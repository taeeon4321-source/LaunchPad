// Legal documents (versioned, with review status) and public request forms: support, privacy rights, copyright, refunds.
import type { FastifyInstance } from 'fastify';
import { readdirSync, readFileSync } from 'node:fs';
import { db } from '../db.ts';
import { fail, ip, str, validEmail } from '../http.ts';
import { throttles } from '../security.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const STATUS: Record<string, string> = { draft: 'Draft', awaiting_review: 'Draft, awaiting legal review', approved: 'Approved for publication' };

// legal/*.html start with a header comment: <!-- slug | version | title | status | effective date (YYYY-MM-DD or blank) -->
export async function seedLegal() {
  for (const f of readdirSync('legal').filter(f => f.endsWith('.html'))) {
    const src = readFileSync(`legal/${f}`, 'utf8'), m = src.match(/^<!--\s*(.+?)\s*-->/);
    if (!m) continue;
    const [slug, version, title, status, effective] = m[1].split('|').map(s => s.trim());
    await db.query(`insert into legal_documents (slug, version, title, review_status, effective_date, content_html) values ($1, $2, $3, $4, $5, $6)
      on conflict (slug, version) do update set title = excluded.title, review_status = excluded.review_status, effective_date = excluded.effective_date, content_html = excluded.content_html, updated_at = now()`,
      [slug, version, title, status, effective || null, src.slice(m[0].length)]);
  }
}
export async function currentLegalVersions(slugs: string[]) {
  return (await db.query('select distinct on (slug) slug, version from legal_documents where slug = any($1) order by slug, updated_at desc', [slugs])).rows as { slug: string; version: string }[];
}

