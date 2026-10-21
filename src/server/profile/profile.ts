import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, lte } from 'drizzle-orm'
import { generateText } from 'ai'
import { z } from 'zod'
import { db, schema } from '#/server/db/client'
import { auditInTransaction } from '#/server/audit/log'
import { agentModel } from '#/server/llm/models'
import { businessMonth } from '#/lib/dashboard'
import { collectEvidence, verifyNumbers } from '#/server/verify/numbers'
import { fundPortfolio } from '#/server/funds/trading'
import { allowedFund } from '#/server/funds/pool'

/**
 * 后台用户画像（#7）。
 *
 * 两层，边界清楚：
 * 1. **指标由代码算出**（`buildProfileMetrics`）：纯函数，输入是流水与持仓的数字快照，输出可单测、可复算。
 * 2. **文字由模型写**（`narrateProfile`）：模型只拿到白名单化的数字与类别，只输出文字；
 *    文字里出现的每个金额都必须能在指标集合里找到出处，找不到就整段丢弃，退回确定性文案。
 *
 * 与 §0 的关系：画像只用于后台人员查看，**不进入策略引擎的事实、不影响任何风险等级、不进入 Agent 上下文**。
 * 如果将来想让画像参与风控，必须像 #1 那样走"事实 → rules.ts"，而不是直接读这里的文字。
 */

// ── 口径 ──────────────────────────────────────────────────────────────────────

/** 与后台总览（admin/utils.ts 的 cashFlow）保持一致：本金进出不是消费。再加上本人账户之间的往来。 */
const NON_FLOW_CATEGORIES = new Set(['opening', '理财', '冲正'])
/** 信用卡还款是把储蓄卡的钱转去还信用消费，消费已在信用卡流水里计过，不能再算一次支出。 */
const EXCLUDED_SPEND = new Set(['信用卡还款'])
const WINDOW_MONTHS = 6
const RECURRING_MIN_MONTHS = 3

export interface ProfileTransaction {
  id: string
  accountId: string
  amountCents: number
  category: string
  counterparty: string
  occurredAt: Date
  /** 本人账户之间的互转（两端都属于该用户） */
  internal: boolean
}

export interface ProfileInput {
  now: Date
  transactions: ProfileTransaction[]
  /** 活期可用余额（分） */
  balanceCents: number
  investmentPrincipalCents: number
  /** 理财产品风险等级对应的本金，用来看持仓结构 */
  holdings: { riskRating: string; principalCents: number }[]
  /** 问卷得出的风险等级；没做过测评为 null */
  riskRating: string | null
  activeSubscriptions: number
  subscriptionMonthlyCents: number
  creditLimitCents: number
  creditOutstandingCents: number
}

export interface MonthPoint { month: string; incomeCents: number; expenseCents: number }
export interface CategoryShare { category: string; cents: number; share: number }

export interface ProfileMetrics {
  /** 参与统计的完整月份数（不含当月）；少于 3 时多数比率标记为"数据不足" */
  monthsObserved: number
  monthlyIncomeCents: number
  monthlyExpenseCents: number
  /** (收入-支出)/收入；收入为 0 或数据不足时为 null */
  savingsRate: number | null
  currentMonth: MonthPoint
  trend: MonthPoint[]
  topCategories: CategoryShare[]
  /** 周期性支出：同一对手方、金额相同、至少连续 3 个月出现 */
  recurring: { counterparty: string; amountCents: number; months: number }[]
  recurringMonthlyCents: number
  /** 当月支出相对前几个月均值的偏离；数据不足时为 null */
  expenseVsAverage: number | null
  /** 活期余额可覆盖多少个月的平均支出；支出为 0 时为 null */
  liquidityMonths: number | null
  investmentShare: number | null
  holdingsByRisk: { riskRating: string; principalCents: number }[]
  riskRating: string | null
  /** 风险等级与持仓最高风险的关系：mismatch 表示持仓高于测评等级 */
  riskAlignment: 'aligned' | 'mismatch' | 'unknown'
  creditUtilization: number | null
  activeSubscriptions: number
  subscriptionMonthlyCents: number
  totalAssetsCents: number
}

