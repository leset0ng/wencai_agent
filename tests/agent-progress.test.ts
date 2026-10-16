import { describe, expect, it } from 'vitest'
import { agentStage, progressOnlyTool } from '#/components/chat/progress'
const assistant=(parts:unknown[])=>[{id:'a',role:'assistant',parts}]
const tool=(name:string,state='input-available',status?:string)=>({type:`tool-${name}`,toolCallId:`call-${name}`,state,output:status?{status}:undefined})
describe('Agent 真实步骤状态卡',()=>{
  it('请求开始即显示状态，结束、停止和失败后不再转圈',()=>{
    expect(agentStage([{id:'u',role:'user',parts:[]}],true)?.key).toBe('understanding')
    expect(agentStage(assistant([tool('list_transactions')]),false)).toBeNull()
  })
  it('使用真实工具阶段，切换工具产生不同动画标识',()=>{
    const first=agentStage(assistant([tool('get_spending_report')]),true)!
    const next=agentStage(assistant([tool('get_spending_report','output-available','done'),tool('show_view')]),true)!
    expect(first.title).toBe('正在汇总支出分类')
    expect(next.title).toBe('正在生成结果视图')
    expect(next.key).not.toBe(first.key)
    expect(agentStage(assistant([tool('show_view','output-available','view')]),true)?.title).toBe('正在整理查询结果')
  })
  it('新请求不会继续使用上一次回答的工具进度',()=>{
    expect(agentStage([...assistant([tool('transfer')]),{id:'new',role:'user',parts:[]}],true)?.key).toBe('understanding')
  })
  it('并行工具优先显示仍在处理的步骤',()=>{
    expect(agentStage(assistant([tool('list_transactions'),tool('list_cards','output-available','done')]),true)?.key).toBe('call-list_transactions')
  })
  it('转账和待确认只显示准备/核对，不宣称已经执行',()=>{
    expect(agentStage(assistant([tool('transfer')]),true)?.description).toContain('尚未执行')
    expect(agentStage(assistant([tool('transfer','output-available','needs_confirmation')]),true)?.description).toContain('须由你本人确认')
  })
  it('进度卡替代中间状态，保留确认单、拒绝和错误',()=>{
    expect(progressOnlyTool(tool('list_transactions'),true,'result')).toBe(true)
    expect(progressOnlyTool(tool('get_spending_report','output-available','done'),true,'status')).toBe(true)
    expect(progressOnlyTool(tool('show_view','output-available','view'),true,'status')).toBe(true)
    expect(progressOnlyTool(tool('show_view','output-available','view'),false,'result')).toBe(false)
    for(const status of ['needs_confirmation','needs_handoff','plan','error','denied']) expect(progressOnlyTool(tool('transfer','output-available',status),true,'status')).toBe(false)
    expect(progressOnlyTool(tool('list_transactions','output-error'),true,'status')).toBe(false)
  })
})
