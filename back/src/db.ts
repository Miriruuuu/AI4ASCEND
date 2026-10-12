/**
 * 持久层：`Repository` 接口 + `MongoRepository` + `MemoryRepository`。
 *
 * - `DB_MODE=mongo` 且连接成功 -> 用 Mongo；
 * - `DB_MODE=memory` 或没有 `MONGODB_URI` -> 用内存仓储（并打醒目警告）；
 * - Mongo 连接失败会重试 `attempts` 次，仍然失败则抛出 `MongoUnavailableError`，
 *   由 `index.ts` 打印中文排查提示并退出。
 */
import { MongoClient, type Collection } from 'mongodb'
import type { AppConfig } from './config'
import type { Logger } from './logger'
import type { Dice, ReplayStep } from './protocol'
import type { CharacterId } from './core/characters'
import type { GameResult, PlayerIndex } from './core/types'

/** 回放里的玩家条目。 */
export interface ReplayPlayer {
  readonly playerId: string
  readonly name: string
  readonly seat: PlayerIndex
}

/** `replays` 集合的文档结构（见 PROTOCOL.md 第 5 节）。 */
export interface ReplayDoc {
  /** 与 matchId 相同，天然幂等。 */
  readonly _id: string
  readonly matchId: string
  readonly mode: 'online'
  readonly createdAt: number
  readonly finishedAt: number
  readonly durationMs: number
  readonly players: ReplayPlayer[]
  /** 便于建索引查询。 */
  readonly playerIds: string[]
  /**
   * 参与本局的**登录账号**（bugv34k）。老存档没有这个字段。
   *
   * 回放列表优先按它过滤 —— 账号才是"人"，`playerIds` 只是浏览器本地身份。
   */
  readonly accounts?: string[]
  readonly dice: Dice
  /** 双方角色，按座位索引（bugv10 #11；老对局没有这个字段）。 */
  readonly characters?: [CharacterId, CharacterId]
  /** 与前端 `MatchRecord.steps` 同构。 */
  readonly steps: ReplayStep[]
  readonly result: GameResult
  readonly playerNames: [string, string]
}

/**
 * `users` 集合的文档结构（bugv34i：最简账号体系）。
 *
 * 只做"联机需要登录"这一件事：账号 + 口令（散列 + 盐）+ 昵称 + 长期令牌。
 * 口令**永不存明文**；令牌用于"不退出登录就一直是登录态"。
 */
export interface UserDoc {
  /** 归一化后的账号（小写），作为主键。 */
  readonly _id: string
  /** 展示用账号（保留注册时输入的大小写）。 */
  readonly username: string
  /** 昵称（注册时填写；空则由服务端按 playerId 兜底）。 */
  nickname: string
  readonly passwordHash: string
  readonly salt: string
  readonly createdAt: number
  lastLoginAt: number
  /** 长期登录令牌（退出登录时清除）。 */
  token?: string
}

/** 用户文档的增量更新（`token: null` 表示清除令牌 = 退出登录）。 */
export interface UserPatch {
  nickname?: string
  lastLoginAt?: number
  token?: string | null
}

export interface RepoStats {
  readonly replays: number
  readonly players: number
  /** 注册账号数（bugv34i）。 */
  readonly users: number
}

export interface Repository {
  readonly kind: 'mongo' | 'memory'
  /** 幂等写入（`_id = matchId`）。 */
  saveReplay(doc: ReplayDoc): Promise<void>
  getReplay(id: string): Promise<ReplayDoc | null>
  /** 按 `createdAt` 倒序。传 `account` 时优先按账号过滤（bugv34k）。 */
  listReplays(query: { playerId?: string; account?: string; limit: number }): Promise<ReplayDoc[]>
  /** 按账号（已归一化为小写）取用户。 */
  getUser(username: string): Promise<UserDoc | null>
  createUser(doc: UserDoc): Promise<void>
  updateUser(username: string, patch: UserPatch): Promise<void>
  /** 按长期令牌取用户（令牌无效 / 已被清除时返回 null）。 */
  getUserByToken(token: string): Promise<UserDoc | null>
  stats(): Promise<RepoStats>
  close(): Promise<void>
}

/** Mongo 不可用（重试耗尽）。 */
export class MongoUnavailableError extends Error {
  constructor(
    message: string,
    readonly uri: string,
    readonly attempts: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'MongoUnavailableError'
  }
}

/** 打印连接串时抹掉密码，避免日志泄露。 */
export function maskMongoUri(uri: string): string {
  return uri.replace(/\/\/([^:@/]+):([^@/]*)@/, (_match, user: string) => `//${user}:****@`)
}

