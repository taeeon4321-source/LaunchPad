import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { readFileSync, existsSync, createReadStream } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertProductionConfig, config } from './config.ts';
import { connect } from './db.ts';
import { HttpError, ip, loadSession } from './http.ts';
import { startWorker } from './jobs.ts';
import { throttles } from './security.ts';
import { registerHandlers } from './worker.ts';
import authRoutes from './routes/auth.ts';
import meRoutes from './routes/me.ts';
import dataRoutes from './routes/data.ts';
import legalRoutes, { seedLegal } from './routes/legal.ts';
import billingRoutes from './routes/billing.ts';
import robloxRoutes from './routes/roblox.ts';
import adminRoutes from './routes/admin.ts';
import analyticsRoutes from './routes/analytics.ts';

declare module 'fastify' { interface FastifyReply { cspNonce: string } }

// Requests without cookies (Paddle webhooks, the Studio plugin's bearer token) are exempt from the browser-origin check.
const NO_ORIGIN_CHECK = [/^\/api\/billing\/webhook$/, /^\/api\/plugin\//];
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.lua': 'text/plain; charset=utf-8', '.json': 'application/json' };

function csp(nonce: string) {
  return [
    "default-src 'self'", `script-src 'self' 'nonce-${nonce}' https://accounts.google.com/gsi/client https://cdn.paddle.com`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style", "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://tr.rbxcdn.com https://*.googleusercontent.com", "connect-src 'self' https://accounts.google.com/gsi/ https://*.paddle.com",
    "frame-src https://accounts.google.com/gsi/ https://*.paddle.com", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
    ...(config.isProd ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

export async function buildApp(opts: { memoryDb?: boolean; worker?: boolean } = {}): Promise<FastifyInstance> {
  assertProductionConfig();
  await connect({ memory: opts.memoryDb });
  await seedLegal();
  registerHandlers();
  const app = Fastify({ bodyLimit: 4 * 1024 * 1024, trustProxy: config.isProd, logger: config.isProd ? { redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["paddle-signature"]'] } : false });
  await app.register(cookie);
  // Keep the raw body: Paddle signatures are computed over the exact bytes received.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as any).rawBody = body;
    if (!body) return done(null, {});
    try { done(null, JSON.parse(body as string)); } catch { done(new HttpError(400, 'Invalid JSON'), undefined); }
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.cspNonce = randomBytes(16).toString('base64');
    if (!req.url.startsWith('/api/')) return;
    const t = throttles.api.take(ip(req)); if (!t.ok) throw new HttpError(429, 'Too many requests. Slow down a little.');
    const path = req.url.split('?')[0];
    // CSRF: state-changing requests from the browser must come from LaunchPad's own origin with a JSON body.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !NO_ORIGIN_CHECK.some(r => r.test(path))) {
      const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : '');
      if (origin !== config.appOrigin) throw new HttpError(403, 'Request blocked: it didn\'t come from LaunchPad.');
      if (req.headers['content-length'] && req.headers['content-length'] !== '0' && !String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
    }
    await loadSession(req);
  });
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('Content-Security-Policy', csp(reply.cspNonce));
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self "https://*.paddle.com")');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin-allow-popups'); // Google sign-in popups
    if (config.isProd) reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, ...err.extra });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.statusCode === 413 ? 'That upload is too large.' : 'Bad request.' });
    req.log?.error({ err: { message: err.message, code: err.code } }, 'unhandled');
    return reply.code(500).send({ error: 'Something went wrong on our side. Please try again.' });
  });

  for (const r of [authRoutes, meRoutes, dataRoutes, legalRoutes, billingRoutes, robloxRoutes, adminRoutes, analyticsRoutes]) await app.register(r);
  app.get('/healthz', async () => ({ ok: true }));

  // Pages: inline scripts get this response's CSP nonce.
  const html = (f: string) => readFileSync(join('public', f), 'utf8');
  const sendPage = (f: string) => async (req: any, reply: any) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(html(f).replace(/<script(?=[\s>])/g, `<script nonce="${reply.cspNonce}"`));
  app.get('/', sendPage('index.html'));
  app.get('/admin', sendPage('admin.html'));
  // The plugin is served with this deployment's address filled in; it contains no secrets.
  app.get('/plugin/LaunchPadStudio.lua', async (req, reply) => reply.type('text/plain; charset=utf-8').header('Content-Disposition', 'attachment; filename="LaunchPadStudio.lua"')
    .send(readFileSync('plugin/LaunchPadStudio.lua', 'utf8').replace('__LAUNCHPAD_URL__', config.appOrigin)));
  app.get('/*', async (req, reply) => {
    const rel = normalize(decodeURIComponent((req.params as any)['*'] || '')).replace(/^([.][.][\\/])+/, '');
    const file = join('public', rel);
    if (!file.startsWith('public') || rel.includes('..') || !existsSync(file) || extname(file) === '.html') return reply.code(404).send({ error: 'Not found' });
    return reply.type(MIME[extname(file)] ?? 'application/octet-stream').header('Cache-Control', 'public, max-age=3600').send(createReadStream(file));
  });

  if (opts.worker !== false) { const stop = startWorker(); app.addHook('onClose', async () => stop()); }
  return app;
}

if (process.argv[1]?.endsWith('server.ts')) {
  const app = await buildApp();
  await app.listen({ port: config.port, host: config.isProd ? '0.0.0.0' : 'localhost' });
  console.log(`LaunchPad running at ${config.appOrigin}`);
}
