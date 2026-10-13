import type { WencaiUIMessage } from '#/server/agent/messages'

export type ChoiceKind = 'card' | 'account' | 'product' | 'recipient' | 'subscription' | 'option'
export interface AgentChoice {
  id: string; kind: ChoiceKind; label: string; details: { label: string; value: string }[]; slot?: string
  card?: { cardId?: string; name: string; last4?: string; kind?: string; status?: string; balance?: number }
}
export interface InteractionSnapshot { requests: string[]; selections: string[]; taskKey?: string; cardRole?: 'source' | 'target' }
export interface AgentMessageOptions { verificationActionId?: string; cancelActionId?: string; confirmedActionId?: string }
const REQUEST = '【办理需求】', SELECTED = '【已选条件】', END = '【交互说明】'
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
const unique = (values: string[]) => [...new Set(values.filter(Boolean))]
const textOf = (message: WencaiUIMessage) => message.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n')

/** Reuse the originating task, never the unrelated turn currently at the bottom of the chat. */
export function interactionSnapshot(messages: WencaiUIMessage[], end: number): InteractionSnapshot {
  let requests: string[] = [], selections: string[] = []
  let taskKey: string | undefined
  for (const message of messages.slice(0, end + 1)) {
    if (message.parts.some((part) => part.type === 'data-confirmation' && ['completed', 'cancelled', 'failed'].includes(part.data.status))) { requests = []; selections = []; taskKey = undefined }
    if (message.role !== 'user') continue
    const text = textOf(message).trim()
    if (!text || /^我已核对并确认/.test(text)) continue
    const start = text.indexOf(REQUEST), selected = text.indexOf(SELECTED), finish = text.indexOf(END)
    if (start >= 0 && selected > start && finish > selected) {
      requests = text.slice(start + REQUEST.length, selected).trim().split('\n').filter(Boolean)
      selections = text.slice(selected + SELECTED.length, finish).trim().split('\n').filter(Boolean)
      const origin = messages.slice(0, end + 1).reverse().find((item) => item.role === 'user' && clean(textOf(item)) === requests[0])
      taskKey = origin?.id ?? taskKey ?? message.id
    } else {
      // Passwords/OTP never belong in a reusable task description.
      if (/^\d{6}$/.test(text) || /(?:密码|验证码)\s*[:：是为]?\s*\d{6}/.test(text)) continue
      const newIntent = /^(?:帮我|请|我(?:想|要|准备|打算)|查询|查一下|分析|列出|查看|看看)/.test(text) || /(?:转账|给.+转.+(?:元|块)|投资|申购|赎回|购买|挂失|申请|还款)/.test(text)
      if (requests.length && newIntent && !/^(?:改|换|更改|修改|还是|继续|重新|上一|我(?:改|换|选择|使用)|请(?:改|换|继续|重新))/.test(text)) { requests = []; selections = []; taskKey = message.id }
      taskKey ??= message.id
      requests = unique([...requests, clean(text)])
    }
  }
  const question = textOf(messages[end] ?? { role: 'assistant', parts: [] } as unknown as WencaiUIMessage).split(/[。！？\n]/).reverse().find((line) => /请选择|哪张|从哪|选择.*银行卡/.test(line)) ?? ''
  const source = /付款|扣款|转出|从哪/.test(question), target = /收款卡|转入|目标卡/.test(question)
  return { requests, selections, taskKey, ...(source && !target ? { cardRole: 'source' as const } : target && !source ? { cardRole: 'target' as const } : {}) }
}

/** A task's pickers share this store; old tasks stay separate from newly started work. */
export class InteractionMemory {
  private readonly tasks = new Map<string, InteractionSnapshot>()
  remember(snapshot: InteractionSnapshot) {
    if (!snapshot.taskKey) return
    const previous = this.tasks.get(snapshot.taskKey)
    this.tasks.set(snapshot.taskKey, structuredClone({ ...snapshot, selections: snapshot.selections.length ? snapshot.selections : previous?.selections ?? [] }))
  }
  resolve(base: InteractionSnapshot) {
    const latest = base.taskKey ? this.tasks.get(base.taskKey) : undefined
    return latest ? { ...base, requests: latest.requests, selections: latest.selections } : base
  }
  afterChoice(base: InteractionSnapshot, choice: AgentChoice, cancel = false) {
    const current = this.resolve(base), text = choiceMessage(choice, current, cancel)
    const updated = interactionSnapshot([{ id: base.taskKey ?? 'choice', role: 'user', parts: [{ type: 'text', text }] } as WencaiUIMessage], 0)
    this.remember({ ...updated, taskKey: base.taskKey })
    return text
  }
}

