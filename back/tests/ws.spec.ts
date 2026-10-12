/**
 * WebSocket 端到端测试：两个真实 `ws` 客户·+ 内存模式 + 随机端口起真服务· *
 * 覆盖：握手校·-> 在线匹配 -> 骰子/座位 -> 交替落子（含"成线 -> 攻击 -> 防守抵消"·> gameOver
 * -> 回放 REST 校验；以及匹配码、notYourTurn / illegalMove / roomNotFound / roomFull、opponentLeft· */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startServer, type RunningServer } from '../src/index'
import { DEFAULT_CHARACTERS, skillsOfCharacter, type CharacterId } from '../src/core/characters'
import { GameEngine } from '../src/core/engine'
import { hasLine } from '../src/core/lines'
import { Rng } from '../src/core/random'
import { cellOf, other, type PlayerIndex } from '../src/core/types'
import { digestOfEngine } from '../src/digest'
import { setLogLevel } from '../src/logger'
import { PROTOCOL_VERSION, type AppliedMessage, type ClientMessage, type ErrorMessage, type GameOverMessage, type ServerMessage } from '../src/protocol'
import type { ReplayDoc } from '../src/db'

type MessageType = ServerMessage['t']

class TestClient {
  private readonly inbox: ServerMessage[] = []
  private readonly consumed = new Set<number>()
  private readonly waiters: Array<{
    predicate: (message: ServerMessage) => boolean
    resolve: (message: ServerMessage) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }> = []
  private closed = false
  readonly errors: Error[] = []
  /** 这条连接登录用的账号（bugv34k：回放要按账号能查到）。 */
  account = ''

  private constructor(readonly socket: WebSocket) {}

  static async connect(url: string): Promise<TestClient> {
    const socket = new WebSocket(url)
    const client = new TestClient(socket)
    socket.on('message', (raw: unknown) => {
      try {
        client.inbox.push(JSON.parse(String(raw)) as ServerMessage)
      } catch {
        client.errors.push(new Error(`收到无法解析的消息：${String(raw)}`))
      }
      client.flush()
    })
    socket.on('error', (error: Error) => client.errors.push(error))
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', (error: Error) => reject(error))
    })
    return client
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message))
  }

  private indexOf(predicate: (message: ServerMessage) => boolean): number {
    for (let i = 0; i < this.inbox.length; i += 1) {
      if (!this.consumed.has(i) && predicate(this.inbox[i])) return i
    }
    return -1
  }

  private flush(): void {
    for (let i = 0; i < this.waiters.length; i += 1) {
      const waiter = this.waiters[i]
      const index = this.indexOf(waiter.predicate)
      if (index < 0) continue
      this.consumed.add(index)
      clearTimeout(waiter.timer)
      this.waiters.splice(i, 1)
      i -= 1
      waiter.resolve(this.inbox[index])
    }
  }

  waitFor<T extends ServerMessage>(predicate: (message: ServerMessage) => message is T, timeoutMs?: number): Promise<T>
  waitFor(predicate: (message: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>
  waitFor(predicate: (message: ServerMessage) => boolean, timeoutMs = 5000): Promise<ServerMessage> {
    const index = this.indexOf(predicate)
    if (index >= 0) {
      this.consumed.add(index)
      return Promise.resolve(this.inbox[index])
    }
    return new Promise<ServerMessage>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const position = this.waiters.indexOf(waiter)
          if (position >= 0) this.waiters.splice(position, 1)
          const dump = this.inbox.map((message) => message.t).join(', ')
          reject(new Error(`等待消息超时（已收到 ${dump || '（空）'}）`))
        }, timeoutMs),
      }
      this.waiters.push(waiter)
    })
  }

  next<T extends MessageType>(type: T, timeoutMs = 5000): Promise<Extract<ServerMessage, { t: T }>> {
    return this.waitFor((message) => message.t === type, timeoutMs).then(
      (message) => message as Extract<ServerMessage, { t: T }>,
    )
  }

  /** 收到过的所有消息类型（按到达顺序），用于校验协议的消息顺序·*/
  receivedTypes(): string[] {
    return this.inbox.map((message) => message.t)
  }

  /** 关闭连接（测试里·terminate 更快，服务端同样收到 close）·*/
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve())
      this.socket.terminate()
    })
  }
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

let server: RunningServer
let wsUrl = ''
const live: TestClient[] = []

/** bugv34i：每个用例用唯一账号（同名账号第二次 register 会 usernameTaken）。 */
let authSeq = 0

async function connect(playerId: string, name = playerId, accountOverride?: string): Promise<TestClient> {
  const client = await TestClient.connect(wsUrl)
  live.push(client)
  client.send({ t: 'hello', playerId, name, version: PROTOCOL_VERSION })
  const welcome = await client.next('welcome')
  expect(welcome.playerId).toBe(playerId)
  expect(welcome.version).toBe(PROTOCOL_VERSION)
  // 没带令牌 → 未登录；联机动作都要求先登录（bugv34i）
  expect(welcome.authenticated).toBe(false)
  const account = accountOverride ?? `u_${playerId.replace(/[^a-zA-Z0-9]/g, '_')}_${(authSeq += 1)}`
  client.send({ t: 'register', username: account, password: 'test-pass', nickname: name })
  const logged = await client.next('loggedIn')
  expect(typeof logged.nickname).toBe('string')
  client.account = logged.username
  return client
}

/**
 * bugv34i：双方都点「准备」→ 服务端自动开局（房间里已没有「开始游戏」）。
 *
 * 每次 ready 变化都会向房内广播一份 `roomState`（甲准备的、乙准备的），
 * 开局后还会再补一份"对局中"的 —— 这里一次性把它们消费掉，
 * 免得后面 `next('roomState')` 拿到过期的那一份。
 */
async function readyBoth(a: TestClient, b: TestClient): Promise<void> {
  a.send({ t: 'roomReady', ready: true })
  b.send({ t: 'roomReady', ready: true })
  for (let round = 0; round < 3; round += 1) {
    await Promise.all([a.next('roomState'), b.next('roomState')])
  }
}

/** 用在线匹配凑一局（返回时 matched 已被消费，座位信息一并带回）·*/
async function matchPair(
  aId: string,
  bId: string,
  characters?: { a?: string; b?: string },
): Promise<{
  a: TestClient
  b: TestClient
  matchId: string
  dice: { rolls: readonly [number, number]; first: PlayerIndex }
  seatA: PlayerIndex
  seatB: PlayerIndex
  characters: [CharacterId, CharacterId]
}> {
  const a = await connect(aId, `·${aId}`)
  const b = await connect(bId, `·${bId}`)
  a.send(characters?.a === undefined ? { t: 'queue' } : { t: 'queue', character: characters.a })
  await a.next('queued')
  b.send(characters?.b === undefined ? { t: 'queue' } : { t: 'queue', character: characters.b })
  // bugv34e：匹配成功不再直接开局 —— 两人先进同一个房间（随机一方为房主），
  // bugv34i：再由**双方各点一次「准备」**（都准备好才自动开局）。
  const [roomA, roomB] = await Promise.all([a.next('roomState'), b.next('roomState')])
  expect(roomA.code).toBe(roomB.code)
  expect(roomA.phase).toBe('lobby')
  expect(roomA.members).toHaveLength(2)
  // bugv34i：双方都点「准备」→ 服务端自动开局（roomState 广播已在 readyBoth 里消费掉）
  await readyBoth(a, b)
  const [matchedA, matchedB] = await Promise.all([a.next('matched'), b.next('matched')])
  expect(matchedA.matchId).toBe(matchedB.matchId)
  expect(matchedA.dice).toEqual(matchedB.dice)
  expect([matchedA.seat, matchedB.seat].sort()).toEqual([0, 1])
  // 角色按座位下发，且两端看到的完全一致（bugv10 #11）
  expect(matchedA.characters).toEqual(matchedB.characters)
  expect(matchedA.characters).toHaveLength(2)
  return {
    a,
    b,
    matchId: matchedA.matchId,
    dice: matchedA.dice,
    seatA: matchedA.seat,
    seatB: matchedB.seat,
    characters: matchedA.characters,
  }
}

