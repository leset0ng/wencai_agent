import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { phoneNumber } from 'better-auth/plugins'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { db, auth as authSchema } from '#/server/db/client'
import { env } from '#/server/env'
import { sendVerificationSMS } from '#/server/auth/step-up'
import { createAuthMiddleware, APIError } from 'better-auth/api'
import { eq } from 'drizzle-orm'
import { resolvePhoneNumber } from '#/lib/phone-number'
import { schema } from '#/server/db/client'
import { recordPhoneLogin } from '#/server/auth/onboarding'
import { runtimeLog } from '#/server/logging/runtime'

/**
 * 认证实例。仅负责「你是谁」，不涉及任何银行业务授权。
 *
 * 关键约定：
 * - userId 只由服务端从这里解析，绝不来自模型参数。
 * - 会话存库（stateful），登出/踢人立即生效。
 * - 交易密码等本地凭据存在 account.password，不用 better-auth 的邮箱密码体系。
 */
export const auth = betterAuth({
  baseURL: env.PUBLIC_BASE_URL,
  secret: env.CONFIRM_SECRET,
  trustedOrigins: [env.PUBLIC_BASE_URL, ...(['localhost', '127.0.0.1'].includes(new URL(env.PUBLIC_BASE_URL).hostname) ? ['localhost', '127.0.0.1'].map((host) => { const url = new URL(env.PUBLIC_BASE_URL); url.hostname = host; return url.origin }) : [])],
  database: drizzleAdapter(db, {
    provider: 'sqlite',
    schema: {
      ...authSchema,
      // better-auth 以小写 modelName 查找表；这里显式对齐
      user: authSchema.baUser,
      session: authSchema.baSession,
      account: authSchema.baAccount,
      verification: authSchema.baVerification,
    },
  }),
  user: {
    modelName: 'user',
    additionalFields: {},
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (!['/phone-number/send-otp', '/phone-number/verify'].includes(ctx.path)) return
      const phone = ctx.body?.phoneNumber
      if (typeof phone !== 'string' || !resolvePhoneNumber(phone).isValid || resolvePhoneNumber(phone).submissionNumber !== phone) throw new APIError('BAD_REQUEST', { message: '请输入有效的手机号' })
      if (ctx.path !== '/phone-number/verify' || ctx.body?.updatePhoneNumber) return
      const [existing] = await db.select({ id: authSchema.baUser.id }).from(authSchema.baUser).where(eq(authSchema.baUser.phoneNumber, phone))
      if (!existing && (ctx.body?.registration !== true || typeof ctx.body?.registrationName !== 'string' || !ctx.body.registrationName.trim() || ctx.body.registrationName.trim().length > 60)) throw new APIError('BAD_REQUEST', { message: '此手机号尚未注册，请先填写户名注册' })
      if (existing && ctx.body?.registration === true) throw new APIError('BAD_REQUEST', { message: '此手机号已注册，请直接登录' })
    }),
  },
  databaseHooks: {
    session: { create: { after: async (session, ctx) => {
      if (ctx?.path === '/phone-number/verify') await recordPhoneLogin(session.id, session.userId)
    } } },
    user: {
      create: {
        before: async (user, ctx) => {
          if (ctx?.path === '/phone-number/verify') return { data: { ...user, name: String(ctx.body?.registrationName ?? '').trim() } }
        },
        after: async (user) => {
          await db.insert(schema.users).values({ id: user.id, name: user.name }).onConflictDoNothing()
        },
      },
    },
  },
  session: {
    modelName: 'session',
    // 空闲 15 分钟未活动即过期（银行惯例）
    updateAge: 15 * 60,
    // 绝对有效期 12 小时
    expiresIn: 12 * 60 * 60,
  },
  account: {
    modelName: 'account',
    accountLinking: { enabled: false },
  },
  verification: { modelName: 'verification' },
  plugins: [
    phoneNumber({
      otpLength: 6,
      expiresIn: 300,
      // 生产必须配置短信通道；仅本地开发的登录验证码允许演示日志。
      sendOTP: async ({ phoneNumber: phone, code }) => {
        try {
          if (env.SMS_DELIVERY_URL) {
            await sendVerificationSMS(phone, code)
            runtimeLog('info', 'auth', '登录验证码已交付短信通道')
          } else if (env.AUTH_DEMO_MODE && process.env.NODE_ENV !== 'production') {
            console.log(`[auth] 演示登录验证码 ${phone}: ${code}`)
            runtimeLog('info', 'auth', '已生成演示登录验证码（仅服务端终端可见）')
          } else throw new Error('登录短信通道尚未配置')
        } catch (error) {
          runtimeLog('error', 'auth', error instanceof Error ? error.message : '登录验证码发送失败')
          throw error
        }
      },
      // 注册页提供户名，服务端 hook 校验；只有手机号 OTP 通过后才能开户。
      signUpOnVerification: {
        getTempEmail: (phone: string) => `${phone}@wencai.local`,
      },
    }),
    tanstackStartCookies(),
  ],
  advanced: {
    // 演示环境同时跑飞书（WebSocket 回调用不同来源）与 Web，这里信任自身来源
    disableCSRFCheck: false,
    useSecureCookies: env.PUBLIC_BASE_URL.startsWith('https'),
  },
  rateLimit: {
    // 认证端点开启限流，交易验证另有尝试计数及账户熔断。
    enabled: true,
  },
})

export type Auth = typeof auth