export function choiceDescription(choice: AgentChoice): string {
  if (choice.kind === 'card' && choice.card?.last4) return `尾号${choice.card.last4}的「${clean(choice.label)}」银行卡`
  return `「${clean(choice.label)}」${({ account: '账户', product: '理财产品', recipient: '收款人', subscription: '订阅', option: '项目', card: '银行卡' })[choice.kind]}`
}
export function selectionSnapshot(snapshot: InteractionSnapshot, choice: AgentChoice): InteractionSnapshot {
  const slot = choice.slot ?? choice.kind
  const selection = `${slot}：${choiceDescription(choice)}${choice.details.length ? `（${choice.details.map((field) => `${clean(field.label)}：${clean(field.value)}`).join('；')}）` : ''}`
  const previous = snapshot.selections.filter((line) => !line.startsWith(`${slot}：`) && !(['付款卡', '收款卡'].includes(slot) && line.startsWith('银行卡：')))
  return { ...snapshot, selections: [...previous, selection] }
}
/** Local draft only; confirmation is the only transmission point. */
export class SelectionDraft {
  private readonly values = new Map<string, AgentChoice | null>()
  private revision = 0
  private readonly listeners = new Set<() => void>()
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getRevision = () => this.revision
  private changed() { this.revision++; this.listeners.forEach((listener) => listener()) }
  select(choice: AgentChoice) { this.values.set(choice.slot ?? choice.kind, choice); this.changed() }
  clear(slot: string) { this.values.set(slot, null); this.changed() }
  selected(choices: AgentChoice[], snapshot: InteractionSnapshot) {
    const slot = choices[0]?.slot ?? choices[0]?.kind
    if (!slot) return undefined
    if (choices.length === 1) return choices[0]
    if (this.values.has(slot)) return choices.find((choice) => choice.id === this.values.get(slot)?.id)
    return choices.find((choice) => snapshot.selections.some((line) => line.startsWith(`${slot}：`) && line.includes(choiceDescription(choice))))
  }
  snapshot(base: InteractionSnapshot, choices: AgentChoice[]) {
    const cleared = [...this.values].filter(([, choice]) => choice === null).map(([slot]) => `${slot}：`)
    return choices.reduce(selectionSnapshot, { ...base, selections: base.selections.filter((line) => !cleared.some((prefix) => line.startsWith(prefix))) })
  }
}
export function confirmationMessage(snapshot: InteractionSnapshot, choices: AgentChoice[], prompt?: string) {
  const selected = choices.reduce(selectionSnapshot, snapshot)
  return [prompt ? `我确认：${clean(prompt)}` : '我已确认以下办理需求与选择，请继续办理。', REQUEST,
    ...(selected.requests.length ? selected.requests : ['请说明所选项目可办理的业务，缺少必要信息时先询问。']), SELECTED, ...selected.selections,
    END, '以本次选择为准，重新查询当前状态；交易仍须独立安全验证，不得重复执行已完成的操作。'].join('\n')
}
export function choiceMessage(choice: AgentChoice, snapshot: InteractionSnapshot, cancel = false): string {
  const description = choiceDescription(choice)
  const selection = `${choice.slot ? `${choice.slot}：` : ''}${description}${choice.details.length ? `（${choice.details.map((field) => `${clean(field.label)}：${clean(field.value)}`).join('；')}）` : ''}`
  const previous = choice.slot ? snapshot.selections.filter((line) => !line.startsWith(`${choice.slot}：`) && !(['付款卡', '收款卡'].includes(choice.slot!) && line.startsWith('银行卡：'))) : snapshot.selections
  return [
    cancel ? `我暂不选择${description}，请先不要执行本次操作。` : `我选择${description}${choice.slot && ['付款卡', '收款卡'].includes(choice.slot) ? `作为${choice.slot}` : ''}，请结合以下完整需求继续办理，缺少必要信息时请先询问。`,
    REQUEST, ...(snapshot.requests.length ? snapshot.requests : ['请就当前所选项目向我说明可办理的业务；不要直接执行交易。']),
    SELECTED, ...unique([...(cancel ? snapshot.selections : previous), ...(cancel ? [] : [selection])]),
    END, '以上历史需求只用于恢复本次选择的上下文，以当前选择及最后补充为准；不要重复执行已完成的操作。选择不代表交易验证通过，涉及交易仍须生成确认单并由我验证。',
  ].join('\n')
}
export function followUpMessage(prompt: string, snapshot: InteractionSnapshot): string {
  return [prompt, REQUEST, ...snapshot.requests, SELECTED, ...snapshot.selections, END, '请按当前请求继续；以上条件是上下文，不代表任何操作已经通过安全验证。'].join('\n')
}
export function operationMessage(summary: { title: string; fields: { label: string; value: string }[] }, snapshot: InteractionSnapshot, action: 'verify' | 'cancel' | 'repeat' | 'receipt'): string {
  const details = summary.fields.map((field) => `${field.label}：${field.value}`).join('；')
  const verb = action === 'cancel' ? '请取消这次操作，不要继续执行' : action === 'receipt' ? '请仅核对本次服务端结果，不要重新执行' : action === 'repeat' ? '我重新选择办理以下操作，请重新查询当前数据并生成新的确认单' : '我选择办理以下操作，请核对并打开独立安全验证页'
  return followUpMessage(`${verb}。${summary.title}（${details}）。以本次卡片明细为准，任何交易仍须我完成安全验证。`, snapshot)
}

