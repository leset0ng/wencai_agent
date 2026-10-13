import { Button } from '#/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '#/components/ui/toggle-group'
import { Input } from '#/components/ui/input'
import { SelectControl, SelectOption } from '#/components/ui/select'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowRightLeft,
  Check,
  CheckCircle2,
  Copy,
  Loader2,
  Plus,
  Search,
  ShieldCheck,
  UsersRound,
  Wallet,
} from 'lucide-react'
import ConfirmCard from '#/components/chat/ConfirmCard'
import { Reveal } from '#/components/ui/motion'
import { ConfirmError, useCancelAction, useConfirmAction } from '#/lib/queries'
import { parsePaymentAmount } from '#/lib/payment-amount'
import type { ToolOutcome } from '#/server/tools/define'

export type PaymentView = 'transfer' | 'payees' | 'receive'
type Account = {
  id: string
  name: string
  accountNo: string
  cardLast4?: string
  ownerName: string
  bank: string
  currency: string
  balanceCents: number
}
type Payee = {
  id: string
  name: string
  alias: string | null
  bank: string
  account: string
  internal: boolean
}
type Candidate = {
  name: string
  accountName: string
  account: string
  bank: string
  reference: string
}
type Pending = Extract<ToolOutcome, { status: 'needs_confirmation' }>
const money = (cents: number) =>
  (cents / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

async function request<T>(body?: unknown): Promise<T> {
  const res = await fetch('/api/payments', {
    credentials: 'same-origin',
    ...(body
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? '请求失败，请重试')
  return data
}

export default function PaymentCenter({
  userId,
  initialView,
  initialAccountId,
}: {
  userId: string
  initialView: PaymentView
  initialAccountId?: string
}) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['payments', userId],
    queryFn: () => request<{ accounts: Account[]; payees: Payee[] }>(),
    staleTime: 0,
    retry: false,
  })
  const [view, setView] = useState(initialView)
  const [adding, setAdding] = useState(false)
  const [ownTransfer, setOwnTransfer] = useState(false)
  const [source, setSource] = useState(initialAccountId ?? '')
  const [destination, setDestination] = useState('')
  const [payeeId, setPayeeId] = useState('')
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [method, setMethod] = useState<'phone' | 'account'>('phone')
  const [phone, setPhone] = useState('')
  const [accountNo, setAccountNo] = useState('')
  const [name, setName] = useState('')
  const [alias, setAlias] = useState('')
  const [candidates, setCandidates] = useState<Candidate[]>()
  const [chosen, setChosen] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<Pending>()
  const [receipt, setReceipt] = useState<Record<string, unknown>>()
  const [copied, setCopied] = useState('')
  const accounts = query.data?.accounts.filter((a) => a.currency === 'CNY').sort((a, b) => Number(b.id === initialAccountId) - Number(a.id === initialAccountId)) ?? []
  const payees = query.data?.payees ?? []
  const fromId = source || accounts[0]?.id || ''
  const from = accounts.find((a) => a.id === fromId)
  const go = (next: PaymentView) => {
    setView(next)
    setAdding(false)
    setReceipt(undefined)
    setError('')
  }
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['payments', userId] })
    void qc.invalidateQueries({ queryKey: ['dashboard', userId] })
  }
  const lookupChanged = () => {
    setCandidates(undefined)
    setChosen('')
    setError('')
  }
  async function prepare(tool: string, args: unknown) {
    setBusy(true)
    setError('')
    try {
      const out = await request<ToolOutcome>({ tool, args })
      if (out.status === 'needs_confirmation') setPending(out)
      else if (out.status === 'error') throw new Error(out.message)
      else if (out.status === 'denied') throw new Error(out.reasons.join('；'))
      else throw new Error('未能生成确认单，请重试')
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }
  async function lookup() {
    setBusy(true)
    lookupChanged()
    try {
      const out = await request<ToolOutcome>({
        tool: 'search_bank_accounts',
        args: method === 'phone' ? { method, phoneNumber: phone } : { method, accountNo, name },
      })
      if (out.status !== 'done')
        throw new Error(out.status === 'error' ? out.message : '无法查找，请稍后重试')
      const result = out.data as { candidates: Candidate[] }
      setCandidates(result.candidates)
      if (!result.candidates.length) setError('未找到匹配账户，请核对手机号，或账号与户名。')
    } catch (e) {
      setError(e instanceof Error ? e.message : '查找失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="bank-payment-scroll">
      <p className="bank-payment-caption">
        <ShieldCheck size={14} /> 核对信息后确认，每一笔都清晰可查
      </p>
      {!pending && !receipt && (
        <nav className="bank-payment-tabs" aria-label="转账服务">
          {(
            [
              { id: 'transfer', name: '转账', Icon: ArrowRightLeft },
              { id: 'payees', name: '收款人', Icon: UsersRound },
              { id: 'receive', name: '我的收款账号', Icon: Wallet },
            ] as const
          ).map(({ id, name: label, Icon }) => (
            <Button
              type="button"
              key={id}
              className={`bank-lift${view === id ? ' is-active' : ''}`}
              aria-pressed={view === id}
              disabled={busy}
              onClick={() => go(id)}
            >
              <Icon size={15} />
              {label}
            </Button>
          ))}
        </nav>
      )}
      {query.isPending ? (
        <p className="bank-empty">
          <Loader2 className="bank-spin" size={20} /> 正在读取账户…
        </p>
      ) : query.isError ? (
        <div role="alert" className="bank-error">
          {query.error.message}
          <Button type="button" onClick={() => void query.refetch()} className="ui-button-reset">
            重新加载
          </Button>
        </div>
      ) : pending ? (
        <Reveal key={pending.actionId}>
          <PaymentApproval
            pending={pending}
            onBack={() => {
              setPending(undefined)
              invalidate()
            }}
            onComplete={(output) => {
              setReceipt(output as Record<string, unknown>)
              setPending(undefined)
              setAmount('')
              setMemo('')
              setAdding(false)
              setCandidates(undefined)
              setChosen('')
              invalidate()
            }}
          />
        </Reveal>
      ) : receipt ? (
        <Reveal>
          <div className="bank-payment-receipt" role="status">
            <CheckCircle2 size={48} />
            <h2>{receipt.transactionId ? '转账成功' : '收款人已添加'}</h2>
            {typeof receipt.amount === 'number' && (
              <strong>¥ {money(Math.round(receipt.amount * 100))}</strong>
            )}
            <p>{String(receipt.payee ?? receipt.name ?? '')}</p>
            <p>{String(receipt.account ?? '')}</p>
            {typeof receipt.fromAccount === 'string' && <p>付款账户：{receipt.fromAccount}</p>}
            {typeof receipt.transactionId === 'string' && (
              <small>流水号：{receipt.transactionId}</small>
            )}
            {receipt.settlement === 'internal' && <p>收款账户已入账</p>}
            <Button
              type="button"
              className="bank-primary bank-lift bank-full-width"
              onClick={() => {
                if (typeof receipt.payeeId === 'string') {
                  setPayeeId(receipt.payeeId)
                  setOwnTransfer(false)
                }
                go('transfer')
              }}
            >
              {receipt.transactionId ? '继续转账' : '向该收款人转账'}
            </Button>
            <Button
              type="button"
              className="bank-text-button bank-lift"
              onClick={() => go('payees')}
            >
              查看收款人
            </Button>
          </div>
        </Reveal>
      ) : (
        <>
          {view === 'transfer' && (
            <Reveal>
              <form
                className="bank-payment-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  setError('')
                  const cents = parsePaymentAmount(amount)
                  if (!cents) {
                    setError('请输入有效金额，最多两位小数，单笔最多 100 万元')
                    return
                  }
                  if (!from || from.balanceCents < cents) {
                    setError('付款账户余额不足')
                    return
                  }
                  if (ownTransfer && (!destination || destination === fromId)) {
                    setError('请选择不同的本人收款账户')
                    return
                  }
                  if (!ownTransfer && !payeeId) {
                    setError('请选择收款人')
                    return
                  }
                  void prepare(
                    ownTransfer ? 'transfer_between_accounts' : 'transfer',
                    ownTransfer
                      ? {
                          fromAccountId: fromId,
                          toAccountId: destination,
                          amountCents: cents,
                          memo,
                        }
                      : {
                          fromAccountId: fromId,
                          payeeId,
                          amount: cents / 100,
                          memo,
                        },
                  )
                }}
              >
                <ToggleGroup className="bank-payment-switch" aria-label="转账方式" value={ownTransfer ? 'own' : 'payee'} onValueChange={(value) => { setOwnTransfer(value === 'own'); setError('') }}>
                  <ToggleGroupItem value="payee"
                    disabled={busy}
                    type="button"
                    className={`bank-lift${!ownTransfer ? ' is-active' : ''}`}
                    aria-pressed={!ownTransfer}
                  >
                    转给收款人
                  </ToggleGroupItem>
                  <ToggleGroupItem value="own"
                    disabled={busy}
                    type="button"
                    className={`bank-lift${ownTransfer ? ' is-active' : ''}`}
                    aria-pressed={ownTransfer}
                  >
                    本人互转
                  </ToggleGroupItem>
                </ToggleGroup>
                <label>
                  付款账户
                  <SelectControl
                    disabled={busy}
                    value={fromId}
                    onValueChange={(value) => {
                      setSource(value)
                      setDestination('')
                      setError('')
                    }}
                    required
                  >
                    <SelectOption value="" disabled>
                      请选择付款账户
                    </SelectOption>
                    {accounts.map((a) => (
                      <SelectOption key={a.id} value={a.id}>
                        {a.name}{!a.cardLast4 ? ` · 尾号 ${a.accountNo.slice(-4)}` : ''}
                      </SelectOption>
                    ))}
                  </SelectControl>
                </label>
                {from && (
                  <small className="bank-payment-balance">
                    可用余额 ¥ {money(from.balanceCents)}
                  </small>
                )}
                {ownTransfer ? (
                  <label>
                    收款账户
                    <SelectControl
                      disabled={busy}
                      value={destination}
                      required
                      onValueChange={(value) => setDestination(value)}
                    >
                      <SelectOption value="">请选择本人收款账户</SelectOption>
                      {accounts
                        .filter((a) => a.id !== fromId)
                        .map((a) => (
                          <SelectOption key={a.id} value={a.id}>
                            {a.name}{!a.cardLast4 ? ` · 尾号 ${a.accountNo.slice(-4)}` : ''}
                          </SelectOption>
                        ))}
                    </SelectControl>
                    {accounts.length < 2 && <small>本人互转需要至少两个人民币账户。</small>}
                  </label>
                ) : (
                  <>
                    <label>
                      收款人
                      <SelectControl
                        disabled={busy}
                        value={payeeId}
                        required
                        onValueChange={(value) => setPayeeId(value)}
                      >
                        <SelectOption value="">请选择收款人</SelectOption>
                        {payees.map((p) => (
                          <SelectOption key={p.id} value={p.id}>
                            {p.alias ? `${p.alias} · ` : ''}
                            {p.name} · {p.account.slice(-4)}
                          </SelectOption>
                        ))}
                      </SelectControl>
                    </label>
                    <Button
                      type="button"
                      className="bank-text-button bank-lift"
                      onClick={() => {
                        go('payees')
                        setAdding(true)
                      }}
                    >
                      <Plus size={16} /> 添加新收款人
                    </Button>
                  </>
                )}
                <label className="bank-payment-amount">
                  转账金额（元）
                  <div>
                    <span>¥</span>
                    <Input
                      disabled={busy}
                      aria-label="转账金额（元）"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      maxLength={14}
                      required
                    />
                  </div>
                </label>
                <label>
                  转账备注（选填）
                  <Input
                    disabled={busy}
                    value={memo}
                    onChange={(e) => setMemo(e.target.value)}
                    maxLength={50}
                    placeholder="例如：生活费"
                  />
                </label>
                <Button
                  className="bank-primary bank-lift bank-full-width"
                  disabled={busy || !accounts.length} type="submit"
                >
                  {busy ? '正在准备…' : '下一步 · 核对转账'}
                </Button>
                <p className="bank-page-note">
                  文财银行账户实时入账；已有外部银行卡收款人为模拟转出。
                </p>
              </form>
            </Reveal>
          )}
          {view === 'payees' && (
            <Reveal>
              {adding ? (
                <form
                  className="bank-payment-form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void lookup()
                  }}
                >
                  <Button
                    type="button"
                    className="bank-text-button bank-lift"
                    disabled={busy}
                    onClick={() => {
                      setAdding(false)
                      setError('')
                    }}
                  >
                    <ArrowLeft size={16} /> 返回收款人
                  </Button>
                  <h2>添加收款人</h2>
                  <ToggleGroup className="bank-payment-switch" aria-label="收款人查找方式" value={method} onValueChange={(value) => { setMethod(value as 'phone' | 'account'); lookupChanged() }}>
                    <ToggleGroupItem value="phone"
                      disabled={busy}
                      type="button"
                      className={`bank-lift${method === 'phone' ? ' is-active' : ''}`}
                      aria-pressed={method === 'phone'}
                    >
                      手机号查找
                    </ToggleGroupItem>
                    <ToggleGroupItem value="account"
                      disabled={busy}
                      type="button"
                      className={`bank-lift${method === 'account' ? ' is-active' : ''}`}
                      aria-pressed={method === 'account'}
                    >
                      账号与户名
                    </ToggleGroupItem>
                  </ToggleGroup>
                  {method === 'phone' ? (
                    <label>
                      收款人手机号
                      <Input
                        disabled={busy}
                        type="tel"
                        inputMode="tel"
                        value={phone}
                        maxLength={11}
                        onChange={(e) => {
                          setPhone(e.target.value)
                          lookupChanged()
                        }}
                        placeholder="请输入注册手机号"
                        pattern="1[0-9]{10}"
                        required
                      />
                    </label>
                  ) : (
                    <>
                      <label>
                        文财银行账号
                        <Input
                          disabled={busy}
                          inputMode="numeric"
                          value={accountNo}
                          maxLength={16}
                          onChange={(e) => {
                            setAccountNo(e.target.value)
                            lookupChanged()
                          }}
                          placeholder="请输入完整 16 位账号"
                          pattern="[0-9]{16}"
                          required
                        />
                      </label>
                      <label>
                        收款户名
                        <Input
                          disabled={busy}
                          value={name}
                          maxLength={60}
                          onChange={(e) => {
                            setName(e.target.value)
                            lookupChanged()
                          }}
                          placeholder="请输入真实户名"
                          required
                        />
                      </label>
                    </>
                  )}
                  <Button className="bank-payment-secondary bank-lift" disabled={busy} type="submit">
                    <Search size={16} />
                    {busy ? '查找中…' : '查找收款账户'}
                  </Button>
                  {candidates && candidates.length > 0 && (
                    <fieldset className="bank-payment-candidates">
                      <legend>请选择收款账户</legend>
                      {candidates.map((c) => (
                        <label
                          key={c.reference}
                          className={`bank-payment-candidate bank-lift${chosen === c.reference ? ' is-selected' : ''}`}
                        >
                          <Input
                            disabled={busy}
                            type="radio"
                            name="recipient"
                            value={c.reference}
                            checked={chosen === c.reference}
                            onChange={() => setChosen(c.reference)}
                          />
                          <span>
                            <strong>
                              {c.name} · {c.accountName}
                            </strong>
                            <small>
                              {c.bank}　{c.account}
                            </small>
                          </span>
                          {chosen === c.reference && <Check size={17} />}
                        </label>
                      ))}
                    </fieldset>
                  )}
                  {chosen && (
                    <>
                      <label>
                        备注名（选填）
                        <Input
                          disabled={busy}
                          value={alias}
                          maxLength={30}
                          onChange={(e) => setAlias(e.target.value)}
                          placeholder="例如：家人、朋友"
                        />
                      </label>
                      <Button
                        type="button"
                        className="bank-primary bank-lift bank-full-width"
                        disabled={busy}
                        onClick={() =>
                          void prepare('add_payee', {
                            reference: chosen,
                            alias,
                          })
                        }
                      >
                        {busy ? '正在准备…' : '添加收款人 · 核对信息'}
                      </Button>
                    </>
                  )}
                  <p className="bank-page-note">支持已注册文财银行的用户。只展示核对所需信息。</p>
                </form>
              ) : (
                <>
                  <div className="bank-section-heading">
                    <h2>我的收款人</h2>
                    <Button
                      type="button"
                      className="bank-text-button bank-lift"
                      onClick={() => {
                        setAdding(true)
                        lookupChanged()
                        setAlias('')
                      }}
                    >
                      <Plus size={16} /> 添加收款人
                    </Button>
                  </div>
                  <div className="bank-payment-payees">
                    {payees.map((p, i) => (
                      <Reveal key={p.id} delay={Math.min(i, 6) * 45}>
                        <Button
                          type="button"
                          className="bank-payment-payee bank-lift"
                          onClick={() => {
                            setPayeeId(p.id)
                            setOwnTransfer(false)
                            go('transfer')
                          }}
                        >
                          <span className="bank-transaction-icon">
                            <UsersRound size={19} />
                          </span>
                          <span>
                            <strong>
                              {p.alias || p.name}
                              {p.alias && <small> · {p.name}</small>}
                            </strong>
                            <small>
                              {p.bank}　{p.account}
                            </small>
                          </span>
                          <ArrowRightLeft size={17} />
                        </Button>
                      </Reveal>
                    ))}
                  </div>
                  {!payees.length && <p className="bank-empty">还没有收款人，添加后即可转账。</p>}
                </>
              )}
            </Reveal>
          )}
          {view === 'receive' && (
            <Reveal>
              <h2>我的收款账号</h2>
              <p className="bank-page-note">
                将账号与户名分享给付款人，也可让对方通过你的注册手机号查找。
              </p>
              {accounts.map((a, i) => (
                <Reveal key={a.id} delay={i * 65}>
                  <article className="bank-payment-address bank-lift">
                    <span>
                      {a.name}
                      <small>{a.bank}</small>
                    </span>
                    <strong>{a.accountNo.replace(/(.{4})/g, '$1 ').trim()}</strong>
                    <p>户名：{a.ownerName}</p>
                    <Button
                      type="button"
                      className="bank-text-button bank-lift"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(
                            `${a.bank}\n户名：${a.ownerName}\n账号：${a.accountNo}`,
                          )
                          setCopied(a.id)
                        } catch {
                          setError('复制失败，可长按账号手动复制')
                        }
                      }}
                    >
                      <Copy size={15} />
                      {copied === a.id ? '已复制' : '复制收款信息'}
                    </Button>
                  </article>
                </Reveal>
              ))}
              {!accounts.length && <p className="bank-empty">暂无人民币收款账户</p>}
            </Reveal>
          )}
          {error && (
            <p className="bank-error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  )
}

export function PaymentApproval({
  pending,
  onBack,
  onComplete,
}: {
  pending: Pending
  onBack: () => void
  onComplete: (output: unknown) => void
}) {
  const confirm = useConfirmAction(pending.actionId)
  const cancel = useCancelAction(pending.actionId)
  const error = confirm.error ?? cancel.error
  const terminal =
    confirm.error instanceof ConfirmError &&
    !['step_up_required', 'step_up_failed'].includes(confirm.error.data.code ?? '')
  return (
    <div className={`bank-payment-approval${pending.level === 'red' ? ' is-red' : ''}`}>
      <ConfirmCard
        {...pending}
        submitting={confirm.isPending || cancel.isPending}
        error={error?.message}
        done={terminal ? '本次操作未完成，请返回重新发起' : undefined}
        doneState="failed"
        onCompleted={(result) => onComplete(result.output)}
        onConfirm={async (stepUp) => {
          const result = await confirm.mutateAsync(stepUp)
          onComplete(result.output)
        }}
        onCancel={() => {
          void cancel
            .mutateAsync()
            .then(onBack)
            .catch(() => {})
        }}
      />
      {terminal && (
        <p className="bank-error" role="alert">
          {error?.message}
        </p>
      )}
      {terminal && (
        <Button
          type="button"
          className="bank-payment-secondary bank-lift bank-full-width"
          onClick={onBack}
        >
          返回重新填写
        </Button>
      )}
    </div>
  )
}
