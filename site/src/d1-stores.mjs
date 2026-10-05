export function createSigningKeyStore(db) {
  if (!db?.prepare) throw new Error('Missing private store');
  const rowFor = owner => db.prepare('SELECT private_jwk, public_jwk FROM signing_keys WHERE owner_id = ?').bind(owner).first();
  return {
    async initialize(owner) {
      let row = await rowFor(owner);
      if (!row) {
        const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
        const privateJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));
        const publicJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey));
        await db.prepare('INSERT OR IGNORE INTO signing_keys (owner_id, private_jwk, public_jwk) VALUES (?, ?, ?)').bind(owner, privateJwk, publicJwk).run();
        row = await rowFor(owner);
      }
      if (!row) throw new Error('Key storage unavailable');
      return JSON.parse(row.public_jwk);
    },
    async publicKey(owner) {
      const row = await rowFor(owner);
      return row ? JSON.parse(row.public_jwk) : null;
    },
    async signingKey(owner) {
      const row = await rowFor(owner);
      if (!row) throw new Error('Key not initialized');
      return crypto.subtle.importKey('jwk', JSON.parse(row.private_jwk), 'Ed25519', false, ['sign']);
    }
  };
}
