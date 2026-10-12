/**
 * bugv7 逐条验证。
 *
 *   cd back && PORT=8899 DB_MODE=memory SERVE_FRONTEND=false pnpm exec tsx src/index.ts
 *   pnpm exec vite preview --port 5199 --strictPort
 *   pnpm exec tsx scripts/verify-bugv7.ts
 *
 * #1 联机：两个独立浏览器上下文 + 真后端，**用真实鼠标点击**落子（不再直接调 handleCellPick，
 *    因为 bug 恰好出在"3D 层是否允许点击"这道门上）；同时抓 WS 原始帧核对消息顺序，
 *    并复现"服务端先 matched 后 queued"这一顺序，验证客户端不会再被锁住。
 * #2 拖尾：量它的**形状**——必须是沿轨迹连续的一条细尾迹，而不是四散的烟花。
 */
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright-core'

const BASE = process.env.SMOKE_URL ?? 'http://localhost:5199/'
const SERVER = process.env.ONLINE_SERVER ?? '127.0.0.1:8899'
const OUT = '.shots/bugv7'
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
  online: () => window.__CONNECT4__.online,
  cell: (r, c) => r * 9 + c,
  connect: (url) => window.__CONNECT4__.connectOnline(url),
  queue: () => window.__CONNECT4__.onlineQueue(),
  pick: (cell) => { window.__CONNECT4__.handleCellPick(cell); return true; },
  firstEmpty: () => window.__CONNECT4__.engine.value.board.findIndex(function (v) { return v === 0; }),
  // 棋盘下标 -> 屏幕坐标（真实鼠标点击用）
  clickPoint: (cell) => {
    const scene = window.__CONNECT4__.scene.value;
    const row = Math.floor(cell / 9), col = cell % 9;
    const v = new window.__THREE_VECTOR3__(col - 4, 0, row - 4);
    v.project(scene.rig.camera);
    const rect = document.querySelector('#board-canvas').getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  },
  locked: () => document.querySelector('#board-canvas').classList.contains('is-locked'),
  mine: () => window.__CONNECT4__.isMyOnlineTurn.value,
  snap: () => {
    const game = window.__CONNECT4__;
    const engine = game.engine.value;
    return {
      screen: game.ui.screen, status: game.online.status, connected: game.online.connected,
      seat: game.online.seat, matchId: game.online.matchId, seq: game.online.seq,
      current: engine.current, busy: game.ui.busy, phase: engine.phase,
      hp: engine.hp.slice(), moves: engine.moveCount.value, result: engine.result,
      board: engine.board.join(''), locked: window.C4.locked(), mine: window.C4.mine(),
      message: game.online.message, dice: game.ui.dice,
    };
  },
  trail: () => {
    const root = document.querySelector('.app-root');
    const canvas = Array.from(root.querySelectorAll('canvas')).find(function (c) { return c.dataset.trail === 'on'; });
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const dpr = canvas.width / (canvas.clientWidth || 1);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const W = canvas.width, H = canvas.height;
    let painted = 0, sumR = 0, sumG = 0, sumB = 0;
    const cols = new Array(W).fill(0);
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (data[i + 3] > 20) {
          painted += 1; cols[x] += 1; sumR += data[i]; sumG += data[i + 1]; sumB += data[i + 2];
          if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
        }
      }
    }
    return { painted: painted, dpr: Number(dpr.toFixed(2)), cols: cols,
      bbox: painted ? [minX, minY, maxX, maxY] : null,
      avg: painted ? [Math.round(sumR / painted), Math.round(sumG / painted), Math.round(sumB / painted)] : null,
      cssSize: [canvas.clientWidth, canvas.clientHeight], zIndex: canvas.style.zIndex };
  },
  // 沿轨迹的覆盖率 / 最大断口 / 最大横向偏移（dpr 由 dpr 参数换算）
  trailShape: (x0, x1, y0, dpr) => {
    const root = document.querySelector('.app-root');
    const canvas = Array.from(root.querySelectorAll('canvas')).find(function (c) { return c.dataset.trail === 'on'; });
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const W = canvas.width, H = canvas.height;
    const from = Math.round(x0 * dpr), to = Math.round(x1 * dpr);
    let covered = 0, total = 0, gap = 0, maxGap = 0, maxLateral = 0, painted = 0;
    for (let x = from; x <= to; x += Math.max(1, Math.round(3 * dpr))) {
      total += 1;
      let hit = false;
      for (let y = 0; y < H; y++) {
        if (data[(y * W + x) * 4 + 3] > 20) {
          hit = true; painted += 1;
          const lateral = Math.abs(y / dpr - y0);
          if (lateral > maxLateral) maxLateral = lateral;
        }
      }
      if (hit) { covered += 1; gap = 0 } else { gap += 1; if (gap > maxGap) maxGap = gap }
    }
    return { coverage: Number((covered / Math.max(total, 1)).toFixed(3)), maxGapCols: maxGap * 3,
      maxLateral: Number(maxLateral.toFixed(1)), painted: painted };
  },
  // 合成一段水平轨迹（步进可控，便于量形状）
  drawPath: (x0, x1, y, steps) => {
    const root = document.querySelector('.app-root');
    for (let i = 0; i <= steps; i++) {
      const x = x0 + ((x1 - x0) * i) / steps;
      root.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true, pointerType: 'mouse' }));
    }
    return true;
  },
  startTrail: () => window.__CONNECT4__.startTrail(document.querySelector('.app-root'), { force: true }),
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
/** 每个页面收到的服务端原始帧（用于核对消息顺序）。 */
const frames = new Map<Page, string[]>()
function watch(page: Page, label: string): void {
  const list: string[] = []
  frames.set(page, list)
  page.on('websocket', (socket) => {
    socket.on('framereceived', (event) => {
      const payload = typeof event.payload === 'string' ? event.payload : ''
      if (payload.includes('"t"')) list.push(payload)
    })
  })
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`[${label}][error] ${message.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`[${label}][pageerror] ${error.message}`))
}

async function openPlayer(label: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  const page = await context.newPage()
  watch(page, label)
  await page.goto(BASE, { waitUntil: 'load' })
  await page.evaluate(HELPERS)
  await page.waitForTimeout(1200)
  return page
}

type Snap = {
  screen: string
  status: string
  connected: boolean
  seat: number
  matchId: string
  seq: number
  current: number
  busy: boolean
  phase: string
  hp: number[]
  moves: number
  result: { winner: number | null } | null
  board: string
  locked: boolean
  mine: boolean
  message: string
  dice: unknown
}

const snap = async (page: Page): Promise<Snap> => (await page.evaluate('window.C4.snap()')) as Snap

async function waitFor(page: Page, predicate: (value: Snap) => boolean, timeoutMs = 12000): Promise<Snap> {
  const deadline = Date.now() + timeoutMs
  let last = await snap(page)
  while (Date.now() < deadline) {
    if (predicate(last)) return last
    await page.waitForTimeout(110)
    last = await snap(page)
  }
  return last
}

// ===========================================================================
// #2 拖尾：必须是一条连续的细尾迹
// ===========================================================================
{
  const page = await openPlayer('trail')
  await page.evaluate('window.C4.startTrail()')
  await page.waitForTimeout(250)

  const Y = 430
  // 沿水平方向画一段 600px 的轨迹（分步合成，步距 10px）
  await page.evaluate(`window.C4.drawPath(300, 900, ${Y}, 60)`)
  await page.waitForTimeout(60)
  const shot = (await page.evaluate('window.C4.trail()')) as {
    painted: number
    dpr: number
    zIndex: string
    avg: number[] | null
    bbox: number[] | null
  } | null
  const dpr = shot?.dpr ?? 1
  // bugv8 #1 之后尾迹更短：只要求"尾迹自身"是连续的，所以按它自己的包围盒来量覆盖率
  const bbox = shot?.bbox ?? null
  const x0 = bbox ? Math.floor(bbox[0] / dpr) : 300
  const x1 = bbox ? Math.ceil(bbox[2] / dpr) : 900
  const shape = (await page.evaluate(`window.C4.trailShape(${x0}, ${x1}, ${Y}, ${dpr})`)) as {
    coverage: number
    maxGapCols: number
    maxLateral: number
    painted: number
  } | null
  const avg = shot?.avg ?? [0, 0, 0]
  check(
    '#2 拖尾是沿轨迹**连续**的一条尾迹（自身覆盖率 ≥0.9、断口 ≤6px）',
    (shape?.coverage ?? 0) >= 0.9 && (shape?.maxGapCols ?? 99) <= 6 && (shot?.painted ?? 0) > 300,
    { shape, x0, x1, painted: shot?.painted, zIndex: shot?.zIndex },
  )
  check(
    '#2 尾迹是细的（不横向炸开），且为蓝色',
    (shape?.maxLateral ?? 99) <= 16 && avg[2] > avg[0] + 40 && avg[2] > 120,
    { maxLateral: shape?.maxLateral, avg },
  )
  await page.screenshot({ path: `${OUT}/01-trail.png` })

  // 停手之后尾巴要收干净（不是留下四散的粒子）
  await page.waitForTimeout(1300)
  const after = (await page.evaluate('window.C4.trail()')) as { painted: number } | null
  check('#2 停手后尾迹收干净（不会留下挂着的烟花粒子）', (after?.painted ?? 1) === 0, { painted: after?.painted })
  await page.context().close()
}

// ===========================================================================
// #1 联机：真实鼠标点击（双方都必须能下子）
// ===========================================================================
const A = await openPlayer('A')
const B = await openPlayer('B')
{
  await A.evaluate(`window.C4.connect('${SERVER}')`)
  await B.evaluate(`window.C4.connect('${SERVER}')`)
  await waitFor(A, (s) => s.status === 'idle')
  await waitFor(B, (s) => s.status === 'idle')
  await A.evaluate('window.C4.queue()')
  await waitFor(A, (s) => s.status === 'queued', 4000)
  await B.evaluate('window.C4.queue()')

  const a1 = await waitFor(A, (s) => s.matchId !== '', 8000)
  const b1 = await waitFor(B, (s) => s.matchId !== '', 8000)
  check('#1 在线匹配成功（同一 matchId、座位相反）', a1.matchId !== '' && a1.matchId === b1.matchId && a1.seat !== b1.seat, {
    matchId: a1.matchId,
    seats: [a1.seat, b1.seat],
  })

  // WS 原始帧：`queued` 不能再出现在 `matched` 之后（否则客户端会被"降级"锁住棋盘）
  const order = [A, B].map((page) => {
    const list = frames.get(page) ?? []
    const types = list.map((raw) => {
      try {
        return String((JSON.parse(raw) as { t?: string }).t ?? '')
      } catch {
        return ''
      }
    })
    const firstMatched = types.indexOf('matched')
    const queuedAfterMatched = firstMatched >= 0 && types.slice(firstMatched).includes('queued')
    return { types, queuedAfterMatched }
  })
  check(
    '#1 服务端不再在 matched 之后再补发 queued（消息顺序修好）',
    order.every((entry) => entry.queuedAfterMatched === false),
    order.map((entry) => entry.types.join('>')),
  )

  await waitFor(A, (s) => s.screen === 'playing' && !s.busy, 14000)
  await waitFor(B, (s) => s.screen === 'playing' && !s.busy, 14000)
  await waitFor(A, (s) => s.dice !== null, 8000)
  await waitFor(B, (s) => s.dice !== null, 8000)
  await A.waitForTimeout(2400) // 等骰子浮层淡出

  /** 用真实鼠标点一个空格：先移动过去让视差稳定，再重新投影后点击。 */
  async function realClick(page: Page): Promise<number> {
    const cell = (await page.evaluate('window.C4.firstEmpty()')) as number
    const rough = (await page.evaluate(`window.C4.clickPoint(${cell})`)) as { x: number; y: number }
    await page.mouse.move(rough.x, rough.y)
    await page.waitForTimeout(260)
    const exact = (await page.evaluate(`window.C4.clickPoint(${cell})`)) as { x: number; y: number }
    await page.mouse.click(exact.x, exact.y)
    return cell
  }

  let movesA = 0
  let movesB = 0
  let stuck = ''
  for (let round = 0; round < 10 && !stuck; round++) {
    const [a, b] = await Promise.all([snap(A), snap(B)])
    if (a.result || b.result) break
    const mover = a.current === a.seat ? A : b.current === b.seat ? B : null
    if (!mover) {
      stuck = `找不到该谁走：A(current=${a.current},seat=${a.seat}) B(current=${b.current},seat=${b.seat})`
      break
    }
    const label = mover === A ? 'A' : 'B'
    const before = a.seq
    const locked = await mover.evaluate('window.C4.locked()')
    if (locked) {
      stuck = `${label} 的棋盘是锁住的（is-locked），真实点击无效 :: A=${JSON.stringify(a)} B=${JSON.stringify(b)}`
      break
    }
    await realClick(mover)
    const advanced = await waitFor(A, (s) => s.seq > before || s.result !== null, 6000)
    if (advanced.seq <= before && !advanced.result) {
      stuck = `${label} 真实点击之后服务端没有接受这一步（seq 仍为 ${advanced.seq}）`
      break
    }
    if (mover === A) movesA += 1
    else movesB += 1
    await Promise.all([waitFor(A, (s) => !s.busy, 14000), waitFor(B, (s) => !s.busy, 14000)])
  }

  check(
    '#1 双方都能用真实鼠标点击落子（不再是"一方下完另一方点不动"）',
    stuck === '' && movesA >= 3 && movesB >= 3,
    { movesA, movesB, stuck, message: (await snap(A)).message },
  )
  await A.screenshot({ path: `${OUT}/02-online-real-click.png` })
}

// ===========================================================================
// #1 回归：即使服务端（旧版本）先发 matched 再发 queued，客户端也不能被锁住
// ===========================================================================
{
  const [a, b] = await Promise.all([snap(A), snap(B)])
  const mover = a.current === a.seat ? A : B
  const label = mover === A ? 'A' : 'B'
  const before = a.seq
  // 复现旧服务端的顺序：把状态强行改回"排队中"
  await mover.evaluate(`window.__CONNECT4__.online.status = 'queued'`)
  await mover.waitForTimeout(220)
  const nowSnap = await snap(mover)
  const interactive = !nowSnap.locked
  await mover.mouse.move(640, 700)
  await mover.waitForTimeout(260)
  // 状态被改成 queued 之后，真实点击仍然要能落子
  let clicked = false
  if (nowSnap.mine && interactive) {
    const cell = (await mover.evaluate('window.C4.firstEmpty()')) as number
    const point = (await mover.evaluate(`window.C4.clickPoint(${cell})`)) as { x: number; y: number }
    await mover.mouse.click(point.x, point.y)
    const advanced = await waitFor(A, (s) => s.seq > before || s.result !== null, 6000)
    clicked = advanced.seq > before || Boolean(advanced.result)
  }
  check(
    '#1 状态被"降级"成 queued 时棋盘依然可点（客户端不再只看 status 文案）',
    nowSnap.mine === true && interactive === true && clicked === true,
    { label, status: nowSnap.status, mine: nowSnap.mine, interactive, clicked, seq: `${before} → ${(await snap(A)).seq}` },
  )
  await mover.screenshot({ path: `${OUT}/03-status-latch.png` })
}

// ===========================================================================
console.log('\n============================= 汇总 =============================')
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.item}`)
console.log(`通过 ${results.filter((r) => r.ok).length}/${results.length}`)
console.log('console errors:', problems.length ? problems : 'none')

await browser.close()
