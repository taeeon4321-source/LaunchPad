// Background sync of one game's Roblox analytics into metric_points. Runs in slices so a job never hits the queue timeout.
import { db } from './db.ts';
import { canAccess, getUsageLimit } from './entitlements.ts';
import { enqueue } from './jobs.ts';
import { SYNC_PLAN, queryRange, RobloxAnalyticsError } from './metrics.ts';
import { decrypt } from './security.ts';

const DAY = 86400e3, SLICE_MS = 90_000;
type P = { userId: string; gameId: string; index: number; runId?: number };

export async function syncGame(p: P, now = Date.now()) {
  const { userId: uid, gameId: game } = p, t0 = Date.now();
  const link = (await db.asUser(uid, q => q.query(`select l.universe_id::text universe, l.last_success_at, c.secret_enc from analytics_links l
    left join analytics_credentials c on c.id = l.credential_id and c.user_id = l.user_id where l.user_id = $1 and l.game_id = $2`, [uid, game]))).rows[0];
  if (!link?.secret_enc || !(await canAccess(uid, 'roblox_analytics_sync'))) return;
  const hist = (await getUsageLimit(uid, 'analytics_history_days')) ?? 365;
  // Re-fetch the last 35 days each time: forward D30 retention keeps changing until a cohort is 30 days old.
  const end = new Date(Math.floor(now / DAY) * DAY), first = new Date(end.getTime() - Math.min(hist, 365) * DAY);
  const start = link.last_success_at ? new Date(Math.max(first.getTime(), new Date(link.last_success_at).getTime() - 35 * DAY)) : first;
  const snapStart = new Date(end.getTime() - 28 * DAY); // None-granularity snapshots (distributions, funnels) cover the last 28 days
  const runId = p.runId ?? (await db.asUser(uid, q => q.query('insert into analytics_sync_runs (user_id, game_id) values ($1, $2) returning id', [uid, game]))).rows[0].id;
  const key = decrypt(link.secret_enc), detail: any[] = []; let points = 0, unauthorized = false;
  for (let i = p.index; i < SYNC_PLAN.length; i++) {
    if (Date.now() - t0 > SLICE_MS) { // continue in a fresh job
      await saveRun(uid, runId, detail, points, null);
      return enqueue('analytics_sync', { ...p, index: i, runId }, { key: `analytics-cont:${runId}:${i}` });
    }
    const q = SYNC_PLAN[i], none = q.granularity === 'None', from = none ? snapStart : q.granularity === 'OneWeek' || q.granularity === 'OneMonth' ? new Date(Math.min(start.getTime(), end.getTime() - 120 * DAY)) : start;
    try {
      const pts = await queryRange(key, link.universe, q, from, end);
      await db.asUser(uid, async t => {
        for (let k = 0; k < pts.length; k += 400) {
          const part = pts.slice(k, k + 400), vals: unknown[] = [];
          const ph = part.map((x, j) => { const o = j * 10; vals.push(uid, game, q.metric, q.granularity, x.breakdown, none ? from.toISOString() : x.t, none ? end.toISOString() : null, x.value, x.status, new Date(now).toISOString());
            return `($${o + 1},$${o + 2},'roblox',$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10})`; });
          await t.query(`insert into metric_points (user_id, game_id, source, metric, granularity, breakdown, t, t_end, value, status, fetched_at) values ${ph.join(',')}
            on conflict (user_id, game_id, source, metric, granularity, breakdown, t) do update set value = excluded.value, status = excluded.status, t_end = excluded.t_end, fetched_at = excluded.fetched_at`, vals);
        }
      });
      points += pts.length; detail.push({ metric: q.metric, granularity: q.granularity, breakdown: q.breakdown ?? [], points: pts.length });
    } catch (e: any) {
      const kind = e instanceof RobloxAnalyticsError ? e.kind : 'failed';
      detail.push({ metric: q.metric, granularity: q.granularity, breakdown: q.breakdown ?? [], error: kind, message: String(e?.message ?? e).slice(0, 200) });
      if (kind === 'unauthorized') { unauthorized = true; break; } // the key lost access: stop, don't hammer Roblox
    }
  }
  const prior = p.runId ? (await db.asUser(uid, q => q.query('select detail, points from analytics_sync_runs where id = $1 and user_id = $2', [runId, uid]))).rows[0] : null;
  const all = [...(prior?.detail ?? []), ...detail], ok = all.filter(d => !d.error).length, total = points + (prior?.points ?? 0);
  const status = unauthorized ? 'failed' : ok === all.length ? 'ok' : ok ? 'partial' : 'failed';
  await saveRun(uid, runId, detail, points, status);
  const allUnsupported = !ok && all.every(d => d.error === 'unsupported');
  const linkStatus = unauthorized ? 'unauthorized' : allUnsupported ? 'not_eligible' : ok ? 'ok' : 'error';
  const msg = unauthorized ? 'The API key can\'t read this experience\'s analytics (missing universe.analytics:read or revoked).'
    : allUnsupported ? `Roblox rejected every query: ${all[0]?.message ?? ''}` : ok < all.length ? `${all.length - ok} of ${all.length} queries returned no data.` : null;
  await db.asUser(uid, q => q.query(`update analytics_links set status = $3, status_detail = $4, last_success_at = case when $5 then now() else last_success_at end where user_id = $1 and game_id = $2`,
    [uid, game, linkStatus, msg, ok > 0]));
  await db.query('update analytics_credentials set last_used_at = now() where secret_enc = $1', [link.secret_enc]);
  return { status, points: total };
}

async function saveRun(uid: string, runId: number, detail: any[], points: number, status: string | null) {
  await db.asUser(uid, q => q.query(`update analytics_sync_runs set detail = detail || $3::jsonb, points = points + $4, status = coalesce($5, status), finished_at = case when $5 is null then null else now() end
    where id = $1 and user_id = $2`, [runId, uid, JSON.stringify(detail), points, status]));
}
