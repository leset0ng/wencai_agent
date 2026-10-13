import { Input } from '#/components/ui/input'
import { Button } from '#/components/ui/button'
import { SelectControl, SelectOption } from '#/components/ui/select'
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CreditCard, ShieldCheck } from 'lucide-react'
import type { DashboardData } from '#/lib/dashboard'
import { formatAmount } from '#/lib/dashboard'
import { parsePaymentAmount } from '#/lib/payment-amount'
import type { ToolOutcome } from '#/server/tools/define'
import { PaymentApproval } from './PaymentCenter'
import { Reveal } from '#/components/ui/motion'
import { CardPasswordAction } from '#/components/ui/CardPasswordAction'

export type CardServiceMode = 'remark' | 'repay' | 'manage' | 'apply'
export function CardServices({ data, cardId, mode, userId }: { data: DashboardData; cardId: string; mode: CardServiceMode; userId: string }) {
  const card = data.cards.find((c) => c.id === cardId)!
  const debit = data.cards.filter((c) => c.kind === 'debit' && c.status === 'active')
  const [remark, setRemark] = useState(card.remark)
  const [source, setSource] = useState(debit[0]?.id ?? '')
  const [amount, setAmount] = useState(card.outstanding ? String(card.outstanding) : '')
  const [limit, setLimit] = useState(String(card.kind === 'credit' ? card.creditLimit : card.dailyLimit))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<Extract<ToolOutcome, { status: 'needs_confirmation' }>>()
  const qc = useQueryClient()
  const prepare = async (tool: string, args: Record<string, unknown>) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const res = await fetch('/api/payments', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, args }) })
      const outcome = await res.json()
      if (!res.ok) throw new Error(outcome.error ?? '操作失败')
      if (outcome.status === 'needs_confirmation') setPending(outcome)
      else throw new Error(outcome.message ?? outcome.reasons?.join('；') ?? '请重新核对信息')
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败') }
    finally { setBusy(false) }
  }
  return <div className="bank-payment-scroll bank-card-services">
    <p className="bank-payment-caption"><ShieldCheck size={14} />{card.accountName} · {card.kind === 'credit' ? '信用卡' : '储蓄卡'}尾号{card.last4}</p>
    {pending ? <PaymentApproval pending={pending} onBack={() => setPending(undefined)} onComplete={() => { void qc.invalidateQueries({ queryKey: ['dashboard', userId] }); void qc.invalidateQueries({ queryKey: ['payments', userId] }) }} /> : <Reveal>
      {mode === 'remark' && <form className="bank-payment-form" onSubmit={(e) => { e.preventDefault(); void prepare('set_card_remark', { cardId, remark }) }}>
        <h2>给卡片添加备注</h2>
        <label>卡片备注<Input value={remark} onChange={(e) => setRemark(e.target.value)} maxLength={30} placeholder="例如：工资卡、储蓄卡A" disabled={busy} /></label>
        <p className="bank-page-note">备注只用于识别卡片，不改变储蓄卡或信用卡类型。你可以对 Agent 说“从工资卡转账 500 到储蓄卡A”；同名时会询问具体尾号。</p>
        <Button className="bank-primary bank-lift" disabled={busy} type="submit">{busy ? '正在准备…' : '保存备注'}</Button>
      </form>}
      {mode === 'repay' && <form className="bank-payment-form" onSubmit={(e) => {
        e.preventDefault()
        const cents = parsePaymentAmount(amount)
        const from = debit.find((c) => c.id === source)
        if (cents === null || !from) { setError('请选择付款卡并填写有效金额'); return }
        void prepare('repay_credit_card', { creditCardQuery: `信用卡尾号${card.last4}`, sourceCardQuery: `储蓄卡尾号${from.last4}`, amountCents: cents })
      }}>
        <h2>信用卡还款</h2>
        <div className="bank-credit-overview"><CreditCard size={24} /><span>当前待还<strong>¥ {formatAmount(card.outstanding)}</strong></span></div>
        <label>付款储蓄卡<SelectControl value={source} onValueChange={(value) => setSource(value)} disabled={busy}>{debit.map((c) => <SelectOption key={c.id} value={c.id}>{c.accountName} · 尾号{c.last4} · ¥{formatAmount(data.accounts.find((a) => a.id === c.accountId)?.balance ?? 0)}</SelectOption>)}</SelectControl></label>
        <label>还款金额（元）<Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" maxLength={14} required disabled={busy} /></label>
        <Button className="bank-primary bank-lift" disabled={busy || !debit.length || card.outstanding <= 0} type="submit">{busy ? '正在准备…' : '下一步 · 核对还款'}</Button>
        <p className="bank-page-note">支持部分或全额还款，金额不能超过当前待还。到账后同步恢复可用额度。</p>
      </form>}
      {mode === 'manage' && <div className="bank-payment-form">
        <h2>卡片管理</h2>
        <CardPasswordAction cardId={card.id} last4={card.last4} />
        <p className="bank-page-note">{card.kind === 'credit' ? '信用卡用于消费和还款，信用额度不计入账户余额。' : '储蓄卡独立记账，可转账、收款和设置每日转出限额。'}已挂失的卡片不能解锁。</p>
        {card.status === 'active' && <Button className="bank-payment-secondary bank-lift" disabled={busy} onClick={() => void prepare('lock_card', { cardId })} type="button">临时冻结</Button>}
        {card.status === 'locked' && <Button className="bank-payment-secondary bank-lift" disabled={busy} onClick={() => void prepare('unlock_card', { cardId })} type="button">解锁卡片</Button>}
        {card.status !== 'lost' && <Button className="bank-payment-secondary bank-lift" disabled={busy} onClick={() => void prepare('report_card_lost', { cardId })} type="button">挂失卡片</Button>}
        {card.status !== 'lost' && <form className="bank-payment-form" onSubmit={(e) => {
          e.preventDefault(); const cents = parsePaymentAmount(limit)
          if (cents === null) { setError('请输入有效限额'); return }
          void prepare(card.kind === 'credit' ? 'adjust_credit_limit' : 'adjust_card_limit', card.kind === 'credit' ? { cardId, creditLimit: cents / 100 } : { cardId, dailyLimit: cents / 100 })
        }}><label>{card.kind === 'credit' ? '信用总额度（元）' : '每日转出限额（元）'}<Input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} disabled={busy} /></label><Button className="bank-primary bank-lift" disabled={busy} type="submit">调整额度 / 限额</Button></form>}
      </div>}
    </Reveal>}
    {error && <p className="bank-error" role="alert">{error}</p>}
  </div>
}

