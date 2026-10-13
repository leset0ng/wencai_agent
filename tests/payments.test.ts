import { setTxPassword } from '#/server/auth/tx-password'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { auth, db, schema } from '#/server/db/client'
import type { AgentContext } from '#/server/agent/context'
import {
  addPaymentPayee,
  listPaymentPayees,
  lookupSchema,
  paymentAccounts,
  resolveRecipientReference,
  reverseTransfer,
  searchBankAccounts,
  settleTransfer,
} from '#/server/payments/service'
import { ensurePaymentsSchema } from '#/server/payments/migrate'
import { addPayee, transferBetweenAccounts } from '#/server/tools/payments'
import { findPayee, resolveTool, transfer } from '#/server/tools/bank'
import { commitTransfer, previewTransfer } from '#/server/tools/bank-extended'
import { runBankTool } from '#/server/tools/runner'
import { confirmPending } from './helpers/card-confirmation'
import { runDueJobs } from '#/server/tools/jobs'
import { parsePaymentAmount } from '#/lib/payment-amount'
import { ensureAutomationSchema } from '#/server/automation/service'

const A = 'u_payment_a',
  B = 'u_payment_b'
const a: AgentContext = {
  userId: A,
  sessionId: 'payment-test',
  channel: 'web',
}
const b: AgentContext = { ...a, userId: B }
const ids = ['payment_a1', 'payment_a2', 'payment_b1']
let reference = '',
  payeeId = '',
  receiverNo = ''
