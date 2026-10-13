import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '#/components/ui/table'
import { Button } from '#/components/ui/button'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Fingerprint,
  ScrollText,
  Boxes,
  Bug,
  Layers,
  Play,
  Link2,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ChevronDown,
  ChevronUp,
  Eye,
} from 'lucide-react'
import { Panel, Empty, Badge, type ViewProps } from '../shared'
import { adminApi, type AdminSecurityOverview, type AdminTrace, type SandboxProbeResult } from '../client'
import { dateTime } from '../utils'

const LEVEL_LABEL: Record<string, string> = { green: '🟢 绿色 · 自动执行', yellow: '🟡 黄色 · 用户确认', red: '🔴 红色 · 强验证' }
const OUTCOME: Record<AdminTrace['outcome'], { label: string; status: string }> = {
  blocked: { label: '输入审核拦截', status: 'lost' },
  denied: { label: '策略拒绝', status: 'lost' },
  pending: { label: '等待用户确认', status: 'pending' },
  confirmed: { label: '已确认执行', status: 'active' },
  failed: { label: '执行失败', status: 'failed' },
  compensated: { label: '已补偿回滚', status: 'planned' },
  ok: { label: '完成（只读）', status: 'active' },
  open: { label: '进行中', status: 'pending' },
}

export function AdminSecurity({ s }: ViewProps) {
  const client = useQueryClient()
  const [toast, setToast] = useState('')
  const [openTrace, setOpenTrace] = useState<string | null>(null)

  const security = useQuery({
    queryKey: ['admin', 'security'],
    queryFn: () => adminApi.security(),
    refetchInterval: 5000,
  })
  const traces = useQuery({
    queryKey: ['admin', 'trace'],
    queryFn: () => adminApi.trace(),
    refetchInterval: 5000,
  })
  const sandbox = useQuery({
    queryKey: ['admin', 'sandbox'],
    queryFn: () => adminApi.sandbox(),
    // 沙箱样本含 1 秒超时与内存炸弹用例，只在用户点击时执行
    enabled: false,
  })

  const command = useMutation({
    mutationFn: (cmd: Parameters<typeof adminApi.command>[1]) => adminApi.command(s.user.id, cmd),
    onSuccess: async (_data, cmd) => {
      await client.invalidateQueries({ queryKey: ['admin'] })
      setToast(cmd.type === 'tamperAudit' ? '已篡改一条审计记录，请点击「校验整链」查看结果' : '已还原被篡改的审计记录')
    },
  })

  const overview: AdminSecurityOverview | undefined = security.data
  const chain = overview?.chain

  return (
    <>
      {toast && (
        <div className="load-error" role="status" style={{ borderColor: '#cfe3ff', background: '#f4f8ff' }}>
          <CheckCircle2 size={18} className="text-green" />
          <div>
            <strong>{toast}</strong>
          </div>
          <Button className="button button-outline button-sm" onClick={() => setToast('')} type="button">
            知道了
          </Button>
        </div>
      )}

      {/* ① 审计链防篡改 */}
      <Panel
        title="审计链防篡改"
        subtitle="每条记录含上一条哈希。改写任意一条载荷，整链校验立刻定位到那一条"
        action={
          chain && (
            <span className={`chain-state ${chain.ok ? 'ok' : 'broken'}`}>
              {chain.ok ? <ShieldCheck size={15} /> : <ShieldX size={15} />}
              {chain.ok ? `整链完整 · ${chain.total} 条` : `第 ${chain.brokenSeq} 条起断裂`}
            </span>
          )
        }
      >
        {chain ? (
          <>
            <div className="chain-actions">
              <Button
                className="button button-outline button-sm"
                onClick={() => client.invalidateQueries({ queryKey: ['admin', 'security'] })}
                disabled={security.isFetching} type="button"
              >
                <Eye size={14} />
                校验整链
              </Button>
              <Button
                className="button button-outline button-sm"
                onClick={() => {
                  // 选一条较早的记录：链尾容易被后续写入掩盖，中间位置最能说明问题
                  const target = chain.entries.filter((e) => e.seq > 1)[Math.floor(Math.max(chain.entries.length - 8, 0) / 2)]
                  if (target) command.mutate({ type: 'tamperAudit', seq: target.seq })
                }}
                disabled={command.isPending || chain.entries.length < 3} type="button"
              >
                <Bug size={14} />
                模拟篡改一条记录
              </Button>
              {chain.entries.some((e) => e.tampered) && (
                <Button
                  className="button button-primary button-sm"
                  onClick={() => command.mutate({ type: 'restoreAudit' })}
                  disabled={command.isPending} type="button"
                >
                  <Link2 size={14} />
                  还原并重新校验
                </Button>
              )}
            </div>
            <div className="chain-list">
              {chain.entries
                .slice()
                .reverse()
                .slice(0, 12)
                .map((entry) => (
                  <div key={entry.seq} className={`chain-row ${entry.ok ? '' : 'broken'}`}>
                    <span className="chain-seq">#{entry.seq}</span>
                    <span className="chain-type">{entry.type}</span>
                    <code className="chain-hash">{entry.hash.slice(0, 16)}…</code>
                    <span className="chain-reason">
                      {entry.tampered && <em>演示篡改</em>}
                      {entry.reason}
                    </span>
                    <span className="chain-time">{dateTime(entry.at)}</span>
                  </div>
                ))}
            </div>
          </>
        ) : (
          <div className="loading-workspace">
            <Loader2 size={22} className="spin" />
            <span>正在校验哈希链</span>
          </div>
        )}
      </Panel>

      {/* ② 决策链 */}
      <Panel title="决策链追踪" subtitle="同一句用户请求：输入审核 → 工具调用 → 策略判定 → 用户确认 → 执行，全部可回溯到哈希">
        {traces.data?.length ? (
          <div className="trace-list">
            {traces.data.slice(0, 12).map((trace) => {
              const expanded = openTrace === trace.id
              const outcome = OUTCOME[trace.outcome]
              return (
                <div key={trace.id} className="trace-card">
                  <Button
                    type="button"
                    className="trace-head"
                    aria-expanded={expanded}
                    onClick={() => setOpenTrace(expanded ? null : trace.id)}
                  >
                    <div className="trace-request">
                      <strong>{trace.request}</strong>
                      <small>
                        {dateTime(trace.startedAt)} · {trace.channel} · {trace.steps.length} 步
                      </small>
                    </div>
                    {trace.level && <span className={`level-chip level-${trace.allowed === false ? 'denied' : trace.level}`}>
                      {trace.allowed === false ? '策略拒绝' : LEVEL_LABEL[trace.level].split(' · ')[0]}
                    </span>}
                    <Badge status={outcome.status}>{outcome.label}</Badge>
                    {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                  </Button>
                  {expanded && (
                    <div className="trace-body">
                      <ol className="trace-steps">
                        {trace.steps.map((step) => (
                          <li key={step.seq} className={`tone-${step.tone}`}>
                            <span className="step-dot" />
                            <div>
                              <strong>{step.label}</strong>
                              <p>{step.detail}</p>
                              <small>
                                #{step.seq} · {dateTime(step.at)} · sha256:{step.hash.slice(0, 12)}…
                              </small>
                            </div>
                          </li>
                        ))}
                      </ol>
                      {(trace.reasons.length > 0 || trace.facts) && (
                        <div className="trace-verdict">
                          <div className="trace-verdict-head">
                            <Fingerprint size={15} />
                            <strong>分级依据（由策略引擎计算，非模型输出）</strong>
                          </div>
                          {trace.reasons.length > 0 && (
                            <ul>
                              {trace.reasons.map((reason) => (
                                <li key={reason}>{reason}</li>
                              ))}
                            </ul>
                          )}
                          {trace.facts && (
                            <dl className="fact-grid">
                              {typeof trace.facts.dailyOutgoingCents === 'number' && (
                                <>
                                  <dt>今日已转出</dt>
                                  <dd>¥{(trace.facts.dailyOutgoingCents / 100).toFixed(2)}</dd>
                                </>
                              )}
                              <dt>收款人</dt>
                              <dd>
                                {trace.facts.payeeAgeDays === undefined
                                  ? '未登记 / 新收款人'
                                  : `登记 ${String(trace.facts.payeeAgeDays)} 天`}
                              </dd>
                              <dt>近10分钟转账</dt>
                              <dd>{String(trace.facts.recentTransferCount ?? '—')} 笔</dd>
                              <dt>账户状态</dt>
                              <dd>{trace.facts.accountLocked === true ? '已锁定' : '正常'}</dd>
                              <dt>收款账户风险</dt>
                              <dd>{trace.facts.payeeRiskFlag === 'confirmed' ? '人工确认高危' : trace.facts.payeeRiskFlag === 'suspected' ? '待核实，需强验证' : '无活动标记'}</dd>
                              {typeof trace.facts.payeeRiskRevision === 'number' && <><dt>标记版本</dt><dd>{trace.facts.payeeRiskRevision}</dd></>}
                            </dl>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <Empty icon={Layers} title="还没有可展示的决策链" text="用户端发起一次对话或转账后，这里会按请求串出完整链路。" />
        )}
      </Panel>

      {/* ③ 红队回归 */}
      <Panel
        title="红队回归"
        subtitle="内置攻击样本逐条重放，现场可见拦截结果（走真实启发式规则，不调用模型）"
        action={
          overview && (
            <span className={`chain-state ${overview.redTeamScore.passed === overview.redTeamScore.total ? 'ok' : 'broken'}`}>
              <ShieldAlert size={15} />
              拦截 {overview.redTeamScore.passed}/{overview.redTeamScore.total}
            </span>
          )
        }
      >
        {overview ? (
          <div className="table-scroll">
            <Table className="data-table">
              <TableHeader>
                <TableRow>
                  <TableHead>攻击样本</TableHead>
                  <TableHead>类别</TableHead>
                  <TableHead>判定</TableHead>
                  <TableHead>防线</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overview.redTeam.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <div className="redteam-input">
                        <strong>{item.input}</strong>
                        <small>预期：{item.expect}</small>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="category-tag">{item.category}</span>
                    </TableCell>
                    <TableCell>
                      <Badge status={item.verdict === 'block' ? 'lost' : item.verdict === 'flag' ? 'pending' : 'scheduled'}>
                        {item.verdict === 'block' ? '拦截' : item.verdict === 'flag' ? '标记' : '放行'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <small className="muted">
                        {item.passed ? item.caughtBy : '未命中启发式——由结构约束兜底'}
                        {item.score > 0 && ` · 可疑度 ${item.score}`}
                      </small>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="loading-workspace">
            <Loader2 size={22} className="spin" />
            <span>正在重放攻击样本</span>
          </div>
        )}
      </Panel>

      {/* ④ 策略引擎实时推演 */}
      <Panel title="风险分级推演" subtitle="同一套纯函数策略引擎：只改事实，不改代码，看等级如何变化">
        {overview ? (
          <div className="probe-list">
            {overview.policy.map((probe) => (
              <div key={probe.id} className={`probe-row level-${probe.allowed ? probe.level : 'denied'}`}>
                <div className="probe-main">
                  <strong>{probe.label}</strong>
                  <small>{probe.note}</small>
                </div>
                <code className="probe-tool">{probe.tool}</code>
                <span className="probe-arrow">→</span>
                <span className="probe-level">
                  {probe.allowed === false ? '拒绝执行' : probe.level}
                  {probe.requiresChannelHandoff && <em>需跳转 H5</em>}
                </span>
                <span className="probe-reason">{probe.reasons.join('；') || '未命中升级规则'}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="loading-workspace">
            <Loader2 size={22} className="spin" />
            <span>正在推演</span>
          </div>
        )}
      </Panel>

      {/* ⑤ 沙箱监控 */}
      <Panel
        title="代码沙箱监控"
        subtitle="模型生成的 JavaScript 在 QuickJS WASM 中执行：无文件系统、无网络、限时 1 秒、限内存 32MB"
        action={
          <Button className="button button-outline button-sm" onClick={() => sandbox.refetch()} disabled={sandbox.isFetching} type="button">
            {sandbox.isFetching ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
            运行沙箱样本
          </Button>
        }
      >
        {sandbox.data ? (
          <div className="sandbox-list">
            {sandbox.data.map((probe: SandboxProbeResult) => (
              <div key={probe.id} className={`sandbox-card ${probe.ok ? '' : 'rejected'}`}>
                <div className="sandbox-head">
                  <Boxes size={15} />
                  <strong>{probe.label}</strong>
                  <span className="sandbox-ms">{probe.durationMs} ms</span>
                  {probe.ok ? <Badge status="active">已执行</Badge> : <Badge status="lost">被拦截</Badge>}
                </div>
                <pre className="sandbox-code">{probe.code}</pre>
                <p className="sandbox-note">{probe.note}</p>
                {probe.ok ? (
                  <pre className="sandbox-output">{probe.output}</pre>
                ) : (
                  <pre className="sandbox-error">
                    <AlertTriangle size={13} /> {probe.error}
                  </pre>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Empty
            icon={Boxes}
            title="尚未运行沙箱样本"
            text="点击「运行沙箱样本」，会依次执行正常分析、无限循环、文件系统访问与内存炸弹四类用例。"
          />
        )}
      </Panel>

      {/* ⑥ 安全计数 */}
      {overview && (
        <Panel title="安全事件计数" subtitle="来自审计表的全局统计，可整链校验">
          <div className="security-stats">
            <Stat icon={ScrollText} label="待确认动作" value={overview.stats.pendingTotal} note="需用户确认" />
            <Stat icon={CheckCircle2} label="已确认执行" value={overview.stats.executedTotal} note="含 DAG 恢复" />
            <Stat icon={ShieldX} label="被策略拒绝" value={overview.stats.deniedTotal} note="含熔断" />
            <Stat icon={Bug} label="隔离可疑文本" value={overview.stats.redactedTotal} note="间接注入" />
            <Stat icon={AlertTriangle} label="数字核验提示" value={overview.stats.outputViolations} note="回复中无出处的金额" />
            <Stat icon={Fingerprint} label="熔断锁定" value={overview.stats.circuitBreaks} note="强验证连续失败" />
          </div>
        </Panel>
      )}
    </>
  )
}

function Stat({
  icon: Icon,
  label,
  value,
  note,
}: {
  icon: typeof ShieldCheck
  label: string
  value: number
  note: string
}) {
  return (
    <div className="security-stat">
      <span className="security-stat-icon">
        <Icon size={17} />
      </span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{note}</em>
      </div>
    </div>
  )
}
