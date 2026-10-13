import { createHash, scryptSync, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { auth as authTables, db, type DB } from '#/server/db/client'
import { env } from '#/server/env'

/**
 * 交易密码用于本人的敏感卡号查看；不能代替红色操作的多因子验证。
 */

const PROVIDER = 'wencai-tx-password'

function hash(password: string, salt: string): string {
  return scryptSync(password.normalize('NFKC'), salt, 32).toString('hex')
}

function saltFor(userId: string): string {
  return createHash('sha256').update(`${env.CONFIRM_SECRET}:${userId}`).digest('hex').slice(0, 16)
}

export async function setTxPassword(userId: string, password: string): Promise<void> {
  if (!/^\d{6}$/.test(password)) throw new Error('交易密码须为 6 位数字')
  const salt = saltFor(userId)
  await db
    .insert(authTables.baAccount)
    .values({ id: `acct_txpw_${userId}`, accountId: userId, providerId: PROVIDER, userId, password: `${salt}:${hash(password, salt)}` })
    .onConflictDoUpdate({ target: authTables.baAccount.id, set: { password: `${salt}:${hash(password, salt)}` } })
}

/** 常数时间比较；未设置密码时拒绝。 */
export async function verifyTxPassword(userId: string, password: string, database: Pick<DB, 'select'> = db): Promise<boolean> {
  const input = password.normalize('NFKC')
  const [row] = await database
    .select({ password: authTables.baAccount.password })
    .from(authTables.baAccount)
    .where(eq(authTables.baAccount.id, `acct_txpw_${userId}`))
  const stored = row?.password
  if (!stored) return false
  const expected = stored
  const [salt, digest] = expected.split(':')
  const actual = Buffer.from(hash(input, salt), 'hex')
  const want = Buffer.from(digest, 'hex')
  return actual.length === want.length && timingSafeEqual(actual, want)
}

export async function hasTxPassword(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ password: authTables.baAccount.password })
    .from(authTables.baAccount)
    .where(eq(authTables.baAccount.id, `acct_txpw_${userId}`))
  return !!row?.password
}

/** INSERT only: initial setup can never overwrite a password, even with concurrent requests. */
export async function setInitialTxPassword(tx: Parameters<Parameters<DB['transaction']>[0]>[0], userId: string, password: string) {
  if (!/^\d{6}$/.test(password)) throw new Error('交易密码须为 6 位数字')
  const salt = saltFor(userId)
  const rows = await tx.insert(authTables.baAccount).values({ id: `acct_txpw_${userId}`, accountId: userId, providerId: PROVIDER, userId, password: `${salt}:${hash(password, salt)}` }).onConflictDoNothing().returning({ id: authTables.baAccount.id })
  if (!rows.length) throw new Error('已设置交易密码，请到安全设置中通过强验证修改')
}
