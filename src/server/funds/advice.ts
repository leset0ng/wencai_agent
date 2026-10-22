import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { generateText } from 'ai'
import { db, schema } from '#/server/db/client'
import type { AgentContext } from '#/server/agent/context'
import { computeProfile } from '#/server/profile/profile'
import { userCards } from '#/server/cards/service'
import { agentModel } from '#/server/llm/models'
import { audit } from '#/server/audit/log'
import { requestedAmounts } from '#/lib/requested-amounts'
import { fundNavs, listFunds } from './store'
import { fundMetrics } from './metrics'
import { ASSET_CLASSES, FUND_STYLES, STYLE_LABELS, type InvestmentProfile } from '#/lib/fund-preferences'

export const AdviceInput = z.object({
  amountYuan: z.number().positive().max(1_000_000).optional(),
  horizon: z.enum(['within_3m', '3_12m', '1_3y', 'over_3y', 'unknown']).default('unknown'),
  liquidity: z.enum(['anytime', 'partial', 'locked_ok', 'unknown']).default('unknown'),
  preference: z.enum(['preserve', 'balanced', 'growth', 'unknown']).default('unknown'),
  targetReturnPct: z.number().min(0).max(100).optional(),
  purpose: z.enum(['emergency', 'education', 'home', 'retire', 'general']).default('general'),
  assetClasses: z.array(z.enum(ASSET_CLASSES)).max(6).optional(),
  styles: z.array(z.enum(FUND_STYLES)).max(13).optional(),
  avoidStyles: z.array(z.enum(FUND_STYLES)).max(13).optional(),
  maxDrawdownPct: z.number().min(0).max(100).optional(),
})
export type AdviceRequest = z.infer<typeof AdviceInput>
type Metrics = ReturnType<typeof fundMetrics>
export interface AdviceCandidate {
  id: string; kind: 'fund' | 'bank'; name: string; riskRating: string; minCents: number; termDays: number;
  expectedYieldPct: number | null; metrics: Metrics; source: string; asOf: string | null;
  investmentProfile?: InvestmentProfile;
}
export interface AdviceBudget { monthlyExpenseCents: number; reserveCents: number; investableCents: number; amountCents: number; monthsObserved: number }
const REASONS = ['risk_matched', 'lower_drawdown', 'diversification', 'long_horizon', 'liquidity', 'historical_return', 'preference_matched'] as const
const ModelAdvice = z.object({
  picks: z.array(z.object({ candidate: z.string().regex(/^候选[1-5]$/), role: z.enum(['core', 'satellite', 'alternative']),
    reasons: z.array(z.enum(REASONS)).min(1).max(3), note: z.string().max(80),
  }).strict()).min(1).max(3), summary: z.string().max(160), conflictNotes: z.array(z.string().max(100)).max(6),
}).strict()
const forbidden = /保本|稳赚|保证.{0,6}收益|一定|肯定|无风险|必涨|零风险|承诺.{0,6}(?:回报|收益)|绝不(?:亏|损)|包赚|确保.{0,6}收益/
const percentageTokens = (text: string) => [...text.normalize('NFKC').matchAll(/([-+]?\d[\d,]*(?:\.\d+)?)\s*(?:%|个百分点|个点)|百分之\s*([-+]?\d+(?:\.\d+)?)/g)]
  .map((m) => Number((m[1] ?? m[2]).replace(/,/g, '')))
const moneyTokens = (text: string) => [...text.normalize('NFKC').matchAll(/[¥￥]\s*(\d[\d,]*(?:\.\d+)?)\s*(万)?|(?:人民币\s*)?(\d[\d,]*(?:\.\d+)?)\s*(万)?元/g)]
  .map((m) => Math.round(Number((m[1] ?? m[3]).replace(/,/g, '')) * (m[2] || m[4] ? 10000 : 1) * 100))
const numericEqual = (a: number, b: number) => Math.abs(a - b) < .00001

