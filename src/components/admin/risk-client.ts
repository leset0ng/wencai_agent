/** 收款账户风险复核使用独立管理接口，复核人由服务端鉴权确定。 */
export type RiskReviewStatus = 'suspected' | 'confirmed' | 'cleared'

export type RiskReviewRow = {
  accountId: string
  userId: string
  ownerName: string
  accountName: string
  status: RiskReviewStatus
  revision: number
  features: Record<string, number | null>
  reasons: string[]
  source: string
  createdAt: string
  updatedAt: string
  reviewedBy: string | null
  reviewedAt: string | null
}

export type RiskReviewOverview = {
  flags: RiskReviewRow[]
  summary: Record<RiskReviewStatus, number>
  generatedAt: string
}

export class RiskReviewApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

function accessHeaders(): Record<string, string> {
  const token = typeof window === 'undefined' ? null : sessionStorage.getItem('wencai_admin_token')
  return token ? { authorization: `Bearer ${token}` } : {}
}

async function request<T>(decision?: { accountId: string; expectedRevision: number; decision: 'confirmed' | 'cleared' }): Promise<T> {
  const response = await fetch('/api/admin-risk', {
    method: decision ? 'POST' : 'GET',
    headers: { ...accessHeaders(), ...(decision ? { 'Content-Type': 'application/json' } : {}) },
    ...(decision ? { body: JSON.stringify(decision) } : {}),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new RiskReviewApiError(response.status, body?.error?.code ?? 'ERROR', body?.error?.message ?? '无法连接风险复核服务，请重试')
  }
  if (!body || !('data' in body)) throw new RiskReviewApiError(response.status, 'INVALID_RESPONSE', '风险复核服务返回了无效数据，请重试')
  return body.data as T
}

export const riskReviewApi = {
  list: () => request<RiskReviewOverview>(),
  review: (decision: { accountId: string; expectedRevision: number; decision: 'confirmed' | 'cleared' }) => request<unknown>(decision),
}
