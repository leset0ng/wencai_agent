import type { Channel } from '#/server/policy/types'

/** 每次请求的服务端上下文。userId 来自会话认证，绝不来自模型参数。 */
export interface AgentContext {
  userId: string
  sessionId: string
  channel: Channel
  /** 仅确认服务写入，模型与客户端不能指定。 */
  authorization?: { level: 'yellow' | 'red'; actionId: string; payeeRisk?: { accountId: string; revision: number } }
}
