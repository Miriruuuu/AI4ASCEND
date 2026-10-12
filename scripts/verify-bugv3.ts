/**
 * bugv3 逐条验证（临时脚本，不属于交付内容）。
 *
 * 刻意放在 tsconfig 的 include 之外：`pnpm build` 会用 tsconfig.app.json
 * 检查 `tests/**`，探测脚本里一个多余变量就会让构建失败（上一轮踩过）。
 *
 *   pnpm exec vite preview --port 5199 --strictPort   # 先起服务
 *   pnpm exec tsx scripts/verify-bugv3.ts
 */
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright-core'

const BASE = process.env.SMOKE_URL ?? 'http://localhost:5199/'
const OUT = '.shots/bugv3'
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

mkdirSync(OUT, { recursive: true })

const results: { item: string; ok: boolean; detail: string }[] = []
function check(item: string, ok: boolean, detail: unknown): void {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail)
  results.push({ item, ok, detail: text })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${item}  ${text}`)
}

/** 页面侧小工具（字符串形式传入，避免 tsx 注入的 __name 辅助函数）。 */
const HELPERS = `
window.C4 = {
  game: () => window.__CONNECT4__,
  scene: () => window.__CONNECT4__.scene.value,
  cell: (r, c) => r * 9 + c,
  scenario: (stones, options) => {
    const game = window.__CONNECT4__;
    const opts = options || {};
    game.ui.mode = opts.mode || 'pvp';
    game.ui.screen = 'playing';
    // 清掉上一轮留下的舞台棋子 / 特效，避免场景与新局面不一致
    game.scene.value.resetTransient();
    const board = new Array(81).fill(0);
    stones.forEach(function (entry) { board[entry[0] * 9 + entry[1]] = entry[2]; });
    game.engine.value.loadScenario(board, {
      hp: opts.hp || [6, 6],
      current: opts.current === undefined ? 0 : opts.current,
      firstPlayer: opts.current === undefined ? 0 : opts.current,
    });
    game.scene.value.setIdle(false);
    game.scene.value.setInteractive(true);
    game.scene.value.syncBoard(board);
    game.syncUi();
    return game.engine.value.phase;
  },
  // 注意：不要返回 handleCellPick 的 promise —— page.evaluate 会 await 它，
  // 那样采样代码只能等到整段动画播完之后才执行，看不到中间过程。
  pick: (cell) => { window.__CONNECT4__.handleCellPick(cell); return true; },
  pickAndWait: (cell) => window.__CONNECT4__.handleCellPick(cell),
  state: () => {
    const game = window.__CONNECT4__;
    const engine = game.engine.value;
    return { phase: engine.phase, uiPhase: game.ui.phase, hp: engine.hp.slice(), uiHp: game.ui.hp.slice(),
      tally: game.ui.tally.slice(), highlights: Array.from(engine.highlights.keys()), board: Array.from(engine.board),
      dark: document.querySelector('.app-root').classList.contains('is-dimmed'), staged: window.C4.staged() };
  },
  staged: () => {
    const scene = window.C4.scene();
    const camera = scene.rig.camera;
    return scene.staged.map(function (item) {
      const p = item.base.clone().project(camera);
      return { owner: item.owner, ndcX: Number(p.x.toFixed(3)), ndcY: Number(p.y.toFixed(3)),
        spinSpeed: Number(item.spinSpeed.toFixed(3)) };
    });
  },
  stagedMeshes: () => window.C4.scene().staged.map(function (item) {
    const material = item.mesh.material;
    const aura = item.mesh.getObjectByName('aura');
    return { owner: item.owner, color: '#' + material.color.getHexString(),
      emissive: '#' + material.emissive.getHexString(),
      emissiveIntensity: Number(material.emissiveIntensity.toFixed(3)),
      auraColor: aura ? '#' + aura.material.color.getHexString() : null,
      auraOpacity: aura ? Number(aura.material.opacity.toFixed(3)) : null };
  }),
  durations: () => {
    window.__durations = [];
    const anim = window.C4.scene().animator;
    const orig = anim.run.bind(anim);
    anim.run = function (d, u, o) { window.__durations.push(Number(d.toFixed(4))); return orig(d, u, o); };
    return window.__durations.length;
  },
  resetDurations: () => { window.__durations = []; },
  readDurations: () => window.__durations.slice(),
  pieceAt: (cell) => {
    const mesh = window.C4.scene().pieces.get(cell);
    if (!mesh) return null;
    const material = mesh.material;
    return { color: '#' + material.color.getHexString(), emissive: '#' + material.emissive.getHexString(),
      emissiveIntensity: Number(material.emissiveIntensity.toFixed(3)),
      ground: Boolean(mesh.getObjectByName('ground')), aura: Boolean(mesh.getObjectByName('aura')) };
  },
  boardPieceCount: () => window.C4.scene().pieces.boardPieces.length,
  tallies: () => Array.from(document.querySelectorAll('.tally')).map(function (el) {
    const value = el.querySelector('.tally__value');
    const rect = el.getBoundingClientRect();
    return { visible: el.classList.contains('is-visible'), text: value ? value.textContent : null,
      fontSize: value ? getComputedStyle(value).fontSize : null,
      textShadow: value ? getComputedStyle(value).textShadow : null,
      x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  }),
  dimLayers: () => {
    const root = document.querySelector('.app-root');
    return { overlayZ: getComputedStyle(root, '::after').zIndex,
      boardZ: getComputedStyle(document.querySelector('.board-layer')).zIndex,
      panelBackground: getComputedStyle(document.querySelector('.player-panel')).backgroundColor,
      dimmed: root.classList.contains('is-dimmed') };
  },
  vfx: () => {
    const scene = window.C4.scene();
    return { ripple: scene.ripple.mesh.material.type, rippleBlending: scene.ripple.mesh.material.blending,
      flash: scene.screenFlash.mesh.material.type, particles: scene.particles.points.material.type };
  },
};
'ready'
`

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-gpu-sandbox',
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
  ],
})

const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const problems: string[] = []
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(`[${message.type()}] ${message.text()}`)
})
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`))

