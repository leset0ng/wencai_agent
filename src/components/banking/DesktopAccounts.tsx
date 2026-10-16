import { ArrowDownLeft, ArrowLeftRight, ArrowRight, LockKeyhole, Pencil, Settings2, ShieldAlert, Snowflake, UserRound } from 'lucide-react'
import type { DashboardData } from '#/lib/dashboard'
import { formatAmount } from '#/lib/dashboard'
import { Button } from '#/components/ui/button'
import { Reveal } from '#/components/ui/motion'
import { AccountCarousel } from './AccountCarousel'
import type { CardServiceMode } from './CardServices'
import './desktop-accounts.css'

export function DesktopAccounts({ data, card, hidden, active, onSelect, onApply, onTransfer, onReceive, onService }: {
  data: DashboardData; card?: DashboardData['cards'][number]; hidden: boolean; active: boolean;
  onSelect: (id: string) => void; onApply: () => void; onTransfer: () => void; onReceive: () => void; onService: (mode: CardServiceMode) => void;
}) {
  const activity = card && data.accountActivity[card.accountId]
  const status = card?.status === 'active' ? '正常' : card?.status === 'locked' ? '临时冻结' : '已挂失'
  const money = (amount: number, sign = '') => hidden ? '••••••' : `${sign}${formatAmount(amount)}`
  return <div className="bank-desktop-accounts">
    <div className="bank-accounts-heading"><div><h1>我的账户 <span>{data.cards.length} 张银行卡</span></h1><p>每张卡独立记账，左右滑动查看对应账单。</p></div><Button className="bank-desktop-text" onClick={onApply}>申请新卡<ArrowRight size={22} /></Button></div>
    <div className="bank-accounts-overview">
      <section className="bank-desktop-panel bank-accounts-card" aria-label="银行卡与快捷操作">
        <AccountCarousel data={data} selectedId={card?.id} onSelect={onSelect} hidden={hidden} active={active} />
        {card && <div className="bank-accounts-actions">
          {card.kind === 'credit' ? <Button className="bank-desktop-primary" disabled={card.status !== 'active' || card.outstanding <= 0} onClick={() => onService('repay')}><ArrowLeftRight size={20} />还款</Button> : <><Button className="bank-desktop-primary" disabled={card.status !== 'active'} onClick={onTransfer}><ArrowLeftRight size={20} />转账</Button><Button className="bank-desktop-secondary" disabled={card.status !== 'active'} onClick={onReceive}><ArrowDownLeft size={20} />收款</Button></>}
          <Button className="bank-desktop-secondary" onClick={() => onService('remark')}><Pencil size={19} />备注</Button>
          <Button className="bank-desktop-secondary" disabled={card.status === 'lost'} onClick={() => onService('limit')}><Settings2 size={19} />{card.kind === 'credit' ? '调整额度' : '调整限额'}</Button>
        </div>}
      </section>
      <section className="bank-desktop-panel bank-accounts-info" aria-label="当前卡片账户信息">
        <div className="bank-accounts-panel-heading"><h2>账户信息</h2>{card && <Button className="bank-desktop-text" onClick={() => onService('manage')} aria-label="卡片安全管理"><LockKeyhole size={18} /></Button>}</div>
        {card ? <><dl><div><dt>卡备注</dt><dd>{card.accountName}</dd></div><div><dt>卡号尾号</dt><dd>{card.last4}</dd></div><div><dt>卡片状态</dt><dd className={`bank-accounts-status is-${card.status}`}>{status}</dd></div></dl>
          <div className="bank-accounts-risk-actions"><Button className="bank-card-freeze-action" disabled={card.status === 'lost'} onClick={() => onService('freeze')}><Snowflake size={22} /><span>{card.status === 'locked' ? '解除冻结' : '临时冻结'}<small>{card.status === 'lost' ? '已挂失，无法解除冻结' : '暂停使用，可验证后恢复'}</small></span><ArrowRight size={17} /></Button><Button className="bank-card-lost-action" disabled={card.status === 'lost'} onClick={() => onService('lost')}><ShieldAlert size={22} /><span>{card.status === 'lost' ? '卡片已挂失' : '挂失卡片'}<small>卡片遗失时保护账户安全</small></span><ArrowRight size={17} /></Button></div>
        </> : <p className="bank-desktop-empty">申请银行卡后查看账户信息</p>}
      </section>
      <section className="bank-desktop-panel bank-accounts-monthly" aria-label="当前卡片本月账单">
        <div className="bank-accounts-panel-heading"><h2>本月账单</h2><span>{(activity?.monthly.period ?? data.monthly.period).replace('-', ' / ')}</span></div>
        <div className="bank-accounts-monthly-item"><span>{card?.kind === 'credit' ? '本月还款' : '本月收入'}</span><strong className="is-income">{money(activity?.monthly.income ?? 0, '+')}</strong></div>
        <div className="bank-accounts-monthly-item"><span>{card?.kind === 'credit' ? '本月消费' : '本月支出'}</span><strong>{money(activity?.monthly.expense ?? 0, '−')}</strong></div>
        {card?.kind === 'credit' && <p className="bank-accounts-credit-note">当前待还 ¥ {money(card.outstanding)} · 总额度 ¥ {money(card.creditLimit)}<br />账单日 {card.billDay} 日 · 还款日 {card.dueDay} 日</p>}
      </section>
    </div>
    {card && activity && <Reveal key={card.id}><section className="bank-desktop-panel bank-accounts-ledger" aria-label={`尾号${card.last4}账单`}>
      <div className="bank-accounts-panel-heading"><h2>{card.accountName} · {card.last4} 账单</h2><span>{activity.monthly.period.replace('-', ' / ')}<i />最近 {activity.transactions.length} 笔</span></div>
      <div className="bank-accounts-table-scroll"><table><thead><tr><th>交易对象</th><th>交易时间</th><th>关联银行卡</th><th>金额</th></tr></thead><tbody>{activity.transactions.map((transaction) => <tr key={transaction.id}><td><span className="bank-accounts-payee"><UserRound size={17} /><strong>{transaction.counterparty}</strong></span></td><td>{new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(transaction.occurredAt))}</td><td>{card.accountName} · 尾号 {card.last4}</td><td className={transaction.amount > 0 ? 'is-income' : ''}>{money(Math.abs(transaction.amount),transaction.amount > 0 ? '+' : '−')}</td></tr>)}</tbody></table></div>
      {!activity.transactions.length && <p className="bank-desktop-empty">这张卡暂无交易记录</p>}
    </section></Reveal>}
  </div>
}
