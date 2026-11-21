// AI analysis pipeline: collect evidence → choose references → structured OpenAI call → validate → persist → tasks.
// Paid feature (ai_analysis), enforced here. Identical evidence is never paid for twice (input hash cache).
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { db } from '../db.ts';
import { canAccess, planOf } from '../entitlements.ts';
import { FREE_AI_ANALYSES_PER_DAY } from '../plans.ts';
import { fail, ip, requireRole, requireUser, str } from '../http.ts';
import { audit, Throttle } from '../security.ts';
import { generate, modelFor, AiError, type Part, type Task } from '../ai.ts';
import { refreshReferences, relevantReferences, universeForPlace, STYLES, MECHANICS } from '../references.ts';
import { checkImageBytes } from './data.ts';

const SCHEMA_VERSION = 'v1', ID = /^[\w-]{1,64}$/, DAY = 86400e3;
const OPTIMIZERS: Record<string, { task: Task; focus: string; label: string }> = {
  thumbnail: { task: 'thumbnail_analysis', focus: 'thumbnail', label: 'Thumbnail & Icon' },
  'game-page': { task: 'game_page_analysis', focus: 'game-page', label: 'Game Page' },
  'first-session': { task: 'first_session_analysis', focus: 'gameplay', label: 'First Session' },
  retention: { task: 'retention_analysis', focus: 'gameplay', label: 'Retention' },
  progression: { task: 'progression_analysis', focus: 'gameplay', label: 'Progression' },
  audit: { task: 'full_audit', focus: 'game-page', label: 'Full game audit' },
};
const analyzeThrottle = new Throttle(20, 60 * 60e3), promptThrottle = new Throttle(60, 60 * 60e3);
const sha = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

// ---------- output schema (strict structured output) ----------
const S = { type: 'string' }, E = (...v: string[]) => ({ type: 'string', enum: v }), A = (items: any, maxItems = 20) => ({ type: 'array', items, maxItems });
const O = (props: Record<string, any>) => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props });
export const ANALYSIS_SCHEMA = { name: 'launchpad_analysis', schema: O({
  overall_assessment: S,
  findings: A(O({ id: S, title: S, category: E('visual', 'presentation', 'onboarding', 'gameplay', 'progression', 'economy', 'retention', 'ui', 'analytics', 'technical'),
    severity: E('critical', 'high', 'medium', 'low'), problem: S, evidence: S, evidence_type: E('observed', 'interpretation', 'hypothesis'), reasoning: S, solution: S,
    rewritten_text: S, experiment: S, confidence: E('high', 'medium', 'low'), reference_ids: A(S, 4), related_metrics: A(S, 6),
    implementation_effort: E('low', 'medium', 'high'), impact_estimate: E('high', 'medium', 'low'), prompt_available: { type: 'boolean' } }), 12),
  strengths: A(O({ point: S, evidence: S }), 5),
  reference_comparisons: A(O({ reference_id: S, why_relevant: S, technique: S, what_to_adapt: S, what_not_to_copy: S, visual_difference: S }), 4),
  roadmap: O({ now: A(S, 3), next: A(S, 3), later: A(S, 3) }),
  limitations: A(S, 8),
}) };
const PROMPT_SCHEMA = { name: 'implementation_prompt', schema: O({ title: S, prompt: S, attach: A(S, 6), expected_output: S, testing: S }) };

