// Billing provider abstraction plus the Paddle Billing implementation. Another provider can implement the same
// interface without touching routes, entitlements or the database model.
import { createHmac } from 'node:crypto';
import { config, configured } from './config.ts';
import { db } from './db.ts';
import { sendEmail } from './email.ts';
import { recomputeEntitlement } from './entitlements.ts';
import { planForPriceId } from './plans.ts';
import { safeEqual, securityEvent } from './security.ts';
import { serverEvent } from './routes/analytics.ts';

export interface BillingProvider {
  name: string;
  ensureCustomer(user: { id: string; email: string; display_name: string }): Promise<string>;
  createCheckout(customerId: string, priceId: string, userId: string): Promise<{ transactionId: string }>;
  changePlan(subscriptionId: string, priceId: string): Promise<void>;
  portalUrl(customerId: string, subscriptionIds: string[]): Promise<string>;
  getSubscription(id: string): Promise<any>;
  cancelNow(id: string): Promise<void>;
  verifyWebhook(raw: string, signature: string | undefined): boolean;
}

const base = () => config.paddle.environment === 'live' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
async function paddle(method: string, path: string, body?: object) {
  const r = await fetch(base() + path, { method, headers: { Authorization: `Bearer ${config.paddle.apiKey}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) { const e: any = new Error(`Paddle ${method} ${path.split('?')[0]} failed: ${r.status} ${j?.error?.code ?? ''}`); e.status = r.status; e.code = j?.error?.code; throw e; }
  return j.data;
}

export const paddleProvider: BillingProvider = {
  name: 'paddle',
  async ensureCustomer(u) {
    const env = config.paddle.environment, have = await db.one("select customer_id from billing_customers where provider = 'paddle' and environment = $1 and user_id = $2", [env, u.id]);
    if (have) return have.customer_id;
    let id: string;
    try { id = (await paddle('POST', '/customers', { email: u.email, name: u.display_name, custom_data: { user_id: u.id } })).id; }
    catch (e: any) {
      if (e.code !== 'customer_already_exists') throw e;
      // Paddle already has this email: reuse that customer only if it isn't linked to another LaunchPad user.
      const list = await paddle('GET', `/customers?email=${encodeURIComponent(u.email)}`); id = list?.[0]?.id; if (!id) throw e;
      const other = await db.one("select user_id from billing_customers where provider = 'paddle' and environment = $1 and customer_id = $2", [env, id]);
      if (other && other.user_id !== u.id) throw new Error('Billing customer belongs to another account');
    }
    await db.query("insert into billing_customers (provider, environment, customer_id, user_id) values ('paddle', $1, $2, $3) on conflict (provider, environment, customer_id) do update set user_id = excluded.user_id", [env, id, u.id]);
    return id;
  },
  async createCheckout(customerId, priceId, userId) {
    const t = await paddle('POST', '/transactions', { items: [{ price_id: priceId, quantity: 1 }], customer_id: customerId, custom_data: { user_id: userId }, collection_mode: 'automatic' });
    return { transactionId: t.id };
  },
  async changePlan(subscriptionId, priceId) { await paddle('PATCH', `/subscriptions/${encodeURIComponent(subscriptionId)}`, { items: [{ price_id: priceId, quantity: 1 }], proration_billing_mode: 'prorated_immediately' }); },
  async portalUrl(customerId, subscriptionIds) { const s = await paddle('POST', `/customers/${encodeURIComponent(customerId)}/portal-sessions`, { subscription_ids: subscriptionIds }); return s.urls.general.overview; },
  getSubscription: id => paddle('GET', `/subscriptions/${encodeURIComponent(id)}`),
  async cancelNow(id) { await paddle('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { effective_from: 'immediately' }); },
  // Paddle-Signature: "ts=<unix>;h1=<hex hmac>"; signed payload is "<ts>:<raw body>". Multiple h1 values can appear during secret rotation.
  verifyWebhook(raw, signature) {
    if (!signature || !config.paddle.webhookSecret) return false;
    const parts = signature.split(';').map(p => p.split('=')), ts = parts.find(p => p[0] === 'ts')?.[1], h1s = parts.filter(p => p[0] === 'h1').map(p => p[1]);
    if (!ts || !/^\d+$/.test(ts) || !h1s.length || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
    const expected = createHmac('sha256', config.paddle.webhookSecret).update(`${ts}:${raw}`).digest('hex');
    return h1s.some(h => safeEqual(h, expected));
  },
};
export const provider = () => paddleProvider;
const env = () => config.paddle.environment;

async function userForCustomer(customerId?: string, custom?: any) {
  if (custom?.user_id && /^[0-9a-f-]{36}$/.test(custom.user_id) && await db.one('select 1 from users where id = $1', [custom.user_id])) return custom.user_id as string;
  if (!customerId) return null;
  return (await db.one("select user_id from billing_customers where provider = 'paddle' and environment = $1 and customer_id = $2", [env(), customerId]))?.user_id ?? null;
}
export const portalLink = () => `${config.appOrigin}/#/settings/billing`;

// Applies a subscription snapshot from a webhook or from reconciliation. Older snapshots never overwrite newer ones.
export async function applySubscription(s: any, occurredAt: string, eventId: string | null) {
  const existing = await db.one("select * from subscriptions where provider = 'paddle' and environment = $1 and provider_subscription_id = $2", [env(), s.id]);
  if (existing?.last_event_at && new Date(existing.last_event_at) > new Date(occurredAt)) return 'ignored';
  const userId = existing?.user_id ?? await userForCustomer(s.customer_id, s.custom_data);
  const priceId = s.items?.[0]?.price?.id ?? null, mapped = priceId ? planForPriceId(priceId) : null;
  if (priceId && !mapped) await securityEvent('billing_unknown_price', { userId, detail: { priceId } });
  const pastDueSince = s.status === 'past_due' ? (existing?.past_due_since ?? occurredAt) : null;
  await db.query(`insert into subscriptions (provider, environment, provider_subscription_id, provider_customer_id, user_id, product_id, price_id, plan, billing_interval, status,
      current_period_start, current_period_end, next_billed_at, scheduled_change, canceled_at, past_due_since, last_event_at, last_event_id, updated_at)
    values ('paddle', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())
    on conflict (provider, environment, provider_subscription_id) do update set provider_customer_id = excluded.provider_customer_id, user_id = coalesce(subscriptions.user_id, excluded.user_id),
      product_id = excluded.product_id, price_id = excluded.price_id, plan = excluded.plan, billing_interval = excluded.billing_interval, status = excluded.status,
      current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end, next_billed_at = excluded.next_billed_at,
      scheduled_change = excluded.scheduled_change, canceled_at = excluded.canceled_at, past_due_since = excluded.past_due_since, last_event_at = excluded.last_event_at, last_event_id = excluded.last_event_id, updated_at = now()`,
    [env(), s.id, s.customer_id ?? null, userId, s.items?.[0]?.price?.product_id ?? null, priceId, mapped?.plan ?? null, mapped?.interval ?? null, s.status,
      s.current_billing_period?.starts_at ?? null, s.current_billing_period?.ends_at ?? null, s.next_billed_at ?? null, s.scheduled_change ?? null, s.canceled_at ?? null, pastDueSince, occurredAt, eventId]);
  if (userId) {
    const before = (await db.one('select plan from entitlements where user_id = $1', [userId]))?.plan ?? 'free';
    const after = await recomputeEntitlement(userId);
    const u = await db.one('select email from users where id = $1', [userId]);
    if (u && before !== after) {
      if (before !== 'free' && after !== 'free') await sendEmail(u.email, 'plan_changed', { from: cap(before), to: cap(after), interval: mapped?.interval ?? 'month', portal: portalLink() });
      else if (after === 'free') { await sendEmail(u.email, 'subscription_canceled', { plan: cap(before), until: null, portal: portalLink() }); await serverEvent('subscription_cancelled', { plan: before }); }
    } else if (u && s.scheduled_change?.action === 'cancel' && !existing?.scheduled_change)
      await sendEmail(u.email, 'subscription_canceled', { plan: cap(after), until: String(s.scheduled_change.effective_at).slice(0, 10), portal: portalLink() });
  }
  return 'processed';
}
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export async function handleWebhookEvent(evt: any) {
  if (!evt?.event_id || !evt?.event_type || !evt?.occurred_at) throw new Error('Malformed event');
  const ins = await db.query("insert into subscription_events (provider, environment, event_id, event_type, occurred_at, payload) values ('paddle', $1, $2, $3, $4, $5) on conflict do nothing returning event_id",
    [env(), evt.event_id, evt.event_type, evt.occurred_at, evt]);
  if (!ins.rows.length) return 'duplicate';
  let status = 'processed';
  try {
    const d = evt.data ?? {}, type: string = evt.event_type;
    if (type.startsWith('subscription.')) status = await applySubscription(d, evt.occurred_at, evt.event_id);
    else if (type.startsWith('transaction.')) {
      const userId = await userForCustomer(d.customer_id, d.custom_data), priceId = d.items?.[0]?.price?.id, mapped = priceId ? planForPriceId(priceId) : null;
      const total = d.details?.totals?.grand_total != null ? Number(d.details.totals.grand_total) : null;
      await db.query(`insert into billing_transactions (provider, environment, transaction_id, user_id, subscription_id, status, origin, amount_cents, currency, billing_interval, billed_at, updated_at)
        values ('paddle', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now()) on conflict (provider, environment, transaction_id) do update set status = excluded.status, amount_cents = excluded.amount_cents, billed_at = excluded.billed_at, user_id = coalesce(billing_transactions.user_id, excluded.user_id), updated_at = now()`,
        [env(), d.id, userId, d.subscription_id ?? null, d.status, d.origin ?? null, total, d.currency_code ?? null, mapped?.interval ?? null, d.billed_at ?? null]);
      const u = userId && await db.one('select email from users where id = $1', [userId]);
      if (type === 'transaction.completed' && mapped) await serverEvent('subscription_active', { plan: mapped.plan, interval: mapped.interval });
      if (u && type === 'transaction.completed' && mapped && total != null) {
        const sub = d.subscription_id && await db.one("select next_billed_at from subscriptions where provider_subscription_id = $1", [d.subscription_id]);
        await sendEmail(u.email, 'subscription_active', { plan: cap(mapped.plan), interval: mapped.interval, amountCents: total, currency: d.currency_code, nextBilled: sub?.next_billed_at ? new Date(sub.next_billed_at).toISOString().slice(0, 10) : null, portal: portalLink() });
      }
      if (u && type === 'transaction.payment_failed') await sendEmail(u.email, 'payment_failed', { plan: cap(mapped?.plan ?? 'LaunchPad'), portal: portalLink() });
    } else if (type.startsWith('adjustment.')) {
      if (type === 'adjustment.created') await serverEvent(d.action === 'refund' ? 'refund' : 'adjustment', { action: d.action });
      await db.query(`insert into billing_adjustments (provider, environment, adjustment_id, transaction_id, action, status, amount_cents, currency) values ('paddle', $1, $2, $3, $4, $5, $6, $7)
        on conflict (provider, environment, adjustment_id) do update set status = excluded.status, amount_cents = excluded.amount_cents`,
        [env(), d.id, d.transaction_id ?? null, d.action ?? null, d.status ?? null, d.totals?.total != null ? Number(d.totals.total) : null, d.currency_code ?? null]);
    } else status = 'ignored';
    await db.query("update subscription_events set status = $3, processed_at = now() where environment = $1 and event_id = $2", [env(), evt.event_id, status]);
  } catch (e: any) {
    await db.query("update subscription_events set status = 'failed', error = $3 where environment = $1 and event_id = $2", [env(), evt.event_id, String(e.message).slice(0, 300)]);
    throw e;
  }
  return status;
}

export async function reconcileSubscriptions() {
  if (!configured.paddle()) return;
  const subs = (await db.query("select provider_subscription_id from subscriptions where provider = 'paddle' and environment = $1 and status <> 'canceled'", [env()])).rows;
  for (const s of subs) { const fresh = await provider().getSubscription(s.provider_subscription_id); await applySubscription(fresh, fresh.updated_at ?? new Date().toISOString(), null); }
}
