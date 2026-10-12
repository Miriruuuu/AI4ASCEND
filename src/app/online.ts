/**
 * 联机客户端（bugv6 #8 / bugv7 #1）：把 WebSocket 协议（见 `back/PROTOCOL.md`）包成一个小类。
 *
 * 设计：**服务端权威**。客户端本地也跑同一份纯逻辑引擎，但只在收到服务端的
 * `applied` 之后才推进本地模型并播放动画，因此两端不会各算各的。
 * 每一步都会比对局面指纹（`src/core/digest.ts`），不一致就 `sync` 重建。
 *
 * bugv7 #1 修的三件事（都会让"能收到对方消息、自己却下不了子"）：
 * 1. **状态只升不降**：服务端可能先发 `matched` 再发 `queued`（入队即配对），
 *    之前那条第 `queued` 会把 `playing` 覆盖成 `queued`，那一方的棋盘就永久锁死了。
 *    现在只要手上有 `matchId`，大厅类状态（idle/queued/room）一律不覆盖对局状态。
 * 2. **socket 不会被写脏**：事件回调绑定在自己那条 socket 上（`on*` 赋值 + 身份校验），
 *    旧连接的 close 不会再把新连接引用清成 null（那会让后续所有 `send` 静默失败）。
 * 3. **连接是幂等的**：`connect()` 对同一地址重复调用不会拆掉正在握手的连接；
 *    未连上时的"入队 / 建房 / 加入"会记成待发意图，握手完成后自动补发。
 */
import type {
  AttackSnapshot,
  GameResult,
  MagicConfig,
  MagicKind,
  NightConfig,
  NightPhase,
  PlayerIndex,
  WeatherId,
} from '../core/types'
import type { MatchRecord, ReplayStep } from './useConnectGame'

/**
 * 与服务端约定的协议版本。
 *
 * v2（bugv34e）：引入**房间（大厅）** —— 匹配 / 建房都先进房间，房主点「开始游戏」才开局。
 * v3（bugv34i）：**联机需要登录**（注册 / 登录 / 长期令牌），开局改为**双方都点「准备」**。
 */
export const ONLINE_PROTOCOL_VERSION = 3

/** 已登录的账号信息（bugv34i）。 */
export interface OnlineUser {
  username: string
  nickname: string
}

export type OnlineStatus =
  | 'offline'
  | 'connecting'
  /** 已连接、未开局 */
  | 'idle'
  | 'queued'
  /** 已建房，等待对手输入匹配码 */
  | 'room'
  | 'playing'
  /** 对局中断（对手离开 / 掉线） */
  | 'ended'
  | 'error'

export interface OnlineDice {
  rolls: [number, number]
  first: PlayerIndex
}

export interface OnlineMatched {
  matchId: string
  seat: PlayerIndex
  code: string | null
  opponent: string
  dice: OnlineDice
  /**
   * 双方选用的角色（bugv10 #11：技能联机后服务端要知道两边的技能表），
   * 下标是座位。
   */
  characters?: [string, string]
  /**
   * 本局的房间设置（bugv34e：血量上限 / 魔力植物 / 黑夜都由房间决定）。
   *
   * 客户端必须拿它**构造自己的镜像引擎**，否则第一步指纹就会漂移。
   */
  settings?: OnlineRoomSettings
}

/**
 * 房间设置（bugv34e，与服务端 `back/src/protocol.ts` 的 `RoomSettings` 一一对应）。
 */
export interface OnlineRoomSettings {
  hpLimit: number
  magic: Partial<MagicConfig> & Record<string, unknown>
  night: Partial<NightConfig> & Record<string, unknown>
}

/** 房间设置补丁。 */
export interface OnlineRoomSettingsPatch {
  hpLimit?: number
  magic?: Record<string, unknown>
  night?: Record<string, unknown>
}

/** 房间成员视图。 */
export interface OnlineRoomMember {
  playerId: string
  name: string
  character: string
  connected: boolean
  host: boolean
  wins: number
  /** 是否已点「准备」（bugv34i：双方都准备才自动开局）。 */
  ready: boolean
}

/** 房间聊天条目。 */
export interface OnlineRoomChatEntry {
  id: number
  playerId: string
  name: string
  text: string
  at: number
}

