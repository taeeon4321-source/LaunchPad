import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { makeApp, client, registerUser } from './helpers.ts';
import { db } from '../src/db.ts';
import { config } from '../src/config.ts';
import { setGoogleJwksForTests } from '../src/google.ts';

let app: any, key: any, otherKey: any;
const AUD = 'test-client.apps.googleusercontent.com';
before(async () => {
  config.google.clientId = AUD;
  key = await generateKeyPair('RS256'); otherKey = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(key.publicKey)), kid: 'k1', alg: 'RS256' };
  setGoogleJwksForTests(createLocalJWKSet({ keys: [jwk] }));
  app = await makeApp();
});
after(async () => { await app.close(); await db.close(); });

const token = (claims: object, o: { k?: any; aud?: string; iss?: string; exp?: string } = {}) => new SignJWT({ email_verified: true, ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
  .setIssuer(o.iss ?? 'https://accounts.google.com').setAudience(o.aud ?? AUD).setIssuedAt().setExpirationTime(o.exp ?? '10m').sign((o.k ?? key).privateKey);
async function signIn(c: any, claims: object, o = {}, extra = {}) { const { nonce } = (await c.call('GET', '/api/auth/google/nonce')).json; return c.call('POST', '/api/auth/google', { credential: await token({ nonce, ...claims }, o), ...extra }); }

test('valid Google sign-in creates an account after consent, keyed by sub', async () => {
  const c = client(app);
  assert.equal((await signIn(c, { sub: 'g-1', email: 'gina@example.com', name: 'Gina' })).json.needsConsent, true);
  const r = await signIn(c, { sub: 'g-1', email: 'gina@example.com', name: 'Gina' }, {}, { acceptTerms: true, ageConfirmed: true });
  assert.equal(r.json.created, true);
  const me = (await c.call('GET', '/api/me')).json; assert.equal(me.user.emailVerified, true); assert.equal(me.identities[0].provider, 'google');
  const again = client(app); assert.equal((await signIn(again, { sub: 'g-1', email: 'changed@example.com' })).json.ok, true, 'same sub signs into the same account even if the email changed');
});

test('invalid Google tokens are rejected', async () => {
  const c = client(app);
  assert.equal((await signIn(c, { sub: 'g-2', email: 'x@example.com' }, { k: otherKey })).status, 401, 'bad signature');
  assert.equal((await signIn(c, { sub: 'g-2', email: 'x@example.com' }, { aud: 'someone-else' })).status, 401, 'wrong audience');
  assert.equal((await signIn(c, { sub: 'g-2', email: 'x@example.com' }, { iss: 'https://evil.example' })).status, 401, 'wrong issuer');
  assert.equal((await signIn(c, { sub: 'g-2', email: 'x@example.com' }, { exp: '-5m' })).status, 401, 'expired');
  await c.call('GET', '/api/auth/google/nonce');
  const wrongNonce = await c.call('POST', '/api/auth/google', { credential: await token({ sub: 'g-2', email: 'x@example.com', nonce: 'not-the-cookie-nonce' }) });
  assert.equal(wrongNonce.status, 401, 'nonce mismatch');
  assert.equal((await c.call('POST', '/api/auth/google', { credential: 'garbage' })).status, 401);
});

test('matching email never merges accounts; linking needs a signed-in, recently authenticated user', async () => {
  const { c, id, password } = await registerUser(app, 'pat@example.com');
  const stranger = client(app);
  const r = await signIn(stranger, { sub: 'g-3', email: 'pat@example.com' }, {}, { acceptTerms: true, ageConfirmed: true });
  assert.equal(r.status, 409); assert.equal((await db.query("select 1 from auth_identities where provider_subject = 'g-3'")).rows.length, 0);
  await db.query("update sessions set authenticated_at = now() - interval '1 hour' where user_id = $1", [id]);
  assert.equal((await signIn(c, { sub: 'g-3', email: 'pat@example.com' }, {}, { mode: 'link' })).status, 403);
  await c.call('POST', '/api/auth/reauth', { password });
  assert.equal((await signIn(c, { sub: 'g-3', email: 'pat@example.com' }, {}, { mode: 'link' })).json.ok, true);
  assert.equal((await db.query('select 1 from security_events where kind = $1 and user_id = $2', ['identity_linked', id])).rows.length, 1);
  assert.equal((await signIn(client(app), { sub: 'g-3', email: 'pat@example.com' })).json.ok, true, 'linked Google account now signs in');
});
