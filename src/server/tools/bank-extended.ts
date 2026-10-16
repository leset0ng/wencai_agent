/**
 * 扩展工具层：在 wencai 的 defineBankTool 接口上实现银行查询、解析与两段式业务提交。
 * 工具按功能分组：只读查询 → 实体解析 → 前置校验 → 预览（签发令牌）→ 提交（消费令牌）→ 系统控制
 *
 * 与原 bank.ts 的关系：
 * - 共用同一套 schema、db、AgentContext
 * - 原 bank.ts 的 13 个工具保留，此文件注册 22 个扩展工具
 * - bank.ts 的 BANK_TOOLS 合并基础、扩展与规划工具；仿真控制另行导出
 */
import { createHash, randomUUID } from 'node:crypto'
import { settleTransfer, reverseTransfer, transferSummary } from '#/server/payments/service'
import { and, desc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '#/server/db/client'
import { businessMonth } from '#/lib/dashboard'
import { defineBankTool } from './define'
import type { AgentContext } from '#/server/agent/context'
import { runDueJobs, simNow } from './jobs'
import { assertDebitAccount } from '#/server/cards/service'
import { rollbackInvestment } from '#/server/payments/investment-rollback'
import { cancelLifeSubscription, lifeSubscriptionChangeSummary } from '#/server/life/service'

// ── helpers ──────────────────────────────────────────────────────────────────

export const yuan = (cents: number) => Math.round(cents) / 100
export const fmt = (cents: number) =>
  new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(cents / 100)
export const DAY = 24 * 60 * 60 * 1000

const RISK_ORDER: Record<string, number> = { R1: 1, R2: 2, R3: 3, R4: 4, R5: 5 }

/** 风险适当性：测评须在一年内，且产品等级不高于用户等级 */
export async function riskGate(ctx: AgentContext, productRating: string) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, ctx.userId))
  const now = await simNow()
  const assessedAt = user?.riskAssessedAt ? new Date(user.riskAssessedAt) : null
  const fresh = !!assessedAt && now.getTime() - assessedAt.getTime() <= 365 * DAY
  const userRiskRating = user?.riskRating ?? 'R1'
  const reasons: string[] = []
  if (!fresh) reasons.push(assessedAt ? '风险测评已超过一年，需要重新测评' : '尚未完成风险测评')
  else if (RISK_ORDER[productRating] > RISK_ORDER[userRiskRating])
    reasons.push(`产品风险 ${productRating} 超过您的风险等级 ${userRiskRating}`)
  return { fresh, userRiskRating, reasons }
}

export async function ownAccountOrThrow(ctx: AgentContext, accountId: string) {
  const [acc] = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, ctx.userId)))
  if (!acc) throw new Error('账户不存在或不属于当前用户')
  return acc
}

export async function ownPayeeOrThrow(ctx: AgentContext, payeeId: string) {
  const [p] = await db
    .select()
    .from(schema.payees)
    .where(and(eq(schema.payees.id, payeeId), eq(schema.payees.userId, ctx.userId)))
  if (!p) throw new Error('收款人不存在')
  return p
}

async function ownCardOrThrow(ctx: AgentContext, cardId: string) {
  const [c] = await db
    .select()
    .from(schema.cards)
    .where(and(eq(schema.cards.id, cardId), eq(schema.cards.userId, ctx.userId)))
  if (!c) throw new Error('卡片不存在')
  return c
}

function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']'
  const keys = Object.keys(obj as object).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((obj as Record<string, unknown>)[k])).join(',') + '}'
}

function paramHash(params: Record<string, unknown>) {
  return createHash('sha256').update(stableStringify(params)).digest('hex').slice(0, 16)
}

/** 签发两段式确认令牌（preview 侧调用） */
export async function issueToken(
  ctx: AgentContext,
  operation: string,
  params: Record<string, unknown>,
  summaryData: object,
  ttlMs = 15 * 60 * 1000,
) {
  const id = `tok_${randomUUID()}`
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttlMs)
  await db.insert(schema.confirmationTokens).values({
    id,
    userId: ctx.userId,
    operation,
    paramHash: paramHash(params),
    summaryJson: JSON.stringify(summaryData),
    tier: 'T2',
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
  })
  return { confirmationToken: id, expiresAt: expiresAt.toISOString(), summary: summaryData }
}

/** 校验并消费确认令牌（commit 侧调用），失败时 throw */
export async function consumeToken(
  ctx: AgentContext,
  token: string,
  operation: string,
  params: Record<string, unknown>,
) {
  const [row] = await db
    .select()
    .from(schema.confirmationTokens)
    .where(eq(schema.confirmationTokens.id, token))
  if (!row) throw new Error('TOKEN_INVALID: 确认令牌不存在')
  if (row.userId !== ctx.userId) throw new Error('TOKEN_OWNER_MISMATCH: 令牌不属于当前用户')
  if (row.operation !== operation) throw new Error('TOKEN_SCOPE_MISMATCH: 令牌操作类型不匹配')
  if (row.consumedAt) throw new Error('TOKEN_CONSUMED: 令牌已被使用，不能重放')
  if (new Date(row.expiresAt) < new Date()) throw new Error('TOKEN_EXPIRED: 令牌已过期，请重新预览')
  const incoming = paramHash(params)
  if (row.paramHash !== incoming) throw new Error('TOKEN_PARAM_MISMATCH: 参数与预览时不一致，疑似篡改')
  const claimed = await db.update(schema.confirmationTokens)
    .set({ consumedAt: new Date().toISOString() })
    .where(and(eq(schema.confirmationTokens.id, token), isNull(schema.confirmationTokens.consumedAt)))
    .returning({ id: schema.confirmationTokens.id })
  if (!claimed.length) throw new Error('TOKEN_CONSUMED: 令牌已被使用，不能重放')
}