/** 房间全量状态（服务端每次变化都会广播一份）。 */
export interface OnlineRoomState {
  code: string
  /** 收信者自己的 playerId。 */
  you: string
  members: OnlineRoomMember[]
  settings: OnlineRoomSettings
  phase: 'lobby' | 'playing'
  matchId: string | null
  chat: OnlineRoomChatEntry[]
  canStart: boolean
}

export interface OnlineApplied {
  matchId: string
  seq: number
  seat: PlayerIndex
  /** bugv10 #11：技能也走 `applied` 广播。 */
  kind: 'place' | 'defend' | 'skill'
  cell: number
  /** 技能步：技能槽序号。 */
  slot?: number
  /** 技能步：消耗的魔力植物格子。 */
  cells?: number[]
  /** 技能步：点选的目标格（没有目标时为 null）。 */
  target?: number | null
  hp: [number, number]
  current: PlayerIndex
  phase: string
  digest: string
  result: GameResult | null
}

export interface OnlineStateMessage {
  matchId: string
  seq: number
  seat: PlayerIndex
  board: number[]
  hp: [number, number]
  current: PlayerIndex
  phase: string
  firstPlayer: PlayerIndex | null
  highlightOwner: PlayerIndex | null
  highlights: Array<[number, number]>
  attack: AttackSnapshot | null
  digest: string
  result: GameResult | null
  /** 魔力植物（bugv8 #4）：重连后必须一起恢复，否则指纹会漂移。 */
  magic?: Array<{ cell: number; kind: MagicKind; owner: PlayerIndex | null }>
  magicGrowths?: number
  magicCooldown?: number
  magicLineSeen?: boolean
  /** 双方的技能表由座位上的角色决定（bugv10 #11）。 */
  characters?: [string, string]
  shield?: [number, number]
  bonusActions?: [number, number]
  actionsTaken?: [number, number]
  skillReadyAt?: [number[], number[]]
  lastPlacedBy?: [number | null, number | null]
  turnNo?: number
  immuneUntil?: [number, number]
  /** 增伤到期回合（bugv12 #2：「小一哥」持续 2 回合）。 */
  powerUntil?: [number, number]
  /** 烈焰：`[cell, 剩余回合][]`（bugv10 #9 恶龙吐息）。 */
  flames?: Array<[number, number]>
  /** 叠在敌方棋子上的额外棋子：`[cell, player][]`（bugv10 #9 毒鸡蛋）。 */
  overlay?: Array<[number, number]>
  /** 本回合的伤害加成（bugv10 #9 小一哥）。 */
  powerBonus?: [number, number]
  /** 本回合是否可以在敌方棋子上落子（bugv10 #9 毒鸡蛋）。 */
  sabotage?: [boolean, boolean]
  /** 本回合毒鸡蛋的额外伤害（bugv12 #3，可与小一哥叠加）。 */
  sabotageBonus?: [number, number]
  /** 「双子星」的爆发窗口（bugv11 #5：两连即可攻击 + 免疫反击）。 */
  twinStar?: [boolean, boolean]
  /** 下次双子星是否**消耗 -1**（bugv12 #3 / bugv14）。 */
  bloomCheaperNext?: [boolean, boolean]
  /** 临时护甲与到期回合（bugv14 精密计算）。 */
  tempArmor?: [number, number]
  tempArmorUntil?: [number, number]
  /** 「深度思考」的额外攻击值与到期回合（bugv14）。 */
  strikeBonus?: [number, number]
  strikeUntil?: [number, number]
  /** 「播种」窗口（bugv14）。 */
  seedGrow?: [boolean, boolean]
  /** bugv19：低消耗档「杀鲸霸拳」——本回合本方植物不加伤。 */
  noPlantBonus?: [boolean, boolean]
  /** 烈焰归属（bugv14）：`[格子, 主人][]`。 */
  flameOwner?: Array<[number, number]>
  /** 各技能已经释放过几次（bugv11 #6：首次免费）。 */
  skillCasts?: [number[], number[]]
  /** 黑夜阶段 / 预告剩余 / 持续回合 / 距上次结束（bugv34）。 */
  nightPhase?: NightPhase
  nightCountdown?: number
  nightTurns?: number
  turnsSinceNight?: number
  /** 当前天气（bugv34；bugv34c 起 7 种）。 */
  weather?: WeatherId | null
  /** 双方发起过的攻击棋子数 + 本次黑夜起点（bugv34）。 */
  attacksLaunched?: [number, number]
  nightAttackBase?: [number, number]
  /** 本次黑夜是否由「黑夜开局」触发（bugv34d；联机恒 false）。 */
  nightFromStart?: boolean
  /** bugv34m：Qwen「本地部署」的窗口与本回合伤害加成。 */
  deploy?: [boolean, boolean]
  deployBonus?: [number, number]
  /** bugv34m：Qwen「小千问」待重新部署的棋子（编码值：原格 * 2 + 叠子位）。 */
  redeployPending?: [number[], number[]]
}

