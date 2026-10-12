/**
 * 服务端裁决与 steps 记录的单测（不涉及网络）· */
import { describe, expect, it } from 'vitest'
import { MatchManager, MatchRoom, resolveCharacters, type MatchPlayer } from '../src/match'
import type { Participant } from '../src/matching'
import { MemoryRepository, type ReplayDoc } from '../src/db'
import { digestOfEngine } from '../src/digest'
import { DEFAULT_CHARACTERS, skillsOfCharacter, type CharacterId } from '../src/core/characters'
import { INITIAL_HP, other, type Board, type PlayerIndex } from '../src/core/types'
import type { OpponentLeftMessage, ServerMessage } from '../src/protocol'

class FakePlayer implements Participant {
  readonly inbox: ServerMessage[] = []
  character?: CharacterId

  constructor(
    readonly playerId: string,
    public name: string,
  ) {}

  send(message: ServerMessage): void {
    this.inbox.push(message)
  }

  /** 取最后一条某类型的消息·*/
  last<T extends ServerMessage['t']>(type: T): Extract<ServerMessage, { t: T }> | null {
    for (let i = this.inbox.length - 1; i >= 0; i -= 1) {
      const message = this.inbox[i]
      if (message.t === type) return message as Extract<ServerMessage, { t: T }>
    }
    return null
  }

  clear(): void {
    this.inbox.length = 0
  }
}

function emptyBoard(): Board {
  return new Array<number>(81).fill(0) as Board
}

/** 造棋盘：`{ cellIndex: 归属格·}`·*/
function boardWith(cells: Record<number, 1 | 2>): Board {
  const board = emptyBoard()
  for (const [index, value] of Object.entries(cells)) board[Number(index)] = value
  return board
}

function makeRoom(characters?: readonly string[]): { room: MatchRoom; a: FakePlayer; b: FakePlayer } {
  const a = new FakePlayer('player-a', '赤方')
  const b = new FakePlayer('player-b', '青方')
  const room = new MatchRoom({ host: a, guest: b, seed: 12345, characters })
  return { room, a, b }
}

function seatOfFirst(room: MatchRoom): PlayerIndex {
  return room.dice.first
}

function playerOfSeat(room: MatchRoom, seat: PlayerIndex): MatchPlayer {
  const found = room.players.find((player) => player.seat === seat)
  if (!found) throw new Error(`没有座位 ${seat} 的玩家`)
  return found
}

describe('MatchRoom 开局', () => {
  it('服务端掷一次骰子，两端拿到同一·dice 与相反座·', () => {
    const { room, a, b } = makeRoom()

    expect(room.dice.rolls.length).toBe(2)
    expect(room.dice.rolls[0]).toBeGreaterThanOrEqual(1)
    expect(room.dice.rolls[1]).toBeLessThanOrEqual(6)
    expect([0, 1]).toContain(room.dice.first)
    expect(room.engine.phase).toBe('playing')
    expect(room.engine.current).toBe(room.dice.first)
    expect(room.engine.firstPlayer).toBe(room.dice.first)

    const matchedA = room.matchedMessageFor(room.players[0])
    const matchedB = room.matchedMessageFor(room.players[1])
    expect(matchedA.seat).toBe(0)
    expect(matchedB.seat).toBe(1)
    expect(matchedA.opponent).toBe('青方')
    expect(matchedB.opponent).toBe('赤方')
    expect(matchedA.dice).toEqual(matchedB.dice)
    expect(matchedA.matchId).toBe(room.id)
    expect(matchedA.code).toBeNull()

    // 构造时不发消息，由上层广播
    expect(a.inbox).toHaveLength(0)
    expect(b.inbox).toHaveLength(0)
  })

  it('sync 返回完整局面，highlights 是数组且 digest 与本地引擎一·', () => {
    const { room } = makeRoom()
    const first = seatOfFirst(room)
    const firstPlayer = playerOfSeat(room, first)

    const outcome = room.applyMove(firstPlayer.playerId, 40)
    expect(outcome.ok).toBe(true)
    const state = room.stateFor(firstPlayer.playerId)
    expect(state.t).toBe('state')
    expect(state.seat).toBe(first)
    expect(state.board).toHaveLength(81)
    expect(state.hp).toEqual([INITIAL_HP, INITIAL_HP])
    expect(Array.isArray(state.highlights)).toBe(true)
    expect(state.digest).toBe(digestOfEngine(room.engine))
    expect(state.phase).toBe('playing')
    expect(state.current).toBe(other(first))
  })
})

