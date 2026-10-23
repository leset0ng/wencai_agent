/**
 * 扩展工具（第二批）：联系人、持仓解析、预算/排期/条款校验、风险测评、定时转账、AA 收款、生日计划取消、订阅提醒、到期任务。
 * 与 bank-extended.ts 共用令牌与校验辅助函数，口径一致。
 */
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '#/server/db/client'
import { defineBankTool } from './define'
import { RISK_QUESTIONNAIRE } from '#/lib/questionnaire'
import {
  DAY,
  advanceSimulationClock,
  consumeToken,
  fmt,
  issueToken,
  ownAccountOrThrow,
  ownPayeeOrThrow,
  yuan,
} from './bank-extended'
import { runDueJobs, scoreRisk, simNow } from './jobs'
import { listLifeSubscriptions } from '#/server/life/service'
import type { AgentContext } from '#/server/agent/context'
import { ensureAutomationSchema } from '#/server/automation/service'
import { createSplitRequests } from '#/server/payments/splits'
import { cancelBirthday } from '#/server/automation/birthdays'



async function ownContactOrThrow(ctx: AgentContext, contactId: string) {
  const [c] = await db
    .select()
    .from(schema.contacts)
    .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.userId, ctx.userId)))
  if (!c) throw new Error(`联系人不存在：${contactId}`)
  return c
}

async function ownSubscriptionOrThrow(ctx: AgentContext, subscriptionId: string) {
  const [s] = await db
    .select()
    .from(schema.subscriptions)
    .where(and(eq(schema.subscriptions.id, subscriptionId), eq(schema.subscriptions.userId, ctx.userId)))
  if (!s) throw new Error('订阅不存在')
  return s
}

/** 下次扣费时间：按周期从上次扣费推算 */
function nextChargeAt(s: { cycle: 'monthly' | 'yearly'; lastChargedAt: Date | null }) {
  if (!s.lastChargedAt) return null
  const d = new Date(s.lastChargedAt)
  if (s.cycle === 'monthly') d.setMonth(d.getMonth() + 1)
  else d.setFullYear(d.getFullYear() + 1)
  return d.toISOString()
}

/** 定时执行时间必须晚于仿真时钟 */
async function futureTimeOrThrow(executeAt: string) {
  const when = new Date(executeAt)
  if (!Number.isFinite(when.getTime())) throw new Error('INVALID_TIME: 时间格式无效')
  const now = await simNow()
  if (when <= now) throw new Error(`INVALID_TIME: 必须晚于当前模拟业务时间 ${now.toISOString()}`)
  return { iso: when.toISOString(), now }
}

/** AA 按分平均，余数依次分给参与人；发起人自己占一份 */
function splitShares(total: number, contactIds: string[]) {
  const n = contactIds.length + 1
  const base = Math.floor(total / n)
  const rem = total % n
  if (base === 0) throw new Error('金额不足以按分拆分')
  return {
    selfAmountCents: base,
    shares: contactIds.map((contactId, i) => ({ contactId, amountCents: base + (i < rem ? 1 : 0) })),
  }
}

// ── 只读 / 解析 ───────────────────────────────────────────────────────────────

export const listContacts = defineBankTool({
  name: 'list_contacts',
  description:
    '列出通讯录联系人（用于 AA 收款与生日计划），可按姓名或备注片段过滤。转账收款人请用 resolve_recipient。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({ q: z.string().optional() }),
  execute: async ({ q }, ctx) => {
    const all = await db.select().from(schema.contacts).where(eq(schema.contacts.userId, ctx.userId))
    const rows = q ? all.filter((c) => c.name.includes(q) || c.note.includes(q)) : all
    return rows.map((c) => ({
      contactId: c.id,
      name: c.name,
      note: c.note,
      bank: c.bank,
      account: c.accountMask,
    }))
  },
})

