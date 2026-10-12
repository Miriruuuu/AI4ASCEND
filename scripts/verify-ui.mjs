#!/usr/bin/env node
/**
 * UI 验收探针（bugv25 #1~#5 + bugv26 #1~#3）。
 *
 * 用法：
 *   node scripts/verify-ui.mjs replay/replay4.txt 1280 800 desktop
 *   node scripts/verify-ui.mjs replay/replay4.txt 390 844 mobile
 *
 * 需要先起开发服务器（`pnpm dev`）。检查项：
 *   #1 回放里技能框可见、且不与回放面板重叠；回放角色正确
 *   #2 立绘旁"伤害 +N"徽章；手机端抽屉内有技能图标；双指缩放接通
 *   #3 结算面板位置（桌面=绝对定位且不压技能框；手机=文档流）+ 总攻击数正确
 *   #5 手机端技能抽屉流程（弹抽屉 → 使用 → 进选植物）、开始菜单居中/无横向滚动
 *
 * ⚠️ 必须显式设 `Emulation.setDeviceMetricsOverride`，否则 headless 默认 764×429，
 *    手机媒体查询压根不生效（第一次就踩了这个坑）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { launch } from './ui-cdp.mjs'

const REPLAY_FILE = process.argv[2] ?? 'replay/replay4.txt'
const W = Number(process.argv[3] ?? 1280)
const H = Number(process.argv[4] ?? 800)
const TAG = process.argv[5] ?? 'desktop'
const MOBILE = W <= 720

const { cdp, close } = await launch({
  url: 'http://localhost:5173/',
  readyExpr: 'Boolean(window.__CONNECT4__)',
  timeoutMs: 30000,
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (expr) => cdp.eval(`(async () => { ${expr} })()`, { awaitPromise: true })
/** 截图目录：自己建，别依赖调用方先 `mkdir`（踩过 ENOENT）。 */
mkdirSync('ui-shots', { recursive: true })
const shot = async (name) => {
  await cdp.send('Page.enable')
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`ui-shots/shot-${name}.png`, Buffer.from(r.data, 'base64'))
}

const pass = (ok, msg) => console.log(`${ok ? '✅' : '❌'} ${msg}`)

// ⚠️ 必须先设视口，否则 headless 默认是 764×429，手机 CSS 压根不生效
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: W,
  height: H,
  deviceScaleFactor: 1,
  mobile: MOBILE,
})

/** 造一个"技能就绪 + 场上有我方植物"的局面，好把抽屉流程走完。 */
const SCENARIO = `
  const g = window.__CONNECT4__
  const e = g.engine.value
  const b = new Array(81).fill(0)
  b[40] = 1; b[41] = 1; b[49] = 1; b[58] = 1
  b[30] = 2; b[31] = 2
  e.loadScenario(b, {
    hp: [6, 6], current: 0, firstPlayer: 0,
    magic: [
      { cell: 22, kind: 'flower', owner: 0 },
      { cell: 24, kind: 'grass', owner: 0 },
      { cell: 26, kind: 'fern', owner: 0 },
    ],
    skillReadyAt: [[0, 0], [99, 99]],
    powerBonus: [1, 0],
    powerUntil: [99, 99],
    sabotageBonus: [0, 0],
  })
  g.syncUi()
  return { ready: g.ui.skills[0]?.[0]?.ready, owned: g.ui.skills[0]?.[0]?.owned, power: g.ui.power }
`

