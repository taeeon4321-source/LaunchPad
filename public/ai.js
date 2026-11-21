'use strict';
/* LaunchPad AI analysis UI (loaded on demand). Talks only to LaunchPad's server; the server calls OpenAI and enforces plans. */
(() => {
const AIX = window.AIX = { pages: {} };
const SEV = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' }, ET = { observed: 'Observed', interpretation: 'Interpretation', hypothesis: 'Hypothesis' };
const KIND_FOR = { visual: 'image_edit', presentation: 'game_page', onboarding: 'first_session', gameplay: 'gameplay', progression: 'progression', economy: 'progression', retention: 'retention_experiment', ui: 'ui_redesign', analytics: 'retention_experiment', technical: 'script' };
const KINDS = [['image_edit', 'Image editing'], ['ui_redesign', 'UI redesign'], ['ui_create', 'UI creation'], ['gameplay', 'Gameplay improvement'], ['progression', 'Progression improvement'], ['script', 'Script improvement'], ['game_page', 'Game page improvement'], ['first_session', 'First session improvement'], ['retention_experiment', 'Retention experiment'], ['full_audit', 'Full game audit']];
const TOOLS = [['image_ai', 'Image AI (editing / generation)'], ['general_ai', 'General AI assistant'], ['coding_ai', 'Coding AI'], ['roblox_studio_assistant', 'Roblox Studio Assistant']];
const OPTS = { thumbnail: 'Thumbnail & Icon', 'game-page': 'Game Page', 'first-session': 'First Session', retention: 'Retention', progression: 'Progression', audit: 'Full game audit' };
const has = f => !!ME?.entitlement?.features?.includes(f);
const refOf = (a, id) => (a.references || []).find(r => r.reference_id === id);
const refImg = (r, cls = '') => r?.thumbnail_url || r?._thumb ? `<img class="${cls}" src="${esc(r.thumbnail_url || r._thumb)}" alt="${esc(r.name)} thumbnail" loading="lazy" referrerpolicy="no-referrer">` : '';
const usd = n => n < 0.01 ? '<$0.01' : '$' + n.toFixed(2);
// The server only receives image data, never local paths: draw each image to a canvas and send ≤1024px JPEG.
async function toDataUrl(f, max = 1024) {
  const src = f && (f.hi || f.display || f.preview); if (!src) return null;
  const img = new Image(); img.crossOrigin = 'anonymous'; img.src = src; await img.decode().catch(() => null); if (!img.naturalWidth) return null;
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); try { return c.toDataURL('image/jpeg', 0.85); } catch { return null; }
}
AIX.images = async (opt, inputs) => {
  if (!['thumbnail', 'game-page', 'audit', 'first-session'].includes(opt)) return [];
  const list = [...(inputs.thumbs || []).slice(0, 3).map(t => ['thumbnail', t]), ...(inputs.icon ? [['icon', inputs.icon]] : []), ...((inputs.screens || []).slice(0, 2).map(t => ['screenshot', t]))];
  return (await Promise.all(list.map(async ([role, f]) => ({ role, dataUrl: await toDataUrl(f, role === 'icon' ? 512 : 1024) })))).filter(x => x.dataUrl);
};

/* ---------- upgrade (no fake previews) ---------- */
AIX.upgrade = (featureLabel, value) => openModal({ title: `${featureLabel} is part of Light and Max`, wide: true, body: `<p style="margin-top:0">${esc(value)}</p>
  <div class="table-wrap"><table><thead><tr><th></th><th>Free</th><th>Light</th><th>Max</th></tr></thead><tbody>
    <tr><td>Rule-based quick checks</td><td>✓</td><td>✓</td><td>✓</td></tr><tr><td>AI analysis of thumbnails, icons, game page, first session, retention, progression</td><td>1 per day</td><td>Unlimited</td><td>Unlimited</td></tr>
    <tr><td>Reference comparisons and implementation prompts</td><td>✓</td><td>✓</td><td>✓</td></tr><tr><td>Full game audit</td><td>—</td><td>—</td><td>✓</td></tr></tbody></table></div>
  <p class="small muted">Your inputs stay saved here, so you can run the analysis right after upgrading.</p>`,
  actions: `<button class="btn ghost" data-close>Not now</button><button class="btn" id="upGo">See plans</button>`, onMount: m => { $('#upGo', m).onclick = () => { closeModal(); go('#/pricing'); }; } });

/* ---------- panel on each optimizer page ---------- */
AIX.panel = async (el, opt, inputs) => {
  const g = selectedGame(), label = OPTS[opt];
  const shell = body => { el.innerHTML = `<section class="section ai-sec"><div class="ai-head"><div><span class="t-label">AI analysis</span><h2>${esc(label)}</h2></div>${body.actions || ''}</div>${body.html || ''}</section>`; };
  if (!isAuthed()) return shell({ html: '<p class="small muted">Sign up to have LaunchPad\'s AI critique your actual images, game data and analytics.</p>' });
  if (!g || g.sample) return shell({ html: '<p class="small muted">Choose or add your own game above. AI analysis is saved to your game.</p>' });
  if (!has('ai_analysis')) {
    shell({ actions: '<button class="btn" id="aiLock">Run AI analysis</button>', html: `<p class="small muted" style="margin:0">Looks at your actual ${opt === 'thumbnail' ? 'thumbnail and icon images' : 'game, scan and analytics'}, compares them with real Roblox experiences and gives specific fixes with ready-to-use prompts. Light and Max.</p>` });
    $('#aiLock', el).onclick = () => AIX.upgrade(`${label} AI analysis`, 'The AI inspects your real assets and data, finds the specific problems, compares them with relevant real games and writes the fixes and prompts to implement them.');
    return;
  }
  let latest = null; try { latest = (await api('GET', `/api/ai/analyses?game=${encodeURIComponent(g.id)}`)).find(a => a.optimizer === opt) || null; } catch { }
  const freeNote = ME.entitlement.plan === 'free' ? '<p class="tiny muted" style="margin:4px 0 0">Free includes 1 AI analysis per day. Reused results don\'t count. <a href="#/pricing">Light and Max are unlimited.</a></p>' : '';
  shell({ actions: `<button class="btn ${latest ? 'ghost' : ''}" id="aiRun">${latest ? 'Re-analyze' : 'Run AI analysis'}</button>`, html: (latest ? '' : '<p class="small muted" style="margin:0">Uses your current inputs, images, Studio scan and analytics. Unchanged inputs reuse the last analysis at no cost.</p>') + freeNote + '<div id="aiOut"></div>' });
  if (latest) AIX.render($('#aiOut', el), latest, inputs);
  $('#aiRun', el).onclick = async () => {
    const b = $('#aiRun', el), out = $('#aiOut', el); b.disabled = true; b.textContent = 'Analyzing…';
    out.innerHTML = '<div class="ai-wait"><div class="ax-skel"></div><p class="small muted">Collecting evidence, choosing references and analyzing. This can take up to a minute.</p></div>';
    try {
      if (S().games.some(x => x.id === g.id && !x.sample)) await syncNow();
      const a = await api('POST', '/api/ai/analyze', { gameId: g.id, optimizer: opt, inputs: AIX.cleanInputs(inputs), images: await AIX.images(opt, inputs), force: !!latest });
      AIX.render(out, a, inputs); b.textContent = 'Re-analyze'; b.classList.add('ghost');
      if (a.cached) toast('Nothing changed since the last analysis, so it was reused (no cost).');
    } catch (e) { out.innerHTML = `<div class="ax-note warn">${esc(e.message)}</div>`; if (e.data?.upgrade) AIX.upgrade(e.data.feature === 'ai_daily' ? 'Unlimited AI analysis' : label, e.message); b.textContent = latest ? 'Re-analyze' : 'Run AI analysis'; }
    b.disabled = false;
  };
};
// Inputs without image data (images go separately, resized) and without huge fields.
AIX.cleanInputs = inp => JSON.parse(JSON.stringify(inp, (k, v) => (k === 'preview' || k === 'hi' || k === 'display') ? undefined : typeof v === 'string' ? v.slice(0, 3000) : v));

/* ---------- report ---------- */
AIX.render = (el, a, inputs = {}) => {
  const r = a.result, f = r.findings, own = [...(inputs.thumbs || []).map((t, i) => ({ l: `Your thumbnail ${i + 1}`, src: t.display || t.preview })), ...(inputs.icon ? [{ l: 'Your icon', src: inputs.icon.display || inputs.icon.preview, icon: true }] : [])].filter(x => x.src);
  const refs = (a.references || []).filter(x => r.reference_comparisons.some(c => c.reference_id === x.reference_id) || f.some(y => y.reference_ids.includes(x.reference_id)));
  el.innerHTML = `<div class="ai-report">
    <p class="ai-overall">${esc(r.overall_assessment)}</p>
    <p class="ai-meta">${AX_KIND('AI analysis')} ${esc(a.model)} · ${fmtDateTime(Date.parse(a.createdAt))}${a.cached ? ' · reused' : ''} · ${usd(a.costUsd)} · sources: ${[a.sources.images?.length ? `${a.sources.images.length} image(s)` : '', a.sources.scan ? 'Studio scan' : '', a.sources.analytics ? `${a.sources.analytics} metrics` : '', a.sources.references ? `${a.sources.references} references` : ''].filter(Boolean).join(', ') || 'your inputs'}</p>
    <h3 class="ai-h">Critical issues</h3><ol class="ai-findings">${f.map((x, i) => findingHTML(a, x, i)).join('')}</ol>
    ${refs.length && (own.length || a.optimizer === 'thumbnail') ? `<h3 class="ai-h">Compare with real games</h3><div class="ai-compare" id="aiCmp"></div>` : ''}
    ${r.reference_comparisons.length ? `<h3 class="ai-h">Concepts to try</h3><div class="ai-concepts">${r.reference_comparisons.map(c => { const ref = refOf(a, c.reference_id); return ref ? `<article class="ai-concept">${refImg(ref)}<div><b>${esc(ref.name)}</b><span class="tiny muted"> by ${esc(ref.creator || 'unknown')}</span>
      <p class="small"><b>Technique:</b> ${esc(c.technique)}</p><p class="small"><b>Why it's relevant:</b> ${esc(c.why_relevant)}</p><p class="small"><b>Adapt:</b> ${esc(c.what_to_adapt)}</p><p class="small"><b>Don't copy:</b> ${esc(c.what_not_to_copy)}</p>
      <a class="tiny" href="https://www.roblox.com/games/${esc(ref.root_place_id || '')}" target="_blank" rel="noopener noreferrer">View on Roblox</a></div></article>` : ''; }).join('')}</div>` : ''}
    ${f.some(x => x.experiment) ? `<h3 class="ai-h">Experiments</h3><ul class="ai-exp">${f.filter(x => x.experiment).map(x => `<li><b>${esc(x.title)}</b><span class="small">${esc(x.experiment)}</span></li>`).join('')}</ul>` : ''}
    ${r.strengths.length ? `<h3 class="ai-h">What's working</h3><ul class="ai-exp">${r.strengths.map(s => `<li><b>${esc(s.point)}</b><span class="small muted">${esc(s.evidence)}</span></li>`).join('')}</ul>` : ''}
    <div class="ai-road">${['now', 'next', 'later'].map(k => r.roadmap[k].length ? `<div><span class="t-label">${{ now: 'Do first', next: 'Next', later: 'Later' }[k]}</span><ul>${r.roadmap[k].map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '').join('')}</div>
    <details class="ai-lim"><summary>Confidence and limitations</summary><ul class="small">${r.limitations.map(x => `<li>${esc(x)}</li>`).join('') || '<li>None stated.</li>'}<li>Findings marked Interpretation or Hypothesis aren't proven causes. Reference relevance describes how comparable a game is, not how good it is. Reference figures are Roblox's public counts at the date shown, never private metrics.</li></ul></details></div>`;
  el.onclick = e => {
    const p = e.target.closest('[data-prompt]'); if (p) return AIX.promptModal(a, p.dataset.prompt);
    const c = e.target.closest('[data-copy]'); if (c) return copyText(c.dataset.copy).then(() => toast('Copied'));
  };
  if ($('#aiCmp', el)) compareGallery($('#aiCmp', el), own, refs, r);
};
const AX_KIND = l => `<span class="ax-kind ax-k-forecast">${esc(l)}</span>`;
function findingHTML(a, x, i) {
  return `<li class="ai-f sev-${x.severity}"><div class="ai-f-h"><span class="ai-sev">${SEV[x.severity]}</span><h4>${esc(x.title)}</h4><span class="tiny muted">${esc(x.category)} · ${x.implementation_effort} effort · ${x.impact_estimate} impact · ${x.confidence} confidence</span></div>
    <p><b>Problem.</b> ${esc(x.problem)}</p><p><b>Change.</b> ${esc(x.solution)}</p>
    ${x.rewritten_text ? `<div class="copyable small">${esc(x.rewritten_text)}</div><button class="btn ghost sm" data-copy="${esc(x.rewritten_text)}">${icon('copy', 14)} Copy rewrite</button>` : ''}
    <details><summary class="small">Evidence and reasoning</summary><p class="small"><span class="ai-et">${ET[x.evidence_type]}</span> ${esc(x.evidence)}</p><p class="small muted">${esc(x.reasoning)}</p>
      ${x.related_metrics.length ? `<p class="tiny muted">Metrics: ${x.related_metrics.map(esc).join(', ')}</p>` : ''}${x.reference_ids.length ? `<div class="ai-f-refs">${x.reference_ids.map(id => { const r = refOf(a, id); return r ? `<figure>${refImg(r)}<figcaption class="tiny">${esc(r.name)}</figcaption></figure>` : ''; }).join('')}</div>` : ''}</details>
    ${x.prompt_available ? `<button class="btn sm" data-prompt="${esc(x.id)}">${icon('sparkle', 14)} Generate implementation prompt</button>` : ''}</li>`;
}
// Side by side at the same size; switch reference; the AI's specific comparison underneath.
function compareGallery(el, own, refs, r) {
  let ri = 0, oi = 0;
  const draw = () => {
    const ref = refs[ri], mine = own[oi], c = r.reference_comparisons.find(x => x.reference_id === ref.reference_id);
    el.innerHTML = `<div class="ai-cmp-pick">${own.length > 1 ? `<select id="aiOwn" aria-label="Your image">${own.map((o, i) => `<option value="${i}" ${i === oi ? 'selected' : ''}>${esc(o.l)}</option>`).join('')}</select>` : ''}<div class="seg ax-seg" role="group" aria-label="Reference">${refs.map((x, i) => `<button type="button" data-ri="${i}" aria-pressed="${i === ri}">${esc(x.name)}</button>`).join('')}</div></div>
      <div class="ai-cmp-pair"><figure>${mine ? `<img src="${esc(mine.src)}" alt="${esc(mine.l)}">` : '<div class="ax-empty">Upload your thumbnail to compare</div>'}<figcaption>${esc(mine?.l || 'Your image')}</figcaption></figure>
        <figure>${refImg(ref)}<figcaption>${esc(ref.name)} <span class="tiny muted">· relevance ${Math.round(ref.relevance * 100)}% · ${esc((ref.selected_because || []).join('; '))}</span></figcaption></figure></div>
      ${c ? `<p class="small"><b>Difference:</b> ${esc(c.visual_difference)}</p>` : ''}
      <p class="tiny faint">Public data as of ${ref.public_stats?.fetchedAt ? fmtDate(Date.parse(ref.public_stats.fetchedAt)) : '—'}: ${ref.public_stats?.visits != null ? `${Number(ref.public_stats.visits).toLocaleString()} visits` : 'no visit count'}${ref.public_stats?.favorites != null ? `, ${Number(ref.public_stats.favorites).toLocaleString()} favorites` : ''}. Popularity isn't the same as retention or click-through.</p>`;
    el.querySelectorAll('[data-ri]').forEach(b => b.onclick = () => { ri = +b.dataset.ri; draw(); });
    $('#aiOwn', el) && ($('#aiOwn', el).onchange = e => { oi = +e.target.value; draw(); });
  };
  refs.forEach(x => { x._thumb = x._thumb || null; });
  hydrate(refs).then(draw);
}
// Reference thumbnails come from the catalog (the analysis stores ids and facts, the catalog the current asset URLs).
const catCache = new Map();
async function hydrate(refs) {
  const need = refs.filter(r => !r._thumb && !catCache.has(r.reference_id));
  if (need.length) { try { const d = await api('GET', '/api/references'); d.references.forEach(x => catCache.set(`ref_${x.universe_id}`, x)); } catch { } }
  refs.forEach(r => { const c = catCache.get(r.reference_id); if (c) { r._thumb = c.thumbnail_urls?.[0] || c.icon_url; r.root_place_id = c.root_place_id; r.creator ||= c.creator; } });
}
const _render = AIX.render; AIX.render = async (el, a, inputs) => { await hydrate(a.references || []); _render(el, a, inputs); };

/* ---------- prompt generator ---------- */
AIX.promptModal = (a, findingId) => {
  const f = a.result.findings.find(x => x.id === findingId);
  openModal({ title: 'Implementation prompt', wide: true, body: `<p class="small muted" style="margin-top:0">${f ? esc(f.title) : 'Whole analysis'}</p>
    <div class="form-grid"><div><label class="label" for="pmKind">Prompt type</label><select id="pmKind">${KINDS.map(([k, l]) => `<option value="${k}" ${k === (KIND_FOR[f?.category] || 'full_audit') ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div><label class="label" for="pmTool">For</label><select id="pmTool">${TOOLS.map(([k, l]) => `<option value="${k}" ${k === (f?.category === 'visual' ? 'image_ai' : f?.category === 'technical' ? 'coding_ai' : 'general_ai') ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
    <label class="label" for="pmNotes" style="margin-top:10px">Extra constraints (optional)</label><textarea id="pmNotes" rows="2" maxlength="1000" placeholder="e.g. keep our mascot, mobile-first, don't touch the save system"></textarea>
    <div id="pmOut"></div>`, actions: '<button class="btn ghost" data-close>Close</button><button class="btn" id="pmGo">Generate</button>',
    onMount: m => { $('#pmGo', m).onclick = async () => { const b = $('#pmGo', m); b.disabled = true; b.textContent = 'Writing…';
      try { const p = await api('POST', '/api/ai/prompts', { analysisId: a.id, findingId, kind: $('#pmKind', m).value, tool: $('#pmTool', m).value, notes: $('#pmNotes', m).value });
        $('#pmOut', m).innerHTML = `<label class="label" for="pmText" style="margin-top:14px">${esc(p.title)}</label><textarea id="pmText" rows="14" class="ai-prompt">${esc(p.prompt)}</textarea>
          ${p.attach.length ? `<p class="small"><b>Attach:</b> ${p.attach.map(esc).join(', ')}</p>` : ''}<p class="small"><b>Expected output:</b> ${esc(p.expected_output)}</p><p class="small"><b>Check it by:</b> ${esc(p.testing)}</p>
          <button class="btn ghost sm" id="pmCopy">${icon('copy', 14)} Copy prompt</button><p class="tiny faint">LaunchPad doesn't edit your game. Review anything an AI tool produces before using it.</p>`;
        $('#pmCopy', m).onclick = () => copyText($('#pmText', m).value).then(() => toast('Prompt copied'));
      } catch (e) { $('#pmOut', m).innerHTML = `<p class="ax-note warn">${esc(e.message)}</p>`; if (e.data?.upgrade) { closeModal(); AIX.upgrade('Implementation prompts', e.message); } }
      b.disabled = false; b.textContent = 'Generate again'; }; } });
};

/* ---------- Concepts to Try without an analysis: real references for the genre ---------- */
AIX.concepts = async (el, genre) => {
  if (!isAuthed()) { el.innerHTML = '<section class="section"><h2>Concepts to try</h2><p class="small muted">Sign in to browse real Roblox thumbnails from games like yours.</p></section>'; return; }
  let d; try { d = await api('GET', `/api/references?type=${encodeURIComponent(genre || '')}`); } catch { return; }
  const list = d.references.filter(r => r.thumbnail_urls?.length).slice(0, 6);
  el.innerHTML = `<section class="section"><div class="section-title"><h2>Concepts to try</h2><span class="small muted">Real thumbnails from ${esc(genre || 'related')} games in LaunchPad's reference catalog</span></div>
    ${list.length ? `<div class="ai-concepts">${list.map(r => `<article class="ai-concept"><img src="${esc(r.thumbnail_urls[0])}" alt="${esc(r.name)} thumbnail" loading="lazy" referrerpolicy="no-referrer"><div><b>${esc(r.name)}</b><span class="tiny muted"> by ${esc(r.creator || '')}</span><p class="tiny muted">${esc([r.tags?.styles?.join(', '), r.tags?.mechanics?.slice(0, 3).join(', ')].filter(Boolean).join(' · '))}</p><a class="tiny" href="https://www.roblox.com/games/${esc(r.root_place_id || '')}" target="_blank" rel="noopener noreferrer">View on Roblox</a></div></article>`).join('')}</div>
      <p class="small muted">${has('ai_analysis') ? 'Run the AI analysis above to see which techniques fit your thumbnail and what to change.' : 'The AI analysis (Light and Max) picks the most relevant of these and explains which techniques apply to your thumbnail.'}</p>` : '<p class="small muted">No references for this genre in the catalog yet.</p>'}</section>`;
};

/* ---------- Action Center ---------- */
const STATUS = [['not_started', 'Not started'], ['in_progress', 'In progress'], ['completed', 'Completed'], ['dismissed', 'Dismissed']];
AIX.pages.actions = async () => {
  const v = $('#view'), games = S().games.filter(g => !g.sample), g = selectedGame()?.sample ? games[0] : selectedGame();
  v.innerHTML = `<header class="page-head"><h1>Action Center</h1></header>`;
  if (!isAuthed()) { v.insertAdjacentHTML('beforeend', '<div class="card ax-empty-state"><h2>Sign up to collect your fixes here.</h2></div>'); return; }
  if (!games.length) { v.insertAdjacentHTML('beforeend', AX_noGames()); return; }
  const tasks = await api('GET', `/api/ai/tasks?game=${encodeURIComponent(g.id)}`).catch(() => []), filt = AIX.filter || 'open';
  const open = tasks.filter(t => t.status === 'not_started' || t.status === 'in_progress'), shown = tasks.filter(t => filt === 'open' ? open.includes(t) : t.status === filt);
  v.insertAdjacentHTML('beforeend', `<div class="ax-bar"><label class="ax-sel"><span class="sr-only">Game</span><select id="acGame">${games.map(x => `<option value="${esc(x.id)}" ${x.id === g.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <div class="seg ax-seg" role="group" aria-label="Show">${[['open', `Open (${open.length})`], ['completed', 'Completed'], ['dismissed', 'Dismissed']].map(([k, l]) => `<button data-f="${k}" aria-pressed="${k === filt}">${l}</button>`).join('')}</div></div>
    ${!tasks.length ? `<div class="card ax-empty-state"><h2>No findings yet for ${esc(g.name)}.</h2><p class="small muted">Run an AI analysis on any optimizer. Its findings land here, ordered by priority.</p><a class="btn" href="#/optimizers">Open optimizers</a></div>` : ''}
    ${open.length && filt === 'open' ? `<section class="ai-roadmap"><div><span class="t-label">Highest priority</span><b>${esc(open[0].finding.title)}</b></div>${open[1] ? `<div><span class="t-label">Next</span><b>${esc(open[1].finding.title)}</b></div>` : ''}${open[2] ? `<div><span class="t-label">Later</span><b>${esc(open[2].finding.title)}</b></div>` : ''}</section>` : ''}
    <ol class="ai-tasks">${shown.map(t => `<li class="card ai-task sev-${t.finding.severity}"><div class="ai-f-h"><span class="ai-sev">${SEV[t.finding.severity]}</span><h3>${esc(t.finding.title)}</h3><select data-st="${esc(t.id)}" aria-label="Status">${STATUS.map(([k, l]) => `<option value="${k}" ${k === t.status ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <p class="tiny muted">${esc(OPTS[t.optimizer] || t.optimizer)} · ${esc(t.finding.category)} · ${t.finding.implementation_effort} effort · ${t.finding.impact_estimate} impact · priority because: ${esc(t.priority_reason)}</p>
      <p><b>Issue.</b> ${esc(t.finding.problem)}</p><p><b>Fix.</b> ${esc(t.finding.solution)}</p>
      <details><summary class="small">Evidence</summary><p class="small"><span class="ai-et">${ET[t.finding.evidence_type]}</span> ${esc(t.finding.evidence)}</p><p class="small muted">${esc(t.finding.reasoning)}</p></details>
      <div class="row" style="gap:8px">${t.finding.prompt_available ? `<button class="btn ghost sm" data-pt="${esc(t.id)}">${icon('sparkle', 14)} Prompt</button>` : ''}<span class="tiny faint">${fmtDate(Date.parse(t.created_at))}</span></div></li>`).join('')}</ol>
    ${tasks.length ? '<p class="tiny faint">Priority combines severity, likely impact, confidence and effort. It helps order the work; it isn\'t a measurement.</p>' : ''}`);
  $('#acGame').onchange = e => { S().selectedGameId = e.target.value; save(); AIX.pages.actions(); };
  v.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { AIX.filter = b.dataset.f; AIX.pages.actions(); });
  v.querySelectorAll('[data-st]').forEach(s => s.onchange = async () => { try { await api('PATCH', `/api/ai/tasks/${encodeURIComponent(s.dataset.st)}`, { status: s.value }); toast('Updated'); AIX.pages.actions(); } catch (e) { toast(e.message, 'warn'); } });
  v.querySelectorAll('[data-pt]').forEach(b => b.onclick = async () => { const t = tasks.find(x => x.id === b.dataset.pt); try { AIX.promptModal(await api('GET', `/api/ai/analyses/${t.analysis_id}`), t.finding.id); } catch (e) { toast(e.message, 'warn'); } });
};
const AX_noGames = () => `<div class="card ax-empty-state"><h2>Add a game first.</h2><button class="btn" data-addgame>${icon('plus', 18)} New Game</button></div>`;

/* ---------- Prompt Generator page ---------- */
AIX.pages.prompts = async () => {
  const v = $('#view'), games = S().games.filter(g => !g.sample), g = selectedGame()?.sample ? games[0] : selectedGame();
  v.innerHTML = '<header class="page-head"><h1>Prompt Generator</h1></header>';
  if (!isAuthed() || !games.length) { v.insertAdjacentHTML('beforeend', isAuthed() ? AX_noGames() : '<div class="card ax-empty-state"><h2>Sign up to generate prompts from your analyses.</h2></div>'); return; }
  if (!has('ai_analysis')) { v.insertAdjacentHTML('beforeend', '<div class="card ax-empty-state"><h2>Prompts are built from AI analyses.</h2><p class="small muted">Light and Max.</p><button class="btn" id="pgUp">See plans</button></div>'); $('#pgUp').onclick = () => AIX.upgrade('Implementation prompts', 'Turn each finding into a complete prompt for image, UI, scripting or game-design AI tools.'); return; }
  const list = await api('GET', `/api/ai/analyses?game=${encodeURIComponent(g.id)}`).catch(() => []);
  v.insertAdjacentHTML('beforeend', `<p class="small muted" style="margin-top:-12px">Pick a finding from your latest analyses and turn it into a complete prompt for an external AI tool. LaunchPad never edits your game directly.</p>
    ${list.length ? `<div class="card"><div class="form-grid"><div><label class="label" for="pgA">Analysis</label><select id="pgA">${list.map(a => `<option value="${a.id}">${esc(OPTS[a.optimizer])} · ${fmtDate(Date.parse(a.createdAt))}</option>`).join('')}</select></div><div><label class="label" for="pgF">Finding</label><select id="pgF"></select></div></div><button class="btn" id="pgGo" style="margin-top:12px">Choose prompt type…</button></div>` : '<div class="card ax-empty-state"><h2>No analyses yet.</h2><a class="btn" href="#/optimizers">Run one</a></div>'}`);
  if (!list.length) return;
  const fill = () => { const a = list.find(x => x.id === $('#pgA').value); $('#pgF').innerHTML = a.result.findings.map(f => `<option value="${esc(f.id)}">${esc(SEV[f.severity])} · ${esc(f.title)}</option>`).join(''); };
  fill(); $('#pgA').onchange = fill; $('#pgGo').onclick = () => AIX.promptModal(list.find(x => x.id === $('#pgA').value), $('#pgF').value);
};

/* ---------- Reference catalog ---------- */
AIX.pages.references = async (q = {}) => {
  const v = $('#view'), admin = (ME?.roles || []).some(r => r === 'owner' || r === 'administrator');
  v.innerHTML = '<header class="page-head"><h1>Reference games</h1></header>';
  if (!isAuthed()) { v.insertAdjacentHTML('beforeend', '<div class="card ax-empty-state"><h2>Sign in to browse the reference catalog.</h2></div>'); return; }
  const st = AIX.refQ ||= { q: '', type: '', style: '', mechanic: '' };
  const d = await api('GET', `/api/references?q=${encodeURIComponent(st.q)}&type=${encodeURIComponent(st.type)}&style=${encodeURIComponent(st.style)}&mechanic=${encodeURIComponent(st.mechanic)}`);
  v.insertAdjacentHTML('beforeend', `<div class="ax-bar"><input id="rfQ" placeholder="Search name or creator" value="${esc(st.q)}" style="height:34px;border-radius:9px;border:1px solid var(--border);padding:0 10px;background:var(--surface)">
      <select id="rfT" aria-label="Game type"><option value="">All types</option>${['simulator', 'tycoon', 'obby', 'rpg', 'horror', 'roleplay', 'fighting', 'survival', 'racing', 'puzzle', 'shooter', 'social', 'other'].map(t => `<option ${t === st.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <select id="rfS" aria-label="Visual style"><option value="">All styles</option>${d.styles.map(t => `<option ${t === st.style ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <select id="rfM" aria-label="Mechanic"><option value="">All mechanics</option>${d.mechanics.map(t => `<option ${t === st.mechanic ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select><span class="ax-fresh">${d.references.length} games</span></div>
    ${admin ? `<div class="card sunk" style="margin-bottom:16px"><label class="label" for="rfAdd">Add experiences (Roblox game links or universe IDs)</label><div class="row" style="gap:8px"><input id="rfAdd" style="flex:1" placeholder="https://www.roblox.com/games/123…, 456…"><button class="btn sm" id="rfGo">Add</button></div><p class="tiny faint">Public data only, from Roblox's public APIs. Refreshed weekly.</p></div>` : ''}
    <div class="ai-refgrid">${d.references.map(r => `<article class="ai-ref">${r.thumbnail_urls?.[0] ? `<img src="${esc(r.thumbnail_urls[0])}" alt="${esc(r.name)} thumbnail" loading="lazy" referrerpolicy="no-referrer">` : '<div class="ax-empty">No thumbnail</div>'}
      <div class="ai-ref-b">${r.icon_url ? `<img class="ai-ref-ic" src="${esc(r.icon_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<div><b>${esc(r.name)}</b><span class="tiny muted">${esc(r.creator || '')}${r.genre ? ' · ' + esc(r.genre) : ''}</span>
      <span class="tiny muted">${r.stats?.visits != null ? `${Number(r.stats.visits).toLocaleString()} visits · ` : ''}${r.stats?.playing != null ? `${Number(r.stats.playing).toLocaleString()} playing` : ''}${r.refreshed_at ? ` · ${fmtDate(Date.parse(r.refreshed_at))}` : ''}</span>
      <span class="tiny">${esc([...(r.tags?.styles || []), ...(r.tags?.mechanics || []).slice(0, 4)].join(' · '))}</span></div></div></article>`).join('') || '<p class="small muted">No matches.</p>'}</div>`);
  const upd = debounce(() => { st.q = $('#rfQ').value; st.type = $('#rfT').value; st.style = $('#rfS').value; st.mechanic = $('#rfM').value; AIX.pages.references(); }, 350);
  ['#rfQ', '#rfT', '#rfS', '#rfM'].forEach(s => { $(s).oninput = upd; $(s).onchange = upd; });
  $('#rfGo') && ($('#rfGo').onclick = async () => { const b = $('#rfGo'); b.disabled = true; try { const r = await api('POST', '/api/admin/references', { ids: $('#rfAdd').value }); toast(`Added ${r.added.length}`); AIX.pages.references(); } catch (e) { toast(e.message, 'warn'); b.disabled = false; } });
};
})();
