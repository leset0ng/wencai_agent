import { and, eq, gt, isNull } from 'drizzle-orm'
import { auth, db, schema } from '#/server/db/client'
import { setInitialTxPassword } from './tx-password'
import { auditInTransaction } from '#/server/audit/log'
import { withUserExecutionLock } from '#/server/confirm/lock'
import type { AuthSession } from '#/server/types'

let ready: Promise<unknown> | undefined
export function ensureEnrollmentSchema() {
  return ready ??= db.$client.execute('CREATE TABLE IF NOT EXISTS bank_initial_enrollments (session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER)').catch((error) => { ready = undefined; throw error })
}
/** Called only by the phone OTP plugin after successful verification creates this session. */
export async function recordPhoneLogin(sessionId: string, userId: string) {
  await ensureEnrollmentSchema()
  await db.insert(schema.bankInitialEnrollments).values({ sessionId, userId, expiresAt: new Date(Date.now() + 15 * 60_000) }).onConflictDoNothing()
}

/** Legacy-client compatibility only. New users set a separate password while applying for each card. */
export async function initializePassword(session: AuthSession, password: string) {
  await ensureEnrollmentSchema()
  return withUserExecutionLock(session.userId, async () => {
    const [user] = await db.select().from(auth.baUser).where(eq(auth.baUser.id, session.userId))
    const [login] = await db.select().from(auth.baSession).where(and(eq(auth.baSession.id, session.sessionId), eq(auth.baSession.userId, session.userId)))
    // Initial enrollment is allowed only after a recent verified-phone login. Reset stays MFA-only.
    if (!user?.phoneNumberVerified || !login || login.expiresAt <= new Date() || Date.now() - login.createdAt.getTime() > 15 * 60_000) throw new Error('请重新通过手机验证码登录后设置交易密码')
    await db.transaction(async (tx) => {
      const proof = await tx.update(schema.bankInitialEnrollments).set({ consumedAt: new Date() }).where(and(
        eq(schema.bankInitialEnrollments.sessionId, session.sessionId), eq(schema.bankInitialEnrollments.userId, session.userId),
        isNull(schema.bankInitialEnrollments.consumedAt), gt(schema.bankInitialEnrollments.expiresAt, new Date()),
      )).returning()
      if (!proof.length) {
        // Keep a clear response for replayed setup without changing the stored password.
        const [credential] = await tx.select({ id: auth.baAccount.id }).from(auth.baAccount).where(eq(auth.baAccount.id, `acct_txpw_${session.userId}`))
        throw new Error(credential ? '已设置交易密码，请到安全设置中通过强验证修改' : '请重新通过手机验证码登录后设置交易密码')
      }
      await setInitialTxPassword(tx, session.userId, password)
      await tx.insert(schema.users).values({ id: user.id, name: user.name }).onConflictDoNothing()
      await auditInTransaction(tx, { ...session, channel: 'web' }, 'tx_password_set', { via: 'initial_verified_phone_enrollment' })
    })
  })
}