try {
  await sleep(1000)
  console.log(`\n########## ${TAG}  ${W}x${H} ##########`)

  await ev(`
    const g = window.__CONNECT4__
    g.ui.mode = 'pve'
    await g.startMatch()
    await new Promise(r => setTimeout(r, 2200))
    return true
  `)

  // ---- #2 增伤徽章 ----
  const sc = await ev(SCENARIO)
  await sleep(400)
  const badge = await ev(`
    const el = document.querySelector('.power-badge')
    return { exists: Boolean(el), text: el?.textContent?.trim() ?? null, uiPower: window.__CONNECT4__.ui.power }
  `)
  console.log('\n--- #2 立绘旁增伤标识 ---')
  console.log('局面:', JSON.stringify(sc), ' 徽章:', JSON.stringify(badge))
  pass(badge.exists === true && badge.text === '伤害 +1', '增伤徽章显示「伤害 +1」')

  // ---- #3 徽章不能压住技能槽（bugv26 #3） ----
  const badgeGeom = await ev(`
    const R = (s) => { const e = document.querySelector(s); if (!e) return null
      const r = e.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) } }
    const OV = (a, b) => { if (!a || !b) return 0
      const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x))
      const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y))
      return Math.round(w * h) }
    // 把两个徽章都顶出来（连续行动 + 增伤）
    const g = window.__CONNECT4__
    g.ui.bonusActions = [1, 1]
    g.ui.power = [2, 2]
    g.syncUi()
    return new Promise(res => setTimeout(() => {
      const bars = [...document.querySelectorAll('.skill-bar')]
      const badges = [...document.querySelectorAll('.power-badge, .combo-badge')]
      const panels = [...document.querySelectorAll('.player-panel')]
      let ovBars = 0, ovPanels = 0
      for (const bd of badges) {
        const a = bd.getBoundingClientRect()
        for (const bar of bars) ovBars += OV(a, bar.getBoundingClientRect())
        for (const p of panels) ovPanels += OV(a, p.getBoundingClientRect())
      }
      res({
        badgeCount: badges.length,
        bars: bars.map(b => R('.skill-bar.is-side-' + b.dataset.skillBar)),
        overlapWithSkillBars: ovBars,
        overlapWithPanels: ovPanels,
        reserve: getComputedStyle(document.querySelector('.app-root')).getPropertyValue('--hud-reserve').trim(),
      })
    }, 500))
  `)
  console.log('\n--- #3 徽章 vs 技能槽 ---')
  console.log(JSON.stringify(badgeGeom, null, 1))
  if (!MOBILE) {
    pass(badgeGeom.overlapWithSkillBars === 0, `徽章不压技能槽（重叠 ${badgeGeom.overlapWithSkillBars}px²，--hud-reserve=${badgeGeom.reserve}）`)
  }

  // ---- #5 手机端：抽屉全流程 ----
  if (MOBILE) {
    console.log('\n--- #5 手机端技能抽屉流程 ---')
    const flow = await ev(`
      const g = window.__CONNECT4__
      const btn = document.querySelector('.mobile-skill-btn')
      if (!btn) return { ok: false, reason: '没有 .mobile-skill-btn' }
      btn.click()
      await new Promise(r => setTimeout(r, 600))
      const sheet = document.querySelector('.skill-drawer__sheet')
      const r = sheet?.getBoundingClientRect()
      const useBtn = document.querySelector('.skill-drawer__actions .primary-btn')
      const opened = {
        open: Boolean(sheet),
        bottomFlush: r ? Math.abs(Math.round(r.bottom) - window.innerHeight) <= 2 : null,
        title: document.querySelector('.skill-drawer__name')?.textContent ?? null,
        hasIcon: Boolean(document.querySelector('.skill-drawer__icon img')),
        iconShown: (() => { const i = document.querySelector('.skill-drawer__icon'); return i ? getComputedStyle(i).display !== 'none' && i.getBoundingClientRect().width > 0 : false })(),
        useText: useBtn?.textContent?.trim() ?? null,
        useDisabled: useBtn?.disabled ?? null,
      }
      useBtn?.click()
      await new Promise(r2 => setTimeout(r2, 700))
      const after = {
        drawerGone: !document.querySelector('.skill-drawer__sheet'),
        stage: g.ui.skillSelect?.stage ?? null,
        need: g.ui.skillSelect?.need ?? null,
        dockVisible: Boolean(document.querySelector('.skill-dock')),
        dockText: document.querySelector('.skill-hint')?.textContent?.trim().slice(0, 40) ?? null,
        longHintGone: !(document.querySelector('.skill-hint')?.textContent ?? '').includes('点击场上'),
        sideDockHidden: getComputedStyle(document.querySelector('.side-dock')).display === 'none',
        dockBottom: (() => { const d = document.querySelector('.skill-dock'); const r = d?.getBoundingClientRect(); return r ? Math.round(window.innerHeight - r.bottom) : null })(),
        confirmRect: (() => { const c = document.querySelector('.skill-confirm'); const r = c?.getBoundingClientRect(); return r ? { x: Math.round(r.x), w: Math.round(r.width), bottom: Math.round(window.innerHeight - r.bottom) } : null })(),
        // bugv26 #2：底部确认条会压住状态条（状态条那时显示"XX 落子"）⇒ 必须藏掉
        stripHidden: !document.querySelector('.status-strip') || getComputedStyle(document.querySelector('.status-strip')).display === 'none',
        dockOverlapStrip: (() => {
          const d = document.querySelector('.skill-dock')?.getBoundingClientRect()
          const s = document.querySelector('.status-strip')?.getBoundingClientRect()
          if (!d || !s) return 0
          const w = Math.max(0, Math.min(d.right, s.right) - Math.max(d.left, s.left))
          const h = Math.max(0, Math.min(d.bottom, s.bottom) - Math.max(d.top, s.top))
          return Math.round(w * h)
        })(),
      }
      return { ok: true, opened, after }
    `)
    console.log(JSON.stringify(flow, null, 1))
    pass(flow.opened?.open === true, '点小按钮弹出抽屉')
    pass(flow.opened?.bottomFlush === true, '抽屉贴底（bottom ≈ 视口高度）')
    pass(flow.opened?.hasIcon === true && flow.opened?.iconShown === true, '抽屉里显示技能图标')
    pass(flow.opened?.useDisabled === false, '技能可用时「使用技能」可点')
    pass(flow.after?.drawerGone === true, '点「使用」关闭抽屉')
    pass(flow.after?.stage === 'plants', `进入选植物环节（stage=${flow.after?.stage}）`)
    pass(flow.after?.dockVisible === true, '底部出现选植物确认条')
    pass(flow.after?.longHintGone === true, '原长提示文字已去掉')
    pass(flow.after?.sideDockHidden === true, '选植物时隐藏侧边按钮（不再压住确认条）')
    pass(flow.after?.dockOverlapStrip === 0, `选植物确认条不压状态条「XX 落子」（重叠 ${flow.after?.dockOverlapStrip}px²）`)
    await shot(`${TAG}-drawer`)

    // ---- #2 双指缩放（真派发 touch 事件，验证不在 passive 上被吞） ----
    console.log('\n--- #2 双指缩放 ---')
    const pinch = await ev(`
      const g = window.__CONNECT4__
      const c = document.getElementById('board-canvas')
      const before = g.scene.value.rig.zoomLevel
      const T = (id, x, y) => new Touch({ identifier: id, target: c, clientX: x, clientY: y })
      const fire = (type, pts) => {
        const touches = pts.map((p, i) => T(i + 1, p[0], p[1]))
        c.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: touches, bubbles: true, cancelable: true }))
      }
      fire('touchstart', [[100, 400], [200, 400]])
      // 两指间距从 100px 拉到 200px ⇒ scale = 2 ⇒ 拉近（倍率变小）
      fire('touchmove', [[50, 400], [250, 400]])
      await new Promise(r => setTimeout(r, 300))
      const zoomed = g.scene.value.rig.zoomLevel
      fire('touchend', [])
      g.scene.value.rig.setZoom(1)
      return { before, zoomed, canvasTouchAction: getComputedStyle(c).touchAction }
    `)
    console.log(JSON.stringify(pinch))
    pass(pinch.zoomed < pinch.before - 0.05, `双指拉开 → 拉近（倍率 ${pinch.before} → ${pinch.zoomed}）`)
    pass(pinch.canvasTouchAction === 'pan-y', `画布允许单指纵向滚动、双指交给 JS（touch-action=${pinch.canvasTouchAction}）`)
  }

  // ---- #3 结算面板：#2/#5 增伤明细 + 位置 ----
  const raw = readFileSync(REPLAY_FILE, 'utf8').trim()
  await ev(`
    const g = window.__CONNECT4__
    const rec = g.importReplayCode(${JSON.stringify(raw)})
    g.openReplay(rec, 'menu')
    await new Promise(r => setTimeout(r, 1500))
    return true
  `)
  // 播到有结算的那一步（replay4 的第 11 步 = 防守步，真值 [0,3]）
  const played = await ev(`
    const g = window.__CONNECT4__
    await g.playReplayStep(11)
    await new Promise(r => setTimeout(r, 900))
    const card = document.querySelector('.attack-card')
    const r = card?.getBoundingClientRect()
    const cs = card ? getComputedStyle(card) : null
    const bars = [...document.querySelectorAll('.skill-bar')].map(b => b.getBoundingClientRect())
    let overlap = 0
    if (card && bars.length) {
      for (const b of bars) {
        const ox = Math.max(0, Math.min(r.right, b.right) - Math.max(r.left, b.left))
        const oy = Math.max(0, Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top))
        overlap += ox * oy
      }
    }
    return {
      cardVisible: Boolean(card),
      pos: cs?.position ?? null,
      rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
      winH: window.innerHeight,
      overlapWithSkillBars: Math.round(overlap),
      tally: g.ui.tally,
      labels: [...document.querySelectorAll('.attack-card .stat')].map(s => s.textContent.replace(/\\s+/g, ' ').trim()),
    }
  `)
  console.log('\n--- #3 结算面板 ---')
  console.log(JSON.stringify(played, null, 1))
  pass(played.cardVisible === true, '结算面板可见')
  pass(played.tally?.[0] === 0 && played.tally?.[1] === 3, `总攻击数正确（tally=${JSON.stringify(played.tally)}，真值 [0,3]）`)
  if (MOBILE) {
    pass(played.pos === 'static', `手机端结算面板改为正常文档流（position=${played.pos}）`)
  } else {
    pass(played.overlapWithSkillBars === 0, `桌面端与技能框零重叠（重叠 ${played.overlapWithSkillBars}px²）`)
  }
  await shot(`${TAG}-attack`)

  // ---- bugv27 #1/#2：回放攻击步的「悬浮棋子回收」与「立绘时序」 ----
  {
    console.log('\n--- bugv27 #1/#2 回放攻击步 ---')
    const attack = await ev(`
      const g = window.__CONNECT4__
      const rec = g.replay.record
      const lethal = []
      rec.steps.forEach((s, i) => {
        const hasResolve = (s.events ?? []).some(e => e.type === 'attackResolved')
        if (hasResolve && (s.hp[0] <= 0 || s.hp[1] <= 0)) lethal.push(i + 1)
      })
      return { lethal }
    `)
    const target = attack.lethal[0]
    if (!target) {
      console.log('  （这条回放没有"致命攻击"步，跳过）')
    } else {
      const trace = await ev(`
        const g = window.__CONNECT4__
        g.closeReplay()
        await new Promise(r => setTimeout(r, 600))
        const rec = g.replay.record
        g.openReplay(rec, 'menu')
        await new Promise(r => setTimeout(r, 1200))
        g.seekReplay(${target} - 1)
        await new Promise(r => setTimeout(r, 600))
        const tl = []
        let last = ''
        let stop = false
        const tick = () => {
          if (stop) return
          const key = JSON.stringify([g.ui.expression, g.ui.hp])
          if (key !== last) {
            last = key
            tl.push({ expr: [...g.ui.expression], hp: [...g.ui.hp], staged: g.scene.value?.staged.length ?? -1 })
          }
          setTimeout(tick, 25)
        }
        tick()
        await g.playReplayStep(${target})
        await new Promise(r => setTimeout(r, 3200))
        stop = true
        return { tl, stagedAfter: g.scene.value?.staged.length ?? -1, exprAfter: [...g.ui.expression] }
      `)
      const dead = trace.tl.filter((row) => row.expr.includes('lose'))
      // 致命一击：lose 必须出现在"撞击过程中"（即结束后 stage 归零之前），
      // 且此后**不能**再被顶回 hit
      const firstLose = trace.tl.findIndex((row) => row.expr.includes('lose'))
      const hitAfterLose = trace.tl.slice(firstLose + 1).some((row) => row.expr.includes('hit'))
      console.log('  时间线:', trace.tl.map((r) => `[${r.expr.join(',')}]@staged${r.staged}`).join(' → '))
      pass(dead.length > 0, '致命一击过程中确实切到了 lose')
      pass(hitAfterLose === false, 'lose 之后不会被顶回 hit（攻击结算不再用陈旧血量判定）')
      pass(trace.stagedAfter === 0, `攻击阶段结束后悬浮棋子已清空（staged=${trace.stagedAfter}）`)
      await shot(`${TAG}-bugv27`)
    }
  }

  // ---- #5 开始菜单居中 + 无横向滚动 ----
  const menu = await ev(`
    const g = window.__CONNECT4__
    g.closeReplay()
    await new Promise(r => setTimeout(r, 900))
    const inner = document.querySelector('.start-menu__inner')
    const r = inner?.getBoundingClientRect()
    const winW = window.innerWidth
    return {
      screen: g.ui.screen,
      hasMenu: Boolean(inner),
      rect: r ? { x: Math.round(r.x), w: Math.round(r.width) } : null,
      winW,
      // 居中判据：左/右留白差 ≤ 2px
      offCenter: r ? Math.abs(Math.round(r.x) - Math.round(winW - r.right)) : null,
      docScrollW: document.documentElement.scrollWidth,
      cols: inner ? getComputedStyle(inner).gridTemplateColumns : null,
    }
  `)
  console.log('\n--- #5 开始菜单 ---')
  console.log(JSON.stringify(menu, null, 1))
  pass(menu.hasMenu === true, '开始菜单渲染')
  pass(Math.abs(menu.offCenter ?? 999) <= 2, `横向居中（左右差 ${menu.offCenter}px）`)
  pass(menu.docScrollW <= menu.winW, `无横向滚动条（${menu.docScrollW} ≤ ${menu.winW}）`)
  await shot(`${TAG}-menu`)
} finally {
  await close()
}
