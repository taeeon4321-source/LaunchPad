// Profile, preferences, consents, data export and account deletion.
import type { FastifyInstance } from 'fastify';
import { db } from '../db.ts';
import { entitlementSummary } from '../entitlements.ts';
import { enqueue } from '../jobs.ts';
import { fail, ip, requireUser, requireRecentAuth, rolesOf, str, cookieOpts, SESSION_COOKIE } from '../http.ts';
import { securityEvent } from '../security.ts';
import { checkImageBytes } from './data.ts';

export default async function meRoutes(app: FastifyInstance) {
  app.get('/api/me', async req => {
    if (!req.user) return { user: null };
    const u = req.user;
    const [ids, prefs, roblox, roles, ent] = await Promise.all([
      db.query("select provider, email, created_at from auth_identities where user_id = $1", [u.id]),
      db.one('select prefs, consents from user_preferences where user_id = $1', [u.id]),
      db.one('select roblox_user_id, roblox_username, scopes, status, connected_at, last_used_at from roblox_connections where user_id = $1', [u.id]),
      rolesOf(u.id), entitlementSummary(u.id),
    ]);
    return { user: { id: u.id, email: u.email, displayName: u.display_name, emailVerified: !!u.email_verified_at, createdAt: u.created_at, hasPassword: !!u.password_hash, mfaEnabled: !!u.mfa_enabled_at, hasAvatar: !!(await db.one('select 1 from users where id = $1 and avatar is not null', [u.id])) },
      identities: ids.rows, prefs: prefs?.prefs ?? {}, consents: prefs?.consents ?? {}, roblox: roblox ? { userId: String(roblox.roblox_user_id), username: roblox.roblox_username, scopes: roblox.scopes, status: roblox.status, connectedAt: roblox.connected_at, lastUsedAt: roblox.last_used_at } : null,
      roles, entitlement: ent, sessionAuthenticatedAt: req.session!.authenticated_at };
  });

  app.patch('/api/me', async req => {
    const u = requireUser(req), name = str((req.body as any)?.displayName, 60);
    if (!name) fail(400, 'Enter a display name.');
    await db.query('update users set display_name = $2 where id = $1', [u.id, name]); return { ok: true };
  });
  app.put('/api/me/preferences', async req => {
    const u = requireUser(req), p = (req.body as any)?.prefs;
    if (!p || typeof p !== 'object' || JSON.stringify(p).length > 4000) fail(400, 'Invalid preferences.');
    await db.asUser(u.id, q => q.query('insert into user_preferences (user_id, prefs) values ($1, $2) on conflict (user_id) do update set prefs = excluded.prefs, updated_at = now()', [u.id, p]));
    return { ok: true };
  });
  // Consents are explicit, per purpose, and can be withdrawn at any time.
  app.put('/api/me/consents', async req => {
    const u = requireUser(req), b: any = req.body ?? {}, allowed = ['scriptInspection', 'productEmails'];
    const c = Object.fromEntries(allowed.filter(k => typeof b[k] === 'boolean').map(k => [k, { granted: b[k], at: new Date().toISOString() }]));
    await db.asUser(u.id, q => q.query(`insert into user_preferences (user_id, consents) values ($1, $2) on conflict (user_id) do update set consents = user_preferences.consents || excluded.consents, updated_at = now()`, [u.id, c]));
    await securityEvent('consent_changed', { userId: u.id, ip: ip(req), detail: Object.fromEntries(Object.entries(c).map(([k, v]: any) => [k, v.granted])) });
    return { ok: true };
  });

  app.put('/api/me/avatar', async req => {
    const u = requireUser(req), m = String((req.body as any)?.dataUrl ?? '').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) fail(400, 'Use a PNG, JPEG or WebP image.');
    const buf = Buffer.from(m![2], 'base64'), err = checkImageBytes(buf, m![1]); if (err) fail(400, err);
    if (buf.length > 1024 * 1024) fail(400, 'Profile images must be 1 MB or smaller.');
    await db.query('update users set avatar = $2, avatar_type = $3 where id = $1', [u.id, buf, m![1]]); return { ok: true };
  });
  app.delete('/api/me/avatar', async req => { const u = requireUser(req); await db.query('update users set avatar = null, avatar_type = null where id = $1', [u.id]); return { ok: true }; });
  app.get('/api/me/avatar', async (req, reply) => {
    const u = requireUser(req), r = await db.one('select avatar, avatar_type from users where id = $1', [u.id]);
    if (!r?.avatar) fail(404, 'No profile image.');
    reply.header('Content-Type', r.avatar_type).header('Cache-Control', 'private, max-age=60').header('Content-Disposition', 'inline'); return reply.send(Buffer.from(r.avatar));
  });

  // Export everything LaunchPad stores about this account (no secrets: token and password hashes are left out).
  app.get('/api/me/export', async (req, reply) => {
    const u = requireUser(req);
    const own = (sql: string) => db.asUser(u.id, q => q.query(sql, [u.id])).then(r => r.rows);
    const out = {
      exportedAt: new Date().toISOString(),
      account: await db.one('select id, email, display_name, email_verified_at, created_at, last_login_at, mfa_enabled_at from users where id = $1', [u.id]),
      identities: (await db.query('select provider, email, created_at from auth_identities where user_id = $1', [u.id])).rows,
      sessions: (await db.query('select created_at, last_seen_at, ip, user_agent, revoked_at from sessions where user_id = $1', [u.id])).rows,
      preferences: await own('select prefs, consents from user_preferences where user_id = $1'),
      games: await own('select data from games where user_id = $1'),
      reports: await own('select data from reports where user_id = $1'),
      overrides: await own('select game_id, field, value from developer_overrides where user_id = $1'),
      robloxConnection: await db.one('select roblox_user_id, roblox_username, scopes, status, connected_at from roblox_connections where user_id = $1', [u.id]),
      robloxExperiences: await own('select universe_id, name, active, connected_at from roblox_experiences where user_id = $1'),
      scans: await own('select universe_id, place_id, created_at, data, changes from scan_snapshots where user_id = $1'),
      // Analytics: API keys are listed by name and hint only (the secret is never exported).
      analyticsKeys: await own('select label, key_hint, created_at, last_used_at from analytics_credentials where user_id = $1'),
      analyticsLinks: await own('select game_id, universe_id, status, last_success_at from analytics_links where user_id = $1'),
      analyticsUploads: await own('select id, game_id, kind, filename, timezone, row_count, created_at from analytics_datasets where user_id = $1'),
      analyticsData: await own('select game_id, source, metric, granularity, breakdown, t, t_end, value, status, sample_size from metric_points where user_id = $1 order by game_id, metric, t'),
      forecasts: await own('select game_id, metric, breakdown, generated_at, result from analytics_forecasts where user_id = $1'),
      savedCharts: await own('select id, name, config, updated_at from saved_charts where user_id = $1'),
      dashboards: await own('select id, name, widgets, updated_at from dashboards where user_id = $1'),
      legalAcceptances: (await db.query('select slug, version, accepted_at from legal_acceptances where user_id = $1', [u.id])).rows,
      subscriptions: (await db.query('select plan, billing_interval, status, current_period_end, provider_subscription_id from subscriptions where user_id = $1', [u.id])).rows,
      requests: (await db.query('select kind, subject, status, created_at from support_requests where user_id = $1', [u.id])).rows,
      securityEvents: (await db.query('select kind, ip, at from security_events where user_id = $1 order by at desc limit 500', [u.id])).rows,
    };
    await securityEvent('data_export', { userId: u.id, ip: ip(req) });
    reply.header('Content-Disposition', 'attachment; filename="launchpad-export.json"');
    return out;
  });

  // Deletion: sign-in stops immediately; a job revokes third-party access, cancels billing and deletes data.
  app.post('/api/me/delete', async (req, reply) => {
    const u = requireUser(req); requireRecentAuth(req);
    if ((req.body as any)?.confirm !== 'DELETE') fail(400, 'Type DELETE to confirm.');
    if ((await rolesOf(u.id)).includes('owner')) fail(400, 'Transfer ownership to another administrator before deleting this account.');
    await db.query("update users set status = 'deleted', deleted_at = now() where id = $1", [u.id]);
    await db.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [u.id]);
    await securityEvent('account_deletion_requested', { userId: u.id, ip: ip(req) });
    await enqueue('delete_account', { userId: u.id }, { key: 'delete:' + u.id });
    reply.clearCookie(SESSION_COOKIE, cookieOpts());
    return { ok: true };
  });
}
