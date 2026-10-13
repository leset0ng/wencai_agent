import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
const logs = path.join(root, '.scratch', 'logs')
fs.mkdirSync(logs, { recursive: true })
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const logPath = path.join(logs, `run-${stamp}-${process.pid}.log`)
const maxLogBytes = 10 * 1024 * 1024
let logBytes = 0
const secrets = new Set()
let server
let worker
let activeChild
let stopping = false

function log(message) {
  let text = String(message)
  for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]')
  if (text.length > 16_384) text = `${text.slice(0, 16_384)}…[过长日志已截断]`
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}\n`
  process.stdout.write(line)
  const saved = stripVTControlCharacters(line)
  const size = Buffer.byteLength(saved)
  if (logBytes + size > maxLogBytes) {
    // Bound disk usage to the active file plus three 10 MB segments per run.
    if (fs.existsSync(`${logPath}.3`)) fs.unlinkSync(`${logPath}.3`)
    for (let index = 2; index >= 1; index--) {
      if (fs.existsSync(`${logPath}.${index}`)) fs.renameSync(`${logPath}.${index}`, `${logPath}.${index + 1}`)
    }
    if (fs.existsSync(logPath)) fs.renameSync(logPath, `${logPath}.1`)
    logBytes = 0
  }
  fs.appendFileSync(logPath, saved, 'utf8')
  logBytes += size
}

// Buffer complete lines so credentials split across output chunks are also hidden.
function relay(stream) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  stream.on('data', (chunk) => {
    pending += decoder.write(chunk)
    const lines = pending.split(/\r\n|\n|\r/)
    pending = lines.pop()
    for (const line of lines) log(line)
    if (pending.length > 65_536) {
      log(pending)
      pending = ''
    }
  })
  stream.on('end', () => {
    pending += decoder.end()
    if (pending) log(pending)
  })
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...options,
    })
    activeChild = child
    relay(child.stdout)
    relay(child.stderr)
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (activeChild === child) activeChild = undefined
      if (stopping || code === 0) resolve()
      else reject(new Error(`启动步骤失败（${signal ?? code}）：${path.basename(command)}`))
    })
  })
}

function available(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', (error) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false)
      else reject(error)
    })
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

function openBrowser(url) {
  if (process.argv.includes('--no-open')) return
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
  child.once('error', () => log(`无法自动打开浏览器，请手动访问 ${url}`))
  child.unref()
}

async function waitUntilReady(url) {
  const deadline = Date.now() + 90_000
  while (!stopping && server?.exitCode === null && Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/login`, { signal: AbortSignal.timeout(5000) })
      await response.arrayBuffer()
      if (response.ok) {
        log(`启动完成：首页 ${url}/  管理后台 ${url}/admin`)
        log('此窗口持续显示实时日志，按 Ctrl+C 停止服务。')
        openBrowser(`${url}/`)
        return
      }
    } catch {
      // Vite may still be starting or compiling its first page.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  if (!stopping && server?.exitCode === null) log('页面就绪检查超时，请根据实时日志排查。')
}

