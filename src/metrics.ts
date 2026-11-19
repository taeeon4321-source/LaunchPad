// Metric catalog, the Roblox Analytics Query API adapter and the sync plan.
// Source: https://create.roblox.com/docs/cloud/guides/analytics (+ /metrics). Auth is an Open Cloud API key with
// universe.analytics:read on the experience (x-api-key header); the API has no OAuth flow.

// unit: ratio (0–1, shown as %), count, minutes, hours, amount (in-game currency/Robux).
// summable: values for different days may be added (playtime hours, sessions). Never true for user counts or rates.
// def states the denominator and time window; axis says what the x-axis date means.
export type MetricDef = { label: string; unit: 'ratio' | 'count' | 'minutes' | 'hours' | 'amount'; group: string; def: string; grans: string[]; dims: string[];
  summable?: boolean; axis?: string; roblox?: boolean; upload?: boolean };

const COHORT_AXIS = 'First-play date of the cohort (not the day players returned).';
const RET = ['Platform', 'OperatingSystem', 'Country', 'AgeGroupV2'], ENG = ['Platform', 'IsNewUser', 'OperatingSystem', 'Country', 'AgeGroupV2'];
export const METRICS: Record<string, MetricDef> = {
  ForwardD1Retention: { label: 'D1 retention', unit: 'ratio', group: 'retention', roblox: true, upload: true, grans: ['OneDay'], dims: RET, axis: COHORT_AXIS,
    def: 'Players who first played on a day ÷ those of them who played again 1 day later (Roblox forward retention).' },
  ForwardD7Retention: { label: 'D7 retention', unit: 'ratio', group: 'retention', roblox: true, upload: true, grans: ['OneDay'], dims: RET, axis: COHORT_AXIS,
    def: 'Players who first played on a day ÷ those of them who played again 7 days later. A cohort matures 7 days after its first-play date.' },
  ForwardD30Retention: { label: 'D30 retention', unit: 'ratio', group: 'retention', roblox: true, upload: true, grans: ['OneDay'], dims: RET, axis: COHORT_AXIS,
    def: 'Players who first played on a day ÷ those of them who played again 30 days later. A cohort matures 30 days after its first-play date.' },
  DailyCohortRetention: { label: 'Daily cohort retention', unit: 'ratio', group: 'cohort', roblox: true, upload: true, grans: ['OneDay'], dims: ['CohortDay'], axis: COHORT_AXIS,
    def: 'Share of a daily first-play cohort that played again on each later day (CohortDay).' },
  WeeklyCohortRetention: { label: 'Weekly cohort retention', unit: 'ratio', group: 'cohort', roblox: true, upload: true, grans: ['OneWeek'], dims: ['CohortWeek'], axis: COHORT_AXIS,
    def: 'Share of a weekly first-play cohort that played again in each later week (CohortWeek).' },
  CohortSize: { label: 'Cohort size', unit: 'count', group: 'cohort', upload: true, grans: ['OneDay', 'OneWeek'], dims: [], axis: COHORT_AXIS, def: 'Players who first played in the period (uploaded).' },
  DailyActiveUsers: { label: 'Active users', unit: 'count', group: 'engagement', roblox: true, upload: true, grans: ['OneDay', 'OneWeek', 'OneMonth'], dims: [...ENG, 'AcquisitionSource'],
    def: 'Unique players in the period. Weekly and monthly values use Roblox\'s own OneWeek/OneMonth aggregation of DailyActiveUsers, never a sum of days.' },
  MonthlyActiveUsers: { label: 'MAU', unit: 'count', group: 'engagement', roblox: true, upload: true, grans: ['OneDay'], dims: ENG, def: 'Unique players in the 30 days ending on each day.' },
  DauMauStickiness: { label: 'Stickiness (DAU/MAU)', unit: 'ratio', group: 'engagement', roblox: true, grans: ['OneDay'], dims: ['Platform'], def: 'Daily active users ÷ monthly active users for each day.' },
  AveragePlayTimeMinutesPerDAU: { label: 'Playtime per active user', unit: 'minutes', group: 'playtime', roblox: true, upload: true, grans: ['OneDay', 'OneWeek', 'OneMonth'], dims: ENG,
    def: 'Total playtime ÷ active users, per period.' },
  AverageSessionLengthMinutes: { label: 'Average session length', unit: 'minutes', group: 'playtime', roblox: true, upload: true, grans: ['OneDay', 'OneWeek', 'OneMonth'], dims: ENG, def: 'Total playtime ÷ sessions, per period.' },
  TotalPlayTimeHours: { label: 'Total playtime', unit: 'hours', group: 'playtime', roblox: true, upload: true, summable: true, grans: ['OneDay', 'OneWeek', 'OneMonth'], dims: ENG, def: 'Hours played by all players in the period.' },
  Visits: { label: 'Sessions', unit: 'count', group: 'engagement', roblox: true, upload: true, summable: true, grans: ['OneDay', 'OneWeek', 'OneMonth'], dims: ENG, def: 'Play sessions started in the period (Roblox "Visits").' },
  TotalSessionsEndedInBucket: { label: 'Sessions by length', unit: 'count', group: 'playtime', roblox: true, upload: true, summable: true, grans: ['None', 'OneDay'], dims: ['SessionTimeBucket', 'Platform'],
    def: 'Sessions ended in the period, grouped by session-length bucket (Roblox SessionTimeBucket).' },
  UniqueUsersWithImpressions: { label: 'Users with impressions', unit: 'count', group: 'acquisition', roblox: true, grans: ['None', 'OneDay'], dims: ['Platform', 'AcquisitionSource'], def: 'Unique users who saw the experience in the period.' },
  UniqueUsersWithClicks: { label: 'Users with detail-page visits', unit: 'count', group: 'acquisition', roblox: true, grans: ['None', 'OneDay'], dims: ['Platform', 'AcquisitionSource'], def: 'Unique users who opened the experience details page.' },
  UniqueUsersWithPlaySessions: { label: 'Users who played', unit: 'count', group: 'acquisition', roblox: true, grans: ['None', 'OneDay', 'OneWeek'], dims: ['Platform', 'AcquisitionSource'], def: 'Unique users with a play session.' },
  QualifiedUniqueUsersWithPlaySessions: { label: 'Users with a qualified play', unit: 'count', group: 'acquisition', roblox: true, grans: ['None', 'OneDay', 'OneWeek'], dims: ['Platform', 'AcquisitionSource'],
    def: 'Unique users whose play session met Roblox\'s "qualified" threshold.' },
  // shortcut: Roblox doesn't state the RFY playtime unit; treated as minutes per user. Check against the Creator Dashboard on first real sync.
  RFYD1Playtime: { label: 'Day-1 playtime per user', unit: 'minutes', group: 'playtime', roblox: true, grans: ['OneDay'], dims: [], def: 'Playtime on the first day, per user arriving from Home recommendations (Roblox RFY).' },
  RFYD2To7Playtime: { label: 'Days 2–7 playtime per user', unit: 'minutes', group: 'playtime', roblox: true, grans: ['OneDay'], dims: [], def: 'Playtime on days 2–7, per user arriving from Home recommendations.' },
  RFYD8To28Playtime: { label: 'Days 8–28 playtime per user', unit: 'minutes', group: 'playtime', roblox: true, grans: ['OneDay'], dims: [], def: 'Playtime on days 8–28, per user arriving from Home recommendations.' },
  EconomyTransactionAmount: { label: 'Currency flow', unit: 'amount', group: 'economy', roblox: true, summable: true, grans: ['OneDay', 'OneWeek', 'OneMonth'], dims: ['FlowType', 'CurrencyType'],
    def: 'Currency amounts logged with AnalyticsService:LogEconomyEvent. FlowType Source = earned, Sink = spent.' },
  EconomyAverageWalletBalance: { label: 'Average wallet balance', unit: 'amount', group: 'economy', roblox: true, grans: ['OneDay', 'OneWeek', 'OneMonth'], dims: ['CurrencyType'], def: 'Average ending balance reported by economy events.' },
  FunnelUserStepCompletionRate: { label: 'Funnel step completion', unit: 'ratio', group: 'progression', roblox: true, grans: ['None'], dims: ['FunnelName', 'FunnelStep'],
    def: 'Users who completed a step ÷ users who completed the previous step (AnalyticsService:LogFunnelStepEvent).' },
  FunnelUserTotalCount: { label: 'Users per funnel step', unit: 'count', group: 'progression', roblox: true, grans: ['None'], dims: ['FunnelName', 'FunnelStep'], def: 'Unique users who reached each funnel step in the period.' },
  CustomEventAvgValue: { label: 'Custom event average', unit: 'count', group: 'progression', roblox: true, grans: ['None', 'OneDay'], dims: ['CustomEventName', 'CustomField1'],
    def: 'Average value of a custom event (AnalyticsService:LogCustomEvent), e.g. minutes played when a level was reached.' },
  CustomEventCountUser: { label: 'Users logging a custom event', unit: 'count', group: 'progression', roblox: true, grans: ['None', 'OneDay'], dims: ['CustomEventName', 'CustomField1'], def: 'Unique users who logged the custom event.' },
  // Upload-only progression and economy series (developer data, labelled Uploaded).
  ProgressionPlayers: { label: 'Players per stage', unit: 'count', group: 'progression', upload: true, grans: ['None', 'OneDay'], dims: ['Stage'], def: 'Players who reached each level or stage (uploaded).' },
  ProgressionMinutesToStage: { label: 'Time to reach stage', unit: 'minutes', group: 'progression', upload: true, grans: ['None', 'OneDay'], dims: ['Stage'], def: 'Average minutes of playtime before a player reached the stage (uploaded).' },
  MilestoneCompletionRate: { label: 'Milestone completion', unit: 'ratio', group: 'progression', upload: true, grans: ['None', 'OneDay'], dims: ['Milestone'], def: 'Players who completed the milestone ÷ active players in the period (uploaded).' },
  UpgradePurchases: { label: 'Upgrade purchases', unit: 'count', group: 'progression', upload: true, summable: true, grans: ['None', 'OneDay'], dims: ['Upgrade'], def: 'Upgrade purchases in the period (uploaded).' },
  CurrencyEarned: { label: 'Currency earned', unit: 'amount', group: 'economy', upload: true, summable: true, grans: ['OneDay', 'OneWeek'], dims: ['Currency'], def: 'Currency players earned in the period (uploaded).' },
  CurrencySpent: { label: 'Currency spent', unit: 'amount', group: 'economy', upload: true, summable: true, grans: ['OneDay', 'OneWeek'], dims: ['Currency'], def: 'Currency players spent in the period (uploaded).' },
  CurrencyBalance: { label: 'Average currency balance', unit: 'amount', group: 'economy', upload: true, grans: ['OneDay', 'OneWeek'], dims: ['Currency'], def: 'Average balance held by active players (uploaded).' },
};
export const UPLOAD_KINDS = ['retention', 'sessions', 'progression', 'economy', 'milestones', 'benchmark', 'other'] as const;

