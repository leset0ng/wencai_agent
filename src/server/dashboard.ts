import { and, desc, eq, gt, inArray } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import { businessMonth } from '#/lib/dashboard'
import type { DashboardData } from '#/lib/dashboard'
import { simNow } from '#/server/tools/jobs'
import { userCards, cardKindName } from '#/server/cards/service'
import { notifications } from '#/server/automation/service'
import { reservedFunds } from '#/server/automation/birthdays'

/** 用户首页只接受已认证会话中的身份，所有业务数据按归属过滤。金额返回元。 */
export async function getDashboard(userId: string): Promise<DashboardData> {
  const cards = await userCards(userId)
  const [accounts, holdings, subscriptions, now, pendingTransfers] = await Promise.all([
    db.select().from(schema.accounts).where(eq(schema.accounts.userId, userId)),
    db
      .select({ principal: schema.holdings.principalCents })
      .from(schema.holdings)
      .where(eq(schema.holdings.userId, userId)),
    db.select().from(schema.subscriptions).where(eq(schema.subscriptions.userId, userId)),
    simNow(),
    db.select({ actionId: schema.pendingActions.id, level: schema.pendingActions.level, summaryJson: schema.pendingActions.summaryJson, expiresAt: schema.pendingActions.expiresAt })
      .from(schema.pendingActions).where(and(eq(schema.pendingActions.userId, userId), eq(schema.pendingActions.status, 'pending'), gt(schema.pendingActions.expiresAt, new Date()),
        inArray(schema.pendingActions.tool, ['transfer', 'commit_transfer', 'transfer_between_cards', 'transfer_between_accounts', 'pay_split_request'])))
      .orderBy(desc(schema.pendingActions.createdAt)),
  ])
  const rows = accounts.length
    ? await db
        .select()
        .from(schema.transactions)
        .where(
          inArray(
            schema.transactions.accountId,
            accounts.map((account) => account.id),
          ),
        )
        .orderBy(desc(schema.transactions.occurredAt))
    : []
  const period = businessMonth(now)
  const transactionData = (items: typeof rows) => items.slice(0, 50).map((row) => ({
    id: row.id,
    amount: row.amountCents / 100,
    counterparty: row.counterparty,
    category: row.category,
    occurredAt: row.occurredAt.toISOString(),
    accountId: row.accountId,
    memo: row.memo ?? '',
  }))
  // 每个账户独立统计完整账期，再截取明细；不从首页的 50 条记录里筛选。
  const accountActivity = Object.fromEntries(accounts.map((account) => {
    const own = rows.filter((row) => row.accountId === account.id)
    const current = own.filter((row) => businessMonth(row.occurredAt) === period)
    const categories = new Map<string, number>()
    let income = 0
    let expense = 0
    for (const row of current) {
      if (row.amountCents >= 0) income += row.amountCents
      else {
        expense -= row.amountCents
        categories.set(row.category, (categories.get(row.category) ?? 0) - row.amountCents)
      }
    }
    return [account.id, {
      monthly: {
        period, income: income / 100, expense: expense / 100,
        categories: [...categories].map(([label, value]) => ({ label, value: value / 100 })).sort((a, b) => b.value - a.value),
      },
      transactions: transactionData(own),
    }]
  }))
  const current = rows.filter((row) => businessMonth(row.occurredAt) === period && row.category !== '信用卡还款')
  const categories = new Map<string, number>()
  let incomeCents = 0
  let expenseCents = 0
  for (const row of current) {
    if (row.amountCents >= 0) incomeCents += row.amountCents
    else {
      expenseCents -= row.amountCents
      categories.set(row.category, (categories.get(row.category) ?? 0) - row.amountCents)
    }
  }
  const availableCents = accounts.reduce((sum, account) => sum + account.balanceCents, 0)
  const principalCents = holdings.reduce((sum, holding) => sum + holding.principal, 0)
  const reservedCents = (await reservedFunds(userId)).reduce((sum, fund) => sum + fund.heldCents, 0)
  const [year, month] = period.split('-').map(Number)
  const trend = Array.from({ length: 6 }, (_, i) => {
    const date = new Date(Date.UTC(year, month - 6 + i, 1))
    const key = date.toISOString().slice(0, 7)
    const total = rows
      .filter((row) => businessMonth(row.occurredAt) === key && row.amountCents < 0 && row.category !== '信用卡还款')
      .reduce((sum, row) => sum - row.amountCents, 0)
    return { label: `${date.getUTCMonth() + 1}月`, value: total / 100 }
  })
  return {
    pendingTransfers: pendingTransfers.map((item) => ({ actionId: item.actionId, level: item.level, summary: JSON.parse(item.summaryJson), expiresAt: item.expiresAt.getTime() })),
    notifications: (await notifications(userId)).map((n) => ({ id: n.id, title: n.title, body: n.body, actionId: n.actionId, read: !!n.readAt })),
    now: now.toISOString(),
    totalAssets: (availableCents + principalCents + reservedCents) / 100,
    reservedBalance: reservedCents / 100,
    availableBalance: availableCents / 100,
    investmentPrincipal: principalCents / 100,
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      balance: account.balanceCents / 100,
      currency: account.currency,
    })),
    cards: cards.map((card) => ({
      id: card.id,
      accountId: card.accountId,
      last4: card.last4,
      kind: card.kind,
      status: card.status,
      accountName: card.remark || cardKindName(card.kind),
      remark: card.remark,
      dailyLimit: card.dailyLimitCents / 100,
      creditLimit: card.creditLimitCents / 100,
      outstanding: card.outstandingCents / 100,
      availableCredit: (card.creditLimitCents - card.outstandingCents) / 100,
      billDay: card.billDay, dueDay: card.dueDay,
    })),
    transactions: transactionData(rows),
    accountActivity,
    subscriptions: subscriptions.map((item) => ({
      id: item.id,
      merchant: item.merchant,
      amount: item.amountCents / 100,
      cycle: item.cycle,
      status: item.status,
    })),
    monthly: {
      period,
      income: incomeCents / 100,
      expense: expenseCents / 100,
      categories: [...categories]
        .map(([label, value]) => ({ label, value: value / 100 }))
        .sort((a, b) => b.value - a.value),
    },
    trend,
  }
}
