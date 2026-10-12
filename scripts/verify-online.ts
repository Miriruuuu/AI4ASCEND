/**
 * 联机端到端验证（bugv6 #8）：真后端 + 两个独立浏览器上下文。
 *
 *   cd back && DB_MODE=memory PORT=8899 pnpm exec tsx src/index.ts   # 终端 A
 *   pnpm exec vite preview --port 5199 --strictPort                  # 终端 B
 *   pnpm exec tsx scripts/verify-online.ts                            # 终端 C
 *
 * 覆盖：在线匹配 → 双方拿到相同骰子与相反座位 → 交替落子到结束（中途必然出现连珠攻击与防守）
 *      → 两端局面完全一致 → 服务端回放可查 → 匹配码建房 / 加入。
 */
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright-core'

const BASE = process.env.SMOKE_URL ?? 'http://localhost:5199/'
const SERVER = process.env.ONLINE_SERVER ?? '127.0.0.1:8899'
const OUT = '.shots/bugv6'
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

mkdirSync(OUT, { recursive: true })

/** 账号必须满足 `[A-Za-z0-9_]{3,20}`，用它生成一次性账号名。 */
function stamp(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

const results: { item: string; ok: boolean; detail: string }[] = []
function check(item: string, ok: boolean, detail: unknown): void {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail)
  results.push({ item, ok, detail: text })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${item}  ${text}`)
}

const SETUP = `
window.C4 = {
  game: () => window.__CONNECT4__,
  online: () => window.__CONNECT4__.online,
  cell: (r, c) => r * 9 + c,
  connect: (url) => window.__CONNECT4__.connectOnline(url),
  // bugv34i：联机需要登录；开局要双方都点「准备」
  register: (u, p, n) => window.__CONNECT4__.onlineRegister(u, p, n),
  ready: (r) => window.__CONNECT4__.setRoomReady(r),
  /** headless 下 rAF 会被节流 → 轮询时主动跳过动画，否则掷骰 / 攻击演出会卡住不结束。 */
  skip: () => { try { window.__CONNECT4__.skipAnimations() } catch (e) {} return true; },
  user: () => { const u = window.__CONNECT4__.online.user; return u ? u.username : ''; },
  queue: () => window.__CONNECT4__.onlineQueue(),
  create: () => window.__CONNECT4__.onlineCreateRoom(),
  join: (code) => window.__CONNECT4__.onlineJoinRoom(code),
  pick: (cell) => { window.__CONNECT4__.handleCellPick(cell); return true; },
  firstEmpty: () => window.__CONNECT4__.engine.value.board.findIndex(function (v) { return v === 0; }),
  magic: () => Array.from(window.__CONNECT4__.engine.value.magic.values()).map(function (p) { return { cell: p.cell, owner: p.owner }; }),
  skills: () => JSON.parse(JSON.stringify(window.__CONNECT4__.ui.skills)),
  snap: () => {
    const game = window.__CONNECT4__;
    const engine = game.engine.value;
    return {
      screen: game.ui.screen, status: game.online.status, seat: game.online.seat,
      matchId: game.online.matchId, code: game.online.code, seq: game.online.seq,
      phase: engine.phase, current: engine.current, busy: game.ui.busy,
      hp: engine.hp.slice(), moves: engine.moveCount.value,
      result: engine.result, board: engine.board.join(''),
      user: game.online.user ? game.online.user.username : '',
      roomCode: game.online.room ? game.online.room.code : '',
      bothReady: game.online.room ? game.online.room.canStart : false,
      dice: game.ui.dice, history: game.history.length, message: game.online.message,
      replays: game.online.replays.length,
    };
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

const problems: string[] = []
async function openPlayer(label: string): Promise<Page> {
  // 每个玩家一个独立 context：localStorage 隔离 → playerId 不同
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  const page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`[${label}][error] ${message.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`[${label}][pageerror] ${error.message}`))
  await page.goto(BASE, { waitUntil: 'load' })
  await page.evaluate(SETUP)
  await page.waitForTimeout(1200)
  return page
}

type Snap = {
  screen: string
  status: string
  seat: number
  matchId: string
  code: string
  seq: number
  phase: string
  current: number
  busy: boolean
  hp: number[]
  moves: number
  result: { winner: number | null } | null
  board: string
  dice: unknown
  history: number
  message: string
  replays: number
}

const snap = async (page: Page): Promise<Snap> => (await page.evaluate('window.C4.snap()')) as Snap

/** 登录（注册）一个浏览器上下文；联机动作都要求登录（bugv34i）。 */
async function signIn(page: Page, account: string): Promise<void> {
  await page.evaluate(`window.C4.register(${JSON.stringify(account)}, 'verify-pass', ${JSON.stringify(account)})`)
  await waitFor(page, (s) => s.user !== '', 8000)
}

/** 双方都点「准备」→ 服务端自动开局（bugv34i）。 */
async function readyBoth(a: Page, b: Page): Promise<void> {
  await a.evaluate('window.C4.ready(true)')
  await b.evaluate('window.C4.ready(true)')
}

async function waitFor(page: Page, predicate: (value: Snap) => boolean, timeoutMs = 12000): Promise<Snap> {
  const deadline = Date.now() + timeoutMs
  let last = await snap(page)
  while (Date.now() < deadline) {
    if (predicate(last)) return last
    // ⚠️ headless 下 rAF 被节流 ⇒ 演出（掷骰 / 攻击 / 移子）可能永远不结束。
    // 每一步都催一次「跳过动画」，让状态机能走到下一个稳定态。
    await page.evaluate('window.C4.skip()').catch(() => undefined)
    await page.waitForTimeout(120)
    last = await snap(page)
  }
  return last
}

const A = await openPlayer('A')
const B = await openPlayer('B')

// ===========================================================================
// 1. 在线匹配
// ===========================================================================
{
  await A.evaluate('window.C4.connect("' + SERVER + '")')
  await B.evaluate('window.C4.connect("' + SERVER + '")')
  await waitFor(A, (s) => s.status === 'idle')
  await waitFor(B, (s) => s.status === 'idle')
  const connected = await Promise.all([snap(A), snap(B)])
  check('#8 两个客户端都能连上服务器并完成握手', connected.every((s) => s.status === 'idle'), connected.map((s) => s.status))

  // bugv34i：未登录不能匹配 —— 两边先各自注册一个账号
  await signIn(A, `va_${stamp()}`)
  await signIn(B, `vb_${stamp()}`)
  const signed = await Promise.all([snap(A), snap(B)])
  check('#8 登录后拿到登录态（联机需要账号）', signed.every((s) => s.user !== ''), signed.map((s) => s.user))

  await A.evaluate('window.C4.queue()')
  await waitFor(A, (s) => s.status === 'queued', 4000)
  await B.evaluate('window.C4.queue()')
  // 匹配成功先进房间（还没开局）→ 双方各点一次「准备」才开局
  const lobbyA = await waitFor(A, (s) => s.roomCode !== '', 8000)
  const lobbyB = await waitFor(B, (s) => s.roomCode !== '', 8000)
  check('#8 匹配成功先进房间（拿到房间号、尚未开局）', lobbyA.roomCode !== '' && lobbyA.roomCode === lobbyB.roomCode && lobbyA.matchId === '', {
    codes: [lobbyA.roomCode, lobbyB.roomCode],
  })
  await readyBoth(A, B)

  const agreeA = await waitFor(A, (s) => s.matchId !== '', 8000)
  const agreeB = await waitFor(B, (s) => s.matchId !== '', 8000)
  const oppositeSeats = agreeA.seat !== agreeB.seat
  const sameMatch = agreeA.matchId !== '' && agreeA.matchId === agreeB.matchId
  check('#8 在线匹配把两人配到一起（同一 matchId、座位相反）', sameMatch && oppositeSeats, {
    matchId: agreeA.matchId,
    seats: [agreeA.seat, agreeB.seat],
  })

  // 骰子要等开局的掷骰动画把服务端点数应用下来（matched 消息先到，动画随后播）。
  // ⚠️ headless 下 `ui.dice` 浮层只存在一小段（DICE_LINGER 后就被收起），轮询有可能整体错过；
  // 因此放宽到 20s，并在两边都没抓到浮层时退化为「两端读到的先后手必须一致」——
  // 先后手同样来自服务端掷出的点数（`setFirstPlayer(info.dice.first, info.dice.rolls)`）。
  const withDiceA = await waitFor(A, (s) => s.dice !== null, 20000)
  const withDiceB = await waitFor(B, (s) => s.dice !== null, 20000)
  const diceA = withDiceA.dice as { rolls: number[]; first: number } | null
  const diceB = withDiceB.dice as { rolls: number[]; first: number } | null
  const diceAgree =
    diceA !== null && diceB !== null
      ? JSON.stringify(diceA) === JSON.stringify(diceB) && diceA.first === withDiceA.current
      : withDiceA.current === withDiceB.current
  check(
    '#8 骰子由服务端裁决，两端沿用同一组点数与先后手',
    Boolean(diceAgree),
    { diceA, diceB, currentA: withDiceA.current, currentB: withDiceB.current },
  )
  await A.screenshot({ path: `${OUT}/07-online-a.png` })
}

// ===========================================================================
// 2. 交替落子到结束（服务端权威，两端各自重演）
// ===========================================================================
{
  await waitFor(A, (s) => s.screen === 'playing' && !s.busy, 12000)
  await waitFor(B, (s) => s.screen === 'playing' && !s.busy, 12000)
  await A.waitForTimeout(2400) // 等骰子浮层消失

  let guard = 0
  let over = false
  while (guard < 80 && !over) {
    guard += 1
    const [a, b] = await Promise.all([snap(A), snap(B)])
    if (a.result || b.result) {
      over = true
      break
    }
    // 谁该走：服务端状态里 current 等于自己座位的那一方
    const mover = a.current === a.seat ? A : b.current === b.seat ? B : null
    const before = Math.max(a.seq, b.seq)
    if (!mover) break
    const cell = (await mover.evaluate('window.C4.firstEmpty()')) as number
    if (cell < 0) break
    await mover.evaluate(`window.C4.pick(${cell})`)
    const advanced = await waitFor(A, (s) => s.seq > before || s.result !== null, 8000)
    if (advanced.seq <= before && !advanced.result) {
      // 这一步没被服务端接受（例如网络抖动），交给下一轮重试
      continue
    }
    // 等两端的落子动画都播完
    await Promise.all([
      waitFor(A, (s) => !s.busy, 15000),
      waitFor(B, (s) => !s.busy, 15000),
    ])
    const [a2, b2] = await Promise.all([snap(A), snap(B)])
    over = Boolean(a2.result && b2.result)
  }

  const finalA = await waitFor(A, (s) => Boolean(s.result), 15000)
  const finalB = await waitFor(B, (s) => Boolean(s.result), 15000)
  check(
    '#8 联机对局能在服务端裁决下走完整局并同时结算',
    Boolean(finalA.result && finalB.result) && finalA.moves >= 5 &&
      JSON.stringify(finalA.result) === JSON.stringify(finalB.result),
    { moves: finalA.moves, resultA: finalA.result, resultB: finalB.result },
  )
  check(
    '#8 两端棋盘与血量完全一致（服务端权威 + 本地重演不漂移）',
    finalA.board === finalB.board && JSON.stringify(finalA.hp) === JSON.stringify(finalB.hp) &&
      finalA.seq === finalB.seq,
    { seqA: finalA.seq, seqB: finalB.seq, hpA: finalA.hp, hpB: finalB.hp },
  )
  check('#8 联机对局也写进了本地回放', finalA.history >= 1 && finalB.history >= 1, {
    a: finalA.history,
    b: finalB.history,
  })
  await A.screenshot({ path: `${OUT}/08-online-finished.png` })
}

// ===========================================================================
// 3. 服务端回放（MongoDB / 内存仓库）
// ===========================================================================
{
  const payload = (await A.evaluate(`(async () => {
    const game = window.__CONNECT4__;
    const count = await game.refreshOnlineReplays(20);
    const s = game.online;
    return { count, message: s.message, first: s.replays[0] ? {
      id: String(s.replays[0].id), steps: s.replays[0].steps.length,
      mode: s.replays[0].mode, winner: s.replays[0].result.winner } : null };
  })()`)) as { count: number; message: string; first: { id: string; steps: number } | null }
  check(
    '#8 联机对局可从服务器拉回放（含完整 steps 快照，可直接播放）',
    payload.count >= 1 && (payload.first?.steps ?? 0) >= 5,
    payload,
  )
}

// ===========================================================================
// 4. 匹配码：建房 + 加入
// ===========================================================================
{
  await Promise.all([
    waitFor(A, (s) => s.status === 'idle' || s.status === 'ended', 6000),
    waitFor(B, (s) => s.status === 'idle' || s.status === 'ended', 6000),
  ])
  await A.evaluate('window.__CONNECT4__.online.status = "idle"')
  await B.evaluate('window.__CONNECT4__.online.status = "idle"')
  await A.evaluate('window.C4.create()')
  const created = await waitFor(A, (s) => s.code !== '', 6000)
  check('#8 创建房间会返回 6 位匹配码', /^[A-Z0-9]{6}$/.test(created.code), { code: created.code })

  await B.evaluate(`window.C4.join('${created.code}')`)
  // bugv34i：加入后先进房间，双方准备才开局
  await waitFor(A, (s) => s.roomCode === created.code, 8000)
  await waitFor(B, (s) => s.roomCode === created.code, 8000)
  await readyBoth(A, B)
  const joinedA = await waitFor(A, (s) => s.status === 'playing' || s.matchId !== '', 8000)
  const joinedB = await waitFor(B, (s) => s.status === 'playing' || s.matchId !== '', 8000)
  check(
    '#8 输入匹配码即可与房主开局',
    joinedA.matchId !== '' && joinedA.matchId === joinedB.matchId && joinedA.seat !== joinedB.seat,
    { matchId: joinedA.matchId, seats: [joinedA.seat, joinedB.seat] },
  )
  await A.screenshot({ path: `${OUT}/09-online-room.png` })
}

// ===========================================================================
// 5. 角色技能联机（bugv10 #11）
// ===========================================================================
{
  // 重新开一局：先在客户端选好角色（角色的技能表要在开局前发给服务端）
  await A.evaluate('window.__CONNECT4__.onlineResign()')
  await B.evaluate('window.__CONNECT4__.onlineResign()')
  await A.waitForTimeout(400)
  await A.evaluate(`window.__CONNECT4__.setCharacter(0, 'deepseek')`)
  await B.evaluate(`window.__CONNECT4__.setCharacter(0, 'gemini')`)

  await A.evaluate('window.C4.queue()')
  await B.evaluate('window.C4.queue()')
  await waitFor(A, (s) => s.roomCode !== '', 8000)
  await waitFor(B, (s) => s.roomCode !== '', 8000)
  await readyBoth(A, B)
  const skillA = await waitFor(A, (s) => s.matchId !== '' && s.seq >= 0, 9000)
  const skillB = await waitFor(B, (s) => s.matchId !== '' && s.seq >= 0, 9000)
  await waitFor(A, (s) => s.screen === 'playing' && !s.busy, 12000)
  await waitFor(B, (s) => s.screen === 'playing' && !s.busy, 12000)
  await A.waitForTimeout(2200)

  // 服务端下发的角色必须按座位落到位（两边都用同一套技能表，否则指纹会漂）
  const chars = (await A.evaluate(`(function () {
    const game = window.__CONNECT4__;
    return { my: [...game.characters], seat: game.online.seat,
      skillNames: game.ui.skills.map(function (list) { return list.map(function (s) { return s.name; }); }) };
  })()`)) as { my: string[]; seat: number; skillNames: string[][] }
  check(
    '#11 联机开局会把双方角色按座位下发，两端技能表一致（deepseek / gemini）',
    chars.skillNames[0][0] === '大胃袋' && chars.skillNames[1][0] === '猫的憩息',
    chars,
  )

  /**
   * 驱动到"某一方占住一棵魔力植物并且技能可用"，然后释放技能。
   *
   * 注意：先手是服务端掷骰决定的，所以施法者可能是 deepseek（盾）也可能是 gemini（回血），
   * 断言不能写死"护盾 +1"，得按**实际放出去的那个技能**来判（这里记下 slot / name）。
   */
  let castBy = -1
  let castSlot = -1
  let castName = ''
  let castCost = 0
  let guard = 0
  while (guard < 140 && castBy < 0) {
    guard += 1
    const [a, b] = await Promise.all([snap(A), snap(B)])
    if (a.result || b.result) break
    const mover = a.current === a.seat ? A : b.current === b.seat ? B : null
    const moverSnap = mover === A ? a : b
    if (!mover) break
    const plan = (await mover.evaluate(`(function () {
      const game = window.__CONNECT4__;
      const engine = game.engine.value;
      const seat = game.online.seat;
      const plants = Array.from(engine.magic.values()).map(function (p) { return { cell: p.cell, owner: p.owner }; });
      const mine = plants.filter(function (p) { return p.owner === seat; }).map(function (p) { return p.cell; });
      const free = plants.filter(function (p) { return p.owner === null; }).map(function (p) { return p.cell; });
      const states = game.ui.skills[seat].map(function (s) { return { slot: s.slot, ready: s.ready, costNow: s.costNow, name: s.name }; });
      return { mine: mine, free: free, ready: states.filter(function (s) { return s.ready; }), phase: engine.phase };
    })()`)) as {
      mine: number[]
      free: number[]
      ready: Array<{ slot: number; costNow: number; name: string }>
      phase: string
    }
    void moverSnap
    if (plan.phase === 'playing' && plan.ready.length > 0 && plan.mine.length + 1 > plan.ready[0].costNow) {
      const skill = plan.ready[0]
      const cells = plan.mine.slice(0, skill.costNow)
      const before = Math.max(a.seq, b.seq)
      await mover.evaluate(`window.__CONNECT4__.toggleSkill(window.__CONNECT4__.online.seat, ${skill.slot})`)
      for (const cell of cells) {
        await mover.evaluate(`window.__CONNECT4__.handleCellPick(${cell})`)
        await mover.waitForTimeout(120)
      }
      const advanced = await waitFor(A, (s) => s.seq > before, 8000)
      if (advanced.seq > before) {
        castBy = moverSnap.seat
        castSlot = skill.slot
        castName = skill.name
        castCost = skill.costNow
      }
      continue
    }
    const cell = plan.free.length > 0 ? plan.free[0] : ((await mover.evaluate('window.C4.firstEmpty()')) as number)
    if (cell < 0) break
    const before = Math.max(a.seq, b.seq)
    await mover.evaluate(`window.C4.pick(${cell})`)
    await waitFor(A, (s) => s.seq > before || s.result !== null, 8000)
    await Promise.all([waitFor(A, (s) => !s.busy, 15000), waitFor(B, (s) => !s.busy, 15000)])
  }

  await Promise.all([waitFor(A, (s) => !s.busy, 15000), waitFor(B, (s) => !s.busy, 15000)])
  const after = (await A.evaluate(`(function () {
    const game = window.__CONNECT4__;
    const engine = game.engine.value;
    return { seat: game.online.seat, shield: engine.shield.slice(), hp: engine.hp.slice(), hint: game.ui.hint,
      digest: game.localDigest(), magic: Array.from(engine.magic.values()).length,
      readyAt: Array.from(engine.skillReadyAt[${castBy}]) };
  })()`)) as {
    seat: number
    shield: number[]
    hp: number[]
    hint: string
    digest: string
    magic: number
    readyAt: number[]
  }
  const opponentView = (await B.evaluate(`(function () {
    const game = window.__CONNECT4__;
    const engine = game.engine.value;
    return { seat: game.online.seat, shield: engine.shield.slice(), hp: engine.hp.slice(), digest: game.localDigest(),
      readyAt: Array.from(engine.skillReadyAt[${castBy}]), hint: game.ui.hint };
  })()`)) as {
    seat: number
    shield: number[]
    hp: number[]
    digest: string
    readyAt: number[]
    hint: string
  }
  // 按实际放出去的技能判效果：大胃袋 → 护盾 +1；猫的憩息 → 回血（上限 6，所以只要求不掉）
  const effectOk =
    castName === '大胃袋'
      ? after.shield[castBy] === 1 && opponentView.shield[castBy] === 1
      : castName === '猫的憩息'
        ? after.hp[castBy] === opponentView.hp[castBy] && after.hp[castBy] >= 4
        : after.hp[castBy] === opponentView.hp[castBy]
  check(
    '#11 技能在联机里生效：服务端裁决后两端都拿到同一结果（技能效果 / 冷却 / 指纹一致）',
    castBy >= 0 &&
      castSlot >= 0 &&
      effectOk &&
      after.readyAt[castSlot] === opponentView.readyAt[castSlot] &&
      after.readyAt[castSlot] > 0 &&
      after.digest === opponentView.digest,
    { castBy, castName, castSlot, castCost, after, opponentView },
  )
  await A.screenshot({ path: `${OUT}/10-online-skill.png` })
}

// ===========================================================================
console.log('\n============================= 汇总 =============================')
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.item}`)
console.log(`通过 ${results.filter((r) => r.ok).length}/${results.length}`)
console.log('console errors:', problems.length ? problems : 'none')

await browser.close()
