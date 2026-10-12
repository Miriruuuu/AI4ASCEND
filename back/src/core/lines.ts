/**
 * 连珠（≥4 连线）检测与攻击值计算。
 *
 * 纯函数，无副作用，是规则实现的唯一真源。
 */
import {
  BOARD_SIZE,
  cellId,
  cellOf,
  DIRECTIONS,
  isInsideBoard,
  MIN_ATTACK_VALUE,
  MIN_LINE_LENGTH,
  type Board,
  type Cell,
  type Line,
  type PlayerIndex,
} from './types'

/** 单次检测可接受的棋盘描述：一维数组（0/1/2）、8×8? 不，仅 9×9 一维数组或二维数组。 */
export type BoardLike = Board | ReadonlyArray<ReadonlyArray<number>>

/**
 * 「叠在敌方棋子上」的额外棋子（bugv10 #9 毒鸡蛋）。
 *
 * 键是棋盘下标，值是把子叠上去的一方。这一格对**双方**都算己方棋子：
 * 底下的原棋子照旧属于原主人（不会被顶替），上面那颗属于叠子的一方。
 */
export type StoneOverlay = ReadonlyMap<number, number>

function normalize(board: BoardLike): Board {
  if (Array.isArray(board) && typeof board[0] === 'number') {
    return board as Board
  }
  const grid = board as ReadonlyArray<ReadonlyArray<number>>
  const flat: number[] = new Array(BOARD_SIZE * BOARD_SIZE).fill(0)
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      flat[cellId(r, c)] = grid[r]?.[c] ?? 0
    }
  }
  return flat as Board
}

function at(flat: Board, row: number, col: number): number {
  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return -1
  return flat[cellId(row, col)]
}

/**
 * 该位置对 `target` 来说算不算己方棋子。
 *
 * `overlay` 非空时，被叠子的格子对双方都算己方（bugv10 #9）。
 */
function makeOwned(flat: Board, target: Cell, overlay?: StoneOverlay): (row: number, col: number) => boolean {
  if (!overlay || overlay.size === 0) {
    return (row, col) => at(flat, row, col) === target
  }
  return (row, col) => {
    if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return false
    const index = cellId(row, col)
    if (flat[index] === target) return true
    const stack = overlay.get(index)
    return stack !== undefined && stack === (target - 1)
  }
}

/**
 * 找出指定玩家棋盘上所有极大连珠（长度 ≥ `minLength`，默认 4）。
 *
 * - 每一条极大连珠只返回一次（从其起点开始扫描）。
 * - 横 / 竖 / 两条斜线四个方向。
 * - 结果按起点下标、方向稳定排序，保证不同实现顺序一致（含跨线共享棋子）。
 * - `overlay` 里的叠子对叠子的那一方也算己方棋子（bugv10 #9）。
 * - `minLength` 是"几条子才算连珠"（bugv11 #5：双子星把门槛降到 2）。
 */
export function findLines(
  board: BoardLike,
  player: PlayerIndex,
  overlay?: StoneOverlay,
  minLength: number = MIN_LINE_LENGTH,
): Line[] {
  const flat = normalize(board)
  const target = cellOf(player)
  const owned = makeOwned(flat, target, overlay)
  const lines: Line[] = []
  const threshold = Math.max(1, Math.round(minLength))

  for (const [dr, dc] of DIRECTIONS) {
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        if (!owned(row, col)) continue
        // 只从连珠起点开始扫描
        if (owned(row - dr, col - dc)) continue
        const cells: number[] = []
        let r = row
        let c = col
        while (owned(r, c)) {
          cells.push(cellId(r, c))
          r += dr
          c += dc
        }
        if (cells.length >= threshold) {
          lines.push({ length: cells.length, cells, direction: [dr, dc] })
        }
      }
    }
  }
  return lines
}

/** 是否存在任意一条连珠。 */
export function hasLine(board: BoardLike, player: PlayerIndex, overlay?: StoneOverlay): boolean {
  return findLines(board, player, overlay).length > 0
}

/** 一条“再补一颗就能连珠”的预判提示（bugv9 #3）。 */
export interface ThreatHint {
  /** 补子方向。 */
  readonly direction: readonly [number, number]
  /** 该方向上一个「四连窗口」的全部格子（含落点与那个空位）。 */
  readonly cells: readonly number[]
  /** 需要补的那一格（空位）下标。 */
  readonly gap: number
}

/**
 * “只差一颗子即可连珠”的方向（bugv5 #7：下子后的提示针）。
 *
 * 判定（bugv9 #3 补全）：在落点所在的每个方向上，检查所有**包含落点的
 * `MIN_LINE_LENGTH` 连窗口**；只要某个窗口里正好有 `MIN_LINE_LENGTH - 1` 颗己方棋子
 * 且剩下那 1 格是盘内空位，就说明"补上那一格即可成线"。
 *
 * 这样既覆盖原来的「连续 3 颗 + 一端空位」，也覆盖需求里点名的
 * 「2 + 1 中间空一格」（X X _ X）—— 后者以前完全没有提示。
 */
