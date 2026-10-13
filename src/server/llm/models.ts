import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { env } from '#/server/env'

/**
 * 主模型 DeepSeek V4.1 Flash，降级模型为 OpenAI 兼容接口（如 Qwen3）。
 * 官方模型 ID 为 deepseek-flash，可通过 DEEPSEEK_MODEL 配置覆盖。
 */
export function primaryModel(): LanguageModel {
  if (env.DEEPSEEK_API_KEY) {
    return createDeepSeek({ apiKey: env.DEEPSEEK_API_KEY })(env.DEEPSEEK_MODEL)
  }
  return fallbackModel()
}

export function fallbackModel(): LanguageModel {
  if (!env.FALLBACK_BASE_URL) {
    throw new Error('未配置模型：请设置 DEEPSEEK_API_KEY 或 FALLBACK_BASE_URL')
  }
  return createOpenAICompatible({
    name: 'fallback',
    baseURL: env.FALLBACK_BASE_URL,
    apiKey: env.FALLBACK_API_KEY,
  })(env.FALLBACK_MODEL)
}

interface CallOptions { abortSignal?: AbortSignal }
/** 只依赖两个调用方法，便于用假模型单测 */
export interface CallableModel {
  doGenerate(options: any): PromiseLike<any>
  doStream(options: any): PromiseLike<any>
}
export interface Candidate<T extends CallableModel = CallableModel> { name: string; model: T }
export interface FailoverOptions {
  /** 等待模型开始响应的上限；超时视为该模型不可用 */
  connectTimeoutMs?: number
  /** 失败后暂时跳过该模型的时长，避免每次请求都先等一次超时 */
  cooldownMs?: number
  now?: () => number
  log?: (message: string) => void
}

/**
 * 运行时故障切换：按顺序尝试候选模型，前一个在开始响应之前失败（连接错误、限流、
 * 服务端错误、超时）就换下一个。
 *
 * 边界：只覆盖"开始响应之前"的失败。流已经开始后中途断开不会切换——那时可能已有
 * 工具调用发出，换模型重跑会重复执行。用户主动取消也不切换。
 * 切换只影响"由谁来提议"，风险分级与确认仍由策略引擎和确认链路决定。
 */
export function withFailover<T extends CallableModel>(candidates: Candidate<T>[], options: FailoverOptions = {}): T {
  if (candidates.length === 0) throw new Error('至少需要一个候选模型')
  const { connectTimeoutMs = 15_000, cooldownMs = 60_000, now = Date.now, log = (m) => console.warn(m) } = options
  const coolingUntil = new Map<string, number>()

  async function attempt(candidate: Candidate<T>, method: 'doGenerate' | 'doStream', callOptions: CallOptions) {
    const controller = new AbortController()
    const outer = callOptions.abortSignal
    const forward = () => controller.abort(outer?.reason)
    if (outer?.aborted) forward()
    else outer?.addEventListener('abort', forward, { once: true })
    // 只限制"开始响应"的等待时间；开始之后清除定时器，不截断正常的长回复
    const timer = method === 'doStream' ? setTimeout(() => controller.abort(new Error(`${candidate.name} 响应超时`)), connectTimeoutMs) : undefined
    try {
      return await candidate.model[method]({ ...callOptions, abortSignal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  async function call(method: 'doGenerate' | 'doStream', callOptions: CallOptions) {
    const healthy = candidates.filter((c) => (coolingUntil.get(c.name) ?? 0) <= now())
    const cooling = candidates.filter((c) => !healthy.includes(c))
    let lastError: unknown
    // 冷却中的模型排在最后而不是丢弃：全部都在冷却时仍要尝试
    for (const candidate of [...healthy, ...cooling]) {
      try {
        const result = await attempt(candidate, method, callOptions)
        coolingUntil.delete(candidate.name)
        return result
      } catch (error) {
        if (callOptions.abortSignal?.aborted) throw error
        lastError = error
        coolingUntil.set(candidate.name, now() + cooldownMs)
        log(`[llm] ${candidate.name} 不可用，尝试下一个模型：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw lastError
  }

  return new Proxy(candidates[0].model, {
    get(target, key, receiver) {
      if (key === 'doGenerate' || key === 'doStream') return (callOptions: CallOptions) => call(key, callOptions)
      return Reflect.get(target, key, receiver)
    },
  })
}

let cached: LanguageModel | undefined
/** Agent 使用的模型：主模型与降级模型都配置时带故障切换，否则退回单模型 */
export function agentModel(): LanguageModel {
  if (cached) return cached
  const candidates: Candidate[] = []
  if (env.DEEPSEEK_API_KEY) candidates.push({ name: 'deepseek', model: primaryModel() as CallableModel })
  if (env.FALLBACK_BASE_URL) candidates.push({ name: 'fallback', model: fallbackModel() as CallableModel })
  if (candidates.length === 0) throw new Error('未配置模型：请设置 DEEPSEEK_API_KEY 或 FALLBACK_BASE_URL')
  cached = (candidates.length === 1 ? candidates[0].model : withFailover(candidates)) as LanguageModel
  return cached
}
