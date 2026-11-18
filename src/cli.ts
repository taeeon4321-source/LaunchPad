// Operator commands. Roles can't be granted from the website by anyone to themselves; the first owner is bootstrapped here.
// Usage: npm run cli -- grant-owner someone@example.com
import { connect, db } from './db.ts';

const [cmd, arg] = process.argv.slice(2);
await connect();
if (cmd === 'grant-owner') {
  const u = await db.one("select id, mfa_enabled_at from users where lower(email) = lower($1) and status = 'active'", [arg ?? '']);
  if (!u) { console.error('No active user with that email.'); process.exit(1); }
  if (!u.mfa_enabled_at) { console.error('That user must turn on two-step verification (Settings → Security) first.'); process.exit(1); }
  await db.query("insert into admin_roles (user_id, role) values ($1, 'owner') on conflict do nothing", [u.id]);
  await db.query("insert into admin_audit_log (admin_id, action, target, reason, outcome) values (null, 'grant_role:owner', $1, 'CLI bootstrap', 'ok')", [u.id]);
  console.log('Owner role granted.');
} else console.log('Commands: grant-owner <email>');
await db.close();
