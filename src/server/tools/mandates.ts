import { z } from 'zod'
import { defineBankTool } from './define'
import { simNow } from './jobs'
import {
  MANDATE_LIMITS,
  createMandate,
  describeCadence,
  listMandates,
  planMandate,
  revokeMandate,
} from '#/server/automation/mandates'
import type { MandatePlan } from '#/server/automation/mandates'

const yuan = (cents: number) => `¥${(cents / 100).toFixed(2)}`

const createInput = z.object({
  fromAccountId: z.string().describe('付款储蓄账户 ID，来自 get_accounts'),
  payeeId: z.string().describe('收款人 ID，来自 find_payee / list_payees'),
  amountCents: z.number().int().positive().describe('每次转账金额，单位分'),
  every: z.enum(['daily', 'weekly', 'monthly']).describe('执行频率'),
  weekday: z.number().int().min(1).max(7).optional().describe('每周执行时的星期，1=周一 … 7=周日'),
  dayOfMonth: z.number().int().min(1).max(28).optional().describe('每月执行时的日期，1–28'),
  time: z.string().optional().describe('北京时间 HH:mm，默认 09:00'),
  validityDays: z.number().int().min(1).max(MANDATE_LIMITS.maxValidityDays).optional().describe('授权有效天数，默认 30'),
  maxExecutions: z.number().int().min(1).max(MANDATE_LIMITS.maxExecutions).optional().describe('最多执行次数，默认取有效期内的全部次数'),
  memo: z.string().max(50).optional(),
})
type CreateInput = z.infer<typeof createInput>
/** prepare 解析出的完整方案会随确认单一起冻结并签名；客户端不能提供 */
type Prepared = CreateInput & { plan: MandatePlan }

/**
 * 创建常设授权。**不是转账**：它授权系统在有限期内、按固定频率向固定收款人转固定金额。
 *
 * 约束（改动前必读）：
 * 1. 基础等级红色，必须强验证；确认单列明每次金额、频率、授权期、次数和累计上限。
 * 2. 模型只能创建、查询、撤销，**没有触发执行的工具**；执行只由 worker 到期触发。
 * 3. 次数、金额、间隔、授权期的上限都由代码在每次执行时强制，不依赖这里写的任何文字。
 */
export const createStandingMandate = defineBankTool({
  name: 'create_standing_mandate',
  kind: 'write',
  baseRisk: 'red',
  description:
    '创建定期转账授权，例如每月给孩子转生活费。用户通过一次强验证授权后，系统在授权期内按频率自动转账，期间不再逐笔确认；' +
    '有单次金额、执行次数、累计金额与最小间隔的硬上限，到期或用户撤销后失效。收款人必须已在收款人列表中。' +
    '你无法触发执行，也不要承诺确认单之外的次数或金额。',
  inputSchema: createInput,
  factsHint: (a) => ({ payeeId: a.payeeId }),
  prepare: async (a, ctx) => {
    const plan = await planMandate(
      ctx.userId,
      {
        fromAccountId: a.fromAccountId,
        payeeId: a.payeeId,
        amountCents: a.amountCents,
        cadence: { every: a.every, weekday: a.weekday, dayOfMonth: a.dayOfMonth, time: a.time },
        validityDays: a.validityDays,
        maxExecutions: a.maxExecutions,
        memo: a.memo,
      },
      await simNow(),
    )
    return { ...a, plan } as Prepared
  },
  summarize: async (args) => {
    const { plan } = args as Prepared
    return {
      title: '确认定期转账授权',
      fields: [
        { label: '收款人', value: plan.payeeName },
        { label: '付款账户', value: plan.fromAccountName },
        { label: '每次金额', value: yuan(plan.amountCents) },
        { label: '执行频率', value: describeCadence(plan.cadence) },
        { label: '授权有效期', value: `自确认起 ${plan.validityDays} 天` },
        { label: '最多执行', value: `${plan.maxExecutions} 次，累计不超过 ${yuan(plan.maxTotalCents)}` },
        { label: '最小间隔', value: `两次执行至少相隔 ${Math.round((plan.minIntervalHours / 24) * 10) / 10} 天` },
        { label: '生效后', value: '到期自动转账，无需再次确认；可随时在任务中心撤销' },
        ...(plan.memo ? [{ label: '备注', value: plan.memo }] : []),
      ],
    }
  },
  execute: async (args, ctx) => {
    const { plan } = args as Prepared
    const created = await createMandate(ctx, plan, await simNow())
    return {
      status: 'mandate_created' as const,
      ...created,
      payee: plan.payeeName,
      amount: plan.amountCents / 100,
      cadence: describeCadence(plan.cadence),
      maxExecutions: plan.maxExecutions,
      maxTotal: plan.maxTotalCents / 100,
    }
  },
  // DAG 失败回退时撤销刚创建的授权
  compensate: async (_args, out, ctx) => {
    await revokeMandate(ctx, (out as { mandateId: string }).mandateId, '计划回退')
  },
})

export const listStandingMandates = defineBankTool({
  name: 'list_standing_mandates',
  kind: 'read',
  baseRisk: 'green',
  description: '查询本人的定期转账授权：收款人、金额、频率、已执行次数与累计金额、下次执行时间、到期时间与状态。',
  inputSchema: z.object({}),
  execute: async (_args, ctx) => listMandates(ctx.userId),
})

export const revokeStandingMandate = defineBankTool({
  name: 'revoke_standing_mandate',
  kind: 'write',
  baseRisk: 'yellow',
  description: '撤销一个定期转账授权，立即生效，之后不会再自动转账。已经执行的转账不会冲回。',
  inputSchema: z.object({ mandateId: z.string() }),
  summarize: async ({ mandateId }, ctx) => {
    const found = (await listMandates(ctx.userId)).find((m) => m.id === mandateId)
    if (!found || !['active', 'suspended'].includes(found.status)) throw new Error('授权不存在，或已经结束')
    return {
      title: '确认撤销定期转账授权',
      fields: [
        { label: '收款人', value: found.payeeName },
        { label: '每次金额', value: `¥${found.amount.toFixed(2)}` },
        { label: '频率', value: found.cadence },
        { label: '已执行', value: `${found.executionsDone}/${found.maxExecutions} 次，累计 ¥${found.totalSpent.toFixed(2)}` },
        { label: '撤销后', value: '不再自动转账；已执行的转账不会冲回' },
      ],
    }
  },
  execute: async ({ mandateId }, ctx) => revokeMandate(ctx, mandateId),
})

export const MANDATE_TOOLS = [createStandingMandate, listStandingMandates, revokeStandingMandate]
