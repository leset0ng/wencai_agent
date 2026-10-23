/** @jsxImportSource chat */
import { Actions, Button, Card, CardText, Chat, Field, Fields } from 'chat'
import { createMemoryState } from '@chat-adapter/state-memory'
import { createLarkAdapter } from '@larksuite/vercel-chat-adapter'
import type { ModelMessage } from 'ai'
import { BLOCKED_REPLY, runAgent, screenInput } from '#/server/agent/run'
import type { AgentContext } from '#/server/agent/context'
import { confirmFromLark } from './lark-confirm'
import { cancelActionAndPlan } from '#/server/executor/service'
import { resolveChannelUser } from '#/server/session'
import { audit } from '#/server/audit/log'
import { bindLink, createBindCode } from '#/server/auth/bind'
import type { ToolOutcome } from '#/server/tools/define'

/**
 * 飞书渠道。红色操作直接转 H5；黄色操作若需要银行卡/资金账户安全凭据，
 * 或执行前升级为红色，也沿用原确认单转 H5，不能用聊天按钮替代验证。
 */

/** 渠道身份只能来自绑定表：未绑定的飞书账号查不到任何账户数据 */
async function bankUserFor(larkUserId: string): Promise<string | null> {
  const userId = await resolveChannelUser('lark', larkUserId)
  if (!userId) await audit({ userId: 'anonymous', sessionId: `lark:unbound:${larkUserId}`, channel: 'lark' }, 'bind_rejected', { reason: 'unbound_channel_user' })
  return userId
}

// 骨架阶段：每个会话线程的模型消息历史保存在内存
const histories = new Map<string, ModelMessage[]>()

export function createLarkBot() {
  const bot = new Chat({
    userName: process.env.LARK_BOT_USERNAME ?? 'wencai',
    adapters: { lark: createLarkAdapter() },
    state: createMemoryState(),
  })

  const handle = async (thread: Parameters<Parameters<typeof bot.onDirectMessage>[0]>[0], message: { text: string; author: { userId: string } }) => {
    const userId = await bankUserFor(message.author.userId)
    if (!userId) {
      const code = await createBindCode('lark', message.author.userId)
      await thread.post(`请先绑定文财账号：${bindLink(code)}`)
      return
    }
    const ctx: AgentContext = { userId, sessionId: `lark:${thread.id}`, channel: 'lark' }
    const verdict = await screenInput(ctx, message.text)
    if (verdict.verdict === 'block') {
      await thread.post(BLOCKED_REPLY)
      return
    }

    const history = histories.get(thread.id) ?? []
    history.push({ role: 'user', content: message.text })
    const { result } = await runAgent({ ctx, messages: history, priorEvidence: [message.text], abortSignal: thread.signal })
    await thread.post(result.fullStream)

    const response = await result.response
    history.push(...response.messages)
    histories.set(thread.id, history.slice(-30))

    for (const step of await result.steps) {
      for (const r of step.toolResults) await postOutcomeCard(thread, r.output as ToolOutcome)
    }
  }

  bot.onDirectMessage(handle)
  bot.onNewMention(async (thread, message) => {
    await thread.subscribe()
    await handle(thread, message)
  })
  bot.onSubscribedMessage(handle)

  bot.onAction(['confirm', 'cancel'], async (event) => {
    const userId = await bankUserFor(event.user.userId)
    if (!userId || !event.value || !event.thread) return
    // 操作必须属于该绑定的银行用户，否则拒绝（confirmPending 会再次校验归属）
    const ctx: AgentContext = { userId, sessionId: `lark:${event.threadId}`, channel: 'lark' }
    if (event.actionId === 'cancel') {
      await cancelActionAndPlan(ctx, event.value)
      await event.thread.post('已取消。')
      return
    }
    // confirmPending 会校验点击者即操作所属用户、完整性、时效与一次性
    const { result: res, message: reply } = await confirmFromLark(ctx, event.value)
    await event.thread.post(reply)
    if (res.ok && res.plan) for (const node of Object.values(res.plan.nodes)) await postOutcomeCard(event.thread, node.output as ToolOutcome)
  })

  return bot
}

async function postOutcomeCard(thread: { post: (m: never) => Promise<unknown> }, outcome: ToolOutcome | undefined) {
  if (!outcome || typeof outcome !== 'object') return
  if (outcome.status === 'needs_confirmation') {
    await thread.post(
      (
        <Card title={outcome.summary.title} subtitle={outcome.reasons.join('；') || '请核对后确认'}>
          <Fields>
            {outcome.summary.fields.map((f) => (
              <Field label={f.label} value={f.value} />
            ))}
          </Fields>
          <Actions>
            <Button id="confirm" value={outcome.actionId} style="primary">确认</Button>
            <Button id="cancel" value={outcome.actionId} style="danger">取消</Button>
          </Actions>
        </Card>
      ) as never,
    )
  } else if (outcome.status === 'needs_handoff') {
    await thread.post(
      (
        <Card title={outcome.summary.title} subtitle="该操作需要在 App 内完成强验证">
          <CardText>{outcome.reasons.join('；')}</CardText>
          <CardText>{`[前往验证](${outcome.url})`}</CardText>
        </Card>
      ) as never,
    )
  }
}
