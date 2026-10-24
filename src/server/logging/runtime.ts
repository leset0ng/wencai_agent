import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { RuntimeLogEntry, RuntimeLogLevel, RuntimeLogSnapshot, RuntimeLogSource } from '#/lib/runtime-logs'

const CAPACITY = 500
// Preserve the buffer and request context across dev-server HMR. Each process has its own buffer.
const key = Symbol.for('wencai.runtime.logs')
const globals = globalThis as typeof globalThis & { [key]?: ReturnType<typeof createState> }
function createState() {
  return {
    entries: [] as RuntimeLogEntry[],
    sequence: 0,
    startedAt: new Date().toISOString(),
    context: new AsyncLocalStorage<string>(),
  }
}
const state = (globals[key] ??= createState())

/** Only curated events are recorded. Never pass request bodies, headers or database rows. */
export function redactRuntimeMessage(input: string) {
  let value = input
  for (const [name, secret] of Object.entries(process.env)) {
    if (/(?:SECRET|TOKEN|PASSWORD|API_KEY)/i.test(name) && secret && secret.length >= 4)
      value = value.replaceAll(secret, '[已隐藏]')
  }
  return value
    .replace(/\bBearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(
      /((?:password|passwd|token|secret|api[_-]?key|cookie|authorization|验证码|密码)\s*["']?\s*[:=：]\s*)[^\s,;，；]+/gi,
      '$1[已隐藏]',
    )
    .replace(/https?:\/\/[^\s]+/gi, '[远程地址已隐藏]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]')
    .replace(/\+?\d[\d -]{4,}\d/g, '[号码已隐藏]')
    .replace(/[\r\n\x00-\x1f\x7f]/g, ' ')
    .slice(0, 1200)
}

export function runtimeLog(level: RuntimeLogLevel, source: RuntimeLogSource, message: string) {
  const entry: RuntimeLogEntry = {
    id: ++state.sequence,
    at: new Date().toISOString(),
    level,
    source,
    message: redactRuntimeMessage(message),
    requestId: state.context.getStore(),
  }
  state.entries.push(entry)
  if (state.entries.length > CAPACITY) state.entries.splice(0, state.entries.length - CAPACITY)
}

export function runtimeLogSnapshot(): RuntimeLogSnapshot {
  return { entries: state.entries.map((entry) => ({ ...entry })), capacity: CAPACITY, startedAt: state.startedAt }
}

/** Do not log URL parameters or variable path segments such as credential/challenge IDs. */
function requestLabel(request: Request) {
  const path = new URL(request.url).pathname
  const segments = path.split('/').filter(Boolean)
  return `/${segments.map((segment, index) => (index < (segments[1] === 'auth' ? 4 : 2) && /^[a-z-]+$/.test(segment) ? segment : ':id')).join('/')}`
}

export async function observeRuntimeRequest<T extends { response: Response }>(
  request: Request,
  next: () => Promise<T> | T,
): Promise<T> {
  const url = new URL(request.url)
  // Log polling must not create log entries or crowd out the events being investigated.
  if (
    !url.pathname.startsWith('/api/') ||
    (url.pathname === '/api/admin' && ['logs', 'access'].includes(url.searchParams.get('action') ?? ''))
  )
    return next()
  return state.context.run(randomUUID().slice(0, 8), async () => {
    const started = performance.now()
    const source = url.pathname.startsWith('/api/auth/') ? 'auth' : 'http'
    const label = `${request.method} ${requestLabel(request)}`
    try {
      const result = await next()
      const status = result.response.status
      runtimeLog(
        status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
        source,
        `${label} → ${status} · ${Math.round(performance.now() - started)}ms`,
      )
      return result
    } catch (error) {
      // Router redirects are control flow, not authentication failures.
      const status = error instanceof Response ? error.status : 500
      runtimeLog(
        status >= 500 ? 'error' : 'info',
        source,
        `${label} → ${status} · ${error instanceof Error ? error.message : '请求结束'}`,
      )
      throw error
    }
  })
}

/** Only an error code or a fixed server-authored validation message may enter the log. */
export async function recordAuthFailure(response: Response) {
  if (response.ok || !response.headers.get('content-type')?.includes('application/json')) return
  const body = await response
    .clone()
    .json()
    .catch(() => null)
  const code = body?.code
  if (typeof code === 'string' && /^[A-Z][A-Z_]{1,79}$/.test(code)) runtimeLog('warn', 'auth', `认证失败 · ${code}`)
  else if (
    typeof body?.message === 'string' &&
    ['请输入有效的手机号', '此手机号尚未注册，请先填写户名注册', '此手机号已注册，请直接登录'].includes(body.message)
  )
    runtimeLog('warn', 'auth', `认证失败 · ${body.message}`)
}
