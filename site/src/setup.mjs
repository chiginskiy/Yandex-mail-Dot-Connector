import { limitedText } from './http.mjs';
import { signedBridgeRequest } from './signing.mjs';
const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };

export function configuredBridgeOrigin(value) {
  try {
    const bridge = new URL(value);
    if (bridge.protocol !== 'https:' || bridge.pathname !== '/' || bridge.search || bridge.hash || bridge.username || bridge.password) return null;
    return bridge;
  } catch { return null; }
}

// Backend for a small owner-only setup page. No mutation through GET.
// The UI must explain that initialize creates a persistent private signing key.
export function createSetupHandler({ authorizeOwner, keyStore, siteId, bridgeOrigin, fetchImpl = fetch }) {
  return async request => {
    const url = new URL(request.url);
    const owner = await authorizeOwner(request);
    if (!owner) return Response.json({ error: 'Owner authentication required' }, { status: 403, headers });
    if (url.pathname === '/api/connection/public-key' && request.method === 'GET') {
      return Response.json({ siteId, ownerId: owner.userId, publicKey: await keyStore.publicKey(owner.userId) }, { headers });
    }
    if (request.method !== 'POST' || request.headers.get('origin') !== url.origin || request.headers.get('content-type') !== 'application/json') return Response.json({ error: 'Invalid request' }, { status: 403, headers });
    let body;
    try { body = JSON.parse(await limitedText(request.body, 128)); } catch { return Response.json({ error: 'Invalid request' }, { status: 400, headers }); }
    if (url.pathname === '/api/connection/initialize' && body.confirm === 'create_private_signing_key') {
      const publicKey = await keyStore.initialize(owner.userId);
      return Response.json({ siteId, ownerId: owner.userId, publicKey }, { headers });
    }
    if (url.pathname === '/api/connection/authorize' && body.confirm === 'connect_yandex_mail_readonly') {
      const bridge = configuredBridgeOrigin(bridgeOrigin);
      if (!bridge) return Response.json({ error: 'configuration_required', message: 'Cloudflare connection setup is incomplete. The connection key can be created first.' }, { status: 503, headers });
      let stage = 'key_load';
      try {
        const privateKey = await keyStore.signingKey(owner.userId);
        stage = 'request_sign';
        const signed = await signedBridgeRequest({ url: new URL('/v1/oauth/start', bridge).href, body: '{}', privateKey, siteId, ownerId: owner.userId });
        stage = 'bridge_fetch';
        const response = await fetchImpl(signed, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
        stage = 'bridge_http_' + response.status;
        if (!response.ok) return Response.json({error:stage,message:'Ошибка соединения: '+stage},{status:503,headers});
        stage = 'bridge_response';
        const result = JSON.parse(await limitedText(response.body, 16384));
        stage = 'authorization_target';
        const target = new URL(result.authorizationUrl);
        if (target.origin !== 'https://oauth.yandex.ru' || target.pathname !== '/authorize' || target.searchParams.get('scope') !== 'mail:imap_ro') throw new Error('Invalid authorization target');
        return Response.json({ authorizationUrl: target.href }, { headers });
      } catch (error) {
        if (stage === 'request_sign' && ['signing_digest','signing_crypto','signing_request'].includes(error?.safeCode)) stage = error.safeCode;
        return Response.json({error:stage,message:'Ошибка соединения: '+stage},{status:503,headers});
      }
    }
    return Response.json({ error: 'Not found' }, { status: 404, headers });
  };
}
