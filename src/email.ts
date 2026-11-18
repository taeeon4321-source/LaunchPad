// Transactional email. Messages go to the outbox table and a job sends them; with no provider configured they stay
// in the outbox (development). Bodies are never written to logs because they can contain one-time links.
import { config, configured } from './config.ts';
import { db } from './db.ts';
import { enqueue } from './jobs.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const layout = (title: string, body: string) => `<!doctype html><html><body style="margin:0;background:#F7F6F1;font-family:Inter,Arial,sans-serif;color:#292A27">
<div style="max-width:520px;margin:0 auto;padding:32px 20px"><p style="font-weight:700;font-size:18px;margin:0 0 24px">LaunchPad</p>
<div style="background:#FFFFFF;border:1px solid #E4E2DA;border-radius:12px;padding:28px"><h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>${body}</div>
<p style="font-size:12px;color:#6B6A64;margin:20px 0 0">LaunchPad is an independent tool and isn't affiliated with Roblox Corporation.</p></div></body></html>`;
const btn = (href: string, label: string) => `<p style="margin:20px 0"><a href="${esc(href)}" style="background:#292A27;color:#F7F6F1;padding:11px 18px;border-radius:10px;text-decoration:none;font-weight:600">${esc(label)}</a></p>`;
const p = (t: string) => `<p style="line-height:1.55;margin:0 0 12px">${t}</p>`;
const money = (cents: number, cur = 'USD') => `${cur === 'USD' ? '$' : ''}${(cents / 100).toFixed(2)}${cur === 'USD' ? '' : ' ' + esc(cur)}`;

export const templates = {
  welcome: (d: { name: string }) => ({ subject: 'Welcome to LaunchPad', html: layout(`Welcome, ${d.name}`, p('Your account is ready. Add a game or connect Roblox Studio to get your first analysis.') + btn(config.appOrigin, 'Open LaunchPad')) }),
  verify_email: (d: { link: string }) => ({ subject: 'Confirm your email', html: layout('Confirm your email', p('Click the button to confirm this address. The link works once and expires in 24 hours.') + btn(d.link, 'Confirm email') + p('If you didn\'t create a LaunchPad account, ignore this email.')) }),
  reset_password: (d: { link: string }) => ({ subject: 'Reset your LaunchPad password', html: layout('Reset your password', p('The link works once and expires in 30 minutes.') + btn(d.link, 'Choose a new password') + p('If you didn\'t ask for this, ignore this email. Your password stays the same.')) }),
  security_notice: (d: { what: string }) => ({ subject: 'Security change on your LaunchPad account', html: layout('Security change', p(esc(d.what)) + p('If this wasn\'t you, reset your password and sign out of all devices from Settings → Security.')) }),
  subscription_active: (d: { plan: string; interval: string; amountCents: number; currency: string; nextBilled?: string | null; portal: string }) => ({ subject: `Your LaunchPad ${d.plan} plan is active`, html: layout(`LaunchPad ${d.plan} is active`,
    p(`Plan: <b>LaunchPad ${esc(d.plan)}</b>, billed ${d.interval === 'year' ? '<b>annually, paid upfront</b>' : 'monthly'}.`) + p(`Amount charged: <b>${money(d.amountCents, d.currency)}</b> (${esc(d.currency)}).`) +
    (d.nextBilled ? p(`It renews automatically on ${esc(d.nextBilled)} unless you cancel before then.`) : '') + btn(d.portal, 'Manage billing')) }),
  subscription_canceled: (d: { plan: string; until?: string | null; portal: string }) => ({ subject: 'Your LaunchPad subscription is canceled', html: layout('Subscription canceled', p(d.until ? `You keep ${esc(d.plan)} features until ${esc(d.until)}. After that your account moves to the free plan, and your games and reports stay.` : 'Your account is on the free plan. Your games and reports stay.') + btn(d.portal, 'Billing details')) }),
  payment_failed: (d: { plan: string; portal: string }) => ({ subject: 'Your LaunchPad payment didn\'t go through', html: layout('Payment didn\'t go through', p(`We couldn't collect the payment for LaunchPad ${esc(d.plan)}. Update your payment method in the billing portal to keep your plan.`) + btn(d.portal, 'Update payment method')) }),
  plan_changed: (d: { from: string; to: string; interval: string; portal: string }) => ({ subject: `Your LaunchPad plan changed to ${d.to}`, html: layout('Plan changed', p(`Your plan changed from ${esc(d.from)} to <b>${esc(d.to)}</b> (${d.interval === 'year' ? 'annual' : 'monthly'} billing).`) + btn(d.portal, 'Billing details')) }),
};

export async function sendEmail<K extends keyof typeof templates>(to: string, template: K, data: Parameters<typeof templates[K]>[0]) {
  const t = (templates[template] as any)(data);
  const row = await db.one<{ id: number }>('insert into email_outbox (to_email, template, subject, body_html) values ($1, $2, $3, $4) returning id', [to, template, t.subject, t.html]);
  if (configured.email()) await enqueue('send_email', { id: row!.id });
}

export async function deliver(id: number) {
  const m = await db.one('select * from email_outbox where id = $1 and sent_at is null', [id]); if (!m) return;
  if (config.email.provider !== 'resend') throw new Error(`Email provider "${config.email.provider}" isn't implemented; see DEPLOYMENT.md`);
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${config.email.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: config.email.from, to: m.to_email, subject: m.subject, html: m.body_html }) });
  if (!r.ok) throw new Error(`Email provider returned ${r.status}`);
  // The body held one-time links; once delivered there's no reason to keep it.
  await db.query("update email_outbox set sent_at = now(), body_html = '[sent]' where id = $1", [id]);
}