export const resolveHolding = defineBankTool({
  name: 'resolve_holding',
  description: '按产品名或持仓 ID 定位唯一持仓，返回本金与是否可赎回。多个命中时返回候选，需要用户指定。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({ query: z.string().min(1) }),
  execute: async ({ query }, ctx) => {
    const q = query.trim()
    const holdings = await db.select().from(schema.holdings).where(eq(schema.holdings.userId, ctx.userId))
    const products = await db.select().from(schema.products)
    const name = (productId: string) => products.find((p) => p.id === productId)?.name ?? productId
    const live = holdings.filter((h) => h.principalCents > 0)
    const exact = live.filter((h) => h.id === q)
    const matched = exact.length
      ? exact
      : live.filter((h) => name(h.productId).includes(q) || h.productId === q)
    const now = (await simNow()).toISOString()
    const view = (h: (typeof holdings)[number]) => ({
      holdingId: h.id,
      productName: name(h.productId),
      principal: yuan(h.principalCents),
      principalCents: h.principalCents,
      redeemableAt: h.redeemableAt,
      redeemableNow: h.redeemableAt <= now,
    })
    if (matched.length === 1) return { found: true, ...view(matched[0]) }
    return {
      found: false,
      needsDisambiguation: matched.length > 1,
      candidates: matched.map(view),
    }
  },
})

// ── 前置校验 ──────────────────────────────────────────────────────────────────

export const checkBudget = defineBankTool({
  name: 'check_budget',
  description: '检查一笔预算性支出（生日计划、礼物预算）在账户余额内是否可行，返回可用金额与差额。不预留资金。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({
    fromAccountId: z.string(),
    amountCents: z.number().int().positive(),
  }),
  execute: async ({ fromAccountId, amountCents }, ctx) => {
    const acc = await ownAccountOrThrow(ctx, fromAccountId)
    return {
      amount: yuan(amountCents),
      available: yuan(acc.balanceCents),
      affordable: acc.balanceCents >= amountCents,
      shortfall: yuan(Math.max(0, amountCents - acc.balanceCents)),
    }
  },
})

export const checkScheduleWindow = defineBankTool({
  name: 'check_schedule_window',
  description: '检查拟定执行时间是否合法（必须晚于当前模拟业务时间），并返回距今天数。用于定时转账排期。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({ executeAt: z.string().describe('ISO 8601 时间，含时区偏移') }),
  execute: async ({ executeAt }) => {
    const when = new Date(executeAt)
    if (!Number.isFinite(when.getTime())) throw new Error('时间格式无效')
    const now = await simNow()
    return {
      executeAt: when.toISOString(),
      now: now.toISOString(),
      valid: when > now,
      daysFromNow: Math.round((when.getTime() - now.getTime()) / DAY),
    }
  },
})

export const getSubscriptionTerms = defineBankTool({
  name: 'get_subscription_terms',
  description: '读取某项代扣的条款：金额、周期、下次扣费、提醒设置、年化成本与取消说明。建议用户取消前必须先调用。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({ subscriptionId: z.string() }),
  execute: async ({ subscriptionId }, ctx) => {
    const s = await ownSubscriptionOrThrow(ctx, subscriptionId)
    const life=(await listLifeSubscriptions(ctx.userId,await simNow())).find(item=>item.id===s.id)
    return {
      subscriptionId: s.id,
      merchant: s.merchant,
      amount: yuan(s.amountCents),
      cycle: s.cycle,
      status: s.status,
      nextChargeAt: life?.productId ? life.nextChargeAt : nextChargeAt(s),
      ...(life?.productId?{periodEnd:life.periodEnd,serviceStatus:life.serviceStatus,renewalsLeft:life.renewalsLeft,renewalStatus:life.renewalStatus,cardLast4:life.cardLast4}:{}),
      remindDays: s.remindDays,
      yearlyCost: yuan(s.cycle === 'monthly' ? s.amountCents * 12 : s.amountCents),
      cancellable: s.status === 'active',
      cancelNote: s.status === 'active' ? '取消后仅停止后续代扣，已发生的扣费不退。' : '该代扣已取消，无需重复操作。',
    }
  },
})

const answersSchema = z.array(z.number().int().min(1).max(5)).length(5).describe('五项答案，1 最低 / 5 最高')

export const getRiskQuestionnaire = defineBankTool({
  name: 'get_risk_questionnaire', kind: 'read', baseRisk: 'green',
  description: '开始或重新风险测评时调用。显示银行标准5题单选问卷，上一题/下一题切换，最后统一提交完整答案给Agent；不登记、不交易。不要提前查询理财推荐或展示产品选择。收到答案先assess_risk_profile试算，再征求登记同意。',
  inputSchema: z.object({}), execute: async () => ({ questionnaire: structuredClone(RISK_QUESTIONNAIRE) }),
})

export const assessRiskProfile = defineBankTool({
  name: 'assess_risk_profile',
  description: '用五项问卷试算风险等级（R1–R5），不写入账户。用户同意后再调用 commit_risk_assessment 登记。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({ answers: answersSchema }),
  execute: async ({ answers }) => ({ riskRating: scoreRisk(answers), persisted: false }),
})

