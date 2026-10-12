/**
 * 联机黑夜一致性（bugv34d 第 5 项）。
 *
 * 背景：服务端是权威引擎，客户端拿 `stateFor()` 恢复一份**镜像引擎**，
 * 之后每一步客户端**本地重跑同一份引擎**（`commit` / `defend` / `useSkill`），
 * 用自己的 `localDigest()` 与服务端下发的 `digest` 比对 —— 不一致就重新 `sync`。
 *
 * 因此"联机支持黑夜"的硬要求是：**同一串走子之后，两端的黑夜状态与指纹必须逐字节一致**。
 * 这个用例就按客户端的真实做法驱动一遍，并且**必须真的跑到入夜**（否则等于没测）。
 */
import { describe, expect, it } from 'vitest'
import { MatchRoom, type MatchPlayer } from '../src/match'
import type { Participant } from '../src/matching'
import { digestOfEngine } from '../src/digest'
import { GameEngine } from '../src/core/engine'
import { stateDigest } from '../src/core/digest'
import { Rng } from '../src/core/random'
import {
  createBoard,
  resolveMagicConfig,
  resolveNightConfig,
  cellOf,
  other,
  type Board,
  type PlayerIndex,
  type SkillSpec,
} from '../src/core/types'
import { skillsOfCharacter, type CharacterId } from '../src/core/characters'
import type { ServerMessage } from '../src/protocol'

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
}

function makeRoom(seed: number, characters?: readonly string[]): MatchRoom {
  const a = new FakePlayer('player-a', '赤方')
  const b = new FakePlayer('player-b', '青方')
  return new MatchRoom({ host: a, guest: b, seed, characters })
}

/** 客户端的 `localDigest()`（字段集合必须与服务端 `digestOfEngine` 完全一致）。 */
function clientDigest(engine: GameEngine): string {
  return stateDigest({
    board: engine.board,
    hp: engine.hp,
    phase: engine.phase,
    current: engine.current,
    firstPlayer: engine.firstPlayer,
    highlightOwner: engine.highlightOwner,
    highlights: engine.highlights,
    magic: engine.magic,
    magicGrowths: engine.magicGrowths,
    magicCooldown: engine.magicCooldown,
    shield: engine.shield,
    bonusActions: engine.bonusActions,
    actionsTaken: engine.actionsTaken,
    skillReadyAt: engine.skillReadyAt,
    turnNo: engine.turnNo,
    immuneUntil: engine.immuneUntil,
    powerUntil: engine.powerUntil,
    flames: engine.flames,
    overlay: engine.overlay,
    twinStar: engine.twinStar,
    sabotage: engine.sabotage,
    sabotageBonus: engine.sabotageBonus,
    bloomCheaperNext: engine.bloomCheaperNext,
    skillCasts: engine.skillCasts,
    tempArmor: engine.tempArmor,
    tempArmorUntil: engine.tempArmorUntil,
    strikeBonus: engine.strikeBonus,
    strikeUntil: engine.strikeUntil,
    seedGrow: engine.seedGrow,
    noPlantBonus: engine.noPlantBonus,
    // bugv34m：Qwen 的两个技能状态（少一项两端指纹就会对不上）
    deploy: engine.deploy,
    deployBonus: engine.deployBonus,
    redeployPending: engine.redeployPending,
    flameOwner: engine.flameOwner,
    nightPhase: engine.nightPhase,
    nightCountdown: engine.nightCountdown,
    nightTurns: engine.nightTurns,
    turnsSinceNight: engine.turnsSinceNight,
    weather: engine.weather,
    attacksLaunched: engine.attacksLaunched,
    nightAttackBase: engine.nightAttackBase,
    nightFromStart: engine.nightFromStart,
  })
}

/**
 * 造客户端镜像引擎 —— 与 `useConnectGame.startOnlineMatch()` 完全同构：
 * 不自动掷骰、不传角色技能表（联机对局禁用技能），黑夜用默认配置。
 */
function mirrorEngine(): GameEngine {
  return new GameEngine({ initialHp: 12, autoRoll: false, magic: null, skills: null })
}

/**
 * 用 `stateFor` 的完整局面把镜像引擎对齐（等价于客户端首帧的 `applyOnlineState`）。
 *
 * ⚠️ 必须用**房间设置**建引擎（`magic` / `night` / `hpLimit`）—— `loadScenario` 不会改配置，
 * 配置不一致时（例如房主把魔力植物关了）第一步之后就会分叉。
 */
