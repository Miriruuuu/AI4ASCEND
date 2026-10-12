/* 仅供测试 / 对拍 / 调参的调试 API（debugSimulate 是三个 verify-ai-* 脚本的钩子）。 */
import { DEFAULT_MAGIC_CONFIG, other, type Board, type PlayerIndex } from '../core/types'
import type { AiMagicContext, AiRequest, AiSkillContext } from './types'
import { Searcher, type AttackFrame, type MagicSnapshot, type SkillMove } from './search'

/**
 * 调试函数专用的时间上限。
 *
 * ⚠️ 这里**故意设得很小**：调试脚本会一次性跑上千次搜索，若每次都给 60s 上限，
 * 单次脚本就要跑十几分钟。诊断只需要"跑到足够深"，不需要跑满生产预算。
 */
const DEBUG_BUDGET_MS = 1_500

/**
 * 仅供测试：跑一次根搜索，返回**搜索结束后**的工作棋盘。
 *
 * 正常情况下它必须与传入的棋盘逐格相同 —— 任何差异都说明"落子 / 撤销"不对称，
 * 搜索会在错误的局面上越走越偏。
 */
/**
 * 仅供测试：跑一次根搜索，返回**搜索结束后**的工作棋盘。
 *
 * 正常情况下它必须与传入的棋盘逐格相同 —— 任何差异都说明"落子 / 撤销"不对称，
 * 搜索会在错误的局面上越走越偏。
 */
export function debugBoardAfterSearch(
  board: Board,
  hp: readonly [number, number],
  player: PlayerIndex,
  depth: number,
  highlightWeights?: ReadonlyMap<number, number>,
  magic?: AiMagicContext | null,
  skills?: AiSkillContext | null,
): { board: number[]; hp: [number, number] } {
  const searcher = new Searcher(board, hp, player, DEBUG_BUDGET_MS, magic ?? null, skills ?? null)
  if (highlightWeights) {
    const cells = [...highlightWeights.keys()].sort((a, b) => a - b)
    const frame: AttackFrame = {
      attacker: other(player),
      cells,
      weights: cells.map((cell) => highlightWeights.get(cell) ?? 1),
      baseDamage: cells.length,
      strikeBonus: 0,
      strikeExtra: 0,
      breakShield: false,
      magicBonus: 0,
    }
    for (let d = 1; d <= depth; d++) searcher.searchRootDefend(d, frame, null)
  } else {
    // 模拟 decideMove 的迭代加深（同一个搜索器连续跑多层）
    for (let d = 1; d <= depth; d++) searcher.searchRootStep(d, null)
  }
  return { board: [...searcher.board], hp: [searcher.hp[0], searcher.hp[1]] }
}

/** 仅供调参：静态评估（根玩家视角）。 */
export function debugEval(
  board: Board,
  hp: readonly [number, number],
  root: PlayerIndex,
  turn: PlayerIndex,
  magic?: AiMagicContext | null,
  skills?: AiSkillContext | null,
): number {
  const searcher = new Searcher(board, hp, root, 1000, magic ?? null, skills ?? null)
  return searcher.evaluate(turn)
}

/**
 * 仅供测试 / 回归：返回根节点**会被考虑**的技能着法（不做搜索）。
 *
 * 这是把"技能闸门"暴露出来的唯一口子。闸门写错的代价是**技能永远放不出来**，
 * 而且从对局结果里极难看出来（只表现为"某个角色莫名很弱"）——实际踩过两次：
 * 双子星用 4 连去卡（两连即可攻击，憋着不放）、毒鸡蛋自锁（判据要求"技能已释放"）。
 * 所以必须有确定性测试钉住它。
 *
 * ⚠️ 生产代码不要调用。
 */
export function debugRootSkillMoves(
  request: AiRequest,
): Array<{ slot: number; effect: string; target: number; cells: number[] }> {
  const hp: [number, number] =
    request.player === 0 ? [request.selfHp, request.opponentHp] : [request.opponentHp, request.selfHp]
  const searcher = new Searcher(
    request.board,
    hp,
    request.player,
    DEBUG_BUDGET_MS,
    request.magic ?? null,
    request.skills ?? null,
  )
  const out: SkillMove[] = []
  searcher.generateSkillMoves(request.player, out)
  return out.map((m) => ({ slot: m.slot, effect: m.effect, target: m.target, cells: [...m.cells] }))
}

/**
 * 仅供调试 / 调参：把根节点每个候选着法的搜索分数打出来。
 *
 * ⚠️ 生产代码不要调用。
 */
export function debugRootScores(
  board: Board,
  hp: readonly [number, number],
  player: PlayerIndex,
  depth: number,
  mode: 'attack' | 'defend' = 'attack',
  highlightWeights?: ReadonlyMap<number, number>,
  magic?: AiMagicContext | null,
  skills?: AiSkillContext | null,
): Array<{ move: number; score: number }> {
  const searcher = new Searcher(board, hp, player, DEBUG_BUDGET_MS, magic ?? null, skills ?? null)
  let scores: Map<number, number>
  if (mode === 'defend') {
    const weights = highlightWeights ?? new Map<number, number>()
    const cells = [...weights.keys()].sort((a, b) => a - b)
    const frame: AttackFrame = {
      attacker: other(player),
      cells,
      weights: cells.map((cell) => weights.get(cell) ?? 1),
      baseDamage: cells.length,
      strikeBonus: 0,
      strikeExtra: 0,
      breakShield: false,
      magicBonus: 0,
    }
    scores = searcher.searchRootDefend(depth, frame, null).scores
  } else {
    scores = searcher.searchRootStep(depth, null).scores
  }
  return [...scores.entries()].map(([move, score]) => ({ move, score })).sort((a, b) => b.score - a.score)
}

