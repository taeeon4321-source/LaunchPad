# Privacy and data

| Data | Stored | Retention |
|---|---|---|
| Account (email, name, avatar, password hash, MFA secret encrypted) | `users` | Until deletion |
| Google identity (`sub`, email) | `auth_identities` | Until unlinked or deletion |
| Sessions (hash, IP, user agent) | `sessions` | 30 days after expiry/revocation |
| Games, reports, recommendations, evidence, overrides | own tables, RLS | Until the user deletes them or the account |
| Roblox connection (IDs, encrypted tokens), authorized experiences | `roblox_connections`, `roblox_experiences` | Until disconnect or deletion |
| Studio scan summaries (no raw source code) | `scan_snapshots` | `RETENTION_SCAN_SNAPSHOT_DAYS` (latest per experience kept) |
| Consents (script inspection, product emails) | `user_preferences.consents` | Until changed or deletion |
| Security events | `security_events` | `RETENTION_SECURITY_EVENT_DAYS` |
| Admin audit log | `admin_audit_log` | Append-only; retention period to be set with counsel |
| Billing references (Paddle IDs, amounts) | billing tables | Kept with `user_id` cleared after deletion, for the legally required period |
| Emails | `email_outbox` | Body replaced after sending; rows deleted after 30 days |
| Roblox Open Cloud API keys (encrypted, hint only shown) | `analytics_credentials` | Until removed or deletion |
| Aggregated game analytics (Roblox sync, uploads, benchmarks; no player-level data) | `metric_points`, `analytics_datasets` | Until deleted (Settings → Data & forecasts) or account deletion; Roblox 28-day snapshots 90 days |
| Sync history, forecasts, saved charts, dashboards | `analytics_sync_runs`, `analytics_forecasts`, `saved_charts`, `dashboards` | Sync runs 90 days; others until deleted or account deletion |

The privacy policy draft (`legal/privacy.html`) doesn't yet describe the analytics data above; add it before publishing (see LEGAL_REVIEW_CHECKLIST).

## Source code
The plugin reads scripts only when the user allows "script inspection" (Settings → Privacy). Reading happens inside Studio; only feature names, script paths and numbers from configuration tables are sent. Raw source is never transmitted, stored or sent to any AI provider. The server rejects scans marked as code-reading when consent is off.

## User rights workflows
- Export: Settings → Privacy → Export (`GET /api/me/export`, everything except secrets).
- Deletion: Settings → Privacy → Delete account (re-auth + typed confirmation). Sign-in stops immediately; a job revokes Roblox tokens, cancels Paddle subscriptions and deletes the account (cascade).
- Access/correction/deletion requests by email: `/legal/request?kind=privacy_access` → Admin → Requests.
- Consent changes are logged as `consent_changed`.

## Backups
Encrypted automated backups must be configured on the managed database (DEPLOYMENT.md). Deleted data rolls off backups by their retention window. **Backup restoration has not been tested yet**; do it before launch.
