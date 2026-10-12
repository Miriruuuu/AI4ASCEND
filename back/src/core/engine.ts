/**
 * 对局引擎：规则状态机（纯逻辑，零渲染依赖）。
 *
 * 设计要点：
 * - 所有状态变更在 `commit()` 中同步完成，并返回一串**语义事件**；
 *   表现层（three.js / Vue）只需按顺序播放这些事件的动画即可。
 * - 引擎自身不关心动画时长，因此可被单测完整覆盖。
 */
import {
  finalAttackValue,
  clashCount,
  damageDiff,
  summarizeMatch,
  summaryOfLines,
  uniquePieceCells,
  type BoardLike,
  type MatchSummary,
} from './lines'
import { MAGIC_KINDS, pickMagicPlants, plantsOnCells, ringCells, seededRng } from './magic'
import { Rng, rollDie } from './random'
import {
  BOARD_SIZE,
  CELL_COUNT,
  INITIAL_HP,
  WEATHERS,
  cellId,
  cellOf,
  cloneBoard,
  createBoard,
  isInsideBoard,
  other,
  playerOf,
  resolveMagicConfig,
  resolveNightConfig,
  magicCountForGrowth,
  type AttackSnapshot,
  type Board,
  type Cell,
  type GameEvent,
  type GameResult,
  type MagicConfig,
  type MagicKind,
  type MagicPlant,
  type MatchPhase,
  type NightConfig,
  type NightPhase,
  type PlayerIndex,
  type ResolutionMode,
  type SkillSpec,
  type SkillState,
  type WeatherId,
} from './types'

export interface GameEngineOptions {
  /** 随机种子（用于测试与回放）。 */
  seed?: number
  /** 初始血量。 */
  initialHp?: number
  /** 是否在构造时自动掷骰子决定先后手。 */
  autoRoll?: boolean
  /** 自定义先后手（跳过掷骰子，主要用于测试）。 */
  fixedFirstPlayer?: PlayerIndex
  /** 魔力植物配置（bugv8 #4，联机固定用默认值）。 */
  magic?: Partial<MagicConfig> | null
  /**
   * 双方的角色技能表（bugv9 #13）。
   *
   * 引擎不认识"角色"，只认识数值；宿主把角色的技能表传进来即可。
   * 联机时两端都传自己的角色技能（技能状态不参与指纹），但联机对局禁用技能。
   */
  skills?: readonly [readonly SkillSpec[], readonly SkillSpec[]] | null
  /** 黑夜机制配置（bugv34，联机固定用默认值）。 */
  night?: Partial<NightConfig> | null
}

/**
 * 「双子星」把连珠门槛降到 2（bugv11 #5：本回合形成两连即可发起攻击）。
 */
const TWIN_STAR_LINE_LENGTH = 2

/**
 * 走在自己的烈焰上要付出的代价（bugv14）。
 *
 * 结算顺序与普通伤害一致：临时护甲 → 护盾 → 血量（`applyDamage`）。
 */
const FLAME_WALK_DAMAGE = 1

interface AttackDraft {
  attacker: PlayerIndex
  lines: MatchSummary['lines']
  cells: readonly number[]
  baseDamage: number
  lineLengthSum: number
  weights: ReadonlyMap<number, number>
  defenseCell: number | null
  weakness: number
  finalAttack: number
  defenderLines: MatchSummary['lines']
  defenderCells: readonly number[]
  defenderAttack: number
  /**
   * 「瘟疫」分裂给防守方的攻击棋子数（bugv34）。
   *
   * 宣告攻击时就已给出初值（防守方**落子前**就握着这些棋子），
   * `defend()` 里再按"植物是否被抢走"重算。与 `defenderAttack` 分开记：
   * 防守方**可能并没有成线反击**，只是靠这些分裂出来的棋子参与对撞；
   * `resolveAttack` 用它判断"是否进入对撞"。
   */
  plagueSplit: number
  /**
   * 「暴雪」解冻的**待重生格**（bugv34c）。
   *
   * 口径（用户明确）：连珠上被冻结的魔力植物会**随着棋子一起消失**，同时**在原地**
   * 重新长出一棵**非冻结**的魔力植物 —— 「你可以理解为解冻」。
   * `defend()` 在清植物前登记这些格子，`resolveAttack` 的**最后**统一重生
   * —— 必须等防守方棋子也飞走（`removeDetached`）之后，否则刚长出来就被清掉。
   */
  thawCells: number[]
  /**
   * 防守方反击值里**与天气无关**的部分 = 连珠棋子数 + 小一哥 + 毒鸡蛋。
   *
   * `buildSnapshot()` 用 `defenderAttack − (defenderCombatBase + 无天气的植物加伤)`
   * 反推出"天气给防守方带来的净增减伤"（bugv34d，结算面板显示用）。
   */
  defenderCombatBase: number
  mode: ResolutionMode | null
  damaged: PlayerIndex | null
  diff: number
  clash: number
  /** 攻击方连珠上计入伤害的魔力植物（bugv8 #4）。 */
  attackerPlantCells: readonly number[]
  /** 防守方连珠上计入伤害的魔力植物（含抢来的）。 */
  defenderPlantCells: readonly number[]
  /** 被防守方抢走的植物数量。 */
  stolenPlants: number
  /** 攻击方本回合的额外攻击值（bugv10 #9 小一哥）。 */
  powerBonus: number
  /** 攻击方本回合的额外伤害（bugv12 #3 毒鸡蛋，可与小一哥叠加）。 */
  sabotageBonus: number
  /**
   * 攻击方本回合因「本地部署」获得的额外伤害（bugv34m）：
   * 使用该技能的那个回合里落子成连珠 → 这一击 +1。
   */
  deployBonus: number
  /** 攻击方因「力大砖飞」获得的额外攻击棋子数（bugv14，原「深度思考」）。 */
  strikeBonus: number
  /**
   * 「深度思考」的**追加**加成（bugv14）：防守方没能成线反击时再补这么多伤害。
   *
   * ⚠️ bugv30 起**恒为 0**（该技能的第二段加成被"破盾"取代），字段保留是为了
   * 不改动 `AttackSnapshot` 的字段清单 —— 前后端指纹 / 回放 / 落库都按它对齐。
   */
  strikeExtra: number
  /**
   * bugv30：这一击是「力大砖飞」的加成攻击，**成功造成伤害后要把受伤方的护盾清空**。
   */
  breakShield: boolean
  /** 伤害被无敌挡下时，无敌的一方（bugv10 #9 精密计算）。 */
  immune: PlayerIndex | null
}

/** 把 Map / 数组两种形态统一转成 Map（联机 sync / 回放用，bugv10 #9）。 */
function toNumberMap(
  input: ReadonlyMap<number, number> | ReadonlyArray<readonly [number, number]> | undefined,
): Map<number, number> {
  const out = new Map<number, number>()
  if (!input) return out
  if (Array.isArray(input)) {
    for (const entry of input as ReadonlyArray<readonly [number, number]>) out.set(entry[0], entry[1])
    return out
  }
  for (const entry of input as ReadonlyMap<number, number>) out.set(entry[0], entry[1])
  return out
}

export class GameEngine {
  board: Board = createBoard()
  hp: [number, number]
  phase: MatchPhase = 'setup'
  /** 当前该谁落子（playing 阶段有效）。 */
  current: PlayerIndex = 0
  /** 掷骰子决定的首发方。 */
  firstPlayer: PlayerIndex | null = null
  /** 攻击阶段信息。 */
  attack: AttackSnapshot | null = null
  /** 高光位置 -> 属于几条连珠。 */
  highlights = new Map<number, number>()
  /** 攻击方高光的拥有者。 */
  highlightOwner: PlayerIndex | null = null
  result: GameResult | null = null
  /** 已落子总数。 */
  readonly moveCount = { value: 0 }

  // --- 魔力植物（bugv8 #4） ------------------------------------------------
  /** 配置（联机固定默认值）。 */
  readonly magicConfig: MagicConfig
  /** 棋盘上的魔力植物：格子 -> 植物。空位才有；`owner` 是把它占住的一方。 */
  magic = new Map<number, MagicPlant>()
  /** 已经长出过几次（决定单次数量）。 */
  magicGrowths = 0
  /** 距离下次生长还剩几回合。 */
  magicCooldown = 0
  /** 是否已经出现过连珠（`requireLine` 的门槛）。 */
  magicLineSeen = false

  // --- 黑夜机制与天气（bugv34，规格见 Weather.md） --------------------------
  /** 黑夜配置（联机固定用默认值）。 */
  readonly nightConfig: NightConfig
  /** 黑夜阶段：`none` = 白天 / `pending` = 预告中 / `active` = 黑夜中。 */
  nightPhase: NightPhase = 'none'
  /** 预告剩余回合（双方回合，递减到 0 进入黑夜）。 */
  nightCountdown = 0
  /** 黑夜已持续的回合数（双方回合）。 */
  nightTurns = 0
  /** 距上次黑夜结束已过几回合（用于"再次触发需间隔 ≥ minGap"；用大数避免 JSON 的 Infinity）。 */
  turnsSinceNight = 999
  /** 当前天气（`active` 时有效；`null` = 无）。 */
  weather: WeatherId | null = null
  /**
   * 双方"发起过的攻击棋子"总数（连珠后飞出的实体棋子数，**不是最终造成的伤害**）。
   *
   * 黑夜的进入 / 退出条件都读它。`attackStoneCount()` 给出双方合计。
   */
  attacksLaunched: [number, number] = [0, 0]
  /** 本次黑夜开始时的 `attacksLaunched` 快照（算"黑夜期间增量"；参与联机指纹）。 */
  nightAttackBase: [number, number] = [0, 0]
  /**
   * 当前这次黑夜是不是由「黑夜开局」触发的（bugv34d）。
   *
   * 用途只有一个：**首个黑夜的强制退出条件里不判「场上没有被棋子占有的魔力植物」** ——
   * 开局必然 0 棵植物，若照常判就会第一回合天亮，黑夜等于没开。
   *
   * ⚠️ 「黑夜开局」只在**非联机**启用（联机固定 `startInNight: false`），
   * 所以这个标记在联机里恒为 `false`，**不参与**联机指纹的六处字段清单。
   * 若哪天要在联机也开「黑夜开局」，必须把它一起加进那六处。
   */
  nightFromStart = false

  /** 本次落子的连珠冷却削减是否已经生效（同一次攻击只减一次）。 */
  private lineCutDone = false

  // --- 角色技能（bugv9 #13） ------------------------------------------------
  /**
   * 双方各自的技能表（引擎只认数值）。
   *
   * 可变：宿主在设置里换角色之后可以直接替换技能表（下一手立刻生效）。
   */
  skills: readonly [readonly SkillSpec[], readonly SkillSpec[]]
  /** 护盾：先于血量承伤，无上限。 */
  shield: [number, number] = [0, 0]
  /** 还能连续行动几次（「下回合可连续行动 2 回合」）。 */
  bonusActions: [number, number] = [0, 0]
  /** 各方已经行动过几次（冷却以「行动次数」为单位）。 */
  actionsTaken: [number, number] = [0, 0]
  /** 每个技能"可以再次使用"的行动次数门槛。 */
  skillReadyAt: [number[], number[]] = [[], []]
  /** 各方最近一颗棋子的位置（绽放技能围绕它生长）。 */
  lastPlacedBy: [number | null, number | null] = [null, null]

  // --- bugv10 #9：新增角色的技能状态 ----------------------------------------
  /** 回合序号（每次换手 +1）：用于「直到对手的下个回合结束」这类持续效果。 */
  turnNo = 0
  /**
   * 无敌持续到第几回合（`immuneUntil[p] > turnNo` 时该方无敌）。
   *
   * `grantImmunity` 设成 `turnNo + amount`：
   * - `amount = 2`（bugv12 #2 起「精密计算」的口径）→ 覆盖当前回合与**对手的下个回合**；
   * - `amount = 1` → 只覆盖当前回合（纯粹的"免疫反击"）。
   */
  immuneUntil: [number, number] = [0, 0]
  /** 额外攻击值（小一哥：生成攻击棋子时额外飞出一颗）。 */
  powerBonus: [number, number] = [0, 0]
  /**
   * 增伤持续到第几回合（`powerUntil[p] > turnNo` 时 `powerBonus[p]` 仍生效）。
   *
   * bugv12 #2：「小一哥」改成**持续 2 回合**（使用技能的当前回合 + 自己的下一个回合）。
   * `useSkill` 设成 `turnNo + duration`；`clearTurnEffects` 只在 `powerUntil <= turnNo` 时清空。
   */
  powerUntil: [number, number] = [0, 0]
  /** 本回合是否可以在敌方棋子上落子（毒鸡蛋）。 */
  sabotage: [boolean, boolean] = [false, false]
  /**
   * 本回合因「毒鸡蛋」获得的额外伤害（bugv12 #3：可与「小一哥」的 `powerBonus` 叠加）。
   * 只在**当前回合**有效（随 `sabotage` 一起在换手时清空），所以它和"持续 2 回合"的
   * `powerBonus` 必须分开存 —— 否则毒鸡蛋的 +1 会被错误地带到自己的下一个回合。
   */
  sabotageBonus: [number, number] = [0, 0]
  /**
   * 下次释放「双子星」是否**消耗 -1**（bugv12 #3 的条件奖励，bugv14 从"免费"改成"减 1"）。
   *
   * 条件：本回合成线攻击、且对手没能成线反击 → 本次不进冷却 + 下一次消耗 -1。
   * 减费的那一次用完即清掉本标记。
   */
  bloomCheaperNext: [boolean, boolean] = [false, false]
  /**
   * 临时护甲（bugv14「精密计算」）：先于护盾承伤，**到期清零**（未用完的不留着）。
   */
  tempArmor: [number, number] = [0, 0]
  /** 临时护甲到期回合（`tempArmorUntil[p] <= turnNo` 时清空）。 */
  tempArmorUntil: [number, number] = [0, 0]
  /**
   * 「深度思考」（bugv14）：首个连珠攻击的额外攻击棋子数。
   *
   * 在**宣告攻击**时结算进 `baseDamage` 并立即清零（只对"首个连珠攻击"生效）；
   * 若防守方没能成线反击，还会再补一次同样的加成（见 `AttackDraft.strikeExtra`）。
   */
  strikeBonus: [number, number] = [0, 0]
  /** 额外攻击值持续到第几回合（同 `powerUntil` 的口径）。 */
  strikeUntil: [number, number] = [0, 0]
  /** 本回合是否处于「播种」窗口（落子未成连珠 → 周围长植物）。 */
  seedGrow: [boolean, boolean] = [false, false]
  /**
   * bugv34m「本地部署」（Qwen 1 技能）的窗口：本回合落子时 ——
   * 未成连珠 → 在**落点**长一棵魔力植物（该格已有植物则跳过）；成连珠 → 本次攻击伤害 +1。
   */
  deploy: [boolean, boolean] = [false, false]
  /**
   * bugv34m「本地部署」本回合的伤害加成（与 `deploy` 同生共死，换手时清空）。
   *
   * 单独一个字段（而不是塞进 `powerBonus`）是为了让攻击快照能如实标出这 +1 的来源。
   */
  deployBonus: [number, number] = [0, 0]
  /**
   * bugv34m「小千问」（Qwen 2 技能）待结算的棋子。
   *
   * 每项是**编码值** `原格 * 2 + (是否叠子 ? 1 : 0)`：技能释放时记下被移除的棋子，
   * 本回合落子未成连珠时按这个表逐个"重新部署"；放不下的回原位并退还植物。
   */
  redeployPending: [number[], number[]] = [[], []]
  /**
   * bugv19「杀鲸霸拳」的低消耗档：这一回合该玩家的**魔力植物不提供伤害加成**。
   *
   * 选 2 棵植物释放时可以更快打出（用于大连击 / 封堵），代价是这一回合自己的
   * 植物加伤（攻击方连珠加成 + 防守方反击加成）全部按 0 计。
   * 与其它"仅本回合有效"的效果一起在换手时清掉。
   */
  noPlantBonus: [boolean, boolean] = [false, false]
  /**
   * 「双子星」的爆发窗口（bugv11 #5，bugv11 追加 #2 起是它的**唯一**效果）。
   *
   * 使用技能的那个回合里：只要落下的这颗子形成**两连**就能直接发起攻击，
   * 并且这一击**免疫对手的反击伤害**。换手时随"仅本回合有效"的效果一起清掉。
   *
   * 注意：最初的「下一颗棋子落下时长满魔力植物」已经按需求去掉（bugv11 追加 #2），
   * 这个技能现在只做"两连即可攻击 + 免反击"。
   */
  twinStar: [boolean, boolean] = [false, false]
  /**
   * 每个技能已经释放过几次（bugv11 #6：`freeFirst` 的技能只有第一次免费）。
   *
   * 用绝对次数而不是"冷却是否为 0"来判断——冷却门槛可以被存档 / 重连改写成任意值，
   * 只有这个计数器才真正表示"用过没有"。
   */
  skillCasts: [number[], number[]] = [[], []]
  /** 烈焰：格子 -> 还能烧几个**半回合**（每次换手 -1，所以 2 = 双方各走一步 = 1 回合）。 */
  flames = new Map<number, number>()
  /**
   * 烈焰的**主人**（bugv14）：谁放的火球就算谁的。
   *
   * 规则：**主人自己的棋子可以走在自己的烈焰上**（不碎裂，改为受 1 点伤害）；
   * 其他人的棋子落上去照样碎裂。`flames` 与 `flameOwner` 必须严格同步
   * （只有 `castFireball` 写入、`tickFlames` 清理、`loadScenario` 恢复这三处）。
   */
  flameOwner = new Map<number, PlayerIndex>()
  /** 叠在敌方棋子上的额外棋子：格子 -> 叠子的一方（毒鸡蛋，不顶替原棋子）。 */
  overlay = new Map<number, PlayerIndex>()

