# LaunchPad

Growth analysis for Roblox developers: five optimizers (Game Page, Thumbnail & Icon, First Session, Retention, Progression), Roblox Studio sync, accounts, billing and administration.

```bash
npm install
cp .env.example .env    # fill in what you have; everything else stays switched off
npm run dev             # http://localhost:8787
npm test                # 28 automated tests (in-memory Postgres)
```

## Architecture

```
Browser (public/index.html, public/admin.html)
  │  HTTPS, httpOnly session cookie, same-origin JSON only
  ▼
LaunchPad backend (Node + Fastify, src/server.ts)
  ├─ Authentication: email + Argon2id, Google ID tokens, sessions, TOTP MFA   (src/routes/auth.ts)
  ├─ Data API: games, reports, recommendations, evidence, overrides           (src/routes/data.ts)
  ├─ Entitlement service: plan → features and limits                          (src/entitlements.ts, src/plans.ts)
  ├─ Paddle payment service: checkout, portal, signed webhooks, reconciliation (src/billing.ts, src/routes/billing.ts)
  ├─ Roblox OAuth (PKCE, state, nonce) and Studio pairing                      (src/routes/roblox.ts)
  ├─ Admin API (roles, MFA, append-only audit log)                             (src/routes/admin.ts)
  ├─ Legal documents and request forms                                         (src/routes/legal.ts, legal/*.html)
  └─ Job queue: scans, emails, deletion, reconciliation, retention             (src/jobs.ts, src/worker.ts)
  ▼
PostgreSQL with row-level security (migrations/)
  ▲
LaunchPad Studio plugin (plugin/LaunchPadStudio.lua) ── read-only scan ──► scan jobs ──► five optimizers ──► reports
```

The five optimizers run in the browser with the same rules as before. Synced scans are stored server-side and analyzed when the developer opens the Studio page (see ROBLOX_INTEGRATION.md).

Docs: [SECURITY](docs/SECURITY.md) · [AUTHENTICATION](docs/AUTHENTICATION.md) · [ADMIN_GUIDE](docs/ADMIN_GUIDE.md) · [PRIVACY_AND_DATA](docs/PRIVACY_AND_DATA.md) · [LEGAL_REVIEW_CHECKLIST](docs/LEGAL_REVIEW_CHECKLIST.md) · [ROBLOX_INTEGRATION](docs/ROBLOX_INTEGRATION.md) · [BILLING](docs/BILLING.md) · [DEPLOYMENT](docs/DEPLOYMENT.md) · [INCIDENT_RESPONSE](docs/INCIDENT_RESPONSE.md) · [TESTING](docs/TESTING.md) · [ANALYTICS](docs/ANALYTICS.md) · [AI](docs/AI.md)
