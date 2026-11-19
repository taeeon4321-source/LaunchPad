'use strict';
/* LaunchPad analytics (loaded on demand). Uses app.js globals: $, $$, esc, icon, api, toast, openModal, closeModal, confirmDialog,
   S, save, ME, isAuthed, selectedGame, gameById, go, route, reducedMotion, fmtDate, fmtDateTime, timeAgo, debounce, OPTIMIZERS, OPT, PRI, latestReport. */
(() => {
const DAY = 864e5, EASE = 'cubic-bezier(.2,.7,.2,1)', DRAW_MS = 1000;
const AX = window.AX = { catalog: null, cache: new Map(), sources: null, pages: {}, demo: false };
const motion = () => !reducedMotion() && !document.hidden && !S().prefs.ax?.noChartMotion;
const today = () => Math.floor(Date.now() / DAY) * DAY;
const KIND = { roblox: 'Actual', upload: 'Uploaded', benchmark: 'Benchmark', calc: 'Calculated', forecast: 'Forecast', demo: 'Demonstration' };
AX.KIND = KIND;

/* ---------- catalog, sources, queries ---------- */
AX.load = async () => {
  if (!AX.catalog) AX.catalog = await api('GET', '/api/metrics/catalog');
  AX.demo = !isAuthed();
  return AX.catalog;
};
AX.def = m => AX.catalog?.metrics[m] || { label: m, unit: 'count', grans: ['OneDay'], dims: [], def: '' };
AX.bust = () => AX.cache.clear();
AX.loadSources = async (force) => {
  if (AX.demo) return AX.sources = { credentials: [], links: [], runs: [], datasets: [] };
  if (!AX.sources || force) AX.sources = await api('GET', '/api/metrics/sources');
  return AX.sources;
};
// One request per (games, metrics, range, granularity, breakdown); cached for 5 minutes and shared by every chart that needs it.
AX.query = (o) => {
  const key = JSON.stringify(o), hit = AX.cache.get(key);
  if (hit && Date.now() - hit.at < 300e3) return hit.p;
  const p = AX.demo ? Promise.resolve(AX.demoQuery(o)) : api('GET', `/api/metrics/query?games=${o.games.map(encodeURIComponent).join(',')}&metrics=${o.metrics.join(',')}&granularity=${o.gran || 'OneDay'}&from=${new Date(o.from).toISOString()}&to=${new Date(o.to).toISOString()}&breakdown=${encodeURIComponent(o.breakdown || '')}`);
  AX.cache.set(key, { at: Date.now(), p }); p.catch(() => AX.cache.delete(key));
  return p;
};
// Picks one source per metric: official Roblox data first, then uploads. Benchmarks are only ever overlays.
AX.pick = (series, metric, { game, breakdown = '', source } = {}) => {
  const c = series.filter(s => s.metric === metric && s.breakdown === breakdown && (!game || s.game === game));
  return source ? c.find(s => s.source === source) : c.find(s => s.source === 'roblox') || c.find(s => s.source === 'demo') || c.find(s => s.source === 'upload') || null;
};
AX.range = (preset, custom) => {
  if (preset === 'custom' && custom?.from && custom?.to) return { from: Date.parse(custom.from), to: Date.parse(custom.to) + DAY, label: `${fmtDate(Date.parse(custom.from))} – ${fmtDate(Date.parse(custom.to))}` };
  const d = { '7d': 7, '28d': 28, '90d': 90, '180d': 180, '365d': 365 }[preset] || 28, to = today();
  return { from: to - d * DAY, to, label: `Last ${d} days`, days: d };
};
AX.prevRange = r => ({ from: r.from - (r.to - r.from), to: r.from });
AX.RANGES = [['7d', '7 days'], ['28d', '28 days'], ['90d', '90 days'], ['180d', '180 days'], ['365d', '365 days'], ['custom', 'Custom']];

/* ---------- formatting ---------- */
const compact = v => Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(Math.abs(v) >= 1e7 ? 0 : 1) + 'M' : Math.abs(v) >= 1e4 ? (v / 1e3).toFixed(Math.abs(v) >= 1e5 ? 0 : 1) + 'K' : Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : (Math.round(v * 10) / 10).toLocaleString();
AX.fmt = (unit, v, short) => {
  if (v == null || !isFinite(v)) return '—';
  if (unit === 'ratio') return (v * 100).toFixed(short && v >= 0.1 ? 0 : 1) + '%';
  if (unit === 'minutes') return v >= 90 && !short ? `${Math.floor(v / 60)}h ${String(Math.round(v % 60)).padStart(2, '0')}m` : `${(Math.round(v * 10) / 10).toLocaleString()} min`;
  if (unit === 'hours') return compact(v) + (short ? 'h' : ' h');
  if (unit === 'index') return Math.round(v).toString();
  if (unit === 'number') return (Math.round(v * 100) / 100).toLocaleString();
  return compact(v);
};
AX.unitLabel = u => ({ ratio: '%', count: 'count', minutes: 'minutes', hours: 'hours', amount: 'amount', index: 'index (first = 100)', number: 'number' }[u] || u);
const fmtX = (t, span) => { const d = new Date(t); return span > 400 * DAY ? d.toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }); };
AX.fmtDay = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
AX.chip = (kind, extra = '') => `<span class="ax-kind ax-k-${kind}" title="${esc({ roblox: 'Retrieved from Roblox\'s Analytics API', upload: 'Imported by you', benchmark: 'Comparison group, not a prediction', calc: 'Calculated from other metrics', forecast: 'Estimated by LaunchPad; may be wrong', demo: 'Generated for this demonstration; not a real game' }[kind] || '')}">${KIND[kind] || kind}${extra}</span>`;
AX.info = text => `<span class="ax-info" tabindex="0" role="note" aria-label="${esc(text)}">${icon('info', 14)}<span role="tooltip">${esc(text)}</span></span>`;
// Counts a number up to its value in ~1s (lands exactly on the value).
AX.countTo = (el, v, unit) => {
  if (v == null || !isFinite(v) || !motion()) return void (el.textContent = AX.fmt(unit, v));
  const t0 = performance.now(), tick = t => { const k = Math.min(1, (t - t0) / DRAW_MS), e = 1 - Math.pow(1 - k, 3); el.textContent = AX.fmt(unit, v * e); if (k < 1) requestAnimationFrame(tick); else el.textContent = AX.fmt(unit, v); };
  requestAnimationFrame(tick); setTimeout(() => { el.textContent = AX.fmt(unit, v); }, DRAW_MS + 200);
};

/* ---------- chart engine ---------- */
// spec: { type: line|area|bar|stacked|hist|funnel|heat|table, series: [{ id, name, unit, kind, points: [[x, y, status?]], band?: [[x, lo, hi]], dash?, color? }],
//         x: 'time'|'cat', cats?, h, annotations?: [{ t, label }], onZoom?, onSelect?, heat?, funnel?, table?, empty? }
const PAL = ['var(--ax1)', 'var(--ax2)', 'var(--ax3)', 'var(--ax4)', 'var(--ax5)', 'var(--ax6)'];
AX.PAL = PAL;
function ticks(min, max, n = 4) {
  if (!(max > min)) { max = min + (Math.abs(min) || 1); }
  const raw = (max - min) / n, p = 10 ** Math.floor(Math.log10(raw)), k = raw / p, step = (k <= 1 ? 1 : k <= 2 ? 2 : k <= 2.5 ? 2.5 : k <= 5 ? 5 : 10) * p;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, out = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) out.push(+v.toFixed(10));
  return { lo, hi, ticks: out };
}
const sig = s => { const p = s.points || []; return [s.type, p.length, p[0]?.[0], p[p.length - 1]?.[0], p.reduce((a, q) => a + (q[1] ?? 0), 0).toFixed(6), (s.band || []).length].join(':'); };
AX.chart = (host, spec) => {
  const st = host._ax || (host._ax = { prev: new Map(), hidden: new Set(), domain: null, w: 0 });
  st.spec = spec;
  if (!st.ro && 'ResizeObserver' in window) { st.ro = new ResizeObserver(() => { if (host.isConnected && Math.abs(host.clientWidth - st.w) > 4) draw(host, false); }); st.ro.observe(host); }
  draw(host, true);
};
function draw(host, animate) {
  const st = host._ax, spec = st.spec; st.w = host.clientWidth;
  if (spec.empty) { host.innerHTML = `<div class="ax-empty">${spec.empty}</div>`; return; }
  const fn = { heat: heat, funnel: funnel, table: table }[spec.type] || xy;
  fn(host, st, spec, animate && motion());
}
function legendHTML(st, spec) {
  if (spec.legend === false || spec.series.length < 2 && !spec.series.some(s => s.kind && s.kind !== 'roblox')) return st.domain ? '<div class="ax-legend"><button class="ax-reset" data-ax-reset>Reset zoom</button></div>' : '';
  return `<div class="ax-legend" role="group" aria-label="Series">${spec.series.map((s, i) => `<button type="button" data-ax-series="${esc(s.id)}" aria-pressed="${!st.hidden.has(s.id)}"><i class="ax-sw ${s.dash ? 'dash' : ''} ${s.kind === 'forecast' ? 'fc' : ''}" style="--c:${s.color || PAL[i % PAL.length]}"></i>${esc(s.name)}${s.kind && s.kind !== 'roblox' && s.kind !== 'demo' ? ` <small>${KIND[s.kind] || ''}</small>` : ''}</button>`).join('')}${st.domain ? '<button class="ax-reset" data-ax-reset>Reset zoom</button>' : ''}</div>`;
}
function bindLegend(host, st) {
  host.querySelectorAll('[data-ax-series]').forEach(b => b.onclick = () => { const id = b.dataset.axSeries; st.hidden.has(id) ? st.hidden.delete(id) : (st.hidden.add(id), st.prev.delete(id)); draw(host, true); });
  const r = host.querySelector('[data-ax-reset]'); if (r) r.onclick = () => { st.domain = null; st.spec.onZoom?.(null); draw(host, false); };
}
// Animates only series whose data changed (or that just appeared). Everything else is drawn in place.
function animateSeries(svg, st, spec, animate) {
  const seen = new Set();
  spec.series.forEach(s => {
    const id = s.id, sg = sig(s); seen.add(id);
    if (animate && st.prev.get(id) !== sg && !st.hidden.has(id)) {
      svg.querySelectorAll(`[data-s="${CSS.escape(id)}"]`).forEach(el => {
        const k = el.dataset.a;
        if (k === 'draw') el.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: DRAW_MS, easing: EASE });
        else if (k === 'bar') el.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: DRAW_MS, easing: EASE, delay: Math.min(300, (+el.dataset.i || 0) * 12), fill: 'backwards' });
        else if (k === 'barx') el.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: DRAW_MS, easing: EASE, delay: (+el.dataset.i || 0) * 60, fill: 'backwards' });
        else el.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)' }], { duration: DRAW_MS, easing: EASE });
      });
    }
    if (!st.hidden.has(id)) st.prev.set(id, sg);
  });
  for (const k of [...st.prev.keys()]) if (!seen.has(k)) st.prev.delete(k);
}
function xy(host, st, spec, animate) {
  const cat = spec.x === 'cat', all = spec.series, vis = all.filter(s => !st.hidden.has(s.id));
  const W = Math.max(260, host.clientWidth || 600), H = spec.h || { 1: 160, 2: 250, 3: 380 }[(host.className.match(/ax-h(d)/) || [])[1]] || 240;
  const units = [...new Set(vis.map(s => s.unit))].slice(0, 2), ax = s => Math.max(0, units.indexOf(s.unit));
  const P = { l: 50, r: units.length > 1 ? 50 : 14, t: 12, b: 26 }, iw = W - P.l - P.r, ih = H - P.t - P.b;
  let xs = [...new Set(vis.flatMap(s => [...s.points.map(p => p[0]), ...(s.band || []).map(b => b[0])]))].sort((a, b) => a - b);
  if (cat) xs = (spec.cats || []).map((_, i) => i);
  const [x0, x1] = st.domain || [xs[0] ?? 0, xs[xs.length - 1] ?? 1], inX = x => x >= x0 && x <= x1;
  const stacked = spec.type === 'stacked', bars = spec.type === 'bar' || stacked || spec.type === 'hist';
  const bw = bars ? Math.max(2, Math.min(40, iw / Math.max(1, xs.filter(inX).length) * 0.72)) : 0;
  const X = v => P.l + bw / 2 + (x1 === x0 ? (iw - bw) / 2 : (v - x0) / (x1 - x0) * (iw - bw));
  // y scale per axis (stacked bars use per-x sums).
  const sc = units.map((u, i) => {
    const ss = vis.filter(s => ax(s) === i); let vals = ss.flatMap(s => [...s.points.filter(p => inX(p[0])).map(p => p[1]), ...(s.band || []).filter(b => inX(b[0])).flatMap(b => [b[1], b[2]])]).filter(v => v != null && isFinite(v));
    if (stacked) { const sum = new Map(); ss.forEach(s => s.points.forEach(p => inX(p[0]) && sum.set(p[0], (sum.get(p[0]) || 0) + (p[1] || 0)))); vals = [...sum.values()]; }
    const mn = Math.min(0, ...vals), mx = Math.max(...vals, u === 'ratio' ? 0.01 : 1), t = ticks(spec.zeroBase === false ? Math.min(...vals) : mn, mx);
    return { u, ...t, Y: v => P.t + ih - (v - t.lo) / (t.hi - t.lo || 1) * ih };
  });
  if (!sc.length) { host.innerHTML = legendHTML(st, spec) + '<div class="ax-empty">All series are hidden.</div>'; bindLegend(host, st); return; }
  let g = '';
  sc[0].ticks.forEach(v => { const y = sc[0].Y(v); g += `<line class="ax-gl${v === 0 ? ' zero' : ''}" x1="${P.l}" x2="${W - P.r}" y1="${y}" y2="${y}"/><text class="ax-tick" x="${P.l - 8}" y="${y + 3.5}" text-anchor="end">${esc(AX.fmt(sc[0].u, v, true))}</text>`; });
  if (sc[1]) sc[1].ticks.forEach(v => { g += `<text class="ax-tick" x="${W - P.r + 8}" y="${sc[1].Y(v) + 3.5}">${esc(AX.fmt(sc[1].u, v, true))}</text>`; });
  const span = x1 - x0, xt = cat ? xs.filter((_, i) => i % Math.max(1, Math.ceil(xs.length * 64 / Math.max(1, iw))) === 0) : (() => { const n = Math.max(2, Math.floor(iw / 90)), step = Math.max(1, Math.ceil(xs.filter(inX).length / n)); return xs.filter(inX).filter((_, i) => i % step === 0); })();
  xt.forEach(v => { g += `<text class="ax-tick" x="${X(v)}" y="${H - 8}" text-anchor="middle">${esc(cat ? String(spec.cats[v]).slice(0, 14) : fmtX(v, span))}</text>`; });
  (spec.annotations || []).filter(a => !cat && inX(a.t)).forEach(a => { const x = X(a.t); g += `<g class="ax-ann"><line x1="${x}" x2="${x}" y1="${P.t}" y2="${P.t + ih}"/><text x="${x + 4}" y="${P.t + 9}">${esc(String(a.label).slice(0, 18))}</text><title>${esc(a.label)} · ${AX.fmtDay(a.t)}</title></g>`; });
  // forecast boundary
  const fc = vis.find(s => s.kind === 'forecast' && s.points.length);
  if (fc && inX(fc.points[0][0])) { const x = X(fc.points[0][0]); g += `<line class="ax-fcline" x1="${x}" x2="${x}" y1="${P.t}" y2="${P.t + ih}"/><text class="ax-fctag" x="${x + 5}" y="${P.t + ih - 6}">Forecast</text>`; }
  const stackBase = new Map(), nb = bars && !stacked ? vis.filter(s => s.kind !== 'forecast' && !s.line).length || 1 : 1;
  let barIdx = 0;
  all.forEach((s, si) => {
    if (st.hidden.has(s.id)) return;
    const c = s.color || PAL[si % PAL.length], Y = sc[ax(s)].Y, pts = s.points.filter(p => inX(p[0]) && p[1] != null && isFinite(p[1])), sid = esc(s.id);
    if (s.band?.length) { const b = s.band.filter(q => inX(q[0])); if (b.length > 1) g += `<path class="ax-band" data-s="${sid}" data-a="clip" style="fill:${c}" d="M${b.map(q => `${X(q[0]).toFixed(1)} ${Y(q[2]).toFixed(1)}`).join('L')}L${b.slice().reverse().map(q => `${X(q[0]).toFixed(1)} ${Y(q[1]).toFixed(1)}`).join('L')}Z"/>`; }
    if (bars && s.kind !== 'forecast' && !s.line) {
      const j = barIdx++, w = stacked ? bw : bw / nb;
      pts.forEach((p, i) => {
        const base = stacked ? stackBase.get(p[0]) || 0 : 0, top = base + p[1]; if (stacked) stackBase.set(p[0], top);
        const yA = Y(Math.max(base, top)), yB = Y(Math.min(base, top)), x = X(p[0]) - bw / 2 + (stacked ? 0 : j * w);
        g += `<rect class="ax-rect${s.kind === 'benchmark' ? ' bm' : ''}" data-s="${sid}" data-a="bar" data-i="${i}" x="${x.toFixed(1)}" y="${yA.toFixed(1)}" width="${Math.max(1, w - (stacked ? 1 : 2)).toFixed(1)}" height="${Math.max(0.5, yB - yA).toFixed(1)}" rx="2" style="fill:${c}"/>`;
      });
      return;
    }
    if (pts.length > 1) {
      const d = 'M' + pts.map(p => `${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join('L');
      if (spec.type === 'area' && !s.dash && s.kind !== 'forecast') g += `<path class="ax-area" data-s="${sid}" data-a="clip" style="fill:${c}" d="${d}L${X(pts[pts.length - 1][0]).toFixed(1)} ${Y(Math.max(0, sc[ax(s)].lo))}L${X(pts[0][0]).toFixed(1)} ${Y(Math.max(0, sc[ax(s)].lo))}Z"/>`;
      const dashed = s.dash || s.kind === 'forecast' || s.kind === 'benchmark';
      g += `<path class="ax-line ${s.kind ? 'k-' + s.kind : ''}" data-s="${sid}" data-a="${dashed ? 'clip' : 'draw'}" ${dashed ? '' : 'pathLength="1"'} style="stroke:${c}" d="${d}"/>`;
    }
    if (pts.length <= 20 || pts.length === 1) pts.forEach(p => { g += `<circle class="ax-pt${p[2] === 'Projected' ? ' proj' : ''}" data-s="${sid}" data-a="clip" cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="${pts.length > 20 ? 2.2 : 3}" style="stroke:${c}"/>`; });
  });
  host.innerHTML = `${legendHTML(st, spec)}<div class="ax-plot"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.title || 'Chart')}">${g}<line class="ax-cross" y1="${P.t}" y2="${P.t + ih}" x1="-9" x2="-9"/><rect class="ax-brush" y="${P.t}" height="${ih}" x="0" width="0"/><rect class="ax-hit" x="${P.l}" y="${P.t}" width="${iw}" height="${ih}"/></svg><div class="ax-tip" role="status" aria-live="off"></div></div>`;
  bindLegend(host, st);
  const svg = host.querySelector('svg'); animateSeries(svg, st, spec, animate);
  // Hover: one tooltip for every visible series at the nearest x; drag to zoom; double-click resets.
  const tip = host.querySelector('.ax-tip'), cross = svg.querySelector('.ax-cross'), brush = svg.querySelector('.ax-brush'), hit = svg.querySelector('.ax-hit');
  const vx = xs.filter(inX), maps = vis.map(s => ({ s, m: new Map(s.points.map(p => [p[0], p])), b: new Map((s.band || []).map(b => [b[0], b])) }));
  const toData = px => x0 + (px - P.l - bw / 2) / Math.max(1, iw - bw) * (x1 - x0);
  const nearest = px => { const v = toData(px); let best = vx[0], bd = Infinity; for (const x of vx) { const d = Math.abs(x - v); if (d < bd) { bd = d; best = x; } } return best; };
  let raf = 0, drag = null;
  const show = e => {
    const r = svg.getBoundingClientRect(), px = e.clientX - r.left, x = nearest(px); if (x == null) return;
    cross.setAttribute('x1', X(x)); cross.setAttribute('x2', X(x));
    const rows = maps.map(({ s, m, b }, i) => { const p = m.get(x), q = b.get(x); if (!p && !q) return '';
      const c = s.color || PAL[spec.series.indexOf(s) % PAL.length];
      return `<div><i style="background:${c}"></i><span>${esc(s.name)}</span><b>${esc(AX.fmt(s.unit, p?.[1]))}</b>${q ? `<small>${esc(AX.fmt(s.unit, q[1]))}–${esc(AX.fmt(s.unit, q[2]))}</small>` : ''}${p?.[2] === 'Projected' ? '<small>projected</small>' : ''}${p?.[3] != null ? `<small>n=${esc(AX.fmt('count', p[3]))}</small>` : ''}</div>`; }).join('');
    if (!rows) { tip.classList.remove('on'); return; }
    tip.innerHTML = `<p>${esc(cat ? spec.cats[x] : AX.fmtDay(x))}</p>${rows}`; tip.classList.add('on');
    const tw = tip.offsetWidth; tip.style.transform = `translate(${Math.min(W - tw - 4, Math.max(4, X(x) + (X(x) > W / 2 ? -tw - 12 : 12)))}px, ${P.t + 4}px)`;
  };
  hit.onpointermove = e => {
    if (drag) { const r = svg.getBoundingClientRect(), px = Math.min(P.l + iw, Math.max(P.l, e.clientX - r.left)); brush.setAttribute('x', Math.min(drag, px)); brush.setAttribute('width', Math.abs(px - drag)); }
    if (raf) return; raf = requestAnimationFrame(() => { raf = 0; show(e); });
  };
  hit.onpointerleave = () => { tip.classList.remove('on'); cross.setAttribute('x1', -9); cross.setAttribute('x2', -9); };
  if (!cat && vx.length > 3) {
    hit.onpointerdown = e => { if (e.button !== 0 || e.pointerType === 'touch') return; drag = e.clientX - svg.getBoundingClientRect().left; hit.setPointerCapture(e.pointerId); };
    hit.onpointerup = e => {
      if (drag == null) return; const r = svg.getBoundingClientRect(), px = e.clientX - r.left, a = Math.min(drag, px), b = Math.max(drag, px); drag = null; brush.setAttribute('width', 0);
      if (b - a > 12) { const d = [toData(a), toData(b)]; if (vx.filter(x => x >= d[0] && x <= d[1]).length >= 2) { st.domain = d; spec.onZoom?.(d); draw(host, false); } }
      else if (spec.onSelect) spec.onSelect(nearest(px));
    };
    hit.ondblclick = () => { if (st.domain) { st.domain = null; spec.onZoom?.(null); draw(host, false); } };
  }
}
// Cohort heatmap: rows = cohorts, columns = days/weeks since first play. Immature cells are hatched, never shown as 0.
function heat(host, st, spec, animate) {
  const { rows, cols, cell, fmtRow } = spec.heat, W = Math.max(300, host.clientWidth || 600), lw = 86, sw = 58, cw = Math.max(18, (W - lw - sw - 8) / Math.max(1, cols.length)), ch = 22, H = 26 + rows.length * ch;
  const vals = rows.flatMap((r, i) => cols.map((c, j) => cell(i, j)?.v)).filter(v => v != null), mx = Math.max(...vals, 0.0001);
  let g = `<defs><pattern id="axHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="ax-hatch"/></pattern></defs>`;
  g += `<text class="ax-tick" x="${lw - 8}" y="14" text-anchor="end">Cohort</text><text class="ax-tick" x="${lw + sw - 8}" y="14" text-anchor="end">Size</text>`;
  cols.forEach((c, j) => { g += `<text class="ax-tick" x="${lw + sw + j * cw + cw / 2}" y="14" text-anchor="middle">${esc(c.label)}</text>`; });
  rows.forEach((r, i) => {
    const y = 22 + i * ch;
    g += `<text class="ax-tick" x="${lw - 8}" y="${y + 15}" text-anchor="end">${esc(fmtRow(r))}</text><text class="ax-tick" x="${lw + sw - 8}" y="${y + 15}" text-anchor="end">${r.size != null ? esc(AX.fmt('count', r.size)) : '—'}</text>`;
    cols.forEach((c, j) => {
      const v = cell(i, j), x = lw + sw + j * cw, k = i + j;
      if (!v || v.state === 'immature') g += `<rect class="ax-cell na" data-s="heat" data-a="cell" data-i="${k}" data-r="${i}" data-c="${j}" x="${x + 1}" y="${y + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" style="fill:${v ? 'url(#axHatch)' : 'transparent'}"/>`;
      else { const o = 0.08 + 0.86 * (v.v / mx); g += `<rect class="ax-cell" data-s="heat" data-a="cell" data-i="${k}" data-r="${i}" data-c="${j}" x="${x + 1}" y="${y + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" style="fill-opacity:${o.toFixed(3)}"/>${cw >= 34 ? `<text class="ax-celltxt${o > 0.5 ? ' inv' : ''}" x="${x + cw / 2}" y="${y + 15}" text-anchor="middle">${esc(AX.fmt('ratio', v.v, true))}</text>` : ''}`; }
    });
  });
  host.innerHTML = `<div class="ax-plot"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.title || 'Cohort retention heatmap')}">${g}</svg><div class="ax-tip"></div></div>`;
  const svg = host.querySelector('svg'), tip = host.querySelector('.ax-tip');
  if (animate && st.prev.get('heat') !== JSON.stringify([rows.length, cols.length, vals.length])) svg.querySelectorAll('.ax-cell').forEach(el => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, delay: Math.min(600, (+el.dataset.i) * 18), easing: EASE, fill: 'backwards' }));
  st.prev.set('heat', JSON.stringify([rows.length, cols.length, vals.length]));
  svg.onpointermove = e => { const el = e.target.closest('.ax-cell'); if (!el) return tip.classList.remove('on');
    const i = +el.dataset.r, j = +el.dataset.c, r = rows[i], v = cell(i, j);
    tip.innerHTML = `<p>${esc(fmtRow(r))} · ${esc(cols[j].label)}</p>${!v ? '<div><span>No data</span></div>' : v.state === 'immature' ? '<div><span>Not mature yet</span></div>' : `<div><span>Retention</span><b>${AX.fmt('ratio', v.v)}</b></div>${r.size != null ? `<div><span>Cohort size</span><b>${AX.fmt('count', r.size)}</b></div><div><span>Retained</span><b>${AX.fmt('count', r.size * v.v)}</b><small>calculated</small></div>` : ''}`}`;
    tip.classList.add('on'); const bx = el.getBBox(); tip.style.transform = `translate(${Math.min(W - tip.offsetWidth - 4, bx.x + bx.width + 6)}px, ${Math.max(0, bx.y - 6)}px)`; };
  svg.onpointerleave = () => tip.classList.remove('on');
  svg.onclick = e => { const el = e.target.closest('.ax-cell'); if (el && spec.onSelect) spec.onSelect({ row: rows[+el.dataset.r], col: cols[+el.dataset.c] }); };
}
// Funnel: each stage's width relative to the first; the step conversion is shown between stages.
function funnel(host, st, spec, animate) {
  const s = spec.funnel.filter(x => x.v != null), top = s[0]?.v || 1;
  host.innerHTML = `<ol class="ax-funnel">${s.map((x, i) => `<li><div class="ax-fl"><span>${esc(x.label)}</span><b>${esc(AX.fmt(x.unit || 'count', x.v))}</b></div><div class="ax-fbar"><i data-s="funnel" data-a="barx" data-i="${i}" style="width:${Math.max(0.5, x.v / top * 100).toFixed(2)}%"></i></div>${i ? `<small>${AX.fmt('ratio', s[i - 1].v ? x.v / s[i - 1].v : null)} of previous · ${AX.fmt('ratio', x.v / top)} of first</small>` : ''}</li>`).join('')}</ol>`;
  if (animate && st.prev.get('funnel') !== JSON.stringify(s.map(x => x.v))) host.querySelectorAll('[data-a="barx"]').forEach(el => el.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: DRAW_MS, easing: EASE, delay: (+el.dataset.i) * 70, fill: 'backwards' }));
  st.prev.set('funnel', JSON.stringify(s.map(x => x.v)));
}
// Table with pagination (50 rows per page).
function table(host, st, spec) {
  const { cols, rows } = spec.table, page = st.page || 0, per = 50, pages = Math.max(1, Math.ceil(rows.length / per)), part = rows.slice(page * per, page * per + per);
  host.innerHTML = `<div class="table-wrap ax-table"><table><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${part.map(r => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="muted">No rows.</td></tr>`}</tbody></table></div>
    ${pages > 1 ? `<div class="ax-pager"><button class="btn ghost sm" data-pg="-1" ${page ? '' : 'disabled'}>Previous</button><span class="small muted">${page + 1} / ${pages}</span><button class="btn ghost sm" data-pg="1" ${page + 1 < pages ? '' : 'disabled'}>Next</button></div>` : ''}`;
  host.querySelectorAll('[data-pg]').forEach(b => b.onclick = () => { st.page = Math.min(pages - 1, Math.max(0, page + +b.dataset.pg)); table(host, st, spec); });
}

/* ---------- exports ---------- */
AX.toRows = spec => {
  if (spec.type === 'table') return [spec.table.cols, ...spec.table.rows];
  if (spec.type === 'funnel') return [['Stage', 'Value'], ...spec.funnel.map(x => [x.label, x.v])];
  if (spec.type === 'heat') { const { rows, cols, cell, fmtRow } = spec.heat; return [['Cohort', 'Size', ...cols.map(c => c.label)], ...rows.map((r, i) => [fmtRow(r), r.size ?? '', ...cols.map((c, j) => { const v = cell(i, j); return v && v.state !== 'immature' ? v.v : ''; })])]; }
  const xs = [...new Set(spec.series.flatMap(s => s.points.map(p => p[0])))].sort((a, b) => a - b), cat = spec.x === 'cat';
  const head = [cat ? 'Category' : 'Date', ...spec.series.flatMap(s => s.band ? [`${s.name} (${KIND[s.kind] || 'value'})`, `${s.name} low`, `${s.name} high`] : [`${s.name} (${KIND[s.kind] || 'value'}, ${AX.unitLabel(s.unit)})`])];
  const rows = xs.map(x => [cat ? spec.cats[x] : new Date(x).toISOString().slice(0, 10), ...spec.series.flatMap(s => { const p = s.points.find(q => q[0] === x), b = s.band?.find(q => q[0] === x); const val = v => v == null ? '' : s.unit === 'ratio' ? +(v * 100).toFixed(3) : +v.toFixed(4); return s.band ? [val(p?.[1]), val(b?.[1]), val(b?.[2])] : [val(p?.[1])]; })]);
  return [head, ...rows];
};
AX.csv = (name, spec) => {
  const q = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const text = AX.toRows(spec).map(r => r.map(q).join(',')).join('\n'), a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name.replace(/[^\w-]+/g, '-').toLowerCase() + '.csv'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
};
// PNG: inline the computed colours (CSS variables don't survive outside the page), rasterise at 2x.
AX.png = async (name, host, title) => {
  const svg = host.querySelector('svg'); if (!svg) return toast('This view has no image to export.', 'warn');
  const clone = svg.cloneNode(true), src = [...svg.querySelectorAll('*')], dst = [...clone.querySelectorAll('*')];
  src.forEach((el, i) => { const cs = getComputedStyle(el); ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'fill-opacity', 'font-size', 'font-family', 'font-weight'].forEach(p => dst[i].style.setProperty(p, cs.getPropertyValue(p))); });
  const W = +svg.getAttribute('width'), H = +svg.getAttribute('height'), pad = 40, img = new Image(), c = document.createElement('canvas'), x = c.getContext('2d');
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(clone.outerHTML); await img.decode();
  c.width = (W + 32) * 2; c.height = (H + pad + 16) * 2; x.scale(2, 2);
  const bg = getComputedStyle(document.body).backgroundColor, fg = getComputedStyle(document.body).color;
  x.fillStyle = getComputedStyle(host.closest('.card') || document.body).backgroundColor || bg; x.fillRect(0, 0, W + 32, H + pad + 16);
  x.fillStyle = fg; x.font = '600 15px Inter, system-ui, sans-serif'; x.fillText(title || name, 16, 26); x.drawImage(img, 16, pad);
  const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = name.replace(/[^\w-]+/g, '-').toLowerCase() + '.png'; a.click();
};
AX.DAY = DAY; AX.today = today; AX.motion = motion; AX.EASE = EASE; AX.ticks = ticks;
})();
(() => {
const AX = window.AX, DAY = AX.DAY;

/* ---------- context: games, annotations ---------- */
AX.DEMO_GAME = { id: 'ax_demo', name: 'Sample Experience', demoAnalytics: true };
AX.games = () => AX.demo ? [AX.DEMO_GAME] : S().games.filter(g => !g.sample);
AX.game = id => AX.games().find(g => g.id === id) || null;
AX.currentGame = () => { const p = S().prefs.axGame; if (p === 'portfolio') return null; return AX.game(p) || AX.game(S().selectedGameId) || AX.games()[0] || null; };
// Markers on time charts: your logged updates, Studio scans and generated reports (dates only; they don't imply cause).
AX.annotations = g => {
  if (!g) return [];
  if (g.demoAnalytics) return [{ t: AX.today() - 40 * DAY, label: 'Update: new world' }];
  const out = (Array.isArray(g.updates) ? g.updates : []).map(u => ({ t: Math.floor(Date.parse(u.at) / DAY) * DAY, label: u.label || 'Update', kind: 'update' }));
  if (g.studio?.lastScan) out.push({ t: Math.floor(g.studio.lastScan / DAY) * DAY, label: 'Studio scan', kind: 'scan' });
  S().reports.filter(r => r.gameId === g.id).forEach(r => out.push({ t: Math.floor(r.createdAt / DAY) * DAY, label: `${OPT[r.optimizer]?.name || 'Report'} report`, kind: 'report' }));
  return out.filter(a => isFinite(a.t));
};

/* ---------- aggregation ---------- */
const bucket = (t, gran) => { const d = new Date(t); if (gran === 'OneMonth') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); const dow = (d.getUTCDay() + 6) % 7; return t - dow * DAY; };
// Client-side roll-up when Roblox doesn't provide the granularity: sums only for summable metrics, else the mean of daily values.
// Unique-user counts (active users) are never summed, because people who play on several days would be counted repeatedly.
AX.rollup = (points, gran, def) => {
  if (gran === 'OneDay') return { points, note: null };
  if (def.unit === 'count' && !def.summable) return { points: null, note: `${def.label} can't be added up across days. Use Roblox's weekly or monthly values (synced automatically) instead.` };
  const m = new Map(); points.forEach(p => { const k = bucket(p[0], gran), e = m.get(k) || []; e.push(p[1]); m.set(k, e); });
  return { points: [...m].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, def.summable ? v.reduce((a, b) => a + b, 0) : v.reduce((a, b) => a + b, 0) / v.length]),
    note: def.summable ? 'Weekly and monthly values are sums of daily values.' : 'Weekly and monthly values are means of daily values (not weighted by players).' };
};

/* ---------- formulas ---------- */
// Grammar: series letters (A, B, …), numbers, + − × ÷ and parentheses. No functions, no names, nothing evaluated as code.
AX.parseFormula = (src, letters) => {
  const toks = String(src).replace(/\s+/g, '').match(/[A-L]|\d+(?:\.\d+)?|[-+*/()]/g) || [];
  if (toks.join('') !== String(src).replace(/\s+/g, '') || !toks.length) throw new Error('Use series letters, numbers, + − * / and parentheses only.');
  const out = [], ops = [], prec = { '+': 1, '-': 1, '*': 2, '/': 2 }; let prev = 'op';
  for (const t of toks) {
    if (/^[A-L]$/.test(t)) { if (!letters.includes(t)) throw new Error(`Series ${t} isn't in this chart.`); if (prev === 'val') throw new Error('Missing an operator.'); out.push({ ref: t }); prev = 'val'; }
    else if (/^\d/.test(t)) { if (prev === 'val') throw new Error('Missing an operator.'); out.push({ num: +t }); prev = 'val'; }
    else if (t === '(') { if (prev === 'val') throw new Error('Missing an operator before "(".'); ops.push(t); prev = 'op'; }
    else if (t === ')') { if (prev !== 'val') throw new Error('Unexpected ")".'); while (ops.length && ops[ops.length - 1] !== '(') out.push({ op: ops.pop() }); if (!ops.length) throw new Error('Unbalanced parentheses.'); ops.pop(); prev = 'val'; }
    else { if (prev !== 'val') throw new Error(`"${t}" needs a value before it.`); while (ops.length && ops[ops.length - 1] !== '(' && prec[ops[ops.length - 1]] >= prec[t]) out.push({ op: ops.pop() }); ops.push(t); prev = 'op'; }
  }
  if (prev !== 'val') throw new Error('The formula ends with an operator.');
  while (ops.length) { const o = ops.pop(); if (o === '(') throw new Error('Unbalanced parentheses.'); out.push({ op: o }); }
  return out;
};
// Unit algebra: + and − need matching units; × or ÷ by a constant keeps the unit; anything else is a plain number (choose % to show a share).
AX.formulaUnit = (rpn, unitOf) => {
  const st = [];
  for (const t of rpn) {
    if (t.ref) st.push({ u: unitOf(t.ref) }); else if ('num' in t) st.push({ u: null });
    else { const b = st.pop(), a = st.pop();
      if (t.op === '+' || t.op === '-') { if (a.u && b.u && a.u !== b.u) throw new Error(`Can't add or subtract ${AX.unitLabel(a.u)} and ${AX.unitLabel(b.u)}.`); st.push({ u: a.u || b.u }); }
      else if (t.op === '*') st.push({ u: a.u && b.u ? 'number' : a.u || b.u });
      else st.push({ u: !b.u ? a.u : a.u ? 'number' : null }); }
  }
  return st[0].u || 'number';
};
AX.evalFormula = (rpn, byLetter) => {
  const xs = [...new Set(Object.values(byLetter).flatMap(s => s.points.map(p => p[0])))].sort((a, b) => a - b), maps = Object.fromEntries(Object.entries(byLetter).map(([k, s]) => [k, new Map(s.points.map(p => [p[0], p[1]]))]));
  let divZero = 0, missing = 0;
  const points = xs.map(x => {
    const st = [];
    for (const t of rpn) {
      if (t.ref) st.push(maps[t.ref].get(x) ?? null); else if ('num' in t) st.push(t.num);
      else { const b = st.pop(), a = st.pop(); if (a == null || b == null) { st.push(null); continue; }
        if (t.op === '/' && b === 0) { divZero++; st.push(null); continue; }
        st.push(t.op === '+' ? a + b : t.op === '-' ? a - b : t.op === '*' ? a * b : a / b); }
    }
    if (st[0] == null) missing++;
    return [x, st[0]];
  }).filter(p => p[1] != null && isFinite(p[1]));
  return { points, divZero, missing };
};

