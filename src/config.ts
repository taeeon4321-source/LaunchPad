// All runtime configuration comes from environment variables (see .env.example). Nothing secret lives in the frontend.
import { readFileSync, existsSync } from 'node:fs';

// Minimal .env loader for local development; production should inject real environment variables from a secret manager.
if (existsSync('.env') && process.env.NODE_ENV !== 'test') {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const env = (k: string, d = '') => process.env[k] ?? d;
const isProd = env('NODE_ENV') === 'production';

export const config = {
  isProd,
  isTest: env('NODE_ENV') === 'test',
  port: Number(env('PORT', '8787')),
  appOrigin: env('APP_ORIGIN', 'http://localhost:8787'),
  databaseUrl: env('DATABASE_URL'), // empty = embedded PGlite (development and tests only)
  pgliteDir: env('PGLITE_DIR', './.data/pglite'),
  encryptionKey: env('ENCRYPTION_KEY'), // 32 bytes, base64. Required in production.
  sessionDays: Number(env('SESSION_DAYS', '30')),
  sessionIdleDays: Number(env('SESSION_IDLE_DAYS', '7')),
  reauthMinutes: Number(env('REAUTH_MINUTES', '10')),
  google: { clientId: env('GOOGLE_CLIENT_ID') },
  roblox: {
    clientId: env('ROBLOX_CLIENT_ID'),
    clientSecret: env('ROBLOX_CLIENT_SECRET'),
    redirectUri: env('ROBLOX_REDIRECT_URI', `${env('APP_ORIGIN', 'http://localhost:8787')}/api/roblox/callback`),
    scopes: env('ROBLOX_SCOPES', 'openid profile universe:read'),
  },
  paddle: {
    environment: (env('PADDLE_ENV', 'sandbox') as 'sandbox' | 'live'),
    apiKey: env('PADDLE_API_KEY'),
    clientToken: env('PADDLE_CLIENT_TOKEN'),
    webhookSecret: env('PADDLE_WEBHOOK_SECRET'),
    prices: {
      light_month: env('PADDLE_PRICE_LIGHT_MONTHLY'),
      light_year: env('PADDLE_PRICE_LIGHT_ANNUAL'),
      max_month: env('PADDLE_PRICE_MAX_MONTHLY'),
      max_year: env('PADDLE_PRICE_MAX_ANNUAL'),
    } as Record<string, string>,
    products: { light: env('PADDLE_PRODUCT_LIGHT'), max: env('PADDLE_PRODUCT_MAX') } as Record<string, string>,
    pastDueGraceDays: Number(env('PAST_DUE_GRACE_DAYS', '0')), // business decision, not a legal requirement
  },
  // OpenAI (server-side only). Models are chosen per task tier in src/ai.ts; override here without code changes.
  openai: {
    apiKey: env('OPENAI_API_KEY'),
    models: { fast: env('OPENAI_MODEL_FAST', 'gpt-6-luna'), vision: env('OPENAI_MODEL_VISION', 'gpt-6.1-terra'), deep: env('OPENAI_MODEL_DEEP', 'gpt-6.2-sol') },
    // USD per 1M tokens [input, cached input, output]; JSON override e.g. {"gpt-6-luna":[0.1,0.01,0.5]}.
    prices: JSON.parse(env('OPENAI_PRICES_JSON', '{}')) as Record<string, [number, number, number]>,
  },
  email: { provider: env('EMAIL_PROVIDER', 'outbox'), apiKey: env('EMAIL_API_KEY'), from: env('EMAIL_FROM', 'LaunchPad <no-reply@example.invalid>') },
  // Plan limits are business decisions; unset (null) means "no limit configured yet". See BILLING.md.
  planLimits: JSON.parse(env('PLAN_LIMITS_JSON', '{}')) as Record<string, Record<string, number | null>>,
  // A/B experiments shown to visitors, e.g. {"pricing_cta":["choose","start"]}. Empty = no experiments running.
  experiments: JSON.parse(env('EXPERIMENTS_JSON', '{}')) as Record<string, string[]>,
  retention: {
    rawScanDays: Number(env('RETENTION_SCAN_SNAPSHOT_DAYS', '90')),
    securityEventDays: Number(env('RETENTION_SECURITY_EVENT_DAYS', '365')),
    deletedAccountGraceDays: Number(env('RETENTION_DELETION_GRACE_DAYS', '0')),
  },
};

export function assertProductionConfig() {
  if (!isProd) return;
  const missing = ['DATABASE_URL', 'ENCRYPTION_KEY', 'APP_ORIGIN'].filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Missing required production settings: ${missing.join(', ')}`);
  if (!config.appOrigin.startsWith('https://')) throw new Error('APP_ORIGIN must be https in production');
  if (Buffer.from(config.encryptionKey, 'base64').length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded');
}

export const configured = {
  google: () => !!config.google.clientId,
  roblox: () => !!(config.roblox.clientId && config.roblox.clientSecret),
  paddle: () => !!(config.paddle.apiKey && config.paddle.clientToken && config.paddle.webhookSecret && Object.values(config.paddle.prices).every(Boolean)),
  email: () => config.email.provider !== 'outbox' && !!config.email.apiKey,
  openai: () => !!config.openai.apiKey,
};