const monthOf = (date: Date) => businessMonth(date)
const RISK_ORDER: Record<string, number> = { R1: 1, R2: 2, R3: 3, R4: 4, R5: 5 }
const round = (n: number, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits

/** 以 `from` 为终点向前数，最长的"按月连续"段；终点可以是当月或上个月（当月尚未扣款不算断）。 */
function consecutiveRun(months: Set<string>, from: string): number {
  const step = (month: string, delta: number) => {
    const [y, m] = month.split('-').map(Number)
    return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7)
  }
  let cursor = months.has(from) ? from : step(from, -1)
  let run = 0
  while (months.has(cursor)) { run++; cursor = step(cursor, -1) }
  return run
}

function isFlow(t: ProfileTransaction) {
  return !t.internal && !NON_FLOW_CATEGORIES.has(t.category)
}

/** 纯函数。同样的输入永远得到同样的指标。 */
export function buildProfileMetrics(input: ProfileInput): ProfileMetrics {
  const nowMonth = monthOf(input.now)
  const [y, m] = nowMonth.split('-').map(Number)
  const months = Array.from({ length: WINDOW_MONTHS }, (_, i) => new Date(Date.UTC(y, m - 1 - (WINDOW_MONTHS - 1 - i), 1)).toISOString().slice(0, 7))
  const byMonth = new Map<string, MonthPoint>(months.map((month) => [month, { month, incomeCents: 0, expenseCents: 0 }]))
  const categoryTotals = new Map<string, number>()

  for (const t of input.transactions) {
    if (!isFlow(t)) continue
    const point = byMonth.get(monthOf(t.occurredAt))
    if (!point) continue
    if (t.amountCents > 0) point.incomeCents += t.amountCents
    else if (!EXCLUDED_SPEND.has(t.category)) {
      point.expenseCents -= t.amountCents
      if (point.month !== nowMonth) categoryTotals.set(t.category, (categoryTotals.get(t.category) ?? 0) - t.amountCents)
    }
  }
  const trend = months.map((month) => byMonth.get(month)!)
  const currentMonth = byMonth.get(nowMonth)!
  // 当月未结束，不参与均值；没有任何流水的月份也不计入，避免新用户被"摊薄"
  const complete = trend.filter((p) => p.month !== nowMonth && (p.incomeCents > 0 || p.expenseCents > 0))
  const monthsObserved = complete.length
  const sum = (key: 'incomeCents' | 'expenseCents') => complete.reduce((n, p) => n + p[key], 0)
  const monthlyIncomeCents = monthsObserved ? Math.round(sum('incomeCents') / monthsObserved) : 0
  const monthlyExpenseCents = monthsObserved ? Math.round(sum('expenseCents') / monthsObserved) : 0
  const enough = monthsObserved >= RECURRING_MIN_MONTHS
  const savingsRate = enough && monthlyIncomeCents > 0 ? round((monthlyIncomeCents - monthlyExpenseCents) / monthlyIncomeCents) : null

  const categoryTotal = [...categoryTotals.values()].reduce((n, v) => n + v, 0)
  const topCategories = [...categoryTotals]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .slice(0, 5)
    .map(([category, cents]) => ({ category, cents, share: categoryTotal ? round(cents / categoryTotal) : 0 }))

  // 固定支出：同对手方 + 同金额，**按月连续**出现至少 3 个月，且最近一次不早于上个月。
  // 转给同一对手方的定额转账（房租、赡养费）算固定支出；AA 分摊是一次性的，不算。
  const groups = new Map<string, { counterparty: string; amountCents: number; months: Set<string> }>()
  for (const t of input.transactions) {
    if (!isFlow(t) || t.amountCents >= 0 || EXCLUDED_SPEND.has(t.category) || t.category === 'AA') continue
    const key = `${t.counterparty}|${t.amountCents}`
    const group = groups.get(key) ?? { counterparty: t.counterparty, amountCents: -t.amountCents, months: new Set<string>() }
    group.months.add(monthOf(t.occurredAt))
    groups.set(key, group)
  }
  const recurring = [...groups.values()]
    .map((g) => ({ counterparty: g.counterparty, amountCents: g.amountCents, months: consecutiveRun(g.months, nowMonth) }))
    .filter((g) => g.months >= RECURRING_MIN_MONTHS)
    .sort((a, b) => b.amountCents - a.amountCents).slice(0, 5)

  const earlier = trend.filter((p) => p.month !== nowMonth && p.expenseCents > 0)
  const earlierAvg = earlier.length >= 2 ? earlier.reduce((n, p) => n + p.expenseCents, 0) / earlier.length : 0
  const expenseVsAverage = earlierAvg > 0 ? round((currentMonth.expenseCents - earlierAvg) / earlierAvg) : null

  const totalAssetsCents = input.balanceCents + input.investmentPrincipalCents
  const byRisk = new Map<string, number>()
  for (const h of input.holdings) if (h.principalCents > 0) byRisk.set(h.riskRating, (byRisk.get(h.riskRating) ?? 0) + h.principalCents)
  const holdingsByRisk = [...byRisk].sort((a, b) => (RISK_ORDER[a[0]] ?? 9) - (RISK_ORDER[b[0]] ?? 9)).map(([riskRating, principalCents]) => ({ riskRating, principalCents }))
  const highestHeld = Math.max(0, ...holdingsByRisk.map((h) => RISK_ORDER[h.riskRating] ?? 0))
  const riskAlignment = !input.riskRating || !holdingsByRisk.length ? 'unknown' : highestHeld > (RISK_ORDER[input.riskRating] ?? 0) ? 'mismatch' : 'aligned'

  return {
    monthsObserved, monthlyIncomeCents, monthlyExpenseCents, savingsRate, currentMonth, trend, topCategories,
    recurring, recurringMonthlyCents: recurring.reduce((n, r) => n + r.amountCents, 0),
    expenseVsAverage,
    liquidityMonths: enough && monthlyExpenseCents > 0 ? round(input.balanceCents / monthlyExpenseCents, 1) : null,
    investmentShare: totalAssetsCents > 0 ? round(input.investmentPrincipalCents / totalAssetsCents) : null,
    holdingsByRisk, riskRating: input.riskRating, riskAlignment,
    creditUtilization: input.creditLimitCents > 0 ? round(input.creditOutstandingCents / input.creditLimitCents) : null,
    activeSubscriptions: input.activeSubscriptions, subscriptionMonthlyCents: input.subscriptionMonthlyCents, totalAssetsCents,
  }
}