  private readonly rng: Rng
  private readonly initialHp: number
  private draft: AttackDraft | null = null
  private events: GameEvent[] = []
  /** 供 UI 使用：最近一次连珠摘要。 */
  lastMatch: { player: PlayerIndex; summary: MatchSummary } | null = null

  constructor(options: GameEngineOptions = {}) {
    this.rng = new Rng(options.seed ?? ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0))
    this.initialHp = options.initialHp ?? INITIAL_HP
    this.hp = [this.initialHp, this.initialHp]
    this.magicConfig = resolveMagicConfig(options.magic)
    this.magicCooldown = this.magicConfig.cooldownTurns
    this.nightConfig = resolveNightConfig(options.night)
    // 角色技能：默认开局所有技能都处于冷却中（bugv9 #13）；
    // bugv11 #6：标了 `startReady` 的技能（恶龙吐息）一上来就能用
    this.skills = [options.skills?.[0] ?? [], options.skills?.[1] ?? []]
    this.skillReadyAt = [this.initialReadyAt(0), this.initialReadyAt(1)]
    this.skillCasts = [this.skills[0].map(() => 0), this.skills[1].map(() => 0)]

    if (options.fixedFirstPlayer !== undefined) {
      this.firstPlayer = options.fixedFirstPlayer
      this.current = options.fixedFirstPlayer
      this.phase = 'playing'
    } else if (options.autoRoll !== false) {
      this.rollForFirst()
    }

    // bugv34 补充「黑夜开局」：开局直接进入黑夜（跳过进入条件与预告）。
    // 放在最后：此时骰子已掷、`diceRolled` / `turnStarted` 已入队，`nightFell` 排在其后。
    // 传 `true` ⇒ 天气用引擎 RNG 抽（开局局面固定，用局面派生随机会每局都一样）。
    if (this.nightConfig.enabled && this.nightConfig.startInNight) this.enterNight(true)
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  /** 开局时某个技能"可以再次使用"的行动数门槛（`startReady` 的技能开局就是 0）。 */
  private initialReadyAt(player: PlayerIndex): number[] {
    return this.skills[player].map((spec) => (spec.startReady === true ? 0 : Math.max(0, spec.cooldown)))
  }

  /** 当前是否处于「双子星」的爆发窗口（UI / 规则面板用）。 */
  isTwinStar(player: PlayerIndex): boolean {
    return this.twinStar[player]
  }

  get isOver(): boolean {
    return this.phase === 'gameOver'
  }

  /** 当前是否等待人类/AI 落子。 */
  get awaitingPlacement(): boolean {
    return this.phase === 'playing'
  }

  /** 当前是否等待防守方在攻击阶段落子。 */
  get awaitingDefense(): boolean {
    return this.phase === 'awaitingDefense'
  }

  at(row: number, col: number): number {
    if (!isInsideBoard(row, col)) return -1
    return this.board[cellId(row, col)]
  }

  isEmpty(row: number, col: number): boolean {
    return this.at(row, col) === 0
  }

  emptyCells(): number[] {
    const cells: number[] = []
    for (let i = 0; i < CELL_COUNT; i++) {
      if (this.board[i] === 0) cells.push(i)
    }
    return cells
  }

  isBoardFull(): boolean {
    for (let i = 0; i < CELL_COUNT; i++) {
      if (this.board[i] === 0) return false
    }
    return true
  }

  /** 该格是否可用于当前操作。 */
  canPlaceAt(index: number): boolean {
    if (index < 0 || index >= CELL_COUNT) return false
    if (this.phase !== 'playing' && this.phase !== 'awaitingDefense') return false
    if (this.board[index] === 0) return !this.overlay.has(index)
    // 敌方棋子：只有在「毒鸡蛋」生效的当前回合才能叠子（bugv10 #9）
    return this.canStackAt(index)
  }

  /**
   * 该格现在能不能叠子（bugv10 #9 毒鸡蛋）。
   *
   * 条件：当前回合轮到的一方有「毒鸡蛋」生效、这一格是**敌方**棋子、且还没有被叠过。
   */
  canStackAt(index: number): boolean {
    if (this.phase !== 'playing') return false
    if (index < 0 || index >= CELL_COUNT) return false
    const player = this.current
    if (!this.sabotage[player]) return false
    const cell = this.board[index]
    if (cell === 0 || cell === cellOf(player)) return false
    return !this.overlay.has(index)
  }

  /**
   * 「毒鸡蛋」可以叠子的位置：只有**能形成连珠**的敌方棋子才算合法（bugv10 #9）。
   *
   * 需求原文："可在敌方棋子处下子(必须可以形成连珠 如不能形成连珠则提示用户…)"。
   *
   * 注意：这里**不检查** `sabotage` 标记 —— 它同时也是"技能能不能用"的判据
   * （技能还没释放时标记还是 false，检查它就永远用不了了）。
   */
  sabotageTargets(player: PlayerIndex = this.current): number[] {
    const out: number[] = []
    for (let index = 0; index < CELL_COUNT; index++) {
      const cell = this.board[index]
      if (cell === 0 || cell === cellOf(player) || this.overlay.has(index)) continue
      const probe = new Map(this.overlay)
      probe.set(index, player)
      const summary = summarizeMatch(this.board, player, probe)
      if (summary.lines.some((line) => line.cells.includes(index))) out.push(index)
    }
    return out
  }

  /** 某玩家在棋盘上的实体棋子（含叠子），供表现层与联机同步使用。 */
  stonesOf(player: PlayerIndex): number[] {
    const cells: number[] = []
    for (let index = 0; index < CELL_COUNT; index++) {
      if (this.board[index] === cellOf(player)) cells.push(index)
    }
    for (const [cell, owner] of this.overlay) {
      if (owner === player && !cells.includes(cell)) cells.push(cell)
    }
    return cells.sort((a, b) => a - b)
  }

  takeEvents(): GameEvent[] {
    const out = this.events
    this.events = []
    return out
  }

  private emit(event: GameEvent): void {
    this.events.push(event)
  }

  // -------------------------------------------------------------------------
  // 开局
  // -------------------------------------------------------------------------

  /** 掷骰子决定先后手（规则 11.1）。 */
  rollForFirst(): readonly [number, number] {
    let a = rollDie(this.rng)
    let b = rollDie(this.rng)
    let guard = 0
    while (a === b && guard++ < 32) {
      a = rollDie(this.rng)
      b = rollDie(this.rng)
    }
    const first: PlayerIndex = a > b ? 0 : 1
    this.firstPlayer = first
    this.current = first
    this.phase = 'playing'
    this.emit({ type: 'diceRolled', first, rolls: [a, b] })
    this.emit({ type: 'turnStarted', player: first })
    return [a, b]
  }

  /** 使用指定的骰子点数开局（用于测试 / 手动指定先后手）。 */
  setFirstPlayer(first: PlayerIndex, rolls: readonly [number, number] = [6, 1]): void {
    this.firstPlayer = first
    this.current = first
    this.phase = 'playing'
    this.emit({ type: 'diceRolled', first, rolls })
    this.emit({ type: 'turnStarted', player: first })
  }

  /**
   * 载入一个局面（用于重放、存档、测试与关卡构造）。
   *
   * @param board 棋盘数组（缺省为当前棋盘）
   * @param ctx   当前局面上下文
   */
  loadScenario(
    board: Board,
    ctx: {
      hp?: readonly [number, number]
      phase?: MatchPhase
      current?: PlayerIndex
      firstPlayer?: PlayerIndex
      attacker?: PlayerIndex
      /**
       * 攻击阶段的高光权重（bugv6 #8）：断线重连时棋盘上的连珠棋子已经被移除，
       * 重新 `summarizeMatch()` 是算不出高光的，因此允许直接从存档恢复。
       */
      highlights?: ReadonlyMap<number, number>
      /** 连珠总长（仅用于结算面板展示）。 */
      lineLengthSum?: number
      /**
       * 攻击快照（bugv25）：回放/重连时**直接**恢复攻击上下文，不再按高光格数反推。
       *
       * 反推会丢掉魔力植物加伤、「小一哥」增伤，以及「最不绕弯子」的 baseDamage
       * （它没有连珠棋子，反推出来是 0）—— 这正是"回放总攻击数显示 0"的根因。
       */
      attackSnapshot?: AttackSnapshot
      /** 魔力植物（bugv8 #4）：断线重连 / 回放要能把它们一起恢复。 */
      magic?: ReadonlyArray<MagicPlant>
      /** 已经长出过几次（影响后续单次数量）。 */
      magicGrowths?: number
      /** 距离下次生长还剩几回合。 */
      magicCooldown?: number
      /** 是否已经出现过连珠。 */
      magicLineSeen?: boolean
      /** 护盾（bugv9 #13：回放 / 重连要能把护盾一起恢复）。 */
      shield?: readonly [number, number]
      /** 剩余"连续行动"次数。 */
      bonusActions?: readonly [number, number]
      /** 各方已行动次数（冷却基准）。 */
      actionsTaken?: readonly [number, number]
      /** 各技能可再次使用的门槛。 */
      skillReadyAt?: readonly [readonly number[], readonly number[]]
      /** 各方最近一颗棋子的位置。 */
      lastPlacedBy?: readonly [number | null, number | null]
      /** 回合序号（bugv10 #9）。 */
      turnNo?: number
      /** 无敌持续到第几回合。 */
      immuneUntil?: readonly [number, number]
      /** 额外攻击值。 */
      powerBonus?: readonly [number, number]
      /** 增伤持续到第几回合（bugv12 #2：「小一哥」持续 2 回合）。 */
      powerUntil?: readonly [number, number]
      /** 本回合是否可以在敌方棋子上落子。 */
      sabotage?: readonly [boolean, boolean]
      /** 本回合因毒鸡蛋获得的额外伤害（bugv12 #3）。 */
      sabotageBonus?: readonly [number, number]
      /** 「双子星」的爆发窗口（bugv11 #5）。 */
      twinStar?: readonly [boolean, boolean]
      /** 下次释放双子星是否**消耗 -1**（bugv12 #3 的条件奖励，bugv14 改成减费）。 */
      bloomCheaperNext?: readonly [boolean, boolean]
      /** 各技能已经释放过几次（bugv11 #6：首次免费）。 */
      skillCasts?: readonly [readonly number[], readonly number[]]
      /** 临时护甲与到期回合（bugv14）。 */
      tempArmor?: readonly [number, number]
      tempArmorUntil?: readonly [number, number]
      /** 「深度思考」的额外攻击值与到期回合（bugv14）。 */
      strikeBonus?: readonly [number, number]
      strikeUntil?: readonly [number, number]
      /** 「播种」窗口（bugv14）。 */
      seedGrow?: readonly [boolean, boolean]
      /** 「本地部署」窗口与它的伤害加成（bugv34m）。 */
      deploy?: readonly [boolean, boolean]
      deployBonus?: readonly [number, number]
      /** 「小千问」待重新部署的棋子（编码值，bugv34m）。 */
      redeployPending?: readonly [readonly number[], readonly number[]]
      /** 「杀鲸霸拳」低消耗档：本回合植物不加伤（bugv19）。 */
      noPlantBonus?: readonly [boolean, boolean]
      /** 棋盘上的烈焰：格子 -> 剩余回合。 */
      flames?: ReadonlyMap<number, number> | ReadonlyArray<readonly [number, number]>
      /** 烈焰归属（bugv14）：格子 -> 主人。 */
      flameOwner?: ReadonlyMap<number, number> | ReadonlyArray<readonly [number, number]>
      /** 叠在敌方棋子上的额外棋子。 */
      overlay?: ReadonlyMap<number, number> | ReadonlyArray<readonly [number, number]>
      /** 黑夜阶段（bugv34）。 */
      nightPhase?: NightPhase
      /** 预告剩余回合（bugv34）。 */
      nightCountdown?: number
      /** 黑夜已持续回合（bugv34）。 */
      nightTurns?: number
      /** 距上次黑夜结束的回合数（bugv34）。 */
      turnsSinceNight?: number
      /** 当前天气（bugv34）。 */
      weather?: WeatherId | null
      /** 双方发起过的攻击棋子数（bugv34）。 */
      attacksLaunched?: readonly [number, number]
      /** 本次黑夜开始时的攻击棋子快照（bugv34）。 */
      nightAttackBase?: readonly [number, number]
      /** 当前这次黑夜是否由「黑夜开局」触发（bugv34d，仅回放恢复用）。 */
      nightFromStart?: boolean
    } = {},
  ): void {
    this.board = cloneBoard(board)
    if (ctx.hp) this.hp = [ctx.hp[0], ctx.hp[1]]
    if (ctx.firstPlayer !== undefined) this.firstPlayer = ctx.firstPlayer

    this.shield = ctx.shield ? [ctx.shield[0], ctx.shield[1]] : [0, 0]
    this.bonusActions = ctx.bonusActions ? [ctx.bonusActions[0], ctx.bonusActions[1]] : [0, 0]
    this.actionsTaken = ctx.actionsTaken ? [ctx.actionsTaken[0], ctx.actionsTaken[1]] : [0, 0]
    this.skillReadyAt = ctx.skillReadyAt
      ? [[...ctx.skillReadyAt[0]], [...ctx.skillReadyAt[1]]]
      : [this.initialReadyAt(0), this.initialReadyAt(1)]
    this.skillCasts = ctx.skillCasts
      ? [[...ctx.skillCasts[0]], [...ctx.skillCasts[1]]]
      : [this.skills[0].map(() => 0), this.skills[1].map(() => 0)]
    this.lastPlacedBy = ctx.lastPlacedBy ? [ctx.lastPlacedBy[0], ctx.lastPlacedBy[1]] : [null, null]

    // bugv10 #9：技能造成的持续状态也要能恢复（联机 sync / 回放跳步）
    this.turnNo = ctx.turnNo ?? 0
    this.immuneUntil = ctx.immuneUntil ? [ctx.immuneUntil[0], ctx.immuneUntil[1]] : [0, 0]
    this.powerBonus = ctx.powerBonus ? [ctx.powerBonus[0], ctx.powerBonus[1]] : [0, 0]
    this.powerUntil = ctx.powerUntil ? [ctx.powerUntil[0], ctx.powerUntil[1]] : [0, 0]
    this.sabotage = ctx.sabotage ? [ctx.sabotage[0], ctx.sabotage[1]] : [false, false]
    this.sabotageBonus = ctx.sabotageBonus ? [ctx.sabotageBonus[0], ctx.sabotageBonus[1]] : [0, 0]
    this.twinStar = ctx.twinStar ? [ctx.twinStar[0], ctx.twinStar[1]] : [false, false]
    this.bloomCheaperNext = ctx.bloomCheaperNext ? [ctx.bloomCheaperNext[0], ctx.bloomCheaperNext[1]] : [false, false]
    this.tempArmor = ctx.tempArmor ? [ctx.tempArmor[0], ctx.tempArmor[1]] : [0, 0]
    this.tempArmorUntil = ctx.tempArmorUntil ? [ctx.tempArmorUntil[0], ctx.tempArmorUntil[1]] : [0, 0]
    this.strikeBonus = ctx.strikeBonus ? [ctx.strikeBonus[0], ctx.strikeBonus[1]] : [0, 0]
    this.strikeUntil = ctx.strikeUntil ? [ctx.strikeUntil[0], ctx.strikeUntil[1]] : [0, 0]
    this.seedGrow = ctx.seedGrow ? [ctx.seedGrow[0], ctx.seedGrow[1]] : [false, false]
    this.noPlantBonus = ctx.noPlantBonus ? [ctx.noPlantBonus[0], ctx.noPlantBonus[1]] : [false, false]
    // bugv34m：Qwen 的两个技能状态（联机 sync / 回放都要恢复）
    this.deploy = ctx.deploy ? [ctx.deploy[0], ctx.deploy[1]] : [false, false]
    this.deployBonus = ctx.deployBonus ? [ctx.deployBonus[0], ctx.deployBonus[1]] : [0, 0]
    this.redeployPending = ctx.redeployPending
      ? [[...ctx.redeployPending[0]], [...ctx.redeployPending[1]]]
      : [[], []]
    this.flames = toNumberMap(ctx.flames)
    this.flameOwner = toNumberMap(ctx.flameOwner) as Map<number, PlayerIndex>
    // 烈焰归属必须与烈焰严格同步：老存档 / 只传 flames 的调用方一律按"0 号位所有"回落
    for (const cell of this.flames.keys()) {
      if (!this.flameOwner.has(cell)) this.flameOwner.set(cell, 0)
    }
    for (const cell of [...this.flameOwner.keys()]) {
      if (!this.flames.has(cell)) this.flameOwner.delete(cell)
    }
    this.overlay = toNumberMap(ctx.overlay) as Map<number, PlayerIndex>

    this.magic = new Map((ctx.magic ?? []).map((plant) => [plant.cell, { ...plant }]))
    this.magicGrowths = ctx.magicGrowths ?? 0
    this.magicCooldown = ctx.magicCooldown ?? this.magicConfig.cooldownTurns
    this.magicLineSeen = ctx.magicLineSeen ?? false

    // bugv34：黑夜 / 天气状态（联机 sync、回放、重连都要恢复）
    this.nightPhase = ctx.nightPhase ?? 'none'
    this.nightCountdown = ctx.nightCountdown ?? 0
    this.nightTurns = ctx.nightTurns ?? 0
    this.turnsSinceNight = ctx.turnsSinceNight ?? 999
    this.weather = ctx.weather ?? null
    this.attacksLaunched = ctx.attacksLaunched ? [ctx.attacksLaunched[0], ctx.attacksLaunched[1]] : [0, 0]
    this.nightAttackBase = ctx.nightAttackBase
      ? [ctx.nightAttackBase[0], ctx.nightAttackBase[1]]
      : [0, 0]
    this.nightFromStart = ctx.nightFromStart ?? false

    const phase = ctx.phase ?? 'playing'
    this.phase = phase
    this.current = ctx.current ?? ctx.firstPlayer ?? this.firstPlayer ?? 0
    this.events = []
    this.result = null
    this.attack = null
    this.draft = null

    if (phase === 'awaitingDefense') {
      const attacker = ctx.attacker ?? 0
      if (ctx.highlights && ctx.highlights.size > 0) {
        this.restoreAttack(attacker, ctx.highlights, ctx.lineLengthSum ?? 0)
      } else if (ctx.attackSnapshot) {
        // 无高光格也能恢复攻击上下文（bugv25「最不绕弯子」）：它的攻击没有连珠棋子，
        // `summarizeMatch()` 算出来是空的，只能靠存档里那份快照。
        this.highlights = new Map()
        this.highlightOwner = attacker
      } else {
        this.declareAttack(attacker, summarizeMatch(this.board, attacker))
      }
      /**
       * bugv25：**用存档里的快照覆盖**刚重建出来的那一个。
       *
       * 重建（`restoreAttack`）只能按"高光格数"反推攻击值，会丢掉
       * ①魔力植物加伤（宣告时棋子连植物一起被删了，重算必为 0）
       * ②「小一哥」的增伤 ③「最不绕弯子」的 baseDamage（它压根没有高光格）。
       * 回放的悬浮"总攻击数"因此会显示成错的（常见是 0）。
       */
      if (ctx.attackSnapshot) this.attack = { ...ctx.attackSnapshot }
    } else {
      this.highlights = new Map()
      this.highlightOwner = null
    }
  }

