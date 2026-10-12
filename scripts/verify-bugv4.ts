/**
 * bugv4 逐条验证（临时脚本，不属于交付内容）。
 *
 *   pnpm exec vite preview --port 5199 --strictPort
 *   pnpm exec tsx scripts/verify-bugv4.ts
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'

const BASE = process.env.SMOKE_URL ?? 'http://localhost:5199/'
const OUT = '.shots/bugv4'
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

mkdirSync(OUT, { recursive: true })

const results: { item: string; ok: boolean; detail: string }[] = []
function check(item: string, ok: boolean, detail: unknown): void {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail)
  results.push({ item, ok, detail: text })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${item}  ${text}`)
}

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
    game.ui.diceVisible = false;
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
  pick: (cell) => { window.__CONNECT4__.handleCellPick(cell); return true; },
  piece: (cell) => {
    const mesh = window.C4.scene().pieces.get(cell);
    if (!mesh) return null;
    const material = mesh.material;
    return { color: '#' + material.color.getHexString(), emissive: '#' + material.emissive.getHexString(),
      emissiveIntensity: Number(material.emissiveIntensity.toFixed(3)),
      y: Number(mesh.position.y.toFixed(3)), ground: Boolean(mesh.getObjectByName('ground')) };
  },
  staged: () => window.C4.scene().staged.map(function (item) {
    const p = item.base.clone().project(window.C4.scene().rig.camera);
    return { owner: item.owner, x: Number(item.base.x.toFixed(2)), ndcX: Number(p.x.toFixed(3)),
      spinSpeed: Number(item.spinSpeed.toFixed(3)) };
  }),
  tilt: () => {
    const scene = window.C4.scene();
    const rig = scene.rig.boardTilt();
    return { groupX: Number(scene.tiltGroup.rotation.x.toFixed(4)), groupZ: Number(scene.tiltGroup.rotation.z.toFixed(4)),
      rigX: Number(rig.rotateX.toFixed(4)), rigZ: Number(rig.rotateZ.toFixed(4)) };
  },
  effects: () => {
    const scene = window.C4.scene();
    return { bursts: scene.effects.bursts.length, rings: scene.effects.rings.length,
      particles: scene.particles.points.geometry.drawRange.count, ripple: scene.ripple.mesh.visible,
      flash: scene.effects.flashAmount };
  },
  durations: () => { window.__durations = []; const anim = window.C4.scene().animator;
    const orig = anim.run.bind(anim);
    anim.run = function (d, u, o) { window.__durations.push(Number(d.toFixed(4))); return orig(d, u, o); };
    return window.__durations.length; },
  resetDurations: () => { window.__durations = []; },
  readDurations: () => window.__durations.slice(),
  card: () => { const el = document.querySelector('.attack-card');
    if (!el) return null; const rect = el.getBoundingClientRect();
    return { left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom),
      viewport: [window.innerWidth, window.innerHeight] }; },
  dice: () => ({ visible: window.__CONNECT4__.ui.diceVisible, interactive: window.C4.scene().interactive,
    busy: window.__CONNECT4__.ui.busy }),
  state: () => { const game = window.__CONNECT4__; const engine = game.engine.value;
    return { phase: engine.phase, moveCount: engine.moveCount.value, hp: engine.hp.slice(), current: engine.current,
      board: engine.board.filter(function (v) { return v !== 0; }).length, result: engine.result,
      mode: game.ui.mode, isAiTurn: game.isAiTurn.value }; },
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
await page.waitForTimeout(1400)

async function idle(timeoutMs = 12000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const busy = await page.evaluate('window.C4.game().ui.busy')
    if (!busy) return
    await page.waitForTimeout(70)
  }
}

async function scenario(stones: string, options: string): Promise<void> {
  await idle()
  await page.evaluate(`window.C4.scenario(${stones}, ${options})`)
  await page.waitForTimeout(250)
}

// ===========================================================================
// #2 骰子未消失前不能下子
// ===========================================================================
{
  // 用双人模式验证（没有 AI 抢手，落子只可能来自点击）
  await page.evaluate('window.__CONNECT4__.backToMenu()')
  await page.waitForTimeout(300)
  await page.evaluate('window.__CONNECT4__.setMode("pvp")')
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: /开始游戏|开始观战/ }).click()
  await page.waitForTimeout(700) // 开局动画已播完，但骰子还在
  const during = await page.evaluate('window.C4.dice()')
  const canvasBox = await page.locator('#board-canvas').boundingBox()
  if (canvasBox) {
    await page.mouse.click(canvasBox.x + canvasBox.width * 0.5, canvasBox.y + canvasBox.height * 0.5)
  }
  await page.waitForTimeout(250)
  const afterClick = await page.evaluate('window.C4.state()')
  // 等骰子淡出，再点一次：这次应该能正常落子
  const deadline = Date.now() + 6000
  let later = await page.evaluate('window.C4.dice()')
  while (later.visible && Date.now() < deadline) {
    await page.waitForTimeout(120)
    later = await page.evaluate('window.C4.dice()')
  }
  if (canvasBox) {
    await page.mouse.click(canvasBox.x + canvasBox.width * 0.5, canvasBox.y + canvasBox.height * 0.5)
  }
  await page.waitForTimeout(600)
  const afterDice = await page.evaluate('window.C4.state()')
  check(
    '#2 骰子未消失前棋盘不可交互（点击无效），消失后恢复可下子',
    during.visible === true && during.interactive === false && afterClick.moveCount === 0 &&
      later.visible === false && later.interactive === true && afterDice.moveCount === 1,
    { during, afterClickMoves: afterClick.moveCount, later, afterDiceMoves: afterDice.moveCount },
  )
}

// ===========================================================================
// #1 场上棋子是纯黑白，不受特征色影响
// ===========================================================================
{
  await scenario('[[4,4,1],[4,5,2],[5,4,1],[3,5,2]]', '{ hp: [6,6], current: 0 }')
  const black = await page.evaluate('window.C4.piece(window.C4.cell(4,4))')
  const white = await page.evaluate('window.C4.piece(window.C4.cell(4,5))')
  check(
    '#1 场上的黑棋是纯黑、白棋是纯白（自发光为 0，不掺特征色）',
    black?.color === '#0b0c10' && black?.emissive === '#000000' && black?.emissiveIntensity === 0 &&
      white?.color === '#f6f7f9' && white?.emissive === '#000000',
    { black, white },
  )
  // 连珠高光也只提亮度，不改色
  await page.evaluate('window.C4.scene().pieces.setMatchGlow(1)')
  const glow = await page.evaluate('window.C4.piece(window.C4.cell(4,4))')
  check('#1 连珠高光只提亮度（白色自发光），不给黑子染红', glow?.emissive === '#ffffff' && glow?.color === '#0b0c10', glow)
  await page.evaluate('window.C4.scene().pieces.setMatchGlow(0)')
  await page.screenshot({ path: `${OUT}/01-stones.png` })
}

// ===========================================================================
// #3 结算面板移到左下角
// ===========================================================================
{
  await scenario('[[0,0,1],[0,1,1],[0,2,1],[1,3,2],[2,3,2],[3,3,2]]', '{ hp: [6,6], current: 0 }')
  await page.evaluate('window.C4.pick(window.C4.cell(0,3))')
  await page.waitForTimeout(1800)
  const card = await page.evaluate('window.C4.card()')
  check(
    '#3 结算面板在左下角（不挡两侧悬浮棋子）',
    card !== null && card.left < 300 && card.top > card.viewport[1] * 0.55,
    card,
  )
  await page.screenshot({ path: `${OUT}/02-card-bottom-left.png` })
}

// ===========================================================================
// #4 落子后棋盘按落点方位倾斜，随后恢复
// ===========================================================================
{
  await scenario('[[8,0,1],[8,1,1],[8,2,1],[5,5,2]]', '{ hp: [6,6], current: 1 }')
  await page.evaluate('window.C4.pick(window.C4.cell(0,8))') // 靠右上角落子
  await page.waitForTimeout(220)
  const tilted = await page.evaluate('window.C4.tilt()')
  await page.waitForTimeout(1200)
  const restored = await page.evaluate('window.C4.tilt()')
  const deviation = Math.abs(tilted.groupX - tilted.rigX) + Math.abs(tilted.groupZ - tilted.rigZ)
  check(
    '#4 落子后按落点方位短暂倾斜，随后自行回正',
    deviation > 0.03 &&
      Math.abs(restored.groupX - restored.rigX) < 0.01 &&
      Math.abs(restored.groupZ - restored.rigZ) < 0.01,
    { tilted, restored, deviation: Number(deviation.toFixed(4)) },
  )
}

// ===========================================================================
// #5 落子不再下落；涟漪更大更慢
// ===========================================================================
{
  await scenario('[[8,0,1],[8,1,1],[8,2,1],[5,5,2]]', '{ hp: [6,6], current: 1 }')
  await page.evaluate('window.C4.pick(window.C4.cell(0,8))')
  await page.waitForTimeout(120)
  const early = await page.evaluate('window.C4.piece(window.C4.cell(0,8))')
  const fx = await page.evaluate('window.C4.effects()')
  check(
    '#5 落子直接出现在棋盘内（没有下落过程），并在落点放出更大更慢的涟漪',
    // bugv5 #2 之后：落子只有落点小波纹（不再打全屏大波纹）
    early !== null && early.y === 0.065 && early.ground === true && fx.rings >= 2,
    { early, fx },
  )
  await page.screenshot({ path: `${OUT}/03-place-ripple.png` })
}

// ===========================================================================
// #6 / #7 / #8 抵消阶段：入位 1.5s → 光芒炸裂 + 粒子爆发；速度与翻转
// ===========================================================================
{
  await scenario('[[0,0,1],[0,1,1],[0,2,1],[1,3,2],[2,3,2],[3,3,2]]', '{ hp: [6,6], current: 0 }')
  await page.evaluate('window.C4.pick(window.C4.cell(0,3))')
  await page.waitForTimeout(2000)
  // 攻击方悬浮（贴屏幕边缘）时的世界坐标，作为"入位前"的基准
  const hoverX = (await page.evaluate('window.C4.staged()')) as { x: number }[]
  await page.evaluate('window.C4.durations()')
  await page.evaluate('window.C4.resetDurations()')
  await page.evaluate('window.C4.pick(window.C4.cell(0,3))') // 防守方成线 → 抵消
  // 入位结束后双方棋子应停在棋盘左右两侧（之后会被逐对对撞消耗掉，所以要采样取到那一刻）
  let maxAtGather = 0
  let gatherSample: number[] = []
  let burstSeen = 0
  let flashSeen = 0
  for (let i = 0; i < 70; i++) {
    await page.waitForTimeout(60)
    const sample = (await page.evaluate('window.C4.staged()')) as { x: number }[]
    const fx = await page.evaluate('window.C4.effects()')
    burstSeen = Math.max(burstSeen, fx.bursts)
    flashSeen = Math.max(flashSeen, fx.flash)
    const atGather = sample.filter((item) => Math.abs(item.x) > 4.72 && Math.abs(item.x) < 5.08)
    if (atGather.length > maxAtGather) {
      maxAtGather = atGather.length
      gatherSample = atGather.map((item) => item.x)
    }
    if (i === 40) await page.screenshot({ path: `${OUT}/04-gather.png` })
    if (burstSeen > 0 && i > 20) await page.screenshot({ path: `${OUT}/05-clash.png` })
  }
  await page.waitForTimeout(2600)
  const durations: number[] = await page.evaluate('window.C4.readDurations()')
  const hoverAbs = Math.abs(hoverX[0]?.x ?? 0)
  check(
    '#8 抵消前插入入位动画：双方棋子移到棋盘左右两侧（|x| ≈ 4.9），耗时 1.5 秒',
    durations.includes(1.5) && maxAtGather >= 4,
    { hasGatherDuration: durations.includes(1.5), maxAtGather, gatherSample, hoverAbs },
  )
  check(
    '#8 入位位置确实比"贴屏幕边缘"的悬浮位置更靠内',
    hoverAbs - 4.9 > 0.25 && maxAtGather >= 4,
    { hoverAbs, gatherX: 4.9 },
  )
  check('#6 对撞时出现光芒炸裂（starburst）与粒子爆发', burstSeen >= 2 && flashSeen > 0, { burstSeen, flashSeen })
  check(
    '#7 对撞 / 撞血条减速 30%（0.24→0.2286，0.2→0.1905，0.42→0.4）',
    durations.some((d) => Math.abs(d - 0.2286) < 0.001) &&
      durations.some((d) => Math.abs(d - 0.1905) < 0.001) &&
      durations.some((d) => Math.abs(d - 0.4) < 0.001),
    durations,
  )
}

// ===========================================================================
// #7 悬浮时间加快（翻转速度）
// ===========================================================================
{
  await scenario('[[8,0,1],[8,1,1],[8,2,1],[6,4,2]]', '{ hp: [6,6], current: 0 }')
  await page.evaluate('window.C4.pick(window.C4.cell(8,3))')
  await page.waitForTimeout(2000)
  const staged = await page.evaluate('window.C4.staged()')
  check(
    '#7 悬浮自由翻转速度再 +50%（基准 0.9~1.8 → 2.03~4.05）',
    staged.length === 4 && staged.every((item: { spinSpeed: number }) => item.spinSpeed >= 2.02 && item.spinSpeed <= 4.06),
    staged.map((item: { spinSpeed: number }) => item.spinSpeed),
  )
}

// ===========================================================================
// #9 AI 对战（观战）自动推进
// ===========================================================================
{
  await page.evaluate('window.__CONNECT4__.backToMenu()')
  await page.waitForTimeout(400)
  const total = await page.evaluate(`(async () => {
    const game = window.__CONNECT4__;
    game.ui.mode = 'pvp';
    await game.setMode('eve');
    return game.ui.mode;
  })()`)
  await page.getByRole('button', { name: /开始观战|开始游戏/ }).click()
  await page.waitForTimeout(800)
  const before = await page.evaluate('window.C4.state()')
  await page.waitForTimeout(9000)
  const after = await page.evaluate('window.C4.state()')
  check(
    '#9 AI 对战模式两边 AI 自动落子（无需人工输入）',
    total === 'eve' && after.mode === 'eve' && after.moveCount >= before.moveCount + 2,
    { mode: total, before: before.moveCount, after: after.moveCount, phase: after.phase, hp: after.hp },
  )
  await page.screenshot({ path: `${OUT}/06-eve.png` })
}

// ===========================================================================
console.log('\n============================= 汇总 =============================')
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.item}`)
console.log(`通过 ${results.filter((r) => r.ok).length}/${results.length}`)
console.log('console problems:', problems.length ? problems : 'none')
console.log(`截图：${OUT}/`)

await browser.close()
