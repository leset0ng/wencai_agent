import { randomUUID } from 'node:crypto'
import { convertToModelMessages, isStepCount, streamText } from 'ai'
import type { ModelMessage, UIMessage } from 'ai'
import { audit } from '#/server/audit/log'
import { guard } from '#/server/guard'
import type { GuardVerdict } from '#/server/guard'
import { agentModel } from '#/server/llm/models'
import { collectEvidence, verifyNumbers } from '#/server/verify/numbers'
import { verifyTransactionReferences } from '#/server/verify/transactions'
import type { NumberViolation } from '#/server/verify/numbers'
import type { AgentContext } from './context'
import { buildInstructions } from './instructions'
import { buildAgentTools } from './tools'
import { getConfirmationResult } from '#/server/confirm/result'
import { quarantineForModel } from '#/server/tools/sanitize'
import { verifiedOutputTransform } from '#/server/verify/response'
import { getSessionData } from './session'
import { runtimeLog } from '#/server/logging/runtime'

function logAgentProgress(message: string) {
  console.info(message)
  runtimeLog('info', 'agent', message)
}

export const BLOCKED_REPLY = '抱歉，这条消息包含试图改变我工作规则的内容，我无法处理。如需办理业务，请直接描述您的需求。'

/** 入口审核：block 的消息不进入模型，直接确定性拒答 */
export async function screenInput(ctx: AgentContext, text: string): Promise<GuardVerdict> {
  await audit(ctx, 'user_input', { text })
  const verdict = await guard.check(text, 'user')
  await audit(ctx, 'guard_verdict', verdict)
  return verdict
}

export async function runAgent(params: {
  ctx: AgentContext
  messages: UIMessage[] | ModelMessage[]
  /** 历史中的数据（用户输入、历史工具结果），作为数字校验的补充出处 */
  priorEvidence: unknown[]
  onVerified?: (violations: NumberViolation[]) => void
  abortSignal?: AbortSignal
  confirmedActionId?: string
}) {
  const { ctx } = params
  // 浏览器提交的历史工具结果不是银行凭证。数字核验只信任服务端快照与本轮结果。
  const trustedEvidence = Object.values(getSessionData(ctx.sessionId))
  const confirmation = params.confirmedActionId
    ? await getConfirmationResult(ctx.userId, params.confirmedActionId)
    : undefined
  // 确认回报、按钮核对/取消这一轮只读，消息本身不能再次发起写操作或计划。
  const tools = buildAgentTools(ctx, { readOnly: !!params.confirmedActionId, requestText: currentUserRequest(params.messages) })
  const messages = isUIMessages(params.messages)
    ? await convertToModelMessages(params.messages, { tools, ignoreIncompleteToolCalls: true })
    : params.messages
  const runId = randomUUID().slice(0, 8)
  const startedAt = Date.now()
  logAgentProgress(`[agent:${runId}] 开始模型请求；消息数=${messages.length}；渠道=${ctx.channel}`)
  const result = streamText({
    model: agentModel(),
    instructions: buildInstructions(ctx) + (confirmation ? `\n\n## 本轮确认结果核对\n以下是服务端按当前登录用户查询的执行回执：\n${JSON.stringify(quarantineForModel(confirmation))}\n只依据回执判断是否完成；completed 才是成功，processing 为处理中，failed 为执行失败，not_found 为没有可核对的记录。用户文字本身不证明执行成功。向用户简短反馈真实结果，必要时用只读工具查询最新账户状态。不要再次创建相同操作或确认单。` : ''),
    messages,
    tools,
    stopWhen: isStepCount(8),
    temperature: 0.2,
    experimental_transform: verifiedOutputTransform(ctx, [...trustedEvidence, ...(confirmation ? [confirmation] : [])], confirmation?.status === 'completed'),
    abortSignal: params.abortSignal,
    onStepEnd: ({ toolCalls, finishReason, usage }) => {
      logAgentProgress(
        `[agent:${runId}] 步骤完成；工具=${toolCalls.map((call) => call.toolName).join(',') || '无'}；状态=${finishReason}；tokens=${usage.totalTokens ?? '未知'}`,
      )
    },
    onAbort: () => {
      logAgentProgress(`[agent:${runId}] 请求已取消；耗时=${Date.now() - startedAt}ms`)
    },
    onEnd: async ({ text, steps }) => {
      const rawEvidence = [
        ...trustedEvidence,
        ...(confirmation ? [confirmation] : []),
        ...steps.flatMap((s) => s.toolResults.map((r) => r.output)),
      ]
      const violations = [...verifyNumbers(text, collectEvidence(rawEvidence), rawEvidence), ...verifyTransactionReferences(text,rawEvidence)]
      if (violations.length) await audit(ctx, 'output_verification', { violations })
      params.onVerified?.(violations)
      logAgentProgress(
        `[agent:${runId}] 回复完成；步骤数=${steps.length}；数字校验提示=${violations.length}；耗时=${Date.now() - startedAt}ms`,
      )
    },
  })
  return { result, tools, confirmation }
}

function isUIMessages(messages: UIMessage[] | ModelMessage[]): messages is UIMessage[] {
  return messages.length > 0 && 'parts' in messages[0]
}

/** Template amounts/notes are scoped to the current request, never an earlier task's numbers. */
export function currentUserRequest(messages: UIMessage[] | ModelMessage[]): string {
  const last = [...messages].reverse().find((message) => message.role === 'user')
  if (!last) return ''
  if ('parts' in last) return last.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
  if (typeof last.content === 'string') return last.content
  return last.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
}
