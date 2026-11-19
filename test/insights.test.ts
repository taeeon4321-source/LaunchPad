import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, registerUser } from './helpers.ts';
import { db } from '../src/db.ts';
import { forecast } from '../src/forecast.ts';
import { io, queryMetric, queryRange, normalize } from '../src/metrics.ts';
import { syncGame } from '../src/sync.ts';

let app: any;
const DAY = 86400e3, T0 = Date.UTC(2026, 0, 1);
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); await db.close(); });
const realFetch = io.fetch, realSleep = io.sleep;
function stubRoblox(handler: (url: string, init: any) => { status: number; body: any }) {
  io.sleep = async () => {};
  io.fetch = (async (url: any, init: any) => { const r = handler(String(url), init); return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } }); }) as any;
}
const restore = () => { io.fetch = realFetch; io.sleep = realSleep; };
const ok = (values: any[]) => ({ status: 200, body: { path: 'v1/universes/1/operations/x', done: true, response: { values } } });

test('forecast: refuses short or patchy history, gives an interval otherwise', () => {
  assert.equal(forecast(Array.from({ length: 20 }, (_, i) => ({ t: T0 + i * DAY, v: 10 })), { horizon: 7 }).ok, false, 'needs 28 days');
  const patchy = Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * DAY, v: 10 })).filter((_, i) => i % 3);
  assert.equal(forecast(patchy, { horizon: 7 }).ok, false, 'too many gaps');
  // Linear growth with deterministic noise: the central estimate should continue the trend (damped) inside the band.
  const pts = Array.from({ length: 70 }, (_, i) => ({ t: T0 + i * DAY, v: 100 + i * 2 + ((i * 7919) % 11) - 5 }));
  const f = forecast(pts, { horizon: 30, summable: true, now: T0 + 80 * DAY });
  assert.ok(f.ok); if (!f.ok) return;
  assert.equal(f.points.length, 30); assert.ok(f.points.every(p => p.lo <= p.mid && p.mid <= p.hi));
  assert.ok(f.points[0].mid > 230 && f.points[0].mid < 250, `next day ≈ 240, got ${f.points[0].mid}`);
  assert.ok(f.points[29].hi - f.points[29].lo > f.points[0].hi - f.points[0].lo, 'band widens with the horizon');
  assert.ok(f.total && f.total.lo < f.total.mid && f.total.mid < f.total.hi);
  assert.ok(f.quality.backtestMape != null && f.quality.backtestMape < 10);
});

test('forecast: weekly seasonality, level shifts, rate bounds', () => {
  const weekly = Array.from({ length: 84 }, (_, i) => ({ t: T0 + i * DAY, v: 50 + (new Date(T0 + i * DAY).getUTCDay() === 6 ? 30 : 0) + (i % 3) }));
  const f = forecast(weekly, { horizon: 14 }); assert.ok(f.ok && f.seasonal, 'detects the weekend effect');
  const shift = Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * DAY, v: i < 50 ? 10 + (i % 2) * 0.1 : 40 + (i % 2) * 0.1 }));
  const s = forecast(shift, { horizon: 7 }); assert.equal(s.ok, false); assert.match((s as any).reason, /changed sharply/);
  const rate = Array.from({ length: 40 }, (_, i) => ({ t: T0 + i * DAY, v: 0.3 + i * 0.015 + (i % 2) * 0.004 }));
  const r = forecast(rate, { horizon: 90, ratio: true }); assert.ok(r.ok && r.points.every(p => p.hi <= 1 && p.lo >= 0) && r.points.some(p => p.hi === 1), 'rates are capped at 100%');
});

