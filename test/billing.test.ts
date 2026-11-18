import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { makeApp, client, registerUser } from './helpers.ts';
import { db } from '../src/db.ts';
import { config } from '../src/config.ts';
import { savings, PRICES } from '../src/plans.ts';
import { planOf } from '../src/entitlements.ts';

const P = { light_month: 'pri_lm', light_year: 'pri_ly', max_month: 'pri_mm', max_year: 'pri_my' };
let app: any, U: any, calls: any[] = [];
const realFetch = globalThis.fetch;
before(async () => {
  Object.assign(config.paddle, { apiKey: 'test_key', clientToken: 'test_client', webhookSecret: 'whsec', environment: 'sandbox', prices: { ...P } });
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const ok = (data: object) => new Response(JSON.stringify({ data }), { status: 200 });
    if (String(url).endsWith('/customers')) return ok({ id: 'ctm_1' });
    if (String(url).endsWith('/transactions')) return ok({ id: 'txn_1' });
    if (String(url).includes('/portal-sessions')) return ok({ urls: { general: { overview: 'https://sandbox-customer-portal.paddle.com/x' } } });
    return realFetch(url, init);
  }) as any;
  app = await makeApp(); U = await registerUser(app, 'payer@example.com');
});
after(async () => { globalThis.fetch = realFetch; await app.close(); await db.close(); });

let n = 0;
async function webhook(event_type: string, data: object, occurred = new Date().toISOString(), o: { sig?: string; id?: string } = {}) {
  const body = JSON.stringify({ event_id: o.id ?? `evt_${++n}`, event_type, occurred_at: occurred, data }), ts = Math.floor(Date.now() / 1000);
  const sig = o.sig ?? `ts=${ts};h1=${createHmac('sha256', 'whsec').update(`${ts}:${body}`).digest('hex')}`;
  const r = await app.inject({ method: 'POST', url: '/api/billing/webhook', payload: body, headers: { 'content-type': 'application/json', 'paddle-signature': sig } });
  return { status: r.statusCode, json: r.json() };
}
const sub = (id: string, price: string, status = 'active', extra = {}) => ({ id, status, customer_id: 'ctm_1', custom_data: { user_id: U.id }, items: [{ price: { id: price, product_id: 'pro_x' } }], current_billing_period: { starts_at: '2026-01-01T00:00:00Z', ends_at: '2027-01-01T00:00:00Z' }, next_billed_at: '2027-01-01T00:00:00Z', ...extra });

test('price table and annual savings', () => {
  assert.deepEqual(PRICES, { light: { month: 999, year: 9999 }, max: { month: 4999, year: 19999 } });
  assert.deepEqual([savings('light').saving, savings('light').percent, savings('light').effectiveMonthly], ['$19.89', '16.6', '$8.33']);
  assert.deepEqual([savings('max').saving, savings('max').percent, savings('max').effectiveMonthly, savings('max').twelveMonthly], ['$399.89', '66.7', '$16.67', '$599.88']);
});

test('checkout uses server-side price IDs only and needs a verified email', async () => {
  assert.equal((await U.c.call('POST', '/api/billing/checkout', { plan: 'max', interval: 'year' })).status, 403);
  await db.query('update users set email_verified_at = now() where id = $1', [U.id]);
  assert.equal((await U.c.call('POST', '/api/billing/checkout', { plan: 'max', interval: 'year', price_id: 'pri_cheap', amount: 1 })).json.transactionId, 'txn_1');
  const txn = calls.find(c => c.url.endsWith('/transactions'));
  assert.deepEqual(txn.body.items, [{ price_id: 'pri_my', quantity: 1 }], 'annual Max uses the annual Max price ID');
  assert.equal(txn.body.custom_data.user_id, U.id);
  assert.equal((await U.c.call('POST', '/api/billing/checkout', { plan: 'ultra', interval: 'year' })).status, 400);
  assert.equal((await U.c.call('POST', '/api/billing/checkout', { plan: 'light', interval: 'week' })).status, 400);
  assert.equal(await planOf(U.id), 'free', 'starting checkout grants nothing');
});

test('webhook signatures are verified', async () => {
  assert.equal((await webhook('subscription.created', sub('sub_x', P.max_month), undefined, { sig: 'ts=1;h1=deadbeef' })).status, 401);
  assert.equal((await webhook('subscription.created', sub('sub_x', P.max_month), undefined, { sig: `ts=${Math.floor(Date.now() / 1000)};h1=${'0'.repeat(64)}` })).status, 401);
  assert.equal(await planOf(U.id), 'free');
});

