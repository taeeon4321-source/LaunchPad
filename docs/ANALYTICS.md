# Analytics platform

LaunchPad's analytics combine five sources. Every point stores its source, so charts can label it.

| Source | How it arrives | Label |
|---|---|---|
| Roblox Analytics Query API | Background sync with the developer's Open Cloud API key | Actual |
| Developer uploads (CSV/JSON) | Upload wizard → `POST /api/metrics/upload` | Uploaded |
| Benchmark uploads | Same wizard, "Benchmark" type | Benchmark |
| Derived values (formulas, roll-ups, net currency) | Computed in the browser from the above | Calculated |
| LaunchPad forecasts | `POST /api/metrics/forecast` | Forecast |

The Studio plugin still provides **structure only** (prices, systems). It never stands in for player behaviour.

## Roblox Analytics Query API

- **Endpoint:** `POST https://apis.roblox.com/analytics-query-api/v1/universes/{universeId}/metrics`. Long-running queries return `done: false` plus a `path`. LaunchPad polls `GET https://apis.roblox.com/analytics-query-api/{path}`, and only accepts paths matching `v1/universes/<id>/operations/<id>`.
- **Authentication:** an Open Cloud API key in the `x-api-key` header, with `universe.analytics:read` on the experience. The API has no OAuth flow, so the existing Roblox OAuth connection isn't used for analytics.
  - Keys are AES-256-GCM encrypted at rest.
  - Only a 4-character hint is ever returned or exported.
  - Removing a key in LaunchPad doesn't revoke it. The UI tells the developer to delete it in Creator Hub too.
- **Access check:** linking a game runs a real query (DailyActiveUsers over 7 days). Roblox only answers when the key has analytics permission for that universe, which is how ownership and access are verified.
- **Sync:** `src/sync.ts`, driven by `SYNC_PLAN` in `src/metrics.ts` (one request per metric, granularity and breakdown).
  - The first sync fetches up to 365 days, or the plan's `analytics_history_days`.
  - Later syncs re-fetch the last 35 days, because D30 forward retention keeps changing until a cohort is 30 days old.
  - Distributions and funnels (granularity `None`) are 28-day snapshots.
  - A run that approaches the job timeout continues itself in a new job.
- **Errors:**

  | Response | What LaunchPad does |
  |---|---|
  | 401 | Link status → "No permission". Sync stops so Roblox isn't hammered. |
  | 400 | That query is marked unavailable. If every query returns 400, the link status becomes "Not available" with Roblox's message. |
  | 429 code 3000 (data-point budget) | Splits the date range in half, up to 4 times. |
  | Other 429, 500, 503 | Backoff with jitter, honouring `Retry-After`. |

  Each run's per-query outcome is shown under Data → History. Missing metrics are never stored as zero.
- **Weekly and monthly active users:** stored from Roblox's own `OneWeek`/`OneMonth` aggregation of `DailyActiveUsers`. The client never sums daily active users; the roll-up refuses to.
- **Units:** the API doesn't state the scale for rate metrics. A rate series containing any value above 1 is read as a percentage.
  - Shortcut: a percent-scaled series that never exceeds 1% would be misread. Check once real keys are in use.
  - The RFY playtime metrics are assumed to be minutes per user. Also check against the Creator Dashboard.
- **Not available from Roblox:** benchmarks, progression metrics, cohort sizes and platform-level funnels. LaunchPad shows these as unavailable unless they're uploaded.

## Metric definitions

All metrics are in `METRICS` (`src/metrics.ts`), served by `GET /api/metrics/catalog`. Each entry gives its unit, allowed granularities, dimensions, and a definition stating the denominator and time window.

- **Forward retention** (D1/D7/D30) is plotted by the cohort's **first-play date**, not the return date.
- **Immature cohorts:**
  - KPI cards use only cohorts old enough to be final: the selected range shifted back by the retention day.
  - Points Roblox marks `Projected` are drawn hollow and never train forecasts.
  - Heatmap cells for cohorts that haven't reached day N are hatched, never shown as zero.