// ── A. 只读查询 ───────────────────────────────────────────────────────────────

export const getSpendingReport = defineBankTool({
  name: 'get_spending_report',
  description: '按分类汇总指定账期的消费支出，可选月度或年度。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({
    period: z.string().regex(/^\d{4}(-\d{2})?$/).describe('YYYY 或 YYYY-MM'),
  }),
  execute: async ({ period }, ctx) => {
    const accs = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.userId, ctx.userId))
    const rows = await db
      .select()
      .from(schema.transactions)
      .where(inArray(schema.transactions.accountId, accs.map((a) => a.id)))
    const prefix = period
    const filtered = rows.filter((t) => {
      return businessMonth(t.occurredAt).startsWith(prefix) && t.category !== '信用卡还款'
    })
    const income = filtered.filter((t) => t.amountCents > 0).reduce((s, t) => s + t.amountCents, 0)
    const expense = filtered.filter((t) => t.amountCents < 0).reduce((s, t) => s + (-t.amountCents), 0)
    const byCategory: Record<string, number> = {}
    for (const t of filtered) {
      if (t.amountCents < 0) byCategory[t.category] = (byCategory[t.category] ?? 0) + (-t.amountCents)
    }
    return {
      period,
      income: yuan(income),
      expense: yuan(expense),
      consumptionExpense: yuan(expense - (byCategory['转账'] ?? 0) - (byCategory['理财'] ?? 0)),
      net: yuan(income - expense),
      transactionCount: filtered.length,
      categories: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, yuan(v)])),
      byCategory: Object.entries(byCategory)
        .sort((a, b) => b[1] - a[1])
        .map(([category, cents]) => ({ category, total: yuan(cents) })),
    }
  },
})

export const getAnomalies = defineBankTool({
  name: 'get_anomalies',
  description: '检测账户中的异常交易：大额支出（前3个月均值2倍以上）或短时间重复扣款。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({}),
  execute: async (_args, ctx) => {
    const accs = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.userId, ctx.userId))
    const now = await simNow()
    const since90 = new Date(now.getTime() - 90 * DAY)
    const rows = await db
      .select()
      .from(schema.transactions)
      .where(
        and(
          inArray(schema.transactions.accountId, accs.map((a) => a.id)),
          gte(schema.transactions.occurredAt, since90),
        ),
      )
      .orderBy(desc(schema.transactions.occurredAt))
    const spending = rows.filter((t) => t.amountCents < 0)
    const avg = spending.length
      ? spending.reduce((s, t) => s + (-t.amountCents), 0) / spending.length
      : 0
    const anomalies: typeof rows = []
    for (const t of spending) {
      if (-t.amountCents > avg * 2 && -t.amountCents > 50_000) anomalies.push(t)
    }
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i],
        b = rows[i + 1]
      const ta =
        a.occurredAt instanceof Date ? a.occurredAt.getTime() : new Date(a.occurredAt).getTime()
      const tb =
        b.occurredAt instanceof Date ? b.occurredAt.getTime() : new Date(b.occurredAt).getTime()
      if (
        a.amountCents === b.amountCents &&
        a.amountCents < 0 &&
        Math.abs(ta - tb) < 10 * 60 * 1000
      ) {
        if (!anomalies.find((x) => x.id === a.id)) anomalies.push(a)
        if (!anomalies.find((x) => x.id === b.id)) anomalies.push(b)
      }
    }
    return anomalies.map((t) => ({
      id: t.id,
      amount: yuan(-t.amountCents),
      counterparty: t.counterparty,
      category: t.category,
      date: (
        t.occurredAt instanceof Date ? t.occurredAt : new Date(t.occurredAt as string)
      )
        .toISOString()
        .slice(0, 10),
    }))
  },
})

export const getPortfolio = defineBankTool({
  name: 'get_portfolio',
  description: '查询用户的理财持仓，包括各产品的本金、可赎回时间和风险等级。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({}),
  execute: async (_args, ctx) => {
    const rows = await db
      .select()
      .from(schema.holdings)
      .where(eq(schema.holdings.userId, ctx.userId))
    const now = await simNow()
    return rows.map((h) => ({
      id: h.id,
      productId: h.productId,
      principalCents: h.principalCents,
      principal: yuan(h.principalCents),
      redeemableAt: h.redeemableAt,
      locked: h.redeemableAt > now.toISOString(),
    }))
  },
})

