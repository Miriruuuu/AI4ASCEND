/**
 * 联机协议的类型定义（与 `back/PROTOCOL.md` 一一对应）。
 *
 * 该文件只放「消息结构」与协议常量，不含任何运行时逻辑；
 * 消息校验在 `ws.ts` 里做，服务端状态的构造在 `match.ts` 里做。
 */
import type { CharacterId } from './core/characters'
import type {
  AttackSnapshot,
  GameResult,
  MagicConfig,
  MagicKind,
  MatchPhase,
  NightConfig,
  NightPhase,
  PlayerIndex,
  WeatherId,
} from './core/types'

/**
 * 协议版本；握手时校验，不一致直接 `error: versionMismatch`。
 *
 * - v1：初始版本（匹配成功 / 建房加入即开局）。
 * - v2（bugv34e）：引入**房间（大厅）** —— 匹配与建房都先进房间，房主点「开始游戏」才开局；
 *   房间内可选角色 / 改房间设置 / 聊天 / 转让房主；断线可凭房间号回到房间。
 * - v3（bugv34i）：**联机需要登录**（注册 / 登录 / 长期令牌），
 *   且开局改为**双方都点「准备」才自动开始**（`roomReady` 取代 `startGame`）。
 */
export const PROTOCOL_VERSION = 3

/** WebSocket 路径（同源部署时前端直接连 `ws(s)://<host>/ws`）。 */
export const WS_PATH = '/ws'

// ---------------------------------------------------------------------------
// 公共结构
// ---------------------------------------------------------------------------

/** 服务端掷出的骰子：`rolls` 为两颗骰子点数，`first` 为由此决定的首发方。 */
export interface Dice {
  readonly rolls: readonly [number, number]
  readonly first: PlayerIndex
}

/** `applied` 的落子类型（bugv10 #11 新增 `skill`）。 */
export type MoveKind = 'place' | 'defend' | 'skill'

/** 技能步骤的原始参数（bugv10 #11）。 */
export interface ReplaySkill {
  readonly slot: number
  readonly cells: number[]
  readonly target: number | null
}

/**
 * 一步之后引擎里"新技能状态"的快照（bugv10 #11）。
 *
 * 每一步都会带，前端回放跳步时必须用它把这些字段一起恢复，
 * 否则回放到技能步骤之后局面就会与真实对局错开。
 */
export interface ReplayExtra {
  readonly shield: [number, number]
  readonly bonusActions: [number, number]
  readonly actionsTaken: [number, number]
  readonly skillReadyAt: [number[], number[]]
  readonly turnNo: number
  readonly immuneUntil: [number, number]
  /** `[cell, 剩余燃烧回合][]`。 */
  readonly flames: Array<[number, number]>
  /** `[cell, 叠子的一方][]`。 */
  readonly overlay: Array<[number, number]>
  readonly lastPlacedBy: [number | null, number | null]
  /** 「双子星」的爆发窗口（bugv11 #5：两连即可攻击 + 免反击）。 */
  readonly twinStar?: [boolean, boolean]
  /** 各技能已经释放过几次（bugv11 #6：恶龙吐息首次免费）。 */
  readonly skillCasts?: [number[], number[]]
  /**
   * bugv27 #4：以下都是"新角色"引入的状态，每一步都会带；
   * 缺一项，重连 / 回放到技能步之后局面就会与真实对局错开。
   */
  /** 「小一哥」增伤持续到第几回合（bugv12 #2 / bugv18 #2 持续 5 回合）。 */
  readonly powerUntil?: [number, number]
  /** 本回合是否可以在敌方棋子上落子（毒鸡蛋）。 */
  readonly sabotage?: [boolean, boolean]
  /** 本回合毒鸡蛋的额外伤害（bugv12 #3，可与小一哥叠加）。 */
  readonly sabotageBonus?: [number, number]
  /** 下次「双子星」是否消耗 -1（bugv12 #3 / bugv14）。 */
  readonly bloomCheaperNext?: [boolean, boolean]
  /** 临时护甲与到期回合（bugv14 精密计算）。 */
  readonly tempArmor?: [number, number]
  readonly tempArmorUntil?: [number, number]
  /** 「力大砖飞」的额外攻击值与到期回合（bugv14）。 */
  readonly strikeBonus?: [number, number]
  readonly strikeUntil?: [number, number]
  /** 「布局」窗口（bugv14）。 */
  readonly seedGrow?: [boolean, boolean]
  /** bugv19：低消耗档「杀鲸霸拳」——本回合本方植物不加伤。 */
  readonly noPlantBonus?: [boolean, boolean]
  /** 烈焰归属（bugv14）：`[cell, 主人][]`。 */
  readonly flameOwner?: Array<[number, number]>
  /** 黑夜阶段 / 预告剩余 / 持续回合 / 距上次结束（bugv34）。 */
  readonly nightPhase?: NightPhase
  readonly nightCountdown?: number
  readonly nightTurns?: number
  readonly turnsSinceNight?: number
  /** 当前天气（bugv34；bugv34c 起 7 种）。 */
  readonly weather?: WeatherId | null
  /** 双方发起过的攻击棋子数 + 本次黑夜起点（bugv34）。 */
  readonly attacksLaunched?: [number, number]
  readonly nightAttackBase?: [number, number]
  /** 本次黑夜是否由「黑夜开局」触发（bugv34d；联机恒 false）。 */
  readonly nightFromStart?: boolean
  /** bugv34m：Qwen「本地部署」的窗口与本回合伤害加成。 */
  readonly deploy?: [boolean, boolean]
  readonly deployBonus?: [number, number]
  /** bugv34m：Qwen「小千问」待重新部署的棋子（编码值：原格 * 2 + 叠子位）。 */
  readonly redeployPending?: [number[], number[]]
}

