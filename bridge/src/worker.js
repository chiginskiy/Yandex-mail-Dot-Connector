import { createHash, timingSafeEqual } from 'node:crypto';
import { BridgeError, fail } from './errors.js';
import { LIMITS, readConfig, validateInput } from './validation.js';
import { createYandexClient, performOperation } from './imap.js';

const ROUTES = new Map([
  ['/v1/messages/list', 'list'], ['/v1/messages/search', 'search'], ['/v1/messages/read', 'read'],
  ['/v1/mailboxes/discover', 'discover'], ['/v1/messages/attachment', 'attachment'],
]);
const HEADERS = {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
};
function response(status, body) {
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json) > LIMITS.responseBytes) return new Response('{"error":{"code":"response_limit_exceeded"}}', {status: 502, headers: HEADERS});
  return new Response(json, {status, headers: HEADERS});
}
function authorize(request, env) {
  const secret = env.BRIDGE_SECRET;
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 512 || /[\s\u0000-\u001f]/u.test(secret)) fail(503, 'not_configured');
  const supplied = request.headers.get('authorization') ?? '';
  if (supplied.length > 520) fail(401, 'unauthorized');
  const hash = value => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(hash(supplied), hash(`Bearer ${secret}`))) fail(401, 'unauthorized');
  return true;
}
async function boundedBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) fail(415, 'json_required');
  if (request.headers.has('content-encoding')) fail(415, 'encoded_body_not_supported');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > LIMITS.requestBytes)) fail(413, 'request_too_large');
  if (!request.body) fail(400, 'invalid_json');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  const started = Date.now();
  try {
    for (;;) {
      const {done, value} = await deadline(() => reader.read(), Math.max(1, LIMITS.bodyMs - (Date.now() - started)), () => { void reader.cancel().catch(() => {}); });
      if (done) break;
      size += value.byteLength;
      if (size > LIMITS.requestBytes) fail(413, 'request_too_large');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { void reader.cancel().catch(() => {}); }
}
async function deadline(work, ms, onTimeout = () => {}) {
  let timer;
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => { timer = setTimeout(() => { onTimeout(); reject(new BridgeError(504, 'request_timeout')); }, ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

/**
 * Injection boundary for the later owner-only OAuth callback/refresh store.
 * Do not return a token obtained with a wider scope. This prepared build has no
 * OAuth credentials, token-copy form, or manual access-token configuration.
 */
export async function unconfiguredTokenProvider() { fail(503, 'oauth_setup_required'); }

export function createWorker({ getAccessToken = unconfiguredTokenProvider, authorizeRequest, createClient = createYandexClient, operationTimeoutMs = LIMITS.operationMs } = {}) {
  return {
    async fetch(request, env) {
      let client;
      try {
        const url = new URL(request.url);
        if (url.protocol !== 'https:' && !(url.hostname === 'localhost' || url.hostname === '127.0.0.1')) fail(400, 'https_required');
        if (!authorizeRequest) authorize(request, env);
        const operation = ROUTES.get(url.pathname);
        if (!operation) fail(404, 'not_found');
        if (request.method !== 'POST') fail(405, 'post_required');
        if (url.search) fail(400, 'query_string_not_allowed');
        const bytes = await boundedBody(request);
        if (authorizeRequest && await deadline(() => authorizeRequest(request, env, bytes), 3000) !== true) fail(401, 'unauthorized');
        const config = readConfig(env);
        let body;
        try { body = JSON.parse(bytes.toString('utf8')); } catch { fail(400, 'invalid_json'); }
        const input = validateInput(operation, body, config.mailboxes);
        const abort = new AbortController();
        const result = await deadline(async () => {
          const grant = await getAccessToken(env, abort.signal);
          if (abort.signal.aborted) fail(504, 'request_timeout');
          if (!grant || grant.owner !== config.owner || !Array.isArray(grant.scopes) || grant.scopes.length !== 1 || grant.scopes[0] !== 'mail:imap_ro') fail(503, 'invalid_oauth_grant');
          if (typeof grant.accessToken !== 'string' || !grant.accessToken.length || grant.accessToken.length > 8192 || /[\u0000-\u0020\u007f]/u.test(grant.accessToken)) fail(503, 'invalid_oauth_grant');
          client = createClient(config.owner, grant.accessToken);
          try {
            await client.connect();
            if (abort.signal.aborted) fail(504, 'request_timeout');
            return await performOperation(client, operation, input);
          } finally { client.close(); }
        }, operationTimeoutMs, () => { abort.abort(); client?.close(); });
        return response(200, result);
      } catch (error) {
        if (error instanceof BridgeError) return response(error.status, {error: {code: error.code}});
        // Never reflect an IMAP/provider error or stack: these can contain secrets.
        return response(502, {error: {code: 'mail_upstream_failed'}});
      } finally {
        // One connection per request; no CLOSE/EXPUNGE, connection pool, or mailbox cache.
        client?.close();
      }
    },
  };
}
export default createWorker();
