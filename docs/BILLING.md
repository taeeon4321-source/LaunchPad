# Billing (Paddle)

## Plans
Single source: `src/plans.ts` (integer cents). The self-check at the bottom fails startup if the table changes.

| Plan | Monthly | Annual (upfront) | Saving vs 12 × monthly | Discount | Effective monthly |
|---|---:|---:|---:|---:|---:|
| Light | $9.99 | $99.99 | $19.89 | 16.6% | $8.33 |
| Max | $49.99 | $199.99 | $399.89 | 66.7% | $16.67 |

Monthly and annual prices of one plan grant identical features. Limits come from `PLAN_LIMITS_JSON` (unset = not limited).

## Paddle sandbox catalog (created 2026-11-18 by `node scripts/paddle-setup.ts`)
| Price | Paddle price ID | Amount / interval |
|---|---|---|
| Light monthly | `pri_01m7q05rz85enpzsxn6cjdnfqr` | $9.99 USD / 1 month |
| Light annual | `pri_01m7q05t8vf36bbswmgkmwg8pr` | $99.99 USD / 1 year |
| Max monthly | `pri_01m7q05w7w64dt33bwny5n72xj` | $49.99 USD / 1 month |
| Max annual | `pri_01m7qjn55bak7m7v1v8m27gxb8` | $199.99 USD / 1 year (the old $200.00 price `pri_01m7q05x15nabyq12xd5xcd137` is archived) |

Products: LaunchPad Light, LaunchPad Max (IDs in `.env`).

## Paddle live catalog (created 2026-11-18; IDs in `.env.production`, git-ignored; the live API key isn't stored)
| Price | Paddle price ID | Amount / interval |
|---|---|---|
| Light monthly | `pri_01m7q1hq536t4ag2k3j6df625c` | $9.99 USD / 1 month |
| Light annual | `pri_01m7q1hqdyh8rkn5w55es7jyf3` | $99.99 USD / 1 year |
| Max monthly | `pri_01m7q1hrzwdkx75whg1tm13rgv` | $49.99 USD / 1 month |
| Max annual | `pri_01m7q1hs88qjpb22a2y05px1e6` | **$200.00: outdated. Re-run the setup script with the live key to create $199.99 and archive this one.** |

The app still runs on sandbox. Production gets `PADDLE_ENV=live`, the live API key, live client token and live webhook secret from the host's secret manager, plus these price IDs.

## Still needed
1. **Client-side token** (Paddle → Developer tools → Authentication → client-side tokens) → `PADDLE_CLIENT_TOKEN`.
2. **Notification destination** → URL `APP_ORIGIN/api/billing/webhook` (must be public HTTPS; for local testing use a tunnel), events: `subscription.*`, `transaction.*`, `adjustment.*`, `customer.updated` → copy its secret to `PADDLE_WEBHOOK_SECRET`.
3. Approve the checkout domain in Paddle (Checkout settings) for both sandbox and live.
Checkout stays switched off ("Checkout opens soon") until all of these are set.

## Flow
Checkout: the browser sends only `{plan, interval}` → server maps to the configured price ID, ensures a Paddle customer, creates a transaction with `custom_data.user_id` → Paddle.js overlay opens with `transactionId`. The page then waits for the server; **the browser never grants access**.

Webhook `POST /api/billing/webhook`: raw-body HMAC-SHA256 check of `Paddle-Signature` (`ts;h1`, 5-minute tolerance, rotation-safe), idempotent by `event_id`, ordered by `occurred_at` (older snapshots ignored). Handled: `subscription.*` (created, updated, activated, past_due, paused, resumed, canceled), `transaction.completed/paid/payment_failed`, `adjustment.*` (refunds, chargebacks).

Entitlement rules: `active`/`trialing` grant the plan; scheduled cancellation keeps access until Paddle cancels; `past_due` grants access for `PAST_DUE_GRACE_DAYS` (default 0); `paused`/`canceled` → Free. Data is never deleted for billing reasons.

Reconciliation: hourly job re-reads every non-canceled subscription from Paddle and applies it.

Portal: `POST /api/billing/portal` creates a Paddle customer-portal session for the signed-in user's own customer only.

Plan changes: `POST /api/billing/change` → Paddle subscription update (prorated immediately); entitlement changes when Paddle's event arrives.

Provider abstraction: `BillingProvider` in `src/billing.ts`; another provider can implement it without touching routes or entitlements.

