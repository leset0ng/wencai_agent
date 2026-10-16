import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import { detectSubscriptions, notifications } from '#/server/automation/service'
import { defineBankTool } from './define'
import { cancelLifeSubscription } from '#/server/life/service'

export const detectRecurring = defineBankTool({
  name: 'detect_subscriptions', kind: 'read', baseRisk: 'green',
  description: '从本人交易流水自动识别同商户同金额的月度/年度周期扣款，返回候选与证据次数，不能把候选当成已确认订阅。',
  inputSchema: z.object({}), execute: (_a, ctx) => detectSubscriptions(ctx.userId),
})
export const saveDetectedSubscription = defineBankTool({
  name: 'save_detected_subscription', kind: 'write', baseRisk: 'yellow',
  description: '确认自动识别的订阅并开启提醒，或一键标记取消该模拟代扣。candidateId 必须来自 detect_subscriptions，由用户核对确认。',
  inputSchema: z.object({ candidateId: z.string(), cancel: z.boolean().default(false) }),
  summarize: async (a, ctx) => { const c = (await detectSubscriptions(ctx.userId)).find((c) => c.candidateId === a.candidateId); if (!c) throw new Error('订阅候选已失效，请重新识别'); return { title: a.cancel ? '确认取消识别到的模拟代扣' : '确认订阅与提醒', fields: [{ label: '商户', value: c.merchant }, { label: '周期', value: c.cycle === 'monthly' ? '每月' : '每年' }, { label: '金额', value: `¥${c.amount.toFixed(2)}` }, { label: '识别依据', value: `${c.matchedPayments} 笔周期扣款` }] } },
  execute: async (a, ctx) => {
    const c = (await detectSubscriptions(ctx.userId)).find((c) => c.candidateId === a.candidateId)
    if (!c) throw new Error('订阅候选已失效')
    const id = `sub_detected_${c.candidateId}`
    const [known] = await db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.userId, ctx.userId), eq(schema.subscriptions.merchant, c.merchant), eq(schema.subscriptions.amountCents, Math.round(c.amount * 100))))
    if (known) { if (a.cancel) await cancelLifeSubscription(ctx,known.id); return { subscriptionId: known.id, status: a.cancel ? 'cancelled' : known.status } }
    await db.insert(schema.subscriptions).values({ id, userId: ctx.userId, merchant: c.merchant, amountCents: Math.round(c.amount * 100), cycle: c.cycle as 'monthly' | 'yearly', status: a.cancel ? 'cancelled' : 'active', lastChargedAt: new Date(c.lastChargedAt), remindDays: 3 }).onConflictDoNothing()
    return { subscriptionId: id, merchant: c.merchant, status: a.cancel ? 'cancelled' : 'active' }
  },
})
export const listNotifications = defineBankTool({ name: 'list_notifications', kind: 'read', baseRisk: 'green', description: '读取本人续费提醒、定时任务结果及待核对操作。', inputSchema: z.object({}), execute: (_a, ctx) => notifications(ctx.userId) })
export const SUBSCRIPTION_TOOLS = [detectRecurring, saveDetectedSubscription, listNotifications]
