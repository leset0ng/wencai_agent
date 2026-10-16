import type { NumberViolation } from './numbers'

/** 日期、金额、银行卡须来自同一条银行流水，不能拼接各自有出处的字段。 */
export function verifyTransactionReferences(text: string, evidence: unknown[]): NumberViolation[] {
  const rows: {date:string;amount:number;cardLast4:string|null}[] = []
  let hasTransactionReport = false
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    const report = value as {kind?:string;transactions?:unknown[];data?:unknown}
    if (report.kind === 'transaction_history' && Array.isArray(report.transactions)) {
      hasTransactionReport = true
      for (const raw of report.transactions) {
        const row = raw as typeof rows[number]
        if (typeof row.date === 'string' && typeof row.amount === 'number') rows.push(row)
      }
    } else if (Array.isArray(value)) value.forEach(visit)
    else if (report.data) visit(report.data)
  }
  evidence.forEach(visit)
  if (!hasTransactionReport) return []
  const violations: NumberViolation[] = []
  for (const line of text.split(/\n|[。；]/)) {
    const dates = [...line.matchAll(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/g)]
    if (dates.length !== 1) continue // 日期范围和汇总不按单笔明细处理。
    const match = dates[0]
    const date = `${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`
    // 明确货币表达，或表格中的纯数值金额列；不把日期、序号、尾号当金额。
    const amounts = [...line.matchAll(/[¥￥]\s*[-−]?\s*(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s*元/g)].map((m)=>m[1]??m[2])
    if (!amounts.length && line.includes('|')) {
      for (const cell of line.split('|')) {
        const value = cell.trim().replaceAll('*','').match(/^[-−+]?\s*(\d[\d,]*\.\d{1,2})$/)
        if (value) amounts.push(value[1])
      }
    }
    const tail = line.match(/尾号\s*(\d{4})/)?.[1]
    for (const raw of amounts) {
      const cents = Math.round(Number(raw.replaceAll(',',''))*100)
      if (!rows.some((row)=>row.date===date && Math.round(Math.abs(row.amount)*100)===cents && (!tail || row.cardLast4===tail))) {
        violations.push({text:line.trim().slice(0,250),kind:'transaction_reference'})
        break
      }
    }
  }
  return violations
}