  // -------------------------------------------------------------------------
  // 主流程
  // -------------------------------------------------------------------------

  /**
   * 普通回合落子（规则 3）。
   * 返回本次操作产生的语义事件序列。
   *
   * bugv10 #4：使用「杀鲸霸拳」之后同一个回合可以连下两颗子，
   * **两颗都下完**才进入攻击阶段（第一颗即使成线也不进入攻击阶段）。
   * bugv10 #9：落在烈焰上的棋子会直接碎裂（行动作废）。
   */
  commit(index: number): GameEvent[] {
    if (this.phase !== 'playing') {
      throw new Error(`commit() 仅可在 playing 阶段调用，当前为 ${this.phase}`)
    }
    const player = this.current
    const occupied = this.board[index] !== 0
    if (occupied && !this.canStackAt(index)) {
      throw new Error(`位置 ${index} 已有棋子`)
    }

    // 烈焰（bugv10 #9 恶龙吐息）：棋子还没形成连珠就被烧裂，这一手作废。
    // bugv14：**这批烈焰的主人**可以走在自己的火上 —— 不碎裂，改为受 1 点伤害。
    const onOwnFlame = this.flames.has(index) && this.flameOwner.get(index) === player
    if (this.flames.has(index) && !onOwnFlame) {
      this.actionsTaken[player] += 1
      this.emit({ type: 'stoneShattered', player, cell: index, reason: 'flame' })
      this.endTurnAfterAction(player)
      return this.takeEvents()
    }

    this.lineCutDone = false
    this.place(index, player)
    this.actionsTaken[player] += 1
    this.emit({ type: 'stonePlaced', player, cell: index, stacked: occupied ? true : undefined })
    this.moveCount.value += 1

    // bugv14：走火 —— 棋子站住了，但这一方要扣 1 点（临时护甲 / 护盾先吸收）
    if (onOwnFlame) {
      const beforeHp = this.hp[player]
      this.applyDamage(player, FLAME_WALK_DAMAGE)
      this.emit({ type: 'flameWalked', player, cell: index, damage: beforeHp - this.hp[player] })
      const dead = this.detectResult()
      if (dead) {
        this.phase = 'gameOver'
        this.result = dead
        this.emit({ type: 'gameOver', result: dead })
        return this.takeEvents()
      }
    }

    const summary = summarizeMatch(this.board, player, this.overlay)
    if (summary.lines.length > 0) this.noteMatch(player, summary)
    // 「双子星」的两连窗口（bugv11 #5）—— 这里只做**判定**，实际宣告仍在下面按原顺序进行
    const twin = this.twinStarSummary(player, index)

    // bugv14「播种」：落子**未成连珠** → 在落点周围长出魔力植物（本回合只触发一次）
    // bugv34m「本地部署」：同样只在未成连珠时触发，但只长**落点这一格**
    if (summary.lines.length === 0 && twin === null) {
      this.triggerSeedGrow(player, index)
      this.triggerLocalDeploy(player, index)
    }

    // bugv10 #4：本回合还能再下一颗子 —— 即使这一颗已经成线，也**先不进入攻击阶段**
    // （防守方此时还不能下子反击；两颗都下完之后再按最终局面结算）
    if (this.bonusActions[player] > 0) {
      this.bonusActions[player] -= 1
      this.emit({ type: 'bonusActionsChanged', player, to: this.bonusActions[player] })
      this.beginTurn(player)
      this.tickMagic()
      return this.takeEvents()
    }

    if (summary.lines.length > 0) {
      // 形成连珠：成为攻击方，进入攻击阶段
      // bugv34m「小千问」：这一手成了连珠 → 待重新部署的棋子作废（就是真没了）
      this.discardRedeploy(player)
      this.deploy[player] = false
      this.declareAttack(player, summary)
      return this.takeEvents()
    }

    // bugv11 #5「双子星」：本回合只要落下的这颗子形成**两连**，就直接发起攻击
    if (twin) {
      this.discardRedeploy(player)
      this.deploy[player] = false
      this.noteMatch(player, twin)
      this.declareAttack(player, twin)
      return this.takeEvents()
    }

    // bugv34m「小千问」：本回合落子**未成连珠** → 重新部署之前移除的棋子（必须赶在换手之前）
    this.resolveRedeploy(player, index)

    // 未形成连珠：交换回合
    this.finishTurn(player)
    return this.takeEvents()
  }

  /**
   * 「双子星」的两连判定（bugv11 #5）。
   *
   * 只认**包含刚落下的这一格**的两连（别的方向上早就有两颗子不算），
   * 所以放完技能随便下一手是不会白打出一次攻击的。
   */
  private twinStarSummary(player: PlayerIndex, cell: number): MatchSummary | null {
    if (!this.twinStar[player]) return null
    const quick = summarizeMatch(this.board, player, this.overlay, TWIN_STAR_LINE_LENGTH)
    const lines = quick.lines.filter((line) => line.cells.includes(cell))
    return lines.length > 0 ? summaryOfLines(lines) : null
  }

  /**
   * 攻击阶段防守方落子（规则 4.2 / 6）。
   *
   * bugv10 #9：落在烈焰上同样会碎裂 —— 这一手没有落成任何棋子，
   * 因此防守方没有连珠可抵消（等于硬吃这一击）。
   * bugv14：但**这批烈焰的主人**可以走在自己的火上 —— 棋子留下（能成线抵消），
   * 代价是受 1 点伤害。
   */
  defend(index: number): GameEvent[] {
    if (this.phase !== 'awaitingDefense') {
      throw new Error(`defend() 仅可在 awaitingDefense 阶段调用，当前为 ${this.phase}`)
    }
    if (this.board[index] !== 0) {
      throw new Error(`位置 ${index} 已有棋子`)
    }
    const draft = this.draft
    if (!draft) throw new Error('缺少攻击阶段上下文')

    const defender = other(draft.attacker)
    const onOwnFlame = this.flames.has(index) && this.flameOwner.get(index) === defender

    // 落在烈焰上：棋子碎裂，不能抵消（bugv10 #9）
    if (this.flames.has(index) && !onOwnFlame) {
      this.actionsTaken[defender] += 1
      this.emit({ type: 'stoneShattered', player: defender, cell: index, reason: 'flame' })
      draft.defenseCell = index
      draft.weakness = 0
      draft.stolenPlants = 0
      // ⚠️ bugv17 #4：**不能**再按当前棋盘重算植物加伤 —— 那些植物在宣告攻击时
      // 就已经随棋子一起删掉了，重算会把它算成 0（等于凭空吃掉这一击的加伤）。
      // 加伤用 `setupAttack()` 锁定的快照。
      draft.finalAttack = this.attackValue(draft, 0)
      draft.defenderLines = []
      draft.defenderCells = []
      draft.defenderPlantCells = []
      draft.defenderAttack = 0
      draft.defenderCombatBase = 0
      draft.plagueSplit = 0
      this.emit({
        type: 'defenderPlaced',
        player: defender,
        cell: index,
        weakened: 0,
        finalAttack: draft.finalAttack,
        defenderAttack: 0,
        shattered: true,
      })
      // bugv18 #1：棋子被烧碎 → 没有抢夺这一步，参与本次连珠的植物直接随它一起消失
      // bugv34c「暴雪」：其中**被冻结**的那些会在之后原地重生一棵（非冻结），即"解冻"
      draft.thawCells = this.frozenLineCells(draft.attackerPlantCells)
      this.clearMagicAt([...draft.cells])
      this.resolveAttack(draft)
      return this.takeEvents()
    }

    this.place(index, defender)
    this.actionsTaken[defender] += 1
    this.moveCount.value += 1
    draft.defenseCell = index
    draft.weakness = draft.weights.get(index) ?? 0
    // bugv14：走自己的火 —— 防守棋子站住了，但要先扣 1 点（护甲 / 护盾先吸收）
    const flameHpBefore = this.hp[defender]
    if (onOwnFlame) this.applyDamage(defender, FLAME_WALK_DAMAGE)
    // bugv18 #5：这 1 点若把血条打空 → **立刻死亡**，不管有没有形成连珠（也就没有反击）
    const flameDeath = onOwnFlame ? this.detectResult() : null

    // bugv8 #4（bugv18 #1 恢复）：防守方落在攻击方连珠的植物格上 → 把这棵植物抢过来。
    // 被抢走的那棵**不再给攻击方加伤**，转而计入防守方自己的攻击值。
    const stolenHere = draft.attackerPlantCells.includes(index) ? 1 : 0
    draft.stolenPlants = stolenHere
    draft.attackerPlantCells = plantsOnCells(this.magic, draft.cells, draft.attacker)
    draft.finalAttack = this.attackValue(draft, draft.weakness)

    const defenseSummary = summarizeMatch(this.board, defender, this.overlay)
    draft.defenderLines = defenseSummary.lines
    draft.defenderCells = defenseSummary.cells
    draft.defenderPlantCells = plantsOnCells(this.magic, defenseSummary.cells, defender)
    // bugv34m「本地部署」被动：连珠上的植物计数必须**现在就取好** ——
    // 下面 `clearMagicAt()` 会把连珠上的植物全部删掉，之后再数永远是 0。
    let defenseLinePlants = 0
    for (const cell of defenseSummary.cells) if (this.magic.has(cell)) defenseLinePlants += 1
    // ⚠️ 防守方的植物加伤同样走 `magicPlantBonus()` —— 这样「枯竭 / 暴雪 / 杀鲸霸拳」
    // 对防守方的反击值也一视同仁（以前这里写死 `棵数 × damagePerPlant`，天气会漏掉防守方）。
    // bugv34d：把"与天气无关的部分"单独记下来，`buildSnapshot()` 才能反推出天气给防守方的净增减伤。
    draft.defenderCombatBase = defenseSummary.uniqueCount + this.powerBonus[defender] + this.sabotageBonus[defender]
    draft.defenderAttack = draft.defenderCombatBase + this.magicPlantBonus(defender, draft.defenderPlantCells)
    // bugv34「干涸」：**防守方形成连珠反击时同样 −1**（用户口径：双方在攻击阶段伤害 −1）。
    // ⚠️ 表现**不在这里发**：防守方的棋子这时还没飞上舞台，此刻发"碎一颗"的事件会在
    // **空舞台上凭空碎一颗**（用户实测反馈的"虚空播放一次棋子消失"，bugv34d 已去掉）。
    // 现在统一交给"悬浮棋子数量对齐"（`reconcileStage` 的 surplus 碎裂）——
    // 它发生在棋子飞上舞台**之后**，观感就是"N 颗里碎了 1 颗"。
    if (this.weather === 'drought' && defenseSummary.lines.length > 0) {
      draft.defenderAttack = Math.max(1, draft.defenderAttack - 1)
    }
    // bugv34「瘟疫」：连珠上带魔力植物的攻击棋子**分裂成两颗、双方各得一颗**
    // （Weather.md：「连珠后魔力植物会为双方提供伤害加成」）。**对两边都生效**：
    //   ① 攻击方连珠上的植物 → 防守方再补等量棋子（宣告时已给过初值，这里按抢夺结果重算）；
    //   ② 防守方连珠上的植物 → 给攻击方补等量棋子（防守方成线反击时触发）。
    draft.plagueSplit = 0
    if (this.weather === 'plague') {
      const toDefender = this.magicPlantBonus(draft.attacker, draft.attackerPlantCells)
      if (toDefender > 0) {
        draft.plagueSplit = toDefender
        draft.defenderAttack += toDefender
      }
      const toAttacker = this.magicPlantBonus(defender, draft.defenderPlantCells)
      if (toAttacker > 0) {
        draft.finalAttack += toAttacker
        for (const cell of draft.defenderPlantCells) {
          this.emit({ type: 'attackStoneSplit', player: defender, cell, to: draft.attacker })
        }
      }
    }

    // 表现层靠这两个数字把悬浮棋子的数量对齐（bugv9 #6）
    this.emit({
      type: 'defenderPlaced',
      player: defender,
      cell: index,
      weakened: draft.weakness,
      finalAttack: draft.finalAttack,
      defenderAttack: draft.defenderAttack,
    })
    if (onOwnFlame) {
      this.emit({ type: 'flameWalked', player: defender, cell: index, damage: flameHpBefore - this.hp[defender] })
    }

    // bugv9 #2 + bugv18 #1：防守方**落子之后**（抢夺窗口关闭），参与本次连珠的植物才消失。
    // 这正是"植物随被破坏的棋子一起消失"的执行时刻 —— 只是要等防守方先把能抢的抢完。
    // bugv34c「暴雪」解冻（用户口径）：连珠上**被冻结**的植物消失后，要在**原地**重新长出
    // 一棵**非冻结**的植物。这里先登记格子（必须按"冻结 = 0"算完攻击值再登记），
    // 真正的重生放到 `resolveAttack` 的最后 —— 那时防守方的棋子也已飞走，格子归属才是终态。
    draft.thawCells = this.frozenLineCells([...draft.attackerPlantCells, ...draft.defenderPlantCells])
    this.clearMagicAt([...draft.cells, ...draft.defenderCells])

    if (flameDeath) {
      this.phase = 'gameOver'
      this.result = flameDeath
      this.emit({ type: 'gameOver', result: flameDeath })
      return this.takeEvents()
    }

    if (defenseSummary.lines.length > 0) {
      this.noteMatch(defender, defenseSummary, defenseLinePlants)
    }

    this.resolveAttack(draft)
    return this.takeEvents()
  }

  /** 当前阶段可落子的位置（用于 UI 提示与 AI）。 */
  legalMoves(): number[] {
    return this.emptyCells()
  }

  // -------------------------------------------------------------------------
  // 回合推进（bugv10 #9）
  // -------------------------------------------------------------------------

  /**
   * 落子之后推进回合（棋子碎裂时用：这一手什么都没落成）。
   *
   * 还有连击数 → 留在同一个角色手上（bugv10 #4：连下两颗子），否则换手。
   */
  private endTurnAfterAction(player: PlayerIndex): void {
    if (this.bonusActions[player] > 0) {
      this.bonusActions[player] -= 1
      this.emit({ type: 'bonusActionsChanged', player, to: this.bonusActions[player] })
      this.beginTurn(player)
      this.tickMagic()
      return
    }
    this.finishTurn(player)
  }

  /** 正常换手：开启对手的回合、推进魔力植物与烈焰、检查棋盘下满。 */
  private finishTurn(player: PlayerIndex): void {
    // bugv34c「旱雷」：在"这一方落子后、对手回合开始前"结算一次天气
    this.afterAction(player)
    this.beginTurn(other(player))
    this.tickMagic()
    this.tickFlames()
    this.checkFullBoard()
  }

  /**
   * 开启一个新回合：回合序号 +1、结算无敌到期、"仅本回合"的效果清空。
   *
   * 注意：只清**上一个行动方**（`other(player)`）的回合内效果，
   * 因为轮到 `player` 时，他刚获得的效果（例如小一哥）必须继续有效。
   */
  private beginTurn(player: PlayerIndex): void {
    this.turnNo += 1
    this.expireImmunity()
    this.expireTempArmor()
    this.clearTurnEffects(other(player))
    this.current = player
    this.emit({ type: 'turnStarted', player })
    // bugv34：每个回合推进黑夜状态机（预告 / 降临 / 天亮）
    this.evaluateNight()
  }

