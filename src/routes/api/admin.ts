import { settleTransfer } from '#/server/payments/service'
import { createUserCard, creditSpend, saveCardRemark, userCards } from '#/server/cards/service'
import { reserveBirthday, cancelBirthday, reservedFunds } from '#/server/automation/birthdays'
import { createSplitRequests } from '#/server/payments/splits'
import { paymentAccounts } from '#/server/payments/service'
/**
 * 银行管理后台 API：/api/admin/*
 *
 * 这是银行管理后台（非用户后台），用于操作模拟银行数据：
 * - 读取全量快照（账户、联系人、卡片、产品、持仓、订阅、任务、分摊、计划、流水、异常、审计）
 * - 执行管理命令（转账、AA、申购、赎回、卡片、订阅、定时任务、仿真时钟）
 *
 * 与 /api/chat 的区别：chat 是 AI Agent 入口，admin 是人工操作入口。
 * admin 不经过策略引擎和确认令牌——它是演示/评测用的直接操作通道。
 */
import { createFileRoute } from '@tanstack/react-router'
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { auth as authTables, db, schema } from '#/server/db/client'
import { DEMO_USER_ID } from '#/server/db/constants'
import { audit } from '#/server/audit/log'
import { env } from '#/server/env'
import { runDueJobs, scoreRisk } from '#/server/tools/jobs'
import { adminUserExists, listAdminUsers } from '#/server/admin/users'
import { adminAuthorized, authorizeAdminTransfer } from '#/server/admin/access'
import { recentTraces, restoreAuditLog, runSandboxProbes, securityOverview, tamperAuditLog } from '#/server/security/kernel'
import { buildTraces } from '#/server/security/trace'
import { runLifeRenewalsThrough } from '#/server/life/service'

const disabled = () =>
  Response.json({ error: { code: 'ADMIN_DISABLED', message: '管理后台未启用（设置 ADMIN_ENABLED=true）' } }, { status: 403 })

const DAY = 24 * 60 * 60 * 1000

async function simNow(): Promise<string> {
  const row = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, 'clock'))
    .then((r) => r[0])
  return row?.value ?? new Date().toISOString()
}

