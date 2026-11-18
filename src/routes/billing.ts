import type { FastifyInstance } from 'fastify';
import { config, configured } from '../config.ts';
import { db } from '../db.ts';
import { handleWebhookEvent, provider } from '../billing.ts';
import { fail, ip, requireUser } from '../http.ts';
import { priceIdFor, publicCatalog } from '../plans.ts';
import { securityEvent, throttles } from '../security.ts';

export default async function billingRoutes(app: FastifyInstance) {
  app.get('/api/plans', async () => ({
    currency: 'USD', plans: publicCatalog(), paymentsAvailable: configured.paddle(),
    paddle: configured.paddle() ? { environment: config.paddle.environment, clientToken: config.paddle.clientToken } : null, // client tokens are public by design
  }));

  // The browser only names a plan and interval; the server maps them to configured Paddle price IDs.
  app.post('/api/billing/checkout', async req => {
    const u = requireUser(req), b: any = req.body ?? {};
    if (!throttles.billing.take(u.id).ok) fail(429, 'Too many checkout attempts. Try again later.');
    if (!configured.paddle()) fail(503, 'Payments aren\'t available yet.');
    if (!u.email_verified_at) fail(403, 'Confirm your email address before subscribing.');
    const priceId = priceIdFor(b.plan, b.interval); if (!priceId) fail(400, 'Choose Light or Max, billed monthly or annually.');
    const active = await db.one("select provider_subscription_id from subscriptions where user_id = $1 and environment = $2 and status in ('active', 'trialing', 'past_due') limit 1", [u.id, config.paddle.environment]);
    if (active) fail(409, 'You already have a subscription. Change plans from Billing instead.', { hasSubscription: true });
    const customerId = await provider().ensureCustomer(u);
    const { transactionId } = await provider().createCheckout(customerId, priceId!, u.id);
    await securityEvent('checkout_started', { userId: u.id, ip: ip(req), detail: { plan: b.plan, interval: b.interval } });
    return { transactionId };
  });

  app.post('/api/billing/change', async req => {
    const u = requireUser(req), b: any = req.body ?? {};
    if (!throttles.billing.take(u.id).ok) fail(429, 'Too many attempts. Try again later.');
    if (!configured.paddle()) fail(503, 'Payments aren\'t available yet.');
    const priceId = priceIdFor(b.plan, b.interval); if (!priceId) fail(400, 'Choose Light or Max, billed monthly or annually.');
    const s = await db.one("select provider_subscription_id, price_id from subscriptions where user_id = $1 and environment = $2 and status in ('active', 'trialing') limit 1", [u.id, config.paddle.environment]);
    if (!s) fail(404, 'No active subscription to change.');
    if (s.price_id === priceId) fail(400, 'You\'re already on that plan.');
    await provider().changePlan(s.provider_subscription_id, priceId!);
    await securityEvent('plan_change_requested', { userId: u.id, ip: ip(req), detail: { plan: b.plan, interval: b.interval } });
    return { ok: true, message: 'Plan change sent to Paddle. Your plan updates as soon as Paddle confirms it.' };
  });

  // Portal sessions are created for the signed-in user's own customer record only; no IDs come from the browser.
  app.post('/api/billing/portal', async req => {
    const u = requireUser(req);
    if (!configured.paddle()) fail(503, 'Payments aren\'t available yet.');
    const c = await db.one("select customer_id from billing_customers where provider = 'paddle' and environment = $1 and user_id = $2", [config.paddle.environment, u.id]);
    if (!c) fail(404, 'No billing account yet.');
    const subs = (await db.query("select provider_subscription_id from subscriptions where user_id = $1 and environment = $2 and status <> 'canceled'", [u.id, config.paddle.environment])).rows.map(r => r.provider_subscription_id);
    return { url: await provider().portalUrl(c.customer_id, subs) };
  });

  app.get('/api/billing/history', async req => {
    const u = requireUser(req);
    return (await db.query('select transaction_id, status, amount_cents, currency, billing_interval, billed_at from billing_transactions where user_id = $1 and environment = $2 order by billed_at desc nulls last limit 50', [u.id, config.paddle.environment])).rows;
  });

  // Webhook: raw body + Paddle-Signature verification, idempotent by event_id, ordered by occurred_at.
  app.post('/api/billing/webhook', async (req, reply) => {
    const raw = (req as any).rawBody as string | undefined;
    if (!raw || !provider().verifyWebhook(raw, req.headers['paddle-signature'] as string | undefined)) {
      await securityEvent('webhook_signature_invalid', { ip: ip(req) }); return reply.code(401).send({ error: 'Invalid signature' });
    }
    const status = await handleWebhookEvent(JSON.parse(raw));
    return { ok: true, status };
  });
}
