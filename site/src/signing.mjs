// Web Crypto only. No private key is created, persisted, or exported here.
const encoder = new TextEncoder();
const encode = value => encoder.encode(value);
const b64url = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer)))
  .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
function decode(value) {
  if (!/^[A-Za-z0-9_-]{86}$/.test(value)) throw new Error('Invalid signature');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '=='), c => c.charCodeAt(0));
}
const component = value => typeof value === 'string' && /^[A-Za-z0-9._:@-]{1,200}$/.test(value);
const routes = new Set(['/v1/messages/list', '/v1/messages/search', '/v1/messages/read', '/v1/mailboxes/discover', '/v1/messages/attachment', '/v1/oauth/start']);

function safeUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || !routes.has(parsed.pathname)) {
    throw new Error('Invalid bridge URL');
  }
  return parsed;
}

async function canonical({ url, body, siteId, ownerId, timestamp, nonce }) {
  const digest = b64url(await crypto.subtle.digest('SHA-256', encode(body)));
  return encode(['ymail-bridge-v1', url.origin, siteId, ownerId, timestamp, nonce, 'POST', url.pathname, digest].join('\n'));
}

export async function signedBridgeRequest({ url, body, privateKey, siteId, ownerId, now = Date.now(), nonce = crypto.randomUUID() }) {
  const parsed = safeUrl(url);
  if (!component(siteId) || !component(ownerId) || !/^[A-Za-z0-9_-]{16,80}$/.test(nonce) || typeof body !== 'string') {
    throw new Error('Invalid signing input');
  }
  const timestamp = String(Math.floor(now / 1000));
  let data, signature;
  try { data = await canonical({ url: parsed, body, siteId, ownerId, timestamp, nonce }); } catch { throw Object.assign(new Error('Signing digest failed'), {safeCode:'signing_digest'}); }
  try { signature = await crypto.subtle.sign('Ed25519', privateKey, data); } catch { throw Object.assign(new Error('Signing operation failed'), {safeCode:'signing_crypto'}); }
  try { return new Request(parsed.href, {
    method: 'POST', body, redirect: 'manual',
    headers: {
      'Content-Type': 'application/json', 'Accept': 'application/json',
      'X-Ymail-Site': siteId, 'X-Ymail-Owner': ownerId,
      'X-Ymail-Time': timestamp, 'X-Ymail-Nonce': nonce,
      'X-Ymail-Signature': b64url(signature)
    }
  }); } catch { throw Object.assign(new Error('Request creation failed'), {safeCode:'signing_request'}); }
}

// claimNonce MUST atomically persist uniqueness across all instances, not memory/KV.
// It returns true only for the first use. Throwing or missing storage fails closed.
export async function verifyBridgeRequest({ request, body, publicKey, siteId, ownerId, origin, claimNonce, now = Date.now() }) {
  try {
    const url = safeUrl(request.url);
    if (url.origin !== origin || request.method !== 'POST' || typeof body !== 'string' || typeof claimNonce !== 'function') return false;
    if (!component(siteId) || !component(ownerId)) return false;
    if (request.headers.get('X-Ymail-Site') !== siteId || request.headers.get('X-Ymail-Owner') !== ownerId) return false;
    const timestamp = request.headers.get('X-Ymail-Time') || '';
    const nonce = request.headers.get('X-Ymail-Nonce') || '';
    const signature = request.headers.get('X-Ymail-Signature') || '';
    if (!/^\d{10,12}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,80}$/.test(nonce)) return false;
    if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 60) return false;
    if (!(await crypto.subtle.verify('Ed25519', publicKey, decode(signature), await canonical({ url, body, siteId, ownerId, timestamp, nonce })))) return false;
    return (await claimNonce({ siteId, nonce, expiresAt: Math.floor(now / 1000) + 121 })) === true;
  } catch {
    return false;
  }
}

export async function publicKeyFingerprint(publicKey) {
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  return b64url(await crypto.subtle.digest('SHA-256', spki));
}