function cloneReplay(doc: ReplayDoc): ReplayDoc {
  return {
    ...doc,
    players: doc.players.map((player) => ({ ...player })),
    playerIds: [...doc.playerIds],
    accounts: doc.accounts ? [...doc.accounts] : undefined,
    dice: { rolls: [doc.dice.rolls[0], doc.dice.rolls[1]], first: doc.dice.first },
    characters: doc.characters ? [doc.characters[0], doc.characters[1]] : undefined,
    steps: doc.steps.map((step) => ({
      player: step.player,
      cell: step.cell,
      defense: step.defense,
      match: step.match,
      board: [...step.board],
      hp: [step.hp[0], step.hp[1]] as [number, number],
      // bugv8 #4：魔力植物也要原样带出去，否则 REST 拿到的回放放不出植物
      magic: step.magic ? step.magic.map((plant) => ({ ...plant })) : undefined,
      // bugv10 #11：技能步参数与每一步的技能状态快照
      skill: step.skill ? { slot: step.skill.slot, cells: [...step.skill.cells], target: step.skill.target } : undefined,
      extra: step.extra
        ? {
            shield: [step.extra.shield[0], step.extra.shield[1]] as [number, number],
            bonusActions: [step.extra.bonusActions[0], step.extra.bonusActions[1]] as [number, number],
            actionsTaken: [step.extra.actionsTaken[0], step.extra.actionsTaken[1]] as [number, number],
            skillReadyAt: [[...step.extra.skillReadyAt[0]], [...step.extra.skillReadyAt[1]]] as [number[], number[]],
            turnNo: step.extra.turnNo,
            immuneUntil: [step.extra.immuneUntil[0], step.extra.immuneUntil[1]] as [number, number],
            flames: step.extra.flames.map((entry): [number, number] => [entry[0], entry[1]]),
            overlay: step.extra.overlay.map((entry): [number, number] => [entry[0], entry[1]]),
            lastPlacedBy: [step.extra.lastPlacedBy[0], step.extra.lastPlacedBy[1]] as [number | null, number | null],
            // bugv11 #5/#6（老存档没有这几项）
            twinStar: step.extra.twinStar
              ? ([step.extra.twinStar[0], step.extra.twinStar[1]] as [boolean, boolean])
              : undefined,
            skillCasts: step.extra.skillCasts
              ? ([[...step.extra.skillCasts[0]], [...step.extra.skillCasts[1]]] as [number[], number[]])
              : undefined,
            // bugv27 #4：新角色的技能状态（老存档没有这几项）
            powerUntil: step.extra.powerUntil
              ? ([step.extra.powerUntil[0], step.extra.powerUntil[1]] as [number, number])
              : undefined,
            sabotage: step.extra.sabotage
              ? ([step.extra.sabotage[0], step.extra.sabotage[1]] as [boolean, boolean])
              : undefined,
            sabotageBonus: step.extra.sabotageBonus
              ? ([step.extra.sabotageBonus[0], step.extra.sabotageBonus[1]] as [number, number])
              : undefined,
            bloomCheaperNext: step.extra.bloomCheaperNext
              ? ([step.extra.bloomCheaperNext[0], step.extra.bloomCheaperNext[1]] as [boolean, boolean])
              : undefined,
            tempArmor: step.extra.tempArmor
              ? ([step.extra.tempArmor[0], step.extra.tempArmor[1]] as [number, number])
              : undefined,
            tempArmorUntil: step.extra.tempArmorUntil
              ? ([step.extra.tempArmorUntil[0], step.extra.tempArmorUntil[1]] as [number, number])
              : undefined,
            strikeBonus: step.extra.strikeBonus
              ? ([step.extra.strikeBonus[0], step.extra.strikeBonus[1]] as [number, number])
              : undefined,
            strikeUntil: step.extra.strikeUntil
              ? ([step.extra.strikeUntil[0], step.extra.strikeUntil[1]] as [number, number])
              : undefined,
            seedGrow: step.extra.seedGrow
              ? ([step.extra.seedGrow[0], step.extra.seedGrow[1]] as [boolean, boolean])
              : undefined,
            noPlantBonus: step.extra.noPlantBonus
              ? ([step.extra.noPlantBonus[0], step.extra.noPlantBonus[1]] as [boolean, boolean])
              : undefined,
            flameOwner: step.extra.flameOwner
              ? step.extra.flameOwner.map((entry): [number, number] => [entry[0], entry[1]])
              : undefined,
            // bugv34：黑夜 / 天气状态（老存档没有这几项）。
            // ⚠️ 这里以前漏了 —— 存进库再读出来的回放会丢掉黑夜状态，
            // 拖到"已入夜"的那一步时演出还是白天（bugv34m 一并补上）。
            nightPhase: step.extra.nightPhase,
            nightCountdown: step.extra.nightCountdown,
            nightTurns: step.extra.nightTurns,
            turnsSinceNight: step.extra.turnsSinceNight,
            weather: step.extra.weather,
            attacksLaunched: step.extra.attacksLaunched
              ? ([step.extra.attacksLaunched[0], step.extra.attacksLaunched[1]] as [number, number])
              : undefined,
            nightAttackBase: step.extra.nightAttackBase
              ? ([step.extra.nightAttackBase[0], step.extra.nightAttackBase[1]] as [number, number])
              : undefined,
            nightFromStart: step.extra.nightFromStart,
            // bugv34m：Qwen 的两个技能状态
            deploy: step.extra.deploy
              ? ([step.extra.deploy[0], step.extra.deploy[1]] as [boolean, boolean])
              : undefined,
            deployBonus: step.extra.deployBonus
              ? ([step.extra.deployBonus[0], step.extra.deployBonus[1]] as [number, number])
              : undefined,
            redeployPending: step.extra.redeployPending
              ? ([
                  [...step.extra.redeployPending[0]],
                  [...step.extra.redeployPending[1]],
                ] as [number[], number[]])
              : undefined,
          }
        : undefined,
    })),
    result: {
      winner: doc.result.winner,
      reason: doc.result.reason,
      hp: [doc.result.hp[0], doc.result.hp[1]] as [number, number],
    },
    playerNames: [doc.playerNames[0], doc.playerNames[1]],
  }
}

