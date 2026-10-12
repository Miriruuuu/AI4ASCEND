/**
 * 端到端冒烟：内存模式起真服务 -> 两个真实 WS 客户端打完一整局 -> 校验回放 REST。
 *
 * 运行：pnpm smoke（或 npx tsx scripts/smoke.ts）
 *
 * 局面脚本（与先手/后手角色绑定，与座位无关）：
 *   先手 0,1,2,3 连成 4 连珠 -> 触发攻击、棋子移出棋盘并留下高光；
 *   后手 72,73,74,75 同时形成 4 连珠 -> 防守方也成线，双方抵消（4 vs 4，无伤害）。
 * 之后两侧改用贪心策略（能成线就成线，防守优先削弱）一直打到有人血量归零。
 */
import { WebSocket } from 'ws'
import { startServer, type RunningServer } from '../src/index'
import { skillsOfCharacter, type CharacterId } from '../src/core/characters'
import { GameEngine } from '../src/core/engine'
import { hasLine } from '../src/core/lines'
import { Rng } from '../src/core/random'
import { cellOf, other, type PlayerIndex } from '../src/core/types'
import { digestOfEngine } from '../src/digest'
import { setLogLevel } from '../src/logger'
import {
  PROTOCOL_VERSION,
  type AppliedMessage,
  type ClientMessage,
  type ErrorMessage,
  type GameOverMessage,
  type ServerMessage,
} from '../src/protocol'
import type { ReplayDoc } from '../src/db'

const SCRIPT: Array<{ role: 'first' | 'second'; cell: number }> = [
  { role: 'first', cell: 0 },
  { role: 'second', cell: 72 },
  { role: 'first', cell: 1 },
  { role: 'second', cell: 73 },
  { role: 'first', cell: 2 },
  { role: 'second', cell: 74 },
  { role: 'first', cell: 3 },
  { role: 'second', cell: 75 },
]

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`断言失败：${message}`)
}

class SmokeClient {
  private readonly inbox: ServerMessage[] = []
  private readonly consumed = new Set<number>()

  private constructor(
    readonly playerId: string,
    private readonly socket: WebSocket,
  ) {}

