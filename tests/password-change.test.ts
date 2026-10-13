import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { auth, db, schema } from '#/server/db/client'
import { confirmPending } from '#/server/confirm/pending'
import { runBankTool } from '#/server/tools/runner'
import { resolveTool, BANK_TOOLS } from '#/server/tools/bank'
import { requestPasswordChange } from '#/server/tools/security'
import { requestStepUpCode } from '#/server/auth/step-up'
import { consumePasswordChangeGrant, ensurePasswordChangeSchema, issuePasswordChangeGrant, GRANT_TTL_MS } from '#/server/auth/password-change'
import { setTxPassword, verifyTxPassword } from '#/server/auth/tx-password'
import { Route as securityRoute } from '#/routes/api/security'

const { session } = vi.hoisted(() => ({ session: vi.fn() }))
vi.mock('#/server/session', () => ({ requireSession: session }))

const uid = 'pwchange_user', otherId = 'pwchange_other'
const ctx = { userId: uid, sessionId: 'pwchange-1', channel: 'web' as const }
const confirm = (id: string, stepUp?: Parameters<typeof confirmPending>[0]['stepUp']) =>
  confirmPending({ ctx, actionId: id, resolveTool, stepUp })

async function smsFor(scope: string, userId = uid) {
  let code = ''
  const challenge = await requestStepUpCode(userId, scope, async (_phone, value) => { code = value })
  return { method: 'sms' as const, challengeId: challenge.challengeId, code }
}

/** 走完整链路：发起 → 红色确认 → 强验证通过，返回工具输出 */
async function authorized() {
  const proposal = await runBankTool(requestPasswordChange, {}, ctx)
  if (proposal.status !== 'needs_confirmation') throw new Error(JSON.stringify(proposal))
  // 验证码挑战必须在拿到 actionId 之后才签发：scope 绑定动作，先发再改会被拒。
  // 注意 requestStepUpCode 有 60 秒发送频率限制，同一条链上只能发一次。
  const result = await confirm(proposal.actionId, await smsFor(`action:${proposal.actionId}`))
  if (!result.ok) throw new Error(JSON.stringify(result))
  return { proposal, result, output: result.output as { status: string; ticket: string; url: string; expiresAt: number } }
}

