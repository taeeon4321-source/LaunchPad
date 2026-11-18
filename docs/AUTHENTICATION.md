# Authentication

## Email and password
- `POST /api/auth/register`: email, display name, password (10–128 chars), consent to Terms + Privacy, minimum-age confirmation (no date of birth collected). Records legal acceptance with document versions. Sends a verification email and signs the user in.
- `POST /api/auth/verify-email`: single-use token (24 h), stored as a SHA-256 hash.
- `POST /api/auth/login`: generic error; asks for a TOTP code when MFA is on.
- `POST /api/auth/forgot` / `reset`: identical response whether or not the email exists; single-use 30-minute token; reset revokes every session.
- Paying requires a verified email.

## Google sign-in (Google Identity Services)
1. The page asks `GET /api/auth/google/nonce`; the server returns a random nonce and stores only its hash in an httpOnly 10-minute cookie.
2. GIS shows the Google button with that nonce and returns an ID token (`credential`).
3. `POST /api/auth/google` verifies with `jose`: signature against Google's JWKS, issuer `accounts.google.com`, audience = `GOOGLE_CLIENT_ID`, expiry, then nonce hash. CSRF is covered by the Origin check and the nonce cookie.
4. The account key is Google's `sub`. A new Google user needs a verified Google email and the same consent as email sign-up.
5. **No automatic merging:** if the email already belongs to a LaunchPad account, sign-in is refused with instructions to log in and connect Google from Settings.

### Linking and unlinking
- Link: signed in + re-authenticated within 10 minutes + a fresh Google credential (`mode: "link"`). Refused if that Google account belongs to another user. Logged as `identity_linked`, and the user gets an email.
- Unlink: re-auth required and the account must have a password. Logged as `identity_unlinked`.

## Sessions
Random 256-bit token in an httpOnly cookie (`__Host-lp_session` in production); only its hash is stored. New token on every login. Expires after 30 days, or 7 days idle. Settings → Security lists sessions and can revoke one or all.

## Two-step verification
TOTP (30 s, 6 digits). Setup and disable need re-auth. Required for every administrator; admin routes also require MFA proven in the current session.

## Configuration
Set `GOOGLE_CLIENT_ID` (Web application client; authorized JavaScript origin = `APP_ORIGIN`). Without it the Google button is hidden and email sign-in still works.