/** Expert-only: percentages are scoped to the current candidate, not any number elsewhere in a conversation. */
export function expertTextViolations(text: string, budget: AdviceBudget, candidate?: AdviceCandidate): string[] {
  const errors: string[] = []
  if (forbidden.test(text)) errors.push('guarantee')
  if (/(?:未来|今后).{0,12}(?:回撤|亏损|损失).{0,6}(?:不超过|低于|小于|至多)|(?:最多亏|亏损(?:不会|不可能|不)超过|损失上限为)/.test(text)) errors.push('drawdown_promise')
  // Never accept spelled-out invented percentages or an unparseable quantitative claim.
  if (/(?:百分之\s*[零〇一二两三四五六七八九十百]+|[零〇一二两三四五六七八九十百壹贰叁肆伍陆柒捌玖拾佰仟][零〇一二两三四五六七八九十百千万亿萬億点壹贰叁肆伍陆柒捌玖拾佰仟]*\s*(?:成|个百分点|个点|%|％|元|圆|圓|块|万|亿|萬|億))/.test(text)) errors.push('unparsed_quantity')
  const percentages = candidate ? [...Object.values(candidate.metrics).filter((n): n is number => typeof n === 'number'), ...(candidate.expectedYieldPct === null ? [] : [candidate.expectedYieldPct])] : []
  if (percentageTokens(text).some((n) => !percentages.some((p) => numericEqual(p, n)))) errors.push('percentage')
  const amounts = [budget.monthlyExpenseCents, budget.reserveCents, budget.investableCents, budget.amountCents, ...(candidate ? [candidate.minCents] : [])]
  if (moneyTokens(text).some((n) => !amounts.includes(n))) errors.push('money')
  // Metric label and value must match too: a drawdown cannot be presented as a one-year return.
  const metrics: [RegExp, number | null][] = candidate ? [
    [/近(?:一|1)年.{0,8}?([-+]?\d+(?:\.\d+)?)\s*[%％]/g, candidate.metrics.return1yPct],
    [/近(?:三|3)个?月.{0,8}?([-+]?\d+(?:\.\d+)?)\s*[%％]/g, candidate.metrics.return3mPct],
    [/最大回撤.{0,8}?([-+]?\d+(?:\.\d+)?)\s*[%％]/g, candidate.metrics.maxDrawdownPct],
    [/波动率.{0,8}?([-+]?\d+(?:\.\d+)?)\s*[%％]/g, candidate.metrics.volatilityPct],
  ] : []
  for (const [pattern, value] of metrics) for (const match of text.matchAll(pattern)) if (value === null || !numericEqual(Number(match[1]), value)) errors.push('metric_attribution')
  // No arbitrary unmarked figures (e.g. "可买5000", a claim escaping the money regex).
  const scrubbed = text.normalize('NFKC').replace(/[-+]?\d[\d,]*(?:\.\d+)?\s*(?:%|个百分点|个点)/g, '')
    .replace(/百分之\s*[-+]?\d+(?:\.\d+)?/g, '').replace(/[¥￥]\s*\d[\d,]*(?:\.\d+)?\s*万?|\d[\d,]*(?:\.\d+)?\s*万?元/g, '')
    .replace(/近(?:1年|3个月)/g, '')
  if (/\d/.test(scrubbed)) errors.push('unattributed_number')
  // Cross-candidate text must not be used to smuggle someone else's metric into this note.
  if (/候选/.test(text)) errors.push('cross_candidate_text')
  return [...new Set(errors)]
}
function matchingCandidates(candidates: AdviceCandidate[], input: AdviceRequest, riskRating: string, amountCents: number) {
  const rank = (r: string) => Number(r.slice(1))
  return candidates.filter((c) => rank(c.riskRating) <= rank(riskRating) && c.minCents <= amountCents)
    .filter((c) => input.horizon !== 'within_3m' || (rank(c.riskRating) <= 2 && c.termDays < 90))
    .filter((c) => input.liquidity !== 'anytime' || (c.kind === 'bank' && c.termDays === 0))
    .filter((c) => !input.assetClasses?.length || input.assetClasses.includes(c.kind === 'bank' ? 'bank_wealth' : c.investmentProfile?.assetClass!))
    .filter((c) => !input.styles?.length || (!!c.investmentProfile && input.styles.includes(c.investmentProfile.style)))
    .filter((c) => !c.investmentProfile || !input.avoidStyles?.includes(c.investmentProfile.style))
    .filter((c) => input.maxDrawdownPct === undefined || (c.metrics.maxDrawdownPct !== null && c.metrics.maxDrawdownPct <= input.maxDrawdownPct))
    .filter((c) => !c.investmentProfile || c.investmentProfile.suggestedHorizonDays <= ({ within_3m: 90, '3_12m': 365, '1_3y': 1095, over_3y: Infinity, unknown: 0 }[input.horizon]))
}
export function rankCandidates(candidates: AdviceCandidate[], input: AdviceRequest, riskRating: string, amountCents: number) {
  const rank = (r: string) => Number(r.slice(1))
  const suitable = matchingCandidates(candidates, input, riskRating, amountCents)
  const score = (c: AdviceCandidate) => input.preference === 'preserve' ? -(c.metrics.maxDrawdownPct ?? (c.kind === 'bank' ? rank(c.riskRating) : 100))
    : input.preference === 'growth' ? c.metrics.return1yPct ?? c.expectedYieldPct ?? -100
    : (c.metrics.return1yPct ?? c.expectedYieldPct ?? 0) / Math.max(1, c.metrics.volatilityPct ?? rank(c.riskRating))
  const sorted = suitable.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))
  if (input.preference !== 'balanced' || input.styles?.length || input.assetClasses?.length) return sorted.slice(0, 5)
  // Give a balanced request different eligible directions to compare, rather than
  // five share classes of the same theme. This is not a correlation guarantee.
  const selected: AdviceCandidate[] = [], classes = new Set<string>(), styles = new Set<string>()
  for (const c of sorted) {
    const asset = c.kind === 'bank' ? 'bank_wealth' : c.investmentProfile?.assetClass ?? 'unknown'
    if (!classes.has(asset) && selected.length < 3) { selected.push(c); classes.add(asset); styles.add(c.investmentProfile?.style ?? asset) }
  }
  for (const c of sorted) if (!selected.includes(c) && !styles.has(c.investmentProfile?.style ?? c.kind) && selected.length < 5) { selected.push(c); styles.add(c.investmentProfile?.style ?? c.kind) }
  for (const c of sorted) if (!selected.includes(c) && selected.length < 5) selected.push(c)
  return selected
}
export function modelAdviceInput(candidates: AdviceCandidate[], budget: AdviceBudget, input: AdviceRequest, conflicts: string[]) {
  return { budget, needs: { horizon: input.horizon, liquidity: input.liquidity, preference: input.preference, purpose: input.purpose, targetReturnPct: input.targetReturnPct ?? null,
    assetClasses: input.assetClasses ?? [], styles: input.styles ?? [], avoidStyles: input.avoidStyles ?? [], maxDrawdownPct: input.maxDrawdownPct ?? null }, conflicts,
    candidates: candidates.map((c, i) => ({ alias: `候选${i + 1}`, kind: c.kind, riskRating: c.riskRating, minCents: c.minCents,
      termDays: c.termDays, expectedYieldPct: c.expectedYieldPct, metrics: c.metrics, investmentProfile: c.investmentProfile ? { assetClass: c.investmentProfile.assetClass, style: c.investmentProfile.style, suggestedHorizonDays: c.investmentProfile.suggestedHorizonDays } : null })) }
}
type Writer = (input: ReturnType<typeof modelAdviceInput>) => Promise<unknown>
const defaultWriter: Writer = async (input) => {
  const result = await generateText({ model: agentModel(), abortSignal: AbortSignal.timeout(8000), temperature: .1, maxOutputTokens: 650,
    providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
    system: '你是只读理财说明器。只能从已筛选候选中挑1至3项，不改变风险、预算或排名计算。输入没有名称，禁止猜名称。只输出JSON：{"picks":[{"candidate":"候选1","role":"core","reasons":["risk_matched"],"note":"理由"}],"summary":"说明","conflictNotes":[]}。reasons只允许risk_matched,lower_drawdown,diversification,long_horizon,liquidity,historical_return,preference_matched。note仅解释该候选，可引用该候选指标和预算内的金额；summary和conflictNotes只写定性文字，不写数字。不承诺未来收益，不声称执行交易。不需要提供配置比例。',
    prompt: JSON.stringify(input),
  })
  return JSON.parse(result.text.trim())
}
export async function describeAdvice(candidates: AdviceCandidate[], budget: AdviceBudget, input: AdviceRequest, conflicts: string[], writer: Writer = defaultWriter) {
  const fallback = () => ({ source: 'rule' as const, summary: '已按风险、预算和资金使用期限筛选。历史业绩不代表未来收益；本建议不会发起交易。',
    picks: candidates.slice(0, 3).map((c, i) => ({ ...c, alias: `候选${i + 1}`, role: i ? 'alternative' : 'core', reasons: ['risk_matched', 'preference_matched'], note: `${c.investmentProfile ? `方向：${STYLE_LABELS[c.investmentProfile.style]}。` : ''}已匹配风险、起购额及已声明的偏好；建议观察期限不是合同锁定期，历史回撤不保证未来损失上限。` })), conflictNotes: [] as string[] })
  if (!candidates.length) return fallback()
  try {
    const data = ModelAdvice.parse(await writer(modelAdviceInput(candidates, budget, input, conflicts))), used = new Set<string>()
    if (expertTextViolations(data.summary, budget).length || data.conflictNotes.some((n) => expertTextViolations(n, budget).length)) throw new Error('EXPERT_UNSUPPORTED_TEXT')
    const picks = data.picks.map((p) => {
      const candidate = candidates[Number(p.candidate.slice(2)) - 1]
      if (!candidate || used.has(p.candidate) || expertTextViolations(p.note, budget, candidate).length) throw new Error('EXPERT_UNSUPPORTED_PICK')
      used.add(p.candidate)
      return { ...candidate, alias: p.candidate, role: p.role, reasons: p.reasons, note: p.note }
    })
    return { source: 'ai' as const, summary: data.summary, picks, conflictNotes: data.conflictNotes }
  } catch { return fallback() }
}
export async function getWealthAdvice(ctx: AgentContext, input: AdviceRequest, now: Date, writer?: Writer) {
  if (input.amountYuan !== undefined && !requestedAmounts(ctx.requestText ?? '').some((n) => Math.round(n * 100) === Math.round(input.amountYuan! * 100))) throw new Error('投资金额必须来自当前用户请求，不能由模型猜测')
  if (input.targetReturnPct !== undefined && !percentageTokens(ctx.requestText ?? '').includes(input.targetReturnPct)) throw new Error('目标收益必须来自当前用户请求')
  if (input.maxDrawdownPct !== undefined && !percentageTokens(ctx.requestText ?? '').includes(input.maxDrawdownPct)) throw new Error('最大回撤偏好必须来自当前用户请求')
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, ctx.userId))
  const assessed = user?.riskAssessedAt ? new Date(user.riskAssessedAt).getTime() : NaN
  if (!Number.isFinite(assessed) || assessed > now.getTime() || now.getTime() - assessed > 365 * 86400_000) return { status: 'needs_risk_assessment', message: '请先使用标准风险测评问卷完成测评，再生成理财建议。', picks: [] }
  if (input.horizon === 'unknown' || input.liquidity === 'unknown') return { status: 'needs_information', message: '请补充投资期限与流动性需求。可通过选择题问卷收集，问卷不执行交易。', picks: [] }
  const { metrics } = await computeProfile(ctx.userId, now)
  const cards = await userCards(ctx.userId)
  const cashCents = cards.filter((c) => c.kind === 'debit' && c.status === 'active').reduce((n, c) => n + c.balanceCents, 0)
  const debtCents = cards.filter((c) => c.kind === 'credit').reduce((n, c) => n + c.outstandingCents, 0)
  const reserveCents = metrics.monthlyExpenseCents * 6
  const investableCents = Math.max(0, cashCents - reserveCents - debtCents)
  const budget = { monthlyExpenseCents: metrics.monthlyExpenseCents, reserveCents, investableCents,
    amountCents: Math.min(investableCents, input.amountYuan === undefined ? investableCents : Math.round(input.amountYuan * 100)), monthsObserved: metrics.monthsObserved }
  const conflicts: string[] = []
  if (input.amountYuan !== undefined && Math.round(input.amountYuan * 100) > investableCents) conflicts.push('amount_exceeds_investable')
  if (input.horizon === 'within_3m' && input.preference === 'growth') conflicts.push('short_horizon_growth')
  if (input.liquidity === 'anytime' && input.preference === 'growth') conflicts.push('liquidity_growth')
  if (input.preference === 'growth' && Number(user!.riskRating.slice(1)) <= 2) conflicts.push('growth_risk_mismatch')
  if (input.styles?.some((s) => input.avoidStyles?.includes(s))) conflicts.push('style_conflict')
  if (metrics.monthsObserved < 3) return { status: 'insufficient_history', message: '完整月份支出数据不足三个月，暂不自动估算可投资额度。请先完善收支信息。', budget, conflicts, picks: [] }
  const funds = await listFunds(now), bankProducts = await db.select().from(schema.products)
  const candidates: AdviceCandidate[] = bankProducts.map((p) => ({ id: p.id, kind: 'bank', name: p.name, riskRating: p.riskRating,
    minCents: p.minAmountCents, termDays: p.termDays, expectedYieldPct: Math.round(p.expectedYield * 10000) / 100,
    metrics: fundMetrics([]), source: 'bank_catalog', asOf: null }))
  const evaluated: { candidate: AdviceCandidate; fund: typeof funds[number] }[] = []
  for (const fund of funds) {
    const candidate: AdviceCandidate = { id: fund.code, kind: 'fund', name: fund.name, riskRating: fund.riskRating, minCents: fund.minPurchaseCents,
      termDays: 0, expectedYieldPct: null, metrics: fundMetrics([]), source: fund.source, asOf: fund.navDate, investmentProfile: fund.investmentProfile }
    // Reject metadata mismatches before loading long NAV histories. Missing risk
    // statistics are never used to satisfy a caller's explicit drawdown limit.
    if (!matchingCandidates([candidate], { ...input, maxDrawdownPct: undefined }, user!.riskRating, budget.amountCents).length) continue
    candidate.metrics = fundMetrics(await fundNavs(fund.code, now))
    evaluated.push({ candidate, fund })
    if (fund.enabled && !fund.stale && fund.purchaseStatus === 'open') candidates.push(candidate)
  }
  const selected = rankCandidates(candidates, input, user!.riskRating, budget.amountCents)
  const matchedIds = new Set(matchingCandidates(evaluated.map((r) => r.candidate), input, user!.riskRating, budget.amountCents).map((c) => c.id))
  const unavailableMatches = evaluated.filter(({ fund }) => matchedIds.has(fund.code) && (fund.purchaseStatus !== 'open' || !fund.enabled || fund.stale))
    .map(({ fund: f }) => ({ code: f.code, name: f.name, purchaseStatus: f.purchaseStatus, stale: f.stale, enabled: f.enabled, investmentProfile: f.investmentProfile }))
  if (!selected.length) conflicts.push(unavailableMatches.length ? 'matching_products_unavailable' : 'no_preference_match')
  const bestHistorical = Math.max(...selected.map((c) => c.metrics.return1yPct ?? -Infinity))
  if (input.targetReturnPct !== undefined && (bestHistorical === -Infinity || input.targetReturnPct > bestHistorical)) conflicts.push('target_not_supported_by_history')
  const text = await describeAdvice(selected, budget, input, conflicts, writer)
  const result = { status: selected.length ? 'advice' : 'no_suitable_candidates', ...text, budget, conflicts, asOf: now.toISOString(),
    riskRating: user!.riskRating, unavailableMatches, requestedPreferences: { assetClasses: input.assetClasses ?? [], styles: input.styles ?? [], avoidStyles: input.avoidStyles ?? [], maxDrawdownPct: input.maxDrawdownPct ?? null },
    disclaimer: '模拟银行理财建议；风险等级及观察期限由人工维护，不是正式评级或合同锁定期。基金净值为公开历史数据，历史业绩及历史回撤不代表未来收益或损失上限；申购须另行确认与强验证。' }
  await audit(ctx, 'wealth_advice', { source: text.source, candidateIds: selected.map((c) => c.id), pickedIds: text.picks.map((p) => p.id), budget, conflicts, preferences: result.requestedPreferences })
  return result
}
