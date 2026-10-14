import type { BatchTransferReady } from '#/lib/batch-transfer'
import { AgentCardPicker, AgentChoiceList, AgentChoiceContext } from './AgentInteraction'
import { choiceFromRow } from './interaction-message'
import { useContext } from 'react'

/** All steps share the usual local draft and one confirm/cancel pair. */
export function BatchTransferView({ data }: { data: BatchTransferReady }) {
  const group = useContext(AgentChoiceContext)
  if (group?.securityConfirmation) return null
  return <section className="bank-batch-transfer" aria-label="多笔转账选择">
    <h3>核对 {data.recipients.length} 笔转账</h3>
    <p className="bank-agent-choice-hint">请逐笔核对收款人，再确认共用的付款卡。选择不会发送消息，确认后才会生成银行确认单。</p>
    {data.recipients.map((group, index) => <AgentChoiceList key={group.stepId} title={`第${index + 1}笔 · 给${group.query}转 ${group.amount} 元`}
      choices={group.candidates.map((row) => ({ ...choiceFromRow(row, 'recipient')!, stepId: group.stepId, slot: `${group.stepId}:收款人` }))} />)}
    <AgentCardPicker title="选择共用的付款储蓄卡" role="source" choices={data.cards.map((row) => choiceFromRow(row, 'card')!)} />
  </section>
}