/* ---------- config → chart ---------- */
// Chart config (saved per user): { type, title, series: [{ metric, game?, breakdown?, source?, name?, formula?, unit? }], gran, range?,
//   compare: none|previous|year, benchmark, forecast, scale: auto|index, split: ''|dimension }
AX.TYPES = { line: 'Line', area: 'Area', bar: 'Bar', stacked: 'Stacked bar', table: 'Table', heat: 'Cohort heatmap', funnel: 'Funnel', hist: 'Distribution' };
AX.validTypes = cfg => {
  const defs = cfg.series.filter(s => s.metric).map(s => AX.def(s.metric));
  if (defs.some(d => d.group === 'cohort')) return ['heat', 'table'];
  if (defs.length > 1 && defs.every(d => d.group === 'acquisition')) return ['funnel', 'line', 'bar', 'table'];
  if (cfg.series.some(s => s.metric === 'TotalSessionsEndedInBucket')) return ['hist', 'bar', 'table'];
  return ['line', 'area', 'bar', 'stacked', 'table'];
};
const fcCache = new Map();
async function forecastFor(game, metric, breakdown) {
  const k = [game, metric, breakdown].join('|'), hit = fcCache.get(k);
  if (hit && Date.now() - hit.at < 600e3) return hit.p;
  const p = AX.demo ? Promise.resolve(AX.demoForecast(metric, breakdown)) : api('POST', '/api/metrics/forecast', { game, metric, breakdown, horizon: 30 });
  fcCache.set(k, { at: Date.now(), p }); p.catch(() => fcCache.delete(k)); return p;
}
AX.forecastFor = forecastFor;
AX.resolve = async (cfg, ctx) => {
  const notes = [], kinds = new Set(), range = cfg.range?.preset ? AX.range(cfg.range.preset, cfg.range) : ctx.range, gameOf = s => s.game || ctx.game?.id;
  const base = cfg.series.filter(s => s.metric && !s.formula), games = [...new Set(base.map(gameOf).filter(Boolean))];
  if (!games.length) return { empty: 'Choose a game first.', notes, kinds };
  const metrics = [...new Set(base.map(s => s.metric))], gran = cfg.gran || 'OneDay';
  const native = gran !== 'OneDay' && metrics.every(m => AX.def(m).grans.includes(gran));
  const isNone = cfg.type === 'funnel' || cfg.type === 'hist' || metrics.every(m => AX.def(m).grans[0] === 'None');
  const qgran = isNone ? 'None' : native ? gran : 'OneDay', bd = cfg.split || (base.some(s => s.breakdown) ? [...new Set(base.filter(s => s.breakdown).map(s => s.breakdown.split('=')[0]))].join(',') : '');
  const wantAll = AX.validTypes(cfg).includes('heat') || cfg.type === 'hist' || metrics.some(m => ['FunnelUserTotalCount', 'FunnelUserStepCompletionRate', 'CustomEventAvgValue', 'CustomEventCountUser', 'EconomyTransactionAmount', 'EconomyAverageWalletBalance', 'ProgressionPlayers', 'ProgressionMinutesToStage', 'MilestoneCompletionRate', 'UpgradePurchases', 'CurrencyEarned', 'CurrencySpent', 'CurrencyBalance'].includes(m));
  const q = { games, metrics, gran: qgran, from: range.from, to: range.to, breakdown: wantAll ? '*' : bd.includes(',') ? '*' : bd };
  let data; try { data = await AX.query(q); } catch (e) { return { empty: esc(e.message), notes, kinds, error: e }; }
  if (data.limitedByPlan) notes.push('Older data is outside your plan\'s history window.');
  let prev = null;
  if (cfg.compare && cfg.compare !== 'none' && !isNone) { const off = cfg.compare === 'year' ? 364 * DAY : range.to - range.from; prev = { off, data: await AX.query({ ...q, from: range.from - off, to: range.to - off }).catch(() => null) }; }
  const out = [], fresh = [];
  const push = (s, src, cfgS, i, label) => {
    const def = AX.def(src.metric); let pts = src.points;
    if (!native && qgran === 'OneDay' && gran !== 'OneDay') { const r = AX.rollup(pts, gran, def); if (!r.points) { notes.push(r.note); } else { pts = r.points; if (r.note) { notes.push(r.note); kinds.add('calc'); } } }
    const kind = src.source; kinds.add(kind); fresh.push(src.fetchedAt);
    out.push({ id: `${i}:${src.breakdown}:${src.game}`, name: label, unit: def.unit, kind, points: pts, letter: cfgS.letter, gran, metric: src.metric, game: src.game, breakdown: src.breakdown });
  };
  base.filter(s => s.metric !== 'CohortSize' || cfg.type !== 'heat').forEach((s, i) => {
    s.letter = String.fromCharCode(65 + i);
    const g = gameOf(s), def = AX.def(s.metric), gname = games.length > 1 ? `${AX.game(g)?.name || g} · ` : '';
    if (cfg.split || wantAll && !s.breakdown && cfg.type !== 'line') {
      const dim = cfg.split, list = data.series.filter(x => x.metric === s.metric && x.game === g && x.source !== 'benchmark' && (dim ? x.breakdown.startsWith(dim + '=') : x.breakdown));
      const srcPref = list.some(x => x.source === 'roblox') ? 'roblox' : list.some(x => x.source === 'demo') ? 'demo' : 'upload';
      list.filter(x => x.source === srcPref).forEach(x => push(s, x, s, i, x.breakdown.startsWith('IsNewUser=') && !x.breakdown.includes('|') ? `${gname}${x.breakdown.endsWith('true') ? 'New players' : 'Returning players'}`
        : `${gname}${base.length > 1 ? (s.name || def.label) + ' · ' : ''}${x.breakdown.split('|').map(p => p.split('=')[1]).join(' · ')}`));
      if (!list.length) notes.push(`No ${def.label.toLowerCase()} ${dim ? 'by ' + dim : 'breakdown'} in this range.`);
    } else {
      const src = AX.pick(data.series, s.metric, { game: g, breakdown: s.breakdown || '', source: s.source && s.source !== 'auto' ? s.source : undefined });
      if (src) push(s, src, s, i, `${gname}${s.name || def.label}${s.breakdown ? ' · ' + s.breakdown.split('=')[1] : ''}`);
      else notes.push(`No ${def.label.toLowerCase()}${s.breakdown ? ' for ' + s.breakdown.split('=')[1] : ''} in this range.`);
      if (prev?.data) { const p = AX.pick(prev.data.series, s.metric, { game: g, breakdown: s.breakdown || '' }); if (p) out.push({ id: `prev:${i}`, name: `${s.name || def.label} · ${cfg.compare === 'year' ? 'a year earlier' : 'previous period'}`, unit: def.unit, kind: p.source, dash: true, points: p.points.map(x => [x[0] + prev.off, x[1], x[2]]), compare: true }); }
      if (cfg.benchmark) { const b = AX.pick(data.series, s.metric, { game: g, breakdown: s.breakdown || '', source: 'benchmark' }); if (b) { kinds.add('benchmark'); out.push({ id: `bm:${i}`, name: `${def.label} benchmark`, unit: def.unit, kind: 'benchmark', points: b.points, color: 'var(--ax-bm)' }); } else notes.push(`No benchmark for ${def.label.toLowerCase()}. Roblox's API doesn't provide benchmarks; upload one under Data.`); }
    }
  });
  // Calculated series.
  cfg.series.filter(s => s.formula).forEach((s, j) => {
    try {
      const letters = out.filter(x => x.letter && !x.compare).reduce((m, x) => (m[x.letter] ||= x, m), {});
      const rpn = AX.parseFormula(s.formula, Object.keys(letters)), refs = [...new Set(rpn.filter(t => t.ref).map(t => t.ref))];
      if (new Set(refs.map(r => letters[r].gran)).size > 1) throw new Error('The series use different time intervals.');
      const unit = s.unit || AX.formulaUnit(rpn, r => letters[r].unit), r = AX.evalFormula(rpn, Object.fromEntries(refs.map(k => [k, letters[k]])));
      if (r.divZero) notes.push(`${s.name || s.formula}: ${r.divZero} point(s) skipped (division by zero).`);
      kinds.add('calc');
      out.push({ id: `f:${j}`, name: s.name || s.formula, unit, kind: 'calc', points: r.points, formula: `${s.formula} where ${refs.map(k => `${k} = ${letters[k].name}`).join(', ')}` });
    } catch (e) { notes.push(`Formula "${s.formula}": ${e.message}`); }
  });
  // Forecast overlay: only for single daily series of official/uploaded data.
  if (cfg.forecast && !isNone) {
    for (const s of out.filter(x => !x.compare && x.kind !== 'benchmark' && x.kind !== 'calc' && x.gran === 'OneDay').slice(0, 3)) {
      try { const f = await forecastFor(s.game, s.metric, s.breakdown);
        // Starts after the last observed point (including Roblox's own projected values) so estimate and data never overlap.
        if (f.ok) { const last = Math.max(...s.points.map(p => p[0])), fp = f.points.filter(p => Date.parse(p.t) > last);
          if (fp.length) { kinds.add('forecast'); out.push({ id: `fc:${s.id}`, name: `${s.name} forecast`, unit: s.unit, kind: 'forecast', points: fp.map(p => [Date.parse(p.t), p.mid]), band: fp.map(p => [Date.parse(p.t), p.lo, p.hi]), forecast: f, color: 'var(--ax-fc)' }); } }
        else notes.push(`${s.name}: ${f.reason}`);
      } catch (e) { notes.push(e.status === 403 ? 'Forecasts are part of Light and Max.' : `${s.name}: ${e.message}`); }
    }
  }
  // Indexed scale: every series relative to its first value (= 100), so different units can share one axis honestly.
  if (cfg.scale === 'index') out.forEach(s => { const b = s.points.find(p => p[1])?.[1]; if (!b) return; s.points = s.points.map(p => [p[0], p[1] / b * 100, p[2]]); if (s.band) s.band = s.band.map(p => [p[0], p[1] / b * 100, p[2] / b * 100]); s.unit = 'index'; });
  else { const units = [...new Set(out.map(s => s.unit))]; if (units.length > 2) { notes.push(`This chart mixes ${units.length} units. Showing the first two; switch to an indexed scale to compare them all.`); const keep = units.slice(0, 2); out.splice(0, out.length, ...out.filter(s => keep.includes(s.unit))); } }
  if (cfg.hideBase) out.splice(0, out.length, ...out.filter(s => s.kind === 'calc' || s.kind === 'forecast'));
  const latest = fresh.filter(Boolean).sort().pop();
  return { series: out, notes: [...new Set(notes)], kinds, fresh: latest, range, data, gran: qgran };
};

