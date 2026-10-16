export interface DashboardData {
  now: string
  notifications?: { id: string; title: string; body: string; actionId: string | null; read: boolean }[]
  pendingTransfers?: { actionId: string; level: 'yellow' | 'red'; summary: { title: string; fields: { label: string; value: string }[] }; expiresAt: number }[]
  totalAssets: number
  reservedBalance?: number
  availableBalance: number
  investmentPrincipal: number
  accounts: { id: string; name: string; balance: number; currency: string }[]
  cards: { id: string; accountId: string; last4: string; kind: string; status: string; accountName: string; remark: string; dailyLimit: number; creditLimit: number; outstanding: number; availableCredit: number; billDay: number; dueDay: number }[]
  accountActivity: Record<string, { monthly: DashboardData['monthly']; transactions: DashboardData['transactions'] }>
  transactions: {
    id: string
    amount: number
    counterparty: string
    category: string
    occurredAt: string
    accountId?: string
    memo?: string
  }[]
  subscriptions: { id: string; merchant: string; amount: number; cycle: string; status: string }[]
  monthly: {
    period: string
    income: number
    expense: number
    categories: { label: string; value: number }[]
  }
  trend: { label: string; value: number }[]
}

export const formatAmount = (amount: number) =>
  amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** 业务账期统一按 UTC+8 计算，不依赖浏览器/服务器的本地时区。 */
export const businessMonth = (date: Date) =>
  new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 7)

/** 与账户页面一致的北京时间，禁止直接截取 UTC ISO 日期用于账单。 */
export const businessDate = (date: Date) =>
  new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)

export const businessDateTime = (date: Date) =>
  new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