test('Roblox adapter: polls long-running queries, retries transient errors, maps 401, scales percents, splits budgets', async () => {
  let calls = 0;
  stubRoblox((url, init) => {
    calls++;
    if (init?.method === 'POST' && calls === 1) return { status: 503, body: { code: 2002 } };
    if (init?.method === 'POST') return { status: 202, body: { path: 'v1/universes/42/operations/abc', done: false } };
    return calls < 4 ? { status: 200, body: { path: 'v1/universes/42/operations/abc', done: false } } : ok([{ breakdowns: [{ dimension: 'Platform', value: 'Phone' }], dataPoints: [{ time: '2026-01-01T00:00:00Z', value: 23.5, status: 'Valid' }] }]);
  });
  const pts = await queryMetric('k'.repeat(30), '42', { metric: 'ForwardD1Retention', granularity: 'OneDay', startTime: 'x', endTime: 'y' });
  assert.deepEqual(pts, [{ breakdown: 'Platform=Phone', t: '2026-01-01T00:00:00.000Z', value: 0.235, status: 'Valid' }], 'percent → ratio');
  assert.deepEqual(normalize('ForwardD1Retention', { values: [{ dataPoints: [{ time: '2026-01-01T00:00:00Z', value: 0.2 }] }] })[0].value, 0.2, 'ratio stays a ratio');
  assert.deepEqual(normalize('DailyActiveUsers', { values: [{ dataPoints: [{ time: '2026-01-01T00:00:00Z', value: 1200 }] }] })[0].value, 1200, 'counts untouched');

  stubRoblox(() => ({ status: 401, body: {} }));
  await assert.rejects(queryMetric('k'.repeat(30), '42', { metric: 'DailyActiveUsers' }), (e: any) => e.kind === 'unauthorized');
  stubRoblox(() => ({ status: 200, body: { path: '../../evil', done: false } }));
  await assert.rejects(queryMetric('k'.repeat(30), '42', { metric: 'DailyActiveUsers' }), (e: any) => e.kind === 'transient', 'never polls a path that isn\'t a Roblox operation');

  const ranges: string[] = [];
  stubRoblox((url, init) => { const b = JSON.parse(init.body); ranges.push(b.startTime.slice(0, 10) + '→' + b.endTime.slice(0, 10));
    return Date.parse(b.endTime) - Date.parse(b.startTime) > 40 * DAY ? { status: 429, body: { code: 3000 } } : ok([{ dataPoints: [{ time: b.startTime, value: 1 }] }]); });
  const split = await queryRange('k'.repeat(30), '42', { metric: 'DailyActiveUsers', granularity: 'OneDay' }, new Date(T0), new Date(T0 + 120 * DAY));
  assert.ok(split.length >= 3 && ranges.length > 3, 'budget errors split the range');
  restore();
});

async function withGame(c: any, id = 'g1') { const r = await c.call('PUT', `/api/games/${id}`, { data: { id, name: 'Test game', genre: 'simulator' } }); assert.equal(r.status, 200); }
async function setPlan(userId: string, plan: 'light' | 'max') {
  await db.query("insert into subscriptions (environment, provider_subscription_id, user_id, price_id, plan, billing_interval, status) values ('sandbox', $2, $1, 'pri_x', $3, 'month', 'active')", [userId, 'sub_' + userId.slice(0, 8), plan]);
  await db.query('delete from entitlements where user_id = $1', [userId]);
}

