import { z } from 'zod'
import { defineBankTool } from './define'
import {
  addPaymentPayee,
  listPaymentPayees,
  lookupSchema,
  maskAccount,
  resolveRecipientReference,
  reverseTransfer,
  searchBankAccounts,
  settleTransfer,
  transferSummary,
} from '#/server/payments/service'

export const searchAccounts = defineBankTool({
  name: 'search_bank_accounts',
  description:
    '添加收款人前，用完整手机号或完整文财账号＋户名查找银行账户。只返回脱敏候选，不返回他人余额；多个候选须让用户选择。',
  kind: 'read',
  baseRisk: 'green',
  inputSchema: lookupSchema,
  execute: searchBankAccounts,
})
export const listPayees = defineBankTool({
  name: 'list_payees',
  description: '列出当前用户保存的收款人及脱敏账号。',
  kind: 'read',
  baseRisk: 'green',
  inputSchema: z.object({}),
  execute: (_a, ctx) => listPaymentPayees(ctx.userId),
})
export const addPayee = defineBankTool({
  name: 'add_payee',
  description:
    '添加已查找到的文财银行收款账户；reference 必须来自 search_bank_accounts 的用户所选候选，添加需用户确认。',
  kind: 'write',
  baseRisk: 'yellow',
  inputSchema: z.object({
    reference: z.string().max(2000),
    alias: z.string().trim().max(30).optional(),
  }),
  summarize: async (a, ctx) => {
    const target = await resolveRecipientReference(a.reference, ctx.userId)
    return {
      title: '确认添加收款人',
      fields: [
        { label: '户名', value: target.name },
        { label: '账号', value: maskAccount(target.accountNo) },
        { label: '开户银行', value: '文财银行' },
        ...(a.alias ? [{ label: '备注名', value: a.alias }] : []),
      ],
    }
  },
  execute: (a, ctx) => addPaymentPayee(a.reference, a.alias, ctx),
})
export const transferBetweenAccounts = defineBankTool({
  name: 'transfer_between_accounts',
  description:
    '本人名下银行账户互转。fromAccountId、toAccountId 必须来自 get_accounts；金额单位为分，须用户确认。',
  kind: 'write',
  baseRisk: 'yellow',
  inputSchema: z.object({
    fromAccountId: z.string(),
    toAccountId: z.string(),
    amountCents: z.number().int().positive().max(100_000_000),
    memo: z.string().max(50).optional(),
  }),
  summarize: transferSummary,
  factsHint: (a) => ({ toAccountId: a.toAccountId }),
  execute: settleTransfer,
  compensate: (_a, output, ctx) => reverseTransfer(output.transactionId, ctx),
})
export const PAYMENT_TOOLS = [searchAccounts, listPayees, addPayee, transferBetweenAccounts]
