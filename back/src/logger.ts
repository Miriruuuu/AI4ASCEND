/**
 * 极简分级日志：`debug < info < warn < error < silent`，由 `LOG_LEVEL` 控制。
 *
 * 不引入任何第三方日志库，宝塔上直接看 pm2 日志即可。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
}

export function normalizeLogLevel(value: string | undefined): LogLevel {
  const raw = (value ?? '').trim().toLowerCase()
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' || raw === 'silent') return raw
  return 'info'
}

let currentLevel: LogLevel = normalizeLogLevel(process.env.LOG_LEVEL)

export function setLogLevel(value: string | undefined): LogLevel {
  currentLevel = normalizeLogLevel(value)
  return currentLevel
}

export function getLogLevel(): LogLevel {
  return currentLevel
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** 本地时间戳 `YYYY-MM-DD HH:mm:ss.SSS`。 */
function stamp(): string {
  const now = new Date()
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
  )
}

function format(scope: string, message: string): string {
  return `[${stamp()}] [${scope}] ${message}`
}

function stringify(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  /** 派生一个带命名空间前缀的 logger。 */
  child(scope: string): Logger
}

function emit(level: Exclude<LogLevel, 'silent'>, scope: string, message: string, args: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return
  const suffix = args.length > 0 ? ` ${args.map(stringify).join(' ')}` : ''
  const line = `${format(scope, message)}${suffix}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

function buildLogger(scope: string): Logger {
  return {
    debug: (message, ...args) => emit('debug', scope, message, args),
    info: (message, ...args) => emit('info', scope, message, args),
    warn: (message, ...args) => emit('warn', scope, message, args),
    error: (message, ...args) => emit('error', scope, message, args),
    child: (childScope: string) => buildLogger(`${scope}:${childScope}`),
  }
}

export const logger: Logger = buildLogger('back')
