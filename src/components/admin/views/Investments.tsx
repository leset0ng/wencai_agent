import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '#/components/ui/table'
import { Button } from '#/components/ui/button'
import { ShieldCheck, ArrowUpRight } from 'lucide-react'
import { Panel, Empty, type ViewProps } from '../shared'
import { money, dateTime } from '../utils'

export function AdminInvestments({ s, actions }: ViewProps) {
  const principal = s.holdings.reduce((sum, h) => sum + h.principal, 0)
  const ratingOrder: Record<string, number> = { R1: 1, R2: 2, R3: 3, R4: 4, R5: 5 }
  const userRating = s.user.riskLevel as string

  return (
    <>
      <div className="risk-banner">
        <div className="risk-icon"><ShieldCheck size={26} /></div>
        <div>
          <span>我的投资风险等级</span>
          <h2>{userRating ? `${userRating} · ${['', '谨慎型', '稳健型', '平衡型', '积极型', '进取型'][parseInt(userRating.replace('R', ''))] ?? userRating}` : '尚未完成风险测评'}</h2>
          <p>{userRating ? `当前风险等级 ${userRating}` : '先完成五项风险问卷，再选择适合自己的模拟产品。'}</p>
        </div>
        <Button className="button button-primary" onClick={actions.risk} type="button">
          {userRating ? '重新测评' : '开始风险测评'}
          <ArrowUpRight size={15} />
        </Button>
      </div>

      <div className="section-caption">
        <h2>产品推荐与对比</h2>
        <span>利率仅供演示，不计提收益</span>
      </div>
      <div className="product-grid">
        {s.products.map((p) => {
          const eligible = !!userRating && ratingOrder[p.riskLevel] <= ratingOrder[userRating]
          return (
            <div className="product-card" key={p.id}>
              <div className="product-head">
                <span className={`risk-tag r${p.riskLevel.replace('R', '')}`}>{p.riskLevel} {ratingOrder[p.riskLevel] <= 2 ? '低风险' : ratingOrder[p.riskLevel] <= 3 ? '中风险' : '高风险'}</span>
                <span>{p.lockDays ? `${p.lockDays} 天锁定` : '随时可赎回'}</span>
              </div>
              <h3>{p.name}</h3>
              <div className="product-rate">
                {(p.annualRate / 100).toFixed(2)}<span>%</span>
              </div>
              <small>演示参考年化 · 不代表实际收益</small>
              <div className="product-facts">
                <div><span>起购金额</span><b>{money(p.minAmount)}</b></div>
                <div><span>申购状态</span><b className={eligible ? 'text-green' : ''}>{eligible ? '风险匹配' : !userRating ? '待风险测评' : '超出风险等级'}</b></div>
              </div>
              <Button className={`button ${eligible ? 'button-primary' : 'button-outline'}`} disabled={!eligible} onClick={() => actions.purchase(p.id)} type="button">
                申购产品<ArrowUpRight size={15} />
              </Button>
            </div>
          )
        })}
      </div>

      <Panel title="我的持仓" subtitle={`总本金 ${money(principal)} · 赎回按本金返还`}>
        {s.holdings.length ? (
          <div className="table-scroll">
            <Table className="data-table">
              <TableHeader>
                <TableRow><TableHead>产品</TableHead><TableHead>持仓本金</TableHead><TableHead>可赎回时间</TableHead><TableHead>操作</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {s.holdings.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell><strong>{s.products.find((p) => p.id === h.productId)?.name ?? h.productId}</strong></TableCell>
                    <TableCell className="amount">{money(h.principal)}</TableCell>
                    <TableCell>{dateTime(h.redeemableAt)}</TableCell>
                    <TableCell>
                      <Button
                        className="button button-outline button-sm"
                        disabled={h.principal === 0 || h.redeemableAt > s.now}
                        onClick={() => actions.redeem(h.id)} type="button"
                      >
                        {h.principal === 0 ? '已全部赎回' : h.redeemableAt > s.now ? '锁定中' : '赎回'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <Empty icon={ShieldCheck} title="暂无持仓" text="先完成风险测评，再选择合适的产品申购。" />
        )}
      </Panel>
    </>
  )
}
