// Analytics platform API: data sources, series queries, uploads, forecasts, saved charts and dashboards.
// Every read and write runs through db.asUser (row-level security) and filters by the signed-in user's id.
import type { FastifyInstance } from 'fastify';
import { db } from '../db.ts';
import { canAccess, getUsageLimit } from '../entitlements.ts';
import { enqueue } from '../jobs.ts';
import { fail, ip, requireUser, str } from '../http.ts';
import { encrypt, decrypt, securityEvent, Throttle } from '../security.ts';
import { METRICS, SYNC_PLAN, UPLOAD_KINDS, queryMetric, RobloxAnalyticsError } from '../metrics.ts';
import { forecast, FORECAST_METHOD } from '../forecast.ts';

const ID = /^[\w-]{1,64}$/, DAY = 86400e3, GRANS = ['OneDay', 'OneWeek', 'OneMonth', 'None'];
const linkThrottle = new Throttle(20, 15 * 60e3), uploadThrottle = new Throttle(30, 60 * 60e3), forecastThrottle = new Throttle(120, 60 * 60e3);
const pid = (v: unknown) => { const s = String(v ?? ''); if (!ID.test(s)) fail(400, 'Invalid id.'); return s; };
const json = (v: unknown, max: number, what: string) => { if (!v || typeof v !== 'object') fail(400, `Missing ${what}.`); if (JSON.stringify(v).length > max) fail(413, `This ${what} is too large.`); return v as any; };
// Maturity: forward retention for a first-play date isn't final until N days later.
export const MATURITY: Record<string, number> = { ForwardD1Retention: 1, ForwardD7Retention: 7, ForwardD30Retention: 30 };

async function ownGame(userId: string, gameId: string) {
  const g = await db.asUser(userId, q => q.query('select data from games where user_id = $1 and id = $2', [userId, gameId]));
  if (!g.rows.length) fail(404, 'Game not found.'); return g.rows[0].data;
}
// Points older than the plan's configured history window are not returned (unset = no limit configured).
async function historyStart(userId: string) { const d = await getUsageLimit(userId, 'analytics_history_days'); return d == null ? null : new Date(Date.now() - d * DAY); }

// Validates the parts of a chart config the server enforces: size, and paid capabilities.
async function checkChartConfig(userId: string, c: any) {
  json(c, 20_000, 'chart');
  const series = Array.isArray(c.series) ? c.series : []; if (series.length > 12) fail(400, 'A chart can hold up to 12 series.');
  // Built-in calculations (e.g. sessions per active user = Visits ÷ DailyActiveUsers) are available on every plan; custom formulas are Max.
  const custom = series.filter((s: any) => s?.formula && !(s.builtin === 'sessions_per_user' && s.formula === 'A/B'));
  if (custom.length && !(await canAccess(userId, 'calculated_metrics'))) fail(403, 'Calculated metrics are part of Max.', { upgrade: true });
  if (new Set(series.map((s: any) => s?.game).filter(Boolean)).size > 1 && !(await canAccess(userId, 'cross_experience_overview'))) fail(403, 'Comparing games in one chart is part of Max.', { upgrade: true });
  if (c.forecast && !(await canAccess(userId, 'forecasts'))) fail(403, 'Forecasts are part of Light and Max.', { upgrade: true });
}

