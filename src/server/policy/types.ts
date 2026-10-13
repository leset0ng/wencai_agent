export type RiskLevel = 'green' | 'yellow' | 'red'

export const RISK_ORDER: Record<RiskLevel, number> = { green: 0, yellow: 1, red: 2 }

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b
}

export type Channel = 'web' | 'lark' | 'mcp'

/** 各渠道可就地执行的最高风险等级（见 ARCHITECTURE.md 3.2） */
export const CHANNEL_CEILING: Record<Channel, RiskLevel> = {
  web: 'red',
  lark: 'yellow',
  mcp: 'green',
}

/** 策略判定所需的事实，由服务端从数据库采集，绝不来自模型 */
export interface PolicyFacts {
  now: Date
  channel: Channel
  accountLocked: boolean
  /** 今日已转出累计（分），不含本笔 */
  dailyOutgoingCents: number
  /** 收款人首次被添加距今的天数；undefined 表示未登记的新收款人 */
  payeeAgeDays?: number
  /** 最近 10 分钟内的转账笔数 */
  recentTransferCount: number
  /** Recipient account flags are server facts; AI never supplies a policy level. */
  payeeRiskFlag?: 'suspected' | 'confirmed'
  payeeRiskAccountId?: string
  payeeRiskRevision?: number
}

export interface PolicyInput {
  tool: string
  baseRisk: RiskLevel
  args: Record<string, unknown>
  facts: PolicyFacts
}

export interface PolicyDecision {
  /** 判定后的等级（只升不降） */
  level: RiskLevel
  /** 是否允许执行（含确认后执行）；false 表示直接拒绝 */
  allowed: boolean
  /** 命中的规则说明，写入审计并展示给用户 */
  reasons: string[]
  /** 渠道能力不足，需跳转 H5 完成 */
  requiresChannelHandoff: boolean
}