/* ---------- demonstration dataset (signed-out demo only, always labelled) ---------- */
const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return ((h >>> 0) % 100000) / 100000 - 0.5; };
const PLAT = [['Phone', 0.52], ['Computer', 0.3], ['Tablet', 0.1], ['Console', 0.08]], NEWR = [['true', 0.34], ['false', 0.66]];
const BUCKETS = [['0–1 min', 0.17], ['1–5 min', 0.24], ['5–15 min', 0.26], ['15–30 min', 0.17], ['30–60 min', 0.11], ['60+ min', 0.05]];
function demoValue(metric, t, k = '') {
  const d = (AX.today() - t) / DAY, wk = [1.16, 0.95, 0.93, 0.94, 0.97, 1.05, 1.18][new Date(t).getUTCDay()], upd = d < 40 ? 1 : 0, n = hash(metric + k + t);
  const dau = 4200 * (1 + (365 - d) / 900) * wk * (1 + upd * 0.07) * (1 + n * 0.06);
  switch (metric) {
    case 'DailyActiveUsers': return dau;
    case 'MonthlyActiveUsers': return dau * 9.6;
    case 'DauMauStickiness': return 0.104 * (1 + n * 0.05);
    case 'ForwardD1Retention': return (0.262 + upd * 0.024) * (1 + n * 0.08);
    case 'ForwardD7Retention': return (0.083 + upd * 0.009) * (1 + n * 0.1);
    case 'ForwardD30Retention': return (0.027 + upd * 0.003) * (1 + n * 0.12);
    case 'AveragePlayTimeMinutesPerDAU': return (31 + upd * 2.5) * (1 + n * 0.05) * (wk > 1.1 ? 1.08 : 1);
    case 'AverageSessionLengthMinutes': return (14.5 + upd * 1.1) * (1 + n * 0.05);
    case 'TotalPlayTimeHours': return dau * 31 / 60 * (1 + n * 0.04);
    case 'Visits': return dau * 2.15 * (1 + n * 0.04);
    case 'CohortSize': return dau * 0.34;
    case 'UniqueUsersWithImpressions': return dau * 21; case 'UniqueUsersWithClicks': return dau * 2.7; case 'UniqueUsersWithPlaySessions': return dau * 1.05; case 'QualifiedUniqueUsersWithPlaySessions': return dau * 0.64;
    case 'RFYD1Playtime': return 18.5 * (1 + n * 0.06); case 'RFYD2To7Playtime': return 24 * (1 + n * 0.07); case 'RFYD8To28Playtime': return 31 * (1 + n * 0.09);
    case 'EconomyTransactionAmount': return (k.includes('Source') ? 1 : 0.86 + d / 3000) * dau * 420 * (1 + n * 0.05);
    case 'EconomyAverageWalletBalance': return 5200 + (365 - d) * 14 + n * 200;
  }
  return null;
}
AX.demoQuery = o => {
  const series = [], fetchedAt = new Date(AX.today()).toISOString(), m = 'demo';
  const days = []; for (let t = Math.max(o.from, AX.today() - 365 * DAY); t < Math.min(o.to, AX.today()); t += DAY) days.push(t);
  const add = (metric, breakdown, points) => series.push({ game: AX.DEMO_GAME.id, metric, source: m, granularity: o.gran, breakdown, points, fetchedAt });
  const mat = { ForwardD1Retention: 1, ForwardD7Retention: 7, ForwardD30Retention: 30 };
  for (const metric of o.metrics) {
    if (o.gran === 'None' || metric === 'TotalSessionsEndedInBucket' || /^Funnel|^CustomEvent/.test(metric)) {
      const t0 = AX.today() - 28 * DAY, tot = days.slice(-28).reduce((a, t) => a + (demoValue('DailyActiveUsers', t) || 0), 0);
      if (metric === 'TotalSessionsEndedInBucket') BUCKETS.forEach(([b, sh]) => add(metric, `SessionTimeBucket=${b}`, [[t0, tot * 2.1 * sh]]));
      else if (metric === 'FunnelUserTotalCount') for (let s = 1; s <= 20; s++) add(metric, `FunnelName=Levels|FunnelStep=${s}`, [[t0, tot * 0.3 * Math.pow(0.9, s - 1) * (s >= 8 ? 0.72 : 1) * (s >= 15 ? 0.8 : 1)]]);
      else if (metric === 'FunnelUserStepCompletionRate') for (let s = 2; s <= 20; s++) add(metric, `FunnelName=Levels|FunnelStep=${s}`, [[t0, 0.9 * (s === 8 ? 0.72 : 1) * (s === 15 ? 0.8 : 1)]]);
      else if (metric === 'CustomEventAvgValue') for (let s = 1; s <= 20; s++) add(metric, `CustomEventName=LevelReachedMinutes|CustomField1=Level ${s}`, [[t0, 4 * Math.pow(s, 1.45) * (s >= 8 ? 1.35 : 1)]]);
      else { const v = days.slice(-28).reduce((a, t) => a + (demoValue(metric, t) || 0), 0) / 5.5; if (v) add(metric, '', [[t0, v]]); }
      continue;
    }
    if (metric === 'DailyCohortRetention') {
      const offs = [1, 2, 3, 7, 14, 21, 30], curve = { 1: 0.27, 2: 0.19, 3: 0.15, 7: 0.085, 14: 0.055, 21: 0.038, 30: 0.028 };
      offs.forEach(c => add(metric, `CohortDay=${c}`, days.filter(t => t + c * DAY < AX.today()).map(t => [t, curve[c] * (1 + hash('c' + c + t) * 0.12) * ((AX.today() - t) / DAY < 40 ? 1.09 : 1)])));
      continue;
    }
    if (!(demoValue(metric, AX.today() - DAY) != null)) continue;
    const pts = k => days.map(t => [t, demoValue(metric, t, k), mat[metric] && t > AX.today() - (mat[metric] + 1) * DAY ? 'Projected' : undefined]);
    if (metric === 'EconomyTransactionAmount') { ['Source', 'Sink'].forEach(f => add(metric, `FlowType=${f}|CurrencyType=Coins`, pts(f))); continue; }
    if (metric === 'EconomyAverageWalletBalance') { add(metric, 'CurrencyType=Coins', pts('')); continue; }
    add(metric, '', pts(''));
    const dims = o.breakdown === '*' ? ['Platform', 'IsNewUser'] : o.breakdown ? o.breakdown.split(',') : [];
    if (dims.includes('Platform') && AX.def(metric).dims.includes('Platform')) PLAT.forEach(([p, sh]) => add(metric, `Platform=${p}`, days.map(t => { const v = demoValue(metric, t, p); return [t, AX.def(metric).unit === 'count' || AX.def(metric).summable ? v * sh : v * (1 + (p === 'Computer' ? 0.12 : p === 'Phone' ? -0.04 : p === 'Console' ? 0.18 : 0.02))]; })));
    if (dims.includes('IsNewUser') && AX.def(metric).dims.includes('IsNewUser')) NEWR.forEach(([p, sh]) => add(metric, `IsNewUser=${p}`, days.map(t => { const v = demoValue(metric, t, p); return [t, AX.def(metric).unit === 'count' || AX.def(metric).summable ? v * sh : v * (p === 'true' ? 0.82 : 1.1)]; })));
  }
  if (o.gran === 'OneWeek' || o.gran === 'OneMonth') series.forEach(s => { s.granularity = o.gran; const r = AX.rollup(s.points, o.gran, { ...AX.def(s.metric), summable: true }); s.points = AX.def(s.metric).summable ? r.points : AX.rollup(s.points, o.gran, { ...AX.def(s.metric), unit: 'number' }).points; });
  return { from: new Date(o.from).toISOString(), to: new Date(o.to).toISOString(), granularity: o.gran, series, limitedByPlan: false };
};
AX.demoForecast = (metric) => {
  const s = AX.demoQuery({ games: [AX.DEMO_GAME.id], metrics: [metric], gran: 'OneDay', from: AX.today() - 200 * DAY, to: AX.today(), breakdown: '' }).series[0];
  if (!s) return { ok: false, reason: 'Not enough data to generate a reliable forecast.' };
  // Same shape as the server's forecast; the demo uses a simple trend + weekday band over its own generated history.
  const pts = s.points.filter(p => p[2] !== 'Projected').slice(-120), mean = pts.reduce((a, p) => a + p[1], 0) / pts.length, sd = Math.sqrt(pts.reduce((a, p) => a + (p[1] - mean) ** 2, 0) / pts.length);
  const last = pts[pts.length - 1][0], recent = pts.slice(-28).reduce((a, p) => a + p[1], 0) / 28, def = AX.def(metric);
  const points = Array.from({ length: 30 }, (_, k) => { const t = last + (k + 1) * DAY, mid = recent * (def.unit === 'count' || def.summable ? [1.16, 0.95, 0.93, 0.94, 0.97, 1.05, 1.18][new Date(t).getUTCDay()] / 1.026 : 1), w = 1.28 * sd * Math.sqrt(1 + k / 20);
    return { t: new Date(t).toISOString(), lo: Math.max(0, mid - w), mid, hi: def.unit === 'ratio' ? Math.min(1, mid + w) : mid + w }; });
  return { ok: true, method: AX.catalog.forecastMethod, interval: 0.8, generatedAt: new Date().toISOString(), trainedFrom: new Date(pts[0][0]).toISOString(), trainedTo: new Date(last).toISOString(), n: pts.length, coverage: 1, seasonal: true,
    quality: { level: 'good', notes: ['Demonstration forecast on generated data.'], backtestMape: null }, points, total: def.summable ? { lo: points.reduce((a, p) => a + p.lo, 0), mid: points.reduce((a, p) => a + p.mid, 0), hi: points.reduce((a, p) => a + p.hi, 0) } : null, metric };
};
})();
(() => {
const AX = window.AX, DAY = AX.DAY;
const P = () => (S().prefs.ax ||= {});
const setP = (k, v) => { P()[k] = v; save(); };
AX.P = P; AX.setP = setP;
const has = f => !!ME?.entitlement?.features?.includes(f) || AX.demo;
AX.has = has;

/* ---------- shared chrome ---------- */
AX.demoBanner = () => AX.demo ? `<div class="ax-demo" role="note">${icon('info', 16)}<span><b>Demonstration data.</b> Generated for a sample experience so you can explore. It isn't a real game. Sign up and connect Roblox or upload data to see your own.</span></div>` : '';
AX.ctx = () => {
  const p = P(), range = AX.range(p.range || '28d', p.custom);
  return { game: AX.currentGame(), portfolio: p.axGame === 'portfolio' || S().prefs.axGame === 'portfolio', range, annotations: AX.annotations(AX.currentGame()) };
};
AX.toolbar = (o = {}) => {
  const p = P(), games = AX.games(), cur = S().prefs.axGame === 'portfolio' ? 'portfolio' : AX.currentGame()?.id || '';
  return `<div class="ax-bar" role="toolbar" aria-label="Analytics filters">
    <label class="ax-sel"><span class="sr-only">Game</span><select id="axGame">${games.map(g => `<option value="${esc(g.id)}" ${g.id === cur ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}${o.portfolio && games.length > 1 ? `<option value="portfolio" ${cur === 'portfolio' ? 'selected' : ''}>Portfolio · all games</option>` : ''}</select></label>
    <label class="ax-sel"><span class="sr-only">Date range</span><select id="axRange">${AX.RANGES.map(([k, l]) => `<option value="${k}" ${(p.range || '28d') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <span id="axCustom" ${p.range === 'custom' ? '' : 'hidden'}><input type="date" id="axFrom" value="${esc(p.custom?.from || '')}" aria-label="From"> – <input type="date" id="axTo" value="${esc(p.custom?.to || '')}" aria-label="To"></span>
    <span class="ax-fresh" id="axFresh"></span><span class="ax-bar-end">${o.end || ''}</span></div>`;
};
AX.bindToolbar = (root, rerender) => {
  const g = $('#axGame', root), r = $('#axRange', root), f = $('#axFrom', root), t = $('#axTo', root);
  if (g) g.onchange = () => { S().prefs.axGame = g.value; if (g.value !== 'portfolio') S().selectedGameId = g.value; save(); rerender(); };
  if (r) r.onchange = () => { setP('range', r.value); $('#axCustom', root).hidden = r.value !== 'custom'; if (r.value !== 'custom' || P().custom?.from) rerender(); };
  const cust = debounce(() => { if (f.value && t.value && f.value <= t.value) { setP('custom', { from: f.value, to: t.value }); rerender(); } }, 400);
  if (f) { f.onchange = cust; t.onchange = cust; }
};
AX.setFresh = (root, iso, kinds) => { const el = $('#axFresh', root); if (!el) return; el.innerHTML = iso ? `Updated ${timeAgo(Date.parse(iso))}` : ''; };
AX.noGames = () => `<div class="card ax-empty-state"><h2>Add a game to see its analytics.</h2><div class="row" style="gap:10px;justify-content:center"><button class="btn" data-addgame>${icon('plus', 18)} New Game</button><a class="btn ghost" href="#/studio">Scan from Studio</a></div></div>`;
const noData = () => AX.demo ? 'No data in this range.' : `No data in this range. <a href="#/data">Connect Roblox or upload data</a>`;

/* ---------- chart card ---------- */
// Widget: { id, w, h, kind?: chart|kpis|findings|portfolio, chart?: config }
AX.cardHTML = (w, o = {}) => `<article class="card ax-card" data-w="${esc(w.id)}" style="--w:${w.w};--h:${w.h}">
  <header class="ax-card-h"><div class="ax-card-t"><h3>${esc(w.chart?.title || { kpis: 'Key metrics', findings: 'Optimizer findings', portfolio: 'Portfolio' }[w.kind] || 'Chart')}</h3><span class="ax-chips"></span></div>
    <div class="ax-card-a">${o.custom ? `<button class="icon-btn ax-grip" data-act="drag" aria-label="Drag to move" title="Drag to move">${icon('grid', 16)}</button>` : ''}${w.kind === 'kpis' || w.kind === 'findings' ? '' : `<button class="icon-btn" data-act="menu" aria-label="Chart options" aria-haspopup="menu">${icon('more', 18)}</button>`}${o.custom ? `<button class="icon-btn" data-act="remove" aria-label="Remove widget">${icon('x', 16)}</button>` : ''}</div></header>
  <div class="ax-body ax-h${w.h}" aria-busy="true"><div class="ax-skel"></div></div><footer class="ax-card-f"></footer>${o.custom ? '<span class="ax-resize" data-act="resize" aria-hidden="true"></span>' : ''}</article>`;
const chipsFor = r => [...(r.kinds || [])].map(k => AX.chip(k)).join('');
AX.mountChart = async (card, cfg, ctx) => {
  const body = $('.ax-body', card), foot = $('.ax-card-f', card);
  const r = await AX.resolve(cfg, ctx); card._r = r; card._cfg = cfg;
  body.removeAttribute('aria-busy');
  $('.ax-chips', card).innerHTML = chipsFor(r) + (cfg.series?.length === 1 && cfg.series[0].metric ? AX.info(`${AX.def(cfg.series[0].metric).def}${AX.def(cfg.series[0].metric).axis ? ' ' + AX.def(cfg.series[0].metric).axis : ''}`) : '');
  if (r.empty || !r.series?.length || !r.series.some(s => s.points.length)) { AX.chart(body, { empty: r.empty || noData() }); foot.innerHTML = r.notes?.length ? `<p class="ax-note">${r.notes.map(esc).join(' ')}</p>` : ''; return r; }
  const spec = AX.specFor(cfg, r, ctx); card._spec = spec;
  AX.chart(body, spec);
  const fc = r.series.find(s => s.forecast);
  foot.innerHTML = `${r.notes.length ? `<p class="ax-note">${r.notes.map(esc).join(' ')}</p>` : ''}<p class="ax-meta">${esc(r.range.label)}${r.fresh ? ` · updated ${timeAgo(Date.parse(r.fresh))}` : ''}${fc ? ` · ${AX.chip('forecast')} ${Math.round(fc.forecast.interval * 100)}% range, trained ${AX.fmtDay(Date.parse(fc.forecast.trainedFrom))}–${AX.fmtDay(Date.parse(fc.forecast.trainedTo))}` : ''}${r.series.find(s => s.formula) ? ` · ${esc(r.series.find(s => s.formula).formula)}` : ''}</p>`;
  return r;
};
// Builds the engine spec for a resolved config (type-specific shapes).
AX.specFor = (cfg, r, ctx) => {
  const type = AX.validTypes(cfg).includes(cfg.type) ? cfg.type : AX.validTypes(cfg)[0];
  if (type === 'table') { const rows = AX.toRows({ type: 'line', series: r.series, x: 'time' }); return { type: 'table', table: { cols: rows[0], rows: rows.slice(1).reverse() } }; }
  if (type === 'heat') return AX.heatSpec(r, cfg);
  if (type === 'funnel') return { type: 'funnel', funnel: r.series.filter(s => !s.compare).map(s => ({ label: s.name, v: s.points[s.points.length - 1]?.[1], unit: s.unit })) };
  if (type === 'hist' || r.gran === 'None') {
    const cats = r.series.map(s => s.name.split(' · ').slice(1).join(' · ') || s.name);
    return { type: 'bar', x: 'cat', cats, h: cfg.h, series: [{ id: 'dist', name: AX.def(cfg.series[0].metric).label, unit: r.series[0].unit, kind: r.series[0].kind, points: r.series.map((s, i) => [i, s.points[s.points.length - 1]?.[1]]) }] };
  }
  return { type, series: r.series, x: 'time', annotations: ctx?.annotations || [], title: cfg.title, h: cfg.h };
};
AX.heatSpec = (r, cfg) => {
  const ret = r.series.filter(s => /CohortRetention/.test(s.metric)), weekly = ret[0]?.metric === 'WeeklyCohortRetention', step = weekly ? 7 * DAY : DAY;
  const offs = [...new Set(ret.map(s => +s.breakdown.split('=')[1]))].filter(isFinite).sort((a, b) => a - b);
  const rowsT = [...new Set(ret.flatMap(s => s.points.map(p => p[0])))].sort((a, b) => b - a).slice(0, weekly ? 16 : 30);
  const sizeS = r.data?.series.find(s => s.metric === 'CohortSize'), size = new Map((sizeS?.points || []).map(p => [p[0], p[1]]));
  const map = new Map(ret.flatMap(s => s.points.map(p => [`${p[0]}|${s.breakdown.split('=')[1]}`, p[1]]))), last = AX.today();
  return { type: 'heat', title: cfg.title, heat: { rows: rowsT.map(t => ({ t, size: size.get(t) ?? null })), cols: offs.map(o => ({ label: weekly ? `W${o}` : `D${o}`, offset: o })),
    fmtRow: rw => AX.fmtDay(rw.t).replace(/, \d{4}$/, ''),
    cell: (i, j) => { const t = rowsT[i], o = offs[j]; if (t + (o + 1) * step > last) return { state: 'immature' }; const v = map.get(`${t}|${o}`); return v == null ? null : { v, state: 'ok' }; } }, onSelect: cfg.onSelect };
};
// Context menu for a chart card.
AX.cardMenu = (btn, card, actions) => {
  document.querySelector('.ax-menu')?.remove();
  const m = document.createElement('div'); m.className = 'ax-menu'; m.setAttribute('role', 'menu');
  m.innerHTML = actions.filter(Boolean).map(([k, l]) => `<button role="menuitem" data-m="${k}">${esc(l)}</button>`).join('');
  document.body.appendChild(m); const r = btn.getBoundingClientRect(); m.style.left = Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth)) + 'px'; m.style.top = (r.bottom + scrollY + 6) + 'px';
  const close = () => { m.remove(); document.removeEventListener('pointerdown', out, true); }, out = e => { if (!m.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('pointerdown', out, true)); m.querySelector('button')?.focus();
  m.onkeydown = e => { if (e.key === 'Escape') { close(); btn.focus(); } };
  return new Promise(res => m.onclick = e => { const b = e.target.closest('[data-m]'); if (b) { close(); res(b.dataset.m); } });
};
AX.exportAction = (k, card, name) => {
  if (k === 'csv') AX.csv(name, card._spec || { type: 'line', series: card._r?.series || [] });
  if (k === 'png') AX.png(name, $('.ax-body', card), name);
  if (k === 'data') { const rows = AX.toRows(card._spec || { type: 'line', series: card._r?.series || [] }); openModal({ title: `${name}: data`, wide: true, body: '<div id="axDataT"></div>', onMount: m => AX.chart($('#axDataT', m), { type: 'table', table: { cols: rows[0], rows: rows.slice(1) } }) }); }
};

/* ---------- KPI strip ---------- */
AX.KPIS = ['ForwardD1Retention', 'ForwardD7Retention', 'ForwardD30Retention', { m: 'DailyActiveUsers', bd: '', label: 'Active users' }, { m: 'AverageSessionLengthMinutes', bd: '', label: 'Avg. session' }, { m: 'AveragePlayTimeMinutesPerDAU', bd: '', label: 'Playtime per user' }];
const mature = (pts, metric) => { const m = AX.catalog.maturity[metric] || 0, cut = AX.today() - (m + 1) * DAY; return pts.filter(p => p[2] !== 'Projected' && p[0] <= cut); };
// Period value: mean of daily values for the period (retention uses only mature cohorts). Same rule for both periods.
AX.periodValue = (series, metric, game, from, to, breakdown = '') => {
  const s = AX.pick(series, metric, { game, breakdown }); if (!s) return null;
  const pts = mature(s.points, metric).filter(p => p[0] >= from && p[0] < to && p[1] != null);
  // Summable metrics (hours played, sessions) are totals for the period; everything else is the mean of daily values.
  return pts.length ? { v: pts.reduce((a, p) => a + p[1], 0) / (AX.def(metric).summable ? 1 : pts.length), n: pts.length, source: s.source, fresh: s.fetchedAt, pts, win: [pts[0][0], pts[pts.length - 1][0]] } : null;
};
// Retention KPIs look at the latest cohorts old enough to be final: the range shifted back by the maturity period.
const shift = m => ((AX.catalog.maturity[m] ?? -1) + 1) * DAY;
AX.kpiHTML = (metric, cur, prev, label) => {
  const d = { ...AX.def(metric), ...(label ? { label } : {}) }, up = cur && prev ? cur.v - prev.v : null, pct = d.unit === 'ratio' ? (up != null ? `${up >= 0 ? '+' : '−'}${Math.abs(up * 100).toFixed(1)} pp` : '') : up != null && prev.v ? `${up >= 0 ? '+' : '−'}${Math.abs(up / prev.v * 100).toFixed(1)}%` : '';
  const spark = cur?.pts?.length > 2 ? (() => { const v = cur.pts.map(p => p[1]), mn = Math.min(...v), mx = Math.max(...v), w = 88, h = 26; return `<svg class="ax-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="M${v.map((y, i) => `${(i / (v.length - 1) * w).toFixed(1)} ${(h - 2 - (y - mn) / (mx - mn || 1) * (h - 4)).toFixed(1)}`).join('L')}"/></svg>`; })() : '';
  return `<div class="ax-kpi"><span class="t-label">${esc(d.label)}${AX.info(d.def + (d.unit === 'ratio' ? ' Period value = mean of the latest daily cohorts old enough to be final (the range shifted back by the retention day).' : (d.summable ? ' Period value = total for the range.' : ' Period value = mean of daily values in the range.')))}</span>
    <b class="t-metric" data-kpi="${metric}" data-v="${cur ? cur.v : ''}">${cur ? AX.fmt(d.unit, cur.v) : '—'}</b>
    ${cur ? `<span class="ax-delta ${up == null ? '' : up >= 0 ? 'up' : 'down'}">${pct && /^[+−]0.0/.test(pct) ? '<span class="muted">No change</span>' : pct ? `${up >= 0 ? '▲' : '▼'} ${pct}` : '<span class="muted">No previous period</span>'}<span class="muted"> vs previous</span></span>${spark}<span class="ax-kfresh">${AX.KIND[cur.source]} · ${d.unit === 'ratio' && AX.catalog.maturity[metric] ? `cohorts ${AX.fmtDay(cur.win[0]).replace(/, \d{4}$/, '')}–${AX.fmtDay(cur.win[1]).replace(/, \d{4}$/, '')}` : cur.fresh ? timeAgo(Date.parse(cur.fresh)) : ''}</span>` : '<span class="ax-kfresh">No data yet</span>'}</div>`;
};
AX.mountKpis = async (el, ctx, items = AX.KPIS) => {
  const g = ctx.game; if (!g) return;
  const r = ctx.range, pr = AX.prevRange(r), K = items.map(x => typeof x === 'string' ? { m: x, bd: '' } : x), dims = [...new Set(K.filter(k => k.bd).map(k => k.bd.split('=')[0]))];
  try {
    const back = Math.max(...K.map(k => shift(k.m))), data = await AX.query({ games: [g.id], metrics: [...new Set(K.map(k => k.m))], gran: 'OneDay', from: pr.from - back, to: r.to, breakdown: dims.join(',') });
    el.innerHTML = `<div class="ax-kpis">${K.map(k => { const b = shift(k.m); return AX.kpiHTML(k.m, AX.periodValue(data.series, k.m, g.id, r.from - b, r.to - b, k.bd), AX.periodValue(data.series, k.m, g.id, pr.from - b, pr.to - b, k.bd), k.label); }).join('')}</div>`;
    el.querySelectorAll('[data-kpi]').forEach(b => b.dataset.v && AX.countTo(b, +b.dataset.v, AX.def(b.dataset.kpi).unit));
    return data;
  } catch (e) { el.innerHTML = `<div class="ax-empty">${esc(e.message)}</div>`; }
};

/* ---------- findings (optimizer reports next to the data) ---------- */
AX.findingsHTML = (g, only) => {
  if (!g || g.demoAnalytics) return '<p class="small muted" style="margin:0">Optimizer reports for your own games appear here.</p>';
  const reps = (only ? [only] : OPTIMIZERS.map(o => o.id)).map(id => latestReport(g.id, id)).filter(Boolean);
  if (!reps.length) return `<p class="small muted" style="margin:0">No reports for ${esc(g.name)} yet. <a href="#/optimizers">Run an optimizer</a></p>`;
  return `<div class="ax-findings">${reps.map(r => { const top = r.recs.filter(x => !x.done).sort((a, b) => PRI[a.priority] - PRI[b.priority]).slice(0, 2);
    return `<a class="ax-find" href="#/reports/${r.id}"><span class="t-label">${esc(OPT[r.optimizer].name)} · ${AX.fmtDay(r.createdAt)}</span><b class="t-num">${r.score}<small>/100</small></b>${top.map(x => `<span class="small"><span class="pri ${x.priority}">${x.priority}</span> ${esc(x.title)}</span>`).join('') || '<span class="small muted">All recommendations done</span>'}</a>`; }).join('')}</div>
    <p class="tiny faint" style="margin:10px 0 0">Report dates are marked on charts. A change after a report doesn't by itself show the report caused it.</p>`;
};

/* ---------- portfolio ---------- */
AX.mountPortfolio = async (el, ctx) => {
  const games = AX.games(), r = ctx.range, metrics = ['DailyActiveUsers', 'ForwardD1Retention', 'ForwardD7Retention', 'AverageSessionLengthMinutes', 'TotalPlayTimeHours'];
  const rows = await Promise.all(games.map(async g => { try { const d = await AX.query({ games: [g.id], metrics, gran: 'OneDay', from: r.from, to: r.to, breakdown: '' }); return { g, d }; } catch { return { g, d: null }; } }));
  const sum = (d, g) => { const s = AX.pick(d.series, 'TotalPlayTimeHours', { game: g }); return s ? s.points.filter(p => p[0] >= r.from).reduce((a, p) => a + p[1], 0) : null; };
  const total = rows.reduce((a, x) => { const v = x.d && sum(x.d, x.g.id); return v == null ? a : (a ?? 0) + v; }, null);
  el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Game</th><th>Avg. active users</th><th>D1</th><th>D7</th><th>Avg. session</th><th>Playtime (total)</th></tr></thead><tbody>
    ${rows.map(({ g, d }) => { const v = m => d && AX.periodValue(d.series, m, g.id, r.from, r.to);
      return `<tr><td><a href="#/home" data-axgame="${esc(g.id)}">${esc(g.name)}</a></td><td>${AX.fmt('count', v('DailyActiveUsers')?.v)}</td><td>${AX.fmt('ratio', v('ForwardD1Retention')?.v)}</td><td>${AX.fmt('ratio', v('ForwardD7Retention')?.v)}</td><td>${AX.fmt('minutes', v('AverageSessionLengthMinutes')?.v)}</td><td>${AX.fmt('hours', d && sum(d, g.id))}</td></tr>`; }).join('')}
    <tr class="ax-total"><td>All games</td><td title="Players can play several of your games, so active users aren't added up.">Not combined</td><td>Not combined</td><td>Not combined</td><td>Not combined</td><td>${AX.fmt('hours', total)}</td></tr></tbody></table></div>
    <p class="tiny faint">Totals are shown only where values can be added (playtime hours). Rates and unique players are kept per game.</p>`;
  el.querySelectorAll('[data-axgame]').forEach(a => a.onclick = e => { e.preventDefault(); S().prefs.axGame = a.dataset.axgame; S().selectedGameId = a.dataset.axgame; save(); route(); });
};

/* ---------- dashboards ---------- */
const S1 = (metric, extra = {}) => ({ metric, ...extra });
AX.PRESETS = {
  retention: { type: 'line', title: 'Retention', series: [S1('ForwardD1Retention'), S1('ForwardD7Retention'), S1('ForwardD30Retention')] },
  active: { type: 'area', title: 'Active players', series: [S1('DailyActiveUsers')] },
  newret: { type: 'stacked', title: 'New vs returning players', series: [S1('DailyActiveUsers')], split: 'IsNewUser' },
  playtime: { type: 'line', title: 'Playtime', series: [S1('AverageSessionLengthMinutes'), S1('AveragePlayTimeMinutesPerDAU')] },
  sessions: { type: 'hist', title: 'Sessions by length', series: [S1('TotalSessionsEndedInBucket')] },
  funnel: { type: 'funnel', title: 'Acquisition funnel', series: ['UniqueUsersWithImpressions', 'UniqueUsersWithClicks', 'UniqueUsersWithPlaySessions', 'QualifiedUniqueUsersWithPlaySessions'].map(m => S1(m)) },
  cohort: { type: 'heat', title: 'Cohort retention', series: [S1('DailyCohortRetention')] },
  platform: { type: 'line', title: 'D1 retention by platform', series: [S1('ForwardD1Retention')], split: 'Platform' },
  economy: { type: 'bar', title: 'Currency earned vs spent', series: [S1('EconomyTransactionAmount')], split: 'FlowType' },
  frequency: { type: 'line', title: 'Sessions per active user', series: [S1('Visits'), S1('DailyActiveUsers'), { formula: 'A/B', builtin: 'sessions_per_user', name: 'Sessions per active user', unit: 'number' }], hideBase: true },
};
AX.DEFAULT_WIDGETS = () => [
  { id: 'kpis', kind: 'kpis', w: 12, h: 1 }, { id: 'ret', w: 8, h: 2, chart: AX.PRESETS.retention }, { id: 'act', w: 4, h: 2, chart: AX.PRESETS.active },
  { id: 'nvr', w: 6, h: 2, chart: AX.PRESETS.newret }, { id: 'play', w: 6, h: 2, chart: AX.PRESETS.playtime }, { id: 'find', kind: 'findings', w: 12, h: 1 }];
AX.dashList = async () => {
  if (AX.demo) return S().axDash ||= [{ id: 'main', name: 'Overview', widgets: AX.DEFAULT_WIDGETS() }];
  if (!AX.dashCache) { const l = await api('GET', '/api/dashboards'); AX.dashCache = l.length ? l : [{ id: 'main', name: 'Overview', widgets: AX.DEFAULT_WIDGETS(), fresh: true }]; }
  return AX.dashCache;
};
const saveDash = debounce(async d => {
  if (AX.demo) return save();
  try { await api('PUT', `/api/dashboards/${d.id}`, { name: d.name, position: AX.dashCache.indexOf(d), widgets: d.widgets }); delete d.fresh; }
  catch (e) { toast(e.data?.upgrade ? e.message : `Couldn't save the layout: ${e.message}`, 'warn'); }
}, 500);
AX.saveDash = saveDash;

AX.pages.home = async () => {
  await AX.load();
  const v = $('#view'), list = await AX.dashList(), p = P(), dash = list.find(d => d.id === p.dash) || list[0], custom = !!AX.customizing;
  const ctx = AX.ctx();
  v.innerHTML = `<header class="page-head row between"><h1>Overview</h1><div class="row" style="gap:10px"><button class="btn ghost" data-addgame>${icon('plus', 18)} New Game</button><a class="btn ghost" href="#/studio">${icon('play', 18)} Scan from Studio</a></div></header>${AX.demoBanner()}
    ${AX.games().length ? AX.toolbar({ portfolio: true, end: `<button class="btn ghost sm" id="axCustomize" aria-pressed="${custom}">${custom ? 'Done' : 'Customize'}</button><button class="btn sm" id="axAdd">${icon('plus', 16)} Add chart</button>` }) : ''}
    ${list.length > 1 || custom ? `<nav class="ax-views" aria-label="Dashboards">${list.map(d => `<button data-view="${esc(d.id)}" aria-current="${d === dash}">${esc(d.name)}</button>`).join('')}${custom ? `<button data-view="+" title="${has('multiple_dashboards') ? 'New dashboard' : 'More dashboards are part of Light and Max'}">${icon('plus', 14)} New view</button>${list.length > 1 ? `<button data-view="rename">Rename</button><button data-view="delete">Delete view</button>` : ''}<button data-view="reset">Reset layout</button>` : ''}</nav>` : ''}
    <div class="ax-grid ${custom ? 'customizing' : ''}" id="axGrid"></div>`;
  if (!AX.games().length) { $('#axGrid').outerHTML = AX.noGames(); return; }
  AX.bindToolbar(v, () => AX.pages.home());
  const grid = $('#axGrid');
  if (ctx.portfolio) { grid.innerHTML = AX.cardHTML({ id: 'pf', kind: 'portfolio', w: 12, h: 1 }); AX.mountPortfolio($('.ax-body', grid), ctx);
    if (has('cross_experience_overview')) { const w = { id: 'cmp', w: 12, h: 2, chart: { type: 'line', title: 'Active players by game', series: AX.games().slice(0, 6).map(g => ({ metric: 'DailyActiveUsers', game: g.id, name: 'Active users' })) } }; grid.insertAdjacentHTML('beforeend', AX.cardHTML(w)); AX.mountChart(grid.lastElementChild, w.chart, ctx); }
    else grid.insertAdjacentHTML('beforeend', '<p class="small muted">Comparing games on one chart is part of Max.</p>');
    $('#axCustomize').hidden = $('#axAdd').hidden = true; return; }
  const mountW = w => { const el = grid.querySelector(`[data-w="${CSS.escape(w.id)}"]`); if (!el) return;
    if (w.kind === 'kpis') return AX.mountKpis($('.ax-body', el), ctx).then(d => { $('.ax-body', el).removeAttribute('aria-busy'); const f = d?.series.map(s => s.fetchedAt).sort().pop(); AX.setFresh(v, f); $('.ax-chips', el).innerHTML = [...new Set(d?.series.map(s => s.source))].map(k => AX.chip(k)).join(''); });
    if (w.kind === 'findings') { $('.ax-body', el).innerHTML = AX.findingsHTML(ctx.game); $('.ax-body', el).removeAttribute('aria-busy'); return; }
    return AX.mountChart(el, w.chart, ctx); };
  const render = () => {
    grid.innerHTML = dash.widgets.map(w => AX.cardHTML(w, { custom: AX.customizing })).join('');
    // Charts render when they scroll near the viewport.
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { io.unobserve(e.target); mountW(dash.widgets.find(w => w.id === e.target.dataset.w)); } }), { rootMargin: '200px' });
    // Cards already on screen mount right away; the rest when they come near.
    grid.querySelectorAll('.ax-card').forEach(c => c.getBoundingClientRect().top < innerHeight + 200 ? mountW(dash.widgets.find(w => w.id === c.dataset.w)) : io.observe(c));
  };
  render();
  $('#axCustomize').onclick = () => { AX.customizing = !AX.customizing; AX.pages.home(); };
  $('#axAdd').onclick = async e => { const btn = e.currentTarget;
    const saved = AX.demo ? [] : await api('GET', '/api/charts').catch(() => []);
    const k = await AX.cardMenu(btn, null, [...Object.entries(AX.PRESETS).map(([k, c]) => [k, c.title]), ['kpis', 'Key metrics'], ['findings', 'Optimizer findings'], ...saved.slice(0, 8).map(c => ['saved:' + c.id, `Saved: ${c.name}`]), ['custom', 'Custom chart…']]);
    if (k === 'custom') return go(`#/charts?dash=${encodeURIComponent(dash.id)}`);
    const id = 'w' + Math.random().toString(36).slice(2, 9), sv = saved.find(c => 'saved:' + c.id === k);
    const w = k === 'kpis' || k === 'findings' ? { id, kind: k, w: 12, h: 1 } : { id, w: 6, h: 2, chart: sv ? sv.config : JSON.parse(JSON.stringify(AX.PRESETS[k])) };
    dash.widgets.push(w); saveDash(dash); grid.insertAdjacentHTML('beforeend', AX.cardHTML(w, { custom: AX.customizing })); mountW(w);
    grid.lastElementChild.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
  };
  v.querySelectorAll('[data-view]').forEach(b => b.onclick = async () => {
    const k = b.dataset.view;
    if (k === '+') { if (!has('multiple_dashboards')) return toast('More dashboards are part of Light and Max.', 'warn'); const d = { id: 'd' + Math.random().toString(36).slice(2, 9), name: `View ${list.length + 1}`, widgets: [{ id: 'kpis', kind: 'kpis', w: 12, h: 1 }] }; list.push(d); setP('dash', d.id); saveDash(d); return AX.pages.home(); }
    if (k === 'reset') return confirmDialog({ title: 'Reset this layout?', message: 'Restores the default charts for this view.', yes: 'Reset', onYes: () => { dash.widgets = AX.DEFAULT_WIDGETS(); saveDash(dash); AX.pages.home(); } });
    if (k === 'rename') { const n = prompt('Dashboard name', dash.name); if (n && n.trim()) { dash.name = n.trim().slice(0, 60); saveDash(dash); AX.pages.home(); } return; }
    if (k === 'delete') return confirmDialog({ title: `Delete “${dash.name}”?`, message: 'Only this view is deleted. Your data stays.', yes: 'Delete', danger: true, onYes: async () => { list.splice(list.indexOf(dash), 1); if (!AX.demo) await api('DELETE', `/api/dashboards/${dash.id}`); else save(); setP('dash', list[0].id); AX.pages.home(); } });
    setP('dash', k); AX.pages.home();
  });
  // Card actions: menu, remove, drag to reorder, resize.
  grid.onclick = async e => {
    const b = e.target.closest('[data-act]'); if (!b) return; const card = b.closest('.ax-card'), w = dash.widgets.find(x => x.id === card.dataset.w);
    if (b.dataset.act === 'remove') { dash.widgets.splice(dash.widgets.indexOf(w), 1); saveDash(dash); card.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.97)' }], { duration: AX.motion() ? 200 : 0 }).onfinish = () => card.remove(); return; }
    if (b.dataset.act !== 'menu') return;
    const mobile = matchMedia('(max-width: 720px)').matches, i = dash.widgets.indexOf(w);
    const k = await AX.cardMenu(b, card, [['edit', 'Edit chart'], ['dup', 'Duplicate'], ['size', w.w >= 12 ? 'Make narrower' : 'Make wider'], ['tall', w.h === 2 ? 'Make shorter' : 'Make taller'], mobile && i > 0 && ['up', 'Move up'], mobile && i < dash.widgets.length - 1 && ['down', 'Move down'], ['data', 'View data'], ['csv', 'Export CSV'], ['png', 'Export image'], ['remove', 'Remove']]);
    if (!k) return;
    if (k === 'edit') return go(`#/charts?dash=${encodeURIComponent(dash.id)}&widget=${encodeURIComponent(w.id)}`);
    if (k === 'dup') { const c = { ...JSON.parse(JSON.stringify(w)), id: 'w' + Math.random().toString(36).slice(2, 9) }; dash.widgets.splice(i + 1, 0, c); saveDash(dash); return render(); }
    if (k === 'size') { const steps = [4, 6, 8, 12], n = steps[(steps.indexOf(w.w) + 1) % steps.length]; w.w = n; card.style.setProperty('--w', n); saveDash(dash); return; }
    if (k === 'tall') { w.h = w.h === 2 ? 1 : 2; card.style.setProperty('--h', w.h); $('.ax-body', card).className = `ax-body ax-h${w.h}`; if (card._spec) { card._spec.h = undefined; AX.chart($('.ax-body', card), { ...card._spec }); } saveDash(dash); return; }
    if (k === 'up' || k === 'down') { const j = k === 'up' ? i - 1 : i + 1; [dash.widgets[i], dash.widgets[j]] = [dash.widgets[j], dash.widgets[i]]; saveDash(dash); const other = grid.children[j]; k === 'up' ? grid.insertBefore(card, other) : grid.insertBefore(other, card); return; }
    if (k === 'remove') { dash.widgets.splice(i, 1); saveDash(dash); card.remove(); return; }
    AX.exportAction(k, card, w.chart?.title || 'chart');
  };
  if (AX.customizing) bindDrag(grid, dash);
};