describe('MatchRoom 裁决', () => {
  it('未轮·/ 越界 / 已有棋子 一律拒·', () => {
    const { room } = makeRoom()
    const first = seatOfFirst(room)
    const second = other(first)
    const secondPlayer = playerOfSeat(room, second)

    const notYourTurn = room.applyMove(secondPlayer.playerId, 0)
    expect(notYourTurn.ok).toBe(false)
    if (!notYourTurn.ok) expect(notYourTurn.code).toBe('notYourTurn')

    const outsider = room.applyMove('someone-else', 0)
    expect(outsider.ok).toBe(false)
    if (!outsider.ok) expect(outsider.code).toBe('notInMatch')

    const firstPlayer = playerOfSeat(room, first)
    const outOfRange = room.applyMove(firstPlayer.playerId, 999)
    expect(outOfRange.ok).toBe(false)
    if (!outOfRange.ok) expect(outOfRange.code).toBe('illegalMove')

    const negative = room.applyMove(firstPlayer.playerId, -1)
    expect(negative.ok).toBe(false)
    if (!negative.ok) expect(negative.code).toBe('illegalMove')

    expect(room.applyMove(firstPlayer.playerId, 7).ok).toBe(true)

    // 现在轮到 second，但 7 已被占用
    const occupied = room.applyMove(secondPlayer.playerId, 7)
    expect(occupied.ok).toBe(false)
    if (!occupied.ok) expect(occupied.code).toBe('illegalMove')

    // 落子失败不应污染 seq / steps
    expect(room.seq).toBe(1)
    expect(room.steps).toHaveLength(1)
  })

  it('普通落子：seq 自增、applied ·digest ·result:null、step 快照正确', () => {
    const { room } = makeRoom()
    const first = seatOfFirst(room)
    const firstPlayer = playerOfSeat(room, first)

    const outcome = room.applyMove(firstPlayer.playerId, 40)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.applied.seq).toBe(1)
    expect(outcome.applied.seat).toBe(first)
    expect(outcome.applied.kind).toBe('place')
    expect(outcome.applied.cell).toBe(40)
    expect(outcome.applied.result).toBeNull()
    expect(outcome.applied.digest).toBe(digestOfEngine(room.engine))

    const step = room.steps[0]
    expect(step.player).toBe(first)
    expect(step.cell).toBe(40)
    expect(step.defense).toBe(false)
    expect(step.match).toBe(false)
    expect(step.board[40]).toBe(first + 1)
    expect(step.hp).toEqual([INITIAL_HP, INITIAL_HP])
  })

  it('成线 -> 攻击 -> 防守方也成线 -> 双方抵消（无伤害·', () => {
    const { room } = makeRoom()
    // 座位 1 ·9,10,11 有三连；座位 0 ·36,37,38 有三·
room.engine.loadScenario(boardWith({ 9: 2, 10: 2, 11: 2, 36: 1, 37: 1, 38: 1 }), {
      hp: [6, 6],
      phase: 'playing',
      current: 1,
      firstPlayer: 1,
    })

    const attack = room.applyMove('player-b', 12)
    expect(attack.ok).toBe(true)
    if (!attack.ok) return
    expect(attack.applied.kind).toBe('place')
    expect(attack.applied.phase).toBe('awaitingDefense')
    expect(attack.applied.current).toBe(0)
    // 攻击方连珠棋子被移除 + 留下 4 个高·
expect(room.engine.highlights.size).toBe(4)
    expect(room.engine.highlightOwner).toBe(1)
    expect(room.steps[0].match).toBe(true)
    for (const cell of [9, 10, 11, 12]) expect(room.engine.board[cell]).toBe(0)

    const defense = room.applyMove('player-a', 39)
    expect(defense.ok).toBe(true)
    if (!defense.ok) return
    expect(defense.applied.kind).toBe('defend')
    expect(defense.applied.phase).toBe('playing')
    expect(defense.applied.result).toBeNull()
    expect(defense.applied.hp).toEqual([6, 6])
    // 规则 11.2：下一回合由原攻击方开·
expect(defense.applied.current).toBe(1)

    const snapshot = room.engine.attack
    expect(snapshot?.baseDamage).toBe(4)
    expect(snapshot?.weakness).toBe(0)
    expect(snapshot?.finalAttack).toBe(4)
    expect(snapshot?.defenderAttack).toBe(4)
    expect(snapshot?.mode).toBe('canceled')
    expect(snapshot?.diff).toBe(0)

    // 防守方连珠棋子同样被移除
    for (const cell of [36, 37, 38, 39]) expect(room.engine.board[cell]).toBe(0)

    const step = room.steps[1]
    expect(step.player).toBe(0)
    expect(step.cell).toBe(39)
    expect(step.defense).toBe(true)
    expect(step.match).toBe(true)
    expect(step.hp).toEqual([6, 6])
    expect(step.board[39]).toBe(0)
    expect(step.board.filter((cell) => cell !== 0)).toHaveLength(0)
  })

  it('防守方在高光处落子会削弱攻击·', () => {
    const { room } = makeRoom()
    room.engine.loadScenario(boardWith({ 0: 1, 1: 1, 2: 1 }), {
      hp: [6, 6],
      phase: 'playing',
      current: 0,
      firstPlayer: 0,
    })

    expect(room.applyMove('player-a', 3).ok).toBe(true)
    // 座位 1 下在座位 0 的高光位·0（属·1 条连·-> 削弱 1·
const defense = room.applyMove('player-b', 0)
    expect(defense.ok).toBe(true)
    if (!defense.ok) return
    const snapshot = room.engine.attack
    expect(snapshot?.baseDamage).toBe(4)
    expect(snapshot?.weakness).toBe(1)
    expect(snapshot?.finalAttack).toBe(3)
    expect(snapshot?.mode).toBe('defenderDamaged')
    expect(room.engine.hp).toEqual([6, 3])
    expect(room.steps[1].board[0]).toBe(2)
    expect(room.steps[1].hp).toEqual([6, 3])
  })

  it('血量归零即结束：applied ·result，随后拒绝继续落·', () => {
    const { room } = makeRoom()
    room.engine.loadScenario(boardWith({ 0: 1, 1: 1, 2: 1 }), {
      hp: [6, 3],
      phase: 'playing',
      current: 0,
      firstPlayer: 0,
    })

    expect(room.applyMove('player-a', 3).ok).toBe(true)
    const finish = room.applyMove('player-b', 80)
    expect(finish.ok).toBe(true)
    if (!finish.ok) return

    expect(finish.applied.phase).toBe('gameOver')
    expect(finish.applied.result).toEqual({ winner: 0, reason: 'hp', hp: [6, -1] })
    expect(finish.gameOver).not.toBeNull()
    expect(finish.gameOver?.t).toBe('gameOver')
    expect(finish.gameOver?.replayId).toBe(room.id)
    expect(finish.replay).not.toBeNull()

    const replay = finish.replay as ReplayDoc
    expect(replay._id).toBe(room.id)
    expect(replay.matchId).toBe(room.id)
    expect(replay.mode).toBe('online')
    expect(replay.playerIds).toEqual(['player-a', 'player-b'])
    expect(replay.playerNames).toEqual(['赤方', '青方'])
    expect(replay.dice).toEqual(room.dice)
    expect(replay.steps).toHaveLength(2)
    expect(replay.steps[0]).toMatchObject({ player: 0, cell: 3, defense: false, match: true, hp: [6, 3] })
    expect(replay.steps[0].board.every((cell) => cell === 0)).toBe(true)
    expect(replay.steps[1]).toMatchObject({ player: 1, cell: 80, defense: true, match: false, hp: [6, -1] })
    expect(replay.steps[1].board[80]).toBe(2)
    expect(replay.result).toEqual({ winner: 0, reason: 'hp', hp: [6, -1] })
    expect(replay.durationMs).toBeGreaterThanOrEqual(0)

    const afterGame = room.applyMove('player-a', 4)
    expect(afterGame.ok).toBe(false)
    if (!afterGame.ok) expect(afterGame.code).toBe('notInMatch')
  })
})