await page.goto(BASE, { waitUntil: 'load' })
await page.evaluate(HELPERS)
await page.waitForTimeout(1500)

/** 等上一段动画彻底播完：换局面时如果打断进行中的事件流，状态会错乱。 */
async function idle(timeoutMs = 9000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const busy = await page.evaluate('window.C4.game().ui.busy')
    if (!busy) return
    await page.waitForTimeout(80)
  }
}

/** 布置局面（先等空闲）。 */
async function scenario(stones: string, options: string): Promise<void> {
  await idle()
  await page.evaluate(`window.C4.scenario(${stones}, ${options})`)
  await page.waitForTimeout(350)
}

async function pick(cell: string): Promise<void> {
  await page.evaluate(`window.C4.pick(${cell})`)
}

/** 等到“可以落子 + 处于指定阶段”。 */
async function waitPhase(expected: string, timeoutMs = 9000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await page.evaluate('({ busy: window.C4.game().ui.busy, phase: window.C4.game().engine.value.phase })')
    if (!state.busy && state.phase === expected) return true
    await page.waitForTimeout(60)
  }
  return false
}

/** 把截图送回页面量亮度（平均 0..255）。 */
async function brightness(pageRef: Page, clip: { x: number; y: number; width: number; height: number }): Promise<number> {
  const shot = await pageRef.screenshot({ clip, type: 'png' })
  const dataUrl = `data:image/png;base64,${shot.toString('base64')}`
  return pageRef.evaluate(`(async () => {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = ${JSON.stringify(dataUrl)}; });
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    return Number((sum / (data.length / 4)).toFixed(1));
  })()`)
}

const box = await page.locator('#board-canvas').boundingBox()
if (!box) throw new Error('找不到画布')
// 一次用户手势：解锁音频（背景音乐）
await page.mouse.click(box.x + 30, box.y + box.height - 30)
await page.waitForTimeout(500)

