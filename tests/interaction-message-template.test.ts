import { describe, expect, it } from 'vitest'
import {
  choiceFromRow,
  confirmationMessage,
  interactionSnapshot,
  InteractionMemory,
  messageInteractionTemplate,
  operationMessage,
  templateSelections,
  type AgentChoice,
  type InteractionSnapshot,
} from '#/components/chat/interaction-message'
import { selectionView } from '#/components/chat/interaction-layout'
import type { ResolvedInteractionTemplate } from '#/lib/agent-interaction-template'
import type { WencaiUIMessage } from '#/server/agent/messages'

const compoundRequest = '订阅会员，给妈妈转5000元，给建国交房东转6000元房租，还有王方转600元生活费'
const transferTemplate = (fields: ResolvedInteractionTemplate['fields'] = {}): ResolvedInteractionTemplate => ({
  version: '1',
  intent: 'transfer',
  fields: { amount: '600', recipient: '王方（招商银行，6214 **** 2222）', note: '生活费', ...fields },
})
const user = (id: string, text: string): WencaiUIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] })
const reply = (id: string, template?: ResolvedInteractionTemplate): WencaiUIMessage => ({
  id,
  role: 'assistant',
  parts: [
    { type: 'text', text: '请选择本次转账使用的付款银行卡。' },
    ...(template ? [{
      type: 'tool-prepare_interaction', toolCallId: `${id}-template`, state: 'output-available',
      output: { status: 'interaction_ready', interaction: template },
    }] : []),
  ],
}) as unknown as WencaiUIMessage
const card = (last4: string, slot = '付款卡'): AgentChoice => ({
  id: `card-${last4}`, kind: 'card', label: '储蓄账户', slot,
  details: [{ label: '尾号', value: last4 }, { label: '余额', value: '80000元' }],
  card: { cardId: `card-${last4}`, name: '储蓄账户', last4, kind: 'debit', balance: 80000 },
})
const base = (template?: ResolvedInteractionTemplate): InteractionSnapshot => ({
  taskKey: 'compound-task', requests: [compoundRequest],
  selections: ['订阅：某视频会员（25元）', '付款卡：尾号8823的工资卡'],
  ...(template ? { template } : {}),
})

