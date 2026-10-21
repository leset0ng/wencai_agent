import type { Channel } from '#/server/policy/types'

/** 每次请求的服务端上下文。userId 来自会话认证，绝不来自模型参数。 */
export interface AgentContext {
  userId: string
  sessionId: string
  channel: Channel
  /** 服务端注入的当前用户原文，仅用于建议参数出处核对，不参与授权。 */
  requestText?: string
  /** 仅确认服务写入，模型与客户端不能指定。 */
  authorization?: { level: 'yellow' | 'red'; actionId: string; secureRequestId?: string; payeeRisk?: { accountId: string; revision: number } }
}