// ===========================================================================
// #7 背景音乐
// ===========================================================================
const bgm1 = await page.evaluate(`(function () {
  const element = window.__CONNECT4__.bgm.element;
  if (!element) return { exists: false };
  return { exists: true, loop: element.loop, paused: element.paused, volume: element.volume,
    currentTime: Number(element.currentTime.toFixed(2)), src: element.currentSrc.split('/').pop() };
})()`)
await page.waitForTimeout(1400)
const bgm2 = await page.evaluate(`(function () {
  const element = window.__CONNECT4__.bgm.element;
  return element ? { currentTime: Number(element.currentTime.toFixed(2)), paused: element.paused } : null;
})()`)
check(
  '#7 bgm.mp3 作为背景音乐循环播放',
  bgm1.exists === true && bgm1.loop === true && bgm1.paused === false && (bgm2?.currentTime ?? 0) > bgm1.currentTime,
  { ...bgm1, later: bgm2 },
)

// ===========================================================================
// #8 黑白棋子 + 特征色
// ===========================================================================
// 注意：棋盘数组的值是 player + 1（1 = player 0，2 = player 1）
await scenario('[[4,4,1],[4,5,2],[5,5,1]]', '{ hp: [6,6], current: 0 }')
const stones = await page.evaluate(`({ black: window.C4.pieceAt(window.C4.cell(4,4)), white: window.C4.pieceAt(window.C4.cell(4,5)) })`)
check('#8 场上棋子改为黑白棋子（带接地阴影）', stones.black?.color === '#0b0c10' && stones.white?.color === '#f6f7f9' && stones.black?.ground === true && stones.white?.ground === true, stones)
// bugv4 #1 之后：棋盘棋子的颜色**不受特征色影响**（特征色只在高光 / 特效 / 悬浮附着层上）
check('#8 棋盘棋子不被特征色染色（bugv4 #1）', stones.black?.emissive === '#000000' && stones.white?.emissive === '#000000' && stones.black?.emissiveIntensity === 0, { black: stones.black?.emissive, white: stones.white?.emissive })
await scenario('[[2,2,1],[3,2,1],[4,2,1],[2,5,2],[3,5,2],[4,5,2],[4,4,1],[4,3,2]]', '{ hp: [6,6], current: 0 }')
await page.screenshot({ path: `${OUT}/07-stones.png` })

// ===========================================================================
// #1 / #4 攻击棋子贴边、各自在己侧；翻转速度 +50%
// ===========================================================================
await scenario('[[8,0,1],[8,1,1],[8,2,1],[6,4,2]]', '{ hp: [6,6], current: 0 }')
await pick('window.C4.cell(8,3)')
const defenseReady = await waitPhase('awaitingDefense')
const attackerStage = await page.evaluate('window.C4.staged()')
const talliesDuringDefense = await page.evaluate('window.C4.tallies()')
await page.screenshot({ path: `${OUT}/01-attacker-stage.png` })
check('#1 攻击方棋子只在自己那一侧（player 0 = 屏幕左侧）', defenseReady && attackerStage.length === 4 && attackerStage.every((item: { owner: number; ndcX: number }) => item.owner === 0 && item.ndcX < -0.5), attackerStage)
check('#4 悬浮位置贴近画面边缘（|NDC x| >= 0.6）', attackerStage.every((item: { ndcX: number }) => Math.abs(item.ndcX) >= 0.6), attackerStage.map((item: { ndcX: number; ndcY: number }) => [item.ndcX, item.ndcY]))
check('#4 悬浮自由翻转速度（bugv3 #4 +50%，bugv4 #7 再 +50% → 2.03~4.05）', attackerStage.every((item: { spinSpeed: number }) => item.spinSpeed >= 2.02 && item.spinSpeed <= 4.06), attackerStage.map((item: { spinSpeed: number }) => item.spinSpeed))
const attackerMeshes = await page.evaluate('window.C4.stagedMeshes()')
// bugv9 #13：默认角色是 DeepSeek（#3964fe），这里比对"当前特征色"而不是写死旧的红蓝
const bugv3Palette = (await page.evaluate('window.__CONNECT4__.players[0].palette.color')) as number
const bugv3SideColor = `#${bugv3Palette.toString(16).padStart(6, '0')}`
check('#8 悬浮攻击棋子表面附着特征色（aura 外壳）', attackerMeshes.length === 4 && attackerMeshes.every((item: { auraColor: string | null }) => item.auraColor === bugv3SideColor), { side: bugv3SideColor, attackerMeshes })

