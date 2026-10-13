import { randomUUID } from 'node:crypto'
import { db } from '#/server/db/client'
import { env } from '#/server/env'

export type BiometricMethod = 'fingerprint' | 'face'
let ready: Promise<unknown> | undefined
const ensure = () => ready ??= db.$client.execute('CREATE TABLE IF NOT EXISTS bank_demo_biometrics (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, scope TEXT NOT NULL, method TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER)').catch((error) => { ready = undefined; throw error })
/** Explicit demo only. These buttons do not claim to perform real biometric identification. */
export async function beginDemoBiometric(userId: string, scope: string, method: BiometricMethod) {
  if (!env.AUTH_DEMO_MODE) throw new Error('当前未开启演示验证，指纹和人脸模拟按钮不可用')
  await ensure()
  const challengeId = `bio_${randomUUID()}`
  await db.$client.execute({ sql: 'INSERT INTO bank_demo_biometrics (id,user_id,scope,method,expires_at) VALUES (?,?,?,?,?)', args: [challengeId, userId, scope, method, Date.now() + 300_000] })
  return { challengeId, demo: true as const }
}
export async function verifyDemoBiometric(userId: string, scope: string, method: BiometricMethod, challengeId: string) {
  if (!env.AUTH_DEMO_MODE) return false
  await ensure()
  const result = await db.$client.execute({ sql: 'UPDATE bank_demo_biometrics SET consumed_at=? WHERE id=? AND user_id=? AND scope=? AND method=? AND consumed_at IS NULL AND expires_at>? RETURNING id', args: [Date.now(), challengeId, userId, scope, method, Date.now()] })
  return result.rows.length === 1
}
