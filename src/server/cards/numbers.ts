import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db, schema, type DB } from '#/server/db/client'
import { env } from '#/server/env'
import { withUserExecutionLock } from '#/server/confirm/lock'
import type { AgentContext } from '#/server/agent/context'
import { ensureCardPasswordSchema, verifyCardPasswordInTransaction } from './password'
import { auditInTransaction } from '#/server/audit/log'

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0]
const key = () => createHash('sha256').update(`wencai-card-encryption:${env.CONFIRM_SECRET}`).digest()
export const numberFingerprint = (number: string) => createHmac('sha256', key()).update(number).digest('hex')
export function validCardNumber(number: string) {
  return /^\d{16}$/.test(number) && [...number].reduce((sum, digit, i) => {
    const value = Number(digit) * (i % 2 === 0 ? 2 : 1)
    return sum + (value > 9 ? value - 9 : value)
  }, 0) % 10 === 0
}
export function generateCardNumber(last4: string) {
  if (!/^\d{4}$/.test(last4)) throw new Error('卡片尾号无效')
  const prefix = `8800${String(randomInt(0, 10_000_000)).padStart(7, '0')}`
  for (let digit = 0; digit < 10; digit++) {
    const number = `${prefix}${digit}${last4}`
    if (validCardNumber(number)) return number
  }
  throw new Error('卡号生成失败')
}
function encrypt(number: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv)
  const data = Buffer.concat([cipher.update(number, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map((x) => x.toString('base64url')).join('.')
}
function decrypt(value: string) {
  const [iv, tag, data] = value.split('.').map((x) => Buffer.from(x, 'base64url'))
  const cipher = createDecipheriv('aes-256-gcm', key(), iv)
  cipher.setAuthTag(tag)
  return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8')
}
let ready: Promise<unknown> | undefined
export function ensureCardNumberSchema() {
  return ready ??= db.$client.execute('CREATE TABLE IF NOT EXISTS bank_card_numbers (card_id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE)').catch((error) => { ready = undefined; throw error })
}
export async function ensureCardNumber(tx: Tx, cardId: string, last4: string) {
  const [existing] = await tx.select({ id: schema.bankCardNumbers.cardId }).from(schema.bankCardNumbers).where(eq(schema.bankCardNumbers.cardId, cardId))
  if (existing) return
  for (let attempt = 0; attempt < 8; attempt++) {
    const number = generateCardNumber(last4)
    const inserted = await tx.insert(schema.bankCardNumbers).values({ cardId, ciphertext: encrypt(number), fingerprint: numberFingerprint(number) }).onConflictDoNothing().returning()
    if (inserted.length) return
  }
  throw new Error('卡号生成失败，请重试')
}

/** Caller must verify a per-card password or consume an exact-card server proof. */
export async function readCardNumber(tx: Tx, userId: string, cardId: string) {
  const [card] = await tx.select().from(schema.cards).where(and(eq(schema.cards.id, cardId), eq(schema.cards.userId, userId)))
  if (!card) throw new Error('银行卡不存在或不属于你')
  await ensureCardNumber(tx, cardId, card.last4)
  const [secret] = await tx.select().from(schema.bankCardNumbers).where(eq(schema.bankCardNumbers.cardId, cardId))
  return { number: decrypt(secret.ciphertext), expiresInSeconds: 30 }
}
export async function revealCardNumber(ctx: AgentContext, cardId: string, password: string) {
  await ensureCardNumberSchema(); await ensureCardPasswordSchema()
  const output = await withUserExecutionLock(ctx.userId, () => db.transaction(async (tx) => {
    const verified = await verifyCardPasswordInTransaction(tx, ctx, cardId, password)
    if (verified.error) return { error: verified.error }
    await auditInTransaction(tx, ctx, 'action_executed', { action: 'view_card_number', cardId })
    return readCardNumber(tx, ctx.userId, cardId)
  }))
  if ('error' in output) throw new Error(output.error)
  return output
}