  // ---------------------------------------------------------------------------
  // 黑夜机制（bugv34，规格见 Weather.md）
  // 「回合」的计数单位 = `turnNo`（每次换手 +1，即"一方走一步"）。
  // ---------------------------------------------------------------------------

  /**
   * 推进黑夜状态机。
   *
   * - `none`（白天）：累加"距上次黑夜"计数；满足进入条件 → 转入 `pending`（预告）。
   * - `pending`（预告）：**不因条件不再满足而终止**，倒数到 0 → 降临。
   * - `active`（黑夜）：累加持续回合；满足退出条件 → 天亮。
   */
  private evaluateNight(): void {
    const cfg = this.nightConfig
    if (!cfg.enabled) return

    if (this.nightPhase === 'active') {
      this.nightTurns += 1
      const attacksInNight = this.nightAttackDelta()
      const unowned = this.unownedPlantCount()
      // 条件 A（同时满足）：持续 ≥ exitTurnsA 且期间攻击 ≥ exitAttacksA
      const exitPair = this.nightTurns >= cfg.exitTurnsA && attacksInNight >= cfg.exitAttacksA
      // 条件 B（满足其一即退）：持续 > exitTurnsB / 攻击 > exitAttacksB / 场上植物都已被占有
      // ⚠️ 「没有无主植物」必须**场上至少有植物**才算数：否则开局（0 棵）或干涸期间（不长植物）
      // 会立刻判定为"没有无主植物"而秒退黑夜（bugv34 补充修）。
      // ⚠️ bugv34d：「黑夜开局」的**首个黑夜**连这一条也不判（用户要求）——
      // 否则开局就是 0 棵植物，测得到"无主 = 0"⇒ 第一回合就天亮，黑夜等于没有。
      const openingNight = this.isOpeningNight()
      const exitDirect =
        this.nightTurns > cfg.exitTurnsB ||
        attacksInNight > cfg.exitAttacksB ||
        (!openingNight && this.magic.size > 0 && unowned === 0)
      if (exitPair || exitDirect) {
        // 「雷暴」结束时，场上所有污染体（无论是否被占有）变回普通魔力植物（bugv34 补充）
        if (this.weather === 'thunder') this.revertPollution()
        // 「暴雪」结束时，场上所有冻结的植物解冻（bugv34c）
        if (this.weather === 'blizzard') this.revertFrozen()
        this.nightPhase = 'none'
        this.weather = null
        this.nightTurns = 0
        this.nightFromStart = false
        this.turnsSinceNight = 0
        this.emit({ type: 'nightEnded' })
      }
      return
    }

    if (this.nightPhase === 'pending') {
      this.nightCountdown -= 1
      if (this.nightCountdown <= 0) this.enterNight()
      return
    }

    this.turnsSinceNight += 1
    if (!this.nightEntryReady()) return
    this.nightPhase = 'pending'
    this.nightCountdown = cfg.warnTurns
    this.emit({ type: 'nightPending', countdown: this.nightCountdown })
  }

  /**
   * 黑夜进入条件（必须全部满足）：
   * ① 开局后至少一方连珠过；② 距上次黑夜结束 > `minGap` 回合；
   * ③ **或**：游戏开始 ≥ `startTurnThreshold` 回合 / 双方攻击棋子 > `entryAttackThreshold`；
   * ④ 场上植物（含无主与占有）> `entryPlantThreshold`。
   */
  private nightEntryReady(): boolean {
    const cfg = this.nightConfig
    if (!this.magicLineSeen) return false
    if (this.turnsSinceNight <= cfg.minGap) return false
    const turnOrAttack =
      this.turnNo >= cfg.startTurnThreshold || this.totalAttacks() > cfg.entryAttackThreshold
    if (!turnOrAttack) return false
    return this.magic.size > cfg.entryPlantThreshold
  }

  /**
   * 由当前局面派生的确定性随机数（0..1）。
   *
   * ⚠️ 联机红线：天气抽取、干涸碎裂**必须**用局面派生的随机，**不能**用 `this.rng`
   * —— 服务端引擎开局掷过骰子，`rng` 流的位置和客户端镜像引擎不同，
   * 用它会让两端抽出不同天气 / 碎不同棋子 ⇒ 每一步指纹都对不上、无限 sync。
   */
  private stateRandom(salt: string): number {
    const pick = seededRng(`${this.board.join('')}|${this.hp[0]},${this.hp[1]}|${this.moveCount.value}|${salt}`)
    return pick()
  }

  /**
   * 由当前局面派生的确定性随机数（0..1）—— **不含 `moveCount`** 的版本。
   *
   * `moveCount` 不参与联机指纹、也不会被 `loadScenario()` 恢复（重连后归零），
   * 所以拿它当随机种子在"重连之后又需要抽随机"的场景里会让两端抽到不同的结果。
   * 「小千问」的自动落子用它（AI 迷你引擎也只按"棋盘 + 血量"复刻，见 `baseline.ts`）。
   */
  private boardRandom(salt: string): number {
    return seededRng(`${this.board.join('')}|${this.hp[0]},${this.hp[1]}|${salt}`)()
  }

  /**
   * 进入黑夜：抽取天气。
   *
   * - 常规（中后期自然触发）：用**局面派生的确定性随机** `stateRandom('night')`。
   * - **「黑夜开局」（`atStart`）**：开局局面是固定的（空棋盘 / 同血量 / `moveCount = 0`）
   *   ⇒ `stateRandom` 永远返回同一个数 ⇒ 每局都是同一种天气（实测恒为「枯竭」）。
   *   所以这一档改用引擎自身的 RNG，每局不同。
   *   ⚠️ 这样做的安全性前提：**「黑夜开局」只在非联机启用**（`useConnectGame` 里联机固定传默认值）。
   *   若哪天要在联机也开它，就必须换成"两端同步过的种子"，否则两端天气会不一致。
   */
  private enterNight(atStart = false): void {
    this.nightPhase = 'active'
    this.nightTurns = 0
    this.nightFromStart = atStart
    this.nightAttackBase = [this.attacksLaunched[0], this.attacksLaunched[1]]
    const idx = atStart
      ? this.rng.int(0, WEATHERS.length - 1)
      : Math.min(WEATHERS.length - 1, Math.floor(this.stateRandom('night') * WEATHERS.length))
    this.weather = WEATHERS[idx].id
    this.emit({ type: 'nightFell', weather: this.weather })
    // 「暴雪」：降临瞬间把场上所有植物（含此后新长出的）冻结（bugv34c）
    if (this.weather === 'blizzard') this.freezeAllPlants()
  }

  /** 双方合计"发起过的攻击棋子"数。 */
  private totalAttacks(): number {
    return this.attacksLaunched[0] + this.attacksLaunched[1]
  }

  /** 本次黑夜期间双方攻击棋子的增量。 */
  private nightAttackDelta(): number {
    return this.attacksLaunched[0] - this.nightAttackBase[0] + (this.attacksLaunched[1] - this.nightAttackBase[1])
  }

  /** 场上无主植物数（"场上没有被棋子占有的魔力植物"退出条件用）。 */
  private unownedPlantCount(): number {
    let n = 0
    for (const plant of this.magic.values()) if (plant.owner === null) n += 1
    return n
  }

  /**
   * 当前是否处于「黑夜开局」的**首个黑夜**（bugv34d）。
   *
   * 这一档不去判"场上没有被棋子占有的魔力植物" —— 开局 0 棵植物必然满足该条，
   * 否则黑夜刚降临就会立刻天亮（用户实测）。
   */
  private isOpeningNight(): boolean {
    return this.nightFromStart && this.nightPhase === 'active'
  }

  /**
   * 把场上所有「污染体」变回普通魔力植物（bugv34 补充：雷暴结束时）。
   *
   * 归属**保留**（无论是否被棋子占有）。新种类由格子索引派生（确定性，联机两端一致）。
   */
  private revertPollution(): void {
    this.rekindPlants((plant) => plant.kind === 'pollution', 'thunderEnd')
  }

  /**
   * 「暴雪」降临：场上所有植物（含刚长出的）冻结（bugv34c）。
   *
   * 冻结 = `kind: 'frozen'` —— 不加伤、雪白冰晶外观。归属保留。
   */
  private freezeAllPlants(): void {
    this.rekindPlants((plant) => plant.kind !== 'frozen', 'blizzardStart')
  }

  /**
   * 「暴雪」结束：场上所有冻结的植物变回普通魔力植物（bugv34c）。
   *
   * ⚠️ 需求原文只写了"连珠后解冻"，但**不在这里统一解冻**的话，天气结束后
   * 那些没上过连珠的冻结植物会**永远**留在场上不加伤 —— 与雷暴结束时回收污染体同口径处理。
   */
  private revertFrozen(): void {
    this.rekindPlants((plant) => plant.kind === 'frozen', 'blizzardEnd')
  }

  /**
   * 把满足条件的植物换成**普通**魔力植物（新种类由格子索引派生，确定性）。
   *
   * 用于所有"天气导致的种类变更"：雷暴结束 / 暴雪降临（反向） / 暴雪结束。
   */
  private rekindPlants(match: (plant: MagicPlant) => boolean, reason: 'thunderEnd' | 'blizzardStart' | 'blizzardEnd'): void {
    const changed: Array<{ cell: number; kind: MagicKind }> = []
    const kindFor = (cell: number): MagicKind =>
      reason === 'blizzardStart' ? 'frozen' : MAGIC_KINDS[cell % MAGIC_KINDS.length]
    for (const plant of [...this.magic.values()]) {
      if (!match(plant)) continue
      const kind = kindFor(plant.cell)
      if (kind === plant.kind) continue
      this.magic.set(plant.cell, { ...plant, kind })
      changed.push({ cell: plant.cell, kind })
    }
    if (changed.length > 0) this.emit({ type: 'magicReverted', plants: changed, reason })
  }

  /** 天气决定的"新长出植物"的种类（雷暴 = 污染体，暴雪 = 冻结，其余照常）。 */
  private growthKind(fallback: MagicKind): MagicKind {
    if (this.weather === 'thunder') return 'pollution'
    if (this.weather === 'blizzard') return 'frozen'
    return fallback
  }

  /**
   * 一方**走完一步**之后的天气结算（bugv34c）。
   *
   * 目前只有「旱雷」：在每一方落子后、对手回合开始前 —— 若场上有**由他自己棋子占有**的
   * 魔力植物，随机指定一棵，闪电落在棋子上、清掉这棵植物，并在空位重新长出一棵
   * （**优先在这颗棋子的周围**）。
   */
  private afterAction(placer: PlayerIndex): void {
    if (this.weather === 'dryLightning') this.strikeOwnPlants(placer)
  }

  /** 「旱雷」：雷击 `owner` 自己占用的一棵植物，并在空位补长一棵（优先在原棋子周围）。 */
  private strikeOwnPlants(owner: PlayerIndex): void {
    const owned = [...this.magic.values()]
      .filter((plant) => plant.owner === owner)
      .sort((a, b) => a.cell - b.cell)
    if (owned.length === 0) return
    const pick = Math.min(owned.length - 1, Math.floor(this.stateRandom('dryLightning') * owned.length))
    const victim = owned[pick]
    // 表现：闪电落在被击中的那一格（3D 播"闪电从天而降"），随后这棵植物消失
    this.emit({ type: 'lightningStruck', cells: [victim.cell] })
    this.magic.delete(victim.cell)
    this.emit({ type: 'magicRemoved', cells: [victim.cell], reason: 'weather' })

    // 重新长一棵：优先在原棋子周围，没有位置就退化为任意空位（两者都按确定性随机挑）
    const empty = (cell: number): boolean => this.board[cell] === 0 && !this.magic.has(cell)
    const near = ringCells(victim.cell, this.board, 1).filter(empty)
    const anywhere: number[] = []
    for (let cell = 0; cell < this.board.length; cell += 1) if (empty(cell)) anywhere.push(cell)
    const pool = near.length > 0 ? near : anywhere
    if (pool.length === 0) return
    const idx = Math.min(pool.length - 1, Math.floor(this.stateRandom('dryLightning-spawn') * pool.length))
    const cell = pool[idx]
    const kind = this.growthKind(MAGIC_KINDS[cell % MAGIC_KINDS.length])
    const plantOwner = this.stoneOwnerAt(cell)
    this.magic.set(cell, { cell, kind, owner: plantOwner })
    this.emit({
      type: 'magicGrown',
      plants: [{ cell, kind, owner: plantOwner }],
      growth: this.magicGrowths,
      source: 'weather',
    })
  }

  /**
   * 临时护甲到期（bugv14「精密计算」）：**未用完的也一起清零**（它是"临时"的）。
   */
  private expireTempArmor(): void {
    for (const player of [0, 1] as PlayerIndex[]) {
      if (this.tempArmorUntil[player] > 0 && this.tempArmorUntil[player] <= this.turnNo) {
        const from = this.tempArmor[player]
        this.tempArmorUntil[player] = 0
        this.tempArmor[player] = 0
        if (from !== 0) this.emit({ type: 'tempArmorChanged', player, from, to: 0 })
      }
    }
  }

  /**
   * 清掉某一方**已到期**的回合内效果（伤害加成 / 敌方棋子落子 / 双子星爆发窗口）。
   *
   * bugv12 #2：「小一哥」可跨回合持续，所以增伤必须按 `powerUntil` 判断是否到期，
   * 不能无条件清 —— 否则"持续 2 回合"根本活不过第一个回合结束。
   */
  private clearTurnEffects(player: PlayerIndex): void {
    if (this.powerBonus[player] !== 0 && this.powerUntil[player] <= this.turnNo) {
      this.powerBonus[player] = 0
      this.powerUntil[player] = 0
      this.emit({ type: 'powerChanged', player, to: 0 })
    }
    if (this.sabotage[player]) {
      this.sabotage[player] = false
      this.emit({ type: 'sabotageChanged', player, active: false })
    }
    if (this.sabotageBonus[player] !== 0) {
      this.sabotageBonus[player] = 0
    }
    if (this.twinStar[player]) {
      this.twinStar[player] = false
      this.emit({ type: 'twinStarChanged', player, active: false })
    }
    // bugv14「播种」窗口只在本回合有效（没用掉就当过期）
    this.seedGrow[player] = false
    // bugv34m「本地部署」的窗口与伤害加成都只在本回合有效
    this.deploy[player] = false
    this.deployBonus[player] = 0
    // bugv34m「小千问」：回合结束时还有没结算的待部署棋子 → 直接作废（"本回合"已经过去）
    this.redeployPending[player] = []
    // bugv19「杀鲸霸拳」低消耗档的"植物不加伤"也只在本回合有效
    this.noPlantBonus[player] = false
    // bugv14「深度思考」：按 `strikeUntil` 判断到期（和 `powerUntil` 同一口径）
    if (this.strikeBonus[player] !== 0 && this.strikeUntil[player] <= this.turnNo) {
      this.strikeBonus[player] = 0
      this.strikeUntil[player] = 0
      this.emit({ type: 'strikeChanged', player, to: 0 })
    }
  }

  /** 无敌是否还生效。 */
  isImmune(player: PlayerIndex): boolean {
    return this.immuneUntil[player] > this.turnNo
  }

  /**
   * 「小一哥」是否正在生效（bugv18 #2）。
   *
   * 生效期间**不能重复释放**（用户指定）——所以技能就绪判定要额外看这一条。
   */
  powerActive(player: PlayerIndex): boolean {
    return this.powerBonus[player] !== 0 && this.powerUntil[player] > this.turnNo
  }

  /** 「力大砖飞」是否正在生效（加成还没被"首个连珠攻击"取走、且没过期）。 */
  strikeActive(player: PlayerIndex): boolean {
    return this.strikeBonus[player] > 0 && this.strikeUntil[player] > this.turnNo
  }

  /** 这一方的技能表里有没有带 `breakShield` 的 `firstStrike`（bugv30「力大砖飞」）。 */
  private strikeBreaksShield(player: PlayerIndex): boolean {
    return this.skills[player].some((spec) => spec.effect === 'firstStrike' && spec.breakShield === true)
  }

  /**
   * 当前攻击上下文是否带"破盾"（bugv30）。
   *
   * 给**对拍脚本 / 回放**用：这一位不进状态同步（`AttackSnapshot` 的字段清单不变），
   * 但迷你引擎在防守模拟里需要它才能算对护盾。
   */
  get attackBreakShield(): boolean {
    return this.draft?.breakShield ?? false
  }

  /**
   * 带 `noRepeat` 的技能，此刻是不是"效果还在生效中"（生效期间不允许重复释放）。
   *
   * bugv30：从"只认 `power`"改成通用开关 —— 效果各自按自己的到期回合字段判定。
   */
  private effectActive(player: PlayerIndex, spec: SkillSpec): boolean {
    if (spec.noRepeat !== true) return false
    if (spec.effect === 'power') return this.powerActive(player)
    if (spec.effect === 'firstStrike') return this.strikeActive(player)
    return false
  }

  /**
   * 这一方此刻是否能**完全免疫伤害**。
   *
   * - 「精密计算」的无敌（bugv10 #9）；
   * - 「双子星」的爆发窗口（bugv11 #5：免疫对手的反击伤害）。
   */
  isDamageImmune(player: PlayerIndex): boolean {
    return this.isImmune(player) || this.twinStar[player]
  }