/** 服务端回放文档（`GET /api/replays`）。 */
export interface OnlineReplayDoc {
  _id: string
  matchId: string
  createdAt: number
  finishedAt?: number
  durationMs?: number
  playerNames: [string, string]
  playerIds?: string[]
  players?: Array<{ playerId: string; name: string; seat: PlayerIndex }>
  dice?: OnlineDice
  steps: ReplayStep[]
  result: GameResult
  mode?: string
  /** 服务端可能带上每一步的魔力植物快照（bugv8 #4）。 */
  magic?: Array<{ cell: number; kind: MagicKind; owner: number | null }>
  /** 双方角色（bugv10 #11：回放里也能还原技能表）。 */
  characters?: [string, string]
}

export interface OnlineClientOptions {
  onStatus?: (status: OnlineStatus, detail?: string) => void
  /** 登录 / 注册成功（bugv34i）。 */
  onLoggedIn?: (user: OnlineUser, token: string) => void
  /** 已退出登录（令牌作废）。 */
  onLoggedOut?: () => void
  onQueue?: (position: number) => void
  /** 房间状态更新（bugv34e：建房 / 加入 / 改设置 / 聊天 / 上下线 / 开局 / 结束都会推）。 */
  onRoom?: (room: OnlineRoomState) => void
  /** 收到一条新聊天（房间里的其他人 / 自己发的）。 */
  onRoomChat?: (entry: OnlineRoomChatEntry) => void
  /** 房间被销毁（自己退出了，或房间没人了）。 */
  onRoomClosed?: (reason: string) => void
  onMatched?: (info: OnlineMatched) => void
  onApplied?: (message: OnlineApplied) => void
  onState?: (message: OnlineStateMessage) => void
  onGameOver?: (result: GameResult, replayId: string | null) => void
  onOpponentLeft?: (reason: string) => void
  /**
   * 登录已失效（bugv34l）：同一账号在别处登录，或本机令牌已被服务端作废。
   *
   * 客户端已经就地清掉登录态（账号 / 令牌），宿主收到后把界面切回登录面板即可。
   */
  onSessionExpired?: (reason: string) => void
  onError?: (code: string, message: string) => void
}

