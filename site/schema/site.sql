-- Reference schema for Site owner to express in db/schema.ts and Drizzle migration.
-- Do not execute schema at runtime; do not expose private_jwk through an API.
CREATE TABLE signing_keys (owner_id TEXT PRIMARY KEY, private_jwk TEXT NOT NULL, public_jwk TEXT NOT NULL);
