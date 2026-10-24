import { settleTransfer, reverseTransfer, transferSummary } from '#/server/payments/service'
import { PAYMENT_TOOLS } from './payments'
import { CARD_TOOLS } from './cards'
import { SUBSCRIPTION_TOOLS } from './subscriptions'
import { SPLIT_TOOLS } from './splits'
import { BIRTHDAY_TOOLS } from './birthdays'
import { SECURITY_TOOLS } from './security'
import { MANDATE_TOOLS } from './mandates'
import { listTransactions } from './transaction-query'
import { businessDate } from '#/lib/dashboard'
import { simNow } from './jobs'
import { LIFE_TOOLS } from './life'
import { cancelLifeSubscription, lifeSubscriptionChangeSummary, listLifeSubscriptions } from '#/server/life/service'
export { listTransactions } from './transaction-query'
import { ownProfile, userCards } from '#/server/cards/service'
import { paymentAccounts } from '#/server/payments/service'
import { and, eq, gte, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '#/server/db/client'
import { runInSandbox } from '#/server/sandbox/quickjs'
import type { AgentContext } from '#/server/agent/context'
import { defineBankTool } from './define'
import type { BankToolDef } from './define'

const yuan = (cents: number) => Math.round(cents) / 100
const fmt = (cents: number) => `¥${yuan(cents).toFixed(2)}`
const DAY = 24 * 60 * 60 * 1000

async function ownCard(ctx: AgentContext, cardId: string) {
  return ownProfile(ctx.userId, cardId)
}

const maskAccount = (no: string) => `${no.slice(0, 4)} **** ${no.slice(-4)}`

// ───────────────────────────── 🟢 只读 ─────────────────────────────

export const getAccounts = defineBankTool({
  name: 'get_accounts',
  description: '查询用户的全部账户及余额',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({}),
  execute: async (_args, ctx) => {
    const rows = await paymentAccounts(ctx.userId)
    return rows.map((a) => ({ id: a.id, name: a.cardLast4 ? `储蓄卡 · 尾号${a.cardLast4}` : a.name, remark: a.remark, cardId: a.cardId, last4: a.cardLast4, balance: yuan(a.balanceCents), currency: a.currency }))
  },
})

export const findPayee = defineBankTool({
  name: 'find_payee',
  description: '按姓名、备注名（如"妈妈"）、手机号或卡号后四位查找收款人。多个候选时必须让用户选择，不得自行决定。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({ query: z.string().min(1) }),
  execute: async ({ query }, ctx) => {
    const rows = await db.select().from(schema.payees).where(eq(schema.payees.userId, ctx.userId))
    const scored = rows
      .map((p) => ({ p, score: payeeScore(query, p) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
    return {
      candidates: scored.map(({ p, score }) => ({
        id: p.id,
        name: p.name,
        alias: p.alias,
        bank: p.bank,
        account: maskAccount(p.accountNo),
        exact: score >= 100,
      })),
      needsDisambiguation: scored.length > 1 && scored[0].score < 100,
    }
  },
})

/** 简易模糊匹配；TODO: 接入拼音（pinyin-pro）以处理同音字 */
function payeeScore(q: string, p: typeof schema.payees.$inferSelect): number {
  const query = q.trim()
  if (query === p.name || query === p.alias || query === p.phone || p.accountNo.endsWith(query)) return 100
  if (p.name.includes(query) || p.alias?.includes(query)) return 60
  if (editDistance(query, p.name) === 1) return 40
  return 0
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return dp[a.length][b.length]
}

export const listCards = defineBankTool({
  name: 'list_cards',
  description: '查询全部银行卡，包含储蓄卡/信用卡类型、备注、尾号、绑定账户、状态、余额或信用额度与待还金额。备注重名必须询问用户具体尾号。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({}),
  execute: async (_args, ctx) => {
    const rows = await userCards(ctx.userId)
    return rows.map((c) => ({ id: c.id, accountId: c.accountId, remark: c.remark, last4: c.last4, kind: c.kind, status: c.status, dailyLimit: yuan(c.dailyLimitCents), ...(c.kind === 'debit' ? { balance: yuan(c.balanceCents) } : { creditLimit: yuan(c.creditLimitCents), outstanding: yuan(c.outstandingCents), availableCredit: yuan(c.creditLimitCents - c.outstandingCents), billDay: c.billDay, dueDay: c.dueDay }) }))
  },
})

export const displayBankCards = defineBankTool({
  name: 'display_bank_cards', kind: 'read', baseRisk: 'green',
  description: '展示本人银行卡只读轮播，无选择/确认/取消/卡号眼睛按钮。用于查余额和状态。cardIds指定一张或多张真实卡ID，省略展示全部；limit限制数量。先用list_cards确定ID，重名不可默认第一张。',
  inputSchema: z.object({ cardIds: z.array(z.string().min(1)).min(1).max(20).optional(), limit: z.number().int().min(1).max(20).optional() }),
  execute: async (a, ctx) => {
    const rows = await listCards.execute({}, ctx)
    if (a.cardIds?.some(id => !rows.some(row => row.id === id))) throw new Error('指定银行卡不存在或不属于你')
    return rows.filter(row => !a.cardIds || a.cardIds.includes(row.id)).slice(0, a.limit ?? rows.length)
  },
})

export const listSubscriptions = defineBankTool({
  name: 'list_subscriptions',
  description: '识别用户的订阅与自动扣费',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({}),
  execute: async (_args, ctx) => {
    return listLifeSubscriptions(ctx.userId,await simNow())
  },
})

export const listProducts = defineBankTool({
  name: 'list_products',
  description: '查询可购买的理财产品（风险等级、预期年化、起购金额、期限）',
  baseRisk: 'green',
  kind: 'read',
  catalogFields: ['name'],
  inputSchema: z.object({}),
  execute: async () => {
    const rows = await db.select().from(schema.products)
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      riskRating: p.riskRating,
      expectedYieldPct: Math.round(p.expectedYield * 10000) / 100,
      minAmount: yuan(p.minAmountCents),
      termDays: p.termDays,
    }))
  },
})

export const analyzeSpending = defineBankTool({
  name: 'analyze_spending',
  description:
    '账单分析。可选提供一段 JavaScript 函数体（在隔离沙箱执行，只能读取只读变量 input.transactions，' +
    '元素形如 {amount, category, counterparty, date}，支出为负数），必须 return 可 JSON 序列化的结果。' +
    '不提供 code 时返回按类别汇总。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({
    days: z.number().int().min(1).max(365).default(30),
    code: z.string().max(4000).optional(),
  }),
  execute: async ({ days, code }, ctx) => {
    const now = await simNow()
    const accs = await db.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.userId, ctx.userId))
    const rows = await db
      .select()
      .from(schema.transactions)
      .where(
        and(
          inArray(schema.transactions.accountId, accs.map((a) => a.id)),
          gte(schema.transactions.occurredAt, new Date(now.getTime() - days * DAY)),
        ),
      )
    const transactions = rows.filter((t) => t.category !== '信用卡还款').map((t) => ({
      amount: yuan(t.amountCents),
      category: t.category,
      counterparty: t.counterparty,
      date: businessDate(t.occurredAt),
    }))
    const program =
      code ??
      `const by = {}; for (const t of input.transactions) if (t.amount < 0) by[t.category] = (by[t.category] || 0) - t.amount;
       const byCategory = Object.entries(by).map(([category, total]) => ({ category, total: Math.round(total * 100) / 100 })).sort((a, b) => b.total - a.total);
       return { totalSpent: Math.round(byCategory.reduce((s, x) => s + x.total, 0) * 100) / 100, byCategory };`
    const result = await runInSandbox(program, { transactions })
    if (!result.ok) throw new Error(`分析代码执行失败：${result.error}`)
    return { days, result: result.value, sandboxMs: result.durationMs }
  },
})

