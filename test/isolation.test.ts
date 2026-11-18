import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, registerUser } from './helpers.ts';
import { db } from '../src/db.ts';

let app: any, A: any, B: any;
before(async () => { app = await makeApp(); A = await registerUser(app, 'alice@example.com'); B = await registerUser(app, 'bob@example.com'); });
after(async () => { await app.close(); await db.close(); });

test('two users never see or change each other\'s data, even with hand-made requests', async () => {
  await A.c.call('PUT', '/api/games/g1', { data: { id: 'g1', name: 'Alice game' } });
  await A.c.call('PUT', '/api/reports/r1', { data: { id: 'r1', gameId: 'g1', optimizer: 'game-page', score: 80, recs: [{ id: 'x', title: 'Fix it', priority: 'High' }], evidence: [{ what: 'Title', source: 'Retrieved from Roblox' }] } });
  await A.c.call('PUT', '/api/games/g1/overrides/loop', { value: 'secret loop' });

  const bState = (await B.c.call('GET', '/api/state')).json;
  assert.deepEqual([bState.games.length, bState.reports.length, bState.overrides.length], [0, 0, 0]);
  assert.equal((await B.c.call('DELETE', '/api/games/g1')).status, 404);
  assert.equal((await B.c.call('DELETE', '/api/reports/r1')).status, 404);
  assert.equal((await B.c.call('PUT', '/api/reports/r2', { data: { id: 'r2', gameId: 'g1', optimizer: 'game-page' } })).status, 404, 'B can\'t attach a report to A\'s game');
  assert.equal((await B.c.call('PUT', '/api/games/g1/overrides/loop', { value: 'x' })).status, 404);
  // Same id from B creates B's own record and leaves A's untouched.
  await B.c.call('PUT', '/api/games/g1', { data: { id: 'g1', name: 'Bob overwrite attempt' } });
  assert.equal((await A.c.call('GET', '/api/state')).json.games[0].name, 'Alice game');
  const aSessions = (await A.c.call('GET', '/api/auth/sessions')).json;
  assert.equal((await B.c.call('DELETE', `/api/auth/sessions/${aSessions[0].id}`)).status, 404);
  assert.equal((await B.c.call('POST', '/api/billing/portal')).status !== 200, true);
  assert.equal((await B.c.call('GET', '/api/me/export')).json.games[0].data.name, 'Bob overwrite attempt');
  assert.equal((await B.c.call('GET', '/api/admin/users')).status, 403);
  // Recommendations and evidence rows are owned too.
  assert.equal((await db.asUser(B.id, q => q.query('select * from recommendations'))).rows.length, 0);
  assert.equal((await db.asUser(A.id, q => q.query('select * from evidence_records'))).rows.length, 1);
});

test('injection-shaped input is treated as data', async () => {
  assert.equal((await A.c.call('PUT', "/api/games/x';drop table users;--", { data: { id: 'x' } })).status, 400);
  const name = "Robert'); DROP TABLE games;-- <script>alert(1)</script>";
  await A.c.call('PUT', '/api/games/g9', { data: { id: 'g9', name } });
  assert.equal((await A.c.call('GET', '/api/state')).json.games.find((g: any) => g.id === 'g9').name, name);
  assert.ok((await db.query('select count(*) from games')).rows.length);
});

test('uploaded images are checked by content, not by claimed type', async () => {
  const fakePng = 'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64');
  assert.equal((await A.c.call('PUT', '/api/games/g2', { data: { id: 'g2', icon: { preview: fakePng } } })).status, 400);
  const realPng = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
  assert.equal((await A.c.call('PUT', '/api/games/g2', { data: { id: 'g2', icon: { preview: realPng } } })).status, 200);
  assert.equal((await A.c.call('PUT', '/api/me/avatar', { dataUrl: 'data:image/jpeg;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') })).status, 400, 'PNG bytes labelled as JPEG are rejected');
});
