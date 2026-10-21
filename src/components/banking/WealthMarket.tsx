import { useEffect, useId, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowDown, ArrowUp, ChevronRight, Filter, Search, Star, X } from 'lucide-react'
import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/Sheet'
import { AgentAvatar } from './AgentAvatar'
import { FundPanel } from './FundPanel'
import type { DashboardData } from '#/lib/dashboard'
import { METRIC_LABELS, PERIOD_LABELS, PERIOD_TITLES, RANK_METRICS, WEALTH_PERIODS, type RankMetric, type WealthMarket as MarketData, type WealthMetrics, type WealthPeriod, type WealthRow } from '#/lib/wealth'
import type { getFundAnalytics } from '#/server/funds/market'
import './wealth.css'

type Details = Awaited<ReturnType<typeof getFundAnalytics>>
const pct = (n: number | null, sign = false) => n === null ? '—' : `${sign && n > 0 ? '+' : ''}${n.toFixed(2)}%`
const number = (n: number | null) => n === null ? '—' : n.toFixed(2)
const category = (s: string) => s === 'bond' ? '债券型基金' : s === 'index' ? '指数基金' : '股票型基金'
const sourceName = (s: string) => s === 'fixture' ? '离线公开快照' : s === 'eastmoney_json' ? '东方财富历史JSON兜底' : s === 'eastmoney' ? '天天基金 / 东方财富' : 'Tushare'
const colorClass = (n: number | null) => n === null || n === 0 ? '' : n > 0 ? 'wealth-up' : 'wealth-down'