  static async connect(url: string, playerId: string, name: string): Promise<SmokeClient> {
    const socket = new WebSocket(url)
    const client = new SmokeClient(playerId, socket)
    socket.on('message', (raw: unknown) => {
      client.inbox.push(JSON.parse(String(raw)) as ServerMessage)
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', (error: Error) => reject(error))
    })
    client.send({ t: 'hello', playerId, name, version: PROTOCOL_VERSION })
    const welcome = await client.next('welcome')
    assert(welcome.playerId === playerId, `welcome.playerId 应为 ${playerId}`)
    // bugv34i：联机需要登录 —— 冒烟自己注册一个账号
    client.send({
      t: 'register',
      username: `smoke_${playerId.replace(/[^a-zA-Z0-9]/g, '_')}`,
      password: 'smoke-pass',
      nickname: name,
    })
    const logged = await client.next('loggedIn')
    assert(logged.username.length > 0, '注册后应拿到账号')
    return client
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message))
  }

  /** 轮询等待第一条满足条件的未消费消息（单条件轮询，避免多个等待者互相抢消息）。 */
  waitFor<T extends ServerMessage>(predicate: (message: ServerMessage) => message is T, timeoutMs?: number): Promise<T>
  waitFor(predicate: (message: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>
  async waitFor(predicate: (message: ServerMessage) => boolean, timeoutMs = 10000): Promise<ServerMessage> {
    const indexOf = (): number => {
      for (let i = 0; i < this.inbox.length; i += 1) {
        if (!this.consumed.has(i) && predicate(this.inbox[i])) return i
      }
      return -1
    }
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = indexOf()
      if (found >= 0) {
        this.consumed.add(found)
        return this.inbox[found]
      }
      if (Date.now() > deadline) {
        throw new Error(`等待消息超时（已收到：${this.inbox.map((m) => m.t).join(', ') || '空'}）`)
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  async next<T extends ServerMessage['t']>(type: T, timeoutMs = 10000): Promise<Extract<ServerMessage, { t: T }>> {
    const message = await this.waitFor((candidate) => candidate.t === type, timeoutMs)
    return message as Extract<ServerMessage, { t: T }>
  }

  close(): void {
    this.socket.terminate()
  }
}

function chooseMove(engine: GameEngine, rng: Rng): number {
  const me = engine.current
  const empties = engine.emptyCells()
  if (empties.length === 0) throw new Error('棋盘已满但引擎没有结束')
  if (engine.phase === 'awaitingDefense') {
    const highlights = [...engine.highlights.keys()].filter((cell) => engine.board[cell] === 0).sort((a, b) => a - b)
    if (highlights.length > 0) return highlights[0]
    return rng.pick(empties)
  }
  for (const cell of empties) {
    const probe = engine.board.slice()
    probe[cell] = cellOf(me)
    if (hasLine(probe, me)) return cell
  }
  return rng.pick(empties)
}

interface DriveStats {
  applied: number
  defends: number
  clashes: number
}

async function drive(options: {
  client: SmokeClient
  matchId: string
  seat: PlayerIndex
  first: PlayerIndex
  seed: number
  /** 双方角色（bugv10 #11）：本地镜像必须与服务端同一份技能表，否则 digest 会漂移。 */
  characters: [CharacterId, CharacterId]
  stats: DriveStats
}): Promise<{ winner: number | null; result: unknown }> {
  const { client, matchId, seat, first, stats } = options
  const engine = new GameEngine({
    fixedFirstPlayer: first,
    skills: [skillsOfCharacter(options.characters[0]), skillsOfCharacter(options.characters[1])],
  })
  const rng = new Rng(options.seed)
  let applied = 0

  const moveFor = (index: number): number => {
    const step = SCRIPT[index]
    if (step) {
      const roleSeat = step.role === 'first' ? first : other(first)
      if (roleSeat === seat) return step.cell
    }
    return chooseMove(engine, rng)
  }

  const sendIfMyTurn = (index: number): void => {
    if (engine.isOver || engine.current !== seat) return
    if (engine.phase !== 'playing' && engine.phase !== 'awaitingDefense') return
    client.send({ t: 'move', matchId, cell: moveFor(index) })
  }

  if (engine.current === seat) sendIfMyTurn(0)

  for (;;) {
    const message = await client.waitFor(
      (candidate): candidate is AppliedMessage | GameOverMessage | ErrorMessage =>
        candidate.t === 'applied' || candidate.t === 'gameOver' || candidate.t === 'error',
    )
    if (message.t === 'error') throw new Error(`服务端报错 ${message.code}：${message.message}`)
    if (message.t === 'gameOver') {
      assert(message.matchId === matchId, 'gameOver.matchId 应一致')
      return { winner: message.result.winner, result: message.result }
    }

    assert(message.seq === applied + 1, `seq 应连续：期望 ${applied + 1}，收到 ${message.seq}`)
    if (message.kind === 'defend') engine.defend(message.cell)
    else engine.commit(message.cell)
    applied += 1
    stats.applied = applied
    assert(digestOfEngine(engine) === message.digest, `digest 漂移（第 ${applied} 步）`)
    if (message.kind === 'defend') {
      stats.defends += 1
      if (engine.attack?.mode === 'canceled') stats.clashes += 1
    }
    if (message.phase === 'gameOver') continue
    sendIfMyTurn(applied)
  }
}

async function main(): Promise<void> {
  setLogLevel('warn')
  console.log('[smoke] 启动内存模式服务（随机端口）…')
  const server: RunningServer = await startServer({
    port: 0,
    dbMode: 'memory',
    effectiveDbMode: 'memory',
    mongodbUri: null,
    serveFrontend: false,
    logLevel: 'warn',
  })
  console.log(`[smoke] 服务就绪：${server.url}（db=${server.repo.kind}）`)

  const wsUrl = `ws://127.0.0.1:${server.port}/ws`
  const a = await SmokeClient.connect(wsUrl, 'smoke-a', '赤方')
  const b = await SmokeClient.connect(wsUrl, 'smoke-b', '青方')

  try {
    a.send({ t: 'queue' })
    await a.next('queued')
    b.send({ t: 'queue' })
    // bugv34e：匹配成功先进**房间**（随机一方为房主），房主点「开始游戏」才开局
    const [roomA, roomB] = await Promise.all([a.next('roomState'), b.next('roomState')])
    assert(roomA.code === roomB.code, '双方房间号应一致')
    assert(roomA.members.length === 2, '房间里应有两名成员')
    console.log(`[smoke] 匹配成功进入房间 ${roomA.code}`)
    // bugv34i：双方都点「准备」→ 服务端自动开局
    a.send({ t: 'roomReady', ready: true })
    b.send({ t: 'roomReady', ready: true })
    const [matchedA, matchedB] = await Promise.all([a.next('matched'), b.next('matched')])
    assert(matchedA.matchId === matchedB.matchId, '双方 matchId 应一致')
    assert(matchedA.seat !== matchedB.seat, '双方座位应相反')
    assert(typeof matchedA.settings?.hpLimit === 'number', '开局必须带上房间设置')
    assert(
      matchedA.dice.rolls[0] === matchedB.dice.rolls[0] &&
        matchedA.dice.rolls[1] === matchedB.dice.rolls[1] &&
        matchedA.dice.first === matchedB.dice.first,
      '双方骰子必须一致',
    )
    console.log(
      `[smoke] 开局 matchId=${matchedA.matchId} 骰子=${matchedA.dice.rolls.join(':')} 先手座位=${matchedA.dice.first} 血量上限=${matchedA.settings.hpLimit}`,
    )

    const stats: DriveStats = { applied: 0, defends: 0, clashes: 0 }
    const otherStats: DriveStats = { applied: 0, defends: 0, clashes: 0 }
    const [resultA] = await Promise.all([
      drive({
        client: a,
        matchId: matchedA.matchId,
        // bugv34e：房主随机 → 座位由服务端分配，不能假设 a 是座位 0
        seat: matchedA.seat,
        first: matchedA.dice.first,
        seed: 424242,
        characters: matchedA.characters,
        stats,
      }),
      drive({
        client: b,
        matchId: matchedA.matchId,
        seat: matchedB.seat,
        first: matchedA.dice.first,
        seed: 535353,
        characters: matchedA.characters,
        stats: otherStats,
      }),
    ])
    assert(stats.applied === otherStats.applied, '两端步数应一致')
    assert(stats.defends >= 1, '本局应至少出现一次攻击阶段的防守落子')
    assert(stats.clashes >= 1, '构造局面应至少出现一次双方抵消')
    console.log(`[smoke] 对局结束：胜者=${resultA.winner ?? '平局'} 共 ${stats.applied} 步（防守 ${stats.defends} 步，抵消 ${stats.clashes} 次）`)

    // 终局局面
    a.send({ t: 'sync', matchId: matchedA.matchId })
    const finalState = await a.next('state')
    assert(finalState.phase === 'gameOver', 'sync 应返回 gameOver 阶段')
    assert(finalState.seq === stats.applied, 'sync.seq 应等于总步数')

    // 回放 REST
    const listResponse = await fetch(`${server.url}/api/replays?playerId=smoke-a&limit=20`)
    const list = (await listResponse.json()) as { ok: boolean; count: number; items: ReplayDoc[] }
    assert(list.ok && list.count === 1, `应查到 1 局回放，实际 ${list.count}`)
    const replay = list.items[0]
    assert(replay.matchId === matchedA.matchId, 'replay.matchId 应一致')
    assert(replay.steps.length === stats.applied, `steps 数量应为 ${stats.applied}，实际 ${replay.steps.length}`)
    assert(replay.result.winner === resultA.winner, '回放胜负应与 gameOver 一致')
    assert(replay.steps[6]?.match === true, '第 7 步应为"成线"的普通落子')
    assert(replay.steps[7]?.defense === true, '第 8 步应为防守落子')
    assert(replay.steps.every((step) => step.board.length === 81), '每步快照都应是 81 格棋盘')
    console.log(
      `[smoke] 回放已落库：id=${replay._id} steps=${replay.steps.length} result=${JSON.stringify(replay.result)} 用时=${replay.durationMs}ms`,
    )

    const detailResponse = await fetch(`${server.url}/api/replays/${matchedA.matchId}`)
    const detail = (await detailResponse.json()) as { ok: boolean; replay: ReplayDoc }
    assert(detail.ok && detail.replay.steps.length === stats.applied, '单局回放接口应返回同样的 steps')

    const health = (await (await fetch(`${server.url}/api/health`)).json()) as { ok: boolean; db: string; version: number }
    assert(health.ok && health.db === 'memory' && health.version === PROTOCOL_VERSION, '健康检查应正常')

    const statsResponse = (await (await fetch(`${server.url}/api/stats`)).json()) as {
      ok: boolean
      replays: { replays: number; players: number }
    }
    assert(statsResponse.ok && statsResponse.replays.replays >= 1, '统计接口应至少有一局回放')

    console.log(`[smoke] REST 校验通过：/api/health /api/replays /api/replays/:id /api/stats`)
    console.log('[smoke] ✅ 端到端冒烟全部通过')
  } finally {
    a.close()
    b.close()
    await server.close()
  }
}

main().catch((error: unknown) => {
  console.error('[smoke] ❌ 失败：', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