export const getRecommendations = defineBankTool({
  name: 'get_recommendations',
  description: '根据用户风险等级返回合适的理财产品推荐，并标注是否符合风险匹配。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({}),
  execute: async (_args, ctx) => {
    const products = await db.select().from(schema.products)
    const { fresh, userRiskRating } = await riskGate(ctx, 'R1')
    return {
      userRiskRating,
      riskAssessed: fresh,
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        riskRating: p.riskRating,
        expectedYieldPct: Math.round(p.expectedYield * 10000) / 100,
        minAmount: yuan(p.minAmountCents),
        termDays: p.termDays,
        eligible: fresh && RISK_ORDER[p.riskRating] <= RISK_ORDER[userRiskRating],
      })),
    }
  },
})

// ── B. 实体解析 / 消歧 ────────────────────────────────────────────────────────

export const resolveRecipient = defineBankTool({
  name: 'resolve_recipient',
  description:
    '按姓名、别名（如"妈妈"）、手机号或卡尾号查找收款人。多个候选必须让用户选择，不得自行决定。返回 candidates 为空表示未找到。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({ query: z.string().min(1) }),
  execute: async ({ query }, ctx) => {
    const rows = await db.select().from(schema.payees).where(eq(schema.payees.userId, ctx.userId))
    const q = query.trim()
    const scored = rows
      .map((p) => {
        let score = 0
        if (q === p.name || q === p.alias || q === p.phone || p.accountNo.endsWith(q)) score = 100
        else if (p.name.includes(q) || p.alias?.includes(q)) score = 60
        else if (editDistance(q, p.name) === 1) score = 40
        return { p, score }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
    if (scored.length === 0) return { found: false, candidates: [] }
    if (scored.length === 1 || scored[0].score === 100) {
      const p = scored[0].p
      return { found: true, payeeId: p.id, name: p.name, alias: p.alias, bank: p.bank }
    }
    return {
      found: false,
      needsDisambiguation: true,
      candidates: scored.map(({ p }) => ({
        payeeId: p.id, name: p.name, alias: p.alias, bank: p.bank,
        account: `${p.bank} ${maskAccount(p.accountNo)}`,
      })),
    }
  },
})

export const resolveCard = defineBankTool({
  name: 'resolve_card',
  description: '按卡尾号或类型（debit/credit）查找用户的银行卡。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({ query: z.string().min(1) }),
  execute: async ({ query }, ctx) => {
    const rows = await db.select().from(schema.cards).where(eq(schema.cards.userId, ctx.userId))
    const q = query.trim().toLowerCase()
    const matched = rows.filter(
      (c) => c.last4 === q || c.kind === q || c.kind.includes(q) || q.includes(c.last4),
    )
    if (matched.length === 1) {
      const c = matched[0]
      return { found: true, cardId: c.id, last4: c.last4, kind: c.kind, status: c.status }
    }
    if (matched.length > 1) {
      return {
        found: false,
        needsDisambiguation: true,
        candidates: matched.map((c) => ({
          cardId: c.id, last4: c.last4, kind: c.kind, status: c.status,
        })),
      }
    }
    return { found: false, candidates: [] }
  },
})

export const resolveSubscription = defineBankTool({
  name: 'resolve_subscription',
  description: '按商户名关键词查找用户的订阅，多个候选时返回列表让用户选择。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({ query: z.string().min(1) }),
  execute: async ({ query }, ctx) => {
    const rows = await db
      .select()
      .from(schema.subscriptions)
      .where(and(eq(schema.subscriptions.userId, ctx.userId), eq(schema.subscriptions.status, 'active')))
    const q = query.trim()
    const matched = rows.filter((s) => s.merchant.includes(q))
    if (matched.length === 1) {
      const s = matched[0]
      return { found: true, subscriptionId: s.id, merchant: s.merchant, amountCents: s.amountCents }
    }
    return {
      found: matched.length > 0,
      needsDisambiguation: matched.length > 1,
      candidates: matched.map((s) => ({
        subscriptionId: s.id, merchant: s.merchant, amountCents: s.amountCents, cycle: s.cycle,
      })),
    }
  },
})

export const resolveProduct = defineBankTool({
  name: 'resolve_product',
  description: '按名称关键词或风险等级查找理财产品。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({ query: z.string().min(1) }),
  execute: async ({ query }) => {
    const rows = await db.select().from(schema.products)
    const q = query.trim().toLowerCase()
    const matched = rows.filter(
      (p) => p.name.toLowerCase().includes(q) || p.riskRating.toLowerCase() === q,
    )
    if (matched.length === 1) {
      const p = matched[0]
      return { found: true, productId: p.id, name: p.name, riskRating: p.riskRating }
    }
    return {
      found: matched.length > 0,
      needsDisambiguation: matched.length > 1,
      candidates: matched.map((p) => ({
        productId: p.id, name: p.name, riskRating: p.riskRating,
        minAmountCents: p.minAmountCents, termDays: p.termDays,
      })),
    }
  },
})

// ── C. 前置校验 ───────────────────────────────────────────────────────────────

export const checkTransferLimit = defineBankTool({
  name: 'check_transfer_limit',
  description: '检查转账额度：单笔上限、今日剩余额度。返回 allowed=false 时附带原因。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({
    amountCents: z.number().int().positive(),
    payeeId: z.string().optional(),
  }),
  execute: async ({ amountCents, payeeId }, ctx) => {
    const SINGLE_LIMIT = 5_000_000 // ¥50,000 单笔（分）
    const DAILY_LIMIT = 20_000_000 // ¥200,000 日累计（分）
    const now = await simNow()
    const startOfDay = new Date(now)
    startOfDay.setHours(0, 0, 0, 0)
    const accs = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.userId, ctx.userId))
    const todayRows = await db
      .select()
      .from(schema.transactions)
      .where(
        and(
          inArray(schema.transactions.accountId, accs.map((a) => a.id)),
          eq(schema.transactions.category, '转账'),
          lt(schema.transactions.amountCents, 0),
          gte(schema.transactions.occurredAt, startOfDay),
        ),
      )
    const dailySpent = todayRows.reduce((s, t) => s + (-t.amountCents), 0)
    const dailyRemaining = Math.max(0, DAILY_LIMIT - dailySpent)
    const reasons: string[] = []
    if (amountCents > SINGLE_LIMIT) reasons.push(`超过单笔上限 ${fmt(SINGLE_LIMIT)}`)
    if (amountCents > dailyRemaining) reasons.push(`超过今日剩余额度 ${fmt(dailyRemaining)}`)
    let isNewPayee = false
    if (payeeId) {
      const [p] = await db
        .select()
        .from(schema.payees)
        .where(and(eq(schema.payees.id, payeeId), eq(schema.payees.userId, ctx.userId)))
      if (p) {
        const ageDays = (now.getTime() - p.createdAt.getTime()) / DAY
        isNewPayee = ageDays < 1
        if (isNewPayee) reasons.push('新添加的收款人，需要额外确认')
      }
    }
    return {
      allowed: reasons.length === 0,
      amountCents,
      amount: yuan(amountCents),
      dailySpent: yuan(dailySpent),
      dailyRemaining: yuan(dailyRemaining),
      singleLimit: yuan(SINGLE_LIMIT),
      dailyLimit: yuan(DAILY_LIMIT),
      isNewPayee,
      reasons,
    }
  },
})

