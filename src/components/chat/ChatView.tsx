import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowUp, Loader2, ReceiptText, Send, Square } from 'lucide-react'
import type { WencaiUIMessage } from '#/server/agent/messages'
import { AgentAvatar } from '#/components/banking/AgentAvatar'
import ToolPart from './ToolPart'
import { toolPresentations } from './presentation'
import AssistantText, { presentedTables } from './AssistantText'
import { subscribeConfirmations } from '#/lib/confirmation-notices'
import ConfirmCard from './ConfirmCard'
import { MotionMessage, ThinkingDots } from '#/components/ui/motion'
import { AgentInteractionContext, AgentInteractionGroup } from './AgentInteraction'
import { interactionSnapshot, InteractionMemory, type AgentMessageOptions } from './interaction-message'

const SUGGESTIONS = [
  { label: '查一下本月支出', prompt: '帮我分析本月支出并用图表展示分类', icon: ReceiptText },
  { label: '给妈妈转 200 元', prompt: '给妈妈转200元', icon: Send },
]

export default function ChatView({
  request,
  active = true,
  userId,
}: {
  request?: { id: number; text: string }
  active?: boolean
  userId?: string
}) {
  const client = useQueryClient()
  const { messages, sendMessage, status, error, stop } = useChat<WencaiUIMessage>({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
    onFinish: () => {
      void client.invalidateQueries({ queryKey: ['dashboard'] })
      void client.invalidateQueries({ queryKey: ['confirm'] })
      void client.invalidateQueries({ queryKey: ['plans'] })
    },
  })
  const [input, setInput] = useState('')
  const interactionMemory = useRef(new InteractionMemory())
  useEffect(() => { if (messages.length) interactionMemory.current.remember(interactionSnapshot(messages, messages.length - 1)) }, [messages])
  const [sendError, setSendError] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const followScroll = useRef(true)
  const handledRequest = useRef<number | undefined>(undefined)
  const seenConfirmations = useRef(new Set<string>())
  const [confirmations, setConfirmations] = useState<string[]>([])
  const [failedConfirmation, setFailedConfirmation] = useState<string>()
  const dispatching = useRef(false)
  const [sending, setSending] = useState(false)
  const activeConfirmation = useRef<string | undefined>(undefined)
  const busy = status === 'submitted' || status === 'streaming'
  const [stoppedNotice, setStoppedNotice] = useState('')
  useEffect(() => { if (status === 'submitted') setStoppedNotice('') }, [status])
  /**
   * 停止不只是停下文字输出：服务端会让正在执行的计划停在当前步骤并标记为已暂停。
   * 这里在停止后查一次，把结果告诉用户，避免留下一个用户不知道的计划。
   */
  async function stopAndReport() {
    await stop()
    await new Promise((resolve) => setTimeout(resolve, 1000))
    void client.invalidateQueries({ queryKey: ['plans'] })
    try {
      const res = await fetch('/api/plans')
      const data = (await res.json()) as { plans?: { status: string; updatedAt: string; state: { plan: { goal: string } } }[] }
      const paused = data.plans?.find((plan) => plan.status === 'paused' && Date.now() - new Date(plan.updatedAt).getTime() < 120_000)
      setStoppedNotice(paused
        ? `已停止。计划「${paused.state.plan.goal}」已暂停在当前步骤，已完成的步骤不会撤销；可在生活页的任务中心恢复或取消。`
        : '已停止回答。')
    } catch {
      setStoppedNotice('已停止回答。')
    }
  }
  useEffect(() => subscribeConfirmations((notice) => {
    if (notice.userId !== userId || seenConfirmations.current.has(notice.actionId)) return
    seenConfirmations.current.add(notice.actionId)
    setConfirmations((queue) => [...queue, notice.actionId])
  }), [userId])
  useEffect(() => {
    if (status === 'error' && activeConfirmation.current) {
      setFailedConfirmation(activeConfirmation.current)
      setSendError('自动核对暂未完成，操作已确认成功，可重试核对。')
    }
  }, [status])

  useEffect(() => {
    const scroll = scrollRef.current
    if (active && followScroll.current && scroll)
      scroll.scrollTo({
        top: scroll.scrollHeight,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      })
  }, [messages, active, busy])
  const send = (text: string, options?: AgentMessageOptions) => {
    if (!text.trim() || busy || dispatching.current) return false
    dispatching.current = true
    setSending(true)
    activeConfirmation.current = undefined
    followScroll.current = true
    setSendError('')
    void sendMessage({ text }, options ? { body: options } : undefined).catch(() => setSendError('消息发送失败，请稍后重试')).finally(() => { dispatching.current = false; setSending(false) })
    setInput('')
    return true
  }
  useEffect(() => {
    if (busy || dispatching.current) return
    const actionId = confirmations[0]
    if (!actionId && (!request || handledRequest.current === request.id)) return
    if (actionId) setConfirmations((queue) => queue.slice(1))
    else handledRequest.current = request!.id
    dispatching.current = true
    setSending(true)
    activeConfirmation.current = actionId
    followScroll.current = true
    setSendError('')
    setFailedConfirmation(undefined)
    void (async () => {
      let text = request?.text ?? ''
      if (actionId) {
        const response = await fetch(`/api/confirm?actionId=${encodeURIComponent(actionId)}`, { credentials: 'same-origin' })
        if (!response.ok) throw new Error('无法读取本次确认摘要')
        const receipt = await response.json() as { summary: { title: string; fields: { label: string; value: string }[] } }
        text = `我已核对并确认${receipt.summary.title}（${receipt.summary.fields.map((field) => `${field.label}：${field.value}`).join('；')}）。请仅按服务端回执核对执行结果，不要再次执行。`
      }
      await sendMessage({ text }, actionId ? { body: { confirmedActionId: actionId } } : undefined)
    })().catch(() => {
      setSendError(actionId ? '自动核对暂未完成，操作已确认成功，可重试核对。' : '消息发送失败，请稍后重试')
      if (actionId) setFailedConfirmation(actionId)
    }).finally(() => { dispatching.current = false; setSending(false) })
  }, [request, busy, sendMessage, confirmations, sending])

  return (
    <>
      <div
        className="bank-chat-scroll"
        ref={scrollRef}
        onWheel={(event) => {
          if (event.deltaY < 0) followScroll.current = false
        }}
        onPointerDown={() => {
          followScroll.current = false
        }}
        onKeyDown={(event) => {
          if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) followScroll.current = false
        }}
        onScroll={() => {
          const el = scrollRef.current
          if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 40)
            followScroll.current = true
        }}
      >
        <div className="bank-agent-welcome">
          <span className="bank-agent-eyebrow">你的专属银行助手</span>
          <h2>说句话，就能办业务</h2>
          <p>查账户、转账、看账单，我来帮你</p>
          <div className="bank-agent-suggestions">
            {SUGGESTIONS.map(({ label, prompt, icon: Icon }) => (
              <Button
                key={label}
                className="bank-lift"
                disabled={busy}
                onClick={() => send(prompt)} type="button"
              >
                <Icon size={17} />
                {label}
              </Button>
            ))}
          </div>
        </div>
        <div
          className="bank-chat-messages"
          aria-label="对话记录"
          aria-live="polite"
          aria-busy={busy}
        >
          {messages.map((message, messageIndex) => {
            const processing = busy && messageIndex === messages.length - 1
            const presentation = toolPresentations(message.parts, processing)
            const tables = presentedTables(message.parts, presentation)
            return (
              <MotionMessage
                key={message.id}
                className={`bank-message ${message.role === 'user' ? 'is-user' : 'is-assistant'}`}
              >
                {message.role !== 'user' && <AgentAvatar small />}
                <AgentInteractionContext.Provider value={{ send, enabled: true, busy: busy || sending, snapshot: interactionSnapshot(messages, messageIndex), memory: interactionMemory.current }}><div className="bank-message-content"><AgentInteractionGroup active={message.role === 'assistant' && !processing} securityConfirmation={message.parts.some((part) => 'output' in part && !!part.output && typeof part.output === 'object' && 'status' in part.output && ['needs_confirmation', 'needs_handoff', 'plan'].includes(String(part.output.status)))}>
                  {message.parts.map((part, index) => {
                    const key = `${message.id}-${index}`
                    if (part.type === 'text')
                      return message.role === 'user' ? (
                        <p key={key} className="bank-user-bubble">
                          {part.text}
                        </p>
                      ) : (
                        <AssistantText key={key} text={part.text} tables={tables} processing={processing} />
                      )
                    if (part.type === 'data-confirmation') {
                      const receipt = part.data
                      // 对话里已有原确认卡时保留其完成态；表单/H5 发起的操作补充固定回执。
                      const hasCard = messages.some((item) => item.parts.some((candidate) =>
                        candidate.type.startsWith('tool-') && 'output' in candidate &&
                        candidate.output && typeof candidate.output === 'object' &&
                        'actionId' in candidate.output && candidate.output.actionId === receipt.actionId,
                      ))
                      if (hasCard || receipt.status !== 'completed' || !('summary' in receipt)) return null
                      return <ConfirmCard key={key} actionId={receipt.actionId} level="yellow" reasons={[]} summary={receipt.summary} done="操作已完成，执行结果已核对" doneState="success" />
                    }
                    if (part.type === 'data-verify')
                      return (
                        <p key={key} className="bank-verification-note">
                          ⚠ 以下数字尚未核实：
                          {part.data.violations.map((violation) => violation.text).join('、')}
                          。请以数据卡片为准。
                        </p>
                      )
                    if (part.type === 'data-blocked')
                      return (
                        <p key={key} className="bank-verification-note">
                          安全审核已拦截：{part.data.categories.join('、')}
                        </p>
                      )
                    if (part.type.startsWith('tool-'))
                      return presentation[index] === 'hidden' ? null : (
                        <div className="bank-tool-result" key={key}>
                          <ToolPart
                            part={part as never}
                            summarized={presentation[index] === 'status'}
                          />
                        </div>
                      )
                    return null
                  })}
                </AgentInteractionGroup></div></AgentInteractionContext.Provider>
              </MotionMessage>
            )
          })}
          {status === 'submitted' && (
            <div className="bank-thinking">
              <AgentAvatar small />
              <span>
                文财正在思考
                <ThinkingDots />
              </span>
            </div>
          )}
        </div>
        {stoppedNotice && !busy && <p className="bank-agent-disclaimer" role="status">{stoppedNotice}</p>}
        {(error || sendError) && (
          <div className="bank-chat-error" role="alert">
            {sendError || '暂时无法连接文财，请稍后重新发送。'}
            <small>智能助手不可用时，关闭此面板仍可在首页办理转账、卡片管理，并在任务中心处理进行中的计划。</small>
            {failedConfirmation && <Button type="button" disabled={busy} className="bank-text-button" onClick={() => {
              setConfirmations((queue) => [...queue, failedConfirmation])
              setFailedConfirmation(undefined)
              setSendError('')
            }}>重新核对结果</Button>}
          </div>
        )}
      </div>
      <form
        className="bank-chat-composer"
        onSubmit={(event) => {
          event.preventDefault()
          send(input)
        }}
      >
        <span className="bank-composer-mark" aria-hidden="true">
          <ReceiptText size={20} />
        </span>
        <Input
          data-autofocus
          aria-label="发送给文财的消息"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="想办什么业务？"
          autoComplete="off"
          maxLength={4000}
        />
        {busy ? (
          <Button
            className="bank-send bank-lift"
            type="button"
            aria-label="停止回答"
            onClick={() => void stopAndReport()}
          >
            {status === 'submitted' ? (
              <Loader2 size={20} className="bank-spin" />
            ) : (
              <Square size={18} />
            )}
          </Button>
        ) : (
          <Button
            type="submit"
            aria-label="发送消息"
            className="bank-send bank-lift"
            disabled={!input.trim()}
          >
            <ArrowUp size={24} />
          </Button>
        )}
      </form>
      <p className="bank-agent-disclaimer">敏感操作须由你确认，请以银行数据为准</p>
    </>
  )
}
