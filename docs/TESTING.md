# Testing

`npm test`: 28 tests, in-memory Postgres (PGlite), no network. Last run: all passing (2026-11-18).

| File | Covers |
|---|---|
| db.test | Migrations; RLS blocks reading and writing another user's rows; audit log is append-only |
| auth.test | Register, duplicate email, generic login errors, Argon2id hashes, no passwords in logs; single-use email verification; reset (generic response, single use, expiry, signs out everywhere); sessions list/revoke/log out everywhere; cookie flags; CSRF origin and content-type checks; login throttling; MFA (re-auth, setup, login code); export; deletion (re-auth, confirmation, job deletes data) |
| google.test | Valid token creates account after consent, keyed by `sub`; bad signature, audience, issuer, expiry, nonce rejected; matching email never merges; linking needs recent auth |
| isolation.test | Two users: no reading, deleting, attaching or overwriting each other's games, reports, overrides, sessions, billing; injection-shaped input; image content validation |
| admin.test | Ordinary users blocked; MFA required; support can't grant roles, suspend or see security history; no self-grants; reasons required; suspension keeps data and ends sessions; audit entries written; audit immutable |
| billing.test | Price table and savings; checkout uses server price IDs and ignores browser amounts; verified email required; invalid signatures rejected; all four prices → correct plan and interval; duplicates; out-of-order events; upgrade; scheduled cancellation keeps access; past due; cancellation; browser prefs can't grant plans; $200 annual transaction and email wording; refunds; portal per user |
| roblox.test | Pairing requires a paid plan, single-use codes, expiry, token handed out once, hashed codes; unauthorized experience refused; script reading needs consent; scan job processing; change detection; cross-user snapshots hidden; revoked plugin token; Roblox OAuth not configured, PKCE + state + nonce on authorize, forged or swapped state rejected, denial |
| web.test | CSP nonces on every inline script, no inline handlers, security headers; path traversal; no secrets in browser files or plugin; legal pages and request forms; public plans endpoint |

Manual browser check (local server): sign-up → onboarding, account sync of games, every settings tab, pricing toggle and annual wording, Studio page states.

## Not yet tested (needs credentials or a deployed URL)
- Real Google sign-in (needs `GOOGLE_CLIENT_ID`); Google token verification itself is tested with locally signed tokens.
- Real Roblox OAuth success, token refresh and revocation (needs a registered Roblox app).
- Plugin pairing and sync from inside Studio (the scanner was run on a real place; the new panel hasn't been opened in Studio).
- Paddle sandbox checkout end-to-end, real webhooks, renewals, portal (needs client token, webhook destination on a public HTTPS URL).
- Email delivery (needs a provider).
- Backup restore, load testing, external penetration test.
