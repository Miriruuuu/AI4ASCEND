/**
 * 房间（大厅）（bugv34e）。
 *
 * 联机流程从"匹配成功即开局"改成：
 *
 * ```
 * 在线匹配 / 建房 / 加入房间  →  进入房间（lobby）
 *   ├─ 房主：改房间设置、点「开始游戏」
 *   ├─ 所有人：选角色、发聊天
 *   └─ 房主可转让房主
 * 房主点开始  →  开局（playing）→ 结束 → 回到房间（lobby，比分累计）
 * ```
 *
 * 关键约束（用户口径）：
 * - 房间内**只有成员手动退出**才移出成员；**断线只标记离线**，可以凭房间号回来；
 * - 房间只要还有成员，就保留**比分与聊天记录**；
 * - 所有成员都退出后，房间数据（比分 / 聊天）**完全销毁**。
 *
 * 本模块只负责"房间"这一层：成员、房主、设置、聊天、比分、生命周期。
 * 真正的对局裁决仍在 `match.ts`（`MatchRoom` / `MatchManager`）。
 */
import { DEFAULT_CHARACTERS, isCharacterId, type CharacterId } from './core/characters'
import { DEFAULT_MAGIC_CONFIG, DEFAULT_NIGHT_CONFIG, INITIAL_HP, type MagicConfig, type NightConfig } from './core/types'
import { generateCode, normalizeCode, type Participant } from './matching'
import type { RoomChatEntry, RoomMemberInfo, RoomSettings, RoomSettingsPatch } from './protocol'

/** 房间容纳的人数（四子棋只有两方）。 */
export const ROOM_CAPACITY = 2

/** 聊天记录最多保留的条数（超出丢弃最旧的）。 */
export const ROOM_CHAT_LIMIT = 120

/** 单条聊天最长字符数。 */
export const ROOM_CHAT_MAX_LENGTH = 120

/** 默认房间设置（血量上限用引擎默认值、魔力植物与黑夜都用默认配置）。 */
export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  hpLimit: INITIAL_HP,
  magic: DEFAULT_MAGIC_CONFIG,
  night: DEFAULT_NIGHT_CONFIG,
}

/** 血量上限可选项（与单机「对局偏好」一致）。 */
export const ROOM_HP_LIMITS: readonly number[] = [8, 12, 16]

export type RoomPhase = 'lobby' | 'playing'

/** 房间成员（服务端内部结构）。 */
export interface RoomMember {
  readonly playerId: string
  name: string
  character: CharacterId
  /** 是否在线。断线后仍留在房间里，标记为 `false`。 */
  connected: boolean
  /** 加入顺序（房主转让 / 推举新房主时按它取最早加入的）。 */
  readonly joinedAt: number
  /** 累计胜场（房间销毁即清零）。 */
  wins: number
  /** 是否已点「准备」（bugv34i：双方都准备才开局）。 */
  ready: boolean
}

export interface RoomSnapshotOptions {
  /** 收信者（用于填 `you` / `host`）。 */
  readonly viewerId: string
}

/**
 * 一个房间。
 *
 * ⚠️ 不持有 `MatchRoom`：对局由 `MatchManager` 持有，房间只记 `matchId`。
 * 这样"对局被回收"与"房间被销毁"是两条独立的生命周期。
 */
export class Room {
  readonly code: string
  readonly createdAt: number
  readonly members = new Map<string, RoomMember>()
  readonly chat: RoomChatEntry[] = []
  settings: RoomSettings
  phase: RoomPhase = 'lobby'
  /** `playing` 时的对局 id。 */
  matchId: string | null = null
  /** 谁先手（开局时服务端掷骰决定，战绩显示用）。 */
  lastActivityAt: number
  private chatSeq = 0
  private hostId: string

  constructor(code: string, host: Participant, now: number) {
    this.code = code
    this.createdAt = now
    this.lastActivityAt = now
    this.settings = { ...DEFAULT_ROOM_SETTINGS }
    this.hostId = host.playerId
    this.addMember(host, now)
  }

  get host(): string {
    return this.hostId
  }

  isHost(playerId: string): boolean {
    return this.hostId === playerId
  }

  member(playerId: string): RoomMember | null {
    return this.members.get(playerId) ?? null
  }

  get size(): number {
    return this.members.size
  }