const RULES = `You are LaunchPad's senior Roblox game analyst. Your job is to find what is wrong and how to fix it, not to praise or restate.
Rules:
- Judge the evidence yourself. Never repeat the developer's own description back as a finding.
- Every finding names a specific problem, cites concrete evidence from the packet (a visible detail in a supplied image, a number in "analytics", a value in "scan"), explains why it matters and gives a concrete change.
- Banned: generic advice ("make it more engaging", "improve retention", "add more content", "make the thumbnail more appealing") without the exact change.
- Only cite reference_ids and metric keys that appear in the packet. Never invent numbers, CTR, retention or revenue for any game. References only have the public data shown.
- If an image is not attached, you have not seen it: don't describe it. If data is missing, say so in limitations.
- evidence_type: "observed" for what the packet directly shows; "interpretation" for what it implies; "hypothesis" when causality is uncertain, and then give an experiment.
- Say something is good only with evidence (use strengths). Don't claim a visual flaw guarantees lower clicks.
- severity reflects likely effect on players; confidence reflects how strong the evidence is. Order findings by importance. 3 to 8 findings.
- rewritten_text: a ready-to-use rewrite only when the fix is text (title, description, UI copy); else "". experiment: "" unless the finding is a hypothesis.
- Write plainly and briefly. No filler.`;
const FOCUS: Record<string, string> = {
  thumbnail: `Critique the attached developer thumbnail(s) and icon as images. Check composition, focal point, subject size and separation, visual hierarchy, contrast, colour distribution, background clutter, readability at small sizes (think ~150px wide on a phone), text legibility, expression, storytelling, genre fit, whether it shows an appealing gameplay moment and a reason to click, icon weaknesses and icon/thumbnail consistency. Compare against the attached reference thumbnails (labelled with their reference_id) and explain concrete visual differences. Prompts for image editing will be generated from your findings, so describe the exact edit.`,
  'game-page': `Critique the game page: title clarity and relevance, description structure and readability, information order, whether the core loop and goal are understandable, unnecessary content, differentiation, thumbnail/icon consistency with the text, and any acquisition analytics (impressions → detail visits → plays). Don't rewrite everything: only rewrite parts you show are weak.`,
  'first-session': `Diagnose the first session from the scan (UI text, prompts, spawns, systems), the developer's stage breakdown, screenshots and any funnel/onboarding analytics: time to objective, first meaningful action, first reward, tutorial clarity, UI complexity, friction, information overload, unnecessary steps, early decisions, visibility of the next goal. You did not watch gameplay: base claims on the supplied evidence.`,
  retention: `Diagnose retention from the analytics (D1/D7/D30, cohorts, sessions, playtime, new vs returning, platform splits, funnels) plus scan and developer input. Separate observed data from interpretation and hypotheses; give an experiment for each hypothesis. Compare mechanics and structure with references; never claim reference retention numbers.`,
  progression: `Critique progression and economy from the scan's priced items (cost, income, reward), the developer's stages and any progression/economy analytics: disproportionate cost jumps, redundant upgrades, rewards with no meaningful effect, unbalanced sinks vs sources, overly long segments, weak milestones, bottlenecks where players stop, endgame gaps. Quote the exact items and numbers. Don't claim inflation or player distributions without data.`,
  audit: `Do a full audit across presentation, first session, retention and progression using everything in the packet. Prioritise the few changes that matter most.`,
};

