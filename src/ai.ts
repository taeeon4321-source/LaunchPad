// OpenAI provider (Responses API, server-side only). One place decides which model handles which task,
// what it costs, and how output is validated. Nothing here is reachable from the browser.
import { config } from './config.ts';
import { db } from './db.ts';

// Task → tier. Cheap model for small structured jobs; the vision model for image/game critique; the deep model for
// multi-source reports and implementation prompts. Change tiers here or models via OPENAI_MODEL_* env vars.
export const TASKS = {
  classify_reference: 'fast', format: 'fast', extract: 'fast',
  thumbnail_analysis: 'vision', game_page_analysis: 'vision', first_session_analysis: 'vision',
  retention_analysis: 'deep', progression_analysis: 'deep', full_audit: 'deep', implementation_prompt: 'deep',
} as const;
export type Task = keyof typeof TASKS;
const FALLBACK: Record<string, 'fast' | 'vision' | 'deep'> = { deep: 'vision', vision: 'deep', fast: 'vision' };
// USD per 1M tokens: [input, cached input, output] (OpenAI pricing page). Overridable with OPENAI_PRICES_JSON.
const PRICES: Record<string, [number, number, number]> = { 'gpt-6-luna': [0.1, 0.01, 0.5], 'gpt-6.1-terra': [1, 0.05, 5], 'gpt-6.2-sol': [2, 0.1, 10], 'gpt-6.2-astra': [8, 0.4, 40] };
export const modelFor = (task: Task) => config.openai.models[TASKS[task]];
export function costOf(model: string, u: { input: number; cached: number; output: number }) {
  const p = config.openai.prices[model] ?? PRICES[model]; if (!p) return 0;
  return ((u.input - u.cached) * p[0] + u.cached * p[1] + u.output * p[2]) / 1e6;
}

export class AiError extends Error { status: number; constructor(message: string, status = 502) { super(message); this.status = status; } }
export const io = { fetch: ((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch, sleep: (ms: number) => new Promise(r => setTimeout(r, ms)) };

// Minimal validator for the JSON-schema subset we send (object/array/string/integer/number/boolean/enum, required,
// additionalProperties:false). Strict mode should already guarantee this; we still check before anything is stored.
export function validate(v: any, s: any, path = '$'): string | null {
  if (s.enum && !s.enum.includes(v)) return `${path}: not one of ${s.enum.join(', ')}`;
  switch (s.type) {
    case 'object': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return `${path}: expected object`;
      for (const k of s.required ?? []) if (!(k in v)) return `${path}.${k}: missing`;
      for (const k of Object.keys(v)) { if (!s.properties[k]) return `${path}.${k}: unexpected`; const e = validate(v[k], s.properties[k], `${path}.${k}`); if (e) return e; }
      return null;
    }
    case 'array': { if (!Array.isArray(v)) return `${path}: expected array`; if (s.maxItems && v.length > s.maxItems) return `${path}: too many items`; for (let i = 0; i < v.length; i++) { const e = validate(v[i], s.items, `${path}[${i}]`); if (e) return e; } return null; }
    case 'string': return typeof v === 'string' && v.length <= 6000 ? null : `${path}: expected string`;
    case 'integer': return Number.isInteger(v) && (s.minimum == null || v >= s.minimum) && (s.maximum == null || v <= s.maximum) ? null : `${path}: expected integer in range`;
    case 'number': return typeof v === 'number' && isFinite(v) ? null : `${path}: expected number`;
    case 'boolean': return typeof v === 'boolean' ? null : `${path}: expected boolean`;
  }
  return null;
}

export type Part = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'low' | 'high' | 'auto' };
// One structured call. Retries transient errors once, then tries the fallback tier. Every attempt is logged in ai_usage.
export async function generate<T>(o: { task: Task; system: string; parts: Part[]; schema: { name: string; schema: any }; maxOutput?: number; userId?: string | null; analysisId?: string | null }) {
  if (!config.openai.apiKey) throw new AiError('AI analysis isn\'t configured on this server yet.', 503);
  const tiers = [TASKS[o.task], FALLBACK[TASKS[o.task]]];
  let last: Error | null = null;
  for (const tier of tiers) {
    const model = config.openai.models[tier];
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = { model, input: [{ role: 'system', content: o.system }, { role: 'user', content: o.parts }], text: { format: { type: 'json_schema', name: o.schema.name, schema: o.schema.schema, strict: true } }, max_output_tokens: o.maxOutput ?? 6000 };
      let r: Response;
      try { r = await io.fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) }); }
      catch (e: any) { last = new AiError('Couldn\'t reach OpenAI.'); await log(o, model, null, false, 'network'); continue; }
      const j: any = await r.json().catch(() => ({}));
      const u = { input: j.usage?.input_tokens ?? 0, cached: j.usage?.input_tokens_details?.cached_tokens ?? 0, output: j.usage?.output_tokens ?? 0 };
      if (r.status === 429 || r.status >= 500) { await log(o, model, u, false, `http ${r.status}`); last = new AiError('OpenAI is busy. Try again in a minute.', 503); await io.sleep(1500 * (attempt + 1)); continue; }
      if (!r.ok) { await log(o, model, u, false, `http ${r.status}`); throw new AiError(r.status === 401 ? 'The OpenAI API key was rejected.' : `OpenAI rejected the request (${r.status}).`, r.status === 401 ? 503 : 502); }
      const text = j.output_text ?? (j.output ?? []).flatMap((x: any) => x.type === 'message' ? x.content ?? [] : []).find((c: any) => c.type === 'output_text')?.text;
      const refusal = (j.output ?? []).flatMap((x: any) => x.content ?? []).find((c: any) => c.type === 'refusal');
      if (refusal) { await log(o, model, u, false, 'refusal'); throw new AiError('The model declined to analyze this content.', 422); }
      let out: any; try { out = JSON.parse(text); } catch { await log(o, model, u, false, 'invalid json'); last = new AiError('The analysis came back malformed.'); break; }
      const err = validate(out, o.schema.schema); if (err) { await log(o, model, u, false, `schema: ${err.slice(0, 150)}`); last = new AiError('The analysis didn\'t match the expected format.'); break; }
      const cost = await log(o, model, u, true, null);
      return { data: out as T, model, cost, usage: u };
    }
  }
  throw last ?? new AiError('AI analysis failed.');
}
async function log(o: { task: Task; userId?: string | null; analysisId?: string | null }, model: string, u: { input: number; cached: number; output: number } | null, ok: boolean, error: string | null) {
  const cost = u ? costOf(model, u) : 0;
  await db.query('insert into ai_usage (user_id, analysis_id, task, model, input_tokens, cached_tokens, output_tokens, cost_usd, ok, error) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
    [o.userId ?? null, o.analysisId ?? null, o.task, model, u?.input ?? 0, u?.cached ?? 0, u?.output ?? 0, cost, ok, error]);
  return cost;
}