  /**
   * 是否满足开局条件（bugv34i）：两人都在房间里、都在线、**且都已准备**。
   *
   * 满足时由 `ws.ts` 自动开局 —— 房间里不再有单独的「开始游戏」按钮。
   */
  get canStart(): boolean {
    return (
      this.phase === 'lobby' &&
      this.members.size === ROOM_CAPACITY &&
      [...this.members.values()].every((member) => member.connected && member.ready)
    )
  }

  /** 我准备好了吗。 */
  isReady(playerId: string): boolean {
    return this.members.get(playerId)?.ready === true
  }

  /** 切换准备状态；返回是否真的变化了。 */
  setReady(playerId: string, ready: boolean, now: number): boolean {
    const member = this.members.get(playerId)
    if (!member || member.ready === ready) return false
    member.ready = ready
    this.lastActivityAt = now
    return true
  }

  addMember(participant: Participant, now: number): RoomMember {
    const existing = this.members.get(participant.playerId)
    if (existing) {
      // 已经是成员：只更新连接信息（等价于"重连回房间"）。
      existing.connected = true
      if (participant.name) existing.name = participant.name
      this.lastActivityAt = now
      return existing
    }
    const member: RoomMember = {
      playerId: participant.playerId,
      name: participant.name || existingFallbackName(participant.playerId),
      character: isCharacterId(participant.character) ? participant.character : defaultCharacter(this.members.size),
      connected: true,
      joinedAt: now,
      wins: 0,
      ready: false,
    }
    this.members.set(member.playerId, member)
    this.lastActivityAt = now
    return member
  }

  /**
   * 显式退出房间（用户点了"退出房间"）。
   *
   * 返回是否因此**销毁**了房间（没有成员了）。
   */
  removeMember(playerId: string, now: number): { room: boolean; empty: boolean } {
    const removed = this.members.delete(playerId)
    this.lastActivityAt = now
    if (!removed) return { room: false, empty: false }
    if (this.members.size === 0) return { room: true, empty: true }
    // 房主退出 → 把房主交给最早加入的剩下成员
    if (this.hostId === playerId) this.hostId = this.earliestMemberId()
    return { room: true, empty: false }
  }

  /** 标记离线（断线；成员本身保留，可凭房间号回来）。 */
  markOffline(playerId: string, now: number): boolean {
    const member = this.members.get(playerId)
    if (!member || !member.connected) return false
    member.connected = false
    // 离线即取消准备：否则他重连回来会带着"上次的准备"把对局直接开起来
    member.ready = false
    this.lastActivityAt = now
    return true
  }

  /** 标记在线（重连回来 / 换了新连接）。 */
  markOnline(participant: Participant, now: number): boolean {
    const member = this.members.get(participant.playerId)
    if (!member) return false
    const changed = !member.connected
    member.connected = true
    if (participant.name) member.name = participant.name
    if (isCharacterId(participant.character)) member.character = participant.character
    this.lastActivityAt = now
    return changed
  }

  /** 转让房主；目标必须是房间成员。 */
  transferHost(toPlayerId: string, now: number): boolean {
    if (!this.members.has(toPlayerId)) return false
    this.hostId = toPlayerId
    this.lastActivityAt = now
    return true
  }

  /** 合并房间设置（房主已由调用方校验）。 */
  patchSettings(patch: RoomSettingsPatch, resolveMagic: (p: Partial<MagicConfig> | null) => MagicConfig, resolveNight: (p: Partial<NightConfig> | null) => NightConfig, now: number): RoomSettings {
    const next: RoomSettings = {
      hpLimit: this.settings.hpLimit,
      magic: this.settings.magic,
      night: this.settings.night,
    }
    if (patch.hpLimit !== undefined && Number.isFinite(patch.hpLimit)) {
      const wanted = Math.round(patch.hpLimit)
      next.hpLimit = ROOM_HP_LIMITS.includes(wanted) ? wanted : next.hpLimit
    }
    if (patch.magic) next.magic = resolveMagic({ ...this.settings.magic, ...patch.magic })
    if (patch.night) next.night = resolveNight({ ...this.settings.night, ...patch.night })
    this.settings = next
    this.lastActivityAt = now
    return next
  }

  /** 追加一条聊天；返回广播用的条目（空白文本返回 null）。 */
  pushChat(from: { playerId: string; name: string }, rawText: string, now: number): RoomChatEntry | null {
    const text = sanitizeChat(rawText)
    if (text === '') return null
    this.chatSeq += 1
    const entry: RoomChatEntry = {
      id: this.chatSeq,
      playerId: from.playerId,
      name: from.name,
      text,
      at: now,
    }
    this.chat.push(entry)
    if (this.chat.length > ROOM_CHAT_LIMIT) this.chat.splice(0, this.chat.length - ROOM_CHAT_LIMIT)
    this.lastActivityAt = now
    return entry
  }

