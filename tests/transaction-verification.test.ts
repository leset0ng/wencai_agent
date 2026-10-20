import { describe, expect, it } from 'vitest'
import { checkedResponse } from '#/server/verify/response'
import { dayTotals } from '#/server/verify/transactions'
const evidence=[{status:'done',data:{kind:'transaction_history',transactions:[
  {date:'2026-09-04',time:'2026-09-04 15:49:00',amount:-256.79,cardLast4:'8823'},
  {date:'2026-09-10',time:'2026-09-10 01:25:00',amount:-81.65,cardLast4:'8823'},
]}},{cards:[{last4:'4267'}]}]
describe('流水日期、金额和银行卡联合核验',()=>{
  it('准确明细通过',()=>{
    expect(checkedResponse('|2026-09-04|尾号8823|−¥256.79|\n|2026-09-10|尾号8823|81.65|',evidence,false,false).blocked).toBe(false)
  })
  it('金额有出处但日期被截成UTC日期时拦截',()=>{
    const result=checkedResponse('|2026-09-09|王建国|−¥81.65|',evidence,false,false)
    expect(result.blocked).toBe(true)
    expect(result.violations.some(v=>v.kind==='transaction_reference')).toBe(true)
  })
  it('调换日期或拼接另一张卡尾号不能通过',()=>{
    expect(checkedResponse('2026-09-04 转账81.65元',evidence,false,false).blocked).toBe(true)
    expect(checkedResponse('|2026-09-10|尾号4267|81.65|',evidence,false,false).blocked).toBe(true)
  })
  it('日期范围、总量和查询说明不当成单笔流水误拦',()=>{
    expect(checkedResponse('查询2026-09-04至2026-09-10的交易。',evidence,false,false).blocked).toBe(false)
  })
  it('查询无记录时，裸金额表格也不能编造流水',()=>{
    const empty=[{status:'done',data:{kind:'transaction_history',transactions:[]}}]
    expect(checkedResponse('|2026-09-07|王建国|81.65|',empty,false,false).blocked).toBe(true)
    expect(checkedResponse('2026-09-07 当天没有转账记录。',empty,false,false).blocked).toBe(false)
  })
})

/** 同一天两笔（¥1,000 与 ¥700），另一天一笔 ¥81.65；并带上其他工具的输出，模拟真实会话里的证据 */
const dayRows = [{ date: '2026-10-12', time: '2026-10-12 10:00:00', amount: -1000, cardLast4: '8823', id: 'a' },
  { date: '2026-10-12', time: '2026-10-12 15:00:00', amount: -700, cardLast4: '8823', id: 'b' },
  { date: '2026-10-10', time: '2026-10-10 09:00:00', amount: -81.65, cardLast4: '8823', id: 'c' }]
const history = (rows = dayRows) => ({ status: 'done', data: { kind: 'transaction_history', transactions: rows } })
const session = [history(), { totalSpent: 1700, balance: 23568.2, creditOutstanding: 1500, amount: 1500 }]
const blocked = (text: string, evidence: unknown[] = session) => checkedResponse(text, evidence, false, false).blocked
const kinds = (text: string, evidence: unknown[] = session) => checkedResponse(text, evidence, false, false).violations.map((v) => v.kind)

describe('流水核验不误拦非流水句子', () => {
  it('单日合计：由当日流水行推出的支出合计、收入合计和净额都可以引用', () => {
    expect(blocked('2026-10-12 共 2 笔，合计 ¥1,700.00')).toBe(false)
    expect(blocked('2026-10-12 共 2 笔，合计支出 1700 元')).toBe(false)
    expect(blocked('|2026-10-12|合计|¥1,700.00|')).toBe(false)
    const mixed = [history([...dayRows, { date: '2026-10-12', time: '2026-10-12 18:00:00', amount: 300, cardLast4: '8823', id: 'd' }])]
    expect(blocked('2026-10-12 收入合计 ¥300.00，支出合计 ¥1,700.00，净支出 ¥1,400.00', mixed)).toBe(false)
  })

  it('合计不需要另一个工具兜底：只有流水时，当日合计本身就有出处（旧的金额出处规则也不再拦）', () => {
    expect(kinds('2026-10-12 共 2 笔，合计 ¥1,700.00', [history()])).toEqual([])
  })

  it('未绑定日期的外部总额不能作为某天流水合计', () => {
    expect(blocked('2026-10-12 当日合计 ¥5,000.00', [history(), { totalSpent: 5000 }])).toBe(true)
  })

  it('计划与期限句不是流水：授权的首次执行日、每次金额、有效期', () => {
    expect(blocked('首次执行 2026-11-05，每次 1500 元')).toBe(false)
    expect(blocked('每次转账 1500 元，首次执行 2026-11-05')).toBe(false)
    expect(blocked('授权有效期至 2026-11-12，累计不超过 ¥1,500.00')).toBe(false)
    expect(blocked('下次扣费 2026-11-05，预计 ¥25.00', [history(), { amount: 25 }])).toBe(false)
  })

  it('余额、额度、还款日陈述不是流水，哪怕带"转账"字样', () => {
    expect(blocked('截至 2026-10-13，活期余额 ¥23,568.20')).toBe(false)
    expect(blocked('2026-10-10 转账后余额 ¥23,568.20')).toBe(false)
    expect(blocked('还款日 2026-10-28，应还 ¥1,500.00')).toBe(false)
  })

  it('无记录关键词的简短明细也必须核对日期与金额', () => {
    expect(blocked('2026-10-10 王建国 ¥81.65')).toBe(false)
    expect(blocked('2026-10-11 王建国 ¥81.65')).toBe(true)
    expect(blocked('|2026-10-11|王建国|−¥81.65|')).toBe(true)
  })
})

