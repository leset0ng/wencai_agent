import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '#/components/ui/button'
import { PaymentApproval } from './PaymentCenter'
import type { DashboardData } from '#/lib/dashboard'
import type { ToolOutcome } from '#/server/tools/define'
import type { listFunds, fundDetails } from '#/server/funds/store'
import type { fundPortfolio } from '#/server/funds/trading'
import type { getWealthAdvice } from '#/server/funds/advice'
import './funds.css'
import { ASSET_LABELS, STYLE_LABELS } from '#/lib/fund-preferences'

type Fund = Awaited<ReturnType<typeof listFunds>>[number]
type Portfolio = Awaited<ReturnType<typeof fundPortfolio>>
const yuan = (cents: number) => `¥${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const source = (s: string) => s === 'fixture' ? '离线快照' : s === 'eastmoney' ? '天天基金缓存' : s === 'eastmoney_json' ? '东方财富JSON兜底' : 'Tushare缓存'
export function FundList({ funds, onChoose }: { funds: Fund[]; onChoose?: (code: string) => void }) {
  return <div className="fund-list">{funds.map((f) => <article className="fund-item" key={f.code}>
    <h3>{f.name} <small>{f.code} · {f.riskRating}</small></h3>
    <p>公布净值 <strong>{f.unitNav?.toFixed(4) ?? '暂无'}</strong> · {f.navDate ?? '无日期'}</p>
    <p>{source(f.source)} · {f.stale ? '数据过期，暂停新申购' : f.purchaseStatus === 'open' && f.enabled ? '可申购' : '暂停、限额或待复核'}{f.syncError ? ' · 联网刷新失败，保留缓存' : ''}</p>
    {onChoose && <Button className="bank-payment-secondary" onClick={() => onChoose(f.code)}>查看详情</Button>}
  </article>)}</div>
}
export function FundPortfolio({ data }: { data: Portfolio }) {
  return <div className="fund-portfolio"><h3>基金资产 {yuan(data.marketValueCents + data.pendingCents)}</h3>
    <p>已确认估值 {yuan(data.marketValueCents)} · 已扣款待确认 {yuan(data.pendingCents)}</p>
    {data.positions.map((p) => <p key={p.code}><strong>{p.name}</strong> · {(p.sharesE2 / 100).toFixed(2)}份 · {yuan(p.marketValueCents)} · 净值日 {p.navDate ?? '无'}{p.stale ? '（过期估值）' : ''}</p>)}
    {data.orders.slice(0, 10).map((o) => <p key={o.id}>{o.code} · {yuan(o.amountCents)} · {o.status === 'submitted' ? '已扣款，待净值确认' : o.status === 'confirmed' ? '份额已确认' : '已撤销退款'} · 交易日 {o.tradeDate}{o.navDate ? ` · 成交净值日 ${o.navDate}` : ''}</p>)}
  </div>
}
const conflicts: Record<string, string> = { amount_exceeds_investable: '申请金额超过可投资额度，已按额度筛选。', short_horizon_growth: '短期用款与追求增长存在冲突。', liquidity_growth: '随时可用与追求增长存在冲突；基金赎回不能承诺即时到账。', growth_risk_mismatch: '增长偏好超过当前风险承受等级。', target_not_supported_by_history: '当前候选历史业绩不能支持目标收益，未来收益也不作保证。', style_conflict: '偏好与排除项包含同一风格，请核对。', matching_products_unavailable: '符合方向的产品当前暂停、限额或数据过期，仅列为观察清单，未当作可申购候选。', no_preference_match: '当前没有同时满足风险、期限、预算与偏好的可申购产品，未自动放宽条件。' }
export function AdviceCard({ data, onAsk }: { data: Awaited<ReturnType<typeof getWealthAdvice>>; onAsk?: (text: string) => void }) {
  return <article className="fund-advice"><h3>理财专家</h3>{'message' in data ? <p>{data.message}</p> : <>
    <p>{data.summary}</p><p>月均支出 <strong>{yuan(data.budget.monthlyExpenseCents)}</strong> · 生活备用金 {yuan(data.budget.reserveCents)} · 可投资 <strong>{yuan(data.budget.investableCents)}</strong></p>
    {Number.isFinite(data.budget.amountCents) && <p>本次建议预算 <strong>{yuan(data.budget.amountCents)}</strong>{data.riskRating ? ` · 你的风险等级 ${data.riskRating}` : ''}</p>}
    {data.requestedPreferences && <p>偏好方向：{data.requestedPreferences.assetClasses.map((a) => ASSET_LABELS[a]).join('、') || '未限定'} · 风格：{data.requestedPreferences.styles.map((s) => STYLE_LABELS[s]).join('、') || '未限定'}{data.requestedPreferences.avoidStyles.length ? ` · 排除：${data.requestedPreferences.avoidStyles.map((s) => STYLE_LABELS[s]).join('、')}` : ''}</p>}
    {data.conflicts.map((c) => <p className="fund-warning" key={c}>{conflicts[c] ?? c}</p>)}
    {data.picks.map((p) => <div className="fund-item" key={p.id}><h4>{p.name} · {p.riskRating}</h4><p>{p.note}</p><p>近一年历史收益 {p.metrics.return1yPct === null ? '数据不足' : `${p.metrics.return1yPct}%`} · 最大回撤 {p.metrics.maxDrawdownPct === null ? '数据不足' : `${p.metrics.maxDrawdownPct}%`}</p><small>{p.kind === 'fund' ? `${source(p.source)} · ${p.asOf}` : '银行理财目录 · 预期年化非收益承诺'}</small>
      {onAsk && <Button className="bank-payment-secondary" onClick={() => onAsk(`请查询${p.kind === 'fund' ? '基金' : '银行理财产品'}「${p.name}」（${p.kind === 'fund' ? '基金代码' : '产品编号'}${p.id}）的详情、风险、起购金额与流动性。仅查询，不执行交易。`)}>查看详情</Button>}</div>)}
    {!data.picks.length && <p>当前条件下没有合适候选，请调整期限、流动性需求或预算。</p>}<small>{data.disclaimer} · 文案来源：{data.source === 'ai' ? '经核验的模型说明' : '代码文案'}</small>
    {!!data.unavailableMatches?.length && <details><summary>暂不可申购的匹配产品（只读）</summary>{data.unavailableMatches.map((p) => <p key={p.code}>{p.name} · {p.stale ? '净值过期' : !p.enabled ? '待人工复核' : p.purchaseStatus === 'limited' ? '限额，当前模拟渠道暂停新申购' : '暂停申购'}</p>)}</details>}
  </>}</article>
}
export function FundPanel({ dashboard, onAgent }: { dashboard: DashboardData; onAgent: (text: string) => void }) {
  const [open, setOpen] = useState(false), [code, setCode] = useState(''), [amount, setAmount] = useState(''), [accountId, setAccountId] = useState('')
  const [pending, setPending] = useState<Extract<ToolOutcome, { status: 'needs_confirmation' }>>(), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const cache = useQueryClient()
  const query = useQuery({ queryKey: ['funds'], enabled: open, queryFn: async () => {
    const response = await fetch('/api/payments?view=funds'); if (!response.ok) throw new Error('基金数据暂不可用')
    return response.json() as Promise<{ funds: Fund[]; portfolio: Portfolio }>
  } })
  const detail = useQuery({ queryKey: ['fund', code], enabled: open && !!code, queryFn: async () => {
    const response = await fetch(`/api/payments?view=funds&code=${code}`); if (!response.ok) throw new Error('基金详情暂不可用')
    return response.json() as Promise<Awaited<ReturnType<typeof fundDetails>> & { metrics: { return1yPct: number | null; maxDrawdownPct: number | null } }>
  } })
  async function buy() {
    setBusy(true); setError('')
    try {
      const value = Number(amount)
      if (!/^\d+(?:\.\d{1,2})?$/.test(amount) || value <= 0 || !accountId) throw new Error('请选择付款卡并填写有效金额（最多两位小数）')
      const args = { code, fromAccountId: accountId, amountCents: Math.round(value * 100) }
      const post = async (tool: string, args: object) => {
        const response = await fetch('/api/payments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool, args }) })
        const body = await response.json(); if (!response.ok || body.status === 'error') throw new Error(body.error ?? body.message ?? '操作失败'); return body
      }
      const preview = await post('preview_fund_order', args)
      if (preview.status !== 'done') throw new Error('请先完成风险测评或检查账户状态')
      const result = await post('commit_fund_order', { ...args, confirmationToken: preview.data.confirmationToken })
      if (result.status !== 'needs_confirmation') throw new Error(result.reasons?.join('；') ?? '未生成确认单')
      setPending(result)
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败') } finally { setBusy(false) }
  }
  return <section className="fund-panel"><div className="bank-section-heading"><h2>基金与理财</h2><Button className="bank-text-button" onClick={() => setOpen(!open)}>{open ? '收起' : '查看基金'}</Button><Button className="bank-text-button" onClick={() => onAgent('请作为理财专家帮我规划可投资资金，先询问我的投资期限、流动性和偏好，再用get_wealth_advice生成建议。仅建议，不下单。')}>问理财专家</Button></div>
    {open && <><small>公开净值数据 · 模拟银行记账；人工维护演示适当性等级。下单时价格未知，等待公布净值确认（通常T+1，QDII可能更晚）。</small>{query.isPending && <p>正在读取缓存…</p>}{query.error && <p role="alert">{query.error.message}</p>}
      {query.data && <><FundList funds={query.data.funds} onChoose={(next) => { setCode(next); setPending(undefined); setError('') }} /><FundPortfolio data={query.data.portfolio} /></>}
      {detail.data && <div className="fund-item"><h3>{detail.data.name}</h3><p>起购 {yuan(detail.data.minPurchaseCents)} · 申购费率 {(detail.data.purchaseFeeBp / 100).toFixed(2)}% · 近一年历史收益 {detail.data.metrics.return1yPct ?? '数据不足'}{detail.data.metrics.return1yPct === null ? '' : '%'}</p>
        {pending ? <PaymentApproval pending={pending} onBack={() => setPending(undefined)} onComplete={() => { setPending(undefined); void cache.invalidateQueries({ queryKey: ['funds'] }); void cache.invalidateQueries({ queryKey: ['dashboard'] }); setError('申购已提交并扣款，待净值公布后确认份额。') }} /> : <div className="fund-buy"><label>付款储蓄卡<select value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">请选择</option>{dashboard.cards.filter((c) => c.kind === 'debit' && c.status === 'active').map((c) => <option key={c.id} value={c.accountId}>{c.accountName} · 尾号{c.last4}</option>)}</select></label><label>申购金额（元）<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></label><Button className="bank-primary" disabled={busy || detail.data.stale || !detail.data.enabled || detail.data.purchaseStatus !== 'open'} onClick={() => void buy()}>{busy ? '正在校验…' : '生成申购确认单'}</Button></div>}
      </div>}{detail.error && <p role="alert">{detail.error.message}</p>}{error && <p role="status">{error}</p>}</>}
  </section>
}
