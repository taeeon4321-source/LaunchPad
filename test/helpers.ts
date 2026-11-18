import { buildApp } from '../src/server.ts';
import { db } from '../src/db.ts';
import { config } from '../src/config.ts';

export const ORIGIN = config.appOrigin;
export async function makeApp() { return buildApp({ memoryDb: true, worker: false }); }

// A tiny cookie-keeping client around app.inject.
let ipN = 1;
export function client(app: any, remoteAddress = `10.0.${(ipN >> 8) & 255}.${ipN++ & 255}`) {
  let cookie = '';
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await app.inject({ method, url, remoteAddress, payload: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), origin: ORIGIN, ...(cookie ? { cookie } : {}), ...headers } });
    for (const c of [].concat(r.headers['set-cookie'] ?? [])) {
      const [kv] = String(c).split(';'), [k] = kv.split('=');
      const rest = cookie.split('; ').filter(x => x && !x.startsWith(k + '='));
      cookie = (/=;|=$/.test(kv) || /Max-Age=0|Expires=Thu, 01 Jan 1970/.test(String(c)) ? rest : [...rest, kv]).join('; ');
    }
    let json: any = null; try { json = r.json(); } catch { /* not json */ }
    return { status: r.statusCode, json, headers: r.headers, body: r.body };
  };
  return { call, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}

export async function registerUser(app: any, email: string, password = 'correct horse battery') {
  const c = client(app);
  const r = await c.call('POST', '/api/auth/register', { email, password, displayName: email.split('@')[0], acceptTerms: true, ageConfirmed: true });
  if (r.status !== 200) throw new Error('register failed: ' + JSON.stringify(r.json));
  const id = (await db.one('select id from users where email = $1', [email])).id;
  return { c, id, email, password };
}
// Read the newest one-time link for an address from the dev outbox (never from logs).
export async function lastLink(email: string, kind: 'verify' | 'reset') {
  const m = await db.one('select body_html from email_outbox where to_email = $1 and body_html like $2 order by id desc limit 1', [email, `%#/${kind}?token=%`]);
  return m.body_html.match(new RegExp(`#/${kind}\\?token=([\\w-]+)`))[1];
}
