/**
 * 定点浏览器探针：验证 bugv17 #4 —— **棋子被破坏时，植物与魔法阵必须同时消失**。
 *
 * 为什么单独写：`verify-bugv8.ts` 要跑整套（拖尾 / 音效 / 碎片…），任何一条无关的失败
 * 都会淹没这里。本探针只做一件事，并且**同时检查引擎状态与 3D 视图**（视图才是用户看到的）。
 *
 * 跑法（需要 dev/preview 在运行）：
 *   SMOKE_URL=http://127.0.0.1:5174/ pnpm exec tsx scripts/probe-plant-vfx.ts
 */
import { chromium, type Page } from 'playwright-core'

const BASE = process.env.SMOKE_URL ?? 'http://127.0.0.1:5174/'
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const HELPERS = `
window.C4 = {
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
      hp: opts.hp || [8, 8],
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
  attack: () => { const a = window.__CONNECT4__.engine.value.attack; return a ? JSON.parse(JSON.stringify(a)) : null; },
  hp: () => window.__CONNECT4__.engine.value.hp.slice(),
  magicState: () => {
    const engine = window.__CONNECT4__.engine.value;
    return { size: engine.magic.size, plants: Array.from(engine.magic.values()).map(function (p) { return { cell: p.cell, kind: p.kind, owner: p.owner }; }) };
  },
  // 3D 视图里的植物数（含正在淡出的）—— 用户"看到"的就是它
  plants3d: () => { const view = window.__CONNECT4__.scene.value.magic; return { count: view.count, cells: view.cells }; },
  busy: () => window.__CONNECT4__.ui.busy,
}
`

interface Result {
  item: string
  ok: boolean
  detail: unknown
}
const results: Result[] = []
function check(item: string, ok: boolean, detail: unknown): void {
  results.push({ item, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${item}\n      ${JSON.stringify(detail)}`)
}

/** 等"动画播完 + 空闲"。 */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction('window.C4.busy() === false', { timeout: 6000 }).catch(() => {})
  await page.waitForTimeout(450)
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
})
const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
const page = await context.newPage()
const problems: string[] = []
page.on('pageerror', (error) => problems.push(error.message))
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(message.text())
})

await page.goto(BASE, { waitUntil: 'load' })
await page.evaluate(HELPERS)
await page.waitForTimeout(1400)

// ---------------------------------------------------------------------------
// 用户 #4：攻击方连珠上的植物 —— 宣告攻击后必须立刻消失（引擎 + 3D 都要）
// ---------------------------------------------------------------------------
await page.evaluate(
  `window.C4.scenario([[1,1,1],[1,2,1],[1,3,1],[2,3,2],[3,3,2],[4,3,2]], ` +
    `{ current: 0, magic: [{ cell: 12, kind: 'flower', owner: 0 }] })`,
)
const beforeState = await page.evaluate('window.C4.magicState()')
const before3d = await page.evaluate('window.C4.plants3d()')
const beforeHp = await page.evaluate('window.C4.hp()')

await page.evaluate('window.C4.pick(window.C4.cell(1, 4))')
await settle(page)

const afterDeclareState = await page.evaluate('window.C4.magicState()')
const afterDeclare3d = await page.evaluate('window.C4.plants3d()')
const phase = await page.evaluate('window.__CONNECT4__.engine.value.phase')

check(
  'A1 摆局成功：目标格 1 棵植物（引擎 + 3D），并进入等待防守',
  (beforeState as { size: number }).size === 1 &&
    (before3d as { count: number }).count === 1 &&
    phase === 'awaitingDefense',
  { engine: beforeState, view3d: before3d, phase },
)
check(
  'A2 宣告攻击后：引擎里那棵植物没了',
  (afterDeclareState as { size: number }).size === 0,
  afterDeclareState,
)
check(
  'A3 宣告攻击后：3D 里植物与魔法阵也没了（用户 #4 的核心诉求）',
  (afterDeclare3d as { count: number }).count === 0,
  afterDeclare3d,
)

// 防守方落子 → 结算
await page.evaluate('window.C4.pick(window.C4.cell(1, 3))')
await settle(page)
const clash = (await page.evaluate('window.C4.attack()')) as {
  finalAttack: number
  defenderAttack: number
  attackerPlants: number
  defenderPlants: number
  stolenPlants: number
  diff: number
  mode: string
} | null
check(
  'A4 加伤在宣告时锁定、植物已不存在（抢不到）→ 4+1-1=4 vs 4+0=4，抵消无伤害',
  clash?.attackerPlants === 1 &&
    clash?.stolenPlants === 0 &&
    clash?.finalAttack === 4 &&
    clash?.defenderPlants === 0 &&
    clash?.defenderAttack === 4 &&
    clash?.diff === 0 &&
    clash?.mode === 'canceled',
  clash,
)
const afterResolve3d = await page.evaluate('window.C4.plants3d()')
const afterResolveHp = await page.evaluate('window.C4.hp()')
check(
  'A5 结算后 3D 里依然没有残留，且双方血量未变',
  (afterResolve3d as { count: number }).count === 0 &&
    (afterResolveHp as number[])[0] === (beforeHp as number[])[0] &&
    (afterResolveHp as number[])[1] === (beforeHp as number[])[1],
  { view3d: afterResolve3d, hpBefore: beforeHp, hpAfter: afterResolveHp },
)

await browser.close()

const failed = results.filter((result) => !result.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (problems.length > 0) {
  console.log(`页面报错（${problems.length} 条）：`)
  for (const problem of problems.slice(0, 6)) console.log(`  - ${problem}`)
}
if (failed.length > 0) process.exitCode = 1