const securityPost = (body: unknown) =>
  (securityRoute.options.server!.handlers as { POST: (c: { request: Request }) => Promise<Response> }).POST({
    request: new Request('http://localhost/api/security', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  })

beforeAll(async () => {
  await ensurePasswordChangeSchema()
  // 上次失败的运行可能留下同名用户，这里幂等重建
  await db.delete(schema.bankPasswordChangeGrants).where(inArray(schema.bankPasswordChangeGrants.userId, [uid, otherId]))
  await db.delete(schema.pendingActions).where(inArray(schema.pendingActions.userId, [uid, otherId]))
  await db.delete(auth.baAccount).where(inArray(auth.baAccount.userId, [uid, otherId]))
  await db.delete(auth.baUser).where(inArray(auth.baUser.id, [uid, otherId]))
  await db.delete(schema.users).where(inArray(schema.users.id, [uid, otherId]))
  await db.insert(schema.users).values([
    { id: uid, name: '密码修改测试' },
    { id: otherId, name: '他人' },
  ])
  await db.insert(auth.baUser).values([
    { id: uid, name: '密码修改测试', email: `${uid}@test.local`, emailVerified: true, phoneNumber: '13900008801', phoneNumberVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: otherId, name: '他人', email: `${otherId}@test.local`, emailVerified: true, phoneNumber: '13900008802', phoneNumberVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])
  session.mockResolvedValue({ userId: uid, userName: '密码修改测试', sessionId: ctx.sessionId })
})

beforeEach(async () => {
  await ensurePasswordChangeSchema()
  await db.delete(schema.bankPasswordChangeGrants).where(eq(schema.bankPasswordChangeGrants.userId, uid))
  await db.delete(schema.pendingActions).where(eq(schema.pendingActions.userId, uid))
  await db.delete(auth.baAccount).where(eq(auth.baAccount.userId, uid))
  await setTxPassword(uid, '983701')
  await db.$client.execute({ sql: 'DELETE FROM bank_step_up_codes WHERE user_id = ?', args: [uid] }).catch(() => {})
  await db.update(schema.users).set({ failedAuthCount: 0, lockedUntil: null }).where(eq(schema.users.id, uid))
})

afterAll(async () => {
  await db.delete(schema.bankPasswordChangeGrants).where(inArray(schema.bankPasswordChangeGrants.userId, [uid, otherId]))
  await db.delete(schema.pendingActions).where(inArray(schema.pendingActions.userId, [uid, otherId]))
  await db.delete(auth.baAccount).where(inArray(auth.baAccount.userId, [uid, otherId]))
  await db.delete(auth.baUser).where(inArray(auth.baUser.id, [uid, otherId]))
  await db.delete(schema.users).where(inArray(schema.users.id, [uid, otherId]))
})

describe('交易密码修改：工具契约', () => {
  it('已注册进 BANK_TOOLS，且是红色写操作', () => {
    const def = BANK_TOOLS.find((t) => t.name === 'request_password_change')
    expect(def).toBeDefined()
    expect(def!.kind).toBe('write')
    expect(def!.baseRisk).toBe('red')
    expect(resolveTool('request_password_change')).toBe(def)
  })

  it('Schema 不接收任何参数——密码在结构上无法进入模型', () => {
    // 这是本功能的核心约束：一旦 schema 多出 password/newPassword，
    // 密码就会落进模型上下文、pending_actions.args_json 和 audit_logs。
    const shape = (requestPasswordChange.inputSchema as unknown as { shape?: Record<string, unknown> }).shape
    const keys = Object.keys(shape ?? {})
    expect(keys).toEqual([])
    expect(keys.some((k) => /pass|pwd|secret|code/i.test(k))).toBe(false)
    // 多余字段被 zod 丢弃（非 strict 模式下是 strip）
    const parsed = requestPasswordChange.inputSchema.safeParse({ password: '123456', newPassword: '654321' })
    expect(parsed.success).toBe(true)
    expect(Object.keys(parsed.data as object)).toEqual([])
  })

  it('工具描述明确禁止模型索要密码', () => {
    expect(requestPasswordChange.description).toContain('不接受')
    expect(requestPasswordChange.description).toMatch(/不要询问|不接收/)
  })
})

describe('交易密码修改：确认与强验证', () => {
  it('发起即生成红色确认单，未强验证不能消费', async () => {
    const proposal = await runBankTool(requestPasswordChange, {}, ctx)
    if (proposal.status !== 'needs_confirmation') throw new Error(JSON.stringify(proposal))
    expect(proposal.level).toBe('red')
    // 确认单摘要说明新密码在安全设置页输入，不经过 AI
    const values = proposal.summary.fields.map((f) => f.value).join(' ')
    expect(values).toContain('安全设置页')
    expect(await confirm(proposal.actionId)).toMatchObject({ code: 'step_up_required' })
  })

  it('交易密码不能满足红色强验证', async () => {
    const proposal = await runBankTool(requestPasswordChange, {}, ctx)
    if (proposal.status !== 'needs_confirmation') throw new Error(JSON.stringify(proposal))
    expect(await confirm(proposal.actionId, { method: 'password', password: '123456' })).toMatchObject({ code: 'step_up_failed' })
  })

  it('强验证通过后签发凭证，且输出中没有任何密码材料', async () => {
    const { output } = await authorized()
    expect(output.status).toBe('password_change_authorized')
    expect(output.ticket).toMatch(/^pwg_/)
    expect(output.url).toContain('/settings?pwTicket=')
    expect(output.expiresAt).toBeGreaterThan(Date.now())
    // 输出里不能出现密码字样
    expect(JSON.stringify(output)).not.toMatch(/123456|654321/)
  })

  it('审计与参数快照中不含密码字段', async () => {
    const { proposal } = await authorized()
    const [row] = await db.select().from(schema.pendingActions).where(eq(schema.pendingActions.id, proposal.actionId))
    expect(row.argsJson).toBe('{}')
    expect(row.argsJson).not.toMatch(/pass|pwd/i)
    const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.userId, uid))
    const relevant = logs.filter((l) => l.payloadJson.includes('password_change'))
    for (const log of relevant) expect(log.payloadJson).not.toMatch(/"password"|"\d{6}"/)
  })
})

