#!/usr/bin/env node
/**
 * bugv28 验收探针（#1 游玩须知 / #2 上一步落子高亮 / #3 动画速度 / #4 联机倒计时）。
 *
 * 用法：
 *   node scripts/verify-bugv28.mjs
 *
 * 会先 `vite build`（若 dist 不存在则报错提示），再用零依赖 CDP 驱动 headless Chrome
 * 打开 dist 静态站点，逐项断言。
 */
import { existsSync } from 'node:fs'
import { launch, startStaticServer } from './ui-cdp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!existsSync('dist/index.html')) {
  console.error('缺少 dist/，请先 `npx vite build`')
  process.exit(2)
}

const server = await startStaticServer('dist')
const results = []
const check = (item, ok, detail) => {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail)
  results.push({ item, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${item}  ${text}`)
}

const { cdp, close } = await launch({
  url: server.url + '/index.html',
  readyExpr: 'Boolean(window.__CONNECT4__)',
  timeoutMs: 40000,
})
const ev = (expr) => cdp.eval(`(async () => { ${expr} })()`, { awaitPromise: true })

/** 轮询直到表达式为真（弹窗是在 onMounted 里弹的，比 __CONNECT4__ 晚一拍）。 */
async function waitFor(expr, timeoutMs = 6000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await ev(`return Boolean(${expr});`)) return true
    } catch {
      /* 页面可能正在重载 */
    }
    await sleep(200)
  }
  return false
}

/** 重载页面并等 `__CONNECT4__` 重新就绪。 */
async function reload() {
  await cdp.send('Page.enable')
  await cdp.send('Page.reload', { ignoreCache: true })
  await sleep(400)
  await waitFor('window.__CONNECT4__', 8000)
  await sleep(300)
}

try {
  await waitFor('document.querySelector(".promise-modal")', 6000)

  // --- #1 游玩须知弹窗（首次进入必然弹出） --------------------------------
  const modal = await ev(`
    const root = document.querySelector('.promise-modal');
    return root ? {
      title: root.querySelector('.modal__headline')?.textContent?.trim() ?? '',
      hasStatement: root.textContent.includes('严正声明'),
      hasAscend: root.textContent.includes('4ASCEND'),
      links: root.querySelectorAll('a').length,
      buttons: Array.from(root.querySelectorAll('.modal__actions button')).map((b) => b.textContent.trim()),
      centered: Boolean(document.querySelector('.overlay--promise')),
    } : null;
  `)
  check(
    '#1 打开游戏即弹出居中的「游玩须知」，含 promise.md 正文 + 可点链接 + 两个按钮',
    modal &&
      modal.hasStatement &&
      modal.hasAscend &&
      modal.links >= 3 &&
      modal.buttons.includes('我已知晓') &&
      modal.buttons.includes('不再弹出') &&
      modal.centered,
    modal,
  )

// 「不再弹出」写入 localStorage 并关闭
await ev(`document.querySelector('.promise-modal .ghost-btn').click(); return true;`)
// ⚠️ 弹窗用 <transition name="modal-fade">（leave 0.28s），元素在过渡结束后才从 DOM 摘掉。
// 350ms 太贴边（实测 ~300ms 才消失），机器一忙就偶发失败 ⇒ 放宽到 900ms。
await sleep(900)
  const never = await ev(`
    return {
      hidden: !document.querySelector('.promise-modal'),
      flag: localStorage.getItem('connect4.promiseDismissed.v1'),
    };
  `)
  check('#1 点「不再弹出」→ 弹窗关闭且写入本地标记', never.hidden && never.flag === '1', never)

  // 刷新后不再弹
  await reload()
  const afterReload = await ev(`return { hidden: !document.querySelector('.promise-modal') };`)
  check('#1 重新进入游戏不再弹出', afterReload.hidden, afterReload)

  // 清掉标记 + 刷新 → 又弹；点「我已知晓」只关不记
  await ev(`localStorage.removeItem('connect4.promiseDismissed.v1'); return true;`)
  await reload()
  await waitFor('document.querySelector(".promise-modal")', 6000)
  const back = await ev(`
    const visible = Boolean(document.querySelector('.promise-modal'));
    document.querySelector('.promise-modal .primary-btn')?.click();
    return { visible, flag: localStorage.getItem('connect4.promiseDismissed.v1') };
  `)
  check('#1 清掉标记后会再弹；「我已知晓」只关闭、不写标记', back.visible && back.flag === null, back)

  // --- #3 动画速度（走设置面板 UI） ---------------------------------------
  await sleep(300)
  await ev(`
    const btn = Array.from(document.querySelectorAll('.start-menu__actions .menu-btn'))
      .find((b) => b.textContent.includes('更改设置'));
    btn?.click();
    return Boolean(btn);
  `)
  await sleep(350)
  const tabOk = await ev(`
    const tab = Array.from(document.querySelectorAll('.settings-nav__item'))
      .find((b) => b.textContent.includes('表现'));
    tab?.click();
    return Boolean(tab);
  `)
  await sleep(250)
  const speed = await ev(`
    const choice = Array.from(document.querySelectorAll('.settings-pane .choice'))
      .find((b) => b.textContent.includes('2×'));
    choice?.click();
    const g = window.__CONNECT4__;
    return {
      clicked: Boolean(choice),
      speed: g.ui.animationSpeed,
      saved: localStorage.getItem('connect4.animSpeed.v1'),
      scene: g.scene.value ? g.scene.value.animationSpeed : null,
    };
  `)
  check(
    '#3 设置→表现→2×：即时生效（含 3D 动画器）+ 本地保存',
    tabOk && speed.clicked && speed.speed === 2 && speed.saved === '2' && (speed.scene === null || speed.scene === 2),
    speed,
  )
  // 关闭设置
  await ev(`document.querySelector('.settings-dialog .primary-btn')?.click(); return true;`)
  await sleep(300)

  // --- #2 上一步落子高亮 --------------------------------------------------
  const mark = await ev(`
    const g = window.__CONNECT4__;
    g.ui.mode = 'pvp';
    await g.startMatch();
    if (g.ui.diceVisible) g.hideDice();
    const engine = g.engine.value;
    let cell = -1;
    for (let i = 0; i < 81; i++) if (engine.canPlaceAt(i)) { cell = i; break; }
    const player = engine.current;
    await g.handleCellPick(cell);
    const scene = g.scene.value;
    const lm = g.ui.lastMark;
    return {
      cell,
      player,
      lastMark: lm ? { cell: lm.cell, player: lm.player } : null,
      sceneMark: scene ? scene.lastMarkInfo : null,
      unsupported: g.ui.unsupported,
    };
  `)
  const markOk =
    mark.lastMark &&
    mark.lastMark.cell === mark.cell &&
    mark.lastMark.player === mark.player &&
    (mark.sceneMark === null || (mark.sceneMark.cell === mark.cell && mark.sceneMark.owner === mark.player))
  check('#2 未成线的落子会被标记（数据 + 3D 圈）', markOk, mark)

  // 成线的那一手不标记
  const line = await ev(`
    const g = window.__CONNECT4__;
    const engine = g.engine.value;
    const board = engine.board.slice();
    board[0 * 9 + 0] = 1; board[0 * 9 + 1] = 1; board[0 * 9 + 2] = 1;
    engine.loadScenario(board, { hp: [6, 6], current: 0, firstPlayer: 0 });
    await g.handleCellPick(0 * 9 + 3);
    return { phase: engine.phase, lastMark: g.ui.lastMark };
  `)
  check('#2 形成连珠的那一手不标记', line.phase === 'awaitingDefense' && line.lastMark === null, line)

  // --- #4 联机倒计时 ------------------------------------------------------
  const timer = await ev(`
    const g = window.__CONNECT4__;
    g.ui.mode = 'online';
    g.online.status = 'playing';
    g.online.matchId = 'verify-' + Date.now();
    await g.startMatch();
    if (g.ui.diceVisible) g.hideDice();
    return {
      kind: g.online.deadlineKind,
      ahead: g.online.deadline - Date.now(),
      active: g.onlineCountdown.value.active,
      seconds: g.onlineCountdown.value.seconds,
      unsupported: g.ui.unsupported,
    };
  `)
  await sleep(600)
  const timerDom = await ev(`
    const g = window.__CONNECT4__;
    return {
      active: g.onlineCountdown.value.active,
      seconds: g.onlineCountdown.value.seconds,
      kind: g.onlineCountdown.value.kind,
      stripText: document.querySelector('.status-strip__timer')?.textContent?.trim() ?? '',
      rings: document.querySelectorAll('.round-timer').length,
      unsupported: g.ui.unsupported,
    };
  `)
  check(
    '#4 联机开局落下 20 秒的"回合结束世界时间"（下子）',
    timer.kind === 'place' && timer.ahead > 18_000 && timer.ahead <= 20_000 && timer.active && timer.seconds === 20,
    timer,
  )
  check(
    '#4 状态条 + 立绘旁都显示倒计时（下子 20s）',
    timerDom.active && timerDom.seconds > 0 && (timerDom.stripText.includes('落子') || timerDom.unsupported) && timerDom.rings >= 1,
    timerDom,
  )

  // 攻击阶段防守方 60 秒
  const defend = await ev(`
    const g = window.__CONNECT4__;
    g.ui.mode = 'online';
    g.online.status = 'playing';
    g.online.matchId = 'verify-def';
    g.ui.screen = 'playing';
    const board = new Array(81).fill(0);
    board[0] = 1; board[1] = 1; board[2] = 1; board[9] = 2;
    g.engine.value.loadScenario(board, { hp: [6, 6], current: 0, firstPlayer: 0 });
    g.syncUi();
    // 直接让引擎进入攻击阶段，再用 hideDice 触发"回合稳定"（重新定世界时间）
    g.engine.value.commit(3);
    g.ui.diceVisible = true;
    g.hideDice();
    return {
      phase: g.engine.value.phase,
      kind: g.online.deadlineKind,
      ahead: g.online.deadline - Date.now(),
      seconds: g.onlineCountdown.value.seconds,
    };
  `)
  check(
    '#4 攻击阶段防守方落 60 秒的世界时间',
    defend.phase === 'awaitingDefense' && defend.kind === 'defense' && defend.ahead > 58_000 && defend.seconds === 60,
    defend,
  )

  // 归零后：轮到自己 → 随机位置自动落子 + 提示音
  const expired = await ev(`
    const g = window.__CONNECT4__;
    g.ui.mode = 'online';
    g.online.status = 'playing';
    g.online.matchId = 'verify-exp';
    g.online.seat = 0;
    const board = new Array(81).fill(0);
    g.engine.value.loadScenario(board, { hp: [6, 6], current: 0, firstPlayer: 0 });
    g.syncUi();
    g.ui.screen = 'playing';
    window.__SENT__ = [];
    window.__SOUNDS__ = [];
    const oc = g.onlineClient;
    oc.matchId = 'verify-exp';
    Object.defineProperty(oc, 'connected', { configurable: true, get: () => true });
    oc.send = (msg) => { window.__SENT__.push(msg); return true; };
    if (g.scene.value) g.scene.value.audio.play = (name) => { window.__SOUNDS__.push(name); };
    // 先按正常流程定下世界时间（会启动 rAF 刷新循环），再把它改成"已经过期"
    g.ui.diceVisible = true;
    g.hideDice();
    g.online.deadline = Date.now() - 1;
    return true;
  `)
  await sleep(250)
  const expiry = await ev(`
    const g = window.__CONNECT4__;
    const sent = window.__SENT__;
    const moveMsg = sent.find((m) => m.t === 'move') ?? null;
    return {
      sorted: sent.map((m) => m.t),
      moveCell: moveMsg ? moveMsg.cell : null,
      cellLegal: moveMsg ? g.engine.value.canPlaceAt(moveMsg.cell) : false,
      sounds: window.__SOUNDS__,
    };
  `)
  check(
    '#4 倒计时归零 → 在随机合法位置自动落子 + 提示音',
    expired && expiry.moveCell !== null && expiry.cellLegal && expiry.sounds.includes('timeout'),
    expiry,
  )
} finally {
  await close()
  server.close()
}

console.log('\n============================= 汇总 =============================')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.item}`)
console.log(`通过 ${results.filter((r) => r.ok).length}/${results.length}`)
process.exit(results.every((r) => r.ok) ? 0 : 1)
