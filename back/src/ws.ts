/**
 * WebSocket 网关：握手、匹配、**房间（大厅）**、落子裁决、同步、认输、离开、心跳。
 *
 * 单一入口 `attachWebSocket(server, deps)`，路径固定 `/ws`。
 *
 * bugv34e 起联机流程是"**先进房间，房主点开始才开局**"：
 * 在线匹配 / 建房 / 加入房间 → 房间内（选角色 / 改设置 / 聊天 / 转让房主）→ 开始游戏。
 */
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import type { AuthService } from './auth'
import type { AppConfig } from './config'
import { isCharacterId, type CharacterId } from './core/characters'
import { resolveMagicConfig, resolveNightConfig, type PlayerIndex } from './core/types'
import type { MatchingService, Participant } from './matching'
import type { MatchManager, MatchRoom } from './match'
import type { Room, RoomManager } from './room'
import { sanitizeChat } from './room'
import type { Logger } from './logger'
import {
  PROTOCOL_VERSION,
  WS_PATH,
  type ClientMessage,
  type ClientMessageType,
  type ErrorCode,
  type RoomStateMessage,
  type ServerMessage,
} from './protocol'

/** 服务端主动 ws ping 的间隔。 */
export const HEARTBEAT_INTERVAL_MS = 30_000
/** 超过该时长没有 pong 就断开连接（两个心跳周期）。 */
export const HEARTBEAT_TIMEOUT_MS = 60_000
/**
 * 房间内**全部成员都离线**多久之后整个房间被回收。
 *
 * ⚠️ 只要还有一个人在线，房间（含比分 / 聊天）就无限期保留 ——
 * 离线的一方可以凭房间号随时回来（用户口径）。
 */
export const ROOM_OFFLINE_TTL_MS = 10 * 60 * 1000
const NAME_MAX_LENGTH = 24

export interface WsDeps {
  config: AppConfig
  matching: MatchingService
  matches: MatchManager
  rooms: RoomManager
  /** 账号服务（bugv34i：联机需要登录）。 */
  auth: AuthService
  logger: Logger
}

export interface WsHandle {
  readonly wss: WebSocketServer
  connectionCount(): number
  close(): Promise<void>
}

/** 已登录身份（bugv34i）。 */
interface AuthUser {
  readonly username: string
  nickname: string
}

interface Connection extends Participant {
  readonly id: string
  readonly socket: WebSocket
  playerId: string
  name: string
  live: boolean
  lastPongAt: number
  /** 玩家本局选择的角色（bugv10 #11）；未选 / 非法时为 undefined（成局时退回默认角色）。 */
  character?: CharacterId
  /** 已登录账号；未登录为 null（未登录不能匹配 / 建房 / 加入房间）。 */
  user: AuthUser | null
  /**
   * 登录账号字符串（bugv34k；未登录为 null）。
   *
   * 它会被带进 `MatchRoom` → 回放文档的 `accounts` 字段，用来把回放**挂到账号上**。
   */
  account: string | null
}

const CLIENT_MESSAGE_TYPES: ReadonlyArray<ClientMessageType> = [
  'hello',
  'login',
  'register',
  'logout',
  'queue',
  'cancelQueue',
  'createRoom',
  'joinRoom',
  'rejoinRoom',
  'roomSettings',
  'roomCharacter',
  'chat',
  'transferHost',
  'roomReady',
  'move',
  'skill',
  'sync',
  'resign',
  'leave',
  'ping',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 昵称清洗：去控制字符、限长、空则给默认值。 */
export function sanitizeName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, NAME_MAX_LENGTH)
  return cleaned === '' ? fallback : cleaned
}

function defaultName(playerId: string): string {
  return `玩家${playerId.replace(/-/g, '').slice(0, 4) || '????'}`
}

/**
 * 记录玩家选择的角色（bugv10 #11）。
 *
 * 只在 `isCharacterId` 通过时才写入；缺省 / 非法一律保持原值，
 * 成局时再由 `resolveCharacters()` 按座位退回默认角色。
 */
function applyCharacter(connection: Connection, raw: unknown): void {
  if (isCharacterId(raw)) connection.character = raw
}

