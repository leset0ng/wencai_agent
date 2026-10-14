import { describe, expect, it, vi } from 'vitest'
import { prepareTransferBatch } from '#/server/agent/batch-transfer'
import { requestedAmounts, requestedTransferMatches } from '#/lib/requested-amounts'
import { checkInteractionTemplate } from '#/server/genui/interaction-template'
import { isResolvedInteractionTemplate, renderInteractionTemplate } from '#/lib/agent-interaction-template'
import { choiceFromRow, confirmationMessage, messageInteractionTemplate, SelectionDraft } from '#/components/chat/interaction-message'
import { canonicalChoiceGroups } from '#/components/chat/selection-groups'
import { toolPresentations } from '#/components/chat/presentation'
import type { BatchTransferReady } from '#/lib/batch-transfer'
import type { ToolOutcome } from '#/server/tools/define'
import type { WencaiUIMessage } from '#/server/agent/messages'
import { checkedResponse } from '#/server/verify/response'
import { AgentChoiceContext } from '#/components/chat/AgentInteraction'
import { BatchTransferView } from '#/components/chat/BatchTransferView'
import AssistantText from '#/components/chat/AssistantText'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const request = '给妈妈转400再给王芳转200再给房东装600'
const input = { transfers: [{ recipientQuery: '妈妈', amountYuan: 400 }, { recipientQuery: '王芳', amountYuan: 200 }, { recipientQuery: '房东', amountYuan: 600 }] }
const recipient = (id: string, name: string) => ({ id, name, bank: '文财银行', account: `6214 **** ${id === 'mom' ? '2233' : id === 'rent' ? '2000' : '2222'}` })
const candidates = { 妈妈: [recipient('mom', '李秀兰')], 王芳: [recipient('fang', '王芳'), recipient('wang', '王方')], 房东: [recipient('rent', '王建国')] }
const cards = ['8823', '4267'].map((last4) => ({ id: `card-${last4}`, remark: last4 === '8823' ? '工资卡' : '储蓄账户', kind: 'debit', status: 'active', last4, balance: 80000 }))
const reader = () => vi.fn(async (tool: string, args: Record<string, unknown>): Promise<ToolOutcome> => ({ status: 'done', data: tool === 'list_cards' ? [...cards, { ...cards[0], id: 'credit', kind: 'credit' }, { ...cards[0], id: 'locked', status: 'locked' }] : { candidates: candidates[args.query as keyof typeof candidates] ?? [] } }))
async function prepared(): Promise<BatchTransferReady> {
  const result = await prepareTransferBatch(input, request, reader())
  if (result.status !== 'batch_transfer_ready') throw new Error(result.errors.join(';'))
  return result
}

