import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentCardPicker, AgentChoiceList, AgentSelectableTable, AgentChoiceContext } from '#/components/chat/AgentInteraction'
import AssistantText from '#/components/chat/AssistantText'
import { choiceFromRow, choiceMessage, followUpMessage, interactionSnapshot, InteractionMemory, operationMessage, SelectionDraft, confirmationMessage, type AgentChoice } from '#/components/chat/interaction-message'
import { selectionView } from '#/components/chat/interaction-layout'
import { canonicalChoiceGroups } from '#/components/chat/selection-groups'
import type { WencaiUIMessage } from '#/server/agent/messages'
import { checkSpec } from '#/server/genui/validate'
import { presentedTables, duplicatesTable } from '#/components/chat/AssistantText'
import { toolPresentations } from '#/components/chat/presentation'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { UIProvider } from '#/components/ui/provider'
import ConfirmCard from '#/components/chat/ConfirmCard'

const user = (text: string) => ({ id: text, role: 'user', parts: [{ type: 'text', text }] }) as WencaiUIMessage
const assistant = (text = '请选择付款银行卡') => ({ id: 'assistant', role: 'assistant', parts: [{ type: 'text', text }] }) as WencaiUIMessage
const card = (tail = '8823'): AgentChoice => ({ id: `card_${tail}`, kind: 'card', label: '工资卡', slot: '付款卡', details: [{ label: '尾号', value: tail }], card: { cardId: `card_${tail}`, name: '工资卡', last4: tail, kind: 'debit', balance: 5000 } })
const initial = [user('给妈妈李秀兰转账500元，从工资卡扣款'), assistant()]
const products = [{ id: 'p_cash', name: '活期宝A', riskRating: 'R1', expectedYieldPct: 1.65, minAmount: 1, termDays: 0 }]