// ===========================================================================
// #6 总攻击数数字
// ===========================================================================
check('#6 悬浮棋子旁显示总攻击数（4，字号更大）', talliesDuringDefense[0]?.visible === true && talliesDuringDefense[0]?.text === '4' && Number.parseFloat(talliesDuringDefense[0]?.fontSize) > 30 && talliesDuringDefense[1]?.visible === false, talliesDuringDefense)
check('#6 发光字（text-shadow 有辉光）', typeof talliesDuringDefense[0]?.textShadow === 'string' && talliesDuringDefense[0].textShadow.length > 20, talliesDuringDefense[0]?.textShadow)
const tallyNear = await page.evaluate(`(function () {
  const scene = window.C4.scene();
  const screen = scene.rig.worldToScreen(scene.staged[0].base);
  const rect = document.querySelector('.tally.is-visible').getBoundingClientRect();
  const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  return { piece: [Math.round(screen.x), Math.round(screen.y)], tally: [Math.round(center.x), Math.round(center.y)],
    distance: Math.round(Math.hypot(screen.x - center.x, screen.y - center.y)) };
})()`)
check('#6 数字紧邻悬浮棋子（< 200px）', tallyNear.distance < 200, tallyNear)
await idle()
await scenario('[[8,0,1],[8,1,1],[8,2,1],[8,3,1],[8,4,1],[8,5,1],[6,4,2]]', '{ hp: [6,6], current: 0 }')
await pick('window.C4.cell(8,6)')
await waitPhase('awaitingDefense')
const bigTally = await page.evaluate('window.C4.tallies()')
await page.screenshot({ path: `${OUT}/05-tally-7.png` })
check('#6 攻击数越大字号越大（4 -> 7）', bigTally[0]?.text === '7' && Number.parseFloat(bigTally[0]?.fontSize) > Number.parseFloat(talliesDuringDefense[0]?.fontSize), { small: talliesDuringDefense[0]?.fontSize, big: bigTally[0]?.fontSize })

// ===========================================================================
// #5 防守方在攻击方高光位落子并成线 → 新棋子必须一起消失
// ===========================================================================
await scenario('[[0,0,1],[0,1,1],[0,2,1],[1,3,2],[2,3,2],[3,3,2]]', '{ hp: [6,6], current: 0 }')
await pick('window.C4.cell(0,3)')
const defenseReady2 = await waitPhase('awaitingDefense')
const highlightState = await page.evaluate(`({ highlights: window.C4.state().highlights, boardPieces: window.C4.boardPieceCount(), clashCellPiece: window.C4.pieceAt(window.C4.cell(0,3)) })`)
// 防守方在高光位 (0,3) 落子，同时形成竖向 4 连珠
await pick('window.C4.cell(0,3)')
let maxBlueStaged = 0
let sawClashCellPiece = false
let clashCellGoneAfterSeen = false
let clashCellBoard = -1
let sawDefenderTally = false
for (let i = 0; i < 45; i++) {
  await page.waitForTimeout(60)
  const sample = await page.evaluate(`({ blue: window.C4.staged().filter(function (s) { return s.owner === 1; }).length, hasPiece: window.C4.pieceAt(window.C4.cell(0,3)) !== null, board: window.C4.state().board[3], tallies: window.C4.tallies() })`)
  maxBlueStaged = Math.max(maxBlueStaged, sample.blue)
  if (sample.tallies[1]?.visible === true && sample.tallies[1]?.text === '4') sawDefenderTally = true
  if (sample.hasPiece) sawClashCellPiece = true
  else if (sawClashCellPiece) {
    clashCellGoneAfterSeen = true
    clashCellBoard = sample.board
  }
}
await page.screenshot({ path: `${OUT}/02-defense-highlight.png` })
check('#5 防守方在高光位成线后棋子离开棋盘（不再残留）', defenseReady2 && highlightState.highlights.includes(3) && sawClashCellPiece && clashCellGoneAfterSeen && clashCellBoard === 0 && maxBlueStaged === 4, { defenseReady2, highlightState, sawClashCellPiece, clashCellGoneAfterSeen, clashCellBoard, maxBlueStaged })
check('#6 防守方一侧同样显示自己的攻击数（反击 = 4）', sawDefenderTally, { sawDefenderTally })