// ── 写操作：低风险直通（仍需用户在确认卡上点确认）──────────────────────────────

export const commitRiskAssessment = defineBankTool({
  name: 'commit_risk_assessment',
  description: '把风险测评结果写入账户，有效期 365 天。先用 assess_risk_profile 试算并取得用户同意后再调用。',
  baseRisk: 'yellow',
  kind: 'write',
  inputSchema: z.object({ answers: answersSchema }),
  summarize: async ({ answers }) => ({
    title: '登记风险测评',
    fields: [{ label: '风险等级', value: scoreRisk(answers) }, { label: '有效期', value: '365 天' }],
  }),
  execute: async ({ answers }, ctx) => {
    const riskRating = scoreRisk(answers)
    const assessedAt = (await simNow()).toISOString()
    await db.update(schema.users).set({ riskRating, riskAssessedAt: assessedAt }).where(eq(schema.users.id, ctx.userId))
    return { riskRating, assessedAt, expiresInDays: 365 }
  },
})

export const setSubscriptionReminder = defineBankTool({
  name: 'set_subscription_reminder',
  description: '调整代扣的提前提醒天数（1–30 天）。不改变扣费金额与周期。',
  baseRisk: 'yellow',
  kind: 'write',
  inputSchema: z.object({ subscriptionId: z.string(), days: z.number().int().min(1).max(30) }),
  summarize: async ({ subscriptionId, days }, ctx) => {
    const s = await ownSubscriptionOrThrow(ctx, subscriptionId)
    return { title: '修改续费提醒', fields: [{ label: '商户', value: s.merchant }, { label: '提前提醒', value: `${days} 天` }] }
  },
  execute: async ({ subscriptionId, days }, ctx) => {
    const s = await ownSubscriptionOrThrow(ctx, subscriptionId)
    if (s.status !== 'active') throw new Error('该代扣已取消')
    await db.update(schema.subscriptions).set({ remindDays: days }).where(eq(schema.subscriptions.id, s.id))
    return { subscriptionId: s.id, remindDays: days }
  },
})

export const runDueJobsTool = defineBankTool({
  name: 'run_due_jobs',
  description: '在当前模拟时间执行所有已到期任务，不推进时钟。仅用于演示与测试。',
  baseRisk: 'yellow',
  kind: 'write',
  inputSchema: z.object({}),
  summarize: async () => ({ title: '执行到期任务', fields: [{ label: '范围', value: '当前模拟时间已到期的定时转账' }] }),
  execute: async (_args, ctx) => {
    const jobs = await runDueJobs(ctx.userId, await simNow())
    return { executed: jobs.length, jobs }
  },
})

// ── 预览（签发令牌，只读）─────────────────────────────────────────────────────

const scheduledTransferInput = z.object({
  fromAccountId: z.string(),
  payeeId: z.string(),
  amountCents: z.number().int().positive(),
  executeAt: z.string().describe('执行时间，ISO 8601 含时区，必须晚于当前模拟业务时间'),
  memo: z.string().max(50).optional(),
})

export const previewScheduledTransfer = defineBankTool({
  name: 'preview_scheduled_transfer',
  description:
    '定时转账预览：校验执行时间晚于当前模拟业务时间与余额，签发确认令牌供 commit_scheduled_transfer 使用。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: scheduledTransferInput,
  execute: async ({ fromAccountId, payeeId, amountCents, executeAt, memo }, ctx) => {
    const [acc, payee] = await Promise.all([ownAccountOrThrow(ctx, fromAccountId), ownPayeeOrThrow(ctx, payeeId)])
    const { iso } = await futureTimeOrThrow(executeAt)
    if (acc.balanceCents < amountCents) throw new Error('INSUFFICIENT_FUNDS: 余额不足')
    const summary = {
      title: '确认定时转账',
      fields: [
        { label: '金额', value: fmt(amountCents) },
        { label: '收款人', value: payee.alias ? `${payee.name}（${payee.alias}）` : payee.name },
        { label: '执行时间', value: iso },
        { label: '付款账户', value: acc.name },
        ...(memo ? [{ label: '附言', value: memo }] : []),
      ],
    }
    // executeAt 归一化为 ISO，避免同一时刻不同写法导致指纹不一致
    const params = { fromAccountId, payeeId, amountCents, executeAt: iso, memo: memo ?? '' }
    return { ...(await issueToken(ctx, 'scheduled_transfer', params, summary)), executeAt: iso }
  },
})