const page = (title: string, body: string, nonce: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · LaunchPad</title>
<style nonce="${nonce}">:root{--t:#292A27;--b:#F7F6F1;--s:#FFFFFF;--m:#6B6A64;--l:#E4E2DA}@media (prefers-color-scheme:dark){:root{--t:#F7F6F1;--b:#151515;--s:#1E1E1D;--m:#A8A69E;--l:#34332F}}
body{margin:0;background:var(--b);color:var(--t);font:16px/1.65 Inter,system-ui,sans-serif}main{max-width:760px;margin:0 auto;padding:32px 16px 64px}a{color:inherit}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}.status{border:1px solid var(--l);background:var(--s);border-radius:10px;padding:12px 14px;font-size:14px;color:var(--m)}
h1{font-size:2rem;line-height:1.2;margin:0 0 6px}h2{margin-top:32px;font-size:1.2rem}.meta{color:var(--m);font-size:14px}nav.docs a{display:block;padding:4px 0}
input,textarea,select{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid var(--l);border-radius:10px;background:var(--s);color:var(--t);margin:4px 0 12px}
button{background:var(--t);color:var(--b);border:0;border-radius:10px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer}label{font-size:14px;font-weight:600}</style></head>
<body><main><div class="top"><a href="/"><b>LaunchPad</b></a><a href="/legal">All policies</a></div>${body}
<p class="meta" style="margin-top:40px">LaunchPad is an independent tool. It isn't affiliated with, sponsored by or endorsed by Roblox Corporation.</p></main></body></html>`;

const FORM_KINDS = ['support', 'privacy_access', 'privacy_export', 'privacy_correction', 'privacy_deletion', 'copyright', 'refund', 'billing'];

export default async function legalRoutes(app: FastifyInstance) {
  app.get('/legal', async (req, reply) => {
    const docs = (await db.query('select distinct on (slug) slug, title, version, review_status from legal_documents order by slug, updated_at desc')).rows;
    reply.type('text/html').send(page('Policies', `<h1>Policies</h1><p class="meta">Every document shows its version and review status.</p><nav class="docs">${docs.map(d => `<a href="/legal/${esc(d.slug)}">${esc(d.title)}</a>`).join('')}</nav>
      <h2>Requests</h2><nav class="docs"><a href="/legal/request?kind=privacy_access">Privacy request (access, export, correction, deletion)</a><a href="/legal/request?kind=copyright">Report a copyright concern</a><a href="/legal/request?kind=support">Contact support</a></nav>`, (reply as any).cspNonce));
  });
  app.get('/legal/request', async (req, reply) => {
    const kind = FORM_KINDS.includes((req.query as any).kind) ? (req.query as any).kind : 'support', cr = kind === 'copyright', pv = kind.startsWith('privacy');
    const sel = pv ? `<label for="k">Request type</label><select id="k" name="kind">${['privacy_access', 'privacy_export', 'privacy_correction', 'privacy_deletion'].map(k => `<option value="${k}" ${k === kind ? 'selected' : ''}>${{ privacy_access: 'Access my information', privacy_export: 'Export my information', privacy_correction: 'Correct my information', privacy_deletion: 'Delete my information' }[k]}</option>`).join('')}</select>` : `<input type="hidden" name="kind" value="${kind}">`;
    const extra = cr ? `<label for="c">Affected content (URL, game or asset identifier)</label><input id="c" name="content" required maxlength="500"><label for="r">Explain the rights you hold</label><textarea id="r" name="rights" rows="4" required maxlength="4000"></textarea>
      <label><input type="checkbox" name="goodFaith" value="1" required style="width:auto"> I believe in good faith that this use isn't authorized by the rights holder, its agent or the law, and the information here is accurate.</label>` : '';
    reply.type('text/html').send(page('Request', `<h1>${cr ? 'Report a copyright concern' : pv ? 'Privacy request' : 'Contact support'}</h1><p class="meta">${pv ? 'Signed-in users can also export or delete their data instantly in Settings → Privacy. We may need to confirm your identity before acting.' : 'We reply by email.'}</p>
      <form id="f">${sel}<label for="n">Your name</label><input id="n" name="name" required maxlength="100"><label for="e">Email</label><input id="e" name="email" type="email" required maxlength="254">
      <label for="s">Subject</label><input id="s" name="subject" required maxlength="200">${extra}<label for="m">Details</label><textarea id="m" name="message" rows="6" required maxlength="8000"></textarea><button>Send</button><p id="out" role="status"></p></form>
      <script nonce="${(reply as any).cspNonce}">document.getElementById('f').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));const r=await fetch('/api/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});const j=await r.json();document.getElementById('out').textContent=r.ok?'Thanks. Your request was received (reference '+j.id.slice(0,8)+').':(j.error||'Something went wrong.');if(r.ok)e.target.reset();};</script>`, (reply as any).cspNonce));
  });
  app.get('/legal/:slug', async (req, reply) => {
    const d = await db.one('select * from legal_documents where slug = $1 order by updated_at desc limit 1', [str((req.params as any).slug, 60)]);
    if (!d) return reply.code(404).type('text/html').send(page('Not found', '<h1>Not found</h1>', (reply as any).cspNonce));
    reply.type('text/html').send(page(d.title, `<h1>${esc(d.title)}</h1><p class="meta">Version ${esc(d.version)} · Effective ${d.effective_date ? esc(new Date(d.effective_date).toISOString().slice(0, 10)) : 'not yet set'} · Last updated ${esc(new Date(d.updated_at).toISOString().slice(0, 10))}</p>
      <p class="status"><b>Status: ${esc(STATUS[d.review_status])}.</b>${d.review_status === 'approved' ? '' : ' This draft hasn\'t been reviewed by a lawyer and may change before LaunchPad accepts paying customers.'}</p>${d.content_html}`, (reply as any).cspNonce));
  });

  app.get('/api/legal', async () => (await db.query('select distinct on (slug) slug, title, version, review_status, effective_date, updated_at from legal_documents order by slug, updated_at desc')).rows);

  app.post('/api/requests', async req => {
    const b: any = req.body ?? {}, kind = FORM_KINDS.includes(b.kind) ? b.kind : null;
    if (!throttles.forms.take(ip(req)).ok) fail(429, 'Too many requests. Try again later.');
    const email = req.user?.email ?? str(b.email, 254);
    if (!kind || !validEmail(email) || !str(b.subject, 200) || !str(b.message, 8000)) fail(400, 'Please fill in every field.');
    if (kind === 'copyright' && (!str(b.content, 500) || !str(b.rights, 4000) || !b.goodFaith)) fail(400, 'Copyright reports need the content, your rights and the good-faith statement.');
    const body = { name: str(b.name, 100), message: str(b.message, 8000), ...(kind === 'copyright' ? { content: str(b.content, 500), rights: str(b.rights, 4000), goodFaith: true } : {}) };
    const r = await db.one('insert into support_requests (user_id, email, kind, subject, body) values ($1, $2, $3, $4, $5) returning id', [req.user?.id ?? null, email, kind, str(b.subject, 200), body]);
    return { ok: true, id: r.id };
  });
}