describe('流水核验仍然拦住真正的拼接与编造', () => {
  it('准确的单笔通过', () => {
    expect(blocked('2026-10-10 转账 ¥81.65')).toBe(false)
    expect(blocked('|2026-10-12|尾号8823|¥1,000.00|')).toBe(false)
  })

  it('日期拼错、金额拼错、卡尾号拼错', () => {
    expect(kinds('2026-10-11 转账 ¥81.65')).toContain('transaction_reference')
    expect(kinds('2026-10-10 转账 ¥1,000.00')).toContain('transaction_reference')
    expect(kinds('|2026-10-12|尾号4267|¥1,000.00|')).toContain('transaction_reference')
  })

  it('合计行也不能拼接：金额只是另一天某一笔，或根本不是当日合计', () => {
    expect(kinds('2026-10-12 合计 ¥81.65')).toContain('transaction_reference') // 81.65 是 10-10 的单笔
    expect(blocked('2026-10-12 共 2 笔，合计 ¥1,800.00', [history()])).toBe(true) // 编造的合计
    expect(blocked('|2026-10-10|合计|¥1,700.00|', [history()])).toBe(true) // 1700 是 10-12 的合计，不是 10-10 的
  })

  it('同日多笔拼接：金额取自当日另一笔、日期取自当日也算对，但另一天的金额不行', () => {
    expect(blocked('2026-10-12 转账 ¥700.00')).toBe(false)
    expect(blocked('2026-10-12 转账 ¥81.65')).toBe(true)
  })

  it('同一笔流水出现在多次查询里，不会被重复累加', () => {
    const twice = [history(), history()]
    expect(blocked('2026-10-12 合计 ¥1,700.00', twice)).toBe(false)
    // 直接看派生合计：两份报告里 id 相同的行只算一次
    const totals = [...dayTotals(twice).get('2026-10-12')!]
    expect(totals).toContain(170_000)
    expect(totals).not.toContain(340_000)
  })

  it('没有任何流水查询结果时，规则不介入（金额出处规则照常）', () => {
    expect(kinds('首次执行 2026-11-05，每次 1500 元', [{ amount: 1500 }])).toEqual([])
  })
})


describe('日期和金额的上下文隔离',()=>{
  it('余额不能充当当日合计的出处',()=>{
    expect(blocked('2026-10-12 合计 ¥23,568.20')).toBe(true)
    expect(blocked('截至2026-10-12 合计 ¥23,568.20')).toBe(true)
  })
  it('派生单日合计不会成为其他日期或无日期余额的通用金额出处',()=>{
    expect(blocked('余额为1700元',[history()])).toBe(true)
    expect(blocked('2026-10-11 合计1700元',[history()])).toBe(true)
    expect(blocked('2026-10-12 合计1700元；余额为1700元',[history()])).toBe(true)
    expect(blocked('2026-10-12 合计1700元',[history()])).toBe(false)
  })
  it('合计必须匹配当前卡片和收入支出类型',()=>{
    expect(blocked('2026-10-12 尾号4267 合计1700元')).toBe(true)
    expect(blocked('2026-10-12 收入合计1700元',[history()])).toBe(true)
    expect(blocked('2026-10-12 支出合计1700元',[history()])).toBe(false)
  })
  it('同一行的余额或计划用语不能让另一笔明细跳过检查',()=>{
    expect(blocked('2026-10-11 王建国 ¥81.65，余额 ¥23,568.20')).toBe(true)
    expect(blocked('2026-10-10 转账 ¥1,000.00，转账后余额 ¥23,568.20')).toBe(true)
    expect(blocked('2026-10-10 转账 ¥81.65，转账后余额 ¥23,568.20')).toBe(false)
    expect(blocked('2026-10-11 王建国 ¥81.65，下次扣费预计25元',[...session,{amount:25}])).toBe(true)
    expect(blocked('截至2026-10-11 王建国 ¥81.65')).toBe(true)
  })
  it('分页尚未结束时，不能把本页和当成全天和',()=>{
    const partial={status:'done',data:{kind:'transaction_history',hasMore:true,transactions:dayRows}}
    expect(blocked('2026-10-12 支出合计1700元',[partial])).toBe(true)
    expect(blocked('2026-10-12 本页支出合计1700元',[partial])).toBe(false)
  })
})
