import { beforeEach, expect, it, vi } from 'vitest'
const { confirm } = vi.hoisted(() => ({ confirm: vi.fn() }))
vi.mock('#/server/confirm/pending', () => ({ confirmPending: confirm }))
vi.mock('#/server/tools/bank', () => ({ resolveTool: vi.fn() }))
vi.mock('#/server/env', () => ({ env: { PUBLIC_BASE_URL: 'https://bank.test/' } }))
import { confirmFromLark } from '#/server/channels/lark-confirm'
const ctx = { userId: 'bound-user', sessionId:'lark:thread', channel:'lark' as const }
beforeEach(() => confirm.mockReset())
it.each(['card_password_required','step_up_required','step_up_failed'])('%s转原H5确认单，不宣称成功或代用户验证', async code => {
  confirm.mockResolvedValue({ok:false,code,message:'需要独立安全验证'})
  const reply = await confirmFromLark(ctx,'pa_original')
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(confirm.mock.calls[0][0]).toMatchObject({ctx,actionId:'pa_original'})
  expect(confirm.mock.calls[0][0]).not.toHaveProperty('secureRequestId')
  expect(reply.message).toContain('https://bank.test/confirm/pa_original')
  expect(reply.message).toContain('尚未执行')
  expect(reply.message).not.toContain('✅')
})
it.each(['forbidden','not_found','expired','tampered','already_used','locked','execution_failed','plan_paused'])('%s只提示失败，不泄露H5链接', async code => {
  confirm.mockResolvedValue({ok:false,code,message:'拒绝'})
  expect((await confirmFromLark(ctx,'foreign')).message).toBe('未能完成：拒绝')
})
it('验证通过后的成功回执及计划保留', async () => {
  const result = {ok:true,tool:'transfer',output:{transactionId:'tx'},plan:{id:'plan'}}
  confirm.mockResolvedValue(result)
  expect(await confirmFromLark(ctx,'pa')).toEqual({result,message:'✅ 操作已完成。'})
})
