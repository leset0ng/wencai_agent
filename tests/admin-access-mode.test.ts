import { afterEach, expect, it, vi } from 'vitest'
const { config } = vi.hoisted(() => ({ config: { ADMIN_ENABLED:true,AUTH_DEMO_MODE:true,ADMIN_TOKEN:'admin-test-credential-at-least-24',PUBLIC_BASE_URL:'https://demo.bank.test' } }))
vi.mock('#/server/env',()=>({env:config}))
import { adminAuthorized } from '#/server/admin/access'
const request=(token?:string)=>new Request('https://demo.bank.test/api/admin',{headers:token?{authorization:`Bearer ${token}`}:{}})
afterEach(()=>{config.ADMIN_ENABLED=true;config.AUTH_DEMO_MODE=true;config.ADMIN_TOKEN='admin-test-credential-at-least-24'})
it('演示模式无需登录或后台凭据，包括部署地址及已配置token的情况',()=>{
  expect(adminAuthorized(request())).toBe(true)
  expect(adminAuthorized(request('outdated-token'))).toBe(true)
})
it('非演示模式必须通过原有凭据校验',()=>{
  config.AUTH_DEMO_MODE=false
  expect(adminAuthorized(request())).toBe(false)
  expect(adminAuthorized(request('wrong'))).toBe(false)
  expect(adminAuthorized(request(config.ADMIN_TOKEN))).toBe(true)
})
it('演示模式不能越过后台禁用总开关',()=>{
  config.ADMIN_ENABLED=false
  expect(adminAuthorized(request())).toBe(false)
})
it('非演示部署未配置凭据时不能匿名访问',()=>{
  config.AUTH_DEMO_MODE=false;config.ADMIN_TOKEN=''
  expect(adminAuthorized(request())).toBe(false)
})