export function threatHints(board: BoardLike, player: PlayerIndex, cell: number, overlay?: StoneOverlay): ThreatHint[] {
  const flat = normalize(board)
  const target = cellOf(player)
  const owned = makeOwned(flat, target, overlay)
  const row = Math.floor(cell / BOARD_SIZE)
  const col = cell % BOARD_SIZE
  if (!owned(row, col)) return []
  const hints: ThreatHint[] = []

  for (const [dr, dc] of DIRECTIONS) {
    // 窗口起点相对落点的偏移：落点可以落在窗口的任意一格上
    for (let start = -(MIN_LINE_LENGTH - 1); start <= 0; start++) {
      const cells: number[] = []
      let mine = 0
      let gap: number | null = null
      let valid = true
      for (let k = 0; k < MIN_LINE_LENGTH; k++) {
        const r = row + (start + k) * dr
        const c = col + (start + k) * dc
        if (!isInsideBoard(r, c)) {
          valid = false
          break
        }
        if (owned(r, c)) mine += 1
        else if (at(flat, r, c) === 0 && gap === null) gap = cellId(r, c)
        else {
          valid = false
          break
        }
        cells.push(cellId(r, c))
      }
      if (!valid || mine !== MIN_LINE_LENGTH - 1 || gap === null) continue
      hints.push({ direction: [dr, dc], cells, gap })
      break
    }
  }

  return hints
}

/** 兼容旧接口：只返回需要提示的方向（bugv5 #7）。 */
export function nearLineDirections(
  board: BoardLike,
  player: PlayerIndex,
  cell: number,
): Array<readonly [number, number]> {
  return threatHints(board, player, cell).map((hint) => hint.direction)
}

/** 连珠总长 = 所有连珠长度之和（规则 2.2）。 */
export function totalLineLength(lines: readonly Line[]): number {
  return lines.reduce((sum, line) => sum + line.length, 0)
}

/**
 * 攻击棋子数 / 防守方攻击值（规则 2.3、2.6）：
 * 参与连珠的实体棋子去重数量。
 */
export function uniquePieceCount(lines: readonly Line[]): number {
  const set = new Set<number>()
  for (const line of lines) {
    for (const cell of line.cells) set.add(cell)
  }
  return set.size
}

/** 所有连珠涉及的实体棋子（去重后按下标升序）。 */
export function uniquePieceCells(lines: readonly Line[]): number[] {
  const set = new Set<number>()
  for (const line of lines) {
    for (const cell of line.cells) set.add(cell)
  }
  return [...set].sort((a, b) => a - b)
}

/** 某个位置属于几条连珠（规则 2.4 占位削弱 k）。 */
export function lineWeightAt(lines: readonly Line[], cell: number): number {
  let k = 0
  for (const line of lines) {
    if (line.cells.includes(cell)) k += 1
  }
  return k
}

/** 每个位置分别属于几条连珠，用于高光标注重叠数量。 */
export function weightMap(lines: readonly Line[]): Map<number, number> {
  const map = new Map<number, number>()
  for (const line of lines) {
    for (const cell of line.cells) {
      map.set(cell, (map.get(cell) ?? 0) + 1)
    }
  }
  return map
}

/**
 * 攻击方最终攻击值 = 攻击棋子数 + 魔力植物加成 - 占位削弱（规则 2.5 / bugv8 #4）。
 *
 * 规则 2.5 说明“正常规则下不会降至 0”，此处以 MIN_ATTACK_VALUE 作为下界兜底。
 */
export function finalAttackValue(baseDamage: number, weakness: number, magicBonus = 0): number {
  return Math.max(MIN_ATTACK_VALUE, baseDamage + Math.max(0, magicBonus) - weakness)
}

/** 抵消数量 = min(攻击方最终攻击值, 防守方攻击值)（规则 6.3）。 */
export function clashCount(attackValue: number, defenseValue: number): number {
  return Math.min(attackValue, defenseValue)
}

/** 差值 D = |攻击方最终攻击值 - 防守方攻击值|（规则 6.3）。 */
export function damageDiff(attackValue: number, defenseValue: number): number {
  return Math.abs(attackValue - defenseValue)
}

export interface MatchSummary {
  readonly lines: readonly Line[]
  readonly cells: readonly number[]
  readonly uniqueCount: number
  readonly lineLengthSum: number
  readonly weights: ReadonlyMap<number, number>
}

/** 一次性汇总某玩家的连珠信息。 */
export function summarizeMatch(
  board: BoardLike,
  player: PlayerIndex,
  overlay?: StoneOverlay,
  minLength: number = MIN_LINE_LENGTH,
): MatchSummary {
  return summaryOfLines(findLines(board, player, overlay, minLength))
}

/** 把一组已经筛好的连珠打包成摘要（bugv11 #5：双子星只要"两连"）。 */
export function summaryOfLines(lines: readonly Line[]): MatchSummary {
  const cells = uniquePieceCells(lines)
  return {
    lines,
    cells,
    uniqueCount: cells.length,
    lineLengthSum: totalLineLength(lines),
    weights: weightMap(lines),
  }
}
