import type { FastifyInstance } from 'fastify';
import { config, configured } from '../config.ts';
import { db } from '../db.ts';
import { sendEmail } from '../email.ts';
import { verifyGoogleCredential } from '../google.ts';
import { fail, ip, requireUser, requireRecentAuth, startSession, cookieOpts, SESSION_COOKIE, str, validEmail } from '../http.ts';
import { decrypt, encrypt, hashPassword, newTotpSecret, passwordProblem, randomToken, securityEvent, sha256, throttles, verifyPassword, verifyTotp } from '../security.ts';
import { currentLegalVersions } from './legal.ts';

const GNONCE = 'lp_gnonce';
const DUMMY_HASH = hashPassword(randomToken());
const tooMany = (retryAfter: number) => fail(429, `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`);

async function issueToken(userId: string, kind: 'verify_email' | 'reset_password', minutes: number) {
  const t = randomToken(32);
  if (kind === 'reset_password') await db.query("update auth_tokens set used_at = now() where user_id = $1 and kind = 'reset_password' and used_at is null", [userId]);
  await db.query(`insert into auth_tokens (user_id, kind, token_hash, expires_at) values ($1, $2, $3, now() + ($4 || ' minutes')::interval)`, [userId, kind, sha256(t), String(minutes)]);
  return t;
}
// Single-use: the update only succeeds once, and only before expiry.
async function useToken(token: unknown, kind: string) {
  if (typeof token !== 'string' || token.length > 100) return null;
  return db.one('update auth_tokens set used_at = now() where token_hash = $1 and kind = $2 and used_at is null and expires_at > now() returning user_id', [sha256(token), kind]);
}
async function sendVerification(u: { id: string; email: string }) {
  const t = await issueToken(u.id, 'verify_email', 24 * 60);
  await sendEmail(u.email, 'verify_email', { link: `${config.appOrigin}/#/verify?token=${t}` });
}
async function recordAcceptance(userId: string, ipAddr: string) {
  for (const d of await currentLegalVersions(['terms', 'privacy'])) await db.query('insert into legal_acceptances (user_id, slug, version, ip) values ($1, $2, $3, $4) on conflict do nothing', [userId, d.slug, d.version, ipAddr]);
}

