/**
 * 服务启动入口：建 DB -> 建 HTTP -> 挂 WS -> 优雅退出。
 *
 * 同时导出 `startServer()`，供 `scripts/smoke.ts` 与测试以内存模式拉起真实服务。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import dotenv from 'dotenv'
import { AuthService } from './auth'
import { PACKAGE_ROOT, loadConfig, type AppConfig } from './config'
import { MongoUnavailableError, createRepository, maskMongoUri, type Repository } from './db'
import { createApp } from './http'
import { logger, setLogLevel, type Logger } from './logger'
import { MatchManager } from './match'
import { MatchingService } from './matching'
import { RoomManager } from './room'
import { PROTOCOL_VERSION, WS_PATH } from './protocol'
import { attachWebSocket, type WsHandle } from './ws'

const SWEEP_INTERVAL_MS = 60_000

export interface RunningServer {
  readonly config: AppConfig
  readonly server: http.Server
  readonly ws: WsHandle
  readonly repo: Repository
  readonly matches: MatchManager
  readonly matching: MatchingService
  readonly rooms: RoomManager
  /** 账号服务（bugv34i）。 */
  readonly auth: AuthService
  readonly port: number
  readonly url: string
  readonly logger: Logger
  close(): Promise<void>
}

/** 加载 `back/.env`（不存在则静默跳过）。 */
export function loadEnvFile(file: string = path.join(PACKAGE_ROOT, '.env')): void {
  if (!fs.existsSync(file)) return
  dotenv.config({ path: file })
}

/** 启动服务；`overrides` 用于测试（内存模式 + 随机端口）。 */
export async function startServer(overrides: Partial<AppConfig> = {}): Promise<RunningServer> {
  const config: AppConfig = { ...loadConfig(), ...overrides }
  const log = logger.child('server')

  const repo = await createRepository(config, log)

  const matches = new MatchManager({
    ttlMs: config.matchTtlMs,
    onMatchFinished: async (replay) => {
      await repo.saveReplay(replay)
      log.info(`回放已落库 ${replay.matchId}（${replay.steps.length} 步）`)
    },
    logger: log,
  })

  const rooms = new RoomManager({ logger: log })
  const auth = new AuthService(repo)

  const matching = new MatchingService({
    logger: log,
    /**
     * bugv34e：在线匹配也**不直接开局** —— 两人先进同一个房间
     * （随机一方为房主），等房主点「开始游戏」才开局。
     */
    onMatch: (first, second) => {
      // 随机一方当房主
      const firstIsHost = Math.random() < 0.5
      const host = firstIsHost ? first : second
      const guest = firstIsHost ? second : first
      const room = rooms.createWith(host, guest)
      for (const memberId of room.members.keys()) {
        const connection = memberId === host.playerId ? host : guest
        connection.send({ t: 'roomState', ...room.snapshot(memberId) })
      }
      log.info(`匹配成功，进入房间 ${room.code}：${host.name} vs ${guest.name}`)
    },
  })

  const app = createApp({ config, repo, matches, logger: log })
  const server = http.createServer(app)
  const ws = attachWebSocket(server, { config, matching, matches, rooms, auth, logger: log })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(config.port, () => {
      server.off('error', onError)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.port
  const url = `http://127.0.0.1:${port}`

  const sweep = setInterval(() => {
    const removed = matches.sweep()
    if (removed > 0) log.info(`已回收 ${removed} 个过期对局`)
  }, SWEEP_INTERVAL_MS)
  sweep.unref?.()

  const memoryWarn = setInterval(() => {
    if (repo.kind === 'memory') {
      log.warn('当前为【内存模式】：对局与回放不会持久化，进程重启后全部丢失（设置 DB_MODE=mongo 与 MONGODB_URI 可持久化）')
    }
  }, SWEEP_INTERVAL_MS)
  memoryWarn.unref?.()

  log.info(`服务已启动：${url}（WebSocket 路径 ${WS_PATH}，协议版本 v${PROTOCOL_VERSION}）`)
  log.info(`持久层：${repo.kind === 'mongo' ? `MongoDB ${config.dbName}` : '内存（临时）'}`)
  if (repo.kind === 'mongo' && config.mongodbUri) log.info(`MongoDB 地址：${maskMongoUri(config.mongodbUri)}`)
  if (config.serveFrontend) log.info(`前端静态目录：${config.frontendDir}`)

  let closed = false
  return {
    config,
    server,
    ws,
    repo,
    matches,
    matching,
    rooms,
    auth,
    port,
    url,
    logger: log,
    close: async () => {
      if (closed) return
      closed = true
      clearInterval(sweep)
      clearInterval(memoryWarn)
      await ws.close()
      const done = new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      server.closeAllConnections?.()
      await done
      matching.dispose()
      await repo.close()
      log.info('服务已关闭')
    },
  }
}

/** Mongo 连不上时的中文排查提示。 */
function printMongoHelp(config: AppConfig, error: MongoUnavailableError): void {
  const uri = error.uri ? maskMongoUri(error.uri) : '(未配置)'
  logger.error(`MongoDB 连接失败（已重试 ${error.attempts} 次），服务退出。`)
  logger.error(`连接串：${uri}`)
  logger.error('请依次排查：')
  logger.error('  1) 服务器安全组 / 宝塔防火墙是否放行了 27017 端口（云厂商默认只对白名单 IP 开放）')
  logger.error('  2) MongoDB 是否绑定了 0.0.0.0（/etc/mongod.conf 的 net.bindIp）且已重启 mongod')
  logger.error('  3) 账号密码是否正确，以及鉴权库是否匹配：宝塔常见做法是用 admin 库鉴权，')
  logger.error(`     可在 .env 设置 MONGODB_AUTH_SOURCE=admin（当前为 ${config.mongoAuthSource}）`)
  logger.error('  4) 本机是否能用 mongosh 直连该地址：mongosh "<连接串>"')
  logger.error('  5) 只想先跑通联机：把 DB_MODE 设为 memory（重启即丢数据，仅供调试）')
}

async function main(): Promise<void> {
  loadEnvFile()
  const config = loadConfig()
  setLogLevel(config.logLevel)

  logger.info('启动联机后端（Windows/Linux + Node 20+）')
  logger.info(`监听端口 ${config.port}，DB_MODE=${config.dbMode}（实际：${config.effectiveDbMode}）`)

  let running: RunningServer
  try {
    running = await startServer(config)
  } catch (error) {
    if (error instanceof MongoUnavailableError) {
      printMongoHelp(config, error)
      process.exitCode = 1
      return
    }
    logger.error('服务启动失败', error)
    process.exitCode = 1
    return
  }

  if (running.repo.kind === 'memory') {
    logger.warn('============================================================')
    logger.warn('  当前为内存模式：数据不落盘，仅供本地联调 / 演示使用！')
    logger.warn('  生产环境请设置 DB_MODE=mongo 并配置 MONGODB_URI。')
    logger.warn('============================================================')
  }

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`收到 ${signal}，正在优雅退出……`)
    void running
      .close()
      .catch((error: unknown) => logger.error('关闭过程中出错', error))
      .finally(() => {
        process.exitCode = 0
      })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main()
}
