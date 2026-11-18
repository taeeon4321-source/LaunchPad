import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, db } from '../src/db.ts';

test('migrations apply and row-level security isolates users', async () => {
  await connect({ memory: true });
  const a = (await db.one('insert into users (email, display_name) values ($1, $2) returning id', ['a@example.com', 'A'])).id;
  const b = (await db.one('insert into users (email, display_name) values ($1, $2) returning id', ['b@example.com', 'B'])).id;
  await db.asUser(a, q => q.query('insert into games (user_id, id, data) values ($1, $2, $3)', [a, 'g1', {}]));
  assert.equal((await db.asUser(a, q => q.query('select * from games'))).rows.length, 1);
  assert.equal((await db.asUser(b, q => q.query('select * from games'))).rows.length, 0, 'B must not see A\'s games');
  await assert.rejects(db.asUser(b, q => q.query('insert into games (user_id, id, data) values ($1, $2, $3)', [a, 'g2', {}])), 'B must not write rows owned by A');
  assert.equal((await db.asUser(b, q => q.query('update games set data = $1 returning id', [{ x: 1 }]))).rows.length, 0);
  await db.query("insert into admin_audit_log (action, outcome) values ('test', 'ok')");
  await assert.rejects(db.query('delete from admin_audit_log'), /append-only/);
  await db.close();
});
