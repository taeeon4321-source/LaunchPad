// The one place plans, prices and entitlements are defined. Amounts are integer cents (no floating point).
// Paddle's configured price IDs remain the source of truth for what is actually charged.
import { config } from './config.ts';

export type Plan = 'free' | 'light' | 'max';
export type Interval = 'month' | 'year';

export const PRICES: Record<'light' | 'max', Record<Interval, number>> = {
  light: { month: 999, year: 9999 },
  max: { month: 4999, year: 19999 },
};

const FEATURES: Record<Plan, string[]> = {
  free: ['manual_optimizers', 'manual_scan_import', 'saved_reports', 'analytics_uploads', 'chart_builder', 'ai_analysis'],
  light: ['manual_optimizers', 'manual_scan_import', 'saved_reports', 'roblox_connection', 'studio_plugin', 'studio_automatic_scanning', 'automatic_analysis', 'report_history_standard', 'overrides', 'scheduled_sync',
    'analytics_uploads', 'chart_builder', 'roblox_analytics_sync', 'forecasts', 'multiple_dashboards', 'ai_analysis'],
  max: ['manual_optimizers', 'manual_scan_import', 'saved_reports', 'roblox_connection', 'studio_plugin', 'studio_automatic_scanning', 'automatic_analysis', 'report_history_standard', 'overrides', 'scheduled_sync',
    'advanced_script_analysis', 'report_history_extended', 'priority_queue', 'advanced_monitoring', 'cross_experience_overview',
    'analytics_uploads', 'chart_builder', 'roblox_analytics_sync', 'forecasts', 'multiple_dashboards', 'calculated_metrics', 'ai_analysis', 'ai_comprehensive'],
};

// Limits are configured per deployment (PLAN_LIMITS_JSON). Unset = no limit configured; LaunchPad doesn't invent numbers.
const LIMIT_KEYS = ['connected_experiences', 'monthly_scans', 'sync_interval_minutes', 'report_history_days', 'analytics_history_days', 'dashboards'] as const;
// AI analyses per day on Free. Light and Max have no limit.
export const FREE_AI_ANALYSES_PER_DAY = 1;
export type LimitKey = typeof LIMIT_KEYS[number];

export function planFeatures(plan: Plan) { return FEATURES[plan]; }
export function planLimit(plan: Plan, key: LimitKey): number | null { const v = config.planLimits[plan]?.[key]; return typeof v === 'number' ? v : null; }

const money = (c: number) => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
// Percent with one decimal using integer math: round(saving / yearly * 1000) / 10.
const pct1 = (num: number, den: number) => { const t = Math.round(num * 1000 / den); return `${Math.floor(t / 10)}.${t % 10}`; };

export function savings(plan: 'light' | 'max') {
  const m = PRICES[plan].month, y = PRICES[plan].year, twelve = m * 12, save = twelve - y;
  return { monthly: money(m), annual: money(y), twelveMonthly: money(twelve), saving: money(save), savingCents: save, percent: pct1(save, twelve), effectiveMonthly: money(Math.round(y / 12)) };
}

export function publicCatalog() {
  return (['light', 'max'] as const).map(p => ({ plan: p, name: p === 'light' ? 'Light' : 'Max', prices: PRICES[p], display: savings(p), features: FEATURES[p], limits: Object.fromEntries(LIMIT_KEYS.map(k => [k, planLimit(p, k)])) }));
}

export function priceIdFor(plan: string, interval: string): string | null {
  if (!(plan === 'light' || plan === 'max') || !(interval === 'month' || interval === 'year')) return null;
  return config.paddle.prices[`${plan}_${interval}`] || null;
}
export function planForPriceId(priceId: string): { plan: 'light' | 'max'; interval: Interval } | null {
  for (const [k, v] of Object.entries(config.paddle.prices)) if (v && v === priceId) { const [plan, interval] = k.split('_') as ['light' | 'max', Interval]; return { plan, interval }; }
  return null;
}

// Self-check of the required price table.
const s1 = savings('light'), s2 = savings('max');
if (s1.saving !== '$19.89' || s1.percent !== '16.6' || s1.effectiveMonthly !== '$8.33' || s2.saving !== '$399.89' || s2.percent !== '66.7' || s2.effectiveMonthly !== '$16.67' || s2.twelveMonthly !== '$599.88')
  throw new Error('Plan price table does not match the required prices');