export const checkProductEligibility = defineBankTool({
  name: 'check_product_eligibility',
  description: '检查用户是否符合购买指定理财产品的条件（余额、风险等级）。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({
    productId: z.string(),
    amountCents: z.number().int().positive(),
    fromAccountId: z.string(),
  }),
  execute: async ({ productId, amountCents, fromAccountId }, ctx) => {
    const [product] = await db.select().from(schema.products).where(eq(schema.products.id, productId))
    if (!product) throw new Error('产品不存在')
    const [acc] = await db
      .select()
      .from(schema.accounts)
      .where(and(eq(schema.accounts.id, fromAccountId), eq(schema.accounts.userId, ctx.userId)))
    if (!acc) throw new Error('账户不存在')
    const risk = await riskGate(ctx, product.riskRating)
    const reasons: string[] = [...risk.reasons]
    if (amountCents < product.minAmountCents)
      reasons.push(`低于最低申购金额 ${fmt(product.minAmountCents)}`)
    if (acc.balanceCents < amountCents) reasons.push('账户余额不足')
    return {
      allowed: reasons.length === 0,
      product: { id: product.id, name: product.name, riskRating: product.riskRating, minAmountCents: product.minAmountCents },
      userRiskRating: risk.userRiskRating,
      riskAssessed: risk.fresh,
      balance: yuan(acc.balanceCents),
      amountCents,
      amount: yuan(amountCents),
      reasons,
    }
  },
})

// ── D. 预览（签发令牌）────────────────────────────────────────────────────────

export const previewTransfer = defineBankTool({
  name: 'preview_transfer',
  description:
    '预览转账操作并签发确认令牌。必须先用 resolve_recipient 确认 payeeId，再调用此工具。令牌 15 分钟内有效。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({
    fromAccountId: z.string(),
    payeeId: z.string(),
    amountCents: z.number().int().positive(),
    memo: z.string().max(50).optional(),
  }),
  summarize: async ({ fromAccountId, payeeId, amountCents, memo }, ctx) => {
    const [acc, payee] = await Promise.all([
      ownAccountOrThrow(ctx, fromAccountId),
      ownPayeeOrThrow(ctx, payeeId),
    ])
    return {
      title: '确认转账',
      fields: [
        { label: '金额', value: fmt(amountCents) },
        { label: '收款人', value: `${payee.name}${payee.alias ? `（${payee.alias}）` : ''}` },
        { label: '收款账户', value: `${payee.bank} ${maskAccount(payee.accountNo)}` },
        { label: '付款账户', value: `${acc.name}（余额 ${fmt(acc.balanceCents)}）` },
        ...(memo ? [{ label: '附言', value: memo }] : []),
      ],
    }
  },
  execute: async ({ fromAccountId, payeeId, amountCents, memo }, ctx) => {
    const [acc, payee] = await Promise.all([
      ownAccountOrThrow(ctx, fromAccountId),
      ownPayeeOrThrow(ctx, payeeId),
    ])
    const summary = {
      title: '确认转账',
      fields: [
        { label: '金额', value: fmt(amountCents) },
        { label: '收款人', value: `${payee.name}${payee.alias ? `（${payee.alias}）` : ''}` },
        { label: '付款账户', value: `${acc.name}（余额 ${fmt(acc.balanceCents)}）` },
        ...(memo ? [{ label: '附言', value: memo }] : []),
      ],
    }
    return issueToken(ctx, 'transfer', { fromAccountId, payeeId, amountCents, memo: memo ?? '' }, summary)
  },
})

