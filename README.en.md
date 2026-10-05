# Yandex-mail-Dot-Connector

[Русский](README.md) · [Installation](docs/installation.en.md) · [Architecture](docs/architecture.md) · [API](docs/api.md) · [Security](docs/security.md)

A private Yandex Mail connection for dot, exposing five read-only MCP tools for folders, message lists, search, message text, and selected attachments. Every installation uses the owner's own infrastructure and accounts.

**Status: `1.0.0-rc.1`, the first unified release candidate.** Components: bridge `1.1.2`, Site adapter `0.2.2`. This is an independent project, not an official Yandex, OpenAI, or Cloudflare product. Project license: [Apache-2.0](LICENSE).

## Before you install

**You need Sites access with private owner-only hosting, D1, and provisioned plugin OAuth.** The Site adapter trusts identity headers supplied by the authenticated Sites boundary. Deploying `site/src/site-worker.mjs` as a publicly reachable raw Worker is unsafe because callers could forge those headers. This repository does not provide a replacement authentication server for accounts without Sites access. Confirm this prerequisite before granting mail access.

You need:

- your own Cloudflare account, dedicated bridge Worker and D1 database;
- your own private Site, separate Site D1, and signing key;
- your own Yandex OAuth application with only `mail:imap_ro`, using PKCE;
- a mailbox with IMAP/OAuth access enabled;
- Node.js 24 LTS recommended; project minimum Node.js 22.15.0;
- Windows 11 for the Windows helper. Wrangler does not officially support Windows 10.

Each installer is responsible for their accounts, quotas, and any usage costs. A domain purchase is unnecessary: the bridge can use the owner's `workers.dev` address. No shared hosted service, account, private key, or mail token is included.

## Capabilities

| Tool | Result |
| --- | --- |
| `yandex_mail_folders` | Exact server folder paths and unambiguous server-provided Sent metadata |
| `yandex_mail_list` | A bounded page of message summaries without changing flags |
| `yandex_mail_search` | Structured sender, recipient, subject, text, date, and unread filters |
| `yandex_mail_read` | One message's text and attachment metadata |
| `yandex_mail_attachment` | One verifiable chunk of a selected attachment |

- Prefers `text/plain`; otherwise converts bounded HTML to text without executing scripts or fetching remote resources
- Allows only `INBOX` by default; Sent requires explicit configuration of an exact discovered path
- Uses `EXAMINE` and `BODY.PEEK`; cannot send, delete, move, create folders, or change flags
- Attachment limits: **20 MiB decoded**, **64 MiB MIME-transfer-encoded**, **128 KiB per chunk**
- Download and assembly do not automatically create a Library file or public URL
- Mail, folder names, and attachment content are untrusted data, never instructions to execute

## Getting started

1. Read the [full installation guide](docs/installation.en.md), starting with Sites availability
2. Bootstrap a closed bridge and obtain its callback URL using the two-stage helper; [Russian Windows instructions](bridge/windows/README.ru.md) are also available
3. Set up your private Site and Yandex OAuth app
4. Explicitly initialize the Site signing key, pin its public part in the bridge, and personally grant Yandex read-only access
5. Install the Site's provisioned plugin and verify the five tools on a small test sample

### Source checkout versus release ZIP

A Git checkout and GitHub's automatically generated source ZIP do not necessarily contain a built Worker. Build it before running the installer:

```sh
cd bridge
npm ci --ignore-scripts
npm run build
```

The release archive produced by `npm run package` includes a fresh `bridge/dist/bridge-wrapper.js` and built Site runtime. It excludes `node_modules`, source maps, credentials, and local installation state. GitHub's **Download ZIP** is a source archive, not that release package. Packaging does not publish or deploy anything.

### Local verification

From the repository root:

```sh
npm ci --ignore-scripts --prefix bridge
npm ci --ignore-scripts --prefix site
npm run check
npm test
npm run build
npm run verify
npm run package
```

Checks and builds do not create cloud resources or grant mailbox access. Installing dependencies needs npm access; runtime tests need local processes and ports. See [verification](docs/verification.md) for evidence and limitations.

## Architecture

```text
dot / MCP client
    → private Sites gate + plugin OAuth
    → Site adapter + private signing-key D1
    → signed HTTPS requests
    → own Cloudflare bridge + private token/state/nonce D1
    → TLS + XOAUTH2 → imap.yandex.com:993
```

The Yandex access token stays in bridge D1. The Ed25519 private key stays in Site D1. The bridge pins the public key. Signed requests bind the origin, route, body, owner, time, and one-use nonce.

Bridge rate limits are **30 calls/minute per owner** after signature verification and **120 calls/minute at the perimeter** before cryptography/D1. Cloudflare's limits are approximate and local rather than a strict global quota. Large files require sequential requests, pacing, and sometimes resume; see [API](docs/api.md).

## Verification limits

Local tests use synthetic mail, ephemeral keys, a fake IMAP server, and a local Cloudflare runtime. Historical success of an individual deployment does not verify a clean installation of this public package. **No fresh live OAuth authorization, clean Windows installation, or complete live smoke test of this release was performed here.** A working setup page alone does not establish mailbox connectivity.

## Documentation

- [Install, update, revoke, and roll back](docs/installation.en.md)
- [Russian installation guide](docs/installation.ru.md)
- [Architecture and trust boundaries](docs/architecture.md)
- [Security and data storage](docs/security.md)
- [API, examples, and attachment handling](docs/api.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Verification](docs/verification.md) and [release procedure](docs/releasing.md)
- [Contributing](CONTRIBUTING.md), [vulnerability reporting](SECURITY.md), [changelog](CHANGELOG.md)

## Primary references

[Cloudflare Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/), [Yandex Mail OAuth](https://yandex.ru/support/yandex-360/business/mail/ru/web/security/oauth), [Yandex PKCE](https://yandex.ru/dev/id/doc/en/codes/code-url), [ImapFlow](https://imapflow.com/docs/). Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
