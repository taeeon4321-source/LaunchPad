import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, registerUser } from './helpers.ts';
import { db } from '../src/db.ts';
import { config } from '../src/config.ts';
import { io, validate, costOf } from '../src/ai.ts';
import { refreshReferences, relevantReferences } from '../src/references.ts';
import { ANALYSIS_SCHEMA, priority } from '../src/routes/ai.ts';

let app: any;
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); await db.close(); });
const real = io.fetch, PNG = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
const finding = (id: string, extra = {}) => ({ id, title: 'Character too small', category: 'visual', severity: 'high', problem: 'The character fills about a tenth of the frame.', evidence: 'In the thumbnail the character sits bottom-left behind three props.', evidence_type: 'observed',
  reasoning: 'At phone size the face is unreadable.', solution: 'Scale the character to ~40% of the height and remove two props.', rewritten_text: '', experiment: '', confidence: 'high', reference_ids: ['ref_111', 'ref_999'], related_metrics: ['DailyActiveUsers:last28d', 'Made:up'],
  implementation_effort: 'low', impact_estimate: 'high', prompt_available: true, ...extra });
const analysis = () => ({ overall_assessment: 'The thumbnail lacks a focal point.', findings: [finding('f1'), finding('f1', { severity: 'low', impact_estimate: 'low' })], strengths: [],
  reference_comparisons: [{ reference_id: 'ref_111', why_relevant: 'Same pet simulator loop', technique: 'One large subject', what_to_adapt: 'Subject size', what_not_to_copy: 'Their mascot', visual_difference: 'Theirs fills the frame' }, { reference_id: 'ref_999', why_relevant: 'x', technique: 'x', what_to_adapt: 'x', what_not_to_copy: 'x', visual_difference: 'x' }],
  roadmap: { now: ['Enlarge the character'], next: [], later: [] }, limitations: ['No click-through data'] });
