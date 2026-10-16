import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { UIProvider } from '#/components/ui/provider'
import { AgentInteractionContext, AgentSelectableTable } from '#/components/chat/AgentInteraction'
import { AgentCardDisplay } from '#/components/chat/AgentCardDisplay'
import { AgentQuestionnaire } from '#/components/chat/AgentQuestionnaire'
import ToolPart from '#/components/chat/ToolPart'
import AssistantText, { cleanAssistantMarkdown } from '#/components/chat/AssistantText'
import { choiceFromRow } from '#/components/chat/interaction-message'
import { displayPurpose } from '#/components/chat/display-purpose'
import { QuestionnaireSchema, RISK_QUESTIONNAIRE, questionnaireMessage } from '#/lib/questionnaire'
import { checkSpec } from '#/server/genui/validate'
import { toolPresentations } from '#/components/chat/presentation'
import type { WencaiUIMessage } from '#/server/agent/messages'

const cards = [{id:'card-a',remark:'工资卡',last4:'8823',kind:'debit',status:'active',balance:60068.2},{id:'card-b',remark:'生活卡',last4:'4267',kind:'debit',status:'locked',balance:1234.5}]
function render(component: React.ReactElement, request='查询账户余额') {
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}})
  return renderToStaticMarkup(createElement(QueryClientProvider,{client},createElement(UIProvider,{children:createElement(AgentInteractionContext.Provider,{value:{send:()=>true,busy:false,enabled:true,snapshot:{requests:[request],selections:[]}}},component)})))
}
const part=(tool:string,data:unknown)=>({type:`tool-${tool}` as const,toolCallId:tool,state:'output-available' as const,output:{status:'done',data}})
describe('只读展示与业务选择分离',()=>{
  it('银行卡只读区可展示全部或指定单卡，完全没有按钮与确认文案',()=>{
    const choices=cards.map(c=>choiceFromRow(c,'card')!)
    const all=render(createElement(AgentCardDisplay,{choices}))
    expect(all).toContain('60,068.20'); expect(all).toContain('已锁定'); expect(all).toContain('4267')
    expect(all).not.toContain('<button'); expect(all).not.toContain('待确认'); expect(all).not.toContain('完整卡号')
    const one=render(createElement(AgentCardDisplay,{choices,cardIds:['card-b']}))
    expect(one).toContain('4267'); expect(one).not.toContain('8823'); expect(one).not.toContain('左右滑动浏览')
  })
  it('同一工具在查询时只读，在转账选择时才显示确认',()=>{
    const query=render(createElement(ToolPart,{part:part('list_cards',cards)}))
    const choose=render(createElement(ToolPart,{part:part('list_cards',cards)}),'给妈妈转账200元，请选择付款卡')
    expect(query).not.toContain('待确认'); expect(query).not.toContain('<button')
    expect(choose).toContain('确认'); expect(choose).toContain('取消')
    const account=part('get_accounts',[{id:'cash',name:'资金账户',balance:123.45}])
    expect(render(createElement(ToolPart,{part:account}))).not.toContain('<button')
    expect(render(createElement(ToolPart,{part:account}),'转账200元，选择付款账户')).toContain('选择资金账户')
  })
  it('风险测评优先于遗留产品选择意图，理财查询不显示操作列',()=>{
    expect(displayPurpose({requests:['查询银行卡余额，不需要选择或确认'],selections:[]})).toBe('query')
    expect(displayPurpose({requests:['给妈妈转200'],selections:[]})).toBe('selection')
    expect(displayPurpose({requests:['重新风险评定'],selections:[],template:{version:'1',intent:'select',fields:{}}})).toBe('assessment')
    const rows=[{id:'p1',name:'活期宝A',riskRating:'R1',expectedYieldPct:1.65,minAmount:1,termDays:0}]
    const query=render(createElement(ToolPart,{part:part('list_products',rows)}),'看看理财产品信息')
    expect(query).toContain('<table'); expect(query).not.toContain('选择'); expect(query).not.toContain('操作</th>')
    const assessment=render(createElement(ToolPart,{part:part('list_products',rows)}),'重新风险评定')
    expect(assessment).not.toContain('<table'); expect(assessment).not.toContain('<button')
    expect(render(createElement(AgentSelectableTable,{rows,columns:[{key:'name',label:'产品'}],selectable:false}))).not.toContain('<button')
  })
  it('显式展示一张卡不会被前面全部银行卡查询覆盖',()=>{
    const modes=toolPresentations([part('list_cards',cards),part('display_bank_cards',[cards[1]])] as unknown as WencaiUIMessage['parts'])
    expect(modes).toEqual(['status','result'])
  })
  it('生成式只读卡片只能筛选真实数据中已有的卡',()=>{
    const make=(cardIds:string[])=>({root:'c',elements:{c:{type:'CardDisplay',props:{title:'银行卡信息',data:{$state:'/list_cards'},cardIds}}}})
    expect(checkSpec(make(['card-b']),{list_cards:cards}).ok).toBe(true)
    expect(checkSpec(make(['foreign-card']),{list_cards:cards}).ok).toBe(false)
  })
})
describe('可复用逐题问卷',()=>{
  it('标准问卷显示首题及下一题，不提前展示提交或理财选择',()=>{
    const html=render(createElement(AgentQuestionnaire,{data:RISK_QUESTIONNAIRE}),'重新风险测评')
    expect(html).toContain('你的投资经验如何'); expect(html).toContain('下一题'); expect(html).toContain('上一题')
    expect(html.match(/type="radio"/g)).toHaveLength(5); expect(html).not.toContain('提交答案'); expect(html).not.toContain('理财可选方案')
  })
  it('问卷必须全部答完且选项有效，最后才生成完整消息',()=>{
    expect(()=>questionnaireMessage(RISK_QUESTIONNAIRE,{'risk-1':'option-1'})).toThrow('完成全部题目')
    const answers=Object.fromEntries(RISK_QUESTIONNAIRE.questions.map((q,i)=>[q.id,`option-${i+1}`]))
    const message=questionnaireMessage(RISK_QUESTIONNAIRE,answers)
    expect(message).toContain('风险测评答案：[1, 2, 3, 4, 5]'); expect(message).toContain('收入稳定性'); expect(message).toContain('先试算'); expect(message).toContain('不代表已登记')
    expect(()=>questionnaireMessage(RISK_QUESTIONNAIRE,{...answers,'risk-3':'not-an-option'})).toThrow()
  })
  it('通用问卷支持任意合理题数，并在消息中保留题干和已选答案',()=>{
    const form={id:'delivery',title:'送礼偏好',purpose:'general' as const,questions:[{id:'timing',title:'希望何时收到礼物？',options:[{id:'now',label:'尽快送达',value:'immediate'},{id:'later',label:'生日当天送达',value:'birthday'}]}]}
    expect(QuestionnaireSchema.safeParse(form).success).toBe(true)
    const message=questionnaireMessage(form,{timing:'later'})
    expect(message).toContain('希望何时收到礼物'); expect(message).toContain('生日当天送达'); expect(message).toContain('仍须生成确认单')
  })
  it('拒绝重复题号、重复选项、秘密凭据问题及篡改的风险问卷',()=>{
    const bad=structuredClone(RISK_QUESTIONNAIRE); bad.questions[0].options[0].label='经验丰富，应选高风险'
    expect(QuestionnaireSchema.safeParse(bad).success).toBe(false)
    const duplicate=structuredClone(RISK_QUESTIONNAIRE); duplicate.questions[1].id=duplicate.questions[0].id
    expect(QuestionnaireSchema.safeParse(duplicate).success).toBe(false)
    const secret=structuredClone(RISK_QUESTIONNAIRE); secret.purpose='general'; secret.questions[0].title='请输入交易密码'
    expect(QuestionnaireSchema.safeParse(secret).success).toBe(false)
  })
})
describe('中文 Markdown 强调',()=>{
  it('中文标点旁的金额、结论能正确加粗，完成后无多余星号',()=>{
    const html=render(createElement(AssistantText,{text:'余额：**¥60,068.20。**请核对，风险等级为**R5（进取型）**。'}))
    expect(html).toContain('<strong'); expect(html).not.toContain('**'); expect(html).toContain('60,068.20')
    expect(cleanAssistantMarkdown('需要我继续吗？ **')).toBe('需要我继续吗？')
  })
  it('保留脱敏卡号、正常粗体与代码中的星号',()=>{
    const value='收款卡：6222 **** 2233，**已完成**。'
    expect(cleanAssistantMarkdown(value)).toBe(value)
    expect(cleanAssistantMarkdown('```\n需要继续吗？ **')).toBe('```\n需要继续吗？ **')
  })
})
