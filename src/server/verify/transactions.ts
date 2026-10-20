import type { NumberViolation } from './numbers'

export interface HistoryRow { id?: string; date: string; amount: number; cardLast4: string | null }
const DATE_RE = /\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/g
const AGGREGATE = /合计|总计|共计|小计|累计|一共|总共|共\s*\d+\s*笔|\d+\s*笔|净支出|净收入|收支净额|平均|均值|日均|月均/
const SCHEDULE = /首次|下次|下一次|每次|每月|每周|每天|每日|每年|定期|预计|将于|将在|计划|授权|有效期|到期|执行(?:时间|日)|扣费日|还款日|账单日|生日/
const STOCK = /余额|总资产|资产|额度|待还|应还|本金|净值/
const cents = (yuan: number) => Math.round(Math.abs(yuan)*100)

function reports(evidence: unknown[]): { rows: HistoryRow[]; hasMore: boolean }[] {
  const found: { rows: HistoryRow[]; hasMore: boolean }[] = []
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(visit); return }
    const report = value as {kind?:string;transactions?:unknown[];data?:unknown;hasMore?:boolean}
    if (report.kind==='transaction_history' && Array.isArray(report.transactions)) {
      found.push({hasMore:report.hasMore===true,rows:report.transactions.filter((raw):raw is HistoryRow=>{
        const row=raw as HistoryRow
        return !!row && typeof row.date==='string' && typeof row.amount==='number' && Number.isFinite(row.amount)
      })})
    } else if(report.data)visit(report.data)
  }
  evidence.forEach(visit)
  return found
}

function dailyRows(evidence: unknown[], tail?: string, partial = false): Map<string, HistoryRow[]> {
  const rows=new Map<string,HistoryRow>()
  reports(evidence).filter(report=>partial || !report.hasMore).forEach((report,ri)=>report.rows.forEach((row,i)=>{
    if(!tail || row.cardLast4===tail)rows.set(row.id??`anonymous:${ri}:${i}`,row)
  }))
  const days=new Map<string,HistoryRow[]>()
  for(const row of rows.values())days.set(row.date,[...(days.get(row.date)??[]),row])
  return days
}

/** Derived values remain bound to a date and optional card; never enter global evidence. */
export function dayTotals(evidence: unknown[]): Map<string,Set<number>> {
  const totals=new Map<string,Set<number>>()
  for(const [date,rows] of dailyRows(evidence)) {
    const out=rows.filter(r=>r.amount<0).reduce((sum,r)=>sum+cents(r.amount),0)
    const income=rows.filter(r=>r.amount>=0).reduce((sum,r)=>sum+cents(r.amount),0)
    totals.set(date,new Set([out,income,Math.abs(income-out)]))
  }
  return totals
}

type Claim = {text:string;date:string;value:number;at:number;end:number;tail?:string;kind:'record'|'aggregate'|'other';metric:'out'|'in'|'net'|'any'|'unsupported';partial:boolean}
function claims(text:string): Claim[] {
  const result:Claim[]=[]
  for(const sentence of text.matchAll(/[^\n。；;]+/g)) {
    const dates=[...sentence[0].matchAll(DATE_RE)]
    if(dates.length!==1)continue
    const d=dates[0],date=`${d[1]}-${d[2].padStart(2,'0')}-${d[3].padStart(2,'0')}`
    let offset=0
    for(const clause of sentence[0].split(/[，]|,(?!\d{3}(?:\D|$))/)) {
      const start=sentence.index!+offset;offset+=clause.length+1
      const table=clause.includes('|'),mentions=[...clause.matchAll(/[¥￥]\s*[-−+]?\s*(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s*[元块]/g)].map(m=>({raw:m[0],value:m[1]??m[2],index:m.index!}))
      if(!mentions.length && table) {
        for(const cell of clause.matchAll(/\|([^|]+)/g)) {
          const bare=cell[1].trim().replaceAll('*','').match(/^[-−+]?\s*(\d[\d,]*(?:\.\d{1,2})?)$/)
          if(bare)mentions.push({raw:cell[0],value:bare[1],index:cell.index!})
        }
      }
      let previous=0
      for(const m of mentions) {
        const prefix=clause.slice(previous,m.index), aggregate=AGGREGATE.test(prefix)
        previous=m.index+m.raw.length
        // Exceptions apply to this amount's clause, never to every amount on the line.
        const plan=(/授权|首次|下次|每次|将于|将在|计划/.test(prefix) || (/^\s*累计不超过/.test(prefix) && /授权/.test(sentence[0].slice(0,start-sentence.index!)))) && !/已(?:经)?|实际|成功/.test(prefix)
        const kind=(!table && (plan || (!aggregate && (STOCK.test(prefix) || SCHEDULE.test(prefix)))))?'other':aggregate?'aggregate':'record'
        const metric=/平均|均值|日均|月均/.test(prefix)?'unsupported':/净支出|净收入|净额/.test(prefix)?'net':/支出|消费|花费/.test(prefix)?'out':/收入|收款|入账/.test(prefix)?'in':'any'
        result.push({text:clause.trim(),date,value:cents(Number(m.value.replaceAll(',',''))),at:start+m.index,end:start+m.index+m.raw.length,tail:clause.match(/尾号\s*(\d{4})/)?.[1]??sentence[0].match(/尾号\s*(\d{4})/)?.[1],kind,metric,partial:/本页|已显示|已展示|这几笔/.test(clause)})
      }
    }
  }
  return result
}

function supportsTotal(claim:Claim,evidence:unknown[]) {
  const rows=dailyRows(evidence,claim.tail,claim.partial).get(claim.date)
  if(!rows?.length || claim.metric==='unsupported')return false
  const out=rows.filter(r=>r.amount<0).reduce((sum,r)=>sum+cents(r.amount),0)
  const income=rows.filter(r=>r.amount>=0).reduce((sum,r)=>sum+cents(r.amount),0)
  const allowed=claim.metric==='out'?[out]:claim.metric==='in'?[income]:claim.metric==='net'?[Math.abs(income-out)]:[out,income,Math.abs(income-out)]
  return allowed.includes(claim.value)
}

export function derivedAmountAt(text:string,at:number,value:number,evidence:unknown[]):boolean {
  return claims(text).some(claim=>claim.kind==='aggregate' && claim.at<=at && at<claim.end && claim.value===cents(value) && supportsTotal(claim,evidence))
}

/** Date + amount defaults to a record claim, even without a banking keyword. */
export function verifyTransactionReferences(text:string,evidence:unknown[]):NumberViolation[] {
  const found=reports(evidence)
  if(!found.length)return []
  const rows=found.flatMap(report=>report.rows),violations:NumberViolation[]=[]
  for(const claim of claims(text)) {
    if(claim.kind==='other')continue
    const supported=claim.kind==='aggregate'?supportsTotal(claim,evidence):rows.some(row=>row.date===claim.date && cents(row.amount)===claim.value && (!claim.tail||row.cardLast4===claim.tail))
    if(!supported)violations.push({text:claim.text.slice(0,250),kind:'transaction_reference'})
  }
  return violations
}
