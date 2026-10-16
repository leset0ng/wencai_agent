import { useContext, useId, useState } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import { Button } from '#/components/ui/button'
import { AgentInteractionContext } from './AgentInteraction'
import { QuestionnaireSchema, questionnaireMessage, type QuestionnaireAnswers, type QuestionnaireData } from '#/lib/questionnaire'
import './agent-questionnaire.css'

export function AgentQuestionnaire({ data }: { data: QuestionnaireData }) {
  const interaction = useContext(AgentInteractionContext), reduce = useReducedMotion()
  const instance = useId()
  const [index, setIndex] = useState(0), [answers, setAnswers] = useState<QuestionnaireAnswers>({}), [submitted, setSubmitted] = useState(false)
  const parsed = QuestionnaireSchema.safeParse(data)
  if (!parsed.success) return <p role="alert">问卷格式无效，请让文财重新生成。</p>
  const form = parsed.data, question = form.questions[index], selected = answers[question.id], last = index === form.questions.length - 1
  const complete = form.questions.every(q => q.options.some(o => o.id === answers[q.id]))
  return <section className="bank-questionnaire" aria-label={form.title}>
    <header><h3>{form.title}</h3><span aria-live="polite">{index + 1} / {form.questions.length}</span></header>
    {form.description && <p className="bank-questionnaire-description">{form.description}</p>}
    <progress value={index + 1} max={form.questions.length} aria-label="问卷进度" />
    <AnimatePresence mode="wait" initial={false}><motion.div key={question.id} initial={reduce ? false : { opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: reduce ? 0 : .18 }}>
      <fieldset disabled={interaction.busy}><legend>{question.title}</legend><div className="bank-questionnaire-options">{question.options.map(option => <label key={option.id} className={selected === option.id ? 'is-selected' : ''}>
        <input type="radio" name={`${instance}-${question.id}`} checked={selected === option.id} value={option.id} onChange={() => { setAnswers(previous => ({ ...previous, [question.id]: option.id })); setSubmitted(false) }} />
        <span>{option.label}</span>
      </label>)}</div></fieldset>
    </motion.div></AnimatePresence>
    {submitted && <p role="status" className="bank-questionnaire-notice">答案已发送，可返回修改后重新提交。</p>}
    <div className="bank-agent-choice-actions"><Button className="bank-choice-button is-secondary" disabled={index === 0 || interaction.busy} onClick={() => setIndex(i => i - 1)}>上一题</Button>
      {last ? <Button className="bank-choice-button" disabled={!complete || interaction.busy || !interaction.enabled} onClick={() => { if (interaction.send(questionnaireMessage(form, answers)) !== false) setSubmitted(true) }}>提交答案</Button>
        : <Button className="bank-choice-button" disabled={!selected || interaction.busy} onClick={() => setIndex(i => i + 1)}>下一题</Button>}
    </div>
  </section>
}
