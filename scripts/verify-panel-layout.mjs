#!/usr/bin/env node
/**
 * 面板布局自检（bugv34j）：联机登录面板 / 匹配大厅 / 房间面板在**电脑端**必须是**单栏**。
 *
 *   node scripts/verify-panel-layout.mjs
 *
 * 背景：`.start-menu__inner` 是主菜单的**两栏**网格（左按钮 + 右角色详情），
 * 单栏面板（online-lobby / room-view / auth-panel）必须各自复写
 * `grid-template-columns: minmax(0, 1fr)`。窄屏媒体查询会强制单栏，
 * 所以"手机上正常、电脑上被挤扁"就是这个漏写造成的。
 *
 * 只开 1 个 headless 页面量 computed style + 截图（不跑对局，很轻）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { launch, startStaticServer } from './ui-cdp.mjs'

const OUT = '.shots/panel-layout'
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
}

const server = await startStaticServer('dist')
const { cdp, close } = await launch({
  url: server.url + '/index.html',
  readyExpr: 'Boolean(window.__CONNECT4__)',
  timeoutMs: 40000,
  extraArgs: ['--window-size=1440,900'],
})

/** 关掉「游玩须知」弹窗（首次进页面会弹，会盖住面板、影响截图与测量）。 */
async function dismissNotice() {
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /我已知晓|不再弹出/.test(b.textContent || ''));
    if (btn) btn.click();
    return true;
  })()`)
  await sleep(400)
}

async function measure(selector) {
  return cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      columns: cs.gridTemplateColumns,
      columnCount: cs.gridTemplateColumns.split(' ').filter(Boolean).length,
      width: Math.round(r.width),
      height: Math.round(r.height),
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight
    };
  })()`)
}

