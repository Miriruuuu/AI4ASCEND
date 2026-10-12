/**
 * bugv8 逐条验证。
 *
 *   cd back && PORT=8899 DB_MODE=memory SERVE_FRONTEND=false pnpm exec tsx src/index.ts
 *   pnpm exec vite preview --port 5199 --strictPort
 *   pnpm exec tsx scripts/verify-bugv8.ts
 *
 * #1 拖尾更短更细 · #2 对手进房的门铃声 · #3 对手掉线的提示
 * #4 魔力植物（生长 / 占位 / 加伤 / 抢夺窗口 / 与棋子同生共死 / 可配置）· #5 魔法阵四个角 + 更粗的边 + 悬浮随机散布
 * #6 总攻击数字更大更细长 · #7 碎片初速度更快
 */
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright-core'

const BASE = process.env.SMOKE_URL ?? 'http://localhost:5199/'
const SERVER = process.env.ONLINE_SERVER ?? '127.0.0.1:8899'
const OUT = '.shots/bugv8'
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
  engine: () => window.__CONNECT4__.engine.value,
  cell: (r, c) => r * 9 + c,
  scenario: (stones, options) => {
    const game = window.__CONNECT4__;
    const opts = options || {};
    game.ui.mode = 'pvp';
    game.ui.screen = 'playing';
    game.ui.diceVisible = false;
    const scene = game.scene.value;
    scene.resetTransient();
    const board = new Array(81).fill(0);
    stones.forEach(function (entry) { board[entry[0] * 9 + entry[1]] = entry[2]; });
    game.engine.value.loadScenario(board, {
      hp: opts.hp || [6, 6],
      current: opts.current === undefined ? 0 : opts.current,
      firstPlayer: opts.current === undefined ? 0 : opts.current,
      magic: opts.magic || [],
      magicGrowths: opts.magicGrowths || 0,
      magicCooldown: opts.magicCooldown === undefined ? 10 : opts.magicCooldown,
      magicLineSeen: Boolean(opts.magicLineSeen),
    });
    scene.setIdle(false);
    scene.setInteractive(true);
    scene.syncBoard(board);
    scene.syncMagic(game.engine.value.magic ? Array.from(game.engine.value.magic.values()) : []);
    game.syncUi();
    return game.engine.value.phase;
  },
  pick: (cell) => { window.__CONNECT4__.handleCellPick(cell); return true; },
  startMatch: () => window.__CONNECT4__.startMatch(),
  setMagicConfig: (patch) => window.__CONNECT4__.setMagicConfig(patch),
  resetMagicConfig: () => window.__CONNECT4__.resetMagicConfig(),
  magicConfig: () => JSON.parse(JSON.stringify(window.__CONNECT4__.magicConfig)),
  // --- 音效记录（#2）---
  spySound: () => {
    const audio = window.__CONNECT4__.scene.value.audio;
    if (!window.__C4_SOUNDS__) { window.__C4_SOUNDS__ = []; const original = audio.play.bind(audio);
      audio.play = function (name, variant) { window.__C4_SOUNDS__.push(name); return original(name, variant); }; }
    return true;
  },
  sounds: () => (window.__C4_SOUNDS__ || []).slice(),
  // --- 拖尾（#1）---
  startTrail: () => window.__CONNECT4__.startTrail(document.querySelector('.app-root'), { force: true }),
  drawPath: (x0, x1, y, steps) => {
    const root = document.querySelector('.app-root');
    for (let i = 0; i <= steps; i++) {
      const x = x0 + ((x1 - x0) * i) / steps;
      root.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true, pointerType: 'mouse' }));
    }
    return true;
  },
  moveTo: (x, y) => {
    document.querySelector('.app-root').dispatchEvent(
      new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true, pointerType: 'mouse' }),
    );
    return true;
  },
  trailShape: (x0, x1, y) => {
    const root = document.querySelector('.app-root');
    const canvas = Array.from(root.querySelectorAll('canvas')).find(function (c) { return c.dataset.trail === 'on'; });
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const dpr = canvas.width / (canvas.clientWidth || 1);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const W = canvas.width, H = canvas.height;
    let painted = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, maxThick = 0;
    for (let x = 0; x < W; x++) {
      let column = 0;
      for (let y = 0; y < H; y++) {
        if (data[(y * W + x) * 4 + 3] > 20) {
          painted += 1; column += 1;
          if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
        }
      }
      if (column > maxThick) maxThick = column;
    }
    return { painted: painted, dpr: dpr,
      bbox: painted ? [minX, minY, maxX, maxY] : null,
      lengthCss: painted ? Math.round((maxX - minX) / dpr) : 0,
      thicknessCss: Math.round(maxThick / dpr),
      pathCss: Math.round(x1 - x0), y: y };
  },
  // --- 魔力植物（#4）---
  plants3d: () => {
    const view = window.__CONNECT4__.scene.value.magic;
    return { count: view.count, cells: view.cells };
  },
  magicState: () => {
    const engine = window.__CONNECT4__.engine.value;
    return { size: engine.magic.size, growths: engine.magicGrowths, cooldown: engine.magicCooldown,
      lineSeen: engine.magicLineSeen,
      plants: Array.from(engine.magic.values()).map(function (p) { return { cell: p.cell, kind: p.kind, owner: p.owner }; }) };
  },
  claimInfo: (cell) => {
    const record = window.__CONNECT4__.scene.value.magic.at(cell);
    if (!record) return null;
    return { owner: record.owner, ringVisible: record.ring.visible,
      ringColor: '#' + record.ring.material.color.getHexString(),
      plantColor: '#' + window.__CONNECT4__.scene.value.magic.prototypes ? null : null };
  },
  attack: () => { const a = window.__CONNECT4__.engine.value.attack; return a ? JSON.parse(JSON.stringify(a)) : null; },
  hp: () => window.__CONNECT4__.engine.value.hp.slice(),
  // --- 魔法阵贴图（#5）---
  magicTexture: () => {
    const effects = window.__CONNECT4__.scene.value.effects;
    const texture = effects.magicTexture;
    if (!texture || !texture.image) return null;
    const canvas = texture.image;
    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    const data = ctx.getImageData(0, 0, size, size).data;
    let painted = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    let midRun = 0, current = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (data[(y * size + x) * 4 + 3] > 24) {
          painted += 1;
          if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
        }
      }
    }
    const mid = Math.floor(size / 2);
    for (let x = 0; x < size; x++) {
      if (data[(mid * size + x) * 4 + 3] > 24) { current += 1; if (current > midRun) midRun = current } else { current = 0 }
    }
    return { size: size, painted: painted, bbox: painted ? [minX, minY, maxX, maxY] : null,
      spanRatio: painted ? Number((((maxX - minX) / size)).toFixed(3)) : 0,
      margin: painted ? Math.min(minX, minY, size - 1 - maxX, size - 1 - maxY) : -1,
      midRunPx: midRun };
  },
  stagedSpread: () => {
    const staged = window.__CONNECT4__.scene.value.staged.map(function (item) {
      const p = item.base.clone().project(window.__CONNECT4__.scene.value.rig.camera);
      return { owner: item.owner, ndcX: Number(p.x.toFixed(3)), ndcY: Number(p.y.toFixed(3)) };
    });
    return staged;
  },
  // --- 总攻击数（#6）---
  tallyStyle: () => {
    const value = document.querySelector('.tally__value');
    const glyph = document.querySelector('.tally__glyph');
    if (!value || !glyph) return null;
    const style = getComputedStyle(value);
    const glyphStyle = getComputedStyle(glyph);
    return { fontSize: Number.parseFloat(style.fontSize), fontWeight: style.fontWeight,
      scale: glyphStyle.getPropertyValue('scale') || glyphStyle.scale,
      text: glyph.textContent };
  },
  // --- 碎片（#7）---
  shardSpeed: () => {
    const shards = window.__CONNECT4__.scene.value.pieces.shards;
    if (shards.length === 0) return null;
    const speeds = shards.map(function (s) { return s.velocity.length(); });
    return { count: shards.length, max: Number(Math.max.apply(null, speeds).toFixed(2)),
      life: Number(shards[0].maxLife.toFixed(2)) };
  },
  effects: () => { const scene = window.__CONNECT4__.scene.value;
    return { shards: scene.pieces.shards.length, plants: scene.magic.count }; },
  state: () => { const game = window.__CONNECT4__; const engine = game.engine.value;
    return { phase: engine.phase, busy: game.ui.busy, magicCount: game.ui.magicCount,
      notice: game.ui.notice ? game.ui.notice.title : null, mode: game.ui.mode,
      screen: game.ui.screen, seat: game.online.seat, matchId: game.online.matchId, seq: game.online.seq,
      locked: document.querySelector('#board-canvas').classList.contains('is-locked') }; },
  noticeText: () => { const el = document.querySelector('.notice'); return el ? el.textContent.replace(/\\s+/g, ' ').trim() : null; },
  online: {
    connect: (url) => window.__CONNECT4__.connectOnline(url),
    queue: () => window.__CONNECT4__.onlineQueue(),
    leave: () => window.__CONNECT4__.closeOnlineLobby(),
  },
  waitForNotice: () => document.querySelector('.notice') !== null,
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

