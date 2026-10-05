import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler, normalizeArgs, ownerAuthorizer, createSignedBridgeClient } from '../src/mcp.mjs';
import { signedBridgeRequest, verifyBridgeRequest } from '../src/signing.mjs';
import { createOAuthHandler, accessTokenProvider } from '../../bridge/src/oauth.mjs';

const rpc = (method, params, extra = {}) => new Request('https://private.example/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
const ownerHeaders = { 'oai-authenticated-user-id': 'owner-1', 'oai-authenticated-user-email': 'owner@example.invalid' };
const authorization = ownerAuthorizer({ ownerUserId: 'owner-1', ownerEmail: 'owner@example.invalid' });

test('discovery contains only five read tools and no private data', async () => {
  const handler = createMcpHandler({ authorizeOwner: authorization, bridgeCall: () => { throw new Error('Should not call'); } });
  const response = await handler(rpc('tools/list'));
  const body = await response.json();
  assert.equal(body.result.tools.length, 5);
  assert.ok(body.result.tools.every(tool => tool.annotations.readOnlyHint));
  assert.equal(JSON.stringify(body).includes('owner@example.invalid'), false);
  assert.match(response.headers.get('cache-control'), /no-store/);
});

test('mail rejects anonymous, wrong owner, and identity-less service access', async () => {
  let calls = 0;
  const handler = createMcpHandler({ authorizeOwner: authorization, bridgeCall: () => { calls++; } });
  for (const [headers, status] of [[{}, 401], [{ ...ownerHeaders, 'oai-authenticated-user-id': 'intruder' }, 403], [{ 'oai-sites-authorization': 'Bearer test-only' }, 401]]) {
    assert.equal((await handler(rpc('tools/call', { name: 'yandex_mail_list' }, headers))).status, status);
  }
  assert.equal(calls, 0);
  assert.equal(ownerAuthorizer()(rpc('tools/list', {}, ownerHeaders)), null);
});

test('mail routes owner request with validated defaults; provider details not leaked', async () => {
  let forwarded;
  const handler = createMcpHandler({ authorizeOwner: authorization, bridgeCall: async (...args) => { forwarded = args; return { messages: [] }; } });
  const result = await (await handler(rpc('tools/call', { name: 'yandex_mail_list' }, ownerHeaders))).json();
  assert.equal(result.result.isError, false);
  assert.deepEqual(forwarded, ['/v1/messages/list', { mailbox: 'INBOX', limit: 20 }, { userId: 'owner-1' }]);
  const failing = createMcpHandler({ authorizeOwner: authorization, bridgeCall: () => { throw new Error('secret-token-should-not-escape'); } });
  const failed = await (await failing(rpc('tools/call', { name: 'yandex_mail_list' }, ownerHeaders))).text();
  assert.equal(failed.includes('secret-token'), false);
  assert.equal(JSON.parse(failed).result.isError, true);
});

test('malicious origins, unknown writes, raw IMAP, bad bounds and invalid dates fail', async () => {
  const handler = createMcpHandler({ authorizeOwner: authorization, bridgeCall: () => { throw new Error('Unexpected bridge call'); } });
  assert.equal((await handler(rpc('tools/list', {}, { Origin: 'https://attacker.invalid' }))).status, 403);
  for (const name of ['send', 'delete', 'yandex_mail_mark_read']) {
    const result = await (await handler(rpc('tools/call', { name }, ownerHeaders))).json();
    assert.equal(result.error.code, -32602);
  }
  for (const args of [{ raw: 'EXPUNGE' }, { limit: 10000 }, { mailbox: 'INBOX\r\nSTORE' }, { beforeUid: -1 }, { since: '2026-02-30' }, { unseen: 'yes' }]) {
    assert.throws(() => normalizeArgs('yandex_mail_search', args));
  }
  assert.throws(() => normalizeArgs('yandex_mail_read', { uid: 1 }));
  assert.throws(() => normalizeArgs('yandex_mail_read', { uid: 1, uidValidity: '4294967296' }));
});

test('MCP initialization, notifications and unsupported protocol are correct', async () => {
  const handler = createMcpHandler({ authorizeOwner: authorization, bridgeCall: () => ({}) });
  const init = await (await handler(rpc('initialize', { protocolVersion: '2025-03-26' }))).json();
  assert.equal(init.result.protocolVersion, '2025-03-26');
  const notification = new Request('https://private.example/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal((await handler(notification)).status, 202);
  assert.equal((await handler(rpc('tools/list', {}, { 'MCP-Protocol-Version': 'bad' }))).status, 400);
  assert.equal((await handler(new Request('https://private.example/mcp'))).status, 405);
});

test('signed requests bind origin, owner, route, body, nonce and time', async () => {
  // Ephemeral fixture keys, never persisted or registered anywhere.
  const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const body = JSON.stringify({ mailbox: 'INBOX', limit: 20 });
  const now = 1791032000000;
  const request = await signedBridgeRequest({ url: 'https://bridge.example/v1/messages/list', body, privateKey: keys.privateKey, siteId: 'site-1', ownerId: 'owner-1', now });
  const seen = new Set();
  const claimNonce = async ({ nonce }) => { if (seen.has(nonce)) return false; seen.add(nonce); return true; };
  const verify = overrides => verifyBridgeRequest({ request, body, publicKey: keys.publicKey, siteId: 'site-1', ownerId: 'owner-1', origin: 'https://bridge.example', claimNonce, now, ...overrides });
  assert.equal(await verify({ body: '{}' }), false);
  assert.equal(await verify({ ownerId: 'owner-2' }), false);
  assert.equal(await verify({ origin: 'https://other.example' }), false);
  assert.equal(await verify({ now: now + 61000 }), false);
  assert.equal(await verify({ claimNonce: undefined }), false);
  assert.equal(await verify({ claimNonce: async () => { throw new Error('storage down'); } }), false);
  assert.equal(await verify({}), true);
  assert.equal(await verify({}), false);
});

test('bridge client rejects redirects and arbitrary proxy paths', async () => {
  const key = (await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])).privateKey;
  let request;
  const client = createSignedBridgeClient({ origin: 'https://bridge.example', siteId: 'site-1', getSigningKey: async () => key, signRequest: signedBridgeRequest, fetchImpl: async (req, options) => { request = req; assert.equal(options.redirect, 'manual'); return Response.json({ messages: [] }); } });
  assert.deepEqual(await client('/v1/messages/list', { mailbox: 'INBOX' }, { userId: 'owner-1' }), { messages: [] });
  assert.equal(request.headers.has('X-Ymail-Signature'), true);
  await assert.rejects(client('/admin', {}, { userId: 'owner-1' }));
  assert.throws(() => createSignedBridgeClient({ origin: 'http://bridge.example' }));
});