/** 一步回放快照（与前端 `ReplayStep` 同构）。 */
export interface ReplayStep {
  readonly player: PlayerIndex
  readonly cell: number
  /** 该步是否为攻击阶段的防守落子。 */
  readonly defense: boolean
  /** 该步之后是否形成连珠。 */
  readonly match: boolean
  /** 该步**结算完毕后**的棋盘快照（81 格）。 */
  readonly board: number[]
  /** 该步结算完毕后的血量。 */
  readonly hp: [number, number]
  /** 该步结算完毕后的魔力植物（bugv8 #4，老回放没有这个字段）。 */
  readonly magic?: Array<{ cell: number; kind: MagicKind; owner: PlayerIndex | null }>
  /** 该步由技能产生时的技能参数（bugv10 #11，老回放没有这个字段）。 */
  readonly skill?: ReplaySkill
  /** 该步结算完毕后的技能状态（bugv10 #11，老回放没有这个字段）。 */
  readonly extra?: ReplayExtra
}

/** 对手离开的原因。 */
export type OpponentLeftReason = 'disconnect' | 'leave'

/**
 * 房间设置（bugv34e）：房主在房间里可调，**开局时下发给两端**。
 *
 * 两端用的是同一份设置（服务端裁决 + 客户端镜像），所以改设置不会造成指纹漂移。
 * 与前端 `src/app/online.ts` 的同名类型必须保持一致。
 */
export interface RoomSettings {
  /** 血量上限（同时是回血上限与护盾上限）。 */
  hpLimit: number
  /** 魔力植物配置（已是 resolve 过的完整配置）。 */
  magic: MagicConfig
  /** 黑夜配置（已是 resolve 过的完整配置）。 */
  night: NightConfig
}

/** 房间设置的增量补丁（只传要改的字段）。 */
export interface RoomSettingsPatch {
  readonly hpLimit?: number
  readonly magic?: Partial<MagicConfig>
  readonly night?: Partial<NightConfig>
}

/** 房间成员（发给客户端的信息）。 */
export interface RoomMemberInfo {
  readonly playerId: string
  readonly name: string
  readonly character: CharacterId
  /** 是否在线（断线后保留在房间里，标记为离线，可凭房间号回来）。 */
  readonly connected: boolean
  readonly host: boolean
  /** 该成员在本房间的累计胜场（房间销毁即清零）。 */
  readonly wins: number
  /** 是否已点「准备」（bugv34i：双方都准备才自动开局）。 */
  readonly ready: boolean
}

/** 房间聊天条目。 */
export interface RoomChatEntry {
  readonly id: number
  readonly playerId: string
  readonly name: string
  readonly text: string
  readonly at: number
}

