/**
 * 服务端权威对局：`MatchRoom`（单局）+ `MatchManager`（全局登记与回收）。
 *
 * 服务端与前端跑同一份纯逻辑引擎（`src/core`），这里只负责：
 * 校验落子 -> 调 `engine.commit()` / `engine.defend()` -> 记录 steps -> 生成回放。
 */
import { randomInt, randomUUID } from 'node:crypto'
import { DEFAULT_CHARACTERS, isCharacterId, skillsOfCharacter, type CharacterId } from './core/characters'
import { GameEngine } from './core/engine'
import { CELL_COUNT, other, type GameEvent, type GameResult, type PlayerIndex } from './core/types'
import { digestOfEngine } from './digest'
import { DEFAULT_ROOM_SETTINGS } from './room'
import type { ReplayDoc, ReplayPlayer } from './db'
import type { Participant } from './matching'
import type {
  AppliedMessage,
  Dice,
  ErrorCode,
  GameOverMessage,
  MatchedMessage,
  MoveKind,
  ReplayExtra,
  ReplayStep,
  RoomSettings,
  ServerMessage,
  StateMessage,
} from './protocol'

/** 已废弃（一方掉线/离开）的对局在内存里的保留时长：5 分钟。 */
export const ABANDONED_MATCH_TTL_MS = 5 * 60 * 1000

export type MatchStatus = 'active' | 'finished' | 'abandoned'

/** 对局中的一方。 */
export interface MatchPlayer extends Participant {
  readonly seat: PlayerIndex
}

export interface MoveFailure {
  readonly ok: false
  readonly code: ErrorCode
  readonly message: string
}

export interface MoveOutcome {
  readonly ok: true
  readonly room: MatchRoom
  readonly applied: AppliedMessage
  /** 对局在本步结束时非 null。 */
  readonly gameOver: GameOverMessage | null
  /** 需要落库的回放（对局结束时才有）。 */
  readonly replay: ReplayDoc | null
}

export type MoveResult = MoveOutcome | MoveFailure

export interface FinishOutcome {
  readonly ok: true
  readonly room: MatchRoom
  readonly gameOver: GameOverMessage
  readonly replay: ReplayDoc | null
}