export const previewPurchase = defineBankTool({
  name: 'preview_purchase',
  description: '预览理财产品申购并签发确认令牌。须先完成 check_product_eligibility。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({
    fromAccountId: z.string(),
    productId: z.string(),
    amountCents: z.number().int().positive(),
  }),
  summarize: async ({ fromAccountId, productId, amountCents }, ctx) => {
    const [acc] = await db
      .select()
      .from(schema.accounts)
      .where(and(eq(schema.accounts.id, fromAccountId), eq(schema.accounts.userId, ctx.userId)))
    const [product] = await db.select().from(schema.products).where(eq(schema.products.id, productId))
    return {
      title: '确认申购',
      fields: [
        { label: '产品', value: product?.name ?? productId },
        { label: '金额', value: fmt(amountCents) },
        { label: '付款账户', value: `${acc?.name ?? fromAccountId}（余额 ${fmt(acc?.balanceCents ?? 0)}）` },
        { label: '锁定期', value: product?.termDays ? `${product.termDays} 天` : '随时可赎回' },
      ],
    }
  },
  execute: async ({ fromAccountId, productId, amountCents }, ctx) => {
    await ownAccountOrThrow(ctx, fromAccountId)
    const [product] = await db.select().from(schema.products).where(eq(schema.products.id, productId))
    if (!product) throw new Error('产品不存在')
    const summary = {
      title: '确认申购',
      fields: [
        { label: '产品', value: product.name },
        { label: '金额', value: fmt(amountCents) },
        { label: '锁定期', value: product.termDays ? `${product.termDays} 天` : '随时可赎回' },
      ],
    }
    return issueToken(ctx, 'purchase', { fromAccountId, productId, amountCents }, summary)
  },
})

export const previewRedemption = defineBankTool({
  name: 'preview_redemption',
  description: '预览理财持仓赎回并签发确认令牌。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({
    holdingId: z.string(),
    amountCents: z.number().int().positive(),
    toAccountId: z.string(),
  }),
  summarize: async ({ holdingId, amountCents }) => {
    const [h] = await db.select().from(schema.holdings).where(eq(schema.holdings.id, holdingId))
    return {
      title: '确认赎回',
      fields: [
        { label: '持仓', value: h?.productId ?? holdingId },
        { label: '赎回金额', value: fmt(amountCents) },
      ],
    }
  },
  execute: async ({ holdingId, amountCents, toAccountId }, ctx) => {
    const [h] = await db
      .select()
      .from(schema.holdings)
      .where(and(eq(schema.holdings.id, holdingId), eq(schema.holdings.userId, ctx.userId)))
    if (!h) throw new Error('持仓不存在')
    const now = await simNow()
    if (h.redeemableAt > now.toISOString()) throw new Error('持仓仍在锁定期内，不可赎回')
    if (amountCents > h.principalCents) throw new Error('赎回金额超过可用本金')
    const summary = {
      title: '确认赎回',
      fields: [
        { label: '持仓', value: h.productId },
        { label: '赎回金额', value: fmt(amountCents) },
        { label: '到账账户', value: toAccountId },
      ],
    }
    return issueToken(ctx, 'redemption', { holdingId, amountCents, toAccountId }, summary)
  },
})

export const previewCardChange = defineBankTool({
  name: 'preview_card_change',
  description: '预览卡片状态或限额变更并签发确认令牌。action: lock | unlock | lost | limits',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({
    cardId: z.string(),
    action: z.enum(['lock', 'unlock', 'lost', 'limits']),
    dailyLimitCents: z.number().int().positive().optional(),
  }),
  summarize: async ({ cardId, action, dailyLimitCents }, ctx) => {
    const c = await ownCardOrThrow(ctx, cardId)
    const actionLabel: Record<string, string> = {
      lock: '临时锁卡', unlock: '解除锁卡', lost: '挂失卡片', limits: '调整限额',
    }
    return {
      title: actionLabel[action],
      fields: [
        { label: '卡片', value: `${c.kind === 'credit' ? '信用卡' : '借记卡'} 尾号 ${c.last4}` },
        ...(action === 'limits' && dailyLimitCents
          ? [{ label: '新每日限额', value: fmt(dailyLimitCents) }]
          : []),
      ],
    }
  },
  execute: async ({ cardId, action, dailyLimitCents }, ctx) => {
    const c = await ownCardOrThrow(ctx, cardId)
    const summary = {
      title: { lock: '临时锁卡', unlock: '解除锁卡', lost: '挂失卡片', limits: '调整限额' }[action],
      fields: [{ label: '卡片', value: `尾号 ${c.last4}` }],
    }
    return issueToken(ctx, 'card_change', { cardId, action, dailyLimitCents: dailyLimitCents ?? null }, summary)
  },
})