// Drag-and-drop (desktop, customize mode): pointer drag on the grip; other cards slide out of the way (FLIP, 250 ms).
function flip(grid, mutate) {
  const before = new Map([...grid.children].map(c => [c, c.getBoundingClientRect()])); mutate();
  if (!AX.motion()) return;
  for (const c of grid.children) { const a = before.get(c), b = c.getBoundingClientRect(); if (!a || c.classList.contains('dragging')) continue; const dx = a.left - b.left, dy = a.top - b.top; if (dx || dy) c.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }], { duration: 250, easing: AX.EASE }); }
}
function bindDrag(grid, dash) {
  if (matchMedia('(max-width: 720px)').matches) return;
  grid.onpointerdown = e => {
    const grip = e.target.closest('[data-act="drag"]'), rs = e.target.closest('[data-act="resize"]'); if (!grip && !rs) return;
    const card = (grip || rs).closest('.ax-card'), w = dash.widgets.find(x => x.id === card.dataset.w); e.preventDefault();
    if (rs) { // resize: snap width to 4/6/8/12 columns and height to 1/2 rows
      const g = grid.getBoundingClientRect(), col = g.width / 12, r0 = card.getBoundingClientRect();
      const move = ev => { const cols = Math.round((ev.clientX - r0.left) / col), nw = [3, 4, 6, 8, 12].reduce((a, b) => Math.abs(b - cols) < Math.abs(a - cols) ? b : a, 12), nh = ev.clientY - r0.top > 300 ? 2 : 1;
        if (nw !== w.w || nh !== w.h) flip(grid, () => { w.w = nw; w.h = nh; card.style.setProperty('--w', nw); card.style.setProperty('--h', nh); $('.ax-body', card).className = `ax-body ax-h${nh}`; }); };
      const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); saveDash(dash); if (card._spec) AX.chart($('.ax-body', card), card._spec); };
      addEventListener('pointermove', move); addEventListener('pointerup', up); return;
    }
    const r = card.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top, ph = document.createElement('div');
    ph.className = 'ax-ph'; ph.style.cssText = `--w:${w.w};--h:${w.h};height:${r.height}px`; card.after(ph);
    card.classList.add('dragging'); card.style.cssText += `;position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;z-index:50;pointer-events:none`;
    const move = ev => {
      card.style.left = ev.clientX - ox + 'px'; card.style.top = ev.clientY - oy + 'px';
      const target = [...grid.children].filter(c => c !== card && c !== ph).find(c => { const b = c.getBoundingClientRect(); return ev.clientX > b.left && ev.clientX < b.right && ev.clientY > b.top && ev.clientY < b.bottom; });
      if (target) { const b = target.getBoundingClientRect(), after = ev.clientY > b.top + b.height / 2 || ev.clientX > b.left + b.width / 2 && ev.clientY > b.top; flip(grid, () => after ? target.after(ph) : target.before(ph)); }
      if (ev.clientY < 60) scrollBy(0, -12); else if (ev.clientY > innerHeight - 60) scrollBy(0, 12);
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      const end = ph.getBoundingClientRect(); ph.replaceWith(card); card.classList.remove('dragging');
      const from = { left: card.style.left, top: card.style.top }; card.style.position = card.style.left = card.style.top = card.style.width = card.style.height = card.style.zIndex = card.style.pointerEvents = '';
      const now = card.getBoundingClientRect(); if (AX.motion()) card.animate([{ transform: `translate(${parseFloat(from.left) - now.left}px,${parseFloat(from.top) - now.top}px)` }, { transform: 'none' }], { duration: 250, easing: AX.EASE });
      const order = [...grid.children].map(c => c.dataset.w); dash.widgets.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)); saveDash(dash);
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };
}
})();
(() => {
const AX = window.AX, DAY = AX.DAY;
const head = (title, extra = '') => `<header class="page-head row between"><h1>${title}</h1>${extra}</header>${AX.demoBanner()}`;
const section = (title, body, o = {}) => `<section class="ax-sec"><div class="ax-sec-h"><h2>${title}</h2>${o.end || ''}</div>${body}</section>`;
const slot = (id, w = 12, h = 2, title = '') => `<article class="card ax-card" id="${id}" style="--w:${w};--h:${h}"><header class="ax-card-h"><div class="ax-card-t"><h3>${esc(title)}</h3><span class="ax-chips"></span></div><div class="ax-card-a"><button class="icon-btn" data-act="menu" aria-label="Chart options">${icon('more', 18)}</button></div></header><div class="ax-body ax-h${h}" aria-busy="true"><div class="ax-skel"></div></div><footer class="ax-card-f"></footer></article>`;
const seg = (id, opts, cur) => `<div class="seg ax-seg" role="group" id="${id}">${opts.map(([k, l, dis]) => `<button type="button" data-v="${k}" aria-pressed="${k === cur}" ${dis ? `disabled title="${esc(dis)}"` : ''}>${esc(l)}</button>`).join('')}</div>`;
const bindSeg = (root, id, fn) => root.querySelectorAll(`#${id} [data-v]`).forEach(b => b.onclick = () => { root.querySelectorAll(`#${id} [data-v]`).forEach(x => x.setAttribute('aria-pressed', x === b)); fn(b.dataset.v); });
// Shared: cards on these pages get the same context menu as dashboard cards.
const bindMenus = root => root.addEventListener('click', async e => { const b = e.target.closest('[data-act="menu"]'); if (!b) return; const card = b.closest('.ax-card');
  const k = await AX.cardMenu(b, card, [['open', 'Open in Chart Builder'], ['data', 'View data'], ['csv', 'Export CSV'], ['png', 'Export image']]);
  if (k === 'open' && card._cfg) go('#/charts?c=' + AX.encode(card._cfg)); else if (k) AX.exportAction(k, card, $('h3', card).textContent); });
const guard = v => { if (!AX.games().length) { v.insertAdjacentHTML('beforeend', AX.noGames()); return false; } return true; };
const mount = (id, cfg, ctx) => { const el = $('#' + id); el._cfg = cfg; return AX.mountChart(el, cfg, ctx); };
AX.encode = cfg => btoa(unescape(encodeURIComponent(JSON.stringify(cfg)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
AX.decode = s => { try { return JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))))); } catch { return null; } };

