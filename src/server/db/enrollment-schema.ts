import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
export const bankInitialEnrollments = sqliteTable('bank_initial_enrollments', {
  sessionId: text('session_id').primaryKey(), userId: text('user_id').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
})
