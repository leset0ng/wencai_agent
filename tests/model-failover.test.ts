import { describe, expect, it } from 'vitest'
import { withFailover } from '#/server/llm/models'
import type { CallableModel } from '#/server/llm/models'

type Fake = CallableModel & { provider: string; calls: number }
const ok = (name: string): Fake => ({
  provider: name, calls: 0,
  async doGenerate() { this.calls++; return { from: name } },
  async doStream() { this.calls++; return { from: name } },
})
const failing = (name: string, message = '503'): Fake => ({
  provider: name, calls: 0,
  async doGenerate() { this.calls++; throw new Error(message) },
  async doStream() { this.calls++; throw new Error(message) },
})
/** 永不响应，直到被中断 */
const hanging = (name: string): Fake => ({
  provider: name, calls: 0,
  async doGenerate() { this.calls++; return { from: name } },
  doStream(options: { abortSignal: AbortSignal }) {
    this.calls++
    return new Promise((_resolve, reject) => options.abortSignal.addEventListener('abort', () => reject(options.abortSignal.reason)))
  },
})
const quiet = { log: () => {} }

describe('模型故障切换', () => {
  it('主模型正常时不触碰降级模型', async () => {
    const a = ok('a'), b = ok('b')
    const model = withFailover([{ name: 'a', model: a }, { name: 'b', model: b }], quiet)
    expect(await model.doStream({})).toEqual({ from: 'a' })
    expect(b.calls).toBe(0)
    expect(model.provider).toBe('a')
  })

  it('主模型失败时切换到降级模型', async () => {
    const a = failing('a'), b = ok('b')
    const model = withFailover([{ name: 'a', model: a }, { name: 'b', model: b }], quiet)
    expect(await model.doStream({})).toEqual({ from: 'b' })
    expect(await model.doGenerate({})).toEqual({ from: 'b' })
  })

  it('冷却期内跳过刚失败的模型，冷却结束后重新尝试', async () => {
    let time = 0
    const a = failing('a'), b = ok('b')
    const model = withFailover([{ name: 'a', model: a }, { name: 'b', model: b }], { ...quiet, cooldownMs: 1000, now: () => time })
    await model.doStream({})
    await model.doStream({})
    expect(a.calls).toBe(1)
    time = 1001
    await model.doStream({})
    expect(a.calls).toBe(2)
  })

  it('全部失败时抛出最后一个错误，且冷却中的模型仍会被尝试', async () => {
    const a = failing('a', 'a down'), b = failing('b', 'b down')
    const model = withFailover([{ name: 'a', model: a }, { name: 'b', model: b }], quiet)
    await expect(model.doStream({})).rejects.toThrow('b down')
    await expect(model.doStream({})).rejects.toThrow()
    expect(a.calls).toBe(2)
    expect(b.calls).toBe(2)
  })

  it('开始响应超时视为不可用并切换', async () => {
    const a = hanging('a'), b = ok('b')
    const model = withFailover([{ name: 'a', model: a }, { name: 'b', model: b }], { ...quiet, connectTimeoutMs: 20 })
    expect(await model.doStream({})).toEqual({ from: 'b' })
  })

  it('用户取消时不切换模型', async () => {
    const a = hanging('a'), b = ok('b')
    const model = withFailover([{ name: 'a', model: a }, { name: 'b', model: b }], { ...quiet, connectTimeoutMs: 5000 })
    const controller = new AbortController()
    const pending = model.doStream({ abortSignal: controller.signal })
    controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
    expect(b.calls).toBe(0)
  })

  it('开始响应后用户取消仍能传到模型', async () => {
    let seen: AbortSignal | undefined
    const a: Fake = { ...ok('a'), async doStream(options: { abortSignal: AbortSignal }) { seen = options.abortSignal; return { from: 'a' } } }
    const model = withFailover([{ name: 'a', model: a }, { name: 'b', model: ok('b') }], quiet)
    const controller = new AbortController()
    await model.doStream({ abortSignal: controller.signal })
    expect(seen!.aborted).toBe(false)
    controller.abort()
    expect(seen!.aborted).toBe(true)
  })
})
