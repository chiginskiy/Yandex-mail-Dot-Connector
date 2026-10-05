-- Separate user-owned Cloudflare D1 database. Never expose a query endpoint.
CREATE TABLE oauth_states (state TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);
CREATE TABLE mail_tokens (site_id TEXT NOT NULL, owner_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(site_id, owner_id));
CREATE TABLE used_nonces (site_id TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(site_id, nonce));
CREATE INDEX used_nonces_expiry ON used_nonces(expires_at);