// ── 标签：全部由指标推导，不是模型的判断 ─────────────────────────────────────────

export interface ProfileTag { code: string; label: string; tone: 'good' | 'warn' | 'info'; basis: string }

const pct = (v: number) => `${(v * 100).toFixed(1)}%`
export function deriveTags(m: ProfileMetrics): ProfileTag[] {
  const tags: ProfileTag[] = []
  if (m.monthsObserved < RECURRING_MIN_MONTHS) tags.push({ code: 'insufficient', label: '数据不足', tone: 'info', basis: `仅有 ${m.monthsObserved} 个完整月份的流水，比率类指标暂不输出。` })
  if (m.savingsRate !== null) {
    if (m.savingsRate >= 0.3) tags.push({ code: 'saver', label: '高储蓄', tone: 'good', basis: `月均储蓄率 ${pct(m.savingsRate)}。` })
    else if (m.savingsRate < 0) tags.push({ code: 'overspend', label: '入不敷出', tone: 'warn', basis: `月均支出高于收入，储蓄率 ${pct(m.savingsRate)}。` })
    else if (m.savingsRate < 0.1) tags.push({ code: 'thin_margin', label: '结余偏低', tone: 'warn', basis: `月均储蓄率仅 ${pct(m.savingsRate)}。` })
  }
  if (m.liquidityMonths !== null && m.liquidityMonths < 3) tags.push({ code: 'low_liquidity', label: '活期储备偏少', tone: 'warn', basis: `活期余额约可覆盖 ${m.liquidityMonths} 个月支出。` })
  if (m.liquidityMonths !== null && m.liquidityMonths >= 12 && (m.investmentShare ?? 0) < 0.2) tags.push({ code: 'idle_cash', label: '闲置资金较多', tone: 'info', basis: `活期可覆盖 ${m.liquidityMonths} 个月支出，理财占比 ${pct(m.investmentShare ?? 0)}。` })
  if (m.expenseVsAverage !== null && m.expenseVsAverage >= 0.3) tags.push({ code: 'spend_spike', label: '本月支出偏高', tone: 'warn', basis: `本月支出较前期月均高 ${pct(m.expenseVsAverage)}。` })
  if (m.riskAlignment === 'mismatch') tags.push({ code: 'risk_mismatch', label: '持仓风险高于测评', tone: 'warn', basis: `风险测评 ${m.riskRating}，持仓含更高风险等级产品。` })
  if (!m.riskRating) tags.push({ code: 'no_assessment', label: '未做风险测评', tone: 'info', basis: '没有风险测评记录，理财推荐按最低风险等级处理。' })
  if (m.creditUtilization !== null && m.creditUtilization >= 0.7) tags.push({ code: 'credit_high', label: '信用额度使用率高', tone: 'warn', basis: `信用卡额度已使用 ${pct(m.creditUtilization)}。` })
  if (m.recurring.length) tags.push({ code: 'recurring', label: '有固定支出', tone: 'info', basis: `识别到 ${m.recurring.length} 项连续多月的固定扣款。` })
  return tags
}

