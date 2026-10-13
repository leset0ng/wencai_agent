import { and, eq } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import type { AuditTransaction } from '#/server/audit/log'
import type { AgentContext } from '#/server/agent/context'
import { readAccountRiskFlag } from './accounts'
import type { PolicyFacts } from '#/server/policy/types'

export function parseRiskAcknowledgement(json: string | null | undefined): { accountId: string; revision: number } | undefined {
  try {
    const value = JSON.parse(json ?? 'null')
    if (value && typeof value.accountId === 'string' && Number.isSafeInteger(value.revision) && value.revision > 0) return { accountId: value.accountId, revision: value.revision }
  } catch { /* An old or corrupt grant never acknowledges a new recipient flag. */ }
}

export function riskAcknowledged(facts: PolicyFacts, ack: ReturnType<typeof parseRiskAcknowledgement>) {
  return facts.payeeRiskFlag !== 'suspected' || (ack?.accountId === facts.payeeRiskAccountId && ack?.revision === facts.payeeRiskRevision)
}

/** Resolve actual bank records, never a model-supplied risk level or arbitrary third-party identity. */
export async function resolveRiskRecipient(params: { userId: string; payeeId?: string; toAccountId?: string; splitRequestId?: string }) {
  if (params.payeeId) {
    const [payee] = await db.select().from(schema.payees).where(and(eq(schema.payees.id, params.payeeId), eq(schema.payees.userId, params.userId)))
    if (!payee) return undefined
    const [link] = await db.select().from(schema.bankPayeeLinks).where(and(eq(schema.bankPayeeLinks.payeeId, payee.id), eq(schema.bankPayeeLinks.userId, params.userId)))
    // Address lookup also covers legacy rows without a bankPayeeLinks record.
    const [address] = await db.select().from(schema.bankAccountAddresses).where(eq(schema.bankAccountAddresses.accountNo, payee.accountNo))
    return address?.accountId ?? link?.targetAccountId
  }
  if (params.splitRequestId) {
    const [request] = await db.select().from(schema.bankSplitRequests).where(and(eq(schema.bankSplitRequests.id, params.splitRequestId), eq(schema.bankSplitRequests.payerUserId, params.userId)))
    return request?.targetAccountId
  }
  if (params.toAccountId) {
    const [account] = await db.select({ id: schema.accounts.id }).from(schema.accounts).where(and(eq(schema.accounts.id, params.toAccountId), eq(schema.accounts.userId, params.userId)))
    return account?.id
  }
}

export class RecipientRiskChanged extends Error {
  constructor(public readonly confirmed: boolean) {
    super(confirmed ? '该收款账户经人工复核存在高风险，已阻止本次转账，请联系人工客服' : '收款账户风险标记已变化，请重新核对并完成本次强验证')
  }
}

/** Last check inside settlement's write transaction closes the review/OTP race. */
export async function assertRecipientRisk(tx: AuditTransaction, accountId: string | undefined, authorization: AgentContext['authorization']) {
  if (!accountId) return
  const flag = await readAccountRiskFlag(accountId, tx)
  if (flag?.status === 'confirmed') throw new RecipientRiskChanged(true)
  if (flag?.status === 'suspected' && (authorization?.level !== 'red' || authorization.payeeRisk?.accountId !== accountId || authorization.payeeRisk.revision !== flag.revision)) throw new RecipientRiskChanged(false)
}