// ---------- evidence packet ----------
async function analyticsSummary(userId: string, gameId: string) {
  const rows = (await db.asUser(userId, q => q.query(`select metric, breakdown, t, value, source, status from metric_points where user_id = $1 and game_id = $2 and granularity = 'OneDay' and source in ('roblox', 'upload')
    and t > now() - interval '70 days' and metric in ('ForwardD1Retention','ForwardD7Retention','ForwardD30Retention','DailyActiveUsers','AverageSessionLengthMinutes','AveragePlayTimeMinutesPerDAU','Visits')
    and (breakdown = '' or breakdown like 'Platform=%' or breakdown like 'IsNewUser=%')`, [userId, gameId]))).rows;
  const snap = (await db.asUser(userId, q => q.query(`select metric, breakdown, value, source from metric_points where user_id = $1 and game_id = $2 and granularity = 'None'
    and metric in ('UniqueUsersWithImpressions','UniqueUsersWithClicks','UniqueUsersWithPlaySessions','QualifiedUniqueUsersWithPlaySessions','FunnelUserTotalCount','TotalSessionsEndedInBucket','ProgressionPlayers','MilestoneCompletionRate')
    and t = (select max(t) from metric_points m where m.user_id = metric_points.user_id and m.game_id = metric_points.game_id and m.metric = metric_points.metric)`, [userId, gameId]))).rows;
  const out: Record<string, { value: number; source: string; window: string }> = {}, now = Date.now(), lag = (m: string) => ({ ForwardD1Retention: 2, ForwardD7Retention: 8, ForwardD30Retention: 31 } as any)[m] ?? 0;
  const groups = new Map<string, any[]>(); for (const r of rows) { const k = `${r.metric}|${r.breakdown}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
  for (const [k, list] of groups) {
    const [m, bd] = k.split('|'), src = list.some(r => r.source === 'roblox') ? 'roblox' : 'upload', l = list.filter(r => r.source === src && r.status !== 'Projected'), end = now - lag(m) * DAY;
    const win = (a: number, b: number) => { const v = l.filter(r => { const t = new Date(r.t).getTime(); return t >= end - a * DAY && t < end - b * DAY; }).map(r => r.value); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
    const cur = win(28, 0), prev = win(56, 28), key = `${m}${bd ? ':' + bd : ''}`;
    if (cur != null) out[`${key}:last28d`] = { value: +cur.toFixed(4), source: src, window: 'mean of daily values, last 28 mature days' };
    if (prev != null) out[`${key}:prior28d`] = { value: +prev.toFixed(4), source: src, window: 'mean of daily values, the 28 days before' };
  }
  for (const r of snap) out[`${r.metric}${r.breakdown ? ':' + r.breakdown : ''}:snapshot28d`] = { value: +Number(r.value).toFixed(4), source: r.source, window: 'last 28 days, unique/total' };
  return out;
}
async function scanSummary(userId: string, g: any) {
  const uni = g.studio?.universeId; if (!uni) return g.studio?.scan ? trimScan(g.studio.scan) : null;
  const s = (await db.asUser(userId, q => q.query('select data, created_at from scan_snapshots where user_id = $1 and universe_id = $2 order by created_at desc limit 1', [userId, uni]))).rows[0];
  return s ? { ...trimScan(s.data), scannedAt: s.created_at } : g.studio?.scan ? trimScan(g.studio.scan) : null;
}
const trimScan = (s: any) => ({ counts: s.counts, features: s.features, uiTexts: (s.texts ?? []).slice(0, 40), prompts: (s.prompts ?? []).slice(0, 25), economy: (s.economy ?? []).slice(0, 40), codeRead: !!s.codeRead });
// Images from the browser: data URLs only, checked by their bytes (not the claimed type), size-capped.
function images(list: unknown) {
  const out: { role: string; url: string; hash: string }[] = [];
  for (const x of Array.isArray(list) ? list.slice(0, 5) : []) {
    const m = String((x as any)?.dataUrl ?? '').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/); if (!m) fail(400, 'Images must be PNG, JPEG or WebP.');
    const buf = Buffer.from(m![2], 'base64'); if (buf.length > 1.5 * 1024 * 1024) fail(413, 'Each image must be under 1.5 MB after resizing.');
    const e = checkImageBytes(buf, m![1]); if (e) fail(400, e);
    out.push({ role: ['thumbnail', 'icon', 'screenshot', 'ui'].includes((x as any).role) ? (x as any).role : 'screenshot', url: m![0], hash: sha(buf) });
  }
  return out;
}

export default async function aiRoutes(app: FastifyInstance) {
  app.post('/api/ai/analyze', async req => {
    const u = requireUser(req), b: any = req.body ?? {}, opt = OPTIMIZERS[b.optimizer];
    if (!opt) fail(400, 'Unknown analysis.');
    if (!(await canAccess(u.id, 'ai_analysis'))) fail(403, 'AI analysis isn\'t available on your plan.', { upgrade: true, feature: 'ai_analysis' });
    if (b.optimizer === 'audit' && !(await canAccess(u.id, 'ai_comprehensive'))) fail(403, 'The full game audit is part of Max.', { upgrade: true, feature: 'ai_comprehensive' });
    const gameId = String(b.gameId ?? ''); if (!ID.test(gameId)) fail(400, 'Invalid game.');
    const g = (await db.asUser(u.id, q => q.query('select data from games where user_id = $1 and id = $2', [u.id, gameId]))).rows[0]?.data; if (!g) fail(404, 'Save this game to your account first.');
    const inputs = b.inputs && typeof b.inputs === 'object' ? b.inputs : {}; if (JSON.stringify(inputs).length > 40_000) fail(413, 'Inputs are too large.');
    const imgs = images(b.images);
    const [analytics, scan, refs] = await Promise.all([analyticsSummary(u.id, gameId), scanSummary(u.id, g), relevantReferences(g, opt.focus, opt.focus === 'thumbnail' ? 4 : 3)]);
    const visual = opt.focus === 'thumbnail' || b.optimizer === 'game-page';
    const refPacket = refs.map(r => ({ reference_id: `ref_${r.universe_id}`, name: r.name, creator: r.creator, genre: r.genre, tags: { game_type: r.tags?.game_type, styles: r.tags?.styles, mechanics: r.tags?.mechanics },
      description_excerpt: String(r.description ?? '').slice(0, 400), public_stats: r.stats, relevance: r.score, selected_because: r.reasons, thumbnail_attached: visual && !!r.thumbnail_urls?.[0] }));
    const packet = { analysis: opt.label, game: { name: g.name, genre: g.genre, description: String(g.description ?? '').slice(0, 4000), loop: g.loop ?? '', url: g.url ?? '', updates: g.updates ?? [] },
      developer_inputs: inputs, analytics: Object.keys(analytics).length ? analytics : 'No analytics connected or uploaded for this game.', scan: scan ?? 'No Studio scan for this game.',
      images_attached: imgs.map(i => i.role), references: refPacket.length ? refPacket : 'No relevant references in the catalog yet.' };
    const model = modelFor(opt.task), hash = sha([SCHEMA_VERSION, b.optimizer, model, packet, imgs.map(i => i.hash)]);
    if (!b.force) { const hit = (await db.asUser(u.id, q => q.query('select * from ai_analyses where user_id = $1 and input_hash = $2 order by created_at desc limit 1', [u.id, hash]))).rows[0]; if (hit) return { ...view(hit), cached: true }; }
    if (!analyzeThrottle.take(u.id).ok) fail(429, 'Too many analyses in the last hour. Try again later.');
    const free = (await planOf(u.id)) === 'free', day = new Date().toISOString().slice(0, 10);
    if (free && !(await takeDaily(u.id, day))) fail(429, `Free includes ${FREE_AI_ANALYSES_PER_DAY} AI analysis per day. Light and Max are unlimited.`, { upgrade: true, feature: 'ai_daily' });
    const parts: Part[] = [{ type: 'input_text', text: `EVIDENCE PACKET (JSON):\n${JSON.stringify(packet)}` }];
    imgs.forEach((im, i) => { parts.push({ type: 'input_text', text: `Developer image ${i + 1}: ${im.role}` }, { type: 'input_image', image_url: im.url, detail: im.role === 'icon' ? 'low' : 'high' }); });
    if (visual) refs.forEach(r => { if (r.thumbnail_urls?.[0]) parts.push({ type: 'input_text', text: `Reference thumbnail for ref_${r.universe_id} (${r.name})` }, { type: 'input_image', image_url: r.thumbnail_urls[0], detail: 'low' }); });
    let res; try { res = await generate<any>({ task: opt.task, system: `${RULES}\n\n${FOCUS[b.optimizer]}`, parts, schema: ANALYSIS_SCHEMA, userId: u.id }); }
    catch (e: any) { if (free) await db.query("update usage_counters set count = greatest(0, count - 1) where user_id = $1 and metric = 'ai_analyses_daily' and period = $2", [u.id, day]); if (e instanceof AiError) fail(e.status, e.message); throw e; }
    const result = sanitize(res.data, new Set(refPacket.map(r => r.reference_id)), new Set(Object.keys(analytics)));
    const row = await db.asUser(u.id, async q => {
      const a = (await q.query(`insert into ai_analyses (user_id, game_id, optimizer, input_hash, model, sources, reference_ids, result, cost_usd) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [u.id, gameId, b.optimizer, hash, res.model, { analytics: Object.keys(analytics).length, scan: !!scan, images: imgs.map(i => i.role), references: refPacket.length, inputs: Object.keys(inputs) }, JSON.stringify(refPacket), result, res.cost])).rows[0];
      await q.query("update ai_tasks set status = 'superseded', updated_at = now() where user_id = $1 and game_id = $2 and optimizer = $3 and status = 'not_started'", [u.id, gameId, b.optimizer]);
      for (const f of result.findings) { const p = priority(f); await q.query('insert into ai_tasks (user_id, id, game_id, analysis_id, optimizer, finding, priority, priority_reason) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing', [u.id, `${a.id.slice(0, 8)}_${f.id}`.slice(0, 64), gameId, a.id, b.optimizer, f, p.score, p.reason]); }
      return a;
    });
    await db.query('update ai_usage set analysis_id = $1 where user_id = $2 and analysis_id is null and at > now() - interval \'5 minutes\' and task = $3', [row.id, u.id, opt.task]);
    return { ...view(row), cached: false };
  });

  app.get('/api/ai/analyses', async req => {
    const u = requireUser(req), q: any = req.query, game = String(q.game ?? ''); if (!ID.test(game)) fail(400, 'Invalid game.');
    return (await db.asUser(u.id, t => t.query(`select distinct on (optimizer) * from ai_analyses where user_id = $1 and game_id = $2 order by optimizer, created_at desc`, [u.id, game]))).rows.map(view);
  });
  app.get('/api/ai/analyses/:id', async req => {
    const u = requireUser(req), id = String((req.params as any).id); if (!/^[0-9a-f-]{36}$/.test(id)) fail(400, 'Invalid id.');
    const r = (await db.asUser(u.id, q => q.query('select * from ai_analyses where user_id = $1 and id = $2', [u.id, id]))).rows[0]; if (!r) fail(404, 'Not found.'); return view(r);
  });

  // Implementation prompt for one finding, for an external AI tool. Cached per (finding, kind, tool, notes).
  const KINDS = ['image_edit', 'ui_redesign', 'ui_create', 'gameplay', 'progression', 'script', 'game_page', 'first_session', 'retention_experiment', 'full_audit'];
  const TOOLS = ['image_ai', 'general_ai', 'coding_ai', 'roblox_studio_assistant'];
  app.post('/api/ai/prompts', async req => {
    const u = requireUser(req), b: any = req.body ?? {};
    if (!(await canAccess(u.id, 'ai_analysis'))) fail(403, 'AI prompts are part of Light and Max.', { upgrade: true, feature: 'ai_analysis' });
    const id = String(b.analysisId ?? ''); if (!/^[0-9a-f-]{36}$/.test(id)) fail(400, 'Invalid analysis.');
    if (!KINDS.includes(b.kind) || !TOOLS.includes(b.tool)) fail(400, 'Choose a prompt type and tool.');
    const a = (await db.asUser(u.id, q => q.query('select * from ai_analyses where user_id = $1 and id = $2', [u.id, id]))).rows[0]; if (!a) fail(404, 'Analysis not found.');
    const f = a.result.findings.find((x: any) => x.id === b.findingId); if (!f && b.kind !== 'full_audit') fail(404, 'Finding not found.');
    const g = (await db.asUser(u.id, q => q.query('select data from games where user_id = $1 and id = $2', [u.id, a.game_id]))).rows[0]?.data ?? {};
    const notes = str(b.notes, 1000), hash = sha([SCHEMA_VERSION, id, b.findingId ?? '', b.kind, b.tool, notes]);
    const hit = (await db.asUser(u.id, q => q.query('select * from ai_prompts where user_id = $1 and input_hash = $2', [u.id, hash]))).rows[0]; if (hit) return { ...hit.result, id: hit.id, cached: true };
    if (!promptThrottle.take(u.id).ok) fail(429, 'Too many prompts in the last hour.');
    const refs = (a.reference_ids ?? []).filter((r: any) => (f?.reference_ids ?? []).includes(r.reference_id));
    const ctx = { game: { name: g.name, genre: g.genre, loop: g.loop, description: String(g.description ?? '').slice(0, 1500) }, finding: f ?? null, all_findings: b.kind === 'full_audit' ? a.result.findings : undefined,
      overall: a.result.overall_assessment, references: refs.map((r: any) => ({ id: r.reference_id, name: r.name, technique: a.result.reference_comparisons.find((c: any) => c.reference_id === r.reference_id)?.technique })), developer_notes: notes, kind: b.kind, tool: b.tool };
    const r = await generate<any>({ task: 'implementation_prompt', userId: u.id, analysisId: id, maxOutput: 3000, schema: PROMPT_SCHEMA,
      system: `Write one complete, ready-to-paste prompt for an external AI tool (${b.tool.replace(/_/g, ' ')}) to implement the fix in the finding. Include: context (the game, what exists now), the exact problem and its evidence, the specific change, what must be preserved, constraints (Roblox thumbnails 16:9 e.g. 1920x1080, icons 512x512 square; Luau server/client boundaries; mobile and desktop), testing steps, and the expected output. For image edits describe the developer's actual image from the finding's evidence. Never claim the tool can access the game. "attach" lists which files the developer should attach (e.g. "your current thumbnail"). Plain text, no markdown headings.`,
      parts: [{ type: 'input_text', text: JSON.stringify(ctx) }] });
    const saved = (await db.asUser(u.id, q => q.query('insert into ai_prompts (user_id, analysis_id, finding_id, kind, tool, input_hash, result) values ($1,$2,$3,$4,$5,$6,$7) returning id', [u.id, id, b.findingId ?? null, b.kind, b.tool, hash, r.data]))).rows[0];
    return { ...r.data, id: saved.id, cached: false };
  });

  // Action Center.
  app.get('/api/ai/tasks', async req => {
    const u = requireUser(req), game = String((req.query as any).game ?? '');
    return (await db.asUser(u.id, q => q.query(`select id, game_id, analysis_id, optimizer, finding, priority::float, priority_reason, status, created_at, updated_at from ai_tasks
      where user_id = $1 and ($2 = '' or game_id = $2) and status <> 'superseded' order by status = 'completed', status = 'dismissed', priority desc limit 200`, [u.id, game]))).rows;
  });
  app.patch('/api/ai/tasks/:id', async req => {
    const u = requireUser(req), id = String((req.params as any).id), s = (req.body as any)?.status;
    if (!ID.test(id) || !['not_started', 'in_progress', 'completed', 'dismissed'].includes(s)) fail(400, 'Invalid status.');
    const r = await db.asUser(u.id, q => q.query('update ai_tasks set status = $3, updated_at = now() where user_id = $1 and id = $2 returning id', [u.id, id, s])); if (!r.rows.length) fail(404, 'Task not found.');
    return { ok: true };
  });
  app.get('/api/ai/usage', async req => {
    const u = requireUser(req), r = await db.one(`select count(*) filter (where ok)::int calls, coalesce(sum(cost_usd), 0)::float cost from ai_usage where user_id = $1 and at >= date_trunc('month', now())`, [u.id]);
    const today = await db.one("select coalesce(sum(count), 0)::int n from usage_counters where user_id = $1 and metric = 'ai_analyses_daily' and period = $2", [u.id, new Date().toISOString().slice(0, 10)]);
    const month = await db.one("select count(*)::int n from ai_analyses where user_id = $1 and created_at >= date_trunc('month', now())", [u.id]), free = (await planOf(u.id)) === 'free';
    return { analysesThisMonth: month.n, analysesToday: today.n, dailyLimit: free ? FREE_AI_ANALYSES_PER_DAY : null, modelCalls: r.calls, costUsd: r.cost };
  });

  // Reference catalog: readable by any signed-in user; maintained by administrators.
  app.get('/api/references', async req => {
    requireUser(req); const q: any = req.query, s = str(q.q, 60).toLowerCase(), type = str(q.type, 30), style = str(q.style, 30), mech = str(q.mechanic, 30);
    const rows = (await db.query(`select universe_id::text, root_place_id::text, name, creator, genre, icon_url, thumbnail_urls, stats, tags, refreshed_at from reference_games where active
      and ($1 = '' or lower(name) like '%' || $1 || '%' or lower(creator) like '%' || $1 || '%') and ($2 = '' or tags->>'game_type' = $2 or lower(genre) = $2)
      and ($3 = '' or tags->'styles' ? $3) and ($4 = '' or tags->'mechanics' ? $4) order by name limit 120`, [s, type, style, mech])).rows;
    return { references: rows, styles: STYLES, mechanics: MECHANICS };
  });
  app.post('/api/admin/references', async req => {
    const roles = await requireRole(req, ['administrator']), b: any = req.body ?? {};
    const raw = String(b.ids ?? '').split(/[\s,]+/).filter(Boolean).slice(0, 50), out: string[] = [];
    for (const x of raw) { const place = x.match(/roblox\.com\/games\/(\d+)/)?.[1] ?? (b.kind === 'place' ? x : null); out.push(place ? await universeForPlace(place) : x); }
    const added = await refreshReferences(out.filter(Boolean));
    await audit(req.user!.id, 'references_add', added.map(a => a.universeId).join(',').slice(0, 300), str(b.reason, 200) || null, `ok (${roles.join(',')})`);
    return { added };
  });
  app.patch('/api/admin/references/:id', async req => {
    await requireRole(req, ['administrator']); const id = String((req.params as any).id); if (!/^\d{1,20}$/.test(id)) fail(400, 'Invalid id.');
    await db.query('update reference_games set active = $2 where universe_id = $1', [id, (req.body as any)?.active === true]); await audit(req.user!.id, 'references_toggle', id, null, 'ok'); return { ok: true };
  });
  app.get('/api/admin/ai-usage', async req => {
    await requireRole(req, ['administrator']);
    return (await db.query(`select date_trunc('day', at)::date day, model, task, count(*)::int calls, sum(input_tokens)::int input, sum(output_tokens)::int output, sum(cost_usd)::float cost, count(*) filter (where not ok)::int errors
      from ai_usage where at > now() - interval '30 days' group by 1, 2, 3 order by 1 desc, cost desc`)).rows;
  });
}

