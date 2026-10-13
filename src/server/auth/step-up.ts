import { createHmac, randomInt, randomUUID } from 'node:crypto'
import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { auth, db, schema } from '#/server/db/client'
import { env } from '#/server/env'
import { verifyPasskeyAssertion } from './passkey'
import { audit } from '#/server/audit/log'
import { verifyDemoBiometric } from './demo-biometric'

export const StepUpSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('sms'), challengeId: z.string().max(100), code: z.string().regex(/^\d{6}$/) }),
  z.object({ method: z.literal('passkey'), response: z.unknown() }),
  z.object({ method: z.literal('fingerprint'), challengeId: z.string().max(100) }),
  z.object({ method: z.literal('face'), challengeId: z.string().max(100) }),
  // 兼容旧客户端的错误反馈；普通密码不再满足红色验证。
  z.object({ method: z.literal('password'), password: z.string().max(32) }),
])
export type StrongStepUp = z.infer<typeof StepUpSchema>
type Delivery = (phone: string, code: string) => Promise<void>
let ready: Promise<unknown> | undefined
const ensure = () => ready ??= db.$client.execute(`CREATE TABLE IF NOT EXISTS bank_step_up_codes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, scope TEXT NOT NULL, code_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, consumed_at INTEGER)`).catch((e) => { ready = undefined; throw e })
const hash = (id: string, code: string) => createHmac('sha256', env.CONFIRM_SECRET).update(`${id}:${code}`).digest('hex')

export async function sendVerificationSMS(phone: string, code: string) {
  if (!env.SMS_DELIVERY_URL) throw new Error('短信通道尚未配置，请选择其他可用验证方式')
  const response = await fetch(env.SMS_DELIVERY_URL, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(env.SMS_DELIVERY_TOKEN ? { authorization: `Bearer ${env.SMS_DELIVERY_TOKEN}` } : {}) },
    body: JSON.stringify({ phoneNumber: phone, code, expiresInSeconds: 300, purpose: 'wencai-verification' }), signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error('验证码发送失败，请稍后重试')
}

export async function requestStepUpCode(userId: string, scope: string, deliver: Delivery = sendVerificationSMS) {
  await ensure()
  const [user] = await db.select().from(auth.baUser).where(eq(auth.baUser.id, userId))
  if (!user?.phoneNumber || !user.phoneNumberVerified) throw new Error('请先验证账户绑定的手机号')
  const id = `sms_${randomUUID()}`, code = String(randomInt(0, 1_000_000)).padStart(6, '0'), now = new Date()
  await db.transaction(async (tx) => {
    const recent = await tx.select().from(schema.bankStepUpCodes).where(and(eq(schema.bankStepUpCodes.userId, userId), gte(schema.bankStepUpCodes.createdAt, new Date(now.getTime() - 10 * 60_000))))
    if (recent.length >= 5 || recent.some((r) => r.createdAt.getTime() > now.getTime() - 60_000)) throw new Error('验证码发送过于频繁，请稍后再试')
    await tx.insert(schema.bankStepUpCodes).values({ id, userId, scope, codeHash: hash(id, code), createdAt: now, expiresAt: new Date(now.getTime() + 300_000) })
  })
  try { await deliver(user.phoneNumber, code) }
  catch (error) { await db.update(schema.bankStepUpCodes).set({ consumedAt: new Date() }).where(eq(schema.bankStepUpCodes.id, id)); throw error }
  return { challengeId: id, maskedPhone: `${user.phoneNumber.slice(0, 3)}****${user.phoneNumber.slice(-4)}`, expiresAt: now.getTime() + 300_000 }
}

export async function verifyStrongStepUp(userId: string, scope: string, proof: StrongStepUp | undefined) {
  if (!proof) return false
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId))
  if (user?.lockedUntil && user.lockedUntil > new Date()) return false
  const verified = await verifyProof(userId, scope, proof)
  const locked = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(schema.users).where(eq(schema.users.id, userId))
    if (!current) return false
    const failures = verified ? 0 : current.failedAuthCount + 1
    const lock = failures >= 5
    await tx.update(schema.users).set({ failedAuthCount: lock ? 0 : failures, ...(lock ? { lockedUntil: new Date(Date.now() + 30 * 60_000) } : {}) }).where(eq(schema.users.id, userId))
    return lock
  })
  if (locked) await audit({ userId, sessionId: 'strong-verification', channel: 'web' }, 'circuit_breaker', { reason: 'step_up_failed_repeatedly', lockMinutes: 30 })
  return verified
}

async function verifyProof(userId: string, scope: string, proof: StrongStepUp) {
  if (proof.method === 'fingerprint' || proof.method === 'face') return verifyDemoBiometric(userId, scope, proof.method, proof.challengeId)
  if (proof.method === 'passkey') return verifyPasskeyAssertion(userId, proof.response, scope).catch(() => false)
  if (proof.method !== 'sms') return false
  await ensure()
  return db.transaction(async (tx) => {
    const [attempt] = await tx.update(schema.bankStepUpCodes).set({ attempts: sql`${schema.bankStepUpCodes.attempts} + 1` })
      .where(and(eq(schema.bankStepUpCodes.id, proof.challengeId), eq(schema.bankStepUpCodes.userId, userId), eq(schema.bankStepUpCodes.scope, scope), isNull(schema.bankStepUpCodes.consumedAt), lt(schema.bankStepUpCodes.attempts, 5), gte(schema.bankStepUpCodes.expiresAt, new Date()))).returning()
    if (!attempt || attempt.codeHash !== hash(proof.challengeId, proof.code)) return false
    const claimed = await tx.update(schema.bankStepUpCodes).set({ consumedAt: new Date() }).where(and(eq(schema.bankStepUpCodes.id, attempt.id), isNull(schema.bankStepUpCodes.consumedAt))).returning()
    return claimed.length === 1
  })
}