  /** 处理无敌到期（对手的下个回合已经结束）。 */
  private expireImmunity(): void {
    for (const player of [0, 1] as PlayerIndex[]) {
      if (this.immuneUntil[player] > 0 && !this.isImmune(player)) {
        this.immuneUntil[player] = 0
        this.emit({ type: 'immuneChanged', player, active: false, until: 0 })
      }
    }
  }

  /**
   * 授予无敌。
   *
   * `amount` 决定覆盖几个回合（`turnNo + amount`）：
   * - `amount = 2`（bugv12 #2 起「精密计算」的口径）→ 覆盖当前回合与**对手的下个回合**，
   *   也就是能扛住对手一整回合的进攻，同时也能抵消自己发起攻击时挨的反击；
   * - `amount = 1` → 只覆盖当前回合（纯粹的"免疫反击"，换手即到期）。
   */
  private grantImmunity(player: PlayerIndex, turns: number): void {
    // `turns = 1` → 只覆盖当前回合（免疫反击）；`2` → 再覆盖对手的下个回合（旧的"无敌"口径）
    const until = this.turnNo + Math.max(1, turns)
    this.immuneUntil[player] = until
    this.emit({ type: 'immuneChanged', player, active: true, until })
  }

  /** 烈焰：每换手一次递减 1（内部按"半回合"存，所以双方各走一步 = 1 回合）。 */
  private tickFlames(): void {
    if (this.flames.size === 0) return
    const expired: number[] = []
    for (const [cell, left] of [...this.flames]) {
      const next = left - 1
      if (next <= 0) {
        this.flames.delete(cell)
        // bugv14：烈焰熄灭时归属一起清掉（两张表必须严格同步）
        this.flameOwner.delete(cell)
        expired.push(cell)
      } else {
        this.flames.set(cell, next)
      }
    }
    if (expired.length > 0) this.emit({ type: 'flamesCleared', cells: expired.sort((a, b) => a - b) })
    if (this.flames.size > 0) {
      this.emit({
        type: 'flamesChanged',
        cells: [...this.flames.keys()].sort((a, b) => a - b),
        // 对外一律报"还剩几回合"（半回合向上取整）
        remaining: Math.ceil(Math.max(...this.flames.values()) / 2),
      })
    }
  }

  /** 棋盘下满：按血量判定（规则 8.2）。 */
  private checkFullBoard(): void {
    if (!this.isBoardFull()) return
    const result = this.detectResult()
    if (!result) return
    this.phase = 'gameOver'
    this.result = result
    this.emit({ type: 'gameOver', result })
  }

  // -------------------------------------------------------------------------
  // 角色技能（bugv9 #13）
  // -------------------------------------------------------------------------

  /** 场上被某一方棋子占用的魔力植物（技能消耗的就是这些）。 */
  ownedPlants(player: PlayerIndex): number[] {
    const cells: number[] = []
    for (const plant of this.magic.values()) {
      if (plant.owner === player) cells.push(plant.cell)
    }
    return cells.sort((a, b) => a - b)
  }

  /** 某个技能还要行动几次才能再用。 */
  skillRemaining(player: PlayerIndex, slot: number): number {
    const readyAt = this.skillReadyAt[player][slot]
    if (readyAt === undefined) return 0
    return Math.max(0, readyAt - this.actionsTaken[player])
  }

  /**
   * 某个技能此刻实际要消耗几棵魔力植物。
   *
   * - bugv11 #6：标了 `freeFirst` 的技能**首次释放免费**（用掉之后按标称 cost 收费）。
   * - bugv14：双子星的条件奖励从"下一次免费"改成"**下一次消耗 -1**"。
   * - bugv14：可变消耗技能（`variableCost`）返回**下限**；上限见 `skillCostRange`。
   */
  skillCostNow(player: PlayerIndex, slot: number): number {
    const spec = this.skills[player][slot]
    if (!spec) return 0
    if (spec.freeFirst === true && (this.skillCasts[player][slot] ?? 0) === 0) return 0
    if (spec.variableCost) return Math.max(0, spec.variableCost.min)
    if (spec.effect === 'bloom' && this.bloomCheaperNext[player]) return Math.max(0, spec.cost - 1)
    return spec.cost
  }

  /**
   * 某个技能此刻可以消耗的植物数量区间（bugv14）。
   *
   * 非可变消耗技能返回 `[costNow, costNow]`。
   *
   * ⚠️ bugv27 #3：可变消耗技能返回的是**标称区间**（`variableCost.min ~ max`），
   * 不再按"场上还剩几棵"收缩 —— 否则植物少的时候 UI 会把「杀鲸霸拳」显示成 `2`、
   * 把「最不绕弯子」显示成 `1~2`（用户反馈"消耗要正确显示 2~3 / 1~4"）。
   * 真正可选到几棵由落子阶段的选择上限（`owned`）与引擎校验负责。
   */
  skillCostRange(player: PlayerIndex, slot: number): [number, number] {
    const spec = this.skills[player][slot]
    if (!spec) return [0, 0]
    if (!spec.variableCost) {
      const now = this.skillCostNow(player, slot)
      return [now, now]
    }
    return [Math.max(0, spec.variableCost.min), Math.max(0, spec.variableCost.max)]
  }

  /** 可变消耗技能按实际消耗算冷却；其它技能用标称冷却。 */
  private cooldownFor(spec: SkillSpec, used: number): number {
    const v = spec.variableCost
    if (v) {
      // bugv19：`flatCooldown` 的技能两个档位共用同一个冷却（杀鲸霸拳）
      if (v.flatCooldown === true || v.cooldownPerUnit <= 0) return Math.max(0, spec.cooldown)
      return Math.max(0, used) * v.cooldownPerUnit
    }
    return Math.max(0, spec.cooldown)
  }

  /** 某个技能此刻是不是"首次免费"。 */
  isFirstFree(player: PlayerIndex, slot: number): boolean {
    const spec = this.skills[player][slot]
    return spec?.freeFirst === true && (this.skillCasts[player][slot] ?? 0) === 0
  }

  /** 某个技能此刻的状态（UI 直接展示）。 */
  skillStateFor(player: PlayerIndex, slot: number): SkillState | null {
    const spec = this.skills[player][slot]
    if (!spec) return null
    const owned = this.ownedPlants(player).length
    const remaining = this.skillRemaining(player, slot)
    const costNow = this.skillCostNow(player, slot)
    const [costMin, costMax] = this.skillCostRange(player, slot)
    let reason: string | null = null
    if (this.phase !== 'playing') reason = '只能在你的落子回合使用'
    else if (this.current !== player) reason = '还没轮到你'
    else if (remaining > 0) reason = `冷却中（还要行动 ${remaining} 次）`
    // bugv18 #2 / bugv30：带 `noRepeat` 的效果还在生效时不能重复释放
    else if (this.effectActive(player, spec)) {
      reason =
        spec.effect === 'power'
          ? `增伤还在生效（剩余 ${this.powerUntil[player] - this.turnNo} 回合）`
          : `技能还在生效（剩余 ${this.strikeUntil[player] - this.turnNo} 回合）`
    } else if (owned < costNow) reason = `魔力植物不足（需要 ${costNow} 棵，场上只有 ${owned} 棵）`
    else if (spec.effect === 'sabotage' && this.sabotageTargets(player).length === 0) {
      reason = '场上没有"下上去就能连珠"的敌方棋子'
    }
    return {
      slot,
      id: spec.id,
      name: spec.name,
      cost: spec.cost,
      costNow,
      costMin: spec.variableCost ? costMin : null,
      costMax: spec.variableCost ? costMax : null,
      minCostPenalty: spec.variableCost?.minCostPenalty ?? null,
      // bugv31：可变消耗技能也可能是"首次免费"（恶龙吐息）—— 免费时统一显示"免费"，
      // 不能因为它是可变消耗就把它排除在外（那样会把免费的火球显示成 "2~3 棵"）。
      freeNow: costNow < spec.cost && !(spec.variableCost && costNow > 0),
      discountedNow: spec.effect === 'bloom' && this.bloomCheaperNext[player],
      effect: spec.effect,
      remaining,
      owned,
      ready: reason === null,
      reason,
      endsTurn: spec.endsTurn === true,
      targetsCell: spec.targetsCell === true,
      desc: spec.desc ?? '',
    }
  }

  /** 双方的技能状态（UI 一次拿全）。 */
  skillStates(): [SkillState[], SkillState[]] {
    return [
      this.skills[0].map((_, slot) => this.skillStateFor(0, slot)).filter((state): state is SkillState => state !== null),
      this.skills[1].map((_, slot) => this.skillStateFor(1, slot)).filter((state): state is SkillState => state !== null),
    ]
  }

  /**
   * 使用技能（bugv9 #13 / bugv10 #9）。
   *
   * @param cells 要消耗的魔力植物格子（必须正好 `spec.cost` 格，且都被该方棋子占着）
   * @param target 需要点选目标格的技能（恶龙吐息）的棋盘下标
   */
  useSkill(player: PlayerIndex, slot: number, cells: readonly number[], target?: number | null): GameEvent[] {
    if (this.phase !== 'playing') {
      throw new Error(`技能只能在 playing 阶段使用，当前为 ${this.phase}`)
    }
    if (this.current !== player) throw new Error('还没轮到你行动')
    const spec = this.skills[player][slot]
    if (!spec) throw new Error(`玩家 ${player} 没有第 ${slot + 1} 个技能`)
    if (this.skillRemaining(player, slot) > 0) {
      throw new Error(`${spec.name} 还在冷却中（还要行动 ${this.skillRemaining(player, slot)} 次）`)
    }
    // bugv18 #2 / bugv30：带 `noRepeat` 的效果还在生效时不能重复释放
    if (this.effectActive(player, spec)) {
      throw new Error(`${spec.name} 还在生效中，不能重复释放`)
    }
    const unique = [...new Set(cells)].sort((a, b) => a - b)
    /**
     * bugv31：可变消耗技能的**档位**。
     *
     * `freeCast` 必须在 `skillCasts` 自增**之前**算出来；
     * 首次免费释放按**下限档位**算（gtp「恶龙吐息」：免费的火球同样结束回合）。
     */
    const vcost = spec.variableCost
    const freeCast = this.isFirstFree(player, slot)
    // bugv11 #6：首次免费 —— 这时候一颗植物都不用交（也必须不交，否则等于白扣）
    // bugv14：可变消耗技能改为"自选 min~max 棵"
    if (vcost) {
      const min = Math.max(0, vcost.min)
      const max = Math.max(min, vcost.max)
      if (freeCast) {
        if (unique.length !== 0) {
          throw new Error(`${spec.name} 首次释放免费：这一手不用消耗魔力植物`)
        }
      } else if (unique.length < min || unique.length > max) {
        throw new Error(`${spec.name} 需要选择 ${min}~${max} 棵魔力植物`)
      }
    } else {
      const costNow = this.skillCostNow(player, slot)
      if (unique.length !== costNow) throw new Error(`${spec.name} 需要选择 ${costNow} 棵魔力植物`)
    }
    for (const cell of unique) {
      const plant = this.magic.get(cell)
      if (!plant || plant.owner !== player) throw new Error('只能消耗被我方棋子占用的魔力植物')
    }
    if (spec.targetsCell) {
      if (target === null || target === undefined || !isInsideBoard(Math.floor(target / BOARD_SIZE), target % BOARD_SIZE)) {
        throw new Error(`请先为${spec.name}选择一个目标位置`)
      }
    }

    for (const cell of unique) this.magic.delete(cell)
    if (unique.length > 0) this.emit({ type: 'magicConsumed', player, cells: unique })
    this.skillCasts[player][slot] = (this.skillCasts[player][slot] ?? 0) + 1
    this.skillReadyAt[player][slot] = this.actionsTaken[player] + this.cooldownFor(spec, unique.length)
    this.emit({
      type: 'skillUsed',
      player,
      slot,
      skillId: spec.id,
      skillName: spec.name,
      effect: spec.effect,
      cells: unique,
      target: spec.targetsCell ? (target ?? null) : null,
    })

    // bugv19「杀鲸霸拳」：按**下限**数量释放 → 本回合你的魔力植物不提供伤害加成
    // （选 2 棵 = 更快打出但这一手打不出植物加伤；选 3 棵照常）
    // bugv31：免费释放（`unique` 为空）按**下限档位**算
    const tier = freeCast ? Math.max(0, vcost?.min ?? 0) : unique.length
    if (vcost?.minCostPenalty === 'noPlantBonus' && tier <= Math.max(0, vcost.min)) {
      this.noPlantBonus[player] = true
    }

    switch (spec.effect) {
      case 'shield':
        this.addShield(player, Math.max(1, spec.amount))
        break
      case 'heal':
        this.healPlayer(player, Math.max(1, spec.amount))
        break
      case 'double':
        // bugv10 #4：当前回合可再下一颗子（下完两颗才进入攻击阶段）
        this.bonusActions[player] += Math.max(1, spec.amount)
        this.emit({ type: 'bonusActionsChanged', player, to: this.bonusActions[player] })
        break
      case 'bloom':
        // bugv11 追加 #2：不再长魔力植物，只点亮「双子星」爆发窗口
        // （本回合两连即可发起攻击，并且免疫对手的反击伤害）
        this.twinStar[player] = true
        // bugv14：条件奖励里的"下一次消耗 -1"被这一次用掉了
        if (this.bloomCheaperNext[player]) this.bloomCheaperNext[player] = false
        this.emit({ type: 'twinStarChanged', player, active: true })
        break
      case 'immune':
        this.grantImmunity(player, Math.max(1, spec.amount))
        break
      case 'tempArmor': {
        // bugv14「精密计算」：临时护甲，持续到**指定回合结束前**
        // bugv29：强度可取"生命上限"（`amountFromMaxHp`），持续到**自己的下个回合结束前**
        const turns = Math.max(1, spec.duration ?? 2)
        const gain = spec.amountFromMaxHp ? this.initialHp : Math.max(1, spec.amount)
        const from = this.tempArmor[player]
        this.tempArmor[player] = from + gain
        this.tempArmorUntil[player] = Math.max(this.tempArmorUntil[player], this.turnNo + turns)
        this.emit({ type: 'tempArmorChanged', player, from, to: this.tempArmor[player] })
        break
      }
      case 'firstStrike': {
        // bugv14「深度思考」：直到自己的下个回合结束前，首个连珠攻击 +N
        const turns = Math.max(1, spec.duration ?? 2)
        const from = this.strikeBonus[player]
        this.strikeBonus[player] = from + Math.max(1, spec.amount)
        this.strikeUntil[player] = Math.max(this.strikeUntil[player], this.turnNo + turns)
        this.emit({ type: 'strikeChanged', player, to: this.strikeBonus[player] })
        break
      }
      case 'seedGrow':
        // bugv14「播种」：本回合落子若**未成连珠**，在落点周围 1 格长出魔力植物
        this.seedGrow[player] = true
        break
      case 'localDeploy':
        // bugv34m「本地部署」：本回合落子未成连珠 → 落点长植物；成连珠 → 这一击 +1
        this.deploy[player] = true
        this.deployBonus[player] += Math.max(1, spec.amount)
        break
      case 'redeploy': {
        // bugv34m「小千问」：消耗的植物已经被删掉了（上面统一的 `magic.delete`），
        // 这里把**压在这些植物上的棋子**移除，并记下它们的原位等待本回合落子后重新部署。
        const codes: number[] = []
        for (const cell of unique) {
          const stacked = this.overlay.get(cell)
          const base = this.board[cell]
          if (stacked !== undefined) {
            this.overlay.delete(cell)
            codes.push(cell * 2 + 1)
          } else if (base !== 0) {
            this.board[cell] = 0
            codes.push(cell * 2)
          } else {
            // 理论上不会发生（植物归属要求"有棋子压着"）；保险起见按原位记一笔
            codes.push(cell * 2)
          }
          this.emit({ type: 'stoneShattered', player, cell, reason: 'flame' })
        }
        this.redeployPending[player] = codes
        break
      }
      case 'guardShare': {
        // bugv14「稳稳的接住你」：自己 +N 护甲，对手 +M 护甲
        this.addShield(player, Math.max(0, spec.amount))
        const foe = other(player)
        this.addShield(foe, Math.max(0, spec.shareToFoe ?? 0))
        break
      }
      case 'assault':
        // bugv14「最直接、最不绕弯子」：直接进入攻击阶段，攻击值 = 消耗的植物数量
        this.declareAssault(player, unique.length)
        break
      case 'fireball':
        // bugv32：可变消耗只有 **max 档**才直击碎子（1 费档 / 首次免费只燃火）；
        // bugv33：max 从 3 → 2，碎子判定泛化成跟随 `variableCost.max`（不再硬编码 3）。
        // 固定消耗（旧口径变体 gtp-old-fb / gtp-old-kit 无 variableCost）永远碎子。
        this.castFireball(
          player,
          target as number,
          Math.max(1, spec.amount),
          spec.variableCost ? tier >= (spec.variableCost.max ?? 3) : true,
        )
        break
      case 'power': {
        // bugv12 #2：持续 `duration` 个回合（默认 1 = 仅本回合）
        const turns = Math.max(1, spec.duration ?? 1)
        this.powerBonus[player] += Math.max(1, spec.amount)
        this.powerUntil[player] = Math.max(this.powerUntil[player], this.turnNo + turns)
        this.emit({ type: 'powerChanged', player, to: this.powerBonus[player] })
        break
      }
      case 'sabotage':
        this.sabotage[player] = true
        // bugv12 #3：释放后本回合伤害 +1（可与「小一哥」的 powerBonus 叠加）
        this.sabotageBonus[player] += Math.max(1, spec.amount)
        this.emit({ type: 'sabotageChanged', player, active: true })
        break
    }

    // 用完之后把回合交给对手（`endsTurn` 技能；bugv32 起没有技能用它了，但保留通用开关）
    if (spec.endsTurn === true && this.phase === 'playing') {
      this.beginTurn(other(player))
      this.tickMagic()
      this.checkFullBoard()
    }
    return this.takeEvents()
  }

