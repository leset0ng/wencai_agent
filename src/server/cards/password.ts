import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { auth, db, schema, type DB } from '#/server/db/client'
import { auditInTransaction } from '#/server/audit/log'
import { withUserExecutionLock } from '#/server/confirm/lock'
import type { AgentContext } from '#/server/agent/context'
export type CardTx = Parameters<Parameters<DB['transaction']>[0]>[0]
let ready: Promise<unknown> | undefined
export function ensureCardPasswordSchema() {
  return ready ??= (async () => {
    await db.$client.execute('CREATE TABLE IF NOT EXISTS bank_card_passwords (card_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, password_hash TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1)')
    await db.$client.execute("CREATE TABLE IF NOT EXISTS bank_secure_requests (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL, purpose TEXT NOT NULL, card_id TEXT, action_id TEXT, status TEXT NOT NULL DEFAULT 'pending', password_hash TEXT, password_version INTEGER, result_json TEXT, expires_at INTEGER NOT NULL, consumed_at INTEGER)")
    const columns = await db.$client.execute('PRAGMA table_info(bank_secure_requests)')
    if (!columns.rows.some((row) => row.name === 'verification_method')) await db.$client.execute('ALTER TABLE bank_secure_requests ADD COLUMN verification_method TEXT')
  })().catch((error) => { ready = undefined; throw error })
}
export function hashCardPassword(password: string) {
  if (!/^\d{6}$/.test(password)) throw new Error('银行卡交易密码须为 6 位数字')
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`
}
export function matchesCardPassword(password: string, stored: string) {
  if (!/^\d{6}$/.test(password)) return false
  const [salt, digest] = stored.split(':')
  if (!salt || !digest) return false
  const actual = scryptSync(password, salt, 32), expected = Buffer.from(digest, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
/** Only absent legacy card credentials inherit the old hash. Subsequent changes are per-card. */
export async function migrateLegacyCardPassword(tx: CardTx, userId: string, cardId: string) {
  const [existing] = await tx.select().from(schema.bankCardPasswords).where(eq(schema.bankCardPasswords.cardId, cardId))
  if (existing) return existing
  const [card] = await tx.select().from(schema.cards).where(and(eq(schema.cards.id, cardId), eq(schema.cards.userId, userId)))
  if (!card) throw new Error('银行卡不存在或不属于你')
  const [legacy] = await tx.select().from(auth.baAccount).where(and(eq(auth.baAccount.id, `acct_txpw_${userId}`), eq(auth.baAccount.userId, userId)))
  if (!legacy?.password) return undefined
  await tx.insert(schema.bankCardPasswords).values({ cardId, userId, passwordHash: legacy.password }).onConflictDoNothing()
  return (await tx.select().from(schema.bankCardPasswords).where(eq(schema.bankCardPasswords.cardId, cardId)))[0]
}
export async function verifyCardPasswordInTransaction(tx: CardTx, ctx: AgentContext, cardId: string, password: string) {
  const credential = await migrateLegacyCardPassword(tx, ctx.userId, cardId)
  const [owner] = await tx.select().from(schema.users).where(eq(schema.users.id, ctx.userId))
  if (!owner || (owner.lockedUntil && owner.lockedUntil > new Date())) return { error: '账户已临时锁定，请稍后重试' }
  if (!credential) return { error: '此卡尚未设置交易密码，请先在安全中心设置' }
  const verified = matchesCardPassword(password, credential.passwordHash)
  const failures = verified ? 0 : owner.failedAuthCount + 1, lock = failures >= 5
  await tx.update(schema.users).set({ failedAuthCount: lock ? 0 : failures, ...(lock ? { lockedUntil: new Date(Date.now() + 30 * 60_000) } : {}) }).where(eq(schema.users.id, ctx.userId))
  await auditInTransaction(tx, ctx, lock ? 'circuit_breaker' : verified ? 'action_executed' : 'login_failed', { action: 'verify_card_password', cardId, verified, ...(lock ? { lockMinutes: 30 } : {}) })
  return verified ? { version: credential.version } : { error: lock ? '交易密码连续错误，账户已锁定 30 分钟' : '该银行卡交易密码错误，请重新输入' }
}
export async function verifyCardPassword(ctx: AgentContext, cardId: string, password: string) {
  await ensureCardPasswordSchema()
  const result = await withUserExecutionLock(ctx.userId, () => db.transaction((tx) => verifyCardPasswordInTransaction(tx, ctx, cardId, password)))
  if ('error' in result) throw new Error(result.error)
  return result.version
}