/** 读取全量快照 */
async function getSnapshot(userId: string) {
  const cards = await userCards(userId)
  const now = await simNow()
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId))
  const registered = user ? undefined : (await db.select({ name: authTables.baUser.name }).from(authTables.baUser).where(eq(authTables.baUser.id, userId)))[0]
  const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.userId, userId))
  const contacts = await db.select().from(schema.contacts).where(eq(schema.contacts.userId, userId))
  const products = await db.select().from(schema.products)
  const holdings = await db.select().from(schema.holdings).where(eq(schema.holdings.userId, userId))
  const subscriptions = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.userId, userId))
  const tasks = await db
    .select()
    .from(schema.scheduledTasks)
    .where(eq(schema.scheduledTasks.userId, userId))
    .orderBy(desc(schema.scheduledTasks.dueAt))
  const splits = await db.select().from(schema.splits).where(eq(schema.splits.userId, userId))
  const plans = await db
    .select()
    .from(schema.birthdayPlans)
    .where(eq(schema.birthdayPlans.userId, userId))
  const orders = plans.length
    ? await db.select().from(schema.birthdayOrders).where(inArray(schema.birthdayOrders.planId, plans.map((plan) => plan.id)))
    : []
  const accIds = accounts.map((a) => a.id)
  const transactions = accIds.length
    ? await db
        .select()
        .from(schema.transactions)
        .where(inArray(schema.transactions.accountId, accIds))
        .orderBy(desc(schema.transactions.occurredAt))
    : []
  const auditLogs = await db
    .select()
    .from(schema.auditLogs)
    .where(eq(schema.auditLogs.userId, userId))
    .orderBy(desc(schema.auditLogs.seq))
    .limit(200)

  const mainAccount = accounts[0]
  const balance = mainAccount?.balanceCents ?? 0
  const birthdayFunds = await reservedFunds(userId)
  const held = birthdayFunds.filter((fund) => fund.accountId === mainAccount?.id).reduce((sum, fund) => sum + fund.heldCents, 0)

  return {
    now,
    user: {
      id: user?.id ?? userId,
      name: user?.name ?? registered?.name ?? '演示用户',
      riskLevel: user?.riskRating ?? 'R1',
      riskAssessedAt: user?.riskAssessedAt ?? null,
    },
    account: {
      id: mainAccount?.id ?? '',
      name: mainAccount?.name ?? '主账户',
      balance: balance + held,
      available: balance,
      held,
    },
    accounts: accounts.map((a) => ({ ...a, balance: a.balanceCents, available: a.balanceCents })),
    contacts: contacts.map((c) => ({ ...c })),
    cards: cards.map((c) => ({
      ...c,
      dailyLimit: c.dailyLimitCents,
      creditLimit: c.creditLimitCents,
      outstanding: c.outstandingCents,
      onlineEnabled: true,
    })),
    products: products.map((p) => ({
      ...p,
      riskLevel: p.riskRating,
      minAmount: p.minAmountCents,
      annualRate: Math.round(p.expectedYield * 10000),
      lockDays: p.termDays,
      description: '',
    })),
    holdings: holdings.map((h) => ({
      ...h,
      principal: h.principalCents,
    })),
    subscriptions: subscriptions.map((s) => ({
      ...s,
      amount: s.amountCents,
      nextChargeAt: s.lastChargedAt?.toISOString?.() ?? s.lastChargedAt,
      remindDays: s.remindDays,
      lastReminderAt: null,
    })),
    tasks: tasks.map((t) => ({
      ...t,
      payload: JSON.parse(t.payloadJson),
      result: t.resultJson ? JSON.parse(t.resultJson) : null,
    })),
    splits: splits.map((sp) => {
      const shares = JSON.parse(sp.sharesJson) as Array<{
        contactId: string
        amountCents: number
        status: string
      }>
      const selfAmount = Math.floor(sp.totalCents / (shares.length + 1))
      return {
        ...sp,
        total: sp.totalCents,
        shares: shares.map((s) => ({
          contactId: s.contactId,
          amount: s.amountCents,
          status: s.status,
        })),
        selfAmount,
      }
    }),
    plans: plans.map((p) => ({ ...p, status: p.status === 'reserved' && !birthdayFunds.some((fund) => fund.planId === p.id) ? 'planned' : p.status, budget: p.budgetCents })),
    orders: orders.map((o) => ({ ...o, amount: o.amountCents })),
    transactions: transactions.map((t) => ({
      ...t,
      amount: t.amountCents,
      merchant: t.counterparty,
      reference: 'seed',
      subscriptionId: null,
    })),
    auditLogs: auditLogs.map((a) => ({
      ...a,
      payloadJson: a.payloadJson,
    })),
  }
}

/** 计算账期报告 */
async function getReport(userId: string, period: string) {
  const accs = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.userId, userId))
  const rows = await db
    .select()
    .from(schema.transactions)
    .where(inArray(schema.transactions.accountId, accs.map((a) => a.id)))
  const filtered = rows.filter((t) => {
    const d = t.occurredAt instanceof Date ? t.occurredAt.toISOString() : String(t.occurredAt)
    return d.startsWith(period)
  })
  const income = filtered.filter((t) => t.amountCents > 0).reduce((s, t) => s + t.amountCents, 0)
  const expense = filtered.filter((t) => t.amountCents < 0).reduce((s, t) => s + (-t.amountCents), 0)
  const byCategory: Record<string, number> = {}
  for (const t of filtered) {
    if (t.amountCents < 0) byCategory[t.category] = (byCategory[t.category] ?? 0) + (-t.amountCents)
  }
  return {
    period,
    income,
    expense,
    net: income - expense,
    transactionCount: filtered.length,
    categories: byCategory,
    excludedCategories: ['opening', '理财'],
  }
}

/** 异常检测 */
async function getAnomalies(userId: string) {
  const accs = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.userId, userId))
  const now = new Date(await simNow())
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
  const avg = spending.length ? spending.reduce((s, t) => s + (-t.amountCents), 0) / spending.length : 0
  const anomalies: typeof rows = []
  for (const t of spending) {
    if (-t.amountCents > avg * 2 && -t.amountCents > 50_000) anomalies.push(t)
  }
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i],
      b = rows[i + 1]
    const ta = a.occurredAt instanceof Date ? a.occurredAt.getTime() : new Date(a.occurredAt).getTime()
    const tb = b.occurredAt instanceof Date ? b.occurredAt.getTime() : new Date(b.occurredAt).getTime()
    if (a.amountCents === b.amountCents && a.amountCents < 0 && Math.abs(ta - tb) < 10 * 60 * 1000) {
      if (!anomalies.find((x) => x.id === a.id)) anomalies.push(a)
      if (!anomalies.find((x) => x.id === b.id)) anomalies.push(b)
    }
  }
  return anomalies.map((t) => ({
    ...t,
    amount: t.amountCents,
    merchant: t.counterparty,
    reference: 'seed',
    subscriptionId: null,
    reasons: ['大额或重复扣款'],
    needsReview: true as const,
  }))
}

