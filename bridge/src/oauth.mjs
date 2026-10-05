import { limitedText } from './http.mjs';
// Bridge-side OAuth module. Stores and authorization are injected, fail-closed.
// No token is returned to the Site, browser, MCP caller, or logs.
const encoder = new TextEncoder();
const b64url = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const json = (body, status = 200) => Response.json(body, { status, headers });
const failure = () => new Response('Connection was not completed. Return to your private Site and start again.', { status: 400, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });

export function createOAuthHandler({ clientId, bridgeOrigin, siteOrigin, ownerEmail, authorizeStart, verifyMailboxToken, store, fetchImpl = fetch, now = Date.now }) {
  const bridge = new URL(bridgeOrigin);
  const site = new URL(siteOrigin);
  for (const origin of [bridge, site]) if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('Invalid origin');
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(clientId)) throw new Error('Invalid client ID');
  const callback = new URL('/oauth/callback', bridge).href;
  return async request => {
    const url = new URL(request.url);
    if (url.origin !== bridge.origin) return failure();
    if (url.pathname === '/v1/oauth/start') {
      if (request.method !== 'POST' || request.headers.get('content-type') !== 'application/json') return failure();
      // Start requests contain no user parameters. This is also the signed body.
      let body;
      try { body = await limitedText(request.body, 2); } catch { return failure(); }
      if (body !== '{}') return failure();
      const owner = await authorizeStart(request, body);
      if (!owner?.userId || !owner?.siteId) return json({ error: 'Owner authentication required' }, 403);
      const state = random();
      const verifier = random();
      const challenge = b64url(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
      try {
        await store.createState(state, { ownerId: owner.userId, siteId: owner.siteId, verifier, expiresAt: now() + 600000 });
      } catch { return json({ error: 'Connection temporarily unavailable' }, 503); }
      const authorize = new URL('https://oauth.yandex.ru/authorize');
      for (const [key, value] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: callback, scope: 'mail:imap_ro', force_confirm: 'yes', state, code_challenge: challenge, code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
      return json({ authorizationUrl: authorize.href });
    }
    if (url.pathname !== '/oauth/callback') return json({ error: 'Not found' }, 404);
    if (request.method !== 'GET') return failure();
    const states = url.searchParams.getAll('state');
    const codes = url.searchParams.getAll('code');
    if (states.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(states[0])) return failure();
    let pending;
    try { pending = await store.consumeState(states[0]); } catch { return failure(); }
    if (!pending || pending.expiresAt <= now() || url.searchParams.has('error') || codes.length !== 1 || !/^[A-Za-z0-9._-]{1,1024}$/.test(codes[0])) return failure();
    try {
      const tokenResponse = await fetchImpl('https://oauth.yandex.ru/token', {
        // workerd supports manual/follow, not error. Reject all 3xx below.
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: codes[0], client_id: clientId, code_verifier: pending.verifier })
      });
      if (!tokenResponse.ok || !tokenResponse.headers.get('content-type')?.includes('application/json')) return failure();
      const text = await limitedText(tokenResponse.body, 16384);
      const token = JSON.parse(text);
      if (token.token_type?.toLowerCase() !== 'bearer' || typeof token.access_token !== 'string' || !/^[A-Za-z0-9._~-]{1,4096}$/.test(token.access_token)) return failure();
      if (!Number.isSafeInteger(token.expires_in) || token.expires_in <= 0 || token.expires_in > 315576000) return failure();
      if (token.scope !== undefined && token.scope.trim() !== 'mail:imap_ro') return failure();
      // Authenticate this token to the fixed configured mailbox before persisting.
      // Never accept a caller-supplied owner or a caller-supplied access token.
      if (!ownerEmail || typeof verifyMailboxToken !== 'function' || await verifyMailboxToken(ownerEmail, token.access_token) !== true) return failure();
      await store.setToken(pending.siteId, pending.ownerId, { accessToken: token.access_token, owner: ownerEmail, expiresAt: now() + token.expires_in * 1000, scope: 'mail:imap_ro' });
      // Deliberately discard refresh_token; reauthorization is explicit on expiry.
      return new Response(null, { status: 303, headers: { ...headers, Location: new URL('/?connection=authorized', site).href } });
    } catch { return failure(); }
  };
}

export function accessTokenProvider({ store, siteId, ownerId, ownerEmail, now = Date.now }) {
  return async () => {
    const token = await store.getToken(siteId, ownerId);
    if (!token || token.owner !== ownerEmail || !ownerEmail || token.scope !== 'mail:imap_ro' || token.expiresAt <= now() + 60000 || !token.accessToken) throw new Error('Reauthorization required');
    return { accessToken: token.accessToken, owner: token.owner, scopes: ['mail:imap_ro'] };
  };
}
