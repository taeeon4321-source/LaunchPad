// Internal administration. Every route checks roles server-side and requires MFA; every change writes an audit record.
import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { enqueue } from '../jobs.ts';
import { fail, requireRole, str } from '../http.ts';
import { PRICES } from '../plans.ts';
import { audit } from '../security.ts';

const UUID = /^[0-9a-f-]{36}$/;
const uid = (req: any) => { const v = String(req.params.id ?? ''); if (!UUID.test(v)) fail(400, 'Invalid id.'); return v; };
const reason = (req: any) => { const r = str(req.body?.reason, 500); if (!r) fail(400, 'Give a reason; it\'s recorded in the audit log.'); return r; };
const n = async (sql: string, p: unknown[] = []) => Number((await db.one(sql, p))?.n ?? 0);

export default async function adminRoutes(app: FastifyInstance) {
  app.get('/api/admin/me', async req => ({ roles: await requireRole(req, ['administrator', 'support', 'security']) }));

  app.get('/api/admin/overview', async req => {
    await requireRole(req, ['administrator', 'security', 'support']);
    const env = config.paddle.environment, sub = (plan: string, int: string) => n("select count(*) n from subscriptions where environment = $1 and plan = $2 and billing_interval = $3 and status in ('active', 'trialing', 'past_due')", [env, plan, int]);
    return {
      accounts: await n("select count(*) n from users where status <> 'deleted'"), verified: await n("select count(*) n from users where status <> 'deleted' and email_verified_at is not null"),
      active30d: await n("select count(*) n from users where status = 'active' and last_login_at > now() - interval '30 days'"), suspended: await n("select count(*) n from users where status = 'suspended'"),
      robloxConnections: await n("select count(*) n from roblox_connections where status = 'active'"), connectedExperiences: await n('select count(*) n from roblox_experiences'),
      scans: await n('select count(*) n from scan_jobs'), scansDone: await n("select count(*) n from scan_jobs where status = 'done'"), scansFailed: await n("select count(*) n from scan_jobs where status = 'failed'"),
      activeJobs: await n("select count(*) n from jobs where status in ('queued', 'running')"), failedJobs: await n("select count(*) n from jobs where status = 'failed'"),
      subscriptions: { light_month: await sub('light', 'month'), light_year: await sub('light', 'year'), max_month: await sub('max', 'month'), max_year: await sub('max', 'year') },
      canceled: await n("select count(*) n from subscriptions where environment = $1 and status = 'canceled'", [env]), scheduledCancellations: await n("select count(*) n from subscriptions where environment = $1 and status = 'active' and scheduled_change->>'action' = 'cancel'", [env]),
      paymentFailures30d: await n("select count(*) n from subscription_events where environment = $1 and event_type = 'transaction.payment_failed' and occurred_at > now() - interval '30 days'", [env]),
      recentSecurity: (await db.query('select kind, ip, at from security_events order by at desc limit 15')).rows,
      recentAdmin: (await db.query('select action, target, outcome, at from admin_audit_log order by at desc limit 15')).rows,
      billingEnvironment: env,
    };
  });

  app.get('/api/admin/users', async req => {
    await requireRole(req, ['administrator', 'support', 'security']);
    const q = str((req.query as any).q, 100);
    return (await db.query(`select u.id, u.email, u.display_name, u.status, u.email_verified_at is not null verified, u.created_at, u.last_login_at, coalesce(e.plan, 'free') plan, e.billing_interval
      from users u left join entitlements e on e.user_id = u.id where u.status <> 'deleted' and ($1 = '' or u.email ilike '%' || $1 || '%' or u.display_name ilike '%' || $1 || '%' or u.id::text = $1) order by u.created_at desc limit 50`, [q])).rows;
  });
  app.get('/api/admin/users/:id', async req => {
    const roles = await requireRole(req, ['administrator', 'support', 'security']), id = uid(req);
    const u = await db.one('select id, email, display_name, status, suspended_reason, email_verified_at, created_at, last_login_at, mfa_enabled_at is not null mfa from users where id = $1', [id]); if (!u) fail(404, 'User not found.');
    const sec = roles.some(r => ['owner', 'administrator', 'security'].includes(r));
    await audit(req.user!.id, 'view_user', id, null, 'ok');
    return { user: u,
      providers: (await db.query('select provider, created_at from auth_identities where user_id = $1', [id])).rows.map(r => r.provider).concat((await db.one('select password_hash is not null p from users where id = $1', [id]))?.p ? ['password'] : []),
      roblox: await db.one('select roblox_user_id::text, roblox_username, status, connected_at, last_used_at from roblox_connections where user_id = $1', [id]),
      experiences: (await db.query('select universe_id::text, name, active from roblox_experiences where user_id = $1', [id])).rows,
      plan: await db.one('select plan, billing_interval, status_note from entitlements where user_id = $1', [id]),
      sessions: await n('select count(*) n from sessions where user_id = $1 and revoked_at is null and expires_at > now()', [id]),
      security: sec ? (await db.query('select kind, ip, at from security_events where user_id = $1 order by at desc limit 50', [id])).rows : null,
      roles: (await db.query('select role, granted_at from admin_roles where user_id = $1', [id])).rows };
  });
  app.post('/api/admin/users/:id/suspend', async req => {
    await requireRole(req, ['administrator']); const id = uid(req), why = reason(req);
    if (id === req.user!.id) fail(400, 'You can\'t suspend yourself.');
    if ((await db.query("select 1 from admin_roles where user_id = $1 and role = 'owner'", [id])).rows.length) fail(403, 'Owners can\'t be suspended here.');
    const r = await db.query("update users set status = 'suspended', suspended_reason = $2 where id = $1 and status = 'active' returning id", [id, why]);
    await db.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [id]);
    await audit(req.user!.id, 'suspend_user', id, why, r.rows.length ? 'ok' : 'not_active'); return { ok: !!r.rows.length };
  });
  app.post('/api/admin/users/:id/reinstate', async req => {
    await requireRole(req, ['administrator']); const id = uid(req), why = reason(req);
    const r = await db.query("update users set status = 'active', suspended_reason = null where id = $1 and status = 'suspended' returning id", [id]);
    await audit(req.user!.id, 'reinstate_user', id, why, r.rows.length ? 'ok' : 'not_suspended'); return { ok: !!r.rows.length };
  });
  app.post('/api/admin/users/:id/revoke-sessions', async req => {
    await requireRole(req, ['administrator', 'security']); const id = uid(req), why = reason(req);
    const r = await db.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null returning id', [id]);
    await audit(req.user!.id, 'revoke_sessions', id, why, `${r.rows.length} revoked`); return { revoked: r.rows.length };
  });
  app.post('/api/admin/users/:id/delete', async req => {
    await requireRole(req, ['administrator']); const id = uid(req), why = reason(req);
    if ((await db.query("select 1 from admin_roles where user_id = $1 and role = 'owner'", [id])).rows.length) fail(403, 'Owners can\'t be deleted here.');
    await db.query("update users set status = 'deleted', deleted_at = now() where id = $1 and status <> 'deleted'", [id]);
    await db.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [id]);
    await enqueue('delete_account', { userId: id }, { key: 'delete:' + id });
    await audit(req.user!.id, 'delete_user', id, why, 'queued'); return { ok: true };
  });

  app.get('/api/admin/security-events', async req => {
    await requireRole(req, ['security']);
    return (await db.query("select id, user_id, kind, ip, detail, at from security_events where ($1 = '' or kind = $1) order by at desc limit 200", [str((req.query as any).kind, 60)])).rows;
  });
  app.get('/api/admin/audit', async req => { await requireRole(req, ['security']); return (await db.query('select * from admin_audit_log order by at desc limit 300')).rows; });

  app.get('/api/admin/requests', async req => {
    await requireRole(req, ['administrator', 'support']);
    return (await db.query("select id, user_id, email, kind, subject, body, status, resolution, created_at from support_requests where ($1 = '' or status = $1) order by created_at desc limit 200", [str((req.query as any).status, 20)])).rows;
  });
  app.patch('/api/admin/requests/:id', async req => {
    await requireRole(req, ['administrator', 'support']); const id = uid(req), b: any = req.body ?? {};
    if (!['open', 'in_progress', 'resolved', 'rejected'].includes(b.status)) fail(400, 'Invalid status.');
    await db.query('update support_requests set status = $2, resolution = $3, handled_by = $4, updated_at = now() where id = $1', [id, b.status, str(b.resolution, 4000) || null, req.user!.id]);
    await audit(req.user!.id, 'update_request', id, str(b.resolution, 200) || b.status, b.status); return { ok: true };
  });

  // Billing: amounts come from provider transactions. MRR/ARR are estimates from active subscriptions and configured prices.
  app.get('/api/admin/billing', async req => {
    await requireRole(req, ['administrator']); const env = config.paddle.environment;
    const active = (await db.query("select plan, billing_interval, count(*)::int n from subscriptions where environment = $1 and status in ('active', 'trialing') and plan is not null group by 1, 2", [env])).rows;
    const mrrCents = active.reduce((a, r) => a + r.n * (r.billing_interval === 'year' ? Math.round(PRICES[r.plan as 'light'][r.billing_interval as 'year'] / 12) : PRICES[r.plan as 'light'].month), 0);
    const cash = (await db.query("select currency, billing_interval, sum(amount_cents)::bigint total, count(*)::int n from billing_transactions where environment = $1 and status in ('completed', 'paid') group by 1, 2", [env])).rows;
    const refunds = (await db.query("select currency, action, status, sum(amount_cents)::bigint total, count(*)::int n from billing_adjustments where environment = $1 group by 1, 2, 3", [env])).rows;
    await audit(req.user!.id, 'view_billing_overview', null, null, 'ok');
    return { environment: env, active, estimatedMrrCents: mrrCents, estimatedArrCents: mrrCents * 12, cashCollected: cash, adjustments: refunds,
      failedPayments30d: await n("select count(*) n from billing_transactions where environment = $1 and status = 'past_due' and updated_at > now() - interval '30 days'", [env]),
      scheduledCancellations: (await db.query("select provider_subscription_id, user_id, plan, billing_interval, scheduled_change from subscriptions where environment = $1 and scheduled_change->>'action' = 'cancel'", [env])).rows,
      recent: (await db.query('select transaction_id, user_id, status, amount_cents, currency, billing_interval, billed_at from billing_transactions where environment = $1 order by updated_at desc limit 30', [env])).rows };
  });
  app.get('/api/admin/users/:id/billing', async req => {
    await requireRole(req, ['administrator']); const id = uid(req);
    await audit(req.user!.id, 'view_user_billing', id, null, 'ok');
    return { customer: (await db.query('select provider, environment, customer_id, created_at from billing_customers where user_id = $1', [id])).rows,
      subscriptions: (await db.query('select provider_subscription_id, environment, plan, billing_interval, status, current_period_end, next_billed_at, scheduled_change, canceled_at, last_event_at from subscriptions where user_id = $1 order by updated_at desc', [id])).rows,
      transactions: (await db.query('select transaction_id, status, amount_cents, currency, billing_interval, billed_at from billing_transactions where user_id = $1 order by billed_at desc nulls last limit 50', [id])).rows };
  });

  // Roles: only an owner can grant or remove them, never for themselves, so nobody can raise their own access.
  app.get('/api/admin/roles', async req => { await requireRole(req, ['administrator', 'security']); return (await db.query('select r.user_id, u.email, r.role, r.granted_at from admin_roles r join users u on u.id = r.user_id order by r.granted_at')).rows; });
  app.post('/api/admin/roles', async req => {
    const roles = await requireRole(req, ['owner']), b: any = req.body ?? {}, why = reason(req);
    if (!roles.includes('owner')) fail(403, 'Only an owner can change roles.');
    if (!UUID.test(String(b.userId)) || !['owner', 'administrator', 'support', 'security'].includes(b.role)) fail(400, 'Invalid role change.');
    if (b.userId === req.user!.id) fail(403, 'You can\'t change your own roles.');
    const target = await db.one("select mfa_enabled_at from users where id = $1 and status = 'active'", [b.userId]); if (!target) fail(404, 'User not found.');
    if (!target.mfa_enabled_at) fail(400, 'That user must turn on two-step verification first.');
    await db.query('insert into admin_roles (user_id, role, granted_by) values ($1, $2, $3) on conflict do nothing', [b.userId, b.role, req.user!.id]);
    await audit(req.user!.id, 'grant_role:' + b.role, b.userId, why, 'ok'); return { ok: true };
  });
  app.delete('/api/admin/roles', async req => {
    const roles = await requireRole(req, ['owner']), b: any = req.body ?? {}, why = reason(req);
    if (!roles.includes('owner')) fail(403, 'Only an owner can change roles.');
    if (b.userId === req.user!.id) fail(403, 'You can\'t change your own roles.');
    await db.query('delete from admin_roles where user_id = $1 and role = $2', [b.userId, b.role]);
    await audit(req.user!.id, 'revoke_role:' + b.role, b.userId, why, 'ok'); return { ok: true };
  });
}
