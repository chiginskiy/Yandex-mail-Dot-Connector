# Release procedure

This project has separate publication steps for source, release files and a user's hosted services. None of the check/build/package commands deploys, publishes to GitHub, creates cloud resources, or authorizes a mailbox. Do not publish an existing installation directory or its Git history.

## Prepare a candidate

1. Work from a clean checkout of `chiginskiy/Yandex-mail-Dot-Connector`. Confirm the intended commit and branch. Review all staged files; use only the public source tree. Never add `.local`, `.wrangler`, `node_modules`, private hosting metadata, connection configuration, mail, attachments, logs, D1 exports, tokens, keys or source maps.
2. Update the unified version in root `package.json` and root lockfile, component versions and lockfiles, MCP server version, changelog and relevant docs. Maintain Apache-2.0 project metadata and upstream attribution. Do not change a dependency license to match the project license.
3. Use the pinned Node version from the workflow for release comparisons. Install and check:

   ```sh
   npm run deps
   npm run notices
   npm run verify
   npm audit --prefix bridge
   npm audit --prefix site
   npm run package
   node scripts/verify-zip.mjs
   ```

   `npm run notices` regenerates the root notices for lockfile-pinned runtime packages. Review its diff. `@zone-eu/mailsplit` is used under its offered MIT option; it is not presented as EUPL-only. Drizzle ORM supports the schema source and is not bundled into the Site handler. The tested scoped esbuild override in `site/package.json` removes the old development-server advisory inherited through Drizzle Kit. Recheck migration generation when upgrading these tools.
4. The ZIP is written to `releases/Yandex-mail-Dot-Connector-<version>.zip` with external `SHA256SUMS.txt` and internal `FILE-SHA256SUMS.txt`. The root packaging script uses a fixed allowlist, sorted entries, fixed 1980 ZIP timestamps, regular-file modes, and STORE compression for deterministic archive bytes. It includes only the fresh production bridge bundle plus the exact built Site runtime. It excludes test bundles and source maps. Never ZIP the working directory directly.
5. Repeat `npm run package` without source changes and compare SHA-256. Same-input archive determinism is tested locally; reproducibility across different dependency resolutions or compiler versions is not promised. Lockfiles and the build toolchain must match.
6. Unpack into a new empty directory and independently verify archive integrity and every file hash. Reinstall dependencies from lockfiles there, run `npm run verify`, and run `node windows/setup.mjs check` from its `bridge` directory. This is a local installer/dry-run rehearsal, not live authentication.
7. Scan both the selected source and exact ZIP. The included scanner catches configured credential shapes, unsafe paths and non-synthetic endpoints. It is defense in depth rather than proof of absence. Review files for names, mailbox addresses, real account/project/database/app IDs, deployment domains, mail samples and other identifying data. If an existing installation is the source, compare against its known configuration privately; never commit that comparison list.

## Verification and release status

Record OS, Node/npm versions, command outcomes, source/runtime test counts, artifact SHA-256, any skipped checks, and unresolved risks in `docs/verification.md`. Do not claim a clean live installation on the basis of mock tests, a previously working personal deployment, or a setup page.

A first public candidate stays a prerelease until a fresh supported installation has independently verified private Sites ownership, plugin OAuth, D1 bindings, exact read-only Yandex app/PKCE consent, IMAP reachability, a bounded read and selected attachment byte equality. Credential entry and grant creation remain explicit owner actions. Never use a production mailbox as a CI fixture.

## CI and publication

- `check.yml` runs on pushes and pull requests with `contents: read`, no stored checkout credentials and full-SHA-pinned official Actions. The matrix covers Linux Node 22.15/24.19 and Windows Node 24.19; workerd smoke tests run on Linux. A configured workflow is not evidence that remote CI has passed.
- `release-candidate.yml` is manual. It verifies and packages a candidate, then uploads only ZIP/checksum files as an Actions artifact. It has no GitHub release write permission and no deployment credentials.
- Publish source/release assets only after reviewing the exact candidate and confirming the intended public repository. Create a prerelease tag matching the root version, upload the verified ZIP and checksum file, and describe known limits. These actions are separate from preparing a candidate.
- Verify the commit exists on the expected remote and CI passed for that exact commit before announcing it as published/checked. Enable repository security reporting and secret scanning where supported; verify settings instead of assuming they are active.
- Deploying an update to any user's Worker/Site is a separate owner-authorized operation. Preserve their identity, configuration and state; never replace them with repository examples. See the installation guide for update and rollback steps.
