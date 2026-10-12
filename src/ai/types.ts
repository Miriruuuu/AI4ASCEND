/* AI 对外的输入 / 输出契约：宿主（useConnectGame）、ai/protocol、脚本都只依赖这里。 */
import type { Board, PlayerIndex, SkillSpec } from '../core/types'

export type AiDifficulty = 'easy' | 'normal' | 'hard' | 'expert'

/**
 * 迷你引擎需要的"魔力植物"信息（阶段二）。
 *
 * ## 公平性：只使用棋盘上**看得见**的植物
 *
 * 植物位置虽然是确定性派生的（理论上玩家也能算），但实战里没人能提前知道下一次长在哪几格。
 * 所以 AI **不模拟未来生长、不预测位置** —— 只把当前棋盘上已有的植物纳入推演。否则就是
 * 开图作弊，赢的也不是棋力。
 *
 * 由此只需要两样东西：现有植物（格子 + 归属）与"每棵加几点伤害"。生长时机（冷却）
 * 只在"会长出哪几棵"上有意义，既然不预测生长，那些计时状态就完全不需要传。
 *
 * 不传 = 没有植物（等价于阶段一行为，也方便做对照测试）。
 */
export interface AiMagicContext {
  /** 棋盘上现有的植物：`[格子, 归属]`（归属 `null` = 无主）。 */
  plants?: ReadonlyArray<readonly [number, PlayerIndex | null]>
  /** 连珠上每有一棵己方植物，最终伤害 +几点（默认 1）。 */
  damagePerPlant?: number
}

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
  /** 防守模式下己方落子可以削弱的攻击方连珠高光（格子 -> 属于几条连珠）。 */
  highlightWeights?: ReadonlyMap<number, number>
  /**
   * 防守模式下**攻击方的攻击值**（基础伤害）。
   *
   * 默认 = `highlightWeights.size`（普通连珠攻击）；「最直接、最不绕弯子」没有高光格，
   * 必须由宿主显式传 `GameEngine.attack.baseDamage`，否则防守方会把来袭伤害算成 0。
   */
  attackBaseDamage?: number
  /**
   * 防守模式下**攻击方连珠上锁定的植物棵数**（bugv17 #4）。
   *
   * `GameEngine.attack.attackerPlants`。引擎在宣告攻击时就把那些植物随棋子一并删掉了，
   * 守卫方按当前棋盘重算只会得到 0，因此必须由宿主显式传进来。
   */
  attackPlants?: number
  difficulty?: AiDifficulty
  /** 思考时间上限（毫秒）。 */
  timeLimitMs?: number
  /**
   * 搜索深度上限（覆盖棋力预设）。
   *
   * 主要用于**测试**：时间受限的搜索会因机器负载落到不同深度、给出不同着法，
   * 单元测试里断言"某个具体选点"就会随机翻车。固定 `maxDepth` 后结果是确定的。
   */
  maxDepth?: number
  /**
   * **确定性预算**（bugv18）：给定后，搜索改用"访问节点数上限"而不是墙钟时间来决定何时收手。
   *
   * 动机：时间预算制搜索会随机器负载落到不同深度 —— 同一份代码、同一个随机种子跑两遍
   * 循环赛，名次会互换（实测 seedance 56.9% ↔ 49.4%、deepseek 38.8% ↔ 48.8%）。
   * 换成节点预算后**同样的输入必定给出同样的着法**（`now()` 完全不参与决策），
   * 剩下的差异才真的来自被比较的对象。`0` / 不传 = 沿用时间预算（**线上行为不变**）。
   */
  nodeLimit?: number
  /** 魔力植物上下文（阶段二）。不传 = 关闭植物。 */
  magic?: AiMagicContext
  /** 角色技能上下文（阶段三）。不传 = 没有技能（等价于纯下棋）。 */
  skills?: AiSkillContext
}

/**
 * 迷你引擎需要的"角色技能"上下文（阶段三）。
 *
 * ## 公平性：只用**双方公开可见**的信息
 *
 * 技能表是开局的公开信息（开始菜单 / 对局里双方角色都看得见）；
 * 技能冷却、护盾、增益等也都直接显示在界面上。所以这些字段都可以交给 AI。
 * 唯一**不允许**的是"读心"——去猜对手下一步的具体意图，那不是信息，是作弊。
 *
 * 不传 = 没有技能（等价于阶段二行为，也方便做对照测试）。
 */
