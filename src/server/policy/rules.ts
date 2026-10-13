import type { PolicyInput, RiskLevel } from './types'

export const LIMITS = {
  /** 单笔超过 3000 元需密码与生物识别双重验证（分）。 */
  singleLargeCents: 300_000,
  /** 10 分钟内转账笔数超过该值触发熔断 */
  burstTransfers: 5,
} as const

export type RuleResult =
  | { kind: 'raise'; to: RiskLevel; reason: string }
  | { kind: 'deny'; reason: string }
  | null

export interface Rule {
  id: string
  applies: (input: PolicyInput) => boolean
  evaluate: (input: PolicyInput) => RuleResult
}

/** 基础工具用元，扩展/互转工具用分；风险规则统一以分比较。 */
function amountCents(input: PolicyInput): number {
  if (typeof input.args.amountCents === 'number' && Number.isSafeInteger(input.args.amountCents)) return input.args.amountCents
  const v = input.args.amount
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : 0
}

const isTransfer = (i: PolicyInput) => ['transfer', 'commit_transfer', 'commit_scheduled_transfer', 'transfer_between_accounts', 'transfer_between_cards', 'repay_credit_card', 'pay_split_request', 'create_birthday_plan', 'execute_birthday_order', 'create_standing_mandate', 'execute_standing_mandate'].includes(i.tool)

export const RULES: Rule[] = [
  {
    id: 'recipient-account-risk',
    applies: isTransfer,
    evaluate: ({ facts }) => facts.payeeRiskFlag === 'confirmed'
      ? { kind: 'deny', reason: '该收款账户经人工复核存在高风险，已阻止本次转账，请联系人工客服' }
      : facts.payeeRiskFlag === 'suspected'
        ? { kind: 'raise', to: 'red', reason: '该收款账户近期收款特征异常，请核实对方身份，并完成本次强验证' }
        : null,
  },
  {
    id: 'sensitive-card-operation',
    applies: (i) => i.tool === 'commit_card_change' && ['unlock', 'lost', 'limits'].includes(String(i.args.action)),
    evaluate: () => ({ kind: 'raise', to: 'red', reason: '解锁、挂失和额度变更必须进行强验证' }),
  },
  {
    id: 'account-locked',
    applies: () => true,
    evaluate: ({ facts, baseRisk }) =>
      facts.accountLocked && baseRisk !== 'green'
        ? { kind: 'deny', reason: '账户因安全原因已临时锁定，请联系人工客服' }
        : null,
  },
  {
    id: 'transfer-burst',
    applies: isTransfer,
    evaluate: ({ facts }) =>
      facts.recentTransferCount >= LIMITS.burstTransfers
        ? { kind: 'deny', reason: '短时间内转账过于频繁，已触发风控熔断' }
        : null,
  },
  {
    id: 'transfer-single-large',
    applies: isTransfer,
    evaluate: (input) =>
      amountCents(input) > LIMITS.singleLargeCents
        ? { kind: 'raise', to: 'red', reason: '单笔转账超过 3000 元，需要交易密码与指纹或人脸双重验证' }
        : null,
  },
]