// ───────────────────────────── 🟡/🔴 写操作 ─────────────────────────────

export const transfer = defineBankTool({
  name: 'transfer',
  description: '向已登记收款人转账。payeeId 必须来自 find_payee 的结果。金额单位：元。',
  baseRisk: 'yellow',
  kind: 'write',
  inputSchema: z.object({
    fromAccountId: z.string(),
    payeeId: z.string(),
    amount: z.number().positive().max(1_000_000).multipleOf(0.01),
    memo: z.string().max(50).optional(),
  }),
  factsHint: (a) => ({ payeeId: a.payeeId }),
  summarize: (a, ctx) => transferSummary({ ...a, amountCents: Math.round(a.amount * 100) }, ctx),
  execute: (a, ctx) => settleTransfer({ ...a, amountCents: Math.round(a.amount * 100) }, ctx),
  compensate: (_a, out, ctx) => reverseTransfer(out.transactionId, ctx),
})

const setCardStatus = async (ctx: AgentContext, cardId: string, status: 'active' | 'locked' | 'lost') => {
  const card = await ownCard(ctx, cardId)
  if (card.status === 'lost' && status !== 'lost') throw new Error('已挂失卡片不可恢复，请重新办卡')
  await db.update(schema.cards).set({ status }).where(eq(schema.cards.id, cardId))
}

const cardSummary = (title: string, extra: { label: string; value: string }[] = []) =>
  async (a: { cardId: string }, ctx: AgentContext) => {
    const c = await ownCard(ctx, a.cardId)
    return { title, fields: [{ label: '卡片', value: `${c.remark ? `${c.remark} · ` : ''}${c.kind === 'credit' ? '信用卡' : '储蓄卡'} 尾号 ${c.last4}` }, ...extra] }
  }

