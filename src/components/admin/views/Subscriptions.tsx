import { Button } from '#/components/ui/button'
import { Bell, Repeat2 } from 'lucide-react'
import { Panel, Empty, Badge, type ViewProps } from '../shared'
import { money, dateTime } from '../utils'

export function AdminSubscriptions({ s, actions }: ViewProps) {
  const active = s.subscriptions.filter((x) => x.status === 'active')
  const cancelled = s.subscriptions.filter((x) => x.status !== 'active')

  return (
    <>
      <Panel title="订阅与自动代扣" subtitle={`${active.length} 项有效订阅`}>
        {active.length ? (
          <div className="sub-list">
            {active.map((sub) => (
              <div className="sub-item" key={sub.id}>
                <span className="mini-icon"><Repeat2 size={18} /></span>
                <div>
                  <strong>{sub.merchant}</strong>
                  <small>
                    {money(sub.amount)} / {sub.cycle === 'monthly' ? '月' : '年'}
                    {sub.nextChargeAt ? ` · 下次扣费 ${dateTime(sub.nextChargeAt, true)}` : ''}
                  </small>
                </div>
                <Badge status="active" />
                <div className="sub-actions">
                  <Button className="button button-ghost button-sm" onClick={() => actions.reminder(sub.id)} type="button">
                    <Bell size={14} />提醒
                  </Button>
                  <Button className="button button-ghost button-sm" onClick={() => actions.cancelSubscription(sub.id)} type="button">
                    取消
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty icon={Repeat2} title="没有有效订阅" text="检测到的订阅会在这里展示。" />
        )}
      </Panel>

      {cancelled.length > 0 && (
        <Panel title="已取消订阅" subtitle="历史记录">
          <div className="sub-list">
            {cancelled.map((sub) => (
              <div className="sub-item" key={sub.id}>
                <span className="mini-icon"><Repeat2 size={18} /></span>
                <div>
                  <strong>{sub.merchant}</strong>
                  <small>{money(sub.amount)} / {sub.cycle === 'monthly' ? '月' : '年'}</small>
                </div>
                <Badge status="cancelled" />
              </div>
            ))}
          </div>
        </Panel>
      )}
    </>
  )
}
