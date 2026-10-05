// Apply the supplied schema through the deployment workflow, never at runtime.
// D1 bindings must be private to their respective Site / bridge.
export function createBridgeStore(db, now = Date.now) {
  if (!db?.prepare) throw new Error('Missing private store');
  return {
    async createState(state, value) {
      await db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').bind(now()).run();
      await db.prepare('INSERT INTO oauth_states (state, payload, expires_at) VALUES (?, ?, ?)').bind(state, JSON.stringify(value), value.expiresAt).run();
    },
    async consumeState(state) {
      const row = await db.prepare('DELETE FROM oauth_states WHERE state = ? RETURNING payload').bind(state).first();
      return row ? JSON.parse(row.payload) : null;
    },
    async setToken(site, owner, value) {
      await db.prepare('INSERT INTO mail_tokens (site_id, owner_id, payload) VALUES (?, ?, ?) ON CONFLICT(site_id, owner_id) DO UPDATE SET payload = excluded.payload').bind(site, owner, JSON.stringify(value)).run();
    },
    async getToken(site, owner) {
      const row = await db.prepare('SELECT payload FROM mail_tokens WHERE site_id = ? AND owner_id = ?').bind(site, owner).first();
      return row ? JSON.parse(row.payload) : null;
    },
    async claimNonce({ siteId, nonce, expiresAt }) {
      await db.prepare('DELETE FROM used_nonces WHERE expires_at < ?').bind(Math.floor(now() / 1000)).run();
      const result = await db.prepare('INSERT OR IGNORE INTO used_nonces (site_id, nonce, expires_at) VALUES (?, ?, ?)').bind(siteId, nonce, expiresAt).run();
      return result.success === true && result.meta?.changes === 1;
    }
  };
}
