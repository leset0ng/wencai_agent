import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { notifyConfirmation } from './confirmation-notices'

/*
 * 客户端查询层。
 *
 * 之前这几页是 useEffect + fetch 手写的，问题有两个：
 * 1. effect 的箭头函数体返回了 Promise，React 19 直接把它当 cleanup 调用 → 崩溃；
 * 2. 每个页面各写一遍加载/错误态，还没有缓存与作废。
 * 统一收到 TanStack Query（router 里已经 setupRouterSsrQueryIntegration）。
 */

export interface SettingsData {
  cards: { id: string; last4: string; name: string; hasPassword: boolean }[]
  user: { id: string; name: string }
  sessions: {
    id: string
    createdAt: string
    expiresAt: string
    ipAddress: string | null
    userAgent: string | null
    current: boolean
  }[]
  bindings: { id: string; channel: string; boundAt: string }[]
  passkeys: { id: string; deviceType: string | null; backedUp: boolean; createdAt: string; lastUsedAt: string | null }[]
  stepUp: { password: boolean; passkey: boolean; larkBound: boolean }
}

export interface BindCodeInfo {
  ok: boolean
  needsLogin?: boolean
  alreadyBoundToMe?: boolean
  alreadyBoundToOther?: boolean
  channel?: string
  reason?: string
}

export class UnauthorizedError extends Error {
  readonly unauth = true
  constructor() {
    super('未登录')
  }
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init })
  if (res.status === 401) throw new UnauthorizedError()
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; reason?: string; error?: string }
    throw new Error(body.message ?? body.reason ?? body.error ?? `请求失败（${res.status}）`)
  }
  return (await res.json()) as T
}

function postJson<T>(url: string, body: unknown): Promise<T> {
  return getJson<T>(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

export const settingsKey = ['settings'] as const

export function settingsQuery() {
  return queryOptions({
    queryKey: settingsKey,
    queryFn: () => getJson<SettingsData>('/api/settings'),
    staleTime: 30_000,
  })
}

export function bindCodeQuery(code: string) {
  return queryOptions({
    queryKey: ['bind', code],
    queryFn: () => getJson<BindCodeInfo>(`/api/bind?code=${encodeURIComponent(code)}`),
    // 绑定链接是一次性的：拿到就不再重试，刷新页面也不重新消耗它
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
}

export function useSettings() {
  return useQuery(settingsQuery())
}

export function useBindCode(code: string) {
  return useQuery({ ...bindCodeQuery(code), enabled: code.length > 0 })
}

/** 安全设置写操作：成功即作废设置缓存，让列表自己刷新 */
export function useSecurityAction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: unknown) => postJson<{ ok: boolean; message?: string }>('/api/security', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: settingsKey }),
  })
}

export function usePasskeyDelete() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => postJson<{ ok: boolean }>('/api/passkey/delete', { id }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: settingsKey }),
  })
}

/* ------------------------------------------------------------------ *
 * 待确认操作（唯一能让黄/红操作真正执行的路径）
 * ------------------------------------------------------------------ */

export interface ConfirmResponse {
  ok: boolean
  cancelled?: boolean
  code?: string
  message?: string
  output?: unknown
  plan?: import('#/server/executor/executor').PlanState
  actionId?: string
  userId?: string
  requiredLevel?: 'red'
  reasons?: string[]
}

/** 服务端的确认失败。code 让 UI 判断能否重试（step_up_failed 可重试）。 */
export class ConfirmError extends Error {
  readonly data: ConfirmResponse
  constructor(message: string, data: ConfirmResponse) {
    super(message)
    this.data = data
  }
}

export type StepUpPayload = import('#/server/auth/step-up').StrongStepUp

/**
 * 服务端错误码里，哪些还允许用户再试一次。
 * 其余（not_found / forbidden / tampered / expired / already_used / locked）都是终态：
 * 该操作已经不能被执行，重试只会再次被拒，UI 应该直接收起到结束态。
 */
const RETRYABLE_CODES = new Set(['step_up_required', 'step_up_failed', 'plan_paused', 'card_password_required'])

export function isRetryableConfirmError(error: unknown): boolean {
  return error instanceof ConfirmError && RETRYABLE_CODES.has(error.data.code ?? '')
}

export function useConfirmAction(actionId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (stepUp: StepUpPayload | undefined) => {
      const res = await fetch('/api/confirm', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actionId, decision: 'confirm', stepUp }),
      })
      const data = (await res.json()) as ConfirmResponse
      if (!res.ok || !data.ok) throw new ConfirmError(data.message ?? data.code ?? '确认失败', data)
      return data
    },
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['dashboard'] })
      void qc.invalidateQueries({ queryKey: ['plans'] })
      if (data.actionId === actionId && data.userId) notifyConfirmation({ actionId, userId: data.userId })
    },
  })
}

export function useCancelAction(actionId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/confirm', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actionId, decision: 'cancel' }),
      })
      const data = (await res.json()) as ConfirmResponse
      if (!data.ok) throw new ConfirmError(data.message ?? data.code ?? '取消失败', data)
      return data
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['plans'] })
      void qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

