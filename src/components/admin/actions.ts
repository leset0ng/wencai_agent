import type { AdminSnapshot } from './client'
import type { AdminCommand } from './client'
import { toFen, localInput, localDate } from './utils'

export type Field = {
  name: string
  label: string
  type?: 'text' | 'money' | 'date' | 'datetime-local' | 'number' | 'select' | 'multi'
  value?: string | string[]
  options?: { value: string; label: string }[]
  hint?: string
  min?: string
  max?: string
  required?: boolean
}

export type Action = {
  title: string
  description?: string
  fields?: Field[]
  submitLabel?: string
  danger?: boolean
  build: (values: Record<string, string | string[]>) => AdminCommand
}

const val = (v: Record<string, string | string[]>, k: string) => String(v[k] ?? '')

export function createActions(s: AdminSnapshot, open: (a: Action) => void) {
  const contacts = s.contacts.map((c) => ({
    value: c.id,
    label: `${c.name} · ${c.phone}（${c.note.split(' ')[0]}）`,
  }))
  const amount = (name = 'amount', label = '金额（元）', value = '100'): Field => ({
    name, label, type: 'money', value,
  })
  const confirm = (title: string, description: string, build: Action['build'], danger = false) =>
    open({ title, description, build, danger, submitLabel: title })

  return {
    transfer: (recipient = '') =>
      open({
        title: '新建转账',
        description: '支持按姓名、手机号或备注匹配；定时转账将创建待执行任务。',
        submitLabel: '确认转账',
        fields: [
          { name: 'recipient', label: '收款人', value: recipient || '妈妈', hint: '输入姓名、手机号或备注' },
          amount(),
          { name: 'memo', label: '转账备注', value: '', required: false },
          { name: 'executeAt', label: '定时执行时间（可选，UTC+8）', type: 'datetime-local', required: false, min: localInput(s.now) },
        ],
        build: (v) => ({
          type: 'transfer',
          recipient: val(v, 'recipient'),
          amount: toFen(val(v, 'amount')),
          memo: val(v, 'memo') || undefined,
          ...(val(v, 'executeAt') ? { executeAt: new Date(val(v, 'executeAt') + ':00+08:00').toISOString() } : {}),
        }),
      }),

    split: () =>
      open({
        title: '发起 AA 收款',
        description: '按人数平均拆分，发起人自动包含在内。',
        submitLabel: '创建收款',
        fields: [
          { name: 'title', label: '收款事由', value: '周末聚餐' },
          amount('total', '总金额（元）', '300'),
          { name: 'contactIds', label: '参与人（不含自己）', type: 'multi', options: contacts, value: [] },
        ],
        build: (v) => ({
          type: 'createSplit',
          title: val(v, 'title'),
          total: toFen(val(v, 'total')),
          contactIds: v.contactIds as string[],
        }),
      }),

    cancelTask: (taskId: string) =>
      confirm('取消定时任务', '取消待执行任务。', () => ({ type: 'cancelTask', taskId }), true),

    risk: () =>
      open({
        title: '投资风险测评',
        description: '五项确定性演示问卷，1 代表最低，5 代表最高；有效期 365 天。',
        submitLabel: '提交测评',
        fields: ['投资知识', '过往投资经验', '可承受损失程度', '投资期限', '市场下跌承受能力'].map(
          (label, i) => ({
            name: `q${i}`,
            label,
            type: 'select' as const,
            value: '3',
            options: [
              { value: '1', label: '1 · 很低 / 非常保守' },
              { value: '2', label: '2 · 较低 / 偏保守' },
              { value: '3', label: '3 · 中等 / 稳健' },
              { value: '4', label: '4 · 较高 / 积极' },
              { value: '5', label: '5 · 很高 / 进取' },
            ],
          }),
        ),
        build: (v) => ({
          type: 'assessRisk',
          answers: Array.from({ length: 5 }, (_, i) => Number(v[`q${i}`])),
        }),
      }),

    purchase: (productId: string) => {
      const p = s.products.find((x) => x.id === productId)!
      open({
        title: `申购 · ${p.name}`,
        description: `${p.riskLevel} · ${p.lockDays ? `锁定 ${p.lockDays} 天` : '随时可赎回'}。仅模拟本金，不计提收益。`,
        submitLabel: '确认申购',
        fields: [amount('amount', '申购金额（元）', String(p.minAmount / 100))],
        build: (v) => ({ type: 'purchase', productId, amount: toFen(val(v, 'amount')) }),
      })
    },

    redeem: (holdingId: string) => {
      const h = s.holdings.find((x) => x.id === holdingId)!
      open({
        title: '赎回持仓',
        description: `当前本金 ${(h.principal / 100).toFixed(2)} 元；按本金返还，可部分赎回。`,
        submitLabel: '确认赎回',
        fields: [amount('amount', '赎回金额（元）', String(h.principal / 100))],
        build: (v) => ({ type: 'redeem', holdingId, amount: toFen(val(v, 'amount')) }),
      })
    },

    applyCard: () =>
      open({
        title: '申请新卡',
        description: '演示环境即刻模拟批准。',
        submitLabel: '提交申请',
        fields: [
          {
            name: 'kind', label: '卡片类型', type: 'select', value: 'debit',
            options: [{ value: 'debit', label: '储蓄卡' }, { value: 'credit', label: '信用卡' }],
          },
        ],
        build: (v) => ({ type: 'applyCard', kind: val(v, 'kind') as 'debit' | 'credit' }),
      }),

    cardRemark: (cardId: string) => open({
      title: '修改卡片备注', description: '可填写工资卡、储蓄卡A等；同名卡片转账时需指定尾号。', submitLabel: '保存备注',
      fields: [{ name: 'remark', label: '卡片备注', type: 'text', value: s.cards.find((c) => c.id === cardId)?.remark ?? '' }],
      build: (v) => ({ type: 'cardRemark', cardId, remark: val(v, 'remark') }),
    }),
    creditSpend: (cardId: string) => open({
      title: '模拟信用卡消费', description: '记录到当前信用卡账单，增加待还款并扣减可用额度。', submitLabel: '记录消费',
      fields: [amount('amount', '消费金额（元）', '100'), { name: 'merchant', label: '商户', type: 'text', value: '演示商户' }],
      build: (v) => ({ type: 'creditSpend', cardId, amount: toFen(val(v, 'amount')), merchant: val(v, 'merchant') }),
    }),
    cardState: (cardId: string, action: 'freeze' | 'unlock' | 'reportLost') =>
      confirm(
        { freeze: '冻结卡片', unlock: '解锁卡片', reportLost: '挂失卡片' }[action],
        action === 'reportLost' ? '挂失后无法解锁。' : action === 'freeze' ? '冻结后该卡线上交易受限。' : '恢复正常状态。',
        () => ({ type: 'updateCard', cardId, action }),
        action === 'reportLost',
      ),

    cardLimits: (cardId: string) => {
      const c = s.cards.find((x) => x.id === cardId)!
      open({
        title: '调整卡片限额',
        description: '每日转账限额最高 50,000 元。',
        submitLabel: '保存限额',
        fields: [amount('dailyLimit', '每日限额（元）', String(c.dailyLimit / 100))],
        build: (v) => ({
          type: 'updateCard', cardId, action: 'limits', dailyLimit: toFen(val(v, 'dailyLimit')),
        }),
      })
    },

    cancelSubscription: (subscriptionId: string) => {
      const sub = s.subscriptions.find((x) => x.id === subscriptionId)!
      confirm(
        '取消订阅代扣',
        `撤销 ${sub.merchant} 的订阅授权。`,
        () => ({ type: 'cancelSubscription', subscriptionId }),
        true,
      )
    },

    reminder: (subscriptionId: string) => {
      const sub = s.subscriptions.find((x) => x.id === subscriptionId)!
      open({
        title: '设置续费提醒',
        description: `${sub.merchant} · 续费前提醒。`,
        submitLabel: '保存',
        fields: [{ name: 'days', label: '提前提醒天数', type: 'number', value: '3', min: '1', max: '30' }],
        build: (v) => ({ type: 'subscriptionReminder', subscriptionId, days: Number(v.days) }),
      })
    },

    birthday: () =>
      open({
        title: '创建生日计划',
        description: '预留预算，生日前两天模拟订购礼物，剩余金额自动释放。',
        submitLabel: '创建计划',
        fields: [
          { name: 'contactId', label: '送给谁', type: 'select', value: contacts[0]?.value ?? '', options: contacts },
          { name: 'birthday', label: '生日日期', type: 'date', min: localDate(s.now), value: localDate(new Date(Date.parse(s.now) + 14 * 86400000).toISOString()) },
          amount('budget', '预留预算（元）', '1000'),
        ],
        build: (v) => ({
          type: 'birthdayPlan',
          contactId: val(v, 'contactId'),
          birthday: val(v, 'birthday'),
          budget: toFen(val(v, 'budget')),
        }),
      }),

    cancelPlan: (planId: string) =>
      confirm('取消生日计划', '取消未执行任务，释放已预留预算。', () => ({ type: 'cancelPlan', planId }), true),

    clock: () =>
      open({
        title: '推进模拟时间',
        description: '时钟只能向前推进。到期任务同时执行。',
        submitLabel: '推进并执行任务',
        fields: [
          {
            name: 'to', label: '目标时间（UTC+8）', type: 'datetime-local',
            min: localInput(s.now),
            value: localInput(new Date(Date.parse(s.now) + 86400000).toISOString()),
          },
        ],
        build: (v) => ({ type: 'advanceClock', to: new Date(val(v, 'to') + ':00+08:00').toISOString() }),
      }),

    runJobs: () =>
      confirm('执行到期任务', '执行当前模拟时间已到期的任务。', () => ({ type: 'runJobs' })),
  }
}

export type AdminActions = ReturnType<typeof createActions>
