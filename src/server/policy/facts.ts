import { and, eq } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import type { Channel, PolicyFacts } from './types'
import { ensurePaymentsSchema } from '#/server/payments/migrate'
import { ensureRiskSchema, readAccountRiskFlag } from '#/server/risk/accounts'
import { resolveRiskRecipient } from '#/server/risk/recipient'
import { transferActivity } from './transfer-activity'

const DAY = 24 * 60 * 60 * 1000

/** 从数据库采集策略事实。模型提供的参数只用于定位对象（如收款人 ID），不参与事实本身。 */
export async function collectFacts(params: {
  userId: string
  channel: Channel
  payeeId?: string
  toAccountId?: string
  splitRequestId?: string
  now?: Date
}): Promise<PolicyFacts> {
  const now = params.now ?? new Date()

  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, params.userId))
  const { dailyOutgoingCents, recentTransferCount } = await transferActivity(params.userId, now)

  let payeeAgeDays: number | undefined
  if (params.payeeId) {
    const [payee] = await db
      .select()
      .from(schema.payees)
      .where(and(eq(schema.payees.id, params.payeeId), eq(schema.payees.userId, params.userId)))
    if (payee) payeeAgeDays = (now.getTime() - payee.createdAt.getTime()) / DAY
  }

  await ensurePaymentsSchema()
  await ensureRiskSchema()
  const riskAccountId = await resolveRiskRecipient(params)
  const risk = riskAccountId ? await readAccountRiskFlag(riskAccountId) : null

  return {
    now,
    channel: params.channel,
    accountLocked: !!user?.lockedUntil && user.lockedUntil.getTime() > now.getTime(),
    dailyOutgoingCents,
    payeeAgeDays,
    recentTransferCount,
    ...(risk && risk.status !== 'cleared' ? { payeeRiskFlag: risk.status, payeeRiskAccountId: risk.accountId, payeeRiskRevision: risk.revision } : {}),
  }
}
