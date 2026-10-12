#!/usr/bin/env node
/**
 * 真浏览器联机自检（bugv34g）
 *
 *   node scripts/verify-online-live.mjs
 *
 * 打开本机预览页 → 点「联机对战」→ 等握手结果，读出界面上的状态文字，
 * 断言**不是**「协议版本不一致」。
 *
 * 这一步是给「明明改了地址，界面还是报版本不一致」这类问题兜底的：
 * 它验的是"浏览器里真的连上了"，而不是"构建产物里的字符串对了"。
 */
import { existsSync } from 'node:fs'
import { launch, startStaticServer } from './ui-cdp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!existsSync('dist/index.html')) {
  console.error('缺少 dist/，请先构建')
  process.exit(2)
}

const server = await startStaticServer('dist')
const { cdp, close } = await launch({
  url: server.url + '/index.html',
  readyExpr: 'Boolean(window.__CONNECT4__)',
  timeoutMs: 40000,
  extraArgs: ['--window-size=1440,900'],
})

async function ev(expr, timeoutMs = 12000) {
  let timer = null
  const guard = new Promise((resolve) => { timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs) })
  try {
    const value = await Promise.race([cdp.eval(expr, { awaitPromise: true }), guard])
    return value
  } finally {
    clearTimeout(timer)
  }
}

const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
}

try {
  // 进联机大厅（走真实按钮，避免绕过界面逻辑）
  await ev(`(() => {
    const btn = [...document.querySelectorAll('button, .menu-btn, [role="button"]')]
      .find((el) => /联机/.test(el.textContent || ''))
    if (!btn) return 'no-button'
    btn.click()
    return 'clicked'
  })()`)
  await sleep(1200)

  // 等状态落地：轮询 online 状态 + 界面文字
  let snap = null
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    snap = await ev(`(() => {
      const g = window.__CONNECT4__
      const o = g && g.online ? g.online : null
      const c = g && g.onlineClient ? g.onlineClient : null
      return {
        screen: g?.ui?.screen ?? null,
        status: o?.status ?? null,
        connected: o?.connected ?? null,
        serverUrl: o?.serverUrl ?? null,
        message: o?.message ?? null,
        lastError: c?.lastError ?? null,
        bodyText: (document.body.innerText || '').slice(0, 1200),
      }
    })()`)
    if (snap && (snap.connected === true || snap.status === 'idle' || /不一致|无法连接|已就绪|正在连接/.test(snap.bodyText || ''))) break
    await sleep(600)
  }

  const text = snap?.bodyText ?? ''
  const mismatch = /协议版本不一致|versionMismatch/i.test(text)
  check(!mismatch, '界面没有「协议版本不一致」', mismatch ? text.match(/.{0,40}协议版本不一致.{0,60}/)?.[0] ?? '' : '')
  check(snap?.connected === true, '已连上后端', `connected=${snap?.connected} status=${snap?.status}`)
  check(
    String(snap?.serverUrl || '').includes('localhost:8787'),
    '连的是本机后端',
    `serverUrl=${snap?.serverUrl}`,
  )
  if (snap?.lastError) console.log(`       lastError: ${snap.lastError}`)

  // --- bugv34i：未登录时显示登录面板；注册 / 登录后进大厅 ---
  check(/账号/.test(text) && /密码/.test(text), '未登录时显示账号 / 密码表单')
  check(snap?.screen === 'online', '停在联机面板（未直接进对局）', `screen=${snap?.screen}`)

  const account = `probe_${Date.now().toString(36)}`
  await ev(`(() => {
    const g = window.__CONNECT4__
    if (!g) return 'no-store'
    g.onlineRegister(${JSON.stringify(account)}, 'probe-pass', '探针')
    return 'submitted'
  })()`)

  let authSnap = null
  const authDeadline = Date.now() + 20000
  while (Date.now() < authDeadline) {
    authSnap = await ev(`(() => {
      const g = window.__CONNECT4__
      // ⚠️ 不要把 Vue reactive 对象整个返回：CDP 的 returnByValue 会序列化成 {}，
      // 这里只取需要的**基本类型**字段。
      const u = g?.online?.user ?? null
      return {
        user: u ? { username: u.username, nickname: u.nickname } : null,
        authMessage: g?.online?.authMessage ?? '',
        room: Boolean(g?.online?.room),
        bodyText: (document.body.innerText || '').slice(0, 800),
      }
    })()`)
    if (authSnap?.user) break
    await sleep(600)
  }
  check(
    Boolean(authSnap?.user?.username),
    '注册后拿到登录态',
    `user=${authSnap?.user?.username ?? '-'}(${authSnap?.user?.nickname ?? '-'}) msg=${authSnap?.authMessage ?? ''}`,
  )
  check(/在线匹配|创建房间/.test(authSnap?.bodyText ?? ''), '登录后进入联机大厅')
} finally {
  await close()
  await server.close?.()
}

const failed = results.filter((r) => !r.ok).length
console.log('')
console.log(failed === 0 ? '结论：浏览器里联机握手正常 ✅' : `结论：${failed} 项失败 ⛔`)
process.exit(failed === 0 ? 0 : 1)
