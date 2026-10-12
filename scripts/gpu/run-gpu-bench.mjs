#!/usr/bin/env node
/**
 * 用系统自带的 Chrome / Edge 跑 WebGPU 计算基准（**零 npm 依赖**）。
 *
 * 为什么这么写：Node 没有内置 WebGPU，而装 Dawn/OpenCL 绑定要编译原生模块。
 * 但 Chrome 113+ 自带 WebGPU，且 **Node 22 自带 `fetch` 与 `WebSocket`**，
 * 于是用 Chrome DevTools Protocol 直接驱动 headless Chrome 就够了 —— 不用装任何东西。
 *
 * 用法：
 *   node scripts/gpu/run-gpu-bench.mjs [局面数=65536] [重复=5]
 *   BROWSER=edge node scripts/gpu/run-gpu-bench.mjs 200000 5
 *
 * 退出码：0 = 跑成功（无论 GPU 是否可用，结果都会打印）；1 = 起浏览器/连 CDP 失败。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const COUNT = Number(process.argv[2] ?? 65536)
const REPEATS = Number(process.argv[3] ?? 5)
const PORT = 9333 + (process.pid % 200)

const CHROME_CANDIDATES = {
  chrome: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ],
  edge: [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ],
}

function findBrowser() {
  const want = (process.env.BROWSER ?? 'chrome').toLowerCase()
  const order = want === 'edge' ? ['edge', 'chrome'] : ['chrome', 'edge']
  for (const name of order) {
    for (const p of CHROME_CANDIDATES[name]) {
      if (existsSync(p)) return { name, path: p }
    }
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForCdp(port, timeoutMs = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return await res.json()
    } catch {
      /* 还没起来 */
    }
    await sleep(200)
  }
  throw new Error(`CDP 在 ${timeoutMs}ms 内没起来（端口 ${port}）`)
}

async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  return await res.json()
}

/** 极简 CDP 客户端：只需要 Runtime.evaluate 与关闭。 */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  /** 在页面里求值（支持 await；返回值按值取回）。 */
  async eval(expression, { awaitPromise = false, timeoutMs = 0 } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      timeout: timeoutMs || undefined,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? '页面内抛出异常')
    }
    return r.result?.value
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => resolve(new Cdp(ws)))
    ws.addEventListener('error', (e) => reject(new Error('WebSocket 连接失败: ' + (e.message ?? ''))))
  })
}

const browser = findBrowser()
if (!browser) {
  console.error('❌ 没找到 Chrome / Edge。装了其中之一，或设 BROWSER=edge。')
  process.exit(1)
}

const htmlPath = resolve(import.meta.dirname, 'webgpu-eval.html')
if (!existsSync(htmlPath)) {
  console.error(`❌ 找不到 ${htmlPath}`)
  process.exit(1)
}
const pageUrl = 'file:///' + htmlPath.replace(/\\/g, '/')

const profileDir = mkdtempSync(join(tmpdir(), 'wb-gpu-'))
const child = spawn(
  browser.path,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    // WebGPU 在 headless 下需要显式打开；--enable-unsafe-webgpu 兼容较旧版本
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,WebGPU',
    '--use-angle=d3d11',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    pageUrl,
  ],
  { stdio: 'ignore', windowsHide: true },
)

let exitCode = 0
try {
  const version = await waitForCdp(PORT)
  console.log(`🌐 浏览器：${browser.name} · ${version.Browser}`)
  console.log(`   页面：${pageUrl}`)

  // 找到承载页面的 target
  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    const list = await listTargets(PORT)
    target = list.find((t) => t.type === 'page' && t.url.startsWith('file://')) ?? null
    if (!target) await sleep(250)
  }
  if (!target) throw new Error('没找到页面 target')

  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')

  // 等页面脚本就绪
  for (let i = 0; i < 40; i++) {
    const ready = await cdp.eval('typeof window.__runGpuBench === "function"')
    if (ready) break
    await sleep(250)
  }

  console.log(`\n▶ 基准：${COUNT} 个局面 × ${REPEATS} 次重复\n${'─'.repeat(64)}`)
  const result = await cdp.eval(
    `window.__runGpuBench({ count: ${COUNT}, repeats: ${REPEATS} })`,
    { awaitPromise: true },
  )

  if (result?.lines?.length) console.log(result.lines.join('\n'))
  if (!result?.ok) exitCode = 1
} catch (err) {
  console.error('❌ ' + (err?.message ?? err))
  exitCode = 1
} finally {
  child.kill()
  await sleep(300)
  try {
    rmSync(profileDir, { recursive: true, force: true })
  } catch {
    /* 浏览器可能还占着文件，忽略 */
  }
}
process.exit(exitCode)
