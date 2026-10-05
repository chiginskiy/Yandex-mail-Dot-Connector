# Private Site adapter

Component version: **0.2.2**, included in unified release **1.0.0-rc.1**. [Installation](../docs/installation.en.md) · [Установка](../docs/installation.ru.md)

This component provides the owner-only setup page, five MCP tools, and the signed client for the separate bridge. Its only persistent store is the Site signing-key table. OAuth exchange, mail tokens, and nonce storage belong to `../bridge/`.

## Required hosting boundary

**Use only private owner-only Sites hosting with trusted identity injection and provisioned plugin OAuth. Do not publish this handler as a public raw Worker.** `ownerAuthorizer` trusts Sites-provided `oai-authenticated-user-id` and `oai-authenticated-user-email`. An internet client could forge them on a raw Worker; an environment variable containing the correct owner email does not fix that.

Sites access with server runtime, D1, and the MCP plugin capability is an explicit prerequisite. This repository does not contain a standalone MCP authentication gateway or an account-independent one-click Site installer. Confirm account/workspace support before creating keys or granting mail access.

## Files

| Path | Responsibility |
| --- | --- |
| `src/site-worker.mjs` | Fetch router, private setup page, `/mcp`, setup API |
| `src/mcp.mjs` | Five tool schemas, owner checks, normalization, signed bridge client, safe 429 metadata |
| `src/setup.mjs` | Explicit key initialization and Yandex authorization kickoff |
| `src/signing.mjs` | Web Crypto Ed25519 canonical request signing |
| `src/d1-stores.mjs` | Site signing keys only |
| `db/schema.ts`, `drizzle/` | Site schema and deployment migrations |
| `schema/site.sql` | Human-readable schema reference |
| `scripts/assemble-attachment.mjs` | Offline exact-byte verification and assembly |
| `scripts/download-attachment.mjs` | Injected-client bounded pacing/retry/resume |

There is no Site copy of the bridge wrapper, bridge token store, or bridge OAuth implementation. Do not reintroduce one.

## Build and test

From this directory, with Node.js 24 LTS recommended and minimum 22.15.0:

```sh
npm ci --ignore-scripts
npm test
npm run build
```

The build produces `dist/server/index.js` and only the Site runtime modules. It does not register a Site or deploy. Tests include synthetic owner isolation, setup flow, storage, MIME assembly, and download behavior. Root `npm run verify` also exercises integration with the adjacent bridge and local runtime tests. Fresh live OAuth and a new Windows installation are separate unperformed checks for this candidate.

For an intentional schema change, update `db/schema.ts`, run `npm run db:generate`, review the generated migration, and apply it only through the supported Site deployment workflow. Do not generate replacement migrations during an ordinary code-only update or run SQL schema creation from web requests.

## Deployment contract

Use the supported Sites workflow to create or update your own private Site, configure MCP capability, and apply the D1 migration. Platform registration/hosting metadata must belong to your project. `hosting.example.json` is an explanatory placeholder only; **never rename and deploy it blindly**. The platform must generate and verify the actual `.openai/hosting.json`, project identity, database metadata, build/archive, and plugin connection details.

`wrangler.site.example.jsonc` is for local runtime testing only. It does not create a trusted Sites gateway and is not a production raw-worker deployment recipe.

| Binding/variable | Value |
| --- | --- |
| `DB` | This Site's private D1 with the `signing_keys` table |
| `SITE_ORIGIN` | Exact HTTPS origin assigned to this private Site |
| `BRIDGE_ORIGIN` | Exact origin of your separate bridge |
| `SITE_ID` | Actual registered Site ID |
| `OWNER_CHATGPT_EMAIL` | Owner's verified account email |
| `OWNER_SITE_USER_ID` | Pin the Site-scoped ID returned after initial key creation |

The email-pinned initial bootstrap lets the owner initialize a key before the Site-scoped ID is known. Pin the returned ID in both components afterward. Keep the email check. `.env.example` is a configuration reference, not proof that production hosting automatically imports a local environment file. Configure runtime variables through the supported platform path.

No token, private key, cookie, password, or Client Secret belongs in environment examples, hosting manifests, archives, command arguments, or repository history.

## Setup page behavior

- `GET /` shows the private Russian setup page to the owner
- `GET /api/connection/public-key` returns existing public configuration; it does not create a key
- `POST /api/connection/initialize` requires same-origin JSON and the explicit confirmation marker `create_private_signing_key`; it creates one persistent private key in Site D1, or returns the existing public key
- `POST /api/connection/authorize` requires same-origin JSON and `connect_yandex_mail_readonly`; it signs the exact bridge OAuth-start request and returns an official Yandex authorization URL
- `/mcp` exposes folders/list/search/read/attachment tools through the provisioned plugin

The owner's UI clicks express the explicit setup actions. Do not invoke key creation preemptively during installation checks. Key initialization is not rotation. The owner pins public output in the bridge before starting Yandex authorization.

The adapter sanitizes bridge failures. A safe 429 exposes only `status: "rate_limited"`, `httpStatus: 429`, and bounded `retryAfterSeconds`. It never forwards raw provider error bodies or arbitrary headers.

## Attachments

Read returns descriptors, not file bytes. Selected bytes arrive through authenticated chunks. The download helper accepts a caller-supplied authorized MCP client, paces sequential requests, retries only bounded safe 429s, and validates private JSONL checkpoints before resume. It performs no login, implicit upload, automatic execution, or Library registration. See [API examples](../docs/api.md#recommended-download-helper).

## Updating safely

Update the same private Site; preserve its project ID, owner bindings, D1, signing key, and plugin identity. Update the matching bridge separately. Do not initialize a new key or request a new Yandex grant just because code changed. Recheck tool schema and owner isolation after publishing. See [operations](../docs/installation.en.md#updates) and [security](../docs/security.md).
