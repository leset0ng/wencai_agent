import { Button } from '#/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '#/components/ui/toggle-group'
import { Input } from '#/components/ui/input'
import { Checkbox } from '#/components/ui/checkbox'
import { SelectControl, SelectOption } from '#/components/ui/select'
import { useState } from 'react'
import { Search, Download, AlertTriangle, ArrowUpRight, ArrowDownLeft, ChartNoAxesCombined } from 'lucide-react'
import { Panel, Metric, TransactionTable, Empty, type ViewProps } from '../shared'
import { money, categories, periodRows, exportLedger } from '../utils'

export function AdminTransactions({ ledger, period, report, anomalies }: ViewProps) {
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const [direction, setDirection] = useState('all')
  const [page, setPage] = useState(0)
  const [onlyAnomalies, setOnlyAnomalies] = useState(false)

  const ids = new Set(anomalies.map((t) => t.id))
  const periodLedger = periodRows(ledger, period)
  const rows = periodLedger.filter(
    (t) =>
      (!q || `${t.merchant} ${t.id}`.toLowerCase().includes(q.toLowerCase())) &&
      (!category || t.category === category) &&
      (direction === 'all' || (direction === 'income' ? t.amount > 0 : t.amount < 0)) &&
      (!onlyAnomalies || ids.has(t.id)),
  )
  const count = Math.max(1, Math.ceil(rows.length / 15))

  return (
    <>
      <div className="metric-grid three">
        <Metric label="本期现金收入" value={money(report?.income ?? 0)} note="排除期初余额与理财赎回" icon={ArrowDownLeft} />
        <Metric label="本期现金支出" value={money(report?.expense ?? 0)} note="排除理财申购等资产移动" icon={ArrowUpRight} />
        <Metric label="本期现金净额" value={money(report?.net ?? 0)} note={`${report?.transactionCount ?? 0} 笔收支记录`} icon={ChartNoAxesCombined} />
      </div>
      <Panel
        title="交易明细"
        subtitle={`${rows.length} 笔记录${anomalies.length ? ` · ${anomalies.length} 笔待复核` : ''}`}
        action={
          <Button className="button button-outline button-sm" onClick={() => exportLedger(periodLedger, period)} type="button">
            <Download size={15} />导出
          </Button>
        }
      >
        <div className="table-toolbar">
          <div className="search-input">
            <Search size={15} />
            <Input placeholder="搜索交易对象或流水号" value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} />
          </div>
          <SelectControl value={category} onValueChange={(value) => { setCategory(value); setPage(0) }}>
            <SelectOption value="">全部分类</SelectOption>
            {Object.entries(categories).map(([k, v]) => <SelectOption key={k} value={k}>{v}</SelectOption>)}
          </SelectControl>
          <ToggleGroup className="segmented" value={direction} onValueChange={(value) => { setDirection(value); setPage(0) }} aria-label="收支方向">
            {(['all', 'income', 'expense'] as const).map((d) => (
              <ToggleGroupItem value={d} key={d} className={direction === d ? 'selected' : ''} type="button">
                {d === 'all' ? '全部' : d === 'income' ? '收入' : '支出'}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {anomalies.length > 0 && (
            <label className="toggle-label">
              <Checkbox  checked={onlyAnomalies} onCheckedChange={(checked) => { setOnlyAnomalies(checked); setPage(0) }} />
              <AlertTriangle size={14} />只看异常
            </label>
          )}
        </div>
        {rows.length ? (
          <>
            <TransactionTable rows={rows} anomalyIds={ids} limit={(page + 1) * 15} />
            {rows.length > 15 && (
              <div className="pagination">
                <Button className="button button-ghost button-sm" disabled={page === 0} onClick={() => setPage(p => p - 1)} type="button">上一页</Button>
                <span>{page + 1} / {count}</span>
                <Button className="button button-ghost button-sm" disabled={page >= count - 1} onClick={() => setPage(p => p + 1)} type="button">下一页</Button>
              </div>
            )}
          </>
        ) : (
          <Empty icon={ChartNoAxesCombined} text="当前筛选条件下没有交易记录" />
        )}
      </Panel>
    </>
  )
}
