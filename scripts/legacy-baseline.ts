/**
 * 基准 AI（baseline bot）。
 *
 * 强度目标：抓住自己的连珠机会、高光削弱对手、识别一步内 / 两步内的致命威胁，
 * 在时间预算内尽可能搜得深。
 *
 * 搜索器包含（bugv4 #9 的加强）：
 * - 迭代加深：由浅到深逐层搜，浅层结果用于给下一层排序，超时丢弃未完成的一层；
 * - 置换表（Zobrist 哈希）：同一局面在不同路径下只算一次；
 * - killer / history 启发式着法排序；
 * - 评估函数围绕本作的真实货币——**攻击值与血量差**，而不是单纯的“棋子形状”。
 *
 * 需要替换为更强的 bot 时，保持 `decideMove(request): AiDecision` 签名即可。
 */
import { findLines, summarizeMatch, uniquePieceCells } from '../src/core/lines'
import {
  BOARD_SIZE,
  CELL_COUNT,
  cellId,
  cellOf,
  cloneBoard,
  createBoard,
  other,
  type Board,
  type PlayerIndex,
} from '../src/core/types'

export type AiDifficulty = 'easy' | 'normal' | 'hard' | 'expert'

export interface AiRequest {
  board: Board
  /** 当前该谁走。 */
  player: PlayerIndex
  /** 己方血量。 */
  selfHp: number
  /** 对手血量。 */
  opponentHp: number
  /** 普通回合 = 'attack'；攻击阶段防守落子 = 'defend'。 */
  mode: 'attack' | 'defend'
  /** 防守模式下己方落子可以削弱的攻击方连珠高光。 */
  highlightWeights?: ReadonlyMap<number, number>
  difficulty?: AiDifficulty
  /** 思考时间上限（毫秒）。 */
  timeLimitMs?: number
}

export interface AiDecision {
  /** 决策落子位置（棋盘下标）。 */
  move: number
  /** 搜索得到的分数（越大越好）。 */
  score: number
  /** 思考耗时（毫秒）。 */
  elapsedMs: number
  /** 搜索节点数。 */
  nodes: number
}

interface SearchState {
  board: Board
  turn: PlayerIndex
  hp: readonly [number, number]
}

const WIN_SCORE = 1_000_000
/** 血量在评估里的权重：1 点血量约等于多少“棋盘分”。 */
const HP_WEIGHT = 70
/** 根节点“分数接近时优先直接成线”的容差。 */
const TIE_EPSILON = 30

const DIFFICULTY_DEPTH: Record<AiDifficulty, number> = {
  easy: 1,
  normal: 3,
  hard: 5,
  expert: 7,
}

const MOVE_TIME_BUDGET: Record<AiDifficulty, number> = {
  easy: 40,
  normal: 180,
  hard: 500,
  expert: 1200,
}

const RUN_CENTER_BONUS = [0, 0.2, 0.6, 1.4, 2.2, 3]

// ---------------------------------------------------------------------------
// Zobrist 哈希（置换表用）
// ---------------------------------------------------------------------------

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
]

const ZOBRIST: Uint32Array[] = (() => {
  let seed = 0x9e3779b9
  const next = (): number => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return seed >>> 0
  }
  return [new Uint32Array(CELL_COUNT), new Uint32Array(CELL_COUNT)].map((row) => {
    for (let i = 0; i < CELL_COUNT; i++) row[i] = next()
    return row
  })
})()

function hashState(state: SearchState): number {
  let hash = state.turn === 0 ? 0x1234567 : 0x89abcdef
  for (let i = 0; i < CELL_COUNT; i++) {
    const value = state.board[i]
    if (value !== 0) hash ^= ZOBRIST[value - 1][i]
  }
  hash ^= Math.imul(state.hp[0] + 16, 0x85ebca6b)
  hash ^= Math.imul(state.hp[1] + 16, 0xc2b2ae35)
  return hash >>> 0
}