// ── 命令 schema ───────────────────────────────────────────────────────────────

const CommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('transfer'),
    recipient: z.string(),
    amount: z.number().int().positive(),
    memo: z.string().optional(),
    executeAt: z.string().optional(),
  }),
  z.object({
    type: z.literal('createSplit'),
    title: z.string(),
    total: z.number().int().positive(),
    contactIds: z.array(z.string()),
  }),
  z.object({
    type: z.literal('settleSplit'),
    splitId: z.string(),
    contactId: z.string(),
  }),
  z.object({
    type: z.literal('cancelTask'),
    taskId: z.string(),
  }),
  z.object({
    type: z.literal('assessRisk'),
    answers: z.array(z.number().int().min(1).max(5)).length(5),
  }),
  z.object({
    type: z.literal('purchase'),
    productId: z.string(),
    amount: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('redeem'),
    holdingId: z.string(),
    amount: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('applyCard'),
    kind: z.enum(['debit', 'credit']),
  }),
  z.object({
    type: z.literal('updateCard'),
    cardId: z.string(),
    action: z.enum(['freeze', 'unlock', 'reportLost', 'limits']),
    dailyLimit: z.number().int().positive().optional(),
    onlineEnabled: z.boolean().optional(),
  }),
  z.object({ type: z.literal('cardRemark'), cardId: z.string(), remark: z.string().trim().max(30) }),
  z.object({ type: z.literal('creditSpend'), cardId: z.string(), amount: z.number().int().positive().max(100_000_000), merchant: z.string().trim().min(1).max(60) }),
  z.object({
    type: z.literal('cancelSubscription'),
    subscriptionId: z.string(),
  }),
  z.object({
    type: z.literal('subscriptionReminder'),
    subscriptionId: z.string(),
    days: z.number().int().min(1).max(30),
  }),
  z.object({
    type: z.literal('birthdayPlan'),
    contactId: z.string(),
    birthday: z.string(),
    budget: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('cancelPlan'),
    planId: z.string(),
  }),
  z.object({
    type: z.literal('advanceClock'),
    to: z.string(),
  }),
  z.object({
    type: z.literal('runJobs'),
  }),
  /** 安全内核演示：故意改写一条审计记录，用于证明哈希链可发现篡改 */
  z.object({
    type: z.literal('tamperAudit'),
    seq: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('restoreAudit'),
  }),
])

type Command = z.infer<typeof CommandSchema>