test('uploads: validation, duplicates, provenance, isolation', async () => {
  const A = await registerUser(app, 'up-a@example.com'), B = await registerUser(app, 'up-b@example.com');
  await withGame(A.c); await withGame(B.c);
  const rows = [['DailyActiveUsers', '2026-01-01', 120], ['DailyActiveUsers', '2026-01-02', 130], ['ForwardD1Retention', '2026-01-01', 0.31, 'Platform=Phone', 400]];
  const bad = await A.c.call('POST', '/api/metrics/upload', { gameId: 'g1', kind: 'retention', filename: 'x.csv', rows: [...rows, ['DailyActiveUsers', '2026-01-01', 5], ['Nope', '2026-01-01', 1], ['ForwardD1Retention', '2026-01-03', 1.5]], mode: 'check' });
  assert.equal(bad.status, 200); assert.equal(bad.json.valid, 3); assert.equal(bad.json.errors.length, 3); assert.equal(bad.json.written, 0);
  const w = await A.c.call('POST', '/api/metrics/upload', { gameId: 'g1', kind: 'retention', filename: 'x.csv', timezone: 'Europe/London', rows, mode: 'skip' });
  assert.equal(w.json.written, 3);
  const again = await A.c.call('POST', '/api/metrics/upload', { gameId: 'g1', kind: 'retention', filename: 'x.csv', rows, mode: 'check' });
  assert.equal(again.json.duplicates, 3, 'detects rows already imported');
  const q = await A.c.call('GET', '/api/metrics/query?game=g1&metrics=DailyActiveUsers,ForwardD1Retention&from=2025-12-01&to=2026-02-01&breakdown=Platform');
  assert.equal(q.status, 200); assert.equal(q.json.series.length, 2);
  assert.ok(q.json.series.every((s: any) => s.source === 'upload'));
  assert.deepEqual(q.json.series.find((s: any) => s.metric === 'ForwardD1Retention').points[0].slice(0, 2), [Date.UTC(2026, 0, 1), 0.31]);
  // B has a game with the same id but can't see A's data; B can't query a game it doesn't have.
  const qb = await B.c.call('GET', '/api/metrics/query?game=g1&metrics=DailyActiveUsers&from=2025-12-01&to=2026-02-01');
  assert.equal(qb.json.series.length, 0);
  assert.equal((await B.c.call('GET', '/api/metrics/query?game=nope&metrics=DailyActiveUsers')).status, 404);
  const ds = (await A.c.call('GET', '/api/metrics/sources')).json.datasets; assert.equal(ds.length, 1); assert.equal(ds[0].timezone, 'Europe/London');
  assert.equal((await B.c.call('DELETE', `/api/metrics/datasets/${ds[0].id}`)).status, 404, 'can\'t delete another user\'s upload');
  assert.equal((await A.c.call('DELETE', `/api/metrics/datasets/${ds[0].id}`)).status, 200);
  assert.equal((await A.c.call('GET', '/api/metrics/query?game=g1&metrics=DailyActiveUsers&from=2025-12-01&to=2026-02-01')).json.series.length, 0, 'deleting a dataset removes its points');
});

test('plan gating is enforced on the server', async () => {
  const F = await registerUser(app, 'gate-free@example.com'); await withGame(F.c);
  assert.equal((await F.c.call('POST', '/api/metrics/forecast', { game: 'g1', metric: 'DailyActiveUsers' })).status, 403);
  assert.equal((await F.c.call('POST', '/api/metrics/credentials', { apiKey: 'a'.repeat(40) })).status, 403);
  assert.equal((await F.c.call('PUT', '/api/dashboards/one', { name: 'Overview', widgets: [] })).status, 200);
  assert.equal((await F.c.call('PUT', '/api/dashboards/two', { name: 'Second', widgets: [] })).status, 403, 'one dashboard on Free');
  assert.equal((await F.c.call('PUT', '/api/charts/c1', { name: 'x', config: { series: [{ metric: 'DailyActiveUsers', game: 'g1' }] } })).status, 200);
  assert.equal((await F.c.call('PUT', '/api/charts/c2', { name: 'x', config: { series: [{ formula: 'a/b' }] } })).status, 403, 'calculated metrics need Max');
  assert.equal((await F.c.call('GET', '/api/metrics/query?games=g1,g2&metrics=DailyActiveUsers')).status, 403, 'multi-game needs Max');
});

