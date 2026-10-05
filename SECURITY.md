# Security policy

This is an initial release candidate. There is no long-term support or incident-response SLA. Security fixes are intended for the newest maintained release; do not assume an older private prototype or public prerelease will receive backports.

## Report a vulnerability privately

Use **Security → Report a vulnerability** on `chiginskiy/Yandex-mail-Dot-Connector` if GitHub private vulnerability reporting is enabled. If that option is absent, open an issue asking for a private reporting channel **without including exploit details or private data**. Do not assume a private channel exists until the maintainer confirms it.

Include:

- Affected release/component and a concise impact description
- Reproduction using synthetic accounts/data, expected behavior, and actual behavior
- Which boundary is affected: Sites identity, bridge signing, OAuth, D1 storage, IMAP, attachment handling, installer, or packaging
- A minimal proposed fix or regression test if available

Never include real mail, attachments, addresses, deployed origins, project/account/database IDs, callback URLs with codes, `.local` contents, tokens, cookies, or private keys. Do not test on someone else's deployment or mailbox. Do not create public exploit reports that expose an active owner's mail.

## Critical installation warning

The Site component trusts Sites-provided identity headers. It is unsafe as a public raw Worker and must remain behind private owner-only Sites hosting with provisioned plugin OAuth. The canonical bridge is deployed separately with signed-request authorization.

Read the [security model](docs/security.md) before connecting a mailbox. If access may already be compromised, revoke the Yandex app and disable the affected connection while arranging private reporting. Publication of this source is not a security audit or evidence of a fresh successful installation.