/** 错误码（见 PROTOCOL.md 第 6 节）。 */
export type ErrorCode =
  | 'badRequest'
  | 'versionMismatch'
  | 'notInMatch'
  | 'notYourTurn'
  | 'illegalMove'
  | 'roomNotFound'
  | 'roomFull'
  | 'alreadyQueued'
  | 'serverBusy'
  /** 同一 playerId 在别的新连接上登录，旧连接被踢（bugv7 #1）。 */
  | 'duplicateLogin'
  /** 不是房主，不能改房间设置 / 开始游戏 / 转让房主（bugv34e）。 */
  | 'notHost'
  /** 房间正在对局中，此时不能改设置 / 加人（bugv34e）。 */
  | 'roomPlaying'
  /** 人数不足（开始游戏需要两人）（bugv34e）。 */
  | 'roomNotReady'
  /** 该玩家不在这个房间里（bugv34e）。 */
  | 'notInRoom'
  /** 未登录就做联机操作（bugv34i）。 */
  | 'notLoggedIn'
  /** 登录：账号不存在（前端据此引导去注册）。 */
  | 'userNotFound'
  /** 登录：密码不正确。 */
  | 'wrongPassword'
  /** 注册：账号已被占用。 */
  | 'usernameTaken'
  /** 账号 / 密码格式不合法。 */
  | 'badUsername'
  | 'badPassword'
  /**
   * 登录已失效（bugv34l「顶号」）。
   *
   * 两种触发：
   * - **同一账号**在别的新连接上登录 → 旧连接被顶掉，服务端关闭它（4002）；
   * - `hello` 带来的令牌服务端认不出来（已在别处登录 / 已退出登录）→ 只是提示，
   *   连接照常完成握手，客户端清掉本地登录态即可。
   *
   * 与 `duplicateLogin` 的区别：后者针对**同一 playerId**（同浏览器多标签共用
   * localStorage），这里针对**同一账号**（不同设备登同一个号）。
   */
  | 'sessionExpired'

// ---------------------------------------------------------------------------
// 客户端 -> 服务端
// ---------------------------------------------------------------------------

export interface HelloMessage {
  readonly t: 'hello'
  readonly playerId: string
  readonly name?: string
  readonly version: number
  /**
   * 长期登录令牌（bugv34i）。带上它服务端会**自动恢复登录态**，
   * 于是"不退出登录就一直保持登录"（前端把它存在 localStorage）。
   */
  readonly token?: string
}

/** 登录（bugv34i）。账号不存在时回 `error: userNotFound`（前端据此引导去注册）。 */
export interface LoginMessage {
  readonly t: 'login'
  readonly username: string
  readonly password: string
}

/** 注册（bugv34i）。昵称可为空（服务端按 playerId 兜底）。 */
export interface RegisterMessage {
  readonly t: 'register'
  readonly username: string
  readonly password: string
  readonly nickname?: string
}

/** 退出登录（作废令牌）。 */
export interface LogoutMessage {
  readonly t: 'logout'
}

export interface QueueMessage {
  readonly t: 'queue'
  readonly name?: string
  /** 本局使用的角色（bugv10 #11）；非法 / 缺省时按座位退回默认角色。 */
  readonly character?: string
}

export interface CancelQueueMessage {
  readonly t: 'cancelQueue'
}

export interface CreateRoomMessage {
  readonly t: 'createRoom'
  readonly name?: string
  /** 本局使用的角色（bugv10 #11）。 */
  readonly character?: string
}

export interface JoinRoomMessage {
  readonly t: 'joinRoom'
  readonly code: string
  readonly name?: string
  /** 本局使用的角色（bugv10 #11）。 */
  readonly character?: string
}

export interface MoveMessage {
  readonly t: 'move'
  readonly matchId: string
  readonly cell: number
}

/** 使用角色技能（bugv10 #11）。 */
export interface SkillMessage {
  readonly t: 'skill'
  readonly matchId: string
  /** 技能槽位（0 = 一技能，1 = 二技能）。 */
  readonly slot: number
  /** 要消耗的魔力植物格子（必须正好 `cost` 格，且都被我方占着）。 */
  readonly cells: number[]
  /** 需要点选目标格的技能（恶龙吐息）的棋盘下标。 */
  readonly target?: number | null
}

export interface SyncMessage {
  readonly t: 'sync'
  readonly matchId: string
}

