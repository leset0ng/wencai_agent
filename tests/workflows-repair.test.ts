import { setTxPassword } from '#/server/auth/tx-password'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { auth, db, schema } from '#/server/db/client'
import { detectSubscriptions, ensureAutomationSchema, notifications, runAutomaticTransfers, sendSubscriptionReminders } from '#/server/automation/service'
import { cancelBirthday, ensureBirthdaySchema, executeBirthdayOrder, reserveBirthday } from '#/server/automation/birthdays'
import { createSplitRequests, ensureSplitSchema, mySplitRequests } from '#/server/payments/splits'
import { getDashboard } from '#/server/dashboard'
import { paySplit } from '#/server/tools/splits'
import { runBankTool } from '#/server/tools/runner'
import { confirmPending } from './helpers/card-confirmation'
import { requestStepUpCode } from '#/server/auth/step-up'
import { resolveTool } from '#/server/tools/bank'
import { controlPlan, startPlan } from '#/server/executor/service'
import { checkedResponse, verifiedOutputTransform } from '#/server/verify/response'
import type { TextStreamPart, ToolSet } from 'ai'

const A = 'workflow_a', B = 'workflow_b', aId = 'workflow_acc_a', bId = 'workflow_acc_b'
const ctx = { userId: A, sessionId: 'workflows', channel: 'web' as const }, bctx = { ...ctx, userId: B }
const balance = async (id: string) => (await db.select().from(schema.accounts).where(eq(schema.accounts.id, id)))[0].balanceCents
beforeAll(async () => {
  await ensureAutomationSchema(); await ensureBirthdaySchema(); await ensureSplitSchema()
  await db.insert(schema.users).values([{ id: A, name: '流程甲' }, { id: B, name: '流程乙' }])
  await db.insert(auth.baUser).values([A, B].map((id, i) => ({ id, name: id, email: `${id}@test.local`, emailVerified: true, phoneNumber: `1390000980${i}`, phoneNumberVerified: true, createdAt: new Date(), updatedAt: new Date() })))
  await db.insert(schema.accounts).values([{ id: aId, userId: A, name: '甲储蓄', balanceCents: 100_000 }, { id: bId, userId: B, name: '乙储蓄', balanceCents: 100_000 }])
  await db.insert(schema.cards).values([A, B].map((id, i) => ({ id: `card_${id}`, userId: id, accountId: i ? bId : aId, kind: 'debit' as const, last4: i ? '8888' : '7777', status: 'active' as const, dailyLimitCents: 5_000_000 })))
  await db.insert(schema.contacts).values({ id: 'workflow_contact', userId: A, name: '流程乙', phone: '13900009801' })
  await db.insert(schema.payees).values({ id: 'workflow_payee', userId: A, name: '旧收款人', accountNo: '6217000000001234', bank: '外部演示银行', createdAt: new Date(0) })
  // These scenarios start with an enrolled banking account.
  for (const id of [A, B]) await setTxPassword(id, '983701')
})
beforeEach(async () => {
  await db.delete(schema.bankTaskPermissions).where(inArray(schema.bankTaskPermissions.taskId, ['wf_auto', 'wf_legacy']))
  await db.delete(schema.bankTaskApprovals).where(inArray(schema.bankTaskApprovals.taskId, ['wf_auto', 'wf_legacy']))
  await db.delete(schema.transactions).where(inArray(schema.transactions.accountId, [aId, bId]))
  await db.delete(schema.scheduledTasks).where(inArray(schema.scheduledTasks.userId, [A, B]))
  await db.delete(schema.pendingActions).where(inArray(schema.pendingActions.userId, [A, B]))
  await db.delete(schema.bankNotifications).where(inArray(schema.bankNotifications.userId, [A, B]))
  await db.delete(schema.bankBirthdayFunds).where(eq(schema.bankBirthdayFunds.userId, A))
  const birthdays = await db.select().from(schema.birthdayPlans).where(eq(schema.birthdayPlans.userId, A))
  if (birthdays.length) await db.delete(schema.birthdayOrders).where(inArray(schema.birthdayOrders.planId, birthdays.map((p) => p.id)))
  await db.delete(schema.birthdayPlans).where(eq(schema.birthdayPlans.userId, A))
  await db.delete(schema.splits).where(eq(schema.splits.userId, A))
  await db.delete(schema.bankSplitRequests).where(eq(schema.bankSplitRequests.requesterUserId, A))
  for (const id of [aId, bId]) await db.update(schema.accounts).set({ balanceCents: 100_000 }).where(eq(schema.accounts.id, id))
})
afterAll(async () => {
  await db.delete(schema.bankTaskPermissions).where(inArray(schema.bankTaskPermissions.taskId, ['wf_auto', 'wf_legacy']))
  await db.delete(schema.bankTaskApprovals).where(inArray(schema.bankTaskApprovals.taskId, ['wf_auto', 'wf_legacy']))
  await db.delete(schema.transactions).where(inArray(schema.transactions.accountId, [aId, bId]))
  await db.delete(schema.scheduledTasks).where(inArray(schema.scheduledTasks.userId, [A, B]))
  await db.delete(schema.pendingActions).where(inArray(schema.pendingActions.userId, [A, B]))
  await db.delete(schema.plans).where(inArray(schema.plans.userId, [A, B]))
  await db.delete(schema.bankNotifications).where(inArray(schema.bankNotifications.userId, [A, B]))
  await db.delete(schema.subscriptions).where(eq(schema.subscriptions.userId, A))
  await db.delete(schema.bankBirthdayFunds).where(eq(schema.bankBirthdayFunds.userId, A))
  await db.delete(schema.contacts).where(eq(schema.contacts.userId, A))
  await db.delete(schema.payees).where(eq(schema.payees.userId, A))
  await db.delete(schema.bankSplitRequests).where(eq(schema.bankSplitRequests.requesterUserId, A))
  await db.delete(schema.splits).where(eq(schema.splits.userId, A))
  await db.delete(schema.bankCardProfiles).where(inArray(schema.bankCardProfiles.cardId, [`card_${A}`, `card_${B}`]))
  await db.delete(schema.cards).where(inArray(schema.cards.userId, [A, B]))
  await db.delete(schema.accounts).where(inArray(schema.accounts.userId, [A, B]))
  await db.delete(auth.baUser).where(inArray(auth.baUser.id, [A, B]))
  await db.delete(schema.users).where(inArray(schema.users.id, [A, B]))
})