function oauthFixture({ scope = 'mail:imap_ro', now = 1791032000000 } = {}) {
  const states = new Map(), tokens = new Map();
  let tokenRequest, exchangeCount = 0;
  const store = {
    createState: async (key, value) => { states.set(key, value); },
    consumeState: async key => { const result = states.get(key); states.delete(key); return result; },
    setToken: async (site, owner, value) => { tokens.set(JSON.stringify([site, owner]), value); },
    getToken: async (site, owner) => tokens.get(JSON.stringify([site, owner]))
  };
  const handler = createOAuthHandler({ clientId: 'public-client-id', bridgeOrigin: 'https://bridge.example', siteOrigin: 'https://private.example', ownerEmail: 'owner@example.invalid', verifyMailboxToken: async (email, token) => email === 'owner@example.invalid' && token === 'test-only-access-token', authorizeStart: async request => request.headers.get('X-Test-Owner') === 'yes' ? { userId: 'owner-1', siteId: 'site-1' } : null, store, now: () => now,
    fetchImpl: async (url, options) => { exchangeCount++; tokenRequest = { url, options }; return Response.json({ token_type: 'bearer', access_token: 'test-only-access-token', refresh_token: 'test-only-refresh-token', expires_in: 3600, scope }); }
  });
  const start = () => handler(new Request('https://bridge.example/v1/oauth/start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-Owner': 'yes' }, body: '{}' }));
  return { handler, store, states, tokens, start, now, get tokenRequest() { return tokenRequest; }, get exchangeCount() { return exchangeCount; } };
}