export const previewSplit = defineBankTool({
  name: 'preview_split',
  description:
    '发起 AA 收款前的预览：列出每位参与人（含发起人自己）分摊金额，余数按分依次分配，签发确认令牌。参与人用 list_contacts 返回的 contactId。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({
    title: z.string().min(1).max(100),
    totalCents: z.number().int().positive(),
    contactIds: z.array(z.string()).min(1).max(20),
  }),
  execute: async ({ title, totalCents, contactIds }, ctx) => {
    if (new Set(contactIds).size !== contactIds.length) throw new Error('参与人不能重复')
    const contacts = await Promise.all(contactIds.map((id) => ownContactOrThrow(ctx, id)))
    const { selfAmountCents, shares } = splitShares(totalCents, contactIds)
    const summary = {
      title: '确认发起 AA 收款',
      fields: [
        { label: '事由', value: title },
        { label: '总金额', value: fmt(totalCents) },
        { label: '我的份额', value: fmt(selfAmountCents) },
        ...shares.map((s, i) => ({ label: contacts[i].name, value: fmt(s.amountCents) })),
      ],
    }
    // 参与人顺序决定余数分配，因此保留原顺序参与指纹
    return {
      ...(await issueToken(ctx, 'split', { title, totalCents, contactIds }, summary)),
      selfAmount: yuan(selfAmountCents),
      shares: shares.map((s, i) => ({ contactId: s.contactId, name: contacts[i].name, amount: yuan(s.amountCents) })),
    }
  },
})

export const previewPlanCancel = defineBankTool({
  name: 'preview_plan_cancel',
  description: '取消生日计划前的预览：说明将取消的计划与待执行任务数，签发确认令牌。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({ planId: z.string() }),
  execute: async ({ planId }, ctx) => {
    const plan = await ownPlanOrThrow(ctx, planId)
    const contact = await ownContactOrThrow(ctx, plan.contactId).catch(() => null)
    const pending = await pendingPlanTasks(ctx, planId)
    const summary = {
      title: '确认取消生日计划',
      fields: [
        { label: '对象', value: contact?.name ?? plan.contactId },
        { label: '生日', value: plan.birthday },
        { label: '预算', value: fmt(plan.budgetCents) },
        { label: '取消未执行任务', value: `${pending.length} 个` },
      ],
    }
    return issueToken(ctx, 'plan_cancel', { planId }, summary)
  },
})

async function ownPlanOrThrow(ctx: AgentContext, planId: string) {
  const [plan] = await db
    .select()
    .from(schema.birthdayPlans)
    .where(and(eq(schema.birthdayPlans.id, planId), eq(schema.birthdayPlans.userId, ctx.userId)))
  if (!plan) throw new Error('计划不存在')
  if (!['planned', 'reserved'].includes(plan.status)) throw new Error('INVALID_STATE: 计划已执行或已取消')
  return plan
}

async function pendingPlanTasks(ctx: AgentContext, planId: string) {
  const tasks = await db
    .select()
    .from(schema.scheduledTasks)
    .where(and(eq(schema.scheduledTasks.userId, ctx.userId), eq(schema.scheduledTasks.status, 'pending')))
  return tasks.filter((t) => (JSON.parse(t.payloadJson) as { planId?: string }).planId === planId)
}

// ── 提交（消费令牌）──────────────────────────────────────────────────────────

