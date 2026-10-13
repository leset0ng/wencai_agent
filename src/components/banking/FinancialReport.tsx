import { Tabs, TabsContent, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { useState } from 'react'
import { ChartColumn, ChartPie } from 'lucide-react'
import { AnimatedBarChart, AnimatedDonutChart } from '#/components/ui/charts'
import type { ChartDatum } from '#/components/ui/charts'
import { AnimatedAmount } from '#/components/ui/motion'

/** 首页账单与工具输出共用，稳定数据不会因流式重渲染而重复播放。 */
export function FinancialReport({
  data,
  total,
  title = '本月支出分类',
}: {
  data: ChartDatum[]
  total: number
  title?: string
}) {
  const [mode, setMode] = useState<'pie' | 'bar'>('pie')
  return (
    <Tabs value={mode} onValueChange={(value) => setMode(value as 'pie' | 'bar')} className="bank-financial-report" render={<section />}>
      <div className="bank-report-total">
        <span>支出合计</span>
        <AnimatedAmount value={total} prefix="¥ " />
      </div>
      <div className="bank-chart-heading">
        <h3>{title}</h3>
        <TabsList className="bank-chart-switch" aria-label="图表类型">
          <TabsTrigger value="pie"
            className="bank-lift"
            aria-label="环形图"
            aria-pressed={mode === 'pie'}
            type="button"
          >
            <ChartPie size={15} />
          </TabsTrigger>
          <TabsTrigger value="bar"
            className="bank-lift"
            aria-label="柱状图"
            aria-pressed={mode === 'bar'}
            type="button"
          >
            <ChartColumn size={15} />
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value={mode}>{mode === 'pie' ? <AnimatedDonutChart data={data} /> : <AnimatedBarChart data={data} />}</TabsContent>
    </Tabs>
  )
}
