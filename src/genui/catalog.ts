import { defineCatalog } from '@json-render/core'
import { schema } from '@json-render/react/schema'
import { z } from 'zod'
import { interactionTemplatePrompt, type ResolvedInteractionTemplate } from '#/lib/agent-interaction-template'

/**
 * 展示类生成式 UI 的组件目录（见 ARCHITECTURE.md §6）。
 * 约束：所有数据型 props 只接受 { $state: "/路径" } 引用，不接受字面量——
 * 数据由服务端从工具结果注入，模型只决定"怎么展示"，无法编造数字。
 */
const DataRef = z.object({ $state: z.string().regex(/^\/[\w/-]+$/) }).strict()

export const catalog = defineCatalog(schema, {
  components: {
    Panel: {
      props: z.object({ title: z.string().max(30), subtitle: z.string().max(60).nullable() }),
      description: '卡片容器，可包含子元素',
    },
    Metric: {
      props: z.object({ label: z.string().max(20), value: DataRef, unit: z.enum(['元', '%', '笔', '天']).nullable() }),
      description: '单个指标，如本月总支出',
    },
    BarChart: {
      props: z.object({ title: z.string().max(30), data: DataRef, labelKey: z.string(), valueKey: z.string() }),
      description: '纵向柱状图（逐柱向上展开）；data 指向对象数组，labelKey/valueKey 指定字段名',
    },
    PieChart: {
      props: z.object({ title: z.string().max(30), data: DataRef, labelKey: z.string(), valueKey: z.string() }),
      description: '环形占比图（顺时针逐段展开）；适合消费类别构成',
    },
    Table: {
      props: z.object({
        rows: DataRef,
        columns: z.array(z.object({ key: z.string(), label: z.string().max(12) })).min(1).max(6),
      }),
      description: '表格；rows 指向对象数组',
    },
    Note: {
      props: z.object({ text: z.string().max(120) }),
      description: '一句说明文字。不得包含金额数字，金额请用 Metric 引用数据',
    },
    ChoiceList: {
      props: z.object({ title: z.string().max(30), data: DataRef, kind: z.enum(['card', 'account', 'product', 'recipient', 'subscription', 'option']).nullable() }),
      description: '项目选择列表，data引用工具数据。选择仅暂存，不发送消息；唯一对象自动确定并灰显，已选对象灰显。交互区统一确认后才发送全部条件。',
    },
    CardPicker: {
      props: z.object({ title: z.string().max(30), data: DataRef, role: z.enum(['source', 'target', 'general']).optional() }),
      description: '银行卡轮播；单卡、滑动、方向按钮、页码。当前显示的卡即待确认卡，只保留取消和确认，不提供选择按钮；统一确认后才收集本套所有条件发完整消息。不要再生成按尾号付款的FollowUp。',
    },
    Confirm: {
      props: z.object({ prompt: z.string().max(300) }),
      description: '无选择项时的确认组件。按下才发送完整需求。已有CardPicker/ChoiceList/Table时由交互区自动提供统一确认，不再重复添加。',
    },
    FollowUp: {
      props: z.object({ label: z.string().max(24), prompt: z.string().max(300) }),
      description: '兼容旧确认入口；新视图使用Confirm。已有选择组件时此入口会被合并，不要用它重复展示按卡尾号付款的选择。',
    },
  },
  // 不声明执行 action：选择与追问都只发完整用户消息，重新走意图 → 策略 → 独立验证流程。
  actions: {},
})

export type GenUISpec = typeof catalog._specType & { interaction?: ResolvedInteractionTemplate }

/** 给模型的组件说明（不使用默认的 JSONL 流式提示，spec 通过 show_view 工具整体提交） */
export function catalogPrompt(): string {
  const lines = Object.entries(catalog.data.components).map(
    ([name, c]) => `- ${name}: ${(c as { description: string }).description}`,
  )
  return [
    'show_view 的 spec 格式：{ root: string, elements: { [key]: { type, props, children?: string[] } }, interaction?: 当前步骤的语义消息模板 }',
    '可用组件：',
    ...lines,
    '必需 props：Panel {title, subtitle: string|null}；Metric {label, value: 数据引用, unit: "元"|"%"|"笔"|"天"|null}；BarChart/PieChart {title, data: 数组引用, labelKey, valueKey}；Table {rows: 数组引用, columns: [{key,label}]}；CardPicker {title,data: 数组引用,role?: "source"|"target"|"general"}；ChoiceList {title,data: 数组引用,kind: "card"|"account"|"product"|"recipient"|"subscription"|"option"|null}；Note {text}；Confirm {prompt}；旧FollowUp {label,prompt}。选择仅暂存，整套交互的确认才发送。',
    '月度分类图示例（先查询 get_spending_report）：{"root":"p","elements":{"p":{"type":"Panel","props":{"title":"本月支出","subtitle":null},"children":["m","c"]},"m":{"type":"Metric","props":{"label":"总支出","value":{"$state":"/get_spending_report/expense"},"unit":"元"}},"c":{"type":"PieChart","props":{"title":"支出分类","data":{"$state":"/get_spending_report/byCategory"},"labelKey":"category","valueKey":"total"}}}}',
    '数据型 props 必须写成 {"$state": "/工具名/字段路径"}，例如 {"$state": "/analyze_spending/result/byCategory"}；',
    '路径只能指向本会话已调用工具的返回结果。禁止在展示组件 props 中写入任何金额数字，禁止提供 state 字段。interaction只描述当前步骤，另行按模板协议校验，不是自由正文。',
    interactionTemplatePrompt(),
  ].join('\n')
}