export default async function insightRoutes(app: FastifyInstance) {
  app.get('/api/metrics/catalog', async () => ({ metrics: METRICS, uploadKinds: UPLOAD_KINDS, forecastMethod: FORECAST_METHOD, maturity: MATURITY, syncQueries: SYNC_PLAN.length }));

  app.get('/api/metrics/sources', async req => {
    const u = requireUser(req);
    return db.asUser(u.id, async q => ({
      credentials: (await q.query('select id, label, key_hint, created_at, last_used_at from analytics_credentials where user_id = $1 order by created_at', [u.id])).rows,
      links: (await q.query('select game_id, universe_id::text, credential_id, status, status_detail, last_sync_at, last_success_at from analytics_links where user_id = $1', [u.id])).rows,
      runs: (await q.query('select id, game_id, started_at, finished_at, status, points, detail from analytics_sync_runs where user_id = $1 order by started_at desc limit 20', [u.id])).rows,
      datasets: (await q.query('select id, game_id, kind, filename, timezone, row_count, columns, created_at from analytics_datasets where user_id = $1 order by created_at desc limit 100', [u.id])).rows,
    }));
  });

  // --- Roblox Open Cloud API keys: stored encrypted, shown only as a hint, never sent back to the browser.
  app.post('/api/metrics/credentials', async req => {
    const u = requireUser(req), b: any = req.body ?? {};
    if (!(await canAccess(u.id, 'roblox_analytics_sync'))) fail(403, 'Syncing Roblox analytics is part of Light and Max.', { upgrade: true });
    const key = typeof b.apiKey === 'string' ? b.apiKey.trim() : '', label = str(b.label, 60) || 'Roblox API key';
    if (key.length < 20 || key.length > 4000 || /\s/.test(key)) fail(400, 'That doesn\'t look like a Roblox Open Cloud API key.');
    if (/ROBLOSECURITY|_\|WARNING/i.test(key)) fail(400, 'That\'s a Roblox login cookie, not an API key. Never share it. Create an API key in Creator Hub instead.');
    const r = await db.asUser(u.id, q => q.query('insert into analytics_credentials (user_id, label, secret_enc, key_hint) values ($1, $2, $3, $4) returning id, label, key_hint, created_at',
      [u.id, label, encrypt(key), '…' + key.slice(-4)]));
    await securityEvent('analytics_key_added', { userId: u.id, ip: ip(req) });
    return r.rows[0];
  });
  app.delete('/api/metrics/credentials/:id', async req => {
    const u = requireUser(req), id = String((req.params as any).id); if (!/^[0-9a-f-]{36}$/.test(id)) fail(400, 'Invalid id.');
    const r = await db.asUser(u.id, async q => {
      await q.query("update analytics_links set status = 'pending', status_detail = 'API key removed' where user_id = $1 and credential_id = $2", [u.id, id]);
      return q.query('delete from analytics_credentials where user_id = $1 and id = $2 returning id', [u.id, id]);
    });
    if (!r.rows.length) fail(404, 'Not found.');
    await securityEvent('analytics_key_removed', { userId: u.id, ip: ip(req) });
    return { ok: true, message: 'Removed from LaunchPad. Also delete the key in Creator Hub → Open Cloud → API Keys so it can\'t be used anywhere.' };
  });

  // Links a game to a universe. Access is proven by a real query: Roblox only answers when the key has analytics permission for it.
  app.put('/api/metrics/links/:game', async req => {
    const u = requireUser(req), game = pid((req.params as any).game), b: any = req.body ?? {};
    if (!(await canAccess(u.id, 'roblox_analytics_sync'))) fail(403, 'Syncing Roblox analytics is part of Light and Max.', { upgrade: true });
    if (!linkThrottle.take(u.id).ok) fail(429, 'Too many attempts. Try again in a few minutes.');
    const universe = String(b.universeId ?? '').trim(); if (!/^\d{1,20}$/.test(universe)) fail(400, 'Enter the numeric universe ID from Creator Hub (not the place ID).');
    const cred = String(b.credentialId ?? ''); if (!/^[0-9a-f-]{36}$/.test(cred)) fail(400, 'Choose an API key.');
    await ownGame(u.id, game);
    const c = await db.asUser(u.id, q => q.query('select secret_enc from analytics_credentials where user_id = $1 and id = $2', [u.id, cred]));
    if (!c.rows.length) fail(404, 'API key not found.');
    let status = 'ok', detail: string | null = null;
    try {
      const end = new Date(Math.floor(Date.now() / DAY) * DAY);
      await queryMetric(decrypt(c.rows[0].secret_enc), universe, { metric: 'DailyActiveUsers', granularity: 'None', startTime: new Date(end.getTime() - 7 * DAY).toISOString(), endTime: end.toISOString() });
    } catch (e: any) {
      status = e instanceof RobloxAnalyticsError ? (e.kind === 'unauthorized' ? 'unauthorized' : e.kind === 'unsupported' ? 'not_eligible' : 'error') : 'error';
      detail = e instanceof RobloxAnalyticsError ? e.message : 'Couldn\'t reach Roblox. Try again.';
    }
    await db.asUser(u.id, q => q.query(`insert into analytics_links (user_id, game_id, universe_id, credential_id, status, status_detail) values ($1, $2, $3, $4, $5, $6)
      on conflict (user_id, game_id) do update set universe_id = excluded.universe_id, credential_id = excluded.credential_id, status = excluded.status, status_detail = excluded.status_detail`, [u.id, game, universe, cred, status, detail]));
    await securityEvent('analytics_link_checked', { userId: u.id, ip: ip(req), detail: { universe, status } });
    return { status, detail };
  });
  app.delete('/api/metrics/links/:game', async req => {
    const u = requireUser(req), game = pid((req.params as any).game);
    await db.asUser(u.id, q => q.query('delete from analytics_links where user_id = $1 and game_id = $2', [u.id, game]));
    return { ok: true, message: 'Unlinked. Synced data stays until you delete it.' };
  });
  app.post('/api/metrics/sync/:game', async req => {
    const u = requireUser(req), game = pid((req.params as any).game);
    if (!(await canAccess(u.id, 'roblox_analytics_sync'))) fail(403, 'Syncing Roblox analytics is part of Light and Max.', { upgrade: true });
    const every = (await getUsageLimit(u.id, 'sync_interval_minutes')) ?? 60;
    const l = (await db.asUser(u.id, q => q.query('select status, last_sync_at from analytics_links where user_id = $1 and game_id = $2', [u.id, game]))).rows[0];
    if (!l) fail(404, 'Link this game to a Roblox universe first.');
    if (l.status === 'unauthorized') fail(409, 'The API key can\'t read this experience. Check its permissions, then check the link again.');
    const next = l.last_sync_at ? new Date(l.last_sync_at).getTime() + every * 60e3 : 0;
    if (next > Date.now()) fail(429, `Your plan syncs at most every ${every} minutes. Next sync from ${new Date(next).toISOString()}.`, { nextAt: new Date(next).toISOString() });
    await db.asUser(u.id, q => q.query('update analytics_links set last_sync_at = now() where user_id = $1 and game_id = $2', [u.id, game]));
    await enqueue('analytics_sync', { userId: u.id, gameId: game, index: 0 }, { key: `analytics:${u.id}:${game}:${Math.floor(Date.now() / (every * 60e3))}` });
    return { queued: true };
  });
  app.post('/api/metrics/data/:game/delete', async req => {
    const u = requireUser(req), game = pid((req.params as any).game), source = String((req.body as any)?.source ?? '');
    if (!['roblox', 'upload', 'benchmark'].includes(source)) fail(400, 'Choose which data to delete.');
    const r = await db.asUser(u.id, async q => {
      if (source !== 'roblox') await q.query('delete from analytics_datasets d where user_id = $1 and game_id = $2 and (($3 = \'benchmark\') = (kind = \'benchmark\'))', [u.id, game, source]);
      return q.query('delete from metric_points where user_id = $1 and game_id = $2 and source = $3', [u.id, game, source]);
    });
    return { ok: true, deleted: (r as any).rowCount ?? null };
  });

  // --- Series. One request returns several metrics for one or more games and a date range (never the whole history).
  app.get('/api/metrics/query', async req => {
    const u = requireUser(req), qs: any = req.query;
    const games = String(qs.games ?? qs.game ?? '').split(',').filter(Boolean).slice(0, 8), metrics = String(qs.metrics ?? '').split(',').filter(Boolean).slice(0, 16);
    if (!games.length || !metrics.length || games.some(g => !ID.test(g)) || metrics.some(m => !METRICS[m])) fail(400, 'Choose a game and known metrics.');
    if (games.length > 1 && !(await canAccess(u.id, 'cross_experience_overview'))) fail(403, 'Comparing several games is part of Max.', { upgrade: true });
    const gran = GRANS.includes(qs.granularity) ? qs.granularity : 'OneDay';
    const to = qs.to && !isNaN(Date.parse(qs.to)) ? new Date(qs.to) : new Date(), floor = await historyStart(u.id);
    let from = qs.from && !isNaN(Date.parse(qs.from)) ? new Date(qs.from) : new Date(to.getTime() - 90 * DAY);
    const limited = !!floor && from < floor; if (floor && from < floor) from = floor;
    if (to.getTime() - from.getTime() > 1500 * DAY) fail(400, 'Choose a shorter date range.');
    // breakdown: '' = totals only; 'Platform' = totals + that dimension; '*' = every stored breakdown (cohorts, funnels).
    const bd = String(qs.breakdown ?? ''); if (bd && bd !== '*' && !/^[A-Za-z0-9,]{1,80}$/.test(bd)) fail(400, 'Invalid breakdown.');
    const sources = String(qs.sources ?? 'roblox,upload,benchmark').split(',').filter(s => ['roblox', 'upload', 'benchmark'].includes(s));
    const rows = await db.asUser(u.id, async q => {
      const exist = (await q.query('select id from games where user_id = $1 and id = any($2)', [u.id, games])).rows.map(r => r.id);
      if (exist.length !== games.length) fail(404, 'Game not found.');
      // None-granularity snapshots: only the latest window per series.
      return (await q.query(`select game_id, source, metric, granularity, breakdown, t, t_end, value, status, sample_size, fetched_at from metric_points
        where user_id = $1 and game_id = any($2) and metric = any($3) and source = any($4) and granularity = $5
          and ($5 = 'None' or (t >= $6 and t < $7))
          and ($8 = '*' or breakdown = '' or ($8 <> '' and split_part(breakdown, '=', 1) = $8 and position('|' in breakdown) = 0))
          and ($5 <> 'None' or t = (select max(t) from metric_points m2 where m2.user_id = metric_points.user_id and m2.game_id = metric_points.game_id and m2.metric = metric_points.metric and m2.source = metric_points.source and m2.granularity = 'None'))
        order by t`, [u.id, games, metrics, sources, gran, from, to, bd])).rows;
    });
    const map = new Map<string, any>();
    for (const r of rows) {
      const k = [r.game_id, r.metric, r.source, r.breakdown].join('\u0000');
      let s = map.get(k); if (!s) map.set(k, s = { game: r.game_id, metric: r.metric, source: r.source, granularity: r.granularity, breakdown: r.breakdown, points: [], fetchedAt: r.fetched_at, window: r.t_end ? [r.t, r.t_end] : null });
      s.points.push([new Date(r.t).getTime(), r.value, r.status || undefined, r.sample_size ?? undefined]);
      if (r.fetched_at > s.fetchedAt) s.fetchedAt = r.fetched_at;
    }
    return { from: from.toISOString(), to: to.toISOString(), granularity: gran, limitedByPlan: limited, series: [...map.values()] };
  });

  // --- Uploads. mode=check reports problems and duplicates without writing; skip/replace write. Never touches Roblox rows.
  app.post('/api/metrics/upload', async req => {
    const u = requireUser(req), b: any = req.body ?? {}, game = pid(b.gameId);
    if (!(await canAccess(u.id, 'analytics_uploads'))) fail(403, 'Uploads aren\'t available on your plan.');
    const kind = UPLOAD_KINDS.includes(b.kind) ? b.kind : fail(400, 'Choose what this file contains.');
    const mode = ['check', 'skip', 'replace'].includes(b.mode) ? b.mode : 'check', rows = Array.isArray(b.rows) ? b.rows : fail(400, 'No rows.');
    if (!rows.length) fail(400, 'The file has no data rows.'); if (rows.length > 40_000) fail(413, 'Upload up to 40,000 rows at a time.');
    if (mode !== 'check' && !uploadThrottle.take(u.id).ok) fail(429, 'Too many uploads. Try again later.');
    const tz = str(b.timezone, 60) || 'UTC', filename = str(b.filename, 120) || 'upload', source = kind === 'benchmark' ? 'benchmark' : 'upload';
    await ownGame(u.id, game);
    const errors: string[] = [], seen = new Set<string>(), clean: any[] = [];
    rows.forEach((r: any, i: number) => {
      const line = `Row ${i + 1}`, [metric, t, value, breakdown = '', sample = null, gran = 'OneDay'] = Array.isArray(r) ? r : [];
      const def = METRICS[metric];
      if (!def || !def.upload) return void (errors.length < 50 && errors.push(`${line}: unknown metric "${String(metric).slice(0, 40)}".`));
      if (typeof t !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t) || isNaN(Date.parse(t + 'T00:00:00Z'))) return void (errors.length < 50 && errors.push(`${line}: date must be YYYY-MM-DD.`));
      if (typeof value !== 'number' || !isFinite(value)) return void (errors.length < 50 && errors.push(`${line}: value is missing or not a number.`));
      if (def.unit === 'ratio' && (value < 0 || value > 1)) return void (errors.length < 50 && errors.push(`${line}: ${def.label} must be between 0 and 1 (or 0–100%).`));
      if (def.unit !== 'ratio' && value < 0 && def.unit !== 'amount') return void (errors.length < 50 && errors.push(`${line}: ${def.label} can't be negative.`));
      if (typeof breakdown !== 'string' || breakdown.length > 160 || (breakdown && !/^[A-Za-z0-9]+=[^|]{1,80}(\|[A-Za-z0-9]+=[^|]{1,80})*$/.test(breakdown))) return void (errors.length < 50 && errors.push(`${line}: invalid breakdown.`));
      if (sample != null && (typeof sample !== 'number' || sample < 0)) return void (errors.length < 50 && errors.push(`${line}: sample size must be a positive number.`));
      if (!def.grans.includes(gran) || gran === 'None' && !def.grans.includes('None')) return void (errors.length < 50 && errors.push(`${line}: ${def.label} doesn't support ${gran}.`));
      const k = [metric, gran, breakdown, t].join('|');
      if (seen.has(k)) return void (errors.length < 50 && errors.push(`${line}: duplicate of an earlier row (${metric} ${t}${breakdown ? ' ' + breakdown : ''}).`));
      seen.add(k); clean.push({ metric, gran, breakdown, t, value, sample });
    });
    const existing = await db.asUser(u.id, q => q.query(`select metric, granularity, breakdown, to_char(t at time zone 'UTC', 'YYYY-MM-DD') d from metric_points
      where user_id = $1 and game_id = $2 and source = $3 and metric = any($4)`, [u.id, game, source, [...new Set(clean.map(c => c.metric))]]));
    const have = new Set(existing.rows.map(r => [r.metric, r.granularity, r.breakdown, r.d].join('|'))), dup = clean.filter(c => have.has([c.metric, c.gran, c.breakdown, c.t].join('|'))).length;
    const roblox = await db.asUser(u.id, q => q.query("select count(*)::int n from metric_points where user_id = $1 and game_id = $2 and source = 'roblox' and metric = any($3)", [u.id, game, [...new Set(clean.map(c => c.metric))]]));
    const summary = { valid: clean.length, invalid: rows.length - clean.length, errors, duplicates: dup, overlapsRoblox: roblox.rows[0].n > 0, metrics: [...new Set(clean.map(c => c.metric))] };
    if (mode === 'check' || errors.length) return { ...summary, written: 0 };
    const write = mode === 'skip' ? clean.filter(c => !have.has([c.metric, c.gran, c.breakdown, c.t].join('|'))) : clean;
    const ds = await db.asUser(u.id, async q => {
      const d = (await q.query('insert into analytics_datasets (user_id, game_id, kind, filename, timezone, row_count, columns) values ($1, $2, $3, $4, $5, $6, $7) returning id',
        [u.id, game, kind, filename, tz, write.length, json(b.columns ?? {}, 4000, 'column mapping')])).rows[0].id;
      for (let i = 0; i < write.length; i += 400) {
        const part = write.slice(i, i + 400), vals: unknown[] = [], ph = part.map((c, j) => { const o = j * 8; vals.push(u.id, game, source, c.metric, c.gran, c.breakdown, c.t + 'T00:00:00Z', c.value); return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},${c.sample == null ? 'null' : Number(c.sample)},'${d}')`; });
        await q.query(`insert into metric_points (user_id, game_id, source, metric, granularity, breakdown, t, value, sample_size, dataset_id) values ${ph.join(',')}
          on conflict (user_id, game_id, source, metric, granularity, breakdown, t) do update set value = excluded.value, sample_size = excluded.sample_size, dataset_id = excluded.dataset_id, fetched_at = now()`, vals);
      }
      return d;
    });
    return { ...summary, written: write.length, datasetId: ds };
  });
  app.delete('/api/metrics/datasets/:id', async req => {
    const u = requireUser(req), id = String((req.params as any).id); if (!/^[0-9a-f-]{36}$/.test(id)) fail(400, 'Invalid id.');
    const r = await db.asUser(u.id, q => q.query('delete from analytics_datasets where user_id = $1 and id = $2 returning id', [u.id, id]));
    if (!r.rows.length) fail(404, 'Not found.'); return { ok: true };
  });

  // --- Forecasts, computed on the server from the stored daily history.
  app.post('/api/metrics/forecast', async req => {
    const u = requireUser(req), b: any = req.body ?? {}, game = pid(b.game), metric = String(b.metric ?? ''), breakdown = str(b.breakdown, 160);
    if (!(await canAccess(u.id, 'forecasts'))) fail(403, 'Forecasts are part of Light and Max.', { upgrade: true });
    const def = METRICS[metric]; if (!def || !def.grans.includes('OneDay') || def.group === 'cohort') fail(400, 'This metric can\'t be forecast.');
    if (!forecastThrottle.take(u.id).ok) fail(429, 'Too many forecasts. Try again later.');
    const horizon = Math.min(90, Math.max(7, Number(b.horizon) || 30)), data = await ownGame(u.id, game);
    const rows = await db.asUser(u.id, q => q.query(`select source, t, value, status from metric_points where user_id = $1 and game_id = $2 and metric = $3 and granularity = 'OneDay' and breakdown = $4
      and source in ('roblox', 'upload') and t > now() - interval '200 days' order by t`, [u.id, game, metric, breakdown]));
    // Official data wins over uploads for the same metric; projected (not yet final) points never train the model.
    const src = rows.rows.some(r => r.source === 'roblox') ? 'roblox' : 'upload', mature = MATURITY[metric] ?? 0, cutoff = Date.now() - (mature + 1) * DAY;
    const pts = rows.rows.filter(r => r.source === src && r.status !== 'Projected' && new Date(r.t).getTime() <= cutoff).map(r => ({ t: new Date(r.t).getTime(), v: r.value }));
    const updates = (Array.isArray(data.updates) ? data.updates : []).map((x: any) => Date.parse(x?.at)).filter((x: number) => isFinite(x));
    const result = { ...forecast(pts, { horizon, ratio: def.unit === 'ratio', summable: def.summable, updates }), metric, breakdown, source: src, horizon };
    if (result.ok) await db.asUser(u.id, q => q.query('insert into analytics_forecasts (user_id, game_id, metric, breakdown, result) values ($1, $2, $3, $4, $5)', [u.id, game, metric, breakdown, result]));
    return result;
  });

  // --- Saved charts and dashboards (private to their owner).
  app.get('/api/charts', async req => { const u = requireUser(req); return db.asUser(u.id, async q => (await q.query('select id, name, config, updated_at from saved_charts where user_id = $1 order by updated_at desc', [u.id])).rows); });
  app.put('/api/charts/:id', async req => {
    const u = requireUser(req), id = pid((req.params as any).id), b: any = req.body ?? {}, name = str(b.name, 80) || 'Untitled chart';
    if (!(await canAccess(u.id, 'chart_builder'))) fail(403, 'The chart builder isn\'t available on your plan.');
    await checkChartConfig(u.id, b.config);
    const n = await db.asUser(u.id, q => q.query('select count(*)::int n from saved_charts where user_id = $1 and id <> $2', [u.id, id]));
    if (n.rows[0].n >= 200) fail(400, 'You can keep up to 200 saved charts.');
    await db.asUser(u.id, q => q.query('insert into saved_charts (user_id, id, name, config) values ($1, $2, $3, $4) on conflict (user_id, id) do update set name = excluded.name, config = excluded.config, updated_at = now()', [u.id, id, name, b.config]));
    return { ok: true };
  });
  app.delete('/api/charts/:id', async req => { const u = requireUser(req), id = pid((req.params as any).id); await db.asUser(u.id, q => q.query('delete from saved_charts where user_id = $1 and id = $2', [u.id, id])); return { ok: true }; });

  app.get('/api/dashboards', async req => { const u = requireUser(req); return db.asUser(u.id, async q => (await q.query('select id, name, position, widgets, updated_at from dashboards where user_id = $1 order by position, updated_at', [u.id])).rows); });
  app.put('/api/dashboards/:id', async req => {
    const u = requireUser(req), id = pid((req.params as any).id), b: any = req.body ?? {}, name = str(b.name, 60) || 'Overview';
    const widgets = Array.isArray(b.widgets) ? b.widgets : fail(400, 'Missing widgets.');
    if (widgets.length > 40) fail(400, 'A dashboard can hold up to 40 widgets.'); json(widgets, 300_000, 'dashboard');
    for (const w of widgets) {
      if (!w || !ID.test(String(w.id)) || ![3, 4, 6, 8, 12].includes(w.w) || ![1, 2].includes(w.h)) fail(400, 'Invalid widget.');
      if (w.chart) await checkChartConfig(u.id, w.chart);
    }
    const others = await db.asUser(u.id, q => q.query('select count(*)::int n from dashboards where user_id = $1 and id <> $2', [u.id, id]));
    if (others.rows[0].n >= 1) {
      if (!(await canAccess(u.id, 'multiple_dashboards'))) fail(403, 'More dashboards are part of Light and Max.', { upgrade: true });
      const lim = await getUsageLimit(u.id, 'dashboards'); if (lim != null && others.rows[0].n >= lim) fail(403, `Your plan allows ${lim} dashboards.`);
    }
    await db.asUser(u.id, q => q.query(`insert into dashboards (user_id, id, name, position, widgets) values ($1, $2, $3, $4, $5)
      on conflict (user_id, id) do update set name = excluded.name, position = excluded.position, widgets = excluded.widgets, updated_at = now()`, [u.id, id, name, Number(b.position) || 0, JSON.stringify(widgets)]));
    return { ok: true };
  });
  app.delete('/api/dashboards/:id', async req => { const u = requireUser(req), id = pid((req.params as any).id); await db.asUser(u.id, q => q.query('delete from dashboards where user_id = $1 and id = $2', [u.id, id])); return { ok: true }; });
}
