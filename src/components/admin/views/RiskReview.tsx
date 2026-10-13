import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, Loader2, RefreshCw, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '#/components/ui/dialog'
import { SelectControl, SelectOption } from '#/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#/components/ui/table'
import { Badge, Empty, Metric, Panel } from '../shared'
import { dateTime } from '../utils'
import { RiskReviewApiError, riskReviewApi, type RiskReviewRow, type RiskReviewStatus } from '../risk-client'

const STATUS: Record<RiskReviewStatus, { label: string; badge: string; effect: string }> = {
  suspected: { label: '待人工复核', badge: 'pending', effect: '向该账户转账需强验证，完成复核前不会自动放行。' },
  confirmed: { label: '已确认高危', badge: 'lost', effect: '向该账户转账已被阻止。' },
  cleared: { label: '已解除标记', badge: 'active', effect: '此风险标记已解除，转账仍须通过日累计金额、账户状态等常规安全规则。' },
}

const FEATURE_LABELS = [
  ['ownerAgeDays', '用户注册天数', 'days'],
  ['incomingCount24h', '近 24 小时入账笔数', 'count'],
  ['incomingCents24h', '近 24 小时入账金额', 'money'],
  ['distinctPayers24h', '近 24 小时不同付款方', 'count'],
  ['outgoingCents24h', '近 24 小时出账金额', 'money'],
  ['rapidOutflowRatio', '快速转出比例', 'ratio'],
] as const

