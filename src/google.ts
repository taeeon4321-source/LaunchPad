// Google ID token verification (Google Identity Services). Signature via Google's JWKS, then issuer, audience,
// expiry and nonce. The stable account key is `sub`; email is only trusted when Google says it's verified.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { config } from './config.ts';
import { sha256, safeEqual } from './security.ts';

let jwks: JWTVerifyGetKey = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export const setGoogleJwksForTests = (k: JWTVerifyGetKey) => { jwks = k; };

export async function verifyGoogleCredential(credential: unknown, nonceHash: string | undefined) {
  if (!config.google.clientId) throw new Error('Google sign-in is not configured');
  if (typeof credential !== 'string' || credential.length > 4096) throw new Error('Invalid credential');
  const { payload } = await jwtVerify(credential, jwks, { issuer: ['accounts.google.com', 'https://accounts.google.com'], audience: config.google.clientId, clockTolerance: 30 });
  if (!nonceHash || typeof payload.nonce !== 'string' || !safeEqual(sha256(payload.nonce), nonceHash)) throw new Error('Nonce mismatch');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('Missing subject');
  return { sub: payload.sub, email: typeof payload.email === 'string' ? payload.email : null, emailVerified: payload.email_verified === true, name: typeof payload.name === 'string' ? payload.name : null };
}
