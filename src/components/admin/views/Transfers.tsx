import { Button } from '#/components/ui/button'
import { Plus, Clock3, Users, ArrowUpRight } from 'lucide-react'
import { Panel, Empty, Badge, type ViewProps } from '../shared'
import { money, dateTime, taskNames } from '../utils'

export function AdminTransfers({ s, actions }: ViewProps) {
  return (
    <>
      <div className="two-col">
        <Panel
          title="常用收款人"
          subtitle="可通过姓名、手机号或备注转账"
          action={
            <Button className="button button-sm button-primary" onClick={() => actions.transfer()} type="button">
              <Plus size={15} />
              新建转账
            </Button>
          }
        >
          <div className="contacts-list">
            {s.contacts.map((c, i) => (
              <div key={c.id}>
                <span className={`avatar avatar-${i % 4}`}>{c.name.slice(-2)}</span>
                <div>
                  <strong>
                    {c.name}
                    <span>{c.note.split(' ')[0]}</span>
                  </strong>
                  <small>
                    {c.phone} · {c.bank}
                  </small>
                </div>
                <Button className="button button-outline button-sm" onClick={() => actions.transfer(c.id)} type="button">
                  转账
                  <ArrowUpRight size={13} />
                </Button>
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          title="定时任务"
          subtitle="资金预留后，按模拟时间执行"
          action={
            <Button className="button button-outline button-sm" onClick={actions.runJobs} type="button">
              <Clock3 size={14} />
              执行到期任务
            </Button>
          }
        >
          {s.tasks.length ? (
            <div className="task-list">
              {s.tasks.map((t) => (
                <div key={t.id}>
                  <span className="mini-icon">
                    <Clock3 size={18} />
                  </span>
                  <div>
                    <strong>{taskNames[t.kind] ?? t.kind}</strong>
                    <small>
                      {dateTime(t.dueAt)}
                      {t.payload.amountCents ? ` · ${money(Number(t.payload.amountCents))}` : ''}
                    </small>
                    {t.result?.message ? (
                      <small className="text-red">{String(t.result.message)}</small>
                    ) : null}
                  </div>
                  <Badge status={t.status} />
                  {t.kind === 'transfer' && t.status === 'pending' && (
                    <Button className="button button-ghost button-sm" onClick={() => actions.cancelTask(t.id)} type="button">
                      取消
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <Empty icon={Clock3} title="还没有定时任务" text="新建转账时设置执行时间。" />
          )}
        </Panel>
      </div>

      <Panel
        title="AA 收款"
        subtitle="包含发起人，按人数分摊"
        action={
          <Button className="button button-sm button-primary" onClick={actions.split} type="button">
            <Plus size={15} />
            发起 AA
          </Button>
        }
      >
        {s.splits.length ? (
          <div className="split-grid">
            {s.splits.map((split) => (
              <div className="split-card" key={split.id}>
                <div className="split-heading">
                  <span className="mini-icon">
                    <Users size={19} />
                  </span>
                  <div>
                    <h3>{split.title}</h3>
                    <small>
                      {dateTime(split.createdAt)} · 共 {split.shares.length + 1} 人
                    </small>
                  </div>
                  <strong>{money(split.total)}</strong>
                </div>
                <div className="split-self">
                  <span>我的份额</span>
                  <b>{money(split.selfAmount)}</b>
                </div>
                {split.shares.map((p) => (
                  <div className="split-person" key={p.contactId}>
                    <span>{s.contacts.find((c) => c.id === p.contactId)?.name ?? p.contactId}</span>
                    <b>{money(p.amount)}</b>
                    {/* AA 只能由参与人登录自己的账户付款，后台不提供代付入口 */}
                    <Badge status={p.status === 'paid' ? 'paid' : 'pending'} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <Empty
            icon={Users}
            title="轻松分账，清晰收款"
            text="聚餐、旅行或共同购物，创建第一笔 AA 收款。"
            action={
              <Button className="button button-outline" onClick={actions.split} type="button">
                创建 AA 收款
              </Button>
            }
          />
        )}
      </Panel>
    </>
  )
}