describe('交易密码修改：凭证单次消费与绑定', () => {
  it('凭证只能消费一次', async () => {
    const { output } = await authorized()
    const first = await consumePasswordChangeGrant(uid, output.ticket)
    expect(first).toMatchObject({ ok: true })
    expect(await consumePasswordChangeGrant(uid, output.ticket)).toMatchObject({ ok: false, reason: 'consumed' })
  })

  it('并发消费只有一个成功', async () => {
    const { output } = await authorized()
    const results = await Promise.all([
      consumePasswordChangeGrant(uid, output.ticket),
      consumePasswordChangeGrant(uid, output.ticket),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
  })

  it('凭证绑定用户，他人无法使用', async () => {
    const { output } = await authorized()
    expect(await consumePasswordChangeGrant(otherId, output.ticket)).toMatchObject({ ok: false, reason: 'not_found' })
    expect(await consumePasswordChangeGrant(uid, output.ticket)).toMatchObject({ ok: true })
  })

  it('过期凭证被拒绝', async () => {
    const grant = await issuePasswordChangeGrant(uid, 'pa_test')
    await db.update(schema.bankPasswordChangeGrants).set({ expiresAt: new Date(0) }).where(eq(schema.bankPasswordChangeGrants.id, grant.ticket))
    expect(await consumePasswordChangeGrant(uid, grant.ticket)).toMatchObject({ ok: false, reason: 'expired' })
  })

  it('有效期符合声明的 TTL', async () => {
    const grant = await issuePasswordChangeGrant(uid, 'pa_test')
    const delta = grant.expiresAt - Date.now()
    expect(delta).toBeGreaterThan(GRANT_TTL_MS - 5000)
    expect(delta).toBeLessThanOrEqual(GRANT_TTL_MS)
  })
})

describe('交易密码修改：接口两条路径', () => {
  it('凭证路径可以改密码，且凭证立刻作废', async () => {
    const { output } = await authorized()
    const res = await securityPost({ action: 'set_tx_password', password: '246810', ticket: output.ticket })
    expect(res.status).toBe(200)
    expect(await verifyTxPassword(uid, '246810')).toBe(true)
    // 重放同一凭证必须失败
    expect((await securityPost({ action: 'set_tx_password', password: '111111', ticket: output.ticket })).status).toBe(403)
    expect(await verifyTxPassword(uid, '111111')).toBe(false)
  })

  it('无效凭证不能改密码', async () => {
    expect((await securityPost({ action: 'set_tx_password', password: '246810', ticket: 'pwg_forged' })).status).toBe(403)
    expect(await verifyTxPassword(uid, '246810')).toBe(false)
  })

  it('既无验证也无凭证一律拒绝', async () => {
    expect((await securityPost({ action: 'set_tx_password', password: '246810' })).status).toBe(403)
    expect(await verifyTxPassword(uid, '246810')).toBe(false)
  })

  it('凭证不能用于非 6 位数字密码', async () => {
    const { output } = await authorized()
    expect((await securityPost({ action: 'set_tx_password', password: 'abcdef', ticket: output.ticket })).status).toBe(400)
    // 密码非法时不应消费凭证
    expect(await consumePasswordChangeGrant(uid, output.ticket)).toMatchObject({ ok: true })
  })
})