/** Code-backed series only; normalizing a comparison never changes the ranking metrics. */
export function WealthChart({ rows, small = false, chartKey = '' }: { rows: Pick<WealthRow, 'code' | 'name' | 'metrics'>[]; small?: boolean; chartKey?: string }) {
  const id = useId().replace(/:/g, ''), reduce = useReducedMotion()
  const starts = rows.flatMap((r) => r.metrics.points.length ? [r.metrics.points[0].date] : [])
  const commonStart = starts.sort().at(-1)
  const series = rows.map((r) => {
    const points = r.metrics.points.filter((p) => !commonStart || p.date >= commonStart)
    return { ...r, points: points.map((p) => ({ date: p.date, value: p.value / (points[0]?.value ?? 100) * 100 })) }
  }).filter((r) => r.points.length > 1)
  if (!series.length) return <div className={small ? 'wealth-spark-empty' : 'wealth-chart-empty'}>{small ? '—' : '当前周期历史不足，暂无可比较曲线'}</div>
  const width = small ? 180 : 760, height = small ? 48 : 250
  const left = small ? 0 : 52, right = small ? 0 : 60, top = small ? 3 : 18, bottom = small ? 0 : 34
  const all = series.flatMap((r) => r.points), times = all.map((p) => Date.parse(p.date))
  const start = Math.min(...times), end = Math.max(...times)
  const values = all.map((p) => p.value), min = Math.min(...values), max = Math.max(...values), pad = Math.max(.5, (max - min) * .15)
  const low = min - pad, high = max + pad
  const x = (date: string) => left + (Date.parse(date) - start) / Math.max(86400_000, end - start) * (width - left - right)
  const y = (value: number) => top + (high - value) / (high - low) * (height - top - bottom)
  return <div className={small ? 'wealth-spark' : 'wealth-chart'}>
    {!small && <div className="wealth-chart-heading"><div><h2>净值走势对比</h2><small>以 {new Date(start).toISOString().slice(0, 10)} 附近共同起点归一为100</small></div><div className="wealth-chart-legend">{series.map((r, i) => <span key={r.code}><i style={{ background: `var(--wealth-line-${i % 3})` }} />{r.name}</span>)}</div></div>}
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={small ? '历史净值趋势' : '复利净值归一对比曲线'} preserveAspectRatio={small ? 'none' : 'xMidYMid meet'}>
      <defs>{series.map((r, i) => <linearGradient key={r.code} id={`${id}-${i}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={`var(--wealth-line-${i % 3})`} stopOpacity=".32" /><stop offset="100%" stopColor={`var(--wealth-line-${i % 3})`} stopOpacity=".02" /></linearGradient>)}</defs>
      {!small && Array.from({ length: 5 }, (_, i) => { const v = low + (high - low) * i / 4; return <g key={i}><line x1={left} x2={width - right} y1={y(v)} y2={y(v)} className="wealth-gridline" /><text x={left - 10} y={y(v) + 4} textAnchor="end">{v.toFixed(1)}</text></g> })}
      {!small && Array.from({ length: 5 }, (_, i) => { const time = start + (end - start) * i / 4, date = new Date(time).toISOString().slice(0, 10); return <text key={i} x={x(date)} y={height - 9} textAnchor="middle">{end - start < 45 * 86400_000 ? date.slice(5) : date.slice(0, 7)}</text> })}
      {series.map((r, i) => {
        const d = r.points.map((p, index) => `${index ? 'L' : 'M'}${x(p.date).toFixed(2)},${y(p.value).toFixed(2)}`).join(' '), first = r.points[0], last = r.points[r.points.length - 1]
        return <g key={`${chartKey}-${r.code}`}><path d={`${d} L${x(last.date)},${height - bottom} L${x(first.date)},${height - bottom} Z`} fill={`url(#${id}-${i})`} />
          <motion.path d={d} fill="none" stroke={`var(--wealth-line-${i % 3})`} strokeWidth={small ? 2 : 2.8} strokeLinejoin="round" initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: .85, ease: 'easeOut' }} />
          {!small && <><circle cx={x(last.date)} cy={y(last.value)} r="4" fill={`var(--wealth-line-${i % 3})`} stroke="white" strokeWidth="1.5" /><text x={x(last.date) + 8} y={y(last.value) + 4} className="wealth-chart-end">{last.value.toFixed(2)}</text></>}
        </g>
      })}
    </svg>
  </div>
}
function MetricStrip({ metrics, period }: { metrics: WealthMetrics; period: WealthPeriod }) {
  return <div className="wealth-metric-strip"><div><span>{PERIOD_TITLES[period]}涨跌幅</span><strong className={colorClass(metrics.returnPct)}>{pct(metrics.returnPct, true)}</strong></div><div><span>夏普率</span><strong>{number(metrics.sharpe)}</strong></div><div><span>最大回撤</span><strong>{pct(metrics.maxDrawdownPct === null ? null : -metrics.maxDrawdownPct)}</strong></div></div>
}
export function WealthMetricsCard({ data }: { data: Details }) {
  return <div className="wealth-detail-table"><h3>{data.name} · 指标详情</h3><p>{sourceName(data.source)} · 净值日 {data.navDate ?? '暂无'} · 风险 {data.riskRating}</p><div className="wealth-table-scroll"><table><thead><tr><th>周期</th><th>涨跌幅</th><th>夏普率</th><th>最大回撤</th><th>年化波动</th><th>年化收益</th><th>卡玛率</th><th>样本数</th></tr></thead><tbody>{WEALTH_PERIODS.map((p) => { const m = data.periods[p]; return <tr key={p}><td>{PERIOD_LABELS[p]}</td><td className={colorClass(m.returnPct)}>{pct(m.returnPct, true)}</td><td>{number(m.sharpe)}</td><td>{pct(m.maxDrawdownPct === null ? null : -m.maxDrawdownPct)}</td><td>{pct(m.volatilityPct)}</td><td>{pct(m.annualizedReturnPct, true)}</td><td>{number(m.calmar)}</td><td>{m.observations}</td></tr> })}</tbody></table></div><p>{data.methodology.note}</p><p>“—”表示数据不足或该周期不适合计算，不代表0。完整区间与指标口径由服务端统一校验。</p></div>
}
export function WealthRankCard({ data, onAsk }: { data: MarketData; onAsk?: (text: string) => void }) {
  return <div className="wealth-agent-rank"><h3>{PERIOD_TITLES[data.period]}产品排行</h3><p>白名单内 {data.universeCount} 只 · 按{METRIC_LABELS[data.sortBy]}{data.direction === 'desc' ? '降序' : '升序'}</p>{data.items.map((r) => <article key={r.code}><strong>{r.rank ?? '—'} · {r.name}</strong><MetricStrip metrics={r.metrics} period={data.period} />{onAsk && <Button className="bank-payment-secondary" onClick={() => onAsk(`请查询基金「${r.name}」（代码${r.code}）的${PERIOD_TITLES[data.period]}涨跌幅、夏普率、最大回撤和各周期指标，说明计算口径和净值日期。仅查询，不交易。`)}>指标详情</Button>}</article>)}</div>
}
export function WealthMarket({ dashboard, userId, onAgent, portalContainer, onModalChange }: { dashboard: DashboardData; userId: string; onAgent: (text: string) => void; portalContainer: HTMLElement | null; onModalChange: (open: boolean) => void }) {
  const [period, setPeriod] = useState<WealthPeriod>('1y'), [sortBy, setSortBy] = useState<RankMetric>('returnPct'), [direction, setDirection] = useState<'asc' | 'desc'>('desc')
  const [tab, setTab] = useState('all'), [search, setSearch] = useState(''), [institution, setInstitution] = useState(''), [riskMax, setRiskMax] = useState('5'), [filters, setFilters] = useState(false)
  const [selected, setSelected] = useState<string[]>([]), [focusCode, setFocusCode] = useState(''), [detailCode, setDetailCode] = useState(''), [portfolio, setPortfolio] = useState(false), [error, setError] = useState('')
  const cache = useQueryClient()
  const query = useQuery({ queryKey: ['wealth', userId, period, sortBy, direction, tab, search, institution, riskMax], staleTime: 30000, refetchInterval: 60000, queryFn: async ({ signal }) => {
    const params = new URLSearchParams({ view: 'wealth', period, sortBy, direction, category: tab, search, institution, riskMax })
    const res = await fetch(`/api/payments?${params}`, { signal }); if (!res.ok) throw new Error('理财数据暂不可用，请稍后重试')
    return res.json() as Promise<MarketData>
  } })
  const details = useQuery({ queryKey: ['fund-metrics', detailCode], enabled: !!detailCode, queryFn: async () => { const res = await fetch(`/api/payments?view=wealth&code=${detailCode}`); if (!res.ok) throw new Error('无法读取指标'); return res.json() as Promise<Details> } })
  useEffect(() => { onModalChange(!!detailCode); return () => onModalChange(false) }, [detailCode, onModalChange])
  const rows = query.data?.items ?? [], focused = rows.find((r) => r.code === focusCode) ?? rows[0]
  const compared = useMemo(() => { const chosen = rows.filter((r) => selected.includes(r.code)); return chosen.length ? chosen : rows.slice(0, 2) }, [rows, selected])
  function compare(code: string) { setSelected((old) => { const active = old.length ? old : rows.slice(0, 2).map((r) => r.code); const next = active.includes(code) ? active.filter((c) => c !== code) : active.length < 3 ? [...active, code] : active; return next.length ? next : [code] }); setFocusCode(code) }
  async function favorite(row: WealthRow) {
    setError('')
    try { const res = await fetch('/api/payments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preference: 'fund_watchlist', code: row.code, favorite: !row.favorite }) }); const data = await res.json(); if (!res.ok || data.status !== 'done') throw new Error(data.error ?? data.message ?? '自选修改失败'); await cache.invalidateQueries({ queryKey: ['wealth'] }) }
    catch (e) { setError(e instanceof Error ? e.message : '自选修改失败') }
  }
  const sort = (next: RankMetric) => { if (sortBy === next) setDirection(direction === 'desc' ? 'asc' : 'desc'); else { setSortBy(next); setDirection(next === 'maxDrawdownPct' || next === 'volatilityPct' ? 'asc' : 'desc') } }
  const ask = () => onAgent('请作为理财专家先了解我的投资期限、流动性和风险偏好，再用get_wealth_advice提供建议；需要对比数据时使用rank_funds和get_fund_metrics。仅查询和建议，不下单。')
  const periods = <>{WEALTH_PERIODS.map((p) => <Button key={p} className={`wealth-period${period === p ? ' is-active' : ''}`} aria-pressed={period === p} onClick={() => setPeriod(p)}>{PERIOD_LABELS[p]}</Button>)}</>
  return <section className="wealth-page">
    <div className="wealth-heading"><div><h1>理财</h1><p>基金与债券，指标一目了然</p></div><Button className="wealth-agent" onClick={ask}><AgentAvatar small />问文财</Button><Button className="wealth-portfolio-toggle" onClick={() => setPortfolio(!portfolio)}>我的理财</Button></div>
    <div className="wealth-toolbar"><label className="wealth-search"><Search size={21} /><input aria-label="搜索产品或机构" placeholder="搜索产品或机构" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
      <div className="wealth-categories" role="group" aria-label="理财分类">{[['all', '全部'], ['fund', '基金'], ['bond', '债券'], ['favorites', '自选']].map(([id, label]) => <Button key={id} aria-pressed={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}>{label}</Button>)}</div>
      <div className="wealth-periods wealth-desktop-periods" role="group" aria-label="排行周期">{periods}</div>
      <label className="wealth-institution"><span>机构：</span><select aria-label="管理机构" value={institution} onChange={(e) => setInstitution(e.target.value)}><option value="">全部</option>{query.data?.institutions.map((s) => <option key={s}>{s}</option>)}</select></label>
      <label className="wealth-sort"><span>排序指标：</span><select aria-label="排序指标" value={sortBy} onChange={(e) => { setSortBy(e.target.value as RankMetric); setDirection(e.target.value === 'maxDrawdownPct' || e.target.value === 'volatilityPct' ? 'asc' : 'desc') }}>{RANK_METRICS.map((m) => <option key={m} value={m}>{METRIC_LABELS[m]}</option>)}</select><Button className="" aria-label="切换排序方向" onClick={() => setDirection(direction === 'desc' ? 'asc' : 'desc')}>{direction === 'desc' ? <ArrowDown size={16} /> : <ArrowUp size={16} />}</Button></label>
    </div>
    {error && <p role="alert">{error}</p>}{query.error && <p role="alert">{query.error.message}</p>}{query.isPending && <p className="wealth-loading">正在读取已校验净值与指标…</p>}
    {query.data && <><div className="wealth-overview"><div className="wealth-panel wealth-comparison"><WealthChart rows={compared} chartKey={period} /></div><article className="wealth-panel wealth-focus">{focused ? <><div className="wealth-focus-heading"><div><h2>{focused.name}</h2><p>{focused.institution} · {category(focused.category)}</p></div><Button className={focused.favorite ? 'is-favorite' : ''} onClick={() => void favorite(focused)}><Star size={17} fill={focused.favorite ? 'currentColor' : 'none'} />{focused.favorite ? '已自选' : '加入自选'}</Button><Button className="" onClick={() => setDetailCode(focused.code)}>指标详情</Button></div><MetricStrip metrics={focused.metrics} period={period} /><dl><div><dt>产品类型</dt><dd>{category(focused.category)}</dd></div><div><dt>基金规模</dt><dd>{focused.scaleYiYuan === null ? '暂无数据' : `${focused.scaleYiYuan.toFixed(2)}亿元`}</dd></div><div><dt>成立日期</dt><dd>{focused.inceptionDate ?? '暂无数据'}</dd></div><div><dt>管理机构</dt><dd>{focused.institution}</dd></div></dl><small>净值日 {focused.navDate} · 规模日 {focused.scaleDate ?? '暂无'} · {sourceName(focused.source)}{focused.stale ? ' · 净值过期' : ''}</small></> : <p>暂无符合条件的产品</p>}</article></div>
      <div className="wealth-panel wealth-ranking"><div className="wealth-ranking-heading"><h2>产品排行</h2><span>按{PERIOD_TITLES[period]}{METRIC_LABELS[sortBy]}{direction === 'desc' ? '降序' : '升序'}</span><Button className="wealth-portfolio-entry" onClick={() => setPortfolio(!portfolio)}>我的理财</Button><Button className="" aria-expanded={filters} onClick={() => setFilters(!filters)}><Filter size={18} />筛选</Button></div>
        <div className="wealth-mobile-periods"><div>{(['day', 'week', 'month', '3m', '1y'] as const).map((p) => <Button key={p} aria-pressed={period === p} className={period === p ? 'is-active' : ''} onClick={() => setPeriod(p)}>{p === '3m' ? '近3月' : p === '1y' ? '近1年' : PERIOD_LABELS[p]}</Button>)}<select aria-label="更多周期" value={['6m', '3y', '5y', 'all'].includes(period) ? period : ''} onChange={(e) => { if (e.target.value) setPeriod(e.target.value as WealthPeriod) }}><option value="">更多</option>{(['6m', '3y', '5y', 'all'] as const).map((p) => <option key={p} value={p}>{PERIOD_LABELS[p]}</option>)}</select></div><p><Button className="" onClick={() => sort(sortBy)}>按{PERIOD_TITLES[period]}{METRIC_LABELS[sortBy]}{direction === 'desc' ? <ArrowDown size={17} /> : <ArrowUp size={17} />}</Button><select aria-label="手机管理机构" value={institution} onChange={(e) => setInstitution(e.target.value)}><option value="">机构</option>{query.data.institutions.map((s) => <option key={s}>{s}</option>)}</select></p></div>
        {filters && <div className="wealth-filters"><label>最高风险<select aria-label="最高风险等级" value={riskMax} onChange={(e) => setRiskMax(e.target.value)}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>R{n}</option>)}</select></label><label>排序<select aria-label="筛选排序指标" value={sortBy} onChange={(e) => setSortBy(e.target.value as RankMetric)}>{RANK_METRICS.map((m) => <option key={m} value={m}>{METRIC_LABELS[m]}</option>)}</select></label><span>可勾选最多3只比较；空值列末尾且不占排名。</span><Button className="" onClick={() => { setRiskMax('5'); setSearch(''); setInstitution(''); setTab('all') }}><X size={15} />重置筛选</Button></div>}
        <div className="wealth-table-scroll wealth-desktop-table"><table><thead><tr><th>对比</th><th>排名</th><th>产品与机构</th><th>类型</th>{(['returnPct', 'sharpe', 'maxDrawdownPct'] as const).map((m) => <th key={m}><Button className="" onClick={() => sort(m)}>{m === 'returnPct' ? PERIOD_TITLES[period] : ''}{METRIC_LABELS[m]}{sortBy === m && (direction === 'desc' ? <ArrowDown size={14} /> : <ArrowUp size={14} />)}</Button></th>)}{(sortBy === 'volatilityPct' || sortBy === 'annualizedReturnPct') && <th>{METRIC_LABELS[sortBy]}</th>}<th>走势</th><th>操作</th></tr></thead><tbody>{rows.map((r) => <tr key={r.code} onMouseEnter={() => setFocusCode(r.code)}><td><input type="checkbox" aria-label={`对比${r.name}`} checked={compared.some((c) => c.code === r.code)} onChange={() => compare(r.code)} disabled={selected.length >= 3 && !selected.includes(r.code)} /></td><td><span className={`wealth-rank rank-${r.rank}`}>{r.rank ?? '—'}</span></td><td><Button className="wealth-name" onClick={() => { setFocusCode(r.code); setDetailCode(r.code) }}>{r.name}</Button><small>{r.institution}</small></td><td><span className="wealth-type">{category(r.category)}</span></td><td className={colorClass(r.metrics.returnPct)}><strong>{pct(r.metrics.returnPct, true)}</strong></td><td>{number(r.metrics.sharpe)}</td><td>{pct(r.metrics.maxDrawdownPct === null ? null : -r.metrics.maxDrawdownPct)}</td>{(sortBy === 'volatilityPct' || sortBy === 'annualizedReturnPct') && <td>{pct(r.metrics[sortBy], sortBy === 'annualizedReturnPct')}</td>}<td><WealthChart rows={[r]} small /></td><td><Button className="wealth-view" onClick={() => setDetailCode(r.code)}>查看</Button></td></tr>)}</tbody></table></div>
        <div className="wealth-mobile-cards">{rows.map((r) => <article key={r.code} className="wealth-mobile-card"><div className="wealth-card-title"><span className={`wealth-rank rank-${r.rank}`}>{r.rank === null ? '—' : String(r.rank).padStart(2, '0')}</span><div><h3>{r.name}</h3><p>{r.institution}　|　{category(r.category)}</p></div><Button className="" aria-label={`${r.favorite ? '移出' : '加入'}自选${r.name}`} onClick={() => void favorite(r)}><Star size={26} fill={r.favorite ? 'currentColor' : 'none'} /></Button></div><MetricStrip metrics={r.metrics} period={period} />{(sortBy === 'volatilityPct' || sortBy === 'annualizedReturnPct') && <p className="wealth-mobile-sort-value">{METRIC_LABELS[sortBy]}：{pct(r.metrics[sortBy], sortBy === 'annualizedReturnPct')}</p>}<div className="wealth-card-bottom"><WealthChart rows={[r]} small /><Button className="" onClick={() => setDetailCode(r.code)}>指标详情<ChevronRight size={18} /></Button></div></article>)}</div>
        {!rows.length && <p className="wealth-empty">{tab === 'favorites' ? '暂无自选，点击星标添加关注的基金。' : '没有符合筛选条件的产品。'}</p>}
        <p className="wealth-disclaimer">白名单内 {query.data.universeCount} 只公开基金的数据排行，非全市场榜单。债券分类当前展示债券型基金。历史业绩不代表未来收益；指标为代码计算值。</p>
      </div><details className="wealth-method"><summary>数据来源与指标计算口径</summary><p>{query.data.methodology.note}</p><p>涨跌幅按周期起点及之后的复利收益计算，最大回撤从区间内前高计算。完整历史不足时不填补、不外推；缺少公布日收益率时标记累计净值近似口径。数据采集与模拟交易相互独立。</p></details></>}
    {portfolio && <FundPanel dashboard={dashboard} onAgent={onAgent} />}
    <Sheet open={!!detailCode} onClose={() => setDetailCode('')} title="基金指标详情" portalContainer={portalContainer} className="wealth-detail-sheet">{details.isPending ? <p>正在加载指标…</p> : details.error ? <p role="alert">{details.error.message}</p> : details.data && <><WealthMetricsCard data={details.data} /><div className="wealth-detail-actions"><Button className="" onClick={() => { const d = details.data!; setDetailCode(''); onAgent(`请分析基金「${d.name}」（代码${d.code}）的各周期表现，使用get_fund_metrics核对收益、夏普率、最大回撤及数据日期。仅分析，不交易。`) }}>让文财分析</Button><Button className="bank-primary" onClick={() => { const d = details.data!; setDetailCode(''); onAgent(`我想了解如何申购基金「${d.name}」（代码${d.code}）。请先核对风险测评并询问申购金额和付款卡，信息齐全后生成未知价申购确认单；仍须独立安全验证。`) }}>咨询申购</Button></div></>}</Sheet>
  </section>
}
