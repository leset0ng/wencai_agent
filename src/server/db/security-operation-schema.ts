import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
export const bankCardPasswords = sqliteTable('bank_card_passwords', {
  cardId: text('card_id').primaryKey(), userId: text('user_id').notNull(),
  passwordHash: text('password_hash').notNull(), version: integer('version').notNull().default(1),
})
export const bankSecureRequests = sqliteTable('bank_secure_requests', {
  id: text('id').primaryKey(), userId: text('user_id').notNull(), sessionId: text('session_id').notNull(),
  purpose: text('purpose').notNull(), cardId: text('card_id'), actionId: text('action_id'),
  status: text('status').notNull().default('pending'), passwordHash: text('password_hash'),
  passwordVersion: integer('password_version'), resultJson: text('result_json'),
  verificationMethod: text('verification_method'),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
})
