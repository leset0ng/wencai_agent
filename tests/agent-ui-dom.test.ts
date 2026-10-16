// @vitest-environment jsdom
import { createElement, type ReactElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { UIProvider } from '#/components/ui/provider'
import ConfirmCard from '#/components/chat/ConfirmCard'
import { AgentInteractionContext } from '#/components/chat/AgentInteraction'
import { AgentQuestionnaire } from '#/components/chat/AgentQuestionnaire'
import { RISK_QUESTIONNAIRE } from '#/lib/questionnaire'

const { openSecure } = vi.hoisted(() => ({ openSecure: vi.fn() }))
vi.mock('#/components/ui/SecureOperation', async original => ({ ...await original<typeof import('#/components/ui/SecureOperation')>(), useSecureOperation: () => openSecure }))
beforeAll(() => {
  window.matchMedia = vi.fn().mockImplementation(query => ({ matches: query.includes('reduced-motion'), media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }))
})
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(c => c.clear()); vi.clearAllMocks() })
function provider(child: ReactElement, client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })) {
  clients.push(client)
  return createElement(QueryClientProvider, { client }, createElement(UIProvider, { children: child }))
}
function questionnaire(send=vi.fn((_text: string)=>true)) {
  return { send, child: createElement(AgentInteractionContext.Provider, { value: { send, busy: false, enabled: true, snapshot: { requests: ['重新风险测评'], selections: [] } } }, createElement(AgentQuestionnaire, { data: RISK_QUESTIONNAIRE })) }
}
describe('确认单完成状态回归',()=>{
  it('真实安全页返回成功后，即使父层仍传failed或旧错误，也显示已完成并保留历史按钮',async()=>{
    openSecure.mockResolvedValue({ok:true,output:{transactionId:'tx-test'}})
    const action=vi.fn(()=>true), completed=vi.fn(), client=new QueryClient()
    const props={actionId:'test-action',level:'yellow' as const,reasons:[],summary:{title:'确认转账',fields:[{label:'金额',value:'¥200.00'}]},doneState:'failed' as const,onAgentAction:action,onCompleted:completed}
    const view=render(provider(createElement(ConfirmCard,props),client))
    fireEvent.click(screen.getByRole('button',{name:/^确认$/}))
    await waitFor(()=>expect(screen.getByText('已完成',{exact:true})).toBeTruthy())
    expect(openSecure).toHaveBeenCalledWith({purpose:'confirm_action',actionId:'test-action'})
    expect(view.container.querySelector('.bank-confirm-card.is-success')).toBeTruthy()
    expect(completed).toHaveBeenCalledTimes(1)
    view.rerender(provider(createElement(ConfirmCard,{...props,done:'执行未完成，可重新办理',error:'操作已完成'}),client))
    expect(screen.queryByText('未完成',{exact:true})).toBeNull()
    expect(screen.queryByText('执行未完成，可重新办理')).toBeNull()
    expect(screen.getByRole('button',{name:'重新办理'})).toBeTruthy()
    expect(screen.getByRole('button',{name:'核对结果'})).toBeTruthy()
    expect(action).toHaveBeenCalledWith('verify')
  })
  it('关闭验证页不会把确认单变成成功或丢失确认按钮',async()=>{
    openSecure.mockResolvedValue({cancelled:true})
    const view=render(provider(createElement(ConfirmCard,{actionId:'cancel-test',level:'yellow',reasons:[],summary:{title:'确认购买',fields:[]},doneState:'failed'})))
    fireEvent.click(screen.getByRole('button',{name:/^确认$/}))
    await waitFor(()=>expect((screen.getByRole('button',{name:/^确认$/}) as HTMLButtonElement).disabled).toBe(false))
    expect(view.container.querySelector('.bank-confirm-card.is-pending')).toBeTruthy()
    expect(screen.queryByText('已完成',{exact:true})).toBeNull()
  })
})
describe('逐题问卷交互',()=>{
  it('五题逐一切换、返回保留答案；仅最终提交发送一条完整消息，按钮仍保留',async()=>{
    const form=questionnaire(); render(provider(form.child))
    expect((screen.getByRole('button',{name:'下一题'}) as HTMLButtonElement).disabled).toBe(true)
    for(let i=0;i<5;i++) {
      await screen.findByText(RISK_QUESTIONNAIRE.questions[i].title)
      fireEvent.click(screen.getAllByRole('radio')[i])
      expect(form.send).not.toHaveBeenCalled()
      if(i<4)fireEvent.click(screen.getByRole('button',{name:'下一题'}))
    }
    fireEvent.click(screen.getByRole('button',{name:'上一题'}))
    await screen.findByText(RISK_QUESTIONNAIRE.questions[3].title)
    expect((screen.getAllByRole('radio')[3] as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('button',{name:'下一题'}))
    await screen.findByText(RISK_QUESTIONNAIRE.questions[4].title)
    fireEvent.click(screen.getByRole('button',{name:'提交答案'}))
    expect(form.send).toHaveBeenCalledTimes(1)
    expect(form.send.mock.calls[0][0]).toContain('风险测评答案：[1, 2, 3, 4, 5]')
    expect(form.send.mock.calls[0][0]).toContain('收入稳定性')
    expect(screen.getByRole('button',{name:'提交答案'})).toBeTruthy()
    fireEvent.click(screen.getAllByRole('radio')[1])
    fireEvent.click(screen.getByRole('button',{name:'提交答案'}))
    expect(form.send).toHaveBeenCalledTimes(2)
    expect(form.send.mock.calls[1][0]).toContain('[1, 2, 3, 4, 2]')
  })
  it('不同历史问卷的单选项互不干扰',()=>{
    const first=questionnaire(),second=questionnaire()
    render(provider(createElement('div',{},first.child,second.child)))
    const forms=screen.getAllByRole('region',{name:'投资风险测评'})
    const a=within(forms[0]).getAllByRole('radio')[0] as HTMLInputElement,b=within(forms[1]).getAllByRole('radio')[1] as HTMLInputElement
    fireEvent.click(a);fireEvent.click(b)
    expect(a.checked).toBe(true);expect(b.checked).toBe(true)
    expect(a.name).not.toBe(b.name)
  })
})
