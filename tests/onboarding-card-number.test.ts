import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { auth, db, schema } from '#/server/db/client'
import { initializePassword, recordPhoneLogin, ensureEnrollmentSchema } from '#/server/auth/onboarding'
import { hasTxPassword, setTxPassword, verifyTxPassword } from '#/server/auth/tx-password'
import { createUserCard, userCards } from '#/server/cards/service'
import { generateCardNumber, revealCardNumber, validCardNumber } from '#/server/cards/numbers'
import { getDashboard } from '#/server/dashboard'
import { getAccounts, listCards, resolveTool } from '#/server/tools/bank'
import { showBankCard } from '#/server/tools/cards'
import { runBankTool } from '#/server/tools/runner'
import { confirmPending } from '#/server/confirm/pending'
import { searchBankAccounts, settleTransfer } from '#/server/payments/service'

const ids = ['enrollment_new', 'enrollment_old'], [uid, oldId] = ids
const session = { userId: uid, userName: '开户测试', sessionId: 'enrollment_session' }
const ctx = { ...session, channel: 'web' as const }
let cardId = '', oldCardId = ''
beforeAll(async () => {
  for (const [i, id] of ids.entries()) {
    await db.insert(auth.baUser).values({ id, name: i ? '老账户' : '开户测试', email: `${id}@test.local`, phoneNumber: `1391234900${i}`, phoneNumberVerified: true })
    await db.insert(schema.users).values({ id, name: i ? '老账户' : '开户测试' })
    const card = await createUserCard(id, 'debit', i ? '旧工资卡' : '新储蓄卡')
    if (i) oldCardId = card.cardId; else cardId = card.cardId
  }
  await db.insert(auth.baSession).values({ id: session.sessionId, userId: uid, token: 'enrollment-session-token', createdAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) })
  await setTxPassword(oldId, '983701')
})
beforeEach(async () => {
  await db.delete(schema.bankCardPasswords).where(eq(schema.bankCardPasswords.userId, uid))
  await ensureEnrollmentSchema()
  await db.delete(schema.bankInitialEnrollments).where(eq(schema.bankInitialEnrollments.sessionId, session.sessionId))
  await recordPhoneLogin(session.sessionId, uid)
  await db.delete(auth.baAccount).where(eq(auth.baAccount.userId, uid))
  await db.update(schema.users).set({ failedAuthCount: 0, lockedUntil: null }).where(eq(schema.users.id, uid))
  await db.update(auth.baSession).set({ createdAt: new Date() }).where(eq(auth.baSession.id, session.sessionId))
})
afterAll(async () => {
  await db.delete(schema.bankInitialEnrollments).where(inArray(schema.bankInitialEnrollments.userId, ids))
  const cards = await db.select().from(schema.cards).where(inArray(schema.cards.userId, ids))
  const accounts = cards.map((c) => c.accountId)
  if (accounts.length) await db.delete(schema.transactions).where(inArray(schema.transactions.accountId, accounts))
  if (cards.length) {
    await db.delete(schema.bankCardNumbers).where(inArray(schema.bankCardNumbers.cardId, cards.map((c) => c.id)))
    await db.delete(schema.bankCardProfiles).where(inArray(schema.bankCardProfiles.cardId, cards.map((c) => c.id)))
  }
  await db.delete(schema.pendingActions).where(inArray(schema.pendingActions.userId, ids))
  await db.delete(schema.cards).where(inArray(schema.cards.userId, ids))
  await db.delete(schema.accounts).where(inArray(schema.accounts.userId, ids))
  await db.delete(auth.baAccount).where(inArray(auth.baAccount.userId, ids))
  await db.delete(auth.baSession).where(inArray(auth.baSession.userId, ids))
  await db.delete(auth.baUser).where(inArray(auth.baUser.id, ids))
  await db.delete(schema.users).where(inArray(schema.users.id, ids))
})