type Row = Record<string, unknown>
const value = (row: Row, ...keys: string[]) => keys.map((key) => row[key]).find((v) => v !== undefined && v !== null && v !== '')
const string = (v: unknown) => typeof v === 'string' || typeof v === 'number' ? String(v) : ''
export function choiceFromRow(row: Row, hint?: ChoiceKind): AgentChoice | null {
  const kind = hint ?? (row.last4 && (row.cardId || row.kind || row.cardLast4) ? 'card' : row.riskRating && (row.name || row.productId) ? 'product' : (row.payeeId || row.bank && row.account) ? 'recipient' : row.merchant && (row.cycle || row.subscriptionId) ? 'subscription' : 'option')
  const id = string(value(row, 'cardId', 'productId', 'payeeId', 'subscriptionId', 'id', 'accountId', 'reference'))
  const label = string(value(row, 'remark', 'name', 'merchant', 'title', 'label')) || (kind === 'card' ? row.kind === 'credit' ? '信用卡' : '储蓄卡' : string(row.last4))
  if (!label || !id) return null
  const last4 = string(value(row, 'last4', 'cardLast4'))
  const details: AgentChoice['details'] = []
  const add = (label: string, raw: unknown, format: (v: string) => string = (v) => v) => { if (string(raw)) details.push({ label, value: format(string(raw)) }) }
  if (kind === 'product') {
    add('风险等级', row.riskRating); add('预期年化', row.expectedYieldPct, (v) => `${v}%`)
    add('起购金额', row.minAmount ?? (typeof row.minAmountCents === 'number' ? row.minAmountCents / 100 : undefined), (v) => `${v}元`)
    add('期限', row.termDays, (v) => v === '0' ? '随时可取' : `${v}天`)
  } else if (kind === 'card' || kind === 'account') {
    add('类型', row.kind === 'credit' ? '信用卡' : '储蓄卡'); add('尾号', last4)
    if (kind === 'account') add('余额', row.balance, (v) => `¥ ${Number(v).toFixed(2)}`)
  } else if (kind === 'recipient') { add('银行', row.bank); add('收款账号', row.account ?? row.maskedAccount); add('备注', row.alias) }
  else if (kind === 'subscription') { add('周期', row.cycle); add('金额', row.amount ?? (typeof row.amountCents === 'number' ? row.amountCents / 100 : undefined), (v) => `${v}元`) }
  else for (const [key, raw] of Object.entries(row)) {
    if (/id$|password|secret|token|code|signature|hash|pan|accountNo|phone/i.test(key)) continue
    if (typeof raw === 'string' || typeof raw === 'number') add(key, raw)
  }
  const slot = ({ card: '银行卡', account: '资金账户', product: '理财产品', recipient: '收款人', subscription: '订阅', option: undefined })[kind]
  return { id, kind, label, details, slot, ...(kind === 'card' ? { card: { cardId: string(value(row, 'cardId', 'id')) || undefined, name: label, last4, kind: string(row.kind) || 'debit', status: string(row.status) || 'active', balance: typeof row.availableCredit === 'number' ? row.availableCredit : typeof row.balance === 'number' ? row.balance : undefined } } : {}) }
}
