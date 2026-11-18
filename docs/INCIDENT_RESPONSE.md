# Incident response

1. **Detect**: alert, report or Admin → Security events. Open an incident note with time, reporter and what's known.
2. **Contain** (security role):
   - Compromised account: Admin → user → Revoke all sessions; suspend if abuse continues.
   - Leaked secret: rotate it at the provider (Paddle API key or webhook secret, Roblox client secret, Google client, email key), update the secret manager, redeploy.
   - Leaked `ENCRYPTION_KEY`: rotate it, re-encrypt stored tokens (or force Roblox reconnects by deleting `roblox_connections`) and ask admins to re-enroll MFA.
   - Suspected database exposure: revoke DB credentials, snapshot for forensics, restore service from a clean state.
3. **Investigate**: `security_events`, `admin_audit_log` (append-only), host logs. Record the timeline.
4. **Notify**: decide with counsel whether regulators or users must be told and by when (e.g. 72 hours under GDPR). Tell affected users plainly what happened and what to do.
5. **Recover**: fix the cause, add a test, confirm alerts would catch a repeat.
6. **Review**: write up within a week; update this document.

Contacts: [SECURITY LEAD], [LEGAL COUNSEL], [HOSTING SUPPORT], Paddle support, Roblox developer relations.
