import { db, schema } from '../src/server/db/client'
import { detectSubscriptions, notify, runAutomaticTransfers, sendSubscriptionReminders } from '../src/server/automation/service'
import { runDueMandates } from '../src/server/automation/mandates'
import { syncWorkerClock } from '../src/server/tools/jobs'
import { runRiskAnalysisPass } from '../src/server/risk/accounts'
import { runLifeAutomation } from '../src/server/life/service'

let stopping = false
let riskPass: Promise<unknown> | undefined
async function tick() {
  const now = await syncWorkerClock()
  const users = await db.select({ id: schema.users.id }).from(schema.users)
  for (const user of users) {
    if (stopping) break
    await runAutomaticTransfers(user.id, now)
    await runDueMandates(user.id, now)
    await runLifeAutomation(user.id, now)
    await sendSubscriptionReminders(user.id, now)
    for (const candidate of await detectSubscriptions(user.id)) {
      await notify(user.id, 'subscription_detected', '识别到疑似订阅扣费', `${candidate.merchant}，周期${candidate.cycle === 'monthly' ? '每月' : '每年'}，金额 ${candidate.amount.toFixed(2)} 元。可让 Agent 核对并设置提醒。`, `detected-subscription:${candidate.candidateId}`)
    }
  }
  // Analysis runs outside the banking tick so a slow/unavailable model cannot delay due payments.
  if (!stopping && !riskPass) {
    riskPass = runRiskAnalysisPass(now).catch((error) => console.error('[worker:risk]', error instanceof Error ? error.message : '风险分析暂不可用'))
      .finally(() => { riskPass = undefined })
  }
}
let timer: NodeJS.Timeout | undefined

function shutdown() {
  if (stopping) return
  stopping = true
  if (timer) clearTimeout(timer)
  try { db.$client.close() } catch {}
  process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, shutdown)
}

console.info('[worker] 自动任务与续费提醒已启动')
while (!stopping) {
  try { await tick() } catch (error) { console.error('[worker]', error instanceof Error ? error.message : '自动任务执行失败') }
  if (!stopping) {
    await new Promise((resolve) => {
      timer = setTimeout(resolve, 10_000)
    })
  }
}
shutdown()