// ---------------------------------------------------------------------------
// 对局驱动（客户端镜像一份引擎，用于校验 digest 与选择落点·// ---------------------------------------------------------------------------

interface ScriptStep {
  role: 'first' | 'second'
  cell: number
}

/**
 * 构造局面（与前端同规则）：
 *  - 先手 0,1,2,3 连成一·4 连珠 -> 触发攻击、棋子被移除并留下高光；
 *  - 后手 72,73,74,75 同时连成 4 连珠 -> 防守方也成线，双方抵消（最终攻击·4 vs 4）· * 之后交给贪心策略打到 gameOver· */
const SCRIPT: ScriptStep[] = [
  { role: 'first', cell: 0 },
  { role: 'second', cell: 72 },
  { role: 'first', cell: 1 },
  { role: 'second', cell: 73 },
  { role: 'first', cell: 2 },
  { role: 'second', cell: 74 },
  { role: 'first', cell: 3 },
  { role: 'second', cell: 75 },
]

function chooseMove(engine: GameEngine, rng: Rng): number {
  const me = engine.current
  const empties = engine.emptyCells()
  if (empties.length === 0) throw new Error('没有可落子的位置')

  if (engine.phase === 'awaitingDefense') {
    // 优先下在攻击方高光位置削弱攻击；否则随机
    const highlights = [...engine.highlights.keys()].filter((cell) => engine.board[cell] === 0).sort((x, y) => x - y)
    if (highlights.length > 0) return highlights[0]
    return rng.pick(empties)
  }

  // 能成线就成线（触发攻击）
  for (const cell of empties) {
    const probe = engine.board.slice()
    probe[cell] = cellOf(me)
    if (hasLine(probe, me)) return cell
  }

  // 其次贴着已有棋子下，加速成·
const mine = new Set<number>()
  for (let i = 0; i < engine.board.length; i += 1) if (engine.board[i] === cellOf(me)) mine.add(i)
  if (mine.size > 0) {
    const near = empties.filter((cell) => {
      const row = Math.floor(cell / 9)
      const col = cell % 9
      for (const [dr, dc] of [
        [0, 1],
        [1, 0],
        [1, 1],
        [1, -1],
      ] as const) {
        const r = row + dr
        const c = col + dc
        if (r < 0 || r > 8 || c < 0 || c > 8) continue
        if (mine.has(r * 9 + c)) return true
      }
      return false
    })
    if (near.length > 0) return near[rng.int(0, near.length - 1)]
  }
  return rng.pick(empties)
}

interface DriveStats {
  applied: number
  defends: number
  defenderLines: number
  clashes: number
}

async function drive(options: {
  client: TestClient
  matchId: string
  seat: PlayerIndex
  first: PlayerIndex
  seed: number
  /** 双方角色（bugv10 #11）：本地镜像必须和服务端同一份技能表，否则指纹对不上·*/
  characters: [CharacterId, CharacterId]
  stats: DriveStats
}): Promise<void> {
  const { client, matchId, seat, first, stats } = options
  const engine = mirrorEngine(first, options.characters)
  const rng = new Rng(options.seed)
  let applied = 0

  const moveFor = (index: number): number => {
    const step = SCRIPT[index]
    const roleSeat = step?.role === 'first' ? first : step ? other(first) : null
    if (step && roleSeat === seat) return step.cell
    return chooseMove(engine, rng)
  }

  const sendIfMyTurn = (index: number): void => {
    if (engine.isOver) return
    if (engine.current !== seat) return
    if (engine.phase !== 'playing' && engine.phase !== 'awaitingDefense') return
    client.send({ t: 'move', matchId, cell: moveFor(index) })
  }

  // matched 已经由测试消费；先手方立刻走第一·
if (engine.current === seat) sendIfMyTurn(0)

  for (;;) {
    const message = await client.waitFor(
      (candidate): candidate is AppliedMessage | GameOverMessage | ErrorMessage =>
        candidate.t === 'applied' || candidate.t === 'gameOver' || candidate.t === 'error',
    )
    if (message.t === 'error') throw new Error(`服务端返回错误：${message.code} ${message.message}`)
    if (message.t === 'gameOver') {
      expect(message.matchId).toBe(matchId)
      expect(message.replayId).toBe(matchId)
      return
    }

    expect(message.seq).toBe(applied + 1)
    expect(message.matchId).toBe(matchId)
    if (message.kind === 'defend') engine.defend(message.cell)
    else engine.commit(message.cell)
    applied += 1
    stats.applied = applied

    // 两端局面必须完全一·
expect(digestOfEngine(engine)).toBe(message.digest)
    if (message.kind === 'defend') {
      stats.defends += 1
      const snapshot = engine.attack
      if ((snapshot?.defenderAttack ?? 0) > 0) stats.defenderLines += 1
      if (snapshot?.mode === 'canceled') stats.clashes += 1
    }

    if (message.phase === 'gameOver') continue
    sendIfMyTurn(applied)
  }
}

async function fetchReplay(playerId: string, matchId: string, attempts = 20): Promise<ReplayDoc> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(`${server.url}/api/replays?playerId=${encodeURIComponent(playerId)}&limit=5`)
    const body = (await response.json()) as { ok: boolean; items: ReplayDoc[] }
    const found = body.items.find((item) => item.matchId === matchId)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`未查到对局 ${matchId} 的回放`)
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  setLogLevel('silent')
  server = await startServer({
    port: 0,
    dbMode: 'memory',
    effectiveDbMode: 'memory',
    mongodbUri: null,
    serveFrontend: false,
    logLevel: 'silent',
  })
  wsUrl = `ws://127.0.0.1:${server.port}/ws`
})

afterAll(async () => {
  for (const client of live) await client.close().catch(() => undefined)
  await server?.close()
})

