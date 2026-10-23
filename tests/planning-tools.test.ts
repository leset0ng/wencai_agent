import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import { commitPurchase, previewPurchase, checkProductEligibility } from '#/server/tools/bank-extended'
import {
  assessRiskProfile,
  commitPlanCancel,
  commitRiskAssessment,
  commitScheduledTransfer,
  commitSplit,
  previewPlanCancel,
  previewScheduledTransfer,
  previewSplit,
  resolveHolding,
  checkScheduleWindow,
} from '#/server/tools/bank-planning'
import { scoreRisk } from '#/server/tools/jobs'
import { runBankTool } from '#/server/tools/runner'
import { BANK_TOOLS } from '#/server/tools/bank'
import type { AgentContext } from '#/server/agent/context'

/**
 * 第二批移植工具：风险适当性、定时转账、AA 收款、生日计划取消。
 * 写操作一律被策略引擎拦截为待确认；带令牌的提交必须与预览参数一致。
 */

const U = 'u_plan_a'
const OTHER = 'u_plan_b'
const ACC = 'acc_plan_a'
const PAYEE = 'p_plan_a'
const C1 = 'c_plan_1'
const C2 = 'c_plan_2'
const PRD = 'prd_plan_r3'
const PLAN = 'bplan_plan_a'
const ctx: AgentContext = { userId: U, sessionId: 's_plan', channel: 'web' }
const otherCtx: AgentContext = { userId: OTHER, sessionId: 's_plan_b', channel: 'web' }

/** 仿真时钟由种子设定；测试以它为基准安排时间 */
async function clock() {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'clock'))
  return new Date(row?.value ?? Date.now())
}
const later = async (days: number) => new Date((await clock()).getTime() + days * 86400_000).toISOString()

beforeAll(async () => {
  await db.insert(schema.users).values([{ id: U, name: '计划甲' }, { id: OTHER, name: '计划乙' }]).onConflictDoNothing()
  await db.insert(schema.accounts).values({ id: ACC, userId: U, name: '测试卡', balanceCents: 10_000_000 }).onConflictDoNothing()
  await db.insert(schema.payees).values({
    id: PAYEE, userId: U, name: '孙丽', alias: '姐姐', accountNo: '6222000055556666', bank: '工商银行',
    createdAt: new Date(Date.now() - 100 * 86400_000),
  }).onConflictDoNothing()
  await db.insert(schema.contacts).values([
    { id: C1, userId: U, name: '周一', phone: '13900000001', note: '同事' },
    { id: C2, userId: U, name: '吴二', phone: '13900000002', note: '朋友' },
  ]).onConflictDoNothing()
  await db.insert(schema.products).values({
    id: PRD, name: '测试成长 R3', riskRating: 'R3', expectedYield: 0.04, minAmountCents: 100_000, termDays: 30,
  }).onConflictDoNothing()
  await db.insert(schema.holdings).values({
    id: 'h_plan_a', userId: U, productId: PRD, principalCents: 200_000,
    redeemableAt: new Date(0).toISOString(), createdAt: new Date(0).toISOString(),
  }).onConflictDoNothing()
  await db.insert(schema.birthdayPlans).values({
    id: PLAN, userId: U, contactId: C1, birthday: '2026-12-01', budgetCents: 100_000, status: 'reserved',
    createdAt: new Date().toISOString(),
  }).onConflictDoNothing()
})

afterAll(async () => {
  for (const [t, col, v] of [
    [schema.confirmationTokens, schema.confirmationTokens.userId, U],
    [schema.scheduledTasks, schema.scheduledTasks.userId, U],
    [schema.splits, schema.splits.userId, U],
    [schema.birthdayPlans, schema.birthdayPlans.userId, U],
    [schema.holdings, schema.holdings.userId, U],
    [schema.transactions, schema.transactions.accountId, ACC],
    [schema.contacts, schema.contacts.userId, U],
    [schema.payees, schema.payees.userId, U],
    [schema.accounts, schema.accounts.userId, U],
    [schema.products, schema.products.id, PRD],
    [schema.users, schema.users.id, U],
    [schema.users, schema.users.id, OTHER],
  ] as const) {
    await db.delete(t).where(eq(col, v))
  }
})

describe('工具注册', () => {
  it('工具名唯一，仿真控制不暴露给模型', () => {
    const names = BANK_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).not.toContain('advance_simulation_clock')
    expect(names).not.toContain('run_due_jobs')
  })

  it('所有写工具基础等级至少为 yellow，必须经用户确认', () => {
    for (const t of BANK_TOOLS.filter((t) => t.kind === 'write')) expect(t.baseRisk, t.name).not.toBe('green')
  })
})

