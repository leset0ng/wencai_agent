import { Button } from '#/components/ui/button'
import { Gift, Check, Flower2, CakeSlice } from 'lucide-react'
import { Panel, Empty, Badge, type ViewProps } from '../shared'
import { money } from '../utils'

export function AdminPlans({ s, actions }: ViewProps) {
  return (
    <Panel
      title="生日计划"
      subtitle="预留预算，生日前两天自动订购礼物"
      action={
        <Button className="button button-sm button-primary" onClick={actions.birthday} type="button">
          <Gift size={15} />
          创建生日计划
        </Button>
      }
    >
      {s.plans.length ? (
        <div className="plan-list">
          {s.plans.map((plan) => {
            const contact = s.contacts.find((c) => c.id === plan.contactId)
            const planOrders = s.orders.filter((o) => o.planId === plan.id)
            return (
              <div className="plan-card" key={plan.id}>
                <div className="plan-head">
                  <div>
                    <strong>{contact?.name ?? plan.contactId}</strong>
                    <small>生日：{plan.birthday} · 预算：{money(plan.budget)}</small>
                  </div>
                  <Badge status={plan.status} />
                  {plan.status !== 'cancelled' && (
                    <Button
                      className="button button-ghost button-sm"
                      onClick={() => actions.cancelPlan(plan.id)} type="button"
                    >
                      取消
                    </Button>
                  )}
                </div>
                {planOrders.length > 0 && (
                  <div className="plan-orders">
                    {planOrders.map((o) => (
                      <div className="plan-order" key={o.id}>
                        <span className="mini-icon">
                          {o.item.includes('鲜花') ? <Flower2 size={16} /> : <CakeSlice size={16} />}
                        </span>
                        <div>
                          <strong>{o.item}</strong>
                          <small>{o.merchant} · 预计 {o.deliveryDate} 送达 · {money(o.amount)}</small>
                        </div>
                        {o.status === 'confirmed' && <Check size={16} className="text-green" />}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <Empty
          icon={Gift}
          title="还没有生日计划"
          text="为重要的人提前规划预算与礼物，生日当天不再手忙脚乱。"
          action={
            <Button className="button button-outline" onClick={actions.birthday} type="button">
              创建第一个生日计划
            </Button>
          }
        />
      )}
    </Panel>
  )
}