export default async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/config', async () => ({ googleClientId: config.google.clientId || null, emailDelivery: configured.email() }));

  app.post('/api/auth/register', async (req, reply) => {
    const b: any = req.body ?? {}, email = str(b.email, 254).toLowerCase(), name = str(b.displayName, 60);
    if (!throttles.register.take(ip(req)).ok) fail(429, 'Too many sign-ups from this network. Try again later.');
    if (!validEmail(email)) fail(400, 'Enter a valid email address.');
    if (!name) fail(400, 'Enter a display name.');
    const pp = passwordProblem(b.password, email); if (pp) fail(400, pp);
    if (b.acceptTerms !== true) fail(400, 'Please accept the Terms of Service and Privacy Policy.');
    if (b.ageConfirmed !== true) fail(400, 'Please confirm you meet the minimum age.');
    if (await db.one("select 1 from users where lower(email) = $1 and status <> 'deleted'", [email]))
      fail(409, "Couldn't create an account with that email. If you already have one, log in or reset your password.");
    const u = await db.one('insert into users (email, display_name, password_hash) values ($1, $2, $3) returning id, email', [email, name, await hashPassword(b.password)]);
    await recordAcceptance(u.id, ip(req));
    await securityEvent('register', { userId: u.id, ip: ip(req), detail: { method: 'password' } });
    await sendVerification(u); await sendEmail(email, 'welcome', { name });
    await startSession(req, reply, u.id);
    return { ok: true };
  });

  app.post('/api/auth/verify-email', async req => {
    const r = await useToken((req.body as any)?.token, 'verify_email'); if (!r) fail(400, 'This link is invalid or has expired. Request a new one from Settings.');
    await db.query('update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1', [r!.user_id]);
    await securityEvent('email_verified', { userId: r!.user_id, ip: ip(req) });
    return { ok: true };
  });
  app.post('/api/auth/resend-verification', async req => {
    const u = requireUser(req); if (u.email_verified_at) return { ok: true };
    if (!throttles.reset.take('verify:' + u.id).ok) fail(429, 'Please wait before requesting another email.');
    await sendVerification(u); return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const b: any = req.body ?? {}, email = str(b.email, 254).toLowerCase();
    const t1 = throttles.loginIp.take(ip(req)), t2 = throttles.login.take(ip(req) + '|' + email);
    if (!t1.ok || !t2.ok) { await securityEvent('login_throttled', { ip: ip(req) }); tooMany(Math.max(t1.retryAfter, t2.retryAfter)); }
    const u = await db.one("select * from users where lower(email) = $1 and status <> 'deleted'", [email]);
    // Hash even when the user doesn't exist so response time doesn't reveal which emails have accounts.
    const ok = await verifyPassword(u?.password_hash ?? await DUMMY_HASH, String(b.password ?? ''));
    if (!u || !ok) { await securityEvent('login_failed', { userId: u?.id, ip: ip(req) }); fail(401, 'Email or password is incorrect.'); }
    if (u.status === 'suspended') { await securityEvent('login_suspended', { userId: u.id, ip: ip(req) }); fail(403, 'This account is suspended. Contact support if you think this is a mistake.'); }
    if (u.mfa_enabled_at) {
      if (!b.code) return { mfaRequired: true };
      if (!verifyTotp(decrypt(u.mfa_secret_enc), b.code)) { await securityEvent('mfa_failed', { userId: u.id, ip: ip(req) }); fail(401, 'That code didn\'t work. Use the current code from your authenticator app.'); }
    }
    throttles.login.reset(ip(req) + '|' + email);
    await startSession(req, reply, u.id, { mfa: !!u.mfa_enabled_at });
    await securityEvent('login', { userId: u.id, ip: ip(req), detail: { method: 'password' } });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.session) await db.query('update sessions set revoked_at = now() where id = $1', [req.session.id]);
    reply.clearCookie(SESSION_COOKIE, cookieOpts()); return { ok: true };
  });
  app.post('/api/auth/logout-all', async (req, reply) => {
    const u = requireUser(req);
    await db.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [u.id]);
    await securityEvent('logout_all', { userId: u.id, ip: ip(req) });
    reply.clearCookie(SESSION_COOKIE, cookieOpts()); return { ok: true };
  });
  app.get('/api/auth/sessions', async req => {
    const u = requireUser(req);
    const rows = (await db.query('select id, created_at, last_seen_at, ip, user_agent from sessions where user_id = $1 and revoked_at is null and expires_at > now() order by last_seen_at desc', [u.id])).rows;
    return rows.map(r => ({ ...r, current: r.id === req.session!.id }));
  });
  app.delete('/api/auth/sessions/:id', async req => {
    const u = requireUser(req), id = str((req.params as any).id, 40);
    const r = await db.query('update sessions set revoked_at = now() where id::text = $1 and user_id = $2 and revoked_at is null returning id', [id, u.id]);
    if (!r.rows.length) fail(404, 'Session not found.');
    await securityEvent('session_revoked', { userId: u.id, ip: ip(req) }); return { ok: true };
  });

  app.post('/api/auth/forgot', async req => {
    const email = str((req.body as any)?.email, 254).toLowerCase();
    if (!throttles.reset.take(ip(req)).ok || !throttles.reset.take('e:' + email).ok) fail(429, 'Too many requests. Try again later.');
    const u = validEmail(email) && await db.one("select id, email from users where lower(email) = $1 and status = 'active'", [email]);
    if (u) { const t = await issueToken(u.id, 'reset_password', 30); await sendEmail(u.email, 'reset_password', { link: `${config.appOrigin}/#/reset?token=${t}` }); await securityEvent('password_reset_requested', { userId: u.id, ip: ip(req) }); }
    return { ok: true, message: 'If an account uses that email, we sent a reset link.' };
  });
  app.post('/api/auth/reset', async (req, reply) => {
    const b: any = req.body ?? {};
    if (!throttles.reset.take('r:' + ip(req)).ok) fail(429, 'Too many attempts. Try again later.');
    const pp = passwordProblem(b.password); if (pp) fail(400, pp);
    const r = await useToken(b.token, 'reset_password'); if (!r) fail(400, 'This reset link is invalid or has expired. Request a new one.');
    const u = await db.one("update users set password_hash = $2, email_verified_at = coalesce(email_verified_at, now()) where id = $1 and status = 'active' returning id, email", [r!.user_id, await hashPassword(b.password)]);
    if (!u) fail(400, 'This account can\'t be reset.');
    await db.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [u.id]);
    await securityEvent('password_reset', { userId: u.id, ip: ip(req) });
    await sendEmail(u.email, 'security_notice', { what: 'Your password was reset and every device was signed out.' });
    reply.clearCookie(SESSION_COOKIE, cookieOpts()); return { ok: true };
  });

  app.post('/api/auth/password', async req => {
    const u = requireUser(req), b: any = req.body ?? {};
    if (u.password_hash ? !(await verifyPassword(u.password_hash, String(b.current ?? ''))) : (requireRecentAuth(req), false)) fail(401, 'Your current password is incorrect.');
    const pp = passwordProblem(b.password, u.email); if (pp) fail(400, pp);
    await db.query('update users set password_hash = $2 where id = $1', [u.id, await hashPassword(b.password)]);
    await db.query('update sessions set revoked_at = now() where user_id = $1 and id <> $2 and revoked_at is null', [u.id, req.session!.id]);
    await securityEvent('password_changed', { userId: u.id, ip: ip(req) });
    await sendEmail(u.email, 'security_notice', { what: 'Your password was changed. Other devices were signed out.' });
    return { ok: true };
  });

  // Re-authentication before sensitive actions (deletion, MFA changes, unlinking, Roblox disconnect).
  app.post('/api/auth/reauth', async (req, reply) => {
    const u = requireUser(req), b: any = req.body ?? {};
    if (!throttles.login.take(ip(req) + '|reauth|' + u.id).ok) tooMany(900);
    let ok = false;
    if (b.password) ok = await verifyPassword(u.password_hash, String(b.password));
    else if (b.credential) { try { const g = await verifyGoogleCredential(b.credential, req.cookies[GNONCE]); ok = !!(await db.one("select 1 from auth_identities where provider = 'google' and provider_subject = $1 and user_id = $2", [g.sub, u.id])); } catch { ok = false; } reply.clearCookie(GNONCE, cookieOpts()); }
    if (ok && u.mfa_enabled_at) ok = verifyTotp(decrypt(u.mfa_secret_enc!), b.code);
    if (!ok) { await securityEvent('reauth_failed', { userId: u.id, ip: ip(req) }); fail(401, u.mfa_enabled_at ? 'That didn\'t match. Enter your password and current authenticator code.' : 'That didn\'t match.'); }
    await db.query('update sessions set authenticated_at = now(), mfa_at = case when $2 then now() else mfa_at end where id = $1', [req.session!.id, !!u.mfa_enabled_at]);
    return { ok: true };
  });

  // Google Identity Services. The nonce is random per attempt; only its hash is kept, in an httpOnly cookie.
  app.get('/api/auth/google/nonce', async (req, reply) => {
    if (!configured.google()) fail(503, 'Google sign-in isn\'t configured yet.');
    const n = randomToken(24); reply.setCookie(GNONCE, sha256(n), cookieOpts(600)); return { nonce: n };
  });
  app.post('/api/auth/google', async (req, reply) => {
    const b: any = req.body ?? {};
    if (!throttles.loginIp.take(ip(req)).ok) tooMany(900);
    let g; try { g = await verifyGoogleCredential(b.credential, req.cookies[GNONCE]); } catch (e: any) { await securityEvent('google_token_rejected', { ip: ip(req), detail: { reason: String(e.message).slice(0, 80) } }); fail(401, 'Google sign-in couldn\'t be verified. Please try again.'); }
    const linked = await db.one("select u.* from auth_identities i join users u on u.id = i.user_id where i.provider = 'google' and i.provider_subject = $1", [g!.sub]);

    if (b.mode === 'link') { // connect Google to the signed-in account
      const u = requireUser(req); requireRecentAuth(req);
      if (linked) fail(409, linked.id === u.id ? 'This Google account is already connected.' : 'That Google account is connected to a different LaunchPad account.');
      await db.query("insert into auth_identities (user_id, provider, provider_subject, email) values ($1, 'google', $2, $3)", [u.id, g!.sub, g!.email]);
      await securityEvent('identity_linked', { userId: u.id, ip: ip(req), detail: { provider: 'google' } });
      await sendEmail(u.email, 'security_notice', { what: 'A Google account was connected to your LaunchPad account.' });
      reply.clearCookie(GNONCE, cookieOpts()); return { ok: true };
    }
    if (linked) {
      if (linked.status !== 'active') fail(403, 'This account is suspended or closed. Contact support.');
      if (linked.mfa_enabled_at) {
        if (!b.code) { reply.setCookie(GNONCE, req.cookies[GNONCE] ?? '', cookieOpts(600)); return { mfaRequired: true }; }
        if (!verifyTotp(decrypt(linked.mfa_secret_enc), b.code)) fail(401, 'That code didn\'t work.');
      }
      await startSession(req, reply, linked.id, { mfa: !!linked.mfa_enabled_at });
      await securityEvent('login', { userId: linked.id, ip: ip(req), detail: { method: 'google' } });
      reply.clearCookie(GNONCE, cookieOpts()); return { ok: true };
    }
    // New Google user. Matching email never merges accounts automatically.
    if (!g!.email || !g!.emailVerified) fail(400, 'Your Google account needs a verified email address.');
    if (await db.one("select 1 from users where lower(email) = $1 and status <> 'deleted'", [g!.email!.toLowerCase()]))
      fail(409, 'A LaunchPad account already uses this email. Log in with your password, then connect Google in Settings → Security.');
    if (b.acceptTerms !== true || b.ageConfirmed !== true) return { needsConsent: true, email: g!.email, name: g!.name };
    const u = await db.one('insert into users (email, display_name, email_verified_at) values ($1, $2, now()) returning id', [g!.email, (g!.name || g!.email!.split('@')[0]).slice(0, 60)]);
    await db.query("insert into auth_identities (user_id, provider, provider_subject, email) values ($1, 'google', $2, $3)", [u.id, g!.sub, g!.email]);
    await recordAcceptance(u.id, ip(req));
    await securityEvent('register', { userId: u.id, ip: ip(req), detail: { method: 'google' } });
    await sendEmail(g!.email!, 'welcome', { name: g!.name || 'there' });
    await startSession(req, reply, u.id);
    reply.clearCookie(GNONCE, cookieOpts()); return { ok: true, created: true };
  });
  app.delete('/api/auth/google', async req => {
    const u = requireUser(req); requireRecentAuth(req);
    if (!u.password_hash) fail(400, 'Set a password first, so you can still log in without Google.');
    await db.query("delete from auth_identities where user_id = $1 and provider = 'google'", [u.id]);
    await securityEvent('identity_unlinked', { userId: u.id, ip: ip(req), detail: { provider: 'google' } });
    await sendEmail(u.email, 'security_notice', { what: 'Google was disconnected from your LaunchPad account.' });
    return { ok: true };
  });

  // Two-step verification (TOTP). Required for administrators, optional for everyone else.
  app.post('/api/auth/mfa/setup', async req => {
    const u = requireUser(req); requireRecentAuth(req);
    if (u.mfa_enabled_at) fail(400, 'Two-step verification is already on.');
    const secret = newTotpSecret();
    await db.query('update users set mfa_secret_enc = $2 where id = $1', [u.id, encrypt(secret)]);
    return { secret, uri: `otpauth://totp/LaunchPad:${encodeURIComponent(u.email)}?secret=${secret}&issuer=LaunchPad` };
  });
  app.post('/api/auth/mfa/enable', async req => {
    const u = requireUser(req); requireRecentAuth(req);
    if (!u.mfa_secret_enc || u.mfa_enabled_at) fail(400, 'Start setup first.');
    if (!verifyTotp(decrypt(u.mfa_secret_enc!), (req.body as any)?.code)) fail(400, 'That code didn\'t work. Check your device\'s clock and try the current code.');
    await db.query('update users set mfa_enabled_at = now() where id = $1', [u.id]);
    await db.query('update sessions set mfa_at = now() where id = $1', [req.session!.id]);
    await securityEvent('mfa_enabled', { userId: u.id, ip: ip(req) });
    await sendEmail(u.email, 'security_notice', { what: 'Two-step verification was turned on.' });
    return { ok: true };
  });
  app.post('/api/auth/mfa/disable', async req => {
    const u = requireUser(req); requireRecentAuth(req);
    if ((await db.query('select 1 from admin_roles where user_id = $1', [u.id])).rows.length) fail(403, 'Administrators must keep two-step verification on.');
    await db.query('update users set mfa_enabled_at = null, mfa_secret_enc = null where id = $1', [u.id]);
    await securityEvent('mfa_disabled', { userId: u.id, ip: ip(req) });
    await sendEmail(u.email, 'security_notice', { what: 'Two-step verification was turned off.' });
    return { ok: true };
  });
}
