import { Button } from '#/components/ui/button'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { Wallet, ArrowUpRight, ArrowDownLeft, ShieldCheck, Plus, Clock3, Gift, AlertTriangle, CreditCard } from 'lucide-react'
import { Panel, Metric, Empty, TransactionTable, More, Badge, type ViewProps } from '../shared'
import { money, categories, monthlyTrend, dateTime, taskNames } from '../utils'
import { AnimatedDonutChart } from '#/components/ui/charts'
import { MotionPlot } from '#/components/ui/motion'

const COLORS = ['#3869ea', '#76a1f8', '#93c5fd', '#93d8d1', '#c2d5ee', '#e3b580', '#a7a9e9', '#d6dde8']

export function AdminOverview({ s, ledger, report, anomalies, actions, go }: ViewProps) {
  const trend = monthlyTrend(ledger, s.now)
  const pending = s.tasks.filter((t) => t.status === 'pending')
  const principal = s.holdings.reduce((n, h) => n + h.principal, 0)
  const allExpenses = Object.entries(report?.categories ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => ({ name: categories[key] ?? key, value }))
  const expenses =
    allExpenses.length > 4
      ? [...allExpenses.slice(0, 3), { name: '其他支出', value: allExpenses.slice(3).reduce((s, p) => s + p.value, 0) }]
      : allExpenses
  const total = report?.expense ?? 0

  return (
    <>
      <div className="metric-grid">
        <Metric
          label="账户可用余额"
          value={money(s.account.available)}
          note={<><span className="live-dot" />人民币活期</>}
          icon={Wallet}
          accent
        />
        <Metric
          label="本期收入"
          value={money(report?.income ?? 0)}
          note={<><ArrowDownLeft size={13} /> 工资、收款等现金流入</>}
          icon={ArrowDownLeft}
        />
        <Metric
          label="本期支出"
          value={money(report?.expense ?? 0)}
          note={<><ArrowUpRight size={13} /> 含消费与对外转账</>}
          icon={ArrowUpRight}
        />
        <Metric
          label="理财持仓本金"
          value={money(principal)}
          note={<><ShieldCheck size={13} />{s.holdings.length} 笔持仓 · 不计收益</>}
          icon={ShieldCheck}
        />
      </div>

      <div className="overview-main">
        <Panel
          title="现金收支趋势"
          subtitle="最近 6 个月 · 本月截至模拟时间"
          action={
            <div className="chart-legend">
              <span><i />收入</span>
              <span><i />支出</span>
            </div>
          }
        >
          <MotionPlot key={JSON.stringify(trend)} className="trend-chart">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend} margin={{ top: 18, right: 12, left: -15, bottom: 5 }} accessibilityLayer>
                <defs>
                  <linearGradient id="incomeFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#4e7ef2" stopOpacity={0.18} />
                    <stop offset="100%" stopColor="#4e7ef2" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="expenseFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#77bcb4" stopOpacity={0.1} />
                    <stop offset="100%" stopColor="#77bcb4" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="4 5" vertical={false} stroke="#e9edf3" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#8792a5' }} dy={10} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#8792a5' }} tickFormatter={(n) => `${n / 1000}k`} />
                <Tooltip
                  formatter={(value, name) => [money(Number(value) * 100), name === 'income' ? '收入' : '支出']}
                  contentStyle={{ borderRadius: 10, border: '1px solid #e6ebf2', fontSize: 12 }}
                />
                <Area type="monotone" dataKey="income" stroke="#4878ee" fill="url(#incomeFill)" strokeWidth={2.5} isAnimationActive={false} />
                <Area type="monotone" dataKey="expense" stroke="#7bbeb6" fill="url(#expenseFill)" strokeWidth={2} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </MotionPlot>
          <div className="chart-foot">
            <span>每笔收支都来自实际模拟流水</span>
            <More onClick={() => go('transactions')}>查看账单分析</More>
          </div>
        </Panel>

        <Panel title="支出分布" subtitle="当前所选账期的支出结构">
          <div className="donut-wrap">
            {total > 0 ? (
              <>
                <div className="ui-admin-donut"><AnimatedDonutChart compact colors={COLORS} ringRadius={61} ringWidth={15} gapDegrees={3}
                  data={expenses.map((point) => ({ label: point.name, value: point.value }))} /></div>
                <div className="donut-center">
                  <span>本期总支出</span>
                  <strong>{money(total)}</strong>
                </div>
              </>
            ) : (
              <Empty text="当前账期尚无支出" />
            )}
          </div>
          <div className="expense-legend">
            {expenses.slice(0, 4).map((p, i) => (
              <div key={p.name}>
                <span><i style={{ background: COLORS[i] }} />{p.name}</span>
                <b>{((p.value / total) * 100).toFixed(1)}%</b>
                <small>{money(p.value)}</small>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="overview-lower">
        <Panel title="最近交易" subtitle="账户最新记账记录" action={<More onClick={() => go('transactions')} />}>
          <TransactionTable rows={ledger} limit={5} anomalyIds={new Set(anomalies.map((a) => a.id))} />
        </Panel>
        <div className="side-stack">
          <div className="account-card">
            <div>
              <span><CreditCard size={18} /> 文财银行</span>
              <Badge status="active">模拟账户</Badge>
            </div>
            <small>账户可用余额</small>
            <strong>{money(s.account.available)}</strong>
            <div className="account-card-bottom">
              <span>{s.user.name}</span>
            </div>
          </div>
          <Panel title="业务待办" action={<More onClick={() => go('transfers')} />}>
            {pending.length ? (
              <div className="task-mini">
                {pending.slice(0, 2).map((t) => (
                  <div key={t.id}>
                    <span className="mini-icon"><Clock3 size={17} /></span>
                    <div>
                      <strong>{taskNames[t.kind] ?? t.kind}</strong>
                      <small>{dateTime(t.dueAt)}</small>
                    </div>
                    <Badge status="pending" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="no-task">
                <Clock3 size={22} />
                <div>
                  <strong>当前没有待执行任务</strong>
                  <p>创建转账或生日计划，交给模拟调度器。</p>
                </div>
              </div>
            )}
            <div className="quick-actions">
              <Button onClick={() => actions.transfer()} className="ui-button-reset" type="button"><Plus size={15} />新建转账</Button>
              <Button onClick={actions.birthday} className="ui-button-reset" type="button"><Gift size={15} />生日计划</Button>
            </div>
          </Panel>
        </div>
      </div>

      {anomalies.length > 0 && (
        <div className="insight-strip">
          <div>
            <span className="insight-icon"><AlertTriangle size={19} /></span>
            <div>
              <strong>{anomalies.length} 笔交易建议复核</strong>
              <p>检测到大额支出或短时间重复扣款。</p>
            </div>
          </div>
          <Button className="button button-outline button-sm" onClick={() => go('transactions')} type="button">
            查看异常<ArrowUpRight size={14} />
          </Button>
        </div>
      )}
    </>
  )
}
