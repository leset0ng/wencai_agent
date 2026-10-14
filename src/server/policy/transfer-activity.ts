import { and, eq, gte, inArray, lt } from 'drizzle-orm'
import { db, schema, type DB } from '#/server/db/client'
import type { AgentContext } from '#/server/agent/context'
import { LIMITS } from './rules'

/** Shared UTC+8 ledger facts, also readable inside the actual debit transaction. */
export async function transferActivity(userId: string, now: Date, reader: Pick<DB, 'select'> = db) {
  const day = 86_400_000
  const start = Math.floor((now.getTime() + 8 * 3600_000) / day) * day - 8 * 3600_000
  const rows = await reader.select({ cents: schema.transactions.amountCents, at: schema.transactions.occurredAt })
    .from(schema.transactions).innerJoin(schema.accounts, eq(schema.accounts.id, schema.transactions.accountId))
    .where(and(eq(schema.accounts.userId, userId), inArray(schema.transactions.category, ['转账', '信用卡还款', '生日订购']),
      lt(schema.transactions.amountCents, 0), gte(schema.transactions.occurredAt, new Date(Math.min(start, now.getTime() - 600_000))),
      lt(schema.transactions.occurredAt, new Date(now.getTime() + 1))))
  return rows.reduce((activity, row) => {
    if (row.at.getTime() >= start) activity.dailyOutgoingCents -= row.cents
    if (now.getTime() - row.at.getTime() < 600_000) activity.recentTransferCount++
    return activity
  }, { dailyOutgoingCents: 0, recentTransferCount: 0 })
}

/** A stale yellow authorization must never debit across the daily boundary. */
export async function assertDailyTransferAuthorization(reader: Pick<DB, 'select'>, userId: string, cents: number, now: Date, authorization: AgentContext['authorization']) {
  const { dailyOutgoingCents } = await transferActivity(userId, now, reader)
  if (dailyOutgoingCents + cents > LIMITS.dailyOutgoingCents && authorization?.level !== 'red') {
    throw new Error('今日累计转账超过 1000 元，请重新核对并完成强验证')
  }
}
