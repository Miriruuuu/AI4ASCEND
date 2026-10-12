/**
 * 环境变量解析（`.env` 由 `dotenv` 在 `index.ts` 里加载）。
 *
 * 设计原则：
 * - 所有配置都有合理默认值，缺省即"本机开发可用"；
 * - 相对路径（FRONTEND_DIR）一律相对 `back/` 根目录解析，而不是 cwd，
 *   这样 pm2 / systemd / 宝塔用绝对路径启动时行为一致。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** `back/` 根目录（src/*.ts 与 dist/*.js 都只差一层）。 */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export type DbMode = 'mongo' | 'memory'

export interface AppConfig {
  /** HTTP / WebSocket 监听端口。 */
  readonly port: number
  /** 最终使用的 Mongo 连接串（已拼接账号密码与库名）；无则 null。 */
  readonly mongodbUri: string | null
  readonly dbName: string
  /** 用户显式要求的 DB 模式（`mongo` | `memory`）。 */
  readonly dbMode: DbMode
  /** 实际生效的 DB 模式：`DB_MODE=mongo` 但没有 URI 时会降级为 memory。 */
  readonly effectiveDbMode: DbMode
  /** `*` 或允许的来源列表。 */
  readonly corsOrigins: '*' | string[]
  /** 是否托管前端构建产物（单页应用）。 */
  readonly serveFrontend: boolean
  /** 前端产物目录（绝对路径）。 */
  readonly frontendDir: string
  /** 结束/废弃对局在内存中的保留时长。 */
  readonly matchTtlMs: number
  /** 匹配码房间有效期（默认 10 分钟）。 */
  readonly roomTtlMs: number
  readonly logLevel: string
  /** Mongo 鉴权库（宝塔常见做法是用 admin 库鉴权）。 */
  readonly mongoAuthSource: string
  /** 是否托管前端时找不到 index.html 是否报错（默认静默跳过）。 */
  readonly frontendMissingIsFatal: boolean
}

function readString(env: NodeJS.ProcessEnv, key: string, fallback = ''): string {
  const raw = env[key]
  if (raw === undefined || raw === null) return fallback
  const trimmed = String(raw).trim()
  return trimmed === '' ? fallback : trimmed
}

function readNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = readString(env, key)
  if (raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function readBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = readString(env, key).toLowerCase()
  if (raw === '') return fallback
  if (['1', 'true', 'yes', 'on', 'y'].includes(raw)) return true
  if (['0', 'false', 'no', 'off', 'n'].includes(raw)) return false
  return fallback
}

/** 拆解 `mongodb://user:pass@host:port/db?opts`，兼容多主机写法。 */
export interface ParsedMongoUri {
  readonly scheme: string
  readonly credentials: string
  readonly hosts: string
  readonly database: string
  readonly query: string
}

export function parseMongoUri(uri: string): ParsedMongoUri {
  const schemeMatch = /^([a-z0-9+.-]+):\/\//i.exec(uri)
  const scheme = schemeMatch ? schemeMatch[1] : 'mongodb'
  let rest = schemeMatch ? uri.slice(schemeMatch[0].length) : uri

  let query = ''
  const queryIndex = rest.indexOf('?')
  if (queryIndex >= 0) {
    query = rest.slice(queryIndex + 1)
    rest = rest.slice(0, queryIndex)
  }

  let database = ''
  const slashIndex = rest.indexOf('/')
  if (slashIndex >= 0) {
    database = rest.slice(slashIndex + 1)
    rest = rest.slice(0, slashIndex)
  }

  let credentials = ''
  const atIndex = rest.lastIndexOf('@')
  if (atIndex >= 0) {
    credentials = rest.slice(0, atIndex)
    rest = rest.slice(atIndex + 1)
  }

  return { scheme, credentials, hosts: rest, database, query }
}

/**
 * 按需求拼接连接串：
 * - `MONGODB_USER` / `MONGODB_PASSWORD` 都为空 -> 直接用 `MONGODB_URI`；
 * - 非空 -> `mongodb://user:pass@host:port/db?authSource=<MONGODB_AUTH_SOURCE>`。
 */
export function buildMongoUri(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = readString(env, 'MONGODB_URI')
  const user = readString(env, 'MONGODB_USER')
  const password = readString(env, 'MONGODB_PASSWORD')
  const dbName = readString(env, 'DB_NAME', 'connect4')
  const authSource = readString(env, 'MONGODB_AUTH_SOURCE', 'admin')

  if (base === '' && user === '') return null

  const parsed = parseMongoUri(base === '' ? 'mongodb://127.0.0.1:27017' : base)
  const database = parsed.database !== '' ? parsed.database : dbName

  if (user === '' && password === '') {
    // 没给账号：沿用原始 URI，仅在缺库名时补上 DB_NAME
    const auth = parsed.credentials === '' ? '' : `${parsed.credentials}@`
    const query = parsed.query === '' ? '' : `?${parsed.query}`
    return `${parsed.scheme}://${auth}${parsed.hosts}/${database}${query}`
  }

  const auth = `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`
  const params = new URLSearchParams(parsed.query)
  if (!params.has('authSource')) params.set('authSource', authSource)
  return `${parsed.scheme}://${auth}${parsed.hosts}/${database}?${params.toString()}`
}

function parseCors(env: NodeJS.ProcessEnv): '*' | string[] {
  const raw = readString(env, 'CORS_ORIGINS', '*')
  if (raw === '*') return '*'
  const list = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  return list.length === 0 ? '*' : list
}

/** 读取环境变量生成配置；不读 `.env` 文件本体（由调用方决定是否加载 dotenv）。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dbName = readString(env, 'DB_NAME', 'connect4')
  const requestedMode: DbMode = readString(env, 'DB_MODE', 'mongo').toLowerCase() === 'memory' ? 'memory' : 'mongo'
  const mongodbUri = requestedMode === 'memory' ? null : buildMongoUri(env)
  const effectiveDbMode: DbMode = requestedMode === 'memory' || mongodbUri === null ? 'memory' : 'mongo'

  const frontendDirRaw = readString(env, 'FRONTEND_DIR', '../dist')

  return {
    port: readNumber(env, 'PORT', 8787),
    mongodbUri,
    dbName,
    dbMode: requestedMode,
    effectiveDbMode,
    corsOrigins: parseCors(env),
    serveFrontend: readBoolean(env, 'SERVE_FRONTEND', true),
    frontendDir: path.isAbsolute(frontendDirRaw) ? frontendDirRaw : path.resolve(PACKAGE_ROOT, frontendDirRaw),
    matchTtlMs: readNumber(env, 'MATCH_TTL_MS', 30 * 60 * 1000),
    roomTtlMs: readNumber(env, 'ROOM_TTL_MS', 10 * 60 * 1000),
    logLevel: readString(env, 'LOG_LEVEL', 'info'),
    mongoAuthSource: readString(env, 'MONGODB_AUTH_SOURCE', 'admin'),
    frontendMissingIsFatal: readBoolean(env, 'FRONTEND_MISSING_FATAL', false),
  }
}
