import { z } from 'zod'

const identifier = z.string().regex(/^[a-zA-Z][\w-]{0,59}$/)
export const QuestionnaireSchema = z.object({
  id: identifier,
  title: z.string().trim().min(1).max(60),
  description: z.string().max(200).optional(),
  purpose: z.enum(['general', 'risk_assessment']).default('general'),
  questions: z.array(z.object({
    id: identifier,
    title: z.string().trim().min(1).max(200),
    options: z.array(z.object({ id: identifier, label: z.string().trim().min(1).max(160), value: z.string().min(1).max(60) })).min(2).max(6),
  })).min(1).max(12),
}).strict().superRefine((form, ctx) => {
  if (new Set(form.questions.map(q => q.id)).size !== form.questions.length) ctx.addIssue({ code: 'custom', message: '题目ID不能重复' })
  for (const q of form.questions) if (new Set(q.options.map(o => o.id)).size !== q.options.length || new Set(q.options.map(o => o.value)).size !== q.options.length) ctx.addIssue({ code: 'custom', message: '同一题的选项ID和值不能重复' })
  if (/交易密码|登录密码|短信验证码|完整卡号|身份证号|OTP|password/i.test([form.title, form.description, ...form.questions.flatMap(q => [q.title, ...q.options.map(o => o.label)])].join(' '))) ctx.addIssue({ code: 'custom', message: '问卷不能收集密码、验证码或完整身份及卡号凭据' })
  if (form.purpose === 'risk_assessment' && (form.id !== 'risk-profile-v1' || form.questions.length !== 5 || form.questions.some((q, i) => q.id !== `risk-${i + 1}` || q.title !== riskItems[i]?.[0] || q.options.length !== 5 || q.options.some((o, j) => o.value !== String(j + 1) || o.label !== riskItems[i]?.[1][j])))) ctx.addIssue({ code: 'custom', message: '风险测评必须使用银行提供的标准问卷' })
})
export type QuestionnaireData = z.infer<typeof QuestionnaireSchema>
export type QuestionnaireAnswers = Record<string, string>

const riskItems = [
  ['你的投资经验如何？', ['没有投资经验', '了解存款和低风险产品', '有少量基金或债券经验', '熟悉多类投资产品', '投资经验丰富']],
  ['这笔资金可以投资多久？', ['一年以内', '一至两年', '两至三年', '三至五年', '五年以上']],
  ['你能接受的最大本金波动是多少？', ['几乎不能接受亏损', '不超过5%', '不超过10%', '不超过30%', '可接受30%以上波动']],
  ['你的收入稳定性如何？', ['很不稳定', '不太稳定', '基本稳定', '比较稳定', '非常稳定']],
  ['你的投资目标更接近哪一项？', ['本金安全为主', '稳健增值', '收益与风险平衡', '追求较高收益', '追求高收益并承担高风险']],
] as const
export const RISK_QUESTIONNAIRE: QuestionnaireData = {
  id: 'risk-profile-v1', title: '投资风险测评', purpose: 'risk_assessment',
  description: '共5题，请按实际情况选择。提交后先试算风险等级，登记仍需另行确认。',
  questions: riskItems.map(([title, labels], i) => ({ id: `risk-${i + 1}`, title, options: labels.map((label, j) => ({ id: `option-${j + 1}`, label, value: String(j + 1) })) })),
}

export function questionnaireMessage(input: QuestionnaireData, answers: QuestionnaireAnswers): string {
  const form = QuestionnaireSchema.parse(input)
  const selected = form.questions.map(q => { const option = q.options.find(o => o.id === answers[q.id]); if (!option) throw new Error('请完成全部题目后提交'); return { q, option } })
  const lines = selected.map(({ q, option }, i) => `${i + 1}. ${q.title}：${option.label}（答案值：${option.value}）`)
  return `我已完成「${form.title}」问卷（${form.id}），我的答案如下：\n${lines.join('\n')}\n` + (form.purpose === 'risk_assessment'
    ? `风险测评答案：[${selected.map(s => s.option.value).join(', ')}]。请先试算风险等级，再询问我是否登记；本次提交不代表已登记或通过安全验证。`
    : '请根据以上完整答案继续本次业务；需要交易或修改账户时仍须生成确认单并由我完成所需验证。')
}
