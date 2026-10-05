# Contributing

Contributions should preserve the single-owner, read-only design. Discuss architectural changes before expanding authentication, storage, mailbox permissions, supported providers, or the public tool surface. Do not submit production credentials or captured personal mail.

## Local workflow

Use Node.js 24 LTS, with minimum 22.15.0. Runtime tests need a supported OS and local process/port access.

```sh
npm ci --ignore-scripts --prefix bridge
npm ci --ignore-scripts --prefix site
npm run check
npm test
npm run build
npm run verify
npm run package
```

These commands are local checks/builds, not authorization or deployment. Never use a maintainer's cloud project or mail account for tests. Use synthetic MIME fixtures, temporary test keys, and fake tokens. For exact release gates see [releasing](docs/releasing.md) and [verification](docs/verification.md).

## Code boundaries

- `bridge/` owns OAuth, mail-token/state/nonce storage, request verification, and IMAP
- `site/` owns private setup UI, owner checks, MCP schemas, signing-key storage, and the signed bridge client
- Keep the bridge wrapper/OAuth implementation canonical in `bridge/`; do not restore duplicate copies in the Site
- Apply schemas through migrations, never from runtime HTTP requests
- Preserve exact attachment bytes; no charset conversion, automatic file opening, execution, or upload
- Do not introduce caller-controlled upstream origins, tokens, owner identities, arbitrary IMAP commands, or rate-limit bucket keys

## Required evidence for changes

For each pull request describe the user-visible change, threat/compatibility impact, tests run, and untested scenarios. Update Russian and English installation/overview documents together when behavior changes. Component versions may differ from the unified release version; keep changelog and manifests consistent.

Authentication changes need rejection tests for wrong owner/origin/body/signature, stale timestamps, replay, missing stores/bindings, provider redirects, and malformed OAuth responses. IMAP changes need wire tests that exercise the real pinned ImapFlow dependency and preserve `EXAMINE`/`BODY.PEEK`. Attachment changes need corrupt/reordered/missing chunks, exact byte comparison, supported MIME encodings, 20 MiB decoded/64 MiB encoded boundaries, retry exhaustion, cancellation, and resume tests.

ImapFlow's Yandex XOAUTH2 hook depends on pinned internals. Review the upstream implementation and repeat protocol tests before upgrading it. Keep dependency lockfiles updated; do not change a version solely to make an audit count look better without verification.

## Documentation and fixtures

Use `example.invalid` for fictional mail addresses/origins, synthetic UIDs, generated temporary test keys, and plainly marked placeholders. Do not include copied live headers, signed production requests, installed Site IDs, account/database IDs, or operator-specific recovery logic. No screenshots of real inboxes.

Never claim a live deployment, new installer run, Windows rehearsal, or provider OAuth flow passed when only mocks/local runtime checks ran. Report passed, failed, and unrun stages separately.

## Pull requests and license

Keep changes focused and use a draft pull request until the relevant checks and review are complete. Publication, deployment, key creation, and authorization are separate maintainer decisions.

Contributions are provided under this repository's [Apache-2.0 license](LICENSE). Preserve required third-party notices. Source-code permission does not grant permission to use third-party branding, accounts, infrastructure, or mail data. Report security issues through [SECURITY.md](SECURITY.md), not a public exploit-filled issue.