describe('MatchManager', () => {
  function makeManager(): { manager: MatchManager; saved: ReplayDoc[]; clock: { now: number } } {
    const saved: ReplayDoc[] = []
    const clock = { now: 1_000_000 }
    const manager = new MatchManager({
      ttlMs: 1000,
      abandonedTtlMs: 500,
      onMatchFinished: (replay) => {
        saved.push(replay)
      },
      now: () => clock.now,
    })
    return { manager, saved, clock }
  }

  it('结束对局会把回放交给落库回调', async () => {
    const { manager, saved } = makeManager()
    const a = new FakePlayer('p-a', '·')
    const b = new FakePlayer('p-b', '·')
    const room = manager.create(a, b, 'ABC234')
    expect(room.code).toBe('ABC234')
    expect(manager.size).toBe(1)
    expect(manager.roomOfPlayer('p-a')?.id).toBe(room.id)

    room.engine.loadScenario(boardWith({ 0: 1, 1: 1, 2: 1 }), { hp: [6, 2], phase: 'playing', current: 0, firstPlayer: 0 })
    const first = manager.move('p-a', room.id, 3)
    expect(first.ok).toBe(true)
    const last = manager.move('p-b', room.id, 80)
    expect(last.ok).toBe(true)
    if (last.ok) {
      expect(last.gameOver?.result.winner).toBe(0)
      // 落库回调是异步触发的，给它一·tick
      await new Promise((resolve) => setImmediate(resolve))
      expect(saved).toHaveLength(1)
      expect(saved[0].matchId).toBe(room.id)
      expect(saved[0].steps).toHaveLength(2)
    }
  })

  it('matchId 错误 / 不在对局中的玩家一·notInMatch', () => {
    const { manager } = makeManager()
    const a = new FakePlayer('p-a', '·')
    const b = new FakePlayer('p-b', '·')
    const room = manager.create(a, b, null)

    const missing = manager.move('p-a', 'not-exist', 0)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('notInMatch')

    const outsider = manager.move('p-c', room.id, 0)
    expect(outsider.ok).toBe(false)
    if (!outsider.ok) expect(outsider.code).toBe('notInMatch')
  })

  it('认输：对手判胜、双方收·gameOver、回放照常落·', async () => {
    const { manager, saved } = makeManager()
    const a = new FakePlayer('p-a', '·')
    const b = new FakePlayer('p-b', '·')
    const room = manager.create(a, b, null)
    room.engine.loadScenario(boardWith({ 40: 1 }), { hp: [5, 4], phase: 'playing', current: 0, firstPlayer: 0 })
    manager.move('p-a', room.id, 41)

    const outcome = manager.resign('p-b', room.id)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.gameOver.result).toEqual({ winner: 0, reason: 'hp', hp: [5, 4] })
    expect(outcome.room.status).toBe('finished')
    await new Promise((resolve) => setImmediate(resolve))
    expect(saved).toHaveLength(1)
    expect(saved[0].result.winner).toBe(0)
    expect(saved[0].steps).toHaveLength(1)
  })

  it('断线：对手收·opponentLeft，房间作废且 5 分钟后可回收', () => {
    const { manager, clock } = makeManager()
    const a = new FakePlayer('p-a', '·')
    const b = new FakePlayer('p-b', '·')
    const room = manager.create(a, b, null)

    const outcome = manager.disconnect('p-a')
    expect(outcome).not.toBeNull()
    const message = b.last('opponentLeft') as OpponentLeftMessage | null
    expect(message).not.toBeNull()
    expect(message?.matchId).toBe(room.id)
    expect(message?.reason).toBe('disconnect')
    expect(room.status).toBe('abandoned')

    // 未到 5 分钟不回·
clock.now += 400
    expect(manager.sweep()).toBe(0)
    clock.now += 200
    expect(manager.sweep()).toBe(1)
    expect(manager.size).toBe(0)
  })

  it('主动 leave 也会通知对手', () => {
    const { manager } = makeManager()
    const a = new FakePlayer('p-a', '·')
    const b = new FakePlayer('p-b', '·')
    const room = manager.create(a, b, null)

    const outcome = manager.leave('p-b', room.id)
    expect(outcome.ok).toBe(true)
    const message = a.last('opponentLeft')
    expect(message?.reason).toBe('leave')
    expect(manager.roomOfPlayer('p-b')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// bugv10 #11：角色（skills 表由角色派生·// ---------------------------------------------------------------------------

describe('角色与技能表（bugv10 #11·', () => {
  it('未指定角色时按座位退回默认角色，matched ·state 都会带上', () => {
    const { room } = makeRoom()

    expect(room.characters).toEqual([DEFAULT_CHARACTERS[0], DEFAULT_CHARACTERS[1]])
    // 技能表由角色派生（引擎只认数值）
    expect(room.engine.skills[0].map((spec) => spec.id)).toEqual(['ds-shield', 'ds-double'])
    expect(room.engine.skills[1].map((spec) => spec.id)).toEqual(['gm-heal', 'gm-bloom'])
    expect(room.engine.skillReadyAt).toEqual([
      [5, 10],
      [5, 10],
    ])

    const matchedA = room.matchedMessageFor(room.players[0])
    const matchedB = room.matchedMessageFor(room.players[1])
    expect(matchedA.characters).toEqual(['deepseek', 'gemini'])
    expect(matchedB.characters).toEqual(matchedA.characters)

    const state = room.stateFor('player-a')
    expect(state.characters).toEqual(['deepseek', 'gemini'])
    expect(state.shield).toEqual([0, 0])
    expect(state.bonusActions).toEqual([0, 0])
    expect(state.actionsTaken).toEqual([0, 0])
    expect(state.skillReadyAt).toEqual([
      [5, 10],
      [5, 10],
    ])
    expect(state.lastPlacedBy).toEqual([null, null])
    expect(state.turnNo).toBe(0)
    expect(state.immuneUntil).toEqual([0, 0])
    expect(state.flames).toEqual([])
    expect(state.overlay).toEqual([])
  })

  it('resolveCharacters：非·/ 缺省逐项退回默认角·', () => {
    expect(resolveCharacters(['gtp', 'glm'])).toEqual(['gtp', 'glm'])
    expect(resolveCharacters(['nope', undefined])).toEqual(['deepseek', 'gemini'])
    expect(resolveCharacters([])).toEqual(['deepseek', 'gemini'])
    expect(resolveCharacters(null)).toEqual(['deepseek', 'gemini'])
    expect(resolveCharacters(undefined)).toEqual(['deepseek', 'gemini'])
  })

  it('MatchManager.create 会把双方选的角色带进对局（缺省时退回默认）', () => {
    const saved: ReplayDoc[] = []
    const manager = new MatchManager({ ttlMs: 1000, onMatchFinished: (replay) => void saved.push(replay) })
    const a = new FakePlayer('p-a', '·')
    const b = new FakePlayer('p-b', '·')
    a.character = 'glm'
    b.character = 'gtp'

    const room = manager.create(a, b, null)
    expect(room.characters).toEqual(['glm', 'gtp'])
    expect(room.engine.skills[0].map((spec) => spec.id)).toEqual(['gl-power', 'gl-sabotage'])
    expect(room.engine.skills[1].map((spec) => spec.id)).toEqual(['gt-immune', 'gt-fireball'])

    // 显式传入（从存档恢复）优先
    const restored = manager.create(new FakePlayer('p-c', '丙'), new FakePlayer('p-d', '丁'), null, ['gemini', 'deepseek'])
    expect(restored.characters).toEqual(['gemini', 'deepseek'])
  })
})

// ---------------------------------------------------------------------------
// bugv10 #11：技能裁决与回放落库
// ---------------------------------------------------------------------------

/** 把某一方的技能冷··到可用，并给它在指定格子放几棵植物·*/
function armSkill(room: MatchRoom, player: PlayerIndex, cells: number[], actionsTaken: number, kind: 'grass' | 'flower' | 'fern' = 'grass'): void {
  room.engine.actionsTaken[player] = actionsTaken
  for (const cell of cells) room.engine.magic.set(cell, { cell, kind, owner: player })
}

describe('MatchRoom 技能（bugv10 #11·', () => {
  it('未轮·/ 不在对局 / 冷却·/ 植物不是自己·一律拒绝，且不推进 seq', () => {
    const { room } = makeRoom(['deepseek', 'deepseek'])
    const first = seatOfFirst(room)
    const second = other(first)

    const notYourTurn = room.applySkill(playerOfSeat(room, second).playerId, 0, [], null)
    expect(notYourTurn.ok).toBe(false)
    if (!notYourTurn.ok) expect(notYourTurn.code).toBe('notYourTurn')

    const outsider = room.applySkill('someone-else', 0, [], null)
    expect(outsider.ok).toBe(false)
    if (!outsider.ok) expect(outsider.code).toBe('notInMatch')

    const firstPlayer = playerOfSeat(room, first)
    // 开局所有技能都在冷却中
    const cooling = room.applySkill(firstPlayer.playerId, 0, [], null)
    expect(cooling.ok).toBe(false)
    if (!cooling.ok) expect(cooling.code).toBe('illegalMove')

    // 冷却好了，但这棵植物是对手的
    room.engine.actionsTaken[first] = 5
    room.engine.magic.set(10, { cell: 10, kind: 'flower', owner: second })
    const wrongOwner = room.applySkill(firstPlayer.playerId, 0, [10], null)
    expect(wrongOwner.ok).toBe(false)
    if (!wrongOwner.ok) expect(wrongOwner.code).toBe('illegalMove')

    // 植物数量不对
    const wrongCount = room.applySkill(firstPlayer.playerId, 0, [], null)
    expect(wrongCount.ok).toBe(false)
    if (!wrongCount.ok) expect(wrongCount.code).toBe('illegalMove')

    expect(room.seq).toBe(0)
    expect(room.steps).toHaveLength(0)
    expect(room.engine.shield).toEqual([0, 0])
  })

  it('技能生效：applied ·skill 字段、digest 与引擎一致、step ·skill + extra', () => {
    const { room } = makeRoom(['gtp', 'gtp'])
    const first = seatOfFirst(room)
    const firstPlayer = playerOfSeat(room, first)
    const cells = [30, 31]
    armSkill(room, first, cells, 12)
    // bugv11 #6：gtp 二技能「恶龙吐息」首次释放免费 —— 这一条测的是**收费**那一次，
    // 所以先把"已经用过一次"补上（否则服务端只接受 0 棵植物）。
    room.engine.skillCasts[first][1] = 1

    const outcome = room.applySkill(firstPlayer.playerId, 1, cells, 40)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.applied.t).toBe('applied')
    expect(outcome.applied.kind).toBe('skill')
    expect(outcome.applied.seat).toBe(first)
    expect(outcome.applied.seq).toBe(1)
    expect(outcome.applied.slot).toBe(1)
    expect(outcome.applied.cells).toEqual(cells)
    expect(outcome.applied.target).toBe(40)
    expect(outcome.applied.cell).toBe(40)
    expect(outcome.applied.digest).toBe(digestOfEngine(room.engine))
    expect(outcome.applied.result).toBeNull()
    expect(outcome.gameOver).toBeNull()
    // bugv32：恶龙吐息**不再结束回合** —— 施法者用完还是自己走
    expect(outcome.applied.current).toBe(first)
    expect(room.engine.flames.size).toBeGreaterThan(0)

    const step = room.steps[0]
    expect(step.player).toBe(first)
    expect(step.cell).toBe(40)
    expect(step.defense).toBe(false)
    expect(step.match).toBe(false)
    expect(step.skill).toEqual({ slot: 1, cells, target: 40 })
    // bugv32：不结束回合 → 不推进 beginTurn，turnNo 不变
    expect(step.extra?.turnNo).toBe(0)
    expect(step.extra?.actionsTaken[first]).toBe(12)
    expect(step.extra?.skillReadyAt[first][1]).toBe(20) // bugv33：冷却 6 → 12 → 8，12 + 8 = 20
    expect(step.extra?.skillCasts?.[first][1]).toBe(2)
    expect(step.extra?.shield).toEqual([0, 0])
    expect(step.extra?.bonusActions).toEqual([0, 0])
    expect(step.extra?.immuneUntil).toEqual([0, 0])
    expect(step.extra?.twinStar).toEqual([false, false])
    expect(step.extra?.overlay).toEqual([])
    expect(step.extra?.lastPlacedBy).toEqual([null, null])
    expect(step.extra?.flames.length).toBe(room.engine.flames.size)
    expect(step.extra?.flames).toContainEqual([40, 12])
    // bugv27 #4：烈焰归属也必须落进 extra（否则重连 / 回放的走火判定就错了）
    expect(step.extra?.flameOwner?.length).toBe(room.engine.flameOwner.size)
    expect(step.extra?.flameOwner).toContainEqual([40, first])
    expect(step.board).toHaveLength(81)

    // 技能消耗掉植物
    for (const cell of cells) expect(room.engine.magic.has(cell)).toBe(false)

    // sync：state ·applied ·digest 一·
const state = room.stateFor(firstPlayer.playerId)
    expect(state.digest).toBe(outcome.applied.digest)
    expect(state.flames).toEqual(step.extra?.flames)
    expect(state.flameOwner).toEqual(step.extra?.flameOwner)
    expect(state.characters).toEqual(['gtp', 'gtp'])
    expect(state.skillReadyAt[first][1]).toBe(20) // bugv33：冷却 6 → 12 → 8
    expect(state.skillCasts[first][1]).toBe(2)
    expect(state.twinStar).toEqual([false, false])
    // bugv27 #4：新角色字段必须都在 state 里（前端 applyOnlineState 会读它们）
    expect(state.powerUntil).toEqual([0, 0])
    expect(state.sabotageBonus).toEqual([0, 0])
    expect(state.bloomCheaperNext).toEqual([false, false])
    expect(state.tempArmor).toEqual([0, 0])
    expect(state.tempArmorUntil).toEqual([0, 0])
    expect(state.strikeBonus).toEqual([0, 0])
    expect(state.strikeUntil).toEqual([0, 0])
    expect(state.seedGrow).toEqual([false, false])
    expect(state.noPlantBonus).toEqual([false, false])
  })

  it('新角色技能状态会进入 state / extra 并参与 digest（bugv27 #4）', () => {
    const { room } = makeRoom(['gtp', 'glm'])
    const first = seatOfFirst(room)
    const firstPlayer = playerOfSeat(room, first)
    // gtp 一技能「精密计算」：临时护甲 = 生命上限（bugv29）、持续到自己下个回合结束前
    armSkill(room, first, [30], 6)
    const outcome = room.applySkill(firstPlayer.playerId, 0, [30], null)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(room.engine.tempArmor[first]).toBe(INITIAL_HP)
    const state = room.stateFor(firstPlayer.playerId)
    expect(state.tempArmor[first]).toBe(INITIAL_HP)
    expect(state.tempArmorUntil[first]).toBeGreaterThan(0)
    expect(state.tempArmorUntil[first]).toBe(room.engine.tempArmorUntil[first])
    expect(state.digest).toBe(digestOfEngine(room.engine))
    const step = room.steps[0]
    expect(step.extra?.tempArmor?.[first]).toBe(INITIAL_HP)
    expect(step.extra?.tempArmorUntil?.[first]).toBe(room.engine.tempArmorUntil[first])
  })

  it('恶龙吐息首次释放免费：0 棵植物也能放，第二次才按 2 棵收费（bugv11 #6）', () => {
    const { room } = makeRoom(['gtp', 'gtp'])
    const first = seatOfFirst(room)
    const firstPlayer = playerOfSeat(room, first)
    const secondPlayer = playerOfSeat(room, other(first))

    // 开局一颗植物都没有：首次释放依然成立（cost 2 但首次免费）
    expect(room.engine.skillStateFor(first, 1)?.costNow).toBe(0)
    const free = room.applySkill(firstPlayer.playerId, 1, [], 40)
    expect(free.ok).toBe(true)
    if (!free.ok) return
    expect(free.applied.cells).toEqual([])
    expect(room.engine.flames.size).toBeGreaterThan(0)
    expect(room.engine.skillCasts[first][1]).toBe(1)

    // 第二次：最低 1 棵植物（可变 1~2 的下限），也要等冷却（8 次行动）；bugv32：不再结束回合
    const after = room.engine.skillStateFor(first, 1)
    expect(after?.costNow).toBe(1)
    expect(after?.freeNow).toBe(false)
    expect(after?.remaining).toBe(8)
    expect(room.engine.current).toBe(first)

    // 本人还轮得到（不结束回合）：同回合还能落子，落完才换手
    const myMove = room.applyMove(firstPlayer.playerId, 0)
    expect(myMove.ok).toBe(true)
    expect(room.engine.current).toBe(other(first))
  })

  it('回放文档：characters + 技能步 skill + 每一·extra 都落库（含内存仓储往返）', async () => {
    const { room } = makeRoom(['gtp', 'gtp'])
    const first = seatOfFirst(room)
    const firstPlayer = playerOfSeat(room, first)
    const cells = [30, 31]
    armSkill(room, first, cells, 12)
    // bugv11 #6：首次免费已经用掉，这一条走"收费"路径
    room.engine.skillCasts[first][1] = 1

    const skill = room.applySkill(firstPlayer.playerId, 1, cells, 40)
    expect(skill.ok).toBe(true)
    // bugv32：火球不结束回合 → 同回合施法者本人还能落子
    const move = room.applyMove(firstPlayer.playerId, 0)
    expect(move.ok).toBe(true)
    expect(room.engine.current).toBe(other(first))

    const doc = room.toReplayDoc()
    expect(doc.characters).toEqual(['gtp', 'gtp'])
    expect(doc.steps).toHaveLength(2)

    expect(doc.steps[0].skill).toEqual({ slot: 1, cells, target: 40 })
    // bugv32：不结束回合 → turnNo 不变
    expect(doc.steps[0].extra?.turnNo).toBe(0)
    expect(doc.steps[0].extra?.skillReadyAt[first][1]).toBe(20) // bugv33：冷却 6 → 12 → 8
    expect(doc.steps[0].extra?.skillCasts?.[first][1]).toBe(2)
    expect(doc.steps[0].extra?.flames).toContainEqual([40, 12])
    expect(doc.steps[0].board).toHaveLength(81)

    // 普通步也带 extra，只是没 skill
    expect(doc.steps[1].skill).toBeUndefined()
    expect(doc.steps[1].extra).toBeDefined()
    // 落子的是施法者本人：这一手让他的行动数 12 → 13；对手还没动过
    expect(doc.steps[1].extra?.actionsTaken[first]).toBe(13)
    expect(doc.steps[1].extra?.actionsTaken[other(first)]).toBe(0)
    for (const step of doc.steps) expect(step.extra).toBeDefined()

    // 内存仓储的深拷贝不能丢掉新字段（REST 回放要用·
const repo = new MemoryRepository()
    await repo.saveReplay(doc)
    const loaded = await repo.getReplay(doc.matchId)
    expect(loaded?.characters).toEqual(['gtp', 'gtp'])
    expect(loaded?.steps[0].skill).toEqual({ slot: 1, cells, target: 40 })
    expect(loaded?.steps[0].extra).toEqual(doc.steps[0].extra)
    expect(loaded?.steps[0].magic).toEqual(doc.steps[0].magic)
    expect(loaded?.steps[1].extra).toEqual(doc.steps[1].extra)
    expect(loaded?.steps[1].extra).not.toBe(doc.steps[1].extra)
  })
})