  /**
   * 恶龙吐息（bugv10 #9 / bugv12 #1）：向目标位置投射火球。
   *
   * - **直击**：目标格上的棋子（含叠子）**直接碎裂**（从棋盘移除）；
   * - 随后落点所在的**整行整列的空位**被烈焰覆盖（直击格打空后也在其中）；
   * - `turns` 为燃烧回合数（每次换手递减 1）。
   */
  private castFireball(caster: PlayerIndex, target: number, turns: number, shatter: boolean): void {
    const row = Math.floor(target / BOARD_SIZE)
    const col = target % BOARD_SIZE

    // ① 直击：目标格上的棋子直接碎裂（含叠上去的那颗）。
    //    bugv32：只有 max 费档才碎子（1 费档 / 免费 = 只燃火，不碎子）。
    if (shatter) {
      const stacked = this.overlay.get(target)
      const base = this.board[target]
      if (base !== 0 || stacked !== undefined) {
        const owner = (stacked ?? base - 1) as PlayerIndex
        this.board[target] = 0
        this.overlay.delete(target)
        this.emit({ type: 'stoneShattered', player: owner, cell: target, reason: 'flame' })
        // bugv17 #5：直击碎掉的那颗棋子上的魔力植物（含魔法阵）必须一并消失
        this.clearMagicAt([target])
      }
    }

    // ② 燃火：整行整列的空位（直击格已经空了，自然也会被点上）
    const cells: number[] = []
    for (let c = 0; c < BOARD_SIZE; c++) {
      const index = cellId(row, c)
      if (this.board[index] === 0) cells.push(index)
    }
    for (let r = 0; r < BOARD_SIZE; r++) {
      const index = cellId(r, col)
      if (this.board[index] === 0 && !cells.includes(index)) cells.push(index)
    }
    if (cells.length === 0) return
    cells.sort((a, b) => a - b)
    // 内部按"半回合"计：每次换手 -1，因此双方各走一步才算掉 1 回合（bugv10 追加 #7）
    for (const cell of cells) {
      this.flames.set(cell, Math.max(1, turns) * 2)
      // bugv14：这批烈焰归施法者 —— 只有他的棋子能走在上面（其余人落上去照样碎裂）
      this.flameOwner.set(cell, caster)
    }
    this.emit({ type: 'flamesIgnited', cells, turns, owner: caster })
    // bugv18 #1：整行整列被点着 —— 空位上的魔力植物（连同魔法阵）也被烧掉。
    // 空位上的植物按大前提是"无主"的，所以这里只是纯粹的清除，不涉及归属转移。
    this.clearMagicAt(cells, 'flame')
  }

  /**
   * 加护盾。
   *
   * bugv16：**护盾上限 = 血量上限**（用户指定）。原本护盾可以无限叠加，
   * 于是"1 费换 1 点护盾"在评估里永远划算 → 镜像局双方无限对刷、把局面拖成僵局
   * （实测 seedance 镜像自对局手数从 80 涨到 220 撞上限）。
   * 有了上限，护盾仍然是"净赚"，但不会退化成无限叠加。
   */
  private addShield(player: PlayerIndex, amount: number): void {
    if (amount <= 0) return
    const from = this.shield[player]
    const to = Math.min(this.initialHp, from + amount)
    if (to === from) return
    this.shield[player] = to
    this.emit({ type: 'shieldChanged', player, from, to })
  }

  /**
   * bugv30「力大砖飞」：把某一方的**护盾与临时护甲一起清空**（破盾）。
   *
   * bugv31：从"只清护盾"扩展到**临时护甲**（用户指定）—— 护盾、护甲一起碎，
   * 并额外发一条 `armorBroken` 给表现层（受伤方立绘播「镜面破碎」）。
   */
  private breakArmor(player: PlayerIndex): void {
    const shieldFrom = this.shield[player]
    const armorFrom = this.tempArmor[player]
    if (shieldFrom <= 0 && armorFrom <= 0) return
    if (shieldFrom > 0) {
      this.shield[player] = 0
      this.emit({ type: 'shieldChanged', player, from: shieldFrom, to: 0 })
    }
    if (armorFrom > 0) {
      this.tempArmor[player] = 0
      this.emit({ type: 'tempArmorChanged', player, from: armorFrom, to: 0 })
    }
    this.emit({ type: 'armorBroken', player, shield: shieldFrom, armor: armorFrom })
  }

