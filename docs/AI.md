# AI analysis engine

OpenAI (Responses API, structured outputs) called only from the server. There is no Claude or ChatGPT-website dependency. The optimizers' rule-based scoring stays as a free "quick check"; AI analysis is a separate, paid step.

## Setup

- `OPENAI_API_KEY` (required). Without it, the analysis endpoints return 503: "AI analysis isn't configured on this server yet."
- **Model routing** (`src/ai.ts`, `TASKS`). Each tier can be changed with an env var; no code changes.

  | Tier | Env var | Default | Price per 1M tokens (in / out) | Used for |
  |---|---|---|---|---|
  | fast | `OPENAI_MODEL_FAST` | gpt-6-luna | $0.10 / $0.50 | reference tagging, formatting, extraction |
  | vision | `OPENAI_MODEL_VISION` | gpt-6.1-terra | $1 / $5 | thumbnail & icon, game page, first session |
  | deep | `OPENAI_MODEL_DEEP` | gpt-6.2-sol | $2 / $10 | retention, progression, full audit, implementation prompts |

  If a tier fails, the call falls back to another tier. Prices can be overridden with `OPENAI_PRICES_JSON`.
- **Plans:** Free gets 1 AI analysis per UTC day (`FREE_AI_ANALYSES_PER_DAY` in `src/plans.ts`). Light and Max are unlimited apart from an abuse throttle of 20 per hour. Reused (cached) results and failed analyses do not count.

## Pipeline (`src/routes/ai.ts`)

1. **Plan check:** `ai_analysis` (all plans; Free limited to 1 per day); `ai_comprehensive` for the full audit (Max). Checked on the server for every analysis and prompt.
2. **Evidence packet:**
   - the game's saved data;
   - the developer's inputs;
   - analytics means for the last 28 mature days and the 28 before (only `metric_points` that exist);
   - funnel and distribution snapshots;
   - the latest Studio scan;
   - up to 4 relevant references with their public stats;
   - developer images (≤1024px, byte-checked, ≤1.5 MB each);
   - reference thumbnails, attached as Roblox CDN URLs at low detail.
3. **Cache:** a SHA-256 of `[schema version, optimizer, model, packet, image hashes]`. The same hash returns the stored analysis at no cost. A different image, new analytics, changed references, a new model or "Re-analyze" (`force`) runs again.
4. **Strict JSON-schema output** (`ANALYSIS_SCHEMA`). Each finding has title, category, severity, problem, evidence, evidence type (observed / interpretation / hypothesis), reasoning, solution, optional rewrite, optional experiment, confidence, reference_ids, related_metrics, effort, impact and prompt_available. The analysis also has strengths, reference comparisons, a roadmap and limitations.
5. **Checks after the model answers:**
   - The schema is validated again on the server.
   - `sanitize` drops reference ids and metric keys the model wasn't given, and fixes duplicate ids.
   - Invalid output is rejected (502), never stored, and doesn't count against the allowance.
6. **Storage:** results go to `ai_analyses` with sources, model, cost and references. Findings become Action Center tasks (`ai_tasks`). Older not-started tasks for the same optimizer are marked superseded.
7. **Prompts:** `POST /api/ai/prompts` (deep tier) turns one finding into a complete prompt for an image AI, general AI, coding AI or Roblox Studio Assistant. Cached per finding, kind, tool and notes.

## Cost and usage

- `ai_usage` records every model call: user, analysis, task, model, tokens (input, cached, output), cost in USD, and ok/error.
- Users see their own monthly usage at `GET /api/ai/usage`. Administrators see daily usage by model and task at `GET /api/admin/ai-usage`.
- Throttles: 20 analyses and 60 prompts per user per hour.

## Reference catalog (`src/references.ts`)

- **Sources:** Roblox's public APIs only.
  - `games.roblox.com/v1/games`: name, creator, description, genre, playing, visits, favorites.
  - `thumbnails.roblox.com`: icon and thumbnails. Only `*.rbxcdn.com` URLs are kept.
  - `apis.roblox.com/universes/v1/places/{id}/universe`: turns a place ID into a universe ID.
- **Tags:** game type, visual style, mechanics and audience come from the fast model, which looks at the public thumbnail and description.
- **Adding games:** administrators paste links on the Reference games page, or an operator runs:

  ```powershell
  npm run cli -- add-references <links or universe IDs>
  ```

  A daily job refreshes public stats for entries older than 7 days, without re-tagging.
- **Relevance:** same game type +0.45, shared mechanics up to +0.35, visual assets available +0.10, public stats +0.05, refreshed recently +0.05. References are used only at 0.4 or above, and the reasons are shown. The score describes how comparable a game is, not how good it is.
- **Limits:**
  - Roblox's public API has no retention, CTR or revenue for other games, so none are shown or sent to the model.
  - The `genre` field is often "All", so references only match well once they're tagged, which needs the OpenAI key.
  - There's no official Roblox API for discovering top games. The catalog grows from links that administrators add.

## Not verified

No OpenAI key was available, so model calls are tested against stubs that follow the documented response shapes (`test/ai.test.ts`). Two things need checking once a key is set:

- The `usage` field names (`input_tokens`, `output_tokens`, `input_tokens_details.cached_tokens`) weren't confirmed in OpenAI's reference.
- Run one real analysis per optimizer and check its quality.
