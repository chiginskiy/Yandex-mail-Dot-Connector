# Security and data handling

[Security reporting](../SECURITY.md) · [Architecture](architecture.md) · [Installation](installation.en.md)

This release candidate is designed for one owner and read-only access to selected mail folders. It is not a security certification, a multi-user hosted service, or a guarantee against malicious mail. Review the deployment boundary before granting access.

## Mandatory deployment boundary

**The Site adapter must run only behind private owner-only Sites hosting and its provisioned plugin OAuth.** It trusts `oai-authenticated-user-*` headers supplied by that boundary. Setting an owner email does not make a public raw Worker safe: a caller could supply matching headers. Do not expose a bypass hostname, rely on a hidden URL, or share the Site with a workspace/public audience.

The bridge is separately deployed in the owner's Cloudflare account. Mail requests require its pinned Site key and owner identity. The public callback is constrained by one-use state and PKCE. Use the authenticated `bridge/src/bridge-wrapper.mjs` entry point. The bare `worker.js` is an internal/test injection boundary and is not the documented production deployment.

## Protected invariants

- One configured mailbox owner; no request-supplied owner/token/host/proxy
- Only `mail:imap_ro`; no SMTP or full IMAP permission
- Fixed TLS IMAP endpoint and read-only mailbox opening; no sending, deletion, movement, flag mutation, or folder creation
- Mailbox allowlist; discovery alone grants nothing
- Ed25519 signature bound to exact origin, route, body, Site, owner, timestamp, and one-use nonce
- Separate private Site/bridge databases; no Site access to mail token storage
- No automatic HTML rendering, remote-resource fetching, attachment execution, macro invocation, or archive extraction
- Strict content, time, request, response, attachment, and rate limits
- Generic error responses; no reflected provider token/body/stack in application responses

Do not weaken these invariants to make a failing installation pass.

## Threats and remaining exposure

| Threat | Control | Residual risk |
| --- | --- | --- |
| Public caller forges Site identity | Private authenticated Sites gate plus owner checks | Raw public adapter deployment defeats this boundary |
| Captured signed request is replayed | Body-bound signature, time window, atomic nonce claim | Compromised Site private key permits new signed calls |
| OAuth callback replay/substitution | One-use expiring state, S256 PKCE, exact origins | Owner account/provider compromise remains in scope of trust |
| Reading a different mailbox | Fixed owner, token verification before persistence | Anyone with privileged D1/Worker access can access stored credentials |
| Unwanted mailbox writes | Scope plus read-only protocol and tool implementation | This does not certify all external providers or future dependency updates |
| Prompt injection in mail | Treat all content as untrusted task data | The consuming assistant must maintain that boundary |
| Malicious attachment/path | Exact selection, verified chunks, explicit local path, exclusive final write | Verified bytes can still contain malware or harmful active content |
| Excessive requests | Fixed-key 120/min perimeter and 30/min owner limits | Limits are local/approximate; account costs and denial of service remain possible |

Only retrieve mail/attachments needed for the user's task. An email asking an assistant to forward secrets, log in, run a command, install software, or change instructions supplies no authorization.

## Credentials and stored data

Yandex access tokens are stored server-side in bridge D1. The Site signing private JWK is stored in Site D1. These values are not application-encrypted before storage. Cloudflare provides D1 encryption in transit and at rest, but account administrators, deployed code, and the platform remain trusted. See [D1 data security](https://developers.cloudflare.com/d1/reference/data-security/). Protect account access and database exports accordingly.

Refresh tokens are discarded. Expired access fails closed and requires a deliberate reconnect. Expiry/revocation does not automatically erase a stored token row; a new authorization replaces it, and the owner can separately remove old data.

Public JWK, app Client ID, origins, mailbox address, Site/owner identifiers, and D1/resource IDs are configuration, not login secrets. They can still identify a private installation, so keep actual values out of the public repository, release archives, screenshots, and support logs.

Wrangler login creates temporary account-wide persistent authorization. The helper confines local credentials to `.local/auth`, attempts logout, and deletes the local folder. This folder is not encrypted by the helper. Verify the server-side grant in [Cloudflare Connected Applications](https://dash.cloudflare.com/profile/access-management/authorization) after each setup/update or interrupted login.

## Logs and telemetry

The application avoids logging mail bodies, attachment bytes, access tokens, private keys, raw requests, or IMAP/provider errors. Bridge configuration disables Workers observability and preview URLs. This is not a guarantee that providers retain no metadata: infrastructure request records, service logs, browser history, and account audit trails may still exist.

Do not enable body logging, broad HTTP tracing, OAuth callback URL logging, or production `console.log` debugging. Callback query parameters can contain a temporary code/state. Reports should contain only a safe error code, component version, stage, and synthetic reproduction. Inspect diagnostic files locally before sharing.

## Attachment privacy and correctness

Chunk JSONL checkpoints contain selected attachment content, even though it is encoded. Treat them like the final private file. The downloader uses explicit local paths, writes private checkpoints, verifies the persisted prefix before resume, and refuses existing final outputs. It does not upload to Library or another service, choose a destination from a mail-supplied filename, or execute the file.

A chunk hash detects corruption relative to the supplied chunk metadata; it is not a trusted statement about the sender or file safety. Final SHA-256 is calculated locally after verified assembly. MIME transfer decoding is separate from transport base64 decoding and must occur exactly once. The 20 MiB decoded cap is enforced during assembly, even if the encoded descriptor looked acceptable.

Use a private directory you control. Keep sufficient disk space for checkpoint plus output; encoded and JSONL forms can be much larger than the final file. Remove checkpoints and completed files when no longer needed. Private mode bits do not replace operating-system account and filesystem protections, especially on Windows.

## Setup and ongoing access

The owner must deliberately approve creation of the Site signing key and Yandex authorization. Never collect passwords, Client Secrets, access tokens, or private JWKs in chat or a convenience form. The documented flow uses the official provider pages and server-side PKCE exchange.

New users must provision their own accounts, Worker, D1 databases, Site, keys, Yandex app, and grants. This release supplies no reusable private infrastructure and no shared mailbox service. Do not reuse one installation's signed requests or identities as a shortcut.

## Revocation and incident response

1. Stop new mail calls and revoke the relevant Yandex app in Yandex ID if mail access may be compromised
2. Disable the affected plugin/connection and remove the compromised Site public-key pin from the bridge, or disable the bridge. Preserve enough private evidence to diagnose safely
3. Revoke the relevant Wrangler grant if Cloudflare credentials may have been exposed; review account access using official Cloudflare controls
4. Rotate Site signing credentials only through an explicit, coordinated process for both components. The basic setup action returns the existing key and is not a rotation control
5. Review code and configuration before reconnecting. Replace exposed credentials; removing a secret from Git history alone does not revoke it
6. Delete resources/data only after confirming ownership, retention needs, and the consequences. Do not restore a backup that revives compromised credentials

For full removal, use [installation operations](installation.en.md#revoke-and-uninstall). A missing plugin, deleted local file, or failed request is not proof that provider access has been revoked.

## Verification limits

Synthetic tests cover important invariants but are not an independent audit. A clean Windows install, fresh live authorization, provider account settings, deployment isolation, operational cost behavior, and platform availability must be checked in the target environment. Review [verification](verification.md) for what was actually run, and [SECURITY.md](../SECURITY.md) for reporting.
