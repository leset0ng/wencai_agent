import { z } from 'zod'
import type { ResolvedInteractionTemplate } from './agent-interaction-template'

export const BatchTransferRequestSchema = z.object({
  transfers: z.array(z.object({
    recipientQuery: z.string().trim().min(1).max(60),
    amountYuan: z.number().positive().max(1_000_000).refine((amount) => Math.abs(amount * 100 - Math.round(amount * 100)) < .00001, '金额必须精确到分'),
    note: z.string().min(1).max(50).optional(),
  }).strict()).min(2).max(8),
}).strict()
export const BatchRecipientSchema = z.object({ id: z.string(), name: z.string(), alias: z.string().nullable().optional(), bank: z.string(), account: z.string() })
export const BatchCardSchema = z.object({ id: z.string(), accountId: z.string().nullable().optional(), remark: z.string(), last4: z.string().regex(/^\d{4}$/), kind: z.literal('debit'), status: z.literal('active'), balance: z.number() })
export interface BatchTransferReady {
  status: 'batch_transfer_ready'
  interaction: ResolvedInteractionTemplate
  recipients: { stepId: string; query: string; amount: string; candidates: z.infer<typeof BatchRecipientSchema>[] }[]
  cards: z.infer<typeof BatchCardSchema>[]
}
