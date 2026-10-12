#!/usr/bin/env node
/**
 * 零依赖的「headless Chrome / Edge + CDP」驱动（从 `run-gpu-bench.mjs` 抽出来复用）。
 *
 * 为什么要它：Node 没有内置 WebGPU，但 Chrome 113+ 自带；而 **Node 22 内置 `fetch` 与
 * `WebSocket`**，于是不需要装任何 npm 包（Dawn / OpenCL 原生绑定都免了）。
 *
 * ⚠️ 两个踩过的坑：
 *  1. `--dump-dom` + `--virtual-time-budget` **抓不到异步结果** —— 虚拟时间不推进 promise，
 *     页面会永远停在 `pending`。必须用 `Runtime.evaluate({awaitPromise:true})`。
 *  2. `file://` 下 `fetch()` 被 CORS 挡死 ⇒ 传二进制数据要给页面起一个本地 http 服务
 *     （`startStaticServer`）。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { tmpdir } from 'node:os'

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

export function findBrowser() {
  const want = (process.env.BROWSER ?? 'chrome').toLowerCase()
  const order = want === 'edge' ? ['edge', 'chrome'] : ['chrome', 'edge']
  for (const name of order) {
    for (const p of CHROME_CANDIDATES[name]) if (existsSync(p)) return { name, path: p }
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.wgsl': 'text/plain; charset=utf-8',
  /**
   * ⚠️ 必须给出正确的 `text/css`：Chrome 对样式表做严格 MIME 校验，
   * 回 `application/octet-stream` 会被**整份拒绝**（页面变成无样式，
   * 而且 `sheet.cssRules` 读不到任何规则）。踩过一次：验收里"滚动条样式"永远查不到。
   */
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/**
 * 起一个只读静态服务（给页面 fetch 二进制数据用，file:// 下会被 CORS 拦）。
 * 返回 { url, close }。
 */
export function startStaticServer(rootDir, port = 0) {
  const root = resolve(rootDir)
  const server = createServer((req, res) => {
    try {
      const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '')
      const full = normalize(join(root, rel))
      if (!full.startsWith(root) || !existsSync(full) || !statSync(full).isFile()) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const body = readFileSync(full)
      res.writeHead(200, {
        'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-store',
        /**
         * ⚠️ Vite 构建出来的 `<link rel="stylesheet" crossorigin>` 走 CORS 模式：
         * 静态服务不回 ACAO 头时，样式表会被判成"跨域不透明"而**整份失效**
         * （页面无样式 + `sheet.cssRules` 抛 SecurityError）。
         */
        'access-control-allow-origin': '*',
      })
      res.end(body)
    } catch (e) {
      res.writeHead(500)
      res.end(String(e?.message ?? e))
    }
  })
  return new Promise((res) => {
    server.listen(port, '127.0.0.1', () => {
      res({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })
    })
  })
}

/** 极简 CDP 客户端：只要 Runtime.evaluate 就够。 */
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
  async eval(expression, { awaitPromise = false } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '页面内抛出异常')
    return r.result?.value
  }
}

/**
 * 起浏览器 → 打开 url → 等 `readyExpr` 为真 → 返回 { cdp, close }。
 *
 * `readyExpr` 应是一个求值为 truthy 的表达式（例如 `typeof window.__x === 'function'`）。
 */
export async function launch({ url, readyExpr, port, timeoutMs = 30000, extraArgs = [] }) {
  const browser = findBrowser()
  if (!browser) throw new Error('没找到 Chrome / Edge（可用 BROWSER=edge 指定）')
  const cdpPort = port ?? 9333 + (process.pid % 200)
  const profileDir = mkdtempSync(join(tmpdir(), 'wb-cdp-'))
  const child = spawn(
    browser.path,
    [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,WebGPU',
      '--use-angle=d3d11',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      ...extraArgs,
      url,
    ],
    { stdio: 'ignore', windowsHide: true },
  )

  const cleanup = async () => {
    child.kill()
    await sleep(250)
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {
      /* 浏览器可能还占着文件 */
    }
  }

  try {
    // 等 CDP 起来
    const t0 = Date.now()
    let version = null
    while (Date.now() - t0 < timeoutMs) {
      try {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`)
        if (res.ok) {
          version = await res.json()
          break
        }
      } catch {
        /* 还没起来 */
      }
      await sleep(200)
    }
    if (!version) throw new Error(`CDP 在 ${timeoutMs}ms 内没起来（端口 ${cdpPort}）`)

    // 找页面 target
    let target = null
    for (let i = 0; i < 60 && !target; i++) {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && t.url.startsWith('http')) ?? null
      if (!target) await sleep(250)
    }
    if (!target) throw new Error('没找到页面 target')

    const cdp = await new Promise((res, rej) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl)
      ws.addEventListener('open', () => res(new Cdp(ws)))
      ws.addEventListener('error', (e) => rej(new Error('WebSocket 连接失败: ' + (e.message ?? ''))))
    })
    await cdp.send('Runtime.enable')

    if (readyExpr) {
      for (let i = 0; i < 80; i++) {
        if (await cdp.eval(readyExpr)) break
        await sleep(250)
      }
    }
    return { cdp, close: cleanup, browser, version }
  } catch (e) {
    await cleanup()
    throw e
  }
}
