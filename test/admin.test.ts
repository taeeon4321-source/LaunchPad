import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, client, registerUser } from './helpers.ts';
import { db } from '../src/db.ts';
import { totp } from '../src/security.ts';

let app: any;
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); await db.close(); });

async function withMfa(u: any) {
  const { secret } = (await u.c.call('POST', '/api/auth/mfa/setup')).json;
  await u.c.call('POST', '/api/auth/mfa/enable', { code: totp(secret) }); return secret;
}

test('roles, MFA requirement, no self-promotion, audit trail', async () => {
  const owner = await registerUser(app, 'owner@example.com'), staff = await registerUser(app, 'staff@example.com'), user = await registerUser(app, 'plain@example.com');
  assert.equal((await user.c.call('GET', '/api/admin/overview')).status, 403, 'ordinary users are blocked');
  await db.query("insert into admin_roles (user_id, role) values ($1, 'owner')", [owner.id]);
  assert.equal((await owner.c.call('GET', '/api/admin/overview')).json.mfa, true, 'admins without MFA are blocked');
  await withMfa(owner);
  const ov = (await owner.c.call('GET', '/api/admin/overview')).json;
  assert.equal(ov.accounts, 3); assert.equal(ov.subscriptions.max_year, 0);

  assert.equal((await owner.c.call('POST', '/api/admin/roles', { userId: staff.id, role: 'support', reason: 'hire' })).status, 400, 'role targets need MFA');
  await withMfa(staff);
  assert.equal((await owner.c.call('POST', '/api/admin/roles', { userId: staff.id, role: 'support', reason: 'hire' })).status, 200);
  assert.equal((await staff.c.call('POST', '/api/admin/roles', { userId: staff.id, role: 'owner', reason: 'me' })).status, 403, 'support can\'t grant roles');
  assert.equal((await owner.c.call('POST', '/api/admin/roles', { userId: owner.id, role: 'security', reason: 'me' })).status, 403, 'no self-grants');
  assert.equal((await staff.c.call('GET', '/api/admin/security-events')).status, 403, 'support can\'t read security events');
  assert.equal((await staff.c.call('POST', `/api/admin/users/${user.id}/suspend`, { reason: 'x' })).status, 403, 'support can\'t suspend');
  const det = (await staff.c.call('GET', `/api/admin/users/${user.id}`)).json;
  assert.equal(det.security, null, 'support sees no security history');

  assert.equal((await owner.c.call('POST', `/api/admin/users/${user.id}/suspend`, {})).status, 400, 'a reason is required');
  assert.equal((await owner.c.call('POST', `/api/admin/users/${user.id}/suspend`, { reason: 'abuse report #1' })).json.ok, true);
  assert.equal((await user.c.call('GET', '/api/me')).json.user, null, 'suspension ends sessions');
  assert.equal((await client(app).call('POST', '/api/auth/login', { email: user.email, password: user.password })).status, 403);
  assert.ok(await db.one('select 1 from users where id = $1', [user.id]), 'suspension keeps data');
  await owner.c.call('POST', `/api/admin/users/${user.id}/reinstate`, { reason: 'resolved' });
  assert.equal((await client(app).call('POST', '/api/auth/login', { email: user.email, password: user.password })).status, 200);

  const log = (await owner.c.call('GET', '/api/admin/audit')).json.map((r: any) => r.action);
  for (const a of ['grant_role:support', 'view_user', 'suspend_user', 'reinstate_user']) assert.ok(log.includes(a), a);
  await assert.rejects(db.query('update admin_audit_log set outcome = $1', ['edited']), /append-only/);
  assert.equal((await owner.c.call('DELETE', '/api/admin/roles', { userId: owner.id, role: 'owner', reason: 'x' })).status, 403);
});
