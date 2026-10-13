import { eq } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'

let ready: Promise<void> | undefined
export function ensurePendingRiskSchema() {
  return ready ??= db.$client.execute('CREATE TABLE IF NOT EXISTS bank_pending_risk_snapshots (action_id TEXT PRIMARY KEY REFERENCES pending_actions(id) ON DELETE CASCADE, account_id TEXT NOT NULL, revision INTEGER NOT NULL)')
    .then(() => {}).catch((error) => { ready = undefined; throw error })
}
export async function pendingRiskSnapshot(actionId: string) {
  await ensurePendingRiskSchema()
  return (await db.select().from(schema.bankPendingRiskSnapshots).where(eq(schema.bankPendingRiskSnapshots.actionId, actionId)))[0]
}
export async function savePendingRiskSnapshot(actionId: string, risk: { accountId: string; revision: number }) {
  await ensurePendingRiskSchema()
  await db.insert(schema.bankPendingRiskSnapshots).values({ actionId, ...risk }).onConflictDoUpdate({
    target: schema.bankPendingRiskSnapshots.actionId, set: risk,
  })
}