describe('自动任务、订阅、AA与跨场景闭环', () => {
  it('从周期流水识别订阅，并对同一期续费只发一条提醒', async () => {
    await db.insert(schema.transactions).values(['2026-07-01', '2026-08-01', '2026-09-01'].map((date, i) => ({ id: `wf_recurring_${i}`, accountId: aId, amountCents: -2500, counterparty: '周期视频会员', category: '娱乐', occurredAt: new Date(`${date}T04:00:00Z`) })))
    expect(await detectSubscriptions(A)).toMatchObject([{ merchant: '周期视频会员', cycle: 'monthly', matchedPayments: 3, amount: 25 }])
    expect(await detectSubscriptions(B)).toEqual([])
    await db.insert(schema.subscriptions).values({ id: 'wf_sub', userId: A, merchant: '周期视频会员', cycle: 'monthly', status: 'active', amountCents: 2500, lastChargedAt: new Date('2026-09-01T04:00:00Z'), remindDays: 3 })
    await sendSubscriptionReminders(A, new Date('2026-09-29T04:00:00Z'))
    await sendSubscriptionReminders(A, new Date('2026-09-29T04:00:00Z'))
    expect(await notifications(A)).toHaveLength(1)
    await db.update(schema.subscriptions).set({ status: 'cancelled' }).where(eq(schema.subscriptions.id, 'wf_sub'))
    await sendSubscriptionReminders(A, new Date('2026-10-29T04:00:00Z'))
    expect(await notifications(A)).toHaveLength(1)
  })
  it('已授权到期任务自动执行一次；没有授权的旧任务只生成待确认单', async () => {
    const now = new Date()
    await db.insert(schema.scheduledTasks).values(['wf_auto', 'wf_legacy'].map((id) => ({ id, userId: A, kind: 'transfer', status: 'pending', dueAt: new Date(now.getTime() - 1000).toISOString(), createdAt: now.toISOString(), payloadJson: JSON.stringify({ fromAccountId: aId, payeeId: 'workflow_payee', amountCents: 100 }) })))
    await db.insert(schema.bankTaskPermissions).values({ taskId: 'wf_auto', level: 'yellow' })
    await Promise.all([runAutomaticTransfers(A, now), runAutomaticTransfers(A, now)])
    expect(await balance(aId)).toBe(99_900)
    expect((await db.select().from(schema.scheduledTasks).where(eq(schema.scheduledTasks.id, 'wf_auto')))[0].status).toBe('succeeded')
    expect((await db.select().from(schema.scheduledTasks).where(eq(schema.scheduledTasks.id, 'wf_legacy')))[0].status).toBe('awaiting_confirmation')
    expect((await notifications(A)).some((n) => n.actionId)).toBe(true)
  })
  it('新版任务在宕机重试前作废孤儿确认单；已结算任务不重复执行', async () => {
    const now = new Date()
    await db.insert(schema.scheduledTasks).values({ id: 'wf_auto', userId: A, kind: 'transfer', status: 'processing', dueAt: new Date(0).toISOString(), createdAt: now.toISOString(), payloadJson: JSON.stringify({ fromAccountId: aId, payeeId: 'workflow_payee', amountCents: 100 }), resultJson: JSON.stringify({ recoveryVersion: 1, startedAt: Date.now() - 400_000, token: 'interrupted' }) })
    await db.insert(schema.bankTaskPermissions).values({ taskId: 'wf_auto', level: 'yellow' })
    const orphan = await runBankTool(resolveTool('transfer')!, { fromAccountId: aId, payeeId: 'workflow_payee', amount: 1 }, { ...ctx, sessionId: 'scheduled:wf_auto' })
    if (orphan.status !== 'needs_confirmation') throw new Error(JSON.stringify(orphan))
    await db.insert(schema.bankTaskApprovals).values({ taskId: 'wf_auto', actionId: orphan.actionId })
    await runAutomaticTransfers(A, now)
    expect(await balance(aId)).toBe(99_900)
    expect((await db.select().from(schema.scheduledTasks).where(eq(schema.scheduledTasks.id, 'wf_auto')))[0].status).toBe('succeeded')
    expect(await confirmPending({ ctx, actionId: orphan.actionId, resolveTool })).toMatchObject({ code: 'already_used' })
    await runAutomaticTransfers(A, now)
    expect(await balance(aId)).toBe(99_900)
  })
  it('预约任务确认超时后关闭，不再留下可重复执行的待确认任务', async () => {
    const now = new Date()
    await db.insert(schema.scheduledTasks).values({ id: 'wf_legacy', userId: A, kind: 'transfer', status: 'pending', dueAt: new Date(0).toISOString(), createdAt: now.toISOString(), payloadJson: JSON.stringify({ fromAccountId: aId, payeeId: 'workflow_payee', amountCents: 100 }) })
    await runAutomaticTransfers(A, now)
    const [link] = await db.select().from(schema.bankTaskApprovals).where(eq(schema.bankTaskApprovals.taskId, 'wf_legacy'))
    await db.update(schema.pendingActions).set({ expiresAt: new Date(0) }).where(eq(schema.pendingActions.id, link.actionId))
    await runAutomaticTransfers(A, now)
    expect((await db.select().from(schema.scheduledTasks).where(eq(schema.scheduledTasks.id, 'wf_legacy')))[0].status).toBe('failed')
    expect(await balance(aId)).toBe(100_000)
  })
  it('生日预算真实预留，资产总额不减少；取消只释放真实冻结金额一次', async () => {
    const before = await getDashboard(A)
    const plan = await reserveBirthday({ fromAccountId: aId, contactId: 'workflow_contact', birthday: '2026-12-20', budgetCents: 10_000 }, ctx, new Date('2026-10-12T02:00:00Z'))
    expect(await balance(aId)).toBe(90_000)
    const dashboard = await getDashboard(A)
    expect(dashboard.availableBalance).toBe(before.availableBalance - 100)
    expect(dashboard.totalAssets).toBe(before.totalAssets)
    expect(dashboard.reservedBalance).toBe(100)
    expect((await cancelBirthday(A, plan.planId)).releasedBudget).toBe(100)
    expect(await balance(aId)).toBe(100_000)
    await expect(cancelBirthday(A, plan.planId)).rejects.toThrow('取消')
  })
  it('生日前两天从预留资金生成两笔模拟订单，不重复扣款或重复下单', async () => {
    const plan = await reserveBirthday({ fromAccountId: aId, contactId: 'workflow_contact', birthday: '2026-12-20', budgetCents: 10_001 }, { ...ctx, authorization: { level: 'red', actionId: 'test-authorized' } }, new Date('2026-10-12T02:00:00Z'))
    await expect(executeBirthdayOrder(A, plan.planId, new Date('2026-12-17T00:00:00Z'))).rejects.toThrow('尚未到')
    const results = await Promise.all([executeBirthdayOrder(A, plan.planId, new Date('2026-12-18T00:00:00Z')), executeBirthdayOrder(A, plan.planId, new Date('2026-12-18T00:00:00Z'))])
    expect(results).toHaveLength(2)
    expect(await balance(aId)).toBe(89_999)
    const orders = await db.select().from(schema.birthdayOrders).where(eq(schema.birthdayOrders.planId, plan.planId))
    expect(orders).toHaveLength(2)
    expect(orders.reduce((sum, o) => sum + o.amountCents, 0)).toBe(10_001)
    expect((await getDashboard(A)).reservedBalance).toBe(0)
  })
  it('AA 必须由参与人确认付款，双边余额和收款进度同时更新且不可重放', async () => {
    await db.insert(schema.splits).values({ id: 'wf_split', userId: A, title: '聚餐AA', totalCents: 2000, sharesJson: JSON.stringify([{ contactId: 'workflow_contact', amountCents: 1000, status: 'pending' }]), createdAt: new Date().toISOString() })
    await createSplitRequests(A, 'wf_split')
    const [request] = await mySplitRequests(B)
    expect(request.status).toBe('pending')
    expect((await runBankTool(paySplit, { requestId: request.id, fromCardQuery: '8888' }, ctx)).status).toBe('error')
    const pending = await runBankTool(paySplit, { requestId: request.id, fromCardQuery: '8888' }, bctx)
    if (pending.status !== 'needs_confirmation') throw new Error(JSON.stringify(pending))
    expect(await balance(aId)).toBe(100_000)
    let code = ''
    const proof = await requestStepUpCode(B, `action:${pending.actionId}`, async (_phone, value) => { code = value })
    const params = { ctx: bctx, actionId: pending.actionId, resolveTool, stepUp: { method: 'sms' as const, challengeId: proof.challengeId, code } }
    expect((await confirmPending(params)).ok).toBe(true)
    expect((await confirmPending(params)).ok).toBe(false)
    expect(await balance(aId)).toBe(101_000)
    expect(await balance(bId)).toBe(99_000)
    expect((await mySplitRequests(B))[0].status).toBe('paid')
  })
  it('计划暂停时禁止确认，恢复后共享确认入口推进后续 DAG；人工节点可记录处理继续', async () => {
    const allowed = new Set(['set_card_remark'])
    const start = await startPlan(ctx, { goal: '修改卡片备注', nodes: [{ id: 'n1', kind: 'tool', tool: 'set_card_remark', args: { cardId: `card_${A}`, remark: '流程工资卡' }, dependsOn: [] }] }, allowed)
    if (!start.ok) throw new Error(JSON.stringify(start))
    const actionId = start.state.nodes.n1.actionId!
    await controlPlan(ctx, start.state.id, 'pause')
    expect(await confirmPending({ ctx, actionId, resolveTool })).toMatchObject({ code: 'plan_paused' })
    await controlPlan(ctx, start.state.id, 'resume')
    const result = await confirmPending({ ctx: { ...ctx, channel: 'lark' }, actionId, resolveTool })
    expect(result).toMatchObject({ ok: true, plan: { status: 'completed' } })
    const manual = await startPlan(ctx, { goal: '人工核对', nodes: [{ id: 'manual', kind: 'handoff', args: {}, dependsOn: [] }] }, allowed)
    if (!manual.ok) throw new Error(JSON.stringify(manual))
    expect((await controlPlan(ctx, manual.state.id, 'complete_handoff', '已由本人核对需求')).status).toBe('completed')
  })
  it('没有成功回执时拦截成功陈述，未知金额在发送前替换', () => {
    expect(checkedResponse('已转账成功。', [], false, true).blocked).toBe(true)
    expect(checkedResponse('余额为¥9999.00。', [], false, false).blocked).toBe(true)
    expect(checkedResponse('还款已成功，剩余¥100.00。', [{ outstanding: 100 }], true, false).blocked).toBe(false)
    expect(checkedResponse('初始额度¥20,000.00，净流出1805.82元。', [{ summary: '¥20,000.00', net: -1805.82 }], false, false).blocked).toBe(false)
  })
  it('错误正文片段不会流给客户端，核验后只输出替代文本', async () => {
    const source = new ReadableStream<TextStreamPart<ToolSet>>({ start(controller) {
      controller.enqueue({ type: 'text-start', id: 'x' })
      controller.enqueue({ type: 'text-delta', id: 'x', text: '已转账' })
      controller.enqueue({ type: 'text-delta', id: 'x', text: '成功，余额¥99999元。' })
      controller.enqueue({ type: 'text-end', id: 'x' })
      controller.close()
    } })
    const stream = source.pipeThrough(verifiedOutputTransform(ctx, [])({ tools: {}, stopStream: () => {} }))
    const parts: TextStreamPart<ToolSet>[] = []
    for await (const part of stream) parts.push(part)
    const deltas = parts.filter((part) => part.type === 'text-delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0].text).toContain('没有可核对')
    expect(JSON.stringify(deltas)).not.toContain('99999')
  })
})
