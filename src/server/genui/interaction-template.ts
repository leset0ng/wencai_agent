import { InteractionTemplateSchema, type InteractionField, type InteractionIntent, type ResolvedInteractionTemplate } from '#/lib/agent-interaction-template'
import { requestedAmounts } from '#/lib/requested-amounts'

const allowed: Record<InteractionIntent, readonly InteractionField[]> = {
  transfer: ['amount', 'source', 'target', 'recipient', 'note'], purchase: ['amount', 'source', 'product'],
  redeem: ['amount', 'target', 'product'], cancel_subscription: ['subscription'],
  card_action: ['card', 'source', 'amount', 'action', 'note'], query: ['card', 'source', 'product', 'subscription', 'query'],
  select: ['source', 'target', 'recipient', 'product', 'subscription', 'card'],
  batch_transfer: ['source'],
}
const forbiddenPath = /(?:password|passcode|secret|token|code|signature|hash|pan|accountno|authorization|verification)/i
const forbiddenText = /(?:密码|验证码)\s*[:：是为]?\s*\d|(?:验证|认证)(?:已|已经)?(?:通过|完成|成功)|跳过(?:验证|确认)|无需(?:验证|确认)/
const plain = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
const masked = (text: string) => plain(text).replace(/\d[\d -]{10,}\d/g, (number) => `**** ${number.replace(/\D/g, '').slice(-4)}`)
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const string = (value: unknown) => typeof value === 'string' ? masked(value) : ''

function getByPointer(state: unknown, pointer: string): unknown {
  let current = state
  for (const segment of pointer.split('/').slice(1)) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function describeEntity(value: unknown, field: InteractionField): string | undefined {
  const row = record(value)
  if (!row) return undefined
  const name = string(row.remark) || string(row.name) || string(row.merchant) || string(row.title) || string(row.label)
  const last4 = typeof row.last4 === 'string' && /^\d{4}$/.test(row.last4) ? row.last4 : typeof row.cardLast4 === 'string' && /^\d{4}$/.test(row.cardLast4) ? row.cardLast4 : ''
  if (last4 && (row.cardId || row.kind || field === 'card')) return `尾号${last4}的${name || (row.kind === 'credit' ? '信用卡' : '储蓄卡')}`
  if (!name) return undefined
  const bank = string(row.bank)
  const account = string(row.maskedAccount) || string(row.account)
  return `${name}${field === 'recipient' && (bank || account) ? `（${[bank, account].filter(Boolean).join(' ')}）` : ''}`.slice(0, 160)
}

function requestedAmount(requestText: string, yuan: number) {
  const cents = Math.round(yuan * 100)
  return requestedAmounts(requestText).some((amount) => Math.round(amount * 100) === cents)
}

export type InteractionTemplateCheck = { ok: true; interaction: ResolvedInteractionTemplate } | { ok: false; errors: string[] }

/** Only server snapshots and the current human request may supply template facts. */
export function checkInteractionTemplate(input: unknown, state: Record<string, unknown>, requestText = '', currentTools: ReadonlySet<string> = new Set()): InteractionTemplateCheck {
  const parsed = InteractionTemplateSchema.safeParse(input)
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((issue) => `interaction.${issue.path.join('.')}: ${issue.message}`) }
  const template = parsed.data
  const fields: ResolvedInteractionTemplate['fields'] = {}
  const errors: string[] = []
  for (const [key, binding] of Object.entries(template.fields)) {
    const field = key as InteractionField
    if (!allowed[template.intent].includes(field)) { errors.push(`interaction.fields.${field}: 不属于当前步骤`); continue }
    if (typeof binding === 'string') { fields[field] = binding; continue }
    const reference = '$state' in binding ? binding.$state : undefined
    if (reference && forbiddenPath.test(reference)) { errors.push(`interaction.fields.${field}: 禁止引用安全凭证`); continue }
    const resolved = reference ? getByPointer(state, reference) : undefined
    if (reference && resolved === undefined) { errors.push(`interaction.fields.${field}: 数据路径 ${reference} 不存在`); continue }
    if (field === 'amount') {
      const yuan = 'yuan' in binding ? binding.yuan : typeof resolved === 'number' ? resolved / (/cents$/i.test(reference ?? '') ? 100 : 1) : NaN
      // A balance/minimum/yield cannot serve as a user's requested transaction amount.
      const validReference = !!reference && currentTools.has(reference.split('/')[1]) && /\/(?:amount|amountCents|principal|principalCents|total|totalCents)$/i.test(reference)
      if (!Number.isFinite(yuan) || yuan <= 0 || yuan > 1_000_000 || Math.abs(Math.round(yuan * 100) - yuan * 100) > 0.00001 || (!validReference && !requestedAmount(requestText, yuan))) errors.push(`interaction.fields.amount: 金额必须来自当前用户需求或本轮工具的办理金额字段`)
      else fields.amount = yuan.toFixed(2)
    } else if (field === 'note') {
      const text = 'value' in binding ? binding.value : typeof resolved === 'string' ? resolved : ''
      if (!text || text.length > 80 || forbiddenText.test(text) || ('value' in binding && !requestText.includes(text))) errors.push('interaction.fields.note: 备注必须来自当前用户需求或工具结果，且不得包含安全凭证或验证断言')
      else fields.note = masked(text)
    } else {
      const description = describeEntity(resolved, field)
      if (!description || forbiddenText.test(description)) errors.push(`interaction.fields.${field}: 必须引用真实的单个项目对象`)
      else fields[field] = description
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, interaction: { version: '1', intent: template.intent, fields } }
}
