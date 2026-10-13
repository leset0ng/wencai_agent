import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CircleAlert, Loader2, RefreshCw, Sparkles, UserRound, Wallet, PiggyBank, ShieldCheck } from 'lucide-react'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#/components/ui/table'
import { AnimatedBarChart, AnimatedDonutChart } from '#/components/ui/charts'
import { Badge, Empty, Metric, Panel } from '../shared'
import { dateTime, money } from '../utils'
import { profileApi, type ProfileTag, type UserProfile } from '../profile-client'

const TONE: Record<ProfileTag['tone'], string> = { good: 'active', warn: 'warning', info: 'planned' }
const COLORS = ['#3869ea', '#76a1f8', '#93c5fd', '#93d8d1', '#c2d5ee', '#e3b580']
const pct = (value: number | null, digits = 1) => (value === null ? '数据不足' : `${(value * 100).toFixed(digits)}%`)
const ALIGNMENT = { aligned: '与测评一致', mismatch: '持仓风险高于测评', unknown: '无法判断' } as const
const NARRATIVE_NOTE = {
  numbers: '模型文字含未经核实的金额，已改用规则生成的文字。',
  invalid: '模型输出格式不符，已改用规则生成的文字。',
  unavailable: '模型暂不可用，已改用规则生成的文字。',
} as const

function TagList({ tags }: { tags: ProfileTag[] }) {
  if (!tags.length) return <span className="muted">暂无特征标签</span>
  return <div className="profile-tags">{tags.map((tag) => <Badge key={tag.code} status={TONE[tag.tone]}>{tag.label}</Badge>)}</div>
}

/**
 * 后台用户画像。数字全部由服务端代码计算；顶部的文字摘要由模型撰写，
 * 但每个金额都经过核验，不通过会换成规则文字，并在这里明示来源，不让人把它当成"银行结论"。
 */
export function AdminProfile() {
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  return selected
    ? <ProfileDetail userId={selected} onBack={() => setSelected(null)} />
    : <ProfileList search={search} setSearch={setSearch} onOpen={setSelected} />
}

