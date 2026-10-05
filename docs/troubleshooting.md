# Troubleshooting

[Install in English](installation.en.md) · [Установка по-русски](installation.ru.md) · [Security](security.md)

Start with the failing stage and safe error code. Do not solve connection problems by disabling TLS, broadening scopes, making the Site public, bypassing identity, or pasting tokens into configuration.

## Before sharing a report

Include release/component version, OS and Node version, command name, stage, expected result, and a redacted safe error code. Exclude mail, attachment bytes/checkpoints, callback query strings, `.local/auth`, private JWKs, deployed domains, account/Site/database IDs, and unreviewed Wrangler logs. A synthetic reproduction is preferable.

## Installation and local checks

### Sites is not available

Private owner-only Sites hosting, its trusted identity gate, private D1, and provisioned plugin OAuth are required. Confirm availability in your account/workspace. There is no supported raw public Worker workaround in this release. Do not provision credentials until this prerequisite is satisfied.

### `dist/bridge-wrapper.js` is missing

You probably have a source checkout/GitHub source ZIP rather than a prepared release package. From `bridge` run:

```sh
npm ci --ignore-scripts
npm run build
```

Then rerun `check`. Do not point the installer at `worker.js` or use a stale bundle from another release.

### Node or SQLite error

Use the project-supported Node version: 24 LTS recommended, minimum 22.15.0. Tests import `node:sqlite`. Check which Node executable your shell actually uses with `node --version`; a installed version in another terminal does not change the current one. An experimental SQLite warning alone is not a failed test.

### Windows dry-run fails

