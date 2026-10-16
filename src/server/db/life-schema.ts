import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const bankLifeOrders = sqliteTable('bank_life_orders', {
  id: text('id').primaryKey(), userId: text('user_id').notNull(), actionId: text('action_id').notNull().unique(),
  productId: text('product_id').notNull(), quantity: integer('quantity').notNull(), amountCents: integer('amount_cents').notNull(),
  accountId: text('account_id').notNull(), transactionId: text('transaction_id').notNull().unique(),
  deliveryJson: text('delivery_json').notNull(), status: text('status').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  dispatchAt: integer('dispatch_at', { mode: 'timestamp_ms' }).notNull(), deliveryAt: integer('delivery_at', { mode: 'timestamp_ms' }).notNull(),
  refundDueAt: integer('refund_due_at', { mode: 'timestamp_ms' }), refundedAt: integer('refunded_at', { mode: 'timestamp_ms' }), refundReason: text('refund_reason'),
})
export const bankLifeSubscriptions = sqliteTable('bank_life_subscriptions', {
  id: text('id').primaryKey(), userId: text('user_id').notNull(), actionId: text('action_id').notNull().unique(),
  productId: text('product_id').notNull(), accountId: text('account_id').notNull(), amountCents: integer('amount_cents').notNull(),
  periodEnd: integer('period_end', { mode: 'timestamp_ms' }).notNull(),
  nextChargeAt: integer('next_charge_at', { mode: 'timestamp_ms' }), renewalsLeft: integer('renewals_left').notNull(),
  renewalStatus: text('renewal_status').notNull(), createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  authorizationExpiresAt: integer('authorization_expires_at', { mode: 'timestamp_ms' }).notNull(),
})
