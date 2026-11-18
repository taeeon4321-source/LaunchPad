// Roblox OAuth 2.0 (authorization code + PKCE, state, nonce) and LaunchPad Studio pairing, status and scan upload.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, randomInt } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config, configured } from '../config.ts';
import { db } from '../db.ts';
import { canAccess, getUsageLimit, planOf, useAllowance } from '../entitlements.ts';
import { enqueue } from '../jobs.ts';
import { cookieOpts, fail, ip, requireRecentAuth, requireUser, str } from '../http.ts';
import { decrypt, encrypt, randomToken, securityEvent, sha256, throttles } from '../security.ts';
import { parseScan } from '../scan.ts';

const R = 'https://apis.roblox.com/oauth/v1';
const RCOOKIE = 'lp_rbx';
const robloxJwks = createRemoteJWKSet(new URL(`${R}/certs`));
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
async function rbx(path: string, body: Record<string, string>) {
  const r = await fetch(R + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ client_id: config.roblox.clientId, client_secret: config.roblox.clientSecret, ...body }), signal: AbortSignal.timeout(15000) });
  const j: any = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`Roblox ${path} failed: ${r.status} ${j.error ?? ''}`); return j;
}

async function storeAuthorizedExperiences(userId: string, accessToken: string) {
  const res = await rbx('/token/resources', { token: accessToken });
  const ids = new Set<number>();
  for (const info of res.resource_infos ?? []) for (const id of info?.resources?.universe?.ids ?? []) if (/^\d+$/.test(String(id))) ids.add(Number(id));
  await db.asUser(userId, async q => {
    for (const id of ids) await q.query('insert into roblox_experiences (user_id, universe_id, owner_type, owner_id) values ($1, $2, $3, $4) on conflict (user_id, universe_id) do nothing',
      [userId, id, null, null]);
    if (ids.size) await q.query('delete from roblox_experiences where user_id = $1 and not (universe_id = any($2))', [userId, [...ids]]);
  });
  return ids.size;
}
// Returns a valid access token, refreshing it when it's about to expire.
export async function robloxAccessToken(userId: string) {
  const c = await db.one("select * from roblox_connections where user_id = $1 and status = 'active'", [userId]); if (!c) return null;
  if (new Date(c.token_expires_at).getTime() - Date.now() > 60e3) return decrypt(c.access_token_enc);
  try {
    const t = await rbx('/token', { grant_type: 'refresh_token', refresh_token: decrypt(c.refresh_token_enc) });
    await db.query("update roblox_connections set access_token_enc = $2, refresh_token_enc = $3, token_expires_at = now() + ($4 || ' seconds')::interval, last_used_at = now() where user_id = $1",
      [userId, encrypt(t.access_token), encrypt(t.refresh_token), String(t.expires_in)]);
    return t.access_token as string;
  } catch { await db.query("update roblox_connections set status = 'expired' where user_id = $1", [userId]); await securityEvent('roblox_token_refresh_failed', { userId }); return null; }
}

// Plugin requests carry a per-installation bearer token (hashed in the database, expiring, revocable).
async function pluginUser(req: FastifyRequest) {
  const h = String(req.headers.authorization || ''), t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!t || t.length > 100) fail(401, 'This plugin isn\'t paired. Pair it again from LaunchPad.');
  const r = await db.one(`select i.id iid, u.id, u.display_name, u.status from studio_installations i join users u on u.id = i.user_id
    where i.token_hash = $1 and i.revoked_at is null and i.expires_at > now()`, [sha256(t)]);
  if (!r || r.status !== 'active') fail(401, 'This plugin isn\'t paired anymore. Pair it again from LaunchPad.');
  await db.query('update studio_installations set last_seen_at = now() where id = $1', [r.iid]);
  return r;
}
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