export const lockCard = defineBankTool({
  name: 'lock_card',
  description: '临时锁卡（可随时解锁）',
  baseRisk: 'yellow',
  kind: 'write',
  inputSchema: z.object({ cardId: z.string() }),
  summarize: cardSummary('确认临时锁卡', [{ label: '影响', value: '锁定期间该卡所有交易将被拒绝' }]),
  execute: async (a, ctx) => {
    await setCardStatus(ctx, a.cardId, 'locked')
    return { cardId: a.cardId, status: 'locked' }
  },
  compensate: async (a, _o, ctx) => setCardStatus(ctx, a.cardId, 'active'),
})

export const unlockCard = defineBankTool({
  name: 'unlock_card',
  description: '解除临时锁卡',
  baseRisk: 'red',
  kind: 'write',
  inputSchema: z.object({ cardId: z.string() }),
  summarize: cardSummary('确认解锁卡片'),
  execute: async (a, ctx) => {
    await setCardStatus(ctx, a.cardId, 'active')
    return { cardId: a.cardId, status: 'active' }
  },
})

export const reportCardLost = defineBankTool({
  name: 'report_card_lost',
  description: '挂失卡片（不可撤销，需重新办卡）',
  baseRisk: 'red',
  kind: 'write',
  inputSchema: z.object({ cardId: z.string() }),
  summarize: cardSummary('确认挂失', [{ label: '注意', value: '挂失后不可撤销，需要重新办卡' }]),
  execute: async (a, ctx) => {
    await setCardStatus(ctx, a.cardId, 'lost')
    return { cardId: a.cardId, status: 'lost' }
  },
})

export const adjustCardLimit = defineBankTool({
  name: 'adjust_card_limit',
  description: '调整卡片每日交易限额（元）',
  baseRisk: 'red',
  kind: 'write',
  inputSchema: z.object({ cardId: z.string(), dailyLimit: z.number().positive().max(500_000) }),
  summarize: async (a, ctx) => {
    const c = await ownCard(ctx, a.cardId)
    return {
      title: '确认调整限额',
      fields: [
        { label: '卡片', value: `尾号 ${c.last4}` },
        { label: '当前限额', value: fmt(c.dailyLimitCents) },
        { label: '调整为', value: fmt(a.dailyLimit * 100) },
      ],
    }
  },
  execute: async (a, ctx) => {
    const before = await ownCard(ctx, a.cardId)
    await db.update(schema.cards).set({ dailyLimitCents: Math.round(a.dailyLimit * 100) }).where(eq(schema.cards.id, a.cardId))
    return { cardId: a.cardId, dailyLimit: a.dailyLimit, previous: yuan(before.dailyLimitCents) }
  },
  compensate: async (a, out, ctx) => {
    await ownCard(ctx, a.cardId)
    await db.update(schema.cards).set({ dailyLimitCents: Math.round(out.previous * 100) }).where(eq(schema.cards.id, a.cardId))
  },
})

export const cancelSubscription = defineBankTool({
  name: 'cancel_subscription',
  description: '取消一项订阅/自动扣费',
  baseRisk: 'yellow',
  kind: 'write',
  inputSchema: z.object({ subscriptionId: z.string() }),
  summarize: async (a, ctx) => lifeSubscriptionChangeSummary(ctx.userId,a.subscriptionId,'cancel'),
  execute: async (a, ctx) => {
    return cancelLifeSubscription(ctx,a.subscriptionId)
  },
})

import { EXTENDED_TOOLS } from './bank-extended'
import { PLANNING_TOOLS } from './bank-planning'
import { FUND_TOOLS } from './funds'

export const BANK_TOOLS: BankToolDef[] = [
  getAccounts,
  listTransactions,
  findPayee,
  listCards,
  displayBankCards,
  listSubscriptions,
  listProducts,
  analyzeSpending,
  transfer,
  lockCard,
  unlockCard,
  reportCardLost,
  adjustCardLimit,
  cancelSubscription,
  // --- ai-banking-agent 扩展工具 ---
  ...EXTENDED_TOOLS,
  ...PLANNING_TOOLS,
  ...PAYMENT_TOOLS,
  ...CARD_TOOLS,
  ...SUBSCRIPTION_TOOLS,
  ...SPLIT_TOOLS,
  ...BIRTHDAY_TOOLS,
  ...SECURITY_TOOLS,
  ...MANDATE_TOOLS,
  ...LIFE_TOOLS,
  ...FUND_TOOLS,
]

const byName = new Map<string, BankToolDef>(BANK_TOOLS.map((t) => [t.name, t]))
export const resolveTool = (name: string) => byName.get(name)