// ── 采集（只读） ──────────────────────────────────────────────────────────────

export async function collectProfileInput(userId: string, now: Date): Promise<ProfileInput> {
  const [accounts, holdings, products, subscriptions, user, cards] = await Promise.all([
    db.select().from(schema.accounts).where(eq(schema.accounts.userId, userId)),
    db.select().from(schema.holdings).where(eq(schema.holdings.userId, userId)),
    db.select().from(schema.products),
    db.select().from(schema.subscriptions).where(eq(schema.subscriptions.userId, userId)),
    db.select().from(schema.users).where(eq(schema.users.id, userId)),
    db.select().from(schema.cards).where(eq(schema.cards.userId, userId)),
  ])
  const ids = accounts.map((a) => a.id)
  const since = new Date(Date.UTC(Number(monthOf(now).slice(0, 4)), Number(monthOf(now).slice(5)) - WINDOW_MONTHS, 1) - 8 * 3600_000)
  const rows = ids.length
    ? await db.select().from(schema.transactions)
        .where(and(inArray(schema.transactions.accountId, ids), lte(schema.transactions.occurredAt, now)))
        .orderBy(desc(schema.transactions.occurredAt))
    : []
  // 本人账户之间的互转：借方的收款账户属于本人
  const links = rows.length
    ? await db.select().from(schema.bankTransferLinks).where(inArray(schema.bankTransferLinks.debitTransactionId, rows.map((r) => r.id))).catch(() => [])
    : []
  const mine = new Set(ids)
  const internalIds = new Set<string>()
  for (const link of links) {
    if (link.targetAccountId && mine.has(link.targetAccountId)) {
      internalIds.add(link.debitTransactionId)
      if (link.creditTransactionId) internalIds.add(link.creditTransactionId)
    }
  }
  const productRisk = new Map(products.map((p) => [p.id, p.riskRating]))
  const credit = await creditTotals(userId, cards)
  const funds = await fundPortfolio(userId, now)
  return {
    now,
    // 窗口外的流水不进入计算：既限制规模，也让"最近 6 个月"的口径写在一处
    transactions: rows.filter((r) => r.occurredAt >= since).map((r) => ({
      id: r.id, accountId: r.accountId, amountCents: r.amountCents, category: r.category,
      counterparty: r.counterparty, occurredAt: r.occurredAt, internal: internalIds.has(r.id),
    })),
    balanceCents: accounts.filter((a) => !credit.creditAccountIds.has(a.id)).reduce((n, a) => n + a.balanceCents, 0),
    investmentPrincipalCents: holdings.reduce((n, h) => n + h.principalCents, 0) + funds.marketValueCents + funds.pendingCents,
    holdings: [...holdings.map((h) => ({ riskRating: productRisk.get(h.productId) ?? 'R1', principalCents: h.principalCents })),
      ...funds.positions.map((p) => ({ riskRating: p.riskRating, principalCents: p.marketValueCents })),
      ...funds.orders.filter((o) => o.status === 'submitted').map((o) => ({ riskRating: allowedFund(o.code).riskRating, principalCents: o.amountCents }))],
    riskRating: user[0]?.riskAssessedAt ? (user[0].riskRating ?? null) : null,
    activeSubscriptions: subscriptions.filter((s) => s.status === 'active').length,
    subscriptionMonthlyCents: subscriptions.filter((s) => s.status === 'active')
      .reduce((n, s) => n + (s.cycle === 'yearly' ? Math.round(s.amountCents / 12) : s.amountCents), 0),
    creditLimitCents: credit.limit,
    creditOutstandingCents: credit.outstanding,
  }
}