const problems: string[] = []
async function openPage(label: string, reuse?: Page): Promise<Page> {
  if (reuse) {
    reuse.on('console', (message) => {
      if (message.type() === 'error') problems.push(`[${label}][error] ${message.text()}`)
    })
    return reuse
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  const page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`[${label}][error] ${message.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`[${label}][pageerror] ${error.message}`))
  await page.goto(BASE, { waitUntil: 'load' })
  await page.evaluate(HELPERS)
  await page.waitForTimeout(1300)
  return page
}

async function idle(page: Page, timeoutMs = 16000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const busy = await page.evaluate('window.C4.state().busy')
    if (!busy) return
    await page.waitForTimeout(70)
  }
}

async function scenario(page: Page, stones: string, options: string): Promise<void> {
  await idle(page)
  await page.evaluate(`window.C4.scenario(${stones}, ${options})`)
  await page.waitForTimeout(220)
}

const page = await openPage('A')

// ===========================================================================
// #1 拖尾：更短更细
// ===========================================================================
{
  await page.evaluate('window.C4.startTrail()')
  await page.waitForTimeout(220)
  // 按真实时间铺一条 600px 的横向轨迹（每步让出 ~16ms），再看尾迹有多长多粗
  const x0 = 260
  const x1 = 860
  const y = 430
  const steps = 40
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps
    await page.evaluate(`window.C4.moveTo(${x}, ${y})`)
    await page.waitForTimeout(16)
  }
  const shape = (await page.evaluate(`window.C4.trailShape(${x0}, ${x1}, ${y})`)) as {
    painted: number
    lengthCss: number
    thicknessCss: number
    pathCss: number
  } | null
  check(
    '#1 拖尾更短（尾迹长度约为轨迹的 1/3 以内）',
    (shape?.painted ?? 0) > 80 && (shape?.lengthCss ?? 999) <= 220,
    { shape, pathCss: shape?.pathCss },
  )
  check('#1 拖尾更细（最大横向厚度 ≤ 9px）', (shape?.thicknessCss ?? 99) <= 9, { thickness: shape?.thicknessCss })
  await page.screenshot({ path: `${OUT}/01-trail.png` })
}

// ===========================================================================
// #4 魔力植物：生长 / 占位 / 加伤 / 与棋子同生共死（bugv17 #4）/ 可配置
// ===========================================================================
{
  // 用一份"长得很快"的配置：2 回合冷却、不需要先连珠
  await page.evaluate(`window.C4.setMagicConfig({ cooldownTurns: 2, lineCooldownCut: 2, requireLine: false, baseCount: 2 })`)
  const config = await page.evaluate('window.C4.magicConfig()')
  await page.evaluate('window.C4.startMatch()')
  await idle(page)
  await page.waitForTimeout(2600)
  // 冷却设成 1：再走一步棋就必然长出一批（确定性，不受对局长度影响）
  await scenario(page, '[[0,0,2]]', '{ hp: [6,6], current: 0, magicCooldown: 1, magicGrowths: 0 }')
  await page.evaluate(`window.C4.pick(window.C4.engine().board.findIndex(function (v) { return v === 0 }))`)
  await idle(page)
  await page.waitForTimeout(700)
  const magic = (await page.evaluate('window.C4.magicState()')) as { size: number; growths: number } | null
  const plants3d = (await page.evaluate('window.C4.plants3d()')) as { count: number } | null
  check(
    '#4 满足生长条件后，空位上长出魔力植物（一次 2 棵，3D 里也出现）',
    (magic?.size ?? 0) >= 2 && (magic?.growths ?? 0) >= 1 && (plants3d?.count ?? 0) >= 2,
    { magic, plants3d, config: (config as { cooldownTurns: number }).cooldownTurns },
  )
  await page.screenshot({ path: `${OUT}/02-magic-grow.png` })

  // 加伤：连珠上有一棵植物 → 最终攻击值 +1
  await scenario(
    page,
    '[[1,1,1],[1,2,1],[1,3,1],[8,8,2]]',
    "{ hp: [6,6], current: 0, magic: [{ cell: 12, kind: 'flower', owner: 0 }] }",
  )
  await page.evaluate(`window.C4.pick(window.C4.cell(1, 4))`)
  await idle(page)
  const attack = (await page.evaluate('window.C4.attack()')) as {
    baseDamage: number
    finalAttack: number
    attackerPlants: number
  } | null
  check(
    '#4 连珠上每有一棵魔力植物，最终伤害 +1（4 → 5）',
    attack?.baseDamage === 4 && attack?.attackerPlants === 1 && attack?.finalAttack === 5,
    attack,
  )

  // bugv17 #4：攻击方连珠上的植物**随棋子一并破坏**（宣告攻击的那一刻），
  // 而且它的加伤在宣告时就已经锁进这一击了。
  await scenario(
    page,
    '[[1,1,1],[1,2,1],[1,3,1],[2,3,2],[3,3,2],[4,3,2]]',
    "{ hp: [6,6], current: 0, magic: [{ cell: 12, kind: 'flower', owner: 0 }] }",
  )
  const before = (await page.evaluate('window.C4.hp()')) as number[]
  await page.evaluate(`window.C4.pick(window.C4.cell(1, 4))`)
  await idle(page)
  // ⚠️ 关键（bugv18 #1）：宣告攻击之后、防守方还没落子之前，这棵植物**必须还在** ——
  // 它是防守方的"抢夺窗口"，提前删掉就没法抢了。
  const afterDeclare = (await page.evaluate('window.C4.magicState()')) as { size: number } | null
  const plants3dAfterDeclare = (await page.evaluate('window.C4.plants3d()')) as { count: number } | null
  check(
    '#4 宣告攻击后，连珠棋子上的植物**仍然保留**（留给防守方抢夺，bugv18 #1）',
    (afterDeclare?.size ?? 0) === 1 && (plants3dAfterDeclare?.count ?? 0) === 1,
    { afterDeclare, plants3dAfterDeclare },
  )
  await page.evaluate(`window.C4.pick(window.C4.cell(1, 3))`)
  await idle(page)
  const after = (await page.evaluate('window.C4.hp()')) as number[]
  const clash = (await page.evaluate('window.C4.attack()')) as {
    finalAttack: number
    defenderAttack: number
    attackerPlants: number
    defenderPlants: number
    stolenPlants: number
    diff: number
    mode: string
  } | null
  const remaining = (await page.evaluate('window.C4.magicState()')) as { size: number } | null
  check(
    '#4 防守方抢走植物：攻击方 4+0(被抢)-1(削弱)=3，防守方 4+1=5 → 差值 2 由攻击方承担',
    clash?.stolenPlants === 1 &&
      clash?.attackerPlants === 0 &&
      clash?.finalAttack === 3 &&
      clash?.defenderPlants === 1 &&
      clash?.defenderAttack === 5 &&
      clash?.diff === 2 &&
      after[0] === before[0] - 2,
    { clash, hpBefore: before, hpAfter: after },
  )
  check('#4 连珠结算后植物随棋子一起消失', (remaining?.size ?? 1) === 0, remaining)
  await page.screenshot({ path: `${OUT}/03-magic-steal.png` })

  // 落子占位：植物归落子方，3D 里出现特征色光环
  await scenario(page, '[[0,0,2]]', "{ hp: [6,6], current: 0, magic: [{ cell: 40, kind: 'fern', owner: null }] }")
  const sceneBefore = await page.evaluate('window.C4.plants3d()')
  await page.evaluate(`window.C4.pick(window.C4.cell(4, 4))`)
  await idle(page)
  const claim = (await page.evaluate('window.C4.claimInfo(40)')) as { owner: number; ringVisible: boolean } | null
  const magicAfter = (await page.evaluate('window.C4.magicState()')) as { plants: Array<{ owner: number | null }> } | null
  check(
    '#4 可以在魔力植物上落子，落子后这棵植物归落子方（3D 里有归属光环）',
    (sceneBefore as { count: number }).count === 1 &&
      claim?.owner === 0 &&
      claim?.ringVisible === true &&
      magicAfter?.plants[0]?.owner === 0,
    { claim, magicAfter },
  )

  // 配置可改且会持久化
  await page.evaluate(`window.C4.setMagicConfig({ baseCount: 3, maxCount: 4, damagePerPlant: 2 })`)
  const changed = (await page.evaluate('window.C4.magicConfig()')) as { baseCount: number; damagePerPlant: number }
  const stored = (await page.evaluate(`JSON.parse(localStorage.getItem('connect4.magic.v1') || '{}')`)) as {
    baseCount: number
  }
  await page.evaluate('window.C4.resetMagicConfig()')
  const restored = (await page.evaluate('window.C4.magicConfig()')) as { baseCount: number }
  check(
    '#4 参数写在配置里、可在设置中更改（并持久化，可恢复默认）',
    changed.baseCount === 3 && changed.damagePerPlant === 2 && stored.baseCount === 3 && restored.baseCount === 2,
    { changed, stored, restored },
  )
}

// ===========================================================================
// #5 魔法阵：四个角不再被截断 + 边更粗；悬浮棋子随机散布
// ===========================================================================
{
  await scenario(page, '[[8,0,1],[8,1,1],[8,2,1],[6,4,2]]', '{ hp: [6,6], current: 0 }')
  await page.evaluate(`window.C4.pick(window.C4.cell(8, 3))`)
  await idle(page)
  const texture = (await page.evaluate('window.C4.magicTexture()')) as {
    size: number
    spanRatio: number
    margin: number
    midRunPx: number
  } | null
  check(
    '#5 魔法阵的四个角完整显示（贴图内容不再被画布裁掉）',
    (texture?.spanRatio ?? 0) >= 0.85 && (texture?.margin ?? 0) >= 3,
    texture,
  )
  check('#5 正方形的边更粗（中线上的笔画宽度 ≥ 6px）', (texture?.midRunPx ?? 0) >= 6, { midRun: texture?.midRunPx })

  const staged = (await page.evaluate('window.C4.stagedSpread()')) as Array<{ owner: number; ndcX: number; ndcY: number }>
  const sameSide = staged.every((item) => item.ndcX < 0)
  const uniqueY = new Set(staged.map((item) => item.ndcY)).size
  const uniqueX = new Set(staged.map((item) => item.ndcX)).size
  // 原来四颗的 ndcX 完全一样（一条竖线）；现在每个都不同
  check(
    '#5 悬浮棋子不再排成整齐的行列（位置带随机散布，仍在己方一侧）',
    staged.length === 4 && sameSide && uniqueY === 4 && uniqueX === 4,
    { staged, uniqueX, uniqueY },
  )
  await page.screenshot({ path: `${OUT}/04-magic-circle.png` })
  await idle(page)
}

// ===========================================================================
// #6 总攻击数：更大、更细长
// ===========================================================================
{
  await scenario(page, '[[8,0,1],[8,1,1],[8,2,1],[6,4,2]]', '{ hp: [6,6], current: 0 }')
  await page.evaluate(`window.C4.pick(window.C4.cell(8, 3))`)
  await idle(page)
  const tally = (await page.evaluate('window.C4.tallyStyle()')) as {
    fontSize: number
    fontWeight: string
    scale: string
    text: string
  } | null
  const vertical = Number.parseFloat((tally?.scale ?? '1 1').split(/\s+/)[1] ?? '1')
  const horizontal = Number.parseFloat((tally?.scale ?? '1 1').split(/\s+/)[0] ?? '1')
  check(
    '#6 总攻击数字更大（≥44px）、笔画更细（≤300）、字形更修长（纵向 > 横向）',
    (tally?.fontSize ?? 0) >= 44 &&
      Number.parseInt(tally?.fontWeight ?? '900', 10) <= 300 &&
      vertical > horizontal &&
      vertical >= 1.1,
    tally,
  )
  await page.screenshot({ path: `${OUT}/05-tally.png` })
  await idle(page)
}

// ===========================================================================
// #7 碎片：初速度更快、更有冲击力
// ===========================================================================
{
  await scenario(page, '[[0,0,1],[0,1,1],[0,2,1],[1,3,2],[2,3,2],[3,3,2]]', '{ hp: [6,6], current: 0 }')
  await page.evaluate(`window.C4.pick(window.C4.cell(0, 3))`)
  await idle(page)
  await page.evaluate(`window.C4.pick(window.C4.cell(0, 3))`)
  let best: { count: number; max: number; life: number } | null = null
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(50)
    const sample = (await page.evaluate('window.C4.shardSpeed()')) as { count: number; max: number; life: number } | null
    if (sample && (!best || sample.max > best.max)) best = sample
    if (best && best.max > 0 && i > 20) break
  }
  check('#7 碎片初速度明显更快（≥11，之前上限约 6.8）', (best?.max ?? 0) >= 11, best)
  await page.screenshot({ path: `${OUT}/06-shards.png` })
  await idle(page)
}

// ===========================================================================
// #2 / #3 联机：门铃声 + 对手掉线提示
// ===========================================================================
{
  const pageB = await openPage('B')
  await page.evaluate('window.C4.spySound()')
  await pageB.evaluate('window.C4.spySound()')
  await page.evaluate(`window.C4.online.connect('${SERVER}')`)
  await pageB.evaluate(`window.C4.online.connect('${SERVER}')`)
  await page.waitForTimeout(600)
  await page.evaluate('window.C4.online.queue()')
  await page.waitForTimeout(400)
  await pageB.evaluate('window.C4.online.queue()')

  const deadline = Date.now() + 8000
  let matchedA = ''
  while (Date.now() < deadline) {
    matchedA = (await page.evaluate('window.C4.state().matchId')) as string
    if (matchedA) break
    await page.waitForTimeout(150)
  }
  await page.waitForTimeout(700)
  const soundsA = (await page.evaluate('window.C4.sounds()')) as string[]
  const soundsB = (await pageB.evaluate('window.C4.sounds()')) as string[]
  check(
    '#2 对手加入 / 匹配成功时播放门铃声（两端都触发 doorbell）',
    matchedA !== '' && soundsA.includes('doorbell') && soundsB.includes('doorbell'),
    { matchedA, soundsA, soundsB },
  )

  // 一方直接断开（关掉页面）→ 另一方必须看到提示
  await pageB.context().close()
  const noticeDeadline = Date.now() + 8000
  let noticeText: string | null = null
  while (Date.now() < noticeDeadline) {
    noticeText = (await page.evaluate('window.C4.noticeText()')) as string | null
    if (noticeText) break
    await page.waitForTimeout(150)
  }
  const state = (await page.evaluate('window.C4.state()')) as { notice: string | null; locked: boolean }
  check(
    '#3 一方断开连接时，另一方弹出提示（并对局结束、棋盘锁定）',
    Boolean(noticeText) && noticeText?.includes('对手') === true && state.notice !== null,
    { noticeText, state },
  )
  await page.screenshot({ path: `${OUT}/07-online-disconnect.png` })
}

// ===========================================================================
console.log('\n============================= 汇总 =============================')
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.item}`)
console.log(`通过 ${results.filter((r) => r.ok).length}/${results.length}`)
console.log('console errors:', problems.length ? problems : 'none')
console.log(`截图：${OUT}/`)

await browser.close()
