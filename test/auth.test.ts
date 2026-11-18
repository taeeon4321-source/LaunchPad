import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, client, registerUser, lastLink } from './helpers.ts';
import { db } from '../src/db.ts';
import { runOnce, registerJob } from '../src/jobs.ts';
import { totp } from '../src/security.ts';

let app: any;
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); await db.close(); });

test('registration, duplicate email, login, wrong password', async () => {
  const { c, email, password } = await registerUser(app, 'reg@example.com');
  assert.equal((await c.call('GET', '/api/me')).json.user.email, email);
  const dup = await client(app).call('POST', '/api/auth/register', { email: 'REG@example.com', password, displayName: 'x', acceptTerms: true, ageConfirmed: true });
  assert.equal(dup.status, 409);
  const bad = await client(app).call('POST', '/api/auth/login', { email, password: 'wrong password!' });
  assert.equal(bad.status, 401); assert.equal(bad.json.error, 'Email or password is incorrect.');
  const unknown = await client(app).call('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'whatever12345' });
  assert.equal(unknown.json.error, bad.json.error, 'unknown and wrong-password errors are identical');
  const ok = client(app); assert.equal((await ok.call('POST', '/api/auth/login', { email, password })).status, 200);
  const r = await client(app).call('POST', '/api/auth/register', { email: 'weak@example.com', password: 'short', displayName: 'w', acceptTerms: true, ageConfirmed: true });
  assert.equal(r.status, 400);
  const h = await db.one('select password_hash from users where email = $1', [email]);
  assert.match(h.password_hash, /^\$argon2id\$/); assert.ok(!h.password_hash.includes(password));
  const ev = await db.query('select detail::text d from security_events');
  assert.ok(ev.rows.every(e => !e.d.includes(password)), 'passwords never reach the security log');
});

test('email verification links are single-use', async () => {
  const { c, email } = await registerUser(app, 'verify@example.com');
  const t = await lastLink(email, 'verify');
  assert.equal((await c.call('POST', '/api/auth/verify-email', { token: t })).status, 200);
  assert.equal((await c.call('POST', '/api/auth/verify-email', { token: t })).status, 400);
  assert.equal((await c.call('GET', '/api/me')).json.user.emailVerified, true);
});

test('password reset: generic response, single use, expiry, signs out everywhere', async () => {
  const { c, email } = await registerUser(app, 'reset@example.com');
  const anon = client(app);
  const a = await anon.call('POST', '/api/auth/forgot', { email }), b = await anon.call('POST', '/api/auth/forgot', { email: 'missing@example.com' });
  assert.deepEqual(a.json, b.json, 'same response whether or not the account exists');
  const t = await lastLink(email, 'reset');
  assert.equal((await anon.call('POST', '/api/auth/reset', { token: t, password: 'a brand new password' })).status, 200);
  assert.equal((await anon.call('POST', '/api/auth/reset', { token: t, password: 'another new password' })).status, 400, 'reset tokens are single-use');
  assert.equal((await c.call('GET', '/api/me')).json.user, null, 'old sessions are revoked after a reset');
  await anon.call('POST', '/api/auth/forgot', { email });
  const t2 = await lastLink(email, 'reset');
  await db.query("update auth_tokens set expires_at = now() - interval '1 minute' where kind = 'reset_password' and used_at is null");
  assert.equal((await anon.call('POST', '/api/auth/reset', { token: t2, password: 'expired link password' })).status, 400, 'expired links fail');
});

test('sessions: list, revoke one, log out everywhere', async () => {
  const { c, email, password } = await registerUser(app, 'sess@example.com');
  const other = client(app); await other.call('POST', '/api/auth/login', { email, password });
  const list = (await c.call('GET', '/api/auth/sessions')).json; assert.equal(list.length, 2);
  const otherId = list.find((s: any) => !s.current).id;
  assert.equal((await c.call('DELETE', `/api/auth/sessions/${otherId}`)).status, 200);
  assert.equal((await other.call('GET', '/api/me')).json.user, null);
  await other.call('POST', '/api/auth/login', { email, password });
  await c.call('POST', '/api/auth/logout-all');
  assert.equal((await other.call('GET', '/api/me')).json.user, null);
  assert.equal((await c.call('GET', '/api/me')).json.user, null);
});

test('cookie flags and CSRF origin check', async () => {
  const c = client(app);
  const r = await c.call('POST', '/api/auth/register', { email: 'flags@example.com', password: 'correct horse battery', displayName: 'f', acceptTerms: true, ageConfirmed: true });
  const set = String([].concat(r.headers['set-cookie'])[0]);
  assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Lax/);
  const cross = await c.call('PATCH', '/api/me', { displayName: 'evil' }, { origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
  const form = await app.inject({ method: 'PATCH', url: '/api/me', payload: 'displayName=evil', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost:8787', cookie: c.cookie } });
  assert.equal(form.statusCode, 415);
});

test('login throttling', async () => {
  const c = client(app); let last = 0;
  for (let i = 0; i < 12; i++) last = (await c.call('POST', '/api/auth/login', { email: 'throttle@example.com', password: 'nope nope nope' })).status;
  assert.equal(last, 429);
});

test('MFA: setup needs re-auth, then login needs a code', async () => {
  const { c, email, password } = await registerUser(app, 'mfa@example.com');
  await db.query("update sessions set authenticated_at = now() - interval '1 hour'");
  assert.equal((await c.call('POST', '/api/auth/mfa/setup')).status, 403, 'stale sessions must re-authenticate');
  assert.equal((await c.call('POST', '/api/auth/reauth', { password })).status, 200);
  const { secret } = (await c.call('POST', '/api/auth/mfa/setup')).json;
  assert.equal((await c.call('POST', '/api/auth/mfa/enable', { code: '000000' })).status, 400);
  assert.equal((await c.call('POST', '/api/auth/mfa/enable', { code: totp(secret) })).status, 200);
  const n = client(app);
  assert.equal((await n.call('POST', '/api/auth/login', { email, password })).json.mfaRequired, true);
  assert.equal((await n.call('GET', '/api/me')).json.user, null);
  assert.equal((await n.call('POST', '/api/auth/login', { email, password, code: totp(secret) })).status, 200);
});

test('data export and account deletion', async () => {
  const { c, id, password } = await registerUser(app, 'delete@example.com');
  await c.call('PUT', '/api/games/g1', { data: { id: 'g1', name: 'Mine' } });
  const ex = await c.call('GET', '/api/me/export');
  assert.equal(ex.json.games[0].data.name, 'Mine'); assert.ok(!JSON.stringify(ex.json).includes('password_hash'));
  await db.query("update sessions set authenticated_at = now() - interval '1 hour' where user_id = $1", [id]);
  assert.equal((await c.call('POST', '/api/me/delete', { confirm: 'DELETE' })).status, 403);
  await c.call('POST', '/api/auth/reauth', { password });
  assert.equal((await c.call('POST', '/api/me/delete', { confirm: 'nope' })).status, 400);
  assert.equal((await c.call('POST', '/api/me/delete', { confirm: 'DELETE' })).status, 200);
  assert.equal((await client(app).call('POST', '/api/auth/login', { email: 'delete@example.com', password })).status, 401, 'deleted accounts can\'t log in');
  while (await runOnce()) { /* drain jobs */ }
  assert.equal(await db.one('select 1 from users where id = $1', [id]), undefined);
  assert.equal((await db.query('select 1 from games where user_id = $1', [id])).rows.length, 0);
});
