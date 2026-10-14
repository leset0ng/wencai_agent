import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import { defineBankTool } from './define'
import { cardLabel, resolveCard } from '#/server/cards/service'
import { cancelBirthday, ensureBirthdaySchema, executeBirthdayOrder, reserveBirthday } from '#/server/automation/birthdays'
import { simNow } from './jobs'

const input = z.object({ fromCardQuery: z.string().min(1), contactId: z.string(), birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), budgetCents: z.number().int().min(2).max(10_000_000) })
type Prepared = z.infer<typeof input> & { fromAccountId: string; amountCents: number }
export const createBirthdayPlan = defineBankTool({
  name: 'create_birthday_plan', kind: 'write', baseRisk: 'yellow', description: '为联系人创建生日计划，立即从指定储蓄卡预留预算，生日前两天自动完成文财模拟鲜花/蛋糕预订。预算单位分，需确认；明确是模拟预订，不联系真实商家。', inputSchema: input,
  prepare: async (a, ctx) => ({ ...a, fromAccountId: (await resolveCard(ctx.userId, a.fromCardQuery, 'debit')).accountId, amountCents: a.budgetCents }),
  summarize: async (a, ctx) => { const [contact] = await db.select().from(schema.contacts).where(and(eq(schema.contacts.id, a.contactId), eq(schema.contacts.userId, ctx.userId))); if (!contact) throw new Error('联系人不存在'); return { title: '确认生日预算与模拟预订', fields: [{ label: '联系人', value: contact.name }, { label: '生日', value: a.birthday }, { label: '付款卡', value: cardLabel(await resolveCard(ctx.userId, a.fromCardQuery, 'debit')) }, { label: '预留预算', value: `¥${(a.budgetCents / 100).toFixed(2)}` }, { label: '执行', value: '生日前两天模拟预订鲜花、蛋糕' }] } },
  execute: async (a, ctx) => reserveBirthday(a as Prepared, ctx, await simNow()),
  compensate: async (_a, out, ctx) => { await cancelBirthday(ctx.userId, out.planId) },
})
export const birthdayOrder = defineBankTool({
  name: 'execute_birthday_order', kind: 'write', baseRisk: 'yellow', description: '执行已确认并预留资金的生日模拟预订，风险变化时重新核对授权。不会重复扣款或联系真实商户。',
  inputSchema: z.object({ planId: z.string() }),
  prepare: async (a, ctx) => { await ensureBirthdaySchema(); const [plan] = await db.select().from(schema.birthdayPlans).where(and(eq(schema.birthdayPlans.id, a.planId), eq(schema.birthdayPlans.userId, ctx.userId))); if (!plan) throw new Error('计划不存在'); return { ...a, amountCents: plan.budgetCents } },
  summarize: async (a, ctx) => { const [plan] = await db.select().from(schema.birthdayPlans).where(and(eq(schema.birthdayPlans.id, a.planId), eq(schema.birthdayPlans.userId, ctx.userId))); if (!plan) throw new Error('计划不存在'); return { title: '确认使用已预留的生日预算', fields: [{ label: '生日', value: plan.birthday }, { label: '预算', value: `¥${(plan.budgetCents / 100).toFixed(2)}` }, { label: '商户', value: '文财模拟鲜花与蛋糕商户' }] } },
  execute: async (a, ctx) => executeBirthdayOrder(ctx.userId, a.planId, await simNow(), undefined, ctx.authorization),
})
export const listBirthdayPlans = defineBankTool({ name: 'list_birthday_plans', kind: 'read', baseRisk: 'green', description: '查询本人生日计划与模拟订单、预算状态。', inputSchema: z.object({}), execute: async (_a, ctx) => {
  const plans = await db.select().from(schema.birthdayPlans).where(eq(schema.birthdayPlans.userId, ctx.userId))
  await ensureBirthdaySchema()
  const funds = await db.select().from(schema.bankBirthdayFunds).where(eq(schema.bankBirthdayFunds.userId, ctx.userId))
  return Promise.all(plans.map(async (plan) => {
    const fund = funds.find((item) => item.planId === plan.id)
    return { ...plan, status: plan.status === 'reserved' && !fund ? 'planned' : plan.status, heldAmount: (fund?.heldCents ?? 0) / 100, ...(plan.status === 'reserved' && !fund ? { note: '旧版演示占位计划，尚未实际预留资金，也未授权自动下单。需要重新创建并确认。' } : {}), orders: await db.select().from(schema.birthdayOrders).where(eq(schema.birthdayOrders.planId, plan.id)) }
  }))
} })
export const BIRTHDAY_TOOLS = [createBirthdayPlan, birthdayOrder, listBirthdayPlans]
