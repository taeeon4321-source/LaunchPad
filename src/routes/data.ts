// Games, reports, recommendations, evidence and developer overrides. Every query runs through db.asUser,
// so row-level security backs up the explicit user_id filters.
import type { FastifyInstance } from 'fastify';
import { db } from '../db.ts';
import { fail, requireUser, str } from '../http.ts';

const ID = /^[\w-]{1,64}$/;
const OPTS = ['game-page', 'thumbnail', 'first-session', 'retention', 'progression'];
const MAX_JSON = 3_000_000;
const IMG_SIGS: [string, number[]][] = [['image/png', [0x89, 0x50, 0x4e, 0x47]], ['image/jpeg', [0xff, 0xd8, 0xff]], ['image/gif', [0x47, 0x49, 0x46]], ['image/webp', [0x52, 0x49, 0x46, 0x46]], ['image/bmp', [0x42, 0x4d]]];

// Uploaded images arrive as data URLs inside game/report JSON. Check the bytes, not the claimed type.
export function checkImageBytes(buf: Buffer, claimed?: string) {
  const sig = IMG_SIGS.find(([, s]) => s.every((b, i) => buf[i] === b));
  if (!sig) return 'That file isn\'t a PNG, JPEG, GIF, WebP or BMP image.';
  if (sig[0] === 'image/webp' && buf.subarray(8, 12).toString() !== 'WEBP') return 'That file isn\'t a valid WebP image.';
  if (claimed && claimed !== sig[0]) return 'The image type doesn\'t match its contents.';
  if (buf.length > 8 * 1024 * 1024) return 'Images must be 8 MB or smaller.';
  return null;
}
function validateJson(v: unknown, depth = 0): string | null {
  if (depth > 12) return 'Data is nested too deeply.';
  if (typeof v === 'string' && v.startsWith('data:')) {
    const m = v.match(/^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/); if (!m) return 'Only base64 image data is allowed.';
    return checkImageBytes(Buffer.from(m[2], 'base64'), m[1]);
  }
  if (Array.isArray(v)) { for (const x of v) { const e = validateJson(x, depth + 1); if (e) return e; } }
  else if (v && typeof v === 'object') { for (const x of Object.values(v)) { const e = validateJson(x, depth + 1); if (e) return e; } }
  return null;
}
function body(req: any) {
  const d = req.body?.data; if (!d || typeof d !== 'object' || Array.isArray(d)) fail(400, 'Missing data.');
  if (JSON.stringify(d).length > MAX_JSON) fail(413, 'This record is too large.');
  const e = validateJson(d); if (e) fail(400, e);
  return d;
}
const pid = (req: any, k = 'id') => { const v = String(req.params[k] ?? ''); if (!ID.test(v)) fail(400, 'Invalid id.'); return v; };

