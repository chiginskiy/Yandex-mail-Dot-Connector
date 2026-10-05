# Installation and operations

[Русский](installation.ru.md) · [Repository overview](../README.en.md)

This guide installs an owner-only connection using your own accounts. It does not grant permission to an assistant to sign in, accept account terms, create credentials, authorize mail access, or publish on your behalf. Review and complete those steps yourself, or explicitly authorize the supported action. Never paste passwords, OAuth tokens, Cloudflare credentials, or private keys into chat, source files, issue reports, or shell arguments.

## 0. Check prerequisites before provisioning

1. Confirm that your account can create a **private owner-only Sites deployment with D1 and a provisioned MCP plugin**. Sites must enforce its authenticated hosting boundary and plugin OAuth. It must supply trusted `oai-authenticated-user-id` and `oai-authenticated-user-email` headers to the adapter. Account/workspace availability can vary.
2. If you cannot verify this prerequisite, stop here. The Site adapter is unsafe as a public raw Cloudflare Worker, even if you set an owner email in its environment. There is no standalone authentication-server installation path in this release.
3. Have your own Cloudflare account with Workers/D1 access and your own Yandex mailbox. Check any organization restrictions before enabling IMAP or creating an OAuth app.
4. Install Node.js 24 LTS from an official source. The project minimum is 22.15.0, including `node:sqlite` used by tests. Use Windows 11 for the Windows helper. Wrangler officially supports Windows 11, macOS 13.5+, and supported Linux distributions; Windows 10 is unsupported. See [Wrangler requirements](https://developers.cloudflare.com/workers/wrangler/install-and-update/).
5. Review costs and limits for your own Cloudflare/Sites accounts. The helper does not change plans or purchase add-ons, but existing service quotas and charges still apply. Stop if a service presents an unexpected paid upgrade or permission request.

Expected checkpoint: Sites private hosting and plugin support are confirmed, and `node --version` reports a supported version. No mailbox access has been granted.

## 1. Choose a source checkout or prepared release

Use the exact project `chiginskiy/Yandex-mail-Dot-Connector`. A prepared release ZIP contains `bridge/dist/bridge-wrapper.js`. The source checkout or GitHub-generated source ZIP needs a build first:

```sh
git clone https://github.com/chiginskiy/Yandex-mail-Dot-Connector.git
cd Yandex-mail-Dot-Connector
npm ci --ignore-scripts --prefix bridge
npm ci --ignore-scripts --prefix site
npm run verify
```

Alternatively, build only the required bridge bundle:

```sh
cd bridge
npm ci --ignore-scripts
npm run build
```

`build` is local. It does not deploy. Do not substitute `wrangler deploy` without `--dry-run`. A prepared release still requires Node and the pinned Wrangler executable, but the helper can obtain Wrangler using `npx` without installing the full project.

For Windows, extract the ZIP into an ordinary user folder before running it. Do not execute inside the ZIP. Do not change PowerShell ExecutionPolicy or run as administrator just for this project.

Expected checkpoint: `bridge/dist/bridge-wrapper.js` exists. The package has no local state or connection data from another installation.

## 2. Bootstrap a closed bridge

Run from the **`bridge` directory**, where `windows`, `dist`, and `package.json` are siblings.

Windows PowerShell:

```powershell
npx.cmd --yes --package=wrangler@4.146.0 node .\windows\setup.mjs check
npx.cmd --yes --package=wrangler@4.146.0 node .\windows\setup.mjs bootstrap
```

POSIX shell, using the same helper:

```sh
npx --yes --package=wrangler@4.146.0 node ./windows/setup.mjs check
npx --yes --package=wrangler@4.146.0 node ./windows/setup.mjs bootstrap
```

The helper's prompts are in Russian. `check` performs only local CLI and no-bundle dry-run checks. `bootstrap` repeats the dry-run, then:

1. Shows the temporary Cloudflare authorization scope. Enter `LOGIN` only if you accept it; complete the device-code login on the official Cloudflare page
2. Shows the selected account, new Worker name, and dedicated D1 database. Enter `CREATE` to create those resources
3. Creates the bridge schema and rate-limit bindings, then publishes a bridge with mail access still disabled
4. Asks for the exact public `https://…workers.dev` origin printed by deploy, without a trailing slash. It validates the origin against the new Worker name and checks the closed response
5. Prints your exact Yandex callback, ending in `/oauth/callback`

Cloudflare may ask to register your account's first `workers.dev` subdomain. This does not require a domain purchase. Rate-limit namespace IDs are randomly selected by the helper; check for collisions if your account has many existing bindings.

The helper saves state in `bridge/.local/setup-state.json`. Preserve it. Do not rerun bootstrap after partial success: that could create duplicate resources, and the helper intentionally refuses it.

Expected checkpoint: state is `bootstrap-complete`; the bridge returns HTTP 503 with `connection_not_configured`; its callback URL is known. That 503 is expected at this stage. No Yandex token exists yet.

### Cloudflare access and cleanup

The helper requests `account:read user:read workers_scripts:write d1:write`; Wrangler also adds `offline_access`. These rights apply to the account, not only this Worker. Temporary Wrangler credentials are held in the isolated `bridge/.local/auth` directory in Wrangler's normal format, without application-level encryption. Do not inspect or share that directory.

The helper attempts logout and removes that directory after login sessions. If interrupted:

```powershell
npx.cmd --yes --package=wrangler@4.146.0 node .\windows\setup.mjs cleanup
```

Then verify server-side revocation at [Cloudflare Connected Applications](https://dash.cloudflare.com/profile/access-management/authorization), selecting the relevant Wrangler grant. A logout success message alone is not proof of successful server revocation. Do not delete unrelated tokens or applications.

## 3. Register your Yandex OAuth application

On the [official Yandex OAuth application page](https://oauth.yandex.ru/), create your own web application:

- Set Redirect URI to the exact callback from step 2, for example `https://bridge.example.invalid/oauth/callback` as a non-working illustration. Use your real Worker origin in your account
- Request **only** `mail:imap_ro`, labeled read-only mailbox access. Do not request `mail:imap_full`, SMTP, or unrelated scopes
- Save the public Client ID. This installation uses authorization code + S256 PKCE and does not ask you to copy a Client Secret or token
- Check your mailbox's IMAP and OAuth-token access settings, making any required change yourself

The bridge requests only `mail:imap_ro`; if Yandex returns a scope field, it rejects a different scope. When the field is omitted, exact app registration and the requested scope remain part of the security boundary. See [Yandex Mail OAuth](https://yandex.ru/support/yandex-360/business/mail/ru/web/security/oauth) and [PKCE authorization](https://yandex.ru/dev/id/doc/en/codes/code-url).

Expected checkpoint: your app's callback exactly matches your bridge, and its only mail permission is read-only. Registration alone does not authorize the mailbox.

## 4. Create a private Site

Use the supported Sites creation/deployment workflow available to your account. Import the **`site/` component** into your own Site project. Do not copy the author's Site project identity or deploy the Site adapter directly with Wrangler.

The platform-specific registration, source, and hosting metadata must be generated for your own project. A reusable project ID or ready-to-deploy `.openai/hosting.json` is intentionally not provided. Ask the Sites-enabled assistant or interface to:

1. Create an owner-only private server Site, with MCP capability and the normal provisioned plugin OAuth
2. Use `site/src/site-worker.mjs` through the built `dist/server/index.js` entry point
3. Bind private Site D1 as `DB` and apply the included Drizzle migration from `site/db/schema.ts` and `site/drizzle/` using the platform's migration workflow. Never run schema creation from an HTTP request
4. Configure `SITE_ORIGIN` as the exact private Site HTTPS origin; `BRIDGE_ORIGIN` as the exact step-2 Worker origin; `SITE_ID` as the registered Site ID; and `OWNER_CHATGPT_EMAIL` as your verified account email
5. Keep `OWNER_SITE_USER_ID` unset only for the initial email-pinned bootstrap, then pin it after step 5
6. Confirm the audience remains private and owner-only, and the adapter has no public raw-worker bypass

Use exact origins without a path, trailing slash, query, or credentials. The Site and bridge use **separate D1 databases**. Site D1 contains signing keys only; it must not receive the bridge mail-token tables.

Expected checkpoint: the owner can open the private setup page; anonymous and different-user access cannot use mail or setup actions. The page can create a connection key, but mail is not yet authorized. Tool discovery alone is not proof of owner access or mail connectivity.

## 5. Initialize the key and configure the bridge

On your private Site, click **Создать ключ связи** (Create connection key). This creates persistent credentials: a private Ed25519 key in Site D1 and a public JWK. Repeated clicks show the existing key; they do not rotate it.

Copy only the displayed public `SITE_ID`, `OWNER_SITE_USER_ID`, and public JWK. Set `OWNER_SITE_USER_ID` in Site configuration to that exact ID, retaining the email check, and redeploy the same private Site.

In `bridge`, copy `windows/connect.example.json` to `windows/connect.json`, then fill the six fields:

| Field | Source |
| --- | --- |
| `YANDEX_OWNER_EMAIL` | Your exact Yandex mailbox address |
| `YANDEX_CLIENT_ID` | Your own app's public Client ID |
| `SITE_ID` | Your registered Site ID |
| `OWNER_SITE_USER_ID` | Public owner ID returned by your Site |
| `SITE_PUBLIC_KEY_JWK` | JSON-encoded string of your Site's public Ed25519 JWK |
| `SITE_ORIGIN` | Your exact private Site HTTPS origin |

`SITE_PUBLIC_KEY_JWK` is a JSON **string**, so inner quotes must be escaped in `connect.json`. A JWK object shown by the page must be serialized once for this field. It must contain `kty: "OKP"`, `crv: "Ed25519"`, and public `x`; a private `d` field is rejected. Do not type invented keys from documentation.

The helper prefers `bridge/.local/connect.json` if it exists, otherwise uses `bridge/windows/connect.json`. Check which file you are editing. Both are local installation data and excluded from releases.

```powershell
npx.cmd --yes --package=wrangler@4.146.0 node .\windows\setup.mjs configure
```

On POSIX use `npx` and `./windows/setup.mjs`. The helper validates public settings before login, shows the existing Worker and allowlist, asks for `CONFIGURE`, then `LOGIN`. It updates the original Worker and retains its D1. It does not authorize Yandex.

Expected checkpoint: state is `configured`; the same Worker/D1 and Site identities are preserved; both Site and bridge pin the same owner ID and public key. Confirm Wrangler grant cleanup again.

## 6. Authorize mail and install the plugin

1. On the private Site click **Подключить Яндекс Почту** (Connect Yandex Mail)
2. Verify the browser is on Yandex's official OAuth service and requests only read-only access; sign in as the configured mailbox owner and confirm
3. The callback consumes one-use state, exchanges the code server-side, verifies XOAUTH2 against the fixed mailbox, and stores the access token in bridge D1. The private token is not shown to the Site or MCP client
4. The browser returns to your fixed private Site origin with an authorization confirmation
5. Install/connect the Site's provisioned plugin through its normal platform connection flow. Do not invent a second MCP OAuth service or install a local bypass connection

There is no silent refresh-token loop. The bridge deliberately discards a refresh token and requires an explicit reconnect when access expires or is revoked.

Expected checkpoint: the correct owner sees five tool definitions and a small `yandex_mail_list` call succeeds. Complete the smoke checklist below before relying on the connection.

## 7. Initial smoke checklist

Use a small, known synthetic test message in your own mailbox. This guide does not send it for you.

- [ ] Anonymous and wrong-owner calls cannot read mail or initialize a key
- [ ] `yandex_mail_folders({})` returns bounded folder metadata; discovery does not enable any new folder
- [ ] `yandex_mail_list({"mailbox":"INBOX","limit":1})` returns a bounded page
- [ ] `yandex_mail_search({"mailbox":"INBOX","subject":"Connector test","limit":1})` returns the expected item, or a pagination cursor to continue
- [ ] `yandex_mail_read` with the returned UID and UIDVALIDITY returns text; compare flags before/after to check read-only behavior
- [ ] A small selected test attachment passes chunk/metadata/hash verification and matches your known local bytes
- [ ] A disallowed folder is rejected; HTML does not load external images; mail data and tokens are absent from application logs

These are deployment checks for the installer to run. They were not performed as a fresh live install during preparation of this release. Detailed examples are in [API](api.md).

## Optional Sent access

Call `yandex_mail_folders`. Use only an exact returned `path`. Prefer `sentStatus: "server_identified"` with one server-confirmed candidate. If status is ambiguous, discovery was truncated, or identification came only from a display-name heuristic, choose the folder explicitly rather than guessing a translation.

Add optional `SENT_MAILBOX` to your existing connection file and run `configure` again. It must differ from `INBOX`. The helper sets the allowlist to `INBOX` plus that exact path. Discovery by itself never grants access. To remove Sent access, delete only `SENT_MAILBOX` and rerun `configure`.

## Updates

1. Record the running component versions and save a private backup of configuration and `bridge/.local/setup-state.json`. Keep database backups and deployment rollback identifiers private; they may expose credentials
2. Review [CHANGELOG](../CHANGELOG.md), schemas, and [verification](verification.md) before installing. Do not assume a future database migration is reversible
3. Unpack a new release in a separate temporary folder, compare program files, and update the existing installation while preserving `.local`, your connection file, Worker/D1 identity, Site identity, keys, and Yandex app
4. For source updates, rerun `npm ci` and `build`. From the existing `bridge` directory run `configure`, not `bootstrap`
5. Deploy the matching Site adapter through the same Site's supported private update flow. Preserve its project ID, D1, owner configuration, and provisioned plugin
6. Check the installed tool schema and rerun the small smoke checklist. A valid existing mail grant normally survives a code-only update; do not reauthorize or rotate a key without a reason

If migrating from an older flat bridge-only folder, keep that existing folder as the bridge installation root, or move its local state and connection file deliberately into the new `bridge/` directory. Do not create a second bridge by accidentally bootstrapping the new layout.

## Rollback

Stop new mail calls, preserve evidence without logging secrets, and identify a previously working **compatible bridge/Site pair**. Restore their known source/build or use each service's deployment-version rollback under your control. Preserve the same resources and public settings. Do not overwrite current D1 with an old database backup merely to roll back code: that can revive revoked tokens or mismatch keys/state.

For this initial public release there is no older public release to recommend as a rollback target. If you have no independently verified compatible deployment, disable the connection and diagnose rather than claim a safe downgrade. Never downgrade to known-vulnerable code. Repeat owner isolation and read-only smoke checks after recovery.

## Revoke and uninstall

- **Stop mailbox access:** revoke this application in Yandex ID's connected-app permissions. Removing the dot plugin alone does not revoke the Yandex token
- **Stop Site-to-bridge calls:** disable the connection or remove/replace the bridge's pinned Site public key through your controlled deployment. Key rotation needs an explicit plan for both components; the basic UI has no rotation button
- **Remove local Cloudflare grant:** run helper cleanup and verify Wrangler revocation in Cloudflare Connected Applications
- **Remove infrastructure:** after identifying only this installation's resources, decide whether to preserve private backups, then remove its Site, bridge Worker, and their separate D1 databases through the respective services. Database deletion is destructive; it is never an automatic helper step
- Delete local downloaded mail/checkpoints when no longer needed. Do not share `.local/auth`, D1 exports, or attachments for troubleshooting

Revocation at the provider is distinct from deleting a local file. See [security](security.md) and [troubleshooting](troubleshooting.md).