Wrangler officially supports Windows 11, not Windows 10. The helper performs a dry-run before account login so a CLI/runtime problem can stop without cloud changes. A successful `--version` is not a deploy test. Do not change ExecutionPolicy or run as administrator as a generic fix. Check the official [Wrangler OS requirements](https://developers.cloudflare.com/workers/wrangler/install-and-update/) and pinned version first.

### npm or local runtime is blocked

`npm ci` needs registry access. Local workerd/wire tests need process and loopback-port access. A sandbox denial is not proof that the tests passed or that the application failed. Run in an appropriately authorized development environment and record unrun stages. Do not bypass a deliberate account/network restriction.

## Bootstrap and state recovery

From the existing `bridge` directory:

```powershell
npx.cmd --yes --package=wrangler@4.145.0 node .\windows\setup.mjs status
```

State identifies what was attempted. `planned`, `creating-database`, `database-created`, `schema-created`, and `worker-published` are incomplete checkpoints; `bootstrap-complete` and `configured` are accepted for `configure`.

If bootstrap partially succeeded, **do not delete state or rerun blindly**. Inspect your own account for the exact resources already created. The helper refuses repeat bootstrap to avoid duplicates or overwrites. Do not delete a D1 database just because a command failed; it may contain a valid installation.

### Worker published, but origin entry was interrupted

Only for an unconfigured bootstrap, obtain the exact Worker origin from your own deployment output or Cloudflare dashboard. From `bridge`:

```powershell
node .\windows\recover-url.mjs https://bridge.example.invalid
```

The example.invalid address is a non-working placeholder. Replace it with your own verified workers.dev origin before running. The recovery helper validates it against existing local state, checks the expected closed HTTP 503 `connection_not_configured`, preserves a backup, and rejects concurrent state changes. It does not log in, deploy, authorize mail, or recover a configured Worker. Do not invent an origin or reuse another owner's URL.

If the saved stage is earlier, the resources do not match, or the closed check fails, stop and inspect the partial setup; this command is not a universal recovery tool.

### Cloudflare login or cleanup was interrupted

Run helper `cleanup`, then verify the relevant Wrangler grant is revoked in [Connected Applications](https://dash.cloudflare.com/profile/access-management/authorization). Local deletion and server revocation are separate. Do not share the auth directory or remove unrelated account tokens.

## Configuration and setup page

### HTTP 503 `connection_not_configured`

Expected immediately after bootstrap. Later, check required bridge variables, valid public Ed25519 JWK, separate D1 binding/schema, and both rate-limit bindings. Placeholder or missing configuration must fail closed. The same generic error can conceal a configuration/runtime failure; do not enable token/body logging to distinguish it.

### `configuration_required` on the Site

The private page can create/show a signing key before the bridge origin is configured. Check `BRIDGE_ORIGIN` is a complete HTTPS origin without path, credentials, query, or trailing slash. Add the actual bridge origin to the same Site configuration and redeploy privately.

### Public JWK rejected

`SITE_PUBLIC_KEY_JWK` in `connect.json` is a JSON string containing public JWK JSON, not an object. Escape inner quotes once. Use your Site's actual public `kty: "OKP"`, `crv: "Ed25519"`, and `x`; never include `d`. Check whether `.local/connect.json` takes precedence over the file you edited. Repeated key initialization returns the existing key and does not rotate it.

### Owner authentication fails

Check that the page is on the correct private Site, that the owner is signed into the intended ChatGPT account, and that the pinned email and Site-scoped ID match the values supplied by Sites. IDs from other Sites are not interchangeable. Verify trusted platform authentication rather than injecting matching headers. Different-user rejection is an expected security behavior.

### `bridge_http_401`, `bridge_http_403`, or signing stage error

Compare the Site ID, owner ID, public key, exact origins, and current deployment pair. Check server clocks, one-use nonce storage, and schema/bindings. Do not reuse a captured signed request. A change to only one side of a key pair breaks the connection; coordinate both sides. Never paste the private key into bridge variables.

### `bridge_http_429` or rate-limited mail

Wait before retrying. The owner budget is 30/min and perimeter 120/min, locally/approximately enforced. Another client or unwanted traffic can consume the same bucket. The attachment helper honors safe bounded retry information; don't parallelize calls or expand limits to hide the issue.

## Yandex authorization and mailbox access

### Callback says connection was not completed

Open your private Site and start a new authorization flow. State lasts ten minutes and is consumed once; Back, refresh, replay, mismatched callback, or an expired flow can fail. Check the app's exact redirect URI and sole `mail:imap_ro` permission. Sign in as the configured mailbox owner. Never copy a code/token to chat as a workaround.

A success page confirms callback processing, not all five tools or a clean new installation. Run the small live smoke checklist yourself.

### Mail worked, then stopped

A token can expire or be revoked. Reconnect explicitly through the private Site; this project does not silently refresh. Also check provider availability, IMAP/OAuth mailbox settings, and whether a configuration/dependency update changed the installed pair. Do not broaden the app scope.

### `mailbox_not_allowed` or Sent is absent

Discovery and permission are separate. Read only a selectable path with `allowed: true`. To enable Sent, select its exact discovered path and add `SENT_MAILBOX` to your existing connection file, then `configure`. Do not guess `Sent`, a Russian label, or a hierarchy. Ambiguity/truncation requires an explicit owner choice.

### Search returns nothing

Inspect `nextBeforeUid` and `scannedUidRange`. Search is bounded to a 1,000-UID window; an empty page can still have a continuation cursor. Keep the same filters and use the returned cursor. `text` searches the body under server IMAP semantics, not a semantic search index. Stop at the user's requested scope or a null cursor.

### UIDVALIDITY changed / message not found

Relist or search again and reselect the message. A UID without its mailbox and UIDVALIDITY can refer to a different identity after mailbox changes. Do not replace only the validity number or retry against guessed UIDs. The message may genuinely have been removed outside this connector.

### HTML text is incomplete or missing

Plain text has priority. HTML source and output are bounded and active/hidden elements are omitted. Check `textSource`, `bodyStatus`, `truncated`, and conversion metadata. This is a text reader, not a full HTML mail renderer. Do not fetch remote images or execute scripts to recreate the message.

## Attachments

### Base64-decoded bytes are not the expected file

`dataBase64` is a transport envelope around MIME-transfer-encoded bytes. Decode transport chunks, verify them, join in order, then decode the MIME transfer encoding exactly once. Use the supplied assembler/downloader. Do not perform charset/newline conversion on attachment bytes.

### Large download is slow

Each ≤128 KiB chunk is a separate signed call and IMAP connection. A large MIME-base64 attachment can require hundreds of chunks. Pacing at ≥2,100 ms helps respect 30 calls/min; pauses and retries add time. Use the checkpoint/resume API in [API](api.md), not a fast parallel loop.

### Resume failed or final output already exists

Resume validates the entire JSONL prefix, exact identity/metadata, offsets, and hashes. Corrupted, truncated, or mixed files are rejected. Keep the rejected checkpoint private; start a new checkpoint only if re-downloading is appropriate. An existing final output is deliberately not overwritten; choose a new explicit path or inspect the existing file first.

A `.lock` means a checkpoint writer may be active. After a hard process termination, confirm no writer remains before removing only that stale lock. Do not edit valid checkpoint records to force a resume. On Windows, use private ACLs; POSIX `0600` alone is not a Windows privacy guarantee.

### Attachment too large / unsupported / changed

The final decoded limit is 20 MiB, encoded limit 64 MiB. `downloadable` can still be followed by a decoding-size rejection. Unknown MIME encodings, metadata changes, missing parts, or mismatched hashes fail closed. Choose another appropriately sized attachment or access it directly through your mail provider; do not raise caps or ignore hashes during a user download.

### No Library file or browser URL appeared

That is expected. The tool returns authorized chunks and the helper creates a verified private local file. A user-facing attachment requires a separate supported, authorized file-upload workflow. Never invent a Library ID or publish a temporary URL containing credentials.

## What local success means

Unit, wire, and local workerd tests validate different boundaries. They do not establish your account setup, current Sites availability, Windows installation, cloud TCP reachability, fresh OAuth, or provider behavior. Read [verification](verification.md) and record exactly what passed, failed, or was never run.
