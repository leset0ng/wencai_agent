import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
/** PAN ciphertext is deliberately separate from all dashboard/tool projections. */
export const bankCardNumbers = sqliteTable('bank_card_numbers', {
  cardId: text('card_id').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  fingerprint: text('fingerprint').notNull().unique(),
})
