import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import type { AgentContext } from '#/server/agent/context'
import { assertDebitAccount } from '#/server/cards/service'
import { audit, auditInTransaction } from '#/server/audit/log'
import { cstDate, staleNav } from './provider'
import { ensureFundData, ensureFundSchema } from './store'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
export interface FundOrderInput { code: string; fromAccountId: string; amountCents: number }
/** Before 15:00 CST use today's NAV; after cutoff use the first NAV on/after the next calendar day. */
export function effectiveTradeDate(now: Date) {
  const local = new Date(now.getTime() + 8 * 3600_000)
  if (local.getUTCHours() >= 15) local.setUTCDate(local.getUTCDate() + 1)
  return local.toISOString().slice(0, 10)
}
const safe = (v: bigint) => { const n = Number(v); if (!Number.isSafeInteger(n)) throw new Error('FUND_AMOUNT_OVERFLOW'); return n }
export function subscriptionShares(amountCents: number, feeBp: number, navE4: number) {
  if (![amountCents, feeBp, navE4].every(Number.isSafeInteger) || amountCents <= 0 || navE4 <= 0 || feeBp < 0 || feeBp > 500) throw new Error('FUND_AMOUNT_INVALID')
  const netCents = safe((BigInt(amountCents) * 10000n + BigInt(10000 + feeBp) / 2n) / BigInt(10000 + feeBp))
  // Round shares down to 0.01 to avoid issuing unsupported fractional shares.
  return { sharesE2: safe(BigInt(netCents) * 10000n / BigInt(navE4)), feeCents: amountCents - netCents }
}
async function eligibility(tx: Tx, userId: string, input: FundOrderInput, now: Date) {
  const { code, fromAccountId, amountCents } = input
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 100_000_000) throw new Error('申购金额无效')
  const [fund] = await tx.select().from(schema.bankFunds).where(eq(schema.bankFunds.code, code))
  if (!fund?.enabled || fund.purchaseStatus !== 'open') throw new Error('基金不可申购（暂停、限额或待人工复核）')
  const [nav] = await tx.select().from(schema.bankFundNavs).where(and(eq(schema.bankFundNavs.code, code), lte(schema.bankFundNavs.navDate, cstDate(now)))).orderBy(desc(schema.bankFundNavs.navDate)).limit(1)
  if (!nav || staleNav(nav.navDate, now)) throw new Error('净值数据过期，请先刷新；未扣款')
  const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, userId))
  const assessed = user?.riskAssessedAt ? new Date(user.riskAssessedAt).getTime() : NaN
  if (!user || !Number.isFinite(assessed) || assessed > now.getTime() || now.getTime() - assessed > 365 * 86400_000) throw new Error('请先完成有效的风险测评')
  if (Number(user.riskRating.slice(1)) < Number(fund.riskRating.slice(1))) throw new Error('产品风险超过您的风险等级')
  if (user.lockedUntil && user.lockedUntil > new Date()) throw new Error('账户已锁定')
  if (amountCents < fund.minPurchaseCents) throw new Error('低于基金起购金额')
  const [account] = await tx.select().from(schema.accounts).where(and(eq(schema.accounts.id, fromAccountId), eq(schema.accounts.userId, userId)))
  if (!account || account.balanceCents < amountCents) throw new Error('付款账户不可用或余额不足')
  await assertDebitAccount(tx, fromAccountId)
  const [card] = await tx.select().from(schema.cards).where(eq(schema.cards.accountId, fromAccountId))
  if (card) {
    const dayStart = new Date(cstDate(now) + 'T00:00:00+08:00'), dayEnd = new Date(dayStart.getTime() + 86400_000)
    const rows = await tx.select().from(schema.transactions).where(and(eq(schema.transactions.accountId, fromAccountId), gte(schema.transactions.occurredAt, dayStart), lte(schema.transactions.occurredAt, new Date(dayEnd.getTime() - 1))))
    if (rows.reduce((n, r) => n + Math.max(0, -r.amountCents), 0) + amountCents > card.dailyLimitCents) throw new Error('超过银行卡每日支出限额')
  }
  return fund
}
export async function previewFundOrder(ctx: AgentContext, input: FundOrderInput, now: Date) {
  await ensureFundData()
  const fund = await db.transaction((tx) => eligibility(tx, ctx.userId, input, now))
  const token = `fund_preview_${randomUUID()}`, expiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
  await db.insert(schema.confirmationTokens).values({ id: token, userId: ctx.userId, operation: 'fund_purchase',
    paramHash: JSON.stringify(input), summaryJson: JSON.stringify({ ...input, name: fund.name, purchaseFeeBp: fund.purchaseFeeBp }), tier: 'T2', expiresAt, createdAt: new Date().toISOString() })
  return { ...input, name: fund.name, riskRating: fund.riskRating, confirmationToken: token, expiresAt,
    purchaseFeeBp: fund.purchaseFeeBp, feeCents: subscriptionShares(input.amountCents, fund.purchaseFeeBp, 10000).feeCents,
    tradeDate: effectiveTradeDate(now), pricing: '未知价申购；扣款后等待交易日首个已公布净值，T+1确认份额', realTrading: false }
}
export async function submitFundOrder(ctx: AgentContext, input: FundOrderInput & { confirmationToken: string }, now: Date) {
  await ensureFundSchema()
  if (ctx.authorization?.level !== 'red') throw new Error('基金申购必须通过红色确认和强验证')
  const actionId = ctx.authorization.actionId
  return db.transaction(async (tx) => {
    const [previous] = await tx.select().from(schema.bankFundOrders).where(eq(schema.bankFundOrders.actionId, actionId))
    if (previous) {
      if (previous.userId !== ctx.userId || previous.code !== input.code || previous.accountId !== input.fromAccountId || previous.amountCents !== input.amountCents) throw new Error('FUND_ACTION_MISMATCH')
      return previous
    }
    const plain = { code: input.code, fromAccountId: input.fromAccountId, amountCents: input.amountCents }
    const [token] = await tx.select().from(schema.confirmationTokens).where(eq(schema.confirmationTokens.id, input.confirmationToken))
    if (!token || token.userId !== ctx.userId || token.operation !== 'fund_purchase' || token.paramHash !== JSON.stringify(plain) || token.consumedAt || new Date(token.expiresAt) <= new Date()) throw new Error('基金预览已过期、已使用或参数不匹配，请重新预览')
    const fund = await eligibility(tx, ctx.userId, plain, now)
    if (JSON.parse(token.summaryJson).purchaseFeeBp !== fund.purchaseFeeBp) throw new Error('基金申购费率已变化，请重新预览和确认；未扣款')
    await tx.update(schema.confirmationTokens).set({ consumedAt: new Date().toISOString() }).where(and(eq(schema.confirmationTokens.id, token.id), isNull(schema.confirmationTokens.consumedAt)))
    const [account] = await tx.update(schema.accounts).set({ balanceCents: sql`${schema.accounts.balanceCents}-${input.amountCents}` })
      .where(and(eq(schema.accounts.id, input.fromAccountId), eq(schema.accounts.userId, ctx.userId), gte(schema.accounts.balanceCents, input.amountCents))).returning()
    if (!account) throw new Error('余额不足')
    const transactionId = `tx_${randomUUID()}`
    await tx.insert(schema.transactions).values({ id: transactionId, accountId: input.fromAccountId, amountCents: -input.amountCents,
      counterparty: fund.name, memo: '基金未知价申购，待确认份额', category: '理财', occurredAt: now })
    // Freeze the fee schedule on this order; a later provider refresh cannot silently change it.
    const [order] = await tx.insert(schema.bankFundOrders).values({ id: `fo_${randomUUID()}`, userId: ctx.userId, actionId,
      code: input.code, side: 'buy', amountCents: input.amountCents, accountId: input.fromAccountId, tradeDate: effectiveTradeDate(now),
      status: 'submitted', transactionId, createdAt: now.toISOString(), feeCents: subscriptionShares(input.amountCents, fund.purchaseFeeBp, 10000).feeCents,
    }).returning()
    await auditInTransaction(tx, ctx, 'action_executed', { tool: 'commit_fund_order', order }, now.getTime())
    return order
  })
}
/** Purely local settlement; no provider/network calls, and each order commits independently. */
export async function confirmFundOrders(now: Date) {
  await ensureFundSchema()
  const orders = await db.select().from(schema.bankFundOrders).where(eq(schema.bankFundOrders.status, 'submitted'))
  const result: string[] = []
  for (const candidate of orders) {
    const confirmed = await db.transaction(async (tx) => {
      const [order] = await tx.select().from(schema.bankFundOrders).where(and(eq(schema.bankFundOrders.id, candidate.id), eq(schema.bankFundOrders.status, 'submitted')))
      if (!order || order.tradeDate >= cstDate(now)) return false
      // First NAV >= trade date, NOT latest NAV. Never settle using a date still in the future or same-day T+0.
      const [nav] = await tx.select().from(schema.bankFundNavs).where(and(eq(schema.bankFundNavs.code, order.code), gte(schema.bankFundNavs.navDate, order.tradeDate), lte(schema.bankFundNavs.navDate, cstDate(now))))
        .orderBy(asc(schema.bankFundNavs.navDate)).limit(1)
      // fetchedAt is wall-clock collection provenance, not a publication/trading date. Using it
      // here would stall a historical simulation until the fixture download date was reached.
      if (!nav || nav.navDate >= cstDate(now)) return false
      const sharesE2 = safe(BigInt(order.amountCents - (order.feeCents ?? 0)) * 10000n / BigInt(nav.unitNavE4))
      if (!sharesE2) return false
      await tx.update(schema.bankFundOrders).set({ status: 'confirmed', sharesE2, navDate: nav.navDate, unitNavE4: nav.unitNavE4, confirmedAt: now.toISOString() }).where(eq(schema.bankFundOrders.id, order.id))
      await tx.insert(schema.bankFundPositions).values({ userId: order.userId, code: order.code, sharesE2, costCents: order.amountCents })
        .onConflictDoUpdate({ target: [schema.bankFundPositions.userId, schema.bankFundPositions.code], set: {
          sharesE2: sql`${schema.bankFundPositions.sharesE2}+${sharesE2}`, costCents: sql`${schema.bankFundPositions.costCents}+${order.amountCents}`,
        } })
      await auditInTransaction(tx, { userId: order.userId, sessionId: 'fund-worker', channel: 'web' }, 'action_executed', { tool: 'fund_nav_confirmation', orderId: order.id, navDate: nav.navDate, unitNavE4: nav.unitNavE4, sharesE2 }, now.getTime())
      return true
    }).catch(async (error) => {
      // One corrupt/unavailable order must not stop NAV confirmation for every other customer.
      await audit({ userId: candidate.userId, sessionId: 'fund-worker', channel: 'web' }, 'tool_result', {
        tool: 'fund_nav_confirmation', orderId: candidate.id, ok: false,
        message: error instanceof Error ? error.message : '基金订单确认失败',
      }).catch(() => {})
      return false
    })
    if (confirmed) result.push(candidate.id)
  }
  return result
}
export async function compensateFundOrder(ctx: AgentContext, orderId: string, now: Date) {
  await ensureFundSchema()
  await db.transaction(async (tx) => {
    const [order] = await tx.select().from(schema.bankFundOrders).where(and(eq(schema.bankFundOrders.id, orderId), eq(schema.bankFundOrders.userId, ctx.userId)))
    if (!order || order.status === 'cancelled') return
    if (order.status !== 'submitted') throw new Error('基金份额已确认，需人工处理，不能自动撤销')
    const [account] = await tx.update(schema.accounts).set({ balanceCents: sql`${schema.accounts.balanceCents}+${order.amountCents}` }).where(and(eq(schema.accounts.id, order.accountId), eq(schema.accounts.userId, ctx.userId))).returning()
    if (!account) throw new Error('退款账户不存在，需人工处理')
    await tx.insert(schema.transactions).values({ id: `tx_${randomUUID()}`, accountId: order.accountId, amountCents: order.amountCents, counterparty: '基金申购撤销', category: '冲正', occurredAt: now, reversalOf: order.transactionId })
    await tx.update(schema.bankFundOrders).set({ status: 'cancelled' }).where(eq(schema.bankFundOrders.id, order.id))
    await auditInTransaction(tx, ctx, 'action_compensated', { orderId: order.id, amountCents: order.amountCents }, now.getTime())
  })
}
export async function fundPortfolio(userId: string, now = new Date()) {
  await ensureFundSchema()
  const positions = await db.select().from(schema.bankFundPositions).where(eq(schema.bankFundPositions.userId, userId))
  const orders = await db.select().from(schema.bankFundOrders).where(eq(schema.bankFundOrders.userId, userId)).orderBy(desc(schema.bankFundOrders.createdAt))
  const valued = await Promise.all(positions.map(async (p) => {
    const [fund] = await db.select().from(schema.bankFunds).where(eq(schema.bankFunds.code, p.code))
    const [nav] = await db.select().from(schema.bankFundNavs).where(and(eq(schema.bankFundNavs.code, p.code), lte(schema.bankFundNavs.navDate, cstDate(now)))).orderBy(desc(schema.bankFundNavs.navDate)).limit(1)
    const marketValueCents = nav ? safe((BigInt(p.sharesE2) * BigInt(nav.unitNavE4) + 5000n) / 10000n) : p.costCents
    return { ...p, name: fund?.name ?? p.code, riskRating: fund?.riskRating ?? 'R5', navDate: nav?.navDate ?? null,
      marketValueCents, gainCents: marketValueCents - p.costCents, valuation: nav ? 'nav' : 'cost_only', source: fund?.source ?? null, stale: !nav || staleNav(nav.navDate, now) }
  }))
  const pendingCents = orders.filter((o) => o.status === 'submitted').reduce((n, o) => n + o.amountCents, 0)
  return { positions: valued, orders, pendingCents, marketValueCents: valued.reduce((n, p) => n + p.marketValueCents, 0), realTrading: false }
}
