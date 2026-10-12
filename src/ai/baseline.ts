import {
  BOARD_SIZE,
  CELL_COUNT,
  DEFAULT_MAGIC_CONFIG,
  cellId,
  cellOf,
  cloneBoard,
  createBoard,
  isInsideBoard,
  other,
  type Board,
  type PlayerIndex,
} from '../core/types'
import type { AiDecision, AiRequest, AiSkillUse } from './types'
import { Searcher, type AttackFrame, type RootAction } from './search'
import { DIFFICULTY, DIRS, INF, WIN, now } from './policy'

/**
 * 四子棋 AI（基线 bot v2 · 全规则博弈搜索）。
 *
 * ## 这一版解决什么问题
 *
 * 上一版（见 `scripts/legacy-baseline.ts`，保留作对照）有三个硬伤：
 * 1. **贪攻**：只要自己能成线就立刻发起攻击，不考虑对手的反击；
 * 2. **看不懂高光削弱**：防守回合里 `incoming damage` 是从"攻击方棋子已经被移除"
 *    的棋盘上重算的，等于恒为 0 —— 于是它以为"随便挡一下只掉 1 点血"；
 * 3. **开局走角落**：角落只在两个方向上有展开空间，很难成线。
 *
 * 本作的精髓是**反击**：一次攻击会让攻击方的连珠棋子**离开棋盘**（棋盘上只剩高光），
 * 防守方只要在合适的位置落子，既能按高光权重削弱攻击值，又能顺势成线**对撞抵消**
 * 甚至反打。因此"能成线就打"是彻头彻尾的亏本买卖。
 *
 * 所以 v2 不再用启发式近似防守，而是在一个**逐字节复刻引擎规则**的迷你引擎上
 * 做完整博弈树搜索 —— 把整条链路都搜出来：
 *
 * ```
 * 落子 → 成线？ → 攻击方连珠棋子移除、留高光 → 防守方落子
 *      → 按高光权重削弱攻击值 / 防守方自己成线 → 对撞抵消、差值打向劣势方
 *      → 下一普通回合仍由「原攻击方」开始
 * ```
 *
 * 搜索器：迭代加深 + alpha-beta + 置换表（Zobrist）+ killer/history 着法排序 +
 * 窗口威胁评估 + **成线延伸**（quiescence：叶子节点若有一击成线的着法就继续搜，
 * 避免"打了一半不看结果"的视界效应）。
 *
 * ## 三个阶段（都已完成）
 *
 * - **阶段一 · 基础规则**：落子 / 成线 / 移除留高光 / 防守削弱 / 对撞抵消 / 续走，全搜。
 * - **阶段二 · 魔力植物**：AI 只用**棋盘上看得见的**植物（不预测未来生长，见 `AiMagicContext`
 *   的公平性说明）；连珠上的己方植物 +1 伤、防守抢植物、连珠清植物。
 * - **阶段三 · 角色技能**：4 角色 8 技能（护盾 / 回血 / 连下两颗 / 双子星 / 无敌 / 火球 /
 *   增伤 / 叠子）。**8 个技能都是"用完不交回合"**，所以一轮行动 = "任意个技能 + 落子"：
 *   技能在搜索里原样递归（同一方、同一深度），`AiDecision.skills` 就是技能序列。
 *
 * ## 一致性怎么保证
 *
 * 本文件里的一切规则都靠**三个对拍脚本**逐字节钉死，改动后必须全部重跑：
 * `scripts/verify-ai-engine.ts`（阶段一）/ `verify-ai-magic.ts`（阶段二）/
 * `verify-ai-skills.ts`（阶段三）。它们通过 `debugSimulate()` 钩子比对完整状态。
 *
 * ## 文件结构（本文件只保留"对外入口"，实现已按职责拆分到同目录）
 *
 * - `types.ts`   — 输入 / 输出契约（`AiRequest` / `AiDecision` / `AiMagicContext` / `AiSkillContext` …）
 * - `policy.ts`  — 可调参数与常量（评价权重、着法优先级、`AI_POLICY`、`DIFFICULTY`、Zobrist 表）
 * - `search.ts`  — 搜索核心 `Searcher`（迷你引擎 + 迭代加深 + alpha-beta + 置换表）
 * - `debug.ts`   — 仅供测试 / 对拍的 `debug*` 钩子
 *
 * 三个对拍脚本（`verify-ai-engine/magic/skills`）与本文件的公开 API 均保持不变。
 */
// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 基准 AI 决策。
 *
 * - 普通回合：在自己的回合用完整博弈树搜索（含对手的反击与高光削弱）。
 * - 防守回合：把"我落这一子之后攻击结算成什么样"以及后续走势一起搜出来。
 */
export function decideMove(request: AiRequest): AiDecision {
  const startedAt = Date.now()
  const difficulty = request.difficulty ?? 'normal'
  const config = DIFFICULTY[difficulty] ?? DIFFICULTY.normal
  const budget = request.timeLimitMs ?? config.budget
  const maxDepth = request.maxDepth ?? config.depth
  // bugv18：确定性预算。>0 时改为"访问节点数上限"，让同一输入必定得到同一着法。
  const nodeLimit = Math.max(0, request.nodeLimit ?? 0)

  const legal = legalMoves(request.board)
  if (legal.length === 0) {
    return { move: -1, score: 0, elapsedMs: 0, nodes: 0 }
  }

  const self = request.selfHp
  const foe = request.opponentHp
  const hp: [number, number] = request.player === 0 ? [self, foe] : [foe, self]

  const searcher = new Searcher(
    request.board,
    hp,
    request.player,
    budget,
    request.magic ?? null,
    request.skills ?? null,
    nodeLimit,
  )

  if (request.mode === 'defend') {
    const weights = request.highlightWeights ?? new Map<number, number>()
    const cells = [...weights.keys()].sort((a, b) => a - b)
    const frame: AttackFrame = {
      attacker: other(request.player),
      cells,
      weights: cells.map((cell) => weights.get(cell) ?? 1),
      baseDamage: request.attackBaseDamage ?? cells.length,
      strikeBonus: 0,
      strikeExtra: 0,
      breakShield: false,
      // bugv17 #4：攻击方的植物加伤在宣告时就锁定了，防守方不能按棋盘重算
      magicBonus:
        (request.attackPlants ?? 0) *
        (request.magic?.damagePerPlant ?? DEFAULT_MAGIC_CONFIG.damagePerPlant),
    }
    // 保底：高光位里挑权重最大的一个（万一搜索被时间掐断）
    let bestMove = cells.find((cell) => request.board[cell] === 0) ?? legal[0]
    let bestScore = -INF
    let fallbackWeight = weights.get(bestMove) ?? 0
    for (const cell of cells) {
      if (request.board[cell] !== 0) continue
      const w = weights.get(cell) ?? 0
      if (w > fallbackWeight) {
        bestMove = cell
        fallbackWeight = w
      }
    }
    const fallback = bestMove

    let previousD: Map<number, number> | null = null
    for (let depth = 1; depth <= maxDepth; depth++) {
      const t0 = now()
      const result = searcher.searchRootDefend(depth, frame, previousD)
      const duration = now() - t0
      if (searcher.aborted) {
        if (depth === 1 && result.move >= 0) {
          bestMove = result.move
          bestScore = result.score
        }
        break
      }
      if (result.move >= 0) {
        bestMove = result.move
        bestScore = result.score
        previousD = result.scores
      }
      if (bestScore >= WIN) break
      // 确定性预算：到节点数就停；否则按墙钟（时间预算 + 2 倍余量预判下一层跑不完）
      if (nodeLimit > 0) {
        if (searcher.nodes >= nodeLimit) break
      } else if (now() - startedAt + duration * 2 > budget) break
    }

    if (request.board[bestMove] !== 0) bestMove = fallback
    return { move: bestMove, score: bestScore, elapsedMs: Date.now() - startedAt, nodes: searcher.nodes }
  }

  // 普通回合：迭代加深。每层解出完整计划「技能序列 + 落子」。
  let bestMove = legal[0]
  let bestSkills: AiSkillUse[] = []
  let bestScore = -INF
  let previous: Map<number, number> | null = null

  for (let depth = 1; depth <= maxDepth; depth++) {
    const t0 = now()
    const result = searcher.searchRootPlan(depth, previous)
    const duration = now() - t0
    if (result.aborted) {
      if (depth === 1 && result.plan.length > 0) {
        const decided = planToDecision(result.plan, legal[0])
        bestMove = decided.move
        bestSkills = decided.skills
        bestScore = result.score
      }
      break
    }
    const decided = planToDecision(result.plan, legal[0])
    bestMove = decided.move
    bestSkills = decided.skills
    bestScore = result.score
    previous = result.scores
    if (bestScore >= WIN) break
    // 确定性预算：到节点数就停（见上）
    if (nodeLimit > 0) {
      if (searcher.nodes >= nodeLimit) break
    } else if (now() - startedAt + duration * 2 > budget) break
  }

  return {
    move: bestMove,
    ...(bestSkills.length > 0 ? { skills: bestSkills } : {}),
    score: bestScore,
    elapsedMs: Date.now() - startedAt,
    nodes: searcher.nodes,
  }
}