  /** 开局：记录对局 id，进入 `playing`。 */
  beginMatch(matchId: string, now: number): void {
    this.phase = 'playing'
    this.matchId = matchId
    this.lastActivityAt = now
  }

  /** 对局结束 / 作废：回到 `lobby`（比分保留）。`winner` 为空表示平局不加分。 */
  endMatch(winner: string | null, now: number): void {
    if (winner) {
      const member = this.members.get(winner)
      if (member) member.wins += 1
    }
    this.phase = 'lobby'
    this.matchId = null
    // 新一局要重新准备（否则刚打完的人一回到大厅就会立刻被"双方都已准备"再开一局）
    for (const member of this.members.values()) member.ready = false
    this.lastActivityAt = now
  }

  /** 发给客户端的全量房间视图。 */
  snapshot(viewerId: string): {
    code: string
    you: string
    members: RoomMemberInfo[]
    settings: RoomSettings
    phase: RoomPhase
    matchId: string | null
    chat: RoomChatEntry[]
    canStart: boolean
  } {
    const members: RoomMemberInfo[] = [...this.members.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((member) => ({
        playerId: member.playerId,
        name: member.name,
        character: member.character,
        connected: member.connected,
        host: member.playerId === this.hostId,
        wins: member.wins,
        ready: member.ready,
      }))
    return {
      code: this.code,
      you: viewerId,
      members,
      settings: this.settings,
      phase: this.phase,
      matchId: this.matchId,
      chat: [...this.chat],
      canStart: this.canStart,
    }
  }

  /** 玩家顺序列表（按加入顺序）：`[host 顺序第一位, ...]`。 */
  orderedMemberIds(): string[] {
    return [...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt).map((member) => member.playerId)
  }

  private earliestMemberId(): string {
    let best: RoomMember | null = null
    for (const member of this.members.values()) {
      if (!best || member.joinedAt < best.joinedAt) best = member
    }
    return best ? best.playerId : ''
  }
}

/** 昵称兜底（与 `ws.ts` 的默认名保持同风格）。 */
function existingFallbackName(playerId: string): string {
  return `玩家${playerId.replace(/-/g, '').slice(0, 4) || '????'}`
}

/** 按加入顺序给默认角色（避免两人都是同一个）。 */
function defaultCharacter(index: number): CharacterId {
  return DEFAULT_CHARACTERS[index] ?? DEFAULT_CHARACTERS[0]
}

/** 聊天文本清洗：去控制字符、去首尾空白、限长。 */
export function sanitizeChat(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ROOM_CHAT_MAX_LENGTH)
}

export interface RoomManagerOptions {
  now?: () => number
  /** 自定义房间号生成器（测试用）。 */
  codeGenerator?: () => string
  logger?: { info(message: string, ...args: unknown[]): void; warn(message: string, ...args: unknown[]): void }
}

export interface RoomJoinResult {
  readonly ok: boolean
  readonly room?: Room
  readonly code?: 'roomNotFound' | 'roomFull' | 'roomPlaying'
  readonly message?: string
}

/**
 * 房间登记表：建房、加入、查出所在房间、退出、回收。
 *
 * 与 `MatchManager` 相互独立：这里只按**房间号**与**玩家**索引房间。
 */
export class RoomManager {
  private readonly byCode = new Map<string, Room>()
  private readonly byPlayer = new Map<string, string>()
  private readonly now: () => number
  private readonly codeGenerator: () => string

  constructor(private readonly options: RoomManagerOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.codeGenerator = options.codeGenerator ?? (() => generateCode())
  }

  get size(): number {
    return this.byCode.size
  }

  get(code: string): Room | null {
    return this.byCode.get(normalizeCode(code)) ?? null
  }

  /** 玩家现在所在的房间（断线重连 / 回到房间用）。 */
  roomOfPlayer(playerId: string): Room | null {
    const code = this.byPlayer.get(playerId)
    return code ? this.byCode.get(code) ?? null : null
  }

  /** 建房：房主 = 创建者；同一玩家重复建房会先退出旧房。 */
  create(host: Participant): Room {
    this.leave(host.playerId)
    let code = this.codeGenerator()
    let guard = 0
    while (this.byCode.has(code) && guard < 64) {
      code = this.codeGenerator()
      guard += 1
    }
    const room = new Room(code, host, this.now())
    this.byCode.set(code, room)
    for (const playerId of room.members.keys()) this.byPlayer.set(playerId, code)
    this.options.logger?.info(`已创建房间 ${code}（房主 ${host.name || host.playerId}）`)
    return room
  }