async function main() {
  log(`项目目录：${root}`)
  log(`实时日志同时保存到：${logPath}`)
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('请安装 Node.js 22 或更新版本。')
  const envFile = path.join(root, '.env.local')
  if (!fs.existsSync(envFile)) {
    fs.copyFileSync(path.join(root, '.env.example'), envFile)
    log('已创建 .env.local；请填写模型密钥后重新启动以启用 Agent。')
  }
  process.loadEnvFile(envFile)
  if (!process.env.CONFIRM_SECRET) {
    const secret = randomBytes(32).toString('hex')
    let content = fs.readFileSync(envFile, 'utf8')
    content = /^CONFIRM_SECRET=.*$/m.test(content)
      ? content.replace(/^CONFIRM_SECRET=.*$/m, `CONFIRM_SECRET=${secret}`)
      : `${content.trimEnd()}\nCONFIRM_SECRET=${secret}\n`
    fs.writeFileSync(envFile, content, 'utf8')
    process.env.CONFIRM_SECRET = secret
    log('已生成本地会话与确认签名密钥。')
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (value && /(?:API_KEY|SECRET|PASSWORD|TOKEN)$/.test(name)) secrets.add(value)
  }
  if (process.env.CONFIRM_SECRET.length < 16) throw new Error('.env.local 中的 CONFIRM_SECRET 至少需要 16 位。')

  const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!fs.existsSync(vite)) {
    log('首次运行：正在安装项目依赖……')
    const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'pnpm'
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm install --frozen-lockfile'] : ['install', '--frozen-lockfile']
    await run(command, args)
    if (stopping) return
  }
  if (!process.env.DEEPSEEK_API_KEY && !process.env.FALLBACK_BASE_URL) {
    log('尚未配置模型：页面可以使用，Agent 对话需要在 .env.local 填写密钥。')
  } else {
    log(`模型：${process.env.DEEPSEEK_API_KEY ? (process.env.DEEPSEEK_MODEL || 'deepseek-flash') : process.env.FALLBACK_MODEL || 'qwen3-32b'}（密钥已隐藏）`)
  }

  const database = process.env.DATABASE_URL || 'file:./data/bank.db'
  if (database.startsWith('file:')) {
    const databasePath = database.startsWith('file:/')
      ? fileURLToPath(new URL(database))
      : path.resolve(root, decodeURIComponent(database.slice(5).split('?')[0]))
    if (!fs.existsSync(databasePath)) {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true })
      log('首次运行：创建演示数据库并导入种子数据……')
      await run(process.execPath, [path.join(root, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'push', '--force'])
      if (stopping) return
      await run(process.execPath, ['--import=tsx', path.join(root, 'src', 'server', 'db', 'seed.ts')])
      if (stopping) return
    } else {
      log('使用已有数据库。')
    }
  }
  const initialPort = Number(process.env.PORT || new URL(process.env.PUBLIC_BASE_URL || 'http://localhost:3000').port || 3000)
  if (!Number.isInteger(initialPort) || initialPort < 1 || initialPort > 65535) throw new Error('启动端口无效。')
  let port = initialPort
  while (!(await available(port))) {
    if (++port > Math.min(initialPort + 20, 65535)) throw new Error('可用端口不足，请关闭之前的启动窗口后重试。')
  }
  if (port !== initialPort) log(`端口 ${initialPort} 已占用，改用 ${port}。`)
  const url = `http://127.0.0.1:${port}`
  process.env.PUBLIC_BASE_URL = url
  server = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  activeChild = server
  relay(server.stdout)
  relay(server.stderr)
  worker = spawn(process.execPath, ['--import=tsx', path.join(root, 'scripts', 'worker.ts')], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  relay(worker.stdout)
  relay(worker.stderr)
  worker.on('error', (error) => log(`自动任务服务启动失败：${error.message}`))
  worker.once('exit', (code) => {
    if (!stopping) {
      log(`自动任务服务意外退出（${code}），正在停止本次服务，请检查日志后重新启动。`)
      server?.kill('SIGTERM')
    }
  })
  const closed = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.once('close', (code, signal) => {
      if (stopping || code === 0) resolve()
      else reject(new Error(`服务退出（${signal ?? code}）。`))
    })
  })
  void waitUntilReady(url)
  await closed
  stopAll(false)
  process.exit(0)
}

function killProcess(child, signal = 'SIGTERM') {
  if (!child || child.killed || child.exitCode !== null) return
  try {
    child.kill(signal)
  } catch {}
}

function stopAll(force = false) {
  stopping = true
  const signal = force ? 'SIGKILL' : 'SIGTERM'
  killProcess(activeChild, signal)
  killProcess(server, signal)
  killProcess(worker, signal)
}

let sigintCount = 0
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    sigintCount++
    if (sigintCount > 1) {
      stopAll(true)
      process.exit(signal === 'SIGINT' ? 130 : 143)
    }
    if (stopping) return
    stopping = true
    log('正在停止服务……')
    stopAll(false)

    const timer = setTimeout(() => {
      stopAll(true)
      process.exit(signal === 'SIGINT' ? 130 : 143)
    }, 500)
    timer.unref()
  })
}

try {
  await main()
} catch (error) {
  log(`错误：${error.message}`)
  process.exitCode = 1
} finally {
  stopAll(true)
  process.exit(process.exitCode || 0)
}
