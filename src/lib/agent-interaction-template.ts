import { z } from 'zod'

/** A UI message describes intent only. It never carries an authorization or execution receipt. */
export const interactionIntents = ['transfer', 'purchase', 'redeem', 'cancel_subscription', 'card_action', 'query', 'select'] as const
export type InteractionIntent = typeof interactionIntents[number] | 'batch_transfer'
export type InteractionField = 'amount' | 'source' | 'target' | 'recipient' | 'product' | 'subscription' | 'card' | 'action' | 'query' | 'note'
export type InteractionSelections = Partial<Record<InteractionField, string>>
export interface ResolvedInteractionTemplate {
  version: '1'
  intent: InteractionIntent
  fields: InteractionSelections
  steps?: { id: string; recipientQuery: string; fields: InteractionSelections; recipientIds: string[] }[]
}

const DataRef = z.object({ $state: z.string().regex(/^\/[\w/-]+$/) }).strict()
const CardAction = z.enum(['apply', 'report_loss', 'lock', 'unlock', 'adjust_limit', 'set_remark', 'repay'])
const Query = z.enum(['balance', 'transactions', 'spending_report', 'products', 'subscriptions', 'card_details'])
export const InteractionTemplateSchema = z.object({
  version: z.literal('1'),
  intent: z.enum(interactionIntents),
  fields: z.object({
    amount: z.union([DataRef, z.object({ yuan: z.number().positive().max(1_000_000) }).strict()]).optional(),
    source: DataRef.optional(), target: DataRef.optional(), recipient: DataRef.optional(),
    product: DataRef.optional(), subscription: DataRef.optional(), card: DataRef.optional(),
    action: CardAction.optional(), query: Query.optional(),
    note: z.union([DataRef, z.object({ value: z.string().min(1).max(80) }).strict()]).optional(),
  }).strict(),
}).strict()
export type InteractionTemplateInput = z.infer<typeof InteractionTemplateSchema>

const allowed: Record<InteractionIntent, readonly InteractionField[]> = {
  transfer: ['amount', 'source', 'target', 'recipient', 'note'],
  purchase: ['amount', 'source', 'product'],
  redeem: ['amount', 'target', 'product'],
  cancel_subscription: ['subscription'],
  card_action: ['card', 'source', 'amount', 'action', 'note'],
  query: ['card', 'source', 'product', 'subscription', 'query'],
  select: ['source', 'target', 'recipient', 'product', 'subscription', 'card'],
  batch_transfer: ['source'],
}
const selectable = new Set<InteractionField>(['source', 'target', 'recipient', 'product', 'subscription', 'card'])
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[「」]/g, ' ').trim().slice(0, 160)
const quote = (text: string) => `「${clean(text)}」`
const resolvedFields = z.object({
  amount: z.string().regex(/^\d+(?:\.\d{1,2})?$/).optional(),
  source: z.string().max(160).optional(), target: z.string().max(160).optional(), recipient: z.string().max(160).optional(),
  product: z.string().max(160).optional(), subscription: z.string().max(160).optional(), card: z.string().max(160).optional(),
  action: CardAction.optional(), query: Query.optional(), note: z.string().max(80).optional(),
}).strict()
const transferStep = z.object({
  id: z.string().regex(/^step-[1-8]$/), recipientQuery: z.string().min(1).max(60),
  fields: z.object({ amount: z.string().regex(/^\d+(?:\.\d{1,2})?$/), recipient: z.string().max(160).optional(), note: z.string().max(80).optional() }).strict(),
  recipientIds: z.array(z.string().min(1).max(100)).min(1).max(100),
}).strict()
const resolvedTemplateSchema = z.union([
  z.object({ version: z.literal('1'), intent: z.enum(interactionIntents), fields: resolvedFields }).strict(),
  z.object({ version: z.literal('1'), intent: z.literal('batch_transfer'), fields: z.object({ source: z.string().max(160).optional() }).strict(), steps: z.array(transferStep).min(2).max(8) }).strict(),
])