/* ---------- Retention ---------- */
AX.pages.retention = async () => {
  await AX.load();
  const v = $('#view'), p = AX.P(), st = (p.ret ||= { compare: 'none', agg: 'OneDay', heat: 'day', overlay: [] });
  v.innerHTML = head('Retention') + (AX.games().length ? AX.toolbar() : '');
  if (!guard(v)) return;
  const ctx = AX.ctx(), g = ctx.game, marks = ctx.annotations.filter(a => a.kind !== 'report').sort((a, b) => b.t - a.t);
  v.insertAdjacentHTML('beforeend', `<div id="rKpis" class="ax-kpi-wrap"></div>
    <div class="ax-controls">${seg('rCmp', [['none', 'No comparison'], ['previous', 'Previous period'], ['year', 'A year earlier'], ['platform', 'By platform'], ['update', 'Before vs after update', marks.length ? '' : 'Log an update in Settings → Games first']], st.compare)}
      ${seg('rAgg', [['OneDay', 'Daily'], ['OneWeek', 'Weekly']], st.agg)}
      <label class="check sm"><input type="checkbox" id="rBm" ${st.overlay.includes('benchmark') ? 'checked' : ''}> Benchmark</label>
      <label class="check sm"><input type="checkbox" id="rFc" ${st.overlay.includes('forecast') ? 'checked' : ''} ${AX.has('forecasts') ? '' : 'disabled'}> Forecast${AX.has('forecasts') ? '' : ' <span class="tiny muted">(Light and Max)</span>'}</label></div>
    <div class="ax-grid">${slot('rTime', 12, 2, 'Retention by first-play date')}<div class="card ax-card ax-cohort" id="rCohort" style="--w:12;--h:1" hidden></div>
      ${slot('rCurve', 6, 2, 'Retention curve')}${slot('rFunnel', 6, 2, 'Acquisition funnel')}
      ${slot('rHeat', 12, 2, 'Cohort retention')}
      ${slot('rPlat', 6, 2, 'D1 retention by platform')}${slot('rNew', 6, 2, 'New vs returning players')}
      <article class="card ax-card" id="rBA" style="--w:12;--h:1" ${st.compare === 'update' ? '' : 'hidden'}></article>
      <article class="card ax-card" style="--w:12;--h:1"><header class="ax-card-h"><div class="ax-card-t"><h3>Retention findings</h3></div></header><div class="ax-body">${AX.findingsHTML(g, 'retention')}</div></article></div>`);
  AX.bindToolbar(v, () => AX.pages.retention()); bindMenus(v);
  AX.mountKpis($('#rKpis'), ctx, ['ForwardD1Retention', 'ForwardD7Retention', 'ForwardD30Retention', { m: 'DailyActiveUsers', bd: 'IsNewUser=false', label: 'Returning players' }, { m: 'DailyActiveUsers', bd: '', label: 'Active users' }]).then(d => AX.setFresh(v, d?.series.map(s => s.fetchedAt).sort().pop()));
  const timeCfg = () => ({ type: 'line', title: 'Retention by first-play date', gran: st.agg, series: ['ForwardD1Retention', 'ForwardD7Retention', 'ForwardD30Retention'].map(metric => ({ metric })),
    compare: ['previous', 'year'].includes(st.compare) ? st.compare : 'none', split: st.compare === 'platform' ? 'Platform' : '', benchmark: st.overlay.includes('benchmark'), forecast: st.overlay.includes('forecast') && st.compare === 'none' });
  const drawTime = async () => {
    const cfg = timeCfg(); if (st.compare === 'platform') cfg.series = [{ metric: 'ForwardD1Retention' }, { metric: 'ForwardD7Retention' }];
    const r = await mount('rTime', cfg, ctx), body = $('#rTime .ax-body');
    // Clicking a point opens that cohort: D1/D7/D30, maturity and (when uploaded) its size.
    if (body._ax?.spec && r?.series) { body._ax.spec.onSelect = t => showCohort(t, r); }
  };
  const showCohort = async (t, r) => {
    const el = $('#rCohort'), mat = AX.catalog.maturity, age = (AX.today() - t) / DAY;
    const val = m => r.series.find(s => s.metric === m && !s.breakdown && !s.compare)?.points.find(p => p[0] === t);
    const sz = await AX.query({ games: [g.id], metrics: ['CohortSize'], gran: 'OneDay', from: t, to: t + DAY, breakdown: '' }).then(d => d.series[0]?.points[0]?.[1]).catch(() => null);
    el.hidden = false;
    el.innerHTML = `<header class="ax-card-h"><div class="ax-card-t"><h3>Cohort · first played ${AX.fmtDay(t)}</h3></div><div class="ax-card-a"><button class="icon-btn" id="rCx" aria-label="Close cohort">${icon('x', 16)}</button></div></header>
      <div class="ax-kpis">${['ForwardD1Retention', 'ForwardD7Retention', 'ForwardD30Retention'].map(m => { const p = val(m), ok = age > mat[m] + 1;
        return `<div class="ax-kpi"><span class="t-label">${AX.def(m).label}</span><b class="t-metric">${p ? AX.fmt('ratio', p[1]) : '—'}</b><span class="ax-kfresh">${!ok ? `Matures ${AX.fmtDay(t + (mat[m] + 1) * DAY)}` : p?.[2] === 'Projected' ? 'Projected by Roblox' : p ? 'Final' : 'No data'}</span></div>`; }).join('')}
        <div class="ax-kpi"><span class="t-label">Cohort size</span><b class="t-metric">${sz != null ? AX.fmt('count', sz) : '—'}</b><span class="ax-kfresh">${sz != null ? 'Uploaded' : 'Roblox doesn\'t report cohort size'}</span></div></div>`;
    $('#rCx').onclick = () => { el.hidden = true; }; el.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  };
  drawTime();
  // Retention curve: average share of a first-play cohort still playing N days later (mature cohorts only).
  (async () => {
    const el = $('#rCurve'), d = await AX.query({ games: [g.id], metrics: ['DailyCohortRetention', 'ForwardD1Retention', 'ForwardD7Retention', 'ForwardD30Retention'], gran: 'OneDay', from: ctx.range.from, to: ctx.range.to, breakdown: '*' }).catch(e => ({ series: [], err: e }));
    const pr = AX.prevRange(ctx.range), dp = st.compare === 'previous' ? await AX.query({ games: [g.id], metrics: ['DailyCohortRetention', 'ForwardD1Retention', 'ForwardD7Retention', 'ForwardD30Retention'], gran: 'OneDay', from: pr.from, to: pr.to, breakdown: '*' }).catch(() => null) : null;
    const curve = data => {
      const coh = data.series.filter(s => s.metric === 'DailyCohortRetention' && s.breakdown.startsWith('CohortDay='));
      const src = coh.some(s => s.source === 'roblox') ? 'roblox' : coh.some(s => s.source === 'demo') ? 'demo' : 'upload', rows = coh.filter(s => s.source === src);
      if (rows.length) return { src, pts: rows.map(s => { const o = +s.breakdown.split('=')[1], m = s.points.filter(p => p[0] + (o + 1) * DAY <= AX.today()); return [o, m.length ? m.reduce((a, p) => a + p[1], 0) / m.length : null]; }).filter(p => p[1] != null).sort((a, b) => a[0] - b[0]) };
      const f = [['ForwardD1Retention', 1], ['ForwardD7Retention', 7], ['ForwardD30Retention', 30]].map(([m, o]) => { const v = AX.periodValue(data.series, m, g.id, -Infinity, Infinity); return v ? [o, v.v, v.source] : null; }).filter(Boolean);
      return { src: f[0]?.[2], pts: f.map(p => [p[0], p[1]]) };
    };
    const c = curve(d), cp = dp && curve(dp), offs = [...new Set([...c.pts, ...(cp?.pts || [])].map(p => p[0]))].sort((a, b) => a - b);
    $('.ax-body', el).removeAttribute('aria-busy');
    if (!c.pts.length) { AX.chart($('.ax-body', el), { empty: d.err ? esc(d.err.message) : 'No cohort data in this range.' }); return; }
    $('.ax-chips', el).innerHTML = AX.chip(c.src) + AX.info('Average share of each first-play cohort that played again N days later. Only cohorts old enough to have reached day N are included. Unweighted mean across cohorts.');
    const spec = { type: 'line', x: 'cat', cats: offs.map(o => `Day ${o}`), series: [{ id: 'cur', name: 'This period', unit: 'ratio', kind: c.src, points: c.pts.map(p => [offs.indexOf(p[0]), p[1]]) }, ...(cp?.pts.length ? [{ id: 'prev', name: 'Previous period', unit: 'ratio', kind: cp.src, dash: true, points: cp.pts.map(p => [offs.indexOf(p[0]), p[1]]) }] : [])] };
    el._spec = spec; AX.chart($('.ax-body', el), spec);
    $('.ax-card-f', el).innerHTML = `<p class="ax-meta">Mature cohorts · ${esc(ctx.range.label)}</p>`;
  })();
  mount('rFunnel', AX.PRESETS.funnel, ctx).then(r => { if (r?.series) $('#rFunnel .ax-card-f').insertAdjacentHTML('afterbegin', '<p class="ax-note">Unique users over the last 28 days, from Roblox acquisition metrics. Stages without data are hidden.</p>'); });
  const drawHeat = () => mount('rHeat', { type: 'heat', title: 'Cohort retention', series: [{ metric: st.heat === 'week' ? 'WeeklyCohortRetention' : 'DailyCohortRetention' }, { metric: 'CohortSize' }], gran: st.heat === 'week' ? 'OneWeek' : 'OneDay',
    range: { preset: st.heat === 'week' ? '180d' : (AX.P().range === '7d' ? '28d' : AX.P().range || '28d'), ...AX.P().custom } }, ctx);
  $('#rHeat .ax-card-a').insertAdjacentHTML('afterbegin', seg('rHeatG', [['day', 'Daily'], ['week', 'Weekly']], st.heat));
  bindSeg(v, 'rHeatG', x => { st.heat = x; save(); drawHeat(); });
  drawHeat().then(() => { $('#rHeat .ax-card-f').insertAdjacentHTML('afterbegin', '<p class="ax-note">Hatched cells are cohorts that haven\'t reached that day yet, not zero.</p>'); });
  mount('rPlat', { type: 'bar', title: 'D1 retention by platform', series: [{ metric: 'ForwardD1Retention' }], split: 'Platform' }, ctx);
  mount('rNew', AX.PRESETS.newret, ctx);
  const drawBA = async () => {
    const el = $('#rBA'); if (st.compare !== 'update' || !marks.length) { el.hidden = true; return; } el.hidden = false;
    const m = marks.find(x => String(x.t) === String(st.mark)) || marks[0], win = st.win || 14;
    const d = await AX.query({ games: [g.id], metrics: ['ForwardD1Retention', 'ForwardD7Retention', 'DailyActiveUsers', 'AverageSessionLengthMinutes'], gran: 'OneDay', from: m.t - win * DAY, to: m.t + win * DAY, breakdown: '' });
    el.innerHTML = `<header class="ax-card-h"><div class="ax-card-t"><h3>Before vs after</h3></div><div class="ax-card-a"><select id="rMark" aria-label="Update">${marks.map(x => `<option value="${x.t}" ${x === m ? 'selected' : ''}>${esc(x.label)} · ${AX.fmtDay(x.t)}</option>`).join('')}</select><select id="rWin" aria-label="Window">${[7, 14, 28].map(n => `<option value="${n}" ${n === win ? 'selected' : ''}>${n} days each side</option>`).join('')}</select></div></header>
      <div class="table-wrap"><table><thead><tr><th>Metric</th><th>Before</th><th>After</th><th>Difference</th></tr></thead><tbody>${['ForwardD1Retention', 'ForwardD7Retention', 'DailyActiveUsers', 'AverageSessionLengthMinutes'].map(k => { const def = AX.def(k), a = AX.periodValue(d.series, k, g.id, m.t - win * DAY, m.t), b = AX.periodValue(d.series, k, g.id, m.t, m.t + win * DAY);
        return `<tr><td>${esc(def.label)}</td><td>${AX.fmt(def.unit, a?.v)}<small class="muted"> ${a ? `${a.n} days` : ''}</small></td><td>${AX.fmt(def.unit, b?.v)}<small class="muted"> ${b ? `${b.n} days` : ''}</small></td><td>${a && b ? (def.unit === 'ratio' ? `${b.v >= a.v ? '+' : '−'}${Math.abs((b.v - a.v) * 100).toFixed(1)} pp` : `${b.v >= a.v ? '+' : '−'}${Math.abs((b.v - a.v) / a.v * 100).toFixed(1)}%`) : '—'}</td></tr>`; }).join('')}</tbody></table></div>
      <p class="tiny faint" style="margin:10px 0 0">An observed difference, not proof the update caused it. Seasonality, traffic sources and Roblox events can move these numbers too. Retention only counts mature cohorts.</p>`;
    $('#rMark').onchange = e => { st.mark = e.target.value; save(); drawBA(); }; $('#rWin').onchange = e => { st.win = +e.target.value; save(); drawBA(); };
  };
  drawBA();
  bindSeg(v, 'rCmp', x => { st.compare = x; save(); drawTime(); drawBA(); });
  bindSeg(v, 'rAgg', x => { st.agg = x; save(); drawTime(); });
  const ov = () => { st.overlay = [$('#rBm').checked && 'benchmark', $('#rFc').checked && 'forecast'].filter(Boolean); save(); drawTime(); };
  $('#rBm').onchange = ov; $('#rFc').onchange = ov;
};