/** 执行管理命令 */
async function executeCommand(userId: string, command: Command, request: Request) {
  const now = new Date(await simNow())
  switch (command.type) {
    case 'transfer': {
      const accs = await db.select().from(schema.accounts).where(eq(schema.accounts.userId, userId))
      const acc = accs[0]
      if (!acc) throw new Error('没有可用账户')
      // 按姓名/别名/手机号查找收款人
      const payees = await db.select().from(schema.payees).where(eq(schema.payees.userId, userId))
      const q = command.recipient.trim()
      // 精确匹配优先（ID/姓名/别名/手机/卡尾号），否则包含匹配；多个候选一律拒绝，不替用户猜
      const exact = payees.filter(
        (p) => p.id === q || p.name === q || p.alias === q || p.phone === q || (q.length >= 4 && p.accountNo.endsWith(q)),
      )
      const matched = exact.length
        ? exact
        : payees.filter((p) => p.name.includes(q) || p.alias?.includes(q))
      if (matched.length > 1)
        throw new Error(`收款人"${q}"有多个匹配：${matched.map((p) => p.alias ? `${p.name}（${p.alias}）` : p.name).join('、')}`)
      if (matched.length === 1)
        return doTransfer(request, userId, acc.id, matched[0].id, command.amount, command.memo, command.executeAt)

      // 联系人（后台通讯录）：按 ID/姓名/手机/备注关键词匹配，首次转账时登记为收款人
      const contacts = await db.select().from(schema.contacts).where(eq(schema.contacts.userId, userId))
      const cExact = contacts.filter((c) => c.id === q || c.name === q || c.phone === q)
      const cMatched = cExact.length ? cExact : contacts.filter((c) => c.note.split(' ').includes(q))
      if (cMatched.length > 1)
        throw new Error(`收款人"${q}"有多个匹配：${cMatched.map((c) => c.name).join('、')}`)
      const c = cMatched[0]
      if (!c) throw new Error(`未找到收款人：${q}`)
      const payeeId = `p_${c.id}`
      await db
        .insert(schema.payees)
        .values({
          id: payeeId,
          userId,
          name: c.name,
          alias: c.note.split(' ')[0] || null,
          accountNo: c.accountMask.replace(/\D/g, ''),
          bank: c.bank,
          phone: c.phone,
          createdAt: now,
        })
        .onConflictDoNothing()
      return doTransfer(request, userId, acc.id, payeeId, command.amount, command.memo, command.executeAt)
    }
    case 'createSplit': {
      const shares = command.contactIds.map((contactId) => ({
        contactId,
        amountCents: Math.floor(command.total / (command.contactIds.length + 1)),
        status: 'pending' as const,
      }))
      const id = `split_${Date.now()}`
      await db.insert(schema.splits).values({
        id,
        userId,
        title: command.title,
        totalCents: command.total,
        sharesJson: JSON.stringify(shares),
        createdAt: now.toISOString(),
      })
      const requests = await createSplitRequests(userId, id)
      return { id, ...requests, title: command.title, total: command.total, shares, selfAmount: Math.floor(command.total / (command.contactIds.length + 1)) }
    }
    case 'settleSplit': {
      throw new Error('AA 必须由参与人登录自己的账户确认付款，后台不能代替参与人生成到账记录')
    }
    case 'cancelTask': {
      return (await import('#/server/confirm/lock')).withUserExecutionLock(userId, async () => (await import('#/server/automation/service')).cancelScheduled(userId, command.taskId))
    }
    case 'assessRisk': {
      const riskRating = scoreRisk(command.answers)
      await db
        .update(schema.users)
        .set({ riskRating, riskAssessedAt: now.toISOString() })
        .where(eq(schema.users.id, userId))
      return { riskLevel: riskRating, assessedAt: now.toISOString() }
    }
    case 'purchase': {
      const [product] = await db.select().from(schema.products).where(eq(schema.products.id, command.productId))
      if (!product) throw new Error('产品不存在')
      const accs = await db.select().from(schema.accounts).where(eq(schema.accounts.userId, userId))
      const acc = accs[0]
      if (!acc) throw new Error('没有可用账户')
      if (acc.balanceCents < command.amount) throw new Error('余额不足')
      const redeemableAt = new Date(now.getTime() + product.termDays * DAY).toISOString()
      const holdingId = `h_${Date.now()}`
      const txId = `tx_${Date.now()}`
      await db.transaction(async (tx) => {
        const [debited] = await tx
          .update(schema.accounts)
          .set({ balanceCents: sql`${schema.accounts.balanceCents} - ${command.amount}` })
          .where(and(eq(schema.accounts.id, acc.id), gte(schema.accounts.balanceCents, command.amount)))
          .returning()
        if (!debited) throw new Error('余额不足')
        await tx.insert(schema.holdings).values({
          id: holdingId,
          userId,
          productId: command.productId,
          principalCents: command.amount,
          redeemableAt,
          createdAt: now.toISOString(),
        })
        await tx.insert(schema.transactions).values({
          id: txId,
          accountId: acc.id,
          amountCents: -command.amount,
          counterparty: product.name,
          memo: '理财申购',
          category: '理财',
          occurredAt: now,
        })
      })
      return { holdingId, productId: command.productId, principal: command.amount, redeemableAt }
    }
    case 'redeem': {
      const [h] = await db
        .select()
        .from(schema.holdings)
        .where(and(eq(schema.holdings.id, command.holdingId), eq(schema.holdings.userId, userId)))
      if (!h) throw new Error('持仓不存在')
      if (h.redeemableAt > now.toISOString()) throw new Error('持仓锁定中')
      if (command.amount > h.principalCents) throw new Error('超过持仓本金')
      const accs = await db.select().from(schema.accounts).where(eq(schema.accounts.userId, userId))
      const acc = accs[0]
      if (!acc) throw new Error('没有可用账户')
      const txId = `tx_${Date.now()}`
      await db.transaction(async (tx) => {
        const [redeemed] = await tx
          .update(schema.holdings)
          .set({ principalCents: sql`${schema.holdings.principalCents} - ${command.amount}` })
          .where(and(eq(schema.holdings.id, command.holdingId), gte(schema.holdings.principalCents, command.amount)))
          .returning()
        if (!redeemed) throw new Error('可赎回本金不足')
        await tx
          .update(schema.accounts)
          .set({ balanceCents: sql`${schema.accounts.balanceCents} + ${command.amount}` })
          .where(eq(schema.accounts.id, acc.id))
        await tx.insert(schema.transactions).values({
          id: txId,
          accountId: acc.id,
          amountCents: command.amount,
          counterparty: h.productId,
          memo: '理财赎回',
          category: '理财',
          occurredAt: now,
        })
      })
      return { transactionId: txId, amount: command.amount }
    }
    case 'applyCard': {
      return { ...await createUserCard(userId, command.kind), status: 'active', simulation: true as const }
    }
    case 'cardRemark': return saveCardRemark(userId, command.cardId, command.remark)
    case 'creditSpend': return creditSpend(userId, command.cardId, command.amount, command.merchant)
    case 'updateCard': {
      const [c] = await db
        .select()
        .from(schema.cards)
        .where(and(eq(schema.cards.id, command.cardId), eq(schema.cards.userId, userId)))
      if (!c) throw new Error('卡片不存在')
      if (c.status === 'lost' && command.action !== 'reportLost') throw new Error('已挂失卡片不可恢复或修改状态')
      if (command.action === 'freeze') {
        await db.update(schema.cards).set({ status: 'locked' }).where(eq(schema.cards.id, command.cardId))
      } else if (command.action === 'unlock') {
        await db.update(schema.cards).set({ status: 'active' }).where(eq(schema.cards.id, command.cardId))
      } else if (command.action === 'reportLost') {
        await db.update(schema.cards).set({ status: 'lost' }).where(eq(schema.cards.id, command.cardId))
      } else if (command.action === 'limits' && command.dailyLimit) {
        await db
          .update(schema.cards)
          .set({ dailyLimitCents: command.dailyLimit })
          .where(eq(schema.cards.id, command.cardId))
      }
      return { cardId: command.cardId, action: command.action }
    }
    case 'cancelSubscription': {
      await db
        .update(schema.subscriptions)
        .set({ status: 'cancelled' })
        .where(
          and(
            eq(schema.subscriptions.id, command.subscriptionId),
            eq(schema.subscriptions.userId, userId),
          ),
        )
      return { subscriptionId: command.subscriptionId, status: 'cancelled' as const }
    }
    case 'subscriptionReminder': {
      await db
        .update(schema.subscriptions)
        .set({ remindDays: command.days })
        .where(and(eq(schema.subscriptions.id, command.subscriptionId), eq(schema.subscriptions.userId, userId)))
      return { subscriptionId: command.subscriptionId, remindDays: command.days }
    }
    case 'birthdayPlan': {
      const account = (await paymentAccounts(userId))[0]
      if (!account) throw new Error('没有可预留资金的储蓄账户')
      return reserveBirthday({ fromAccountId: account.id, contactId: command.contactId, birthday: command.birthday, budgetCents: command.budget }, { userId, sessionId: 'admin', channel: 'web', authorization: { level: 'red', actionId: 'admin' } }, now)
    }
    case 'cancelPlan': {
      return cancelBirthday(userId, command.planId)
    }
    case 'advanceClock': {
      const current = new Date(await simNow())
      const target = new Date(command.to)
      if (target <= current) throw new Error('目标时间不能早于当前模拟时间')
      const renewal = await runLifeRenewalsThrough(current, target)
      // Clock advance has committed. Report a later job error explicitly, never claim it rolled back.
      try { return { now: target.toISOString(), renewal, jobs: await runDueJobs(userId, target) } }
      catch (e) { return { now: target.toISOString(), renewal, jobs: [], jobsError: e instanceof Error ? e.message : String(e) } }
    }
    case 'runJobs': {
      const current = new Date(await simNow())
      const jobs = await runDueJobs(userId, current)
      return { jobs }
    }
    case 'tamperAudit': {
      // 只改载荷、不动 hash 列——攻击者的真实做法。用于演示整链校验能定位到这一条。
      const result = await tamperAuditLog(command.seq)
      return { ...result, message: `已改写审计记录 #${result.seq} 的载荷，哈希列保持不变` }
    }
    case 'restoreAudit': {
      const result = await restoreAuditLog()
      return { ...result, message: result.restored.length ? `已还原 ${result.restored.length} 条记录` : '没有需要还原的记录' }
    }
  }
}

