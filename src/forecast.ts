// Forecasts for daily metrics: damped linear trend + optional day-of-week seasonality, with an 80% prediction interval.
// Deterministic and explainable. It refuses to forecast when the history is too short, too patchy or just changed.
const DAY = 86400e3, Z80 = 1.2816, PHI = 0.98; // PHI: per-day trend damping so the trend flattens instead of running away
export const FORECAST_METHOD = 'Damped linear trend (φ = 0.98 per day) on up to the last 120 days, plus day-of-week effects when at least 8 weeks of data '
  + 'make them meaningful. 80% prediction interval from the residual spread, widening with the horizon. Projected/immature points and data before a detected level shift are excluded.';

export type Pt = { t: number; v: number };
export type ForecastOpts = { horizon: number; ratio?: boolean; summable?: boolean; updates?: number[]; now?: number };
export type Forecast = { ok: false; reason: string; n: number } | {
  ok: true; method: string; interval: number; generatedAt: string; trainedFrom: string; trainedTo: string; n: number; coverage: number; seasonal: boolean;
  quality: { level: 'good' | 'fair' | 'limited'; notes: string[]; backtestMape: number | null };
  points: { t: string; lo: number; mid: number; hi: number }[]; total: { lo: number; mid: number; hi: number } | null };

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
function ols(xs: number[], ys: number[]) {
  const mx = mean(xs), my = mean(ys); let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const b = sxx ? sxy / sxx : 0; return { a: my - b * mx, b, mx, sxx };
}
// Fits the model on (day index, value) pairs and returns a predictor with its standard error.
function fit(pts: Pt[], day0: number, allowSeason: boolean) {
  const xs = pts.map(p => Math.round((p.t - day0) / DAY)), ys = pts.map(p => p.v);
  let season = Array(7).fill(0), seasonal = false, m = ols(xs, ys);
  const sse = (s: number[], mm = m) => ys.reduce((acc, y, i) => acc + (y - (mm.a + mm.b * xs[i] + s[((xs[i] % 7) + 7) % 7])) ** 2, 0);
  if (allowSeason && pts.length >= 56) {
    const by: number[][] = Array.from({ length: 7 }, () => []);
    ys.forEach((y, i) => by[((xs[i] % 7) + 7) % 7].push(y - (m.a + m.b * xs[i])));
    const s = by.map(r => r.length ? mean(r) : 0), adj = mean(s), cand = s.map(v => v - adj);
    const m2 = ols(xs, ys.map((y, i) => y - cand[((xs[i] % 7) + 7) % 7]));
    if (sse(cand, m2) < 0.9 * sse(season)) { season = cand; m = m2; seasonal = true; } // keep only if it explains ≥10% of the error
  }
  const dof = Math.max(1, pts.length - 2 - (seasonal ? 6 : 0)), sd = Math.sqrt(sse(season) / dof), lastX = xs[xs.length - 1];
  const at = (x: number) => { const k = x - lastX, damp = k > 0 ? (PHI * (1 - PHI ** k)) / (1 - PHI) : k; // trend beyond the last point is damped
    const mid = m.a + m.b * (lastX + damp) + season[((x % 7) + 7) % 7], se = sd * Math.sqrt(1 + 1 / pts.length + ((x - m.mx) ** 2) / (m.sxx || 1));
    return { mid, se }; };
  return { at, seasonal, sd, lastX };
}