function ProfileList({ search, setSearch, onOpen }: { search: string; setSearch: (value: string) => void; onOpen: (userId: string) => void }) {
  const query = useQuery({ queryKey: ['admin', 'profile-list'], queryFn: profileApi.list, refetchInterval: 30_000 })
  const keyword = search.trim().toLocaleLowerCase()
  const rows = (query.data?.users ?? []).filter((row) => !keyword || row.userName.toLocaleLowerCase().includes(keyword) || row.userId.toLocaleLowerCase().includes(keyword))
  return (
    <Panel title="用户画像" subtitle="按近 6 个月的真实流水、持仓与卡片计算；列表不调用模型，点开用户查看完整画像。" action={
      <Button className="button button-outline button-sm" type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>
        <RefreshCw size={14} className={query.isFetching ? 'spin' : ''} />刷新
      </Button>
    }>
      <div className="risk-review-filters">
        <label className="risk-review-search"><span>查找用户</span><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="姓名或用户 ID" /></label>
      </div>
      {query.isError && <div className="load-error" role="alert"><CircleAlert size={18} /><div><strong>无法读取用户画像</strong><p>{query.error.message}</p></div><Button className="button button-outline button-sm" type="button" onClick={() => void query.refetch()}>重新加载</Button></div>}
      {query.isPending ? <div className="loading-workspace" role="status"><Loader2 className="spin" size={24} /><span>正在计算用户画像</span></div> : rows.length ? (
        <div className="table-scroll">
          <Table className="data-table">
            <TableHeader><TableRow><TableHead>用户</TableHead><TableHead>月均收入 / 支出</TableHead><TableHead>储蓄率</TableHead><TableHead>总资产</TableHead><TableHead>特征</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
            <TableBody>{rows.map((row) => (
              <TableRow key={row.userId}>
                <TableCell><div className="risk-review-account"><strong>{row.userName}</strong><small>{row.userId} · 测评 {row.riskRating ?? '未测评'}</small></div></TableCell>
                <TableCell>{row.monthsObserved ? <div className="risk-review-account"><span>{money(row.monthlyIncomeCents)}</span><small>支出 {money(row.monthlyExpenseCents)}</small></div> : <span className="muted">流水不足</span>}</TableCell>
                <TableCell>{pct(row.savingsRate)}</TableCell>
                <TableCell>{money(row.totalAssetsCents)}</TableCell>
                <TableCell><TagList tags={row.tags} /></TableCell>
                <TableCell><Button className="button button-outline button-sm" type="button" aria-label={`查看${row.userName}的画像`} onClick={() => onOpen(row.userId)}>查看画像</Button></TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        </div>
      ) : !query.isError && <Empty icon={UserRound} title="没有匹配的用户" text="请调整查找内容。" />}
      {query.data && <p className="risk-review-updated">数据更新于 {dateTime(query.data.generatedAt)} · 每 30 秒刷新</p>}
    </Panel>
  )
}

function ProfileDetail({ userId, onBack }: { userId: string; onBack: () => void }) {
  const client = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)
  const query = useQuery({ queryKey: ['admin', 'profile', userId], queryFn: () => profileApi.detail(userId) })
  async function rewrite() {
    setRefreshing(true)
    try {
      const fresh = await profileApi.detail(userId, true)
      client.setQueryData(['admin', 'profile', userId], fresh)
    } finally { setRefreshing(false) }
  }
  if (query.isPending) return <div className="loading-workspace" role="status"><Loader2 className="spin" size={24} /><span>正在生成画像，模型撰写摘要最多需要十几秒</span></div>
  if (query.isError) return <Panel title="用户画像" subtitle=""><div className="load-error" role="alert"><CircleAlert size={18} /><div><strong>无法生成画像</strong><p>{query.error.message}</p></div><Button className="button button-outline button-sm" type="button" onClick={onBack}>返回列表</Button></div></Panel>
  const p: UserProfile = query.data
  const m = p.metrics
  const enough = m.monthsObserved >= 3
  return <>
    <div><Button className="button button-ghost button-sm" type="button" onClick={onBack}><ArrowLeft size={14} />返回用户列表</Button></div>
    <Panel title={`${p.userName} 的画像`} subtitle={`按近 6 个月数据计算 · 生成于 ${dateTime(p.generatedAt)} · 观察到 ${m.monthsObserved} 个完整月份`} action={
      <Button className="button button-outline button-sm" type="button" onClick={() => void rewrite()} disabled={refreshing}>
        {refreshing ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}重写摘要
      </Button>
    }>
      <TagList tags={p.tags} />
      <blockquote className="profile-narrative">
        <p>{p.narrative.text}</p>
        <small>
          {p.narrative.source === 'ai' ? '摘要由模型撰写，金额已逐项核验' : '摘要由规则生成'}
          {p.narrative.rejected ? `；${NARRATIVE_NOTE[p.narrative.rejected]}` : ''} · 仅供后台参考，不影响任何交易的风险判定
        </small>
      </blockquote>
      {p.tags.filter((tag) => tag.basis).length > 0 && <ul className="profile-basis">{p.tags.map((tag) => <li key={tag.code}><strong>{tag.label}</strong>：{tag.basis}</li>)}</ul>}
    </Panel>

    <div className="profile-metrics">
      <Metric label="月均收入" value={enough ? money(m.monthlyIncomeCents) : '数据不足'} note={m.monthsObserved ? `近 ${m.monthsObserved} 个完整月份` : '暂无完整月份'} icon={Wallet} />
      <Metric label="月均支出" value={enough ? money(m.monthlyExpenseCents) : '数据不足'} note={m.recurringMonthlyCents ? `含固定支出 ${money(m.recurringMonthlyCents)}` : '未识别固定支出'} icon={Wallet} />
      <Metric label="储蓄率" value={pct(m.savingsRate)} note={m.liquidityMonths === null ? '活期覆盖月数暂无' : `活期约可覆盖 ${m.liquidityMonths} 个月支出`} icon={PiggyBank} />
      <Metric label="总资产" value={money(m.totalAssetsCents)} note={`理财占比 ${pct(m.investmentShare)}`} icon={ShieldCheck} />
    </div>

    <div className="two-col">
      <Panel title="支出结构" subtitle="近 6 个月完整月份，已排除理财、本人账户互转与信用卡还款">
        {m.topCategories.length ? (
          <div className="profile-donut">
            <div className="ui-admin-donut"><AnimatedDonutChart compact colors={COLORS} ringRadius={61} ringWidth={15} gapDegrees={3} data={m.topCategories.map((c) => ({ label: c.category, value: c.cents }))} /></div>
            <ul className="profile-legend">{m.topCategories.map((c, index) => <li key={c.category}><i style={{ background: COLORS[index % COLORS.length] }} />{c.category}<span>{money(c.cents)} · {pct(c.share)}</span></li>)}</ul>
          </div>
        ) : <Empty icon={UserRound} title="暂无支出数据" text="需要至少一个完整月份的支出流水。" />}
      </Panel>
      <Panel title="近 6 个月支出" subtitle={m.expenseVsAverage === null ? '当月数据不足以对比' : `本月支出较前期月均${m.expenseVsAverage >= 0 ? '高' : '低'} ${pct(Math.abs(m.expenseVsAverage))}`}>
        <AnimatedBarChart data={m.trend.map((point) => ({ label: `${Number(point.month.slice(5))}月`, value: point.expenseCents }))} />
      </Panel>
    </div>

    <div className="two-col">
      <Panel title="固定支出" subtitle="同一对手方、金额相同、连续至少 3 个月">
        {m.recurring.length ? <ul className="profile-basis">{m.recurring.map((r) => <li key={`${r.counterparty}${r.amountCents}`}><strong>{r.counterparty}</strong>：{money(r.amountCents)} / 月，已连续 {r.months} 个月</li>)}</ul> : <Empty icon={UserRound} title="未识别到固定支出" text="需要连续多个月金额相同的扣款。" />}
        <p className="risk-review-updated">已开通 {m.activeSubscriptions} 项订阅，折合每月 {money(m.subscriptionMonthlyCents)}</p>
      </Panel>
      <Panel title="理财与风险" subtitle="风险等级来自问卷测评，由代码判定">
        <dl className="risk-review-features">
          <div><dt>风险测评</dt><dd>{m.riskRating ?? '未测评'}</dd></div>
          <div><dt>持仓与测评</dt><dd>{ALIGNMENT[m.riskAlignment]}</dd></div>
          <div><dt>理财占总资产</dt><dd>{pct(m.investmentShare)}</dd></div>
          <div><dt>信用额度使用率</dt><dd>{pct(m.creditUtilization)}</dd></div>
        </dl>
        {m.holdingsByRisk.length > 0 && <ul className="profile-basis">{m.holdingsByRisk.map((h) => <li key={h.riskRating}><strong>{h.riskRating}</strong>：本金 {money(h.principalCents)}</li>)}</ul>}
      </Panel>
    </div>
  </>
}