async function doTransfer(
  request: Request,
  userId: string,
  accountId: string,
  payeeId: string,
  amountCents: number,
  memo?: string,
  executeAt?: string,
) {
  const now = new Date(await simNow())
  const [acc] = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, userId)))
  if (!acc) throw new Error('账户不存在')
  const [payee] = await db
    .select()
    .from(schema.payees)
    .where(and(eq(schema.payees.id, payeeId), eq(schema.payees.userId, userId)))
  if (!payee) throw new Error('收款人不存在')

  if (executeAt) {
    // 定时转账：创建任务
    const taskId = `task_${Date.now()}`
    await db.insert(schema.scheduledTasks).values({
      id: taskId,
      userId,
      kind: 'transfer',
      status: 'pending',
      dueAt: executeAt,
      payloadJson: JSON.stringify({ payeeId, fromAccountId: accountId, amountCents, memo }),
      resultJson: null,
      createdAt: now.toISOString(),
    })
    return { id: taskId, kind: 'transfer', status: 'pending', dueAt: executeAt, payload: { payeeId, amountCents }, result: null }
  }

  const input = { fromAccountId: accountId, payeeId, amountCents, memo }
  const adminGrant = authorizeAdminTransfer(request,userId,input)
  const result = await settleTransfer(input, { userId, sessionId: 'admin', channel: 'web' }, now, { adminGrant })
  return { ...result, amount: amountCents }
}

