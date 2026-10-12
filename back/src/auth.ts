/**
 * 最简账号体系（bugv34i）：注册 / 登录 / 长期令牌。
 *
 * 目标只有一条：**联机对战需要登录**。所以这里刻意做得很薄：
 * - 口令用 `scrypt` + 每用户随机盐散列，**永不存明文**；
 * - 登录成功签发一枚随机令牌（第 3 版协议里随 `hello.token` 回传，
 *   所以"不退出登录就一直保持登录态"）；
 * - 昵称注册时填写，空则由服务端按 playerId 兜底。
 *
 * 不做的东西（有意为之）：找回密码、改密码、邮箱/手机验证、多端会话管理。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { Repository, UserDoc } from './db'

export const USERNAME_MIN = 3
export const USERNAME_MAX = 20
export const PASSWORD_MIN = 4
export const PASSWORD_MAX = 64
export const NICKNAME_MAX = 24

/** 账号允许的字符集（简单起见只要字母 / 数字 / 下划线）。 */
const USERNAME_PATTERN = /^[a-zA-Z0-9_]+$/

/** 失败原因（同时也是返回给客户端的错误码）。 */
export type AuthFailure = 'badUsername' | 'badPassword' | 'userNotFound' | 'wrongPassword' | 'usernameTaken'

export interface AuthOk {
  readonly ok: true
  readonly user: UserDoc
  readonly token: string
}

export interface AuthFail {
  readonly ok: false
  readonly code: AuthFailure
  readonly message: string
}

export type AuthResult = AuthOk | AuthFail

/** 归一化账号：去掉首尾空白并转小写（大小写不敏感）。 */
export function normalizeUsername(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().toLowerCase()
}

export function isValidUsername(username: string): boolean {
  return (
    username.length >= USERNAME_MIN &&
    username.length <= USERNAME_MAX &&
    USERNAME_PATTERN.test(username)
  )
}

export function isValidPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX
}

/** 口令散列（scrypt，64 字节十六进制）。 */
export function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex')
}

/** 恒定时间比较（长度不同也返回 false，不抛异常）。 */
export function verifyPassword(password: string, salt: string, expected: string): boolean {
  const actual = Buffer.from(hashPassword(password, salt), 'hex')
  const want = Buffer.from(expected, 'hex')
  if (actual.length !== want.length) return false
  return timingSafeEqual(actual, want)
}

function newToken(): string {
  return randomBytes(24).toString('hex')
}

function badUsernameMessage(): string {
  return `账号需为 ${USERNAME_MIN}-${USERNAME_MAX} 位字母 / 数字 / 下划线`
}

/**
 * 账号服务：薄薄一层，所有读写都走 `Repository`（内存 / Mongo 都支持）。
 */
export class AuthService {
  constructor(private readonly repo: Repository) {}

  /** 注册：账号已存在则失败（前端据此切回登录）。 */
  async register(username: string, password: string, nickname: string): Promise<AuthResult> {
    const name = normalizeUsername(username)
    if (!isValidUsername(name)) return { ok: false, code: 'badUsername', message: badUsernameMessage() }
    if (!isValidPassword(password)) {
      return { ok: false, code: 'badPassword', message: `密码长度需为 ${PASSWORD_MIN}-${PASSWORD_MAX} 位` }
    }
    const existing = await this.repo.getUser(name)
    if (existing) return { ok: false, code: 'usernameTaken', message: `账号 ${name} 已被注册，请直接登录` }

    const salt = randomBytes(16).toString('hex')
    const token = newToken()
    const now = Date.now()
    const doc: UserDoc = {
      _id: name,
      username: name,
      nickname: nickname.slice(0, NICKNAME_MAX),
      passwordHash: hashPassword(password, salt),
      salt,
      createdAt: now,
      lastLoginAt: now,
      token,
    }
    await this.repo.createUser(doc)
    return { ok: true, user: doc, token }
  }

  /** 登录：账号不存在返回 `userNotFound`（前端据此引导去注册）。 */
  async login(username: string, password: string): Promise<AuthResult> {
    const name = normalizeUsername(username)
    if (!isValidUsername(name)) return { ok: false, code: 'badUsername', message: badUsernameMessage() }
    const user = await this.repo.getUser(name)
    if (!user) return { ok: false, code: 'userNotFound', message: `账号 ${name} 不存在，请先注册` }
    if (!verifyPassword(password, user.salt, user.passwordHash)) {
      return { ok: false, code: 'wrongPassword', message: '密码不正确' }
    }
    const token = newToken()
    await this.repo.updateUser(name, { token, lastLoginAt: Date.now() })
    return { ok: true, user: { ...user, token, lastLoginAt: Date.now() }, token }
  }

  /** 令牌 -> 用户（`hello.token` 自动恢复登录态用）。 */
  async byToken(token: unknown): Promise<UserDoc | null> {
    if (typeof token !== 'string') return null
    const value = token.trim()
    if (value === '') return null
    return this.repo.getUserByToken(value)
  }

  /** 退出登录：作废令牌（之后这个令牌不再能恢复登录态）。 */
  async logout(username: string): Promise<void> {
    await this.repo.updateUser(username, { token: null })
  }
}
