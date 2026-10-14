import { z } from 'zod'
import { BatchTransferRequestSchema, BatchRecipientSchema, BatchCardSchema, type BatchTransferReady } from '#/lib/batch-transfer'
import { requestedTransferMatches, transferClauseAmounts } from '#/lib/requested-amounts'
import type { ToolOutcome } from '#/server/tools/define'

type Reader = (tool: 'find_payee' | 'list_cards', args: Record<string, unknown>) => Promise<ToolOutcome>

/** Read-only preparation. Each step owns its candidate set; no money or authorization moves here. */
export async function prepareTransferBatch(input: unknown, requestText: string, read: Reader): Promise<BatchTransferReady | { status: 'needs_information'; errors: string[] }> {
  const parsed = BatchTransferRequestSchema.safeParse(input)
  if (!parsed.success) return { status: 'needs_information', errors: parsed.error.issues.map((issue) => issue.message) }
  const used = new Set<number>(), errors: string[] = []
  for (const [index, transfer] of parsed.data.transfers.entries()) {
    const occurrence = requestedTransferMatches(requestText, transfer.recipientQuery, transfer.amountYuan).find((position) => !used.has(position))
    if (occurrence === undefined) errors.push(`第${index + 1}笔：请确认${transfer.recipientQuery}对应的转账金额，不能从其他收款人或历史任务借用金额。`)
    else used.add(occurrence)
    if (transfer.note && (!requestText.includes(transfer.note) || /密码|验证码|验证.*(?:通过|成功)|跳过验证|无需验证/.test(transfer.note))) errors.push(`第${index + 1}笔：备注须来自当前请求且不能包含安全验证信息。`)
  }
  for (const clause of transferClauseAmounts(requestText)) {
    if (!used.has(clause.position)) errors.push(`当前请求中还有给${clause.recipient}的${clause.amount}元转账未被纳入，请补齐本次每笔需求，不能静默丢弃。`)
  }
  if (errors.length) return { status: 'needs_information', errors }
  const recipients: BatchTransferReady['recipients'] = []
  for (const [index, transfer] of parsed.data.transfers.entries()) {
    const result = await read('find_payee', { query: transfer.recipientQuery })
    const rows = result.status === 'done' ? z.object({ candidates: z.array(BatchRecipientSchema) }).safeParse(result.data) : undefined
    if (!rows?.success || !rows.data.candidates.length) errors.push(`第${index + 1}笔：未找到${transfer.recipientQuery}的可核对收款账户，请核对姓名、备注或先添加收款人。`)
    else recipients.push({ stepId: `step-${index + 1}`, query: transfer.recipientQuery, amount: transfer.amountYuan.toFixed(2), candidates: rows.data.candidates })
  }
  const result = await read('list_cards', {})
  const cards = result.status === 'done' && Array.isArray(result.data)
    ? result.data.flatMap((row) => { const card = BatchCardSchema.safeParse(row); return card.success ? [card.data] : [] }) : []
  if (!cards.length) errors.push('暂无可付款的正常储蓄卡，请先申请储蓄卡或处理卡片状态。')
  if (errors.length) return { status: 'needs_information', errors }
  return {
    status: 'batch_transfer_ready', cards, recipients,
    interaction: { version: '1', intent: 'batch_transfer', fields: {}, steps: recipients.map((group, index) => ({
      id: group.stepId, recipientQuery: group.query, recipientIds: group.candidates.map((candidate) => candidate.id),
      fields: { amount: group.amount, ...(parsed.data.transfers[index].note ? { note: parsed.data.transfers[index].note } : {}) },
    })) },
  }
}