export interface ResignMessage {
  readonly t: 'resign'
  readonly matchId: string
}

export interface LeaveMessage {
  readonly t: 'leave'
  readonly matchId?: string
}

export interface PingMessage {
  readonly t: 'ping'
}

// --- bugv34e：房间（大厅）相关 -------------------------------------------

/** 修改房间设置（**仅房主**，且房间不在对局中）。 */
export interface RoomSettingsMessage {
  readonly t: 'roomSettings'
  readonly settings: RoomSettingsPatch
}

/** 在房间里改自己的角色（对局开始前随时可改）。 */
export interface RoomCharacterMessage {
  readonly t: 'roomCharacter'
  readonly character: string
}

/** 在房间里发一条聊天。 */
export interface ChatMessage {
  readonly t: 'chat'
  readonly text: string
}

/** 转让房主（**仅房主**）。`to` = 目标成员 playerId。 */
export interface TransferHostMessage {
  readonly t: 'transferHost'
  readonly to: string
}

/**
 * 点「准备」/ 取消准备（bugv34i）。
 *
 * 房间里**双方都准备**时服务端自动开局（不再有单独的「开始游戏」动作）。
 */
export interface RoomReadyMessage {
  readonly t: 'roomReady'
  readonly ready: boolean
}

/** 回到房间（断线 / 刷新后凭房间号回来；已经是成员时等同重连）。 */
export interface RejoinRoomMessage {
  readonly t: 'rejoinRoom'
  readonly code: string
  readonly name?: string
  readonly character?: string
}

export type ClientMessage =
  | HelloMessage
  | LoginMessage
  | RegisterMessage
  | LogoutMessage
  | QueueMessage
  | CancelQueueMessage
  | CreateRoomMessage
  | JoinRoomMessage
  | RejoinRoomMessage
  | RoomSettingsMessage
  | RoomCharacterMessage
  | ChatMessage
  | TransferHostMessage
  | RoomReadyMessage
  | MoveMessage
  | SkillMessage
  | SyncMessage
  | ResignMessage
  | LeaveMessage
  | PingMessage

export type ClientMessageType = ClientMessage['t']

// ---------------------------------------------------------------------------
// 服务端 -> 客户端
// ---------------------------------------------------------------------------

export interface WelcomeMessage {
  readonly t: 'welcome'
  readonly playerId: string
  readonly serverTime: number
  readonly version: number
  /** 是否已经带着有效令牌自动登录（bugv34i）。 */
  readonly authenticated: boolean
  /** 已登录时的账号 / 昵称。 */
  readonly username?: string
  readonly nickname?: string
}

/** 登录 / 注册成功（bugv34i）。`token` 要存下来，下次 `hello` 时回传。 */
export interface LoggedInMessage {
  readonly t: 'loggedIn'
  readonly playerId: string
  readonly username: string
  readonly nickname: string
  readonly token: string
  readonly serverTime: number
}

/** 已退出登录（令牌已作废）。 */
export interface LoggedOutMessage {
  readonly t: 'loggedOut'
}

export interface QueuedMessage {
  readonly t: 'queued'
  /** 队列位置，从 1 开始。 */
  readonly position: number
}

export interface QueueCanceledMessage {
  readonly t: 'queueCanceled'
}

export interface RoomCreatedMessage {
  readonly t: 'roomCreated'
  readonly code: string
}

export interface MatchedMessage {
  readonly t: 'matched'
  readonly matchId: string
  readonly seat: PlayerIndex
  /** 房间号（bugv34e：建房与在线匹配都会先有房间，因此这里恒为房间号）。 */
  readonly code: string | null
  /** 对手昵称。 */
  readonly opponent: string
  readonly dice: Dice
  /** 双方角色（bugv10 #11），按座位索引（0 = 先手方）。 */
  readonly characters: [CharacterId, CharacterId]
  /** 本局的房间设置（bugv34e：血量上限 / 魔力植物 / 黑夜都由房间决定）。 */
  readonly settings: RoomSettings
}

/**
 * 房间（大厅）全量状态（bugv34e）。
 *
 * 任何一次房间内变化（加入 / 离开 / 上下线 / 改设置 / 换角色 / 换房主 / 聊天 / 开局 / 结束）
 * 都向房间内所有**在线**成员广播一次，客户端整体替换自己的房间视图。
 * 房间号同时用于"断线后回到房间"。
 */
