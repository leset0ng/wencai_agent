/** Explicit opt-in only. Append synthetic accounts/activity; never clear or reseed the application database. */
import { eq } from 'drizzle-orm'
import { auth, db, schema } from '../src/server/db/client'
import { ensureRiskSchema } from '../src/server/risk/accounts'
import { ensureCardSchema } from '../src/server/cards/service'
import { auditInTransaction } from '../src/server/audit/log'

if (!process.argv.includes('--append-demo')) {
  console.error('仅追加合成演示数据：pnpm exec tsx scripts/seed-risk-demo.ts --append-demo [--at=2026-10-13T04:00:00Z]')
  process.exit(1)
}
const atArg = process.argv.find((arg) => arg.startsWith('--at='))?.slice(5)
const now = atArg ? new Date(atArg) : new Date()
if (!Number.isFinite(now.getTime())) throw new Error('--at 必须是合法的 ISO 时间')
await ensureRiskSchema()
await ensureCardSchema()
const marker = 'risk_demo_fixture_v1', owner = 'risk_demo_mule', target = 'risk_demo_mule_account'
const people = [owner, ...Array.from({ length: 5 }, (_, n) => `risk_demo_payer_${n}`), 'risk_demo_sink']
try {
  const added = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(schema.settings).where(eq(schema.settings.key, marker))
    if (existing) return false
    // Fixed fixture IDs make the operation idempotent and keep every synthetic row identifiable.
    for (const [index, id] of people.entries()) {
      const name = index === 0 ? '风险演示·收款观察户（合成）' : index === 6 ? '风险演示·流出接收户（合成）' : `风险演示·付款人${index}（合成）`
      const accountId = id === owner ? target : `${id}_account`
      await tx.insert(schema.users).values({ id, name })
      await tx.insert(auth.baUser).values({ id, name, email: `${id}@wencai.local`, emailVerified: true,
        phoneNumber: `1990000998${index}`, phoneNumberVerified: true,
        createdAt: new Date(now.getTime() - (index === 0 ? 2 : 365) * 86_400_000), updatedAt: now })
      await tx.insert(schema.accounts).values({ id: accountId, userId: id, name: '演示储蓄账户（合成）',
        balanceCents: index === 0 ? 100_000 : index === 6 ? 900_000 : 800_000 })
      await tx.insert(schema.bankAccountAddresses).values({ accountId, accountNo: `880000000009908${index}` })
      await tx.insert(schema.cards).values({ id: `${id}_card`, userId: id, accountId, last4: `908${index}`,
        kind: 'debit', status: 'active', dailyLimitCents: 5_000_000 })
      await tx.insert(schema.bankCardProfiles).values({ cardId: `${id}_card`, remark: '合成风控演示' })
    }
    for (let n = 0; n < 6; n++) {
      const id = `risk_demo_transfer_${n}`, creditId = `${id}_credit`
      const from = n < 5 ? `risk_demo_payer_${n}_account` : target
      const to = n < 5 ? target : 'risk_demo_sink_account'
      const amount = n < 5 ? 200_000 : 900_000
      const occurredAt = new Date(now.getTime() - (n < 5 ? 60 - n * 5 : 10) * 60_000)
      await tx.insert(schema.transactions).values([
        { id, accountId: from, amountCents: -amount, counterparty: '合成风控演示对手方', memo: '仅用于本地演示，无真实资金', category: '转账', occurredAt },
        { id: creditId, accountId: to, amountCents: amount, counterparty: '合成风控演示对手方', memo: '仅用于本地演示，无真实资金', category: '转账', occurredAt },
      ])
      await tx.insert(schema.bankTransferLinks).values({ debitTransactionId: id, targetAccountId: to, creditTransactionId: creditId })
    }
    await tx.insert(schema.settings).values({ key: marker, value: now.toISOString() })
    await auditInTransaction(tx, { userId: owner, sessionId: 'seed-risk-demo', channel: 'web' }, 'admin_command', {
      command: 'append_synthetic_risk_fixture', synthetic: true, accountsAdded: 7, transfersAdded: 6, at: now.toISOString(),
    })
    return true
  })
  console.info(added ? '已追加 7 个合成账户和 6 笔双边转账；原用户余额与账单未修改。worker 会异步分析收款观察户，模型结果不会自动确认高危。' : '合成风控演示数据已存在，本次未新增或修改数据。')
} finally { db.$client.close() }
