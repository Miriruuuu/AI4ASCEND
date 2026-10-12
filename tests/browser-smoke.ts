/**
 * 浏览器端到端烟雾测试（需要本机 Chrome）。
 *
 *   pnpm preview --port 5199 --strictPort   # 终端 A
 *   pnpm test:browser                        # 终端 B
 *
 * 覆盖：开始菜单 → 开局 → 落子 → 攻击阶段（高光 / 对撞 / 撞血条）→ 结算 → 回放。
 * 截图输出到 .shots/。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const BASE = process.env.SMOKE_URL ?? 'http://localhost:5199/'
const OUT = '.shots'
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

/** 页面侧小工具（字符串形式传入，避免 tsx 注入 __name 辅助函数）。 */
const INSTALL_HELPERS = `
  window.C4 = {
    game: () => window.__CONNECT4__,
    cell: (r, c) => r * 9 + c,
    scenario: (stones, options) => {
      const game = window.__CONNECT4__;
      const opts = options || {};
      game.ui.mode = opts.mode || 'pvp';
      game.ui.screen = 'playing';
      const board = new Array(81).fill(0);
      stones.forEach(([r, c, owner]) => { board[r * 9 + c] = owner; });
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
    pick: (cell) => window.__CONNECT4__.handleCellPick(cell),
    skip: () => window.__CONNECT4__.skipAnimations(),
    state: () => {
      const game = window.__CONNECT4__;
      const engine = game.engine.value;
      return {
        screen: game.ui.screen,
        phase: engine.phase,
        uiPhase: game.ui.phase,
        hp: [...engine.hp],
        current: engine.current,
        result: engine.result,
        highlights: [...engine.highlights.keys()],
        attack: game.ui.attack,
        attackPanelOpen: game.ui.attackPanelOpen,
        steps: game.history.length,
        dark: document.querySelector('.app-root').classList.contains('is-dimmed'),
      };
    },
  };
  'ready'
`

mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-gpu-sandbox',
    '--no-sandbox',
  ],
})

const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })

