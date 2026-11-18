import { createHash, randomBytes, createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { hash, verify } from '@node-rs/argon2';
import { config } from './config.ts';
import { db } from './db.ts';

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const safeEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

// Argon2id with OWASP's minimum recommended parameters (19 MiB, t=2, p=1). Algorithm 2 = Argon2id.
export const hashPassword = (p: string) => hash(p, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const verifyPassword = async (h: string | null, p: string) => { if (!h) return false; try { return await verify(h, p); } catch { return false; } };
export function passwordProblem(p: unknown, email = ''): string | null {
  if (typeof p !== 'string' || p.length < 10) return 'Use at least 10 characters.';
  if (p.length > 128) return 'Use 128 characters or fewer.';
  if (email && p.toLowerCase().includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length > 3) return "Don't include your email name in your password.";
  return null;
}

// AES-256-GCM for OAuth tokens and MFA secrets at rest.
let key: Buffer;
function encKey() {
  if (key) return key;
  if (config.encryptionKey) return key = Buffer.from(config.encryptionKey, 'base64');
  if (config.isProd) throw new Error('ENCRYPTION_KEY missing');
  // Development only: a key generated once and kept outside git.
  const f = './.data/dev-encryption-key';
  if (!existsSync(f)) { mkdirSync('./.data', { recursive: true }); writeFileSync(f, randomBytes(32).toString('base64')); }
  return key = Buffer.from(readFileSync(f, 'utf8'), 'base64');
}
export function encrypt(text: string) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', encKey(), iv), body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}
export function decrypt(blob: string) {
  const [v, iv, tag, body] = blob.split('.'); if (v !== 'v1') throw new Error('Unknown ciphertext version');
  const d = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64url')); d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
}

// TOTP (RFC 6238, SHA-1, 30 s, 6 digits) for administrator MFA and optional user MFA.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret() { const b = randomBytes(20); let bits = '', out = ''; for (const x of b) bits += x.toString(2).padStart(8, '0'); for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]; return out; }
function b32decode(s: string) { let bits = ''; for (const c of s.replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(c); if (v < 0) throw new Error('bad base32'); bits += v.toString(2).padStart(5, '0'); } const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }
export function totp(secret: string, t = Date.now()) {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = createHmac('sha1', b32decode(secret)).update(c).digest(), o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
export const verifyTotp = (secret: string, code: unknown) => typeof code === 'string' && /^\d{6}$/.test(code) && [-1, 0, 1].some(w => safeEqual(totp(secret, Date.now() + w * 30000), code));

// Fixed-window throttles. shortcut: in-process memory, so limits are per server instance; move to Redis or the database before running several instances.
export class Throttle {
  private hits = new Map<string, { n: number; reset: number }>();
  private max: number; private windowMs: number;
  constructor(max: number, windowMs: number) { this.max = max; this.windowMs = windowMs; }
  take(key: string) {
    const now = Date.now(), h = this.hits.get(key);
    if (!h || h.reset < now) { this.hits.set(key, { n: 1, reset: now + this.windowMs }); if (this.hits.size > 50000) this.sweep(now); return { ok: true, retryAfter: 0 }; }
    h.n++; return { ok: h.n <= this.max, retryAfter: Math.ceil((h.reset - now) / 1000) };
  }
  reset(key: string) { this.hits.delete(key); }
  private sweep(now: number) { for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k); }
}
// Throttling slows guessing without locking real users out: limits apply per IP and per IP+account, never per account alone.
export const throttles = {
  login: new Throttle(10, 15 * 60e3),
  loginIp: new Throttle(50, 15 * 60e3),
  register: new Throttle(5, 60 * 60e3),
  reset: new Throttle(5, 60 * 60e3),
  pairing: new Throttle(10, 15 * 60e3),
  billing: new Throttle(20, 15 * 60e3),
  forms: new Throttle(10, 60 * 60e3),
  api: new Throttle(600, 60e3),
  events: new Throttle(120, 60e3),
};

// Security log. Never pass passwords, tokens, cookies or source code in `detail`.
export async function securityEvent(kind: string, o: { userId?: string | null; ip?: string; detail?: Record<string, unknown> } = {}) {
  await db.query('insert into security_events (user_id, kind, ip, detail) values ($1, $2, $3, $4)', [o.userId ?? null, kind, o.ip ?? null, o.detail ?? {}]);
}
export async function audit(adminId: string, action: string, target: string | null, reason: string | null, outcome: string) {
  await db.query('insert into admin_audit_log (admin_id, action, target, reason, outcome) values ($1, $2, $3, $4, $5)', [adminId, action, target, reason, outcome]);
}