export interface RoomStateMessage {
  readonly t: 'roomState'
  readonly code: string
  /** 收信者自己的 playerId（客户端用它定位"我"）。 */
  readonly you: string
  readonly members: RoomMemberInfo[]
  readonly settings: RoomSettings
  readonly phase: 'lobby' | 'playing'
  /** 对局中时的对局 id（`phase === 'playing'` 时有；重连要拿它去 `sync`）。 */
  readonly matchId: string | null
  /** 聊天记录（按时间升序，最多保留最近若干条）。 */
  readonly chat: RoomChatEntry[]
  /** 是否已满足开局条件（bugv34i：两人都在线**且都已准备**）。 */
  readonly canStart: boolean
}

/** 聊天广播（bugv34e）。 */
export interface RoomChatMessage {
  readonly t: 'roomChat'
  readonly entry: RoomChatEntry
}

/** 房间被销毁（bugv34e：所有成员都退出了）。 */
export interface RoomClosedMessage {
  readonly t: 'roomClosed'
  readonly reason: 'empty' | 'left'
}

export interface AppliedMessage {
  readonly t: 'applied'
  readonly matchId: string
  readonly seq: number
  /** 该步的落子方座位。 */
  readonly seat: PlayerIndex
  readonly kind: MoveKind
  readonly cell: number
  readonly hp: [number, number]
  readonly current: PlayerIndex
  readonly phase: MatchPhase
  readonly digest: string
  /** 未结束时为 null。 */
  readonly result: GameResult | null
  /** 技能槽位（`kind === 'skill'` 时有）。 */
  readonly slot?: number
  /** 技能消耗的魔力植物格子（`kind === 'skill'` 时有）。 */
  readonly cells?: number[]
  /** 技能目标格（`kind === 'skill'` 时有；不需要目标的技能为 null）。 */
  readonly target?: number | null
}

