import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '#/components/ui/table'
import { Button } from '#/components/ui/button'
import type { ReactNode } from 'react'
import {
  ArrowUpRight,
  ArrowDownLeft,
  Inbox,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react'
import { categories, money, dateTime, statuses, type Ledger } from './utils'
import type { AdminSnapshot } from './client'
import type { AdminActions } from './actions'
import { Card, CardHeader } from '#/components/ui/card'
import { Badge as UIBadge } from '#/components/ui/badge'

export type Section =
  | 'overview'
  | 'transactions'
  | 'transfers'
  | 'investments'
  | 'cards'
  | 'subscriptions'
  | 'plans'
  | 'audit'
  | 'security'

export type ViewProps = {
  s: AdminSnapshot
  ledger: Ledger
  report:
    | {
        period: string
        income: number
        expense: number
        net: number
        transactionCount: number
        categories: Record<string, number>
      }
    | undefined
  period: string
  anomalies: Array<{ id: string; amount: number; merchant: string; category: string; occurredAt: string; reasons: string[]; needsReview: true }>
  audit: Array<{ seq: number; at: string; userId: string; type: string; payloadJson: string }>
  actions: AdminActions
  go: (section: Section) => void
}

export function Panel({
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  title: string
  subtitle?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <Card className={`panel ${className}`}>
      <CardHeader className="panel-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </CardHeader>
      {children}
    </Card>
  )
}

export function Empty({
  title = '暂无记录',
  text,
  action,
  icon: Icon = Inbox,
}: {
  title?: string
  text: string
  action?: ReactNode
  icon?: LucideIcon
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={24} strokeWidth={1.5} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  )
}

export function Badge({
  status,
  children,
}: {
  status?: string
  children?: ReactNode
}) {
  return (
    <UIBadge className={`badge badge-${status ?? 'neutral'}`}>
      <i />
      {children ?? statuses[status ?? ''] ?? status}
    </UIBadge>
  )
}

export function TransactionTable({
  rows,
  anomalyIds = new Set(),
  limit,
}: {
  rows: Ledger
  anomalyIds?: Set<string>
  limit?: number
}) {
  return (
    <div className="table-scroll">
      <Table className="data-table">
        <TableHeader>
          <TableRow>
            <TableHead>交易对象 / 时间</TableHead>
            <TableHead>分类</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="align-right">金额</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.slice(0, limit).map((t) => (
            <TableRow key={t.id}>
              <TableCell>
                <div className="transaction-name">
                  <span className={`transaction-icon ${t.amount > 0 ? 'income' : ''}`}>
                    {t.amount > 0 ? <ArrowDownLeft size={18} /> : <ArrowUpRight size={18} />}
                  </span>
                  <div>
                    <strong>{t.merchant}</strong>
                    <small>{dateTime(t.occurredAt)}</small>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <span className="category-tag">{categories[t.category] ?? t.category}</span>
              </TableCell>
              <TableCell>
                {anomalyIds.has(t.id) ? (
                  <Badge status="warning">待复核</Badge>
                ) : (
                  <Badge status="active">已入账</Badge>
                )}
              </TableCell>
              <TableCell className={`amount align-right ${t.amount > 0 ? 'text-green' : ''}`}>
                {t.amount > 0 ? '+' : '−'}
                {money(Math.abs(t.amount))}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function More({ onClick, children = '查看全部' }: { onClick: () => void; children?: ReactNode }) {
  return (
    <Button className="button button-ghost button-sm" onClick={onClick} type="button">
      {children}
      <ChevronRight size={14} />
    </Button>
  )
}

export function Metric({
  label,
  value,
  note,
  icon: Icon,
  accent = false,
}: {
  label: string
  value: string
  note: ReactNode
  icon: LucideIcon
  accent?: boolean
}) {
  return (
    <div className={`metric ${accent ? 'metric-accent' : ''}`}>
      <div className="metric-top">
        <span>{label}</span>
        <span className="metric-icon">
          <Icon size={18} />
        </span>
      </div>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  )
}
