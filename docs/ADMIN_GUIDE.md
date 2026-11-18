# Admin guide

Admin dashboard: `/admin`. Every admin route checks roles on the server, requires MFA on the account and MFA proven in the session, and writes to the append-only audit log.

## Roles
| Role | Can |
|---|---|
| owner | Everything, including granting and removing roles (never their own) |
| administrator | Overview, users, suspend/reinstate, revoke sessions, process deletion, support requests, billing |
| support | Overview, user lookup (no security history, no billing, no tokens or code), support requests |
| security | Overview, user lookup with security history, revoke sessions, security events, audit log, roles list |

Nobody can see OAuth tokens, password hashes, raw source code or card data: none of it is stored or exposed.

## First owner
1. The person signs up and turns on two-step verification (Settings → Security).
2. On the server: `npm run cli -- grant-owner their@email`.
Further roles: Admin → Roles (owner only; the target must have MFA on).

## Common tasks
- **Suspend**: Users → user → Suspend, with a reason. Ends sessions and blocks sign-in; data is kept. Reinstate restores access.
- **Revoke sessions**: signs the user out everywhere.
- **Deletion request**: Requests tab shows privacy requests; Users → Process deletion runs the same job as self-service deletion.
- **Copyright report**: Requests (kind `copyright`); set status and record the decision.
- **Billing**: Billing tab. Cash figures are actual Paddle transactions; MRR/ARR are estimates (annual = 1/12 per month). Refunds, payment method changes and cancellations happen in the Paddle dashboard or customer portal.
