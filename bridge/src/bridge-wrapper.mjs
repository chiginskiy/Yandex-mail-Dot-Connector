// Canonical production composition: signed, owner-bound, rate-limited read-only bridge.
import { createWorker } from './worker.js';
import { verifyYandexToken } from './imap.js';
import { createBridgeStore } from './d1-stores.mjs';
import { createOAuthHandler, accessTokenProvider } from './oauth.mjs';
import { verifyBridgeRequest } from './signing.mjs';
import { requireRateLimit } from './rate-limit.js';
import { BridgeError } from './errors.js';

export function createAuthenticatedBridge({ coreFactory = createWorker, validateToken = verifyYandexToken, storeFor = env => createBridgeStore(env.DB), fetchImpl = fetch } = {}) {
  return { async fetch(request, env) {
    try {
      // One single-user perimeter bucket per Cloudflare location; no user/IP
      // input can create unlimited buckets. Apply before crypto or D1 access.
      if (typeof env.OWNER_LIMITER?.limit !== 'function') throw new BridgeError(503, 'rate_limit_unavailable');
      await requireRateLimit(env.PERIMETER_LIMITER, 'yandex-readonly-bridge-perimeter');
      if (!env.SITE_ID || !env.OWNER_SITE_USER_ID || !env.BRIDGE_ORIGIN || !env.SITE_ORIGIN || !env.YANDEX_OWNER_EMAIL) throw new Error('Configuration required');
      if (typeof env.SITE_PUBLIC_KEY_JWK !== 'string' || env.SITE_PUBLIC_KEY_JWK.length > 2048) throw new Error('Public key required');
      const jwk = JSON.parse(env.SITE_PUBLIC_KEY_JWK);
      if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || jwk.d !== undefined || !/^[A-Za-z0-9_-]{43}$/.test(jwk.x ?? '') || ![undefined, 'EdDSA', 'Ed25519'].includes(jwk.alg)) throw new Error('Invalid public key');
      // Node exports alg=Ed25519; workerd expects EdDSA. The fixed key type/curve
      // and algorithm argument are authoritative; import portable public fields.
      const publicKey = await crypto.subtle.importKey('jwk', {kty:'OKP',crv:'Ed25519',x:jwk.x,ext:true}, 'Ed25519', false, ['verify']);
      const store = storeFor(env);
      const verify = async (req, body) => {
        const valid = await verifyBridgeRequest({ request: req, body, publicKey, siteId: env.SITE_ID, ownerId: env.OWNER_SITE_USER_ID, origin: env.BRIDGE_ORIGIN, claimNonce: value => store.claimNonce(value) });
        if (!valid) return false;
        await requireRateLimit(env.OWNER_LIMITER, `site:${env.SITE_ID}:owner:${env.OWNER_SITE_USER_ID}`);
        return true;
      };
      const url = new URL(request.url);
      if (url.pathname === '/v1/oauth/start' || url.pathname === '/oauth/callback') {
        return await createOAuthHandler({
          clientId: env.YANDEX_CLIENT_ID, bridgeOrigin: env.BRIDGE_ORIGIN, siteOrigin: env.SITE_ORIGIN, ownerEmail: env.YANDEX_OWNER_EMAIL,
          authorizeStart: async (req, body) => await verify(req, body) ? { userId: env.OWNER_SITE_USER_ID, siteId: env.SITE_ID } : null,
          verifyMailboxToken: validateToken, store, fetchImpl
        })(request);
      }
      const core = coreFactory({
        authorizeRequest: (req, _env, bytes) => verify(req, new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        getAccessToken: accessTokenProvider({ store, siteId: env.SITE_ID, ownerId: env.OWNER_SITE_USER_ID, ownerEmail: env.YANDEX_OWNER_EMAIL })
      });
      return await core.fetch(request, env);
    } catch(error) {
      if(error instanceof BridgeError) return Response.json({error:{code:error.code}},{status:error.status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',...(error.status===429?{'Retry-After':'60'}:{})}});
      return Response.json({ error: { code: 'connection_not_configured' } }, { status: 503, headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });
    }
  }};
}
export default createAuthenticatedBridge();