export const previewSubscriptionChange = defineBankTool({
  name: 'preview_subscription_change',
  description: '预览取消订阅或修改提醒天数，签发确认令牌。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({
    subscriptionId: z.string(),
    action: z.enum(['cancel', 'set_reminder']),
    remindDays: z.number().int().min(1).max(30).optional(),
  }),
  summarize: async ({ subscriptionId, action, remindDays }, ctx) => lifeSubscriptionChangeSummary(ctx.userId,subscriptionId,action,remindDays),
  execute: async ({ subscriptionId, action, remindDays }, ctx) => {
    const [s] = await db
      .select()
      .from(schema.subscriptions)
      .where(and(eq(schema.subscriptions.id, subscriptionId), eq(schema.subscriptions.userId, ctx.userId)))
    if (!s) throw new Error('订阅不存在')
    const summary = await lifeSubscriptionChangeSummary(ctx.userId,subscriptionId,action,remindDays)
    return issueToken(ctx, 'subscription_change', { subscriptionId, action, remindDays: remindDays ?? null }, summary)
  },
})

// ── E. 提交（消费令牌）────────────────────────────────────────────────────────

export const commitTransfer = defineBankTool({
  name: 'commit_transfer',
  description: '执行转账。必须提供 preview_transfer 签发的确认令牌。',
  baseRisk: 'yellow',
  kind: 'write',
  inputSchema: z.object({
    confirmationToken: z.string(),
    fromAccountId: z.string(),
    payeeId: z.string(),
    amountCents: z.number().int().positive(),
    memo: z.string().optional(),
  }),
  factsHint: (a) => ({ payeeId: a.payeeId }),
  summarize: transferSummary,
  execute: async ({ confirmationToken, ...a }, ctx) => {
    await consumeToken(ctx, confirmationToken, 'transfer', { fromAccountId: a.fromAccountId, payeeId: a.payeeId, amountCents: a.amountCents, memo: a.memo ?? '' })
    return settleTransfer(a, ctx)
  },
  compensate: (_a, out, ctx) => reverseTransfer(out.transactionId, ctx),
})

export const commitPurchase = defineBankTool({
  name: 'commit_purchase',
  description: '执行理财申购。必须提供 preview_purchase 签发的确认令牌。',
  baseRisk: 'red',
  kind: 'write',
  inputSchema: z.object({
    confirmationToken: z.string(),
    fromAccountId: z.string(),
    productId: z.string(),
    amountCents: z.number().int().positive(),
  }),
  summarize: async ({ productId, amountCents }) => {
    const [p] = await db.select().from(schema.products).where(eq(schema.products.id, productId))
    return { title: '申购执行中', fields: [{ label: '产品', value: p?.name ?? productId }, { label: '金额', value: fmt(amountCents) }] }
  },
  execute: async ({ confirmationToken, fromAccountId, productId, amountCents }, ctx) => {
    await consumeToken(ctx, confirmationToken, 'purchase', { fromAccountId, productId, amountCents })
    const acc = await ownAccountOrThrow(ctx, fromAccountId)
    if (acc.balanceCents < amountCents) throw new Error('余额不足')
    const [product] = await db.select().from(schema.products).where(eq(schema.products.id, productId))
    if (!product) throw new Error('产品不存在')
    const risk = await riskGate(ctx, product.riskRating)
    if (risk.reasons.length) throw new Error(`RISK_MISMATCH: ${risk.reasons.join('；')}`)
    if (amountCents < product.minAmountCents) throw new Error(`低于最低申购金额 ${fmt(product.minAmountCents)}`)
    const now = await simNow()
    const redeemableAt = new Date(now.getTime() + product.termDays * DAY).toISOString()
    const holdingId = `h_${randomUUID()}`
    const txId = `tx_${randomUUID()}`
    const balanceAfter = await db.transaction(async (tx) => {
      await assertDebitAccount(tx, acc.id)
      const [debited] = await tx
        .update(schema.accounts)
        .set({ balanceCents: sql`${schema.accounts.balanceCents} - ${amountCents}` })
        .where(and(eq(schema.accounts.id, acc.id), eq(schema.accounts.userId, ctx.userId), gte(schema.accounts.balanceCents, amountCents)))
        .returning()
      if (!debited) throw new Error('余额不足，申购未执行')
      await tx.insert(schema.holdings).values({
        id: holdingId,
        userId: ctx.userId,
        productId,
        principalCents: amountCents,
        redeemableAt,
        createdAt: now.toISOString(),
      })
      await tx.insert(schema.transactions).values({
        id: txId,
        accountId: acc.id,
        amountCents: -amountCents,
        counterparty: product.name,
        memo: '理财申购',
        category: '理财',
        occurredAt: now,
      })
      return debited.balanceCents
    })
    return { holdingId, transactionId: txId, productId, amount: yuan(amountCents), redeemableAt, balanceAfter: yuan(balanceAfter) }
  },
  compensate: (_a, output, ctx) => rollbackInvestment(ctx.userId, output.transactionId, output.holdingId, 'purchase'),
})

