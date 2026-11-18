// Creates (or finds) the LaunchPad Light and Max products and their four recurring USD prices in Paddle,
// then writes the IDs into .env. Safe to re-run: existing products/prices with the same names are reused.
// Usage: node scripts/paddle-setup.ts   (live: PADDLE_ENV=live PADDLE_API_KEY=... ENV_FILE=.env.production node scripts/paddle-setup.ts)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { config } from '../src/config.ts';
import { PRICES } from '../src/plans.ts';

const base = config.paddle.environment === 'live' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
if (!config.paddle.apiKey) throw new Error('Set PADDLE_API_KEY in .env first');
async function call(method: string, path: string, body?: object) {
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${config.paddle.apiKey}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json(); if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j.error)}`); return j.data;
}

const PLANS = [
  { key: 'light', name: 'LaunchPad Light', description: 'Automatic Roblox game analysis across all five LaunchPad optimizers.' },
  { key: 'max', name: 'LaunchPad Max', description: 'Everything in Light plus deeper analysis, more connected experiences and priority scans.' },
] as const;
const out: Record<string, string> = {};
const products = await call('GET', '/products?status=active&per_page=200');
for (const p of PLANS) {
  let prod = products.find((x: any) => x.name === p.name);
  if (!prod) {
    try { prod = await call('POST', '/products', { name: p.name, description: p.description, tax_category: 'saas' }); }
    catch (e: any) { if (!/tax_category/.test(e.message)) throw e; prod = await call('POST', '/products', { name: p.name, description: p.description, tax_category: 'standard' }); }
  }
  out[`PADDLE_PRODUCT_${p.key.toUpperCase()}`] = prod.id;
  const prices = await call('GET', `/prices?product_id=${prod.id}&status=active&per_page=50`);
  for (const interval of ['month', 'year'] as const) {
    const amount = String(PRICES[p.key][interval]), label = interval === 'month' ? 'Monthly' : 'Annual';
    let price = prices.find((x: any) => x.billing_cycle?.interval === interval && x.billing_cycle?.frequency === 1 && x.unit_price.amount === amount && x.unit_price.currency_code === 'USD');
    if (!price) price = await call('POST', '/prices', { product_id: prod.id, name: label, description: `${p.name} ${label.toLowerCase()} (${interval === 'year' ? 'billed once a year, upfront' : 'billed every month'})`,
      unit_price: { amount, currency_code: 'USD' }, billing_cycle: { interval, frequency: 1 }, quantity: { minimum: 1, maximum: 1 }, tax_mode: 'account_setting' });
    // Retire superseded prices for this plan and interval so checkout can only use the current amount.
    for (const old of prices.filter((x: any) => x.id !== price.id && x.billing_cycle?.interval === interval && x.billing_cycle?.frequency === 1)) {
      await call('PATCH', `/prices/${old.id}`, { status: 'archived' }); console.log(`Archived ${p.name} ${label} ${old.id} ($${(Number(old.unit_price.amount) / 100).toFixed(2)})`);
    }
    out[`PADDLE_PRICE_${p.key.toUpperCase()}_${interval === 'month' ? 'MONTHLY' : 'ANNUAL'}`] = price.id;
    console.log(`${p.name} ${label}: ${price.id}  $${(Number(price.unit_price.amount) / 100).toFixed(2)} ${price.unit_price.currency_code} every ${price.billing_cycle.frequency} ${price.billing_cycle.interval}`);
  }
}
const target = process.env.ENV_FILE || '.env';
let env = existsSync(target) ? readFileSync(target, 'utf8') : '';
for (const [k, v] of Object.entries(out)) env = new RegExp(`^${k}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : env.trimEnd() + `\n${k}=${v}\n`;
writeFileSync(target, env);
console.log(`Wrote ${config.paddle.environment} product and price IDs to ${target}`);