describe('可复用 Agent 消息交互', () => {
  it('同角色的全部卡和可付款卡合并，只有可见轮播的当前卡参与确认；收款角色单独保留', () => {
    const a=card('1111'), b=card('2222'), c=card('3333')
    const groups=[{id:'all',signature:'all',choices:[a,b,c],currentChoice:a},{id:'eligible',signature:'eligible',choices:[a,b],currentChoice:b},{id:'target',signature:'target',choices:[{...c,slot:'收款卡'}],currentChoice:{...c,slot:'收款卡'}}]
    const result=canonicalChoiceGroups(groups)
    expect(result.map(group=>group.id)).toEqual(['eligible','target'])
    expect(result[0].currentChoice?.card?.last4).toBe('2222')
    expect(result[0].choices).toHaveLength(2)
    expect(canonicalChoiceGroups([{...groups[0],choices:[a]},{...groups[1],choices:[b]}])[0].choices).toEqual([a,b])
  })
  it('真实组件已接管展示时隐藏重复数字兜底，其他错误与无组件的提示仍保留', () => {
    const text = '部分内容未通过银行数据核对，已停止展示。请以已显示的账户数据和操作卡片为准。'
    const value = { register:()=>()=>{}, groups:[], draft:new SelectionDraft(), hasChoices:true, securityConfirmation:false, confirm:()=>{} }
    expect(renderToStaticMarkup(createElement(AgentChoiceContext.Provider,{value},createElement(AssistantText,{text})))).toBe('')
    expect(renderToStaticMarkup(createElement(AssistantText,{text}))).toContain('未通过银行数据核对')
    expect(renderToStaticMarkup(createElement(AgentChoiceContext.Provider,{value},createElement(AssistantText,{text:'银行业务失败，请重试'})))).toContain('银行业务失败')
  })
  it('已有有效选卡区时不再展示其他空查询的无卡提示，真正无卡仍提示', () => {
    const value = { register:()=>()=>{}, groups:[{id:'other',signature:'cards',choices:[card()]}], draft:new SelectionDraft(), hasChoices:true, securityConfirmation:false, confirm:()=>{} }
    expect(renderToStaticMarkup(createElement(AgentChoiceContext.Provider,{value},createElement(AgentCardPicker,{choices:[]})))).toBe('')
    expect(renderToStaticMarkup(createElement(AgentCardPicker,{choices:[]}))).toContain('暂无可选银行卡')
  })
  it('选择只保存本地草稿，统一确认包含付款卡、收款人、金额和原始目的', () => {
    const base = interactionSnapshot(initial, 1), draft = new SelectionDraft()
    const recipient = choiceFromRow({ id: 'mom', name: '李秀兰', bank: '工商银行', account: '6222 **** 2233' }, 'recipient')!
    draft.select(card('8823')); draft.select(recipient)
    expect(base.selections).toEqual([])
    const current = draft.snapshot(base, [draft.selected([card('8823'),card('4267')],base)!, draft.selected([recipient],base)!])
    const text = confirmationMessage(current, [])
    expect(text).toContain('8823'); expect(text).toContain('李秀兰'); expect(text).toContain('500元'); expect(text).toContain('工商银行')
    expect(text).toContain('交易仍须独立安全验证')
    expect(interactionSnapshot([user(text),assistant()],1).selections).toHaveLength(2)
  })
  it('唯一对象自动确定；多对象可重选或取消草稿而不丢失其他条件', () => {
    const draft = new SelectionDraft(), base = {requests:['转500元'],selections:[]}
    const product = choiceFromRow(products[0])!
    expect(draft.selected([product], base)).toEqual(product)
    expect(draft.selected([card('1111'),card('2222')],base)).toBeUndefined()
    draft.select(card('1111')); draft.select(card('2222'))
    expect(draft.selected([card('1111'),card('2222')],base)?.card?.last4).toBe('2222')
    draft.clear('付款卡')
    expect(draft.selected([card('1111'),card('2222')],base)).toBeUndefined()
    draft.clear(product.slot!)
    expect(draft.selected([product],base)).toEqual(product)
  })
  it('选择视图清理重复付款入口及空外框，已有银行确认时移除选择组件', () => {
    const view = {root:'p',elements:{p:{type:'Panel',children:['cards','extra']},cards:{type:'CardPicker',props:{data:{$state:'/list_cards'}}},extra:{type:'Panel',children:['follow']},follow:{type:'FollowUp',props:{prompt:'用工资卡付款'}}}}
    const cleaned=selectionView(view)!
    expect(cleaned.elements[cleaned.root].type).toBe('CardPicker')
    expect(Object.values(cleaned.elements).some((node)=>node.type==='FollowUp')).toBe(false)
    expect(selectionView(view,true,true)).toBeNull()
    expect(view.elements.p.children).toEqual(['cards','extra'])
    const standalone={root:'confirm',elements:{confirm:{type:'Confirm',props:{prompt:'开始风险测评'}}}}
    expect(selectionView(standalone)).toEqual(standalone)
  })
  it('确认卡结束后仍保留核对与重新办理按钮', () => {
    for (const state of ['success', 'cancelled', 'failed'] as const) {
      const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(UIProvider, { children: createElement(ConfirmCard, {
        actionId: 'old-action', level: 'yellow', reasons: [], summary: { title: '确认转账', fields: [{ label: '金额', value: '¥500.00' }] }, done: '操作已结束', doneState: state, onAgentAction: () => true,
      }) })))
      expect(html).toContain('重新办理'); expect(html).toContain('核对结果'); expect(html).toContain('¥500.00')
    }
  })
  it('新的查询任务独立隔离，相同文字重发也绑定最近一次任务', () => {
    const first = { ...user('帮我列出银行卡'), id: 'first' }, second = { ...user('帮我列出银行卡'), id: 'second' }
    const latest = interactionSnapshot([first, assistant(), second, assistant()], 3)
    expect(latest.taskKey).toBe('second')
    const generated = choiceMessage(card(), latest)
    expect(interactionSnapshot([first, second, user(generated), assistant()], 3).taskKey).toBe('second')
    const query = interactionSnapshot([...initial, user('帮我分析本月账单'), assistant()], 3)
    expect(query.requests).toEqual(['帮我分析本月账单'])
  })
  it('重选同类产品替换旧选择，保留付款卡与金额', () => {
    const memory = new InteractionMemory(), base = interactionSnapshot(initial, 1)
    memory.afterChoice(base, card())
    memory.afterChoice(base, choiceFromRow(products[0])!)
    const text = memory.afterChoice(base, choiceFromRow({ ...products[0], id: 'p_new', name: '新方案' })!)
    expect(text).not.toContain('活期宝A'); expect(text).toContain('新方案'); expect(text).toContain('8823'); expect(text).toContain('500元')
  })
  it('同一旧回复的产品按钮会带上后来刚选的卡，不混入另一任务的选择', () => {
    const base = interactionSnapshot(initial, 1), memory = new InteractionMemory()
    memory.remember(base)
    memory.afterChoice(base, card('8823'))
    const other = { taskKey: 'another-task', requests: ['给王建国转900元'], selections: [] }
    memory.remember(other); memory.afterChoice(other, card('7777'))
    const text = memory.afterChoice(base, choiceFromRow(products[0])!)
    expect(text).toContain('8823'); expect(text).toContain('活期宝A'); expect(text).toContain('500元')
    expect(text).not.toMatch(/7777|王建国|900元/)
  })
  it('卡片选择消息独立包含尾号、用途、原目标与金额，不依赖之前的对话', () => {
    const context = interactionSnapshot(initial, 1), text = choiceMessage(card(), context)
    expect(context.cardRole).toBe('source')
    expect(text).toContain('我选择尾号8823')
    expect(text).toContain('作为付款卡')
    expect(text).toContain('妈妈李秀兰转账500元')
    expect(text).toContain('选择不代表交易验证通过')
  })
  it('旧按钮使用它所属的需求快照，不混入后面另一笔操作', () => {
    const text = choiceMessage(card(), interactionSnapshot([...initial, user('给王建国转900元')], 1))
    expect(text).toContain('李秀兰转账500元')
    expect(text).not.toContain('王建国')
  })
  it('反复点击不消费、不改变原始快照，消息保持完整', () => {
    const context = interactionSnapshot(initial, 1), saved = structuredClone(context)
    const first = choiceMessage(card(), context)
    expect(choiceMessage(card(), context)).toBe(first)
    expect(context).toEqual(saved)
  })
  it('重选付款卡覆盖旧付款条件，同时保留已选收款卡与原金额', () => {
    const context = { requests: ['从付款卡向收款卡转500元'], selections: ['付款卡：尾号1111的银行卡', '收款卡：尾号2222的银行卡'] }
    const text = choiceMessage(card('3333'), context)
    expect(text).not.toContain('1111')
    expect(text).toContain('2222')
    expect(text).toContain('3333')
    expect(text).toContain('500元')
  })
  it('连续选择产品与卡片后仍携带原始任务，格式不会递归膨胀', () => {
    const product = choiceFromRow(products[0])!
    const a = choiceMessage(product, interactionSnapshot(initial, 1))
    const b = choiceMessage(card(), interactionSnapshot([...initial, user(a), assistant()], 3))
    expect(b.match(/给妈妈李秀兰转账500元/g)).toHaveLength(1)
    expect(b).toContain('活期宝A')
    expect(b).toContain('1.65%')
    expect(b).toContain('8823')
  })
  it('追问、取消、核对消息都包含完整办理参数，而不是“用这个”', () => {
    const context = interactionSnapshot(initial, 1)
    expect(followUpMessage('继续分析所选方案', context)).toContain('500元')
    expect(choiceMessage(card(), context, true)).toContain('请先不要执行')
    const summary = { title: '确认转账', fields: [{ label: '金额', value: '¥500.00' }, { label: '付款卡', value: '工资卡尾号8823' }, { label: '收款人', value: '李秀兰' }] }
    for (const action of ['verify', 'cancel', 'repeat', 'receipt'] as const) {
      const text = operationMessage(summary, context, action)
      expect(text).toContain('¥500.00'); expect(text).toContain('李秀兰'); expect(text).toContain('尾号8823')
    }
  })
  it('不把误发的验证码或密码复制到后续按钮消息', () => {
    const context = interactionSnapshot([...initial, user('123456'), user('密码：987654'), assistant()], 4)
    const text = choiceMessage(card(), context)
    expect(text).not.toMatch(/123456|987654/)
  })
  it('新增类型可直接复用选择表格与列表，不需要专用点击函数', () => {
    const rows = [{ id: 'future-service', name: '未来服务方案', cycle: '每月', budget: 80 }]
    const choice = choiceFromRow(rows[0])!
    expect(choice.kind).toBe('option')
    expect(choiceMessage(choice, { requests: ['帮我安排每月服务'], selections: [] })).toContain('budget：80')
    const html = renderToStaticMarkup(createElement(AgentSelectableTable, { rows, columns: [{ key: 'name', label: '方案' }] }))
    expect(html).toContain('aria-label="已选择未来服务方案"')
    expect(renderToStaticMarkup(createElement(AgentChoiceList, { choices: [choice] }))).toContain('已确定')
  })
  it('银行卡共用账户区域的轮播基础，按钮保留且只展示一个当前卡页', () => {
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(UIProvider, { children: createElement(AgentCardPicker, { choices: [card('1111'), card('2222'), card('3333')] }) })))
    expect(html).toContain('data-slot="carousel"')
    expect(html).toContain('左右滑动切换银行卡')
    expect(html).not.toContain('aria-label="选择"')
    expect(html).toContain('aria-label="确认"')
    expect(html).toContain('aria-label="取消"')
    expect(html.match(/aria-current="true"/g)).toHaveLength(1)
  })
  it('生成式选择组件只能引用真实数据，不能注入伪造卡片', () => {
    const spec = (data: unknown) => ({ root: 'cards', elements: { cards: { type: 'CardPicker', props: { title: '选择付款卡', data, role: 'source' }, children: [] } } })
    expect(checkSpec(spec({ $state: '/list_cards' }), { list_cards: [{ id: 'c', last4: '8823' }] }).ok).toBe(true)
    expect(checkSpec(spec([{ id: 'fake', balance: 99999 }]), {}).ok).toBe(false)
  })
  it('推荐结果、生成式表格与正文产品表格不重复展示，选择入口保留', () => {
    const part = { type: 'tool-get_recommendations', toolCallId: 'products', state: 'output-available', output: { status: 'done', data: { products } } } as unknown as WencaiUIMessage['parts'][number]
    const tables = presentedTables([part], ['result'])
    expect(tables).toHaveLength(1)
    expect(duplicatesTable({ headers: ['产品', '风险', '预期年化', '起购', '期限'], rows: [['活期宝A', 'R1', '1.65%', '1元', '随时可取']] }, tables[0])).toBe(true)
    expect(toolPresentations([part], true)).toEqual(['status'])
  })
})