describe('WebSocket 网关', () => {
  it('握手：hello 之前发别的消·-> badRequest；版本不·-> versionMismatch；ping -> pong', async () => {
    const client = await TestClient.connect(wsUrl)
    live.push(client)

    client.send({ t: 'queue' })
    const bad = await client.next('error')
    expect(bad.code).toBe('badRequest')
    expect(bad.reqType).toBe('queue')

    client.send({ t: 'hello', playerId: 'legacy', name: '老客户端', version: PROTOCOL_VERSION - 1 })
    const mismatch = await client.next('error')
    expect(mismatch.code).toBe('versionMismatch')
    expect(mismatch.reqType).toBe('hello')

    // 版本对上之后仍然可以正常握手
    client.send({ t: 'hello', playerId: 'fresh', name: '新客户端', version: PROTOCOL_VERSION })
    const welcome = await client.next('welcome')
    expect(welcome.playerId).toBe('fresh')
    expect(welcome.version).toBe(PROTOCOL_VERSION)
    expect(typeof welcome.serverTime).toBe('number')

    client.send({ t: 'ping' })
    const pong = await client.next('pong')
    expect(typeof pong.time).toBe('number')

    // 服务端消息结构不合法
    client.socket.send('not-json')
    const jsonError = await client.next('error')
    expect(jsonError.code).toBe('badRequest')
    await client.close()
  })

  it('在线匹配 FIFO：重·queue 幂等，cancelQueue 生效，两端拿到同一骰子与相反座·', async () => {
    // 先验·cancelQueue 真的把人移出队列（丙排队后立刻取消）
    const c = await connect('queue-c', '·')
    c.send({ t: 'queue' })
    expect((await c.next('queued')).position).toBe(1)
    c.send({ t: 'cancelQueue' })
    await c.next('queueCanceled')

    const a = await connect('queue-a', '·')
    const b = await connect('queue-b', '·')

    a.send({ t: 'queue' })
    expect((await a.next('queued')).position).toBe(1)
    // 重复 queue 幂等，位置不·
a.send({ t: 'queue' })
    expect((await a.next('queued')).position).toBe(1)

    b.send({ t: 'queue' })
    // bugv34e：先拿到房间，再由房主开局
    const [roomA2, roomB2] = await Promise.all([a.next('roomState'), b.next('roomState')])
    expect(roomA2.code).toBe(roomB2.code)
    await readyBoth(a, b)
    const [matchedA, matchedB] = await Promise.all([a.next('matched'), b.next('matched')])
    expect(matchedA.matchId).toBe(matchedB.matchId)
    expect([matchedA.seat, matchedB.seat].sort()).toEqual([0, 1])
    expect(matchedA.dice).toEqual(matchedB.dice)
    expect(matchedA.code).toBe(roomA2.code)
    expect(matchedA.opponent).toBe('·')

    // 丙取消后不会被匹配进这一局
    await new Promise((resolve) => setTimeout(resolve, 100))
    c.send({ t: 'ping' })
    await c.next('pong')

    await Promise.all([a.close(), b.close(), c.close()])
  })

  it('房间（bugv34e）：建房 -> 加入 -> 第三·roomFull；不存在的码 roomNotFound；自己加自己算"回到房间"', async () => {
    const host = await connect('room-host', '房主')
    host.send({ t: 'createRoom' })
    const created = await host.next('roomState')
    expect(created.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    expect(created.phase).toBe('lobby')
    expect(created.members).toHaveLength(1)
    expect(created.canStart).toBe(false)
    // 创建即含默认房间设置（血量上限 12 + 默认魔力植物 / 黑夜）
    expect(created.settings.hpLimit).toBe(12)

    const missing = await connect('room-missing', '路人')
    missing.send({ t: 'joinRoom', code: 'ZZZZZZ' })
    expect((await missing.next('error')).code).toBe('roomNotFound')

    const guest = await connect('room-guest', '客人')
    guest.send({ t: 'joinRoom', code: created.code.toLowerCase() })
    // 加入**不再直接开局**：两人各自收到新的房间状态
    const [hostRoom, guestRoom] = await Promise.all([host.next('roomState'), guest.next('roomState')])
    expect(hostRoom.members).toHaveLength(2)
    // bugv34i：两人都在也**不算**可以开始 —— 还要双方都点「准备」
    expect(hostRoom.canStart).toBe(false)
    expect(hostRoom.members.every((m) => m.ready === false)).toBe(true)
    expect(guestRoom.you).toBe('room-guest')
    expect(hostRoom.members.find((m) => m.playerId === 'room-host')?.host).toBe(true)

    const third = await connect('room-third', '第三·')
    third.send({ t: 'joinRoom', code: created.code })
    expect((await third.next('error')).code).toBe('roomFull')

    // 已经是成员 → "回到房间"（不报 roomFull）
    host.send({ t: 'rejoinRoom', code: created.code })
    expect((await host.next('roomState')).code).toBe(created.code)

    await Promise.all([host.close(), guest.close(), third.close(), missing.close()])
  })

  it('房间交互（bugv34e）：房主才能改设置 / 转让 / 开始；聊天双向广播；非房主被拒 notHost', async () => {
    const host = await connect('int-host', '房主')
    const guest = await connect('int-guest', '客人')
    host.send({ t: 'createRoom' })
    const created = await host.next('roomState')
    guest.send({ t: 'joinRoom', code: created.code })
    await Promise.all([host.next('roomState'), guest.next('roomState')])

    // --- 角色：各改各的，广播给双方（两边都要消费掉，否则后面的 next('roomState') 会拿到旧消息）---
    guest.send({ t: 'roomCharacter', character: 'gtp' })
    const [charRoom, charRoomGuest] = await Promise.all([host.next('roomState'), guest.next('roomState')])
    expect(charRoom.members.find((m) => m.playerId === 'int-guest')?.character).toBe('gtp')
    expect(charRoomGuest.members.find((m) => m.playerId === 'int-guest')?.character).toBe('gtp')

    // --- 聊天：双方都收到 roomChat ---
    guest.send({ t: 'chat', text: '  你好呀  ' })
    const chat = await host.next('roomChat')
    expect(chat.entry.text).toBe('你好呀')
    expect(chat.entry.playerId).toBe('int-guest')

    // --- 设置：非房主被拒 ---
    guest.send({ t: 'roomSettings', settings: { hpLimit: 8 } })
    expect((await guest.next('error')).code).toBe('notHost')

    // --- 设置：房主可改，双方收到 ---
    host.send({ t: 'roomSettings', settings: { hpLimit: 16, night: { warnTurns: 4 } } })
    const settingsRoom = await Promise.all([host.next('roomState'), guest.next('roomState')])
    expect(settingsRoom[0].settings.hpLimit).toBe(16)
    expect(settingsRoom[0].settings.night.warnTurns).toBe(4)
    expect(settingsRoom[1].settings.hpLimit).toBe(16)

    // --- 转让房主 ---
    host.send({ t: 'transferHost', to: 'int-guest' })
    const afterTransfer = await host.next('roomState')
    await guest.next('roomState')
    expect(afterTransfer.members.find((m) => m.playerId === 'int-guest')?.host).toBe(true)

    // --- 现在原房主改设置会被拒（notHost）---
    host.send({ t: 'roomSettings', settings: { hpLimit: 8 } })
    expect((await host.next('error')).code).toBe('notHost')

    // --- 开局改为「双方准备」（bugv34i）：只准备一方不会开局 ---
    guest.send({ t: 'roomReady', ready: true })
    const readyRoom = await Promise.all([host.next('roomState'), guest.next('roomState')])
    expect(readyRoom[0].members.find((m) => m.playerId === 'int-guest')?.ready).toBe(true)
    expect(readyRoom[0].members.find((m) => m.playerId === 'int-host')?.ready).toBe(false)
    expect(readyRoom[0].canStart).toBe(false)
    // 另一方也准备 → 自动开局，设置随 matched 下发（血量上限 16）
    host.send({ t: 'roomReady', ready: true })
    const [matchedHost, matchedGuest] = await Promise.all([host.next('matched'), guest.next('matched')])
    expect(matchedHost.settings.hpLimit).toBe(16)
    expect(matchedHost.matchId).toBe(matchedGuest.matchId)
    expect([matchedHost.seat, matchedGuest.seat].sort()).toEqual([0, 1])
    await Promise.all([host.close(), guest.close()])
  })

  it('房间保留（bugv34e）：一局结束后回到大厅、比分累计、聊天保留；对手断线房间不销毁', async () => {
    const pair = await matchPair('keep-a', 'keep-b')
    // 座位随机：谁先手谁认输，另一个人留下观察
    const resigner = pair.dice.first === pair.seatA ? pair.a : pair.b
    const winner = resigner === pair.a ? pair.b : pair.a
    const winnerId = resigner === pair.a ? 'keep-b' : 'keep-a'

    // 先聊一句，验收"房间保留聊天"
    resigner.send({ t: 'chat', text: '开打吧' })
    await winner.next('roomChat')

    // 一方认输 → 另一方获胜
    resigner.send({ t: 'resign', matchId: pair.matchId })
    await winner.next('gameOver')
    // 对局结束后房间回到大厅并广播比分（认输方也收到）
    const afterGame = await resigner.next('roomState')
    expect(afterGame.phase).toBe('lobby')
    expect(afterGame.matchId).toBeNull()
    expect(afterGame.chat.some((entry) => entry.text === '开打吧')).toBe(true)
    expect(afterGame.members.find((member) => member.playerId === winnerId)?.wins).toBe(1)

    // 赢家断线（不回房间）：房间不销毁，只标记离线
    await winner.close()
    const offlineRoom = await resigner.next('roomState')
    expect(offlineRoom.code).toBe(afterGame.code)
    expect(offlineRoom.members).toHaveLength(2)
    expect(offlineRoom.members.filter((member) => !member.connected)).toHaveLength(1)
    expect(offlineRoom.canStart).toBe(false)
    // 房间数据还在（比分 / 聊天都没丢）
    expect(server.rooms.get(afterGame.code)).not.toBeNull()
    expect(server.rooms.get(afterGame.code)?.chat).toHaveLength(1)

    // 最后一人显式退出 → 房间里只剩那个"离线"的赢家（数据仍在，等他回来）
    resigner.send({ t: 'leave' })
    expect((await resigner.next('roomClosed')).reason).toBe('left')
    await resigner.close()
    expect(server.rooms.get(afterGame.code)).not.toBeNull()
    expect(server.rooms.get(afterGame.code)?.members.size).toBe(1)

    // 全部成员都走光（离线超过 TTL）→ 房间数据完全销毁
    expect(server.rooms.sweep(0)).toBeGreaterThanOrEqual(1)
    expect(server.rooms.get(afterGame.code)).toBeNull()
  }, 15000)

  it('裁决：notYourTurn / illegalMove / sync 完整局·', async () => {
    const pair = await matchPair('verdict-a', 'verdict-b')
    const first = pair.dice.first
    const firstClient = first === pair.seatA ? pair.a : pair.b
    const secondClient = first === pair.seatA ? pair.b : pair.a
    const secondSeat = other(first)

    // 还没轮到·
secondClient.send({ t: 'move', matchId: pair.matchId, cell: 0 })
    const notYourTurn = await secondClient.next('error')
    expect(notYourTurn.code).toBe('notYourTurn')
    expect(notYourTurn.reqType).toBe('move')

    // 越界
    firstClient.send({ t: 'move', matchId: pair.matchId, cell: 999 })
    expect((await firstClient.next('error')).code).toBe('illegalMove')

    // 正常落子：双方都收到 applied
    firstClient.send({ t: 'move', matchId: pair.matchId, cell: 40 })
    const [appliedFirst, appliedSecond] = await Promise.all([firstClient.next('applied'), secondClient.next('applied')])
    expect(appliedFirst.seq).toBe(appliedSecond.seq)
    expect(appliedFirst.cell).toBe(40)
    expect(appliedFirst.kind).toBe('place')
    expect(appliedFirst.result).toBeNull()

    // 同一步已占位 -> illegalMove（此时轮到对手）
    secondClient.send({ t: 'move', matchId: pair.matchId, cell: 40 })
    expect((await secondClient.next('error')).code).toBe('illegalMove')

    // sync：完整局面与 digest
    secondClient.send({ t: 'sync', matchId: pair.matchId })
    const state = await secondClient.next('state')
    expect(state.matchId).toBe(pair.matchId)
    expect(state.seat).toBe(secondSeat)
    expect(state.seq).toBe(1)
    expect(state.board[40]).toBe(first + 1)
    expect(state.highlights).toEqual([])
    expect(state.attack).toBeNull()
    expect(state.current).toBe(secondSeat)
    expect(state.digest).toBe(appliedFirst.digest)

    // matchId 不存·/ 不在对局·
secondClient.send({ t: 'sync', matchId: 'no-such-match' })
    expect((await secondClient.next('error')).code).toBe('notInMatch')

    await Promise.all([pair.a.close(), pair.b.close()])
  })

  it('完整对局：构造成·攻击/防守抵消，一路打·gameOver 并落库回·', async () => {
    const a = await connect('full-a', '红方')
    const b = await connect('full-b', '蓝方')
    a.send({ t: 'queue' })
    await a.next('queued')
    b.send({ t: 'queue' })
    const [roomFull, roomFullB] = await Promise.all([a.next('roomState'), b.next('roomState')])
    // bugv34i：双方都准备 → 自动开局（房主随机只影响"谁能改房间设置"）
    await readyBoth(a, b)
    const [matchedA, matchedB] = await Promise.all([a.next('matched'), b.next('matched')])
    const matchId = matchedA.matchId
    const dice = matchedA.dice
    // 座位由服务端分配（房主 = 座位 0），不能再假设 a 一定是 0
    expect([matchedA.seat, matchedB.seat].sort()).toEqual([0, 1])
    expect(matchedA.dice).toEqual(matchedB.dice)
    expect(roomFullB.code).toBe(roomFull.code)
    expect(dice.first === 0 || dice.first === 1).toBe(true)

    const stats: DriveStats = { applied: 0, defends: 0, defenderLines: 0, clashes: 0 }
    const otherStats: DriveStats = { applied: 0, defends: 0, defenderLines: 0, clashes: 0 }
    await Promise.all([
      drive({ client: a, matchId, seat: matchedA.seat, first: dice.first, seed: 20260101, characters: matchedA.characters, stats }),
      drive({ client: b, matchId, seat: matchedB.seat, first: dice.first, seed: 20260202, characters: matchedA.characters, stats: otherStats }),
    ])
    // 两端看到的步·事件数必须一·
expect(otherStats.applied).toBe(stats.applied)
    expect(otherStats.defends).toBe(stats.defends)

    // 至少一次成线攻·+ 至少一次防守，并且构造局面里出现·防守方也成线 -> 抵消"
    expect(stats.defends).toBeGreaterThanOrEqual(1)
    expect(stats.defenderLines).toBeGreaterThanOrEqual(1)
    expect(stats.clashes).toBeGreaterThanOrEqual(1)

    // 结束·sync 仍能拿到终局局·
a.send({ t: 'sync', matchId })
    const finalState = await a.next('state')
    expect(finalState.phase).toBe('gameOver')
    expect(finalState.seq).toBe(stats.applied)
    expect(finalState.result).not.toBeNull()

    // 回放 REST
    const replay = await fetchReplay('full-a', matchId)
    expect(replay.matchId).toBe(matchId)
    expect(replay.steps).toHaveLength(stats.applied)
    expect(replay.result).toEqual(finalState.result)
    // 落库的玩家顺序按**座位**（房主随机 → 不能写死 a 在前）
    const bySeat: Array<[PlayerIndex, string, string]> = [
      [matchedA.seat, 'full-a', '红方'],
      [matchedB.seat, 'full-b', '蓝方'],
    ]
    bySeat.sort((x, y) => x[0] - y[0])
    expect(replay.playerIds).toEqual(bySeat.map((entry) => entry[1]))
    expect(replay.playerNames).toEqual(bySeat.map((entry) => entry[2]))
    expect(replay.dice).toEqual(dice)
    expect(replay.steps.filter((step) => step.defense).length).toBe(stats.defends)
    for (const step of replay.steps) {
      expect(step.board).toHaveLength(81)
      expect(step.hp).toHaveLength(2)
    }
    // 快照口径：成线那一步，攻击方连珠棋子已被移·
const matchStep = replay.steps.find((step) => step.match && !step.defense)
    expect(matchStep).toBeTruthy()
    if (matchStep) expect(matchStep.board).toHaveLength(81)

    // 单局回放接口
    const detail = await fetch(`${server.url}/api/replays/${matchId}`)
    const detailBody = (await detail.json()) as { ok: boolean; replay: ReplayDoc }
    expect(detailBody.ok).toBe(true)
    expect(detailBody.replay.matchId).toBe(matchId)

    // 健康检·/ 统计
    const health = (await (await fetch(`${server.url}/api/health`)).json()) as { ok: boolean; db: string; matches: number }
    expect(health.ok).toBe(true)
    expect(health.db).toBe('memory')
    const stats2 = (await (await fetch(`${server.url}/api/stats`)).json()) as { ok: boolean; replays: { replays: number } }
    expect(stats2.ok).toBe(true)
    expect(stats2.replays.replays).toBeGreaterThanOrEqual(1)

    // 没有 playerId 时返回最近的对局（便于调试）
    const recent = (await (await fetch(`${server.url}/api/replays?limit=1`)).json()) as { items: ReplayDoc[] }
    expect(recent.items.length).toBe(1)

    await Promise.all([a.close(), b.close()])
  }, 60_000)

  it('认输：双方收·gameOver，胜者为对手', async () => {
    const pair = await matchPair('resign-a', 'resign-b')
    const loser = pair.a
    loser.send({ t: 'resign', matchId: pair.matchId })
    const [overA, overB] = await Promise.all([pair.a.next('gameOver'), pair.b.next('gameOver')])
    expect(overA.result.winner).toBe(other(pair.seatA))
    expect(overB.result.winner).toBe(other(pair.seatA))
    expect(overA.replayId).toBe(pair.matchId)
    await Promise.all([pair.a.close(), pair.b.close()])
  })

  it('对局中一方断开：另一方收·opponentLeft(disconnect)', async () => {
    const pair = await matchPair('drop-a', 'drop-b')
    await pair.a.close()
    const left = await pair.b.next('opponentLeft')
    expect(left.matchId).toBe(pair.matchId)
    expect(left.reason).toBe('disconnect')
    // 房间已作废，继续落子会被拒绝
    pair.b.send({ t: 'move', matchId: pair.matchId, cell: 0 })
    const error = await pair.b.next('error')
    expect(['notInMatch', 'notYourTurn', 'illegalMove']).toContain(error.code)
    await pair.b.close()
  })

  it('默认玩家名：没有 name 时服务端补一个，不会为空', async () => {
    const a = await TestClient.connect(wsUrl)
    live.push(a)
    a.send({ t: 'hello', playerId: '9f8e7d6c-5b4a-3210-9876-543210fedcba', version: PROTOCOL_VERSION })
    await a.next('welcome')
    // bugv34i：昵称留空 → 服务端按 playerId 兜底（这条用例就是验它）
    a.send({ t: 'register', username: 'name_user_9f8e', password: 'test-pass', nickname: '' })
    await a.next('loggedIn')
    const b = await connect('name-b', '·')
    a.send({ t: 'queue' })
    await a.next('queued')
    b.send({ t: 'queue' })
    const [roomA, roomB] = await Promise.all([a.next('roomState'), b.next('roomState')])
    await readyBoth(a, b)
    const [, matchedB] = await Promise.all([a.next('matched'), b.next('matched')])
    expect(matchedB.opponent).toBe('玩家9f8e')
    expect(roomB.code).toBe(roomA.code)
    await Promise.all([a.close(), b.close()])
  }, 15000)

  // -------------------------------------------------------------------------
  // bugv7 #1：这两条都曾导致"一方落子后另一方点不动棋盘"
  // -------------------------------------------------------------------------

  it('入队即配对成功时不会再补·queued（消息顺序：roomState 之后不能·queued·', async () => {
    const a = await connect('order-a', '·')
    const b = await connect('order-b', '·')
    a.send({ t: 'queue' })
    await a.next('queued')
    // b 这一步会立刻配对：它不应该再收到 queued（那会把客户端的"房间里"覆盖成"排队中"）
    b.send({ t: 'queue' })
    const [roomA, roomB] = await Promise.all([a.next('roomState'), b.next('roomState')])
    await new Promise((resolve) => setTimeout(resolve, 150))

    for (const [label, client] of [
      ['·', a],
      ['·', b],
    ] as const) {
      const types = client.receivedTypes()
      const roomAt = types.indexOf('roomState')
      const queuedAt = types.indexOf('queued')
      expect(roomAt, `${label} 应该收到 roomState`).toBeGreaterThanOrEqual(0)
      expect(queuedAt === -1 || queuedAt < roomAt, `${label} 的消息顺序异常：${types.join('>')}`).toBe(true)
    }
    expect(roomA.code).toBe(roomB.code)
    await Promise.all([a.close(), b.close()])
  })

  it('同一 playerId 重复登录：新连接接管，旧连接收到 duplicateLogin 并被断开', async () => {
    const first = await connect('dup-player', '第一个标签页')
    const second = await TestClient.connect(wsUrl)
    live.push(second)
    second.send({ t: 'hello', playerId: 'dup-player', name: '第二个标签页', version: PROTOCOL_VERSION })
    const welcome = await second.next('welcome')
    expect(welcome.playerId).toBe('dup-player')

    const error = await first.next('error')
    expect(error.code).toBe('duplicateLogin')
    await new Promise<void>((resolve) => {
      if (first.socket.readyState === WebSocket.CLOSED) resolve()
      else first.socket.once('close', () => resolve())
    })

    // 新连接可以正常使·
second.send({ t: 'ping' })
    await second.next('pong')
    await second.close()
  })

  // -------------------------------------------------------------------------
  // bugv34l：同一**账号**重复登录 = 顶号（与上面的「同一 playerId」是两条不同规则）
  // -------------------------------------------------------------------------

  it('同一账号在别处登录：旧连接收到 sessionExpired 并被断开；旧令牌再也恢复不了登录态', async () => {
    const account = `kick_me_${(authSeq += 1)}`

    // 设备一：注册并登录
    const deviceA = await TestClient.connect(wsUrl)
    live.push(deviceA)
    deviceA.send({ t: 'hello', playerId: 'kick-dev-a', name: '设备一', version: PROTOCOL_VERSION })
    await deviceA.next('welcome')
    deviceA.send({ t: 'register', username: account, password: 'secret-1', nickname: '顶号甲' })
    const tokenA = (await deviceA.next('loggedIn')).token

    // 设备二：同一账号登录（playerId 不同 —— 只有账号相同）
    const deviceB = await TestClient.connect(wsUrl)
    live.push(deviceB)
    deviceB.send({ t: 'hello', playerId: 'kick-dev-b', name: '设备二', version: PROTOCOL_VERSION })
    await deviceB.next('welcome')
    deviceB.send({ t: 'login', username: account.toUpperCase(), password: 'secret-1' })
    await deviceB.next('loggedIn')

    // 设备一被顶掉
    expect((await deviceA.next('error')).code).toBe('sessionExpired')
    await new Promise<void>((resolve) => {
      if (deviceA.socket.readyState === WebSocket.CLOSED) resolve()
      else deviceA.socket.once('close', () => resolve())
    })

    // 旧令牌已作废：拿它 hello 会再收到 sessionExpired，但握手照常完成（未登录，可重新登录）
    const stale = await TestClient.connect(wsUrl)
    live.push(stale)
    stale.send({ t: 'hello', playerId: 'kick-dev-a', name: '设备一', version: PROTOCOL_VERSION, token: tokenA })
    expect((await stale.next('error')).code).toBe('sessionExpired')
    expect((await stale.next('welcome')).authenticated).toBe(false)

    await Promise.all([deviceB.close(), stale.close()])
  })

  it('刷新页面（同身份重连）不会作废正在进行的对局', async () => {
    const a = await connect('reload-a', '·')
    const b = await connect('reload-b', '·')
    a.send({ t: 'queue' })
    await a.next('queued')
    b.send({ t: 'queue' })
    const [roomA] = await Promise.all([a.next('roomState'), b.next('roomState')])
    await readyBoth(a, b)
    const [matchedA] = await Promise.all([a.next('matched'), b.next('matched')])

    // ·刷新页面"：同 playerId 重新连上，旧连接被踢
    const a2 = await TestClient.connect(wsUrl)
    live.push(a2)
    a2.send({ t: 'hello', playerId: 'reload-a', name: '·', version: PROTOCOL_VERSION })
    await a2.next('welcome')
    // bugv34e：刷新后服务端会自动把身份放回房间（`roomState`）——
    // 客户端就是靠它拿到 matchId 再去 sync 的。
    const backToRoom = await a2.next('roomState')
    expect(backToRoom.phase).toBe('playing')
    expect(backToRoom.matchId).toBe(matchedA.matchId)

    // 乙不应该收到 opponentLeft
    let gotLeft = false
    const watch = b.next('opponentLeft', 400).then(() => {
      gotLeft = true
    })
    await watch.catch(() => undefined)
    expect(gotLeft).toBe(false)

    // 甲的新连接用 sync 能接回局面，并继续落·
a2.send({ t: 'sync', matchId: matchedA.matchId })
    const state = await a2.next('state')
    expect(state.matchId).toBe(matchedA.matchId)
    expect(state.seat).toBe(matchedA.seat)

    const firstMover = matchedA.dice.first
    const mover = matchedA.seat === firstMover ? a2 : b
    const otherClient = mover === a2 ? b : a2
    mover.send({ t: 'move', matchId: matchedA.matchId, cell: 40 })
    // 新连接必须能收到**广播**（不只是 sync 的那一次快照）·    // 注意两个 next 必须挂在**不同**客户端上，否则同一条消息会被消费掉、第二个等待永远等不·
const [appliedMover, appliedOther] = await Promise.all([
      mover.next('applied'),
      otherClient.next('applied'),
    ])
    const appliedA = mover === a2 ? appliedMover : appliedOther
    const appliedB = mover === a2 ? appliedOther : appliedMover
    expect(appliedA.seq).toBe(1)
    expect(appliedB.seq).toBe(1)
    expect(appliedA.digest).toBe(appliedB.digest)

    await Promise.all([b.close(), a2.close()])
  }, 15000)
})

// ---------------------------------------------------------------------------
// bugv10 #11：角色技能联·// ---------------------------------------------------------------------------

/** 两端跑同一·core：按服务端的座位/角色造一个本地镜像引擎·*/
function mirrorEngine(first: PlayerIndex, characters: [CharacterId, CharacterId]): GameEngine {
  return new GameEngine({
    fixedFirstPlayer: first,
    skills: [skillsOfCharacter(characters[0]), skillsOfCharacter(characters[1])],
  })
}

/** 白盒：给服务端的权威引擎塞几·被某一方占·的魔力植物（技能消耗用）·*/
function seedPlants(matchId: string, owner: PlayerIndex, cells: number[], actionsTaken: number): void {
  const room = server.matches.get(matchId)
  expect(room).not.toBeNull()
  if (!room) return
  for (const cell of cells) room.engine.magic.set(cell, { cell, kind: 'grass', owner })
  room.engine.actionsTaken[owner] = actionsTaken
}

describe('角色技能联机（bugv10 #11·', () => {
  it('skill：未轮到 -> notYourTurn；冷却中 -> illegalMove，且不广播、不推进 seq', async () => {
    const pair = await matchPair('skill-reject-a', 'skill-reject-b')
    // 老客户端不带 character：按座位退回默认角·
expect(pair.characters).toEqual([DEFAULT_CHARACTERS[0], DEFAULT_CHARACTERS[1]])

    const first = pair.dice.first
    const firstClient = first === pair.seatA ? pair.a : pair.b
    const secondClient = first === pair.seatA ? pair.b : pair.a

    // 还没轮到·
secondClient.send({ t: 'skill', matchId: pair.matchId, slot: 0, cells: [], target: null })
    const notYourTurn = await secondClient.next('error')
    expect(notYourTurn.code).toBe('notYourTurn')
    expect(notYourTurn.reqType).toBe('skill')

    // 轮到了，但技能还在冷却（开局所有技能都处于冷却中）·引擎抛错 -> illegalMove
    firstClient.send({ t: 'skill', matchId: pair.matchId, slot: 0, cells: [], target: null })
    const illegal = await firstClient.next('error')
    expect(illegal.code).toBe('illegalMove')
    expect(illegal.reqType).toBe('skill')

    // 结构不合·-> badRequest（不会被当成引擎错误·
firstClient.socket.send(JSON.stringify({ t: 'skill', matchId: pair.matchId, slot: 0, cells: 'nope' }))
    expect((await firstClient.next('error')).code).toBe('badRequest')

    // 失败不推·seq / 不写 steps
    secondClient.send({ t: 'sync', matchId: pair.matchId })
    const state = await secondClient.next('state')
    expect(state.seq).toBe(0)
    expect(state.board.every((cell) => cell === 0)).toBe(true)

    await Promise.all([pair.a.close(), pair.b.close()])
  })

  it('skill 生效：双方收·applied(kind=skill)，digest 与本地引擎一致；state 带全部技能字·', async () => {
    // 两边都·deepseek：一技能固定是「大胃袋」（护盾），与先手是哪一侧无·
const pair = await matchPair('skill-ok-a', 'skill-ok-b', { a: 'deepseek', b: 'deepseek' })
    expect(pair.characters).toEqual(['deepseek', 'deepseek'])
    const first = pair.dice.first
    const firstClient = first === pair.seatA ? pair.a : pair.b
    const secondClient = first === pair.seatA ? pair.b : pair.a

    // deepseek 一技能「大胃袋」：cost 1 / cooldown 5，把冷却"·好再给一棵植·
const plantCell = 20
    seedPlants(pair.matchId, first, [plantCell], 5)

    const mirror = mirrorEngine(first, pair.characters)
    mirror.magic.set(plantCell, { cell: plantCell, kind: 'grass', owner: first })
    mirror.actionsTaken[first] = 5

    firstClient.send({ t: 'skill', matchId: pair.matchId, slot: 0, cells: [plantCell], target: null })
    const [appliedFirst, appliedSecond] = await Promise.all([
      firstClient.next('applied'),
      secondClient.next('applied'),
    ])

    expect(appliedFirst.kind).toBe('skill')
    expect(appliedFirst.seat).toBe(first)
    expect(appliedFirst.seq).toBe(1)
    expect(appliedFirst.slot).toBe(0)
    expect(appliedFirst.cells).toEqual([plantCell])
    expect(appliedFirst.target).toBeNull()
    expect(appliedFirst.cell).toBe(-1) // 不需要目标的技·
expect(appliedSecond.kind).toBe('skill')
    expect(appliedSecond.digest).toBe(appliedFirst.digest)

    // 与服务端同口径重算指·
mirror.useSkill(first, 0, [plantCell], null)
    expect(digestOfEngine(mirror)).toBe(appliedFirst.digest)

    // sync：state 必须带全部技能字段，·digest ·applied 一·
secondClient.send({ t: 'sync', matchId: pair.matchId })
    const state = await secondClient.next('state')
    expect(state.digest).toBe(appliedFirst.digest)
    expect(state.characters).toEqual(pair.characters)
    expect(state.shield[first]).toBe(1)
    expect(state.shield[other(first)]).toBe(0)
    expect(state.bonusActions).toEqual([0, 0])
    expect(state.actionsTaken[first]).toBe(5)
    expect(state.skillReadyAt[first][0]).toBe(10)
    expect(state.skillReadyAt[other(first)][0]).toBe(5)
    expect(state.lastPlacedBy).toEqual([null, null])
    expect(state.turnNo).toBe(0)
    expect(state.immuneUntil).toEqual([0, 0])
    expect(state.flames).toEqual([])
    expect(state.overlay).toEqual([])
    expect(state.magic).toEqual([]) // 植物被技能消耗掉·
    // 白盒：回放步骤带 skill + extra
    const room = server.matches.get(pair.matchId)
    expect(room?.steps).toHaveLength(1)
    const step = room?.steps[0]
    expect(step?.player).toBe(first)
    expect(step?.defense).toBe(false)
    expect(step?.match).toBe(false)
    expect(step?.skill).toEqual({ slot: 0, cells: [plantCell], target: null })
    expect(step?.extra?.shield[first]).toBe(1)
    expect(step?.extra?.turnNo).toBe(0)

    await Promise.all([pair.a.close(), pair.b.close()])
  })

  it('gtp 恶龙吐息：state.flames 非空、技能状态齐全，digest 与本地引擎一·', async () => {
    const a = await connect('fire-a', '·')
    const b = await connect('fire-b', '·')
    a.send({ t: 'queue', character: 'gtp' })
    await a.next('queued')
    b.send({ t: 'queue', character: 'gtp' })
    const [fireRoomA, fireRoomB] = await Promise.all([a.next('roomState'), b.next('roomState')])
    await readyBoth(a, b)
    const [matchedA, matchedB] = await Promise.all([a.next('matched'), b.next('matched')])
    const matchId = matchedA.matchId
    expect(fireRoomB.code).toBe(fireRoomA.code)
    expect(matchedA.characters).toEqual(['gtp', 'gtp'])
    expect(matchedB.characters).toEqual(['gtp', 'gtp'])

    const first = matchedA.dice.first
    const moverClient = first === matchedA.seat ? a : b
    const otherClient = moverClient === a ? b : a

    // gtp 二技能「恶龙吐息」：cost 2 / cooldown 8 / targetsCell
    // bugv11 #6：首次释放免费，这里测"收费"的那一次，所以先把已用次数补上
    const cells = [30, 31]
    seedPlants(matchId, first, cells, 12)
    {
      const room = server.matches.get(matchId)
      if (room) room.engine.skillCasts[first][1] = 1
    }

    const mirror = mirrorEngine(first, ['gtp', 'gtp'])
    for (const cell of cells) mirror.magic.set(cell, { cell, kind: 'grass', owner: first })
    mirror.actionsTaken[first] = 12
    mirror.skillCasts[first][1] = 1

    moverClient.send({ t: 'skill', matchId, slot: 1, cells, target: 40 })
    const [appliedMover, appliedOther] = await Promise.all([
      moverClient.next('applied'),
      otherClient.next('applied'),
    ])

    expect(appliedMover.kind).toBe('skill')
    expect(appliedMover.slot).toBe(1)
    expect(appliedMover.cells).toEqual(cells)
    expect(appliedMover.target).toBe(40)
    expect(appliedMover.cell).toBe(40)
    expect(appliedMover.current).toBe(first) // bugv32：恶龙吐息不再结束回合
    expect(appliedOther.digest).toBe(appliedMover.digest)

    mirror.useSkill(first, 1, cells, 40)
    expect(digestOfEngine(mirror)).toBe(appliedMover.digest)

    moverClient.send({ t: 'sync', matchId })
    const state = await moverClient.next('state')
    expect(state.digest).toBe(appliedMover.digest)
    expect(state.characters).toEqual(['gtp', 'gtp'])
    expect(state.flames.length).toBeGreaterThan(0)
    expect(state.flames).toContainEqual([40, 12])
    // 烈焰现在按"半回合"存：6 回合 → 12；每次换手 -1（bugv10 追加 #7）
    expect(state.flames.every(([, left]) => left === 12)).toBe(true)
    // 烈焰格子与镜像引擎逐项一致（服务端按 cell 升序下发）
    expect(state.flames).toEqual(
      [...mirror.flames.entries()].map(([cell, left]): [number, number] => [cell, left]).sort((x, y) => x[0] - y[0]),
    )
    // bugv32：恶龙吐息不结束回合 → turnNo 不变、current 还是施法者
    expect(state.turnNo).toBe(0)
    expect(state.current).toBe(first)
    expect(state.magic).toEqual([])
    expect(state.overlay).toEqual([])
    expect(state.skillReadyAt[first][1]).toBe(20) // bugv33：冷却 6 → 12 → 8
    expect(state.skillCasts[first][1]).toBe(2)
    expect(state.shield).toEqual([0, 0])
    expect(state.immuneUntil).toEqual([0, 0])

    await Promise.all([a.close(), b.close()])
  })

  it('房间：createRoom / joinRoom 也能选角色，非法值按座位退回默·', async () => {
    const host = await connect('char-host', '房主')
    host.send({ t: 'createRoom', character: 'glm' })
    const created = await host.next('roomState')

    const guest = await connect('char-guest', '客人')
    guest.send({ t: 'joinRoom', code: created.code, character: 'not-a-character' })
    const [hostRoom, guestRoom] = await Promise.all([host.next('roomState'), guest.next('roomState')])
    expect(hostRoom.members.find((m) => m.playerId === 'char-host')?.character).toBe('glm')
    // 非法角色按"加入顺序"退回默认角色（第二人 = DEFAULT_CHARACTERS[1]）
    expect(guestRoom.members.find((m) => m.playerId === 'char-guest')?.character).toBe(DEFAULT_CHARACTERS[1])

    await readyBoth(host, guest)
    const [matchedHost, matchedGuest] = await Promise.all([host.next('matched'), guest.next('matched')])
    expect(matchedHost.characters).toEqual(['glm', DEFAULT_CHARACTERS[1]])
    expect(matchedGuest.characters).toEqual(matchedHost.characters)

    // 非法值不会报错，只是退回默认角色；技能表也确实按角色派生
    const room = server.matches.get(matchedHost.matchId)
    expect(room?.engine.skills[0].map((spec) => spec.id)).toEqual(['gl-power', 'gl-sabotage'])
    expect(room?.engine.skills[1].map((spec) => spec.id)).toEqual(
      skillsOfCharacter(DEFAULT_CHARACTERS[1]).map((spec) => spec.id),
    )
    // 房间设置也随开局一起交给了对局引擎（血量上限 12 = 默认）
    expect(room?.settings.hpLimit).toBe(12)

    await Promise.all([host.close(), guest.close()])
  })

  // -------------------------------------------------------------------------
  // bugv34i：联机需要登录（账号 / 密码 / 长期令牌）
  // -------------------------------------------------------------------------

  it('未登录不能匹配 / 建房 / 加入房间（notLoggedIn）', async () => {
    const client = await TestClient.connect(wsUrl)
    live.push(client)
    client.send({ t: 'hello', playerId: 'anon-1', name: '匿名', version: PROTOCOL_VERSION })
    expect((await client.next('welcome')).authenticated).toBe(false)

    client.send({ t: 'queue' })
    const queueError = await client.next('error')
    expect(queueError.code).toBe('notLoggedIn')
    expect(queueError.reqType).toBe('queue')

    client.send({ t: 'createRoom' })
    expect((await client.next('error')).code).toBe('notLoggedIn')

    client.send({ t: 'joinRoom', code: 'ABCDEF' })
    expect((await client.next('error')).code).toBe('notLoggedIn')

    await client.close()
  })

  it('注册 / 登录：不存在 -> userNotFound；重复注册 -> usernameTaken；密码错 -> wrongPassword；令牌可恢复登录态', async () => {
    const client = await TestClient.connect(wsUrl)
    live.push(client)
    client.send({ t: 'hello', playerId: 'auth-user', name: '账本', version: PROTOCOL_VERSION })
    await client.next('welcome')

    // 账号不存在 → 前端据此切到"注册"
    client.send({ t: 'login', username: 'nobody_here', password: 'whatever' })
    expect((await client.next('error')).code).toBe('userNotFound')

    // 注册成功（账号归一化为小写、昵称原样保留）
    client.send({ t: 'register', username: 'Alpha_1', password: 'secret-1', nickname: '阿尔法' })
    const created = await client.next('loggedIn')
    expect(created.username).toBe('alpha_1')
    expect(created.nickname).toBe('阿尔法')
    expect(created.token.length).toBeGreaterThan(8)

    // 重复注册（大小写不同也算同一个账号）
    const other = await TestClient.connect(wsUrl)
    live.push(other)
    other.send({ t: 'hello', playerId: 'auth-user-2', version: PROTOCOL_VERSION })
    await other.next('welcome')
    other.send({ t: 'register', username: 'ALPHA_1', password: 'secret-2', nickname: '贝塔' })
    expect((await other.next('error')).code).toBe('usernameTaken')

    // 账号格式不合法
    other.send({ t: 'register', username: 'a!', password: 'secret-1', nickname: '小名' })
    expect((await other.next('error')).code).toBe('badUsername')

    // 密码错误
    other.send({ t: 'login', username: 'alpha_1', password: 'wrong' })
    expect((await other.next('error')).code).toBe('wrongPassword')

    // 正确密码登录 → 拿到新令牌
    other.send({ t: 'login', username: 'ALPHA_1', password: 'secret-1' })
    const relogin = await other.next('loggedIn')
    expect(relogin.username).toBe('alpha_1')

    // 换一条连接带上令牌 → 自动恢复登录态（"不退出就一直登录"）
    const restored = await TestClient.connect(wsUrl)
    live.push(restored)
    restored.send({ t: 'hello', playerId: 'auth-user-3', version: PROTOCOL_VERSION, token: relogin.token })
    const welcome = await restored.next('welcome')
    expect(welcome.authenticated).toBe(true)
    expect(welcome.username).toBe('alpha_1')
    expect(welcome.nickname).toBe('阿尔法')

    // 退出登录后令牌作废
    restored.send({ t: 'logout' })
    await restored.next('loggedOut')
    const stale = await TestClient.connect(wsUrl)
    live.push(stale)
    stale.send({ t: 'hello', playerId: 'auth-user-4', version: PROTOCOL_VERSION, token: relogin.token })
    expect((await stale.next('welcome')).authenticated).toBe(false)

    await Promise.all([client.close(), other.close(), restored.close(), stale.close()])
  })

  it('房间准备：只准备一方 / 取消准备都不会开局，双方都准备才自动开局', async () => {
    const a = await connect('ready-a', '甲')
    const b = await connect('ready-b', '乙')
    a.send({ t: 'queue' })
    await a.next('queued')
    b.send({ t: 'queue' })
    await Promise.all([a.next('roomState'), b.next('roomState')])

    a.send({ t: 'roomReady', ready: true })
    const [onlyA] = await Promise.all([a.next('roomState'), b.next('roomState')])
    expect(onlyA.canStart).toBe(false)
    expect(onlyA.members.find((m) => m.playerId === 'ready-a')?.ready).toBe(true)
    expect(onlyA.members.find((m) => m.playerId === 'ready-b')?.ready).toBe(false)

    // 取消准备：依然是"没准备好"
    a.send({ t: 'roomReady', ready: false })
    const [canceled] = await Promise.all([a.next('roomState'), b.next('roomState')])
    expect(canceled.canStart).toBe(false)

    // 只有乙准备 → 仍然不开局
    b.send({ t: 'roomReady', ready: true })
    const [half] = await Promise.all([a.next('roomState'), b.next('roomState')])
    expect(half.canStart).toBe(false)

    // 甲也准备 → 自动开局
    a.send({ t: 'roomReady', ready: true })
    const [matchedA, matchedB] = await Promise.all([a.next('matched'), b.next('matched')])
    expect(matchedA.matchId).toBe(matchedB.matchId)
    expect([matchedA.seat, matchedB.seat].sort()).toEqual([0, 1])
    // 开局瞬间的两份 roomState（"双方已准备" + "对局中"）一并消费掉
    await Promise.all([a.next('roomState'), b.next('roomState')])
    await Promise.all([a.next('roomState'), b.next('roomState')])

    // 对局结束后回到大厅，准备状态必须被清掉（否则会立刻又开一局）
    const loser = matchedA.seat === matchedA.dice.first ? a : b
    loser.send({ t: 'resign', matchId: matchedA.matchId })
    const [backToLobby] = await Promise.all([a.next('roomState'), b.next('roomState')])
    expect(backToLobby.phase).toBe('lobby')
    expect(backToLobby.members.every((m) => m.ready === false)).toBe(true)
    expect(backToLobby.canStart).toBe(false)

    await Promise.all([a.close(), b.close()])
  }, 15000)

  // -------------------------------------------------------------------------
  // bugv34k：回放**挂在账号上**（换设备也查得到），不是挂在浏览器本地 id 上
  // -------------------------------------------------------------------------

  it('回放按账号过滤：?account= 能查到本账号的对局，查不到别人的', async () => {
    const accountA = `ra_${Date.now().toString(36)}a`
    const accountB = `rb_${Date.now().toString(36)}b`
    const a = await connect('replay-acct-a', '甲', accountA)
    const b = await connect('replay-acct-b', '乙', accountB)
    a.send({ t: 'queue' })
    await a.next('queued')
    b.send({ t: 'queue' })
    await Promise.all([a.next('roomState'), b.next('roomState')])
    await readyBoth(a, b)
    const [matched] = await Promise.all([a.next('matched'), b.next('matched')])

    // 认输也会落库回放（省得打一整局）
    a.send({ t: 'resign', matchId: matched.matchId })
    await Promise.all([a.next('gameOver'), b.next('gameOver')])
    // 等落库
    await new Promise((resolve) => setTimeout(resolve, 200))

    const listFor = async (account: string): Promise<ReplayDoc[]> => {
      const res = await fetch(`${server.url}/api/replays?account=${encodeURIComponent(account)}&limit=10`)
      const body = (await res.json()) as { account: string | null; items: ReplayDoc[] }
      expect(body.account).toBe(account)
      return body.items
    }

    const mine = await listFor(accountA)
    expect(mine.length).toBeGreaterThanOrEqual(1)
    expect(mine[0].matchId).toBe(matched.matchId)
    // 落库文档里要带 accounts（两个账号都在）
    expect(mine[0].accounts).toEqual(expect.arrayContaining([accountA, accountB]))
    // 对方的账号也能查到同一局（双方都算"参与过"）
    const theirs = await listFor(accountB)
    expect(theirs.some((doc) => doc.matchId === matched.matchId)).toBe(true)
    // 没打过的账号查不到
    expect(await listFor(`nobody_${Date.now().toString(36)}`)).toHaveLength(0)

    // 单局回放里也能看到账号
    const detail = (await (await fetch(`${server.url}/api/replays/${matched.matchId}`)).json()) as {
      replay: ReplayDoc
    }
    expect(detail.replay.accounts).toEqual(expect.arrayContaining([accountA, accountB]))

    await Promise.all([a.close(), b.close()])
  }, 20000)
})
