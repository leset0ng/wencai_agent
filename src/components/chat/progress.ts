type Part = { type: string; state?: string; toolCallId?: string; output?: unknown }
type Message = { id: string; role: string; parts: readonly unknown[] }
export type AgentStage = { key: string; title: string; description: string }

const stages: Record<string, [string, string]> = {
  get_accounts: ['正在查询账户余额', '正在读取你的账户与可用余额…'],
  list_cards: ['正在查询银行卡', '正在读取卡片状态、备注和账户信息…'],
  resolve_my_cards: ['正在查找对应银行卡', '正在核对卡片备注和尾号…'],
  list_transactions: ['正在查询交易记录', '正在按查询条件读取真实银行流水…'],
  get_spending_report: ['正在汇总支出分类', '正在整理指定账期的交易分类数据…'],
  analyze_spending: ['正在分析账单', '正在计算消费分类和收支情况…'],
  detect_anomalies: ['正在检查异常交易', '正在核对交易特征与历史记录…'],
  show_view: ['正在生成结果视图', '正在将已查询的数据整理成清晰的图表与明细…'],
  find_payee: ['正在查找收款人', '正在核对已登记的收款人信息…'],
  search_bank_accounts: ['正在核对收款账户', '正在匹配账号、户名或手机号…'],
  prepare_transfer_batch: ['正在整理多笔转账', '正在逐笔核对收款人、金额和可用付款卡…'],
  prepare_interaction: ['正在准备交互选项', '正在整理本次办理需要核对的内容…'],
  preview_transfer: ['正在核对转账信息', '正在核对付款账户、收款人和金额…'],
  transfer: ['正在准备转账确认单', '正在核对转账条件，尚未执行转账…'],
  commit_transfer: ['正在准备转账确认单', '正在核对转账条件，尚未执行转账…'],
  transfer_between_cards: ['正在准备卡间转账', '正在核对转出卡、转入卡和金额，尚未执行…'],
  transfer_between_accounts: ['正在准备账户互转', '正在核对两端账户和金额，尚未执行…'],
  pay_split_request: ['正在准备 AA 付款', '正在核对付款请求，尚未执行付款…'],
  list_products: ['正在查询理财产品', '正在读取产品期限、风险等级和起购信息…'],
  get_recommendations: ['正在匹配理财方案', '正在结合风险评估筛选适合的产品…'],
  list_subscriptions: ['正在查询订阅与代扣', '正在读取已登记的订阅和扣费信息…'],
  detect_subscriptions: ['正在识别订阅扣费', '正在检查真实流水中的周期性扣费…'],
  plan_task: ['正在安排业务步骤', '正在整理任务依赖和需要本人确认的步骤…'],
}

/** Only actual stream/tool state advances the card; no timers or invented execution progress. */
export function agentStage(messages: readonly Message[], busy: boolean): AgentStage | null {
  if (!busy) return null
  const latest = messages.at(-1)
  const tools = latest?.role === 'assistant' ? (latest.parts as readonly Part[]).filter((part) => part.type.startsWith('tool-')) : []
  const running = tools.filter((part) => ['input-streaming', 'input-available'].includes(part.state ?? '')).at(-1)
  if (running) {
    const [title, description] = stages[running.type.slice(5)] ?? ['正在处理银行业务', '正在核对本次业务所需的信息…']
    return {key:running.toolCallId ?? running.type,title,description}
  }
  const last = tools.at(-1)
  if (last) {
    const status = (last.output as {status?:string} | undefined)?.status
    if (['needs_confirmation','needs_handoff','plan'].includes(status ?? '')) return {key:`${last.toolCallId}:confirmation`,title:'正在整理确认信息',description:'请以银行确认单为准，敏感操作须由你本人确认。'}
    if (last.state === 'output-error' || ['error','denied','invalid_view','invalid_plan'].includes(status ?? '')) return {key:`${last.toolCallId}:review`,title:'正在整理处理情况',description:'正在汇总已返回的结果和需要说明的问题…'}
    return {key:`${last.toolCallId}:result`,title:'正在整理查询结果',description:'正在核对已返回的数据并准备回复…'}
  }
  return {key:'understanding',title:'正在理解你的需求',description:'正在确认办理意图和需要查询的信息…'}
}

/** Confirmation cards, errors and denials must remain visible during processing. */
export function progressOnlyTool(part: {type:string}, processing: boolean, presentation: string): boolean {
  if (!part.type.startsWith('tool-')) return false
  const tool = part as Part
  const status = (tool.output as {status?:string} | undefined)?.status
  if (tool.state === 'output-error' || ['needs_confirmation','needs_handoff','plan','error','denied'].includes(status ?? '')) return false
  if (presentation === 'hidden' || part.type === 'tool-prepare_interaction') return true
  if (!processing) return presentation === 'status'
  if (['input-streaming','input-available'].includes(tool.state ?? '')) return true
  return status === 'done' || status === 'view' || (presentation === 'status' && tool.state !== 'output-error')
}
