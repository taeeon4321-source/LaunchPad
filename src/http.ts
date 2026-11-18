// Request helpers shared by routes: sessions, permission checks, errors.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.ts';
import { db } from './db.ts';
import { randomToken, sha256 } from './security.ts';

export class HttpError extends Error { status: number; extra: object; constructor(status: number, message: string, extra: object = {}) { super(message); this.status = status; this.extra = extra; } }
export const fail = (status: number, message: string, extra = {}): never => { throw new HttpError(status, message, extra); };

export const SESSION_COOKIE = config.isProd ? '__Host-lp_session' : 'lp_session';
export const cookieOpts = (maxAgeSec?: number) => ({ httpOnly: true, secure: config.isProd, sameSite: 'lax' as const, path: '/', ...(maxAgeSec ? { maxAge: maxAgeSec } : {}) });
export const ip = (req: FastifyRequest) => req.ip;

export type User = { id: string; email: string; display_name: string; email_verified_at: string | null; status: string; password_hash: string | null; mfa_enabled_at: string | null; mfa_secret_enc: string | null; created_at: string; last_login_at: string | null };
export type Session = { id: string; authenticated_at: string; mfa_at: string | null };
declare module 'fastify' { interface FastifyRequest { user?: User; session?: Session } }

// New sessions always get a new random token (session rotation). Only a SHA-256 hash is stored.
export async function startSession(req: FastifyRequest, reply: FastifyReply, userId: string, o: { mfa?: boolean } = {}) {
  const token = randomToken(32);
  await db.query(`insert into sessions (user_id, token_hash, expires_at, mfa_at, ip, user_agent) values ($1, $2, now() + ($3 || ' days')::interval, $4, $5, $6)`,
    [userId, sha256(token), String(config.sessionDays), o.mfa ? new Date() : null, ip(req), String(req.headers['user-agent'] || '').slice(0, 200)]);
  await db.query('update users set last_login_at = now() where id = $1', [userId]);
  reply.setCookie(SESSION_COOKIE, token, cookieOpts(config.sessionDays * 86400));
}

export async function loadSession(req: FastifyRequest) {
  const token = req.cookies?.[SESSION_COOKIE]; if (!token || token.length > 100) return;
  const row = await db.one(`select s.id sid, s.authenticated_at, s.mfa_at, s.last_seen_at, u.* from sessions s join users u on u.id = s.user_id
    where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and s.last_seen_at > now() - ($2 || ' days')::interval and u.status = 'active'`, [sha256(token), String(config.sessionIdleDays)]);
  if (!row) return;
  req.session = { id: row.sid, authenticated_at: row.authenticated_at, mfa_at: row.mfa_at };
  req.user = row;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60e3) await db.query('update sessions set last_seen_at = now() where id = $1', [row.sid]);
}

export function requireUser(req: FastifyRequest): User { if (!req.user) fail(401, 'Please log in.'); return req.user!; }
export function requireRecentAuth(req: FastifyRequest) {
  requireUser(req);
  if (Date.now() - new Date(req.session!.authenticated_at).getTime() > config.reauthMinutes * 60e3) fail(403, 'Please confirm it\'s you first.', { reauth: true });
}
export async function rolesOf(userId: string): Promise<string[]> { return (await db.query('select role from admin_roles where user_id = $1', [userId])).rows.map(r => r.role); }
// Admin access: a role, MFA enabled on the account, and MFA proven in this session.
export async function requireRole(req: FastifyRequest, allowed: string[]) {
  const u = requireUser(req), roles = await rolesOf(u.id);
  if (!roles.some(r => allowed.includes(r) || r === 'owner')) fail(403, 'You don\'t have access to this.');
  if (!u.mfa_enabled_at || !req.session!.mfa_at) fail(403, 'Administrators must use two-step verification.', { mfa: true });
  return roles;
}
export const str = (v: unknown, max: number) => typeof v === 'string' ? v.trim().slice(0, max) : '';
export const validEmail = (e: string) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