// ---------------------------------------------------------------------------
// 内存仓储
// ---------------------------------------------------------------------------

export class MemoryRepository implements Repository {
  readonly kind = 'memory' as const
  private readonly replays = new Map<string, ReplayDoc>()
  private readonly users = new Map<string, UserDoc>()
  /** 令牌 -> 账号（登录态查询用）。 */
  private readonly tokens = new Map<string, string>()

  async saveReplay(doc: ReplayDoc): Promise<void> {
    this.replays.set(doc._id, cloneReplay(doc))
  }

  async getUser(username: string): Promise<UserDoc | null> {
    const found = this.users.get(username)
    return found ? { ...found } : null
  }

  async createUser(doc: UserDoc): Promise<void> {
    this.users.set(doc._id, { ...doc })
    if (doc.token) this.tokens.set(doc.token, doc._id)
  }

  async updateUser(username: string, patch: UserPatch): Promise<void> {
    const user = this.users.get(username)
    if (!user) return
    if (patch.token !== undefined) {
      if (user.token) this.tokens.delete(user.token)
      if (patch.token === null) delete user.token
      else {
        user.token = patch.token
        this.tokens.set(patch.token, username)
      }
    }
    if (patch.nickname !== undefined) user.nickname = patch.nickname
    if (patch.lastLoginAt !== undefined) user.lastLoginAt = patch.lastLoginAt
  }

  async getUserByToken(token: string): Promise<UserDoc | null> {
    const username = this.tokens.get(token)
    if (!username) return null
    const user = this.users.get(username)
    return user && user.token === token ? { ...user } : null
  }

  async getReplay(id: string): Promise<ReplayDoc | null> {
    const found = this.replays.get(id)
    return found ? cloneReplay(found) : null
  }

  async listReplays(query: { playerId?: string; account?: string; limit: number }): Promise<ReplayDoc[]> {
    const all = [...this.replays.values()]
      .filter((doc) => (query.account ? (doc.accounts ?? []).includes(query.account) : true))
      .filter((doc) => (!query.account && query.playerId ? doc.playerIds.includes(query.playerId) : true))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, query.limit)
    return all.map(cloneReplay)
  }

  async stats(): Promise<RepoStats> {
    const players = new Set<string>()
    for (const doc of this.replays.values()) {
      for (const playerId of doc.playerIds) players.add(playerId)
    }
    return { replays: this.replays.size, players: players.size, users: this.users.size }
  }

  async close(): Promise<void> {
    this.replays.clear()
    this.users.clear()
    this.tokens.clear()
  }
}

// ---------------------------------------------------------------------------
// Mongo 仓储
// ---------------------------------------------------------------------------

export class MongoRepository implements Repository {
  readonly kind = 'mongo' as const

  private constructor(
    private readonly client: MongoClient,
    private readonly replays: Collection<ReplayDoc>,
    private readonly users: Collection<UserDoc>,
  ) {}

