import { integer, sqliteTable, text, primaryKey } from 'drizzle-orm/sqlite-core'

export const bankFunds = sqliteTable('bank_funds', {
  code: text('code').primaryKey(), name: text('name').notNull(), category: text('category').notNull(),
  riskRating: text('risk_rating').notNull(), purchaseStatus: text('purchase_status').notNull(),
  redeemStatus: text('redeem_status').notNull(), purchaseFeeBp: integer('purchase_fee_bp').notNull(),
  minPurchaseCents: integer('min_purchase_cents').notNull(), enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  source: text('source').notNull(), updatedAt: text('updated_at').notNull(),
  metadataJson: text('metadata_json').notNull().default('{}'),
})
export const bankFundNavs = sqliteTable('bank_fund_navs', {
  code: text('code').notNull(), navDate: text('nav_date').notNull(), unitNavE4: integer('unit_nav_e4').notNull(),
  accNavE4: integer('acc_nav_e4').notNull(), fetchedAt: text('fetched_at').notNull(),
  dailyReturnE8: integer('daily_return_e8'),
}, (t) => [primaryKey({ columns: [t.code, t.navDate] })])
export const bankFundSyncState = sqliteTable('bank_fund_sync_state', {
  code: text('code').primaryKey(), leaseToken: text('lease_token'), leaseUntil: integer('lease_until').notNull().default(0),
  nextRunAt: integer('next_run_at').notNull().default(0), lastSuccessAt: text('last_success_at'), lastErrorCode: text('last_error_code'),
})
export const bankFundOrders = sqliteTable('bank_fund_orders', {
  id: text('id').primaryKey(), userId: text('user_id').notNull(), actionId: text('action_id').notNull().unique(),
  code: text('code').notNull(), side: text('side').notNull(), amountCents: integer('amount_cents').notNull(),
  sharesE2: integer('shares_e2'), accountId: text('account_id').notNull(), tradeDate: text('trade_date').notNull(),
  status: text('status', { enum: ['submitted', 'confirmed', 'cancelled'] }).notNull(), navDate: text('nav_date'),
  unitNavE4: integer('unit_nav_e4'), feeCents: integer('fee_cents'), transactionId: text('transaction_id').notNull().unique(),
  createdAt: text('created_at').notNull(), confirmedAt: text('confirmed_at'),
})
export const bankFundPositions = sqliteTable('bank_fund_positions', {
  userId: text('user_id').notNull(), code: text('code').notNull(), sharesE2: integer('shares_e2').notNull(),
  costCents: integer('cost_cents').notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.code] })])
export const bankFundWatchlist = sqliteTable('bank_fund_watchlist', {
  userId: text('user_id').notNull(), code: text('code').notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.code] })])