test('Roblox analytics: keys never leave the server, links are verified, sync writes Actual data', async () => {
  const L = await registerUser(app, 'light@example.com'); await setPlan(L.id, 'light'); await withGame(L.c);
  assert.equal((await L.c.call('POST', '/api/metrics/credentials', { apiKey: '_|WARNING:-DO-NOT-SHARE-THIS.--Sharing-this-will-allow' })).status, 400, 'rejects a login cookie');
  const key = 'rbx_' + 'x'.repeat(60) + 'TAIL';
  const c = await L.c.call('POST', '/api/metrics/credentials', { label: 'Main', apiKey: key });
  assert.equal(c.status, 200); assert.equal(c.json.key_hint, '…TAIL'); assert.ok(!JSON.stringify(c.json).includes(key));
  const src = await L.c.call('GET', '/api/metrics/sources'); assert.ok(!src.body.includes('xxxxxxxx') && !src.body.includes('secret_enc'));
  const stored = await db.one('select secret_enc from analytics_credentials where id = $1', [c.json.id]); assert.ok(!stored.secret_enc.includes('xxxx'), 'encrypted at rest');

  stubRoblox(() => ({ status: 401, body: {} }));
  const bad = await L.c.call('PUT', '/api/metrics/links/g1', { universeId: '123', credentialId: c.json.id }); assert.equal(bad.json.status, 'unauthorized');
  let seenKey = '';
  stubRoblox((url, init) => {
    seenKey = init.headers['x-api-key']; const b = JSON.parse(init.body);
    if (b.metric === 'MonthlyActiveUsers') return { status: 400, body: { code: 2001, message: 'Unsupported' } };
    const base = Date.parse(b.startTime);
    return ok([{ breakdowns: b.breakdown ? [{ dimension: b.breakdown[0], value: 'Computer' }] : [], dataPoints: [0, 1].map(k => ({ time: new Date(base + k * DAY).toISOString(), value: b.metric.includes('Retention') ? 0.2 : 100 + k, status: 'Valid' })) }]);
  });
  const good = await L.c.call('PUT', '/api/metrics/links/g1', { universeId: '123', credentialId: c.json.id }); assert.equal(good.json.status, 'ok'); assert.equal(seenKey, key);
  const s = await L.c.call('POST', '/api/metrics/sync/g1'); assert.equal(s.status, 200);
  assert.equal((await L.c.call('POST', '/api/metrics/sync/g1')).status, 429, 'respects the plan\'s sync interval');
  const r = await syncGame({ userId: L.id, gameId: 'g1', index: 0 }, Date.UTC(2026, 2, 1));
  restore();
  assert.equal(r!.status, 'partial');
  const link = (await L.c.call('GET', '/api/metrics/sources')).json.links[0]; assert.equal(link.status, 'ok'); assert.match(link.status_detail, /returned no data/);
  const q = await L.c.call('GET', '/api/metrics/query?game=g1&metrics=DailyActiveUsers&from=2025-01-01&to=2026-03-02&breakdown=Platform');
  const total = q.json.series.find((x: any) => x.breakdown === '' && x.source === 'roblox'), plat = q.json.series.find((x: any) => x.breakdown === 'Platform=Computer');
  assert.ok(total.points.length > 0 && plat.points.length > 0);
  const wk = await L.c.call('GET', '/api/metrics/query?game=g1&metrics=DailyActiveUsers&granularity=OneWeek&from=2025-01-01&to=2026-03-02');
  assert.ok(wk.json.series.length && wk.json.series[0].granularity === 'OneWeek', 'weekly values are Roblox\'s own OneWeek aggregation');
  const f = await L.c.call('POST', '/api/metrics/forecast', { game: 'g1', metric: 'DailyActiveUsers' });
  assert.equal(f.status, 200); assert.equal(f.json.ok, false, 'two synced days are not enough to forecast'); assert.match(f.json.reason, /Not enough data/);
  const other = await registerUser(app, 'other@example.com'); await withGame(other.c);
  assert.equal((await other.c.call('PUT', '/api/metrics/links/g1', { universeId: '123', credentialId: c.json.id })).status, 403, 'free plan');
});

test('dashboards and charts are private to their owner', async () => {
  const A = await registerUser(app, 'dash-a@example.com'), B = await registerUser(app, 'dash-b@example.com');
  const widgets = [{ id: 'w1', w: 8, h: 2, chart: { type: 'line', series: [{ metric: 'DailyActiveUsers' }] } }, { id: 'w2', w: 4, h: 1, kind: 'kpi' }];
  assert.equal((await A.c.call('PUT', '/api/dashboards/main', { name: 'Overview', widgets })).status, 200);
  assert.equal((await A.c.call('PUT', '/api/dashboards/main', { name: 'Overview', widgets: [{ id: 'w1', w: 5, h: 1 }] })).status, 400, 'sizes are validated');
  assert.deepEqual((await A.c.call('GET', '/api/dashboards')).json[0].widgets, widgets, 'layout persists');
  assert.deepEqual((await B.c.call('GET', '/api/dashboards')).json, []);
  await B.c.call('DELETE', '/api/dashboards/main');
  assert.equal((await A.c.call('GET', '/api/dashboards')).json.length, 1, 'another user can\'t delete it');
});