// What one sync fetches. Each entry is one Analytics Query API request (range = the sync window).
export const SYNC_PLAN: { metric: string; granularity: string; breakdown?: string[] }[] = [
  ...['ForwardD1Retention', 'ForwardD7Retention', 'ForwardD30Retention', 'DailyActiveUsers', 'MonthlyActiveUsers', 'DauMauStickiness', 'AveragePlayTimeMinutesPerDAU', 'AverageSessionLengthMinutes', 'TotalPlayTimeHours', 'Visits',
    'UniqueUsersWithImpressions', 'UniqueUsersWithClicks', 'UniqueUsersWithPlaySessions', 'QualifiedUniqueUsersWithPlaySessions', 'RFYD1Playtime', 'RFYD2To7Playtime', 'RFYD8To28Playtime'].map(metric => ({ metric, granularity: 'OneDay' })),
  ...['ForwardD1Retention', 'ForwardD7Retention', 'ForwardD30Retention', 'DailyActiveUsers', 'AveragePlayTimeMinutesPerDAU', 'AverageSessionLengthMinutes', 'TotalPlayTimeHours'].map(metric => ({ metric, granularity: 'OneDay', breakdown: ['Platform'] })),
  ...['DailyActiveUsers', 'AveragePlayTimeMinutesPerDAU', 'AverageSessionLengthMinutes', 'TotalPlayTimeHours', 'Visits'].map(metric => ({ metric, granularity: 'OneDay', breakdown: ['IsNewUser'] })),
  { metric: 'DailyActiveUsers', granularity: 'OneWeek' }, { metric: 'DailyActiveUsers', granularity: 'OneMonth' },
  { metric: 'AveragePlayTimeMinutesPerDAU', granularity: 'OneWeek' }, { metric: 'TotalPlayTimeHours', granularity: 'OneWeek' },
  { metric: 'DailyCohortRetention', granularity: 'OneDay', breakdown: ['CohortDay'] }, { metric: 'WeeklyCohortRetention', granularity: 'OneWeek', breakdown: ['CohortWeek'] },
  { metric: 'TotalSessionsEndedInBucket', granularity: 'None', breakdown: ['SessionTimeBucket'] }, { metric: 'TotalSessionsEndedInBucket', granularity: 'None', breakdown: ['SessionTimeBucket', 'Platform'] },
  ...['UniqueUsersWithImpressions', 'UniqueUsersWithClicks', 'UniqueUsersWithPlaySessions', 'QualifiedUniqueUsersWithPlaySessions'].map(metric => ({ metric, granularity: 'None' })),
  { metric: 'EconomyTransactionAmount', granularity: 'OneDay', breakdown: ['FlowType', 'CurrencyType'] }, { metric: 'EconomyAverageWalletBalance', granularity: 'OneDay', breakdown: ['CurrencyType'] },
  { metric: 'FunnelUserTotalCount', granularity: 'None', breakdown: ['FunnelName', 'FunnelStep'] }, { metric: 'FunnelUserStepCompletionRate', granularity: 'None', breakdown: ['FunnelName', 'FunnelStep'] },
  { metric: 'CustomEventAvgValue', granularity: 'None', breakdown: ['CustomEventName', 'CustomField1'] }, { metric: 'CustomEventCountUser', granularity: 'OneDay', breakdown: ['CustomEventName'] },
];