const problems: string[] = []
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(`[${message.type()}] ${message.text()}`)
})
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`))

await page.goto(BASE, { waitUntil: 'load' })
await page.evaluate(INSTALL_HELPERS)
await page.waitForTimeout(1600)

// --- 1. 开始菜单 ---
const menuState = await page.evaluate('window.C4.state()')
console.log('start menu:', JSON.stringify(menuState))
await page.screenshot({ path: `${OUT}/01-menu.png` })

// --- 2. 开始游戏：骰子 + 开局 ---
await page.getByRole('button', { name: /开始游戏/ }).click()
await page.waitForTimeout(900)
await page.screenshot({ path: `${OUT}/02-dice.png` })
await page.waitForTimeout(2800)
await page.screenshot({ path: `${OUT}/03-board.png` })
console.log('after start:', JSON.stringify(await page.evaluate('window.C4.state()')))

// 鼠标视差 + 悬停
const box = await page.locator('#board-canvas').boundingBox()
if (!box) throw new Error('找不到棋盘画布')
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5)
await page.waitForTimeout(600)
await page.screenshot({ path: `${OUT}/04-hover.png` })

// --- 3. 攻击阶段：高光 ---
console.log('scenario:', await page.evaluate("window.C4.scenario([[8,0,1],[8,1,1],[8,2,1],[1,4,2],[2,4,2],[3,4,2]], { hp: [6,6], current: 0 })"))
await page.evaluate('window.C4.pick(window.C4.cell(8,3))')
await page.waitForTimeout(2800)
await page.screenshot({ path: `${OUT}/05-attack-highlight.png` })
console.log('attack state:', JSON.stringify(await page.evaluate('window.C4.state()')))

// --- 4. 防守方成线：对撞抵消 ---
/**
 * 用 DevTools 截屏流记录动画帧（`page.screenshot` 会暂停 rAF，
 * 拿到的往往是动画结束后的画面，因此对撞这类连续动画用 CDP 录帧更可靠）。
 */
async function recordFrames(
  action: () => Promise<void>,
  durationMs: number,
  saveEvery: number,
  prefix: string,
): Promise<number> {
  const client = await page.context().newCDPSession(page)
  const frames: Buffer[] = []
  client.on('Page.screencastFrame', (payload: { data: string; sessionId: number }) => {
    frames.push(Buffer.from(payload.data, 'base64'))
    void client.send('Page.screencastFrameAck', { sessionId: payload.sessionId }).catch(() => undefined)
  })
  await client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
  await action()
  await page.waitForTimeout(durationMs)
  await client.send('Page.stopScreencast')
  await client.detach().catch(() => undefined)
  frames.forEach((buffer, index) => {
    if (index % saveEvery !== 0) return
    writeFileSync(`${OUT}/${prefix}-${String(index).padStart(3, '0')}.png`, buffer)
  })
  return frames.length
}

const clashFrames = await recordFrames(
  async () => {
    await page.evaluate('window.C4.pick(window.C4.cell(0,4))')
  },
  5200,
  4,
  '06-clash',
)
console.log('clash frames recorded:', clashFrames)
console.log('clash state:', JSON.stringify(await page.evaluate('window.C4.state()')))

// --- 5. 未成线：棋子撞血条 ---
console.log('scenario:', await page.evaluate("window.C4.scenario([[8,0,1],[8,1,1],[8,2,1]], { hp: [6,6], current: 0 })"))
await page.evaluate('window.C4.pick(window.C4.cell(8,3))')
await page.waitForTimeout(2800)
await page.screenshot({ path: `${OUT}/09-defense-wait.png` })
await page.evaluate('window.C4.pick(window.C4.cell(0,0))')
await page.waitForTimeout(1400)
await page.screenshot({ path: `${OUT}/10-fly-to-hud.png` })
await page.waitForTimeout(1600)
await page.screenshot({ path: `${OUT}/11-hp-impact.png` })
console.log('damage state:', JSON.stringify(await page.evaluate('window.C4.state()')))

// --- 6. 攻击阶段结束后面板关闭 ---
await page.waitForTimeout(2600)
console.log('after linger:', JSON.stringify(await page.evaluate('window.C4.state()')))
await page.screenshot({ path: `${OUT}/12-panel-closed.png` })

// --- 7. 致命一击 + 结算 ---
await page.evaluate("window.C4.scenario([[4,4,1],[4,5,1],[4,6,1]], { hp: [6,2], current: 0 })")
await page.evaluate('window.C4.pick(window.C4.cell(4,7))')
await page.waitForTimeout(3000)
await page.evaluate('window.C4.pick(window.C4.cell(0,0))')
await page.waitForTimeout(3000)
await page.screenshot({ path: `${OUT}/13-result.png` })
console.log('final:', JSON.stringify(await page.evaluate('window.C4.state()')))

// --- 8. 回放 ---
await page.evaluate("window.__CONNECT4__.ui.showResult = false")
await page.evaluate("window.__CONNECT4__.openReplay()")
await page.waitForTimeout(700)
await page.screenshot({ path: `${OUT}/14-replay.png` })
await page.evaluate("window.__CONNECT4__.seekReplay(6)")
await page.waitForTimeout(600)
await page.screenshot({ path: `${OUT}/15-replay-step.png` })
console.log('replay:', JSON.stringify(await page.evaluate('window.C4.state()')))

// --- 9. ESC 菜单 ---
await page.evaluate("window.__CONNECT4__.backToMenu()")
await page.waitForTimeout(500)
await page.getByRole('button', { name: /开始游戏/ }).click()
await page.waitForTimeout(4200)
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
await page.screenshot({ path: `${OUT}/16-game-menu.png` })

const stats = await page.evaluate(`(() => {
  const canvasEl = document.querySelector('#board-canvas');
  const gl = canvasEl && canvasEl.getContext('webgl2');
  const stage = document.querySelector('.board-stage');
  return {
    webgl2: Boolean(gl),
    canvasSize: canvasEl ? [canvasEl.width, canvasEl.height] : null,
    stageSize: stage ? [stage.clientWidth, stage.clientHeight] : null,
    canvasCovers: canvasEl ? (canvasEl.getBoundingClientRect().width >= window.innerWidth - 1) : false,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    menuButtonVisible: Boolean(document.querySelector('.game-menu')),
    fallback: Boolean(document.querySelector('.fallback')),
  };
})()`)

console.log('page stats:', JSON.stringify(stats, null, 2))
console.log('console problems:', problems.length ? problems : 'none')

await browser.close()
