/**
 * bugv5 逐条验证（临时脚本，不属于交付内容）。
 *
 *   pnpm exec vite preview --port 5199 --strictPort
 *   pnpm exec tsx scripts/verify-bugv5.ts
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'

const BASE = process.env.SMOKE_URL ?? 'http://localhost:5199/'
const OUT = '.shots/bugv5'
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
  staged: () => window.C4.scene().staged.map(function (item) {
    const p = item.base.clone().project(window.C4.scene().rig.camera);
    return { owner: item.owner, x: Number(item.base.x.toFixed(2)), ndcX: Number(p.x.toFixed(3)),
      magic: Boolean(item.magic), spinSpeed: Number(item.spinSpeed.toFixed(3)) };
  }),
  effects: () => {
    const scene = window.C4.scene();
    const effects = scene.effects;
    return { rings: effects.rings.length, suns: effects.suns.length, bursts: effects.bursts.length,
      beams: effects.beams.length, shards: scene.pieces.shards.length,
      sunLight: Number(effects.sunLight.intensity.toFixed(2)),
      ringMaterial: effects.rings[0] ? effects.rings[0].mesh.material.type : null,
      ringSpikes: effects.rings[0] ? Number(effects.rings[0].mesh.material.uniforms.uSpikes.value.toFixed(2)) : null,
      rippleVisible: scene.ripple.mesh.visible };
  },
  durations: () => { window.__durations = []; const anim = window.C4.scene().animator;
    const orig = anim.run.bind(anim);
    anim.run = function (d, u, o) { window.__durations.push(Number(d.toFixed(4))); return orig(d, u, o); };
    return window.__durations.length; },
  readDurations: () => window.__durations.slice(),
  // 入位之后：双方棋子分别在棋盘的哪一侧
  gatherSides: () => {
    const staged = window.C4.scene().staged;
    const byOwner = { 0: [], 1: [] };
    staged.forEach(function (item) { byOwner[item.owner].push(Number(item.base.x.toFixed(2))); });
    return byOwner;
  },
  magic: () => window.C4.scene().staged.map(function (item) {
    if (!item.magic) return null;
    const p = item.magic.position.clone().project(window.C4.scene().rig.camera);
    return { visible: item.magic.visible, color: '#' + item.magic.material.color.getHexString(),
      size: Number(item.magic.scale.x.toFixed(2)), ndcX: Number(p.x.toFixed(2)),
      rotationZ: Number(item.magic.rotation.z.toFixed(3)) };
  }),
  workerReady: () => Boolean(window.__CONNECT4__.ai && window.__CONNECT4__.ai.worker),
  bgm: () => {
    const game = window.__CONNECT4__;
    return { track: game.ui.bgmTrack, tracks: game.bgmTracks.map(function (t) { return t.name; }),
      src: (game.bgm.element && game.bgm.element.currentSrc.split('/').pop()) || null,
      paused: game.bgm.element ? game.bgm.element.paused : null };
  },
  trail: () => {
    // bugv6 #3 起拖尾换成第三方库（cursor-effects 的 characterCursor）：
    // canvas 覆盖层、蓝色光点，不再有 .cursor-trail 那排 DOM 圆点
    const root = document.querySelector('.app-root');
    const canvas = Array.from(root.querySelectorAll('canvas')).find(function (c) { return c.style.zIndex === '30'; });
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0, sumR = 0, sumG = 0, sumB = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 24) { painted += 1; sumR += data[i]; sumG += data[i + 1]; sumB += data[i + 2]; }
    }
    return { canvas: true, zIndex: canvas.style.zIndex, painted: painted,
      avg: painted > 0 ? [Math.round(sumR / painted), Math.round(sumG / painted), Math.round(sumB / painted)] : null };
  },
  state: () => { const game = window.__CONNECT4__; const engine = game.engine.value;
    return { phase: engine.phase, moves: engine.moveCount.value, hp: engine.hp.slice(), mode: game.ui.mode,
      busy: game.ui.busy }; },
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

async function idle(timeoutMs = 14000): Promise<void> {
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
// #2 落子不再打全屏大波纹
// ===========================================================================
{
  await scenario('[[8,0,1],[8,1,1],[8,2,1],[5,5,2]]', '{ hp: [6,6], current: 1 }')
  await page.evaluate('window.C4.pick(window.C4.cell(0,8))')
  let rippleSeen = false
  let ringsSeen = 0
  // 圆环寿命只有 1.05~1.4s，必须在循环里就采样材质（循环结束后再去读就过期了）
  let ringMaterial: string | null = null
  let ringSpikes: number | null = null
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(60)
    const fx = await page.evaluate('window.C4.effects()')
    rippleSeen = rippleSeen || fx.rippleVisible
    ringsSeen = Math.max(ringsSeen, fx.rings)
    if (fx.rings > 0 && fx.ringMaterial) {
      ringMaterial = fx.ringMaterial
      ringSpikes = fx.ringSpikes
    }
  }
  check('#2 落子只有落点小波纹（没有全屏大波纹）', rippleSeen === false && ringsSeen >= 2, { rippleSeen, ringsSeen })
  check('#3 小波纹是频谱状（ShaderMaterial + 随机锯齿数）', ringMaterial === 'ShaderMaterial', { ringMaterial, ringSpikes })
  await page.screenshot({ path: `${OUT}/01-place-spectrum.png` })
}

// ===========================================================================
// #1 入位方向只跟"属于哪一方"有关（先后手都不能反过来）
// ===========================================================================
{
  // 让 player 1（青方，右侧）当攻击方：先手为 1
  for (const attacker of [0, 1] as const) {
    const red = attacker === 0
    const stones = red
      ? '[[0,0,1],[0,1,1],[0,2,1],[1,3,2],[2,3,2],[3,3,2]]'
      : '[[0,0,2],[0,1,2],[0,2,2],[1,3,1],[2,3,1],[3,3,1]]'
    await scenario(stones, `{ hp: [6,6], current: ${attacker} }`)
    await page.evaluate(`window.C4.pick(window.C4.cell(0,3))`)
    await idle()
    await page.evaluate(`window.C4.pick(window.C4.cell(0,3))`) // 防守方也成线 → 入位 + 抵消
    let sides = { 0: [] as number[], 1: [] as number[] }
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(60)
      const sample = (await page.evaluate('window.C4.gatherSides()')) as { 0: number[]; 1: number[] }
      if (sample[0].length > 0 && sample[1].length > 0 && Math.abs(sample[1][0]) > 4.5) {
        sides = sample
        break
      }
    }
    const leftOk = sides[0].length > 0 && sides[0].every((x) => x < 0)
    const rightOk = sides[1].length > 0 && sides[1].every((x) => x > 0)
    check(`#1 攻击方为 ${red ? '赤方(先手/左)' : '青方(后手/右)'} 时，入位仍在各自那一侧`, leftOk && rightOk, sides)
  }
}

// ===========================================================================
// #6 / #7 针状提示线
// ===========================================================================
{
  // 红方已有 2 子，补上第 3 子 → “只差一颗即可连珠”
  await scenario('[[4,4,1],[4,5,1],[2,2,2]]', '{ hp: [6,6], current: 0 }')
  await page.evaluate('window.C4.pick(window.C4.cell(4,3))')
  let beams = 0
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(60)
    const fx = await page.evaluate('window.C4.effects()')
    beams = Math.max(beams, fx.beams)
  }
  check('#7 下子后若"只差一颗即可连珠"，沿成线方向显示提示针', beams > 0, { beams })
  await page.screenshot({ path: `${OUT}/02-threat-hint.png` })

  await scenario('[[0,0,1],[0,1,1],[0,2,1],[5,5,2]]', '{ hp: [6,6], current: 0 }')
  await page.evaluate('window.C4.pick(window.C4.cell(0,3))')
  let matchBeams = 0
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(60)
    const fx = await page.evaluate('window.C4.effects()')
    matchBeams = Math.max(matchBeams, fx.beams)
  }
  check('#6 连珠提示线是针状（旋转体梭形，半径很小）', matchBeams > 0, { matchBeams })
  await page.screenshot({ path: `${OUT}/03-match-needle.png` })
}

// ===========================================================================
// #10 悬浮棋子的魔法阵
// ===========================================================================
{
  await scenario('[[8,0,1],[8,1,1],[8,2,1],[6,4,2]]', '{ hp: [6,6], current: 0 }')
  await page.evaluate('window.C4.pick(window.C4.cell(8,3))')
  await idle()
  const magic = await page.evaluate('window.C4.magic()')
  const first = magic[0]
  await page.waitForTimeout(400)
  const later = (await page.evaluate('window.C4.magic()'))[0]
  // bugv9 #12：魔法阵颜色由该方特征色决定（默认角色 DeepSeek = #3964fe）
  check(
    '#10 每颗悬浮棋子带一个特征色魔法阵（两个交错正方形）且在旋转',
    magic.length === 4 && magic.every((m: { visible: boolean } | null) => m?.visible === true) &&
      first?.color === '#3964fe' && first?.rotationZ !== later?.rotationZ,
    { count: magic.length, first, laterRotation: later?.rotationZ },
  )
  await page.screenshot({ path: `${OUT}/04-magic-circle.png` })
  await idle()
}

// ===========================================================================
// #8 太阳式爆发 + 棋子碎片
// ===========================================================================
{
  await scenario('[[0,0,1],[0,1,1],[0,2,1],[1,3,2],[2,3,2],[3,3,2]]', '{ hp: [6,6], current: 0 }')
  await page.evaluate('window.C4.pick(window.C4.cell(0,3))')
  await idle()
  await page.evaluate('window.C4.pick(window.C4.cell(0,3))') // 抵消
  let suns = 0
  let shards = 0
  let sunLight = 0
  let saved = false
  for (let i = 0; i < 70; i++) {
    await page.waitForTimeout(60)
    const fx = await page.evaluate('window.C4.effects()')
    suns = Math.max(suns, fx.suns)
    shards = Math.max(shards, fx.shards)
    sunLight = Math.max(sunLight, fx.sunLight)
    if (!saved && fx.suns > 0) {
      saved = true
      await page.screenshot({ path: `${OUT}/05-sun-clash.png` })
    }
  }
  check('#8 对撞出现"太阳"式爆发（含瞬时点光）', suns >= 1 && sunLight > 5, { suns, sunLight })
  check('#8 棋子炸开成碎片（烟花式粒子 + 碎块）', shards >= 20, { shards })
}

// ===========================================================================
// #4 AI 在 worker 里算（不卡动画）
// ===========================================================================
{
  await page.evaluate('window.__CONNECT4__.backToMenu()')
  await page.waitForTimeout(300)
  await page.evaluate('window.__CONNECT4__.setDifficulty("expert")')
  await page.evaluate('window.__CONNECT4__.setMode("eve")')
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /开始观战|开始游戏/ }).click()
  await page.waitForTimeout(2500)
  // 在 AI 思考期间测帧率：worker 化之后动画应该照常推进
  const frames = await page.evaluate(`(async () => {
    let count = 0;
    const started = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        count += 1;
        if (performance.now() - started > 2500) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return { count, ms: Math.round(performance.now() - started) };
  })()`)
  const state = await page.evaluate('window.C4.state()')
  const worker = await page.evaluate('window.C4.workerReady()')
  const fps = (frames.count / frames.ms) * 1000
  check('#4 强档 AI 思考期间动画不中断（worker 计算，帧率 > 20fps）', worker === true && fps > 20 && state.moves >= 1, { worker, fps: Number(fps.toFixed(1)), moves: state.moves })
}

// ===========================================================================
// #5 背景音乐曲库与切换
// ===========================================================================
{
  const before = await page.evaluate('window.C4.bgm()')
  // bugv9 #7：默认曲目改成 let me go.mp3（找不到才用第一首）
  const other = (before.tracks as string[]).find((name) => name !== before.track) ?? 'piano'
  await page.evaluate(`window.__CONNECT4__.setBgmTrack(${JSON.stringify(other)})`)
  await page.waitForTimeout(500)
  const after = await page.evaluate('window.C4.bgm()')
  check(
    '#5 列出 bgm 文件夹内所有 mp3，并且可以切换（默认用 let me go.mp3）',
    (before.tracks as string[]).length >= 2 &&
      (before.tracks as string[]).includes('let me go') &&
      before.track === 'let me go' &&
      after.track === other &&
      String(after.src).startsWith(other),
    { before, after },
  )
}

// ===========================================================================
// #9 鼠标拖尾（bugv6 #3 之后改为第三方库的蓝色光点拖尾）
// ===========================================================================
{
  await page.evaluate(`window.__CONNECT4__.startTrail(document.querySelector('.app-root'), { force: true })`)
  await page.waitForTimeout(200)
  await page.mouse.move(300, 300)
  await page.waitForTimeout(120)
  await page.mouse.move(900, 600, { steps: 24 })
  await page.waitForTimeout(160)
  const trail = await page.evaluate('window.C4.trail()')
  const avg = trail?.avg ?? [0, 0, 0]
  check(
    '#9 鼠标拖尾生效（canvas 覆盖层、蓝色光点、随节奏淡出）',
    trail !== null && trail.canvas === true && trail.painted > 100 && avg[2] > avg[0] + 25,
    trail,
  )
  await page.screenshot({ path: `${OUT}/06-trail.png` })
}

// ===========================================================================
console.log('\n============================= 汇总 =============================')
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.item}`)
console.log(`通过 ${results.filter((r) => r.ok).length}/${results.length}`)
console.log('console problems:', problems.length ? problems : 'none')
console.log(`截图：${OUT}/`)

await browser.close()