describe('多笔转账独立步骤与统一确认', () => {
  it('复现截图原话：逐笔保留金额与收款候选，共用正常储蓄卡，准备阶段只有只读查询', async () => {
    const read = reader(), result = await prepareTransferBatch(input, request, read)
    expect(result.status).toBe('batch_transfer_ready')
    if (result.status !== 'batch_transfer_ready') return
    expect(result.recipients.map((group) => [group.stepId, group.amount, group.candidates.length])).toEqual([['step-1', '400.00', 1], ['step-2', '200.00', 2], ['step-3', '600.00', 1]])
    expect(result.cards.map((card) => card.last4)).toEqual(['8823', '4267'])
    expect(read.mock.calls.map(([tool]) => tool)).toEqual(['find_payee', 'find_payee', 'find_payee', 'list_cards'])
    expect(isResolvedInteractionTemplate(result.interaction)).toBe(true)
  })
  it('收款人和金额不能互换、捏造，也不能把同一原文重复拆成两笔', async () => {
    for (const transfers of [
      [{ recipientQuery: '妈妈', amountYuan: 200 }, input.transfers[2]],
      [{ recipientQuery: '陌生人', amountYuan: 400 }, input.transfers[2]],
      [input.transfers[0], input.transfers[0]],
    ]) {
      const read = reader(), result = await prepareTransferBatch({ transfers }, request, read)
      expect(result.status).toBe('needs_information'); expect(read).not.toHaveBeenCalled()
    }
  })
  it('两笔同名收款人仍有独立步骤；明确重复两次的指令可以分别准备', async () => {
    const result = await prepareTransferBatch({ transfers: [input.transfers[0], input.transfers[0]] }, '给妈妈转400，再给妈妈转400', reader())
    expect(result.status).toBe('batch_transfer_ready')
    if (result.status === 'batch_transfer_ready') expect(result.interaction.steps?.map((step) => step.id)).toEqual(['step-1', 'step-2'])
  })
  it('三笔需求不能只准备其中两笔，也不能用同一笔的两种称呼重复创建', async () => {
    const missing = await prepareTransferBatch({ transfers: input.transfers.slice(0, 2) }, request, reader())
    expect(missing.status).toBe('needs_information')
    if (missing.status === 'needs_information') expect(missing.errors.join(';')).toMatch(/房东.*600元.*未被纳入/)
    const repeated = await prepareTransferBatch({ transfers: [{ recipientQuery: '妈妈', amountYuan: 400 }, { recipientQuery: '李秀兰', amountYuan: 400 }] }, '给妈妈李秀兰转400', reader())
    expect(repeated.status).toBe('needs_information')
  })
  it('完整多笔组件接管展示后不再显示模型重复表格或先替用户选择候选的文字', () => {
    expect(renderToStaticMarkup(createElement(AssistantText, { text: '第二笔向王芳转200元，默认使用第一张卡。', batchSelection: true }))).toBe('')
  })
  it('已有银行确认单时不再展示多笔选择组件', async () => {
    const data = await prepared()
    const value = { register: () => () => {}, groups: [], draft: new SelectionDraft(), hasChoices: false, securityConfirmation: true, confirm: () => {} }
    expect(renderToStaticMarkup(createElement(AgentChoiceContext.Provider, { value }, createElement(BatchTransferView, { data })))).toBe('')
  })
  it('找不到收款人或无可用付款卡时具体提示，不返回丢失信息的select界面', async () => {
    const missing = await prepareTransferBatch(input, request, async () => ({ status: 'done', data: { candidates: [] } }))
    expect(missing.status).toBe('needs_information')
    if (missing.status === 'needs_information') expect(missing.errors.join(';')).toMatch(/第1笔.*妈妈/)
    const read = reader()
    const noCards = await prepareTransferBatch(input, request, (tool, args) => tool === 'list_cards' ? Promise.resolve({ status: 'done', data: [] }) : read(tool, args))
    expect(noCards.status).toBe('needs_information')
    if (noCards.status === 'needs_information') expect(noCards.errors.join(';')).toContain('暂无可付款的正常储蓄卡')
  })
  it('准备消息拒绝多于两位小数和密码备注', async () => {
    expect((await prepareTransferBatch({ transfers: [{ ...input.transfers[0], amountYuan: 400.001 }, input.transfers[1]] }, request, reader())).status).toBe('needs_information')
    expect((await prepareTransferBatch({ transfers: [{ ...input.transfers[0], note: '密码123456' }, input.transfers[1]] }, `${request}，密码123456`, reader())).status).toBe('needs_information')
  })
  it('消歧草稿只修改对应笔；最终消息一次包含三笔完整信息，历史按钮可重选', async () => {
    const data = await prepared(), draft = new SelectionDraft(), base = { requests: [request], selections: [], template: data.interaction }
    const groups = data.recipients.map((group) => group.candidates.map((row) => ({ ...choiceFromRow(row, 'recipient')!, stepId: group.stepId, slot: `${group.stepId}:收款人` })))
    draft.select(groups[1][1])
    const chosen = groups.map((group) => draft.selected(group, base)!)
    expect(chosen.map((choice) => choice.label)).toEqual(['李秀兰', '王方', '王建国'])
    const card = { ...choiceFromRow(data.cards[1], 'card')!, slot: '付款卡' }
    const text = confirmationMessage(base, [...chosen, card])
    expect(text).toContain('尾号4267')
    expect(text).toMatch(/李秀兰.*400.00元/); expect(text).toMatch(/王方.*200.00元/); expect(text).toMatch(/王建国.*600.00元/)
    expect(text).not.toMatch(/办理目的及必要参数|不要创建或执行交易|装600|再给/)
    expect(text).toContain('每笔仍须在独立安全页面完成验证')
    draft.select(groups[1][0])
    const retry = confirmationMessage(base, [...groups.map((group) => draft.selected(group, base)!), card])
    expect(retry).toMatch(/王芳.*200.00元/); expect(retry).toMatch(/李秀兰.*400.00元/); expect(retry).toMatch(/王建国.*600.00元/)
    expect(retry).not.toContain('王方')
  })
  it('不能把第一笔的收款对象填到第三笔；缺选择时明确指出哪一笔', async () => {
    const data = await prepared()
    const mom = { ...choiceFromRow(data.recipients[0].candidates[0], 'recipient')!, stepId: 'step-3', slot: 'step-3:收款人' }
    const text = confirmationMessage({ requests: [], selections: [], template: data.interaction }, [mom])
    expect(text).toContain('第3笔收款人（房东）'); expect(text).toContain('不要创建或执行交易')
    expect(text).not.toMatch(/向「李秀兰.*600.00元/)
  })
  it('相同候选集用于不同步骤不会被去重吞掉', () => {
    const values = candidates.王芳.map((row) => choiceFromRow(row, 'recipient')!)
    const groups = ['step-1', 'step-2'].map((id) => ({ id, choices: values.map((choice) => ({ ...choice, slot: `${id}:收款人` })), signature: id }))
    expect(canonicalChoiceGroups(groups)).toHaveLength(2)
  })
  it('多笔模板优先于误生成的普通select元数据，并隐藏重复普通查询组件', async () => {
    const data = await prepared()
    const part = { type: 'tool-prepare_transfer_batch', state: 'output-available', toolCallId: 'batch', output: data }
    const message = { id: 'reply', role: 'assistant', parts: [part,
      { type: 'tool-find_payee', toolCallId: 'one', state: 'output-available', output: { status: 'done', data: { candidates: candidates.妈妈 } } },
      { type: 'tool-prepare_interaction', toolCallId: 'old', state: 'output-available', output: { status: 'interaction_ready', interaction: { version: '1', intent: 'select', fields: {} } } },
    ] } as WencaiUIMessage
    expect(messageInteractionTemplate(message)?.intent).toBe('batch_transfer')
    expect(toolPresentations(message.parts).slice(0, 2)).toEqual(['result', 'hidden'])
    expect(isResolvedInteractionTemplate({ ...data.interaction, steps: [data.interaction.steps![0], data.interaction.steps![0]] })).toBe(false)
  })
})

