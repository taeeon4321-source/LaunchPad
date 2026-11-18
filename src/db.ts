// Database access. Production: PostgreSQL via `pg`. Development/tests: PGlite (real Postgres in-process).
// All queries are parameterized. User-scoped work runs through asUser(), which switches to the app_user role
// and sets app.user_id so row-level security applies on top of the server's own ownership checks.
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { config } from './config.ts';

export interface Q { query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>; }
type TxFn<T> = (q: Q) => Promise<T>;

let impl: { query: Q['query']; exec(sql: string): Promise<unknown>; tx<T>(fn: TxFn<T>): Promise<T>; close(): Promise<void> };

export async function connect(opts: { memory?: boolean } = {}) {
  if (config.databaseUrl && !opts.memory) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: config.databaseUrl, ssl: process.env.DATABASE_SSL === 'off' ? false : config.isProd ? { rejectUnauthorized: process.env.DATABASE_SSL !== 'no-verify' } : undefined, max: 10 });
    impl = {
      query: (sql, params) => pool.query(sql, params as any[]) as any,
      exec: sql => pool.query(sql),
      async tx(fn) { const c = await pool.connect(); try { await c.query('begin'); const r = await fn(c as any); await c.query('commit'); return r; } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); } },
      close: () => pool.end(),
    };
  } else {
    if (config.isProd) throw new Error('DATABASE_URL is required in production');
    const { PGlite } = await import('@electric-sql/pglite');
    if (!opts.memory) mkdirSync(config.pgliteDir, { recursive: true });
    const pg = new PGlite(opts.memory ? undefined : config.pgliteDir);
    // PGlite is a single connection; serialize transactions so they never interleave.
    let chain: Promise<unknown> = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
    impl = {
      query: (sql, params) => serial(() => pg.query(sql, params as any[])) as any,
      exec: sql => serial(() => pg.exec(sql)),
      tx: fn => serial(() => pg.transaction(t => fn({ query: (s, p) => t.query(s, p as any[]) as any }))),
      close: () => pg.close(),
    };
  }
  await migrate();
}

export const db = {
  query: <T = any>(sql: string, params?: unknown[]) => impl.query<T>(sql, params),
  one: async <T = any>(sql: string, params?: unknown[]) => (await impl.query<T>(sql, params)).rows[0] as T | undefined,
  tx: <T>(fn: TxFn<T>) => impl.tx(fn),
  // Runs fn with row-level security enforced for this user.
  asUser: <T>(userId: string, fn: TxFn<T>) => impl.tx(async q => {
    await q.query('set local role app_user');
    await q.query("select set_config('app.user_id', $1, true)", [userId]);
    return fn(q);
  }),
  close: () => impl.close(),
};

async function migrate() {
  await impl.query('create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await impl.query<{ version: string }>('select version from schema_migrations')).rows.map(r => r.version));
  for (const f of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(f)) throw new Error(`Bad migration file name: ${f}`);
    const sql = readFileSync(`migrations/${f}`, 'utf8').replace(/create table schema_migrations[^;]*;/, '');
    await impl.exec(`begin;\n${sql}\ninsert into schema_migrations (version) values ('${f}');\ncommit;`);
  }
}