/** Persisted chat records are not assumed to have the shape of a fresh server response. */
export function isResolvedInteractionTemplate(input: unknown): input is ResolvedInteractionTemplate {
  const parsed = resolvedTemplateSchema.safeParse(input)
  return parsed.success && Object.keys(parsed.data.fields).every((field) => allowed[parsed.data.intent].includes(field as InteractionField)) && (parsed.data.intent !== 'batch_transfer' || new Set(parsed.data.steps.map((step) => step.id)).size === parsed.data.steps.length)
}

/** Fixed wording prevents model-generated prose, historical task replay and claims of completed verification. */
export function renderInteractionTemplate(template: ResolvedInteractionTemplate, selections: InteractionSelections = {}, stepSelections: Record<string, InteractionSelections> = {}): string {
  if (!isResolvedInteractionTemplate(template)) return '请先核对本次要办理的业务及必要信息，不要创建或执行交易。'
  const fields: InteractionSelections = { ...template.fields }
  for (const field of allowed[template.intent]) if (selectable.has(field) && selections[field]) fields[field] = clean(selections[field]!)
  if (template.intent === 'batch_transfer') {
    const missing: string[] = []
    if (!fields.source) missing.push('付款账户')
    const lines = template.steps!.map((step, index) => {
      const recipient = stepSelections[step.id]?.recipient ?? step.fields.recipient
      if (!recipient) missing.push(`第${index + 1}笔收款人（${clean(step.recipientQuery)}）`)
      return `${index + 1}. 向${recipient ? quote(recipient) : `待确定的${quote(step.recipientQuery)}`}转账${step.fields.amount}元${step.fields.note ? `，备注${quote(step.fields.note)}` : ''}。`
    })
    const body = `我确认${fields.source ? `从${quote(fields.source)}` : ''}依次办理以下${lines.length}笔转账：\n${lines.join('\n')}\n`
    return body + (missing.length ? `请先补充${missing.join('、')}，不要创建或执行交易。` : '请逐笔核对当前银行数据并生成银行确认单，每笔仍须在独立安全页面完成验证；已完成的操作不得重复执行。')
  }
  const entity = (field: InteractionField) => fields[field] ? quote(fields[field]!) : ''
  const amount = fields.amount ? `${fields.amount}元` : ''
  let body = ''
  const missing: string[] = []
  switch (template.intent) {
    case 'transfer': {
      if (!fields.source) missing.push('付款账户')
      if (!fields.recipient && !fields.target) missing.push('收款对象')
      if (!amount) missing.push('转账金额')
      body = `我确认${fields.source ? `从${entity('source')}` : ''}向${entity('recipient') || entity('target') || '待确定的收款对象'}转账${amount}${fields.note ? `，备注${entity('note')}` : ''}。`
      break
    }
    case 'purchase':
      if (!fields.source) missing.push('付款账户')
      if (!fields.product) missing.push('理财产品')
      if (!amount) missing.push('申购金额')
      body = `我确认${fields.source ? `使用${entity('source')}` : ''}申购${entity('product') || '待确定的理财产品'}${amount}。`
      break
    case 'redeem':
      if (!fields.product) missing.push('理财产品')
      if (!amount) missing.push('赎回金额')
      body = `我确认赎回${entity('product') || '待确定的理财产品'}${amount}${fields.target ? `，转入${entity('target')}` : ''}。`
      break
    case 'cancel_subscription':
      if (!fields.subscription) missing.push('订阅项目')
      body = `我确认申请取消${entity('subscription') || '待确定的订阅'}。`
      break
    case 'card_action': {
      const action = fields.action && ({ apply: '申请银行卡', report_loss: '挂失', lock: '锁定', unlock: '解锁', adjust_limit: '调整限额', set_remark: '修改备注', repay: '信用卡还款' } as Record<string, string>)[fields.action]
      if (!action) missing.push('卡片操作')
      if (fields.action !== 'apply' && !fields.card) missing.push('银行卡')
      if (['adjust_limit', 'repay'].includes(fields.action ?? '') && !amount) missing.push('金额')
      if (fields.action === 'set_remark' && !fields.note) missing.push('新备注')
      body = `我确认申请${action || '待确定的卡片操作'}${fields.card ? `，卡片${entity('card')}` : ''}${fields.source ? `，付款账户${entity('source')}` : ''}${amount ? `，金额${amount}` : ''}${fields.note ? `，备注${entity('note')}` : ''}。`
      break
    }
    case 'query': {
      const query = fields.query && ({ balance: '账户余额', transactions: '交易明细', spending_report: '账单报告', products: '理财产品信息', subscriptions: '订阅信息', card_details: '银行卡信息' } as Record<string, string>)[fields.query]
      if (!query) missing.push('查询内容')
      const subject = ['card', 'source', 'product', 'subscription'].filter((key) => fields[key as InteractionField]).map((key) => entity(key as InteractionField)).join('、')
      body = `请查询${subject ? `${subject}的` : ''}${query || '待确定的内容'}。`
      break
    }
    case 'select': {
      const choices = allowed.select.filter((field) => fields[field]).map((field) => `${({ source: '付款账户', target: '转入账户', recipient: '收款人', product: '理财产品', subscription: '订阅', card: '银行卡' } as Record<string, string>)[field]}${entity(field)}`)
      body = choices.length ? `我确认选择${choices.join('、')}。` : '请说明当前可选择的项目。'
      missing.push('办理目的及必要参数')
      break
    }
  }
  if (missing.length) return `${body}请先向我确认${missing.join('、')}，不要创建或执行交易。`
  return template.intent === 'query' ? body : `${body}请核对当前银行数据并生成本次操作的确认单，仍须在独立安全页面完成验证。`
}