/** 把根节点的行动计划转成对外决策（技能序列 + 落子）。 */
function planToDecision(plan: readonly RootAction[], fallbackCell: number): { move: number; skills: AiSkillUse[] } {
  const skills: AiSkillUse[] = []
  for (let i = 0; i < plan.length; i++) {
    const action = plan[i]
    if (action.kind === 'skill') {
      skills.push({
        slot: action.slot,
        cells: action.cells,
        ...(action.target >= 0 ? { target: action.target } : {}),
      })
    } else {
      return { move: action.cell, skills }
    }
  }
  // 计划里没有落子：只有「最直接、最不绕弯子」会这样（它用完直接进入攻击阶段，
  // 本回合不再需要落子）。返回 -1 表示"不需要落子"，宿主必须据此跳过落子。
  void fallbackCell
  return { move: -1, skills }
}

// ---------------------------------------------------------------------------
// 兼容旧接口的工具函数
// ---------------------------------------------------------------------------

/** 棋盘上的空位。 */
export function legalMoves(board: Board): number[] {
  const moves: number[] = []
  for (let i = 0; i < CELL_COUNT; i++) {
    if (board[i] === 0) moves.push(i)
  }
  return moves
}

/** 某位置若落子，能否立刻形成连珠。 */
export function createsLine(board: Board, player: PlayerIndex, cell: number): boolean {
  const probe = cloneBoard(board)
  probe[cell] = cellOf(player)
  const target = cellOf(player)
  const row = (cell / BOARD_SIZE) | 0
  const col = cell % BOARD_SIZE
  for (const [dr, dc] of DIRS) {
    let length = 1
    let r = row - dr
    let c = col - dc
    while (isInsideBoard(r, c) && probe[cellId(r, c)] === target) {
      length += 1
      r -= dr
      c -= dc
    }
    r = row + dr
    c = col + dc
    while (isInsideBoard(r, c) && probe[cellId(r, c)] === target) {
      length += 1
      r += dr
      c += dc
    }
    if (length >= 4) return true
  }
  return false
}

/** 某位置落子后参与连珠的实体棋子。 */
export function attackPiecesAt(board: Board, player: PlayerIndex, cell: number): number[] {
  const probe = cloneBoard(board)
  probe[cell] = cellOf(player)
  const target = cellOf(player)
  const row = (cell / BOARD_SIZE) | 0
  const col = cell % BOARD_SIZE
  const set = new Set<number>()
  for (const [dr, dc] of DIRS) {
    const run: number[] = []
    let r = row - dr
    let c = col - dc
    while (isInsideBoard(r, c) && probe[cellId(r, c)] === target) {
      run.push(cellId(r, c))
      r -= dr
      c -= dc
    }
    run.push(cell)
    r = row + dr
    c = col + dc
    while (isInsideBoard(r, c) && probe[cellId(r, c)] === target) {
      run.push(cellId(r, c))
      r += dr
      c += dc
    }
    if (run.length >= 4) for (const index of run) set.add(index)
  }
  return [...set].sort((a, b) => a - b)
}

/** 空棋盘（便于宿主工程自行构造状态）。 */
export function emptyBoard(): Board {
  return createBoard()
}

// ---------------------------------------------------------------------------
// 对外接口（re-export）：既有 `from '../ai/baseline'` 的调用方无需改动
// ---------------------------------------------------------------------------
export * from './types'
export * from './debug'
export { AI_POLICY } from './policy'
export type { ArmorGate } from './policy'
export type { MagicSnapshot } from './search'
