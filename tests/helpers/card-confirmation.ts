import { and, eq } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import { confirmPending as original } from '#/server/confirm/pending'
import { pendingCardRequirement } from '#/server/security/card-requirement'
import { createSecureRequest } from '#/server/security/operation'
import { hashCardPassword } from '#/server/cards/password'

/** Other feature regressions start AFTER password verification. Dedicated security tests use the real path. */
export async function confirmPending(params: Parameters<typeof original>[0]) {
  const [row] = await db.select().from(schema.pendingActions).where(and(eq(schema.pendingActions.id, params.actionId), eq(schema.pendingActions.userId, params.ctx.userId)))
  if (!row || row.status !== 'pending' || row.expiresAt <= new Date()) return original(params)
  const requirement = await pendingCardRequirement(row)
  if (!requirement) return original(params)
  const request = await createSecureRequest(params.ctx, { purpose: 'confirm_action', actionId: row.id })
  await db.update(schema.bankSecureRequests).set({ status: 'verified', passwordHash: requirement.newCard ? hashCardPassword('743852') : null, passwordVersion: requirement.newCard ? null : requirement.version }).where(eq(schema.bankSecureRequests.id, request.id))
  return original({ ...params, secureRequestId: request.id })
}