export const commitRedemption = defineBankTool({
  name: 'commit_redemption',
  description: '执行理财赎回。必须提供 preview_redemption 签发的确认令牌。',
  baseRisk: 'red',
  kind: 'write',
  inputSchema: z.object({
    confirmationToken: z.string(),
    holdingId: z.string(),
    amountCents: z.number().int().positive(),
    toAccountId: z.string(),
  }),
  summarize: async ({ holdingId, amountCents }) => ({
    title: '赎回执行中',
    fields: [{ label: '持仓', value: holdingId }, { label: '金额', value: fmt(amountCents) }],
  }),
  execute: async ({ confirmationToken, holdingId, amountCents, toAccountId }, ctx) => {
    await consumeToken(ctx, confirmationToken, 'redemption', { holdingId, amountCents, toAccountId })
    const [h] = await db
      .select()
      .from(schema.holdings)
      .where(and(eq(schema.holdings.id, holdingId), eq(schema.holdings.userId, ctx.userId)))
    if (!h) throw new Error('持仓不存在')
    if (amountCents > h.principalCents) throw new Error('赎回金额超过持仓本金')
    const acc = await ownAccountOrThrow(ctx, toAccountId)
    const now = await simNow()
    if (h.redeemableAt > now.toISOString()) throw new Error('持仓仍在锁定期内，不可赎回')
    const txId = `tx_${randomUUID()}`
    const balanceAfter = await db.transaction(async (tx) => {
      await assertDebitAccount(tx, acc.id)
      const [redeemed] = await tx
        .update(schema.holdings)
        .set({ principalCents: sql`${schema.holdings.principalCents} - ${amountCents}` })
        .where(and(eq(schema.holdings.id, holdingId), eq(schema.holdings.userId, ctx.userId), gte(schema.holdings.principalCents, amountCents), lte(schema.holdings.redeemableAt, now.toISOString())))
        .returning()
      if (!redeemed) throw new Error('可赎回本金不足或持仓处于锁定期')
      const [credited] = await tx
        .update(schema.accounts)
        .set({ balanceCents: sql`${schema.accounts.balanceCents} + ${amountCents}` })
        .where(eq(schema.accounts.id, acc.id)).returning()
      await tx.insert(schema.transactions).values({
        id: txId,
        accountId: acc.id,
        amountCents,
        counterparty: h.productId,
        memo: '理财赎回',
        category: '理财',
        occurredAt: now,
      })
      return credited.balanceCents
    })
    return { transactionId: txId, amount: yuan(amountCents), balanceAfter: yuan(balanceAfter) }
  },
  compensate: (a, output, ctx) => rollbackInvestment(ctx.userId, output.transactionId, a.holdingId, 'redemption'),
})

export const commitCardChange = defineBankTool({
  name: 'commit_card_change',
  description: '执行卡片状态或限额变更。必须提供 preview_card_change 签发的确认令牌。',
  baseRisk: 'yellow',
  kind: 'write',
  inputSchema: z.object({
    confirmationToken: z.string(),
    cardId: z.string(),
    action: z.enum(['lock', 'unlock', 'lost', 'limits']),
    dailyLimitCents: z.number().int().positive().optional(),
  }),
  summarize: async ({ cardId, action }, ctx) => {
    const c = await ownCardOrThrow(ctx, cardId)
    return { title: { lock: '锁卡', unlock: '解锁', lost: '挂失', limits: '改限额' }[action], fields: [{ label: '卡片', value: `尾号 ${c.last4}` }] }
  },
  execute: async ({ confirmationToken, cardId, action, dailyLimitCents }, ctx) => {
    await consumeToken(ctx, confirmationToken, 'card_change', { cardId, action, dailyLimitCents: dailyLimitCents ?? null })
    const card = await ownCardOrThrow(ctx, cardId)
    if (card.status === 'lost' && action !== 'lost') throw new Error('已挂失卡片不可恢复，请重新办卡')
    if (action === 'limits') {
      if (!dailyLimitCents) throw new Error('调整限额需提供 dailyLimitCents')
      await db.update(schema.cards).set({ dailyLimitCents }).where(eq(schema.cards.id, cardId))
    } else {
      const statusMap: Record<string, 'active' | 'locked' | 'lost'> = { lock: 'locked', unlock: 'active', lost: 'lost' }
      await db.update(schema.cards).set({ status: statusMap[action] }).where(eq(schema.cards.id, cardId))
    }
    return { cardId, action, done: true }
  },
  compensate: async ({ cardId, action, dailyLimitCents: _dl }, _out, ctx) => {
    if (action !== 'lock') throw new Error('该卡片变更不支持自动回退，需人工核对')
    if (action === 'lock') {
      const card = await ownCardOrThrow(ctx, cardId)
      if (card.status === 'lost') throw new Error('卡片已挂失，不能通过回退恢复')
      await db.update(schema.cards).set({ status: 'active' }).where(and(eq(schema.cards.id, cardId), eq(schema.cards.status, 'locked')))
    }
  },
})