  /**
   * 加入房间。
   *
   * - **已经是该房间成员** → 视为"回到房间"（更新连接与角色），不会 `roomFull`；
   * - 人数已满 → `roomFull`；
   * - 房间正在对局 → `roomPlaying`（不能中途加入）；
   * - 不存在 / 已销毁 → `roomNotFound`。
   */
  join(code: string, participant: Participant): RoomJoinResult {
    const room = this.get(code)
    if (!room) return { ok: false, code: 'roomNotFound', message: `房间 ${normalizeCode(code)} 不存在或已解散` }
    const existing = room.member(participant.playerId)
    if (existing) {
      room.markOnline(participant, this.now())
      this.options.logger?.info(`玩家 ${participant.playerId} 回到房间 ${room.code}`)
      return { ok: true, room }
    }
    if (room.phase === 'playing') return { ok: false, code: 'roomPlaying', message: '房间正在对局中，无法加入' }
    if (room.size >= ROOM_CAPACITY) return { ok: false, code: 'roomFull', message: `房间 ${room.code} 已满` }
    // 换房：先退出旧房
    this.leave(participant.playerId)
    room.addMember(participant, this.now())
    this.byPlayer.set(participant.playerId, room.code)
    this.options.logger?.info(`玩家 ${participant.playerId} 加入房间 ${room.code}`)
    return { ok: true, room }
  }

  /**
   * 把一名玩家加进一个**新建**的房间（在线匹配用）。
   *
   * 匹配双方进同一个房间（`host` 为随机指定的一方）。
   */
  createWith(host: Participant, guest: Participant): Room {
    const room = this.create(host)
    const result = this.join(room.code, guest)
    if (!result.ok) {
      // 理论上不可达（新房必空）；保底把房主也踢掉，避免留下空壳
      this.destroy(room.code)
      throw new Error(`匹配建房失败：${result.message ?? result.code}`)
    }
    return room
  }

  /** 显式退出房间；返回房间是否被销毁（没有成员了）。 */
  leave(playerId: string): boolean {
    const code = this.byPlayer.get(playerId)
    if (!code) return false
    const room = this.byCode.get(code)
    this.byPlayer.delete(playerId)
    if (!room) return false
    const outcome = room.removeMember(playerId, this.now())
    if (!outcome.room) {
      // 不在房里（可能是残留索引），清掉索引即可
      return false
    }
    if (outcome.empty) {
      this.byCode.delete(code)
      this.options.logger?.info(`房间 ${code} 已无成员，数据（比分 / 聊天）销毁`)
      return true
    }
    return false
  }

  /** 标记离线（断线）；房间与成员都保留。 */
  markOffline(playerId: string): Room | null {
    const room = this.roomOfPlayer(playerId)
    if (!room) return null
    const changed = room.markOffline(playerId, this.now())
    return changed ? room : null
  }

  /** 对局结束：记账胜负并回到大厅。 */
  finishMatch(room: Room, winnerId: string | null): void {
    room.endMatch(winnerId, this.now())
  }

  /** 直接销毁一个房间（含索引）。 */
  destroy(code: string): void {
    const key = normalizeCode(code)
    const room = this.byCode.get(key)
    if (!room) return
    for (const playerId of room.members.keys()) {
      if (this.byPlayer.get(playerId) === key) this.byPlayer.delete(playerId)
    }
    this.byCode.delete(key)
  }

  /**
   * 回收：把长时间离线的成员清出房间（这样"人走了没点退出"也不会永久占位）。
   *
   * 只有**全部成员都离线**超过 `offlineTtlMs` 的房间才会被整体清理；
   * 有人在线时，离线的一方可以一直等（房间保留）。
   */
  sweep(offlineTtlMs: number): number {
    const now = this.now()
    let removed = 0
    for (const room of [...this.byCode.values()]) {
      const allOffline = [...room.members.values()].every((member) => !member.connected)
      if (!allOffline) continue
      if (now - room.lastActivityAt < offlineTtlMs) continue
      this.destroy(room.code)
      removed += 1
    }
    return removed
  }

  /** 测试 / 关闭用。 */
  clear(): void {
    this.byCode.clear()
    this.byPlayer.clear()
  }
}