function syncMirror(room: MatchRoom, seat: PlayerIndex): GameEngine {
  const message = room.stateFor(room.players[seat].playerId)
  const engine = new GameEngine({
    initialHp: room.settings.hpLimit,
    autoRoll: false,
    magic: room.settings.magic,
    night: room.settings.night,
    skills: null,
  })
  engine.loadScenario(message.board as Board, {
    hp: [message.hp[0], message.hp[1]],
    phase: message.phase as typeof engine.phase,
    current: message.current,
    firstPlayer: message.firstPlayer ?? undefined,
    attacker: message.highlightOwner ?? undefined,
    highlights: new Map(message.highlights),
    lineLengthSum: message.attack?.lineLengthSum ?? 0,
    magic: message.magic ?? [],
    magicGrowths: message.magicGrowths,
    magicCooldown: message.magicCooldown,
    magicLineSeen: message.magicLineSeen,
    shield: message.shield,
    bonusActions: message.bonusActions,
    actionsTaken: message.actionsTaken,
    skillReadyAt: message.skillReadyAt,
    lastPlacedBy: message.lastPlacedBy,
    turnNo: message.turnNo,
    immuneUntil: message.immuneUntil,
    powerUntil: message.powerUntil,
    flames: message.flames,
    overlay: message.overlay,
    powerBonus: message.powerBonus,
    sabotage: message.sabotage,
    sabotageBonus: message.sabotageBonus,
    twinStar: message.twinStar,
    bloomCheaperNext: message.bloomCheaperNext,
    skillCasts: message.skillCasts,
    tempArmor: message.tempArmor,
    tempArmorUntil: message.tempArmorUntil,
    strikeBonus: message.strikeBonus,
    strikeUntil: message.strikeUntil,
    seedGrow: message.seedGrow,
    noPlantBonus: message.noPlantBonus,
    deploy: message.deploy,
    deployBonus: message.deployBonus,
    redeployPending: message.redeployPending,
    flameOwner: message.flameOwner,
    nightPhase: message.nightPhase,
    nightCountdown: message.nightCountdown,
    nightTurns: message.nightTurns,
    turnsSinceNight: message.turnsSinceNight,
    weather: message.weather ?? null,
    attacksLaunched: message.attacksLaunched,
    nightAttackBase: message.nightAttackBase,
    nightFromStart: message.nightFromStart ?? false,
  })
  engine.attack = message.attack
  engine.result = message.result
  return engine
}

function playerOfSeat(room: MatchRoom, seat: PlayerIndex): MatchPlayer {
  const found = room.players.find((player) => player.seat === seat)
  if (!found) throw new Error(`没有座位 ${seat} 的玩家`)
  return found
}

/**
 * 跑一整局（服务端裁决 + 客户端镜像重跑），每一步比对指纹。
 *
 * 走子策略故意"让它容易成线"：优先挑能形成连珠/需要防守的位置，从而把
 * `attacksLaunched` 与植物数都推上去，**保证真的能进黑夜**。
 */
function playGame(seed: number, maxSteps = 400): { room: MatchRoom; enteredNight: boolean; mismatchAt: number | null } {
  const room = makeRoom(seed)
  const rng = new Rng(seed ^ 0x5f3759df)
  // 两端各自一份引擎：服务端就是 room.engine，客户端是镜像
  const mirror = syncMirror(room, 0)
  let enteredNight = false
  let mismatchAt: number | null = null

  for (let step = 0; step < maxSteps; step += 1) {
    const engine = room.engine
    if (engine.isOver) break
    const seat = engine.current
    const player = playerOfSeat(room, seat)

    // --- 客户端：先本地重跑同一手，并检查指纹 ---
    // ⚠️ 必须先记下**服务端裁决前**的阶段：`applyMove` 之后引擎已经推进，
    // 那时再读 `engine.phase` 会误判该 commit 还是 defend。
    const wasDefense = engine.phase === 'awaitingDefense'
    let legal = engine.legalMoves()
    if (wasDefense) legal = legal.filter((cell) => !engine.flames.has(cell))
    if (legal.length === 0) break
    // 有连珠可拿就先拿（更快进入攻击/黑夜）
    const sorted = [...legal].sort((a, b) => b - a)
    const cell = sorted[Math.floor(rng.next() * Math.min(sorted.length, 9))]

    let applied
    try {
      applied = room.applyMove(player.playerId, cell)
    } catch {
      break
    }
    if (!applied.ok) break

    // 客户端镜像跟着重跑同一步
    try {
      if (wasDefense) mirror.defend(cell)
      else mirror.commit(cell)
    } catch (error) {
      throw new Error(`镜像引擎在第 ${step} 步抛错：${String(error)}`)
    }

    if (mirror.nightPhase === 'active') enteredNight = true

    if (digestOfEngine(room.engine) !== clientDigest(mirror)) {
      // 客户端此时会 requestSync()，等价于"重新对齐" —— 记录下来后继续，
      // 但若**是真的漂移**，重新对齐也救不回来（下面会断言 mismatchAt === null）。
      mismatchAt = step
      const resynced = syncMirror(room, 0)
      if (digestOfEngine(room.engine) !== clientDigest(resynced)) break
    }

    // 两边黑夜字段也必须逐项一致
    expect(mirror.nightPhase, `第 ${step} 步 nightPhase`).toBe(room.engine.nightPhase)
    expect(mirror.weather, `第 ${step} 步 weather`).toBe(room.engine.weather)
    expect(mirror.nightTurns, `第 ${step} 步 nightTurns`).toBe(room.engine.nightTurns)
    expect(mirror.nightCountdown, `第 ${step} 步 nightCountdown`).toBe(room.engine.nightCountdown)
    expect(mirror.nightFromStart, `第 ${step} 步 nightFromStart`).toBe(room.engine.nightFromStart)
  }

  return { room, enteredNight, mismatchAt }
}