function featureValue(value: number | null | undefined, kind: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未知'
  if (kind === 'money') return `¥${(value / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  if (kind === 'ratio') return `${(value * 100).toFixed(1)}%`
  return kind === 'days' ? `${value} 天` : String(value)
}

export function AdminRiskReview() {
  const dialogRef = useRef<HTMLDivElement>(null)
  const client = useQueryClient()
  const [filter, setFilter] = useState('suspected')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<RiskReviewRow | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const query = useQuery({
    queryKey: ['admin', 'risk-review'],
    queryFn: riskReviewApi.list,
    refetchInterval: 10000,
  })
  const mutation = useMutation({
    mutationFn: riskReviewApi.review,
    onSuccess: async (_result, decision) => {
      setSelected(null)
      setError('')
      setNotice(decision.decision === 'confirmed' ? '已确认高危，向该账户转账将被阻止。' : '已解除此风险标记，常规安全规则继续生效。')
      await client.invalidateQueries({ queryKey: ['admin'] })
    },
    onError: async (err) => {
      if (err instanceof RiskReviewApiError && err.status === 409) {
        setSelected(null)
        setError('')
        setNotice('该记录已被更新，列表已重新加载。请打开最新记录后再复核。')
        await client.invalidateQueries({ queryKey: ['admin'] })
      } else {
        setError(err instanceof Error ? err.message : '复核失败，请重试')
      }
    },
  })

  const keyword = search.trim().toLocaleLowerCase()
  const rows = (query.data?.flags ?? []).filter((row) =>
    (filter === 'all' || row.status === filter) &&
    (!keyword || [row.ownerName, row.accountName, row.accountId].some((value) => value.toLocaleLowerCase().includes(keyword))),
  )

  function open(row: RiskReviewRow) {
    // 使用打开时的版本提交，后台轮询不会悄悄改变管理员正在核对的内容。
    setSelected(row)
    setError('')
    setNotice('')
    mutation.reset()
  }

  function review(decision: 'confirmed' | 'cleared') {
    if (!selected || mutation.isPending) return
    setError('')
    mutation.mutate({ accountId: selected.accountId, expectedRevision: selected.revision, decision })
  }

  return <>
    {notice && <div className="risk-review-notice" role="status"><ShieldCheck size={18} /><span>{notice}</span></div>}
    {query.data && <div className="risk-review-metrics">
      <Metric label="待人工复核" value={String(query.data.summary.suspected)} note="转账需强验证" icon={ShieldAlert} />
      <Metric label="已确认高危" value={String(query.data.summary.confirmed)} note="阻止向该账户转账" icon={ShieldX} />
      <Metric label="已解除标记" value={String(query.data.summary.cleared)} note="常规安全规则继续生效" icon={ShieldCheck} />
    </div>}
    <Panel title="收款账户风险复核" subtitle="全局收款风险记录；自动检测只提供线索，高危确认与解除标记由管理员完成。" action={
      <Button className="button button-outline button-sm" type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>
        <RefreshCw size={14} className={query.isFetching ? 'spin' : ''} />刷新
      </Button>
    }>
      <div className="risk-review-filters">
        <label className="risk-review-search"><span>查找账户</span><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="户名、账户名称或账户编号" /></label>
        <label><span>复核状态</span><SelectControl value={filter} onValueChange={setFilter}>
          <SelectOption value="all">全部状态</SelectOption>
          <SelectOption value="suspected">待人工复核</SelectOption>
          <SelectOption value="confirmed">已确认高危</SelectOption>
          <SelectOption value="cleared">已解除标记</SelectOption>
        </SelectControl></label>
      </div>
      {query.isError && <div className="load-error" role="alert"><CircleAlert size={18} /><div><strong>无法读取风险记录</strong><p>{query.error.message}</p></div><Button className="button button-outline button-sm" onClick={() => void query.refetch()} type="button">重新加载</Button></div>}
      {query.isPending ? <div className="loading-workspace" role="status"><Loader2 className="spin" size={24} /><span>正在读取收款账户风险记录</span></div> : rows.length ? <div className="table-scroll">
        <Table className="data-table risk-review-table">
          <TableHeader><TableRow><TableHead>收款账户</TableHead><TableHead>状态 / 更新时间</TableHead><TableHead>检测依据</TableHead><TableHead>人工复核</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
          <TableBody>{rows.map((row) => <TableRow key={row.accountId}>
            <TableCell><div className="risk-review-account"><strong>{row.ownerName} · {row.accountName}</strong><small>账户 {row.accountId}</small></div></TableCell>
            <TableCell><div className="risk-review-account"><Badge status={STATUS[row.status].badge}>{STATUS[row.status].label}</Badge><small>{dateTime(row.updatedAt)}</small></div></TableCell>
            <TableCell><ul className="risk-review-reasons">{row.reasons.length ? row.reasons.map((reason, index) => <li key={index}>{reason}</li>) : <li>等待人工核对</li>}</ul></TableCell>
            <TableCell><div className="risk-review-account"><span>{row.reviewedBy ? '已由管理员复核' : '尚未复核'}</span><small>{row.reviewedAt ? dateTime(row.reviewedAt) : '—'}</small></div></TableCell>
            <TableCell><Button className="button button-outline button-sm" onClick={() => open(row)} aria-label={`${row.status === 'cleared' ? '查看' : '复核'}${row.ownerName}的${row.accountName}`} type="button">{row.status === 'cleared' ? '查看记录' : '查看并复核'}</Button></TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </div> : !query.isError && <Empty icon={ShieldCheck} title="暂无匹配的风险记录" text={filter === 'suspected' && !keyword ? '当前没有待人工复核的收款账户。可切换状态查看已处理记录。' : '请调整查找内容或复核状态。'} />}
      {query.data && <p className="risk-review-updated">数据更新于 {dateTime(query.data.generatedAt)} · 每 10 秒刷新</p>}
    </Panel>
    {selected && <Dialog open onOpenChange={(isOpen, details) => { if (mutation.isPending) details.cancel(); else if (!isOpen) { setSelected(null); setError('') } }} disablePointerDismissal={mutation.isPending}>
      <DialogContent ref={dialogRef} initialFocus={() => dialogRef.current} className="risk-review-dialog">
        <div className="dialog-head"><DialogTitle>收款账户风险复核</DialogTitle><DialogDescription>核对账户与检测依据后，由你决定是否确认高危或解除此标记。</DialogDescription></div>
        <div className="risk-review-detail">
          <div className="risk-review-account"><strong>{selected.ownerName} · {selected.accountName}</strong><small>账户 {selected.accountId} · 记录版本 {selected.revision}</small></div>
          <Badge status={STATUS[selected.status].badge}>{STATUS[selected.status].label}</Badge>
          <p className="risk-review-effect">{STATUS[selected.status].effect}</p>
          <h3>检测依据</h3><ul className="risk-review-reasons">{selected.reasons.length ? selected.reasons.map((reason, index) => <li key={index}>{reason}</li>) : <li>暂无检测依据，请人工核对。</li>}</ul>
          <h3>账户交易特征</h3><dl className="risk-review-features">{FEATURE_LABELS.map(([key, label, kind]) => <div key={key}><dt>{label}</dt><dd>{featureValue(selected.features[key], kind)}</dd></div>)}</dl>
          {selected.reviewedBy && <p className="risk-review-updated">复核人：{selected.reviewedBy} · {selected.reviewedAt ? dateTime(selected.reviewedAt) : '—'}</p>}
          {selected.status !== 'cleared' && <div className="risk-review-effect"><strong>本次决定的影响</strong><p>确认高危：阻止向该账户转账。解除标记：移除此风险限制，常规安全规则继续生效。决定将记录到操作审计。</p></div>}
          {error && <div className="form-error" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
        </div>
        <div className="dialog-foot risk-review-dialog-foot">
          <Button type="button" className="button button-ghost" disabled={mutation.isPending} onClick={() => { setSelected(null); setError('') }}>{selected.status === 'cleared' ? '关闭' : '暂不处理'}</Button>
          {selected.status !== 'cleared' && <div>
            <Button type="button" className="button button-outline" disabled={mutation.isPending} onClick={() => review('cleared')}>{mutation.isPending && mutation.variables?.decision === 'cleared' && <Loader2 size={14} className="spin" />}解除标记</Button>
            {selected.status === 'suspected' && <Button type="button" className="button button-danger" disabled={mutation.isPending} onClick={() => review('confirmed')}>{mutation.isPending && mutation.variables?.decision === 'confirmed' && <Loader2 size={14} className="spin" />}确认高危</Button>}
          </div>}
        </div>
      </DialogContent>
    </Dialog>}
  </>
}
