import { serve } from '@hono/node-server'
import { createDemoSmsApp } from './demo-sms-app.mjs'

if (process.env.AUTH_DEMO_MODE !== 'true' || !process.env.SMS_DELIVERY_TOKEN || process.env.SMS_DELIVERY_TOKEN.length < 32) {
  throw new Error('演示短信仅允许显式开启演示模式并配置独立访问密钥后启动')
}
serve({ fetch: createDemoSmsApp({ enabled: true, token: process.env.SMS_DELIVERY_TOKEN }).fetch, hostname: '0.0.0.0', port: 3100 })
console.info('[demo-sms] 私有演示短信适配器已启动，验证码仅显示在项目日志')