export default async function robloxRoutes(app: FastifyInstance) {
  app.get('/api/roblox/connect', async (req, reply) => {
    const u = requireUser(req);
    if (!configured.roblox()) return reply.redirect('/#/settings/connected?roblox=not_configured');
    if (!(await canAccess(u.id, 'roblox_connection'))) return reply.redirect('/#/pricing?need=roblox');
    const state = randomToken(24), verifier = randomToken(48), nonce = randomToken(24);
    reply.setCookie(RCOOKIE, encrypt(JSON.stringify({ state, verifier, nonce, uid: u.id, exp: Date.now() + 600e3 })), cookieOpts(600));
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return reply.redirect(`${R}/authorize?${form({ client_id: config.roblox.clientId, redirect_uri: config.roblox.redirectUri, scope: config.roblox.scopes, response_type: 'code', state, nonce, code_challenge: challenge, code_challenge_method: 'S256' })}`);
  });

  app.get('/api/roblox/callback', async (req, reply) => {
    const q: any = req.query, back = (s: string) => reply.redirect(`/#/settings/connected?roblox=${s}`);
    let saved: any; try { saved = JSON.parse(decrypt(req.cookies[RCOOKIE] ?? '')); } catch { saved = null; }
    reply.clearCookie(RCOOKIE, cookieOpts());
    if (!req.user || !saved || saved.exp < Date.now() || saved.uid !== req.user.id || typeof q.state !== 'string' || q.state !== saved.state) { await securityEvent('roblox_oauth_state_invalid', { userId: req.user?.id, ip: ip(req) }); return back('invalid_state'); }
    if (q.error) { await securityEvent('roblox_oauth_denied', { userId: req.user.id, ip: ip(req) }); return back('denied'); }
    try {
      const t = await rbx('/token', { grant_type: 'authorization_code', code: String(q.code ?? ''), code_verifier: saved.verifier, redirect_uri: config.roblox.redirectUri });
      const { payload } = await jwtVerify(t.id_token, robloxJwks, { issuer: 'https://apis.roblox.com/oauth/', audience: config.roblox.clientId });
      if (payload.nonce !== saved.nonce) throw new Error('nonce mismatch');
      const robloxId = Number(payload.sub); if (!Number.isSafeInteger(robloxId)) throw new Error('bad subject');
      await db.query(`insert into roblox_connections (user_id, roblox_user_id, roblox_username, access_token_enc, refresh_token_enc, token_expires_at, scopes, status, connected_at, last_used_at)
        values ($1, $2, $3, $4, $5, now() + ($6 || ' seconds')::interval, $7, 'active', now(), now())
        on conflict (user_id) do update set roblox_user_id = excluded.roblox_user_id, roblox_username = excluded.roblox_username, access_token_enc = excluded.access_token_enc, refresh_token_enc = excluded.refresh_token_enc,
          token_expires_at = excluded.token_expires_at, scopes = excluded.scopes, status = 'active', connected_at = now(), last_used_at = now()`,
        [req.user.id, robloxId, str(payload.preferred_username ?? payload.name, 60) || null, encrypt(t.access_token), encrypt(t.refresh_token), String(t.expires_in), str(t.scope, 500)]);
      const n = await storeAuthorizedExperiences(req.user.id, t.access_token);
      await securityEvent('roblox_connected', { userId: req.user.id, ip: ip(req), detail: { robloxUserId: robloxId, experiences: n } });
      return back('connected');
    } catch (e: any) { await securityEvent('roblox_oauth_failed', { userId: req.user.id, ip: ip(req), detail: { reason: String(e.message).slice(0, 100) } }); return back('failed'); }
  });

  app.post('/api/roblox/disconnect', async req => {
    const u = requireUser(req); requireRecentAuth(req);
    const c = await db.one('select refresh_token_enc from roblox_connections where user_id = $1', [u.id]);
    if (c && configured.roblox()) { try { await rbx('/token/revoke', { token: decrypt(c.refresh_token_enc) }); } catch { /* still remove local access below */ } }
    await db.query('delete from roblox_connections where user_id = $1', [u.id]);
    await db.asUser(u.id, q => q.query('delete from roblox_experiences where user_id = $1', [u.id]));
    await db.query('update studio_installations set revoked_at = now() where user_id = $1 and revoked_at is null', [u.id]);
    await securityEvent('roblox_disconnected', { userId: u.id, ip: ip(req) });
    return { ok: true, message: 'Roblox disconnected. Your games and reports were kept.' };
  });
  app.post('/api/roblox/refresh-experiences', async req => {
    const u = requireUser(req), t = await robloxAccessToken(u.id); if (!t) fail(409, 'Reconnect Roblox to refresh your experiences.');
    return { count: await storeAuthorizedExperiences(u.id, t!) };
  });
  app.get('/api/roblox/experiences', async req => {
    const u = requireUser(req);
    const limit = await getUsageLimit(u.id, 'connected_experiences'); // outside the transaction: one connection at a time
    return db.asUser(u.id, async q => ({ limit, experiences: (await q.query('select universe_id::text, name, active, connected_at from roblox_experiences where user_id = $1 order by connected_at', [u.id])).rows }));
  });
  // After a downgrade, the developer chooses which experiences stay active; nothing is deleted.
  app.patch('/api/roblox/experiences/:id', async req => {
    const u = requireUser(req), id = String((req.params as any).id), active = (req.body as any)?.active === true;
    if (!/^\d{1,20}$/.test(id)) fail(400, 'Invalid experience.');
    const lim = active ? await getUsageLimit(u.id, 'connected_experiences') : null;
    await db.asUser(u.id, async q => {
      if (active) { const n = Number((await q.query('select count(*) n from roblox_experiences where user_id = $1 and active and universe_id <> $2', [u.id, id])).rows[0].n);
        if (lim != null && n >= lim) fail(403, `Your plan allows ${lim} active experience(s). Turn another one off first.`); }
      if (!(await q.query('update roblox_experiences set active = $3 where user_id = $1 and universe_id = $2 returning 1', [u.id, id, active])).rows.length) fail(404, 'Experience not found.');
    });
    return { ok: true };
  });

  // --- LaunchPad Studio pairing: plugin starts, signed-in website confirms, plugin collects a revocable token.
  app.post('/api/plugin/pair/start', async req => {
    if (!throttles.pairing.take('start:' + ip(req)).ok) fail(429, 'Too many pairing attempts. Try again in a few minutes.');
    const code = newCode(), poll = randomToken(32);
    const r = await db.one("insert into pairing_codes (code_hash, poll_secret_hash, expires_at) values ($1, $2, now() + interval '10 minutes') returning id", [sha256(code), sha256(poll)]);
    return { pairingId: r.id, code, pollSecret: poll, expiresInSeconds: 600, confirmUrl: `${config.appOrigin}/#/studio` };
  });
  app.post('/api/plugin/pair/confirm', async req => {
    const u = requireUser(req), code = str((req.body as any)?.code, 20).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!throttles.pairing.take('confirm:' + u.id).ok || !throttles.pairing.take('confirm-ip:' + ip(req)).ok) fail(429, 'Too many attempts. Try again in a few minutes.');
    if (!(await canAccess(u.id, 'studio_plugin'))) fail(403, 'Connecting LaunchPad Studio needs a Light or Max plan.', { upgrade: true });
    const r = await db.one('update pairing_codes set user_id = $2, confirmed_at = now() where code_hash = $1 and confirmed_at is null and expires_at > now() returning id', [sha256(code), u.id]);
    if (!r) { await securityEvent('pairing_code_rejected', { userId: u.id, ip: ip(req) }); fail(400, 'That code is wrong, expired or already used. Start pairing again in the plugin.'); }
    await securityEvent('studio_paired', { userId: u.id, ip: ip(req) });
    return { ok: true };
  });
  app.post('/api/plugin/pair/poll', async req => {
    const b: any = req.body ?? {}, id = str(b.pairingId, 40);
    if (!/^[0-9a-f-]{36}$/.test(id)) fail(400, 'Invalid pairing.');
    const p = await db.one('select * from pairing_codes where id = $1', [id]);
    if (!p || p.poll_secret_hash !== sha256(String(b.pollSecret ?? ''))) fail(404, 'Unknown pairing.');
    if (p.claimed_at) fail(410, 'This pairing was already used.');
    if (new Date(p.expires_at) < new Date() && !p.confirmed_at) fail(410, 'This code expired. Start pairing again.');
    if (!p.confirmed_at) return { pending: true };
    const token = randomToken(32);
    return db.tx(async q => {
      const claimed = await q.query('update pairing_codes set claimed_at = now() where id = $1 and claimed_at is null returning user_id', [id]);
      if (!claimed.rows.length) fail(410, 'This pairing was already used.');
      const inst = await q.query("insert into studio_installations (user_id, token_hash, expires_at) values ($1, $2, now() + interval '90 days') returning id", [p.user_id, sha256(token)]);
      await q.query('update pairing_codes set installation_id = $2 where id = $1', [id, inst.rows[0].id]);
      return { token };
    });
  });
  app.get('/api/plugin/status', async req => {
    const p = await pluginUser(req), plan = await planOf(p.id);
    const consent = await db.one('select consents from user_preferences where user_id = $1', [p.id]);
    const exps = await db.asUser(p.id, q => q.query('select universe_id::text, name from roblox_experiences where user_id = $1 and active', [p.id]));
    return { account: p.display_name, plan, canSync: await canAccess(p.id, 'studio_automatic_scanning'), scriptInspectionAllowed: consent?.consents?.scriptInspection?.granted === true,
      experiences: exps.rows, syncIntervalMinutes: await getUsageLimit(p.id, 'sync_interval_minutes'), robloxConnected: !!(await db.one("select 1 from roblox_connections where user_id = $1 and status = 'active'", [p.id])) };
  });
  app.post('/api/plugin/scans', async req => {
    const p = await pluginUser(req);
    if (!(await canAccess(p.id, 'studio_automatic_scanning'))) fail(403, 'Automatic scanning needs a Light or Max plan.');
    let scan; try { scan = parseScan((req.body as any)?.scan); } catch (e: any) { fail(400, e.message); }
    // Owning a Place ID isn't proof of access: the experience must be one Roblox authorized for this account.
    const exp = await db.asUser(p.id, q => q.query('select active from roblox_experiences where user_id = $1 and universe_id = $2', [p.id, scan!.place.universeId]));
    if (!exp.rows.length) fail(403, 'This experience isn\'t authorized for your LaunchPad account. Connect Roblox and allow access to it first.');
    if (!exp.rows[0].active) fail(403, 'This experience is inactive on your plan. Turn it on in LaunchPad first.');
    const consent = await db.one('select consents from user_preferences where user_id = $1', [p.id]);
    if (scan!.codeRead && consent?.consents?.scriptInspection?.granted !== true) fail(403, 'Script inspection isn\'t allowed. Turn it on in LaunchPad → Settings → Privacy, or scan without it.');
    if (!(await useAllowance(p.id, 'monthly_scans'))) fail(429, 'You\'ve used this month\'s scan allowance.');
    const job = await db.asUser(p.id, q => q.query('insert into scan_jobs (user_id, universe_id, installation_id) values ($1, $2, $3) returning id', [p.id, scan!.place.universeId, p.iid]));
    const priority = await canAccess(p.id, 'priority_queue');
    await enqueue('process_scan', { jobId: job.rows[0].id, userId: p.id, scan }, { key: 'scan:' + job.rows[0].id, runAt: priority ? new Date(Date.now() - 60e3) : new Date() });
    await db.query("update roblox_experiences set name = coalesce($3, name) where user_id = $1 and universe_id = $2", [p.id, scan!.place.universeId, scan!.place.name]);
    return { jobId: job.rows[0].id };
  });
  app.get('/api/plugin/scans/:id', async req => {
    const p = await pluginUser(req), id = String((req.params as any).id);
    if (!/^[0-9a-f-]{36}$/.test(id)) fail(400, 'Invalid id.');
    const j = await db.asUser(p.id, q => q.query('select status, error, updated_at from scan_jobs where id = $1 and user_id = $2', [id, p.id]));
    if (!j.rows.length) fail(404, 'Scan not found.'); return j.rows[0];
  });
  app.post('/api/plugin/disconnect', async req => {
    const p = await pluginUser(req);
    await db.query('update studio_installations set revoked_at = now() where id = $1', [p.iid]);
    await securityEvent('studio_disconnected', { userId: p.id }); return { ok: true };
  });

  // Website side: installations and analyzed snapshots.
  app.get('/api/studio/installations', async req => {
    const u = requireUser(req);
    return (await db.query('select id, created_at, last_seen_at, expires_at from studio_installations where user_id = $1 and revoked_at is null and expires_at > now() order by created_at desc', [u.id])).rows;
  });
  app.delete('/api/studio/installations/:id', async req => {
    const u = requireUser(req), id = String((req.params as any).id);
    const r = await db.query('update studio_installations set revoked_at = now() where id::text = $1 and user_id = $2 and revoked_at is null returning id', [id, u.id]);
    if (!r.rows.length) fail(404, 'Not found.');
    await securityEvent('studio_disconnected', { userId: u.id, ip: ip(req) }); return { ok: true };
  });
  app.get('/api/studio/snapshots', async req => {
    const u = requireUser(req);
    return db.asUser(u.id, async q => (await q.query(`select distinct on (universe_id) id, universe_id::text, place_id::text, data, changes, code_read, created_at, analyzed_at
      from scan_snapshots where user_id = $1 order by universe_id, created_at desc`, [u.id])).rows);
  });
  app.post('/api/studio/snapshots/:id/analyzed', async req => {
    const u = requireUser(req), id = String((req.params as any).id);
    if (!/^[0-9a-f-]{36}$/.test(id)) fail(400, 'Invalid id.');
    await db.asUser(u.id, q => q.query('update scan_snapshots set analyzed_at = now() where id = $1 and user_id = $2', [id, u.id])); return { ok: true };
  });
}
