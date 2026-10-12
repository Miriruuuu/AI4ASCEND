#!/usr/bin/env node
/**
 * 联机后端连通性验收（bugv34g）
 *
 *   node scripts/verify-online-backend.mjs            # 默认检查 http://localhost:8787
 *   ONLINE_SERVER=113.45.13.149:8787 node scripts/verify-online-backend.mjs
 *
 * 它**不**用浏览器，只做两件事：
 *   1. 从 `dist/` 里读出前端实际会连的后端地址（证明构建产物内嵌的是哪一台）；
 *   2. 用真实 WS 握手那个地址，检查协议版本是否与前端一致。
 *
 * 之所以单独做这个：一旦出现 `versionMismatch`，问题一定在
 * 「前端连错后端」或「某一侧是旧代码」两者之一，这个脚本能把两者分开。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const FRONTEND_PROTOCOL = Number(
  readFileSync('src/app/online.ts', 'utf8').match(/ONLINE_PROTOCOL_VERSION\s*=\s*(\d+)/)?.[1] ?? 0,
)

/**
 * 从构建产物里找出真正生效的后端地址（`defaultServerUrl()` 读的 `VITE_SERVER_URL`）。
 *
 * ⚠️ **必须**认 `dist/index.html` 里引用的那个入口，不能只是 `readdirSync` 拿第一个
 * `index-*.js`：本仓库构建用 `--emptyOutDir=false`（沙箱删不掉 dist），
 * 所以 `dist/assets` 会同时躺着好几代 hash 不同的 `index-*.js` 历史产物，
 * 随便挑一个可能读到**上一代**的地址（bugv34l 踩过）。
 */
function bakedServerUrl() {
  const dir = join('dist', 'assets')
  let entry = null
  try {
    const html = readFileSync(join('dist', 'index.html'), 'utf8')
    entry = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1] ?? null
  } catch {
    /* 没有 dist/index.html 就退回扫描目录 */
  }
  if (!entry || !readdirSync(dir).includes(entry)) {
    // 兜底：按修改时间取最新的那个（比按文件名排序靠谱）
    const newest = readdirSync(dir)
      .filter((f) => /^index-.*\.js$/.test(f))
      .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0]
    entry = newest ? newest.f : null
  }
  if (!entry) throw new Error('dist/assets 里找不到 index-*.js，请先构建')
  const code = readFileSync(join(dir, entry), 'utf8')
  // 取 `defaultServerUrl` 里的字符串字面量：形如  const a="http://host:port"
  const fn = code.match(/function \w+\(\)\{const \w+="(https?:\/\/[^"]+)"\.trim\(\)/)
  return { entry, url: fn ? fn[1] : null }
}

/** 真实 WS 握手，读服务端回的 welcome.version 或 error。 */
async function probe(serverUrl) {
  const wsUrl = serverUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws'
  // Node 22+ 自带全局 WebSocket；老版本回退到后端的 ws 包
  const Ctor = globalThis.WebSocket ?? (await import('../back/node_modules/ws/index.js')).WebSocket
  return new Promise((resolve) => {
    const ws = new Ctor(wsUrl, { handshakeTimeout: 8000 })
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      try { ws.close() } catch {}
      resolve(value)
    }
    const timer = setTimeout(() => finish({ kind: 'timeout' }), 10000)
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', playerId: 'probe-verify', name: '探针', version: FRONTEND_PROTOCOL }))
    }
    ws.onmessage = (event) => {
      clearTimeout(timer)
      const m = JSON.parse(String(event.data ?? event))
      if (m.t === 'welcome') finish({ kind: 'welcome', version: Number(m.version) })
      else finish({ kind: 'error', code: m.code, message: m.message })
    }
    ws.onerror = (err) => { clearTimeout(timer); finish({ kind: 'unreachable', message: err?.message ?? '连接失败' }) }
  })
}

const expected = process.env.ONLINE_SERVER || 'localhost:8787'
const normalized = expected.startsWith('http') ? expected : `http://${expected}`

const baked = bakedServerUrl()
console.log(`前端协议版本 (ONLINE_PROTOCOL_VERSION) : ${FRONTEND_PROTOCOL}`)
console.log(`dist 入口                            : ${baked.entry}`)
console.log(`产物内嵌后端 (defaultServerUrl 取值)  : ${baked.url ?? '（未找到，可能被压缩变形）'}`)
console.log(`本次要探测的后端                      : ${normalized}`)
console.log('')

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
}

// ① 产物内嵌地址是否就是预期的后端
if (baked.url) {
  const same = baked.url.replace(/\/+$/, '') === normalized.replace(/\/+$/, '')
  check(same, `构建产物连的后端 == 预期 (${normalized})`, same ? '' : `实际 ${baked.url}`)
}

// ② 真实握手，协议版本是否一致
const result = await probe(normalized)
if (result.kind === 'welcome') {
  check(
    result.version === FRONTEND_PROTOCOL,
    `协议版本一致 (服务端 ${result.version} / 前端 ${FRONTEND_PROTOCOL})`,
    result.version === FRONTEND_PROTOCOL ? '' : '⇒ 某一侧是旧代码',
  )
} else if (result.kind === 'error') {
  check(false, '握手成功', `服务端返回 ${result.code}：${result.message}`)
} else {
  check(false, '后端可达', `${result.kind}${result.message ? '：' + result.message : ''}`)
}

console.log('')
if (failed === 0) {
  console.log('结论：前端连的后端是对的，且协议版本一致 ✅')
  process.exit(0)
}
console.log('结论：有问题，见上面的 FAIL ⛔')
if (result.kind === 'error' && result.code === 'versionMismatch') {
  console.log('  提示：versionMismatch 说明被连的那台后端还在跑旧代码 —— 重新构建并**重启**它。')
}
process.exit(1)
