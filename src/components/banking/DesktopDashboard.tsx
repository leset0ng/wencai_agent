import { ArrowDownLeft, ArrowUpRight, ChevronRight, Clock3, CreditCard, Eye, EyeOff, MoreHorizontal, ShieldAlert } from 'lucide-react'
import type { DashboardData } from '#/lib/dashboard'
import { formatAmount } from '#/lib/dashboard'
import { Button } from '#/components/ui/button'
import { AnimatedAmount, Reveal } from '#/components/ui/motion'
import { AnimatedBarChart } from '#/components/ui/charts'
import { useCancelAction } from '#/lib/queries'

type Pending = NonNullable<DashboardData['pendingTransfers']>[number]
export function DesktopDashboard({ data, hidden, agentOpen, onToggleHidden, onTransfer, onReceive, onTransactions, onAssets, onBill, onMore, onCards, onCard, onPending }: {
  data: DashboardData; hidden: boolean; agentOpen: boolean; onToggleHidden: () => void; onTransfer: () => void; onReceive: () => void;
  onTransactions: () => void; onAssets: () => void; onBill: () => void; onMore: () => void; onCards: () => void; onCard: (id: string) => void; onPending: (id?: string) => void
}) {
  const pending = data.pendingTransfers ?? []
  return <div className="bank-desktop-dashboard">
    <Reveal className="bank-desktop-ledger">
      <section className="bank-desktop-panel bank-desktop-main-panel" aria-label="账户与最近交易">
        <div className="bank-desktop-balance-heading">
          <div className="bank-desktop-balance-label">可用余额（元）<Button className="bank-icon-button" aria-label={hidden ? '显示资产金额' : '隐藏资产金额'} onClick={onToggleHidden}>{hidden ? <EyeOff size={24} /> : <Eye size={24} />}</Button></div>
          <nav className="bank-desktop-quick" aria-label="快捷业务">
            <Button className="bank-desktop-secondary" onClick={onReceive}><ArrowDownLeft size={22} />收款</Button>
            <Button className="bank-desktop-primary" onClick={onTransfer}><ArrowUpRight size={22} />转账</Button>
            <Button className="bank-desktop-more" aria-label="更多服务" onClick={onMore}><MoreHorizontal size={25} /></Button>
          </nav>
        </div>
        <h2 className="bank-desktop-balance">{hidden ? '••••••' : <AnimatedAmount value={data.availableBalance} />}</h2>
        <div className="bank-desktop-asset-line"><p>账户总资产 <strong>{hidden ? '••••••' : `¥ ${formatAmount(data.totalAssets)}`}</strong></p><Button className="bank-desktop-text" onClick={onAssets}>资产详情<ChevronRight size={17} /></Button></div>
        <div className="bank-desktop-section-title"><h2>最近交易</h2><Button className="bank-desktop-text" onClick={onTransactions}>查看全部<ChevronRight size={19} /></Button></div>
        <div className="bank-desktop-transactions"><table><thead><tr><th>交易</th><th>银行卡</th><th>交易备注</th><th>金额</th></tr></thead><tbody>
          {data.transactions.slice(0, 6).map((transaction, index) => {
            const card = data.cards.find((item) => item.accountId === transaction.accountId)
            return <tr key={transaction.id}>
              <td><div className="bank-desktop-counterparty"><span className={`bank-desktop-person tone-${index % 3}`}>{transaction.counterparty.slice(0, 1)}</span><div><strong>{transaction.counterparty}</strong><small>{new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(transaction.occurredAt))}</small></div></div></td>
              <td>{card?.accountName ?? data.accounts.find((account) => account.id === transaction.accountId)?.name ?? '资金账户'}{card && <small>尾号 {card.last4}</small>}</td>
              <td><span className="bank-desktop-memo" title={transaction.memo || transaction.category}>{transaction.memo || transaction.category}</span></td><td className={transaction.amount > 0 ? 'is-income' : ''}>{hidden ? '••••••' : `${transaction.amount > 0 ? '+' : '−'}${formatAmount(Math.abs(transaction.amount))}`}</td>
            </tr>
          })}
        </tbody></table>{!data.transactions.length && <p className="bank-desktop-empty">暂无交易记录</p>}</div>
        <Button className="bank-desktop-monthly" aria-label="查看本月收支分析" onClick={onBill}><span><small>本月收入</small><strong className="is-income">{hidden ? '••••••' : `¥ ${formatAmount(data.monthly.income)}`}</strong></span><span><small>本月支出</small><strong>{hidden ? '••••••' : `¥ ${formatAmount(data.monthly.expense)}`}</strong></span>{!hidden && <span className="bank-desktop-trend" aria-hidden="true"><AnimatedBarChart data={data.trend} compact /></span>}</Button>
        <footer className="bank-desktop-ledger-footer"><Button className="bank-desktop-neutral" onClick={onTransactions}>查看全部交易</Button><span>模拟银行数据</span></footer>
      </section>
    </Reveal>
    <aside className="bank-desktop-widgets" aria-label="账户快捷信息" inert={agentOpen}>
      <Reveal delay={80}><section className="bank-desktop-panel bank-desktop-safety"><div><span className="bank-desktop-shield"><ShieldAlert size={41} /></span><div><h2>安全提示</h2><p>转账前请核对收款人、付款卡和备注，敏感操作需本人确认。</p></div></div><a className="bank-desktop-secondary" href="/settings">查看安全设置</a></section></Reveal>
      <Reveal delay={140}><section className="bank-desktop-panel bank-desktop-pending"><div className="bank-desktop-section-title"><h2>待确认转账 · {pending.length}</h2><Button className="bank-desktop-text" onClick={() => onPending()}>查看全部<ChevronRight size={18} /></Button></div>{pending[0] ? <PendingPreview item={pending[0]} hidden={hidden} onOpen={() => onPending(pending[0].actionId)} /> : <div className="bank-desktop-empty"><Clock3 size={25} /><p>暂无待确认转账</p><small>需要确认的转账会显示在这里</small></div>}</section></Reveal>
      <Reveal delay={200}><section className="bank-desktop-panel bank-desktop-cards"><div className="bank-desktop-section-title"><h2>我的银行卡 · {data.cards.length}</h2><Button className="bank-desktop-text" onClick={onCards}>查看全部<ChevronRight size={18} /></Button></div><div className="bank-desktop-card-list">{data.cards.slice(0, 3).map((card, index) => <Button className="bank-desktop-card-preview" key={card.id} onClick={() => onCard(card.id)} aria-label={`查看${card.accountName}尾号${card.last4}`}>
        <span className={`bank-desktop-mini-card tone-${index}`} aria-hidden="true"><strong>文财银行</strong><span className="bank-desktop-mini-chip" /><span className="bank-desktop-mini-marks"><i /><i /></span></span><strong>{card.accountName}</strong><small>尾号 {card.last4}</small>
      </Button>)}</div>{!data.cards.length && <div className="bank-desktop-empty"><CreditCard size={30} /><p>还没有银行卡</p><Button className="bank-desktop-text" onClick={onCards}>前往申请新卡<ChevronRight size={16} /></Button></div>}</section></Reveal>
    </aside>
  </div>
}

function PendingPreview({ item, hidden, onOpen }: { item: Pending; hidden: boolean; onOpen: () => void }) {
  const cancel = useCancelAction(item.actionId)
  const field = (label: string) => item.summary.fields.find((entry) => entry.label.includes(label))?.value
  const payee = field('收款人') ?? field('转入') ?? '待核对收款人'
  return <div className="bank-desktop-pending-card"><div className="bank-desktop-pending-info"><span className="bank-desktop-person tone-2">{payee.slice(0, 1)}</span><div><strong>{payee}</strong><small>{field('收款账号') ?? item.summary.title}</small></div><div><strong>{hidden ? '••••••' : field('金额')}</strong><span className="bank-desktop-pending-status"><Clock3 size={16} />待确认</span></div></div><div className="bank-desktop-pending-actions"><Button className="bank-desktop-primary" onClick={onOpen} disabled={cancel.isPending}>查看并确认</Button><Button className="bank-desktop-neutral" onClick={() => cancel.mutate()} disabled={cancel.isPending}>{cancel.isPending ? '取消中…' : '取消'}</Button></div>{cancel.error && <p role="alert" className="bank-error">{cancel.error.message}</p>}</div>
}