// ---------------------------------------------------------------------------
// 评估
// ---------------------------------------------------------------------------

/**
 * 静态评估：扫描四个方向的所有连续段，按长度与“活端数”给分。
 *
 * - 实际成线（≥4）直接按几何级数给高分，鼓励成线与多线交叉；
 * - 长度 3 且两端开放（活三）就是“下一步成线”的杀招，权重故意给得很高；
 * - 再叠加中心控制，鼓励在中腹成形（中腹的连珠更难被封）。
 */
function evaluateBoard(board: Board, player: PlayerIndex): number {
  return potential(board, player) - potential(board, other(player))
}

function potential(board: Board, player: PlayerIndex): number {
  const target = cellOf(player)
  let score = 0

  for (const [dr, dc] of DIRS) {
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        if (board[cellId(row, col)] !== target) continue
        // 只从连续段起点开始统计
        const pr = row - dr
        const pc = col - dc
        if (pr >= 0 && pr < BOARD_SIZE && pc >= 0 && pc < BOARD_SIZE && board[cellId(pr, pc)] === target) {
          continue
        }

        let length = 0
        let r = row
        let c = col
        while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[cellId(r, c)] === target) {
          length += 1
          r += dr
          c += dc
        }

        const headOpen = pr >= 0 && pr < BOARD_SIZE && pc >= 0 && pc < BOARD_SIZE ? 1 : 0
        const tailOpen = r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE ? 1 : 0
        // 起点的“前一段”一定是越界或非己方：若在盘内则为对手或空位
        const headBlockedByOpponent = headOpen === 1 && board[cellId(pr, pc)] !== 0
        const tailBlockedByOpponent = tailOpen === 1 && board[cellId(r, c)] !== 0
        const firstOpen = headOpen === 1 && !headBlockedByOpponent ? 1 : 0
        const lastOpen = tailOpen === 1 && !tailBlockedByOpponent ? 1 : 0
        const openEnds = firstOpen + lastOpen

        if (length >= 4) {
          score += 900 * (length - 3) + 320 * openEnds
        } else if (length === 3) {
          if (openEnds === 2) score += 220
          else if (openEnds === 1) score += 34
        } else if (length === 2) {
          if (openEnds === 2) score += 16
          else if (openEnds === 1) score += 5
        } else {
          score += openEnds === 2 ? 1.5 : 0.5
        }

        const centerDist = Math.max(Math.abs(col - (BOARD_SIZE - 1) / 2), Math.abs(row - (BOARD_SIZE - 1) / 2))
        score += RUN_CENTER_BONUS[Math.min(centerDist, RUN_CENTER_BONUS.length - 1)] * length * 0.25
      }
    }
  }
  return score
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

const TT_EXACT = 0
const TT_LOWER = 1
const TT_UPPER = 2

interface TtEntry {
  depth: number
  score: number
  flag: number
  move: number
}

/**
 * 搜索器：**根视角 minimax** + alpha-beta + 置换表。
 *
 * 为什么不用纯 negamax：本作里攻击阶段结束后由**原攻击方**继续（规则 11.2），
 * 也就是说一步棋之后轮次可能不变。negamax 依赖"每层视角交替"，遇到不换手就会把
 * 分数符号搞反（成线反而被算成亏）。所以这里固定以 `root` 视角记分，
 * 轮到 root 时取最大、轮到对手时取最小。
 */
class Searcher {
  nodes = 0
  aborted = false
  readonly table = new Map<number, TtEntry>()
  private readonly deadline: number
  private readonly killers: number[][] = []
  private readonly history = new Float64Array(CELL_COUNT)

  constructor(timeLimitMs: number) {
    this.deadline = Date.now() + timeLimitMs
  }

  private get timedOut(): boolean {
    return Date.now() > this.deadline
  }