const PLAYER_ID_KEY = 'connect4.playerId'
/** 登录态（账号 / 昵称 / 令牌）——"不退出登录就一直保持登录"（bugv34i）。 */
const USER_KEY = 'connect4.user.v1'
/** 握手后自动补发的意图（入队 / 建房 / 加入房间）。 */
type Intent = {
  t: 'queue' | 'createRoom' | 'joinRoom' | 'rejoinRoom'
  name?: string
  code?: string
  character?: string
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function randomId(): string {
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** 浏览器里记住的账号（没有则返回 null）。 */
export function storedUser(): { user: OnlineUser; token: string } | null {
  const store = safeStorage()
  const raw = store?.getItem(USER_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { username?: unknown; nickname?: unknown; token?: unknown }
    if (typeof parsed?.username !== 'string' || typeof parsed?.token !== 'string') return null
    return {
      user: { username: parsed.username, nickname: String(parsed.nickname ?? parsed.username) },
      token: parsed.token,
    }
  } catch {
    return null
  }
}

function persistUser(user: OnlineUser | null, token: string | null): void {
  const store = safeStorage()
  if (!store) return
  try {
    if (user && token) store.setItem(USER_KEY, JSON.stringify({ ...user, token }))
    else store.removeItem(USER_KEY)
  } catch {
    /* 存不下就算了（隐私模式） */
  }
}

/** 浏览器里记住的玩家 id（服务端不再单独分配）。 */
export function storedPlayerId(): string {
  const store = safeStorage()
  const existing = store?.getItem(PLAYER_ID_KEY)
  if (existing) return existing
  const id = randomId()
  store?.setItem(PLAYER_ID_KEY, id)
  return id
}

/**
 * 线上（生产）联机后端：宝塔上跑的那台（bugv11 追加 #7）。
 *
 * 只有**生产构建**（`pnpm build` / 部署到线上的那一份前端）才会连它。
 */
export const PRODUCTION_SERVER_URL = 'http://113.45.13.149:8787'

/**
 * 本地（开发）联机后端：`cd back && pnpm dev` 默认监听 8787。
 *
 * **开发模式**（`pnpm dev`，vite dev server）连它 —— 本地前后端一起改、一起热重载，
 * 不会碰到线上那台（也就不受"线上还没部署新协议"的影响）。
 * ⚠️ 用 `localhost` 而不是 `127.0.0.1`：本机环境里 `127.0.0.1` 会被代理拦（见项目约定）。
 */
export const LOCAL_SERVER_URL = 'http://localhost:8787'

/**
 * 默认联机后端 = 按**构建模式**选：开发 → 本地，生产 → 线上（bugv34f）。
 *
 * 生产/开发的真正开关是 `<root>/.env.production` 与 `<root>/.env.development`
 * 里的 `VITE_SERVER_URL`（`.env.[mode]` 由 vite 按 mode 自动加载）：
 * - `pnpm dev` / `vite` → `.env.development` → 本地；
 * - `pnpm build` / `vite build` → `.env.production` → 线上；
 * - 构建时显式给的环境变量（`VITE_SERVER_URL=… pnpm build`）优先级最高。
 * 这个常量只是**环境变量缺失时**的兜底（比如有人把 `.env.*` 删了）。
 */
export const DEFAULT_SERVER_URL = import.meta.env.DEV ? LOCAL_SERVER_URL : PRODUCTION_SERVER_URL

/**
 * 默认服务器地址。
 *
 * 优先级：`VITE_SERVER_URL` 环境变量（含 `.env.[mode]` 文件）→ 按模式的兜底常量。
 * 不再读 localStorage：以前玩家手填的地址会一直覆盖默认值，换后端之后就再也连不上了。
 */
export function defaultServerUrl(): string {
  const raw = String(import.meta.env.VITE_SERVER_URL ?? '').trim()
  if (raw) return raw.replace(/\/+$/, '')
  return DEFAULT_SERVER_URL
}

/** 规范化用户输入的服务器地址（允许只写 `1.2.3.4:8787`）。 */
export function normalizeServerUrl(input: string): string {
  const text = input.trim().replace(/\/+$/, '')
  if (!text) return defaultServerUrl()
  if (/^https?:\/\//i.test(text)) return text
  if (/^wss?:\/\//i.test(text)) return text.replace(/^ws/i, 'http')
  return `http://${text}`
}

export class OnlineClient {
  playerId = storedPlayerId()
  name = '玩家'
  status: OnlineStatus = 'offline'
  /** 最近一次出错信息（给界面展示）。 */
  lastError = ''
  serverUrl = defaultServerUrl()
  matchId: string | null = null
  seat: PlayerIndex = 0
  code: string | null = null
  opponent = ''
  queuePosition = 0
  /** 本端选用的角色 id（bugv10 #11：开局前随入队 / 建房一起发给服务端）。 */
  character = 'deepseek'
  /** 当前所在房间（bugv34e；不在房间时为 null）。 */
  room: OnlineRoomState | null = null
  /** 当前登录的账号（bugv34i；未登录为 null）。 */
  user: OnlineUser | null = null
  /** 长期登录令牌（`hello` 时回传给服务端以恢复登录态）。 */
  token: string | null = null

  private socket: WebSocket | null = null
  private helloDone = false
  private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  private pingTimer: ReturnType<typeof globalThis.setInterval> | null = null
  private retries = 0
  /** 被踢 / 主动断开后不再自动重连。 */
  private giveUp = false
  private intent: Intent | null = null

  private readonly options: OnlineClientOptions

  constructor(options: OnlineClientOptions = {}) {
    this.options = options
    const saved = storedUser()
    if (saved) {
      this.user = saved.user
      this.token = saved.token
      this.name = saved.user.nickname
    }
  }

  /** 连接已就绪（握手完成），此时才允许发对局消息。 */
  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN && this.helloDone
  }

  /** 最近的连接状态（含"连接中"，用于界面按钮）。 */
  get live(): boolean {
    return this.socket !== null && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === 0)
  }

  /** 把 http(s) 地址换算成 ws(s) 的 `/ws` 端点。 */
  socketUrl(url = this.serverUrl): string {
    const base = normalizeServerUrl(url)
    const ws = base.replace(/^http/i, 'ws')
    return `${ws}/ws`
  }

  private setStatus(status: OnlineStatus, detail?: string): void {
    // bugv7 #1：手上有 matchId 时，大厅类状态不能把"对局中"覆盖掉
    if (this.matchId !== null && (status === 'idle' || status === 'queued' || status === 'room')) {
      this.status = 'playing'
      return
    }
    this.status = status
    this.options.onStatus?.(status, detail)
  }

  /** 关闭当前 socket（摘掉回调，避免旧连接的 close 影响新连接）。 */
  private teardown(): void {
    this.stopPing()
    if (this.reconnectTimer !== null) {
      globalThis.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const socket = this.socket
    this.socket = null
    this.helloDone = false
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      try {
        socket.close()
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 连接（对同一地址幂等；重复调用不会拆掉正在握手的连接）。 */
  connect(url?: string): void {
    const target = normalizeServerUrl(url ?? this.serverUrl)
    this.serverUrl = target

    const endpoint = this.socketUrl(target)
    const socket = this.socket
    if (socket && socket.url === endpoint && (socket.readyState === 0 || socket.readyState === 1)) {
      // 已经连上 / 正在连同一个地址：复用，别自己把自己的连接关掉。
      // 但要把"不再重连"的标记清掉 —— 显式调用 connect() 就代表想要连上
      // （被 `sessionExpired` / `duplicateLogin` 踢过之后，重新登录要走这条路，bugv34l）。
      this.giveUp = false
      return
    }

    this.giveUp = false
    this.teardown()
    this.retries = 0
    this.setStatus('connecting')

    let next: WebSocket
    try {
      next = new WebSocket(endpoint)
    } catch (error) {
      this.lastError = `无法创建 WebSocket 连接：${String(error)}`
      this.setStatus('error')
      this.options.onError?.('socketFailed', this.lastError)
      return
    }
    this.socket = next

    next.onopen = () => {
      if (this.socket !== next) return
      this.send({
        t: 'hello',
        playerId: this.playerId,
        name: this.name,
        version: ONLINE_PROTOCOL_VERSION,
        ...(this.token ? { token: this.token } : {}),
      })
    }
    next.onmessage = (event: MessageEvent) => {
      if (this.socket !== next) return
      this.handleMessage(event.data)
    }
    next.onerror = () => {
      if (this.socket !== next) return
      this.lastError = `无法连接 ${this.serverUrl}`
      this.options.onError?.('socketError', this.lastError)
    }
    next.onclose = () => {
      if (this.socket !== next) return
      this.socket = null
      this.helloDone = false
      this.stopPing()
      if (this.giveUp) {
        this.setStatus('offline')
        return
      }
      // 对局中掉线：先尝试自动重连（重连成功后用 sync 把局面接回来），
      // 重连彻底失败才告诉宿主"断了"
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.giveUp) return
    if (this.retries >= 5) {
      this.setStatus('error', '连接已断开，重连失败')
      this.options.onError?.('reconnectFailed', '与服务器的连接已断开，重连 5 次仍失败')
      if (this.matchId !== null) this.options.onOpponentLeft?.('连接已断开，重连失败')
      return
    }
    this.retries += 1
    const delay = Math.min(1000 * 2 ** (this.retries - 1), 8000)
    this.setStatus('connecting', `${Math.round(delay / 1000)} 秒后重连（第 ${this.retries} 次）`)
    if (this.reconnectTimer !== null) globalThis.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null
      if (this.giveUp) return
      this.connect(this.serverUrl)
    }, delay)
  }

  /** 主动断开（不再自动重连）。 */
  disconnect(silent = false): void {
    this.giveUp = true
    this.intent = null
    this.teardown()
    this.matchId = null
    this.code = null
    if (!silent) this.setStatus('offline')
  }

  /**
   * 清掉本机登录态（账号 / 令牌 / 房间 / 令牌持久化）。
   *
   * 用于「登录已失效」（`sessionExpired`）：同一账号在别处登录后，本机这份令牌已经作废，
   * 必须忘掉它 —— 否则刷新之后还会拿旧令牌去恢复登录态，又被踢一次（bugv34l）。
   */
  private clearSession(): void {
    this.user = null
    this.token = null
    this.room = null
    this.matchId = null
    this.code = null
    persistUser(null, null)
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = globalThis.setInterval(() => this.send({ t: 'ping' }), 20000)
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      globalThis.clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  send(message: Record<string, unknown>): boolean {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    try {
      socket.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return
    let message: Record<string, unknown>
    try {
      message = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    switch (message.t) {
      case 'welcome': {
        this.helloDone = true
        this.retries = 0
        this.startPing()
        // bugv34i：服务端认出了令牌 → 直接恢复登录态
        if (message.authenticated === true && typeof message.username === 'string') {
          const user: OnlineUser = {
            username: message.username,
            nickname: String(message.nickname ?? message.username),
          }
          this.user = user
          this.name = user.nickname
          this.options.onLoggedIn?.(user, this.token ?? '')
        }
        // 重连回来时把对局局面接回去（服务端会回 `state`；若对局已不在，会回 notInMatch）
        if (this.matchId !== null) this.send({ t: 'sync', matchId: this.matchId })
        if (this.intent) {
          const intent = this.intent
          this.intent = null
          this.send(intent as unknown as Record<string, unknown>)
        }
        if (this.matchId === null) this.setStatus('idle')
        break
      }
      case 'queued': {
        this.queuePosition = Number(message.position ?? 1)
        this.setStatus('queued')
        this.options.onQueue?.(this.queuePosition)
        break
      }
      case 'queueCanceled':
        this.queuePosition = 0
        this.setStatus('idle')
        break
      case 'roomState': {
        // bugv34e：房间（大厅）全量状态
        const room = message as unknown as OnlineRoomState
        this.room = room
        this.code = room.code
        if (room.phase === 'playing') {
          // 房间里正在对局（多半是刷新 / 断线重连回来）→ 让宿主用 matchId 去 sync
          if (room.matchId) {
            this.matchId = room.matchId
            this.setStatus('playing')
          }
        } else {
          this.matchId = null
          this.setStatus('room')
        }
        this.options.onRoom?.(room)
        break
      }
      case 'loggedIn': {
        const user: OnlineUser = {
          username: String(message.username ?? ''),
          nickname: String(message.nickname ?? message.username ?? ''),
        }
        const token = String(message.token ?? '')
        this.user = user
        this.token = token
        this.name = user.nickname
        persistUser(user, token)
        this.options.onLoggedIn?.(user, token)
        break
      }
      case 'loggedOut': {
        this.user = null
        this.token = null
        persistUser(null, null)
        this.options.onLoggedOut?.()
        break
      }
      case 'roomChat': {
        const entry = message.entry as OnlineRoomChatEntry | undefined
        if (entry) this.options.onRoomChat?.(entry)
        break
      }
      case 'roomClosed': {
        this.room = null
        this.matchId = null
        this.code = null
        this.setStatus('idle')
        this.options.onRoomClosed?.(String(message.reason ?? 'left'))
        break
      }
      case 'matched': {
        this.matchId = String(message.matchId ?? '')
        this.seat = (Number(message.seat ?? 0) === 1 ? 1 : 0) as PlayerIndex
        this.code = message.code == null ? null : String(message.code)
        this.opponent = String(message.opponent ?? '对手')
        this.queuePosition = 0
        const dice = (message.dice ?? {}) as Partial<OnlineDice>
        const rawCharacters = message.characters
        const characters: [string, string] | undefined = Array.isArray(rawCharacters)
          ? [String(rawCharacters[0] ?? 'deepseek'), String(rawCharacters[1] ?? 'gemini')]
          : undefined
        const settings = message.settings as OnlineRoomSettings | undefined
        this.setStatus('playing')
        this.options.onMatched?.({
          matchId: this.matchId,
          seat: this.seat,
          code: this.code,
          opponent: this.opponent,
          dice: {
            rolls: [Number(dice.rolls?.[0] ?? 1), Number(dice.rolls?.[1] ?? 1)],
            first: (Number(dice.first ?? 0) === 1 ? 1 : 0) as PlayerIndex,
          },
          ...(characters ? { characters } : {}),
          ...(settings ? { settings } : {}),
        })
        break
      }
      case 'applied':
        // 生长的魔力植物由两端各自按同一份确定性算法算出来（局面指纹负责兜底），
        // 所以协议里不需要传"长在哪几格"
        this.options.onApplied?.(message as unknown as OnlineApplied)
        break
      case 'state':
        this.options.onState?.(message as unknown as OnlineStateMessage)
        break
      case 'gameOver': {
        const result = message.result as GameResult
        const replayId = message.replayId == null ? null : String(message.replayId)
        this.setStatus('ended')
        this.options.onGameOver?.(result, replayId)
        break
      }
      case 'opponentLeft': {
        const reason = String(message.reason ?? '对手已离开')
        this.setStatus('ended')
        this.options.onOpponentLeft?.(reason)
        break
      }
      case 'error': {
        const code = String(message.code ?? 'badRequest')
        const text = String(message.message ?? '服务端返回错误')
        this.lastError = text
        if (code === 'sessionExpired') {
          // bugv34l「顶号」：同一账号在别处登录了 → 本机令牌已作废。
          // 就地清掉登录态（含 localStorage），别再自动重连，宿主会切回登录面板。
          this.giveUp = true
          this.clearSession()
          this.setStatus('error', text)
          this.options.onSessionExpired?.(text)
        } else if (code === 'duplicateLogin') {
          // 身份被新连接接管：别再重连，否则两个标签页会互相踢
          this.giveUp = true
          this.matchId = null
          this.setStatus('error', text)
        } else if (code === 'notInMatch' && this.matchId !== null) {
          // sync 之后发现对局已经没了
          this.matchId = null
          this.setStatus('ended', text)
        }
        this.options.onError?.(code, text)
        break
      }
      default:
        break
    }
  }

  // --- 大厅操作 -------------------------------------------------------------

  setIdentity(name: string, url?: string): void {
    this.name = name.slice(0, 8) || '玩家'
    if (url !== undefined) this.serverUrl = normalizeServerUrl(url)
  }

  /** 未连上时把意图记下来，握手完成后自动补发。 */
  private intend(intent: Intent): void {
    if (this.connected) {
      this.send(intent as unknown as Record<string, unknown>)
      return
    }
    this.intent = intent
    if (!this.live) this.connect(this.serverUrl)
  }

  queue(name?: string): void {
    if (name) this.name = name.slice(0, 8) || '玩家'
    this.matchId = null
    this.code = null
    this.setStatus('queued')
    this.intend({ t: 'queue', name: this.name, character: this.character })
  }

  cancelQueue(): void {
    this.intent = null
    this.send({ t: 'cancelQueue' })
    this.queuePosition = 0
    if (this.matchId === null) this.setStatus('idle')
  }

  createRoom(name?: string): void {
    if (name) this.name = name.slice(0, 8) || '玩家'
    this.matchId = null
    this.code = null
    this.setStatus('room')
    this.intend({ t: 'createRoom', name: this.name, character: this.character })
  }

  joinRoom(code: string, name?: string): void {
    if (name) this.name = name.slice(0, 8) || '玩家'
    this.matchId = null
    this.code = code.trim().toUpperCase()
    this.intend({ t: 'joinRoom', code: this.code, name: this.name, character: this.character })
  }

  /**
   * 回到房间（bugv34e）：断线 / 刷新后凭房间号回来。
   *
   * 服务端按 playerId 认人，所以即使是新连接也会被还原成原来的成员。
   */
  rejoinRoom(code: string, name?: string): void {
    if (name) this.name = name.slice(0, 8) || '玩家'
    this.code = code.trim().toUpperCase()
    this.intend({ t: 'rejoinRoom', code: this.code, name: this.name, character: this.character })
  }

  // --- 账号（bugv34i） ------------------------------------------------------

  /** 登录；账号不存在时服务端回 `userNotFound`，前端据此引导去注册。 */
  login(username: string, password: string): boolean {
    return this.send({ t: 'login', username, password })
  }

  /** 注册（昵称会取代原来设置里的"联机昵称"）。 */
  register(username: string, password: string, nickname: string): boolean {
    return this.send({ t: 'register', username, password, nickname })
  }

  /** 退出登录（作废令牌，之后不再自动登录）。 */
  logout(): void {
    this.send({ t: 'logout' })
    this.user = null
    this.token = null
    persistUser(null, null)
    this.room = null
    this.matchId = null
    this.code = null
  }

  // --- 房间内操作（bugv34e） ------------------------------------------------

  /** 修改房间设置（仅房主生效，服务端会校验）。 */
  setRoomSettings(settings: OnlineRoomSettingsPatch): boolean {
    return this.send({ t: 'roomSettings', settings })
  }

  /** 在房间里改自己的角色。 */
  pickCharacter(character: string): void {
    this.character = character
    this.send({ t: 'roomCharacter', character })
  }

  /** 在房间里发一条聊天。 */
  chat(text: string): boolean {
    return this.send({ t: 'chat', text })
  }

  /** 转让房主（仅房主）。 */
  transferHost(to: string): boolean {
    return this.send({ t: 'transferHost', to })
  }

  /** 点「准备」/ 取消准备（bugv34i：双方都准备时服务端自动开局）。 */
  setReady(ready: boolean): boolean {
    return this.send({ t: 'roomReady', ready })
  }

  /** 主动退出房间（房间因此可能被销毁）。 */
  leaveRoom(): void {
    this.intent = null
    this.send({ t: 'leave' })
    this.room = null
    this.matchId = null
    this.code = null
    this.setStatus('idle')
  }

  /** 落子请求；未连接 / 发送失败返回 false（宿主据此提示用户）。 */
  move(cell: number): boolean {
    if (this.matchId === null) return false
    if (!this.connected) {
      this.connect(this.serverUrl)
      return false
    }
    return this.send({ t: 'move', matchId: this.matchId, cell })
  }

  /**
   * 技能请求（bugv10 #11）。
   *
   * 服务端会跑同一份引擎裁决，成功后用 `applied(kind: 'skill')` 广播给两端。
   */
  skill(slot: number, cells: readonly number[], target?: number | null): boolean {
    if (this.matchId === null) return false
    if (!this.connected) {
      this.connect(this.serverUrl)
      return false
    }
    return this.send({
      t: 'skill',
      matchId: this.matchId,
      slot,
      cells: [...cells],
      target: target ?? null,
    })
  }

  requestSync(): void {
    if (this.matchId === null || !this.connected) return
    this.send({ t: 'sync', matchId: this.matchId })
  }

  resign(): void {
    if (this.matchId === null) return
    this.send({ t: 'resign', matchId: this.matchId })
  }

  leave(): void {
    this.intent = null
    if (this.matchId !== null) this.send({ t: 'leave', matchId: this.matchId })
    else this.send({ t: 'leave' })
    this.matchId = null
    this.code = null
    this.room = null
  }

  // --- 回放（REST） ---------------------------------------------------------

  /**
   * 拉取回放（服务端持久化在 MongoDB）。
   *
   * bugv34k：**优先按登录账号**过滤 —— 账号才是"人"，`playerId` 只是浏览器本地身份。
   * 未登录（老客户端 / 未填）才退回按 `playerId` 查。
   */
  async fetchReplays(limit = 20, playerId?: string, account?: string): Promise<OnlineReplayDoc[]> {
    const query = new URLSearchParams({ limit: String(limit) })
    const who = account ?? this.user?.username ?? ''
    if (who) query.set('account', who)
    else {
      const id = playerId ?? this.playerId
      if (id) query.set('playerId', id)
    }
    const response = await fetch(`${normalizeServerUrl(this.serverUrl)}/api/replays?${query.toString()}`)
    if (!response.ok) throw new Error(`服务器返回 ${response.status}`)
    const payload = (await response.json()) as
      | { items?: OnlineReplayDoc[]; replays?: OnlineReplayDoc[] }
      | OnlineReplayDoc[]
    // 服务端返回 `{ ok, count, items }`；这里同时兼容 `replays` 与裸数组，方便对接别的实现
    if (Array.isArray(payload)) return payload
    return payload.items ?? payload.replays ?? []
  }

  /** 把服务端回放文档转成前端回放器的记录格式。 */
  static toRecord(doc: OnlineReplayDoc): MatchRecord {
    const names =
      doc.playerNames ??
      ([doc.players?.[0]?.name ?? '赤方', doc.players?.[1]?.name ?? '青方'] as [string, string])
    return {
      id: doc.matchId || doc._id,
      mode: 'online',
      playedAt: new Date(doc.createdAt ?? Date.now()).toLocaleString('zh-CN', { hour12: false }),
      playedAtMs: doc.createdAt ?? Date.now(),
      steps: doc.steps ?? [],
      result: doc.result,
      durationMs: doc.durationMs ?? 0,
      playerNames: [names[0], names[1]],
      serverId: doc.matchId || doc._id,
      ...(Array.isArray(doc.characters)
        ? { characters: [String(doc.characters[0]), String(doc.characters[1])] as [string, string] }
        : {}),
    }
  }
}
