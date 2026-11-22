-- Apply to an existing owner's private bridge D1 before deploying search tools.
-- Search results are metadata only. Workflow event payloads contain no secrets.
CREATE TABLE IF NOT EXISTS search_jobs (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode = 'imap_server'),
  query_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','complete','incomplete','reauthorization_required','failed')),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  run INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS search_one_active_per_owner ON search_jobs(site_id,owner_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS search_jobs_expiry ON search_jobs(expires_at);
CREATE TABLE IF NOT EXISTS search_folders (
  job_id TEXT NOT NULL REFERENCES search_jobs(id) ON DELETE CASCADE,
  mailbox TEXT NOT NULL,
  position INTEGER NOT NULL,
  uid_validity TEXT,
  upper_uid INTEGER,
  next_high INTEGER,
  windows_done INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(job_id,mailbox)
);
CREATE TABLE IF NOT EXISTS search_results (
  job_id TEXT NOT NULL REFERENCES search_jobs(id) ON DELETE CASCADE,
  mailbox TEXT NOT NULL,
  uid_validity TEXT NOT NULL,
  uid INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  PRIMARY KEY(job_id,mailbox,uid_validity,uid)
);
CREATE INDEX IF NOT EXISTS search_results_paging ON search_results(job_id,mailbox,uid DESC);
