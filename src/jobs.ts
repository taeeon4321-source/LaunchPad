// Postgres-backed job queue: retries with backoff, idempotency keys, timeouts, cancellation and progress.
import { db } from './db.ts';

type Handler = (payload: any, ctx: { jobId: number; progress(n: number): Promise<void>; cancelled(): Promise<boolean> }) => Promise<void>;
const handlers = new Map<string, Handler>();
export const registerJob = (kind: string, fn: Handler) => handlers.set(kind, fn);

export async function enqueue(kind: string, payload: object = {}, o: { key?: string; runAt?: Date; maxAttempts?: number } = {}) {
  await db.query('insert into jobs (kind, payload, idempotency_key, run_at, max_attempts) values ($1, $2, $3, $4, $5) on conflict (idempotency_key) do nothing',
    [kind, payload, o.key ?? null, o.runAt ?? new Date(), o.maxAttempts ?? 5]);
}

const TIMEOUT_MS = 120_000;
export async function runOnce(): Promise<boolean> {
  // Jobs stuck in "running" (worker crashed) go back to the queue.
  await db.query("update jobs set status = 'queued', locked_at = null where status = 'running' and locked_at < now() - interval '10 minutes'");
  const job = await db.one(`update jobs set status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
    where id = (select id from jobs where status = 'queued' and run_at <= now() order by run_at limit 1 for update skip locked) returning *`);
  if (!job) return false;
  const fn = handlers.get(job.kind);
  try {
    if (!fn) throw new Error(`No handler for job kind ${job.kind}`);
    let timer: NodeJS.Timeout;
    await Promise.race([
      fn(job.payload, { jobId: job.id, progress: n => db.query('update jobs set progress = $2 where id = $1', [job.id, n]).then(() => {}), cancelled: async () => (await db.one('select status from jobs where id = $1', [job.id]))?.status === 'cancelled' }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Job timed out')), TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    await db.query("update jobs set status = 'done', progress = 100, updated_at = now() where id = $1 and status = 'running'", [job.id]);
  } catch (e: any) {
    const final = job.attempts >= job.max_attempts;
    await db.query(`update jobs set status = $2, last_error = $3, locked_at = null, run_at = now() + ($4 || ' seconds')::interval, updated_at = now() where id = $1 and status = 'running'`,
      [job.id, final ? 'failed' : 'queued', String(e?.message || e).slice(0, 500), String(30 * 2 ** job.attempts)]);
  }
  return true;
}

let stopped = false;
export function startWorker() {
  const loop = async () => { while (!stopped) { try { if (!(await runOnce())) await new Promise(r => setTimeout(r, 2000)); } catch { await new Promise(r => setTimeout(r, 5000)); } } };
  loop();
  // Scheduled work: idempotency keys make each period's job run once even with several workers.
  const tick = () => {
    const h = new Date().toISOString().slice(0, 13), d = h.slice(0, 10);
    enqueue('reconcile_subscriptions', {}, { key: `reconcile:${h}` }).catch(() => {});
    enqueue('retention_cleanup', {}, { key: `retention:${d}` }).catch(() => {});
    enqueue('analytics_schedule', {}, { key: `analytics-schedule:${h}` }).catch(() => {});
    enqueue('references_refresh', {}, { key: `references:${d}` }).catch(() => {});
  };
  tick(); const t = setInterval(tick, 15 * 60e3); t.unref();
  return () => { stopped = true; clearInterval(t); };
}
