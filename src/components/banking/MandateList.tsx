import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

type Mandate = {
  id: string; payeeName: string; amount: number; cadence: string; status: string
  executionsDone: number; maxExecutions: number; totalSpent: number; maxTotal: number
  minIntervalDays: number; nextDueAt: string | null; expiresAt: string; endedReason: string | null
}

const STATUS: Record<string, string> = {
  active: '生效中', revoked: '已撤销', expired: '已到期', exhausted: '已用完', suspended: '已暂停，需重新授权',
}
const when = (iso: string) => new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
const money = (value: number) => `¥${value.toFixed(2)}`

/**
 * 定期转账授权列表。只做查看与撤销：创建要在对话里完成强验证，执行由系统到期触发。
 * 把每一项硬上限都摆出来，用户能直接看到"最多还会转多少、到什么时候为止"。
 */
export function MandateList() {
  const client = useQueryClient()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const query = useQuery({
    queryKey: ['mandates'],
    refetchInterval: 5000,
    queryFn: async () => {
      const res = await fetch('/api/mandates')
      if (!res.ok) throw new Error('无法读取定期转账授权')
      return (await res.json()) as { mandates: Mandate[] }
    },
  })
  const revoke = async (id: string) => {
    setBusy(id); setError('')
    try {
      const res = await fetch('/api/mandates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mandateId: id, command: 'revoke' }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message ?? '撤销失败')
      await client.invalidateQueries({ queryKey: ['mandates'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : '撤销失败')
    } finally {
      setBusy('')
    }
  }
  const items = query.data?.mandates ?? []
  if (!items.length && !query.error) return null
  return (
    <section aria-label="定期转账授权">
      <h3 className="bank-subtitle">定期转账授权</h3>
      {(error || query.error) && <p className="bank-error">{error || query.error?.message}</p>}
      {items.map((m) => {
        const live = m.status === 'active'
        return (
          <article className="bank-payment-address" key={m.id}>
            <strong>向 {m.payeeName} {m.cadence} 转 {money(m.amount)}</strong>
            <p>{STATUS[m.status] ?? m.status}</p>
            <small>
              已执行 {m.executionsDone}/{m.maxExecutions} 次，累计 {money(m.totalSpent)}，上限 {money(m.maxTotal)}；
              两次至少相隔 {m.minIntervalDays} 天；有效期至 {when(m.expiresAt)}
              {live && m.nextDueAt ? `；下次执行 ${when(m.nextDueAt)}` : ''}
            </small>
            {!live && m.endedReason && <small>{m.endedReason}</small>}
            {(live || m.status === 'suspended') && (
              <div className="bank-card-actions">
                <button className="bank-payment-secondary" disabled={busy === m.id} onClick={() => void revoke(m.id)}>
                  {busy === m.id ? '撤销中…' : '撤销授权'}
                </button>
              </div>
            )}
          </article>
        )
      })}
    </section>
  )
}