  /** 返回**根玩家视角**的分数。 */
  search(state: SearchState, depth: number, alpha: number, beta: number, root: PlayerIndex): number {
    this.nodes += 1
    if ((this.nodes & 255) === 0 && this.timedOut) this.aborted = true

    const foe = other(root)
    const hpDiff = state.hp[root] - state.hp[foe]
    if (this.aborted) return evaluateBoard(state.board, root) + hpDiff * HP_WEIGHT
    if (state.hp[root] <= 0) return -WIN_SCORE - depth * 1000
    if (state.hp[foe] <= 0) return WIN_SCORE + depth * 1000
    if (depth <= 0) return evaluateBoard(state.board, root) + hpDiff * HP_WEIGHT

    const alphaOrig = alpha
    const betaOrig = beta
    const key = hashState(state)
    const cached = this.table.get(key)
    let ttMove = -1
    if (cached && cached.depth >= depth) {
      if (cached.flag === TT_EXACT) return cached.score
      if (cached.flag === TT_LOWER && cached.score > alpha) alpha = cached.score
      else if (cached.flag === TT_UPPER && cached.score < beta) beta = cached.score
      if (alpha >= beta) return cached.score
    }
    if (cached) ttMove = cached.move

    const me = state.turn
    const maximizing = me === root
    const moves = this.orderMoves(state, me, depth, ttMove)
    if (moves.length === 0) return hpDiff * HP_WEIGHT

    let best = maximizing ? -Infinity : Infinity
    let bestMove = moves[0]

    for (const move of moves) {
      const child = applyMove(state, move)
      const value = this.search(child, depth - 1, alpha, beta, root)
      if (maximizing ? value > best : value < best) {
        best = value
        bestMove = move
      }
      if (maximizing) {
        if (best > alpha) alpha = best
      } else if (best < beta) {
        beta = best
      }
      if (alpha >= beta) {
        this.recordKiller(depth, move)
        this.history[move] += depth * depth
        break
      }
      if (this.aborted) break
    }

    if (!this.aborted && Math.abs(best) < WIN_SCORE / 2) {
      const flag = best <= alphaOrig ? TT_UPPER : best >= betaOrig ? TT_LOWER : TT_EXACT
      this.table.set(key, { depth, score: best, flag, move: bestMove })
    }
    return best
  }

  /**
   * 根节点搜索：返回本层最佳着法与该层所有着法分数（供下一层排序）。
   */
  searchRoot(state: SearchState, depth: number, previous: ReadonlyMap<number, number>): {
    move: number
    score: number
    scores: Map<number, number>
  } {
    const root = state.turn
    const moves = this.orderMoves(state, root, depth, -1, previous)
    const scores = new Map<number, number>()
    let best = -Infinity
    let bestMove = moves[0] ?? -1

    for (const move of moves) {
      const child = applyMove(state, move)
      const value = this.search(child, depth - 1, best, Infinity, root)
      scores.set(move, value)
      if (value > best) {
        best = value
        bestMove = move
      }
      if (this.aborted) break
      if (best >= WIN_SCORE) break
    }

    return { move: bestMove, score: best, scores }
  }

  private recordKiller(depth: number, move: number): void {
    const slot = (this.killers[depth] ??= [])
    if (slot[0] === move || slot[1] === move) return
    slot[1] = slot[0]
    slot[0] = move
  }

