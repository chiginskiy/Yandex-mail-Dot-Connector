# Architecture

[Overview](../README.en.md) · [Security](security.md) · [API](api.md)

The connection is single-owner and has two separately deployed components. The canonical bridge is `bridge/`; the Site adapter is `site/`. Do not copy bridge OAuth or token-storage modules into the Site. They intentionally have different trust and storage boundaries.

## Components and data flow

```text
Owner / dot
  │ Sites sign-in and provisioned plugin OAuth
  ▼
Private owner-only Site
  ├─ setup UI and /api/connection/*
  ├─ /mcp with five tools
  └─ Site D1: Ed25519 signing key for the owner
  │ signed HTTPS POST, fixed route allowlist
  ▼
Owner's Cloudflare bridge Worker
  ├─ perimeter and owner rate-limit bindings
  ├─ signature, body, timestamp, nonce, identity checks
  ├─ OAuth authorization code + PKCE callback
  └─ bridge D1: mail token, OAuth state, used nonces
  │ fixed imap.yandex.com:993, TLS, XOAUTH2
  ▼
Configured Yandex mailbox
```

The bridge has a public HTTPS address because Yandex must reach its callback and the Site must call it. Mail routes are protected by signed requests. The Site, by contrast, **must remain private behind Sites authentication**. A public raw Worker cannot trust caller-supplied `oai-authenticated-user-*` headers.

## Identity and authorization

Sites owns hosting authentication and the plugin OAuth flow. This code does not implement an interchangeable OAuth gateway for arbitrary MCP hosts. The Site reads the trusted platform headers, requires a Site-scoped user ID, checks the configured owner email, and, once pinned, also checks the owner ID. It never accepts an owner from request JSON.

Initial setup can pin the verified email before the Site-scoped user ID is available. After explicit key initialization, pin `OWNER_SITE_USER_ID` in the Site and bridge. The bridge always requires its configured owner and Site IDs. The repository is not multi-tenant: use separate deployments, databases, keys, and OAuth apps for separate owners.

Protocol discovery (`initialize`, `ping`, `tools/list`) is metadata, not proof of mail authorization. Owner validation is required for tool execution and setup actions, in addition to the hosting gate.

## Signed request protocol

The Site signs a canonical UTF-8 sequence using Ed25519:

```text
ymail-bridge-v1
<bridge origin>
<site ID>
<owner ID>
<Unix timestamp seconds>
<nonce>
POST
<exact path>
<base64url SHA-256 of the exact request body>
```

Headers are `X-Ymail-Site`, `X-Ymail-Owner`, `X-Ymail-Time`, `X-Ymail-Nonce`, and `X-Ymail-Signature`. Verification pins the HTTPS origin, accepts only approved paths and POST, rejects query strings, verifies the body digest and signature, checks a ±60-second timestamp window, and claims nonce uniqueness atomically in D1. A verified nonce cannot be reused across instances. Failure or absence of the nonce store fails closed.

Each retry is a new Site-to-bridge request with a fresh signature/nonce. Do not replay a previously signed Request. Do not redirect signed bridge requests to another origin; fetch uses manual redirect handling and rejects unsuccessful responses.

## OAuth lifecycle

1. The owner explicitly clicks the connection-key action. Site D1 creates a persistent Ed25519 key pair once; only public material is exposed
2. The owner configures the public key and identities in the bridge, and registers a Yandex app with only `mail:imap_ro`
3. A signed `POST /v1/oauth/start` with exact body `{}` creates a random state and PKCE verifier in bridge D1, expiring after ten minutes
4. The browser goes to the official Yandex authorization endpoint with S256 challenge and the exact callback
5. `GET /oauth/callback` atomically consumes state before exchange. Malformed, expired, replayed, rejected, or duplicate parameters fail
6. The bridge exchanges the code on the fixed Yandex token endpoint, rejects redirects and unsafe/oversized responses, validates the returned token metadata, and authenticates it to the configured mailbox before storage
7. The access token stays in bridge D1. The callback returns to the fixed private Site origin. A refresh token is deliberately discarded
8. Expiry/revocation requires owner reauthorization. A token near expiry is not used

A token response may omit scope. In that case the exact app registration/request and read-only IMAP implementation remain essential; do not register broader mail permissions.

## Storage ownership