// ===========================================================================
// #2 暗场不压暗悬浮棋子 / 对撞特效 / 血条
// ===========================================================================
// 造出“攻击方棋子悬浮在舞台上”的局面，先量亮场基准
await scenario('[[0,0,1],[0,1,1],[0,2,1],[1,3,2],[2,3,2],[3,3,2]]', '{ hp: [6,6], current: 0 }')
await pick('window.C4.cell(0,3)')
await waitPhase('awaitingDefense')
const panelClip = { x: 30, y: 30, width: 240, height: 120 }
const centerClip = { x: 520, y: 330, width: 400, height: 240 }
const litPanel = await brightness(page, panelClip)
const litCenter = await brightness(page, centerClip)
const litStage = await page.evaluate('window.C4.stagedMeshes()')
await page.screenshot({ path: `${OUT}/04-before-dark.png` })

// 直接开暗场，隔离验证“哪些东西不该被压暗”
await page.evaluate('window.C4.scene().setDarkMode(true)')
await page.waitForTimeout(900)
const darkState = await page.evaluate('window.C4.dimLayers()')
const darkPanel = await brightness(page, panelClip)
const darkCenter = await brightness(page, centerClip)
const darkStage = await page.evaluate('window.C4.stagedMeshes()')
await page.screenshot({ path: `${OUT}/03-dark-stage.png` })
await page.evaluate('window.C4.scene().setDarkMode(false)')

check('#2 暗场叠加层在画布之下（血条 / 特效不被压暗）', darkState.overlayZ === '0' && darkState.boardZ === '1', darkState)
check('#2 场地明显变暗（棋盘区域亮度下降 > 35%）', darkCenter < litCenter * 0.65, { lit: litCenter, dark: darkCenter, ratio: Number((darkCenter / litCenter).toFixed(2)) })
check('#2 顶部血条不被压暗（亮度变化 < 20%）', Math.abs(darkPanel - litPanel) / litPanel < 0.2 && darkState.panelBackground.includes('0.97'), { lit: litPanel, dark: darkPanel, ratio: Number((darkPanel / litPanel).toFixed(2)), bg: darkState.panelBackground })
const vfx = await page.evaluate('window.C4.vfx()')
check('#2 对撞特效使用不受光照影响的加色材质', vfx.ripple === 'ShaderMaterial' && vfx.rippleBlending === 2 && vfx.flash === 'ShaderMaterial' && vfx.particles === 'ShaderMaterial', vfx)
check('#2 暗场中悬浮棋子 / 附着层被提亮（自发光 0.14->0.85，aura 0.26->0.5）', litStage[0]?.emissiveIntensity === 0.14 && litStage[0]?.auraOpacity === 0.26 && darkStage[0]?.emissiveIntensity === 0.85 && darkStage[0]?.auraOpacity === 0.5, { lit: litStage[0], dark: darkStage[0] })

// ===========================================================================
// #3 对撞 / 撞血条提速 50%
// ===========================================================================
await scenario('[[0,0,1],[0,1,1],[0,2,1],[1,3,2],[2,3,2],[3,3,2]]', '{ hp: [6,6], current: 0 }')
await pick('window.C4.cell(0,3)')
await waitPhase('awaitingDefense')
await page.evaluate('window.C4.durations()')
await page.evaluate('window.C4.resetDurations()')
await pick('window.C4.cell(0,3)')
await page.waitForTimeout(5600)
const durations: number[] = await page.evaluate('window.C4.readDurations()')
check(
  '#3 对撞与撞血条时长（bugv3 +50% 后再叠加 bugv4 #7 的 -30%：0.2286 / 0.1905 / 0.4）',
  durations.some((d) => Math.abs(d - 0.2286) < 0.001) &&
    durations.some((d) => Math.abs(d - 0.1905) < 0.001) &&
    durations.some((d) => Math.abs(d - 0.4) < 0.001),
  durations,
)
await page.screenshot({ path: `${OUT}/06-timings.png` })

// ===========================================================================
console.log('\n============================= 汇总 =============================')
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.item}`)
console.log(`通过 ${results.filter((r) => r.ok).length}/${results.length}`)
console.log('console problems:', problems.length ? problems : 'none')
console.log(`截图：${OUT}/`)

await browser.close()