function fail(code: ErrorCode, message: string): MoveFailure {
  return { ok: false, code, message }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 推导双方角色（bugv10 #11）。
 *
 * 按**座位**索引：0 = 先手方（host）、1 = 后手方（guest）。
 * 缺省或非法一律退回默认角色，因此：
 * - 老客户端不带 `character` 时照常开局（`['deepseek', 'gemini']`）；
 * - 从数据库恢复老对局（存档里没有 `characters`）时同样退回默认角色。
 */
export function resolveCharacters(
  stored?: readonly (string | null | undefined)[] | null,
): [CharacterId, CharacterId] {
  return [
    isCharacterId(stored?.[0]) ? (stored[0] as CharacterId) : DEFAULT_CHARACTERS[0],
    isCharacterId(stored?.[1]) ? (stored[1] as CharacterId) : DEFAULT_CHARACTERS[1],
  ]
}

/**
 * 单局对局房间。
 *
 * 座位：0 = 先手方（赤）/ 1 = 后手方（青），与前端 `PlayerIndex` 一致。
 * 谁先走由引擎掷骰子决定（`dice.first`），与座位无关。
 */
export class MatchRoom {
  readonly id: string
  readonly code: string | null
  readonly mode = 'online' as const
  readonly createdAt: number
  readonly players: [MatchPlayer, MatchPlayer]
  readonly engine: GameEngine
  readonly dice: Dice
  /** 双方角色（bugv10 #11），按座位索引；技能表由它派生。 */
  readonly characters: [CharacterId, CharacterId]
  /** 本局的房间设置（bugv34e）。 */
  readonly settings: RoomSettings
  readonly steps: ReplayStep[] = []
  readonly seed: number

  seq = 0
  status: MatchStatus = 'active'
  statusChangedAt: number
  lastActivityAt: number

  private readonly clock: () => number

  constructor(options: {
    id?: string
    code?: string | null
    host: Participant
    guest: Participant
    seed?: number
    now?: () => number
    /** 双方角色（缺省 / 非法按座位退回默认角色）。 */
    characters?: readonly (string | null | undefined)[] | null
    /**
     * 房间设置（bugv34e）：血量上限 / 魔力植物 / 黑夜。
     *
     * 服务端与客户端**必须用同一份**（否则第一步指纹就对不上），
     * 所以这里必须显式传入；缺省时退回默认配置。
     */
    settings?: RoomSettings
  }) {
    this.clock = options.now ?? (() => Date.now())
    const now = this.clock()
    this.id = options.id ?? randomUUID()
    this.code = options.code ?? null
    this.createdAt = now
    this.statusChangedAt = now
    this.lastActivityAt = now
    this.seed = options.seed ?? randomInt(0, 0xffffffff)
    this.characters = options.characters
      ? resolveCharacters(options.characters)
      : resolveCharacters([options.host.character, options.guest.character])
    this.settings = options.settings ?? DEFAULT_ROOM_SETTINGS

    // 服务端掷一次骰子，两端必须沿用（PROTOCOL.md 第 2 节）
    // 技能表由角色派生（bugv10 #11）：两端必须传同一份角色，否则指纹会漂移
    this.engine = new GameEngine({
      seed: this.seed,
      initialHp: this.settings.hpLimit,
      magic: this.settings.magic,
      night: this.settings.night,
      skills: [skillsOfCharacter(this.characters[0]), skillsOfCharacter(this.characters[1])],
    })
    const events = this.engine.takeEvents()
    const rolled = events.find((event): event is Extract<GameEvent, { type: 'diceRolled' }> => event.type === 'diceRolled')
    if (!rolled) throw new Error('引擎未能掷出骰子，无法开局')
    this.dice = { rolls: [rolled.rolls[0], rolled.rolls[1]], first: rolled.first }

    // ⚠️ 这里**重建**了 players，所以 `Participant` 上新增的字段必须一起带过来
    // （漏了 `account` 就会让回放文档写不出 `accounts`，见 bugv34k）。
    this.players = [
      {
        playerId: options.host.playerId,
        name: options.host.name,
        seat: 0,
        account: options.host.account ?? null,
        send: (m) => options.host.send(m),
      },
      {
        playerId: options.guest.playerId,
        name: options.guest.name,
        seat: 1,
        account: options.guest.account ?? null,
        send: (m) => options.guest.send(m),
      },
    ]
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  playerAt(seat: PlayerIndex): MatchPlayer {
    return this.players[seat]
  }

  seatOf(playerId: string): PlayerIndex | null {
    const found = this.players.find((player) => player.playerId === playerId)
    return found ? found.seat : null
  }

  opponentOf(playerId: string): MatchPlayer | null {
    const seat = this.seatOf(playerId)
    if (seat === null) return null
    return this.players[other(seat)]
  }

  /**
   * 玩家换了连接（刷新页面 / 多标签页重新登录）：把广播目标换成新连接。
   *
   * 不做这一步的话，刷新之后 `sync` 能把局面接回来，但对手后续的每一步
   * 仍然发往那条已经断掉的旧连接 —— 表现就是"看得到自己、看不到对手更新"（bugv7 #1）。
   */
  rebind(playerId: string, participant: Participant): boolean {
    const player = this.players.find((item) => item.playerId === playerId)
    if (!player) return false
    player.name = participant.name
    player.send = (message: ServerMessage) => participant.send(message)
    return true
  }

  broadcast(message: ServerMessage): void {
    for (const player of this.players) {
      try {
        player.send(message)
      } catch {
        /* 单个连接发送失败不影响另一方 */
      }
    }
  }

  /** 开局的 `matched` 消息（两名玩家字段不同）。 */
  matchedMessageFor(player: MatchPlayer): MatchedMessage {
    return {
      t: 'matched',
      matchId: this.id,
      seat: player.seat,
      code: this.code,
      opponent: this.players[other(player.seat)].name,
      dice: this.dice,
      characters: [this.characters[0], this.characters[1]],
      // bugv34e：两端必须用同一份房间设置（血量上限 / 魔力植物 / 黑夜）
      settings: this.settings,
    }
  }

  digest(): string {
    return digestOfEngine(this.engine)
  }

  /**
   * 技能相关状态的快照（bugv10 #11）：`state` 与回放 `steps[].extra` 共用。
   *
   * 这些字段必须两端一致，否则技能局一旦重连 / 回放就会漂移。
   */
  private skillExtra(): ReplayExtra {
    const engine = this.engine
    return {
      shield: [engine.shield[0], engine.shield[1]],
      bonusActions: [engine.bonusActions[0], engine.bonusActions[1]],
      actionsTaken: [engine.actionsTaken[0], engine.actionsTaken[1]],
      skillReadyAt: [[...engine.skillReadyAt[0]], [...engine.skillReadyAt[1]]],
      turnNo: engine.turnNo,
      immuneUntil: [engine.immuneUntil[0], engine.immuneUntil[1]],
      flames: [...engine.flames.entries()]
        .map(([cell, left]): [number, number] => [cell, left])
        .sort((a, b) => a[0] - b[0]),
      overlay: [...engine.overlay.entries()]
        .map(([cell, owner]): [number, number] => [cell, owner])
        .sort((a, b) => a[0] - b[0]),
      lastPlacedBy: [engine.lastPlacedBy[0], engine.lastPlacedBy[1]],
      // bugv11 #5/#6：双子星爆发窗口与"首次免费"计数决定下一手怎么算，
      // 重连 / 回放缺了就会算错
      twinStar: [engine.twinStar[0], engine.twinStar[1]],
      skillCasts: [[...engine.skillCasts[0]], [...engine.skillCasts[1]]],
      // bugv27 #4：新角色引入的状态（前端 applyOnlineState 早就会读，服务端以前没给）
      powerUntil: [engine.powerUntil[0], engine.powerUntil[1]],
      sabotage: [engine.sabotage[0], engine.sabotage[1]],
      sabotageBonus: [engine.sabotageBonus[0], engine.sabotageBonus[1]],
      bloomCheaperNext: [engine.bloomCheaperNext[0], engine.bloomCheaperNext[1]],
      tempArmor: [engine.tempArmor[0], engine.tempArmor[1]],
      tempArmorUntil: [engine.tempArmorUntil[0], engine.tempArmorUntil[1]],
      strikeBonus: [engine.strikeBonus[0], engine.strikeBonus[1]],
      strikeUntil: [engine.strikeUntil[0], engine.strikeUntil[1]],
      seedGrow: [engine.seedGrow[0], engine.seedGrow[1]],
      noPlantBonus: [engine.noPlantBonus[0], engine.noPlantBonus[1]],
      flameOwner: [...engine.flameOwner.entries()]
        .map(([cell, owner]): [number, number] => [cell, owner])
        .sort((a, b) => a[0] - b[0]),
      // bugv34：黑夜 / 天气 / 攻击棋子计数（缺一项两端指纹就对不上）
      nightPhase: engine.nightPhase,
      nightCountdown: engine.nightCountdown,
      nightTurns: engine.nightTurns,
      turnsSinceNight: engine.turnsSinceNight,
      weather: engine.weather,
      attacksLaunched: [engine.attacksLaunched[0], engine.attacksLaunched[1]],
      nightAttackBase: [engine.nightAttackBase[0], engine.nightAttackBase[1]],
      // bugv34d：联机固定 startInNight=false ⇒ 恒 false，但照六处清单一起透传，
      // 免得以后联机开「黑夜开局」时漏掉它（那会让两端退出条件不一致 → 指纹漂移）。
      nightFromStart: engine.nightFromStart,
      // bugv34m：Qwen 的两个技能状态（缺一项两端指纹就对不上）
      deploy: [engine.deploy[0], engine.deploy[1]],
      deployBonus: [engine.deployBonus[0], engine.deployBonus[1]],
      redeployPending: [[...engine.redeployPending[0]], [...engine.redeployPending[1]]],
    }
  }

  /** `sync` / 重连用的完整局面。 */
  stateFor(playerId: string): StateMessage {
    const seat = this.seatOf(playerId) ?? 0
    const extra = this.skillExtra()
    return {
      t: 'state',
      matchId: this.id,
      seq: this.seq,
      seat,
      board: this.engine.board.slice(),
      hp: [this.engine.hp[0], this.engine.hp[1]],
      current: this.engine.current,
      phase: this.engine.phase,
      firstPlayer: this.engine.firstPlayer,
      highlightOwner: this.engine.highlightOwner,
      highlights: [...this.engine.highlights.entries()],
      attack: this.engine.attack,
      digest: this.digest(),
      result: this.engine.result,
      // 魔力植物（bugv8 #4）：连它长过几次 / 还剩几回合冷却一起给，
      // 否则重连回来的客户端后续生长节奏会和服务端错开
      magic: [...this.engine.magic.values()].map((plant) => ({ ...plant })),
      magicGrowths: this.engine.magicGrowths,
      magicCooldown: this.engine.magicCooldown,
      magicLineSeen: this.engine.magicLineSeen,
      // 角色技能（bugv10 #11）：断线重连必须把技能状态一起恢复
      characters: [this.characters[0], this.characters[1]],
      shield: extra.shield,
      bonusActions: extra.bonusActions,
      actionsTaken: extra.actionsTaken,
      skillReadyAt: extra.skillReadyAt,
      lastPlacedBy: extra.lastPlacedBy,
      turnNo: extra.turnNo,
      immuneUntil: extra.immuneUntil,
      flames: extra.flames,
      overlay: extra.overlay,
      // 这几项不参与指纹，但"本回合"的伤害加成 / 叠子许可丢了会让重连方算错一手
      powerBonus: [this.engine.powerBonus[0], this.engine.powerBonus[1]],
      sabotage: [this.engine.sabotage[0], this.engine.sabotage[1]],
      // bugv11 #5/#6：双子星爆发窗口与"首次免费"计数
      twinStar: [this.engine.twinStar[0], this.engine.twinStar[1]],
      skillCasts: [[...this.engine.skillCasts[0]], [...this.engine.skillCasts[1]]],
      // bugv27 #4：新角色的技能状态（缺一项重连方就会算错 / 指纹永远对不上）
      powerUntil: extra.powerUntil ?? [0, 0],
      sabotageBonus: extra.sabotageBonus ?? [0, 0],
      bloomCheaperNext: extra.bloomCheaperNext ?? [false, false],
      tempArmor: extra.tempArmor ?? [0, 0],
      tempArmorUntil: extra.tempArmorUntil ?? [0, 0],
      strikeBonus: extra.strikeBonus ?? [0, 0],
      strikeUntil: extra.strikeUntil ?? [0, 0],
      seedGrow: extra.seedGrow ?? [false, false],
      noPlantBonus: extra.noPlantBonus ?? [false, false],
      flameOwner: extra.flameOwner ?? [],
      // bugv34：黑夜 / 天气状态
      nightPhase: extra.nightPhase ?? 'none',
      nightCountdown: extra.nightCountdown ?? 0,
      nightTurns: extra.nightTurns ?? 0,
      turnsSinceNight: extra.turnsSinceNight ?? 999,
      weather: extra.weather ?? null,
      attacksLaunched: extra.attacksLaunched ?? [0, 0],
      nightAttackBase: extra.nightAttackBase ?? [0, 0],
      nightFromStart: extra.nightFromStart ?? false,
      // bugv34m：Qwen 的两个技能状态
      deploy: extra.deploy ?? [false, false],
      deployBonus: extra.deployBonus ?? [0, 0],
      redeployPending: extra.redeployPending ?? [[], []],
    }
  }

  // -------------------------------------------------------------------------
  // 裁决
  // -------------------------------------------------------------------------

  /** 处理一次 `move`（普通落子与防守落子共用）。 */
  applyMove(playerId: string, cell: number): MoveResult {
    if (this.status !== 'active') {
      return fail('notInMatch', `对局已${this.status === 'finished' ? '结束' : '作废'}`)
    }
    const seat = this.seatOf(playerId)
    if (seat === null) return fail('notInMatch', '你不在这局对局中')

    const phase = this.engine.phase
    if (phase !== 'playing' && phase !== 'awaitingDefense') {
      return fail('illegalMove', `当前阶段 ${phase} 不接受落子`)
    }
    if (!Number.isInteger(cell) || cell < 0 || cell >= CELL_COUNT) {
      return fail('illegalMove', `落点 ${cell} 越界（应为 0..${CELL_COUNT - 1} 的整数）`)
    }
    if (this.engine.current !== seat) {
      return fail('notYourTurn', `还没轮到你（当前为座位 ${this.engine.current}）`)
    }
    if (this.engine.board[cell] !== 0) {
      return fail('illegalMove', `位置 ${cell} 已有棋子`)
    }

    const kind: MoveKind = phase === 'awaitingDefense' ? 'defend' : 'place'
    let events: GameEvent[]
    try {
      events = kind === 'defend' ? this.engine.defend(cell) : this.engine.commit(cell)
    } catch (error) {
      // 引擎抛错一律转成 illegalMove（PROTOCOL.md 第 4 节）
      return fail('illegalMove', errorMessage(error))
    }

    this.lastActivityAt = this.clock()
    this.seq += 1
    // 快照口径与前端 useConnectGame 完全一致：
    // 先落子 -> 成线则移除攻击方棋子并留高光 -> 防守方落子 -> 结算移除防守方连珠棋子
    // -> 最后记录 board / hp。这里在"全部事件处理完"之后取快照，天然满足。
    this.steps.push({
      player: seat,
      cell,
      defense: kind === 'defend',
      match: events.some((event) => event.type === 'matchFormed'),
      board: this.engine.board.slice(),
      hp: [this.engine.hp[0], this.engine.hp[1]],
      // 魔力植物也进快照（bugv8 #4）：回放要能原样重现植物
      magic: [...this.engine.magic.values()].map((plant) => ({ ...plant })),
      // 技能状态每一步都记（bugv10 #11）：回放跳步要能恢复护盾 / 冷却 / 烈焰 / 叠子
      extra: this.skillExtra(),
    })

    const finished = this.engine.isOver
    const result: GameResult | null = finished ? this.engine.result : null
    const applied: AppliedMessage = {
      t: 'applied',
      matchId: this.id,
      seq: this.seq,
      seat,
      kind,
      cell,
      hp: [this.engine.hp[0], this.engine.hp[1]],
      current: this.engine.current,
      phase: this.engine.phase,
      digest: this.digest(),
      result,
    }

    if (!finished || !result) {
      return { ok: true, room: this, applied, gameOver: null, replay: null }
    }

    this.status = 'finished'
    this.statusChangedAt = this.clock()
    const gameOver: GameOverMessage = { t: 'gameOver', matchId: this.id, result, replayId: this.id }
    return { ok: true, room: this, applied, gameOver, replay: this.toReplayDoc() }
  }

  /**
   * 处理一次 `skill`（bugv10 #11：角色技能联机）。
   *
   * 裁决口径与落子一致：先卡「是不是你的回合」，再交给 `engine.useSkill()`；
   * 引擎抛错一律转成 `illegalMove`，失败时**不广播、不推进 seq**。
   */
  applySkill(playerId: string, slot: number, cells: readonly number[], target: number | null): MoveResult {
    if (this.status !== 'active') {
      return fail('notInMatch', `对局已${this.status === 'finished' ? '结束' : '作废'}`)
    }
    const seat = this.seatOf(playerId)
    if (seat === null) return fail('notInMatch', '你不在这局对局中')
    if (this.engine.current !== seat) {
      return fail('notYourTurn', `还没轮到你（当前为座位 ${this.engine.current}）`)
    }

    try {
      this.engine.useSkill(seat, slot, cells, target)
    } catch (error) {
      // 引擎抛错一律转成 illegalMove（PROTOCOL.md 第 4 节）
      return fail('illegalMove', errorMessage(error))
    }

    this.lastActivityAt = this.clock()
    this.seq += 1
    this.steps.push({
      player: seat,
      // 技能没有落子：用目标格占位（不需要目标的技能为 -1），与 applied.cell 一致
      cell: target ?? -1,
      defense: false,
      match: false,
      board: this.engine.board.slice(),
      hp: [this.engine.hp[0], this.engine.hp[1]],
      magic: [...this.engine.magic.values()].map((plant) => ({ ...plant })),
      skill: { slot, cells: [...cells], target },
      extra: this.skillExtra(),
    })

    const finished = this.engine.isOver
    const result: GameResult | null = finished ? this.engine.result : null
    const applied: AppliedMessage = {
      t: 'applied',
      matchId: this.id,
      seq: this.seq,
      seat,
      kind: 'skill',
      cell: target ?? -1,
      slot,
      cells: [...cells],
      target,
      hp: [this.engine.hp[0], this.engine.hp[1]],
      current: this.engine.current,
      phase: this.engine.phase,
      digest: this.digest(),
      result,
    }

    if (!finished || !result) {
      return { ok: true, room: this, applied, gameOver: null, replay: null }
    }

    this.status = 'finished'
    this.statusChangedAt = this.clock()
    const gameOver: GameOverMessage = { t: 'gameOver', matchId: this.id, result, replayId: this.id }
    return { ok: true, room: this, applied, gameOver, replay: this.toReplayDoc() }
  }

  /** 认输：立即结束对局（判负），其余照常落库与广播 `gameOver`。 */
  resign(playerId: string): FinishOutcome | MoveFailure {
    if (this.status !== 'active') return fail('notInMatch', `对局已${this.status === 'finished' ? '结束' : '作废'}`)
    const seat = this.seatOf(playerId)
    if (seat === null) return fail('notInMatch', '你不在这局对局中')

    const result: GameResult = {
      winner: other(seat),
      reason: 'hp',
      hp: [this.engine.hp[0], this.engine.hp[1]],
    }
    this.engine.phase = 'gameOver'
    this.engine.result = result
    this.status = 'finished'
    this.statusChangedAt = this.clock()
    this.gameOverMessage = { t: 'gameOver', matchId: this.id, result, replayId: this.id }
    return { ok: true, room: this, gameOver: this.gameOverMessage, replay: this.toReplayDoc() }
  }

  private gameOverMessage: GameOverMessage | null = null

  /** 一方断开 / 主动离开：标记作废（不作回放），另一方收 `opponentLeft`。 */
  abandon(playerId: string, reason: 'disconnect' | 'leave'): { opponent: MatchPlayer; message: ServerMessage } | null {
    if (this.status !== 'active') return null
    const opponent = this.opponentOf(playerId)
    if (!opponent) return null
    this.status = 'abandoned'
    this.statusChangedAt = this.clock()
    return {
      opponent,
      message: { t: 'opponentLeft', matchId: this.id, reason },
    }
  }

  /**
   * 本局双方的登录账号（bugv34k）。没登录 / 拿不到账号的会被过滤掉。
   *
   * 回放列表优先按账号过滤，这样"同一账号换设备"也看得到自己的对局。
   */
  private accounts(): string[] | undefined {
    const list = this.players
      .map((player) => player.account)
      .filter((account): account is string => typeof account === 'string' && account !== '')
    if (list.length === 0) return undefined
    return [...new Set(list)]
  }

  /** 生成与 PROTOCOL.md 第 5 节一致的落库文档。 */
  toReplayDoc(now: number = this.clock()): ReplayDoc {
    const result: GameResult =
      this.engine.result ?? {
        winner: null,
        reason: 'boardFull',
        hp: [this.engine.hp[0], this.engine.hp[1]],
      }
    const players: ReplayPlayer[] = this.players.map((player) => ({
      playerId: player.playerId,
      name: player.name,
      seat: player.seat,
    }))
    return {
      _id: this.id,
      matchId: this.id,
      mode: 'online',
      createdAt: this.createdAt,
      finishedAt: now,
      durationMs: Math.max(0, now - this.createdAt),
      players,
      playerIds: [this.players[0].playerId, this.players[1].playerId],
      // bugv34k：回放挂到**账号**上（能拿到就写，未登录的老客户端为 undefined）
      accounts: this.accounts(),
      dice: { rolls: [this.dice.rolls[0], this.dice.rolls[1]], first: this.dice.first },
      // 角色要落库（bugv10 #11）：老对局从存档恢复时按它重建技能表
      characters: [this.characters[0], this.characters[1]],
      steps: this.steps.map((step) => ({
        player: step.player,
        cell: step.cell,
        defense: step.defense,
        match: step.match,
        board: [...step.board],
        hp: [step.hp[0], step.hp[1]] as [number, number],
        magic: (step.magic ?? []).map((plant) => ({ ...plant })),
        // 技能参数只写在技能步上（bugv10 #11）
        ...(step.skill
          ? { skill: { slot: step.skill.slot, cells: [...step.skill.cells], target: step.skill.target } }
          : {}),
        ...(step.extra
          ? {
              extra: {
                shield: [step.extra.shield[0], step.extra.shield[1]] as [number, number],
                bonusActions: [step.extra.bonusActions[0], step.extra.bonusActions[1]] as [number, number],
                actionsTaken: [step.extra.actionsTaken[0], step.extra.actionsTaken[1]] as [number, number],
                skillReadyAt: [[...step.extra.skillReadyAt[0]], [...step.extra.skillReadyAt[1]]] as [
                  number[],
                  number[],
                ],
                turnNo: step.extra.turnNo,
                immuneUntil: [step.extra.immuneUntil[0], step.extra.immuneUntil[1]] as [number, number],
                flames: step.extra.flames.map((entry): [number, number] => [entry[0], entry[1]]),
                overlay: step.extra.overlay.map((entry): [number, number] => [entry[0], entry[1]]),
                lastPlacedBy: [step.extra.lastPlacedBy[0], step.extra.lastPlacedBy[1]] as [number | null, number | null],
                ...(step.extra.twinStar
                  ? { twinStar: [step.extra.twinStar[0], step.extra.twinStar[1]] as [boolean, boolean] }
                  : {}),
                ...(step.extra.skillCasts
                  ? {
                      skillCasts: [[...step.extra.skillCasts[0]], [...step.extra.skillCasts[1]]] as [
                        number[],
                        number[],
                      ],
                    }
                  : {}),
              },
            }
          : {}),
      })),
      result,
      playerNames: [this.players[0].name, this.players[1].name],
    }
  }

  /** 是否可被回收。 */
  isExpired(now: number, activeTtlMs: number, abandonedTtlMs: number): boolean {
    if (this.status === 'active') return now - this.lastActivityAt > activeTtlMs
    if (this.status === 'abandoned') return now - this.statusChangedAt > abandonedTtlMs
    return now - this.statusChangedAt > activeTtlMs
  }
}

export interface MatchManagerOptions {
  /** 活跃 / 已结束对局在内存中的保留时长。 */
  ttlMs: number
  /** 作废对局的保留时长（默认 5 分钟）。 */
  abandonedTtlMs?: number
  /** 对局结束（含认输）时回调，用于把回放落库。 */
  onMatchFinished?: (replay: ReplayDoc) => void | Promise<void>
  logger?: { info(message: string, ...args: unknown[]): void; warn(message: string, ...args: unknown[]): void }
  now?: () => number
}

export interface AbandonOutcome {
  readonly ok: true
  readonly room: MatchRoom
  readonly opponent: MatchPlayer
  readonly message: ServerMessage
}

/** 对局登记表：创建、查询、作废、回收。 */
export class MatchManager {
  private readonly rooms = new Map<string, MatchRoom>()
  private readonly byPlayer = new Map<string, string>()
  private readonly now: () => number

  constructor(private readonly options: MatchManagerOptions) {
    this.now = options.now ?? (() => Date.now())
  }

  get size(): number {
    return this.rooms.size
  }

  get activeCount(): number {
    let count = 0
    for (const room of this.rooms.values()) if (room.status === 'active') count += 1
    return count
  }

  /**
   * 开一局。
   *
   * `characters` 用于"从存档恢复对局"：显式传入优先，否则取两名参与者各自选择的角色
   * （`Participant.character`，见 bugv10 #11）；两者都没有 / 非法时按座位退回默认角色。
   */
  create(
    host: Participant,
    guest: Participant,
    code: string | null,
    characters?: readonly (string | null | undefined)[] | null,
    settings?: RoomSettings,
  ): MatchRoom {
    this.releasePlayers([host.playerId, guest.playerId])
    const room = new MatchRoom({
      host,
      guest,
      code,
      now: this.now,
      characters: characters ?? [host.character, guest.character],
      settings: settings ?? DEFAULT_ROOM_SETTINGS,
    })
    this.rooms.set(room.id, room)
    for (const player of room.players) this.byPlayer.set(player.playerId, room.id)
    this.options.logger?.info(
      `开局 ${room.id}（${code ? `匹配码 ${code}` : '在线匹配'}）骰子 ${room.dice.rolls[0]}:${room.dice.rolls[1]}，先手座位 ${room.dice.first}，角色 ${room.characters[0]}/${room.characters[1]}`,
    )
    return room
  }

  get(matchId: string): MatchRoom | null {
    return this.rooms.get(matchId) ?? null
  }

  roomOfPlayer(playerId: string): MatchRoom | null {
    const matchId = this.byPlayer.get(playerId)
    return matchId ? this.rooms.get(matchId) ?? null : null
  }

  /** 落子（含结束时的回放落库）。 */
  move(playerId: string, matchId: string, cell: number): MoveResult {
    const room = this.rooms.get(matchId)
    if (!room) return fail('notInMatch', `对局 ${matchId} 不存在或已回收`)
    if (room.seatOf(playerId) === null) return fail('notInMatch', '你不在这局对局中')
    const outcome = room.applyMove(playerId, cell)
    if (outcome.ok && outcome.replay) void this.persist(outcome.replay)
    return outcome
  }

  /** 使用角色技能（bugv10 #11，含结束时的回放落库）。 */
  skill(playerId: string, matchId: string, slot: number, cells: readonly number[], target: number | null): MoveResult {
    const room = this.rooms.get(matchId)
    if (!room) return fail('notInMatch', `对局 ${matchId} 不存在或已回收`)
    if (room.seatOf(playerId) === null) return fail('notInMatch', '你不在这局对局中')
    const outcome = room.applySkill(playerId, slot, cells, target)
    if (outcome.ok && outcome.replay) void this.persist(outcome.replay)
    return outcome
  }

  /** 完整局面（`sync`）。 */
  state(playerId: string, matchId: string): StateMessage | MoveFailure {
    const room = this.rooms.get(matchId)
    if (!room) return fail('notInMatch', `对局 ${matchId} 不存在或已回收`)
    if (room.seatOf(playerId) === null) return fail('notInMatch', '你不在这局对局中')
    return room.stateFor(playerId)
  }

  resign(playerId: string, matchId: string): FinishOutcome | MoveFailure {
    const room = this.rooms.get(matchId)
    if (!room) return fail('notInMatch', `对局 ${matchId} 不存在或已回收`)
    const outcome = room.resign(playerId)
    if (outcome.ok && outcome.replay) void this.persist(outcome.replay)
    return outcome
  }

  /** 主动离开对局。 */
  leave(playerId: string, matchId: string): AbandonOutcome | MoveFailure {
    const room = this.rooms.get(matchId)
    if (!room) return fail('notInMatch', `对局 ${matchId} 不存在或已回收`)
    return this.abandon(playerId, matchId, 'leave')
  }

  /** 断开连接。 */
  disconnect(playerId: string): AbandonOutcome | null {
    const matchId = this.byPlayer.get(playerId)
    if (!matchId) return null
    const outcome = this.abandon(playerId, matchId, 'disconnect')
    this.byPlayer.delete(playerId)
    return outcome.ok ? outcome : null
  }

  /** 玩家换了连接：把对局里的广播目标换成新连接（见 `MatchRoom.rebind`）。 */
  rebind(playerId: string, participant: Participant): MatchRoom | null {
    const matchId = this.byPlayer.get(playerId)
    if (!matchId) return null
    const room = this.rooms.get(matchId)
    if (!room) return null
    return room.rebind(playerId, participant) ? room : null
  }

  private abandon(playerId: string, matchId: string, reason: 'disconnect' | 'leave'): AbandonOutcome | MoveFailure {
    const room = this.rooms.get(matchId)
    if (!room) return fail('notInMatch', `对局 ${matchId} 不存在或已回收`)
    const result = room.abandon(playerId, reason)
    if (!result) return fail('notInMatch', '对局已结束或你已不在其中')
    const opponent = result.opponent
    try {
      opponent.send(result.message)
    } catch {
      /* 对手可能也已经断开 */
    }
    this.byPlayer.delete(playerId)
    this.options.logger?.info(`对局 ${matchId} 因 ${reason} 作废，${opponent.name} 收到 opponentLeft`)
    return { ok: true, room, opponent, message: result.message }
  }

  /** 玩家进入新的匹配/房间前，先释放旧的对局登记（不通知对手）。 */
  private releasePlayers(playerIds: string[]): void {
    for (const playerId of playerIds) this.byPlayer.delete(playerId)
  }

  /** 回收过期对局，返回回收数量。 */
  sweep(): number {
    const now = this.now()
    const abandonedTtl = this.options.abandonedTtlMs ?? ABANDONED_MATCH_TTL_MS
    let removed = 0
    for (const [matchId, room] of this.rooms) {
      if (!room.isExpired(now, this.options.ttlMs, abandonedTtl)) continue
      this.rooms.delete(matchId)
      for (const player of room.players) {
        if (this.byPlayer.get(player.playerId) === matchId) this.byPlayer.delete(player.playerId)
      }
      removed += 1
    }
    return removed
  }

  private async persist(replay: ReplayDoc): Promise<void> {
    try {
      await this.options.onMatchFinished?.(replay)
    } catch (error) {
      this.options.logger?.warn(`回放落库失败 ${replay.matchId}：${errorMessage(error)}`)
    }
  }
}
