import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, client, registerUser } from './helpers.ts';
import { db } from '../src/db.ts';
import { config } from '../src/config.ts';
import { runOnce } from '../src/jobs.ts';

let app: any, U: any;
const P = { light_month: 'pri_lm', light_year: 'pri_ly', max_month: 'pri_mm', max_year: 'pri_my' };
before(async () => { Object.assign(config.paddle, { prices: { ...P } }); app = await makeApp(); U = await registerUser(app, 'dev@example.com'); });
after(async () => { await app.close(); await db.close(); });

const plugin = (token = '') => { const c = client(app); return (m: string, u: string, b?: unknown) => c.call(m, u, b, { origin: '', ...(token ? { authorization: `Bearer ${token}` } : {}) }); };
const scan = (universeId: number, extra = {}) => ({ launchpadScan: 1, codeRead: false, place: { placeId: 1, universeId, name: 'My Game', description: 'Hatch pets' }, counts: { instances: 10 }, features: { saves: ['ServerScriptService.Save'] }, economy: [], prompts: [], ...extra });
async function giveLight() {
  await db.query("insert into subscriptions (environment, provider_subscription_id, user_id, price_id, plan, billing_interval, status) values ('sandbox', 'sub_r', $1, 'pri_lm', 'light', 'month', 'active')", [U.id]);
  await db.query('delete from entitlements');
}

test('pairing needs a paid plan, codes are single-use, expire, and the token is collected once', async () => {
  const p = plugin();
  const s = (await p('POST', '/api/plugin/pair/start')).json; assert.match(s.code, /^[A-Z2-9]{8}$/);
  assert.equal((await U.c.call('POST', '/api/plugin/pair/confirm', { code: s.code })).status, 403, 'free plan can\'t pair');
  await giveLight();
  assert.equal((await p('POST', '/api/plugin/pair/poll', { pairingId: s.pairingId, pollSecret: s.pollSecret })).json.pending, true);
  assert.equal((await p('POST', '/api/plugin/pair/poll', { pairingId: s.pairingId, pollSecret: 'wrong' })).status, 404);
  assert.equal((await U.c.call('POST', '/api/plugin/pair/confirm', { code: s.code })).status, 200);
  assert.equal((await U.c.call('POST', '/api/plugin/pair/confirm', { code: s.code })).status, 400, 'codes are single-use');
  const tok = (await p('POST', '/api/plugin/pair/poll', { pairingId: s.pairingId, pollSecret: s.pollSecret })).json.token; assert.ok(tok);
  assert.equal((await p('POST', '/api/plugin/pair/poll', { pairingId: s.pairingId, pollSecret: s.pollSecret })).status, 410, 'token handed out once');
  const s2 = (await p('POST', '/api/plugin/pair/start')).json;
  await db.query("update pairing_codes set expires_at = now() - interval '1 second' where id = $1", [s2.pairingId]);
  assert.equal((await U.c.call('POST', '/api/plugin/pair/confirm', { code: s2.code })).status, 400, 'expired codes fail');
  assert.ok(!(await db.query('select code_hash from pairing_codes')).rows.some(r => r.code_hash === s.code), 'codes are stored hashed');

  await db.query('insert into roblox_experiences (user_id, universe_id, active) values ($1, 777, false)', [U.id]);
  assert.equal((await U.c.call('GET', '/api/roblox/experiences')).json.experiences.length, 1, 'experience list loads (no nested-connection deadlock)');
  assert.equal((await U.c.call('PATCH', '/api/roblox/experiences/777', { active: true })).status, 200);
  await db.query('delete from roblox_experiences where universe_id = 777');
  const pt = plugin(tok);
  assert.equal((await pt('GET', '/api/plugin/status')).json.plan, 'light');
  assert.equal((await pt('POST', '/api/plugin/scans', { scan: scan(555) })).status, 403, 'unauthorized experiences are refused');
  await db.query('insert into roblox_experiences (user_id, universe_id) values ($1, 555)', [U.id]);
  assert.equal((await pt('POST', '/api/plugin/scans', { scan: scan(555, { codeRead: true }) })).status, 403, 'script reading needs consent');
  const j = (await pt('POST', '/api/plugin/scans', { scan: scan(555) })).json; assert.ok(j.jobId);
  while (await runOnce()) { /* process */ }
  assert.equal((await pt('GET', `/api/plugin/scans/${j.jobId}`)).json.status, 'done');
  let snaps = (await U.c.call('GET', '/api/studio/snapshots')).json; assert.equal(snaps.length, 1); assert.equal(snaps[0].changes.length, 5);
  await U.c.call('POST', `/api/studio/snapshots/${snaps[0].id}/analyzed`);
  await pt('POST', '/api/plugin/scans', { scan: scan(555) }); while (await runOnce()) { /* */ }
  snaps = (await U.c.call('GET', '/api/studio/snapshots')).json;
  assert.deepEqual(snaps[0].changes, [], 'unchanged game: nothing to re-analyze'); assert.ok(snaps[0].analyzed_at);
  await pt('POST', '/api/plugin/scans', { scan: scan(555, { economy: [{ name: 'Egg', cost: 10, income: 1 }] }) }); while (await runOnce()) { /* */ }
  assert.deepEqual((await U.c.call('GET', '/api/studio/snapshots')).json[0].changes, ['economy']);

  const other = await registerUser(app, 'other@example.com');
  assert.equal((await other.c.call('GET', '/api/studio/snapshots')).json.length, 0);
  await pt('POST', '/api/plugin/disconnect');
  assert.equal((await pt('GET', '/api/plugin/status')).status, 401, 'revoked tokens stop working');
});

test('Roblox OAuth: not configured, and state validation', async () => {
  const r = await U.c.call('GET', '/api/roblox/connect'); assert.match(r.headers.location, /roblox=not_configured/);
  Object.assign(config.roblox, { clientId: 'cid', clientSecret: 'sec' });
  const go = await U.c.call('GET', '/api/roblox/connect'); const loc = new URL(go.headers.location);
  assert.equal(loc.origin + loc.pathname, 'https://apis.roblox.com/oauth/v1/authorize');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256'); assert.ok(loc.searchParams.get('nonce')); assert.ok(loc.searchParams.get('state'));
  const bad = await U.c.call('GET', '/api/roblox/callback?code=x&state=forged'); assert.match(bad.headers.location, /invalid_state/);
  await U.c.call('GET', '/api/roblox/connect');
  const st = new URL((await U.c.call('GET', '/api/roblox/connect')).headers.location).searchParams.get('state');
  const denied = await U.c.call('GET', `/api/roblox/callback?error=access_denied&state=${st}`); assert.match(denied.headers.location, /roblox=denied/);
  const other = await registerUser(app, 'thief@example.com');
  const s3 = new URL((await U.c.call('GET', '/api/roblox/connect')).headers.location).searchParams.get('state');
  other.c.cookie = other.c.cookie + '; ' + U.c.cookie.split('; ').find((x: string) => x.startsWith('lp_rbx='));
  assert.match((await other.c.call('GET', `/api/roblox/callback?code=x&state=${s3}`)).headers.location, /invalid_state/, 'state is bound to the user who started it');
  Object.assign(config.roblox, { clientId: '', clientSecret: '' });
});
