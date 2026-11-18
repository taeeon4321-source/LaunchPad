// Privacy-friendly analytics: allow-listed event names, small props, no account or IP stored.
import type { FastifyInstance } from 'fastify';
import { db } from '../db.ts';
import { fail, ip, requireRole, str } from '../http.ts';
import { throttles } from '../security.ts';

const EVENTS = ['pricing_view', 'billing_toggle', 'plan_select', 'checkout_start', 'checkout_complete', 'checkout_cancel', 'checkout_fail',
  'onboarding_start', 'onboarding_skip', 'onboarding_step', 'onboarding_complete', 'onboarding_restart', 'first_game_added', 'first_scan_completed'];
export const SERVER_EVENTS = ['subscription_active', 'subscription_cancelled', 'refund'];
const clean = (o: unknown) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).slice(0, 6).map(([k, v]) => [str(k, 30), typeof v === 'number' ? v : str(v, 40)]));

export async function serverEvent(name: string, props: Record<string, unknown> = {}) {
  await db.query('insert into analytics_events (name, props) values ($1, $2)', [name, clean(props)]);
}

export default async function analyticsRoutes(app: FastifyInstance) {
  app.post('/api/events', async (req, reply) => {
    const b: any = req.body ?? {};
    if (!throttles.events.take(ip(req)).ok) return reply.code(204).send();
    if (!EVENTS.includes(b.name)) fail(400, 'Unknown event.');
    await db.query('insert into analytics_events (name, session, variants, props) values ($1, $2, $3, $4)', [b.name, str(b.session, 40) || null, clean(b.variants), clean(b.props)]);
    return reply.code(204).send();
  });

  // Funnel and split by experiment variant over the last N days.
  app.get('/api/admin/analytics', async req => {
    await requireRole(req, ['administrator']);
    const days = Math.min(365, Math.max(1, Number((req.query as any).days) || 30));
    const counts = (await db.query(`select name, count(*)::int n, count(distinct session)::int sessions from analytics_events where at > now() - ($1 || ' days')::interval group by name`, [String(days)])).rows;
    const byPlan = (await db.query(`select name, props->>'plan' plan, props->>'interval' interval, count(*)::int n from analytics_events where at > now() - ($1 || ' days')::interval and name in ('plan_select', 'checkout_start', 'checkout_complete') group by 1, 2, 3 order by 1, 2, 3`, [String(days)])).rows;
    const byVariant = (await db.query(`select v.key experiment, v.value variant, e.name, count(distinct e.session)::int sessions from analytics_events e, jsonb_each_text(e.variants) v
      where e.at > now() - ($1 || ' days')::interval group by 1, 2, 3 order by 1, 2, 3`, [String(days)])).rows;
    const onboarding = (await db.query(`select name, props->>'step' step, count(*)::int n from analytics_events where at > now() - ($1 || ' days')::interval and name in ('onboarding_step', 'onboarding_skip') group by 1, 2 order by 1, (props->>'step')::int nulls first`, [String(days)])).rows;
    return { days, counts, byPlan, byVariant, onboarding };
  });
}
