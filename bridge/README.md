# Bridge component

Component version: **1.1.2**, included in unified release **1.0.0-rc.1**. [Русский обзор](../README.md) · [English overview](../README.en.md)

The bridge is the owner's Cloudflare Worker for signed Site requests, Yandex OAuth, and read-only IMAP. It is the canonical home of bridge authentication and mail-token storage; the Site component must not duplicate these modules.

## Production entry point

`src/bridge-wrapper.mjs` composes request signatures, D1 state/token/nonce storage, mandatory rate-limit bindings, OAuth, and the IMAP core. Production builds create `dist/bridge-wrapper.js`. Do not deploy `src/worker.js` directly or add a shared bearer-token shortcut.

The bridge always connects to `imap.yandex.com:993` with TLS and XOAUTH2. The only requested OAuth scope is `mail:imap_ro`. Mailboxes must be explicitly allowlisted. Reads use `EXAMINE`/`BODY.PEEK`; no SMTP, message deletion/movement, folder creation, or flag changes are exposed.

## Local development

Node.js 24 LTS is recommended; minimum 22.15.0. From this directory:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm run test:runtime
npm run test:auth-runtime
```

`npm run verify` runs these stages together. Build is a local dry-run, not a deployment. Runtime tests use local workerd and synthetic services; wire tests exercise pinned ImapFlow against a local synthetic IMAP server. They do not verify a real mailbox or Windows installer.

The production release bundle is rebuilt during root `npm run package`; source maps and test runtime bundles are excluded. Never reuse a private installation's `dist` folder as a release input.

## Installation

Read the complete [English](../docs/installation.en.md) or [Russian](../docs/installation.ru.md) guide first. Private owner-only Sites hosting is a prerequisite even though the bridge itself runs in your Cloudflare account.

The [Windows helper](windows/README.ru.md) supports two stages from this directory:

```powershell
npx.cmd --yes --package=wrangler@4.145.0 node .\windows\setup.mjs bootstrap
npx.cmd --yes --package=wrangler@4.145.0 node .\windows\setup.mjs configure
```

Run the second command only after completing your own Site/Yandex public settings. Bootstrap creates a fail-closed Worker and a dedicated D1, then prints the callback. Configure updates the same Worker. Both require deliberate confirmation before cloud changes. They do not run Yandex authorization or read mail.

The default `wrangler.jsonc` is for local builds. `wrangler.deploy.example.jsonc` is a reference for manual administrators, not a filled deployment configuration. Replace placeholders only with your verified installation values and use unique rate-limit namespace IDs. The helper manages its own ignored configuration beneath `.local`.

## Runtime configuration

| Binding/variable | Purpose |
| --- | --- |
| `DB` | Dedicated private D1 using `schema/bridge.sql` |
| `PERIMETER_LIMITER` | Fixed-key 120 requests/min limiter, before signature/D1 |
| `OWNER_LIMITER` | Fixed-owner 30 requests/min limiter, after signature |
| `SITE_ID` | Exact registered Site ID |
| `OWNER_SITE_USER_ID` | Pinned Site-scoped owner ID |
| `SITE_PUBLIC_KEY_JWK` | Public Ed25519 JWK JSON; never a private `d` field |
| `SITE_ORIGIN` | Exact private Site HTTPS origin |
| `BRIDGE_ORIGIN` | Exact bridge HTTPS origin |
| `YANDEX_CLIENT_ID` | Your app's public client ID |
| `YANDEX_OWNER_EMAIL` | Fixed mailbox owner |
| `ALLOWED_MAILBOXES` | JSON array; default `["INBOX"]` |

The helper accepts optional `SENT_MAILBOX` in the local connection file and derives `ALLOWED_MAILBOXES`. Discovery never expands this allowlist. Origins cannot contain paths, query strings, credentials, or trailing slashes.

D1 contains mail access tokens, temporary OAuth state/verifiers, and used nonces. It must be separate from Site signing-key D1. Tokens are not exposed to the Site or MCP caller, and no refresh token is retained. Do not export this database to public support channels.

## Limits and protocol

Mail requests are capped at 8 KiB, JSON responses at 256 KiB, list/search pages at 50 messages, and IMAP operations at 15 seconds. Attachments are ≤20 MiB decoded, ≤64 MiB encoded, and ≤128 KiB per chunk. Cloudflare rate limits are local/approximate, not global cost guarantees. Full tool and route contracts: [API](../docs/api.md).

ImapFlow 2.2.1's Yandex XOAUTH2 adapter is deliberately narrow and depends on pinned internals. Review and rerun wire/runtime tests when updating it. Third-party license notices are maintained in the repository's [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

See [architecture](../docs/architecture.md), [security](../docs/security.md), [troubleshooting](../docs/troubleshooting.md), and [verification](../docs/verification.md) before changing deployment behavior.