test('PKCE OAuth exchange is server-only, read-only, single-use and discards refresh token', async () => {
  const f = oauthFixture();
  const start = await (await f.start()).json();
  const url = new URL(start.authorizationUrl);
  assert.equal(url.origin, 'https://oauth.yandex.ru');
  assert.equal(url.searchParams.get('scope'), 'mail:imap_ro');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.has('client_secret'), false);
  const state = url.searchParams.get('state');
  const callback = new Request(`https://bridge.example/oauth/callback?state=${state}&code=test-code`);
  const response = await f.handler(callback);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), 'https://private.example/?connection=authorized');
  assert.equal(await response.text(), '');
  assert.equal(f.tokenRequest.options.body.get('code_verifier').length, 43);
  assert.equal(f.tokenRequest.options.body.has('client_secret'), false);
  assert.equal(f.tokenRequest.options.redirect, 'manual');
  const saved = await f.store.getToken('site-1', 'owner-1');
  assert.equal(saved.accessToken, 'test-only-access-token');
  assert.equal(JSON.stringify(saved).includes('refresh'), false);
  assert.equal((await f.handler(callback)).status, 400);
  assert.equal(f.exchangeCount, 1);
  assert.deepEqual(await accessTokenProvider({ store: f.store, siteId: 'site-1', ownerId: 'owner-1', ownerEmail: 'owner@example.invalid', now: () => f.now })(), { accessToken: 'test-only-access-token', owner: 'owner@example.invalid', scopes: ['mail:imap_ro'] });
  await assert.rejects(accessTokenProvider({ store: f.store, siteId: 'site-1', ownerId: 'owner-1', ownerEmail: 'owner@example.invalid', now: () => f.now + 3600000 })());
  await assert.rejects(accessTokenProvider({ store: f.store, siteId: 'site-1', ownerId: 'owner-1', ownerEmail: 'other@example.invalid', now: () => f.now })());
});

test('OAuth callback rejects wrong state, duplicate state, expired state and expanded scopes', async () => {
  const f = oauthFixture({ scope: 'mail:imap_full' });
  assert.equal((await f.handler(new Request('https://bridge.example/oauth/callback?state=bad&code=bad'))).status, 400);
  const state = new URL((await (await f.start()).json()).authorizationUrl).searchParams.get('state');
  assert.equal((await f.handler(new Request(`https://bridge.example/oauth/callback?state=${state}&state=${state}&code=test-code`))).status, 400);
  assert.equal(f.exchangeCount, 0);
  assert.equal((await f.handler(new Request(`https://bridge.example/oauth/callback?state=${state}&code=test-code`))).status, 400);
  assert.equal(f.tokens.size, 0);
  const other = oauthFixture();
  const s = new URL((await (await other.start()).json()).authorizationUrl).searchParams.get('state');
  other.states.get(s).expiresAt = 0;
  assert.equal((await other.handler(new Request(`https://bridge.example/oauth/callback?state=${s}&code=test-code`))).status, 400);
  assert.equal(other.exchangeCount, 0);
});

test('folder and attachment routes are signed, body-bound, and reject replay', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  for (const [path, body] of [['/v1/mailboxes/discover', '{}'], ['/v1/messages/attachment', JSON.stringify({ mailbox: 'INBOX', uid: 23, uidValidity: '44', part: '2', offset: 131072 })]]) {
    const request = await signedBridgeRequest({ url: 'https://bridge.example' + path, body, privateKey: keys.privateKey, siteId: 'site-1', ownerId: 'owner-1' });
    const seen = new Set();
    const params = { request, body, publicKey: keys.publicKey, siteId: 'site-1', ownerId: 'owner-1', origin: 'https://bridge.example', claimNonce: async ({ nonce }) => { if (seen.has(nonce)) return false; seen.add(nonce); return true; } };
    assert.equal(request.redirect, 'manual');
    assert.equal(await verifyBridgeRequest({ ...params, body: body + ' ' }), false);
    assert.equal(await verifyBridgeRequest({ ...params, request: new Request('https://bridge.example/v1/messages/read', request) }), false);
    assert.equal(await verifyBridgeRequest(params), true);
    assert.equal(await verifyBridgeRequest(params), false);
  }
});

test('signed bridge never follows an HTTP redirect on new read routes', async () => {
  const key = (await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])).privateKey;
  let fetches = 0;
  const client = createSignedBridgeClient({ origin: 'https://bridge.example', siteId: 'site-1', getSigningKey: async () => key, signRequest: signedBridgeRequest, fetchImpl: async (_request, options) => {
    fetches++;
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 307, headers: { location: 'https://different.invalid/' } });
  } });
  await assert.rejects(client('/v1/mailboxes/discover', {}, { userId: 'owner-1' }));
  await assert.rejects(client('/v1/messages/attachment', { uid: 23, uidValidity: '44', part: '2' }, { userId: 'owner-1' }));
  assert.equal(fetches, 2);
});