// ── 路由 ───────────────────────────────────────────────────────────────────────

export const Route = createFileRoute('/api/admin')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!env.ADMIN_ENABLED) return disabled()
        if (!adminAuthorized(request)) return Response.json({ error: { code: 'ADMIN_AUTH_REQUIRED', message: '请输入后台访问凭据' } }, { status: 401 })
        const url = new URL(request.url)
        const action = url.searchParams.get('action') ?? 'snapshot'
        const userId = url.searchParams.get('userId') ?? DEMO_USER_ID
        const period = url.searchParams.get('period') ?? new Date().toISOString().slice(0, 7)

        try {
          if (action === 'users') return Response.json({ data: await listAdminUsers() })
          // 安全内核与决策链是全局视图（跨用户），不依赖所选账户
          if (action === 'security') return Response.json({ data: await securityOverview() })
          if (action === 'trace') return Response.json({ data: buildTraces(await recentTraces()) })
          if (action === 'sandbox') return Response.json({ data: await runSandboxProbes() })
          if (!(await adminUserExists(userId))) {
            return Response.json({ error: { code: 'USER_NOT_FOUND', message: '用户不存在，请返回首页选择账户' } }, { status: 404 })
          }
          switch (action) {
            case 'snapshot':
              return Response.json({ data: await getSnapshot(userId) })
            case 'report':
              return Response.json({ data: await getReport(userId, period) })
            case 'anomalies':
              return Response.json({ data: await getAnomalies(userId) })
            default:
              return Response.json({ error: { code: 'UNKNOWN_ACTION', message: action } }, { status: 400 })
          }
        } catch (e) {
          return Response.json(
            { error: { code: 'ADMIN_ERROR', message: e instanceof Error ? e.message : String(e) } },
            { status: 500 },
          )
        }
      },
      POST: async ({ request }) => {
        if (!env.ADMIN_ENABLED) return disabled()
        if (!adminAuthorized(request)) return Response.json({ error: { code: 'ADMIN_AUTH_REQUIRED', message: '请输入后台访问凭据' } }, { status: 401 })
        try {
          const body = await request.json()
          const parsed = CommandSchema.safeParse(body)
          if (!parsed.success) {
            return Response.json(
              { error: { code: 'INVALID_COMMAND', message: parsed.error.message } },
              { status: 400 },
            )
          }
          const userId = (request.headers.get('x-admin-user') ?? DEMO_USER_ID) as string
          if (!(await adminUserExists(userId))) {
            return Response.json({ error: { code: 'USER_NOT_FOUND', message: '用户不存在，请返回首页选择账户' } }, { status: 404 })
          }
          const ctx = { userId, sessionId: 'admin', channel: 'web' as const }
          try {
            const result = await executeCommand(userId, parsed.data, request)
            await audit(ctx, 'admin_command', { command: parsed.data, ok: true })
            return Response.json({ data: result })
          } catch (e) {
            await audit(ctx, 'admin_command', {
              command: parsed.data,
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            })
            throw e
          }
        } catch (e) {
          return Response.json(
            { error: { code: 'COMMAND_FAILED', message: e instanceof Error ? e.message : String(e) } },
            { status: 500 },
          )
        }
      },
    },
  },
})