export const commitScheduledTransfer = defineBankTool({
  name: 'commit_scheduled_transfer',
  description:
    '创建定时转账。必须携带 preview_scheduled_transfer 的令牌，收款人、金额、执行时间、附言须与预览一致。到期后由仿真时钟执行。',
  baseRisk: 'yellow',
  kind: 'write',
  inputSchema: scheduledTransferInput.extend({ confirmationToken: z.string() }),
  factsHint: (a) => ({ payeeId: a.payeeId }),
  summarize: async ({ payeeId, amountCents, executeAt }, ctx) => {
    const payee = await ownPayeeOrThrow(ctx, payeeId)
    return {
      title: '确认定时转账',
      fields: [
        { label: '金额', value: fmt(amountCents) },
        { label: '收款人', value: payee.name },
        { label: '执行时间', value: executeAt },
      ],
    }
  },
  execute: async ({ confirmationToken, fromAccountId, payeeId, amountCents, executeAt, memo }, ctx) => {
    const { iso, now } = await futureTimeOrThrow(executeAt)
    await consumeToken(ctx, confirmationToken, 'scheduled_transfer', {
      fromAccountId,
      payeeId,
      amountCents,
      executeAt: iso,
      memo: memo ?? '',
    })
    await Promise.all([ownAccountOrThrow(ctx, fromAccountId), ownPayeeOrThrow(ctx, payeeId)])
    const taskId = `task_${randomUUID()}`
    await db.insert(schema.scheduledTasks).values({
      id: taskId,
      userId: ctx.userId,
      kind: 'transfer',
      status: 'pending',
      dueAt: iso,
      payloadJson: JSON.stringify({ payeeId, fromAccountId, amountCents, memo: memo ?? '' }),
      resultJson: null,
      createdAt: now.toISOString(),
    })
    if (ctx.authorization) {
      await ensureAutomationSchema()
      await db.insert(schema.bankTaskPermissions).values({ taskId, level: ctx.authorization.level, payeeRiskJson: ctx.authorization.payeeRisk ? JSON.stringify(ctx.authorization.payeeRisk) : null })
    }
    return { taskId, status: 'pending', dueAt: iso, amount: yuan(amountCents) }
  },
  compensate: async (_args, out, ctx) => {
    await (await import('#/server/automation/service')).cancelScheduled(ctx.userId, (out as { taskId: string }).taskId)
  },
})

export const commitSplit = defineBankTool({
  name: 'commit_split',
  description: '创建 AA 收款。必须携带 preview_split 的令牌，事由、总金额与参与人（含顺序）须与预览一致。',
  baseRisk: 'yellow',
  kind: 'write',
  inputSchema: z.object({
    confirmationToken: z.string(),
    title: z.string().min(1).max(100),
    totalCents: z.number().int().positive(),
    contactIds: z.array(z.string()).min(1).max(20),
  }),
  summarize: async ({ title, totalCents, contactIds }) => ({
    title: '确认发起 AA 收款',
    fields: [
      { label: '事由', value: title },
      { label: '总金额', value: fmt(totalCents) },
      { label: '参与人数', value: `${contactIds.length + 1} 人（含自己）` },
    ],
  }),
  execute: async ({ confirmationToken, title, totalCents, contactIds }, ctx) => {
    await consumeToken(ctx, confirmationToken, 'split', { title, totalCents, contactIds })
    await Promise.all(contactIds.map((id) => ownContactOrThrow(ctx, id)))
    const { selfAmountCents, shares } = splitShares(totalCents, contactIds)
    const id = `split_${randomUUID()}`
    await db.insert(schema.splits).values({
      id,
      userId: ctx.userId,
      title,
      totalCents,
      sharesJson: JSON.stringify(shares.map((s) => ({ ...s, status: 'pending' }))),
      createdAt: (await simNow()).toISOString(),
    })
    const delivery = await createSplitRequests(ctx.userId, id)
    return { splitId: id, total: yuan(totalCents), selfAmount: yuan(selfAmountCents), participants: shares.length + 1, ...delivery }
  },
})

export const commitPlanCancel = defineBankTool({
  name: 'commit_plan_cancel',
  description: '取消生日计划，并取消该计划下所有未执行任务。必须携带 preview_plan_cancel 的令牌。',
  baseRisk: 'yellow',
  kind: 'write',
  inputSchema: z.object({ confirmationToken: z.string(), planId: z.string() }),
  summarize: async ({ planId }) => ({ title: '确认取消生日计划', fields: [{ label: '计划', value: planId }] }),
  execute: async ({ confirmationToken, planId }, ctx) => {
    await consumeToken(ctx, confirmationToken, 'plan_cancel', { planId })
    await ownPlanOrThrow(ctx, planId)
    const pending = await pendingPlanTasks(ctx, planId)
    return { ...await cancelBirthday(ctx.userId, planId), cancelledTasks: pending.length }
  },
})

export const PLANNING_TOOLS = [
  listContacts,
  resolveHolding,
  checkBudget,
  checkScheduleWindow,
  getSubscriptionTerms,
  assessRiskProfile,
  getRiskQuestionnaire,
  commitRiskAssessment,
  setSubscriptionReminder,
  previewScheduledTransfer,
  commitScheduledTransfer,
  previewSplit,
  commitSplit,
  previewPlanCancel,
  commitPlanCancel,
]

/** 仿真控制：不是用户会说出的银行动作，不暴露给模型，供评测脚本与后台使用 */
export const SYSTEM_TOOLS = [advanceSimulationClock, runDueJobsTool]