async function balances() {
  return Object.fromEntries(
    (await db.select().from(schema.accounts).where(inArray(schema.accounts.id, ids))).map((x) => [
      x.id,
      x.balanceCents,
    ]),
  )
}
async function reset() {
  for (const id of ids)
    await db
      .update(schema.accounts)
      .set({ balanceCents: 100_000 })
      .where(eq(schema.accounts.id, id))
}
beforeAll(async () => {
  await ensurePaymentsSchema()
  for (const [id, name, phone] of [
    [A, '支付甲', '13900008801'],
    [B, '支付乙', '13900008802'],
  ]) {
    await db.insert(schema.users).values({ id, name })
    await db.insert(auth.baUser).values({
      id,
      name,
      email: `${id}@test.local`,
      emailVerified: true,
      phoneNumber: phone,
      phoneNumberVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  }
  await db.insert(schema.accounts).values(
    ids.map((id, i) => ({
      id,
      userId: i < 2 ? A : B,
      name: id,
      balanceCents: 100_000,
    })),
  )
  receiverNo = (await paymentAccounts(B))[0].accountNo
  await db.insert(schema.cards).values(ids.map((id, i) => ({ id: `${id}_card`, userId: i < 2 ? A : B, accountId: id, kind: 'debit' as const, last4: `88${String(i).padStart(2, '0')}`, status: 'active' as const, dailyLimitCents: 5_000_000 })))
  // These scenarios start with an enrolled banking account.
  for (const id of [A, B]) await setTxPassword(id, '983701')
})
afterAll(async () => {
  await db.delete(schema.cards).where(inArray(schema.cards.userId, [A, B]))
  await db.delete(schema.pendingActions).where(inArray(schema.pendingActions.userId, [A, B]))
  await db
    .delete(schema.confirmationTokens)
    .where(inArray(schema.confirmationTokens.userId, [A, B]))
  await db.delete(schema.scheduledTasks).where(inArray(schema.scheduledTasks.userId, [A, B]))
  await db.delete(schema.transactions).where(inArray(schema.transactions.accountId, ids))
  await db.delete(schema.payees).where(inArray(schema.payees.userId, [A, B]))
  await db.delete(schema.accounts).where(inArray(schema.accounts.id, ids))
  await db.delete(auth.baUser).where(inArray(auth.baUser.id, [A, B]))
  await db.delete(schema.users).where(inArray(schema.users.id, [A, B]))
})

describe('收款账户查找与确认添加', () => {
  it('账号持久不变、归属隔离，完整手机号只返回脱敏候选', async () => {
    expect((await paymentAccounts(B))[0].accountNo).toBe(receiverNo)
    expect((await paymentAccounts(A)).map((x) => x.id)).toEqual(ids.slice(0, 2))
    const out = await searchBankAccounts({ method: 'phone', phoneNumber: '13900008802' }, a)
    expect(out.candidates).toHaveLength(1)
    expect(out.candidates[0]).toMatchObject({
      name: '支付乙',
      account: `${receiverNo.slice(0, 4)} **** ${receiverNo.slice(-4)}`,
    })
    expect(JSON.stringify(out)).not.toContain('balance')
    expect(Object.keys(out.candidates[0])).not.toContain('userId')
    reference = out.candidates[0].reference
    expect(lookupSchema.safeParse({ method: 'phone', phoneNumber: '139' }).success).toBe(false)
    expect(
      (await searchBankAccounts({ method: 'phone', phoneNumber: '13999999999' }, a)).candidates,
    ).toEqual([])
  })
  it('完整账号需要户名匹配，本人账户引导到互转', async () => {
    expect(
      (await searchBankAccounts({ method: 'account', accountNo: receiverNo, name: '支付乙' }, a))
        .candidates,
    ).toHaveLength(1)
    expect(
      (await searchBankAccounts({ method: 'account', accountNo: receiverNo, name: '错误姓名' }, a))
        .candidates,
    ).toEqual([])
    await expect(
      searchBankAccounts({ method: 'phone', phoneNumber: '13900008801' }, a),
    ).rejects.toThrow('本人')
  })
  it('签名绑定发起者，篡改与过期均被拒绝', async () => {
    await expect(resolveRecipientReference(reference, B)).rejects.toThrow('失效')
    await expect(resolveRecipientReference(`${reference.slice(0, -1)}!`, A)).rejects.toThrow('无效')
    const now = Date.now
    Date.now = () => now() + 16 * 60_000
    try {
      await expect(resolveRecipientReference(reference, A)).rejects.toThrow('失效')
    } finally {
      Date.now = now
    }
  })
  it('添加之前只生成确认单，确认才写入；不能重放或重复添加', async () => {
    const out = await runBankTool(addPayee, { reference, alias: '朋友' }, a)
    expect(out.status).toBe('needs_confirmation')
    expect(await listPaymentPayees(A)).toHaveLength(0)
    if (out.status !== 'needs_confirmation') throw new Error('missing confirmation')
    const result = await confirmPending({
      ctx: a,
      actionId: out.actionId,
      resolveTool,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    payeeId = (result.output as { payeeId: string }).payeeId
    expect(await listPaymentPayees(A)).toHaveLength(1)
    expect(await listPaymentPayees(B)).toHaveLength(0)
    expect((await confirmPending({ ctx: a, actionId: out.actionId, resolveTool })).ok).toBe(false)
    await expect(addPaymentPayee(reference, '重复', a)).rejects.toThrow('已在')
    expect((await findPayee.execute({ query: '13900008802' }, a)).candidates[0].id).toBe(payeeId)
  })
})

describe('双边转账', () => {
  it('新收款人普通交易单方式确认后 A 扣 B 加，重复确认不再扣', async () => {
    await reset()
    const out = await runBankTool(transfer, { fromAccountId: ids[0], payeeId, amount: 12.34 }, a)
    expect(out.status).toBe('needs_confirmation')
    if (out.status !== 'needs_confirmation') throw new Error('missing confirmation')
    expect(out.level).toBe('yellow')
    expect((await balances())[ids[0]]).toBe(100_000)
    const result = await confirmPending({ ctx: a, actionId: out.actionId, resolveTool })
    expect(result.ok).toBe(true)
    const output = result.ok ? (result.output as { transactionId: string }) : { transactionId: '' }
    const bs = await balances()
    expect(bs[ids[0]]).toBe(98_766)
    expect(bs[ids[2]]).toBe(101_234)
    const rows = await db
      .select()
      .from(schema.transactions)
      .where(
        inArray(schema.transactions.id, [output.transactionId, `${output.transactionId}_credit`]),
      )
    expect(rows.map((r) => r.amountCents).sort((x, y) => x - y)).toEqual([-1234, 1234])
    expect(await confirmPending({ ctx: a, actionId: out.actionId, resolveTool })).toMatchObject({
      ok: false,
      code: 'already_used',
    })
    expect(await balances()).toEqual(bs)
  })
  it('本人互转保留总额，仍需确认；大额升级红色', async () => {
    await reset()
    const input = {
      fromAccountId: ids[0],
      toAccountId: ids[1],
      amountCents: 100,
    }
    const out = await runBankTool(transferBetweenAccounts, input, a)
    expect(out.status).toBe('needs_confirmation')
    expect((await balances())[ids[0]]).toBe(100_000)
    if (out.status !== 'needs_confirmation') throw new Error('missing confirmation')
    expect(out.level).toBe('yellow')
    expect((await confirmPending({ ctx: a, actionId: out.actionId, resolveTool })).ok).toBe(true)
    const bs = await balances()
    expect(bs[ids[0]]).toBe(99_900)
    expect(bs[ids[1]]).toBe(100_100)
    await db
      .update(schema.accounts)
      .set({ balanceCents: 500_000 })
      .where(eq(schema.accounts.id, ids[0]))
    const confirmedLarge = await runBankTool(
      transferBetweenAccounts,
      { ...input, amountCents: 300_001 },
      a,
    )
    expect(confirmedLarge).toMatchObject({
      status: 'needs_confirmation',
      level: 'red',
    })
  })
  it('其他用户的付款账户、收款人、本人互转目标均不可越权；失败不动余额', async () => {
    await reset()
    const before = await balances()
    for (const input of [
      { fromAccountId: ids[2], payeeId, amountCents: 100 },
      { fromAccountId: ids[0], toAccountId: ids[2], amountCents: 100 },
      { fromAccountId: ids[0], toAccountId: ids[0], amountCents: 100 },
      { fromAccountId: ids[0], payeeId: 'missing', amountCents: 100 },
      { fromAccountId: ids[0], payeeId, amountCents: 100_001 },
      { fromAccountId: ids[0], payeeId, amountCents: -1 },
      { fromAccountId: ids[0], payeeId, amountCents: 1.1 },
    ])
      await expect(settleTransfer(input, a)).rejects.toThrow()
    await expect(
      settleTransfer({ fromAccountId: ids[2], payeeId, amountCents: 100 }, b),
    ).rejects.toThrow('收款人')
    expect(await balances()).toEqual(before)
  })
  it('并发转账不超扣，成功笔数与收款方余额一致', async () => {
    await reset()
    await db
      .update(schema.accounts)
      .set({ balanceCents: 150 })
      .where(eq(schema.accounts.id, ids[0]))
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        settleTransfer({ fromAccountId: ids[0], payeeId, amountCents: 100 }, a),
      ),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const bs = await balances()
    expect(bs[ids[0]]).toBe(50)
    expect(bs[ids[2]]).toBe(100_100)
  })
  it('扩展两阶段转账也双边入账，同一预览令牌并发只执行一次', async () => {
    await reset()
    const input = {
      fromAccountId: ids[0],
      payeeId,
      amountCents: 200,
      memo: '',
    }
    const preview = await previewTransfer.execute(input, a)
    const outcomes = await Promise.allSettled(
      [1, 2].map(() =>
        commitTransfer.execute({ ...input, confirmationToken: preview.confirmationToken }, a),
      ),
    )
    expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    const bs = await balances()
    expect(bs[ids[0]]).toBe(99_800)
    expect(bs[ids[2]]).toBe(100_200)
    const p2 = await previewTransfer.execute(input, a)
    const pending = await runBankTool(
      commitTransfer,
      { ...input, confirmationToken: p2.confirmationToken },
      a,
    )
    expect(pending).toMatchObject({
      status: 'needs_confirmation',
      level: 'yellow',
    })
  })
  it('双边冲正不重复退款；收款方余额不足时双方都不变', async () => {
    await reset()
    const input = { fromAccountId: ids[0], payeeId, amountCents: 300 }
    const output = await settleTransfer(input, a)
    await reverseTransfer(output.transactionId, a)
    expect((await balances())[ids[0]]).toBe(100_000)
    expect((await balances())[ids[2]]).toBe(100_000)
    await expect(reverseTransfer(output.transactionId, a)).rejects.toThrow('已冲正')
    const next = await settleTransfer(input, a)
    await db.update(schema.accounts).set({ balanceCents: 0 }).where(eq(schema.accounts.id, ids[2]))
    const before = await balances()
    await expect(reverseTransfer(next.transactionId, a)).rejects.toThrow('余额不足')
    expect(await balances()).toEqual(before)
  })
  it('并发到期任务只扣一次，也能入账 B', async () => {
    await reset()
    await ensureAutomationSchema()
    await db.delete(schema.transactions).where(inArray(schema.transactions.accountId, ids))
    const taskId = 'payment_job'
    await db.delete(schema.bankTaskPermissions).where(eq(schema.bankTaskPermissions.taskId, taskId))
    await db.insert(schema.bankTaskPermissions).values({ taskId, level: 'red' })
    await db.insert(schema.scheduledTasks).values({
      id: taskId,
      userId: A,
      kind: 'transfer',
      status: 'pending',
      dueAt: '2020-01-01T00:00:00Z',
      payloadJson: JSON.stringify({
        fromAccountId: ids[0],
        payeeId,
        amountCents: 500,
      }),
      createdAt: new Date().toISOString(),
    })
    await Promise.all([runDueJobs(A, new Date()), runDueJobs(A, new Date())])
    expect((await balances())[ids[0]]).toBe(99_500)
    expect((await balances())[ids[2]]).toBe(100_500)
    const [task] = await db
      .select()
      .from(schema.scheduledTasks)
      .where(eq(schema.scheduledTasks.id, taskId))
    expect(task.status).toBe('succeeded')
  })
})

it('金额文本精确换算到分，拒绝浮点多位、指数和无效输入', () => {
  expect(parsePaymentAmount('12.34')).toBe(1234)
  expect(parsePaymentAmount('0.01')).toBe(1)
  expect(parsePaymentAmount('01.2')).toBe(120)
  for (const value of ['0', '-1', '1.001', '1e4', 'NaN', '', '1000000.01'])
    expect(parsePaymentAmount(value)).toBeNull()
})
