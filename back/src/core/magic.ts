/**
 * 魔力植物（bugv8 #4）：确定性生长。
 *
 * 两种随机都不能用 `Math.random()` —— 联机时服务端与客户端各自跑一份引擎，
 * 长在哪几个格子、长成哪一种必须**完全一致**，否则局面指纹立刻漂移。
 * 因此这里用「局面文本 + 生长序号」派生出 PRNG：
 * 只要两端局面相同，长出来的植物必然相同；不需要在协议里传生长结果。
 */
import { fnv1a } from './digest'
import type { Board, MagicKind, MagicSpawnPreference, PlayerIndex } from './types'

/** 三种魔力植物。 */
export const MAGIC_KINDS: readonly MagicKind[] = ['flower', 'grass', 'fern']

/** 由任意文本派生的确定性 PRNG（mulberry32）。 */
export function seededRng(seedText: string): () => number {
  let state = fnv1a(seedText) >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 局面文本：棋盘 + 血量 + 轮次 + 生长序号（顺序固定，两端必须一致）。 */
export function magicSeedText(
  board: Board,
  hp: readonly [number, number],
  moveCount: number,
  growth: number,
): string {
  return `${board.join('')}|${hp[0]},${hp[1]}|${moveCount}|${growth}`
}

/** 该空位周围八邻域里是否有棋子（bugv34「优先在棋子附近生成」判定用）。 */
export function hasNeighborStone(board: Board, cell: number): boolean {
  const row = Math.floor(cell / 9)
  const col = cell % 9
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      if (dr === 0 && dc === 0) continue
      const r = row + dr
      const c = col + dc
      if (r < 0 || r >= 9 || c < 0 || c >= 9) continue
      if (board[r * 9 + c] !== 0) return true
    }
  }
  return false
}

/** 从空位里挑 `count` 个互不相同的格子，并各配一种植物（全部确定性）。 */
export function pickMagicPlants(
  board: Board,
  hp: readonly [number, number],
  moveCount: number,
  growth: number,
  count: number,
  blocked: readonly number[] = [],
  preference: MagicSpawnPreference = 'random',
): Array<{ cell: number; kind: MagicKind }> {
  const blockedSet = new Set(blocked)
  const empties: number[] = []
  for (let cell = 0; cell < board.length; cell += 1) {
    if (board[cell] === 0 && !blockedSet.has(cell)) empties.push(cell)
  }
  if (empties.length === 0 || count <= 0) return []

  const random = seededRng(magicSeedText(board, hp, moveCount, growth))
  // Fisher-Yates：洗出前 count 个
  for (let i = empties.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const tmp = empties[i]
    empties[i] = empties[j]
    empties[j] = tmp
  }

  // 生成偏好（bugv34）：「优先在棋子附近」= 在洗好的顺序上做**稳定分区**，
  // 把"贴着已有棋子"的空位排到前面（组内仍保持洗牌的随机性），再取前 count 个。
  // 仍是同一份确定性随机流，联机两端一致。
  let ordered = empties
  if (preference === 'nearStone') {
    const near: number[] = []
    const far: number[] = []
    for (const cell of empties) (hasNeighborStone(board, cell) ? near : far).push(cell)
    ordered = [...near, ...far]
  }

  const chosen = ordered.slice(0, Math.min(count, ordered.length))
  return chosen
    .map((cell) => ({ cell, kind: MAGIC_KINDS[Math.floor(random() * MAGIC_KINDS.length)] }))
    .sort((a, b) => a.cell - b.cell)
}

/** 某棵植物是否落在某方的连珠棋子里（用于伤害加成统计）。 */
export function plantsOnCells(
  plants: ReadonlyMap<number, { kind: MagicKind; owner: PlayerIndex | null }>,
  cells: readonly number[],
  owner: PlayerIndex | null,
): number[] {
  const hit: number[] = []
  for (const cell of cells) {
    const plant = plants.get(cell)
    if (!plant) continue
    if (owner !== null && plant.owner !== owner) continue
    hit.push(cell)
  }
  return hit.sort((a, b) => a - b)
}

/**
 * 以 `center` 为中心的**九宫格**（切比雪夫距离 ≤ `radius`，含中心本身）。
 *
 * - gemini 的「双子星」用它取"这颗棋子周围的所有格子"；
 * - bugv17 #7 起 claude 的「布局」也用它 —— `includeCenter = true`（含落点自身），
 *   并且**不再**过滤棋子占用的格子（压在棋子上的植物归属那颗棋子的主人）。
 */
export function ringCells(center: number, _board: Board, radius = 1, includeCenter = false): number[] {
  const row = Math.floor(center / 9)
  const col = center % 9
  const cells: number[] = []
  for (let dr = -radius; dr <= radius; dr += 1) {
    for (let dc = -radius; dc <= radius; dc += 1) {
      if (dr === 0 && dc === 0 && !includeCenter) continue
      const r = row + dr
      const c = col + dc
      if (r < 0 || r >= 9 || c < 0 || c >= 9) continue
      cells.push(r * 9 + c)
    }
  }
  return cells.sort((a, b) => a - b)
}

/**
 * 技能长出的魔力植物（bugv9 #13）：种类由「局面文本 + 固定盐 + 格子」确定性派生，
 * 因此联机 / 回放里看到的种类也一致。
 */
export function bloomPlants(
  cells: readonly number[],
  board: Board,
  hp: readonly [number, number],
  moveCount: number,
): Array<{ cell: number; kind: MagicKind }> {
  return cells
    .map((cell) => {
      const random = seededRng(`${magicSeedText(board, hp, moveCount, 0)}|bloom|${cell}`)
      return { cell, kind: MAGIC_KINDS[Math.floor(random() * MAGIC_KINDS.length)] }
    })
    .sort((a, b) => a.cell - b.cell)
}