/* ---------- Playtime ---------- */
AX.pages.playtime = async () => {
  await AX.load();
  const v = $('#view');
  v.innerHTML = head('Playtime') + (AX.games().length ? AX.toolbar() : '');
  if (!guard(v)) return;
  const ctx = AX.ctx(), g = ctx.game;
  v.insertAdjacentHTML('beforeend', `<div id="pKpis" class="ax-kpi-wrap"></div>
    <div class="ax-grid"><article class="card ax-card" id="pExp" style="--w:12;--h:1"><header class="ax-card-h"><div class="ax-card-t"><h3>Expected playtime</h3><span class="ax-chips"></span></div></header><div class="ax-body"><div class="ax-skel"></div></div></article>
      ${slot('pTrend', 7, 2, 'Playtime trend')}${slot('pDist', 5, 2, 'Sessions by length')}
      ${slot('pCoh', 6, 2, 'Playtime by player age')}${slot('pPlat', 6, 2, 'Session length by platform')}
      ${slot('pFreq', 6, 2, 'Sessions per active user')}${slot('pTotal', 6, 2, 'Total playtime')}
      <article class="card ax-card" style="--w:12;--h:1"><header class="ax-card-h"><div class="ax-card-t"><h3>First session findings</h3></div></header><div class="ax-body">${AX.findingsHTML(g, 'first-session')}</div></article></div>`);
  AX.bindToolbar(v, () => AX.pages.playtime()); bindMenus(v);
  AX.mountKpis($('#pKpis'), ctx, ['AverageSessionLengthMinutes', 'AveragePlayTimeMinutesPerDAU', 'TotalPlayTimeHours', 'Visits']).then(d => AX.setFresh(v, d?.series.map(s => s.fetchedAt).sort().pop()));
  // Expected playtime: cumulative per-user playtime (Roblox RFY windows) and the forecast for total playtime.
  (async () => {
    const el = $('#pExp .ax-body'), d = await AX.query({ games: [g.id], metrics: ['RFYD1Playtime', 'RFYD2To7Playtime', 'RFYD8To28Playtime'], gran: 'OneDay', from: ctx.range.from, to: ctx.range.to, breakdown: '' }).catch(() => ({ series: [] }));
    const m = k => AX.periodValue(d.series, k, g.id, -Infinity, Infinity)?.v, d1 = m('RFYD1Playtime'), d7 = m('RFYD2To7Playtime'), d28 = m('RFYD8To28Playtime');
    let fc = null; if (AX.has('forecasts')) fc = await AX.forecastFor(g.id, 'TotalPlayTimeHours', '').catch(e => ({ ok: false, reason: e.message }));
    const se = p => (p.hi - p.lo) / (2 * 1.2816), sum = n => { const ps = fc.points.slice(0, n), mid = ps.reduce((a, p) => a + p.mid, 0), s = Math.sqrt(ps.reduce((a, p) => a + se(p) ** 2, 0)); return { lo: Math.max(0, mid - 1.2816 * s), mid, hi: mid + 1.2816 * s }; };
    $('#pExp .ax-chips').innerHTML = (d1 != null ? AX.chip(d.series[0]?.source || 'roblox') : '') + (fc?.ok ? AX.chip('forecast') : '');
    el.innerHTML = `<div class="ax-kpis">
      ${[['Day 1', d1], ['Days 1–7', d1 != null && d7 != null ? d1 + d7 : null], ['Days 1–28', d1 != null && d7 != null && d28 != null ? d1 + d7 + d28 : null]].map(([l, x]) => `<div class="ax-kpi"><span class="t-label">${l} · per player</span><b class="t-metric">${AX.fmt('minutes', x)}</b><span class="ax-kfresh">${x != null ? 'Cumulative · players from Home recommendations' : 'No data'}</span></div>`).join('')}
      ${[7, 30].map(n => { const s = fc?.ok ? sum(n) : null; return `<div class="ax-kpi"><span class="t-label">Next ${n} days · total</span><b class="t-metric">${s ? AX.fmt('hours', s.mid) : '—'}</b><span class="ax-kfresh">${s ? `Forecast · ${AX.fmt('hours', s.lo)}–${AX.fmt('hours', s.hi)} (80% range)` : esc(fc ? fc.reason || '' : 'Forecasts are part of Light and Max.')}</span></div>`; }).join('')}</div>
      <p class="tiny faint" style="margin:10px 0 0">Per-player values are Roblox averages for players who arrived from Home recommendations (days 1, 2–7 and 8–28, added up). The forecast is an estimate of total hours across all players.</p>`;
  })();
  mount('pTrend', { ...AX.PRESETS.playtime, title: 'Playtime trend', forecast: false }, ctx);
  mount('pDist', AX.PRESETS.sessions, ctx).then(r => {
    if (!r?.series?.length) return;
    // Short / medium / long: grouped from Roblox's own buckets by their lower bound in minutes (only when the labels contain minutes).
    const b = r.series.map(s => ({ label: s.name.split(' · ').slice(1).join(' · '), v: s.points[s.points.length - 1]?.[1] || 0 })), lo = x => { const m = String(x.label).match(/(\d+(?:\.\d+)?)/); return m ? +m[1] : null; };
    if (b.some(x => lo(x) == null)) return; const tot = b.reduce((a, x) => a + x.v, 0), grp = (f, t) => b.filter(x => lo(x) >= f && lo(x) < t).reduce((a, x) => a + x.v, 0) / tot;
    $('#pDist .ax-card-f').insertAdjacentHTML('afterbegin', `<p class="ax-meta">Short (&lt;5 min) ${AX.fmt('ratio', grp(0, 5), true)} · Medium (5–30) ${AX.fmt('ratio', grp(5, 30), true)} · Long (30+) ${AX.fmt('ratio', grp(30, 1e9), true)}</p>`);
  });
  mount('pCoh', { type: 'bar', title: 'Playtime by player age', series: [{ metric: 'RFYD1Playtime', name: 'Day 1' }, { metric: 'RFYD2To7Playtime', name: 'Days 2–7' }, { metric: 'RFYD8To28Playtime', name: 'Days 8–28' }], gran: 'OneWeek' }, ctx);
  mount('pPlat', { type: 'line', title: 'Session length by platform', series: [{ metric: 'AverageSessionLengthMinutes' }], split: 'Platform' }, ctx);
  mount('pFreq', AX.PRESETS.frequency, ctx);
  mount('pTotal', { type: 'bar', title: 'Total playtime', series: [{ metric: 'TotalPlayTimeHours' }], forecast: AX.has('forecasts') }, ctx);
};

