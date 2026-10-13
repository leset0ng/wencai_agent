import { Button } from '#/components/ui/button'
import { useRef, useState } from 'react'
import { ConfirmError } from '#/lib/queries'
import { useStrongVerification } from '#/components/ui/StrongVerification'
import type { ConfirmSummary } from '#/server/tools/define'
import './confirm-card.css'

export interface ConfirmCardProps {
  actionId: string
  level: 'yellow' | 'red'
  reasons: string[]
  /** 服务端根据已校验参数生成的摘要；不渲染任何模型文字 */
  summary: ConfirmSummary
  expiresAt?: number
  /** 外部提交态（由 Query mutation 驱动） */
  submitting?: boolean
  /** 外部错误文案；step_up_failed 由调用方判断是否可重试 */
  error?: string
  /** 确认。stepUp 仅红色操作会传。 */
  onConfirm?: (stepUp?: StepUpPayload) => void | Promise<void>
  /** 取消。 */
  onCancel?: () => void
  /** 已完成的展示态（外部在成功后置 true） */
  done?: string
  doneState?: 'success' | 'cancelled' | 'failed'
}

export type StepUpPayload = import('#/server/auth/step-up').StrongStepUp

/**
 * 安全关键组件：内容全部来自服务端生成的 summary，不渲染任何模型文字。
 * 黄色：一键确认；红色：绑定手机短信或 Passkey 强验证。
 */
export default function ConfirmCard(props: ConfirmCardProps) {
  const [message, setMessage] = useState<string>()
  const confirming = useRef(false)
  const [verifying, setVerifying] = useState(false)
  const [escalated, setEscalated] = useState(false)
  const [latestReasons, setLatestReasons] = useState<string[]>()
  const red = props.level === 'red' || escalated
  const submitting = props.submitting || verifying
  const state = props.done ? (props.doneState ?? 'success') : 'pending'
  const verification = useStrongVerification({ purpose: 'action', actionId: props.actionId }, !!submitting)

  async function confirm() {
    if (confirming.current || submitting || props.done) return
    confirming.current = true
    setVerifying(true)
    setMessage(undefined)
    try {
      // 强验证的 stepUp 只在红色操作时构造；Passkey 用浏览器 API 现取 challenge
      const stepUp: StepUpPayload | undefined = red ? await verification.getProof() : undefined
      await props.onConfirm?.(stepUp)
    } catch (err) {
      if (err instanceof ConfirmError && err.data.requiredLevel === 'red') setEscalated(true)
      if (err instanceof ConfirmError && err.data.reasons) setLatestReasons(err.data.reasons)
      // 错误由 props.error 展示；这里不再自行维护错误态
      setMessage(err instanceof Error ? err.message : '验证失败')
    } finally {
      confirming.current = false
      setVerifying(false)
    }
  }

  return (
    <div className={`bank-confirm-card is-${state}${red ? ' is-strong' : ''}`}>
      <div className="mb-3 flex items-center justify-between">
        <p className="m-0 font-semibold text-[var(--sea-ink)]">{props.summary.title}</p>
        <span className="bank-confirm-badge">
          {props.done ? ({ success: '已完成', cancelled: '已取消', failed: '未完成' }[state as 'success' | 'cancelled' | 'failed']) : red ? '强验证' : '需确认'}
        </span>
      </div>
      <dl className="m-0 space-y-1.5 text-sm">
        {props.summary.fields.map((f) => (
          <div key={f.label} className="flex justify-between gap-4">
            <dt className="text-[var(--sea-ink-soft)]">{f.label}</dt>
            <dd className="m-0 text-right font-medium text-[var(--sea-ink)]">{f.value}</dd>
          </div>
        ))}
      </dl>
      {(latestReasons ?? props.reasons).length > 0 && (
        <ul className="mt-3 mb-0 list-none space-y-0.5 p-0 text-xs text-[var(--sea-ink-soft)]">
          {(latestReasons ?? props.reasons).map((r) => (
            <li key={r}>· {r}</li>
          ))}
        </ul>
      )}

      {props.done ? (
        <p className="bank-confirm-status" role="status">{state === 'success' ? '✓ ' : ''}{props.done}</p>
      ) : (
        <div className="mt-4 space-y-2">
          {red && verification.controls}
          <div className="flex gap-2">
            <Button type="button" onClick={() => props.onCancel?.()} disabled={submitting} className="bank-confirm-cancel bank-lift flex-1 rounded-full border border-[var(--line)] py-2 text-sm">
              取消
            </Button>
            <Button
              onClick={() => void confirm()}
              type="button"
              disabled={submitting || !props.onConfirm || (red && !verification.ready)}
              className="bank-confirm-submit bank-lift flex-1 rounded-full py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {submitting ? '处理中…' : '确认'}
            </Button>
          </div>
          {(message ?? props.error) && <p className="m-0 text-center text-xs text-red-600">{message ?? props.error}</p>}
        </div>
      )}
    </div>
  )
}
