import { randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import { ensureCardPasswordSchema, hashCardPassword, migrateLegacyCardPassword, verifyCardPassword } from '#/server/cards/password'
import { ensureCardNumberSchema, readCardNumber } from '#/server/cards/numbers'
import { pendingCardRequirement } from './card-requirement'
import { withUserExecutionLock } from '#/server/confirm/lock'
import { auditInTransaction } from '#/server/audit/log'
import { verifyStrongStepUp, type StrongStepUp } from '#/server/auth/step-up'
import type { AgentContext } from '#/server/agent/context'
import { collectFacts } from '#/server/policy/facts'
import { resolveTool } from '#/server/tools/bank'
import { transferVerification } from './verification-policy'
import { env } from '#/server/env'

export type SecurePurpose = 'confirm_action' | 'view_card' | 'change_card_password'
export async function ownedSecureRequest(ctx: AgentContext, id: string, allowExpired = false) {
  await ensureCardPasswordSchema()
  const [row] = await db.select().from(schema.bankSecureRequests).where(and(eq(schema.bankSecureRequests.id, id), eq(schema.bankSecureRequests.userId, ctx.userId), eq(schema.bankSecureRequests.sessionId, ctx.sessionId)))
  if (!row || (!allowExpired && row.expiresAt <= new Date())) throw new Error('安全页面已过期或不属于当前登录账户，请重新发起')
  return row
}
export async function createSecureRequest(ctx: AgentContext, input: { purpose: SecurePurpose; cardId?: string; actionId?: string }) {
  await ensureCardPasswordSchema()
  let cardId = input.cardId
  if (input.purpose === 'confirm_action') {
    const [pending] = await db.select().from(schema.pendingActions).where(and(eq(schema.pendingActions.id, input.actionId ?? ''), eq(schema.pendingActions.userId, ctx.userId)))
    if (!pending || pending.status !== 'pending' || pending.expiresAt <= new Date()) throw new Error('操作不存在、已处理或已过期')
    const requirement = await pendingCardRequirement(pending)
    cardId = requirement && !requirement.newCard ? requirement.cardId : undefined
  } else {
    const [card] = await db.select().from(schema.cards).where(and(eq(schema.cards.id, cardId ?? ''), eq(schema.cards.userId, ctx.userId)))
    if (!card) throw new Error('银行卡不存在或不属于你')
    await db.transaction((tx) => migrateLegacyCardPassword(tx, ctx.userId, card.id))
  }
  const id = `secure_${randomUUID()}`
  await db.insert(schema.bankSecureRequests).values({ id, userId: ctx.userId, sessionId: ctx.sessionId, purpose: input.purpose, cardId, actionId: input.purpose === 'confirm_action' ? input.actionId : undefined, expiresAt: new Date(Date.now() + 5 * 60_000) })
  return { id, url: `/secure-operation?requestId=${id}` }
}
export async function secureRequestInfo(ctx: AgentContext, id: string) {
  const row = await ownedSecureRequest(ctx, id)
  const [card] = row.cardId ? await db.select().from(schema.cards).where(and(eq(schema.cards.id, row.cardId), eq(schema.cards.userId, ctx.userId))) : []
  const [pending] = row.actionId ? await db.select().from(schema.pendingActions).where(and(eq(schema.pendingActions.id, row.actionId), eq(schema.pendingActions.userId, ctx.userId))) : []
  const requirement = pending ? await pendingCardRequirement(pending) : null
  const args = pending ? JSON.parse(pending.argsJson) : {}
  const facts = pending ? await collectFacts({ userId: ctx.userId, channel: ctx.channel, ...resolveTool(pending.tool)?.factsHint?.(args) }) : {}
  const policy = pending ? transferVerification(pending.tool, args, facts) : { transfer: false, dualRequired: false }
  return { id, purpose: row.purpose, status: row.status, card: card ? { id: card.id, last4: card.last4, kind: card.kind } : null,
    actionId: row.actionId, newPassword: row.purpose === 'change_card_password' || !!requirement?.newCard,
    passwordRequired: !!card, strongRequired: row.purpose === 'change_card_password' || (policy.transfer ? policy.dualRequired : pending?.level === 'red'),
    singleChoice: policy.transfer && !policy.dualRequired && !requirement?.newCard, dualRequired: policy.dualRequired, demoBiometrics: env.AUTH_DEMO_MODE,
    summary: pending ? JSON.parse(pending.summaryJson) as { title: string; fields: { label: string; value: string }[] } : null,
  }
}

export async function submitSecureRequest(ctx: AgentContext, id: string, input: { password?: string; method?: 'password' | 'sms' | 'fingerprint' | 'face'; stepUp?: StrongStepUp }) {
  const row = await ownedSecureRequest(ctx, id)
  if (!['pending', 'verified'].includes(row.status) || row.consumedAt) throw new Error('安全操作已处理，请重新发起')
  const [claimed] = await db.update(schema.bankSecureRequests).set({ status: 'processing' }).where(and(eq(schema.bankSecureRequests.id, id), inArray(schema.bankSecureRequests.status, ['pending', 'verified']), isNull(schema.bankSecureRequests.consumedAt))).returning()
  if (!claimed) throw new Error('安全操作正在处理')
  try {
    if (row.purpose === 'change_card_password') {
      const passwordHash = hashCardPassword(input.password ?? '')
      await withUserExecutionLock(ctx.userId, async () => {
        if (!(await verifyStrongStepUp(ctx.userId, `card-password:${id}`, input.stepUp))) throw new Error('请通过短信、指纹或人脸强验证后修改卡片密码')
        await db.transaction(async (tx) => {
          const [card] = await tx.select().from(schema.cards).where(and(eq(schema.cards.id, row.cardId!), eq(schema.cards.userId, ctx.userId)))
          if (!card) throw new Error('银行卡不存在或不属于你')
          const credential = await migrateLegacyCardPassword(tx, ctx.userId, card.id)
          await tx.insert(schema.bankCardPasswords).values({ cardId: card.id, userId: ctx.userId, passwordHash, version: (credential?.version ?? 0) + 1 })
            .onConflictDoUpdate({ target: schema.bankCardPasswords.cardId, set: { passwordHash, version: (credential?.version ?? 0) + 1 } })
          await auditInTransaction(tx, ctx, 'tx_password_set', { cardId: card.id, via: 'card_strong_verification' })
          await tx.update(schema.bankSecureRequests).set({ status: 'completed', resultJson: JSON.stringify({ ok: true, cardId: card.id }), passwordHash: null }).where(eq(schema.bankSecureRequests.id, id))
        })
      })
      return { ok: true }
    }
    if (row.purpose === 'view_card') {
      const version = await verifyCardPassword(ctx, row.cardId!, input.password ?? '')
      await db.update(schema.bankSecureRequests).set({ status: 'verified', passwordVersion: version }).where(eq(schema.bankSecureRequests.id, id))
      return { ok: true }
    }
    const [pending] = await db.select().from(schema.pendingActions).where(and(eq(schema.pendingActions.id, row.actionId!), eq(schema.pendingActions.userId, ctx.userId)))
    if (!pending || pending.status !== 'pending') throw new Error('操作已处理或不存在')
    const requirement = await pendingCardRequirement(pending)
    const method = input.method ?? 'password'
    const args = JSON.parse(pending.argsJson)
    const facts = await collectFacts({ userId: ctx.userId, channel: ctx.channel, ...resolveTool(pending.tool)?.factsHint?.(args) })
    const policy = transferVerification(pending.tool, args, facts)
    if (method !== 'password' && (!policy.transfer || policy.dualRequired || requirement?.newCard)) throw new Error('本次操作必须先验证银行卡交易密码')
    const passwordHash = requirement?.newCard ? hashCardPassword(input.password ?? '') : null
    const version = requirement && !requirement.newCard ? method === 'password' ? await verifyCardPassword(ctx, requirement.cardId, input.password ?? '') : requirement.version : null
    await db.update(schema.bankSecureRequests).set({ status: 'verified', passwordHash, passwordVersion: version, verificationMethod: method }).where(eq(schema.bankSecureRequests.id, id))
    const { confirmPending } = await import('#/server/confirm/pending')
    // Pending authorization continues to belong to its original Agent session; the password page belongs to this authenticated browser session.
    const result = await confirmPending({ ctx: { ...ctx, sessionId: pending.sessionId }, actionId: pending.id, secureRequestId: id, stepUp: input.stepUp, resolveTool })
    if (!result.ok) {
      if (!['card_password_required', 'step_up_required', 'step_up_failed', 'plan_paused'].includes(result.code)) await db.update(schema.bankSecureRequests).set({ status: 'completed', passwordHash: null, resultJson: JSON.stringify(result) }).where(eq(schema.bankSecureRequests.id, id))
      return result
    }
    const response = { ...result, actionId: pending.id, userId: ctx.userId }
    await db.update(schema.bankSecureRequests).set({ status: 'completed', resultJson: JSON.stringify(response), passwordHash: null }).where(eq(schema.bankSecureRequests.id, id))
    return { ok: true }
  } catch (error) {
    await db.update(schema.bankSecureRequests).set({ status: 'pending', passwordHash: null }).where(and(eq(schema.bankSecureRequests.id, id), eq(schema.bankSecureRequests.status, 'processing')))
    throw error
  }
}
export async function consumeSecureResult(ctx: AgentContext, id: string) {
  await ensureCardNumberSchema()
  await ownedSecureRequest(ctx, id, true)
  return withUserExecutionLock(ctx.userId, () => db.transaction(async (tx) => {
    const [row] = await tx.select().from(schema.bankSecureRequests).where(eq(schema.bankSecureRequests.id, id))
    if (row.status === 'cancelled') return { cancelled: true }
    if (row.purpose === 'view_card') {
      if (row.expiresAt <= new Date()) throw new Error('安全页面已过期，请重新验证')
      if (row.status !== 'verified' || row.consumedAt) throw new Error('尚未验证或验证结果已使用')
      const [credential] = await tx.select().from(schema.bankCardPasswords).where(and(eq(schema.bankCardPasswords.cardId, row.cardId!), eq(schema.bankCardPasswords.userId, ctx.userId)))
      const [owner] = await tx.select().from(schema.users).where(eq(schema.users.id, ctx.userId))
      if (!credential || credential.version !== row.passwordVersion || (owner?.lockedUntil && owner.lockedUntil > new Date())) throw new Error('卡片安全状态已变化，请重新验证')
      const result = await readCardNumber(tx, ctx.userId, row.cardId!)
      await auditInTransaction(tx, ctx, 'action_executed', { action: 'view_card_number', cardId: row.cardId })
      await tx.update(schema.bankSecureRequests).set({ consumedAt: new Date(), status: 'completed' }).where(eq(schema.bankSecureRequests.id, id))
      return result
    }
    if (row.status !== 'completed' || !row.resultJson) throw new Error('操作尚未完成')
    // Non-secret receipts are idempotently readable; financial execution itself is one-use.
    return JSON.parse(row.resultJson) as Record<string, unknown>
  }))
}
export async function cancelSecureRequest(ctx: AgentContext, id: string) {
  const row = await ownedSecureRequest(ctx, id, true)
  if (row.status === 'completed' || row.status === 'issued') return { completed: true }
  const cancelled = await db.update(schema.bankSecureRequests).set({ status: 'cancelled', passwordHash: null }).where(and(eq(schema.bankSecureRequests.id, id), inArray(schema.bankSecureRequests.status, ['pending', 'verified']), isNull(schema.bankSecureRequests.consumedAt))).returning()
  if (!cancelled.length) throw new Error('操作正在处理，请等待结果')
  return { cancelled: true }
}