export function attachWebSocket(server: Server, deps: WsDeps): WsHandle {
  const { matching, matches, rooms, auth, logger } = deps
  const wss = new WebSocketServer({ noServer: true })
  const connections = new Map<string, Connection>()
  const log = logger.child('ws')

  // --- 升级握手：只接受 /ws -------------------------------------------
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = req.url ?? '/'
    const queryIndex = pathname.indexOf('?')
    if (queryIndex >= 0) pathname = pathname.slice(0, queryIndex)
    if (pathname !== WS_PATH && pathname !== `${WS_PATH}/`) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  function send(connection: Connection, message: ServerMessage): void {
    if (connection.socket.readyState !== WebSocket.OPEN) return
    try {
      connection.socket.send(JSON.stringify(message))
    } catch (error) {
      log.warn(`发送失败 ${connection.playerId || connection.id}`, error)
    }
  }

  function sendError(connection: Connection, code: ErrorCode, message: string, reqType?: string): void {
    send(connection, reqType === undefined ? { t: 'error', code, message } : { t: 'error', code, message, reqType })
  }

  /** 该玩家当前**在线**的连接（离线返回 null）。 */
  function connectionOf(playerId: string): Connection | null {
    for (const connection of connections.values()) {
      if (connection.playerId === playerId) return connection
    }
    return null
  }

  // -------------------------------------------------------------------------
  // 房间（大厅）
  // -------------------------------------------------------------------------

  /** 给房间内所有**在线**成员各发一份"以他自己为视角"的房间状态。 */
  function broadcastRoom(room: Room): void {
    for (const memberId of room.members.keys()) {
      const target = connectionOf(memberId)
      if (!target) continue
      send(target, roomStateMessage(room, memberId))
    }
  }

  function roomStateMessage(room: Room, viewerId: string): RoomStateMessage {
    const snapshot = room.snapshot(viewerId)
    return { t: 'roomState', ...snapshot }
  }

  /** 把某名玩家从房间里**显式**移出（并广播 / 销毁）。 */
  function leaveRoom(connection: Connection, notify = true): void {
    const room = rooms.roomOfPlayer(connection.playerId)
    if (!room) return
    const destroyed = rooms.leave(connection.playerId)
    if (destroyed) {
      // 房间已销毁：自己在屏幕上要看到"房间关闭"
      if (notify) send(connection, { t: 'roomClosed', reason: 'left' })
      return
    }
    if (notify) send(connection, { t: 'roomClosed', reason: 'left' })
    broadcastRoom(room)
  }

  /** 释放"正在进行的一切"：队列 + 对局 + 房间（玩家要开始新的匹配 / 建房时调用）。 */
  /**
   * 「顶号」（bugv34l）：同一**账号**在别的新连接上登录 → 顶掉其他连接。
   *
   * 与 `duplicateLogin` 的分工：
   * - `duplicateLogin` 管**同一 playerId**（同浏览器多标签，共用 localStorage 里的 id）；
   * - 这里管**同一账号**（不同设备 / 不同浏览器登录同一个号，playerId 各不相同）。
   *
   * 被顶的连接收到 `error: sessionExpired` 后由服务端关闭（4002）；
   * 它随后会走正常的 `close` 分支（标记房间离线、通知对手等）。
   */
  function kickAccountPeers(connection: Connection): void {
    if (!connection.account) return
    for (const other of [...connections.values()]) {
      if (other === connection || other.account !== connection.account) continue
      log.warn(`账号 ${connection.account} 在别处登录，顶掉连接 ${other.id}（playerId=${other.playerId}）`)
      sendError(other, 'sessionExpired', '该账号已在别处登录，登录已失效', 'hello')
      connections.delete(other.id)
      matching.removePlayer(other.playerId)
      other.socket.close(4002, 'session expired')
    }
  }

  function releaseEverything(connection: Connection): void {
    const active = matches.roomOfPlayer(connection.playerId)
    if (active && active.status === 'active') matches.leave(connection.playerId, active.id)
    matching.cancel(connection.playerId)
    leaveRoom(connection, false)
  }

  /** 校验"我是不是这个房间的成员"，不是则发错并返回 null。 */
  function requireRoom(connection: Connection, reqType: string): Room | null {
    const room = rooms.roomOfPlayer(connection.playerId)
    if (!room) {
      sendError(connection, 'notInRoom', '你不在任何房间里', reqType)
      return null
    }
    return room
  }

  /** 校验"我是房主"，不是则发错并返回 false。 */
  function requireHost(connection: Connection, room: Room, reqType: string): boolean {
    if (!room.isHost(connection.playerId)) {
      sendError(connection, 'notHost', '只有房主可以进行这个操作', reqType)
      return false
    }
    return true
  }

  /**
   * 校验"已登录"（bugv34i）。
   *
   * 只有**进入联机**的三个动作（匹配 / 建房 / 加入房间）需要登录：
   * 一旦进了房间，后续的房间与对局消息自然都是已登录的人发出的。
   */
  function requireAuth(connection: Connection, reqType: string): boolean {
    if (connection.user) return true
    sendError(connection, 'notLoggedIn', '请先登录账号再进行联机对战', reqType)
    return false
  }

  /**
   * 满足开局条件就开局（bugv34i：**双方都准备**时自动开始）。
   *
   * 房主归属只影响"谁能改房间设置"，不再影响开局 —— 房间里没有「开始游戏」按钮了。
   */
  function tryStartMatch(room: Room): void {
    if (!room.canStart) return
    const ordered = room.orderedMemberIds()
    const hostId = ordered[0]
    const guestId = ordered[1]
    if (!hostId || !guestId) return
    const hostMember = room.member(hostId)
    const guestMember = room.member(guestId)
    const hostConn = connectionOf(hostId)
    const guestConn = connectionOf(guestId)
    if (!hostMember || !guestMember || !hostConn || !guestConn) return

    const match = matches.create(
      hostConn,
      guestConn,
      room.code,
      [hostMember.character, guestMember.character],
      room.settings,
    )
    room.beginMatch(match.id, Date.now())
    for (const player of match.players) player.send(match.matchedMessageFor(player))
    broadcastRoom(room)
    log.info(
      `房间 ${room.code} 双方已准备，开局 ${match.id}：血量上限 ${room.settings.hpLimit}，` +
        `骰子 ${match.dice.rolls[0]}:${match.dice.rolls[1]}，先手座位 ${match.dice.first}`,
    )
  }

  /**
   * 一局结束：把胜负记进房间比分，房间退回大厅，并广播新状态。
   *
   * `winnerSeat` 是**座位**（null = 平局 / 对局作废不计分），这里换算成 playerId 记账。
   */
  function afterMatchOver(room: MatchRoom, winnerSeat: PlayerIndex | null): void {
    const gameRoom = room.code ? rooms.get(room.code) : null
    if (!gameRoom) return
    const winnerId = winnerSeat === null ? null : room.players.find((player) => player.seat === winnerSeat)?.playerId ?? null
    rooms.finishMatch(gameRoom, winnerId)
    broadcastRoom(gameRoom)
  }

  /** 简易字段校验：只做结构检查，语义检查留给后续逻辑。 */
  function validate(message: ClientMessage): string | null {
    switch (message.t) {
      case 'hello':
        if (typeof message.playerId !== 'string' || message.playerId.trim() === '') return 'hello.playerId 必须是非空字符串'
        if (typeof message.version !== 'number') return 'hello.version 必须是数字'
        return null
      case 'joinRoom':
      case 'rejoinRoom':
        if (typeof message.code !== 'string' || message.code.trim() === '') return `${message.t}.code 必须是非空字符串`
        if (message.character !== undefined && typeof message.character !== 'string') {
          return `${message.t}.character 必须是字符串`
        }
        return null
      case 'roomSettings':
        if (!isRecord(message.settings)) return 'roomSettings.settings 必须是对象'
        return null
      case 'login':
        if (typeof message.username !== 'string' || message.username.trim() === '') {
          return 'login.username 必须是非空字符串'
        }
        if (typeof message.password !== 'string') return 'login.password 必须是字符串'
        return null
      case 'register':
        if (typeof message.username !== 'string' || message.username.trim() === '') {
          return 'register.username 必须是非空字符串'
        }
        if (typeof message.password !== 'string') return 'register.password 必须是字符串'
        if (message.nickname !== undefined && typeof message.nickname !== 'string') {
          return 'register.nickname 必须是字符串'
        }
        return null
      case 'roomReady':
        if (typeof message.ready !== 'boolean') return 'roomReady.ready 必须是布尔值'
        return null
      case 'roomCharacter':
        if (typeof message.character !== 'string') return 'roomCharacter.character 必须是字符串'
        return null
      case 'chat':
        if (typeof message.text !== 'string') return 'chat.text 必须是字符串'
        return null
      case 'transferHost':
        if (typeof message.to !== 'string' || message.to.trim() === '') return 'transferHost.to 必须是非空字符串'
        return null
      case 'move':
        if (typeof message.matchId !== 'string' || message.matchId === '') return 'move.matchId 必须是非空字符串'
        if (typeof message.cell !== 'number') return 'move.cell 必须是数字'
        return null
      case 'skill':
        if (typeof message.matchId !== 'string' || message.matchId === '') return 'skill.matchId 必须是非空字符串'
        if (!Number.isInteger(message.slot)) return 'skill.slot 必须是整数'
        if (!Array.isArray(message.cells) || message.cells.some((cell) => typeof cell !== 'number')) {
          return 'skill.cells 必须是数字数组'
        }
        if (message.target !== undefined && message.target !== null && typeof message.target !== 'number') {
          return 'skill.target 必须是数字或 null'
        }
        return null
      case 'sync':
      case 'resign':
        if (typeof message.matchId !== 'string' || message.matchId === '') return `${message.t}.matchId 必须是非空字符串`
        return null
      case 'leave':
        if (message.matchId !== undefined && typeof message.matchId !== 'string') return 'leave.matchId 必须是字符串'
        return null
      case 'queue':
      case 'createRoom':
        if (message.name !== undefined && typeof message.name !== 'string') return `${message.t}.name 必须是字符串`
        if (message.character !== undefined && typeof message.character !== 'string') {
          return `${message.t}.character 必须是字符串`
        }
        return null
      case 'cancelQueue':
      case 'logout':
      case 'ping':
        return null
      default:
        return '未知消息类型'
    }
  }

  wss.on('connection', (socket: WebSocket) => {
    const connection: Connection = {
      id: `c${connections.size + 1}-${Date.now().toString(36)}`,
      socket,
      playerId: '',
      name: '',
      live: true,
      lastPongAt: Date.now(),
      user: null,
      account: null,
      send: (message: ServerMessage) => send(connection, message),
    }
    connections.set(connection.id, connection)

    /**
     * 串行处理消息（bugv34i）。
     *
     * 登录 / 注册要读写数据库（异步），而"必须先 hello"这类顺序约束不能被打乱，
     * 所以每条连接上的消息排队执行，前一条处理完才开始下一条。
     */
    let pending: Promise<void> = Promise.resolve()
    log.debug(`连接建立 ${connection.id}，当前 ${connections.size} 个连接`)

    socket.on('pong', () => {
      connection.live = true
      connection.lastPongAt = Date.now()
    })

    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      pending = pending
        .then(() => handleRaw(connection, raw))
        .catch((error: unknown) => log.warn(`处理消息出错 ${connection.playerId || connection.id}`, error))
    })

    socket.on('error', (error: Error) => {
      log.warn(`连接异常 ${connection.playerId || connection.id}`, error.message)
    })

    socket.on('close', () => {
      connections.delete(connection.id)
      if (connection.playerId) {
        // 同一身份已经在新连接上登录（页面刷新 / 多标签页）→ 什么都不要动，
        // 让新连接用 `sync` 把自己的局面接回来。
        const replaced = [...connections.values()].some((item) => item.playerId === connection.playerId)
        if (replaced) {
          log.info(`连接 ${connection.id} 关闭，但身份 ${connection.playerId} 仍在线，保留对局与房间`)
        } else {
          matching.removePlayer(connection.playerId)
          const outcome = matches.disconnect(connection.playerId)
          if (outcome) {
            log.info(`玩家 ${connection.playerId} 断开，对手 ${outcome.opponent.name} 收到 opponentLeft`)
            afterMatchOver(outcome.room, null)
          }
          // ⚠️ 房间**不销毁**：只把成员标记为离线，凭房间号可以回来（用户口径）。
          const room = rooms.markOffline(connection.playerId)
          if (room) {
            log.info(`玩家 ${connection.playerId} 离线（房间 ${room.code} 保留）`)
            broadcastRoom(room)
          }
        }
      }
      log.debug(`连接关闭 ${connection.id}，当前 ${connections.size} 个连接`)
    })
  })

  async function handleRaw(connection: Connection, raw: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString('utf8')
      : Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : Buffer.from(raw).toString('utf8')

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      sendError(connection, 'badRequest', '消息不是合法 JSON')
      return
    }
    if (!isRecord(parsed) || typeof parsed.t !== 'string') {
      sendError(connection, 'badRequest', '消息缺少字段 t')
      return
    }
    const type = parsed.t
    if (!CLIENT_MESSAGE_TYPES.includes(type as ClientMessageType)) {
      sendError(connection, 'badRequest', `未知消息类型 ${type}`, type)
      return
    }
    const message = parsed as unknown as ClientMessage
    const invalid = validate(message)
    if (invalid) {
      sendError(connection, 'badRequest', invalid, type)
      return
    }

    // --- 握手 ---------------------------------------------------------
    if (!connection.playerId) {
      if (message.t !== 'hello') {
        sendError(connection, 'badRequest', '必须先发送 hello 完成握手', message.t)
        return
      }
      if (message.version !== PROTOCOL_VERSION) {
        sendError(
          connection,
          'versionMismatch',
          `协议版本不一致：服务端 ${PROTOCOL_VERSION}，客户端 ${message.version}`,
          'hello',
        )
        return
      }
      connection.playerId = message.playerId.trim()
      connection.name = sanitizeName(message.name, defaultName(connection.playerId))

      // bugv34i：带上有效令牌 → 自动恢复登录态（"不退出登录就一直保持登录"）
      const restored = await auth.byToken(message.token)
      if (restored) {
        connection.user = { username: restored.username, nickname: restored.nickname }
        connection.account = restored.username
        connection.name = sanitizeName(restored.nickname, connection.name)
      } else if (typeof message.token === 'string' && message.token.trim() !== '') {
        // 带了令牌但服务端认不出来 = 这枚令牌已经被作废（在别处登录 / 已退出登录）。
        // 握手照常完成（客户端要能重新登录），只是通知它"登录已失效"并清本地登录态（bugv34l）。
        sendError(connection, 'sessionExpired', '登录已失效，请重新登录', 'hello')
      }

      // 同一身份的旧连接要踢掉（浏览器多标签页共用 localStorage 里的 playerId）。
      // 否则旧连接会一直占着座位：新标签页发的 move 会被判成"不属于这局"。
      const duplicate = [...connections.values()].find(
        (item) => item !== connection && item.playerId === connection.playerId,
      )
      if (duplicate) {
        log.warn(`身份 ${connection.playerId} 重复登录，踢掉旧连接 ${duplicate.id}`)
        sendError(duplicate, 'duplicateLogin', '该身份已在新的连接上登录，此连接已断开', 'hello')
        duplicate.socket.close(4001, 'duplicate login')
        connections.delete(duplicate.id)
        matching.removePlayer(duplicate.playerId)
      }

      // bugv34l：同一**账号**在别处登录 → 顶掉那边的连接（按账号，不按 playerId）
      kickAccountPeers(connection)

      send(connection, {
        t: 'welcome',
        playerId: connection.playerId,
        serverTime: Date.now(),
        version: PROTOCOL_VERSION,
        authenticated: connection.user !== null,
        ...(connection.user ? { username: connection.user.username, nickname: connection.user.nickname } : {}),
      })

      // 正在进行的对局要把广播目标换到这条新连接上，否则刷新页面之后
      // 只能靠 sync 拿一次局面，对手后续的每一步都发往旧连接（bugv7 #1）
      const room = matches.rebind(connection.playerId, connection)
      if (room) log.info(`身份 ${connection.playerId} 的连接已重绑到对局 ${room.id}`)

      // bugv34e：身份已经在一个房间里 → 自动"回到房间"（刷新 / 断线重连都走这里）
      const lobby = rooms.roomOfPlayer(connection.playerId)
      if (lobby) {
        lobby.markOnline(connection, Date.now())
        send(connection, roomStateMessage(lobby, connection.playerId))
        broadcastRoom(lobby)
        log.info(`身份 ${connection.playerId} 自动回到房间 ${lobby.code}（phase=${lobby.phase}）`)
      }

      log.info(`握手成功 ${connection.playerId}（${connection.name}）`)
      return
    }

    if (message.t === 'hello') {
      sendError(connection, 'badRequest', '重复的 hello', 'hello')
      return
    }

    switch (message.t) {
      case 'ping':
        send(connection, { t: 'pong', time: Date.now() })
        return

      // --- 账号（bugv34i） ------------------------------------------------
      case 'login':
      case 'register': {
        if (connection.user) {
          sendError(connection, 'badRequest', '已经登录了，无需重复登录', message.t)
          return
        }
        const result =
          message.t === 'login'
            ? await auth.login(message.username, message.password)
            : await auth.register(
                message.username,
                message.password,
                sanitizeName(message.nickname, defaultName(connection.playerId)),
              )
        if (!result.ok) {
          log.info(`${message.t} 失败：${result.code}（${message.username}）`)
          sendError(connection, result.code, result.message, message.t)
          return
        }
        connection.user = { username: result.user.username, nickname: result.user.nickname }
        connection.account = result.user.username
        connection.name = sanitizeName(result.user.nickname, defaultName(connection.playerId))
        // bugv34l「顶号」：同一账号在别处已登录 → 顶掉那些连接
        kickAccountPeers(connection)
        send(connection, {
          t: 'loggedIn',
          playerId: connection.playerId,
          username: result.user.username,
          nickname: result.user.nickname,
          token: result.token,
          serverTime: Date.now(),
        })
        // 同一身份（playerId）本来就在房间 / 对局里 → 登录后把身份放回去
        const lobby = rooms.roomOfPlayer(connection.playerId)
        if (lobby) {
          lobby.markOnline(connection, Date.now())
          send(connection, roomStateMessage(lobby, connection.playerId))
          broadcastRoom(lobby)
        }
        log.info(`${message.t} 成功：${result.user.username}（${result.user.nickname}）`)
        return
      }

      case 'logout': {
        if (connection.user) {
          await auth.logout(connection.user.username)
          log.info(`已退出登录：${connection.user.username}`)
        }
        connection.user = null
        connection.account = null
        releaseEverything(connection)
        send(connection, { t: 'loggedOut' })
        return
      }

      case 'queue': {
        if (!requireAuth(connection, 'queue')) return
        connection.name = sanitizeName(message.name, connection.name || defaultName(connection.playerId))
        applyCharacter(connection, message.character)
        releaseEverything(connection)
        const position = matching.enqueue(connection)
        // ⚠️ enqueue() 内部可能**立刻配对成功**（这时双方已经被放进同一个房间，
        // `roomState` 已经发出去了）。如果此时再补一条 `queued`，客户端会先收到
        // roomState、后收到 queued，把"房间里"覆盖成"排队中"。
        // 所以只有在确实还留在队列里时才回 `queued`。
        if (matching.positionOf(connection.playerId) === null) {
          log.debug(`${connection.playerId} 入队即配对成功，跳过 queued`)
          return
        }
        send(connection, { t: 'queued', position })
        log.debug(`${connection.playerId} 进入匹配队列，位置 ${position}`)
        return
      }

      case 'cancelQueue': {
        matching.cancel(connection.playerId)
        send(connection, { t: 'queueCanceled' })
        return
      }

      case 'createRoom': {
        if (!requireAuth(connection, 'createRoom')) return
        connection.name = sanitizeName(message.name, connection.name || defaultName(connection.playerId))
        applyCharacter(connection, message.character)
        releaseEverything(connection)
        const room = rooms.create(connection)
        send(connection, roomStateMessage(room, connection.playerId))
        log.debug(`${connection.playerId} 创建房间 ${room.code}`)
        return
      }

      case 'joinRoom':
      case 'rejoinRoom': {
        if (!requireAuth(connection, message.t)) return
        connection.name = sanitizeName(message.name, connection.name || defaultName(connection.playerId))
        applyCharacter(connection, message.character)
        // 加入别人的房间前先释放自己对局/队列（但**不**退出"我本来就在的那个房间"，
        // 否则"回到房间"会把自己的成员身份删掉）。
        const current = rooms.roomOfPlayer(connection.playerId)
        const active = matches.roomOfPlayer(connection.playerId)
        if (active && active.status === 'active') matches.leave(connection.playerId, active.id)
        matching.cancel(connection.playerId)
        if (current && current.code !== message.code.trim().toUpperCase()) leaveRoom(connection, false)
        const outcome = rooms.join(message.code, connection)
        if (!outcome.ok || !outcome.room) {
          sendError(connection, outcome.code ?? 'roomNotFound', outcome.message ?? '加入房间失败', message.t)
          return
        }
        broadcastRoom(outcome.room)
        return
      }

      case 'roomSettings': {
        const room = requireRoom(connection, 'roomSettings')
        if (!room) return
        if (!requireHost(connection, room, 'roomSettings')) return
        if (room.phase === 'playing') {
          sendError(connection, 'roomPlaying', '对局进行中不能修改房间设置', 'roomSettings')
          return
        }
        room.patchSettings(message.settings, resolveMagicConfig, resolveNightConfig, Date.now())
        log.debug(`房间 ${room.code} 设置已更新：${JSON.stringify(room.settings)}`)
        broadcastRoom(room)
        return
      }

      case 'roomCharacter': {
        const room = requireRoom(connection, 'roomCharacter')
        if (!room) return
        applyCharacter(connection, message.character)
        const member = room.member(connection.playerId)
        if (member && isCharacterId(message.character)) member.character = message.character
        room.lastActivityAt = Date.now()
        broadcastRoom(room)
        return
      }

      case 'chat': {
        const room = requireRoom(connection, 'chat')
        if (!room) return
        const member = room.member(connection.playerId)
        if (!member) {
          sendError(connection, 'notInRoom', '你不在这个房间里', 'chat')
          return
        }
        const entry = room.pushChat({ playerId: member.playerId, name: member.name }, message.text, Date.now())
        if (!entry) return
        for (const memberId of room.members.keys()) {
          const target = connectionOf(memberId)
          if (target) send(target, { t: 'roomChat', entry })
        }
        return
      }

      case 'transferHost': {
        const room = requireRoom(connection, 'transferHost')
        if (!room) return
        if (!requireHost(connection, room, 'transferHost')) return
        const to = message.to.trim()
        if (!room.transferHost(to, Date.now())) {
          sendError(connection, 'notInRoom', '目标成员不在房间里', 'transferHost')
          return
        }
        log.info(`房间 ${room.code} 房主转让给 ${to}`)
        broadcastRoom(room)
        return
      }

      case 'roomReady': {
        const room = requireRoom(connection, 'roomReady')
        if (!room) return
        if (room.phase === 'playing') {
          sendError(connection, 'roomPlaying', '房间正在对局中', 'roomReady')
          return
        }
        room.setReady(connection.playerId, message.ready, Date.now())
        broadcastRoom(room)
        // 双方都准备好 → 自动开局
        tryStartMatch(room)
        return
      }

      case 'move': {
        const outcome = matches.move(connection.playerId, message.matchId, message.cell)
        if (!outcome.ok) {
          sendError(connection, outcome.code, outcome.message, 'move')
          return
        }
        outcome.room.broadcast(outcome.applied)
        if (outcome.gameOver) {
          outcome.room.broadcast(outcome.gameOver)
          afterMatchOver(outcome.room, outcome.gameOver.result.winner)
          log.info(
            `对局 ${outcome.room.id} 结束：胜者 ${outcome.gameOver.result.winner ?? '平局'}，共 ${outcome.room.steps.length} 步`,
          )
        }
        return
      }

      case 'skill': {
        const outcome = matches.skill(
          connection.playerId,
          message.matchId,
          message.slot,
          message.cells,
          message.target ?? null,
        )
        if (!outcome.ok) {
          sendError(connection, outcome.code, outcome.message, 'skill')
          return
        }
        // 与 move 完全一致：成功后广播 applied（双方都收到），结束时再补 gameOver
        outcome.room.broadcast(outcome.applied)
        if (outcome.gameOver) {
          outcome.room.broadcast(outcome.gameOver)
          afterMatchOver(outcome.room, outcome.gameOver.result.winner)
          log.info(
            `对局 ${outcome.room.id} 结束：胜者 ${outcome.gameOver.result.winner ?? '平局'}，共 ${outcome.room.steps.length} 步`,
          )
        }
        return
      }

      case 'sync': {
        const state = matches.state(connection.playerId, message.matchId)
        if (!('t' in state)) {
          sendError(connection, state.code, state.message, 'sync')
          return
        }
        send(connection, state)
        return
      }

      case 'resign': {
        const outcome = matches.resign(connection.playerId, message.matchId)
        if (!outcome.ok) {
          sendError(connection, outcome.code, outcome.message, 'resign')
          return
        }
        outcome.room.broadcast(outcome.gameOver)
        afterMatchOver(outcome.room, outcome.gameOver.result.winner)
        log.info(`对局 ${outcome.room.id} 因认输结束：胜者 ${outcome.gameOver.result.winner ?? '平局'}`)
        return
      }

      case 'leave': {
        if (message.matchId) {
          const outcome = matches.leave(connection.playerId, message.matchId)
          if (!outcome.ok) {
            sendError(connection, outcome.code, outcome.message, 'leave')
            return
          }
          afterMatchOver(outcome.room, null)
          return
        }
        const wasQueued = matching.cancel(connection.playerId)
        const active = matches.roomOfPlayer(connection.playerId)
        if (active) matches.leave(connection.playerId, active.id)
        leaveRoom(connection)
        if (wasQueued) send(connection, { t: 'queueCanceled' })
        return
      }

      default: {
        // 理论上不可达（ClientMessage 已被穷举）；保底回复 badRequest
        const unknownMessage = message as { t: string }
        sendError(connection, 'badRequest', '未处理的消息类型', unknownMessage.t)
        return
      }
    }
  }

  // --- 心跳：30s ping，两个周期没有 pong 就断开 ------------------------
  const heartbeat = setInterval(() => {
    const now = Date.now()
    for (const connection of connections.values()) {
      if (!connection.live || now - connection.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        log.warn(`心跳超时，断开 ${connection.playerId || connection.id}`)
        connection.socket.terminate()
        continue
      }
      connection.live = false
      try {
        connection.socket.ping()
      } catch {
        connection.socket.terminate()
      }
    }
  }, HEARTBEAT_INTERVAL_MS)
  heartbeat.unref?.()

  // --- 房间回收：全部成员离线超过 TTL 才清理（比分 / 聊天随之销毁） ----
  const roomSweeper = setInterval(() => {
    const removed = rooms.sweep(ROOM_OFFLINE_TTL_MS)
    if (removed > 0) log.info(`已回收 ${removed} 个长期无人（全部离线）的房间`)
  }, 60_000)
  roomSweeper.unref?.()

  wss.on('close', () => {
    clearInterval(heartbeat)
    clearInterval(roomSweeper)
  })

  return {
    wss,
    connectionCount: () => connections.size,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat)
        clearInterval(roomSweeper)
        for (const connection of connections.values()) {
          try {
            connection.socket.close(1001, 'server shutting down')
          } catch {
            connection.socket.terminate()
          }
        }
        connections.clear()
        wss.close(() => resolve())
      }),
  }
}