async function creditTotals(userId: string, cards: (typeof schema.cards.$inferSelect)[]) {
  const creditCards = cards.filter((c) => c.kind === 'credit')
  const { userCards } = await import('#/server/cards/service')
  const profiles = (await userCards(userId)).filter((c) => c.kind === 'credit')
  return {
    creditAccountIds: new Set(profiles.map((c) => c.accountId)),
    limit: profiles.reduce((n, c) => n + c.creditLimitCents, 0),
    outstanding: profiles.reduce((n, c) => n + c.outstandingCents, 0),
    hasCredit: creditCards.length > 0,
  }
}

// ── 文字：模型只写文字，数字必须有出处 ──────────────────────────────────────────

/**
 * 交给模型的唯一输入。全部是代码算出的数字和固定枚举：
 * 没有姓名、账号、对手方名称、备注、商户名——这些是外部可控文本，不能进模型。
 * 类别来自代码写入的固定集合，仍然做白名单过滤。
 */
const KNOWN_CATEGORIES = new Set(['餐饮', '交通', '购物', '娱乐', '生活缴费', '转账', 'AA', '订阅', '生日订购', '房租', '医疗', '教育', '工资'])
export function narrationInput(m: ProfileMetrics, tags: ProfileTag[]) {
  const yuan = (cents: number) => `¥${(Math.round(cents) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const alignment = { aligned: '与测评一致', mismatch: '持仓风险高于测评', unknown: '无法判断' } as const
  // 比率和枚举全部预先转成可以直接引用的中文文本：模型不需要、也不应该自己换算，
  // 否则它会把 0.294、mismatch 这类原始值原样抄进摘要。
  // 没有意义的字段**整个不交给模型**，而不是给一个"无""数据不足"让它自由发挥：
  // 实测过它会把"无信用卡"写成"信用额度使用率为 0.0%"，不涉及金额，数字核验拦不住，但那是不实的陈述。
  const known = <T,>(value: T | null, text: (v: T) => string) => (value === null ? {} : { value: text(value) })
  const optional = (label: string, part: { value?: string }) => (part.value === undefined ? {} : { [label]: part.value })
  return {
    观察月数: `${m.monthsObserved} 个月`,
    月均收入: yuan(m.monthlyIncomeCents),
    月均支出: yuan(m.monthlyExpenseCents),
    本月支出: yuan(m.currentMonth.expenseCents),
    ...optional('储蓄率', known(m.savingsRate, pct)),
    ...optional('本月较前期月均', known(m.expenseVsAverage, (v) => `${v >= 0 ? '高' : '低'} ${pct(Math.abs(v))}`)),
    ...optional('活期余额可覆盖支出', known(m.liquidityMonths, (v) => `${v} 个月`)),
    ...optional('理财占总资产', known(m.investmentShare, pct)),
    ...optional('风险测评等级', known(m.riskRating, (v) => v)),
    ...(m.riskAlignment === 'unknown' ? {} : { 持仓与测评: alignment[m.riskAlignment] }),
    ...optional('信用额度使用率', known(m.creditUtilization, pct)),
    ...(m.recurringMonthlyCents > 0 ? { 固定支出每月合计: yuan(m.recurringMonthlyCents) } : {}),
    ...(m.topCategories.length ? { 支出前几类: m.topCategories.filter((c) => KNOWN_CATEGORIES.has(c.category)).map((c) => `${c.category} ${yuan(c.cents)}（${pct(c.share)}）`) } : {}),
    ...(tags.length ? { 特征标签: tags.map((t) => t.label) } : {}),
  }
}

export interface Narrative { text: string; source: 'ai' | 'rule'; rejected?: 'numbers' | 'invalid' | 'unavailable' }

/** 确定性文案：模型不可用或输出被拒绝时使用。数字全部来自指标。 */
export function ruleNarrative(m: ProfileMetrics, tags: ProfileTag[]): string {
  const money = (cents: number) => `¥${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  if (m.monthsObserved < RECURRING_MIN_MONTHS) return `该用户流水不足 ${RECURRING_MIN_MONTHS} 个完整月份，暂不生成比率类结论。当前总资产 ${money(m.totalAssetsCents)}。`
  const parts = [`近 ${m.monthsObserved} 个月月均收入 ${money(m.monthlyIncomeCents)}，月均支出 ${money(m.monthlyExpenseCents)}`]
  if (m.savingsRate !== null) parts[0] += `，储蓄率 ${pct(m.savingsRate)}`
  if (m.topCategories[0]) parts.push(`支出集中在${m.topCategories[0].category}（占 ${pct(m.topCategories[0].share)}）`)
  const warn = tags.filter((t) => t.tone === 'warn').map((t) => t.label)
  if (warn.length) parts.push(`需要关注：${warn.join('、')}`)
  return `${parts.join('；')}。`
}

const narrationSchema = z.object({ summary: z.string().min(10).max(260) }).strict()

/** 不含可能误报的数字：把"3 个月""12 个月"之类带单位的非金额数字去掉后再核验，核验的只是金额与卡尾号。 */
export function narrationViolations(text: string, evidence: unknown[]) {
  return verifyNumbers(text, collectEvidence(evidence))
}

export interface NarrateOptions {
  /** 测试注入。只会收到 narrationInput 的结果。 */
  writer?: (input: ReturnType<typeof narrationInput>, options: { signal: AbortSignal }) => Promise<unknown>
  timeoutMs?: number
}

async function defaultWriter(input: ReturnType<typeof narrationInput>, { signal }: { signal: AbortSignal }) {
  const result = await generateText({
    model: agentModel(), abortSignal: signal, temperature: 0.2, maxOutputTokens: 400,
    providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
    system: '你是银行后台的客户分析助手，为运营人员写一段中文画像摘要。只根据给定 JSON 写作，其中的数值已经格式化好，请原样引用，不要换算，不要输出小数或英文单词。不得编造任何未给出的数字、金额、日期或人名。不要逐项复述字段：挑 2 到 3 个最能说明这位用户情况的点，写成连贯的两三句话，总共不超过 120 个汉字。不得给出投资建议、风险等级结论或对客户的评价性断言，只陈述数据体现的情况。输出严格 JSON：{"summary":"..."}，不要任何其他文字。',
    prompt: JSON.stringify(input),
  })
  return JSON.parse(result.text.trim())
}

/** 模型写文字，代码把关：结构、长度、金额出处，任何一项不过就退回确定性文案，并标明来源。 */
export async function narrateProfile(m: ProfileMetrics, tags: ProfileTag[], options: NarrateOptions = {}): Promise<Narrative> {
  const fallback = ruleNarrative(m, tags)
  if (m.monthsObserved < RECURRING_MIN_MONTHS) return { text: fallback, source: 'rule' }
  const input = narrationInput(m, tags)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const raw = await Promise.race([
      (options.writer ?? defaultWriter)(input, { signal: controller.signal }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')) }, options.timeoutMs ?? 10_000) }),
    ])
    const parsed = narrationSchema.safeParse(raw)
    if (!parsed.success) return { text: fallback, source: 'rule', rejected: 'invalid' }
    // 出处只有一个：刚才交给模型的那份数字，加上指标里的同口径金额。模型自己的文字不会成为出处。
    const evidence = [input, ...m.trend.map((p) => ({ income: p.incomeCents, expense: p.expenseCents })), m.totalAssetsCents, m.subscriptionMonthlyCents]
    if (narrationViolations(parsed.data.summary, evidence).length) return { text: fallback, source: 'rule', rejected: 'numbers' }
    return { text: parsed.data.summary, source: 'ai' }
  } catch {
    return { text: fallback, source: 'rule', rejected: 'unavailable' }
  } finally { clearTimeout(timer) }
}

// ── 对外：画像快照 ────────────────────────────────────────────────────────────

export interface UserProfile {
  userId: string
  userName: string
  generatedAt: string
  metrics: ProfileMetrics
  tags: ProfileTag[]
  narrative: Narrative
  /** 指标指纹：输入没变则指纹不变，用来判断缓存的文字是否仍然对应当前数据 */
  fingerprint: string
}

export function metricsFingerprint(m: ProfileMetrics): string {
  return createHash('sha256').update(JSON.stringify(m)).digest('hex').slice(0, 24)
}

/** 只算指标与标签：快、确定、不调用模型。列表页用它。 */
export async function computeProfile(userId: string, now: Date) {
  const input = await collectProfileInput(userId, now)
  const metrics = buildProfileMetrics(input)
  return { metrics, tags: deriveTags(metrics), fingerprint: metricsFingerprint(metrics) }
}

let ready: Promise<void> | undefined
export function ensureProfileSchema() {
  return (ready ??= (async () => {
    await db.$client.execute(`CREATE TABLE IF NOT EXISTS bank_profile_narratives (
      user_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL,
      rejected TEXT, generated_at INTEGER NOT NULL)`)
  })().catch((error) => { ready = undefined; throw error }))
}

/**
 * 读取画像。文字按指标指纹缓存：数据没变就不重复调用模型；`refresh` 才强制重写。
 * 写入缓存与审计同一事务，后台能回答"这段文字是什么时候、基于什么数据生成的"。
 */
export async function getUserProfile(userId: string, now: Date, options: { refresh?: boolean; narrate?: NarrateOptions } = {}): Promise<UserProfile> {
  await ensureProfileSchema()
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId))
  const { metrics, tags, fingerprint } = await computeProfile(userId, now)
  const [cached] = await db.select().from(schema.bankProfileNarratives).where(eq(schema.bankProfileNarratives.userId, userId))
  let narrative: Narrative, generatedAt = now
  if (cached && cached.fingerprint === fingerprint && !options.refresh) {
    narrative = { text: cached.text, source: cached.source as Narrative['source'], ...(cached.rejected ? { rejected: cached.rejected as Narrative['rejected'] } : {}) }
    generatedAt = cached.generatedAt
  } else {
    narrative = await narrateProfile(metrics, tags, options.narrate)
    await db.transaction(async (tx) => {
      await tx.insert(schema.bankProfileNarratives).values({ userId, fingerprint, text: narrative.text, source: narrative.source, rejected: narrative.rejected ?? null, generatedAt: now })
        .onConflictDoUpdate({ target: schema.bankProfileNarratives.userId, set: { fingerprint, text: narrative.text, source: narrative.source, rejected: narrative.rejected ?? null, generatedAt: now } })
      await auditInTransaction(tx, { userId, sessionId: 'profile', channel: 'web' }, 'profile_generated', { fingerprint, source: narrative.source, rejected: narrative.rejected ?? null, tags: tags.map((t) => t.code) })
    })
  }
  return { userId, userName: user?.name ?? userId, generatedAt: generatedAt.toISOString(), metrics, tags, narrative, fingerprint }
}

/** 全体用户的概览行：只含确定性指标与标签，不调用模型。 */
export async function listProfileSummaries(now: Date) {
  const users = await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users)
  const rows = []
  for (const user of users) {
    const { metrics, tags } = await computeProfile(user.id, now)
    rows.push({
      userId: user.id, userName: user.name, monthsObserved: metrics.monthsObserved,
      monthlyIncomeCents: metrics.monthlyIncomeCents, monthlyExpenseCents: metrics.monthlyExpenseCents,
      savingsRate: metrics.savingsRate, totalAssetsCents: metrics.totalAssetsCents, riskRating: metrics.riskRating,
      tags: tags.map((t) => ({ code: t.code, label: t.label, tone: t.tone })),
    })
  }
  return rows.sort((a, b) => b.totalAssetsCents - a.totalAssetsCents)
}
