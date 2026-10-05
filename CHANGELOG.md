# Changelog

Unified release versions describe this repository as a whole. Bridge and Site component versions are separate and do not indicate that earlier unified public releases existed.

## 1.0.0-rc.1 — 2026-10-05

First public release candidate, prepared for review. Components: bridge **1.1.2**, Site adapter **0.2.2**. Preparing this candidate does not publish a release or deploy infrastructure.

### Included

- Five single-owner read-only MCP tools for folders, list, search, read, and selected attachment chunks
- Fixed Yandex TLS/XOAUTH2 connection, allowlisted folders, UID/UIDVALIDITY identity, `EXAMINE` and `BODY.PEEK`
- Plain-text preference and bounded HTML-to-text fallback without rendering or remote-resource loading
- Exact folder-path discovery and explicit optional Sent access; no automatic permission expansion
- Attachments up to 20 MiB decoded, 64 MiB encoded, and 128 KiB per chunk, with metadata/offset/hash validation and exclusive private materialization
- Bounded sequential download pacing, safe 429 handling, and validated checkpoint resume through an injected MCP client
- Separate private Sites adapter and owner-owned Cloudflare bridge, with Ed25519 signing, replay protection, and authorization-code/S256 PKCE flow
- Windows two-stage bootstrap/configure helper, isolated temporary Wrangler authorization, cleanup, and interrupted-setup recovery
- Russian and English overviews/install guides, architecture, security, API, troubleshooting, contribution, and release documentation
- Sanitized configuration templates, reproducible packaging with freshly built runtime output, and Apache-2.0 project licensing

### Structural changes

- Canonical bridge authentication/OAuth/token storage resides only in `bridge/`
- Site storage contains only its signing-key store; duplicate bridge wrappers/OAuth modules are excluded from the Site runtime
- Source checkouts require dependency installation and build; prepared release ZIPs include the current production bridge bundle without source maps

### Dependency maintenance

- Pinned Drizzle ORM 0.45.2 and a scoped esbuild 0.25.12 override for Drizzle Kit's deprecated loader dependency; schema generation is unchanged and full npm audits reported zero advisories at preparation time

### Known limitations

- Private owner-only Sites availability and provisioned plugin OAuth are prerequisites; the Site handler is unsafe on a public raw Worker
- No silent refresh token, multi-user service, mail mutation, automatic attachment execution, or automatic Library upload
- Cloudflare rate limits are approximate/local: owner 30/min, perimeter 120/min
- Fresh live authorization, clean Windows installation, and full live smoke verification of this public candidate have not been performed. Historical success of a separate deployment is not installer evidence

See [verification](docs/verification.md) for actual checks and [installation](docs/installation.en.md) for operations and rollback limits.