let calls: any[] = [];
function stub(out: () => any, status = 200) {
  calls = []; io.sleep = async () => {};
  io.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes('games.roblox.com/v1/games?')) return Response.json({ data: [{ id: 111, rootPlaceId: 5, name: 'Pet Sim Ref', creator: { name: 'Studio A' }, description: 'Hatch eggs, collect pets, rebirth.', genre: 'Simulator', playing: 900, visits: 1e6, favoritedCount: 5000 }, { id: 222, rootPlaceId: 6, name: 'Scary Ref', creator: { name: 'B' }, description: 'Escape the monster.', genre: 'Horror', playing: 9999, visits: 9e8, favoritedCount: 1 }] });
    if (u.includes('/games/icons')) return Response.json({ data: [{ targetId: 111, state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/icon111' }, { targetId: 222, state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/icon222' }] });
    if (u.includes('/multiget/thumbnails')) return Response.json({ data: [{ universeId: 111, thumbnails: [{ state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/th111' }] }, { universeId: 222, thumbnails: [{ state: 'Completed', imageUrl: 'https://evil.example/x' }] }] });
    const body = JSON.parse(init.body); calls.push(body);
    if (body.text.format.name === 'reference_tags') return Response.json({ output_text: JSON.stringify(body.input[1].content[0].text.includes('Pet') ? { game_type: 'simulator', styles: ['bright cartoon'], mechanics: ['pets', 'eggs/gacha', 'rebirth'], audience: 'kids and teens', presentation_notes: '' } : { game_type: 'horror', styles: ['dark/moody'], mechanics: ['horror'], audience: 'teens', presentation_notes: '' }), usage: { input_tokens: 100, output_tokens: 20 } });
    if (body.text.format.name === 'implementation_prompt') return Response.json({ output_text: JSON.stringify({ title: 'Thumbnail edit', prompt: 'Edit the attached thumbnail: enlarge the character…', attach: ['your current thumbnail'], expected_output: '1920x1080 PNG', testing: 'View at 150px wide' }), usage: { input_tokens: 500, output_tokens: 300 } });
    return new Response(JSON.stringify({ output_text: JSON.stringify(out()), usage: { input_tokens: 10000, output_tokens: 2000, input_tokens_details: { cached_tokens: 4000 } } }), { status });
  }) as any;
}
async function light(email: string) {
  const L = await registerUser(app, email);
  await db.query("insert into subscriptions (environment, provider_subscription_id, user_id, price_id, plan, billing_interval, status) values ('sandbox', $2, $1, 'pri_x', 'light', 'month', 'active')", [L.id, 'sub_' + L.id.slice(0, 8)]);
  await db.query('delete from entitlements where user_id = $1', [L.id]);
  await L.c.call('PUT', '/api/games/g1', { data: { id: 'g1', name: 'Egg Hatchers', genre: 'simulator', description: 'Hatch eggs and collect pets, then rebirth for multipliers.', loop: 'hatch, collect, rebirth' } });
  return L;
}

test('schema validator, cost and priority', () => {
  assert.equal(validate(analysis(), ANALYSIS_SCHEMA.schema), null);
  assert.match(validate({ ...analysis(), extra: 1 }, ANALYSIS_SCHEMA.schema)!, /unexpected/);
  assert.match(validate({ ...analysis(), findings: [{ ...finding('x'), severity: 'huge' }] }, ANALYSIS_SCHEMA.schema)!, /severity/);
  assert.equal(costOf('gpt-6.1-terra', { input: 10000, cached: 4000, output: 2000 }), (6000 * 1 + 4000 * 0.05 + 2000 * 5) / 1e6);
  assert.ok(priority(finding('a')).score > priority(finding('b', { severity: 'low', confidence: 'low', implementation_effort: 'high' })).score);
});

test('reference catalog: real public data only, relevance by type and mechanics', async () => {
  config.openai.apiKey = 'sk-test'; stub(analysis);
  const added = await refreshReferences(['111', '222']); assert.equal(added.length, 2);
  const r = await db.one('select * from reference_games where universe_id = 111');
  assert.equal(r.stats.visits, 1e6); assert.deepEqual(r.thumbnail_urls, ['https://tr.rbxcdn.com/th111']); assert.equal(r.tags.game_type, 'simulator');
  assert.deepEqual((await db.one('select thumbnail_urls from reference_games where universe_id = 222')).thumbnail_urls, [], 'non-Roblox image hosts are dropped');
  const refs = await relevantReferences({ genre: 'simulator', name: 'Egg Hatchers', description: 'hatch eggs, collect pets, rebirth' }, 'thumbnail');
  assert.deepEqual(refs.map(x => x.name), ['Pet Sim Ref'], 'the popular horror game is not picked for a simulator');
  assert.ok(refs[0].reasons.some((x: string) => /Same game type/.test(x)));
  io.fetch = real;
});

test('Free gets 1 AI analysis per day, paid plans are unlimited (server-enforced)', async () => {
  config.openai.apiKey = 'sk-test'; stub(analysis);
  const F = await registerUser(app, 'ai-free@example.com');
  await F.c.call('PUT', '/api/games/g1', { data: { id: 'g1', name: 'X', genre: 'simulator' } });
  assert.equal((await F.c.call('POST', '/api/ai/analyze', { gameId: 'g1', optimizer: 'thumbnail' })).status, 200, 'first analysis of the day');
  assert.equal((await F.c.call('POST', '/api/ai/analyze', { gameId: 'g1', optimizer: 'thumbnail' })).json.cached, true, 'a reused result does not count');
  const r = await F.c.call('POST', '/api/ai/analyze', { gameId: 'g1', optimizer: 'retention' }); assert.equal(r.status, 429); assert.equal(r.json.upgrade, true);
  assert.equal((await F.c.call('POST', '/api/ai/analyze', { gameId: 'g1', optimizer: 'thumbnail', force: true })).status, 429, 'reanalysis counts too');
  assert.equal((await F.c.call('GET', '/api/ai/usage')).json.dailyLimit, 1);
  const P = await light('ai-light-many@example.com');
  for (const o of ['thumbnail', 'retention', 'progression']) assert.equal((await P.c.call('POST', '/api/ai/analyze', { gameId: 'g1', optimizer: o })).status, 200, 'paid: no daily limit');
  assert.equal((await P.c.call('GET', '/api/ai/usage')).json.dailyLimit, null);
  io.fetch = real; config.openai.apiKey = '';
  const L = await light('ai-light-audit@example.com');
  assert.equal((await L.c.call('POST', '/api/ai/analyze', { gameId: 'g1', optimizer: 'audit' })).status, 403, 'full audit is Max');
});

test('analysis pipeline: images and references reach the model, output is validated, cached, tracked and turned into tasks', async () => {
  const L = await light('ai-light@example.com');
  config.openai.apiKey = ''; assert.equal((await L.c.call('POST', '/api/ai/analyze', { gameId: 'g1', optimizer: 'thumbnail' })).status, 503, 'no key: clear error, nothing faked');
  config.openai.apiKey = 'sk-test'; stub(analysis);
  assert.equal((await L.c.call('POST', '/api/ai/analyze', { gameId: 'g1', optimizer: 'thumbnail', images: [{ role: 'thumbnail', dataUrl: 'data:image/png;base64,AAAA' }] })).status, 400, 'image bytes are checked');
  const a = await L.c.call('POST', '/api/ai/analyze', { gameId: 'g1', optimizer: 'thumbnail', images: [{ role: 'thumbnail', dataUrl: PNG }], inputs: { focal: 'hero' } });
  assert.equal(a.status, 200, JSON.stringify(a.json)); assert.equal(a.json.cached, false);
  const sent = calls[0]; assert.equal(sent.model, config.openai.models.vision); assert.equal(sent.text.format.type, 'json_schema'); assert.equal(sent.text.format.strict, true);
  const content = sent.input[1].content; assert.ok(content.some((p: any) => p.type === 'input_image' && p.image_url === PNG), 'developer image sent');
  assert.ok(content.some((p: any) => p.type === 'input_image' && p.image_url === 'https://tr.rbxcdn.com/th111'), 'reference thumbnail sent');
  assert.ok(!JSON.stringify(sent).includes('sk-test'));
  const f = a.json.result.findings; assert.deepEqual(f[0].reference_ids, ['ref_111'], 'unknown references removed'); assert.deepEqual(f[0].related_metrics, [], 'metrics not in the packet removed');
  assert.notEqual(f[0].id, f[1].id, 'duplicate ids fixed'); assert.equal(a.json.result.reference_comparisons.length, 1);
  assert.ok(a.json.costUsd > 0);
  const again = await L.c.call('POST', '/api/ai/analyze', { gameId: 'g1', optimizer: 'thumbnail', images: [{ role: 'thumbnail', dataUrl: PNG }], inputs: { focal: 'hero' } });
  assert.equal(again.json.cached, true); assert.equal(calls.length, 1, 'unchanged evidence is not paid for twice');
  await L.c.call('POST', '/api/ai/analyze', { gameId: 'g1', optimizer: 'thumbnail', images: [{ role: 'thumbnail', dataUrl: PNG }], inputs: { focal: 'hero' }, force: true }); assert.equal(calls.length, 2, 'explicit reanalysis');
  const usage = await db.one('select count(*)::int n, sum(cost_usd)::float c from ai_usage where user_id = $1 and ok', [L.id]); assert.equal(usage.n, 2); assert.ok(usage.c > 0);
  const tasks = (await L.c.call('GET', '/api/ai/tasks?game=g1')).json; assert.equal(tasks.length, 2, 'older not-started tasks are superseded by the reanalysis');
  assert.ok(tasks[0].priority >= tasks[1].priority); assert.match(tasks[0].priority_reason, /severity/);
  assert.equal((await L.c.call('PATCH', `/api/ai/tasks/${tasks[0].id}`, { status: 'completed' })).status, 200);
  const p = await L.c.call('POST', '/api/ai/prompts', { analysisId: a.json.id, findingId: f[0].id, kind: 'image_edit', tool: 'image_ai' });
  assert.equal(p.status, 200); assert.match(p.json.prompt, /thumbnail/); assert.equal(calls.at(-1).model, config.openai.models.deep);
  assert.equal((await L.c.call('POST', '/api/ai/prompts', { analysisId: a.json.id, findingId: f[0].id, kind: 'image_edit', tool: 'image_ai' })).json.cached, true);
  const other = await light('ai-other@example.com');
  assert.equal((await other.c.call('GET', `/api/ai/analyses/${a.json.id}`)).status, 404, 'analyses are private');
  stub(() => ({ nonsense: true }));
  const bad = await L.c.call('POST', '/api/ai/analyze', { gameId: 'g1', optimizer: 'retention', force: true }); assert.equal(bad.status, 502, 'invalid model output is rejected, not stored');
  assert.equal((await db.one("select count(*)::int n from ai_analyses where user_id = $1 and optimizer = 'retention'", [L.id])).n, 0);
  assert.equal((await L.c.call('GET', '/api/ai/usage')).json.analysesThisMonth, 2, 'failed analyses don\'t use the allowance');
  io.fetch = real; config.openai.apiKey = '';
});
