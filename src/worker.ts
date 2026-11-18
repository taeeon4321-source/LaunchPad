// Background job handlers.
import { configured, config } from './config.ts';
import { db } from './db.ts';
import { deliver } from './email.ts';
import { registerJob } from './jobs.ts';
import { provider, reconcileSubscriptions } from './billing.ts';
import { decrypt, securityEvent } from './security.ts';
import { changedSections, sectionHashes } from './scan.ts';

export function registerHandlers() {
  registerJob('send_email', p => deliver(p.id));
  registerJob('reconcile_subscriptions', () => reconcileSubscriptions());

  registerJob('process_scan', async p => {
    await db.asUser(p.userId, async q => {
      await q.query("update scan_jobs set status = 'processing', updated_at = now() where id = $1", [p.jobId]);
      const prev = (await q.query('select section_hashes, analyzed_at from scan_snapshots where user_id = $1 and universe_id = $2 order by created_at desc limit 1', [p.userId, p.scan.place.universeId])).rows[0];
      const hashes = sectionHashes(p.scan), changes = changedSections(prev?.section_hashes ?? null, hashes);
      // Nothing relevant changed: keep the previous analysis instead of re-running it.
      await q.query('insert into scan_snapshots (user_id, universe_id, place_id, job_id, data, section_hashes, changes, code_read, analyzed_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [p.userId, p.scan.place.universeId, p.scan.place.placeId || null, p.jobId, p.scan, hashes, JSON.stringify(changes), p.scan.codeRead, changes.length ? null : prev?.analyzed_at ?? null]);
      await q.query("update scan_jobs set status = 'done', updated_at = now() where id = $1", [p.jobId]);
    });
  });

  registerJob('delete_account', async p => {
    const id = p.userId, u = await db.one("select id from users where id = $1 and status = 'deleted'", [id]); if (!u) return;
    const rc = await db.one('select refresh_token_enc from roblox_connections where user_id = $1', [id]);
    if (rc && configured.roblox()) {
      await fetch('https://apis.roblox.com/oauth/v1/token/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: decrypt(rc.refresh_token_enc), client_id: config.roblox.clientId, client_secret: config.roblox.clientSecret }) }).catch(() => {});
    }
    if (configured.paddle()) for (const s of (await db.query("select provider_subscription_id from subscriptions where user_id = $1 and status in ('active', 'trialing', 'past_due', 'paused')", [id])).rows)
      await provider().cancelNow(s.provider_subscription_id);
    // Billing records keep provider references with user_id cleared (see PRIVACY_AND_DATA.md); everything else cascades.
    await db.query('delete from users where id = $1', [id]);
    await securityEvent('account_deleted', { userId: id });
  });

  registerJob('retention_cleanup', async () => {
    const r = config.retention;
    await db.query(`delete from scan_snapshots s where s.created_at < now() - ($1 || ' days')::interval
      and s.id <> (select id from scan_snapshots t where t.user_id = s.user_id and t.universe_id = s.universe_id order by created_at desc limit 1)`, [String(r.rawScanDays)]);
    await db.query("delete from security_events where at < now() - ($1 || ' days')::interval", [String(r.securityEventDays)]);
    await db.query("delete from sessions where expires_at < now() - interval '30 days' or revoked_at < now() - interval '30 days'");
    await db.query("delete from auth_tokens where expires_at < now() - interval '7 days'");
    await db.query("delete from pairing_codes where expires_at < now() - interval '1 day'");
    await db.query("delete from email_outbox where created_at < now() - interval '30 days'");
    await db.query("delete from jobs where status in ('done', 'cancelled') and updated_at < now() - interval '30 days'");
    await db.query("delete from subscription_events where received_at < now() - interval '400 days' and status in ('processed', 'ignored')");
  });
}