  /** 生成按启发式排序的候选着法：置换表着法 → 直接成线 → 威胁 → killer/history → 中心。 */
  private orderMoves(
    state: SearchState,
    player: PlayerIndex,
    depth: number,
    ttMove: number,
    previous?: ReadonlyMap<number, number>,
  ): number[] {
    const enemy = other(player)
    const killers = this.killers[depth] ?? []
    const scored: Array<{ move: number; score: number }> = []

    for (let i = 0; i < CELL_COUNT; i++) {
      if (state.board[i] !== 0) continue
      let score = 0
      if (i === ttMove) score += 100_000
      const previousScore = previous?.get(i)
      if (previousScore !== undefined) {
        // 上一层已经算过的着法优先（按分数排序，但不要盖过战术项）
        score += 1_000 + Math.max(-900, Math.min(900, previousScore))
      }

      const own = summarizeMatch(place(state.board, i, player), player)
      if (own.lines.length > 0) {
        // 成线是这一作的核心收益：直接按攻击值排序
        score += 20_000 + own.uniqueCount * 200
        if (own.uniqueCount >= state.hp[enemy]) score += 200_000
      }
      const threat = summarizeMatch(place(state.board, i, enemy), enemy)
      if (threat.lines.length > 0) score += 6_000 + threat.uniqueCount * 150
      if (killers[0] === i) score += 5_000
      else if (killers[1] === i) score += 2_500
      score += this.history[i] * 0.5
      if (score === 0) {
        const row = Math.floor(i / BOARD_SIZE)
        const col = i % BOARD_SIZE
        score += 4 - Math.max(Math.abs(row - 4), Math.abs(col - 4))
      }
      scored.push({ move: i, score })
    }

    scored.sort((a, b) => b.score - a.score || a.move - b.move)
    return scored.map((item) => item.move)
  }
}

/** 在某状态下落子并推进状态机（与 GameEngine 的规则保持一致）。 */
function applyMove(state: SearchState, move: number): SearchState {
  const board = cloneBoard(state.board)
  const player = state.turn
  board[move] = cellOf(player)

  const summary = summarizeMatch(board, player)
  const hp: [number, number] = [state.hp[0], state.hp[1]]
  let turn: PlayerIndex

  if (summary.lines.length === 0) {
    turn = other(player)
  } else {
    // 攻击阶段：己方连珠棋子全部移除（实体去重，留下高光）
    const highlights = summary.weights
    for (const cell of summary.cells) board[cell] = 0
    const defender = other(player)

    // 防守方最优应对（削弱 / 反击）——启发式近似，避免搜索爆炸
    const response = bestDefense(board, defender, highlights, summary.uniqueCount, hp[defender])
    if (response.defenderLines.length > 0) {
      for (const cell of response.defenderCells) board[cell] = 0
    }

    const finalAttack = Math.max(1, summary.uniqueCount - response.weakness)
    const diff = Math.abs(finalAttack - response.defenderUnique)
    if (diff > 0) {
      // 攻击方最终攻击值更高 -> 防守方受伤；否则攻击方受伤
      const damaged: PlayerIndex = finalAttack > response.defenderUnique ? defender : player
      hp[damaged] -= diff
    }
    turn = player // 规则 11.2：攻击阶段结束后由原攻击方开始下一普通回合
  }

  return { board, turn, hp }
}

interface DefensePlan {
  weakness: number
  defenderLines: ReturnType<typeof findLines>
  defenderCells: readonly number[]
  defenderUnique: number
}

/**
 * 近似求防守方在攻击阶段的最优落点：
 * 优先活下来，其次打死对手，再看净伤害差与削弱权重。
 *
 * 为避免搜索爆炸，只采样具有战术价值的位置（高光位 / 与攻防双方棋子相邻的空位）。
 */
function bestDefense(
  board: Board,
  defender: PlayerIndex,
  highlights: ReadonlyMap<number, number>,
  incomingDamage: number,
  defenderHp = 99,
): DefensePlan {
  let best: DefensePlan | null = null
  let bestKey: readonly number[] = []

  for (const move of candidateDefenseCells(board, defender, highlights)) {
    const weakness = highlights.get(move) ?? 0
    const probe = place(board, move, defender)
    const lines = findLines(probe, defender)
    const cells = uniquePieceCells(lines)
    const unique = cells.length
    const finalAttack = Math.max(1, incomingDamage - weakness)
    const weTake = finalAttack > unique ? finalAttack - unique : 0
    const theyTake = unique > finalAttack ? unique - finalAttack : 0
    // 字典序：不被打死 > 打死对手 > 自己少挨 > 对手多挨 > 削弱更大
    const key = [weTake >= defenderHp ? 0 : 1, theyTake > 0 ? 1 : 0, -weTake, theyTake, weakness, -move]
    if (best === null || compareKey(key, bestKey) > 0) {
      bestKey = key
      best = { weakness, defenderLines: lines, defenderCells: cells, defenderUnique: unique }
    }
  }

  return best ?? { weakness: 0, defenderLines: [], defenderCells: [], defenderUnique: 0 }
}