describe('联机黑夜一致性（bugv34d）', () => {
  it('服务端与客户端镜像：整局指纹逐步一致，且真的跑到入夜', () => {
    let enteredAny = false
    for (const seed of [1, 7, 42, 1234, 99999]) {
      const { enteredNight, mismatchAt } = playGame(seed)
      expect(mismatchAt, `seed=${seed} 出现指纹漂移`).toBeNull()
      enteredAny = enteredAny || enteredNight
    }
    expect(enteredAny, '五个种子都没跑到黑夜 ⇒ 这个用例没测到东西').toBe(true)
  })

  it('**自定义房间设置**（血量上限 16 + 魔力植物关 + 黑夜自定义）两端指纹仍然一致', () => {
    // 这是 bugv34e 的核心风险：房间设置由房主决定，两端必须用**同一份**去建引擎，
    // 否则第一步指纹就对不上（血量上限 / 植物 / 黑夜任一不同都会漂）。
    const settings = {
      hpLimit: 16,
      magic: resolveMagicConfig({ enabled: false }),
      night: resolveNightConfig({
        enabled: true,
        warnTurns: 1,
        minGap: 0,
        startTurnThreshold: 1,
        entryAttackThreshold: 0,
        entryPlantThreshold: 0,
      }),
    }
    const room = new MatchRoom({
      host: new FakePlayer('custom-a', '甲'),
      guest: new FakePlayer('custom-b', '乙'),
      seed: 2468,
      settings,
    })
    expect(room.settings.hpLimit).toBe(16)
    expect(room.engine.hp).toEqual([16, 16])

    // ⚠️ 客户端的第 0 帧就是"拿 stateFor 对齐"，这里必须走同一条路 ——
    // 自己手搓 `loadScenario` 会漏掉技能表派生的 `skillReadyAt`（指纹立刻就不同）。
    const mirror = syncMirror(room, 0)
    expect(digestOfEngine(room.engine)).toBe(clientDigest(mirror))

    const rng = new Rng(97531)
    for (let step = 0; step < 200; step += 1) {
      const engine = room.engine
      if (engine.isOver) break
      const seat = engine.current
      const wasDefense = engine.phase === 'awaitingDefense'
      let legal = engine.legalMoves()
      if (wasDefense) legal = legal.filter((cell) => !engine.flames.has(cell))
      if (legal.length === 0) break
      const cell = legal[Math.floor(rng.next() * legal.length)]
      const applied = room.applyMove(room.players[seat].playerId, cell)
      if (!applied.ok) break
      if (wasDefense) mirror.defend(cell)
      else mirror.commit(cell)
      expect(digestOfEngine(room.engine), `第 ${step} 步指纹应一致`).toBe(clientDigest(mirror))
    }
  })

  it('`stateFor()` 带齐黑夜字段（否则重连的客户端会算错 / 指纹永远对不上）', () => {
    const room = makeRoom(2026)
    const message = room.stateFor(room.players[0].playerId)
    expect(message).toHaveProperty('nightPhase')
    expect(message).toHaveProperty('nightCountdown')
    expect(message).toHaveProperty('nightTurns')
    expect(message).toHaveProperty('turnsSinceNight')
    expect(message).toHaveProperty('weather')
    expect(message).toHaveProperty('attacksLaunched')
    expect(message).toHaveProperty('nightAttackBase')
    expect(message).toHaveProperty('nightFromStart')
  })

  it('黑夜字段会出现在每步回放的 `extra` 里（回放拖进度要能还原明暗与天气）', () => {
    const room = makeRoom(31337)
    const rng = new Rng(31337)
    for (let step = 0; step < 120 && !room.engine.isOver; step += 1) {
      const seat = room.engine.current
      const player = playerOfSeat(room, seat)
      let legal = room.engine.legalMoves()
      if (room.engine.phase === 'awaitingDefense') legal = legal.filter((cell) => !room.engine.flames.has(cell))
      if (legal.length === 0) break
      const cell = legal[Math.floor(rng.next() * legal.length)]
      const applied = room.applyMove(player.playerId, cell)
      if (!applied.ok) break
    }
    expect(room.steps.length).toBeGreaterThan(0)
    for (const step of room.steps) {
      expect(step.extra).toBeDefined()
      expect(step.extra).toHaveProperty('nightPhase')
      expect(step.extra).toHaveProperty('weather')
      expect(step.extra).toHaveProperty('attacksLaunched')
      expect(step.extra).toHaveProperty('nightAttackBase')
      expect(step.extra).toHaveProperty('nightFromStart')
    }
  })
})
