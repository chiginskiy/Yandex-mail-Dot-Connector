import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const signingKeys = sqliteTable('signing_keys', {ownerId:text('owner_id').primaryKey(),privateJwk:text('private_jwk').notNull(),publicJwk:text('public_jwk').notNull()});