/** 防守候选位置：高光位 + 攻防棋子相邻位 + 中心区域。 */
function candidateDefenseCells(
  board: Board,
  defender: PlayerIndex,
  highlights: ReadonlyMap<number, number>,
): number[] {
  const candidates = new Set<number>()
  for (const cell of highlights.keys()) {
    if (board[cell] === 0) candidates.add(cell)
  }

  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const index = cellId(row, col)
      if (board[index] === 0) continue
      for (const [dr, dc] of DIRS) {
        for (let step = -2; step <= 2; step++) {
          if (step === 0) continue
          const r = row + dr * step
          const c = col + dc * step
          if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) continue
          const target = cellId(r, c)
          if (board[target] === 0) candidates.add(target)
        }
      }
    }
  }

  if (candidates.size === 0) {
    for (let i = 0; i < CELL_COUNT; i++) {
      if (board[i] === 0) candidates.add(i)
    }
  }

  // 高光位优先，其余按是否贴近己方棋子排序
  const ownCell = cellOf(defender)
  return [...candidates].sort((a, b) => {
    const wa = highlights.get(a) ?? 0
    const wb = highlights.get(b) ?? 0
    if (wa !== wb) return wb - wa
    return neighborCount(board, b, ownCell) - neighborCount(board, a, ownCell) || a - b
  })
}

function neighborCount(board: Board, index: number, cell: number): number {
  const row = Math.floor(index / BOARD_SIZE)
  const col = index % BOARD_SIZE
  let count = 0
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue
      const r = row + dr
      const c = col + dc
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) continue
      if (board[cellId(r, c)] === cell) count += 1
    }
  }
  return count
}

