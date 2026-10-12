/**
 * 匹配：FIFO 在线队列（bugv34e 起**只管排队**）。
 *
 * 房间（建房 / 加入 / 聊天 / 房主 / 开局）已经拆到 `room.ts`：
 * 匹配的职责退化为"把两个人凑到一起"，凑齐后由上层把两人放进同一个房间
 * （通过构造时注入的 `onMatch` 回调通知）。
 */
import type { CharacterId } from './core/characters'
import type { ServerMessage } from './protocol'

/** 一个已连接并完成握手的玩家（队列 / 房间的成员）。 */
export interface Participant {
  readonly playerId: string
  /**
   * 登录账号（bugv34k；未登录为 null）。
   *
   * 用它把回放**挂到账号上**（而不是浏览器本地生成的 `playerId`），
   * 这样同一账号换设备 / 换浏览器也看得到自己的回放。
   */
  readonly account?: string | null
  name: string
  /**
   * 本局选择的角色（bugv10 #11）。
   *
   * 队列条目就是 Participant 本身，所以这里存的就是"该玩家选的角色"；
   * 成局时按座位索引取用，缺失 / 非法一律退回默认角色。
   */
  character?: CharacterId
  send(message: ServerMessage): void
}

/** 匹配码字符集：去掉易混淆的 `0 O 1 I`。 */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 6

export interface MatchingOptions {
  /**
   * 凑够两人时回调。
   *
   * ⚠️ bugv34e 起**不再直接开局**：上层会把两人放进同一个房间（随机一方为房主），
   * 等房主点「开始游戏」才真正开局。
   */
  onMatch: (host: Participant, guest: Participant) => void
  logger?: { info(message: string, ...args: unknown[]): void; warn(message: string, ...args: unknown[]): void }
}

/** 生成 6 位大写匹配码。 */
export function generateCode(random: () => number = Math.random): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length) % CODE_ALPHABET.length]
  }
  return code
}

/** 房间号规范化（大写、去空白）。 */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase()
}

export class MatchingService {
  /** FIFO 队列（第一个元素最先入队）。 */
  private readonly queue: Participant[] = []

  constructor(private readonly options: MatchingOptions) {}

  get queueSize(): number {
    return this.queue.length
  }

  /** 队列位置（1 起），不在队列返回 null。 */
  positionOf(playerId: string): number | null {
    const index = this.queue.findIndex((item) => item.playerId === playerId)
    return index < 0 ? null : index + 1
  }

  /**
   * 进入队列；同一玩家重复进入是幂等的（会顺带把连接换成最新的一条，
   * 这样重连后的客户端依然能收到配对结果）。
   *
   * 返回**入队时的队列位置**（1 起）。注意：如果这次入队刚好凑够两人，
   * 该玩家会立刻被匹配走（`onMatch` 同步触发），此时位置只是"我排在第几位"的历史信息。
   */
  enqueue(participant: Participant): number {
    const existing = this.queue.findIndex((item) => item.playerId === participant.playerId)
    if (existing >= 0) {
      this.queue[existing] = participant
    } else {
      this.queue.push(participant)
    }
    const position = (existing >= 0 ? existing : this.queue.length - 1) + 1
    this.tryMatch()
    return position
  }

  /** 离开队列；返回是否本来就在队列中。 */
  cancel(playerId: string): boolean {
    const index = this.queue.findIndex((item) => item.playerId === playerId)
    if (index < 0) return false
    this.queue.splice(index, 1)
    return true
  }

  /** 断开连接 / 主动离开时清理（只处理队列；房间由 `RoomManager` 负责）。 */
  removePlayer(playerId: string): void {
    this.cancel(playerId)
  }

  private tryMatch(): void {
    while (this.queue.length >= 2) {
      const first = this.queue.shift() as Participant
      const second = this.queue.shift() as Participant
      this.options.onMatch(first, second)
    }
  }

  dispose(): void {
    this.queue.length = 0
  }
}