- **Retention curve:** the unweighted mean of mature daily cohorts at each CohortDay.
- **Sessions per active user** = Visits ÷ DailyActiveUsers (Calculated). This built-in formula is allowed on every plan.
- **"Where players stop"** = reach(stage) − reach(next stage).
- **Endgame share** = reach(start of the last fifth of stages) ÷ reach(first stage).
- **Totals across games** are shown only for summable metrics (playtime hours). Rates and unique users stay per game.
- **Aggregation:** weekly and monthly views use Roblox's own aggregation where it exists. Otherwise they are sums (summable metrics only) or unweighted means, and the chart says which.

## Forecasts (`src/forecast.ts`)

- **Model:** a damped linear trend (φ = 0.98 per day) over up to the last 120 days, plus day-of-week effects. The weekday effects are kept only with ≥ 8 weeks of data and only if they cut the error by ≥ 10%.
- **Interval:** 80% prediction interval from the residual spread, widening with distance from the training data. Rates are clipped to 0–100% and counts to ≥ 0.
- **When it refuses** ("Not enough data to generate a reliable forecast"):
  - fewer than 28 days of history;
  - more than 20% of days missing;
  - a level shift in the last 14 days. The test: the last 14 days are more than 4 residual standard deviations from what the earlier trend predicts, and no logged update explains it.
- **Logged updates:** Settings → Games. With ≥ 28 days after an update, training starts there; otherwise the forecast notes it.
- **Output:** each forecast reports its method, training window, day count, coverage, seasonality flag, a 14-day backtest error (MAPE), its quality level, and the date generated. Totals (next 7/30 days of playtime) assume independent daily errors.
- **Labelling:** benchmarks and forecasts are separate concepts and are labelled separately on every chart. The disclaimer is in Settings → Data & forecasts.
- **Tests:** `test/insights.test.ts` covers refusal on short or patchy data, trend continuation, band widening, weekday detection, level-shift refusal and rate clipping.

## Plans (server-enforced in `src/routes/insights.ts`)

| Feature | Free | Light | Max |
|---|---|---|---|
| Uploads, all analytics pages, chart builder, one dashboard | ✓ | ✓ | ✓ |
| Roblox analytics sync (API key, linking, scheduled sync) | | ✓ | ✓ |
| Forecasts | | ✓ | ✓ |
| More dashboards | | ✓ | ✓ |
| Custom calculated metrics | | | ✓ |
| Comparing several games in one query or chart (`cross_experience_overview`) | | | ✓ |

- History length (`analytics_history_days`) and dashboard count (`dashboards`) are optional deployment limits in `PLAN_LIMITS_JSON`. Unset means no limit.
- Sync frequency reuses `sync_interval_minutes`.

## Storage (`migrations/005_analytics_platform.sql`)

- **Tables:** `analytics_credentials`, `analytics_links`, `analytics_datasets`, `metric_points`, `analytics_sync_runs`, `analytics_forecasts`, `saved_charts`, `dashboards`.
- **Isolation:** every table has row-level security keyed on `user_id`, and every query also filters by the signed-in user.
- **What's stored:** aggregates only. No player-level or personal data.
- **Uploads:** uploaded rows live under `source = 'upload'` and never overwrite `source = 'roblox'`. Deleting an upload removes its points (cascade).
- **Retention clean-up:** Roblox snapshots after 90 days, sync runs after 90 days, anonymous product events after 400 days.

## In-game tracking

Data → Tracking generates a server-side Luau module for the chosen game type. The developer reviews it and adds it to their own game.

- **Calls used:** `AnalyticsService:LogFunnelStepEvent` (one step per level or stage), `LogCustomEvent("LevelReachedMinutes", minutesPlayed, {CustomField01 = "Level N"})` and `LogEconomyEvent` (Source = earned, Sink = spent).
- **How it reaches LaunchPad:** Roblox aggregates these into the Funnel, CustomEvent and Economy metrics the sync reads. Roblox says this takes about 24 hours.
- **Unverified:** the custom-field dimension name `CustomField1` and the enum `Enum.AnalyticsCustomFieldKeys.CustomField01` haven't been tested against a live experience.

## Not verified yet

- **Live Roblox data:** no real API key was available. The adapter, polling, retries, budget splitting, unit handling and sync are tested against recorded-shape stubs (`test/insights.test.ts`), not against Roblox.
- **Dimension values:** Platform names, CohortDay values and SessionTimeBucket labels are shown exactly as Roblox returns them. Their formats are undocumented.
