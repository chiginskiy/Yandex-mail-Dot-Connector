import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createSigningKeyStore } from '../src/d1-stores.mjs';
import { createBridgeStore } from '../../bridge/src/d1-stores.mjs';
import { createSiteWorker } from '../src/site-worker.mjs';
import { verifyBridgeRequest } from '../src/signing.mjs';

function database(schema) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL(schema === 'bridge' ? '../../bridge/schema/bridge.sql' : '../schema/site.sql', import.meta.url), 'utf8'));
  return { sqlite, prepare(sql) {
    const statement = sqlite.prepare(sql);
    return { bind(...args) {
      return { async first() { return statement.get(...args) ?? null; }, async run() { const value = statement.run(...args); return { success: true, meta: { changes: Number(value.changes) } }; } };
    }};
  }};
}

test('durable SQL stores consume OAuth state once, pin owner, and reject nonce replay', async () => {
  const db = database('bridge');
  const store = createBridgeStore(db, () => 1791032000000);
  const state = { ownerId: 'owner-1', siteId: 'site-1', verifier: 'test-only', expiresAt: 1791032300000 };
  await store.createState('state-1', state);
  assert.deepEqual(await store.consumeState('state-1'), state);
  assert.equal(await store.consumeState('state-1'), null);
  assert.equal(await store.claimNonce({ siteId: 'site-1', nonce: 'nonce-1', expiresAt: 1791032121 }), true);
  assert.equal(await store.claimNonce({ siteId: 'site-1', nonce: 'nonce-1', expiresAt: 1791032121 }), false);
  await store.setToken('site-1', 'owner-1', { accessToken: 'test-only', owner: 'owner@example.invalid', scope: 'mail:imap_ro' });
  assert.equal((await store.getToken('site-1', 'owner-1')).accessToken, 'test-only');
  assert.equal(await store.getToken('site-1', 'other-owner'), null);
  db.sqlite.close();
});

test('private Site setup is owner-only, explicit POST only, and exports only public keys', async () => {
  const db = database('site');
  const env = { SITE_ORIGIN: 'https://private.example', BRIDGE_ORIGIN: 'https://bridge.example', SITE_ID: 'site-1', OWNER_CHATGPT_EMAIL: 'owner@example.invalid', DB: db };
  const identity = { 'oai-authenticated-user-id': 'owner-1', 'oai-authenticated-user-email': 'owner@example.invalid' };
  const keyStore = createSigningKeyStore(db);
  const app = createSiteWorker({ fetchImpl: async signed => {
    const publicKey = await crypto.subtle.importKey('jwk', await keyStore.publicKey('owner-1'), 'Ed25519', false, ['verify']);
    assert.equal(await verifyBridgeRequest({ request: signed, body: await signed.text(), publicKey, siteId: 'site-1', ownerId: 'owner-1', origin: env.BRIDGE_ORIGIN, claimNonce: async () => true }), true);
    return Response.json({ authorizationUrl: 'https://oauth.yandex.ru/authorize?scope=mail%3Aimap_ro' });
  }});
  const get = (path, headers = identity) => app.fetch(new Request(env.SITE_ORIGIN + path, { headers }), env);
  assert.equal((await get('/', {})).status, 403);
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  const pageText = await page.text();
  assert.match(pageText, /Пароли и токены не нужно вставлять сюда или в чат/);
  assert.match(pageText, /HTML-письма преобразуются в безопасный текст/);
  assert.match(pageText, /до 20 МиБ/);
  assert.match(pageText, /Папка «Отправленные» подключается по точному имени/);
  assert.match(pageText, /пересоздавать ключ или повторно выдавать разрешение Яндекса не нужно/);
  assert.doesNotMatch(pageText, /скачивание вложений не поддерживаются/);
  const initial = await (await get('/api/connection/public-key')).json();
  assert.equal(initial.publicKey, null);
  assert.equal((await get('/api/connection/initialize')).status, 403);
  assert.equal(await keyStore.publicKey('owner-1'), null);
  const post = (path, confirm, origin = env.SITE_ORIGIN) => app.fetch(new Request(env.SITE_ORIGIN + path, { method: 'POST', headers: { ...identity, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm }) }), env);
  assert.equal((await post('/api/connection/initialize', 'create_private_signing_key', 'https://attacker.invalid')).status, 403);
  const initialized = await (await post('/api/connection/initialize', 'create_private_signing_key')).json();
  assert.equal(initialized.publicKey.kty, 'OKP');
  assert.equal(initialized.publicKey.crv, 'Ed25519');
  assert.equal(initialized.publicKey.d, undefined);
  assert.equal(JSON.stringify(initialized).includes('private_jwk'), false);
  const again = await (await post('/api/connection/initialize', 'create_private_signing_key')).json();
  assert.deepEqual(initialized, again);
  assert.equal((await keyStore.signingKey('owner-1')).extractable, false);
  const authorization = await (await post('/api/connection/authorize', 'connect_yandex_mail_readonly')).json();
  assert.equal(new URL(authorization.authorizationUrl).origin, 'https://oauth.yandex.ru');
  db.sqlite.close();
});

test('initial private Site works without Cloudflare; authorization and mail clearly require configuration', async () => {
  const db = database('site');
  const env = { SITE_ORIGIN: 'https://private.example', SITE_ID: 'site-1', OWNER_CHATGPT_EMAIL: 'owner@example.invalid', DB: db };
  const identity = { 'oai-authenticated-user-id': 'owner-1', 'oai-authenticated-user-email': 'owner@example.invalid' };
  const app = createSiteWorker({ fetchImpl: async () => { throw new Error('No network should be attempted before configuration'); } });
  const get = path => app.fetch(new Request(env.SITE_ORIGIN + path, { headers: identity }), env);
  const page = await get('/');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Cloudflare ещё не настроен/);
  assert.match(html, /id="authorize" disabled/);
  assert.match(html, /Создать ключ связи/);
  assert.match(html, /\/favicon.svg/);
  assert.equal((await get('/favicon.svg')).headers.get('content-type'), 'image/svg+xml');
  assert.equal((await (await get('/api/connection/public-key')).json()).publicKey, null);
  const post = (path, body) => app.fetch(new Request(env.SITE_ORIGIN + path, { method: 'POST', headers: { ...identity, Origin: env.SITE_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
  const created = await post('/api/connection/initialize', { confirm: 'create_private_signing_key' });
  assert.equal(created.status, 200);
  assert.equal((await created.json()).publicKey.crv, 'Ed25519');
  const auth = await post('/api/connection/authorize', { confirm: 'connect_yandex_mail_readonly' });
  assert.equal(auth.status, 503);
  assert.equal((await auth.json()).error, 'configuration_required');
  const discovery = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal((await discovery.json()).result.tools.length, 5);
  const mail = await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'yandex_mail_list' } });
  const reply = (await mail.json()).result;
  assert.equal(reply.isError, true);
  assert.equal(reply.structuredContent.status, 'configuration_required');
  db.sqlite.close();
});