export function CardApplication() {
  const [kind, setKind] = useState<'debit' | 'credit'>('debit'), [remark, setRemark] = useState('')
  const [pending, setPending] = useState<Extract<ToolOutcome, { status: 'needs_confirmation' }>>()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  return <div className="bank-payment-scroll">{pending ? <PaymentApproval pending={pending} onBack={() => setPending(undefined)} onComplete={() => {}} /> : <form className="bank-payment-form" onSubmit={async (e) => {
    e.preventDefault(); setBusy(true); setError('')
    try {
      const res = await fetch('/api/payments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'apply_card', args: { kind, remark } }) })
      const out = await res.json()
      if (out.status !== 'needs_confirmation') throw new Error(out.message ?? out.error ?? '申请失败')
      setPending(out)
    } catch (e) { setError(e instanceof Error ? e.message : '申请失败') } finally { setBusy(false) }
  }}><h2>申请新卡</h2><label>卡片类型<SelectControl value={kind} onValueChange={(value) => setKind((value ?? '') as 'debit' | 'credit')} disabled={busy}><SelectOption value="debit">储蓄卡</SelectOption><SelectOption value="credit">信用卡</SelectOption></SelectControl></label><label>卡片备注<Input value={remark} maxLength={30} onChange={(e) => setRemark(e.target.value)} disabled={busy} /></label><p className="bank-page-note">申请文财模拟银行卡，新卡独立记账。信用卡初始模拟额度为 20,000 元。</p><Button className="bank-primary bank-lift" disabled={busy} type="submit">{busy ? '准备中…' : '下一步 · 核对申请'}</Button></form>}{error && <p className="bank-error">{error}</p>}</div>
}