export const commitSubscriptionChange = defineBankTool({
  name: 'commit_subscription_change',
  description: '执行取消订阅或修改提醒。必须提供 preview_subscription_change 签发的确认令牌。',
  baseRisk: 'yellow',
  kind: 'write',
  inputSchema: z.object({
    confirmationToken: z.string(),
    subscriptionId: z.string(),
    action: z.enum(['cancel', 'set_reminder']),
    remindDays: z.number().int().optional(),
  }),
  summarize: async ({ subscriptionId, action, remindDays },ctx) => lifeSubscriptionChangeSummary(ctx.userId,subscriptionId,action,remindDays),
  execute: async ({ confirmationToken, subscriptionId, action, remindDays }, ctx) => {
    await consumeToken(ctx, confirmationToken, 'subscription_change', { subscriptionId, action, remindDays: remindDays ?? null })
    const where = and(eq(schema.subscriptions.id, subscriptionId), eq(schema.subscriptions.userId, ctx.userId))
    if (action === 'cancel') {
      await cancelLifeSubscription(ctx,subscriptionId)
    } else {
      if (!remindDays) throw new Error('设置提醒需提供 remindDays')
      await db.update(schema.subscriptions).set({ remindDays }).where(where)
    }
    return { subscriptionId, action, done: true }
  },
})

// ── F. 系统控制（不暴露给模型，后台 / 仿真用）─────────────────────────────────

export const advanceSimulationClock = defineBankTool({
  name: 'advance_simulation_clock',
  description: '推进仿真时钟到指定时间（只能向前）并执行所有到期任务。ISO 8601 格式。仅用于演示与测试。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({ to: z.string() }),
  execute: async ({ to }, ctx) => {
    const current = await simNow()
    const target = new Date(to)
    if (!Number.isFinite(target.getTime())) throw new Error('时间格式无效')
    if (target <= current) throw new Error('目标时间不能早于当前模拟时间')
    await db.insert(schema.settings).values({ key: 'clock_mode', value: 'manual' }).onConflictDoUpdate({ target: schema.settings.key, set: { value: 'manual' } })
    await db
      .insert(schema.settings)
      .values({ key: 'clock', value: target.toISOString() })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: target.toISOString() } })
    const jobs = await runDueJobs(ctx.userId, target)
    return { previous: current.toISOString(), now: target.toISOString(), executed: jobs.length, jobs }
  },
})

export const listScheduledTasks = defineBankTool({
  name: 'list_scheduled_tasks',
  description: '列出当前用户的定时任务（定时转账、生日计划等）。',
  baseRisk: 'green',
  kind: 'read',
  inputSchema: z.object({}),
  execute: async (_args, ctx) => {
    const rows = await db
      .select()
      .from(schema.scheduledTasks)
      .where(eq(schema.scheduledTasks.userId, ctx.userId))
      .orderBy(desc(schema.scheduledTasks.dueAt))
    return rows.map((t) => ({
      id: t.id,
      kind: t.kind,
      status: t.status,
      dueAt: t.dueAt,
      payload: JSON.parse(t.payloadJson),
      result: t.resultJson ? JSON.parse(t.resultJson) : null,
    }))
  },
})

export const cancelScheduledTask = defineBankTool({
  name: 'cancel_scheduled_task',
  description: '取消一个待执行的定时任务。',
  baseRisk: 'yellow',
  kind: 'write',
  inputSchema: z.object({ taskId: z.string() }),
  summarize: async ({ taskId }) => ({
    title: '取消定时任务',
    fields: [{ label: '任务 ID', value: taskId }],
  }),
  execute: async ({ taskId }, ctx) => {
    return (await import('#/server/automation/service')).cancelScheduled(ctx.userId, taskId)
  },
})

// ── helpers ───────────────────────────────────────────────────────────────────

export function maskAccount(no: string) {
  return no.length >= 8 ? `${no.slice(0, 4)} **** ${no.slice(-4)}` : no
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return dp[a.length][b.length]
}

// ── 导出工具数组 ──────────────────────────────────────────────────────────────

export const EXTENDED_TOOLS = [
  // 只读查询
  getSpendingReport,
  getAnomalies,
  getPortfolio,
  getRecommendations,
  // 实体解析
  resolveRecipient,
  resolveCard,
  resolveSubscription,
  resolveProduct,
  // 前置校验
  checkTransferLimit,
  checkProductEligibility,
  // 预览
  previewTransfer,
  previewPurchase,
  previewRedemption,
  previewCardChange,
  previewSubscriptionChange,
  // 提交
  commitTransfer,
  commitPurchase,
  commitRedemption,
  commitCardChange,
  commitSubscriptionChange,
  // 系统控制
  listScheduledTasks,
  cancelScheduledTask,
]