function place(board: Board, index: number, player: PlayerIndex): Board {
  const next = cloneBoard(board)
  next[index] = cellOf(player)
  return next
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 基准 AI 决策。
 *
 * - 普通回合：迭代加深的 alpha-beta（含置换表），在时间预算内搜到尽可能深。
 * - 防守回合：先按“先活下来、再打死对手、再比净伤害”直接择优。
 */
export function decideMove(request: AiRequest): AiDecision {
  const startedAt = Date.now()
  const difficulty = request.difficulty ?? 'normal'
  const maxDepth = DIFFICULTY_DEPTH[difficulty]
  // timeLimitMs 是**上限**：给了就用它，否则用该难度的默认预算
  const moveBudget = request.timeLimitMs ?? MOVE_TIME_BUDGET[difficulty]
  const legal = legalMoves(request.board)
  if (legal.length === 0) {
    return { move: -1, score: 0, elapsedMs: 0, nodes: 0 }
  }

  const hp: [number, number] =
    request.player === 0 ? [request.selfHp, request.opponentHp] : [request.opponentHp, request.selfHp]

  // 攻击阶段防守：直接按结算后的净伤害选点，保证“高光削弱”一定被采纳
  if (request.mode === 'defend') {
    const best = chooseDefense(
      request.board,
      request.player,
      request.highlightWeights ?? new Map(),
      hp,
    )
    if (best !== null) {
      return { move: best, score: 0, elapsedMs: Date.now() - startedAt, nodes: 0 }
    }
  }

  const searcher = new Searcher(moveBudget)
  const root: SearchState = { board: cloneBoard(request.board), turn: request.player, hp }

  let bestMove = legal[0]
  let bestScore = -Infinity
  let previous: Map<number, number> | undefined

  // 迭代加深：浅层结果既用于排序，也保证“超时也有一个完整深度的结果”
  for (let depth = 1; depth <= maxDepth; depth++) {
    const result = searcher.searchRoot(root, depth, previous ?? new Map())
    if (searcher.aborted && depth > 1) break
    if (result.move >= 0) {
      bestMove = result.move
      bestScore = result.score
      previous = result.scores
    }
    if (searcher.aborted || bestScore >= WIN_SCORE) break
    // 这一层已经用掉大半预算，再深一层几乎一定搜不完
    if (Date.now() - startedAt > moveBudget * 0.4) break
  }

  /**
   * 具体战术优先于模糊的局面评估：
   * 若若干着法的分数在 TIE_EPSILON 之内，优先**直接成线**（攻击值最高者）。
   * 浅层搜索下这一步很关键——"能连珠却因为评估噪声而错过"是最亏的失误。
   */
  if (previous && Number.isFinite(bestScore)) {
    let tieMove = -1
    let tieAttack = 0
    for (const [move, score] of previous) {
      if (score < bestScore - TIE_EPSILON) continue
      const summary = summarizeMatch(place(request.board, move, request.player), request.player)
      if (summary.lines.length === 0) continue
      if (summary.uniqueCount > tieAttack) {
        tieAttack = summary.uniqueCount
        tieMove = move
      }
    }
    if (tieMove >= 0) bestMove = tieMove
  }

  return {
    move: bestMove,
    score: bestScore,
    elapsedMs: Date.now() - startedAt,
    nodes: searcher.nodes,
  }
}

/**
 * 防守落点选择：优先“不被打死”，其次“打死对手”，再看自己少挨 / 对手多挨 / 削弱权重。
 *
 * 只在有战术价值的位置（高光位 / 双方棋子附近）中挑选，开销可控。
 */
function chooseDefense(
  board: Board,
  defender: PlayerIndex,
  highlightWeights: ReadonlyMap<number, number>,
  hp: readonly [number, number],
): number | null {
  const attacker = other(defender)
  const attackSummary = summarizeMatch(board, attacker)
  const incoming = attackSummary.uniqueCount
  const ownHp = hp[defender]
  const foeHp = hp[attacker]

  let best: number | null = null
  let bestKey: readonly number[] = []

  for (const move of candidateDefenseCells(board, defender, highlightWeights)) {
    const weakness = highlightWeights.get(move) ?? 0
    const finalAttack = Math.max(1, incoming - weakness)
    const lines = findLines(place(board, move, defender), defender)
    const defenseValue = uniquePieceCells(lines).length
    const diff = Math.abs(finalAttack - defenseValue)

    // 受击方与是否致命
    const weTake = finalAttack > defenseValue ? diff : 0
    const theyTake = defenseValue > finalAttack ? diff : 0
    const lethalForUs = weTake >= ownHp ? 1 : 0
    const lethalForThem = theyTake >= foeHp ? 1 : 0

    // 字典序（取最大）：**不被自己打死** > 打死对手 > 自己少挨 > 对手多挨 > 削弱多 > 位置靠前
    const key = [lethalForUs === 1 ? 0 : 1, lethalForThem, -weTake, theyTake, weakness, -move]
    if (best === null || compareKey(key, bestKey) > 0) {
      bestKey = key
      best = move
    }
  }

  return best
}

function compareKey(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

/** 棋盘上的空位。 */
export function legalMoves(board: Board): number[] {
  const moves: number[] = []
  for (let i = 0; i < CELL_COUNT; i++) {
    if (board[i] === 0) moves.push(i)
  }
  return moves
}

/** 便捷函数：某位置若落子，能否立刻形成连珠。 */
export function createsLine(board: Board, player: PlayerIndex, cell: number): boolean {
  return findLines(place(board, cell, player), player).length > 0
}

/** 便捷函数：某位置落子后参与连珠的实体棋子。 */
export function attackPiecesAt(board: Board, player: PlayerIndex, cell: number): number[] {
  return uniquePieceCells(summarizeMatch(place(board, cell, player), player).lines)
}

/** 空棋盘（便于宿主工程自行构造状态）。 */
export function emptyBoard(): Board {
  return createBoard()
}