/** Instructions for a model: values are semantic bindings, never an arbitrary user-message template. */
export function interactionTemplatePrompt(): string {
  return [
    '所有可交互选择界面在同一轮必须调用一次 prepare_interaction，声明“当前待办理步骤”的稳定消息模板。它不执行业务、不代表验证通过。',
    '模板格式：{version:"1",intent:"transfer"|"purchase"|"redeem"|"cancel_subscription"|"card_action"|"query"|"select",fields:{...}}。也可放在show_view的spec.interaction顶层；不要放进组件props。',
    'fields可用：amount、source、target、recipient、product、subscription、card、action、query、note。实体字段只写{$state:"/工具名/对象路径"}，必须指向真实的单个工具对象；尚待用户选择的实体可省略，用户的本次选择会替换对应字段。',
    'amount写{$state:"/工具名/amountCents"}（自动按分转换）或{yuan:当前用户明确提出的元金额}，服务端会核对本轮用户输入；不能用账户余额、起购金额或旧任务金额冒充办理金额。note写{$state:"/工具名/备注路径"}或{value:"当前用户原文中的备注"}。',
    '每个模板只描述当前一个步骤；复杂任务依次交互，不要把已完成、取消、待定的其他步骤或历史原话重新塞入模板。不能生成自由消息正文，不能包含actionId、密码、验证码、令牌或任何验证已通过的断言。',
    '用户同一请求包含多笔转账时，先调用prepare_transfer_batch，逐笔填入recipientQuery/amountYuan/note；它会为每笔生成独立的消歧选择并共用付款卡，不要将多笔需求降级为select或用多个find_payee结果拼同一个选择界面。',
    'transfer使用amount/source和recipient或target；purchase使用amount/source/product；redeem使用amount/product，可选target；cancel_subscription使用subscription；card_action的action限apply/report_loss/lock/unlock/adjust_limit/set_remark/repay；query的query限balance/transactions/spending_report/products/subscriptions/card_details；仅选择但办理目的尚不明用select。',
    '例如用户本轮明确要求转账200元，且find_payee返回唯一收款人：prepare_interaction({version:"1",intent:"transfer",fields:{amount:{yuan:200},recipient:{$state:"/find_payee/candidates/0"}}})。随后展示付款卡选择，用户确认后固定模板会填入所选付款卡，不重复发送用户历史消息。路径必须依据实际工具输出调整。',
  ].join('\n')
}