export function forecast(series: Pt[], o: ForecastOpts): Forecast {
  const now = o.now ?? Date.now(), notes: string[] = [];
  let pts = [...series].filter(p => isFinite(p.v)).sort((a, b) => a.t - b.t);
  if (pts.length) { const last = pts[pts.length - 1].t; pts = pts.filter(p => p.t > last - 120 * DAY); }
  // A known update inside the window: train on what came after it when there's enough data, otherwise say so.
  const upd = (o.updates ?? []).filter(u => pts.length && u > pts[0].t && u <= pts[pts.length - 1].t).sort((a, b) => b - a)[0];
  if (upd) { const after = pts.filter(p => p.t >= upd); if (after.length >= 28) { pts = after; notes.push(`Trained on data since your update on ${new Date(upd).toISOString().slice(0, 10)}.`); } else notes.push(`Includes data from before your update on ${new Date(upd).toISOString().slice(0, 10)}; results may shift as new data arrives.`); }
  const n = pts.length;
  if (n < 28) return { ok: false, reason: 'Not enough data to generate a reliable forecast.', n };
  const span = Math.round((pts[n - 1].t - pts[0].t) / DAY) + 1, coverage = n / span;
  if (coverage < 0.8) return { ok: false, reason: 'Not enough data to generate a reliable forecast: too many missing days.', n };
  const day0 = pts[0].t, model = fit(pts, day0, true), x = (p: Pt) => Math.round((p.t - day0) / DAY);
  // Hold out the last 14 days: the model fitted on the earlier data predicts them.
  const train = pts.slice(0, -14), test = pts.slice(-14), bm = fit(train, day0, true), resid = test.map(p => p.v - bm.at(x(p)).mid);
  // Level shift: the last two weeks sit far outside what the earlier pattern (trend + noise) explains, so it no longer applies.
  const shift = Math.abs(mean(resid)), noise = Math.max(bm.sd, 1e-9 + Math.abs(mean(train.map(p => p.v))) * 0.01);
  if (shift > 4 * noise && !upd) return { ok: false, reason: 'Not enough data to generate a reliable forecast: the metric changed sharply in the last two weeks.', n };
  // Backtest error on those 14 days (mean absolute percentage error), reported when the earlier window is long enough.
  let backtestMape: number | null = null;
  if (n >= 42) { const errs = test.flatMap((p, i) => Math.abs(p.v) > 1e-9 ? [Math.abs(resid[i]) / Math.abs(p.v)] : []); backtestMape = errs.length ? Math.round(mean(errs) * 1000) / 10 : null; }
  const cv = model.sd / (Math.abs(mean(pts.map(p => p.v))) || 1);
  const level = n >= 56 && coverage >= 0.95 && cv < 0.25 && (backtestMape ?? 0) < 20 ? 'good' : n >= 28 && cv < 0.5 ? 'fair' : 'limited';
  if (cv >= 0.25) notes.push('The metric varies a lot from day to day, so the range is wide.');
  if (coverage < 0.95) notes.push(`${Math.round((1 - coverage) * 100)}% of days in the training window are missing.`);
  const hi = o.ratio ? 1 : Infinity, clip = (v: number) => Math.min(hi, Math.max(0, v)); // rates stay within 0–100%, counts ≥ 0
  const out = [], lastT = pts[n - 1].t; let sMid = 0, sVar = 0;
  for (let k = 1; k <= o.horizon; k++) {
    const x = model.lastX + k, { mid, se } = model.at(x);
    out.push({ t: new Date(lastT + k * DAY).toISOString(), lo: clip(mid - Z80 * se), mid: clip(mid), hi: clip(mid + Z80 * se) });
    sMid += clip(mid); sVar += se * se;
  }
  // Totals assume independent daily errors (stated in the method); only for metrics where days may be added.
  const total = o.summable ? { lo: Math.max(0, sMid - Z80 * Math.sqrt(sVar)), mid: sMid, hi: sMid + Z80 * Math.sqrt(sVar) } : null;
  return { ok: true, method: FORECAST_METHOD, interval: 0.8, generatedAt: new Date(now).toISOString(), trainedFrom: new Date(pts[0].t).toISOString(), trainedTo: new Date(lastT).toISOString(),
    n, coverage: Math.round(coverage * 1000) / 1000, seasonal: model.seasonal, quality: { level, notes, backtestMape }, points: out, total };
}