  /** 回血（不超过初始血量）。 */
  private healPlayer(player: PlayerIndex, amount: number): void {
    const from = this.hp[player]
    const to = Math.min(this.initialHp, from + amount)
    if (to === from) return
    this.hp[player] = to
    this.emit({ type: 'hpChanged', player, from, to, hits: 0 })
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private place(index: number, player: PlayerIndex): void {
    // bugv10 #9 毒鸡蛋：叠在敌方棋子上 —— 原棋子留下，额外的一颗记在 overlay 里
    if (this.board[index] !== 0) {
      this.overlay.set(index, player)
      this.lastPlacedBy[player] = index
      // bugv17 #10：叠子后这一格**也有我的棋子**（连珠判定对双方都算己方），
      // 因此这棵植物归我（原归属方被抢）。以前这里直接 return，植物会一直挂在敌方名下。
      this.reconcilePlantOwner(index)
      return
    }
    this.board[index] = cellOf(player)
    // 记录"这个角色最近一颗子"（绽放技能围绕它生长，bugv9 #13）
    this.lastPlacedBy[player] = index
    // 这一格有魔力植物？那就归刚落子的一方（bugv8 #4：防守方可以把它抢过去）
    const plant = this.magic.get(index)
    if (plant && plant.owner !== player) {
      const stolen = plant.owner !== null
      this.magic.set(index, { ...plant, owner: player })
      this.emit({
        type: 'magicClaimed',
        cell: index,
        kind: plant.kind,
        player,
        stolen,
      })
    }
  }

  /**
   * 每步棋之后推进魔力植物的冷却；到点就在空位长出新的一批（bugv8 #4）。
   *
   * 规则对应：
   * - `requireLine` 时，必须先有连珠出现过才开始计时；
   * - 连珠出现时冷却立刻减 `lineCooldownCut`（由 `noteLineFormed` 处理）；
   * - 冷却归零 → 按 `magicCountForGrowth()` 长出若干棵，然后把冷却重置。
   */
  private tickMagic(): void {
    const config = this.magicConfig
    if (!config.enabled) return
    if (config.requireLine && !this.magicLineSeen) return
    // 冷却按"每步棋"递减；到 0 就长，长完重新计满
    this.magicCooldown -= 1
    if (this.magicCooldown <= 0) this.growMagic()
  }

  /**
   * 有连珠形成：冷却立刻减少（bugv8 #4）。
   *
   * 同一次落子内（攻击方成线 + 防守方抵消成线）只减一次，避免"一次对撞直接把冷却清零"，
   * 也让"10 回合"这个节奏保持可预期。
   */
  private noteLineFormed(): void {
    const config = this.magicConfig
    if (!config.enabled) return
    this.magicLineSeen = true
    if (this.lineCutDone) return
    this.lineCutDone = true
    this.magicCooldown = Math.max(0, this.magicCooldown - config.lineCooldownCut)
  }

  /** 在空位长出 2~4 棵（数量随生长次数提高）。 */
  private growMagic(): void {
    const config = this.magicConfig
    // bugv34「干涸」：场上不再生成魔力植物（冷却照常重置，免得天气一结束就立刻补长一批）
    if (this.weather === 'drought') {
      this.magicGrowths += 1
      this.magicCooldown = config.cooldownTurns
      return
    }
    const count = magicCountForGrowth(this.magicGrowths, config)
    const plants = pickMagicPlants(
      this.board,
      this.hp,
      this.moveCount.value,
      this.magicGrowths,
      count,
      [...this.magic.keys()],
      config.spawnPreference,
    )
    this.magicGrowths += 1
    this.magicCooldown = config.cooldownTurns
    if (plants.length === 0) return
    // bugv34「雷暴」：长出来的一律是"污染体"（结算 +2），并配一段闪电演出；
    // bugv34c「暴雪」：长出来的一律是"冻结的魔力植物"（结算不加伤，雪白冰晶外观）。
    const out: Array<{ cell: number; kind: MagicKind }> = plants.map((plant) => ({
      cell: plant.cell,
      kind: this.growthKind(plant.kind),
    }))
    if (this.weather === 'thunder') this.emit({ type: 'lightningStruck', cells: out.map((plant) => plant.cell) })
    for (const plant of out) {
      this.magic.set(plant.cell, { cell: plant.cell, kind: plant.kind, owner: null })
    }
    this.emit({ type: 'magicGrown', plants: out, growth: this.magicGrowths })
  }

  /**
   * 这些格子上的植物消失。
   *
   * - `reason: 'line'`（默认）：压着它的棋子被连珠结算拿走 → 同生共死；
   * - `reason: 'flame'`：火球点燃整行整列，空位上的植物被烧掉（bugv18 #1）。
   */
  private clearMagicAt(cells: readonly number[], reason: 'line' | 'flame' = 'line'): void {
    const removed: number[] = []
    for (const cell of cells) {
      if (this.magic.delete(cell)) removed.push(cell)
    }
    if (removed.length > 0) this.emit({ type: 'magicRemoved', cells: removed, reason })
  }

  /**
   * 让某格植物的归属与「压在上面的棋子」保持一致（bugv17 #7 用户定下的大前提）：
   *
   * > 魔力植物必须有棋子在上方才算"有归属"；有魔力植物的棋子被破坏，植物一并破坏。
   *
   * 因此归属是**派生量**：叠子（毒鸡蛋）优先，其次底下的棋子，都没有则无主。
   * 只在"棋子数量/归属发生变化"（落子认领、叠子抢占、叠子飞走）之后调用。
   */
  private reconcilePlantOwner(cell: number): void {
    const plant = this.magic.get(cell)
    if (!plant) return
    const stacked = this.overlay.get(cell)
    const base = this.board[cell]
    const owner: PlayerIndex | null =
      stacked !== undefined ? stacked : base !== 0 ? playerOf(base) : null
    if (plant.owner === owner) return
    if (owner === null) {
      // 没有任何棋子压着 → 退回无主（自然生长的状态）
      this.magic.set(cell, { ...plant, owner: null })
      return
    }
    const stolen = plant.owner !== null
    this.magic.set(cell, { ...plant, owner })
    this.emit({ type: 'magicClaimed', cell, kind: plant.kind, player: owner, stolen })
  }

  /**
   * bugv14「布局」（claude 2 技能）：落子**未成连珠**时，让落点九宫格长出魔力植物。
   *
   * bugv17 #7 由用户重新定义（原「播种」）：
   * - **含落点自身**以及周围 1 格的全部位置（`ringCells(center, radius, includeCenter)`）；
   * - **空位与棋子都算**（无论敌我）—— 棋子压着的那一格，长出来的植物就归那颗棋子的主人；
   * - 已经有魔力植物的格子跳过（不覆盖、不换主人）；
   * - 本回合只触发一次（触发后立刻关掉窗口）。
   *
   * ⚠️ 这里**不**推进 `magicGrowths`、也**不**重置自然生长的冷却 —— 它是一条独立的生长通道。
   * ⚠️ 归属严格按"植物必须有棋子压着才算有归属"派生（见 `reconcilePlantOwner`）：
   * 空格上长出来的是**无主**植物，谁先把棋子落上去谁占。
   */
  private triggerSeedGrow(player: PlayerIndex, center: number): void {
    if (!this.seedGrow[player]) return
    const slot = this.skills[player].findIndex((spec) => spec.effect === 'seedGrow')
    this.seedGrow[player] = false
    if (slot < 0) return
    // bugv34「干涸」：场上不再生成魔力植物（「布局」也一并失效）
    if (this.weather === 'drought') return
    const spec = this.skills[player][slot]
    const radius = Math.max(1, spec.amount)
    const isThunder = this.weather === 'thunder'
    const plants: Array<{ cell: number; kind: MagicKind; owner: PlayerIndex | null }> = []
    for (const cell of ringCells(center, this.board, radius, true)) {
      if (this.magic.has(cell)) continue
      // bugv34「雷暴」种出来的也是污染体；bugv34c「暴雪」种出来的是冻结的植物
      const kind: MagicKind = this.growthKind(MAGIC_KINDS[cell % MAGIC_KINDS.length])
      const plantOwner = this.stoneOwnerAt(cell)
      this.magic.set(cell, { cell, kind, owner: plantOwner })
      plants.push({ cell, kind, owner: plantOwner })
    }
    if (plants.length === 0) return
    if (isThunder) this.emit({ type: 'lightningStruck', cells: plants.map((plant) => plant.cell) })
    this.emit({ type: 'magicGrown', plants, growth: this.magicGrowths, source: 'seed' })
  }

  /**
   * bugv34m「本地部署」（Qwen 1 技能）：本回合落子**未成连珠**时，在**落点**长一棵魔力植物。
   *
   * 与「布局」（`triggerSeedGrow`）的区别：
   * - 只长**落点这一格**，不是九宫格；
   * - 该格上**已经有魔力植物就直接跳过**（不覆盖、不换主人）。
   *
   * ⚠️ 同样受「干涸」限制（场上不再生成魔力植物）。
   * ⚠️ 不推进 `magicGrowths` / 不重置自然生长冷却 —— 与「布局」一样是独立生长通道。
   */
  private triggerLocalDeploy(player: PlayerIndex, center: number): void {
    if (!this.deploy[player]) return
    this.deploy[player] = false
    if (this.weather === 'drought') return
    if (this.magic.has(center)) return
    const kind: MagicKind = this.growthKind(MAGIC_KINDS[center % MAGIC_KINDS.length])
    const owner = this.stoneOwnerAt(center)
    this.magic.set(center, { cell: center, kind, owner })
    this.emit({
      type: 'magicGrown',
      plants: [{ cell: center, kind, owner }],
      growth: this.magicGrowths,
      source: 'deploy',
    })
  }

  /**
   * bugv34m「本地部署」的**被动**：己方形成连珠且连珠上有魔力植物 → 削减本技能剩余冷却。
   *
   * 削减量 = 「该连珠上的魔力植物数量」（按连珠去重后的格子数植物）。
   * 只削**剩余**冷却，且不会低于 0（技能没在冷却时什么都不会发生）。
   * 攻击连珠与防守反击连珠都会触发（两者都走 `noteMatch`）。
   */
  private cutCooldownOnMatchPlants(player: PlayerIndex, plants: number): void {
    if (plants <= 0) return
    const slots: number[] = []
    for (let slot = 0; slot < this.skills[player].length; slot += 1) {
      const spec = this.skills[player][slot]
      if (spec.effect === 'localDeploy' && spec.cooldownCutOnMatchPlants === true) slots.push(slot)
    }
    if (slots.length === 0) return
    for (const slot of slots) {
      const readyAt = this.skillReadyAt[player][slot]
      if (readyAt === undefined) continue
      const remaining = readyAt - this.actionsTaken[player]
      if (remaining <= 0) continue
      this.skillReadyAt[player][slot] = readyAt - Math.min(plants, remaining)
    }
  }

  /**
   * bugv34m「小千问」（Qwen 2 技能）的结算：本回合落子**未成连珠**时重新部署棋子。
   *
   * 规则（用户口径）：
   * 1. 候选 = 棋盘空位，**剔除所有会形成连珠的位置**；
   * 2. 优先"落点周围 1 格 **且带魔力植物** 的空位"；这一档空了才退到全部候选；
   * 3. 逐个放置，随机数用**局面派生的确定性随机**（联机红线：绝不能用 `this.rng`）；
   * 4. 没位置可放的棋子**回到原位**（叠子按原样叠回去），并**把那棵魔力植物长回来**，
   *    同时把冷却按"没放下的数量 × 每棵植物的冷却"退回去。
   *
   * ⚠️ 调用点：`commit()` 里"未成连珠 → `finishTurn`"之前。成连珠的那条路不会走到这里
   * （`discardRedeploy` 已经把待结算表清空，即"这一手成了连珠，棋子就真没了"）。
   */
  private resolveRedeploy(player: PlayerIndex, center: number): void {
    const pending = this.redeployPending[player]
    if (pending.length === 0) return
    this.redeployPending[player] = []
    const placed: number[] = []
    const refunded: Array<{ cell: number; overlay: boolean }> = []
    /** 退还回来的魔力植物（事件统一排在 `redeployStones` 之后，观感是"棋子落地 → 植物复生"）。 */
    const regrown: Array<{ cell: number; kind: MagicKind; owner: PlayerIndex }> = []
    for (let index = 0; index < pending.length; index += 1) {
      const code = pending[index]
      const origin = Math.floor(code / 2)
      const isOverlay = code % 2 === 1
      const target = this.pickRedeployCell(player, center, index)
      if (target === null) {
        this.restoreRedeployStone(player, origin, isOverlay)
        refunded.push({ cell: origin, overlay: isOverlay })
        if (!this.magic.has(origin)) {
          const kind = MAGIC_KINDS[origin % MAGIC_KINDS.length]
          this.magic.set(origin, { cell: origin, kind, owner: player })
          regrown.push({ cell: origin, kind, owner: player })
        }
        continue
      }
      this.place(target, player)
      placed.push(target)
    }
    // 冷却按"实际放下"计算：没放下的那些把每棵植物的冷却退回去（Q2 口径）
    if (refunded.length > 0) {
      const slot = this.skills[player].findIndex((spec) => spec.effect === 'redeploy')
      const spec = slot >= 0 ? this.skills[player][slot] : undefined
      const perUnit = spec?.variableCost && spec.variableCost.flatCooldown !== true ? spec.variableCost.cooldownPerUnit : 0
      if (slot >= 0 && perUnit > 0) {
        const readyAt = this.skillReadyAt[player][slot]
        if (readyAt !== undefined) {
          this.skillReadyAt[player][slot] = Math.max(this.actionsTaken[player], readyAt - perUnit * refunded.length)
        }
      }
    }
    this.emit({ type: 'redeployStones', player, placed, refunded })
    if (regrown.length > 0) {
      this.emit({ type: 'magicGrown', plants: regrown, growth: this.magicGrowths, source: 'redeploy' })
    }
  }

  /**
   * 「小千问」给一颗棋子挑落点。
   *
   * 候选必须是**空位且不会形成连珠**（否则等于白送对手一次攻击）。命中优先级
   * （bugv34n 用户口径，**先看植物、再看距离**）：
   *   ① **能吃下魔力植物的空位** —— 空位上的植物必为**无主**（归属由"压着的棋子"派生，
   *      见 `reconcilePlantOwner`），落上去等于顺手把它收为己有；
   *   ② 离落点**最近**的空位（切比雪夫距离，由近到远一圈圈找）。
   * 只有 ① 一个都没有时才退到 ② —— 不允许"随机丢到很远的地方"。
   *
   * 随机用 `boardRandom`（只由棋盘 + 血量派生）：两端引擎的 `rng` 流位置不同、`moveCount`
   * 又不会被 `loadScenario()` 恢复，都不能拿来当种子。
   *
   * ⚠️ AI 的迷你引擎按同一套规则复刻（`src/ai/search.ts: pickRedeployCell`），
   * 两边改一处必须同时改（守卫：`scripts/verify-ai-skills.ts`）。
   */
  private pickRedeployCell(player: PlayerIndex, center: number, index: number): number | null {
    const legal = this.emptyCells().filter((cell) => previewAttackPieces(this.board, player, cell).length === 0)
    if (legal.length === 0) return null
    // ① 优先吃无主魔力植物
    const withPlant = legal.filter((cell) => this.magic.has(cell))
    if (withPlant.length > 0) {
      const pick = this.boardRandom(`redeploy-plant-${player}-${index}`)
      return withPlant[Math.min(withPlant.length - 1, Math.floor(pick * withPlant.length))]
    }
    // ② 退而求其次：离落点最近的一圈
    const row = (center / BOARD_SIZE) | 0
    const col = center % BOARD_SIZE
    const distOf = (cell: number): number =>
      Math.max(Math.abs(((cell / BOARD_SIZE) | 0) - row), Math.abs((cell % BOARD_SIZE) - col))
    let best = Number.POSITIVE_INFINITY
    for (const cell of legal) {
      const d = distOf(cell)
      if (d < best) best = d
    }
    const nearest = legal.filter((cell) => distOf(cell) === best)
    const pick = this.boardRandom(`redeploy-near-${player}-${index}`)
    return nearest[Math.min(nearest.length - 1, Math.floor(pick * nearest.length))]
  }

  /**
   * 把一颗放不下的「小千问」棋子放回原位（含"叠子"情形）。
   *
   * ⚠️ 这里**不动**魔力植物 —— 退还的那棵由调用方统一处理（事件要排在 `redeployStones` 之后）。
   */
  private restoreRedeployStone(player: PlayerIndex, cell: number, isOverlay: boolean): void {
    if (isOverlay) this.overlay.set(cell, player)
    else this.board[cell] = cellOf(player)
  }

  /** 成连珠时「小千问」的待结算表直接作废（这一手成了连珠，被移除的棋子就真没了）。 */
  private discardRedeploy(player: PlayerIndex): void {
    if (this.redeployPending[player].length > 0) this.redeployPending[player] = []
  }

  /** 这一格"压在上面的棋子"属于谁（叠子优先；没有棋子则 `null`）。 */
  private stoneOwnerAt(cell: number): PlayerIndex | null {
    const stacked = this.overlay.get(cell)
    if (stacked !== undefined) return stacked
    const base = this.board[cell]
    return base !== 0 ? playerOf(base) : null
  }

  /**
   * 宣告一次连珠（冷却削减 + 事件 + 摘要）。
   *
   * @param linePlants bugv34m：这条连珠上的**魔力植物数量**。
   *   缺省时按当前棋盘现数；**防守连珠必须显式传** —— `defend()` 在调用它之前
   *   已经把连珠上的植物全清掉了（`clearMagicAt`），现数永远是 0。
   */
  private noteMatch(player: PlayerIndex, summary: MatchSummary, linePlants?: number): void {
    // bugv18 #2「小一哥」：每形成一次连珠，持续时间消耗 2 回合。
    // ⚠️ 只动 `powerUntil`（剩余时间），**不动 `powerBonus`** —— 这样"这一击"的
    // 加伤不受影响（它已经锁进 `draft.powerBonus`），只是后续回合要更早到期。
    if (this.powerUntil[player] > this.turnNo) {
      this.powerUntil[player] = Math.max(this.turnNo, this.powerUntil[player] - 2)
    }
    // bugv34m「本地部署」的**被动**：己方每次形成连珠、且连珠上有魔力植物 →
    // 本技能剩余冷却减少「该连珠上的魔力植物数量」回合。
    // ⚠️ 只削"当前还剩的冷却"（`readyAt - actionsTaken`），不会把技能"倒欠"成负冷却。
    let plants = linePlants
    if (plants === undefined) {
      plants = 0
      for (const cell of summary.cells) if (this.magic.has(cell)) plants += 1
    }
    this.cutCooldownOnMatchPlants(player, plants)
    this.noteLineFormed()
    this.emit({
      type: 'matchFormed',
      match: {
        owner: player,
        lines: summary.lines,
        cells: summary.cells,
        uniqueCount: summary.uniqueCount,
      },
    })
    this.lastMatch = { player, summary }
  }

  /** 攻击方最终攻击值（含魔力植物、「小一哥」、「毒鸡蛋」以及天气的加成）。 */
  private attackValue(draft: AttackDraft, weakness: number): number {
    return this.finalAttackOf(
      draft.attacker,
      draft.baseDamage,
      weakness,
      draft.attackerPlantCells,
      draft.powerBonus,
      draft.sabotageBonus,
      draft.deployBonus,
    )
  }

  /**
   * 连珠上的魔力植物加伤（bugv34 起含天气修正，见 Weather.md）。
   *
   * - 低消耗档「杀鲸霸拳」生效 → 0；
   * - **「枯竭」** → 0（魔力植物不再提供任何伤害加成）；
   * - **「雷暴」** → 污染体每棵 +2，普通植物仍按 `damagePerPlant`；
   * - **「暴雪」** → 「冻结的魔力植物」**每棵 0**（其余照常）；
   * - 其余 → 棵数 × `damagePerPlant`。
   *
   * ⚠️ 逐棵判断（不再用 `cells.length × n`）：天气是按 **kind** 起作用的，
   * 同一片连珠上可能同时有冻结 / 污染 / 普通三种植物。
   */
  private magicPlantBonus(player: PlayerIndex, cells: readonly number[]): number {
    if (this.noPlantBonus[player]) return 0
    let bonus = 0
    for (const cell of cells) {
      const plant = this.magic.get(cell)
      // 冻结的植物不加伤（暴雪）
      if (plant && plant.kind === 'frozen') continue
      // 枯竭：魔力植物一律不加伤
      if (this.weather === 'depletion') continue
      // 快照里查不到（植物已随棋子被带走）时按普通植物计，保持旧口径
      const per = this.weather === 'thunder' && plant && plant.kind === 'pollution' ? 2 : this.magicConfig.damagePerPlant
      bonus += per
    }
    return bonus
  }

  /** 最终攻击值（bugv34：含天气「干涸」的 −1，最低 1）。 */
  private finalAttackOf(
    attacker: PlayerIndex,
    baseDamage: number,
    weakness: number,
    plantCells: readonly number[],
    powerBonus: number,
    sabotageBonus: number,
    deployBonus = 0,
  ): number {
    const magicBonus = this.magicPlantBonus(attacker, plantCells)
    const base = finalAttackValue(baseDamage, weakness, magicBonus) + powerBonus + sabotageBonus + deployBonus
    return this.weather === 'drought' ? Math.max(1, base - 1) : base
  }

  /**
   * 取出「力大砖飞」（原「深度思考」）的加成。
   *
   * 只对**首个连珠攻击**生效 → 取走即清零（`strikeBonus` / `strikeUntil` 一起清），
   * 返回加进基础攻击值的点数。
   *
   * bugv30：不再有"对手没能成线反击再加 1 颗"的第二段加成（`strikeExtra` 恒为 0）；
   * 取而代之的是"成功造成伤害后破盾"（见 `resolveAttack` 里的 `breakShield`）。
   */
  private takeStrike(player: PlayerIndex): number {
    if (this.strikeBonus[player] <= 0 || this.strikeUntil[player] <= this.turnNo) return 0
    const bonus = this.strikeBonus[player]
    this.strikeBonus[player] = 0
    this.strikeUntil[player] = 0
    this.emit({ type: 'strikeChanged', player, to: 0 })
    return bonus
  }

  /**
   * 攻击方宣告攻击：移除连珠棋子、留下高光、进入防守方落子（规则 4.1）。
   *
   * bugv10 #9：连珠格上"叠在敌方棋子上"的那一颗只飞走叠子，底下的原棋子留下。
   */
  /**
   * 宣告攻击（规则 4.1 / 5.1）。
   *
   * bugv17 #4/#5：**棋子被破坏时，压在上面的魔力植物一并被破坏**（用户明确的大前提）。
   * 以前这一步只把棋子从棋盘上拿掉、植物要拖到防守方落子时才清，于是"攻击宣告后
   * 植物与魔法阵还赖在棋盘上"，而且那段时间里的归属状态是错的。
   */
  private declareAttack(attacker: PlayerIndex, summary: MatchSummary): void {
    const cells = [...summary.cells]
    const kept: number[] = []
    // ⚠️ 加伤在宣告时锁进快照（`setupAttack`），但**植物本身先不删** ——
    // bugv18 #1：它们是防守方的"抢夺窗口"，必须留到防守方落子之后。
    const plantCells = plantsOnCells(this.magic, cells, attacker)

    // 棋子飞出棋盘（实体去重）
    for (const cell of cells) {
      if (this.overlay.get(cell) === attacker) {
        this.overlay.delete(cell)
        kept.push(cell)
      } else if (this.board[cell] !== 0) {
        this.board[cell] = 0
      }
    }

    this.emit({
      type: 'stonesRemoved',
      player: attacker,
      cells,
      highlight: true,
      kept: kept.length > 0 ? kept : undefined,
    })
    // 叠子飞走、底下原棋子还留着的格子：植物归属回到底下那颗棋子的主人
    for (const cell of kept) this.reconcilePlantOwner(cell)

    // bugv34：记账"双方发起过的攻击棋子"（黑夜的进入 / 退出条件都读它）
    this.attacksLaunched[attacker] += cells.length

    // bugv34「干涸」的"−1"只由 `finalAttackOf()` 的天气修正负责（棋子的**数量**不在这里改）。
    // ⚠️ **不要**再从 `weights` / `cells` 里删掉一颗：那会少算两颗（4 连 → 2），
    //    而且 `draft.cells` 缺了那一格 ⇒ 结算时 `clearMagicAt` 漏掉它 ⇒ 植物与魔法阵残留场上。
    // ⚠️ 也**不要**再发"随机碎一颗"的事件（bugv34d 已去掉）：它会在舞台上凭空补一颗再炸掉，
    //    与 `reconcileStage` 的 surplus 碎裂**重复播两遍**。表现统一交给 `reconcileStage`。
    const attackCells: readonly number[] = cells
    const weights: ReadonlyMap<number, number> = summary.weights

    const strike = this.takeStrike(attacker)
    this.setupAttack(attacker, weights, summary.lineLengthSum, attackCells, {
      baseDamage: weights.size + strike,
      strikeBonus: strike,
      // bugv30：「力大砖飞」不再有"对手没能成线反击再加伤"的第二段
      strikeExtra: 0,
      breakShield: strike > 0,
      plantCells,
    })

    // bugv34c「极光」：连珠后、伤害结算前，**为双方恢复等量的血量**
    // （每棵魔力植物双方各回 1 血；用宣告时锁定的植物快照，不受后面抢夺影响）。
    if (this.weather === 'aurora') {
      const heal = plantCells.length
      if (heal > 0) {
        this.healPlayer(attacker, heal)
        this.healPlayer(other(attacker), heal)
      }
    }

    // bugv34c「暴雪」：被棋子占有的冻结植物**在连珠后解冻** —— 具体留到 `defend()` 里、
    // 「攻击方最终攻击值重算」**之后**执行，这样本次连珠的加成仍按"冻结 = 0"计。

    // 宣告攻击也算"这一方走过一步"：这样烈焰的 6 回合始终是**双方各走一步 = 1 回合**
    // （bugv10 追加 #7 的计时口径），不会因为这一手是攻击而少烧半个回合。
    this.tickFlames()
  }

  /**
   * 「暴雪」解冻的**待重生格**（bugv34c）：返回连珠上**被冻结**的植物所在格。
   *
   * 口径（用户明确）：连珠后这些冻结植物会**随着棋子一起消失**，同时**在原地重新长出**
   * 一棵**非冻结**的魔力植物 —— 「你可以理解为解冻」（而不是把原来那棵就地改色）。
   * 因此这里只登记格子，真正的重生在 `resolveAttack` 的最后统一执行（`regrowThawedPlant`）。
   */
  private frozenLineCells(cells: readonly number[]): number[] {
    if (this.weather !== 'blizzard') return []
    const out: number[] = []
    const seen = new Set<number>()
    for (const cell of cells) {
      if (seen.has(cell)) continue
      const plant = this.magic.get(cell)
      if (plant && plant.kind === 'frozen') {
        seen.add(cell)
        out.push(cell)
      }
    }
    return out
  }

  /**
   * 「暴雪」解冻的**重生**（bugv34c）：在 `cell` **原地**长出一棵**非冻结**的魔力植物。
   *
   * ⚠️ 必须用普通种类 —— **不能**走 `growthKind()`（暴雪期间它会返回 `'frozen'`，那就白解冻了）。
   * 归属照常由"压在这格上的棋子"派生（防守方可能刚落子在这一格）。
   */
  private regrowThawedPlant(cell: number): void {
    if (this.magic.has(cell)) return
    const kind = MAGIC_KINDS[cell % MAGIC_KINDS.length]
    const owner = this.stoneOwnerAt(cell)
    this.magic.set(cell, { cell, kind, owner })
    this.emit({
      type: 'magicGrown',
      plants: [{ cell, kind, owner }],
      growth: this.magicGrowths,
      source: 'weather',
    })
  }

  /**
   * 「最直接、最不绕弯子」（bugv14）：跳过落子，直接进入攻击阶段。
   *
   * 攻击值 = 消耗的魔力植物数量（没有连珠棋子，因此不发 `stonesRemoved`、
   * 也不削减魔力植物的生长冷却 —— 它压根不是连珠）。
   */
  private declareAssault(attacker: PlayerIndex, count: number): void {
    // bugv34：发起过的攻击棋子记账（「最不绕弯子」也会飞出 count 颗棋子）
    this.attacksLaunched[attacker] += count
    const strike = this.takeStrike(attacker)
    this.setupAttack(attacker, new Map<number, number>(), count, [], {
      baseDamage: count + strike,
      strikeBonus: strike,
      strikeExtra: 0,
      breakShield: strike > 0,
    })
    this.tickFlames()
  }

  /**
   * 直接从高光权重恢复攻击阶段（bugv6 #8，联机断线重连用）。
   *
   * 与 `declareAttack` 的区别：**不**动棋盘、**不**发事件 —— 因为棋盘早已是
   * “攻击方棋子已被移除”之后的样子，重连只是把攻击上下文补回来。
   */
  private restoreAttack(attacker: PlayerIndex, weights: ReadonlyMap<number, number>, lineLengthSum: number): void {
    const cells = [...weights.keys()].sort((a, b) => a - b)
    this.setupAttack(attacker, weights, lineLengthSum, cells)
  }

  /**
   * 建立攻击上下文（高光、草稿、面板快照）。
   *
   * `opts.baseDamage`：覆盖"攻击值 = 高光格数"的默认口径 —— 「最直接、最不绕弯子」
   * 的攻击没有连珠棋子，攻击值直接等于消耗的植物数。`opts.strikeExtra` 见 `AttackDraft`。
   */
  private setupAttack(
    attacker: PlayerIndex,
    weights: ReadonlyMap<number, number>,
    lineLengthSum: number,
    cells: readonly number[],
    opts?: {
      baseDamage?: number
      strikeBonus?: number
      strikeExtra?: number
      /** bugv30：这一击成功造成伤害后是否要清空受伤方的护盾（「力大砖飞」）。 */
      breakShield?: boolean
      /** 攻击方连珠上的植物格子（bugv17 #4：宣告时锁定的快照，此时棋盘上可能已删）。 */
      plantCells?: readonly number[]
    },
  ): void {
    const defender = other(attacker)
    // 参与连珠的实体棋子数 = 高光位置数（weightMap 的键就是连珠棋子的并集）
    const baseDamage = opts?.baseDamage ?? weights.size
    const strikeBonus = opts?.strikeBonus ?? 0
    const strikeExtra = opts?.strikeExtra ?? 0
    // bugv30：「力大砖飞」——只有技能真的带 breakShield 时才破盾
    const breakShield = (opts?.breakShield ?? false) && this.strikeBreaksShield(attacker)
    this.highlights = new Map(weights)
    this.highlightOwner = attacker
    this.emit({
      type: 'highlightShown',
      owner: attacker,
      cells: [...cells],
      weights: [...cells].map((cell) => weights.get(cell) ?? 1),
    })

    // 攻击方连珠棋子上的魔力植物计入伤害（bugv8 #4）
    // bugv17 #4：优先用调用方给的**宣告时快照** —— 这时植物可能已经随棋子删掉了。
    const attackerPlantCells = opts?.plantCells ?? plantsOnCells(this.magic, cells, attacker)
    // bugv34「瘟疫」：攻击阶段**一开始**就把攻击方连珠上每棵魔力植物"分裂出的那一颗"
    // 挂到防守方 —— 防守方**还没落子**就已经握有这些棋子（Weather.md：连珠后魔力植物
    // 会为双方提供伤害加成）。数值在 `defend()` 里会按抢夺结果重算，这里负责"宣告即生效"。
    let plagueToDefender = 0
    if (this.weather === 'plague' && attackerPlantCells.length > 0) {
      plagueToDefender = this.magicPlantBonus(attacker, attackerPlantCells)
      for (const cell of attackerPlantCells) {
        this.emit({ type: 'attackStoneSplit', player: attacker, cell, to: defender })
      }
    }
    // bugv34：最终攻击值统一走 `finalAttackOf`（含「枯竭 / 雷暴 / 干涸」的天气修正）
    const initialFinal = this.finalAttackOf(
      attacker,
      baseDamage,
      0,
      attackerPlantCells,
      this.powerBonus[attacker],
      this.sabotageBonus[attacker],
      this.deployBonus[attacker],
    )

    this.draft = {
      attacker,
      lines: [],
      cells: [...cells],
      baseDamage,
      lineLengthSum,
      weights,
      defenseCell: null,
      weakness: 0,
      finalAttack: initialFinal,
      defenderLines: [],
      defenderCells: [],
      defenderAttack: plagueToDefender,
      plagueSplit: plagueToDefender,
      defenderCombatBase: 0,
      thawCells: [],
      mode: null,
      damaged: null,
      diff: 0,
      clash: 0,
      attackerPlantCells,
      defenderPlantCells: [],
      stolenPlants: 0,
      powerBonus: this.powerBonus[attacker],
      sabotageBonus: this.sabotageBonus[attacker],
      deployBonus: this.deployBonus[attacker],
      strikeBonus,
      strikeExtra,
      breakShield,
      immune: null,
    }

    // bugv34d：直接由 `buildSnapshot()` 生成宣告时的快照 —— 以前这里是手写的一份字面量，
    // 每加一个快照字段都要在两处同步（漏一处就会"UI 上看不到"）。
    // 此时 draft 里的 mode/damaged/diff/weakness/defenseCell 都还是初值，与旧字面量完全等价。
    //
    // ⚠️ 快照里带了「天气增减伤」(`weatherAttackDelta` / `weatherDefenderDelta`) 供结算面板显示。
    this.attack = this.buildSnapshot(this.draft)

    this.phase = 'awaitingDefense'
    this.current = defender
  }

  /** 攻击结算（规则 5 / 6.3 / 7）。 */
  private resolveAttack(draft: AttackDraft): void {
    const { attacker, defender } = { attacker: draft.attacker, defender: other(draft.attacker) }
    // 防守方有棋子参与对撞：要么自己成线反击，要么「瘟疫」把攻击方带植物的棋子分裂了过去。
    // ⚠️ 不能只看 `defenderAttack > 0` —— 没有防御线时，防守方的「小一哥 / 毒鸡蛋」加成
    // 也会让它是正数，但那并不代表防守方有攻击棋子。
    const hasDefenseLine = draft.defenderLines.length > 0
    const hasDefenseStones = hasDefenseLine || draft.plagueSplit > 0

    if (hasDefenseStones) {
      // 防守方形成连珠：双方棋子飞向中央对撞
      this.removeDetached(draft.defenderCells, defender)
      const clash = clashCount(draft.finalAttack, draft.defenderAttack)
      const diff = damageDiff(draft.finalAttack, draft.defenderAttack)

      if (diff === 0) {
        draft.mode = 'canceled'
        draft.damaged = null
        draft.diff = 0
        draft.clash = clash
        this.emit({
          type: 'attackResolved',
          snapshot: this.buildSnapshot(draft),
          clashCount: clash,
          damage: 0,
        })
      } else {
        const damaged: PlayerIndex = draft.finalAttack > draft.defenderAttack ? defender : attacker
        if (this.isDamageImmune(damaged)) {
          // bugv10 #9「精密计算」/ bugv11 #5「双子星」：伤害被完全挡下
          draft.mode = 'immune'
          draft.damaged = damaged
          draft.diff = 0
          draft.clash = 0
          draft.immune = damaged
          this.emit({
            type: 'attackResolved',
            snapshot: this.buildSnapshot(draft),
            clashCount: 0,
            damage: 0,
          })
        } else {
          draft.mode = damaged === defender ? 'defenderDamaged' : 'attackerDamaged'
          draft.damaged = damaged
          draft.diff = diff
          draft.clash = clash
          this.emit({
            type: 'attackResolved',
            snapshot: this.buildSnapshot(draft),
            clashCount: clash,
            damage: diff,
          })
          this.applyDamage(damaged, diff)
        }
      }
    } else if (this.isDamageImmune(defender)) {
      // 防守方没成线，但处于无敌 / 双子星状态：伤害被挡下（bugv10 #9 / bugv11 #5）
      draft.mode = 'immune'
      draft.damaged = defender
      draft.diff = 0
      draft.clash = 0
      draft.immune = defender
      this.emit({
        type: 'attackResolved',
        snapshot: this.buildSnapshot(draft),
        clashCount: 0,
        damage: 0,
      })
    } else {
      // 防守方未形成连珠：攻击方最终攻击值直接造成伤害
      // bugv30：「力大砖飞」不再有"对手没能成线反击再加伤"的第二段（`strikeExtra` 恒为 0）
      const damage = draft.finalAttack + draft.strikeExtra
      draft.mode = 'defenderDamaged'
      draft.damaged = defender
      draft.diff = damage
      draft.clash = 0
      this.emit({
        type: 'attackResolved',
        snapshot: this.buildSnapshot(draft),
        clashCount: 0,
        damage,
      })
      this.applyDamage(defender, damage)
    }

    // bugv30「力大砖飞」：这一击**成功造成了伤害**（受伤的是防守方、伤害 > 0）
    // → 伤害结算完成后把防守方的护盾与临时护甲**全部移除**（bugv31 加入护甲）。
    // ⚠️ 只在"防守方挨打"时触发：若对撞后是攻击方自己吃伤害，说明这一击没打到目标，不破盾。
    if (draft.breakShield && draft.damaged === defender && draft.diff > 0) {
      this.breakArmor(defender)
    }

    // 连珠结算完毕：这些格子上的魔力植物**已经在防守方落子时清掉了**（bugv9 #2），
    // 这里不再重复清理。

    // bugv18 #2：双子星条件奖励 —— 本回合用了双子星（twinStar 还在）、成线发起攻击、
    // 且对手没能成线反击 → **恢复 1 点血量**（用户指定；取代原来的"不进冷却 + 下次消耗 -1"）。
    if (this.twinStar[attacker] && !hasDefenseLine) {
      const slot = this.skills[attacker].findIndex((spec) => spec.effect === 'bloom')
      if (slot >= 0) {
        this.healPlayer(attacker, 1)
        this.emit({ type: 'bloomRewarded', player: attacker })
      }
    }

    // bugv34c「暴雪」解冻的重生：等所有棋子都飞走之后（`removeDetached` 在上面的对撞分支里），
    // 在连珠上原来那几棵冻结植物的位置**原地长出非冻结的植物**。
    // ⚠️ 必须放在这里（而不是清植物的那一刻）—— 否则刚长出来就会被 `removeDetached` 一起清掉。
    for (const cell of draft.thawCells) this.regrowThawedPlant(cell)

    // 清除高光
    this.highlights = new Map()
    this.highlightOwner = null
    this.emit({ type: 'highlightsCleared' })

    this.attack = this.buildSnapshot(draft)
    this.draft = null

    // bugv10 #9：「当前回合伤害 +1」与「可在敌方棋子落子」已经被这一击用掉了
    this.clearTurnEffects(attacker)

    // 攻击阶段结束
    const result = this.detectResult()
    if (result) {
      this.phase = 'gameOver'
      this.result = result
      this.emit({ type: 'gameOver', result })
      return
    }

    // 规则 11.2：下一普通回合由原攻击方开始
    this.phase = 'playing'
    // bugv34c「旱雷」：防守方刚落完子（攻击阶段结束）→ 结算一次天气
    this.afterAction(defender)
    this.beginTurn(attacker)
    // 攻击阶段走完算一步棋：推进魔力植物冷却与烈焰（bugv8 #4 / bugv10 #9）
    this.tickMagic()
    this.tickFlames()
  }

  /**
   * 移除棋盘上的一组棋子（防守方连珠），不留下高光（规则 6.1）。
   *
   * bugv10 #9：叠子只移走上面那一颗，底下的原棋子保留。
   */
  /**
   * 移除棋盘上的一组棋子（防守方连珠），不留下高光（规则 6.1）。
   *
   * bugv10 #9：叠子只移走上面那一颗，底下的原棋子保留。
   * bugv17 #4：真正被破坏的格子上的魔力植物一并破坏（与 `stonesRemoved` 同一时刻）。
   */
  private removeDetached(cells: readonly number[], owner: PlayerIndex): void {
    const removed: number[] = []
    const kept: number[] = []
    for (const cell of cells) {
      if (this.overlay.get(cell) === owner) {
        this.overlay.delete(cell)
        kept.push(cell)
        continue
      }
      if (this.board[cell] === cellOf(owner)) {
        this.board[cell] = 0
        removed.push(cell)
      }
    }
    const all = [...removed, ...kept].sort((a, b) => a - b)
    if (all.length > 0) {
      this.emit({
        type: 'stonesRemoved',
        player: owner,
        cells: all,
        highlight: false,
        kept: kept.length > 0 ? kept.sort((a, b) => a - b) : undefined,
      })
    }
    this.clearMagicAt(removed)
    for (const cell of kept) this.reconcilePlantOwner(cell)
  }

  /**
   * 扣血。承伤顺序（bugv14）：**临时护甲 → 护盾 → 血量**。
   *
   * 临时护甲放在最前面，是因为它"用不完就作废"——先花掉快到期的资源才合理。
   */
  private applyDamage(player: PlayerIndex, amount: number): void {
    if (amount <= 0) return
    // bugv18 #2「猫的憩息」：受到伤害后冷却前进（护甲/护盾全挡下也算"受到伤害"）。
    // bugv24：由"立即清零"改为**前进 `cooldownAdvanceOnDamage` 手**（gemini 现为 2 手）——
    //         原"随时可治"实测过强（约 7 次/局 ≈ 一整条命）。
    // 放在扣血之前，好让随后的事件同步到最新的技能状态。
    const healSlot = this.skills[player].findIndex(
      (spec) => spec.cooldownAdvanceOnDamage !== undefined,
    )
    if (healSlot >= 0) {
      const advance = this.skills[player][healSlot].cooldownAdvanceOnDamage ?? 0
      const readyAt = this.skillReadyAt[player]?.[healSlot] ?? 0
      if (readyAt > this.actionsTaken[player]) {
        this.skillReadyAt[player][healSlot] = Math.max(
          this.actionsTaken[player],
          readyAt - advance,
        )
      }
    }
    let remaining = amount
    // bugv14：临时护甲先承伤（它是会过期的资源，先用掉）
    const armor = this.tempArmor[player]
    if (armor > 0) {
      const absorbed = Math.min(armor, remaining)
      this.tempArmor[player] = armor - absorbed
      remaining -= absorbed
      this.emit({ type: 'tempArmorChanged', player, from: armor, to: this.tempArmor[player] })
    }
    if (remaining <= 0) return
    // 护盾先承伤（bugv9 #13）：金属质感的银色血条被打掉之后才扣血
    const shield = this.shield[player]
    if (shield > 0) {
      const absorbed = Math.min(shield, remaining)
      this.shield[player] = shield - absorbed
      remaining -= absorbed
      this.emit({ type: 'shieldChanged', player, from: shield, to: this.shield[player] })
    }
    if (remaining <= 0) return
    const from = this.hp[player]
    const to = from - remaining
    this.hp[player] = to
    this.emit({ type: 'hpChanged', player, from, to, hits: remaining })
  }

  private buildSnapshot(draft: AttackDraft): AttackSnapshot {
    const defender = other(draft.attacker)
    const cfg = this.magicConfig
    // bugv34d：天气造成的净增减伤 = 实际值 − "无天气"时的基线值。
    // 这样一处计算就涵盖所有天气（污染体 +2 / 枯竭与冻结不加伤 / 干涸 −1 / 瘟疫分裂）。
    const attackerNormal = this.noPlantBonus[draft.attacker] ? 0 : draft.attackerPlantCells.length * cfg.damagePerPlant
    const defenderNormal = this.noPlantBonus[defender] ? 0 : draft.defenderPlantCells.length * cfg.damagePerPlant
    const attackerBaseline =
      finalAttackValue(draft.baseDamage, draft.weakness, attackerNormal) +
      draft.powerBonus +
      draft.sabotageBonus +
      draft.deployBonus
    const defenderBaseline = draft.defenderCombatBase + defenderNormal
    return {
      attacker: draft.attacker,
      defender,
      baseDamage: draft.baseDamage,
      lineLengthSum: draft.lineLengthSum,
      defenseCell: draft.defenseCell,
      weakness: draft.weakness,
      finalAttack: draft.finalAttack,
      defenderAttack: draft.defenderAttack,
      diff: draft.diff,
      mode: draft.mode,
      damaged: draft.damaged,
      attackerPlants: draft.attackerPlantCells.length,
      defenderPlants: draft.defenderPlantCells.length,
      // bugv19：「杀鲸霸拳」低消耗档 → 本回合植物加伤被关掉（UI 提示用）
      attackerPlantBonusOff: this.noPlantBonus[draft.attacker],
      defenderPlantBonusOff: this.noPlantBonus[defender],
      stolenPlants: draft.stolenPlants,
      powerBonus: draft.powerBonus,
      sabotageBonus: draft.sabotageBonus,
      deployBonus: draft.deployBonus,
      strikeBonus: draft.strikeBonus,
      strikeExtra: draft.strikeExtra,
      immune: draft.immune,
      weather: this.weather,
      weatherAttackDelta: draft.finalAttack - attackerBaseline,
      weatherDefenderDelta: draft.defenderAttack - defenderBaseline,
    }
  }

  /** 判定胜负（规则 7 / 8）。 */
  private detectResult(): GameResult | null {
    const [hp0, hp1] = this.hp
    if (hp0 <= 0 || hp1 <= 0) {
      // 血量可扣到 0 以下；双方同时归零时以攻击方优先（先到 0 者负）
      const winner: PlayerIndex | null = hp0 <= 0 && hp1 <= 0 ? (hp1 > hp0 ? 0 : 1) : hp0 <= 0 ? 1 : 0
      return { winner, reason: 'hp', hp: [hp0, hp1] }
    }
    if (this.isBoardFull()) {
      const winner: PlayerIndex | null = hp0 === hp1 ? null : hp0 > hp1 ? 0 : 1
      return { winner, reason: 'boardFull', hp: [hp0, hp1] }
    }
    return null
  }
}

// ---------------------------------------------------------------------------
// 只读辅助（AI / UI 复用）
// ---------------------------------------------------------------------------

/** 在某棋盘上模拟落子后的连珠实体棋子（不修改原棋盘）。 */
export function previewAttackPieces(board: BoardLike, player: PlayerIndex, cell: number): number[] {
  const flat = Array.isArray(board) && typeof board[0] === 'number' ? (board as Board).slice() : []
  if (flat.length === 0) {
    // 二维数组
    const grid = board as ReadonlyArray<ReadonlyArray<number>>
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) flat[cellId(r, c)] = (grid[r]?.[c] ?? 0) as Cell
    }
  }
  flat[cell] = cellOf(player)
  return uniquePieceCells(summarizeMatch(flat, player).lines)
}

/** 该位置属于指定玩家几条连珠。 */
export function weaknessAt(board: BoardLike, player: PlayerIndex, cell: number): number {
  const summary = summarizeMatch(board, player)
  return summary.weights.get(cell) ?? 0
}

export { playerOf }
