# Roblox integration

## OAuth 2.0 (connect Roblox)
- `GET /api/roblox/connect` (signed in, Light/Max) → Roblox `https://apis.roblox.com/oauth/v1/authorize` with authorization code + PKCE (S256), `state` and `nonce`. State, verifier, nonce and user ID are kept encrypted in a 10-minute httpOnly cookie.
- `GET /api/roblox/callback`: checks state and that the same user finished the flow; exchanges the code server-side (`/oauth/v1/token`), verifies the ID token (JWKS `/oauth/v1/certs`, issuer `https://apis.roblox.com/oauth/`, audience, nonce), stores encrypted access/refresh tokens, then reads which experiences the user authorized (`/oauth/v1/token/resources`).
- Refresh: `robloxAccessToken()` refreshes before expiry; failure marks the connection `expired`.
- Disconnect: re-auth, revokes the token at Roblox (`/oauth/v1/token/revoke`), deletes local tokens, experiences and plugin pairings. Reports are kept.
- Scopes: `ROBLOX_SCOPES` (default `openid profile universe:read`). **Verify the exact scope names your registered app is granted in the Creator Dashboard before launch**; Roblox's scope catalogue changes.
- Group-owned experiences appear when the authorizing user grants them during Roblox's consent screen.
- Never used: Roblox passwords, `.ROBLOSECURITY` cookies, undocumented endpoints.

Requirements: register an OAuth 2.0 app (ID-verified developer), redirect URI = `APP_ORIGIN/api/roblox/callback`, then set `ROBLOX_CLIENT_ID` and `ROBLOX_CLIENT_SECRET`. Until then, Connect shows "not configured".

## LaunchPad Studio plugin
File: `plugin/LaunchPadStudio.lua`, served at `/plugin/LaunchPadStudio.lua` with the deployment URL filled in (no secrets).

Pairing:
1. Plugin → `POST /api/plugin/pair/start` → 8-character code (crypto-random, 10 min) + poll secret; only hashes are stored.
2. User enters the code on the Studio page (signed in, Light/Max) → `POST /api/plugin/pair/confirm`; rate-limited; single use.
3. Plugin polls `POST /api/plugin/pair/poll` → receives a per-installation token once (90 days, revocable, stored with `plugin:SetSetting`).
Studio asks the user to allow HTTP access to the LaunchPad domain; denial is shown in the panel.

Syncing (`POST /api/plugin/scans`): the server checks the token, plan (`studio_automatic_scanning`), that the experience is **authorized by Roblox OAuth for this user** (a Place ID alone is not proof), script-inspection consent, and the monthly scan allowance; then queues `process_scan`. The job stores the validated summary with section hashes (listing, structure, ui, systems, economy) and records which sections changed. Unchanged scans keep the previous analysis.

Analysis: the five optimizers run in the browser (`importScan`) when the developer opens the Studio page and new synced scans exist; results are saved as reports with evidence. **Shortcut:** analysis isn't run by a server worker yet, so a sync is analyzed the next time the developer opens LaunchPad. Moving the analyzers into a shared module would let the job queue do it.

Read-only guarantee: the plugin only reads instances and properties, uses `ScriptEditorService:GetEditorSource` (fallback `.Source`) only with consent, never executes scanned code, never edits, deletes, publishes or uploads.

Not yet available: Creator analytics (retention numbers) via Open Cloud; automated Studio playtests. The Retention optimizer still takes Creator Dashboard numbers by hand.