test('each of the four prices grants the right plan; interval never changes features', async () => {
  for (const [price, plan, interval] of [[P.light_month, 'light', 'month'], [P.light_year, 'light', 'year'], [P.max_month, 'max', 'month'], [P.max_year, 'max', 'year']]) {
    await db.query('delete from subscriptions'); await db.query('delete from entitlements');
    await webhook('subscription.created', sub('sub_' + price, price));
    assert.equal(await planOf(U.id), plan, price);
    assert.equal((await db.one('select billing_interval from subscriptions where provider_subscription_id = $1', ['sub_' + price])).billing_interval, interval);
    assert.equal((await U.c.call('GET', '/api/me')).json.entitlement.plan, plan);
  }
});

test('duplicate, out-of-order, scheduled cancellation, cancellation, past due', async () => {
  await db.query('delete from subscriptions'); await db.query('delete from entitlements');
  const t0 = '2026-03-01T00:00:00Z', t1 = '2026-03-02T00:00:00Z', t2 = '2026-03-03T00:00:00Z';
  await webhook('subscription.created', sub('sub_1', P.light_month), t0, { id: 'evt_dup' });
  assert.equal((await webhook('subscription.created', sub('sub_1', P.light_month), t0, { id: 'evt_dup' })).json.status, 'duplicate');
  await webhook('subscription.updated', sub('sub_1', P.max_month), t2);
  assert.equal((await webhook('subscription.updated', sub('sub_1', P.light_month), t1)).json.status, 'ignored', 'older event arriving late is ignored');
  assert.equal(await planOf(U.id), 'max', 'upgrade applied');
  await webhook('subscription.updated', sub('sub_1', P.max_month, 'active', { scheduled_change: { action: 'cancel', effective_at: '2026-04-03T00:00:00Z' } }), '2026-03-04T00:00:00Z');
  assert.equal(await planOf(U.id), 'max', 'scheduled cancellation keeps access until it takes effect');
  await webhook('subscription.past_due', sub('sub_1', P.max_month, 'past_due'), '2026-03-05T00:00:00Z');
  assert.equal(await planOf(U.id), 'free', 'past due with no configured grace period removes paid features');
  await webhook('subscription.updated', sub('sub_1', P.max_month, 'active'), '2026-03-06T00:00:00Z');
  await webhook('subscription.canceled', sub('sub_1', P.max_month, 'canceled', { canceled_at: '2026-04-03T00:00:00Z' }), '2026-04-03T00:00:01Z');
  assert.equal(await planOf(U.id), 'free');
  assert.ok((await db.query("select 1 from email_outbox where to_email = $1 and template = 'subscription_canceled'", [U.email])).rows.length);
  await U.c.call('PUT', '/api/me/preferences', { prefs: { plan: 'max', entitlement: 'max' } });
  assert.equal(await planOf(U.id), 'free', 'browser-side values never grant a plan');
});

test('transactions record amounts; refunds are adjustments; portal is per user', async () => {
  await webhook('transaction.completed', { id: 'txn_9', status: 'completed', customer_id: 'ctm_1', subscription_id: 'sub_1', origin: 'web', currency_code: 'USD', billed_at: '2026-03-01T00:00:00Z', items: [{ price: { id: P.max_year } }], details: { totals: { grand_total: '19999' } } });
  const t = await db.one("select amount_cents, billing_interval from billing_transactions where transaction_id = 'txn_9'");
  assert.deepEqual([Number(t.amount_cents), t.billing_interval], [19999, 'year'], 'annual Max is charged $199.99 once');
  const mail = await db.one("select body_html from email_outbox where template = 'subscription_active' order by id desc limit 1");
  assert.match(mail.body_html, /\$199\.99/); assert.match(mail.body_html, /annually, paid upfront/);
  await webhook('adjustment.created', { id: 'adj_1', transaction_id: 'txn_9', action: 'refund', status: 'approved', currency_code: 'USD', totals: { total: '19999' } });
  assert.equal((await db.one("select action from billing_adjustments where adjustment_id = 'adj_1'")).action, 'refund');
  assert.equal((await U.c.call('POST', '/api/billing/portal')).json.url, 'https://sandbox-customer-portal.paddle.com/x');
  const other = await registerUser(app, 'notpayer@example.com');
  assert.equal((await other.c.call('POST', '/api/billing/portal')).status, 404);
});
