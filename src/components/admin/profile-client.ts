/** 后台用户画像接口。只读；鉴权头与其他后台接口一致。 */
export type ProfileTag = { code: string; label: string; tone: 'good' | 'warn' | 'info'; basis?: string }

export type ProfileSummaryRow = {
  userId: string
  userName: string
  monthsObserved: number
  monthlyIncomeCents: number
  monthlyExpenseCents: number
  savingsRate: number | null
  totalAssetsCents: number
  riskRating: string | null
  tags: ProfileTag[]
}

export type MonthPoint = { month: string; incomeCents: number; expenseCents: number }

export type UserProfile = {
  userId: string
  userName: string
  generatedAt: string
  fingerprint: string
  metrics: {
    monthsObserved: number
    monthlyIncomeCents: number
    monthlyExpenseCents: number
    savingsRate: number | null
    currentMonth: MonthPoint
    trend: MonthPoint[]
    topCategories: { category: string; cents: number; share: number }[]
    recurring: { counterparty: string; amountCents: number; months: number }[]
    recurringMonthlyCents: number
    expenseVsAverage: number | null
    liquidityMonths: number | null
    investmentShare: number | null
    holdingsByRisk: { riskRating: string; principalCents: number }[]
    riskRating: string | null
    riskAlignment: 'aligned' | 'mismatch' | 'unknown'
    creditUtilization: number | null
    activeSubscriptions: number
    subscriptionMonthlyCents: number
    totalAssetsCents: number
  }
  tags: Required<ProfileTag>[]
  narrative: { text: string; source: 'ai' | 'rule'; rejected?: 'numbers' | 'invalid' | 'unavailable' }
}

export class ProfileApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

function accessHeaders(): Record<string, string> {
  const token = typeof window === 'undefined' ? null : sessionStorage.getItem('wencai_admin_token')
  return token ? { authorization: `Bearer ${token}` } : {}
}

async function request<T>(query = ''): Promise<T> {
  const response = await fetch(`/api/admin-profile${query}`, { headers: accessHeaders() })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new ProfileApiError(response.status, body?.error?.message ?? '无法读取用户画像，请重试')
  if (!body || !('data' in body)) throw new ProfileApiError(response.status, '用户画像服务返回了无效数据，请重试')
  return body.data as T
}

export const profileApi = {
  list: () => request<{ users: ProfileSummaryRow[]; generatedAt: string }>(),
  detail: (userId: string, refresh = false) => request<UserProfile>(`?userId=${encodeURIComponent(userId)}${refresh ? '&refresh=1' : ''}`),
}
