# Security

Reference framework: OWASP ASVS (current version). Controls below are implemented in code; the "Tested" column points at automated tests.

| Area | Control | Where | Tested |
|---|---|---|---|
| Passwords | Argon2id (19 MiB, t=2, p=1), 10–128 chars, never logged | `src/security.ts` | auth.test |
| Login | Same error for unknown email and wrong password; constant-ish timing via dummy hash | `routes/auth.ts` | auth.test |
| Throttling | Per IP and per IP+account (no account-only lockout that attackers could abuse); register, reset, pairing, billing, forms, general API | `Throttle` | auth.test |
| Sessions | 256-bit random token, only SHA-256 stored; HttpOnly, SameSite=Lax, Secure + `__Host-` prefix in production; rotation on every login; idle (7 d) and absolute (30 d) expiry; revoke one / all; reset revokes all | `http.ts` | auth.test |
| Re-auth | Password/Google (+TOTP) within 10 minutes for deletion, MFA changes, linking/unlinking, Roblox disconnect | `requireRecentAuth` | auth.test, google.test |
| MFA | TOTP (RFC 6238); required for every admin route; optional for users | `security.ts` | admin.test |
| CSRF | State-changing requests must carry `Origin` = APP_ORIGIN and a JSON body; SameSite cookies | `server.ts` | auth.test |
| CORS | No CORS headers: browser API is same-origin only. Plugin uses bearer tokens; webhooks use signatures | `server.ts` | — |
| Access control | Every query filters by the session's user; Postgres RLS (`app_user` role + `app.user_id`) as a second layer | `db.ts`, migration | isolation.test, db.test |
| IDOR | IDs are namespaced per user (composite keys); cross-user IDs return 404 | `routes/data.ts` | isolation.test |
| SQL injection | Parameterized queries only | all | isolation.test |
| XSS | All dynamic text escaped (`esc`); strict CSP with per-response nonce, no inline handlers | `server.ts` | web.test |
| Uploads | Images checked by magic bytes, type must match content, size limits | `checkImageBytes` | isolation.test |
| SSRF | The server never fetches user-supplied URLs; outbound calls go only to fixed Google, Roblox, Paddle and email hosts | — | review |
| Secrets | Server-side only; `.env` git-ignored; frontend gets only public IDs (Google client ID, Paddle client token) | `config.ts` | web.test |
| Tokens at rest | Roblox OAuth tokens and TOTP secrets AES-256-GCM encrypted | `encrypt()` | — |
| Headers | CSP, HSTS (prod), nosniff, Referrer-Policy, Permissions-Policy, X-Frame-Options DENY, frame-ancestors 'none' | `server.ts` | web.test |
| Path traversal | Static files restricted to `public/`, `.html` only via routes | `server.ts` | web.test |
| Payments | No card data; signed webhooks; server-side price mapping; entitlements only from verified provider state | `billing.ts` | billing.test |
| Audit | Admin actions logged with admin, action, target, reason, outcome; table is append-only (trigger) | migration | admin.test |
| Logging | Security events for logins, failures, resets, MFA, sessions, consents, Roblox, pairing, billing; production logger redacts cookies, auth headers and signatures | `securityEvent` | auth.test |

## Known limits
- Throttles are in-process memory. Before running more than one server instance, move them to Redis or Postgres.
- Breached-password screening (e.g. k-anonymity lookup) isn't implemented yet.
- Passkeys aren't implemented; TOTP is.
- Monitoring/alerting: security events are stored and visible in Admin → Security events; external alerting (e.g. on spikes of `login_failed` or `webhook_signature_invalid`, failed jobs) must be wired to your monitoring provider at deployment (see DEPLOYMENT.md).
- Dependency scanning: run `npm audit` in CI and enable Dependabot or similar.

## Reporting a vulnerability
Email [SECURITY CONTACT] or use the support form with subject "Security". Please don't test against other users' data. See INCIDENT_RESPONSE.md.