| Location | Stored data | What it must not contain |
| --- | --- | --- |
| Site D1 `signing_keys` | Private/public Ed25519 JWK and owner ID | Mail token or cached messages |
| Bridge D1 `mail_tokens` | Owner-bound read-only access token and expiry | Site private signing key |
| Bridge D1 `oauth_states` | Temporary verifier, owner/Site binding, expiry | Long-lived refresh token |
| Bridge D1 `used_nonces` | Replay-prevention identifiers and expiry | Mail content |
| Bridge variables | Fixed public key, app Client ID, origins, identities, mailbox allowlist | Hand-pasted access token |
| Local installer `.local` | Setup state and temporary isolated Wrangler auth directory | Data intended for release or public support |
| Local attachment checkpoint/output | Selected file bytes and metadata | Publicly shared download link by default |

Schemas are applied by deployment/migration workflows, never initialized on runtime HTTP requests. Expired states/nonces are cleaned during corresponding operations; do not interpret this as an independent background retention service. Expired/revoked token rows can remain until replaced or explicitly removed. There is no application-level encryption envelope over D1 payloads; provider security and account access are trusted.

## Read-only IMAP boundary

The client fixes host, port, and TLS to `imap.yandex.com:993`. Client inputs cannot supply a token, owner, host, proxy, port, arbitrary command, or new mailbox permission. Each operation uses a short connection. The bridge does not maintain a mailbox cache or connection pool.

Folder discovery reads metadata without enabling folders. Other operations open an allowlisted mailbox read-only and require the server to confirm that state. Wire tests cover `EXAMINE` and `BODY.PEEK`; writes, flag changes, mailbox creation, sending, and deletion are absent from the tool surface.

UID is meaningful only within a mailbox and UIDVALIDITY. Read/attachment callers must use the values returned by the list/search flow. UIDVALIDITY changes reject stale identities instead of silently reading another message.

ImapFlow 2.2.1 needs a narrowly scoped XOAUTH2 capability adapter for Yandex. Updating ImapFlow requires code review and wire tests; a dependency upgrade is not automatically compatible.

## Bounded content processing

- List/search: at most 50 summaries, default 20; a scanned UID window of 1,000. Empty pages can still have a continuation cursor
- Text: 32 KiB output; HTML source: 128 KiB before bounded conversion. Plain text is preferred
- MIME: at most 100 visited nodes and 30 attachment descriptors; flags disclose truncation
- Discovery: at most 100 folders; ambiguity or truncation prevents automatic Sent selection
- Mail HTTP request: 8 KiB; bridge JSON response: 256 KiB; MCP request: 16 KiB
- IMAP operation: 15 seconds, with separate connection/socket/body limits
- Attachment: 20 MiB decoded, 64 MiB encoded, 128 KiB per chunk

HTML conversion is parser-based. It does not render HTML, run JavaScript, or retrieve images/links. Attachment bytes are fetched separately and reconstructed only after validation; they are never automatically executed or unpacked.

## Rate limiting and attachment transport

The perimeter limiter runs before signature validation or D1 at 120 requests/minute; the owner limiter runs after a valid signature at 30/minute. Keys are fixed server-side, so a caller cannot create arbitrary buckets. Cloudflare limits are approximate and local to processing locations, not global billing controls or complete DDoS protection. Perimeter pressure can temporarily affect the legitimate owner. See [Cloudflare rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

Each chunk opens a new IMAP connection and rechecks identity and MIME metadata. `dataBase64` wraps raw MIME-transfer-encoded bytes. The client concatenates transport-decoded chunks, verifies continuity and hashes, then decodes MIME transfer encoding exactly once. It never applies text charset or flowed-text transformations to attachment bytes.

The injected-client download helper adds bounded pacing, safe 429 retries, and validated resume. It is not a standalone credential-bearing MCP client. The assembler calculates a final local SHA-256; the server does not independently attest the whole-file digest. See [API](api.md).

## Deployment and verification boundary

The bridge release bundle is built from the authenticated wrapper, not the bare core. The Site build contains only the adapter runtime. Root verification covers static/unit/wire/runtime checks and synthetic integration; it does not authorize a mailbox or publish infrastructure. A prior working deployment is distinct from a clean installer rehearsal of this release. See [verification](verification.md).