// Counts one analysis against today's Free allowance (UTC day); undone if the analysis fails.
async function takeDaily(userId: string, day: string) {
  const r = await db.one("insert into usage_counters (user_id, metric, period, count) values ($1, 'ai_analyses_daily', $2, 1) on conflict (user_id, metric, period) do update set count = usage_counters.count + 1 returning count", [userId, day]);
  if (r.count > FREE_AI_ANALYSES_PER_DAY) { await db.query("update usage_counters set count = count - 1 where user_id = $1 and metric = 'ai_analyses_daily' and period = $2", [userId, day]); return false; }
  return true;
}
// Drops anything the model wasn't given: unknown reference ids, metric keys that aren't in the packet.
export function sanitize(r: any, refs: Set<string>, metrics: Set<string>) {
  const findings = r.findings.map((f: any, i: number) => ({ ...f, id: /^[\w-]{1,24}$/.test(f.id) ? f.id : `f${i + 1}`, reference_ids: f.reference_ids.filter((x: string) => refs.has(x)), related_metrics: f.related_metrics.filter((x: string) => metrics.has(x)) }));
  const ids = new Set<string>(); findings.forEach((f: any, i: number) => { if (ids.has(f.id)) f.id = `f${i + 1}`; ids.add(f.id); });
  return { ...r, findings, reference_comparisons: r.reference_comparisons.filter((c: any) => refs.has(c.reference_id)) };
}
// Priority = severity × impact × confidence ÷ effort. A sorting aid, explained in words — not a measurement.
export function priority(f: any) {
  const sev = { critical: 4, high: 3, medium: 2, low: 1 }[f.severity as string] ?? 1, imp = { high: 3, medium: 2, low: 1 }[f.impact_estimate as string] ?? 1;
  const conf = { high: 1, medium: 0.7, low: 0.4 }[f.confidence as string] ?? 0.4, eff = { low: 1, medium: 1.6, high: 2.5 }[f.implementation_effort as string] ?? 1.6;
  return { score: Math.round(sev * imp * conf / eff * 100) / 100, reason: `${f.severity} severity, ${f.impact_estimate} likely impact, ${f.confidence} confidence, ${f.implementation_effort} effort` };
}
const view = (r: any) => ({ id: r.id, gameId: r.game_id, optimizer: r.optimizer, model: r.model, createdAt: r.created_at, sources: r.sources, references: r.reference_ids, result: r.result, costUsd: Number(r.cost_usd) });