export interface StateMessage {
  readonly t: 'state'
  readonly matchId: string
  readonly seq: number
  /** 收信者的座位。 */
  readonly seat: PlayerIndex
  readonly board: number[]
  readonly hp: [number, number]
  readonly current: PlayerIndex
  readonly phase: MatchPhase
  readonly firstPlayer: PlayerIndex | null
  readonly highlightOwner: PlayerIndex | null
  /** `[cell, weight][]`。 */
  readonly highlights: Array<[number, number]>
  readonly attack: AttackSnapshot | null
  readonly digest: string
  readonly result: GameResult | null
  /** 魔力植物（bugv8 #4）：重连后必须一起恢复，否则指纹会漂移。 */
  readonly magic: Array<{ cell: number; kind: MagicKind; owner: PlayerIndex | null }>
  readonly magicGrowths: number
  readonly magicCooldown: number
  readonly magicLineSeen: boolean
  /** 双方角色（bugv10 #11），按座位索引。 */
  readonly characters: [CharacterId, CharacterId]
  /** 护盾（bugv9 #13）。 */
  readonly shield: [number, number]
  /** 剩余"连续行动"次数（bugv10 #4）。 */
  readonly bonusActions: [number, number]
  /** 各方已行动次数（技能冷却基准）。 */
  readonly actionsTaken: [number, number]
  /** 各技能"可以再次使用"的行动次数门槛。 */
  readonly skillReadyAt: [number[], number[]]
  /** 各方最近一颗棋子的位置（绽放技能围绕它生长）。 */
  readonly lastPlacedBy: [number | null, number | null]
  /** 回合序号（bugv10 #9）。 */
  readonly turnNo: number
  /** 无敌持续到第几回合（bugv10 #9 精密计算）。 */
  readonly immuneUntil: [number, number]
  /** 烈焰：`[cell, 剩余燃烧回合][]`（bugv10 #9 恶龙吐息）。 */
  readonly flames: Array<[number, number]>
  /** 叠在敌方棋子上的额外棋子：`[cell, 叠子的一方][]`（bugv10 #9 毒鸡蛋）。 */
  readonly overlay: Array<[number, number]>
  /** 本回合伤害加成（bugv10 #9 小一哥）：不参与指纹，但重连要能接着算伤害。 */
  readonly powerBonus: [number, number]
  /** 本回合是否可以在敌方棋子上落子（bugv10 #9 毒鸡蛋）。 */
  readonly sabotage: [boolean, boolean]
  /** 「双子星」的爆发窗口（bugv11 #5）：两连即可攻击 + 免疫反击。 */
  readonly twinStar: [boolean, boolean]
  /** 各技能已经释放过几次（bugv11 #6：首次免费）。 */
  readonly skillCasts: [number[], number[]]
  /**
   * bugv27 #4：以下字段都是"新角色"引入的状态。
   *
   * 前端 `applyOnlineState()` 早就会读它们，但服务端一直没下发 ⇒
   * 用这些角色联机时，重连 / 漂移自愈后本地状态是**残缺**的
   * （gtp 的 6 点临时护甲、烈焰归属，glm 的增伤到期回合，claude 的播种窗口，
   * deepseek 的"不加伤"档全丢）。
   */
  /** 「小一哥」增伤持续到第几回合。 */
  readonly powerUntil: [number, number]
  /** 本回合毒鸡蛋的额外伤害。 */
  readonly sabotageBonus: [number, number]
  /** 下次「双子星」是否消耗 -1。 */
  readonly bloomCheaperNext: [boolean, boolean]
  /** 临时护甲与到期回合（精密计算）。 */
  readonly tempArmor: [number, number]
  readonly tempArmorUntil: [number, number]
  /** 「力大砖飞」的额外攻击值与到期回合。 */
  readonly strikeBonus: [number, number]
  readonly strikeUntil: [number, number]
  /** 「布局」窗口。 */
  readonly seedGrow: [boolean, boolean]
  /** 低消耗档「杀鲸霸拳」：本回合本方植物不加伤。 */
  readonly noPlantBonus: [boolean, boolean]
  /** 烈焰归属：`[cell, 主人][]`。 */
  readonly flameOwner: Array<[number, number]>
  /** 黑夜阶段 / 预告剩余 / 持续回合 / 距上次结束（bugv34）。 */
  readonly nightPhase: NightPhase
  readonly nightCountdown: number
  readonly nightTurns: number
  readonly turnsSinceNight: number
  /** 当前天气（bugv34；bugv34c 起 7 种）。 */
  readonly weather: WeatherId | null
  /** 双方发起过的攻击棋子数 + 本次黑夜起点（bugv34）。 */
  readonly attacksLaunched: [number, number]
  readonly nightAttackBase: [number, number]
  /** 本次黑夜是否由「黑夜开局」触发（bugv34d；联机恒 false）。 */
  readonly nightFromStart: boolean
  /** bugv34m：Qwen「本地部署」的窗口与本回合伤害加成。 */
  readonly deploy: [boolean, boolean]
  readonly deployBonus: [number, number]
  /** bugv34m：Qwen「小千问」待重新部署的棋子（编码值：原格 * 2 + 叠子位）。 */
  readonly redeployPending: [number[], number[]]
}

export interface GameOverMessage {
  readonly t: 'gameOver'
  readonly matchId: string
  readonly result: GameResult
  /** 回放 id（等于 matchId），可用于 `GET /api/replays/:id`。 */
  readonly replayId: string
}

export interface OpponentLeftMessage {
  readonly t: 'opponentLeft'
  readonly matchId: string
  readonly reason: OpponentLeftReason
}

export interface ErrorMessage {
  readonly t: 'error'
  readonly code: ErrorCode
  readonly message: string
  /** 触发该错误的消息类型。 */
  readonly reqType?: string
}

export interface PongMessage {
  readonly t: 'pong'
  readonly time: number
}

export type ServerMessage =
  | WelcomeMessage
  | LoggedInMessage
  | LoggedOutMessage
  | QueuedMessage
  | QueueCanceledMessage
  | RoomCreatedMessage
  | RoomStateMessage
  | RoomChatMessage
  | RoomClosedMessage
  | MatchedMessage
  | AppliedMessage
  | StateMessage
  | GameOverMessage
  | OpponentLeftMessage
  | ErrorMessage
  | PongMessage

export type ServerMessageType = ServerMessage['t']

// ---------------------------------------------------------------------------
// REST 响应
// ---------------------------------------------------------------------------

export interface HealthResponse {
  readonly ok: boolean
  readonly db: 'mongo' | 'memory'
  readonly uptime: number
  readonly matches: number
  readonly version: number
}
