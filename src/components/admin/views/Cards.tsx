import { Button } from '#/components/ui/button'
import {
  Snowflake, UnlockKeyhole, TriangleAlert, SlidersHorizontal, CreditCard, Plus,
} from 'lucide-react'
import { Panel, Badge, type ViewProps } from '../shared'
import { money } from '../utils'

export function AdminCards({ s, actions }: ViewProps) {
  return (
    <>
      <div className="two-col">
        <Panel
          title="我的银行卡"
          subtitle="管理卡片状态与每日限额"
          action={
            <Button className="button button-sm button-primary" onClick={actions.applyCard} type="button">
              <Plus size={15} />申请新卡
            </Button>
          }
        >
          <div className="card-list">
            {s.cards.map((c) => (
              <div className="card-item" key={c.id}>
                <div className="card-item-head">
                  <CreditCard size={20} />
                  <div>
                    <strong>{c.remark ? `${c.remark} · ` : ''}{c.kind === 'credit' ? '信用卡' : '储蓄卡'} · 尾号 {c.last4}</strong>
                    <small>{c.kind === 'credit' ? `可用额度 ${money(c.creditLimit - c.outstanding)} · 待还 ${money(c.outstanding)}` : `余额 ${money(s.accounts.find((a) => a.id === c.accountId)?.balance ?? 0)} · 每日限额 ${money(c.dailyLimit)}`}</small>
                  </div>
                  <Badge status={c.status} />
                </div>
                <div className="card-actions">
                  <Button className="button button-ghost button-sm" onClick={() => actions.cardRemark(c.id)} type="button">修改备注</Button>
                  {c.kind === 'credit' && c.status === 'active' && <Button className="button button-ghost button-sm" onClick={() => actions.creditSpend(c.id)} type="button">模拟消费</Button>}
                  {c.status === 'active' && (
                    <Button className="button button-outline button-sm" onClick={() => actions.cardState(c.id, 'freeze')} type="button">
                      <Snowflake size={14} />冻结
                    </Button>
                  )}
                  {c.status === 'locked' && (
                    <Button className="button button-outline button-sm" onClick={() => actions.cardState(c.id, 'unlock')} type="button">
                      <UnlockKeyhole size={14} />解锁
                    </Button>
                  )}
                  {c.status !== 'lost' && (
                    <Button className="button button-ghost button-sm" onClick={() => actions.cardState(c.id, 'reportLost')} type="button">
                      <TriangleAlert size={14} />挂失
                    </Button>
                  )}
                  <Button className="button button-ghost button-sm" onClick={() => actions.cardLimits(c.id)} type="button">
                    <SlidersHorizontal size={14} />调整限额
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="卡片说明" subtitle="各状态含义">
          <div className="card-legend">
            <div><Badge status="active" />正常可用，支持所有交易</div>
            <div><Badge status="locked" />已冻结，所有交易将被拒绝</div>
            <div><Badge status="lost" />已挂失，不可解锁，需重新办卡</div>
          </div>
        </Panel>
      </div>
    </>
  )
}