async function shot(file) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}/${file}`, Buffer.from(r.data, 'base64'))
}

/** 摆好一个面板状态并测量。 */
async function panel(kind) {
  const setup =
    kind === 'auth'
      ? `g.online.user = null; g.online.room = null; g.online.authMode = 'login';`
      : kind === 'lobby'
        ? `g.online.user = { username: 'probe', nickname: '探针' }; g.online.room = null;`
        : `g.online.user = { username: 'probe', nickname: '探针' }; g.online.room = {
             code: 'AB12CD', you: 'me',
             members: [
               { playerId: 'me', name: '我', character: 'deepseek', connected: true, host: true, wins: 0, ready: true },
               { playerId: 'rival', name: '对手', character: 'gtp', connected: true, host: false, wins: 0, ready: false }
             ],
             settings: {
               hpLimit: 16,
               magic: { enabled: true, cooldownTurns: 10, lineCooldownCut: 8, baseCount: 2, growthStep: 3, maxCount: 4, damagePerPlant: 1, requireLine: false },
               night: { enabled: true, startInNight: false, warnTurns: 3, minGap: 20, startTurnThreshold: 50, entryAttackThreshold: 10, entryPlantThreshold: 10, exitTurnsA: 30, exitAttacksA: 20, exitTurnsB: 60, exitAttacksB: 40 }
             },
             phase: 'lobby', matchId: null, chat: [], canStart: false
           };`
  await cdp.eval(`(() => {
    const g = window.__CONNECT4__;
    g.ui.mode = 'online';
    g.ui.screen = 'online';
    g.online.chatOpen = false;
    ${setup}
    return true;
  })()`)
  await sleep(420)
  const selector = kind === 'auth' ? '.start-menu__inner.auth-panel' : kind === 'lobby' ? '.start-menu__inner.online-lobby' : '.start-menu__inner.room-view'
  return measure(selector)
}

try {
  await dismissNotice()
  // 弹窗可能带过渡，再补一次（幂等）
  await dismissNotice()

  const viewport = await cdp.eval('({ w: innerWidth, h: innerHeight })')
  console.log(`宽屏视口：${viewport.w}×${viewport.h}\n`)

  const auth = await panel('auth')
  check(Boolean(auth) && auth.columnCount === 1, '电脑端「登录面板」单栏', JSON.stringify(auth))
  await shot('1-auth-wide.png')

  // 登录面板的"注册态"（账号不存在 → 展开昵称）也截一张
  await cdp.eval(`(() => { window.__CONNECT4__.online.authMode = 'register'; return true })()`)
  await sleep(320)
  await shot('1b-auth-register-wide.png')
  await cdp.eval(`(() => { window.__CONNECT4__.online.authMode = 'login'; return true })()`)

  const lobby = await panel('lobby')
  check(Boolean(lobby) && lobby.columnCount === 1, '电脑端「匹配大厅」单栏', JSON.stringify(lobby))
  await shot('2-lobby-wide.png')

  const room = await panel('room')
  check(Boolean(room) && room.columnCount === 1, '电脑端「房间面板」单栏（不再被劈成左右两栏）', JSON.stringify(room))

  // 房间内部：成员竖排、底部三按钮同一行
  const inner = await cdp.eval(`(() => {
    const members = document.querySelector('.room-members');
    const actions = document.querySelector('.room-actions');
    const btns = actions ? [...actions.querySelectorAll('.menu-btn')] : [];
    const layout = document.querySelector('.room-deck-layout');
    const main = document.querySelector('.room-deck-main');
    const detail = document.querySelector('.room-deck-detail');
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right) }; };
    return {
      memberFlex: members ? getComputedStyle(members).flexDirection : null,
      actionColumns: actions ? getComputedStyle(actions).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
      btnCount: btns.length,
      btnDisabled: btns.map((b) => b.disabled),
      // bugv34m：准备独占一行（通栏），房间设置 / 退出房间并排一行
      btnTops: btns.map((b) => Math.round(b.getBoundingClientRect().top)),
      btnWidths: btns.map((b) => Math.round(b.getBoundingClientRect().width)),
      // 去掉描述文案后，按钮里不应再有 .menu-btn__meta
      metaCount: btns.reduce((n, b) => n + b.querySelectorAll('.menu-btn__meta').length, 0),
      // bugv34l：底部按钮属于**左栏**（.room-deck-main），技能详情在右栏
      actionsInsideMain: Boolean(main && actions && main.contains(actions)),
      layoutColumns: layout ? getComputedStyle(layout).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
      mainRect: rect(main),
      detailRect: rect(detail),
      label: (document.querySelector('.room-view') || {}).textContent ? 'room' : 'none'
    };
  })()`)
  check(
    inner &&
      inner.memberFlex === 'column' &&
      inner.actionColumns === 2 &&
      inner.btnCount === 3 &&
      inner.metaCount === 0 &&
      // 第一颗按钮（准备）比后两颗宽 = 通栏；且它自己在第一行
      inner.btnWidths[0] > inner.btnWidths[1] &&
      inner.btnTops[0] < inner.btnTops[1] &&
      inner.btnTops[1] === inner.btnTops[2],
    '房间内部：成员竖排 + 底部「准备」通栏一行、另两个并排一行（无描述文案）',
    JSON.stringify(inner),
  )
  check(
    inner && inner.actionsInsideMain === true && inner.layoutColumns === 2 &&
      inner.mainRect && inner.detailRect && inner.detailRect.left >= inner.mainRect.right - 2,
    '房间左栏 = 角色选择器 + 底部按钮，右栏 = 技能详情（bugv34l）',
    JSON.stringify({
      actionsInsideMain: inner?.actionsInsideMain,
      layoutColumns: inner?.layoutColumns,
      mainRect: inner?.mainRect,
      detailRect: inner?.detailRect,
    }),
  )
  await shot('3-room-wide.png')

  // --- 窄屏回归：不应因为修了宽屏而把手机端弄坏（仍须单栏）---
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await sleep(400)
  const roomNarrow = await measure('.start-menu__inner.room-view')
  check(
    Boolean(roomNarrow) && roomNarrow.columnCount === 1 && roomNarrow.width <= 390,
    '窄屏（390）回归：房间面板仍是单栏且不横向溢出',
    JSON.stringify(roomNarrow),
  )

  // 窄屏下标题必须还在最上面（bugv34l：曾经因为继承了主菜单的 `order`，
  // 「房间 ROOM · …」整块被推到面板最底部）
  const narrowOrder = await cdp.eval(`(() => {
    const brand = document.querySelector('.room-view .start-menu__brand');
    const code = document.querySelector('.room-view .room-view__code');
    const deck = document.querySelector('.room-view .room-deck-layout');
    const picker = document.querySelector('.room-view .character-picker');
    const detail = document.querySelector('.room-view .room-deck-detail');
    const top = (el) => (el ? Math.round(el.getBoundingClientRect().top) : null);
    return {
      brand: top(brand),
      code: top(code),
      deck: top(deck),
      picker: top(picker),
      detail: top(detail),
    };
  })()`)
  check(
    narrowOrder &&
      narrowOrder.brand !== null &&
      narrowOrder.code !== null &&
      narrowOrder.brand < narrowOrder.code &&
      narrowOrder.picker !== null &&
      narrowOrder.detail !== null &&
      narrowOrder.picker < narrowOrder.detail,
    '窄屏（390）：房间标题在最上方 + 角色选择器仍在技能详情上方',
    JSON.stringify(narrowOrder),
  )
  await shot('4-room-narrow.png')
  await cdp.send('Emulation.clearDeviceMetricsOverride')
} finally {
  await close()
  await server.close?.()
}

const failed = results.filter((r) => !r.ok).length
console.log('')
console.log(failed === 0 ? `结论：面板布局正常 ✅（截图在 ${OUT}/）` : `结论：${failed} 项失败 ⛔`)
process.exit(failed === 0 ? 0 : 1)