describe('口语金额与数字证据', () => {
  it('单笔裸金额按转账语境接受，手机号、卡尾号、日期仍不可当作金额', () => {
    expect(requestedAmounts('给妈妈转400再给王芳转200，尾号8823，手机号13800000000')).toEqual([400, 200])
    expect(requestedAmounts('从工资卡转500到储蓄卡A')).toEqual([500])
    expect(requestedAmounts('我选择尾号6000，手机号13800000000，10月14日')).toEqual([])
    expect(requestedAmounts('转账400.001')).toEqual([])
    expect(checkInteractionTemplate({ version: '1', intent: 'transfer', fields: { amount: { yuan: 400 } } }, {}, '给妈妈转400').ok).toBe(true)
    expect(checkInteractionTemplate({ version: '1', intent: 'transfer', fields: { amount: { yuan: 8823 } } }, {}, '用尾号8823给妈妈转400').ok).toBe(false)
  })
  it('支持转400给妈妈；不会误读妈妈卡号或从另一收款人借金额', () => {
    expect(requestedTransferMatches('转400给妈妈，再转200给房东', '妈妈', 400)).toHaveLength(1)
    expect(requestedTransferMatches('给妈妈尾号8823转400', '妈妈', 8823)).toEqual([])
    expect(requestedTransferMatches(request, '妈妈', 600)).toEqual([])
  })
  it('仅服务端核对过的批次提供金额证据，仍拦截编造金额/卡号和未执行的成功声明', async () => {
    const evidence = [await prepared()]
    expect(checkedResponse('请先选择付款卡，再核对给妈妈的400元转账。', evidence, false, false).blocked).toBe(false)
    expect(checkedResponse('400元转账已成功。', evidence, false, false).blocked).toBe(true)
    expect(checkedResponse('使用尾号9999的卡转400元。', evidence, false, false).blocked).toBe(true)
    expect(checkedResponse('余额为9999元。', evidence, false, false).blocked).toBe(true)
    expect(renderInteractionTemplate({ version: '1', intent: 'select', fields: {} })).toContain('办理目的及必要参数')
  })
})
