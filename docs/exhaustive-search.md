# Exhaustive IMAP server search — PR 1 for issue #32

This feature is an asynchronous, owner-only exhaustive UID scan. **It is not
full visible-text search**, which remains a required separate PR before #32
can be closed. IMAP BODY search can differ from displayed HTML-to-text.

## API

Start with yandex_mail_search_all:

~~~json
{"mailboxes":["INBOX","Sent"],"mode":"imap_server","subject":"example"}
~~~

Poll yandex_mail_search_status with {"searchId":"<uuid>"}.
After status=complete and complete=true, call yandex_mail_search_results:

~~~json
{"searchId":"<uuid>","limit":50,"offset":0}
~~~

Continue using nextOffset until null. The total may exceed 50/1000 results:
the database contains every matching UID, not only the visible page.
While running, pages/counts are preliminary.

A failed or interrupted job can be resumed via
{"resumeSearchId":"<uuid>"} after re-authorizing the mail account if needed.

## Scope and technical guarantees

- Exact paths only from the owner-configured mailbox allowlist.
- For each folder, UIDVALIDITY and UIDNEXT-1 are fixed on its first scanned
  window. Later UID arrivals are out of this run; UIDVALIDITY changes abort.
- Every 1000-UID window is scanned, including empty ranges and UID gaps.
- Each match has a unique (job, mailbox, validity, UID) key in private D1.
  The cursor advances only after all matches in that window are stored.
  Failed windows can be retried without duplicates or lost matches.
- Messages removed or moved by another mail client during scanning cannot
  be guaranteed recoverable. Such ambiguous cases must not be advertised
  as a complete immutable historical archive.
- The Workflow input only contains job ID and sequence, no tokens or
  message bodies. Only summary metadata is retained in bridge D1.
- Jobs are retained for seven days and removed on a subsequent job
  creation. This is NOT an autonomous scheduled retention service.
- At most one active scan per owner. Each Workflow instance handles at most
  **12 UID windows**, then deterministically schedules another instance with
  a fresh subrequest budget, while retaining all progress/results in private D1.
  On the Workers Free plan, Cloudflare limits each instance to 50 external
  subrequests and 1,000 service subrequests, **regardless of the separate
  Workflow-step limit**. The small per-instance cap leaves headroom for
  retries, D1, and IMAP connections; high-match-density windows still need
  workload acceptance. Owner rate limits and read-only IMAP are preserved.

## Deployment — owner action required

**Merging the PR does NOT update the private ChatGPT application.**

1. Verify that the owner's Cloudflare plan supports Workflows and the
   actual workload/CPU budget. Use private staging before production.
2. Back up the correct existing bridge D1. Apply the idempotent migration
   bridge/schema/search-jobs-001.sql before deploying the new bridge.
   Never replace existing token, OAuth state, or nonce tables.
3. Configure the SEARCH_WORKFLOW binding with class
   ExhaustiveMailSearchWorkflow in the authenticated bridge. The sample
   Wrangler configs and Windows helper are updated for this binding.
4. Build/deploy the bridge; rebuild/update the existing private
   owner-only Sites deployment. Do not expose the Site adapter on a
   public raw Worker; preserve owner identity and signing keys.
5. Confirm tools/list advertises the three new tools in addition to
   the five original read-only mail tools.
6. Through the installed app, verify known matches near the beginning,
   middle and end of a large UID range. Check matchedTotal and page
   through every result. Compare against an independent authorized
   IMAP/mailbox reference for the same allowed folders and scope.
7. Roll back bridge and private Site together if necessary, without
   deleting the original D1 mail credentials. Search tables are
   inert when the old code runs.

## Important limitations

The imap_server mode only guarantees completeness with respect to
the mail server's IMAP search semantics. HTML conversion, Unicode
normalization and Russian word forms may differ. The future
visible_text_exact mode must read the *entire* supported body of every
in-scope message and must fail closed for any unreadable message.

Search inside attachments, PDF/DOCX and cloud links is not part of
this PR. There is no automatic file download, sending, deletion,
scope expansion, or public export of message contents.

Large jobs consume Workflows/D1/IMAP quotas. Workflow instances have
CPU, step and duration limits; test performance before enabling it in
production. A finished job is viewed by polling status, not by a
guaranteed proactive ChatGPT notification.
