import { describe, expect, it } from 'vitest'
import { checkedResponse } from '#/server/verify/response'
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