  static async connect(
    config: AppConfig,
    logger: Logger,
    options: { attempts?: number; delayMs?: number } = {},
  ): Promise<MongoRepository> {
    const uri = config.mongodbUri
    if (!uri) throw new MongoUnavailableError('未配置 MONGODB_URI', '', 0)

    const attempts = Math.max(1, options.attempts ?? 3)
    const delayMs = Math.max(0, options.delayMs ?? 2000)
    let lastError: unknown = null

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
        socketTimeoutMS: 20000,
      })
      try {
        logger.info(`正在连接 MongoDB（第 ${attempt}/${attempts} 次）：${maskMongoUri(uri)}`)
        await client.connect()
        const db = client.db(config.dbName)
        const replays = db.collection<ReplayDoc>('replays')
        // 索引：按玩家查询 / 按时间倒序
        await replays.createIndex({ playerIds: 1, createdAt: -1 }, { name: 'playerIds_createdAt' })
        await replays.createIndex({ accounts: 1, createdAt: -1 }, { name: 'accounts_createdAt', sparse: true })
        await replays.createIndex({ createdAt: -1 }, { name: 'createdAt' })
        // bugv34i：账号表（`_id` 就是归一化账号，天然唯一）
        const users = db.collection<UserDoc>('users')
        await users.createIndex({ token: 1 }, { name: 'token', sparse: true })
        logger.info(`MongoDB 连接成功：库 ${config.dbName}，集合 replays / users 索引就绪`)
        return new MongoRepository(client, replays, users)
      } catch (error) {
        lastError = error
        logger.warn(`MongoDB 连接失败（第 ${attempt}/${attempts} 次）：${(error as Error).message}`)
        await client.close().catch(() => undefined)
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }

    throw new MongoUnavailableError(
      `MongoDB 连续 ${attempts} 次连接失败：${(lastError as Error)?.message ?? '未知错误'}`,
      uri,
      attempts,
      { cause: lastError },
    )
  }

  async saveReplay(doc: ReplayDoc): Promise<void> {
    await this.replays.replaceOne({ _id: doc._id }, doc, { upsert: true })
  }

  async getReplay(id: string): Promise<ReplayDoc | null> {
    const found = await this.replays.findOne({ _id: id })
    return found ? cloneReplay(found) : null
  }

  async listReplays(query: { playerId?: string; account?: string; limit: number }): Promise<ReplayDoc[]> {
    // 有账号就按账号查（人 ≠ 浏览器），否则退回按本地 playerId 查（老数据 / 未登录调用）
    const filter = query.account
      ? { accounts: query.account }
      : query.playerId
        ? { playerIds: query.playerId }
        : {}
    const found = await this.replays.find(filter).sort({ createdAt: -1 }).limit(query.limit).toArray()
    return found.map(cloneReplay)
  }

  async getUser(username: string): Promise<UserDoc | null> {
    return (await this.users.findOne({ _id: username })) ?? null
  }

  async createUser(doc: UserDoc): Promise<void> {
    await this.users.insertOne({ ...doc })
  }

  async updateUser(username: string, patch: UserPatch): Promise<void> {
    const set: Record<string, unknown> = {}
    const unset: Record<string, ''> = {}
    if (patch.nickname !== undefined) set.nickname = patch.nickname
    if (patch.lastLoginAt !== undefined) set.lastLoginAt = patch.lastLoginAt
    if (patch.token === null) unset.token = ''
    else if (patch.token !== undefined) set.token = patch.token
    const update: Record<string, unknown> = {}
    if (Object.keys(set).length > 0) update.$set = set
    if (Object.keys(unset).length > 0) update.$unset = unset
    if (Object.keys(update).length === 0) return
    await this.users.updateOne({ _id: username }, update)
  }

  async getUserByToken(token: string): Promise<UserDoc | null> {
    return (await this.users.findOne({ token })) ?? null
  }

  async stats(): Promise<RepoStats> {
    const replays = await this.replays.countDocuments()
    const raw = (await this.replays.distinct('playerIds')) as unknown[]
    const users = await this.users.countDocuments()
    return { replays, players: raw.length, users }
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}

/** 依据配置选择仓储实现。 */
export async function createRepository(
  config: AppConfig,
  logger: Logger,
  options?: { attempts?: number; delayMs?: number },
): Promise<Repository> {
  if (config.effectiveDbMode === 'memory') {
    if (config.dbMode === 'mongo') {
      logger.warn('未配置 MONGODB_URI，已自动降级为内存模式（重启即丢数据）')
    }
    return new MemoryRepository()
  }
  return MongoRepository.connect(config, logger, options)
}
