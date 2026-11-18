# Deployment

## Environments
- **development**: `npm run dev`, embedded PGlite in `.data/`, emails stay in the outbox table, Paddle sandbox.
- **staging**: same as production with Paddle sandbox and separate secrets and database.
- **production**: Paddle live, separate secrets, managed Postgres.

## Requirements
Node ≥ 23.6 (runs TypeScript directly; no build step). PostgreSQL 15+.

## Database
1. Create a database and two roles: the app's login role (owns the tables) must be `GRANT app_user TO <login role>` so the app can `SET ROLE app_user` for row-level security.
2. Set `DATABASE_URL` (TLS required in production). Migrations in `migrations/` run automatically at startup, in order, once each.
3. Turn on automated encrypted backups and point-in-time recovery at the provider. **Test a restore into a separate database before launch** and record the result in TESTING.md.

## Secrets
Use the host's secret manager (e.g. Fly secrets, Render env groups, AWS Secrets Manager). Never commit `.env`. Separate values per environment. Rotate the Paddle sandbox API key that was shared in chat during setup.

## Hosting
Any Node host with HTTPS (Fly.io, Render, Railway, AWS). Behind a proxy, `trustProxy` is enabled in production so rate limits use the client IP. Run one instance until throttles move to shared storage (SECURITY.md). The same process runs the job worker.

## Email
Set `EMAIL_PROVIDER=resend`, `EMAIL_API_KEY`, and `EMAIL_FROM` on a verified domain (SPF, DKIM, DMARC).

## Monitoring
- Uptime check on `/healthz`.
- Ship stdout logs (JSON, cookies and auth headers redacted) to your log provider.
- Alerts to set up: spikes in `login_failed`, `webhook_signature_invalid`, `pairing_code_rejected`; any `failed` rows in `jobs`; `subscription_events` with status `failed`; 5xx rate.

## Roblox and Google
Redirect URI and JavaScript origin must match `APP_ORIGIN` exactly in each environment.