/** `debugSimulate` 的结果快照。 */
export interface SimulatedStep extends MagicSnapshot {
  board: number[]
  hp: [number, number]
  /** 与 `GameEngine.current` 对齐：攻击阶段时是**防守方**。 */
  turn: PlayerIndex
  /** 是否停在"等待防守方落子"。 */
  awaitingDefense: boolean
}

/**
 * 仅供测试 / 回归：用 AI 内部的迷你引擎推进一步，供 `GameEngine` 对拍。
 *
 * ⚠️ 生产代码不要调用 —— 它只是把搜索器内部的状态转移暴露出来做一致性校验。
 *
 * `mode`：`attack` = 普通落子、`defend` = 攻击阶段防守落子、`skill` = 释放技能。
 * `attackInfo`：**防守模式必须传** —— 引擎的攻击上下文里有"高光格体现不出来的"信息
 * （攻击值 = 消耗植物数的「最直接、最不绕弯子」、以及「深度思考」的加成与追加伤害）。
 * 不传就会把来袭伤害算少，进而误判生死。
 */
export function debugSimulate(
  board: Board,
  hp: readonly [number, number],
  player: PlayerIndex,
  mode: 'attack' | 'defend' | 'skill',
  move: number,
  highlightWeights?: ReadonlyMap<number, number>,
  magic?: AiMagicContext | null,
  skills?: AiSkillContext | null,
  skillCells?: readonly number[],
  skillTarget?: number,
  attackInfo?: {
    baseDamage?: number
    strikeBonus?: number
    strikeExtra?: number
    /**
     * bugv30：「力大砖飞」这一击成功造成伤害后要清空受伤方的护盾。
     *
     * 不传就按 `strikeBonus > 0` + 攻击方技能表里有没有 `breakShield` 自动推断。
     */
    breakShield?: boolean
    /**
     * bugv17 #4：攻击方连珠上的**植物棵数**（引擎在宣告攻击时锁定）。
     *
     * 引擎已经在宣告那一刻把植物随棋子一并删掉了，所以防守模式的迷你引擎
     * **不能**按当前棋盘重算加伤 —— 必须由调用方把锁定的棵数传进来。
     */
    attackerPlants?: number
  },
): SimulatedStep {
  const searcher = new Searcher(board, hp, player, 1000, magic ?? null, skills ?? null)
  let awaitingDefense = false
  let continues = false
  if (mode === 'skill') {
    const undo = searcher.applySkill(player, move, skillCells ?? [], skillTarget ?? -1)
    continues = undo.continues
    // bugv14：「最直接、最不绕弯子」用完直接进入攻击阶段
    awaitingDefense = undo.frame !== null
  } else if (mode === 'attack') {
    const undo = searcher.applyPlace(move, player)
    awaitingDefense = undo.frame !== null
    continues = undo.continues
  } else {
    const weights = highlightWeights ?? new Map<number, number>()
    const cells = [...weights.keys()].sort((a, b) => a - b)
    const damagePerPlant = magic?.damagePerPlant ?? DEFAULT_MAGIC_CONFIG.damagePerPlant
    // bugv17 #4：默认按"传进来的植物"算加伤（向后兼容）；
    // 引擎侧已经把那批植物删掉了，所以宿主/对拍脚本要显式传 `attackerPlants`。
    const attacker = other(player)
    let fallbackPlants = 0
    if (magic?.plants) for (const [cell, owner] of magic.plants) if (owner === attacker && cells.includes(cell)) fallbackPlants += 1
    // bugv30：「力大砖飞」的破盾——调用方没显式传就按"有 strikeBonus + 该方技能带 breakShield"推断
    const attackerSkills = skills?.skills?.[attacker] ?? []
    const inferredBreakShield =
      (attackInfo?.strikeBonus ?? 0) > 0 &&
      attackerSkills.some((spec) => spec.effect === 'firstStrike' && spec.breakShield === true)
    const frame: AttackFrame = {
      attacker,
      cells,
      weights: cells.map((cell) => weights.get(cell) ?? 1),
      baseDamage: attackInfo?.baseDamage ?? cells.length,
      strikeBonus: attackInfo?.strikeBonus ?? 0,
      strikeExtra: attackInfo?.strikeExtra ?? 0,
      breakShield: attackInfo?.breakShield ?? inferredBreakShield,
      magicBonus: (attackInfo?.attackerPlants ?? fallbackPlants) * damagePerPlant,
    }
    searcher.applyDefense(move, frame)
  }
  return {
    board: [...searcher.board],
    hp: [searcher.hp[0], searcher.hp[1]],
    // ⚠️ 进入攻击阶段时行棋权在**防守方**手上（引擎的 `current` 也是这么给的）——
    // 「最直接、最不绕弯子」虽然是"不交回合"的技能，但它会直接开打，这时不能报 `player`。
    turn: awaitingDefense ? other(player) : continues ? player : other(player),
    awaitingDefense,
    ...searcher.magicSnapshot(),
  }
}