export default async function dataRoutes(app: FastifyInstance) {
  app.get('/api/state', async req => {
    const u = requireUser(req);
    return db.asUser(u.id, async q => ({
      games: (await q.query('select data from games where user_id = $1 order by created_at', [u.id])).rows.map(r => r.data),
      reports: (await q.query('select data from reports where user_id = $1 order by created_at', [u.id])).rows.map(r => r.data),
      overrides: (await q.query('select game_id, field, value, created_at from developer_overrides where user_id = $1', [u.id])).rows,
    }));
  });

  app.put('/api/games/:id', async req => {
    const u = requireUser(req), id = pid(req), d = body(req);
    if (d.id !== id) fail(400, 'Id mismatch.');
    if (d.sample) fail(400, 'Demo games aren\'t saved to your account.');
    const universe = d.studio?.universeId && Number.isSafeInteger(d.studio.universeId) ? d.studio.universeId : null;
    await db.asUser(u.id, q => q.query(`insert into games (user_id, id, data, roblox_universe_id) values ($1, $2, $3, $4)
      on conflict (user_id, id) do update set data = excluded.data, roblox_universe_id = excluded.roblox_universe_id, updated_at = now()`, [u.id, id, d, universe]));
    return { ok: true };
  });
  app.delete('/api/games/:id', async req => {
    const u = requireUser(req), id = pid(req);
    const r = await db.asUser(u.id, q => q.query('delete from games where user_id = $1 and id = $2 returning id', [u.id, id]));
    if (!r.rows.length) fail(404, 'Game not found.'); return { ok: true };
  });

  app.put('/api/reports/:id', async req => {
    const u = requireUser(req), id = pid(req), d = body(req);
    if (d.id !== id || !OPTS.includes(d.optimizer)) fail(400, 'Invalid report.');
    if (d.sample) fail(400, 'Demo reports aren\'t saved to your account.');
    if (d.gameId != null && !ID.test(String(d.gameId))) fail(400, 'Invalid game id.');
    const score = Number.isFinite(d.score) ? Math.round(d.score) : null;
    await db.asUser(u.id, async q => {
      if (d.gameId && !(await q.query('select 1 from games where user_id = $1 and id = $2', [u.id, d.gameId])).rows.length) fail(404, 'Game not found.');
      await q.query(`insert into reports (user_id, id, game_id, optimizer, score, data) values ($1, $2, $3, $4, $5, $6)
        on conflict (user_id, id) do update set data = excluded.data, score = excluded.score, game_id = excluded.game_id, updated_at = now()`, [u.id, id, d.gameId ?? null, d.optimizer, score, d]);
      await q.query('delete from recommendations where user_id = $1 and report_id = $2', [u.id, id]);
      for (const r of (Array.isArray(d.recs) ? d.recs : []).slice(0, 50))
        await q.query('insert into recommendations (user_id, report_id, rec_id, title, priority, done, trigger) values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing',
          [u.id, id, str(r.id || r.key, 64) || 'rec', str(r.title, 200) || 'Recommendation', str(r.priority, 10) || 'Low', !!r.done, str(r.trigger, 500)]);
      await q.query('delete from evidence_records where user_id = $1 and report_id = $2', [u.id, id]);
      for (const e of (Array.isArray(d.evidence) ? d.evidence : []).slice(0, 50))
        await q.query('insert into evidence_records (user_id, report_id, finding, source, reference) values ($1, $2, $3, $4, $5)', [u.id, id, str(e.what, 300) || '—', str(e.source, 60) || 'Unknown', str(e.ref, 300) || null]);
    });
    return { ok: true };
  });
  app.delete('/api/reports/:id', async req => {
    const u = requireUser(req), id = pid(req);
    const r = await db.asUser(u.id, q => q.query('delete from reports where user_id = $1 and id = $2 returning id', [u.id, id]));
    if (!r.rows.length) fail(404, 'Report not found.'); return { ok: true };
  });

  // Developer-confirmed corrections survive later scans until the developer resets them.
  app.put('/api/games/:id/overrides/:field', async req => {
    const u = requireUser(req), id = pid(req), field = pid(req, 'field'), value = (req.body as any)?.value;
    if (value === undefined || JSON.stringify(value).length > 20000) fail(400, 'Invalid value.');
    await db.asUser(u.id, async q => {
      if (!(await q.query('select 1 from games where user_id = $1 and id = $2', [u.id, id])).rows.length) fail(404, 'Game not found.');
      await q.query('insert into developer_overrides (user_id, game_id, field, value) values ($1, $2, $3, $4) on conflict (user_id, game_id, field) do update set value = excluded.value, created_at = now()', [u.id, id, field, JSON.stringify(value)]);
    });
    return { ok: true };
  });
  app.delete('/api/games/:id/overrides/:field', async req => {
    const u = requireUser(req), id = pid(req), field = pid(req, 'field');
    await db.asUser(u.id, q => q.query('delete from developer_overrides where user_id = $1 and game_id = $2 and field = $3', [u.id, id, field]));
    return { ok: true };
  });
}