export class RobloxAnalyticsError extends Error {
  status: number; code: number | null; kind: 'unauthorized' | 'unsupported' | 'budget' | 'transient' | 'failed';
  constructor(message: string, status: number, code: number | null, kind: RobloxAnalyticsError['kind']) { super(message); this.status = status; this.code = code; this.kind = kind; }
}
const BASE = 'https://apis.roblox.com/analytics-query-api/';
const POLL_PATH = /^v1\/universes\/\d{1,20}\/operations\/[\w-]{1,200}$/; // only ever poll Roblox's own operation paths
type Fetch = typeof fetch;
export const io = { fetch: ((...a: Parameters<Fetch>) => fetch(...a)) as Fetch, sleep: (ms: number) => new Promise(r => setTimeout(r, ms)) };

// One metrics query: retries 500/503 and plain 429 with backoff, polls long-running operations, maps errors.
export async function queryMetric(apiKey: string, universeId: string, body: Record<string, unknown>) {
  const headers = { 'x-api-key': apiKey, 'Content-Type': 'application/json' };
  let j: any;
  for (let attempt = 0; ; attempt++) {
    const r = await io.fetch(`${BASE}v1/universes/${universeId}/metrics`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    j = await r.json().catch(() => ({}));
    const code = typeof j?.code === 'number' ? j.code : typeof j?.error?.code === 'number' ? j.error.code : null, msg = String(j?.message ?? j?.error?.message ?? r.statusText ?? '').slice(0, 300);
    if (r.status === 401 || r.status === 403) throw new RobloxAnalyticsError('The API key is missing, revoked, or lacks universe.analytics:read for this experience.', r.status, null, 'unauthorized');
    if (r.status === 429 && code === 3000) throw new RobloxAnalyticsError('Too many data points for one query.', 429, 3000, 'budget');
    if ([429, 500, 503].includes(r.status)) {
      if (attempt >= 3) throw new RobloxAnalyticsError(`Roblox is unavailable (${r.status}). Try again later.`, r.status, code, 'transient');
      const ra = Number(r.headers.get('retry-after')); await io.sleep(ra > 0 ? Math.min(ra, 30) * 1000 : 1000 * 2 ** attempt + Math.random() * 300); continue;
    }
    if (r.status === 400) throw new RobloxAnalyticsError(msg || 'Roblox rejected the query.', 400, code, 'unsupported');
    if (r.status === 504) throw new RobloxAnalyticsError('The query timed out at Roblox.', 504, code, 'budget');
    if (!r.ok && r.status !== 202) throw new RobloxAnalyticsError(`Roblox returned ${r.status}.`, r.status, code, 'failed');
    break;
  }
  // Long-running: poll the operation path until done (up to ~60 s).
  for (let i = 0; !j.done; i++) {
    if (i >= 20 || typeof j.path !== 'string' || !POLL_PATH.test(j.path)) throw new RobloxAnalyticsError('The query didn\'t finish in time.', 504, null, 'transient');
    await io.sleep(Math.min(1000 * 1.5 ** i, 8000));
    const r = await io.fetch(BASE + j.path, { headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(30_000) });
    if (r.status === 401 || r.status === 403) throw new RobloxAnalyticsError('The API key lost access to this experience.', r.status, null, 'unauthorized');
    if (r.status >= 500 || r.status === 429) { j = { ...j, done: false }; continue; }
    j = await r.json().catch(() => ({ done: false, path: j.path }));
  }
  if (j.error) throw new RobloxAnalyticsError(String(j.error.message ?? 'The query failed.').slice(0, 300), 200, j.error.code ?? null, j.error.code === 3000 || j.error.code === 1000 ? 'budget' : 'failed');
  return normalize(String(body.metric), j.response);
}

// Response → flat points. Ratios: Roblox doesn't document the scale, so a series with any value above 1 is read as percent.
// shortcut: a percent-scaled series that never exceeds 1% would be misread as a ratio; re-check once real keys are in use.
export function normalize(metric: string, response: any) {
  const isRatio = METRICS[metric]?.unit === 'ratio', out: { breakdown: string; t: string; value: number; status: string }[] = [];
  for (const s of response?.values ?? []) {
    const breakdown = (s.breakdowns ?? []).map((b: any) => `${String(b.dimension).slice(0, 40)}=${String(b.displayValue ?? b.value ?? '').slice(0, 80)}`).join('|');
    const pts = (s.dataPoints ?? []).filter((p: any) => typeof p.value === 'number' && isFinite(p.value) && !isNaN(Date.parse(p.time)));
    const pct = isRatio && pts.some((p: any) => p.value > 1);
    for (const p of pts) out.push({ breakdown, t: new Date(p.time).toISOString(), value: pct ? p.value / 100 : p.value, status: ['Valid', 'Projected', 'NotStatisticallySignificant'].includes(p.status) ? p.status : '' });
  }
  return out;
}

// Splits a range in half until each part fits Roblox's per-query data-point budget.
export async function queryRange(apiKey: string, universeId: string, q: { metric: string; granularity: string; breakdown?: string[] }, start: Date, end: Date, depth = 0): Promise<ReturnType<typeof normalize>> {
  try {
    return await queryMetric(apiKey, universeId, { metric: q.metric, granularity: q.granularity, breakdown: q.breakdown, startTime: start.toISOString(), endTime: end.toISOString() });
  } catch (e) {
    if (!(e instanceof RobloxAnalyticsError) || e.kind !== 'budget' || depth >= 4 || q.granularity === 'None' || end.getTime() - start.getTime() < 14 * 86400e3) throw e;
    const mid = new Date(Math.floor((start.getTime() + end.getTime()) / 2 / 86400e3) * 86400e3);
    return [...await queryRange(apiKey, universeId, q, start, mid, depth + 1), ...await queryRange(apiKey, universeId, q, mid, end, depth + 1)];
  }
}
