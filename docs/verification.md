# Verification record

Release candidate: `1.0.0-rc.1`; bridge `1.1.2`; Site adapter `0.2.2`. Prepared on 2026-10-05 UTC. This document records local/synthetic checks, not a certificate of safety or live-installation success.

## Environment and scope

- Linux x64, Node.js 24.19.0, npm 11.9.0
- Fresh dependencies from the committed lockfiles with lifecycle scripts disabled
- Official npm packages; no production credentials, mailbox traffic, deployment, account creation, repository upload, or real OAuth consent used
- The existing personal installation and its files were left untouched

## Checks

- Bridge: 44/44 tests passed, including real ImapFlow wire transcripts against a local synthetic IMAP server, EXAMINE/BODY.PEEK invariants, HTML text conversion, fixed TLS production settings, fail-closed required rate limits and generic URL recovery
- Site: 52/52 tests passed, including owner/auth boundaries, durable SQL semantics, signatures/replay, OAuth and attachment verification/downloading
- Root: 7/7 integration/release tests passed, including the canonical signed bridge → MCP → assembler path, safe rate-limit propagation, signature replay rejection, credential-shaped content refusal and symlink/path exclusions
- Total: 103 passed, zero failed/skipped on the recorded Linux run
- Production Wrangler dry-run build passed; no synthetic test input is permitted in its build metadata. Only the authenticated wrapper is packaged
- Real local workerd core and authenticated D1/OAuth smoke tests passed. The OAuth endpoint and IMAP are synthetic; redirects 302/307/308 are refused, one-use state/nonces and all five read routes are exercised
- Drizzle schema generation after the dependency security update reported no schema changes; no new migration required
- Full `npm audit` including development packages reported zero advisories for both packages at the preparation date. This is an advisory-database result, not proof that every dependency is vulnerability-free
- Root third-party notices were regenerated from pinned runtime dependencies. The dual-licensed mail parser uses its MIT option. Public upstream attribution addresses are intentionally retained
- Known original installation identifiers were compared privately against candidate source/runtime files: no matches. The public scanner checks credential patterns, unsafe paths and real Worker endpoints; source maps and local state are excluded

## Attachment coverage

- Exact 20 MiB decoded boundary for all five supported MIME encodings, with rejection above the limit; 64 MiB transfer-encoded cap, 128 KiB chunks, 100 MiB serialized checkpoint cap
- A synthetic 20 MiB folded-base64 download across 219 chunks, with interruption, verified restart from the next offset, a 429 retry at the same offset, and exact final SHA-256
- Fake-clock request pacing, bounded per-offset/total retries and elapsed/request timeouts, including a client promise that never settles
- Identity/metadata/hash/contiguity mismatches, missing/duplicate/reordered chunks, truncated/corrupt checkpoints and unsafe output replacement fail closed
- Checkpoint/output permissions and symlink protections exercised on Linux. Windows ACL privacy remains an operator responsibility

## Archive and local installer rehearsal

The packaging command rebuilds the production bridge and Site, creates a deterministic allowlisted ZIP, and writes SHA-256 manifests. `scripts/verify-zip.mjs` verifies archive identity, safe unique names, exact byte equality with scanned source/runtime files, and every manifest hash. The final checksum is delivered beside the ZIP rather than embedded in this document, which is itself inside that archive.

A clean extracted-archive rehearsal passed on the recorded Linux environment: fresh lockfile dependency installation, all 103 tests, both workerd smoke tests, production build, and `node windows/setup.mjs check` from `bridge/`. The helper completed its no-bundle dry run without cloud login or deployment. A writable temporary npm cache and Wrangler log/config locations were used because this sandbox has no writable home cache. Independent Python ZIP CRC/path checks and private-identifier scans also passed. This rehearses source/build packaging and the local installer only; it cannot establish the live checks below.

## Not verified in this preparation

- A clean installation on Windows or macOS; the Windows-related tests were made portable but have only run on Linux here
- Actual GitHub Actions runs for this repository. Workflows are prepared and official Actions are pinned to verified commit SHAs; the remote repository has not been published by these checks
- Fresh Sites registration, private access gating/plugin installation in a new account, cloud D1 provisioning, Cloudflare → Yandex network reachability or actual OAuth consent for this release
- A full live attachment download. Historical success in another individual deployment is not substituted for these checks
- Security against every possible implementation, platform, account compromise or dependency failure. Independent audits and least-privilege account controls remain necessary

Keep the first public release marked as a candidate/prerelease until the fresh live checklist in the installation guide is completed under the owner's control.
