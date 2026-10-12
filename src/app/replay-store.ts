/**
 * 回放存档（bugv6 #4）：把每局对战写进 localStorage，刷新 / 关掉页面之后依然能查看之前的对局。
 *
 * 只存一份「快照式」的步骤列表（与 `MatchRecord` 同构），
 * 因此回放器不需要重跑规则，直接按快照重建棋盘即可。
 */
import type { GameMode, MatchRecord, ReplayStep } from './useConnectGame'

const STORAGE_KEY = 'connect4.replays.v2'
/** 本地最多保留多少局。 */
export const REPLAY_LIMIT = 30

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    // 隐私模式 / 被策略禁用时访问 localStorage 会直接抛错
    return null
  }
}

/** 宿主环境是否支持持久化（测试环境可能没有 localStorage）。 */
export function replayStorageAvailable(): boolean {
  return storage() !== null
}

function isReplayStep(value: unknown): value is ReplayStep {
  if (!value || typeof value !== 'object') return false
  const step = value as Partial<ReplayStep>
  return (
    typeof step.player === 'number' &&
    typeof step.cell === 'number' &&
    typeof step.defense === 'boolean' &&
    Array.isArray(step.board) &&
    step.board.length === 81 &&
    Array.isArray(step.hp) &&
    step.hp.length === 2
  )
}

function isMatchRecord(value: unknown): value is MatchRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<MatchRecord>
  return (
    (typeof record.id === 'string' || typeof record.id === 'number') &&
    typeof record.playedAt === 'string' &&
    Array.isArray(record.steps) &&
    record.steps.every(isReplayStep) &&
    Array.isArray(record.playerNames) &&
    record.playerNames.length === 2
  )
}

/** 读出所有已保存的回放（损坏的数据会被丢弃，不会让页面崩掉）。 */
export function loadReplays(): MatchRecord[] {
  const store = storage()
  if (!store) return []
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isMatchRecord).slice(0, REPLAY_LIMIT)
  } catch {
    return []
  }
}

/** 覆盖保存（内部做条数截断）。 */
export function persistReplays(records: readonly MatchRecord[]): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(records.slice(0, REPLAY_LIMIT)))
  } catch {
    // 超出配额时静默失败：回放只是锦上添花，不该影响对局
  }
}

/** 生成一个本地回放 id。 */
export function createReplayId(): string {
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** 生成一条新的对局记录。 */
export function buildRecord(input: {
  id?: string | number
  mode: GameMode
  steps: readonly ReplayStep[]
  result: MatchRecord['result']
  durationMs: number
  playerNames: [string, string]
  /** 联机对局的服务端 matchId（用于和服务器回放对齐）。 */
  serverId?: string
  /** 双方角色（bugv10 #11：回放要用同一套技能表）。 */
  characters?: [string, string]
}): MatchRecord {
  const now = new Date()
  return {
    id: input.id ?? createReplayId(),
    mode: input.mode,
    playedAt: now.toLocaleString('zh-CN', { hour12: false }),
    playedAtMs: now.getTime(),
    steps: input.steps.slice(),
    result: input.result,
    durationMs: input.durationMs,
    playerNames: input.playerNames,
    serverId: input.serverId,
    characters: input.characters,
  }
}

/** 清空所有本地回放（返回是否成功）。 */
export function clearReplays(): boolean {
  const store = storage()
  if (!store) return false
  try {
    store.removeItem(STORAGE_KEY)
    return true
  } catch {
    return false
  }
}

/** 供 UI 展示的存储状态。 */
export function replayStorageInfo(): { available: boolean; bytes: number } {
  const store = storage()
  if (!store) return { available: false, bytes: 0 }
  return { available: true, bytes: (store.getItem(STORAGE_KEY) ?? '').length }
}