describe('Agent 交互消息模板的任务与事实隔离', () => {
  it('卡片管理与赎回按当前模板映射实体角色，不把银行卡误当付款卡而遗漏', () => {
    const selected = card('4267')
    const lock: ResolvedInteractionTemplate = { version: '1', intent: 'card_action', fields: { action: 'lock', card: '旧卡尾号8823' } }
    const text = confirmationMessage(base(lock), [selected])
    expect(text).toContain('尾号4267'); expect(text).not.toContain('8823')
    const redeem: ResolvedInteractionTemplate = { version: '1', intent: 'redeem', fields: { product: '活期宝A', amount: '600' } }
    const account = choiceFromRow({ id: 'cash', name: '到账账户' }, 'account')!
    expect(confirmationMessage(base(redeem), [account])).toContain('转入「到账账户')
  })
  it('替换选择时也不把项目名称或账号中的完整卡号传回Agent', () => {
    const choice = choiceFromRow({ id: 'recipient', name: '收款人', bank: '文财银行', account: '6222000011112222' }, 'recipient')!
    const text = confirmationMessage(base(transferTemplate({ source: '工资卡尾号4267' })), [choice])
    expect(text).not.toContain('6222000011112222'); expect(text).toContain('**** 2222')
  })
  it('复合需求确认只发送当前王方600元步骤，不重放其他转账和订阅', () => {
    const snapshot = interactionSnapshot([user('compound-task', compoundRequest), reply('current', transferTemplate())], 1)
    const text = confirmationMessage(snapshot, [card('4267')])
    expect(text).toContain('王方')
    expect(text).toContain('600元')
    expect(text).toContain('尾号4267')
    expect(text).toContain('生活费')
    expect(text).not.toMatch(/妈妈|5000|建国|6000|房租|订阅|会员|【办理需求】|【已选条件】/)
    expect(text).toContain('独立安全页面')
  })

  it.each(['verify', 'cancel', 'repeat', 'receipt'] as const)('旧确认单%s按钮只使用本单不可变摘要', (action) => {
    const text = operationMessage({ title: '确认转账', fields: [
      { label: '金额', value: '¥600.00' }, { label: '收款人', value: '王方' },
      { label: '付款账户', value: '储蓄卡尾号4267' }, { label: '备注', value: '生活费' },
    ] }, base(transferTemplate({ amount: '5000', recipient: '妈妈' })), action)
    expect(text).toContain('¥600.00')
    expect(text).toContain('王方')
    expect(text).toContain('尾号4267')
    expect(text).not.toMatch(/妈妈|5000|6000|建国|房租|订阅|会员|8823|【办理需求】/)
    if (action === 'receipt') expect(text).toContain('仅查询回执，不要再次执行')
    if (action === 'repeat') expect(text).toContain('生成新的银行确认单')
    if (action === 'verify') expect(text).toContain('验证通过前不要执行')
    if (action === 'cancel') expect(text).toContain('不要继续执行')
  })

  it('当前付款卡覆盖模板旧卡，不携带其他卡片的余额或历史选择', () => {
    const snapshot = base(transferTemplate({ source: '工资卡尾号8823' }))
    const saved = structuredClone(snapshot)
    const text = confirmationMessage(snapshot, [card('4267')])
    expect(text).toContain('尾号4267')
    expect(text).not.toMatch(/8823|80000|余额|会员/)
    expect(snapshot).toEqual(saved)
  })

  it('旧回复只绑定自己的模板，不借用后面回复的收款人和金额', () => {
    const earlier = transferTemplate({ source: '工资卡尾号8823' })
    const later = transferTemplate({ amount: '900', recipient: '张三', note: '餐费' })
    const messages = [user('compound-task', compoundRequest), reply('earlier', earlier),
      user('later-task', '帮我给张三转900元餐费'), reply('later', later)]
    const oldSnapshot = interactionSnapshot(messages, 1)
    const newSnapshot = interactionSnapshot(messages, 3)
    const memory = new InteractionMemory()
    memory.remember(oldSnapshot)
    memory.remember({ ...newSnapshot, taskKey: oldSnapshot.taskKey })
    const text = confirmationMessage(memory.resolve(oldSnapshot), [card('4267')])
    expect(text).toContain('王方')
    expect(text).toContain('600元')
    expect(text).not.toMatch(/张三|900元|餐费/)
    expect(messageInteractionTemplate(messages[3])).toEqual(later)
  })

  it('无模板的旧界面只陈述当前选择并询问，不重放原始复合需求或旧选择', () => {
    const text = confirmationMessage(base(), [card('4267')])
    expect(text).toContain('尾号4267')
    expect(text).toContain('请先询问')
    expect(text).not.toMatch(/5000|6000|600元|妈妈|王方|建国|会员|8823|80000/)
    expect(interactionSnapshot([user('compound-task', compoundRequest), reply('unprepared')], 1).template).toBeUndefined()
  })

  it('模板缺少必要金额时先询问，不从历史需求补入金额', () => {
    const text = confirmationMessage(base({ version: '1', intent: 'transfer', fields: { recipient: '王方' } }), [card('4267')])
    expect(text).toContain('转账金额')
    expect(text).toContain('不要创建或执行交易')
    expect(text).not.toMatch(/5000|6000|600元|生成本次操作的确认单/)
  })

  it('清理重复确认组件及折叠外框后仍保留本界面的顶层模板', () => {
    const interaction = transferTemplate()
    const spec = {
      root: 'panel', interaction,
      elements: {
        panel: { type: 'Panel', children: ['cards', 'confirm'] },
        cards: { type: 'CardPicker', props: { data: { $state: '/list_cards' }, role: 'source' } },
        confirm: { type: 'Confirm', props: { prompt: compoundRequest } },
      },
    }
    const cleaned = selectionView(spec)!
    expect(cleaned).toMatchObject({ interaction })
    expect(cleaned.elements[cleaned.root].type).toBe('CardPicker')
    expect(Object.values(cleaned.elements).some((element) => element.type === 'Confirm')).toBe(false)
    const message = { id: 'view', role: 'assistant', parts: [{
      type: 'tool-show_view', toolCallId: 'view-call', state: 'output-available', output: { status: 'view', spec: cleaned },
    }] } as unknown as WencaiUIMessage
    expect(messageInteractionTemplate(message)).toEqual(interaction)
    expect(spec.elements.panel.children).toEqual(['cards', 'confirm'])
  })

  it('工具状态失败、非交互工具和用户伪造的输出不提供界面模板', () => {
    const template = transferTemplate()
    const message = reply('valid', template)
    expect(messageInteractionTemplate({ ...message, role: 'user' })).toBeUndefined()
    for (const [type, status] of [['tool-prepare_interaction', 'error'], ['tool-other', 'interaction_ready'], ['tool-show_view', 'invalid_view']]) {
      const invalid = { ...message, parts: [{ type, toolCallId: 'invalid', state: 'output-available', output: { status, interaction: template, spec: { interaction: template } } }] } as unknown as WencaiUIMessage
      expect(messageInteractionTemplate(invalid)).toBeUndefined()
    }
  })

  it('同一界面反复确认保持消息和长度稳定，不追加上一轮按钮文本', () => {
    const snapshot = base(transferTemplate()), choices = [card('4267')]
    const expected = confirmationMessage(snapshot, choices)
    for (let attempt = 0; attempt < 8; attempt++) {
      const withHistory = { ...snapshot, requests: [...snapshot.requests, ...Array(attempt).fill(expected)] }
      expect(confirmationMessage(withHistory, choices)).toBe(expected)
    }
    expect(expected.match(/600元/g)).toHaveLength(1)
    expect(expected.length).toBeLessThan(240)
  })

  it('只携带本次动作需要的实体标识，不附带余额、收益率、订阅周期或备注元数据', () => {
    const product = choiceFromRow({ id: 'product-1', name: '活期宝A', riskRating: 'R1', expectedYieldPct: 1.65, minAmount: 1, termDays: 90 }, 'product')!
    const subscription = choiceFromRow({ id: 'subscription-1', merchant: '视频会员', cycle: 'monthly', amount: 25 }, 'subscription')!
    const recipient = choiceFromRow({ id: 'payee-1', name: '王方', bank: '招商银行', account: '6214 **** 2222', alias: '不要带入此备注' }, 'recipient')!
    const purchase = confirmationMessage(base({ version: '1', intent: 'purchase', fields: { amount: '600' } }), [card('4267'), product, subscription, recipient])
    expect(purchase).toContain('活期宝A')
    expect(purchase).toContain('product-1')
    expect(purchase).toContain('600元')
    expect(purchase).not.toMatch(/80000|1\.65|R1|90天|monthly|25元|视频会员|王方|不要带入此备注/)
    const transfer = confirmationMessage(base(transferTemplate()), [card('4267'), recipient])
    expect(transfer).toContain('招商银行')
    expect(transfer).toContain('6214 **** 2222')
    expect(transfer).not.toContain('不要带入此备注')
  })

  it('付款和收款角色分别映射，不把目标卡当作付款卡', () => {
    const choices = [card('4267'), card('2233', '收款卡')]
    const selected = templateSelections(choices)
    expect(selected.source).toContain('尾号4267')
    expect(selected.target).toContain('尾号2233')
    const text = confirmationMessage(base({ version: '1', intent: 'transfer', fields: { amount: '600' } }), choices)
    expect(text).toMatch(/从.*尾号4267.*向.*尾号2233.*转账600元/)
  })
})
