// The single server-side entitlement service. Paid access comes only from verified subscription state.
import { config } from './config.ts';
import { db, type Q } from './db.ts';
import { planFeatures, planLimit, type Plan, type LimitKey } from './plans.ts';

// Which provider statuses grant access. Scheduled cancellations stay "active" in Paddle until they take effect.
function grants(s: any, now = Date.now()) {
  if (s.status === 'active' || s.status === 'trialing') return true;
  if (s.status === 'past_due') { const since = s.past_due_since ? new Date(s.past_due_since).getTime() : now; return now - since < config.paddle.pastDueGraceDays * 86400e3; }
  return false;
}

export async function recomputeEntitlement(userId: string, q: Q = db) {
  const subs = (await q.query('select * from subscriptions where user_id = $1 and environment = $2', [userId, config.paddle.environment])).rows;
  const active = subs.filter(s => grants(s) && s.plan).sort((a, b) => (b.plan === 'max' ? 1 : 0) - (a.plan === 'max' ? 1 : 0))[0];
  const plan: Plan = active ? active.plan : 'free';
  await q.query(`insert into entitlements (user_id, plan, billing_interval, source_subscription_id, status_note, updated_at) values ($1, $2, $3, $4, $5, now())
    on conflict (user_id) do update set plan = excluded.plan, billing_interval = excluded.billing_interval, source_subscription_id = excluded.source_subscription_id, status_note = excluded.status_note, updated_at = now()`,
    [userId, plan, active?.billing_interval ?? null, active?.id ?? null, active ? active.status : null]);
  return plan;
}

export async function planOf(userId: string): Promise<Plan> {
  const r = await db.one('select plan from entitlements where user_id = $1', [userId]);
  return r ? r.plan : recomputeEntitlement(userId);
}
export async function canAccess(userId: string, feature: string) { return planFeatures(await planOf(userId)).includes(feature); }
export async function getUsageLimit(userId: string, key: LimitKey) { return planLimit(await planOf(userId), key); }

export async function entitlementSummary(userId: string) {
  const e = await db.one('select e.plan, e.billing_interval, e.status_note, s.current_period_end, s.next_billed_at, s.scheduled_change, s.status from entitlements e left join subscriptions s on s.id = e.source_subscription_id where e.user_id = $1', [userId])
    ?? { plan: await recomputeEntitlement(userId) };
  const plan = (e.plan || 'free') as Plan;
  return { plan, interval: e.billing_interval ?? null, status: e.status ?? null, periodEnd: e.current_period_end ?? null, nextBilledAt: e.next_billed_at ?? null, scheduledChange: e.scheduled_change ?? null, features: planFeatures(plan),
    limits: Object.fromEntries((['connected_experiences', 'monthly_scans', 'sync_interval_minutes', 'report_history_days', 'analytics_history_days', 'dashboards'] as LimitKey[]).map(k => [k, planLimit(plan, k)])) };
}

// Usage counting for configurable allowances (e.g. monthly scans). Returns false when the configured limit is reached.
export async function useAllowance(userId: string, metric: LimitKey & 'monthly_scans') {
  const limit = await getUsageLimit(userId, metric), period = new Date().toISOString().slice(0, 7);
  const r = await db.one(`insert into usage_counters (user_id, metric, period, count) values ($1, $2, $3, 1)
    on conflict (user_id, metric, period) do update set count = usage_counters.count + 1 returning count`, [userId, metric, period]);
  if (limit != null && r!.count > limit) { await db.query('update usage_counters set count = count - 1 where user_id = $1 and metric = $2 and period = $3', [userId, metric, period]); return false; }
  return true;
}
