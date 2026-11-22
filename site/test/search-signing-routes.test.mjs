import test from 'node:test';
import assert from 'node:assert/strict';
import {
  signedBridgeRequest as siteSign,
  verifyBridgeRequest as siteVerify
} from '../src/signing.mjs';
import {
  signedBridgeRequest as bridgeSign,
  verifyBridgeRequest as bridgeVerify
} from '../../bridge/src/signing.mjs';

const origin = 'https://bridge.example.invalid';
const siteId = 'site-1';
const ownerId = 'owner-1';
const now = 1791032000000;

test('all three search-job routes can be signed by Site and verified by Bridge', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const routes = [
    '/v1/search-jobs/start',
    '/v1/search-jobs/status',
    '/v1/search-jobs/results'
  ];
  for (const route of routes) {
    const url = origin + route;
    const body = JSON.stringify({ searchId: '00000000-0000-4000-8000-000000000001' });
    const common = { url, body, siteId, ownerId, now };
    const siteRequest = await siteSign({ ...common, privateKey: keys.privateKey });
    assert.equal(
      await bridgeVerify({
        request: siteRequest, body, publicKey: keys.publicKey, siteId, ownerId,
        origin, now, claimNonce: async () => true
      }),
      true,
      `Bridge rejected Site-signed ${route}`
    );

    const bridgeRequest = await bridgeSign({ ...common, privateKey: keys.privateKey });
    assert.equal(
      await siteVerify({
        request: bridgeRequest, body, publicKey: keys.publicKey, siteId, ownerId,
        origin, now, claimNonce: async () => true
      }),
      true,
      `Site rejected Bridge-signed ${route}`
    );
  }
});

test('signed route allowlist still rejects arbitrary paths, query strings and writes', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  for (const path of [
    '/v1/search-jobs/delete',
    '/v1/messages/send',
    '/v1/search-jobs/start?debug=1',
    '/admin'
  ]) {
    for (const sign of [siteSign, bridgeSign]) {
      await assert.rejects(
        sign({
          url: origin + path, body: '{}',
          privateKey: keys.privateKey, siteId, ownerId, now
        }),
        /Invalid bridge URL/
      );
    }
  }
});