export interface AiSkillContext {
  /** 双方技能表：`[玩家0的技能, 玩家1的技能]`（引擎口径，索引就是 `PlayerIndex`）。 */
  skills: readonly [readonly SkillSpec[], readonly SkillSpec[]]
  /** 双方护盾（先于血量承伤）。 */
  shield?: readonly [number, number]
  /** 双方还能连下几颗子（「杀鲸霸拳」）。 */
  bonusActions?: readonly [number, number]
  /** 双方已行动次数（技能冷却的基准）。 */
  actionsTaken?: readonly [number, number]
  /** 各技能"还能再用"的行动次数门槛。 */
  skillReadyAt?: readonly [readonly number[], readonly number[]]
  /** 各技能已经释放过几次（`freeFirst` 只有第一次免费）。 */
  skillCasts?: readonly [readonly number[], readonly number[]]
  /** 伤害加成（「小一哥」）。 */
  powerBonus?: readonly [number, number]
  /**
   * 伤害加成的到期回合（`> turnNo` 时仍生效）。
   *
   * bugv12 #2：「小一哥」改成**持续 2 回合**，不传这个字段就会被当成"仅本回合"
   * （AI 会低估它，等于白送对手 1 点伤害）。
   */
  powerUntil?: readonly [number, number]
  /** 本回合是否可以在敌方棋子上落子（「毒鸡蛋」）。 */
  sabotage?: readonly [boolean, boolean]
  /** 本回合毒鸡蛋的额外伤害（bugv12 #3，可与小一哥叠加）。 */
  sabotageBonus?: readonly [number, number]
  /** 「双子星」爆发窗口。 */
  twinStar?: readonly [boolean, boolean]
  /** 下次双子星是否**消耗 -1**（bugv12 #3 的条件奖励，bugv14 改成减费）。 */
  bloomCheaperNext?: readonly [boolean, boolean]
  /**
   * bugv19：低消耗档「杀鲸霸拳」——这一回合该方的魔力植物**不提供伤害加成**。
   *
   * 不传就会被当成"植物照常加伤"，AI 会高估自己 2 费那一手打出的伤害。
   */
  noPlantBonus?: readonly [boolean, boolean]
  /** 无敌持续到第几回合（`> turnNo` 时该方无敌）。 */
  immuneUntil?: readonly [number, number]
  /** 临时护甲与到期回合（bugv14「精密计算」）。 */
  tempArmor?: readonly [number, number]
  tempArmorUntil?: readonly [number, number]
  /** 「深度思考」的额外攻击值与到期回合（bugv14）。 */
  strikeBonus?: readonly [number, number]
  strikeUntil?: readonly [number, number]
  /** 「播种」窗口（bugv14）。 */
  seedGrow?: readonly [boolean, boolean]
  /** bugv34m：Qwen「本地部署」的窗口与本回合伤害加成。 */
  deploy?: readonly [boolean, boolean]
  deployBonus?: readonly [number, number]
  /**
   * bugv34m：Qwen「小千问」待重新部署的棋子（编码值：原格 * 2 + 叠子位）。
   *
   * 不传的话 AI 会以为"没有待结算的棋子"，从而算错这一手的落子结果。
   */
  redeployPending?: ReadonlyArray<readonly number[]>
  /** 当前回合序号。 */
  turnNo?: number
  /** 棋盘上的烈焰：`[格子, 剩余半回合]`。 */
  flames?: ReadonlyArray<readonly [number, number]>
  /** 烈焰归属（bugv14）：`[格子, 主人]`。不传 = 谁都不能走在火上。 */
  flameOwner?: ReadonlyArray<readonly [number, number]>
  /** 叠在敌方棋子上的额外棋子：`[格子, 归属]`。 */
  overlay?: ReadonlyArray<readonly [number, number]>
  /** 初始血量（回血上限）。 */
  initialHp?: number
}

/** 一次技能释放（决策输出用）。 */
export interface AiSkillUse {
  /** 技能槽位（0 / 1）。 */
  slot: number
  /** 要消耗的魔力植物格子。 */
  cells: number[]
  /** 需要点选目标格的技能（恶龙吐息）的目标格。 */
  target?: number
}

export interface AiDecision {
  /** 决策落子位置（棋盘下标）。 */
  move: number
  /**
   * 落子**之前**要依次释放的技能（按顺序执行）。
   *
   * 技能用完回合不交出去（8 个技能都是"用完还能落子"），所以宿主先逐个 `useSkill()`
   * 再 `commit()`；连下两颗时宿主会在第一次 `commit()` 之后**再次**调用 AI 决策第二颗。
   */
  skills?: AiSkillUse[]
  /** 搜索得到的分数（越大越好）。 */
  score: number
  /** 思考耗时（毫秒）。 */
  elapsedMs: number
  /** 搜索节点数。 */
  nodes: number
}
