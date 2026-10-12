/**
 * 自对弈脚本的公共工具（bugv14）。
 *
 * 三个脚本（`bench-ai` / `duel` / `tournament`）各自复制了一份"把 AI 决策落到引擎上"
 * 的循环，结果每次加新技能都要改三遍、漏一遍就静默失效。这里把这段逻辑收敛成
 * 唯一实现，并且**只依赖 `GameEngine` 的公开接口**。
 *
 * ⚠️ 两个必须遵守的口径（都踩过）：
 * 1. **可变消耗**（「最直接、最不绕弯子」）的合法植物数是一个**区间**，
 *    不能再用 `cells.length === skillCostNow()` 去卡（那会把多选的候选全部拒掉）。
 * 2. 技能放完之后局面**可能已经进入攻击阶段**（`awaitingDefense`）——
 *    这时绝不能再落子，否则 `commit()` 会抛错或下出非法的一手。
 */
import type { GameEngine } from '../src/core/engine'
import type { AiSkillUse } from '../src/ai/baseline'
import type { PlayerIndex } from '../src/core/types'

/**
 * 校验一次技能释放的植物选择，返回**过滤后**的格子；不合法时返回 `null`。
 *
 * 可变消耗技能允许 `min ~ max` 之间的任意数量。
 *
 * ⚠️ bugv31：**首次免费**的可变消耗技能（gtp「恶龙吐息」）合法数量是 `0`，
 * 不能按"标称区间 2~3"去卡 —— 否则永远判不合法，AI 一辈子放不出这个技能
 * （同角色对撞里 A 侧 0 次施法、胜率 5%，就是这么来的）。
 */
export function resolveSkillCells(
  engine: GameEngine,
  player: PlayerIndex,
  use: AiSkillUse,
): number[] | null {
  const state = engine.skillStateFor(player, use.slot)
  if (!state || !state.ready) return null
  if (state.targetsCell && (use.target === undefined || use.target < 0)) return null
  const cells = (use.cells ?? []).filter((cell) => engine.magic.get(cell)?.owner === player)
  const freeNow = state.costNow <= 0
  const min = freeNow ? 0 : (state.costMin ?? state.costNow)
  const max = freeNow ? 0 : (state.costMax ?? state.costNow)
  if (cells.length < min || cells.length > max) return null
  return cells
}

export interface ApplySkillsResult {
  /** 成功释放的技能（按顺序）。 */
  used: Array<{ slot: number; effect: string; cells: number[] }>
  /**
   * 释放完之后局面是否**已经不在**该方手上（endsTurn 技能交回合，
   * 或「最直接、最不绕弯子」直接进入攻击阶段）→ 调用方必须跳过这一手的落子。
   */
  skipPlacement: boolean
}

/**
 * 把一个 AI 决策里的技能序列依次落到引擎上。
 *
 * 任何一个技能放不下就停止后续技能（与宿主 `applyAiSkill` 的语义一致）。
 */
export function applyAiSkills(
  engine: GameEngine,
  player: PlayerIndex,
  uses: readonly AiSkillUse[] | undefined,
): ApplySkillsResult {
  const used: ApplySkillsResult['used'] = []
  for (const use of uses ?? []) {
    if (engine.current !== player || engine.phase !== 'playing') break
    const cells = resolveSkillCells(engine, player, use)
    if (cells === null) break
    const state = engine.skillStateFor(player, use.slot)
    if (!state) break
    engine.useSkill(player, use.slot, cells, state.targetsCell ? (use.target ?? null) : null)
    used.push({ slot: use.slot, effect: state.effect, cells })
    engine.takeEvents()
    if (engine.isOver) return { used, skipPlacement: true }
  }
  // endsTurn（恶龙吐息）或 assault（最直接、最不绕弯子）都会让这一手不再需要落子
  const skipPlacement = engine.isOver || engine.current !== player || engine.phase !== 'playing'
  return { used, skipPlacement }
}

/**
 * 落点兜底：AI 给出非法落点（或方案里根本没有落点）时挑一个安全格。
 *
 * 「安全」= 不在任何烈焰上（走火要扣血，只作为最后手段）。
 */
export function fallbackPlacement(engine: GameEngine, player: PlayerIndex): number | undefined {
  const legal = engine.legalMoves().filter((cell) => engine.canPlaceAt(cell))
  if (legal.length === 0) return undefined
  const dry = legal.filter((cell) => !engine.flames.has(cell) || engine.flameOwner.get(cell) === player)
  const safe = dry.filter((cell) => !engine.flames.has(cell))
  return safe[0] ?? dry[0] ?? legal[0]
}
