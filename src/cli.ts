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
} else if (cmd === 'create-owner') {
  // Interactive: the operator types the email and password in this terminal; two-step verification is set up before the role is granted.
  const { createInterface } = await import('node:readline/promises');
  const { hashPassword, passwordProblem, newTotpSecret, verifyTotp, encrypt } = await import('./security.ts');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string, hidden = false) => { if (hidden) (rl as any)._writeToOutput = (s: string) => { if (s.includes(q)) process.stdout.write(s); }; const p = rl.question(q); return p.finally(() => { delete (rl as any)._writeToOutput; if (hidden) process.stdout.write('\n'); }); };
  const email = (await ask('Email for the owner account: ')).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || await db.one("select 1 from users where lower(email) = $1 and status <> 'deleted'", [email])) { console.error('Invalid email, or an account with it already exists.'); process.exit(1); }
  const pw = await ask('Password (hidden): ', true), problem = passwordProblem(pw, email);
  if (problem) { console.error(problem); process.exit(1); }
  if (pw !== await ask('Repeat password (hidden): ', true)) { console.error('Passwords don\'t match.'); process.exit(1); }
  const secret = newTotpSecret();
  console.log(`\nAdd this key to your authenticator app (Google Authenticator, Microsoft Authenticator, Authy):\n\n  ${secret}\n\nor open: otpauth://totp/LaunchPad:${encodeURIComponent(email)}?secret=${secret}&issuer=LaunchPad\n`);
  if (!verifyTotp(secret, (await ask('Enter the 6-digit code it shows: ')).trim())) { console.error('That code didn\'t match. Nothing was created; run the command again.'); process.exit(1); }
  const u = await db.one("insert into users (email, display_name, password_hash, email_verified_at, mfa_secret_enc, mfa_enabled_at) values ($1, 'Owner', $2, now(), $3, now()) returning id", [email, await hashPassword(pw), encrypt(secret)]);
  await db.query("insert into admin_roles (user_id, role) values ($1, 'owner')", [u.id]);
  await db.query("insert into admin_audit_log (admin_id, action, target, reason, outcome) values (null, 'create_owner', $1, 'CLI bootstrap', 'ok')", [u.id]);
  rl.close(); console.log('Owner account created. Sign in on the site; the Admin dashboard link is at the bottom of the sidebar.');
} else if (cmd === 'add-references') {
  // Adds real experiences to the reference catalog: universe IDs, or Roblox game URLs (place IDs are resolved).
  const { refreshReferences, universeForPlace } = await import('./references.ts');
  const ids = []; for (const x of process.argv.slice(3)) { const p = x.match(/roblox\.com\/games\/(\d+)/)?.[1]; ids.push(p ? await universeForPlace(p) : x); }
  console.log(JSON.stringify(await refreshReferences(ids)));
} else console.log('Commands: grant-owner <email> | create-owner | add-references <universeId|game URL>...');
await db.close();
