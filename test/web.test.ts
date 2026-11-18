import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeApp, client } from './helpers.ts';
import { db } from '../src/db.ts';

let app: any;
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); await db.close(); });

test('security headers and CSP nonces on pages', async () => {
  const r = await app.inject({ url: '/' });
  const csp = r.headers['content-security-policy'], nonce = csp.match(/'nonce-([^']+)'/)[1];
  assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /object-src 'none'/); assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp));
  assert.equal(r.headers['x-content-type-options'], 'nosniff'); assert.equal(r.headers['x-frame-options'], 'DENY'); assert.ok(r.headers['referrer-policy']); assert.ok(r.headers['permissions-policy']);
  const scripts = r.body.match(/<script\b[^>]*>/g); assert.ok(scripts.length);
  assert.ok(scripts.every((s: string) => s.includes(`nonce="${nonce}"`) || /src="https:\/\/(accounts\.google\.com|cdn\.paddle\.com)/.test(s)), 'every inline script carries the nonce');
  assert.ok(!/\son(click|load|error|submit)=/i.test(r.body.replace(/<script[\s\S]*?<\/script>/g, '')), 'no inline event handlers in markup');
});

test('static files: no path traversal, no secrets shipped to the browser', async () => {
  for (const u of ['/..%2fpackage.json', '/%2e%2e/src/config.ts', '/../.env', '/index.html']) assert.equal((await app.inject({ url: u })).statusCode, 404, u);
  const walk = (d: string): string[] => readdirSync(d).flatMap(f => statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]);
  for (const f of [...walk('public'), 'plugin/LaunchPadStudio.lua'].filter(f => /\.(html|js|lua|css)$/.test(f))) {
    const s = readFileSync(f, 'utf8');
    assert.ok(!/(PADDLE_API_KEY|CLIENT_SECRET|WEBHOOK_SECRET|ENCRYPTION_KEY|pdl_(live|sdbx)_apikey|-----BEGIN)/.test(s), `no secrets in ${f}`);
  }
});

test('legal pages show version and review status; request forms work and validate', async () => {
  const idx = await app.inject({ url: '/legal' }); assert.equal(idx.statusCode, 200);
  const t = await app.inject({ url: '/legal/terms' }); assert.match(t.body, /Version /); assert.match(t.body, /awaiting legal review|Draft/);
  const c = client(app);
  assert.equal((await c.call('POST', '/api/requests', { kind: 'copyright', email: 'r@example.com', subject: 's', message: 'm' })).status, 400, 'copyright needs the extra fields');
  const ok = await c.call('POST', '/api/requests', { kind: 'copyright', name: 'R', email: 'r@example.com', subject: 'My art', message: 'details', content: 'game 123', rights: 'I made it', goodFaith: '1' });
  assert.equal(ok.status, 200);
  assert.equal((await c.call('POST', '/api/requests', { kind: 'privacy_deletion', email: 'p@example.com', subject: 'Delete', message: 'please' })).status, 200);
});

test('plans endpoint exposes only public data', async () => {
  const r = (await client(app).call('GET', '/api/plans')).json;
  assert.deepEqual(r.plans.map((p: any) => [p.plan, p.prices.month, p.prices.year]), [['light', 999, 9999], ['max', 4999, 19999]]);
  assert.equal(r.plans[1].display.saving, '$399.89');
  assert.ok(!JSON.stringify(r).match(/apiKey|webhookSecret/));
});

test('analytics: allow-listed, anonymous, admin-only reports', async () => {
  const c = client(app);
  assert.equal((await app.inject({ method: 'POST', url: '/api/events', remoteAddress: '10.9.9.9', headers: { 'content-type': 'application/json', origin: 'http://localhost:8787' }, payload: JSON.stringify({ name: 'pricing_view', session: 's1', props: { ctx: 'landing' } }) })).statusCode, 204);
  assert.equal((await c.call('POST', '/api/events', { name: 'drop_table' })).status, 400);
  const row = await db.one("select * from analytics_events where name = 'pricing_view'");
  assert.deepEqual(Object.keys(row).sort(), ['at', 'id', 'name', 'props', 'session', 'variants'], 'no user id or IP column');
  assert.equal((await c.call('GET', '/api/admin/analytics')).status, 401);
});