/* ---------- Progression ---------- */
const MODES = {
  simulator: { label: 'Simulator', stage: 'Level', extras: 'levels, rebirths, pets, upgrades and power growth' },
  tycoon: { label: 'Tycoon', stage: 'Stage', extras: 'production, income, purchases and expansion' },
  collection: { label: 'Collection', stage: 'Tier', extras: 'collection completion, rarity and unlocks' },
  rpg: { label: 'RPG', stage: 'Level', extras: 'XP, levels, quests, skills and equipment' },
  survival: { label: 'Survival', stage: 'Day', extras: 'days survived, milestones and resources' },
  incremental: { label: 'Incremental', stage: 'Prestige', extras: 'prestiges, upgrades and currency growth' },
  custom: { label: 'Custom', stage: 'Stage', extras: 'your own milestones and stages' },
};
AX.MODES = MODES;
const stageNum = s => { const m = String(s).match(/(\d+(?:\.\d+)?)/); return m ? +m[1] : NaN; };
AX.pages.progression = async () => {
  await AX.load();
  const v = $('#view');
  v.innerHTML = head('Progression') + (AX.games().length ? AX.toolbar() : '');
  if (!guard(v)) return;
  const ctx = AX.ctx(), g = ctx.game, cfg = (g.progression ||= { mode: g.genre && MODES[g.genre] ? g.genre : 'simulator' }), M = MODES[cfg.mode] || MODES.custom, stageL = cfg.stageLabel || M.stage;
  const persist = () => { if (!g.demoAnalytics) save(); };
  const d = await AX.query({ games: [g.id], metrics: ['FunnelUserTotalCount', 'CustomEventAvgValue', 'EconomyTransactionAmount', 'EconomyAverageWalletBalance', 'ProgressionPlayers', 'ProgressionMinutesToStage', 'MilestoneCompletionRate', 'UpgradePurchases', 'CurrencyEarned', 'CurrencySpent', 'CurrencyBalance', 'DailyActiveUsers'], gran: 'OneDay', from: ctx.range.from, to: ctx.range.to, breakdown: '*' }).catch(e => ({ series: [], err: e }));
  const dNone = await AX.query({ games: [g.id], metrics: ['FunnelUserTotalCount', 'CustomEventAvgValue', 'ProgressionPlayers', 'ProgressionMinutesToStage', 'MilestoneCompletionRate', 'UpgradePurchases'], gran: 'None', from: ctx.range.from, to: ctx.range.to, breakdown: '*' }).catch(() => ({ series: [] }));
  const all = [...new Map([...d.series, ...dNone.series].map(x => [`${x.metric}|${x.breakdown}|${x.source}`, x])).values()], part = (s, k) => (s.breakdown.split('|').find(x => x.startsWith(k + '=')) || '').split('=')[1];
  const funnels = [...new Set(all.filter(s => s.metric === 'FunnelUserTotalCount').map(s => part(s, 'FunnelName')))].filter(Boolean);
  const events = [...new Set(all.filter(s => s.metric === 'CustomEventAvgValue').map(s => part(s, 'CustomEventName')))].filter(Boolean);
  const fn = cfg.funnel && funnels.includes(cfg.funnel) ? cfg.funnel : funnels[0], ev = cfg.event && events.includes(cfg.event) ? cfg.event : events.find(e => /level|stage|minute|time/i.test(e)) || events[0];
  // Players reaching each stage: Roblox funnel (users per step) or uploaded ProgressionPlayers.
  const latest = s => s.points[s.points.length - 1]?.[1];
  let reach = all.filter(s => s.metric === 'FunnelUserTotalCount' && part(s, 'FunnelName') === fn).map(s => [stageNum(part(s, 'FunnelStep')), latest(s), s.source]);
  if (!reach.length) reach = all.filter(s => s.metric === 'ProgressionPlayers').map(s => [stageNum(part(s, 'Stage')) || part(s, 'Stage'), latest(s), s.source]);
  reach = reach.filter(r => r[1] != null).sort((a, b) => a[0] - b[0]);
  let ttl = all.filter(s => s.metric === 'CustomEventAvgValue' && part(s, 'CustomEventName') === ev).map(s => [stageNum(part(s, 'CustomField1')), latest(s), s.source]);
  if (!ttl.length) ttl = all.filter(s => s.metric === 'ProgressionMinutesToStage').map(s => [stageNum(part(s, 'Stage')), latest(s), s.source]);
  ttl = ttl.filter(r => isFinite(r[0]) && r[1] != null).sort((a, b) => a[0] - b[0]);
  const drops = reach.slice(1).map((r, i) => ({ stage: r[0], from: reach[i][0], rate: reach[i][1] ? 1 - r[1] / reach[i][1] : null })).filter(x => x.rate != null).sort((a, b) => b.rate - a.rate).slice(0, 3);
  const scanEco = g.studio?.scan?.economy || [];
  v.insertAdjacentHTML('beforeend', `<div class="ax-controls"><label class="ax-sel">Game type <select id="gMode">${Object.entries(MODES).map(([k, x]) => `<option value="${k}" ${k === cfg.mode ? 'selected' : ''}>${x.label}</option>`).join('')}</select></label>
      <label class="ax-sel">${esc(M.stage)} label <input id="gStage" value="${esc(stageL)}" maxlength="20" style="width:110px"></label>
      ${funnels.length ? `<label class="ax-sel">Funnel <select id="gFunnel">${funnels.map(f => `<option ${f === fn ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label>` : ''}
      ${events.length ? `<label class="ax-sel">Time event <select id="gEvent">${events.map(f => `<option ${f === ev ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label>` : ''}</div>
    ${!reach.length && !ttl.length && !all.some(s => /Economy|Currency/.test(s.metric)) ? `<div class="card ax-empty-state"><h2>No player progression data yet.</h2><p class="muted small">A Studio scan shows how your game is built, not how players move through it. Add the LaunchPad events to your game (Roblox AnalyticsService) or upload a progression file.</p><div class="row" style="gap:10px;justify-content:center"><a class="btn" href="#/data?tab=instrument">Add tracking</a><a class="btn ghost" href="#/data?tab=upload">Upload data</a></div></div>` : ''}
    <div class="ax-grid">
      ${slot('gReach', 8, 2, `Players reaching each ${stageL.toLowerCase()}`)}
      <article class="card ax-card" style="--w:4;--h:2"><header class="ax-card-h"><div class="ax-card-t"><h3>Biggest drop-offs</h3>${reach.length ? AX.chip('calc') : ''}</div></header><div class="ax-body">${drops.length ? `<ol class="ax-drops">${drops.map(x => `<li><b>${esc(stageL)} ${esc(x.from)} → ${esc(x.stage)}</b><span class="t-num">${AX.fmt('ratio', x.rate)}</span><small class="muted">of players stop here</small></li>`).join('')}</ol>
        ${(() => { const n = reach.length, endStart = Math.floor(n * 0.8), share = n >= 5 && reach[0][1] ? reach[endStart][1] / reach[0][1] : null; return share != null ? `<p class="small" style="margin:14px 0 0"><b>${AX.fmt('ratio', share)}</b> reach the last fifth (${esc(stageL)} ${esc(reach[endStart][0])}+).</p>` : ''; })()}` : '<p class="small muted">Needs players-per-stage data.</p>'}</div></article>
      ${slot('gStop', 6, 2, `Where players stop`)}${slot('gTime', 6, 2, `Time to reach each ${stageL.toLowerCase()}`)}
      ${slot('gEco', 8, 2, 'Currency earned vs spent')}${slot('gBal', 4, 2, 'Average balance')}
      ${slot('gMile', 6, 2, 'Milestone completion')}${slot('gUpg', 6, 2, 'Upgrade purchases')}
      ${scanEco.length ? `<article class="card ax-card" style="--w:12;--h:1"><header class="ax-card-h"><div class="ax-card-t"><h3>Upgrade prices from your Studio scan</h3><span class="ax-kind">Structure</span></div></header><div class="ax-body"><div class="table-wrap"><table><thead><tr><th>Item</th><th>Cost</th><th>Income</th><th>Found in</th></tr></thead><tbody>${scanEco.slice(0, 30).map(e => `<tr><td>${esc(e.name)}</td><td>${AX.fmt('amount', e.cost)}</td><td>${e.income != null ? AX.fmt('amount', e.income) : '—'}</td><td class="tiny muted">${esc(e.path)}</td></tr>`).join('')}</tbody></table></div><p class="tiny faint">How the game is set up, not what players did.</p></div></article>` : ''}
      <article class="card ax-card" style="--w:12;--h:1"><header class="ax-card-h"><div class="ax-card-t"><h3>Progression findings</h3></div></header><div class="ax-body">${AX.findingsHTML(g, 'progression')}</div></article></div>`);
  AX.bindToolbar(v, () => AX.pages.progression()); bindMenus(v);
  $('#gMode').onchange = e => { cfg.mode = e.target.value; delete cfg.stageLabel; persist(); AX.pages.progression(); };
  $('#gStage').onchange = e => { cfg.stageLabel = e.target.value.trim().slice(0, 20) || undefined; persist(); AX.pages.progression(); };
  $('#gFunnel') && ($('#gFunnel').onchange = e => { cfg.funnel = e.target.value; persist(); AX.pages.progression(); });
  $('#gEvent') && ($('#gEvent').onchange = e => { cfg.event = e.target.value; persist(); AX.pages.progression(); });
  const put = (id, spec, kinds = [], note = '') => { const el = $('#' + id); $('.ax-body', el).removeAttribute('aria-busy'); el._spec = spec; $('.ax-chips', el).innerHTML = [...new Set(kinds)].map(k => AX.chip(k)).join(''); AX.chart($('.ax-body', el), spec); $('.ax-card-f', el).innerHTML = note ? `<p class="ax-note">${note}</p>` : ''; };
  const catSpec = (rows, name, unit, kind) => ({ type: 'bar', x: 'cat', cats: rows.map(r => `${stageL} ${r[0]}`), series: [{ id: name, name, unit, kind, points: rows.map((r, i) => [i, r[1]]) }] });
  reach.length ? put('gReach', catSpec(reach, 'Players', 'count', reach[0][2]), [reach[0][2]], fn ? `Funnel “${esc(fn)}” · unique users per step, last 28 days.` : 'Uploaded.') : put('gReach', { empty: 'No players-per-stage data. Log a funnel step per level (see Data → Tracking) or upload it.' });
  reach.length > 1 ? put('gStop', catSpec(reach.map((r, i) => [r[0], i + 1 < reach.length ? r[1] - reach[i + 1][1] : r[1]]), 'Players who stopped', 'count', 'calc'), ['calc'], 'Players who reached a stage but not the next (reach minus the next stage\'s reach). The last bar includes players still progressing.') : put('gStop', { empty: 'Needs players per stage.' });
  ttl.length ? put('gTime', { type: 'line', x: 'cat', cats: ttl.map(r => `${stageL} ${r[0]}`), series: [{ id: 'ttl', name: 'Average minutes played', unit: 'minutes', kind: ttl[0][2], points: ttl.map((r, i) => [i, r[1]]) }] }, [ttl[0][2]], ev ? `Average value of custom event “${esc(ev)}” by ${esc(stageL.toLowerCase())} (log minutes played when the ${esc(stageL.toLowerCase())} is reached).` : '') : put('gTime', { empty: 'No time-to-stage data. Log a custom event with minutes played when a stage is reached.' });
  // Economy: Roblox economy events (FlowType Source = earned, Sink = spent) or uploaded earned/spent. Net = earned − spent (calculated).
  const ecoR = d.series.filter(s => s.metric === 'EconomyTransactionAmount'), curr = [...new Set(ecoR.map(s => part(s, 'CurrencyType')))];
  const cur = cfg.currency && curr.includes(cfg.currency) ? cfg.currency : curr[0];
  let earned = ecoR.find(s => part(s, 'FlowType') === 'Source' && part(s, 'CurrencyType') === cur), spent = ecoR.find(s => part(s, 'FlowType') === 'Sink' && part(s, 'CurrencyType') === cur);
  if (!earned) { earned = d.series.find(s => s.metric === 'CurrencyEarned'); spent = d.series.find(s => s.metric === 'CurrencySpent'); }
  if (earned) {
    const net = spent ? AX.evalFormula(AX.parseFormula('A-B', ['A', 'B']), { A: earned, B: spent }).points : [];
    put('gEco', { type: 'bar', series: [{ id: 'e', name: 'Earned', unit: 'amount', kind: earned.source, points: earned.points }, ...(spent ? [{ id: 's', name: 'Spent', unit: 'amount', kind: spent.source, points: spent.points, color: 'var(--ax2)' }] : []), ...(net.length ? [{ id: 'n', name: 'Net (earned − spent)', unit: 'amount', kind: 'calc', points: net, color: 'var(--ax3)', line: true }] : [])], annotations: ctx.annotations },
      [earned.source, ...(net.length ? ['calc'] : [])], `${cur ? `Currency: ${esc(cur)}. ` : ''}A rising net means more currency is entering the economy than leaving it (inflation pressure).`);
  } else put('gEco', { empty: 'No economy data. Log AnalyticsService:LogEconomyEvent for earning and spending, or upload it.' });
  const bal = d.series.find(s => s.metric === 'EconomyAverageWalletBalance' && (!cur || part(s, 'CurrencyType') === cur)) || d.series.find(s => s.metric === 'CurrencyBalance');
  bal ? put('gBal', { type: 'line', series: [{ id: 'b', name: 'Average balance', unit: 'amount', kind: bal.source, points: bal.points }] }, [bal.source]) : put('gBal', { empty: 'No balance data.' });
  const mile = all.filter(s => s.metric === 'MilestoneCompletionRate'), upg = all.filter(s => s.metric === 'UpgradePurchases');
  mile.length ? put('gMile', { type: 'bar', x: 'cat', cats: mile.map(s => part(s, 'Milestone')), series: [{ id: 'm', name: 'Completion', unit: 'ratio', kind: mile[0].source, points: mile.map((s, i) => [i, latest(s)]) }] }, [mile[0].source]) : put('gMile', { empty: 'Upload milestone completion rates to see them here.' });
  upg.length ? put('gUpg', { type: 'bar', x: 'cat', cats: upg.map(s => part(s, 'Upgrade')), series: [{ id: 'u', name: 'Purchases', unit: 'count', kind: upg[0].source, points: upg.map((s, i) => [i, s.points.reduce((a, p) => a + p[1], 0)]) }] }, [upg[0].source], 'Total purchases in the range.') : put('gUpg', { empty: 'Upload upgrade purchases to see adoption.' });
};
})();
(() => {
const AX = window.AX, DAY = AX.DAY;
const uid = () => 'c' + Math.random().toString(36).slice(2, 10);

/* ---------- Chart Builder ---------- */
const GROUPS = { retention: 'Retention', cohort: 'Cohorts', engagement: 'Engagement', playtime: 'Playtime', acquisition: 'Acquisition', progression: 'Progression', economy: 'Economy' };
const metricOptions = cur => Object.entries(GROUPS).map(([gk, gl]) => `<optgroup label="${gl}">${Object.entries(AX.catalog.metrics).filter(([, d]) => d.group === gk).map(([k, d]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}</optgroup>`).join('');
AX.pages.charts = async (q = {}, id) => {
  await AX.load();
  const v = $('#view'), games = AX.games(), saved = AX.demo ? (S().axCharts ||= []) : await api('GET', '/api/charts').catch(() => []);
  const dashes = await AX.dashList(), dash = q.dash ? dashes.find(d => d.id === q.dash) : null, widget = dash && q.widget ? dash.widgets.find(w => w.id === q.widget) : null;
  const pf = AX.P();
  let cfg = widget?.chart ? JSON.parse(JSON.stringify(widget.chart)) : id ? JSON.parse(JSON.stringify(saved.find(c => c.id === id)?.config || null)) : q.c ? AX.decode(q.c) : null;
  cfg ||= { type: pf.chartType || 'line', title: '', series: [{ metric: 'DailyActiveUsers' }], gran: pf.gran || 'OneDay', compare: pf.compare || 'none', scale: 'auto' };
  let savedId = id && saved.some(c => c.id === id) ? id : null;
  if (!games.length) { v.innerHTML = '<header class="page-head"><h1>Chart Builder</h1></header>' + AX.noGames(); return; }
  v.innerHTML = `<header class="page-head row between"><h1>Chart Builder</h1><div class="row" style="gap:8px">${widget || dash ? `<button class="btn" id="cbDash">${widget ? 'Update widget' : `Add to ${esc(dash.name)}`}</button>` : `<button class="btn ghost" id="cbAddDash">Add to dashboard</button>`}<button class="btn ${widget || dash ? 'ghost' : ''}" id="cbSave">${savedId ? 'Save changes' : 'Save chart'}</button></div></header>${AX.demoBanner()}
    <div class="cb"><div class="cb-main">${AX.toolbar()}<article class="card ax-card" id="cbCard" style="--w:12;--h:2"><header class="ax-card-h"><div class="ax-card-t"><h3 id="cbTitle"></h3><span class="ax-chips"></span></div><div class="ax-card-a"><button class="icon-btn" data-act="menu" aria-label="Export">${icon('download', 18)}</button></div></header><div class="ax-body ax-h3"></div><footer class="ax-card-f"></footer></article>
      ${saved.length ? `<section class="ax-sec"><div class="ax-sec-h"><h2>Saved charts</h2></div><div class="ax-saved">${saved.map(c => `<div class="ax-saved-i"><a href="#/charts/${esc(c.id)}">${esc(c.name)}</a><span class="tiny muted">${c.updated_at ? timeAgo(Date.parse(c.updated_at)) : ''}</span><button class="icon-btn" data-del="${esc(c.id)}" aria-label="Delete ${esc(c.name)}">${icon('trash', 15)}</button></div>`).join('')}</div></section>` : ''}</div>
    <aside class="cb-side card" aria-label="Chart settings"><div id="cbPanel"></div></aside></div>`;
  AX.bindToolbar(v, () => draw());
  const ctx = () => AX.ctx();
  const panel = () => {
    const types = AX.validTypes(cfg), letters = cfg.series.filter(s => !s.formula).map((_, i) => String.fromCharCode(65 + i)), multi = AX.has('cross_experience_overview');
    const dims = [...new Set(cfg.series.filter(s => s.metric).flatMap(s => AX.def(s.metric).dims))].filter(d => !['CohortDay', 'CohortWeek', 'FunnelStep', 'CustomField1', 'SessionTimeBucket'].includes(d));
    const native = g => cfg.series.filter(s => s.metric).every(s => AX.def(s.metric).grans.includes(g));
    $('#cbPanel').innerHTML = `<div class="cb-row"><span class="label">Chart type</span><div class="seg ax-seg" role="group" aria-label="Chart type">${Object.entries(AX.TYPES).filter(([k]) => types.includes(k)).map(([k, l]) => `<button type="button" data-type="${k}" aria-pressed="${(types.includes(cfg.type) ? cfg.type : types[0]) === k}">${l}</button>`).join('')}</div></div>
      <div class="cb-row"><span class="label">Series</span><ol class="cb-series">${cfg.series.map((s, i) => s.formula ? `<li><span class="cb-l">ƒ</span><input data-f="${i}" value="${esc(s.formula)}" aria-label="Formula" spellcheck="false"><input data-fn="${i}" value="${esc(s.name || '')}" placeholder="Name" aria-label="Name"><select data-fu="${i}" aria-label="Unit"><option value="">Auto unit</option>${['ratio', 'count', 'minutes', 'hours', 'amount', 'number'].map(u => `<option value="${u}" ${s.unit === u ? 'selected' : ''}>${AX.unitLabel(u)}</option>`).join('')}</select><button class="icon-btn" data-rm="${i}" aria-label="Remove">${icon('x', 14)}</button></li>`
        : `<li><span class="cb-l">${String.fromCharCode(65 + cfg.series.filter((x, j) => !x.formula && j < i).length)}</span><select data-m="${i}" aria-label="Metric">${metricOptions(s.metric)}</select>
          ${games.length > 1 && multi ? `<select data-g="${i}" aria-label="Game"><option value="">Selected game</option>${games.map(g => `<option value="${esc(g.id)}" ${s.game === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>` : ''}
          <select data-src="${i}" aria-label="Source"><option value="auto">Best source</option><option value="roblox" ${s.source === 'roblox' ? 'selected' : ''}>Roblox only</option><option value="upload" ${s.source === 'upload' ? 'selected' : ''}>Uploaded only</option></select>
          ${cfg.series.length > 1 ? `<button class="icon-btn" data-rm="${i}" aria-label="Remove">${icon('x', 14)}</button>` : ''}<span class="tiny muted cb-def">${esc(AX.def(s.metric).def)}</span></li>`).join('')}</ol>
        <div class="row" style="gap:6px"><button class="btn ghost sm" id="cbAddS" ${cfg.series.length >= 8 ? 'disabled' : ''}>${icon('plus', 14)} Series</button><button class="btn ghost sm" id="cbAddF" ${AX.has('calculated_metrics') ? '' : 'disabled title="Calculated metrics are part of Max"'}>${icon('plus', 14)} Calculated</button></div>
        ${cfg.series.some(s => s.formula) ? `<p class="tiny muted">Letters ${letters.join(', ')} refer to the series above. Use + − * / and numbers, e.g. <code>A/B*100</code>.</p>` : ''}</div>
      <div class="cb-row"><span class="label">Interval</span><div class="seg ax-seg" role="group" aria-label="Interval">${[['OneDay', 'Daily'], ['OneWeek', 'Weekly'], ['OneMonth', 'Monthly']].map(([k, l]) => `<button type="button" data-gran="${k}" aria-pressed="${(cfg.gran || 'OneDay') === k}" title="${k === 'OneDay' || native(k) ? 'Roblox\'s own aggregation' : 'Summed or averaged from daily values where that\'s valid'}">${l}</button>`).join('')}</div></div>
      <div class="cb-row"><span class="label">Break down by</span><select id="cbSplit"><option value="">Nothing</option>${dims.map(d => `<option ${cfg.split === d ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
      <div class="cb-row"><span class="label">Compare</span><select id="cbCmp">${[['none', 'Nothing'], ['previous', 'Previous period'], ['year', 'A year earlier']].map(([k, l]) => `<option value="${k}" ${cfg.compare === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="cb-row"><label class="check sm"><input type="checkbox" id="cbBm" ${cfg.benchmark ? 'checked' : ''}> Benchmark overlay</label><label class="check sm"><input type="checkbox" id="cbFc" ${cfg.forecast ? 'checked' : ''} ${AX.has('forecasts') ? '' : 'disabled'}> Forecast${AX.has('forecasts') ? '' : ' <span class="tiny muted">(Light, Max)</span>'}</label></div>
      <details class="cb-adv"><summary>More settings</summary>
        <div class="cb-row"><span class="label">Scale</span><div class="seg ax-seg" role="group">${[['auto', 'Actual units'], ['index', 'Indexed (first = 100)']].map(([k, l]) => `<button type="button" data-scale="${k}" aria-pressed="${(cfg.scale || 'auto') === k}">${l}</button>`).join('')}</div><p class="tiny muted">Different units get their own axis (up to two). Indexing compares trends of any units.</p></div>
        <div class="cb-row"><span class="label">Title</span><input id="cbT" value="${esc(cfg.title || '')}" placeholder="Untitled chart" maxlength="80"></div>
        <div class="cb-row"><span class="label">Date range</span><select id="cbRange"><option value="">Use the page/dashboard range</option>${AX.RANGES.filter(r => r[0] !== 'custom').map(([k, l]) => `<option value="${k}" ${cfg.range?.preset === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="cb-row"><button class="btn ghost sm" id="cbLink">Copy link to this chart</button></div></details>`;
    const P = $('#cbPanel');
    P.querySelectorAll('[data-type]').forEach(b => b.onclick = () => { cfg.type = b.dataset.type; change(); });
    P.querySelectorAll('[data-gran]').forEach(b => b.onclick = () => { cfg.gran = b.dataset.gran; change(); });
    P.querySelectorAll('[data-scale]').forEach(b => b.onclick = () => { cfg.scale = b.dataset.scale; change(); });
    P.querySelectorAll('[data-m]').forEach(s => s.onchange = () => { cfg.series[+s.dataset.m].metric = s.value; change(); });
    P.querySelectorAll('[data-g]').forEach(s => s.onchange = () => { cfg.series[+s.dataset.g].game = s.value || undefined; change(); });
    P.querySelectorAll('[data-src]').forEach(s => s.onchange = () => { cfg.series[+s.dataset.src].source = s.value; change(); });
    P.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { cfg.series.splice(+b.dataset.rm, 1); change(); });
    P.querySelectorAll('[data-f]').forEach(s => s.oninput = debounce(() => { cfg.series[+s.dataset.f].formula = s.value; change(false); }, 450));
    P.querySelectorAll('[data-fn]').forEach(s => s.oninput = debounce(() => { cfg.series[+s.dataset.fn].name = s.value; change(false); }, 450));
    P.querySelectorAll('[data-fu]').forEach(s => s.onchange = () => { cfg.series[+s.dataset.fu].unit = s.value || undefined; change(); });
    $('#cbAddS').onclick = () => { const last = cfg.series.filter(s => s.metric).pop(); cfg.series.splice(cfg.series.filter(s => !s.formula).length, 0, { metric: last?.metric || 'DailyActiveUsers' }); change(); };
    $('#cbAddF').onclick = () => { cfg.series.push({ formula: letters.length > 1 ? 'A/B' : 'A*1', name: '' }); change(); };
    $('#cbSplit').onchange = e => { cfg.split = e.target.value; change(); };
    $('#cbCmp').onchange = e => { cfg.compare = e.target.value; change(); };
    $('#cbBm').onchange = e => { cfg.benchmark = e.target.checked; change(); };
    $('#cbFc').onchange = e => { cfg.forecast = e.target.checked; change(); };
    $('#cbT').oninput = debounce(e => { cfg.title = e.target.value; $('#cbTitle').textContent = cfg.title || 'Untitled chart'; }, 200);
    $('#cbRange').onchange = e => { cfg.range = e.target.value ? { preset: e.target.value } : undefined; change(); };
    $('#cbLink').onclick = () => copyText(`${location.origin}/#/charts?c=${AX.encode(cfg)}`).then(() => toast('Link copied. It opens with the viewer\'s own data.'));
  };
  // Only the chart re-renders on a change; series whose data didn't change keep their place without replaying the drawing.
  const draw = async () => { $('#cbTitle').textContent = cfg.title || 'Untitled chart'; const card = $('#cbCard'); card._cfg = cfg; await AX.mountChart(card, cfg, ctx()); };
  // The URL keeps the chart's settings (no data, no ids beyond your own game ids), so a refresh or a copied link reopens it.
  const change = (rePanel = true) => { if (rePanel) panel(); draw(); if (!widget && !savedId) { const h = '#/charts?c=' + AX.encode(cfg); curHash = h; try { history.replaceState(null, '', h); } catch {} } };
  panel(); draw();
  v.querySelector('#cbCard').addEventListener('click', async e => { const b = e.target.closest('[data-act="menu"]'); if (!b) return; const k = await AX.cardMenu(b, null, [['data', 'View data'], ['csv', 'Export CSV'], ['png', 'Export image']]); if (k) AX.exportAction(k, $('#cbCard'), cfg.title || 'chart'); });
  const persist = async () => {
    const name = cfg.title || 'Untitled chart', cid = savedId || uid();
    if (AX.demo) { const c = { id: cid, name, config: cfg, updated_at: new Date().toISOString() }; const i = saved.findIndex(x => x.id === cid); i >= 0 ? saved[i] = c : saved.unshift(c); save(); }
    else await api('PUT', `/api/charts/${cid}`, { name, config: cfg });
    savedId = cid; return cid;
  };
  $('#cbSave').onclick = async () => { try { const cid = await persist(); toast('Chart saved'); go('#/charts/' + cid); } catch (e) { toast(e.message, 'warn'); } };
  const toDash = async d => { if (widget) widget.chart = cfg; else d.widgets.push({ id: 'w' + Math.random().toString(36).slice(2, 9), w: 6, h: 2, chart: cfg });
    AX.saveDash(d); AX.setP('dash', d.id); setTimeout(() => go('#/home'), 550); };
  $('#cbDash') && ($('#cbDash').onclick = () => toDash(dash));
  $('#cbAddDash') && ($('#cbAddDash').onclick = async e => { const k = await AX.cardMenu(e.currentTarget, null, dashes.map(d => [d.id, d.name])); const d = dashes.find(x => x.id === k); if (d) toDash(d); });
  v.querySelectorAll('[data-del]').forEach(b => b.onclick = () => confirmDialog({ title: 'Delete this chart?', message: 'Dashboards that use a copy keep it.', yes: 'Delete', danger: true, onYes: async () => { if (AX.demo) { S().axCharts = saved.filter(c => c.id !== b.dataset.del); save(); } else await api('DELETE', `/api/charts/${b.dataset.del}`); AX.pages.charts({}, null); } }));
};

/* ---------- Data sources ---------- */
const TEMPLATES = {
  retention: { cols: ['date', 'd1_retention', 'd7_retention', 'd30_retention', 'cohort_size'], map: { d1_retention: 'ForwardD1Retention', d7_retention: 'ForwardD7Retention', d30_retention: 'ForwardD30Retention', cohort_size: 'CohortSize' }, rows: [['2026-01-01', '27.4%', '8.6%', '2.9%', 1520], ['2026-01-02', '26.8%', '8.1%', '2.7%', 1488]] },
  sessions: { cols: ['date', 'active_users', 'sessions', 'avg_session_minutes', 'playtime_minutes_per_user', 'total_playtime_hours'], map: { active_users: 'DailyActiveUsers', sessions: 'Visits', avg_session_minutes: 'AverageSessionLengthMinutes', playtime_minutes_per_user: 'AveragePlayTimeMinutesPerDAU', total_playtime_hours: 'TotalPlayTimeHours' }, rows: [['2026-01-01', 4210, 9050, 14.2, 31.0, 2175], ['2026-01-02', 4388, 9420, 14.6, 31.8, 2325]] },
  progression: { cols: ['date', 'stage', 'players_reached', 'avg_minutes_to_reach'], map: { players_reached: 'ProgressionPlayers', avg_minutes_to_reach: 'ProgressionMinutesToStage' }, dim: { stage: 'Stage' }, rows: [['2026-01-31', 'Level 1', 9800, 0], ['2026-01-31', 'Level 2', 8650, 4.5], ['2026-01-31', 'Level 3', 7320, 11.2]] },
  economy: { cols: ['date', 'currency', 'earned', 'spent', 'avg_balance'], map: { earned: 'CurrencyEarned', spent: 'CurrencySpent', avg_balance: 'CurrencyBalance' }, dim: { currency: 'Currency' }, rows: [['2026-01-01', 'Coins', 1250000, 1080000, 5400], ['2026-01-02', 'Coins', 1310000, 1150000, 5470]] },
  milestones: { cols: ['date', 'milestone', 'completion_rate', 'upgrade', 'upgrade_purchases'], map: { completion_rate: 'MilestoneCompletionRate', upgrade_purchases: 'UpgradePurchases' }, dim: { milestone: 'Milestone', upgrade: 'Upgrade' }, rows: [['2026-01-31', 'First rebirth', '18.2%', 'Better rod', 3120]] },
};
AX.templateCSV = k => { const t = TEMPLATES[k]; return [t.cols.join(','), ...t.rows.map(r => r.join(','))].join('\n') + '\n'; };
function parseCSV(text) {
  const rows = [], n = text.length; let row = [], f = '', q = false;
  for (let i = 0; i < n; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',' || c === ';' || c === '\t') { row.push(f); f = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some(x => x !== '')) rows.push(row); row = []; } else f += c; }
  row.push(f); if (row.some(x => x !== '')) rows.push(row);
  return rows;
}
AX.parseCSV = parseCSV;
// Dates → YYYY-MM-DD in the chosen time zone. Date-only values keep their calendar day.
function toDay(raw, fmt, tz) {
  const s = String(raw).trim(); let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/))) { const [a, b] = [+m[1], +m[2]]; const [mo, d] = fmt === 'dmy' ? [b, a] : fmt === 'mdy' ? [a, b] : a > 12 ? [b, a] : b > 12 ? [a, b] : [null, null]; return mo ? iso(+m[3], mo, d) : 'ambiguous'; }
  const t = Date.parse(s); if (isNaN(t)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}
const iso = (y, mo, d) => { const dt = new Date(Date.UTC(y, mo - 1, d)); return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null; };
const num = (raw, ratio) => { let s = String(raw ?? '').trim(); if (!s) return null; const pct = s.endsWith('%'); s = s.replace(/[%\s,]/g, ''); const v = Number(s); if (!isFinite(v)) return NaN; return ratio && (pct || v > 1) ? v / 100 : v; };
AX.toDay = toDay; AX.num = num;

AX.pages.data = async (q = {}) => {
  await AX.load();
  const v = $('#view'), tab = q.tab || 'sources';
  v.innerHTML = `<header class="page-head"><h1>Data</h1></header>${AX.demoBanner()}<nav class="tabs" aria-label="Data sections">${[['sources', 'Sources'], ['upload', 'Upload'], ['instrument', 'Tracking'], ['history', 'History']].map(([k, l]) => `<a href="#/data?tab=${k}" ${k === tab ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav><div id="dBody"></div>`;
  const el = $('#dBody');
  if (AX.demo && tab !== 'instrument') { el.innerHTML = `<div class="card ax-empty-state"><h2>Your data sources live in your account.</h2><p class="muted small">Sign up to connect Roblox analytics, upload files and keep history.</p><button class="btn" id="dSign">Sign up free</button></div>`; $('#dSign').onclick = () => signInModal(); return; }
  if (!AX.games().length && tab !== 'instrument') { el.innerHTML = AX.noGames(); return; }
  return ({ sources: dataSources, upload: dataUpload, instrument: dataInstrument, history: dataHistory })[tab]?.(el);
};
const statusChip = s => `<span class="chip sm ${s === 'ok' ? 'good' : s === 'pending' ? '' : 'warn'}">${{ ok: 'Connected', pending: 'Not checked', unauthorized: 'No permission', not_eligible: 'Not available', error: 'Error' }[s] || esc(s)}</span>`;
async function dataSources(el) {
  const src = await AX.loadSources(true), can = AX.has('roblox_analytics_sync'), games = AX.games();
  el.innerHTML = `<section class="card section"><h2>Roblox analytics</h2>
    <p class="small muted">LaunchPad reads your experience's analytics through Roblox's official Analytics Query API. It uses an Open Cloud API key you create; it never needs your password or cookies.</p>
    ${can ? `<ol class="small ax-steps"><li>In Creator Hub → Open Cloud → <b>API Keys</b>, create a key.</li><li>Under Access Permissions add <b>universe-analytics</b>, select your experience and grant <b>universe.analytics:read</b> only.</li><li>Paste the key below, then link each game to its universe ID.</li></ol>
      <div class="ax-keys">${src.credentials.map(c => `<div class="ax-key"><b>${esc(c.label)}</b><code>${esc(c.key_hint)}</code><span class="tiny muted">Added ${fmtDate(Date.parse(c.created_at))}${c.last_used_at ? ` · used ${timeAgo(Date.parse(c.last_used_at))}` : ''}</span><button class="btn ghost sm" data-delkey="${c.id}">Remove</button></div>`).join('') || '<p class="small muted">No API keys yet.</p>'}</div>
      <div class="form-grid"><div><label class="label" for="dkLabel">Name</label><input id="dkLabel" placeholder="e.g. Main studio key" maxlength="60"></div><div><label class="label" for="dkKey">API key</label><input id="dkKey" type="password" autocomplete="off" spellcheck="false"></div></div><button class="btn" id="dkAdd" style="margin-top:10px">Save key</button>
      <p class="tiny faint">Stored encrypted. LaunchPad never shows it again or sends it to your browser.</p>` : `<p class="small">Syncing Roblox analytics is part of Light and Max. On Free, upload your exported data instead.</p><a class="btn" href="#/pricing">See plans</a>`}</section>
    ${can ? `<section class="card section"><h2>Games</h2><div class="table-wrap"><table><thead><tr><th>Game</th><th>Universe ID</th><th>Key</th><th>Status</th><th>Last sync</th><th></th></tr></thead><tbody>${games.map(g => { const l = src.links.find(x => x.game_id === g.id);
      return `<tr><td>${esc(g.name)}</td><td><input data-uni="${esc(g.id)}" value="${esc(l?.universe_id || g.studio?.universeId || '')}" inputmode="numeric" style="width:130px" aria-label="Universe ID for ${esc(g.name)}"></td>
        <td><select data-key="${esc(g.id)}" aria-label="API key">${src.credentials.map(c => `<option value="${c.id}" ${l?.credential_id === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></td>
        <td>${l ? statusChip(l.status) : '<span class="tiny muted">Not linked</span>'}${l?.status_detail ? `<br><span class="tiny muted">${esc(l.status_detail)}</span>` : ''}</td><td class="small">${l?.last_success_at ? timeAgo(Date.parse(l.last_success_at)) : '—'}</td>
        <td class="row" style="gap:6px;flex-wrap:nowrap"><button class="btn ghost sm" data-link="${esc(g.id)}" ${src.credentials.length ? '' : 'disabled'}>Check &amp; link</button>${l ? `<button class="btn sm" data-sync="${esc(g.id)}" ${l.status === 'ok' || l.status === 'error' ? '' : 'disabled'}>Sync now</button><button class="icon-btn" data-unlink="${esc(g.id)}" aria-label="Unlink">${icon('x', 14)}</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>
      <p class="tiny faint">Each sync fetches ${AX.catalog.syncQueries} queries (retention, engagement, playtime, acquisition, economy, funnels, custom events). Roblox only answers when the key has analytics permission for that universe, and some metrics need enough traffic or Roblox's analytics eligibility. Missing metrics are shown as unavailable, never as zero.</p></section>` : ''}
    <section class="card section"><h2>Other sources</h2><div class="ax-srcs">
      <a class="ax-src" href="#/studio"><b>Roblox Studio plugin</b><span class="small muted">Game structure: upgrades, currencies, systems. Read-only.</span></a>
      <a class="ax-src" href="#/data?tab=upload"><b>Uploads</b><span class="small muted">${src.datasets.length} file(s) imported</span></a>
      <a class="ax-src" href="#/data?tab=instrument"><b>In-game tracking</b><span class="small muted">Progression, economy and custom events via AnalyticsService</span></a></div></section>`;
  $('#dkAdd') && ($('#dkAdd').onclick = async () => { try { await api('POST', '/api/metrics/credentials', { label: $('#dkLabel').value, apiKey: $('#dkKey').value }); toast('Key saved'); dataSources(el); } catch (e) { toast(e.message, 'warn'); } });
  el.querySelectorAll('[data-delkey]').forEach(b => b.onclick = () => confirmDialog({ title: 'Remove this API key?', message: 'Linked games stop syncing. Also delete it in Creator Hub so it can\'t be used anywhere.', yes: 'Remove', danger: true, onYes: async () => { const r = await api('DELETE', `/api/metrics/credentials/${b.dataset.delkey}`); toast(r.message); dataSources(el); } }));
  el.querySelectorAll('[data-link]').forEach(b => b.onclick = async () => { const g = b.dataset.link; b.disabled = true; b.textContent = 'Checking…';
    try { const r = await api('PUT', `/api/metrics/links/${encodeURIComponent(g)}`, { universeId: el.querySelector(`[data-uni="${CSS.escape(g)}"]`).value.trim(), credentialId: el.querySelector(`[data-key="${CSS.escape(g)}"]`).value });
      toast(r.status === 'ok' ? 'Linked. Roblox confirmed access.' : r.detail || 'Roblox didn\'t confirm access.', r.status === 'ok' ? undefined : 'warn'); } catch (e) { toast(e.message, 'warn'); } dataSources(el); });
  el.querySelectorAll('[data-sync]').forEach(b => b.onclick = async () => { try { await api('POST', `/api/metrics/sync/${encodeURIComponent(b.dataset.sync)}`); AX.bust(); toast('Sync started. New data appears in a few minutes.'); dataSources(el); } catch (e) { toast(e.message, 'warn'); } });
  el.querySelectorAll('[data-unlink]').forEach(b => b.onclick = async () => { const r = await api('DELETE', `/api/metrics/links/${encodeURIComponent(b.dataset.unlink)}`); toast(r.message); dataSources(el); });
}
async function dataHistory(el) {
  const src = await AX.loadSources(true), gname = id => AX.game(id)?.name || id;
  el.innerHTML = `<section class="card section"><h2>Imports</h2>${src.datasets.length ? `<div class="table-wrap"><table><thead><tr><th>File</th><th>Game</th><th>Contains</th><th>Rows</th><th>Time zone</th><th>Imported</th><th></th></tr></thead><tbody>${src.datasets.map(d => `<tr><td>${esc(d.filename)}</td><td>${esc(gname(d.game_id))}</td><td>${esc(d.kind)}</td><td>${d.row_count.toLocaleString()}</td><td>${esc(d.timezone)}</td><td>${fmtDateTime(Date.parse(d.created_at))}</td><td><button class="btn ghost sm" data-delds="${d.id}">Delete</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted">No imports yet.</p>'}</section>
    <section class="card section"><h2>Roblox syncs</h2>${src.runs.length ? `<div class="table-wrap"><table><thead><tr><th>Game</th><th>Started</th><th>Status</th><th>Points</th><th>Queries</th></tr></thead><tbody>${src.runs.map(r => { const bad = (r.detail || []).filter(x => x.error);
      return `<tr><td>${esc(gname(r.game_id))}</td><td>${fmtDateTime(Date.parse(r.started_at))}</td><td>${esc(r.status)}</td><td>${r.points.toLocaleString()}</td><td><details><summary class="small">${(r.detail || []).length - bad.length} ok · ${bad.length} unavailable</summary><ul class="tiny">${(r.detail || []).map(x => `<li>${esc(x.metric)} ${esc(x.granularity)}${x.breakdown?.length ? ' by ' + esc(x.breakdown.join(', ')) : ''}: ${x.error ? `<b>${esc(x.error)}</b> ${esc(x.message || '')}` : `${x.points} points`}</li>`).join('')}</ul></details></td></tr>`; }).join('')}</tbody></table></div>` : '<p class="small muted">No syncs yet.</p>'}</section>`;
  el.querySelectorAll('[data-delds]').forEach(b => b.onclick = () => confirmDialog({ title: 'Delete this import?', message: 'Removes every data point that came from this file. Roblox data isn\'t affected.', yes: 'Delete', danger: true, onYes: async () => { await api('DELETE', `/api/metrics/datasets/${b.dataset.delds}`); AX.bust(); toast('Import deleted'); dataHistory(el); } }));
}
// Upload: choose → map columns → check on the server → confirm.
async function dataUpload(el) {
  const games = AX.games(), metrics = Object.entries(AX.catalog.metrics).filter(([, d]) => d.upload), tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let parsed = null, map = {}, dims = {};
  el.innerHTML = `<section class="card section"><h2>Upload data</h2>
    <div class="form-grid"><div><label class="label" for="uGame">Game</label><select id="uGame">${games.map(g => `<option value="${esc(g.id)}" ${g.id === AX.currentGame()?.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div>
      <div><label class="label" for="uKind">Contains</label><select id="uKind">${[['retention', 'Retention'], ['sessions', 'Sessions & playtime'], ['progression', 'Progression'], ['economy', 'Economy'], ['milestones', 'Milestones & upgrades'], ['benchmark', 'Benchmark (comparison group)'], ['other', 'Other']].map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
      <div><label class="label" for="uFile">CSV or JSON file</label><input type="file" id="uFile" accept=".csv,.tsv,.txt,.json,text/csv,application/json"></div></div>
    <p class="tiny faint">Templates: ${Object.keys(TEMPLATES).map(k => `<a href="#" data-tpl="${k}">${k}</a>`).join(' · ')}. Uploaded data is labelled Uploaded and never replaces data synced from Roblox.</p>
    <div id="uMap"></div></section>`;
  el.querySelectorAll('[data-tpl]').forEach(a => a.onclick = e => { e.preventDefault(); const b = new Blob([AX.templateCSV(a.dataset.tpl)], { type: 'text/csv' }), x = document.createElement('a'); x.href = URL.createObjectURL(b); x.download = `launchpad-${a.dataset.tpl}-template.csv`; x.click(); });
  $('#uFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return; if (f.size > 8 * 1024 * 1024) return toast('Files must be 8 MB or smaller. Split larger exports.', 'warn');
    const text = await f.text();
    try {
      if (/\.json$/i.test(f.name) || /^\s*[[{]/.test(text)) { const j = JSON.parse(text), arr = Array.isArray(j) ? j : j.rows || j.data; if (!Array.isArray(arr) || !arr.length || typeof arr[0] !== 'object') throw new Error('JSON must be an array of objects (one per row).'); const cols = [...new Set(arr.flatMap(o => Object.keys(o)))]; parsed = { name: f.name, cols, rows: arr.map(o => cols.map(c => o[c] ?? '')) }; }
      else { const rows = parseCSV(text); if (rows.length < 2) throw new Error('The file needs a header row and at least one data row.'); parsed = { name: f.name, cols: rows[0].map(c => c.trim()), rows: rows.slice(1) }; }
    } catch (x) { return toast(x.message, 'warn'); }
    // Guess mappings from template headers and metric names.
    const guess = c => { const k = c.toLowerCase().replace(/[^a-z0-9]+/g, '_'); for (const t of Object.values(TEMPLATES)) { if (t.map[k]) return { m: t.map[k] }; if (t.dim?.[k]) return { d: t.dim[k] }; } if (AX.catalog.metrics[c]?.upload) return { m: c }; if (/^(date|day|time|timestamp|cohort_date)$/.test(k)) return { date: true }; if (/platform|device/.test(k)) return { d: 'Platform' }; return {}; };
    map = {}; dims = {}; let dateCol = null; parsed.cols.forEach((c, i) => { const gs = guess(c); if (gs.date && dateCol == null) dateCol = i; if (gs.m) map[i] = gs.m; if (gs.d) dims[i] = gs.d; });
    renderMap(dateCol);
  };
  const renderMap = dateCol => {
    const P = $('#uMap'), opts = cur => `<option value="">Ignore</option><option value="@date" ${cur === '@date' ? 'selected' : ''}>Date</option><option value="@sample" ${cur === '@sample' ? 'selected' : ''}>Sample size</option><optgroup label="Breakdown">${['Platform', 'Stage', 'Milestone', 'Upgrade', 'Currency', 'CohortDay', 'IsNewUser'].map(d => `<option value="@d:${d}" ${cur === '@d:' + d ? 'selected' : ''}>${d}</option>`).join('')}</optgroup><optgroup label="Metric">${metrics.map(([k, d]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}</optgroup>`;
    P.innerHTML = `<h3 style="margin-top:22px">Map columns</h3><p class="small muted">${parsed.rows.length.toLocaleString()} rows in ${esc(parsed.name)}. Match each column to what it contains.</p>
      <div class="table-wrap"><table class="ax-map"><thead><tr>${parsed.cols.map((c, i) => `<th>${esc(c)}<br><select data-col="${i}" aria-label="Column ${esc(c)}">${opts(i === dateCol ? '@date' : map[i] || (dims[i] ? '@d:' + dims[i] : ''))}</select></th>`).join('')}</tr></thead><tbody>${parsed.rows.slice(0, 6).map(r => `<tr>${parsed.cols.map((_, i) => `<td>${esc(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="form-grid" style="margin-top:14px"><div><label class="label" for="uFmt">Date format</label><select id="uFmt"><option value="auto">Detect</option><option value="ymd">YYYY-MM-DD</option><option value="mdy">MM/DD/YYYY</option><option value="dmy">DD/MM/YYYY</option></select></div>
        <div><label class="label" for="uTz">Time zone for date-times</label><select id="uTz">${[...new Set(['UTC', tz, 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo', 'Australia/Sydney'])].map(z => `<option ${z === 'UTC' ? 'selected' : ''}>${z}</option>`).join('')}</select></div>
        <div><label class="label" for="uGran">Each row covers</label><select id="uGran"><option value="OneDay">One day</option><option value="OneWeek">One week</option><option value="None">The whole period (snapshot)</option></select></div></div>
      <div id="uCheck" style="margin-top:14px"></div><div class="row" style="gap:8px;margin-top:12px"><button class="btn" id="uGo">Check file</button></div>`;
    P.querySelectorAll('[data-col]').forEach(s => s.onchange = () => { const i = +s.dataset.col; delete map[i]; delete dims[i]; if (s.value === '@date') { P.querySelectorAll('[data-col]').forEach(o => { if (o !== s && o.value === '@date') o.value = ''; }); dateCol = i; } else if (dateCol === i) dateCol = null; if (s.value.startsWith('@d:')) dims[i] = s.value.slice(3); else if (s.value && !s.value.startsWith('@')) map[i] = s.value; });
    $('#uGo').onclick = () => check(dateCol);
  };
  const build = dateCol => {
    const fmt = $('#uFmt').value, zone = $('#uTz').value, gran = $('#uGran').value, sampleCol = [...$$('[data-col]')].find(s => s.value === '@sample')?.dataset.col;
    if (dateCol == null) throw new Error('Choose which column holds the date.');
    if (!Object.keys(map).length) throw new Error('Map at least one column to a metric.');
    const out = [], problems = []; let ambiguous = 0;
    parsed.rows.forEach((r, i) => {
      const day = toDay(r[dateCol], fmt, zone); if (day === 'ambiguous') { ambiguous++; return; } if (!day) { problems.length < 20 && problems.push(`Row ${i + 2}: can't read the date "${String(r[dateCol]).slice(0, 30)}".`); return; }
      const bd = Object.entries(dims).map(([c, d]) => r[c] !== '' && r[c] != null ? `${d}=${String(r[c]).trim().slice(0, 80)}` : null).filter(Boolean).join('|');
      for (const [c, m] of Object.entries(map)) { const def = AX.def(m), val = num(r[c], def.unit === 'ratio'); if (val == null) continue; if (isNaN(val)) { problems.length < 20 && problems.push(`Row ${i + 2}: "${String(r[c]).slice(0, 20)}" in ${parsed.cols[c]} isn't a number.`); continue; }
        out.push([m, day, val, bd, sampleCol != null && r[sampleCol] !== '' ? num(r[sampleCol]) : null, def.grans.includes(gran) ? gran : def.grans[0]]); }
    });
    if (ambiguous) throw new Error(`${ambiguous} dates could be day/month or month/day. Choose the date format.`);
    return { rows: out, problems, zone };
  };
  const check = async dateCol => {
    const box = $('#uCheck'); let b; try { b = build(dateCol); } catch (e) { box.innerHTML = `<p class="ax-note warn">${esc(e.message)}</p>`; return; }
    const body = { gameId: $('#uGame').value, kind: $('#uKind').value, filename: parsed.name, timezone: b.zone, columns: { map, dims }, rows: b.rows };
    try {
      const r = await api('POST', '/api/metrics/upload', { ...body, mode: 'check' });
      box.innerHTML = `<div class="card sunk small"><p><b>${r.valid.toLocaleString()}</b> valid values${r.invalid ? `, <b>${r.invalid}</b> with problems` : ''}${r.duplicates ? `, <b>${r.duplicates}</b> already imported` : ''}.</p>
        ${[...b.problems, ...r.errors].length ? `<ul class="tiny">${[...b.problems, ...r.errors].slice(0, 12).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${r.overlapsRoblox ? '<p class="tiny">This game already has Roblox data for some of these metrics. Both are kept; charts prefer Roblox and label uploads separately.</p>' : ''}
        ${r.errors.length ? '<p class="tiny">Fix the file and choose it again.</p>' : `${r.duplicates ? `<label class="check sm"><input type="radio" name="uDup" value="skip" checked> Skip rows already imported</label><label class="check sm"><input type="radio" name="uDup" value="replace"> Replace them with this file</label>` : ''}<button class="btn" id="uImport" style="margin-top:8px">Import ${r.valid.toLocaleString()} values</button>`}</div>`;
      $('#uImport') && ($('#uImport').onclick = async () => { try { const w = await api('POST', '/api/metrics/upload', { ...body, mode: $('input[name="uDup"]:checked')?.value || 'skip' }); AX.bust(); toast(`Imported ${w.written.toLocaleString()} values`); go('#/data?tab=history'); } catch (e) { toast(e.message, 'warn'); } });
    } catch (e) { box.innerHTML = `<p class="ax-note warn">${esc(e.message)}</p>`; }
  };
}
// Luau the developer reviews and adds to their own game. Server-side only; logs aggregates through Roblox's AnalyticsService.
AX.luau = mode => `-- LaunchPad progression tracking (ModuleScript in ServerScriptService). Review before publishing.
-- Uses Roblox AnalyticsService; data appears in Creator Hub and LaunchPad's Roblox sync after ~24 hours.
-- Don't put personal information in event names or custom fields.
local AnalyticsService = game:GetService("AnalyticsService")
local Tracking = {}

local FUNNEL = "${mode === 'tycoon' ? 'Stages' : mode === 'collection' ? 'Collection' : mode === 'survival' ? 'Days' : mode === 'incremental' ? 'Prestige' : 'Levels'}" -- one funnel step per ${(AX.MODES[mode] || AX.MODES.custom).stage.toLowerCase()}

-- Call when a player reaches a new ${(AX.MODES[mode] || AX.MODES.custom).stage.toLowerCase()} (step 1, 2, 3, …). minutesPlayed: their total playtime so far.
function Tracking.reached(player: Player, step: number, minutesPlayed: number)
	AnalyticsService:LogFunnelStepEvent(player, FUNNEL, tostring(player.UserId), step, "${(AX.MODES[mode] || AX.MODES.custom).stage} " .. step)
	AnalyticsService:LogCustomEvent(player, "LevelReachedMinutes", minutesPlayed, {
		[Enum.AnalyticsCustomFieldKeys.CustomField01.Name] = "${(AX.MODES[mode] || AX.MODES.custom).stage} " .. step,
	})
end

-- Call after currency is actually earned (Source) or spent (Sink). endingBalance: the player's balance afterwards.
-- how / "Shop": a transaction type string (Roblox suggests names from Enum.AnalyticsEconomyTransactionType).
function Tracking.earned(player: Player, currency: string, amount: number, endingBalance: number, how: string)
	AnalyticsService:LogEconomyEvent(player, Enum.AnalyticsEconomyFlowType.Source, currency, amount, endingBalance, how)
end
function Tracking.spent(player: Player, currency: string, amount: number, endingBalance: number, itemSku: string)
	AnalyticsService:LogEconomyEvent(player, Enum.AnalyticsEconomyFlowType.Sink, currency, amount, endingBalance, "Shop", itemSku)
end
${mode === 'simulator' || mode === 'incremental' ? `
-- Rebirths / prestiges as a custom event (count per player).
function Tracking.rebirth(player: Player, rebirthNumber: number)
	AnalyticsService:LogCustomEvent(player, "Rebirth", 1, { [Enum.AnalyticsCustomFieldKeys.CustomField01.Name] = "Rebirth " .. rebirthNumber })
end
` : ''}${mode === 'collection' ? `
-- Collection: one custom event per new item, with its rarity.
function Tracking.collected(player: Player, rarity: string)
	AnalyticsService:LogCustomEvent(player, "ItemCollected", 1, { [Enum.AnalyticsCustomFieldKeys.CustomField01.Name] = rarity })
end
` : ''}${mode === 'rpg' ? `
-- Quests as their own funnel; skills and equipment as custom events.
function Tracking.questStep(player: Player, quest: string, step: number, stepName: string)
	AnalyticsService:LogFunnelStepEvent(player, quest, tostring(player.UserId), step, stepName)
end
` : ''}
return Tracking
`;
function dataInstrument(el) {
  const g = AX.currentGame(), mode = g?.progression?.mode || 'simulator';
  el.innerHTML = `<section class="card section"><h2>In-game tracking</h2><p class="small muted">A Studio scan shows how your game is built. To see how players actually progress, log events from your game's server with Roblox's AnalyticsService. LaunchPad then reads them through the Roblox sync (funnels, economy and custom events).</p>
    <div class="row" style="gap:10px;margin:12px 0"><label class="ax-sel">Game type <select id="iMode">${Object.entries(AX.MODES).map(([k, m]) => `<option value="${k}" ${k === mode ? 'selected' : ''}>${m.label}</option>`).join('')}</select></label><button class="btn ghost sm" id="iCopy">${icon('copy', 15)} Copy</button></div>
    <pre class="ax-code" id="iCode"></pre>
    <ul class="small muted"><li>Optional, and runs only on your server. It never changes your game until you add it yourself.</li><li>Roblox limits: 10 funnels, 100 custom event names, 3 custom fields per event. Economy events only after a successful transaction.</li><li>Follow Roblox's terms and your privacy policy. Don't log names, chat or other personal data.</li><li>Charts show new events about a day after they're logged (Roblox's processing delay).</li></ul></section>`;
  const put = () => { $('#iCode').textContent = AX.luau($('#iMode').value); };
  put(); $('#iMode').onchange = put; $('#iCopy').onclick = () => copyText($('#iCode').textContent).then(() => toast('Copied'));
}

/* ---------- Settings sections (Games, Dashboard & charts, Data & forecasts) ---------- */
AX.settings = {
  async games(el) {
    await AX.load();
    const games = S().games.filter(g => !g.sample);
    el.innerHTML = `<section class="card section"><h2>Games</h2>${games.length ? `<div class="form-grid"><div><label class="label" for="sgDef">Default game</label><select id="sgDef">${games.map(g => `<option value="${esc(g.id)}" ${g.id === S().selectedGameId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div></div>
      <div class="ax-glist">${games.map(g => `<div class="ax-gitem"><div class="row between"><b>${esc(g.name)}</b><div class="row" style="gap:6px"><a class="btn ghost sm" href="#/games/${esc(g.id)}">Open</a><button class="btn ghost sm" data-gedit="${esc(g.id)}">Edit details</button></div></div>
        <p class="tiny muted" style="margin:6px 0">Updates (shown on charts and used for before/after comparisons)</p>
        <ul class="ax-upd">${(g.updates || []).map((u, i) => `<li>${AX.fmtDay(Date.parse(u.at))} · ${esc(u.label)} <button class="icon-btn" data-gdel="${esc(g.id)}" data-i="${i}" aria-label="Remove update">${icon('x', 12)}</button></li>`).join('') || '<li class="tiny muted">None logged</li>'}</ul>
        <div class="row" style="gap:6px"><input type="date" data-gdate="${esc(g.id)}" aria-label="Update date"><input data-glabel="${esc(g.id)}" placeholder="What changed" maxlength="40" aria-label="Update name"><button class="btn ghost sm" data-gadd="${esc(g.id)}">Add update</button></div></div>`).join('')}</div>` : '<p class="small muted">No games yet.</p>'}
      <button class="btn ghost" data-addgame style="margin-top:12px">${icon('plus', 16)} New Game</button></section>`;
    $('#sgDef') && ($('#sgDef').onchange = e => { S().selectedGameId = e.target.value; S().prefs.axGame = e.target.value; save(); toast('Default game saved'); });
    el.querySelectorAll('[data-gedit]').forEach(b => b.onclick = () => gameModal(gameById(b.dataset.gedit)));
    el.querySelectorAll('[data-gadd]').forEach(b => b.onclick = () => { const g = gameById(b.dataset.gadd), d = el.querySelector(`[data-gdate="${CSS.escape(g.id)}"]`).value, l = el.querySelector(`[data-glabel="${CSS.escape(g.id)}"]`).value.trim();
      if (!d) return toast('Choose the update date.', 'warn'); (g.updates ||= []).push({ at: d + 'T00:00:00Z', label: l || 'Update' }); g.updates.sort((a, b) => a.at.localeCompare(b.at)); save(); AX.settings.games(el); });
    el.querySelectorAll('[data-gdel]').forEach(b => b.onclick = () => { const g = gameById(b.dataset.gdel); g.updates.splice(+b.dataset.i, 1); save(); AX.settings.games(el); });
  },
  async dashboard(el) {
    await AX.load();
    const p = AX.P(), list = await AX.dashList();
    el.innerHTML = `<section class="card section"><h2>Dashboard</h2><div class="form-grid">
        <div><label class="label" for="sdDef">Open on</label><select id="sdDef">${list.map(d => `<option value="${esc(d.id)}" ${p.dash === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div>
        <div><label class="label" for="sdRange">Default time range</label><select id="sdRange">${AX.RANGES.filter(r => r[0] !== 'custom').map(([k, l]) => `<option value="${k}" ${(p.range || '28d') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      <label class="check" style="margin-top:12px"><input type="checkbox" id="sdAnim" ${p.noChartMotion ? '' : 'checked'}> Animate charts when they appear or change</label>
      <button class="btn ghost" id="sdReset" style="margin-top:12px">Reset dashboard layout</button></section>
      <section class="card section"><h2>Charts</h2><div class="form-grid">
        <div><label class="label" for="scType">Default chart type</label><select id="scType">${['line', 'area', 'bar', 'stacked', 'table'].map(t => `<option value="${t}" ${(p.chartType || 'line') === t ? 'selected' : ''}>${AX.TYPES[t]}</option>`).join('')}</select></div>
        <div><label class="label" for="scGran">Default interval</label><select id="scGran">${[['OneDay', 'Daily'], ['OneWeek', 'Weekly'], ['OneMonth', 'Monthly']].map(([k, l]) => `<option value="${k}" ${(p.gran || 'OneDay') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div><label class="label" for="scCmp">Default comparison</label><select id="scCmp">${[['none', 'Nothing'], ['previous', 'Previous period'], ['year', 'A year earlier']].map(([k, l]) => `<option value="${k}" ${(p.compare || 'none') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div></section>`;
    const set = (id, k, f = x => x.value) => { $(id).onchange = e => { AX.setP(k, f(e.target)); toast('Saved'); }; };
    set('#sdDef', 'dash'); set('#sdRange', 'range'); set('#scType', 'chartType'); set('#scGran', 'gran'); set('#scCmp', 'compare'); set('#sdAnim', 'noChartMotion', x => !x.checked);
    $('#sdReset').onclick = () => confirmDialog({ title: 'Reset your dashboard?', message: 'Restores the default charts on your first dashboard view.', yes: 'Reset', onYes: () => { list[0].widgets = AX.DEFAULT_WIDGETS(); AX.saveDash(list[0]); toast('Layout reset'); } });
  },
  async data(el) {
    await AX.load(); const src = await AX.loadSources(true).catch(() => ({ credentials: [], links: [], datasets: [] })), e = ME?.entitlement;
    el.innerHTML = `<section class="card section"><h2>Data sources</h2><p class="small">${src.credentials.length} Roblox API key(s) · ${src.links.length} linked game(s) · ${src.datasets.length} upload(s)</p>
        <p class="small muted">Sync frequency: ${e?.features.includes('scheduled_sync') ? `automatic${e.limits.sync_interval_minutes ? `, every ${e.limits.sync_interval_minutes} minutes` : ''}, plus Sync now` : 'manual uploads on Free'}${e?.limits.analytics_history_days ? ` · history: ${e.limits.analytics_history_days} days` : ''}.</p>
        <div class="row" style="gap:8px"><a class="btn ghost" href="#/data">Manage sources</a><a class="btn ghost" href="#/data?tab=history">Imports and syncs</a></div></section>
      <section class="card section"><h2>Delete analytics data</h2><p class="small muted">Removes stored data for one game. Your games, reports and dashboards stay.</p>
        <div class="row" style="gap:8px"><select id="sxGame" aria-label="Game">${AX.games().map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select><select id="sxSrc" aria-label="Data"><option value="upload">Uploaded data</option><option value="benchmark">Benchmarks</option><option value="roblox">Synced Roblox data</option></select><button class="btn danger sm" id="sxGo">Delete</button></div></section>
      <section class="card section"><h2>Forecasts</h2><p class="small">${esc(AX.catalog.forecastMethod)}</p>
        <p class="small muted">Each forecast shows its training period, the number of days used, how complete the data was, a backtest error on the last 14 days and the date it was generated. If there isn't enough stable history, LaunchPad says so instead of guessing.</p>
        <p class="small muted">Benchmarks are comparison groups you upload. Roblox's Analytics API doesn't provide them, and a benchmark is never a prediction.</p>
        <p class="tiny faint" style="margin:12px 0 0">Forecasts and benchmarks are estimates based on available data. They may be inaccurate or fail to predict future performance.</p></section>`;
    $('#sxGo').onclick = () => confirmDialog({ title: 'Delete this data?', message: 'This can\'t be undone. Synced Roblox data can be fetched again with a new sync.', yes: 'Delete', danger: true, onYes: async () => { try { await api('POST', `/api/metrics/data/${encodeURIComponent($('#sxGame').value)}/delete`, { source: $('#sxSrc').value }); AX.bust(); toast('Deleted'); } catch (x) { toast(x.message, 'warn'); } } });
  },
};
})();