describe('风险适当性', () => {
  it('计分与原口径一致：全 1 为 R1，全 5 为 R5，全 3 为 R3', () => {
    expect(scoreRisk([1, 1, 1, 1, 1])).toBe('R1')
    expect(scoreRisk([5, 5, 5, 5, 5])).toBe('R5')
    expect(scoreRisk([3, 3, 3, 3, 3])).toBe('R3')
  })

  it('试算不落库', async () => {
    await assessRiskProfile.execute({ answers: [5, 5, 5, 5, 5] }, ctx)
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, U))
    expect(u.riskAssessedAt).toBeNull()
  })

  it('未测评时申购被拒，即使持有有效令牌', async () => {
    const args = { fromAccountId: ACC, productId: PRD, amountCents: 100_000 }
    const elig = (await checkProductEligibility.execute(args, ctx)) as { allowed: boolean; reasons: string[] }
    expect(elig.allowed).toBe(false)
    expect(elig.reasons.join()).toContain('尚未完成风险测评')
    const { confirmationToken } = (await previewPurchase.execute(args, ctx)) as { confirmationToken: string }
    await expect(commitPurchase.execute({ ...args, confirmationToken }, ctx)).rejects.toThrow('RISK_MISMATCH')
  })

  it('登记测评须经确认；登记 R2 后申购 R3 产品仍被拒', async () => {
    const outcome = await runBankTool(commitRiskAssessment, { answers: [2, 2, 2, 2, 2] }, ctx)
    expect(outcome.status).toBe('needs_confirmation')
    await commitRiskAssessment.execute({ answers: [2, 2, 2, 2, 2] }, ctx)
    const args = { fromAccountId: ACC, productId: PRD, amountCents: 100_000 }
    const { confirmationToken } = (await previewPurchase.execute(args, ctx)) as { confirmationToken: string }
    await expect(commitPurchase.execute({ ...args, confirmationToken }, ctx)).rejects.toThrow('超过您的风险等级')
  })

  it('登记 R5 后可以申购', async () => {
    await commitRiskAssessment.execute({ answers: [5, 5, 5, 5, 5] }, ctx)
    const args = { fromAccountId: ACC, productId: PRD, amountCents: 100_000 }
    const { confirmationToken } = (await previewPurchase.execute(args, ctx)) as { confirmationToken: string }
    const out = (await commitPurchase.execute({ ...args, confirmationToken }, ctx)) as { holdingId: string }
    expect(out.holdingId).toBeTruthy()
  })
})

describe('定时转账', () => {
  it('过去的时间被拒绝', async () => {
    const r = (await checkScheduleWindow.execute({ executeAt: '2020-01-01T00:00:00Z' }, ctx)) as { valid: boolean }
    expect(r.valid).toBe(false)
    await expect(
      previewScheduledTransfer.execute(
        { fromAccountId: ACC, payeeId: PAYEE, amountCents: 5000, executeAt: '2020-01-01T00:00:00Z' },
        ctx,
      ),
    ).rejects.toThrow('INVALID_TIME')
  })

  it('同一时刻的不同写法不影响令牌校验；改执行时间被拒', async () => {
    const when = await later(3)
    // 保留毫秒，否则仿真时钟带毫秒时并非同一时刻，令牌应当拒绝。
    const local = new Date(new Date(when).getTime() + 8 * 3600_000).toISOString().replace('Z', '+08:00')
    const base = { fromAccountId: ACC, payeeId: PAYEE, amountCents: 5000 }
    const { confirmationToken } = (await previewScheduledTransfer.execute({ ...base, executeAt: when }, ctx)) as {
      confirmationToken: string
    }
    await expect(
      commitScheduledTransfer.execute({ ...base, executeAt: await later(4), confirmationToken }, ctx),
    ).rejects.toThrow('TOKEN_PARAM_MISMATCH')

    const p2 = (await previewScheduledTransfer.execute({ ...base, executeAt: when }, ctx)) as { confirmationToken: string }
    const out = (await commitScheduledTransfer.execute(
      { ...base, executeAt: local, confirmationToken: p2.confirmationToken },
      ctx,
    )) as { taskId: string; status: string }
    expect(out.status).toBe('pending')
  })
})

describe('AA 收款', () => {
  it('余数按分分配；改参与人被拒；创建后所有参与份额仍待本人付款', async () => {
    const args = { title: '团建', totalCents: 1000, contactIds: [C1, C2] }
    const pv = (await previewSplit.execute(args, ctx)) as {
      confirmationToken: string
      selfAmount: number
      shares: { amount: number }[]
    }
    expect(pv.selfAmount).toBe(3.33)
    expect(pv.shares.map((s) => s.amount)).toEqual([3.34, 3.33])

    await expect(
      commitSplit.execute({ ...args, contactIds: [C1], confirmationToken: pv.confirmationToken }, ctx),
    ).rejects.toThrow('TOKEN_PARAM_MISMATCH')

    const pv2 = (await previewSplit.execute(args, ctx)) as { confirmationToken: string }
    const { splitId } = (await commitSplit.execute({ ...args, confirmationToken: pv2.confirmationToken }, ctx)) as {
      splitId: string
    }
    const [saved] = await db.select().from(schema.splits).where(eq(schema.splits.id, splitId))
    expect(JSON.parse(saved.sharesJson)).toEqual(expect.arrayContaining([
      expect.objectContaining({ contactId: C1, status: 'pending' }),
      expect.objectContaining({ contactId: C2, status: 'pending' }),
    ]))
    expect(BANK_TOOLS.some((tool) => tool.name === 'settle_split')).toBe(false)
  })

  it('他人的联系人不能被拉进账单', async () => {
    await expect(previewSplit.execute({ title: 'x', totalCents: 1000, contactIds: [C1] }, otherCtx)).rejects.toThrow(
      '联系人不存在',
    )
  })
})

describe('生日计划取消', () => {
  it('他人无法预览；本人预览 → 提交后计划取消，不能重复取消', async () => {
    await expect(previewPlanCancel.execute({ planId: PLAN }, otherCtx)).rejects.toThrow('计划不存在')
    const { confirmationToken } = (await previewPlanCancel.execute({ planId: PLAN }, ctx)) as {
      confirmationToken: string
    }
    const out = (await commitPlanCancel.execute({ planId: PLAN, confirmationToken }, ctx)) as { status: string }
    expect(out.status).toBe('cancelled')
    await expect(previewPlanCancel.execute({ planId: PLAN }, ctx)).rejects.toThrow('INVALID_STATE')
  })
})

describe('持仓解析', () => {
  it('他人看不到本人持仓', async () => {
    const r = (await resolveHolding.execute({ query: '测试成长' }, otherCtx)) as { found: boolean }
    expect(r.found).toBe(false)
  })
})