describe('旧客户端账户密码兼容（不限制新首页）', () => {
  it('未设置账户密码仍可查询和使用 Agent，只有银行卡敏感操作要求卡密码', async () => {
    expect(await hasTxPassword(uid)).toBe(false)
    expect(await runBankTool(getAccounts, {}, ctx)).toMatchObject({ status: 'done' })
    expect(await confirmPending({ ctx, actionId: 'forged', resolveTool })).toMatchObject({ ok: false, code: 'not_found' })
    await expect(settleTransfer({ fromAccountId: 'forged', toAccountId: 'other', amountCents: 100 }, ctx)).rejects.toThrow()
  })
  it('首次设置只有一个并发请求成功，不能作为重置密码接口', async () => {
    const result = await Promise.allSettled([initializePassword(session, '246810'), initializePassword(session, '135790')])
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    await expect(initializePassword(session, '111111')).rejects.toThrow('已设置交易密码')
    expect(await verifyTxPassword(uid, '111111')).toBe(false)
  })
  it('拒绝非六位数字、他人会话以及过旧的登录验证', async () => {
    await expect(initializePassword(session, 'abc123')).rejects.toThrow('6 位')
    await expect(initializePassword({ ...session, sessionId: 'forged' }, '246810')).rejects.toThrow('重新')
    await db.update(auth.baSession).set({ createdAt: new Date(Date.now() - 16 * 60_000) }).where(eq(auth.baSession.id, session.sessionId))
    await expect(initializePassword(session, '246810')).rejects.toThrow('重新')
    expect(await hasTxPassword(uid)).toBe(false)
  })
  it('新建会话本身不证明经过短信验证，伪装后台会话不能首次设密', async () => {
    await db.delete(schema.bankInitialEnrollments).where(eq(schema.bankInitialEnrollments.sessionId, session.sessionId))
    await expect(initializePassword(session, '246810')).rejects.toThrow('重新通过手机验证码')
    expect(await hasTxPassword(uid)).toBe(false)
  })
})

describe('完整卡号的受控查看与工具展示', () => {
  it('完整16位、校验有效、保留旧尾号，且首页和工具结果没有完整卡号', async () => {
    for (const tail of ['0000', '8823', '9999']) for (let i = 0; i < 20; i++) expect(validCardNumber(generateCardNumber(tail))).toBe(true)
    await initializePassword(session, '246810')
    const card = (await userCards(uid))[0], shown = await revealCardNumber(ctx, cardId, '246810')
    expect(validCardNumber(shown.number)).toBe(true)
    expect(shown.number.endsWith(card.last4)).toBe(true)
    expect(await revealCardNumber(ctx, cardId, '246810')).toEqual(shown)
    const dashboard = await getDashboard(uid)
    const safe = await runBankTool(showBankCard, { query: card.last4 }, ctx)
    expect(safe).toMatchObject({ status: 'done', data: { cardId, last4: card.last4 } })
    for (const value of [dashboard, safe, await runBankTool(listCards, {}, ctx)]) expect(JSON.stringify(value)).not.toContain(shown.number)
    const [stored] = await db.select().from(schema.bankCardNumbers).where(eq(schema.bankCardNumbers.cardId, cardId))
    expect(JSON.stringify(stored)).not.toContain(shown.number)
    const lookup = await searchBankAccounts({ method: 'account', accountNo: shown.number, name: '开户测试' }, { userId: oldId, sessionId: 'old', channel: 'web' })
    expect(lookup.candidates).toHaveLength(1)
    expect(JSON.stringify(lookup)).not.toContain(shown.number)
  })
  it('本人验证、错误密码熔断、不可利用已知他人卡ID获取卡号', async () => {
    await initializePassword(session, '246810')
    await expect(revealCardNumber(ctx, oldCardId, '246810')).rejects.toThrow('不属于你')
    for (let i = 0; i < 4; i++) await expect(revealCardNumber(ctx, cardId, '000000')).rejects.toThrow('密码错误')
    await expect(revealCardNumber(ctx, cardId, '000000')).rejects.toThrow('锁定 30')
    await expect(revealCardNumber(ctx, cardId, '246810')).rejects.toThrow('临时锁定')
  })
  it('同名银行卡要求用户选择尾号，不随意展示某张卡', async () => {
    await initializePassword(session, '246810')
    await createUserCard(uid, 'debit', '新储蓄卡')
    expect(await runBankTool(showBankCard, { query: '新储蓄卡' }, ctx)).toMatchObject({ status: 'error', message: expect.stringContaining('询问具体尾号') })
  })
  it('卡号和密码不进入审计内容', async () => {
    await initializePassword(session, '246810')
    const shown = await revealCardNumber(ctx, cardId, '246810')
    const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.userId, uid))
    expect(logs.some((l) => l.payloadJson.includes('view_card_number'))).toBe(true)
    expect(JSON.stringify(logs)).not.toContain(shown.number)
    expect(JSON.stringify(logs)).not.toContain('246810')
  })
})
