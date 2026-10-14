import { randomUUID } from 'node:crypto'
import { and, eq, gte, sql } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import { assertDebitAccount } from '#/server/cards/service'
import { ensureAutomationSchema, notify } from './service'
import type { AgentContext } from '#/server/agent/context'
import { assertDailyTransferAuthorization } from '#/server/policy/transfer-activity'

let ready: Promise<unknown> | undefined
export const ensureBirthdaySchema = () => ready ??= db.$client.execute('CREATE TABLE IF NOT EXISTS bank_birthday_funds (plan_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL, held_cents INTEGER NOT NULL, status TEXT NOT NULL)').catch((e) => { ready = undefined; throw e })
export async function reservedFunds(userId: string) {
  await ensureBirthdaySchema()
  return db.select().from(schema.bankBirthdayFunds).where(and(eq(schema.bankBirthdayFunds.userId, userId), eq(schema.bankBirthdayFunds.status, 'reserved')))
}
export async function reserveBirthday(a: { fromAccountId: string; contactId: string; birthday: string; budgetCents: number }, ctx: AgentContext, now = new Date()) {
  await ensureBirthdaySchema(); await ensureAutomationSchema()
  const date = new Date(`${a.birthday}T00:00:00+08:00`)
  if (!Number.isFinite(date.getTime()) || new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10) !== a.birthday || date.getTime() + 86400_000 <= now.getTime()) throw new Error('请输入有效的未来生日日期')
  if (!Number.isSafeInteger(a.budgetCents) || a.budgetCents < 2 || a.budgetCents > 10_000_000) throw new Error('预算金额无效')
  return db.transaction(async (tx) => {
    const [contact] = await tx.select().from(schema.contacts).where(and(eq(schema.contacts.id, a.contactId), eq(schema.contacts.userId, ctx.userId)))
    if (!contact) throw new Error('联系人不存在')
    await assertDebitAccount(tx, a.fromAccountId)
    const [account] = await tx.update(schema.accounts).set({ balanceCents: sql`${schema.accounts.balanceCents} - ${a.budgetCents}` }).where(and(eq(schema.accounts.id, a.fromAccountId), eq(schema.accounts.userId, ctx.userId), gte(schema.accounts.balanceCents, a.budgetCents))).returning()
    if (!account) throw new Error('可用余额不足，未预留资金')
    const planId = `birthday_${randomUUID()}`, taskId = `birthday_order_${planId}`
    await tx.insert(schema.birthdayPlans).values({ id: planId, userId: ctx.userId, contactId: a.contactId, birthday: a.birthday, budgetCents: a.budgetCents, status: 'reserved', createdAt: now.toISOString() })
    await tx.insert(schema.bankBirthdayFunds).values({ planId, userId: ctx.userId, accountId: account.id, heldCents: a.budgetCents, status: 'reserved' })
    await tx.insert(schema.scheduledTasks).values({ id: taskId, userId: ctx.userId, kind: 'birthdayOrder', status: 'pending', dueAt: new Date(Math.max(now.getTime(), date.getTime() - 2 * 86400_000)).toISOString(), payloadJson: JSON.stringify({ planId, amountCents: a.budgetCents }), createdAt: now.toISOString() })
    if (ctx.authorization) await tx.insert(schema.bankTaskPermissions).values({ taskId, level: ctx.authorization.level })
    return { planId, taskId, heldAmount: a.budgetCents / 100, birthday: a.birthday, contact: contact.name, status: 'reserved', service: '文财模拟鲜花与蛋糕预订' }
  })
}
export async function executeBirthdayOrder(userId: string, planId: string, now = new Date(), taskClaim?: { id: string; marker: string }, authorization?: AgentContext['authorization']) {
  await ensureBirthdaySchema()
  const result = await db.transaction(async (tx) => {
    const [plan] = await tx.select().from(schema.birthdayPlans).where(and(eq(schema.birthdayPlans.id, planId), eq(schema.birthdayPlans.userId, userId)))
    const [fund] = await tx.select().from(schema.bankBirthdayFunds).where(and(eq(schema.bankBirthdayFunds.planId, planId), eq(schema.bankBirthdayFunds.userId, userId)))
    if (!plan || !fund) throw new Error('生日计划或预留资金不存在')
    if (new Date(`${plan.birthday}T00:00:00+08:00`).getTime() - 2 * 86400_000 > now.getTime()) throw new Error('尚未到预约预订时间')
    if (plan.status === 'ordered' && fund.status === 'spent') return { planId, amount: plan.budgetCents / 100, status: 'ordered', duplicate: true }
    if (plan.status !== 'reserved' || fund.status !== 'reserved' || fund.heldCents !== plan.budgetCents) throw new Error('计划已变化，不可重复下单')
    await assertDailyTransferAuthorization(tx, userId, plan.budgetCents, now, authorization)
    if (taskClaim) {
      const [task] = await tx.update(schema.scheduledTasks).set({ status: 'succeeded', resultJson: JSON.stringify({ planId, amount: plan.budgetCents / 100, status: 'ordered' }) }).where(and(eq(schema.scheduledTasks.id, taskClaim.id), eq(schema.scheduledTasks.userId, userId), eq(schema.scheduledTasks.status, 'processing'), eq(schema.scheduledTasks.resultJson, taskClaim.marker))).returning()
      if (!task) throw new Error('任务执行权已变化，未下单')
    } else await tx.update(schema.scheduledTasks).set({ status: 'succeeded', resultJson: JSON.stringify({ planId, amount: plan.budgetCents / 100, status: 'ordered' }) }).where(and(eq(schema.scheduledTasks.userId, userId), eq(schema.scheduledTasks.kind, 'birthdayOrder'), sql`json_extract(${schema.scheduledTasks.payloadJson}, '$.planId') = ${planId}`, sql`${schema.scheduledTasks.status} IN ('pending', 'awaiting_confirmation')`))
    await assertDebitAccount(tx, fund.accountId)
    const [claimed] = await tx.update(schema.bankBirthdayFunds).set({ status: 'spent', heldCents: 0 }).where(and(eq(schema.bankBirthdayFunds.planId, planId), eq(schema.bankBirthdayFunds.status, 'reserved'))).returning()
    if (!claimed) throw new Error('计划已处理')
    for (const [i, item] of ['鲜花', '蛋糕'].entries()) {
      const cents = i === 0 ? Math.floor(plan.budgetCents / 2) : plan.budgetCents - Math.floor(plan.budgetCents / 2)
      await tx.insert(schema.birthdayOrders).values({ id: `${planId}_${i}`, planId, merchant: '文财模拟商户', item, amountCents: cents, deliveryDate: plan.birthday, status: 'confirmed' })
      await tx.insert(schema.transactions).values({ id: `tx_${planId}_${i}`, accountId: fund.accountId, amountCents: -cents, counterparty: `文财模拟${item}商户`, category: '生日订购', occurredAt: now })
    }
    await tx.update(schema.birthdayPlans).set({ status: 'ordered' }).where(eq(schema.birthdayPlans.id, planId))
    return { planId, amount: plan.budgetCents / 100, status: 'ordered', deliveryDate: plan.birthday }
  })
  await notify(userId, 'birthday', '生日礼品已模拟预订', `鲜花与蛋糕订单已记录，预算 ${result.amount.toFixed(2)} 元。`, `birthday:${planId}:ordered`).catch((error) => console.error('[birthday] 订单已完成，通知失败', String(error)))
  return result
}
export async function cancelBirthday(userId: string, planId: string) {
  await ensureBirthdaySchema()
  return db.transaction(async (tx) => {
    const [plan] = await tx.select().from(schema.birthdayPlans).where(and(eq(schema.birthdayPlans.id, planId), eq(schema.birthdayPlans.userId, userId)))
    if (!plan || !['planned', 'reserved'].includes(plan.status)) throw new Error('计划已下单或取消，需人工核对')
    const [fund] = await tx.update(schema.bankBirthdayFunds).set({ heldCents: 0, status: 'released' }).where(and(eq(schema.bankBirthdayFunds.planId, planId), eq(schema.bankBirthdayFunds.status, 'reserved'))).returning()
    // returning 是更新后的数据；原预算来自已核对计划，旧占位计划没有资金记录则不凭空退款。
    const released = fund ? plan.budgetCents : 0
    if (released) await tx.update(schema.accounts).set({ balanceCents: sql`${schema.accounts.balanceCents} + ${released}` }).where(and(eq(schema.accounts.id, fund.accountId), eq(schema.accounts.userId, userId)))
    await tx.update(schema.birthdayPlans).set({ status: 'cancelled' }).where(eq(schema.birthdayPlans.id, planId))
    await tx.update(schema.scheduledTasks).set({ status: 'cancelled' }).where(and(eq(schema.scheduledTasks.userId, userId), eq(schema.scheduledTasks.status, 'pending'), sql`json_extract(${schema.scheduledTasks.payloadJson}, '$.planId') = ${planId}`))
    return { planId, status: 'cancelled', releasedBudget: released / 100 }
  })
}
