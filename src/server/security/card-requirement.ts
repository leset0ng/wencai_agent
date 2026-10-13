import { and, eq, gt, isNull } from 'drizzle-orm'
import { auth, db, schema } from '#/server/db/client'
import { ensureCardPasswordSchema, migrateLegacyCardPassword } from '#/server/cards/password'

type Pending = typeof schema.pendingActions.$inferSelect
export async function pendingCardRequirement(row: Pending) {
  const [registered] = await db.select({ id: auth.baUser.id }).from(auth.baUser).where(eq(auth.baUser.id, row.userId))
  if (!registered) return null // Internal ledger-only fixtures are not customer sessions.
  if (row.tool === 'apply_card') return { newCard: true as const }
  const args = JSON.parse(row.argsJson) as Record<string, unknown>
  const cardId = args.sourceCardId ?? args.fromCardId ?? args.cardId
  const accountId = args.fromAccountId ?? args.accountId
  if (typeof cardId !== 'string' && typeof accountId !== 'string') return null
  const [card] = await db.select().from(schema.cards).where(and(eq(schema.cards.userId, row.userId),
    typeof cardId === 'string' ? eq(schema.cards.id, cardId) : eq(schema.cards.accountId, String(accountId))))
  if (!card) return null
  await ensureCardPasswordSchema()
  const credential = await db.transaction((tx) => migrateLegacyCardPassword(tx, row.userId, card.id))
  return { newCard: false as const, cardId: card.id, last4: card.last4, kind: card.kind, hasPassword: !!credential, version: credential?.version }
}

/** Only server-verified, one-use, exact-action proofs are accepted. */
export async function validateCardProof(row: Pending, requestId?: string) {
  const requirement = await pendingCardRequirement(row)
  if (!requirement) return { required: false as const }
  if (!requestId) return { required: true as const, valid: false, requirement }
  const [proof] = await db.select().from(schema.bankSecureRequests).where(and(
    eq(schema.bankSecureRequests.id, requestId), eq(schema.bankSecureRequests.userId, row.userId),
    eq(schema.bankSecureRequests.actionId, row.id), eq(schema.bankSecureRequests.purpose, 'confirm_action'),
    eq(schema.bankSecureRequests.status, 'verified'), isNull(schema.bankSecureRequests.consumedAt), gt(schema.bankSecureRequests.expiresAt, new Date()),
  ))
  const valid = !!proof && (requirement.newCard ? !!proof.passwordHash : proof.cardId === requirement.cardId && proof.passwordVersion === requirement.version)
  return { required: true as const, valid, requirement, proof }
}
