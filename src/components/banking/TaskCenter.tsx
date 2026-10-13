import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { PlanState } from '#/server/executor/executor'
import ToolPart from '#/components/chat/ToolPart'
import { MandateList } from './MandateList'

const labels: Record<string, string> = { running: '执行中', suspended: '等待确认', paused: '已暂停', completed: '已完成', failed: '未完成，需核对', compensated: '已回退', handoff: '等待人工处理', pending: '待执行', processing: '执行中，勿重复发起', succeeded: '已完成', cancelled: '已取消', awaiting_confirmation: '需要重新确认' }
export function TaskCenter({ onFollowUp }: { onFollowUp: (text: string) => void }) {
  const qc = useQueryClient(), [error, setError] = useState(''), [note, setNote] = useState(''), [busy, setBusy] = useState(false)
  const query = useQuery({ queryKey: ['plans'], queryFn: async () => {
    const res = await fetch('/api/plans'); if (!res.ok) throw new Error('无法读取任务'); return res.json() as Promise<{ plans: { id: string; status: string; state: PlanState }[]; tasks: { id: string; kind: string; status: string; dueAt: string }[] }>
  }, refetchInterval: 5000 })
  const control = async (planId: string, command: string) => {
    setBusy(true); setError('')
    try { const res = await fetch('/api/plans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ planId, command, note }) }); const data = await res.json(); if (!res.ok) throw new Error(data.message); await qc.invalidateQueries({ queryKey: ['plans'] }); await qc.invalidateQueries({ queryKey: ['dashboard'] }) }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败') } finally { setBusy(false) }
  }
  return <div><MandateList />{query.isPending && <p>读取任务中…</p>}{(error || query.error) && <p className="bank-error">{error || query.error?.message}</p>}
    {query.data?.plans.map((plan) => <article className="bank-payment-address" key={plan.id}><h3>{plan.state.plan.goal}</h3><p>{labels[plan.status] ?? plan.status}</p><ol>{plan.state.plan.nodes.map((node) => <li key={node.id}>{node.note || node.tool || '人工处理'} · {labels[plan.state.nodes[node.id].status] ?? plan.state.nodes[node.id].status}</li>)}</ol>
      {!['completed', 'compensated', 'failed'].includes(plan.status) && <div className="bank-card-actions">
        {plan.status !== 'paused' && <button className="bank-payment-secondary" disabled={busy} onClick={() => void control(plan.id, 'pause')}>暂停</button>}
        {['paused', 'suspended'].includes(plan.status) && <button className="bank-primary" disabled={busy} onClick={() => void control(plan.id, 'resume')}>恢复</button>}
        <button className="bank-payment-secondary" disabled={busy} onClick={() => void control(plan.id, 'cancel')}>取消并回退</button>
      </div>}
      {plan.status === 'handoff' && <div className="bank-payment-form"><label>人工处理说明<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="填写你已处理的事项，不代替银行回执" /></label><button className="bank-primary" disabled={busy || !note.trim()} onClick={() => void control(plan.id, 'complete_handoff')}>记录人工处理并继续</button></div>}
      {plan.status === 'failed' && <div className="bank-payment-form">{plan.state.manualReview ? <p>已记录核对：{plan.state.manualReview.note}</p> : <><p>部分操作无法自动回退。请核对实际流水后记录处理结果，此计划不会继续扣款。</p><label>核对结果<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></label><button className="bank-primary" disabled={busy || !note.trim()} onClick={() => void control(plan.id, 'acknowledge_failure')}>记录人工核对结果</button></>}</div>}
      {plan.status !== 'paused' && plan.state.plan.nodes.map((node) => {
        const item = plan.state.nodes[node.id]
        return item.status === 'suspended' && item.output ? <ToolPart key={item.actionId} part={{ type: `tool-${node.tool}`, toolCallId: item.actionId!, state: 'output-available', output: item.output }} onFollowUp={onFollowUp} /> : null
      })}
    </article>)}
    {query.data?.tasks.map((task) => <article className="bank-payment-address" key={task.id}><strong>{task.kind === 'transfer' ? '定时转账' : '预约任务'}</strong><p>{labels[task.status] ?? task.status}</p><small>{new Date(task.dueAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</small></article>)}
    {!query.isPending && !query.data?.plans.length && !query.data?.tasks.length && <p className="bank-empty">暂无任务</p>}
  </div>
}
