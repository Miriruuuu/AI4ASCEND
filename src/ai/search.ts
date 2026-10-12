/* AI 的博弈搜索核心：逐字节复刻引擎规则的迷你引擎（Searcher）+ 迭代加深 / alpha-beta / 置换表。 */
import {
  BOARD_SIZE,
  CELL_COUNT,
  DEFAULT_MAGIC_CONFIG,
  INITIAL_HP,
  MIN_ATTACK_VALUE,
  MIN_LINE_LENGTH,
  other,
  type Board,
  type PlayerIndex,
  type SkillEffect,
  type SkillSpec,
} from '../core/types'
import { seededRng } from '../core/magic'
import type { AiMagicContext, AiSkillContext } from './types'
import {
  AI_POLICY,
  BOARD_WIN,
  CENTER,
  DIFF_BOARD,
  DIFF_FLAME,
  DIFF_FLAME_OWNER,
  DIFF_OVERLAY,
  DIFF_PLANT,
  DIRS,
  EMPTY_CELLS,
  FIREBALL_PLANT_BONUS_CAP,
  FLAME_WALK_DAMAGE,
  GATE_OWN_FLAME_WALK,
  HP_WEIGHT,
  INF,
  MAX_MOVES,
  MAX_ROOT_MOVES,
  MAX_ROOT_STEPS,
  NB24,
  NB_STRIDE,
  PENDING_DAMAGE_WEIGHT,
  PLANT_ABSENT,
  PLANT_CLAIM_EXCLUSIVE,
  PLANT_CLAIM_SHARED,
  PLANT_LINE_VALUE,
  PLANT_NEUTRAL,
  PLANT_SPENDABLE,
  PRIO_ATTACK_MINE,
  PRIO_ATTACK_OPP,
  PRIO_NEAR1,
  PRIO_NEAR2,
  PRIO_PLANT_FOE,
  PRIO_PLANT_NEUTRAL,
  PRIO_THREE_MINE,
  PRIO_THREE_OPP,
  QUIESCE_LIMIT,
  SHIELD_WEIGHT,
  TEMPO,
  TT_EXACT,
  TT_LOWER,
  TT_UPPER,
  TWIN_STAR_LINE_LENGTH,
  WIN,
  WINDOWS,
  WINDOW_COUNT,
  W_ONE,
  W_ONE_OPP,
  W_THREE,
  W_THREE_OPP,
  W_TWO,
  W_TWO_OPP,
  ZOBRIST,
  ZOBRIST_TURN,
  now,
  ownedPlantScore,
} from './policy'

/**
 * 一次操作（落子 / 防守 / 技能）造成的**全部**状态改动，用于撤销。
 *
 * 单步操作会同时改动棋盘、植物、烈焰、叠子、血量、护盾、冷却……所以统一成一份
 * 记录：小的标量直接快照，格子级的改动压进 `diff`（正序记录、**逆序还原**，
 * 这样同一格被连续改动两次也能回到最初值）。
 */
interface Undo {
  diff: number[]
  hp0: number
  hp1: number
  shield0: number
  shield1: number
  bonus0: number
  bonus1: number
  acted0: number
  acted1: number
  turnNo: number
  immune0: number
  immune1: number
  power0: number
  power1: number
  /** 增伤的到期回合（bugv12 #2：「小一哥」持续 2 回合）。 */
  powerUntil0: number
  powerUntil1: number
  sab0: boolean
  sab1: boolean
  /** 本回合毒鸡蛋的额外伤害（bugv12 #3）。 */
  sabB0: number
  sabB1: number
  twin0: boolean
  twin1: boolean
  /** 下次双子星是否减费（bugv12 #3）。 */
  bloomF0: boolean
  bloomF1: boolean
  /** 临时护甲与到期回合（bugv14）。 */
  armor0: number
  armor1: number
  armorUntil0: number
  armorUntil1: number
  /** 「深度思考」的额外攻击值与到期回合（bugv14）。 */
  strike0: number
  strike1: number
  strikeUntil0: number
  strikeUntil1: number
  /** 「播种」窗口（bugv14）。 */
  seed0: boolean
  seed1: boolean
  /** bugv19：低消耗档「杀鲸霸拳」的本回合植物不加伤。 */
  npb0: boolean
  npb1: boolean
  /** bugv34m：Qwen「本地部署」的窗口与本回合伤害加成。 */
  dep0: boolean
  dep1: boolean
  depB0: number
  depB1: number
  /** bugv34m：Qwen「小千问」待重新部署的棋子（`null` = 本次操作没改）。 */
  redeploy0: number[] | null
  redeploy1: number[] | null
  /** 技能冷却门槛（`null` = 本次操作没改）。 */
  ready0: number[] | null
  ready1: number[] | null
  /** 技能释放次数（`null` = 本次操作没改）。 */
  casts0: number[] | null
  casts1: number[] | null
  /** 本次落子若进入了攻击阶段：压入的上下文（撤销时弹出）。 */
  frame: AttackFrame | null
  /** 落子之后回合**没有**交出去（连下两颗：还在同一方手上）。 */
  continues: boolean
  /** 落子踩到烈焰而"碎裂"（什么都没落成）。 */
  shattered: boolean
}

/** 一次攻击阶段的上下文（攻击方连珠、高光权重、被移除的棋子）。 */
export interface AttackFrame {
  attacker: PlayerIndex
  /** 参与连珠的实体棋子（去重）。「最直接、最不绕弯子」没有连珠棋子，这里是空数组。 */
  cells: number[]
  /** 与 `cells` 平行的高光权重（该格属于几条连珠）。 */
  weights: number[]
  /** 基础伤害 = 实体棋子去重数量（assault = 消耗的植物数）。 */
  baseDamage: number
  /** bugv14「深度思考」：已经并进 `baseDamage` 的额外棋子数（仅用于展示/对齐）。 */
  strikeBonus: number
  /**
   * bugv14「深度思考」：对手没能成线反击时追加的伤害。
   *
   * ⚠️ bugv30 起**恒为 0**（第二段加成被"破盾"取代）；字段保留只为对齐真实引擎的
   * `AttackSnapshot` 字段清单。
   */
  strikeExtra: number
  /** bugv30「力大砖飞」：这一击成功造成伤害后是否清空受伤方的护盾。 */
  breakShield: boolean
  /**
   * bugv17 #4：宣告攻击时就**锁定**的攻击方植物加伤（点数，已乘 `damagePerPlant`）。
   *
   * 真实引擎在 `declareAttack()` 里就把攻击方连珠上的植物随棋子一并删掉了，
   * 因此加伤必须在那一刻锁住 —— 防守阶段再按棋盘重算会得到 0。
   */
  magicBonus: number
}

/** 一次"技能着法"（搜索用）。 */
export interface SkillMove {
  slot: number
  /** 要消耗的植物格。 */
  cells: number[]
  /** 需要目标格的技能的目标格（`-1` = 不需要）。 */
  target: number
  effect: SkillEffect
}

/**
 * 技能着法在置换表里的合成编号。
 *
 * 落子用棋盘下标（0 ~ `CELL_COUNT-1`），技能从 100 起编号，两者不会冲突：
 * `100 + slot * 200 + (target + 1)`（不需要目标时取 0）。
 */
const SKILL_MOVE_BASE = 100
function skillMoveId(slot: number, target: number): number {
  return SKILL_MOVE_BASE + slot * 200 + (target < 0 ? 0 : target + 1)
}

/** 根节点的一条"行动"（技能 或 落子）。 */
export type RootAction =
  | { kind: 'place'; cell: number }
  | { kind: 'skill'; slot: number; cells: number[]; target: number }

/** 供对拍脚本与 `GameEngine` 逐字段比对的状态快照。 */
export interface MagicSnapshot {
  plants: Array<[number, PlayerIndex | null]>
  shield: [number, number]
  bonusActions: [number, number]
  actionsTaken: [number, number]
  skillReadyAt: [number[], number[]]
  skillCasts: [number[], number[]]
  powerBonus: [number, number]
  powerUntil: [number, number]
  sabotage: [boolean, boolean]
  twinStar: [boolean, boolean]
  immuneUntil: [number, number]
  turnNo: number
  flames: Array<[number, number]>
  overlay: Array<[number, PlayerIndex]>
  sabotageBonus: [number, number]
  bloomCheaperNext: [boolean, boolean]
  /** bugv14：临时护甲与到期回合。 */
  tempArmor: [number, number]
  tempArmorUntil: [number, number]
  /** bugv14：「深度思考」的额外攻击值与到期回合。 */
  strikeBonus: [number, number]
  strikeUntil: [number, number]
  /** bugv19：低消耗档「杀鲸霸拳」——本回合植物不加伤。 */
  noPlantBonus: [boolean, boolean]
  /** bugv14：「播种」窗口。 */
  seedGrow: [boolean, boolean]
  /** bugv34m：Qwen「本地部署」的窗口与本回合伤害加成。 */
  deploy: [boolean, boolean]
  deployBonus: [number, number]
  /** bugv34m：Qwen「小千问」待重新部署的棋子（编码值：原格 * 2 + 叠子位）。 */
  redeployPending: [number[], number[]]
  /** bugv14：烈焰归属（格子 -> 主人）。 */
  flameOwner: Array<[number, number]>
}

interface TtEntry {
  depth: number
  score: number
  flag: number
  move: number
}

/**
 * 搜索引擎。
 *
 * 状态在实例里原地修改（`board` / `hp`），落子与防守都用"记录 → 撤销"的方式
 * 回滚，避免每个节点都复制棋盘。
 */
export class Searcher {
  nodes = 0
  aborted = false

  readonly root: PlayerIndex
  readonly board = new Uint8Array(CELL_COUNT)
  readonly hp: number[] = [0, 0]

  private readonly deadline: number
  /** 确定性预算：>0 时只按访问节点数收手（`now()` 完全不参与决策）。 */
  private readonly nodeLimit: number
  private readonly table = new Map<number, TtEntry>()
  private readonly history = new Int32Array(CELL_COUNT)
  private readonly killerA: number[] = [-1, -1]
  private readonly killerB: number[] = [-1, -1]
  private frames: AttackFrame[] = []
  private readonly prio = new Int32Array(CELL_COUNT)
  /** 复用的临时缓冲，避免每次算连珠都分配。 */
  private readonly tmpAll: number[] = []
  private readonly scratchCells: number[] = []
  private readonly scratchWeights: number[] = []
  /** 技能相关临时缓冲（各自独立，避免互相覆盖）。 */
  private readonly scratchPlants: number[] = []
  /** bugv20：「用不上的植物」临时数组（`sparePlants` 用）。 */
  private readonly scratchSpare: number[] = []
  private readonly scratchSab: number[] = []
  private readonly scratchFire: number[] = []
  private readonly scratchFireStones: number[] = []
  private readonly scratchFireCells: number[] = []
  private readonly scratchLineCells: number[] = []
  private readonly scratchLineWeights: number[] = []
  /** 「播种」的九宫格缓冲（bugv14）。 */
  private readonly scratchSeedRing: number[] = []
  /** bugv19 走火闸门的连珠探测缓冲（不能复用 `scratchLineCells`，会被内层搜索覆盖）。 */
  private readonly scratchGateCells: number[] = []
  private readonly scratchGateWeights: number[] = []
  /** bugv32 护甲闸门"对手成线点计数"的专用缓冲（不能复用 `scratchLineCells`）。 */
  private readonly scratchCountCells: number[] = []
  /** bugv34m「小千问」挑落点的候选缓冲。 */
  private readonly scratchRedeployLegal: number[] = []
  private readonly scratchRedeployLiked: number[] = []
  /** 棋盘上还有没有空位（「本地部署」值不值得放的闸门用）。 */
  private hasEmptyCell(): boolean {
    for (let i = 0; i < CELL_COUNT; i++) if (this.board[i] === 0) return true
    return false
  }

  // ---- 魔力植物（阶段二）----
  /**
   * 只记录**棋盘上看得见**的植物：格子 -> 归属（`null` = 无主）。
   *
   * 不模拟未来生长（不预测位置），所以不需要冷却 / 生长次数 / 落子数这些计时状态。
   * 种类（花/草/蕨）不影响任何数值，也不记录。
   */
  private readonly plants = new Map<number, PlayerIndex | null>()
  private readonly magicEnabled: boolean
  private readonly damagePerPlant: number

  // ---- 角色技能与回合状态（阶段三，与 GameEngine 对齐）----
  /** 双方技能表（索引 = `PlayerIndex`）。 */
  private readonly skills: [readonly SkillSpec[], readonly SkillSpec[]]
  /** 是否有任何技能可用（没有时所有技能逻辑短路）。 */
  private readonly skillEnabled: boolean
  /** 初始血量（回血上限）。 */
  private readonly initialHp: number
  /** 护盾：先于血量承伤，无上限。 */
  private readonly shield = [0, 0]
  /** 还能连下几颗子。 */
  private readonly bonusActions = [0, 0]
  /** 各方已行动次数（技能冷却的基准）。 */
  private readonly actionsTaken = [0, 0]
  /** 每个技能"可以再次使用"的行动次数门槛。 */
  private readonly skillReadyAt: number[][] = [[], []]
  /** 每个技能已经释放过几次（`freeFirst` 只有第一次免费）。 */
  private readonly skillCasts: number[][] = [[], []]
  /** 回合序号（每次换手 +1）。 */
  private turnNo = 0
  /** 无敌持续到第几回合。 */
  private readonly immuneUntil = [0, 0]
  /** 本回合的额外攻击值。 */
  private readonly powerBonus = [0, 0]
  /** 增伤的到期回合（bugv12 #2：「小一哥」持续 2 回合）。 */
  private readonly powerUntil = [0, 0]
  /** bugv18 #2：「猫的憩息」的槽位（受到伤害时刷新它）；-1 = 该角色没这个技能。 */
  private readonly healSlot = [-1, -1]
  /** 本回合是否可以在敌方棋子上落子。 */
  private readonly sabotage = [false, false]
  /** 本回合毒鸡蛋的额外伤害（bugv12 #3）。 */
  private readonly sabotageBonus = [0, 0]
  /** 「双子星」爆发窗口。 */
  private readonly twinStar = [false, false]
  /** 下次双子星是否减费（bugv12 #3）。 */
  private readonly bloomCheaperNext = [false, false]
  /** 临时护甲与到期回合（bugv14「精密计算」）。 */
  private readonly tempArmor = [0, 0]
  private readonly tempArmorUntil = [0, 0]
  /** 「深度思考」的额外攻击值与到期回合（bugv14）。 */
  private readonly strikeBonus = [0, 0]
  private readonly strikeUntil = [0, 0]
  /** 「播种」窗口（bugv14）。 */
  private readonly seedGrow = [false, false]
  /** bugv19：低消耗档「杀鲸霸拳」——本回合本方植物不加伤。 */
  private readonly noPlantBonus = [false, false]
  /** bugv34m：Qwen「本地部署」的窗口与本回合伤害加成。 */
  private readonly deploy = [false, false]
  private readonly deployBonus = [0, 0]
  /** bugv34m：Qwen「小千问」待重新部署的棋子（编码值：原格 * 2 + 叠子位）。 */
  private readonly redeployPending: number[][] = [[], []]
  /** bugv15：挡在我方"3 己方 + 1 敌方"窗口里的敌方棋子（火球连招的靶子）。 */
  private readonly scratchFireBlockers: number[] = []
  /** 烈焰：格子 -> 还能烧几个**半回合**（每次换手 -1）。 */
  private readonly flames = new Map<number, number>()
  /** 烈焰归属（bugv14）：格子 -> 主人（只有主人能走在自己的火上）。 */
  private readonly flameOwner = new Map<number, PlayerIndex>()
  /** 叠在敌方棋子上的额外棋子：格子 -> 叠子的一方。 */
  private readonly overlay = new Map<number, PlayerIndex>()

  constructor(
    board: Board,
    hp: readonly [number, number],
    root: PlayerIndex,
    budgetMs: number,
    magic?: AiMagicContext | null,
    skills?: AiSkillContext | null,
    nodeLimit = 0,
  ) {
    for (let i = 0; i < CELL_COUNT; i++) this.board[i] = board[i]
    this.hp[0] = hp[0]
    this.hp[1] = hp[1]
    this.root = root
    this.nodeLimit = Math.max(0, nodeLimit | 0)
    // 给了节点预算就不再设墙钟截止点 —— 否则时间仍会偷偷影响结果（破坏确定性）
    this.deadline = this.nodeLimit > 0 ? Number.POSITIVE_INFINITY : now() + Math.max(1, budgetMs)

    const plants = magic?.plants ?? null
    this.magicEnabled = plants != null && plants.length > 0
    this.damagePerPlant = magic?.damagePerPlant ?? DEFAULT_MAGIC_CONFIG.damagePerPlant
    if (plants) {
      for (let i = 0; i < plants.length; i++) this.plants.set(plants[i][0], plants[i][1])
    }

    this.skills = [skills?.skills[0] ?? [], skills?.skills[1] ?? []]
    this.healSlot[0] = this.skills[0].findIndex((spec) => spec.cooldownAdvanceOnDamage !== undefined)
    this.healSlot[1] = this.skills[1].findIndex((spec) => spec.cooldownAdvanceOnDamage !== undefined)
    this.skillEnabled = this.skills[0].length + this.skills[1].length > 0
    this.initialHp = skills?.initialHp ?? INITIAL_HP
    if (skills) {
      if (skills.shield) {
        this.shield[0] = skills.shield[0]
        this.shield[1] = skills.shield[1]
      }
      if (skills.bonusActions) {
        this.bonusActions[0] = skills.bonusActions[0]
        this.bonusActions[1] = skills.bonusActions[1]
      }
      if (skills.actionsTaken) {
        this.actionsTaken[0] = skills.actionsTaken[0]
        this.actionsTaken[1] = skills.actionsTaken[1]
      }
      for (const p of [0, 1] as PlayerIndex[]) {
        const specs = this.skills[p]
        // 冷却门槛：宿主没给就按引擎的 `initialReadyAt`（`startReady` 立刻可用）
        const ready = skills.skillReadyAt?.[p]
        this.skillReadyAt[p] = specs.map((spec, slot) =>
          ready?.[slot] ?? (spec.startReady === true ? 0 : Math.max(0, spec.cooldown)),
        )
        const casts = skills.skillCasts?.[p]
        this.skillCasts[p] = specs.map((_, slot) => casts?.[slot] ?? 0)
      }
      if (skills.powerBonus) {
        this.powerBonus[0] = skills.powerBonus[0]
        this.powerBonus[1] = skills.powerBonus[1]
      }
      if (skills.powerUntil) {
        this.powerUntil[0] = skills.powerUntil[0]
        this.powerUntil[1] = skills.powerUntil[1]
      }
      if (skills.sabotage) {
        this.sabotage[0] = skills.sabotage[0]
        this.sabotage[1] = skills.sabotage[1]
      }
      if (skills.sabotageBonus) {
        this.sabotageBonus[0] = skills.sabotageBonus[0]
        this.sabotageBonus[1] = skills.sabotageBonus[1]
      }
      if (skills.twinStar) {
        this.twinStar[0] = skills.twinStar[0]
        this.twinStar[1] = skills.twinStar[1]
      }
      if (skills.bloomCheaperNext) {
        this.bloomCheaperNext[0] = skills.bloomCheaperNext[0]
        this.bloomCheaperNext[1] = skills.bloomCheaperNext[1]
      }
      if (skills.immuneUntil) {
        this.immuneUntil[0] = skills.immuneUntil[0]
        this.immuneUntil[1] = skills.immuneUntil[1]
      }
      if (skills.tempArmor) {
        this.tempArmor[0] = skills.tempArmor[0]
        this.tempArmor[1] = skills.tempArmor[1]
      }
      if (skills.tempArmorUntil) {
        this.tempArmorUntil[0] = skills.tempArmorUntil[0]
        this.tempArmorUntil[1] = skills.tempArmorUntil[1]
      }
      if (skills.strikeBonus) {
        this.strikeBonus[0] = skills.strikeBonus[0]
        this.strikeBonus[1] = skills.strikeBonus[1]
      }
      if (skills.strikeUntil) {
        this.strikeUntil[0] = skills.strikeUntil[0]
        this.strikeUntil[1] = skills.strikeUntil[1]
      }
      if (skills.seedGrow) {
        this.seedGrow[0] = skills.seedGrow[0]
        this.seedGrow[1] = skills.seedGrow[1]
      }
      if (skills.noPlantBonus) {
        this.noPlantBonus[0] = skills.noPlantBonus[0]
        this.noPlantBonus[1] = skills.noPlantBonus[1]
      }
      // bugv34m：Qwen 的两个技能状态
      if (skills.deploy) {
        this.deploy[0] = skills.deploy[0]
        this.deploy[1] = skills.deploy[1]
      }
      if (skills.deployBonus) {
        this.deployBonus[0] = skills.deployBonus[0]
        this.deployBonus[1] = skills.deployBonus[1]
      }
      for (const p of [0, 1] as PlayerIndex[]) {
        const pending = skills.redeployPending?.[p]
        if (pending) for (const code of pending) this.redeployPending[p].push(code)
      }
      this.turnNo = skills.turnNo ?? 0
      for (const entry of skills.flames ?? []) this.flames.set(entry[0], entry[1])
      for (const entry of skills.flameOwner ?? []) this.flameOwner.set(entry[0], entry[1] as PlayerIndex)
      for (const entry of skills.overlay ?? []) this.overlay.set(entry[0], entry[1] as PlayerIndex)
    }
  }

  // -------------------------------------------------------------------------
  // 撤销记录（差分 + 标量快照）
  // -------------------------------------------------------------------------

  /** 开一份撤销记录：快照全部小标量。 */
  private beginUndo(): Undo {
    return {
      diff: [],
      hp0: this.hp[0],
      hp1: this.hp[1],
      shield0: this.shield[0],
      shield1: this.shield[1],
      bonus0: this.bonusActions[0],
      bonus1: this.bonusActions[1],
      acted0: this.actionsTaken[0],
      acted1: this.actionsTaken[1],
      turnNo: this.turnNo,
      immune0: this.immuneUntil[0],
      immune1: this.immuneUntil[1],
      power0: this.powerBonus[0],
      power1: this.powerBonus[1],
      powerUntil0: this.powerUntil[0],
      powerUntil1: this.powerUntil[1],
      sab0: this.sabotage[0],
      sab1: this.sabotage[1],
      sabB0: this.sabotageBonus[0],
      sabB1: this.sabotageBonus[1],
      twin0: this.twinStar[0],
      twin1: this.twinStar[1],
      bloomF0: this.bloomCheaperNext[0],
      bloomF1: this.bloomCheaperNext[1],
      armor0: this.tempArmor[0],
      armor1: this.tempArmor[1],
      armorUntil0: this.tempArmorUntil[0],
      armorUntil1: this.tempArmorUntil[1],
      strike0: this.strikeBonus[0],
      strike1: this.strikeBonus[1],
      strikeUntil0: this.strikeUntil[0],
      strikeUntil1: this.strikeUntil[1],
      seed0: this.seedGrow[0],
      seed1: this.seedGrow[1],
      npb0: this.noPlantBonus[0],
      npb1: this.noPlantBonus[1],
      dep0: this.deploy[0],
      dep1: this.deploy[1],
      depB0: this.deployBonus[0],
      depB1: this.deployBonus[1],
      redeploy0: null,
      redeploy1: null,
      ready0: null,
      ready1: null,
      casts0: null,
      casts1: null,
      frame: null,
      continues: false,
      shattered: false,
    }
  }

  /** 还原一份撤销记录（`diff` **逆序**还原，保证同格多次改动也能回到最初值）。 */
  private endUndo(u: Undo): void {
    const d = u.diff
    for (let i = d.length - 3; i >= 0; i -= 3) {
      const kind = d[i]
      const cell = d[i + 1]
      const value = d[i + 2]
      if (kind === DIFF_BOARD) this.board[cell] = value
      else if (kind === DIFF_PLANT) {
        if (value === PLANT_ABSENT) this.plants.delete(cell)
        else this.plants.set(cell, value === PLANT_NEUTRAL ? null : (value as PlayerIndex))
      } else if (kind === DIFF_FLAME) {
        if (value === -1) this.flames.delete(cell)
        else this.flames.set(cell, value)
      } else if (kind === DIFF_FLAME_OWNER) {
        if (value === -1) this.flameOwner.delete(cell)
        else this.flameOwner.set(cell, value as PlayerIndex)
      } else if (value === -1) this.overlay.delete(cell)
      else this.overlay.set(cell, value as PlayerIndex)
    }
    this.hp[0] = u.hp0
    this.hp[1] = u.hp1
    this.shield[0] = u.shield0
    this.shield[1] = u.shield1
    this.bonusActions[0] = u.bonus0
    this.bonusActions[1] = u.bonus1
    this.actionsTaken[0] = u.acted0
    this.actionsTaken[1] = u.acted1
    this.turnNo = u.turnNo
    this.immuneUntil[0] = u.immune0
    this.immuneUntil[1] = u.immune1
    this.powerBonus[0] = u.power0
    this.powerBonus[1] = u.power1
    this.powerUntil[0] = u.powerUntil0
    this.powerUntil[1] = u.powerUntil1
    this.sabotage[0] = u.sab0
    this.sabotage[1] = u.sab1
    this.sabotageBonus[0] = u.sabB0
    this.sabotageBonus[1] = u.sabB1
    this.twinStar[0] = u.twin0
    this.twinStar[1] = u.twin1
    this.bloomCheaperNext[0] = u.bloomF0
    this.bloomCheaperNext[1] = u.bloomF1
    this.tempArmor[0] = u.armor0
    this.tempArmor[1] = u.armor1
    this.tempArmorUntil[0] = u.armorUntil0
    this.tempArmorUntil[1] = u.armorUntil1
    this.strikeBonus[0] = u.strike0
    this.strikeBonus[1] = u.strike1
    this.strikeUntil[0] = u.strikeUntil0
    this.strikeUntil[1] = u.strikeUntil1
    this.seedGrow[0] = u.seed0
    this.seedGrow[1] = u.seed1
    this.noPlantBonus[0] = u.npb0
    this.noPlantBonus[1] = u.npb1
    this.deploy[0] = u.dep0
    this.deploy[1] = u.dep1
    this.deployBonus[0] = u.depB0
    this.deployBonus[1] = u.depB1
    if (u.redeploy0) this.restoreSkillArray(this.redeployPending[0], u.redeploy0)
    if (u.redeploy1) this.restoreSkillArray(this.redeployPending[1], u.redeploy1)
    if (u.ready0) this.restoreSkillArray(this.skillReadyAt[0], u.ready0)
    if (u.ready1) this.restoreSkillArray(this.skillReadyAt[1], u.ready1)
    if (u.casts0) this.restoreSkillArray(this.skillCasts[0], u.casts0)
    if (u.casts1) this.restoreSkillArray(this.skillCasts[1], u.casts1)
    // 本次落子进入过攻击阶段 → 弹出它的上下文
    if (u.frame) this.frames.pop()
  }

  private restoreSkillArray(target: number[], snapshot: number[]): void {
    target.length = snapshot.length
    for (let i = 0; i < snapshot.length; i++) target[i] = snapshot[i]
  }

  // ---- 差分写入（记录原值后再改） ----

  private writeBoard(cell: number, value: number, u: Undo): void {
    u.diff.push(DIFF_BOARD, cell, this.board[cell])
    this.board[cell] = value
  }

  private writePlant(cell: number, owner: PlayerIndex | null, u: Undo): void {
    const cur = this.plants.get(cell)
    u.diff.push(
      DIFF_PLANT,
      cell,
      cur === undefined ? PLANT_ABSENT : cur === null ? PLANT_NEUTRAL : cur,
    )
    this.plants.set(cell, owner)
  }

  private removePlant(cell: number, u: Undo): void {
    const cur = this.plants.get(cell)
    if (cur === undefined) return
    u.diff.push(DIFF_PLANT, cell, cur === null ? PLANT_NEUTRAL : cur)
    this.plants.delete(cell)
  }

  private writeFlame(cell: number, value: number, u: Undo): void {
    const cur = this.flames.get(cell)
    u.diff.push(DIFF_FLAME, cell, cur === undefined ? -1 : cur)
    this.flames.set(cell, value)
  }

  /** 写烈焰归属（bugv14）。与 `writeFlame` 分开记，两张表各自精确回滚。 */
  private writeFlameOwner(cell: number, owner: PlayerIndex, u: Undo): void {
    const cur = this.flameOwner.get(cell)
    u.diff.push(DIFF_FLAME_OWNER, cell, cur === undefined ? -1 : cur)
    this.flameOwner.set(cell, owner)
  }

  /** 清掉一条烈焰（剩余回合 + 归属）。 */
  private removeFlameCell(cell: number, u: Undo): void {
    const cur = this.flames.get(cell)
    if (cur !== undefined) {
      u.diff.push(DIFF_FLAME, cell, cur)
      this.flames.delete(cell)
    }
    const owner = this.flameOwner.get(cell)
    if (owner !== undefined) {
      u.diff.push(DIFF_FLAME_OWNER, cell, owner)
      this.flameOwner.delete(cell)
    }
  }

  private writeOverlay(cell: number, owner: PlayerIndex, u: Undo): void {
    const cur = this.overlay.get(cell)
    u.diff.push(DIFF_OVERLAY, cell, cur === undefined ? -1 : cur)
    this.overlay.set(cell, owner)
  }

  private removeOverlay(cell: number, u: Undo): void {
    const cur = this.overlay.get(cell)
    if (cur === undefined) return
    u.diff.push(DIFF_OVERLAY, cell, cur)
    this.overlay.delete(cell)
  }

  // -------------------------------------------------------------------------
  // 回合生命周期（与 GameEngine 的 beginTurn / finishTurn / expireImmunity 对齐）
  // -------------------------------------------------------------------------

  /** 开启 `player` 的新回合：回合序号 +1、无敌到期结算、"仅本回合"效果清空。 */
  private beginTurn(player: PlayerIndex): void {
    this.turnNo += 1
    this.expireImmunity()
    this.expireTempArmor()
    this.clearTurnEffects(other(player))
  }

  /** 临时护甲到期（bugv14）：未用完的也一起清零。 */
  private expireTempArmor(): void {
    for (const p of [0, 1] as PlayerIndex[]) {
      if (this.tempArmorUntil[p] > 0 && this.tempArmorUntil[p] <= this.turnNo) {
        this.tempArmorUntil[p] = 0
        this.tempArmor[p] = 0
      }
    }
  }

  /**
   * 清掉某一方**已到期**的回合内效果（增伤 / 叠子 / 双子星）。
   *
   * bugv12 #2：「小一哥」可跨回合持续，所以增伤必须按 `powerUntil` 判断是否到期，
   * 不能无条件清 —— 否则"持续 2 回合"根本活不过第一个回合结束。
   */
  /** bugv18 #2：「小一哥」是否正在生效（生效期间不能重复释放）。 */
  private powerActive(player: PlayerIndex): boolean {
    return this.powerBonus[player] !== 0 && this.powerUntil[player] > this.turnNo
  }

  /** bugv30：「力大砖飞」是否正在生效（加成还没被"首个连珠攻击"取走、且没过期）。 */
  private strikeActive(player: PlayerIndex): boolean {
    return this.strikeBonus[player] > 0 && this.strikeUntil[player] > this.turnNo
  }

  /** bugv30：这一方有没有带 `breakShield` 的 `firstStrike`（「力大砖飞」）。 */
  private strikeBreaksShield(player: PlayerIndex): boolean {
    return this.skills[player].some((spec) => spec.effect === 'firstStrike' && spec.breakShield === true)
  }

  /**
   * bugv18 #2「小一哥」：每形成一次连珠，持续时间消耗 2 回合。
   *
   * ⚠️ 只动 `powerUntil`（剩余时间），**不动 `powerBonus`** ——
   * 这样"这一击"的加伤不受影响（已锁进 `AttackFrame`），只是后续回合更早到期。
   */
  private decayPower(player: PlayerIndex): void {
    if (this.powerUntil[player] > this.turnNo) {
      this.powerUntil[player] = Math.max(this.turnNo, this.powerUntil[player] - 2)
    }
  }

  /**
   * 一次连珠宣告（与引擎的 `noteMatch` 对齐）：扣「小一哥」持续时间 +
   * bugv34m「本地部署」的**被动**（连珠上有几棵魔力植物就削多少剩余冷却）。
   *
   * ⚠️ 会改 `skillReadyAt`，所以必须先给撤销记录拍一份快照。
   */
  private noteMatch(player: PlayerIndex, cells: readonly number[], u: Undo): void {
    this.decayPower(player)
    let plants = 0
    for (let i = 0; i < cells.length; i++) if (this.plants.has(cells[i])) plants += 1
    if (plants <= 0) return
    const specs = this.skills[player]
    for (let slot = 0; slot < specs.length; slot++) {
      const spec = specs[slot]
      if (spec.effect !== 'localDeploy' || spec.cooldownCutOnMatchPlants !== true) continue
      const remaining = this.skillReadyAt[player][slot] - this.actionsTaken[player]
      if (remaining <= 0) continue
      // ⚠️ 必须在改之前拍照，否则撤销还原回去的是"已经削过"的值
      if (player === 0) u.ready0 = u.ready0 ?? [...this.skillReadyAt[0]]
      else u.ready1 = u.ready1 ?? [...this.skillReadyAt[1]]
      this.skillReadyAt[player][slot] -= Math.min(plants, remaining)
    }
  }

  private clearTurnEffects(player: PlayerIndex): void {    if (this.powerUntil[player] <= this.turnNo) {
      this.powerBonus[player] = 0
      this.powerUntil[player] = 0
    }
    this.sabotage[player] = false
    this.sabotageBonus[player] = 0
    this.twinStar[player] = false
    // bugv14「播种」窗口只在本回合有效；「深度思考」按 strikeUntil 判断到期
    this.seedGrow[player] = false
    // bugv34m：「本地部署」的窗口 / 加伤与「小千问」的待部署表也只在本回合有效
    this.deploy[player] = false
    this.deployBonus[player] = 0
    this.redeployPending[player].length = 0
    // bugv19：「杀鲸霸拳」低消耗档的"植物不加伤"也只在本回合有效
    this.noPlantBonus[player] = false
    if (this.strikeUntil[player] <= this.turnNo) {
      this.strikeBonus[player] = 0
      this.strikeUntil[player] = 0
    }
  }

  /** 无敌到期（回合已经交出：`turnNo` 追平 `immuneUntil`。「精密计算」只保护当前回合）。 */
  private expireImmunity(): void {
    for (const p of [0, 1] as PlayerIndex[]) {
      if (this.immuneUntil[p] > 0 && !this.isImmune(p)) this.immuneUntil[p] = 0
    }
  }

  /** 这一方此刻是否处于无敌。 */
  private isImmune(player: PlayerIndex): boolean {
    return this.immuneUntil[player] > this.turnNo
  }

  /** 这一方此刻是否**完全免疫伤害**（无敌 or 双子星爆发窗口）。 */
  private isDamageImmune(player: PlayerIndex): boolean {
    return this.isImmune(player) || this.twinStar[player]
  }

  /** 烈焰：每换手一次递减 1（内部按"半回合"存）。 */
  private tickFlames(undo?: Undo): void {
    if (this.flames.size === 0) return
    const expired: number[] = []
    for (const [cell, left] of this.flames) {
      const next = left - 1
      if (next <= 0) {
        if (undo) this.removeFlameCell(cell, undo)
        else {
          this.flames.delete(cell)
          // bugv14：烈焰熄灭时归属一起清掉（两张表必须严格同步）
          this.flameOwner.delete(cell)
        }
        expired.push(cell)
      } else if (undo) {
        this.writeFlame(cell, next, undo)
      } else this.flames.set(cell, next)
    }
    void expired
  }

  /** 扣血：承伤顺序与 GameEngine 一致（bugv14：临时护甲 → 护盾 → 血量）。 */
  private applyDamage(player: PlayerIndex, amount: number): void {
    if (amount <= 0) return
    // bugv18 #2「猫的憩息」：受到伤害后冷却前进（护甲 / 护盾全挡下也算）。
    // bugv24：由"立即清零"改为前进 `cooldownAdvanceOnDamage` 手（gemini 现为 2 手）。
    const hs = this.healSlot[player]
    if (hs >= 0) {
      const advance = this.skills[player][hs].cooldownAdvanceOnDamage ?? 0
      const readyAt = this.skillReadyAt[player][hs]
      if (readyAt > this.actionsTaken[player]) {
        this.skillReadyAt[player][hs] = Math.max(this.actionsTaken[player], readyAt - advance)
      }
    }
    let remaining = amount
    const armor = this.tempArmor[player]
    if (armor > 0) {
      const absorbed = Math.min(armor, remaining)
      this.tempArmor[player] = armor - absorbed
      remaining -= absorbed
    }
    if (remaining <= 0) return
    const shield = this.shield[player]
    if (shield > 0) {
      const absorbed = Math.min(shield, remaining)
      this.shield[player] = shield - absorbed
      remaining -= absorbed
    }
    if (remaining <= 0) return
    this.hp[player] -= remaining
  }

  /** `cell` 对 `player` 算不算己方棋子（含叠子，与 `makeOwned` 一致）。 */
  private ownedAt(cell: number, player: PlayerIndex): boolean {
    if (this.board[cell] === player + 1) return true
    return this.overlay.size > 0 && this.overlay.get(cell) === player
  }

  /**
   * `cell` 周围 8 格里属于 `player` 的棋子数（bugv15，评估用）。
   *
   * 用来判断一棵**中立**植物"多半会落到谁手里"：紧挨我方棋子的中立植物，
   * 我方下一步顺手就能站上去接手（「播种」长出来的那一圈正是这种）。
   */
  private stonesAround(cell: number, player: PlayerIndex): number {
    const base = cell * NB_STRIDE
    let n = 0
    for (let k = 0; k < 8; k++) {
      const nb = NB24[base + k]
      if (nb >= 0 && this.ownedAt(nb, player)) n += 1
    }
    return n
  }

  // -------------------------------------------------------------------------
  // 魔力植物（与 GameEngine 的 place / clearMagicAt / attackValue 对齐）
  // -------------------------------------------------------------------------

  /** `cells` 里归 `owner` 所有的植物数量（= 伤害加成点数）。 */
  private plantsOn(cells: readonly number[], owner: PlayerIndex): number {
    if (!this.magicEnabled) return 0
    let n = 0
    for (let i = 0; i < cells.length; i++) {
      if (this.plants.get(cells[i]) === owner) n += 1
    }
    return n
  }

  /** 某一方场上被自己棋子占用的植物格（技能消耗的就是这些），按下标升序。 */
  private ownedPlantCells(player: PlayerIndex, out: number[]): number[] {
    out.length = 0
    if (!this.magicEnabled) return out
    for (const [cell, owner] of this.plants) if (owner === player) out.push(cell)
    out.sort((a, b) => a - b)
    return out
  }

  /** 攻击方最终攻击值（规则 2.5 + 植物加成）。 */
  private finalAttackValue(baseDamage: number, weakness: number, magicBonus: number): number {
    return Math.max(MIN_ATTACK_VALUE, baseDamage + Math.max(0, magicBonus) - weakness)
  }

  /**
   * 攻击值 = 最终攻击值 + 「小一哥」增伤 + 「毒鸡蛋」增伤 + 「本地部署」加伤
   * （与引擎的 `attackValue` 一致）。
   */
  private attackValue(
    baseDamage: number,
    weakness: number,
    magicBonus: number,
    attacker: PlayerIndex,
  ): number {
    // bugv19：低消耗档「杀鲸霸拳」生效时，本方植物一律不加伤
    const bonus = this.noPlantBonus[attacker] ? 0 : magicBonus
    return (
      this.finalAttackValue(baseDamage, weakness, bonus) +
      this.powerBonus[attacker] +
      this.sabotageBonus[attacker] +
      this.deployBonus[attacker]
    )
  }

  /** 仅供对拍 / 调试：导出状态快照。生产代码不要调用。 */
  magicSnapshot(): MagicSnapshot {
    const plants: Array<[number, PlayerIndex | null]> = []
    for (const [cell, owner] of this.plants) plants.push([cell, owner])
    plants.sort((a, b) => a[0] - b[0])
    const flames: Array<[number, number]> = []
    for (const [cell, left] of this.flames) flames.push([cell, left])
    flames.sort((a, b) => a[0] - b[0])
    const overlay: Array<[number, PlayerIndex]> = []
    for (const [cell, owner] of this.overlay) overlay.push([cell, owner])
    overlay.sort((a, b) => a[0] - b[0])
    // bugv14：烈焰归属也要逐字段对齐（谁的火谁能走）
    const flameOwner: Array<[number, number]> = []
    for (const [cell, owner] of this.flameOwner) flameOwner.push([cell, owner])
    flameOwner.sort((a, b) => a[0] - b[0])
    return {
      plants,
      shield: [this.shield[0], this.shield[1]],
      bonusActions: [this.bonusActions[0], this.bonusActions[1]],
      actionsTaken: [this.actionsTaken[0], this.actionsTaken[1]],
      skillReadyAt: [[...this.skillReadyAt[0]], [...this.skillReadyAt[1]]],
      skillCasts: [[...this.skillCasts[0]], [...this.skillCasts[1]]],
      powerBonus: [this.powerBonus[0], this.powerBonus[1]],
      powerUntil: [this.powerUntil[0], this.powerUntil[1]],
      sabotage: [this.sabotage[0], this.sabotage[1]],
      twinStar: [this.twinStar[0], this.twinStar[1]],
      immuneUntil: [this.immuneUntil[0], this.immuneUntil[1]],
      turnNo: this.turnNo,
      flames,
      overlay,
      sabotageBonus: [this.sabotageBonus[0], this.sabotageBonus[1]],
      bloomCheaperNext: [this.bloomCheaperNext[0], this.bloomCheaperNext[1]],
      tempArmor: [this.tempArmor[0], this.tempArmor[1]],
      tempArmorUntil: [this.tempArmorUntil[0], this.tempArmorUntil[1]],
      strikeBonus: [this.strikeBonus[0], this.strikeBonus[1]],
      strikeUntil: [this.strikeUntil[0], this.strikeUntil[1]],
      seedGrow: [this.seedGrow[0], this.seedGrow[1]],
      noPlantBonus: [this.noPlantBonus[0], this.noPlantBonus[1]],
      deploy: [this.deploy[0], this.deploy[1]],
      deployBonus: [this.deployBonus[0], this.deployBonus[1]],
      redeployPending: [[...this.redeployPending[0]], [...this.redeployPending[1]]],
      flameOwner,
    }
  }

  private timeUp(): boolean {
    // 确定性预算：只看节点数（与机器快慢、并发负载完全无关）
    if (this.nodeLimit > 0) return this.nodes >= this.nodeLimit
    return now() > this.deadline
  }

  // -------------------------------------------------------------------------
  // 规则核（与 GameEngine 对齐）
  // -------------------------------------------------------------------------

  /**
   * 计算经过 `cell` 的极大连珠（`minLen` 起算），填充 `outCells`（去重）与
   * `outWeights`（该格属于几条连珠），返回连珠条数。
   *
   * ⚠️ 一律用 `ownedAt()` 判定"己方棋子"：叠子（毒鸡蛋）对**双方**都算己方棋子，
   * 所以不能只看 `board`。
   */
  private computeMatch(
    cell: number,
    player: PlayerIndex,
    minLen: number,
    outCells: number[],
    outWeights: number[],
  ): number {
    const row = (cell / BOARD_SIZE) | 0
    const col = cell % BOARD_SIZE
    const all = this.tmpAll
    all.length = 0
    let lines = 0

    for (let d = 0; d < 4; d++) {
      const dr = DIRS[d][0]
      const dc = DIRS[d][1]
      let length = 1
      let r = row - dr
      let c = col - dc
      while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && this.ownedAt(r * BOARD_SIZE + c, player)) {
        length += 1
        r -= dr
        c -= dc
      }
      const startR = r + dr
      const startC = c + dc
      r = row + dr
      c = col + dc
      while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && this.ownedAt(r * BOARD_SIZE + c, player)) {
        length += 1
        r += dr
        c += dc
      }
      if (length < minLen) continue
      lines += 1
      r = startR
      c = startC
      for (let k = 0; k < length; k++) {
        all.push(r * BOARD_SIZE + c)
        r += dr
        c += dc
      }
    }

    outCells.length = 0
    outWeights.length = 0
    for (let i = 0; i < all.length; i++) {
      const index = all[i]
      const at = outCells.indexOf(index)
      if (at >= 0) outWeights[at] += 1
      else {
        outCells.push(index)
        outWeights.push(1)
      }
    }
    return lines
  }

  /**
   * 全盘扫描 `player` 的极大连珠（与引擎的 `findLines` **完全一致**）。
   *
   * 为什么不能只看"经过落点的那条线"：盘上可能本来就有一条**已经成线、却还没结算**
   * 的线 —— 例如「杀鲸霸拳」连下两颗时，第一颗成的线要等两颗都下完才结算；
   * 又例如「毒鸡蛋」叠子对双方都算己方棋子。这些情况只有整盘扫才看得见。
   *
   * 为了速度，这里把归属判断内联展开（不调用 `ownedAt`）。
   */
  private computeMatchAll(
    player: PlayerIndex,
    minLen: number,
    outCells: number[],
    outWeights: number[],
  ): number {
    const target = player + 1
    const board = this.board
    const overlay = this.overlay
    const hasOverlay = overlay.size > 0
    const all = this.tmpAll
    all.length = 0
    let lines = 0

    for (let d = 0; d < 4; d++) {
      const dr = DIRS[d][0]
      const dc = DIRS[d][1]
      for (let row = 0; row < BOARD_SIZE; row++) {
        for (let col = 0; col < BOARD_SIZE; col++) {
          const cell = row * BOARD_SIZE + col
          if (board[cell] !== target && !(hasOverlay && overlay.get(cell) === player)) continue
          // 只从极大连珠的起点开始扫描
          if (row - dr >= 0 && row - dr < BOARD_SIZE && col - dc >= 0 && col - dc < BOARD_SIZE) {
            const prev = (row - dr) * BOARD_SIZE + (col - dc)
            if (board[prev] === target || (hasOverlay && overlay.get(prev) === player)) continue
          }
          let length = 0
          let r = row
          let c = col
          while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE) {
            const idx = r * BOARD_SIZE + c
            if (board[idx] !== target && !(hasOverlay && overlay.get(idx) === player)) break
            all.push(idx)
            length += 1
            r += dr
            c += dc
          }
          if (length >= minLen) lines += 1
          else all.length -= length
        }
      }
    }

    outCells.length = 0
    outWeights.length = 0
    for (let i = 0; i < all.length; i++) {
      const index = all[i]
      const at = outCells.indexOf(index)
      if (at >= 0) outWeights[at] += 1
      else {
        outCells.push(index)
        outWeights.push(1)
      }
    }
    return lines
  }

  /** 落子之后判定连珠 —— 一律按引擎口径整盘扫。 */
  private matchAfterPlace(
    player: PlayerIndex,
    minLen: number,
    outCells: number[],
    outWeights: number[],
  ): number {
    return this.computeMatchAll(player, minLen, outCells, outWeights)
  }

  /** 落子（含"叠在敌方棋子上"与"抢占该格植物"），与引擎的 `place()` 对齐。 */
  private placeStone(cell: number, player: PlayerIndex, u: Undo): void {
    // 毒鸡蛋：叠在敌方棋子上 —— 原棋子留下，额外一颗记在 overlay
    if (this.board[cell] !== 0) {
      this.writeOverlay(cell, player, u)
      // bugv17 #10：叠子后这一格也有我的棋子 → 植物归我（原归属方被抢）
      this.reconcilePlantOwner(cell, u)
      return
    }
    this.writeBoard(cell, player + 1, u)
    // 这一格有植物且不属于自己 → 归落子方（含"抢"）
    if (this.magicEnabled) {
      const owner = this.plants.get(cell)
      if (owner !== undefined && owner !== player) this.writePlant(cell, player, u)
    }
  }

  /** 落子之后推进回合（碎裂时用：这一手什么都没落成）。返回是否"还在同一方手上"。 */
  private endTurnAfterAction(player: PlayerIndex, u: Undo): boolean {
    if (this.bonusActions[player] > 0) {
      this.bonusActions[player] -= 1
      this.beginTurn(player)
      return true
    }
    this.finishTurn(player, u)
    return false
  }

  /**
   * 这一方**能不能**把棋子落在这格上（bugv14 烈焰归属）。
   *
   * - 没有烈焰 → 可以；
   * - 有烈焰且**主人就是自己** → 可以（不碎裂，改为受 `FLAME_WALK_DAMAGE` 点伤害）；
   * - 别人的火 → 不可以（落上去会碎裂，等于白费一手）。
   */
  private blockedByFlame(cell: number, player: PlayerIndex): boolean {
    return this.flames.has(cell) && this.flameOwner.get(cell) !== player
  }

  /** 对手在这格落子就会立刻成线（并且对手落得下去）。 */
  private isFoeMatchCell(cell: number, player: PlayerIndex): boolean {
    const foe = other(player)
    if (this.blockedByFlame(cell, foe)) return false // 对手进不来，谈不上"挡住"
    return this.computeMatch(cell, foe, MIN_LINE_LENGTH, this.scratchGateCells, this.scratchGateWeights) > 0
  }

  /**
   * bugv19 走火闸门：这一手落在**自己的烈焰**上是不是纯白走？
   *
   * `true` = 花 1 点血只换到一个普通落点 → 不该进候选集。
   * 只有两种情况放行：① 当场成线（发起攻击）；② 挡住对手的必杀。
   *
   * 动机见 `GATE_OWN_FLAME_WALK` 的注释：AI 把"踏进自己的火"当成了常规落点，
   * 2/3 是白走，每局自伤 ~7.5 点（gtp 只有 8 点血）。
   */
  private wastefulFlameWalk(cell: number, player: PlayerIndex): boolean {
    if (!GATE_OWN_FLAME_WALK) return false
    if (!this.flames.has(cell)) return false
    if (this.flameOwner.get(cell) !== player) return false
    // ① 当场成线 → 这 1 点血是攻击的门票，值
    if (this.computeMatch(cell, player, MIN_LINE_LENGTH, this.scratchGateCells, this.scratchGateWeights) > 0) {
      return false
    }
    // ② 挡住对手的一步成线
    if (this.isFoeMatchCell(cell, player)) return false
    return true
  }

  /** 正常换手（引擎的 `finishTurn`）。 */
  private finishTurn(player: PlayerIndex, u: Undo): void {
    this.beginTurn(other(player))
    this.tickFlames(u)
  }

  /**
   * 宣告攻击：移除连珠棋子（叠子只飞走上面那颗）、压入攻击上下文、推进烈焰。
   *
   * bugv17 #4：被破坏的棋子上的植物**在同一时刻**一并破坏（真实引擎的 `clearMagicAt(crushed)`），
   * 而且攻击方的植物加伤在**这里**就锁进 `AttackFrame.magicBonus`。
   */
  private declareAttack(
    attacker: PlayerIndex,
    cells: readonly number[],
    weights: readonly number[],
    u: Undo,
  ): AttackFrame {
    const frameCells = [...cells]
    const frameWeights = [...weights]
    // 宣告时的加伤快照（此时植物都还在棋盘上，之后防守方可能抢走其中一棵）
    const magicBonus = this.plantsOn(frameCells, attacker) * this.damagePerPlant
    for (let i = 0; i < frameCells.length; i++) {
      const cell = frameCells[i]
      if (this.overlay.get(cell) === attacker) {
        this.removeOverlay(cell, u)
        // 叠子飞走、底下原棋子还留着 → 植物归属回到底下那颗棋子的主人
        this.reconcilePlantOwner(cell, u)
        continue
      }
      if (this.board[cell] !== 0) {
        this.writeBoard(cell, 0, u)
        // bugv18 #1：**先不删植物** —— 它们是防守方的抢夺窗口，留到防守方落子之后再清
      }
    }
    // bugv14「深度思考」：只对**首个连珠攻击**生效，取走即清零
    const strike = this.takeStrike(attacker)
    const frame: AttackFrame = {
      attacker,
      cells: frameCells,
      weights: frameWeights,
      baseDamage: frameWeights.length + strike,
      strikeBonus: strike,
      // bugv30：不再有"对手没能成线反击再加伤"的第二段
      strikeExtra: 0,
      breakShield: strike > 0 && this.strikeBreaksShield(attacker),
      magicBonus,
    }
    this.frames.push(frame)
    // 宣告攻击也算"这一方走过一步"：烈焰按半回合递减
    this.tickFlames(u)
    return frame
  }

  /** 让该格植物的归属与"压在上面的棋子"一致（真实引擎 `reconcilePlantOwner`）。 */
  private reconcilePlantOwner(cell: number, u: Undo): void {
    if (!this.magicEnabled) return
    const plantOwner = this.plants.get(cell)
    if (plantOwner === undefined) return
    const stacked = this.overlay.get(cell)
    const base = this.board[cell]
    const owner: PlayerIndex | null = stacked !== undefined ? stacked : base !== 0 ? ((base - 1) as PlayerIndex) : null
    if (plantOwner === owner) return
    this.writePlant(cell, owner, u)
  }

  /**
   * 「最直接、最不绕弯子」（bugv14）：跳过落子直接进入攻击阶段。
   *
   * 攻击值 = 消耗的植物数量（`count`），没有连珠棋子；引擎里这条路径**不**削减
   * 魔力植物的生长冷却（它压根不是连珠），这里也一并对齐。
   */
  private declareAssault(attacker: PlayerIndex, count: number, u: Undo): AttackFrame {
    const strike = this.takeStrike(attacker)
    const frame: AttackFrame = {
      attacker,
      cells: [],
      weights: [],
      baseDamage: count + strike,
      strikeBonus: strike,
      strikeExtra: 0,
      breakShield: strike > 0 && this.strikeBreaksShield(attacker),
      magicBonus: 0,
    }
    this.frames.push(frame)
    this.tickFlames(u)
    return frame
  }

  /**
   * 取出「力大砖飞」（原「深度思考」）的加成。只对首个连珠攻击生效 → 取走即清零。
   *
   * bugv30：返回加进基础攻击值的点数即可 —— "对手没能成线反击再加 1" 的第二段已取消。
   */
  private takeStrike(player: PlayerIndex): number {
    if (this.strikeBonus[player] <= 0 || this.strikeUntil[player] <= this.turnNo) return 0
    const bonus = this.strikeBonus[player]
    this.strikeBonus[player] = 0
    this.strikeUntil[player] = 0
    return bonus
  }

  /** 移除防守方连珠棋子（不留高光，叠子只移走上面那颗）。 */
  private removeDetached(cells: readonly number[], owner: PlayerIndex, u: Undo): void {
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]
      if (this.overlay.get(cell) === owner) {
        this.removeOverlay(cell, u)
        // bugv17 #4：叠子飞走、底下原棋子还留着 → 植物归属回到底下那颗
        this.reconcilePlantOwner(cell, u)
        continue
      }
      if (this.board[cell] === owner + 1) {
        this.writeBoard(cell, 0, u)
        // bugv17 #4：被破坏的棋子上的植物一并破坏（与真实引擎同一个时刻）
        this.removePlant(cell, u)
      }
    }
  }

  /**
   * 普通回合落子（忠实复刻 `GameEngine.commit`）。
   *
   * - `Undo.frame` 非空 = 进入了攻击阶段（连珠棋子已移除、留高光）；
   * - `Undo.continues` = 落子之后回合**没有**交出去（连下两颗）；
   * - `Undo.shattered` = 踩到烈焰、这一手什么都没落成。
   */
  applyPlace(cell: number, player: PlayerIndex): Undo {
    const u = this.beginUndo()

    // 烈焰：棋子还没成形就被烧裂，行动作废。
    // bugv14：**这批烈焰的主人**可以走在自己的火上 —— 不碎裂，改为受 1 点伤害。
    const onOwnFlame = this.flames.has(cell) && this.flameOwner.get(cell) === player
    if (this.flames.has(cell) && !onOwnFlame) {
      u.shattered = true
      this.actionsTaken[player] += 1
      u.continues = this.endTurnAfterAction(player, u)
      return u
    }

    this.placeStone(cell, player, u)
    this.actionsTaken[player] += 1
    // bugv14：走火要扣 1 点（临时护甲 / 护盾先吸收）
    if (onOwnFlame) this.applyDamage(player, FLAME_WALK_DAMAGE)
    if (this.hp[player] <= 0) return u

    const cells = this.scratchCells
    const weights = this.scratchWeights
    const lines = this.matchAfterPlace(player, MIN_LINE_LENGTH, cells, weights)

    // 双子星的两连判定（只在需要时算，避免多余开销）
    const twinLines =
      lines === 0 && this.twinStar[player]
        ? this.computeMatch(cell, player, TWIN_STAR_LINE_LENGTH, this.scratchLineCells, this.scratchLineWeights)
        : 0

    // bugv18 #2：形成连珠 → 「小一哥」剩余持续时间 -2
    // bugv34m：同时结算「本地部署」被动的冷却削减（与引擎的 noteMatch 对齐）
    if (lines > 0 || twinLines > 0) {
      this.noteMatch(player, lines > 0 ? cells : this.scratchLineCells, u)
    }

    // bugv14「播种」：落子**未成连珠** → 落点周围长出魔力植物（本回合只触发一次）
    // bugv34m「本地部署」：同样只在未成连珠时触发，但只长**落点这一格**
    if (lines === 0 && twinLines === 0) {
      this.triggerSeedGrow(player, cell, u)
      this.triggerLocalDeploy(player, cell, u)
    }

    // 连下两颗：即使这一颗已经成线，也先不进入攻击阶段（防守方此时还不能反击）
    if (this.bonusActions[player] > 0) {
      this.bonusActions[player] -= 1
      this.beginTurn(player)
      u.continues = true
      return u
    }

    if (lines > 0) {
      // bugv34m「小千问」：这一手成了连珠 → 待重新部署的棋子作废
      this.discardRedeploy(player, u)
      this.deploy[player] = false
      u.frame = this.declareAttack(player, cells, weights, u)
      return u
    }

    // 双子星：本回合落下的这一子只要形成**两连**就能直接发起攻击
    if (twinLines > 0) {
      this.discardRedeploy(player, u)
      this.deploy[player] = false
      u.frame = this.declareAttack(player, this.scratchLineCells, this.scratchLineWeights, u)
      return u
    }

    // bugv34m「小千问」：本回合落子未成连珠 → 重新部署之前移除的棋子（赶在换手之前）
    this.resolveRedeploy(player, cell, u)

    this.finishTurn(player, u)
    return u
  }

  /**
   * bugv17 #7「布局」（claude 2 技能）：落子未成连珠时，让落点九宫格长出魔力植物。
   *
   * ⚠️ 与引擎口径一致：
   * - **含落点自身**、周围 1 格的全部位置；
   * - **空位与棋子都算**（无论敌我）—— 棋子压着的格子，长出来的植物归那颗棋子的主人；
   * - 已经有植物的格子跳过；
   * - 不推进 `magicGrowths`、不动自然生长的冷却。
   */
  private triggerSeedGrow(player: PlayerIndex, center: number, u: Undo): void {
    if (!this.seedGrow[player]) return
    const slot = this.skills[player].findIndex((spec) => spec.effect === 'seedGrow')
    this.seedGrow[player] = false
    if (slot < 0) return
    const spec = this.skills[player][slot]
    const ring = this.scratchSeedRing
    ring.length = 0
    const radius = Math.max(1, spec.amount)
    const row = (center / BOARD_SIZE) | 0
    const col = center % BOARD_SIZE
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        const r = row + dr
        const c = col + dc
        if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) continue
        const cell = r * BOARD_SIZE + c
        if (this.plants.has(cell)) continue
        ring.push(cell)
      }
    }
    for (let i = 0; i < ring.length; i++) {
      const cell = ring[i]
      const stacked = this.overlay.get(cell)
      const base = this.board[cell]
      const owner: PlayerIndex | null = stacked !== undefined ? stacked : base !== 0 ? ((base - 1) as PlayerIndex) : null
      this.writePlant(cell, owner, u)
    }
  }

  /**
   * bugv34m「本地部署」（Qwen 1 技能）：落子未成连珠时只在**落点**长一棵植物。
   *
   * 与「布局」的区别：只长落点这一格；该格已有植物就跳过。
   */
  private triggerLocalDeploy(player: PlayerIndex, center: number, u: Undo): void {
    if (!this.deploy[player]) return
    this.deploy[player] = false
    if (!this.magicEnabled) return
    if (this.plants.has(center)) return
    const stacked = this.overlay.get(center)
    const base = this.board[center]
    const owner: PlayerIndex | null =
      stacked !== undefined ? stacked : base !== 0 ? ((base - 1) as PlayerIndex) : null
    this.writePlant(center, owner, u)
  }

  /**
   * 假设在 `cell` 落一颗自己的棋子，是否**立刻形成连珠**。
   *
   * ⚠️ 只看 `board`、不看叠子 —— 与引擎的 `previewAttackPieces()` 口径一致
   * （它传的是裸棋盘）。新形成的连珠必然经过 `cell`，所以只查穿过它的四个方向即可。
   */
  private wouldFormLineAt(cell: number, player: PlayerIndex): boolean {
    const target = player + 1
    const board = this.board
    const row = (cell / BOARD_SIZE) | 0
    const col = cell % BOARD_SIZE
    for (let d = 0; d < 4; d++) {
      const dr = DIRS[d][0]
      const dc = DIRS[d][1]
      let length = 1
      let r = row - dr
      let c = col - dc
      while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r * BOARD_SIZE + c] === target) {
        length += 1
        r -= dr
        c -= dc
      }
      r = row + dr
      c = col + dc
      while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r * BOARD_SIZE + c] === target) {
        length += 1
        r += dr
        c += dc
      }
      if (length >= MIN_LINE_LENGTH) return true
    }
    return false
  }

  /**
   * 「小千问」挑落点（与引擎的 `pickRedeployCell` 逐字对齐）。
   *
   * 候选 = 空位且不会形成连珠。命中优先级（bugv34n 用户口径，**先看植物、再看距离**）：
   * ① 能吃下**无主**魔力植物的空位；② 离落点最近的一圈（切比雪夫距离）。
   * 随机用 `seededRng(board|hp|salt)` —— **不含 moveCount**（引擎那边同理）。
   *
   * ⚠️ 引擎侧用的是 `previewAttackPieces()`，这里用 `wouldFormLineAt()`：在**合法局面**下等价
   * —— 棋盘上永远不会有"已经成线却没被结算掉"的棋子。
   */
  private pickRedeployCell(player: PlayerIndex, center: number, index: number): number {
    const legal = this.scratchRedeployLegal
    legal.length = 0
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (this.board[cell] !== 0) continue
      if (this.wouldFormLineAt(cell, player)) continue
      legal.push(cell)
    }
    if (legal.length === 0) return -1
    const liked = this.scratchRedeployLiked
    // ① 优先吃无主魔力植物（空位上的植物必为无主：归属由"压着的棋子"派生）
    liked.length = 0
    for (let i = 0; i < legal.length; i++) {
      if (this.plants.has(legal[i])) liked.push(legal[i])
    }
    if (liked.length > 0) {
      const pick = seededRng(`${this.board.join('')}|${this.hp[0]},${this.hp[1]}|redeploy-plant-${player}-${index}`)()
      return liked[Math.min(liked.length - 1, (pick * liked.length) | 0)]
    }
    // ② 退而求其次：离落点最近的一圈
    const row = (center / BOARD_SIZE) | 0
    const col = center % BOARD_SIZE
    let best = 1 << 30
    for (let i = 0; i < legal.length; i++) {
      const cell = legal[i]
      const d = Math.max(Math.abs(((cell / BOARD_SIZE) | 0) - row), Math.abs((cell % BOARD_SIZE) - col))
      if (d < best) best = d
    }
    liked.length = 0
    for (let i = 0; i < legal.length; i++) {
      const cell = legal[i]
      const d = Math.max(Math.abs(((cell / BOARD_SIZE) | 0) - row), Math.abs((cell % BOARD_SIZE) - col))
      if (d === best) liked.push(cell)
    }
    const pick = seededRng(`${this.board.join('')}|${this.hp[0]},${this.hp[1]}|redeploy-near-${player}-${index}`)()
    return liked[Math.min(liked.length - 1, (pick * liked.length) | 0)]
  }

  /**
   * bugv34m「小千问」的结算（与引擎 `resolveRedeploy` 对齐）：
   * 本回合落子未成连珠 → 把之前移除的棋子重新随机部署；放不下的回原位、退还植物，
   * 并按"没放下的数量 × 每棵植物的冷却"把冷却退回去。
   */
  private resolveRedeploy(player: PlayerIndex, center: number, u: Undo): void {
    const pending = this.redeployPending[player]
    if (pending.length === 0) return
    const snapshot = [...pending]
    if (player === 0) u.redeploy0 = u.redeploy0 ?? snapshot
    else u.redeploy1 = u.redeploy1 ?? snapshot
    pending.length = 0
    let refunded = 0
    for (let index = 0; index < snapshot.length; index += 1) {
      const code = snapshot[index]
      const origin = (code / 2) | 0
      const isOverlay = code % 2 === 1
      const target = this.pickRedeployCell(player, center, index)
      if (target < 0) {
        if (isOverlay) this.writeOverlay(origin, player, u)
        else this.writeBoard(origin, player + 1, u)
        // 退还那棵魔力植物（引擎用"格子派生的普通种类"，迷你引擎只记归属，等价）
        if (this.magicEnabled && !this.plants.has(origin)) this.writePlant(origin, player, u)
        refunded += 1
        continue
      }
      this.placeStone(target, player, u)
    }
    if (refunded <= 0) return
    const slot = this.skills[player].findIndex((spec) => spec.effect === 'redeploy')
    if (slot < 0) return
    const vcost = this.skills[player][slot].variableCost
    const perUnit = vcost && vcost.flatCooldown !== true ? vcost.cooldownPerUnit : 0
    if (perUnit <= 0) return
    if (player === 0) u.ready0 = u.ready0 ?? [...this.skillReadyAt[0]]
    else u.ready1 = u.ready1 ?? [...this.skillReadyAt[1]]
    this.skillReadyAt[player][slot] = Math.max(
      this.actionsTaken[player],
      this.skillReadyAt[player][slot] - perUnit * refunded,
    )
  }

  /** 成连珠时「小千问」的待结算表作废（引擎 `discardRedeploy`）。 */
  private discardRedeploy(player: PlayerIndex, u: Undo): void {
    if (this.redeployPending[player].length === 0) return
    if (player === 0) u.redeploy0 = u.redeploy0 ?? [...this.redeployPending[0]]
    else u.redeploy1 = u.redeploy1 ?? [...this.redeployPending[1]]
    this.redeployPending[player].length = 0
  }

  /**
   * 防守方在攻击阶段落子（忠实复刻 `GameEngine.defend`）。
   *
   * 削弱攻击值 → 自己是否成线 → 对撞抵消 → 施伤（护盾先承伤 / 无敌免伤）→ 清植物
   * → 攻击阶段结束（回合回到攻击方）。
   */
  applyDefense(cell: number, frame: AttackFrame): Undo {
    const u = this.beginUndo()
    const attacker = frame.attacker
    const defender = other(attacker)
    // bugv12 #3：双子星奖励会改 skillReadyAt，撤销时也要还原
    u.ready0 = [...this.skillReadyAt[0]]
    u.ready1 = [...this.skillReadyAt[1]]

    // 烈焰：棋子碎裂，不能抵消（等于硬吃这一击）
    // bugv14：**这批烈焰的主人**可以走在自己的火上 —— 棋子留下（能成线抵消），代价 1 点伤害。
    const onOwnFlame = this.flames.has(cell) && this.flameOwner.get(cell) === defender
    if (this.flames.has(cell) && !onOwnFlame) {
      u.shattered = true
      this.actionsTaken[defender] += 1
      // bugv17 #4：加伤在宣告时已经锁定（此时植物没被抢，与现场重算等价）
      const finalAttack = this.attackValue(frame.baseDamage, 0, frame.magicBonus, attacker)
      // bugv18 #1：棋子被烧碎 → 没有抢夺，参与本次连珠的植物直接消失
      for (let i = 0; i < frame.cells.length; i++) this.removePlant(frame.cells[i], u)
      this.resolveAttack(attacker, finalAttack, 0, EMPTY_CELLS, u)
      return u
    }

    this.placeStone(cell, defender, u)
    this.actionsTaken[defender] += 1
    // bugv14：走自己的火 —— 防守棋子站住了，但要先扣 1 点（护甲 / 护盾先吸收）
    if (onOwnFlame) this.applyDamage(defender, FLAME_WALK_DAMAGE)

    let weakness = 0
    for (let i = 0; i < frame.cells.length; i++) {
      if (frame.cells[i] === cell) {
        weakness = frame.weights[i]
        break
      }
    }
    // bugv18 #1：植物现在**留在棋盘上等防守方来抢**，所以加伤要按现场重算 ——
    // 防守方落在带植物的连珠格上就把那棵抢过来，攻击方相应少 1 点（bugv8 #4 恢复）。
    const magicBonus = this.plantsOn(frame.cells, attacker) * this.damagePerPlant
    const finalAttack = this.attackValue(frame.baseDamage, weakness, magicBonus, attacker)

    const cells = this.scratchCells
    const weights = this.scratchWeights
    const lines = this.matchAfterPlace(defender, MIN_LINE_LENGTH, cells, weights)
    // bugv18 #2：防守方形成连珠同样消耗「小一哥」的持续时间
    // bugv34m：同时结算「本地部署」被动（引擎的 `noteMatch` 对防守连珠同样触发）
    if (lines > 0) this.noteMatch(defender, cells, u)
    const defenderCells = lines > 0 ? [...cells] : EMPTY_CELLS
    const defenderAttack =
      defenderCells.length +
      // bugv19：低消耗档「杀鲸霸拳」生效时，本方植物一律不加伤
      (this.noPlantBonus[defender] ? 0 : this.plantsOn(defenderCells, defender) * this.damagePerPlant) +
      this.powerBonus[defender] +
      this.sabotageBonus[defender]

    // bugv9 #2 / bugv18 #1：防守方**落子之后**（抢夺窗口关闭），参与本次连珠的植物才消失
    for (let i = 0; i < frame.cells.length; i++) this.removePlant(frame.cells[i], u)
    for (let i = 0; i < defenderCells.length; i++) this.removePlant(defenderCells[i], u)

    // bugv18 #5：走自己的火把自己走死 → 立刻结束，不管有没有形成连珠（也就没有反击）
    if (onOwnFlame && this.hp[defender] <= 0) return u

    this.resolveAttack(attacker, finalAttack, defenderAttack, defenderCells, u, frame.strikeExtra, frame.breakShield)
    return u
  }

  /** 攻击结算（规则 5 / 6.3 / 7），随后攻击阶段结束、回合回到攻击方。 */
  private resolveAttack(
    attacker: PlayerIndex,
    finalAttack: number,
    defenderAttack: number,
    defenderCells: readonly number[],
    u: Undo,
    /** bugv14「深度思考」：对手没能成线反击时追加的伤害（bugv30 起恒为 0）。 */
    strikeExtra = 0,
    /** bugv30「力大砖飞」：这一击成功造成伤害后清空受伤方的护盾。 */
    breakShield = false,
  ): void {
    const defender = other(attacker)
    /** 这一击是否**真的打到了防守方**（破盾的判定条件，bugv30）。 */
    let hitDefender = false

    if (defenderCells.length > 0) {
      // 防守方形成连珠：双方棋子飞向中央对撞
      this.removeDetached(defenderCells, defender, u)
      const diff = Math.abs(finalAttack - defenderAttack)
      if (diff > 0) {
        const damaged = finalAttack > defenderAttack ? defender : attacker
        // 无敌 / 双子星爆发窗口：伤害被完全挡下
        if (!this.isDamageImmune(damaged)) {
          this.applyDamage(damaged, diff)
          hitDefender = damaged === defender
        }
      }
    } else if (this.isDamageImmune(defender)) {
      // 防守方没成线，但处于无敌 / 双子星状态：伤害被挡下
    } else {
      // bugv14：对手没能成线反击 → 「深度思考」追加伤害（bugv30 起 `strikeExtra` 恒为 0）
      const damage = finalAttack + strikeExtra
      this.applyDamage(defender, damage)
      hitDefender = damage > 0
    }

    // bugv30：「力大砖飞」——成功造成伤害后把防守方的护盾**与临时护甲**一起移除（bugv31）
    if (breakShield && hitDefender) {
      this.shield[defender] = 0
      this.tempArmor[defender] = 0
    }

    // bugv18 #2：双子星条件奖励 —— 用了双子星（twinStar 还在）且对手没成线 →
    // **恢复 1 点血量**（用户指定；取代原来的"不进冷却 + 下次消耗 -1"）
    if (this.twinStar[attacker] && defenderCells.length === 0) {
      const slot = this.skills[attacker].findIndex((spec) => spec.effect === 'bloom')
      if (slot >= 0) {
        this.hp[attacker] = Math.min(this.initialHp, this.hp[attacker] + 1)
      }
    }

    // bugv10 #9：「当前回合伤害 +1」与「可在敌方棋子落子」已经被这一击用掉了
    this.clearTurnEffects(attacker)

    // 终局：引擎在结算出胜负后直接进入 gameOver，**不再开启新回合**（turnNo 也不动）
    if (this.hp[0] <= 0 || this.hp[1] <= 0) return

    // 攻击阶段结束（规则 11.2：下一普通回合由原攻击方开始）
    this.beginTurn(attacker)
    this.tickFlames(u)
  }

  // -------------------------------------------------------------------------
  // 角色技能（与 GameEngine 的 useSkill / castFireball / applyDamage 对齐）
  // -------------------------------------------------------------------------

  /** 技能还要行动几次才能再用。 */
  private skillRemaining(player: PlayerIndex, slot: number): number {
    const readyAt = this.skillReadyAt[player][slot]
    if (readyAt === undefined) return 0
    return Math.max(0, readyAt - this.actionsTaken[player])
  }

  /**
   * 技能此刻实际要消耗几棵植物。
   *
   * - `freeFirst`：首次为 0（bugv11 #6）；
   * - bugv14：双子星条件奖励从"下一次免费"改成"**下一次消耗 -1**"；
   * - bugv14：可变消耗技能（`variableCost`）返回**下限**（实际消耗由 `cells.length` 决定）。
   */
  private skillCostNow(player: PlayerIndex, slot: number): number {
    const spec = this.skills[player][slot]
    if (!spec) return 0
    if (spec.freeFirst === true && (this.skillCasts[player][slot] ?? 0) === 0) return 0
    if (spec.variableCost) return Math.max(0, spec.variableCost.min)
    if (spec.effect === 'bloom' && this.bloomCheaperNext[player]) return Math.max(0, spec.cost - 1)
    return spec.cost
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

  /** 这一方有没有"落一子即成线"的空位。 */
  private hasLineMove(player: PlayerIndex): boolean {
    const out = this.scratchLineCells
    this.collectAttackCells(player, out)
    return out.length > 0
  }

  /** 这一方"落一子即成线"的空位数量（bugv32 护甲闸门用）。 */
  private lineMoveCount(player: PlayerIndex): number {
    const out = this.scratchCountCells
    this.collectAttackCells(player, out)
    return out.length
  }

  /**
   * 这一手有没有"走**自己的火**成线"的落点（bugv20，护甲闸门用）。
   *
   * 「恶龙吐息」的烈焰只有施法者能踩，踩上去照样能成线攻击，但要**付 1 点血** ——
   * 这 1 点正好由「精密计算」的护甲吸收，所以"要走走火成线"是买护甲的正当理由。
   */
  private hasOwnFlameLineMove(player: PlayerIndex): boolean {
    if (this.flames.size === 0) return false
    const out = this.scratchLineCells
    this.collectAttackCells(player, out)
    for (const cell of out) {
      if (this.flames.has(cell) && this.flameOwner.get(cell) === player) return true
    }
    return false
  }

  /**
   * 手里"用不上的"植物（bugv20）—— 不在任何"我方 ≥2 子且无对手子"的窗口里，
   * 也就是摘掉它**不会减少成线加伤**的那几棵（口径与 `evaluate` 的 `PLANT_LINE_VALUE` 一致）。
   *
   * 它们是技能最廉价的燃料：花掉只损失"储备价值"，不影响眼前的攻击力。
   */
  private sparePlants(player: PlayerIndex, owned: readonly number[]): number[] {
    const out = this.scratchSpare
    out.length = 0
    for (const cell of owned) if (!this.plantOnLineWindow(cell, player)) out.push(cell)
    return out
  }

  /** 这棵植物是不是"占在成线加伤位置上"（与 `evaluate` 的 `PLANT_LINE_VALUE` 同口径）。 */
  private plantOnLineWindow(cell: number, player: PlayerIndex): boolean {
    if (this.plants.get(cell) !== player) return false
    const tMe = player + 1
    const windows = WINDOWS
    for (let w = 0; w < WINDOW_COUNT; w++) {
      const base = w << 2
      let mine = 0
      let theirs = 0
      let here = false
      for (let k = 0; k < 4; k++) {
        const idx = windows[base + k]
        if (idx === cell) here = true
        const v = this.board[idx]
        if (v === tMe) mine += 1
        else if (v !== 0) theirs += 1
      }
      if (here && mine >= 2 && theirs === 0) return true
    }
    return false
  }

  /**
   * Qwen「本地部署」的"预置"闸门（bugv34o 用户口径）。
   *
   * 是否存在一个落点 `X`，使得**在 X 落子之后**我方拿到一条「3 子 + 1 空位 + 0 对手」的
   * 窗口 —— 也就是下回合补第 4 颗即成线。只看当前局面的等价写法：存在一条
   * 「我方 2 子 + 2 空位 + 0 对手」的窗口，而 `X` 是它的两个空位之一。
   *
   * 这时把一棵闲置植物"换"到 X 上才有意义：X 就在将来那条连珠上，下回合成线时
   * 它正好贡献 +1 伤害 —— 正是用户说的"调换到这回合要下的棋子上，从而让下回合
   * 能用到这个魔力植物进行加伤"。
   *
   * ⚠️ 两个排除项：
   *   · `X` 上**本来就有植物** ⇒ `deployGrow` 会跳过，白耗 1 棵（用户明确否掉的时机①）；
   *   · `X` 走不了（对手的烈焰）⇒ 棋子落上去会碎，站不住。
   * ⚠️ 封堵手（用户否掉的时机②）不会被误放行：封堵只挡对手，不会让我方窗口变 2 子。
   */
  private hasDeployPrepMove(player: PlayerIndex): boolean {
    if (!this.magicEnabled) return false
    const board = this.board
    const tMe = player + 1
    const windows = WINDOWS
    for (let w = 0; w < WINDOW_COUNT; w++) {
      const base = w << 2
      let mine = 0
      let foe = 0
      let empties = 0
      for (let k = 0; k < 4; k++) {
        const v = board[windows[base + k]]
        if (v === tMe) mine += 1
        else if (v === 0) empties += 1
        else foe += 1
      }
      if (mine !== 2 || foe !== 0 || empties !== 2) continue
      for (let k = 0; k < 4; k++) {
        const cell = windows[base + k]
        if (board[cell] !== 0) continue
        if (this.plants.has(cell)) continue
        if (this.blockedByFlame(cell, player)) continue
        return true
      }
    }
    return false
  }

  /**
   * 「小千问」能吃下的**无主植物目标数**（bugv34o 用户口径的闸门用）。
   *
   * 口径与 `pickRedeployCell` 的首要优先级**同一集合**：空位 ∧ 不会形成连珠 ∧ 该格有植物。
   * 空位上的植物必为无主（归属由"压着的棋子"派生），所以这些就是"顺手能吃下的"那几棵。
   */
  private redeployPlantTargetCount(player: PlayerIndex): number {
    let count = 0
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (this.board[cell] !== 0) continue
      if (!this.plants.has(cell)) continue
      if (this.wouldFormLineAt(cell, player)) continue
      count += 1
    }
    return count
  }

  /**
   * 该空位是不是「我方 2 子 + 2 空位 + 0 对手」窗口里的一格。
   *
   * 成立 ⇒ 在它上面落子之后，那条窗口就是「3 子 + 1 空位 + 0 对手」，
   * **下回合补第 4 颗即成线**，而这回合长在这格上的魔力植物正好在那条线上。
   */
  private isDeployPrepCell(cell: number, player: PlayerIndex): boolean {
    const tMe = player + 1
    const board = this.board
    const windows = WINDOWS
    for (let w = 0; w < WINDOW_COUNT; w++) {
      const base = w << 2
      let here = false
      let mine = 0
      let foe = 0
      let empty = 0
      for (let k = 0; k < 4; k++) {
        const idx = windows[base + k]
        if (idx === cell) here = true
        const v = board[idx]
        if (v === tMe) mine += 1
        else if (v === 0) empty += 1
        else foe += 1
      }
      if (here && mine === 2 && foe === 0 && empty === 2) return true
    }
    return false
  }

  /**
   * 「本地部署」窗口开着时，这一格算不算**真的用得上那棵被换过来的植物**（bugv34o 用户口径）。
   *
   *   ✅ 这一手落下去就成线 ⇒ 净 +1 伤害；
   *   ✅ 落点是"下回合补一颗即成线"的窗口格（见 `isDeployPrepCell`）
   *      ⇒ 那棵植物正好预置在将来那条连珠上；
   *   ❌ 其余全部算浪费 —— 尤其**本来就有植物**的格：`deployGrow` 会跳过 ⇒ 白耗 1 棵
   *      （用户明确否掉的时机①）；为封堵而落的孤立格也在这里被挡掉（时机②）。
   */
  private deployTargetOk(cell: number, player: PlayerIndex): boolean {
    if (this.board[cell] !== 0) return false
    if (this.wouldFormLineAt(cell, player)) return true
    if (this.plants.has(cell)) return false
    return this.isDeployPrepCell(cell, player)
  }

  /**
   * 是否存在「落子后至少两连」的空位 —— 「双子星」闸门专用。
   *
   * 双子星只要两连就能发起攻击，所以判定口径必须是 2 连；这里直接找
   * 「己方棋子 + 相邻空位（同行/列/斜）」，O(4·CELL_COUNT) 且多数情况立刻命中。
   */
  private hasPairMove(player: PlayerIndex): boolean {
    for (let d = 0; d < 4; d++) {
      const dr = DIRS[d][0]
      const dc = DIRS[d][1]
      for (let cell = 0; cell < CELL_COUNT; cell++) {
        if (!this.ownedAt(cell, player)) continue
        const row = (cell / BOARD_SIZE) | 0
        const col = cell % BOARD_SIZE
        const ar = row - dr
        const ac = col - dc
        if (ar >= 0 && ar < BOARD_SIZE && ac >= 0 && ac < BOARD_SIZE && this.board[ar * BOARD_SIZE + ac] === 0) return true
        const br = row + dr
        const bc = col + dc
        if (br >= 0 && br < BOARD_SIZE && bc >= 0 && bc < BOARD_SIZE && this.board[br * BOARD_SIZE + bc] === 0) return true
      }
    }
    return false
  }

  /**
   * 「毒鸡蛋」可以叠子的位置：**能形成连珠的敌方棋子**（引擎的 `sabotageTargets`）。
   *
   * ⚠️ 这里**绝不能**检查 `this.sabotage[player]` 标记 —— 那个标记是**释放技能之后**
   * 才置位的，而本方法同时是"这个技能能不能放"的判据。检查它会造成死锁：
   * 标记没置位 → 判据为空 → 永远不放技能 → 标记永远不置位。
   * （引擎的 `sabotageTargets` 有一模一样的注释警告，此处忠实对齐。）
   * 需要"只在叠子生效时用"的调用方，请自行加 `if (this.sabotage[player])` 守卫。
   */
  private sabotageTargets(player: PlayerIndex, out: number[]): number[] {
    out.length = 0
    const cells = this.scratchCells
    const weights = this.scratchWeights
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (this.board[cell] === 0 || this.board[cell] === player + 1) continue
      if (this.overlay.has(cell)) continue
      this.overlay.set(cell, player)
      const lines = this.computeMatch(cell, player, MIN_LINE_LENGTH, cells, weights)
      this.overlay.delete(cell)
      if (lines > 0) out.push(cell)
    }
    return out
  }

  /**
   * 「恶龙吐息」max 费档（**直击碎子**）的目标候选。
   *
   * 用户口径：max 费档**必须能打出大量伤害或打断对手唯一能反击的连珠才用**，不能乱用。
   * 所以这里只给两类目标、且**不给中腹兜底**（没有明确目标就不放）：
   *   ① 挡在我方"3 己方 + 1 敌方"窗口里的敌方棋子 —— 碎掉它立刻开出成线点（大量伤害）；
   *   ② 对手"三连窗口"里的关键棋子 —— 碎掉它拆掉对手能反击的那条线。
   */
  private fireballShatterTargets(player: PlayerIndex, out: number[]): number[] {
    out.length = 0
    const foe = other(player)
    const mine = player + 1
    const push = (cell: number): void => {
      if (cell >= 0 && this.board[cell] !== mine && out.indexOf(cell) < 0) out.push(cell)
    }

    // ① 挡我方成线的敌子（bugv15，优先级最高）：碎掉 → "3 己方 + 1 空位" → 下一步成线攻击。
    //    被打空的这一格还会带上我自己的烈焰（对手落上去会碎、我踩着走只付 1 点）。
    const blockers = this.scratchFireBlockers
    this.collectMyWindowBlockers(player, blockers)
    for (let i = 0; i < blockers.length && out.length < 4; i++) push(blockers[i])

    // ② 对手"三连窗口"里的关键棋子：直击碎掉 → 拆掉对手能反击的那条线。
    const keys = this.scratchFireStones
    this.collectFoeKeyStones(foe, keys)
    for (let i = 0; i < keys.length && out.length < 8; i++) push(keys[i])

    return out
  }

  /**
   * 挡在**我方**"3 己方 + 1 敌方"窗口里的敌方棋子（bugv15）。
   *
   * 碎掉它，这个窗口就只剩 3 颗己方 + 1 个空位 → 下一步落子即成线。
   * 注意必须是**恰好 4 格都被占满**（3 己方 + 1 敌方）；若那第 4 格是空位，
   * 那本来就是成线点（不需要火球）。
   */
  private collectMyWindowBlockers(player: PlayerIndex, out: number[]): void {
    out.length = 0
    const target = player + 1
    const windows = WINDOWS
    const board = this.board
    for (let w = 0; w < WINDOW_COUNT; w++) {
      const base = w << 2
      let mine = 0
      let foeCell = -1
      for (let k = 0; k < 4; k++) {
        const cell = windows[base + k]
        const v = board[cell]
        if (v === target) mine += 1
        else if (v !== 0) foeCell = cell
      }
      if (mine === 3 && foeCell >= 0 && out.indexOf(foeCell) < 0) out.push(foeCell)
    }
  }

  /** 火球能不能**立刻开出一个成线点**（bugv15，tempArmor 的闸门用）。 */
  private fireballOpensLine(player: PlayerIndex): boolean {
    const out = this.scratchFireBlockers
    this.collectMyWindowBlockers(player, out)
    return out.length > 0
  }

  /** 对手"三连窗口"里参与的关键棋子：直击其中任意一颗都能拆掉"一步成线"的威胁。 */
  private collectFoeKeyStones(foe: PlayerIndex, out: number[]): void {
    out.length = 0
    const target = foe + 1
    const windows = WINDOWS
    const board = this.board
    for (let w = 0; w < WINDOW_COUNT; w++) {
      const base = w << 2
      let mine = 0
      let other = 0
      let empty = 0
      for (let k = 0; k < 4; k++) {
        const v = board[windows[base + k]]
        if (v === target) mine += 1
        else if (v === 0) empty += 1
        else other += 1
      }
      if (mine === 3 && other === 0 && empty === 1) {
        for (let k = 0; k < 4; k++) {
          const cell = windows[base + k]
          if (board[cell] === target && out.indexOf(cell) < 0) out.push(cell)
        }
      }
    }
  }

  /**
   * 释放技能（忠实复刻 `GameEngine.useSkill`）。
   *
   * ⚠️ 只负责"施加效果"，不判断"能不能用" —— 可用性由 `generateSkillMoves` 把关。
   * `cells` 是要消耗的植物格，`target` 是需要点选目标的技能（恶龙吐息）的目标格。
   */
  applySkill(player: PlayerIndex, slot: number, cells: readonly number[], target: number): Undo {
    const u = this.beginUndo()
    const spec = this.skills[player][slot]
    u.ready0 = [...this.skillReadyAt[0]]
    u.ready1 = [...this.skillReadyAt[1]]
    u.casts0 = [...this.skillCasts[0]]
    u.casts1 = [...this.skillCasts[1]]

    // bugv31：首次免费释放按**下限档位**算（gtp「恶龙吐息」免费的火球同样结束回合）
    const freeCast = spec.freeFirst === true && (this.skillCasts[player][slot] ?? 0) === 0

    for (let i = 0; i < cells.length; i++) this.removePlant(cells[i], u)
    this.skillCasts[player][slot] = (this.skillCasts[player][slot] ?? 0) + 1
    this.skillReadyAt[player][slot] = this.actionsTaken[player] + this.cooldownFor(spec, cells.length)
    // bugv19「杀鲸霸拳」：按**下限**数量释放 → 本回合本方植物不加伤
    const vcost = spec.variableCost
    const tier = freeCast ? Math.max(0, vcost?.min ?? 0) : cells.length
    if (vcost?.minCostPenalty === 'noPlantBonus' && tier <= Math.max(0, vcost.min)) {
      this.noPlantBonus[player] = true
    }

    switch (spec.effect) {
      case 'shield':
        this.shield[player] += Math.max(1, spec.amount)
        break
      case 'heal':
        this.hp[player] = Math.min(this.initialHp, this.hp[player] + Math.max(1, spec.amount))
        break
      case 'double':
        this.bonusActions[player] += Math.max(1, spec.amount)
        break
      case 'bloom':
        this.twinStar[player] = true
        // bugv14：条件奖励里的"下一次消耗 -1"被这一次用掉
        if (this.bloomCheaperNext[player]) this.bloomCheaperNext[player] = false
        break
      case 'immune':
        // bugv12 #2：`amount` 决定覆盖几个回合
        // （2 = 当前回合 + 对手的下个回合，1 = 仅本回合"免疫反击"）
        this.immuneUntil[player] = this.turnNo + Math.max(1, spec.amount)
        break
      case 'tempArmor': {
        // bugv14「精密计算」：临时护甲，持续到指定回合结束前
        // bugv29：强度可取"生命上限"（`amountFromMaxHp`），持续到自己的下个回合结束前
        const turns = Math.max(1, spec.duration ?? 2)
        this.tempArmor[player] += spec.amountFromMaxHp ? this.initialHp : Math.max(1, spec.amount)
        this.tempArmorUntil[player] = Math.max(this.tempArmorUntil[player], this.turnNo + turns)
        break
      }
      case 'firstStrike': {
        // bugv14「深度思考」：直到自己的下个回合结束前，首个连珠攻击 +N
        const turns = Math.max(1, spec.duration ?? 2)
        this.strikeBonus[player] += Math.max(1, spec.amount)
        this.strikeUntil[player] = Math.max(this.strikeUntil[player], this.turnNo + turns)
        break
      }
      case 'seedGrow':
        // bugv14「播种」：本回合落子未成连珠时长出植物
        this.seedGrow[player] = true
        break
      case 'guardShare':
        // bugv14「稳稳的接住你」：自己 +N，对手 +M（bugv16：护盾上限 = 血量上限）
        this.shield[player] = Math.min(this.initialHp, this.shield[player] + Math.max(0, spec.amount))
        this.shield[other(player)] = Math.min(
          this.initialHp,
          this.shield[other(player)] + Math.max(0, spec.shareToFoe ?? 0),
        )
        break
      case 'assault':
        // bugv14「最直接、最不绕弯子」：直接进入攻击阶段（攻击值 = 消耗的植物数）
        u.frame = this.declareAssault(player, cells.length, u)
        break
      case 'fireball':
        // bugv32：可变消耗只有 **max 档**才直击碎子（1 费档 / 免费按 1 费档算只燃火）；
        // bugv33：max 从 3 → 2，碎子判定泛化成跟随 `variableCost.max`（不再硬编码 3）。
        // 固定消耗（旧口径变体 gtp-old-fb / gtp-old-kit 无 variableCost）永远碎子。
        this.castFireball(player, target, Math.max(1, spec.amount), vcost ? tier >= (vcost.max ?? 3) : true, u)
        break
      case 'power': {
        // bugv12 #2：持续 `duration` 个回合（默认 1 = 仅本回合）
        const turns = Math.max(1, spec.duration ?? 1)
        this.powerBonus[player] += Math.max(1, spec.amount)
        this.powerUntil[player] = Math.max(this.powerUntil[player], this.turnNo + turns)
        break
      }
      case 'sabotage':
        this.sabotage[player] = true
        // bugv12 #3：释放后本回合伤害 +1（可与「小一哥」叠加）
        this.sabotageBonus[player] += Math.max(1, spec.amount)
        break
      case 'localDeploy':
        // bugv34m「本地部署」：本回合落子未成连珠 → 落点长植物；成连珠 → 这一击 +1
        this.deploy[player] = true
        this.deployBonus[player] += Math.max(1, spec.amount)
        break
      case 'redeploy': {
        // bugv34m「小千问」：移除压在被消耗植物上的棋子，记下原位等本回合落子后重新部署
        // （植物已经在上面统一 `removePlant` 掉了）
        u.redeploy0 = u.redeploy0 ?? [...this.redeployPending[0]]
        u.redeploy1 = u.redeploy1 ?? [...this.redeployPending[1]]
        const pending = this.redeployPending[player]
        pending.length = 0
        for (let i = 0; i < cells.length; i++) {
          const cell = cells[i]
          // ⚠️ 与引擎逐字一致：先看叠子（不管是谁的），再看底下的棋子
          if (this.overlay.get(cell) !== undefined) {
            this.removeOverlay(cell, u)
            pending.push(cell * 2 + 1)
          } else {
            if (this.board[cell] !== 0) this.writeBoard(cell, 0, u)
            pending.push(cell * 2)
          }
        }
        break
      }
    }

    // 用完不交回合（`endsTurn` 技能；bugv32 起没有技能用它了，但保留开关）
    if (spec.endsTurn === true) {
      this.beginTurn(other(player))
      u.continues = false
    } else {
      u.continues = true
    }
    return u
  }

  /**
   * 恶龙吐息（bugv12 #1）：直击目标格的棋子（含叠子）令其碎裂，再把整行整列的空位点上烈焰。
   *
   * ⚠️ 先移除棋子、再收集空位 —— 被直击打空的那一格也会因此进入燃火列表（"也会留下火焰"）。
   */
  private castFireball(caster: PlayerIndex, target: number, turns: number, shatter: boolean, u: Undo): void {
    const row = (target / BOARD_SIZE) | 0
    const col = target % BOARD_SIZE
    // ① 直击：目标格上的棋子直接碎裂（叠上去的那颗也一起飞走）。
    //    bugv32：只有 max 费档才碎子（1 费档 / 免费 = 只燃火，不碎子）。
    if (shatter) {
      if (this.overlay.has(target)) this.removeOverlay(target, u)
      if (this.board[target] !== 0) {
        this.writeBoard(target, 0, u)
        // bugv17 #5：直击碎掉的那颗棋子上的魔力植物一并消失
        this.removePlant(target, u)
      }
    }
    // ② 燃火：整行整列的空位
    // ⚠️ 先收集"这一击要覆盖的格子"，再统一写烈焰 —— 引擎就是这个口径：
    // 已存在的烈焰会被**覆盖**成新的回合数，而不是"已经有了就跳过"。
    const cells = this.scratchFireCells
    cells.length = 0
    for (let c = 0; c < BOARD_SIZE; c++) {
      const index = row * BOARD_SIZE + c
      if (this.board[index] === 0) cells.push(index)
    }
    for (let r = 0; r < BOARD_SIZE; r++) {
      const index = r * BOARD_SIZE + col
      if (this.board[index] === 0 && cells.indexOf(index) < 0) cells.push(index)
    }
    if (cells.length === 0) return
    const value = Math.max(1, turns) * 2
    for (let i = 0; i < cells.length; i++) {
      this.writeFlame(cells[i], value, u)
      // bugv14：这批烈焰归施法者（只有他能走在自己的火上）
      this.writeFlameOwner(cells[i], caster, u)
    }
    // bugv18 #1：整行整列被点着 —— 空位上的魔力植物也一并烧掉（与引擎口径一致）
    if (this.magicEnabled) {
      for (let i = 0; i < cells.length; i++) this.removePlant(cells[i], u)
    }
  }

  /**
   * 生成可用的技能着法。
   *
   * **闸门原则**：只有这次释放"真的可能改变结果"时才给候选 ——
   * 增伤 / 双子星只在"这一手能成线（发起攻击）"时才有意义；回血在上限时无意义；
   * 护盾 / 无敌只在有威胁或残血时给；叠子要有目标；火球要有落点。
   * 这样每个节点最多多出 1~2 个候选，搜索不会被技能撑爆。
   */
  generateSkillMoves(player: PlayerIndex, out: SkillMove[]): void {
    out.length = 0
    if (!this.skillEnabled) return
    const specs = this.skills[player]
    const owned = this.ownedPlantCells(player, this.scratchPlants)
    /** bugv20：「用不上的植物」（不在我方成线窗口里）—— 拿来当技能燃料最划算。 */
    const spare = this.sparePlants(player, owned)
    const mineAttack = this.hasLineMove(player)
    const foeAttack = this.hasLineMove(other(player))

    // bugv15：「护甲 + 火球 + 走火」连招的探测信号 —— 放护甲的那一刻还没成线机会
    // （挡路敌子还在），火球碎掉它之后才有。⚠️ bugv33 起 tempArmor 的 `threat` 档
    // **不再**用它当放行理由（它不要求对手威胁，是护甲乱开的主因）；这里仍算出来，
    // 仅留给 `loose` 档（历史口径）保留旧行为。
    let fireballOpensLine = false
    if (specs.some((spec) => spec.effect === 'fireball')) {
      fireballOpensLine =
        this.fireballOpensLine(player) &&
        specs.some(
          (spec, slot) =>
            spec.effect === 'fireball' &&
            this.skillRemaining(player, slot) === 0 &&
            owned.length >= this.skillCostNow(player, slot),
        )
    }

    for (let slot = 0; slot < specs.length; slot++) {
      const spec = specs[slot]
      if (this.skillRemaining(player, slot) > 0) continue
      const costNow = this.skillCostNow(player, slot)
      if (owned.length < costNow) continue
      const cost = owned.slice(0, costNow)

      if (spec.effect === 'fireball') {
        // bugv32 用户战略口径（bugv33 碎子档 3 费 → 2 费，判定用 v.min / v.max 泛化）：
        //   1 费档（只燃火、不碎子）→ 用于**阻断对手连珠的格子**：我这一手能成线、对手也能反击时，
        //     燃掉对手的反击格，让对手无法反击。
        //   max 费档（碎子+燃火）→ **必须能打出大量伤害或打断对手唯一能反击的连珠才用**，不能乱用。
        //   旧口径（无 variableCost）→ 永远碎子，保持原行为。
        const v = spec.variableCost
        const foe = other(player)
        const free = spec.freeFirst === true && (this.skillCasts[player][slot] ?? 0) === 0

        if (free) {
          if (v) {
            // 新口径免费 = 1 费档：只在"我进攻 + 对手能反击"时燃掉对手反击格
            if (mineAttack && foeAttack) {
              const targets = this.scratchFire
              this.collectAttackCells(foe, targets)
              for (let t = 0; t < targets.length; t++) {
                out.push({ slot, cells: [], target: targets[t], effect: spec.effect })
              }
            }
          } else {
            // 旧口径免费：永远碎子（保持原行为）
            const targets = this.scratchFire
            this.fireballShatterTargets(player, targets)
            for (let t = 0; t < targets.length; t++) {
              out.push({ slot, cells: [], target: targets[t], effect: spec.effect })
            }
          }
          continue
        }

        if (!v) {
          // 旧口径固定消耗：永远碎子
          const targets = this.scratchFire
          this.fireballShatterTargets(player, targets)
          const cells = owned.slice(0, costNow)
          for (let t = 0; t < targets.length; t++) {
            out.push({ slot, cells: cells.slice(), target: targets[t], effect: spec.effect })
          }
          continue
        }

        // 新口径可变 1/max 费（bugv33：max=2）：
        //   1 费档（只燃火）：阻断对手反击
        if (mineAttack && foeAttack && owned.length >= v.min) {
          const targets = this.scratchFire
          this.collectAttackCells(foe, targets)
          const pay = owned.slice(0, v.min)
          for (let t = 0; t < targets.length; t++) {
            out.push({ slot, cells: pay.slice(), target: targets[t], effect: spec.effect })
          }
        }
        //   max 费档（碎子）：大量伤害（碎拦路石开出成线）或打断对手唯一反击
        const wantShatter = this.fireballOpensLine(player) || (mineAttack && foeAttack)
        if (wantShatter && owned.length >= v.max) {
          const targets = this.scratchFire
          this.fireballShatterTargets(player, targets)
          const pay = owned.slice(0, v.max)
          for (let t = 0; t < targets.length; t++) {
            out.push({ slot, cells: pay.slice(), target: targets[t], effect: spec.effect })
          }
        }
        continue
      }

      // bugv19「杀鲸霸拳」：2 棵（本回合植物不加伤、更快打出）/ 3 棵（正常加伤）两种打法
      if (spec.effect === 'double' && spec.variableCost) {
        const v = spec.variableCost
        const hi = Math.min(v.max, owned.length)
        for (let n = Math.max(0, v.min); n <= hi; n++) {
          out.push({ slot, cells: owned.slice(0, n), target: -1, effect: spec.effect })
        }
        continue
      }

      // bugv14「最直接、最不绕弯子」：自选 1~4 棵植物，攻击值 = 消耗数。
      // 只给两类候选，避免候选爆炸：① 能直接击杀的消耗量；② 当前能负担的最大消耗量
      // （需求原文："尽可能的选择更多的魔力植物"）。
      if (spec.effect === 'assault') {
        const v = spec.variableCost
        const max = Math.min(v ? v.max : spec.cost, owned.length)
        const min = Math.max(1, v ? v.min : 1)
        const foeHp = this.hp[other(player)]
        for (let n = min; n <= max; n++) {
          if (n < foeHp && n !== max) continue
          out.push({ slot, cells: owned.slice(0, n), target: -1, effect: spec.effect })
        }
        continue
      }

      /**
       * bugv34m「小千问」：消耗 1~2 棵植物把棋子挪走，本回合落子不成连珠时再随机部署回来。
       *
       * ⚠️ 只给"这一手成不了线"的场合（成线那一手会把待部署表作废 = 白丢棋子）。
       * 优先摘"用不上的"植物（`spare`），别动占在成线窗口里的那几棵。
       * bugv34o 用户口径：还要"场上真有能顺手吃下的无主植物"（见下）。
       */
      if (spec.effect === 'redeploy') {
        // bugv34m：政策开关 —— 关掉 = 该技能不进候选（测"是不是净负担"）
        if (!AI_POLICY.redeployEnabled) continue
        const v = spec.variableCost
        const hi = Math.min(v ? v.max : spec.cost, owned.length)
        const lo = Math.max(1, v ? v.min : 1)
        if (!this.magicEnabled || mineAttack || hi < lo) continue
        // bugv34o 用户口径：只有"场上有无主植物、且落在我能顺手吃下的位置"时才用二技能。
        // 一个都吃不到时，重新部署只能把棋子丢到"离落点最近的一圈"，收益很薄。
        let plantTargets = 0
        if (AI_POLICY.redeployRequirePlantTarget) plantTargets = this.redeployPlantTargetCount(player)
        for (let n = lo; n <= hi; n++) {
          if (AI_POLICY.redeployRequirePlantTarget && plantTargets < n) continue
          out.push({
            slot,
            cells: (spare.length >= n ? spare : owned).slice(0, n),
            target: -1,
            effect: spec.effect,
          })
        }
        continue
      }

      switch (spec.effect) {
        case 'power':
          // bugv18 #2：生效期间不能重复释放，也就别进候选
          if (this.powerActive(player)) continue
          // bugv20（用户口径）：小一哥是**长线投资** —— 持续 5 回合、冷却 5 ⇒ 没有真空期；
          // 而且所有技能"用完不交回合"，放它**不占落子**，真实成本只有那 1 棵燃料植物。
          // 所以只要有"用不上的植物"当燃料就该放，不必等这一手成线。
          if (!mineAttack && !(AI_POLICY.powerLongTerm && spare.length >= costNow)) continue
          // 优先烧"用不上的"植物 —— 别动占在成线窗口里的那几棵（摘掉会少 1 点攻击）
          out.push({
            slot,
            cells: (spare.length >= costNow ? spare : owned).slice(0, costNow),
            target: -1,
            effect: spec.effect,
          })
          continue
        case 'firstStrike':
          // bugv30：效果还在生效期间不能重复释放，也就别进候选
          if (this.strikeActive(player)) continue
          // bugv14「深度思考」：加成只对"首个连珠攻击"生效，所以只有这一手能成线才值得放
          if (!mineAttack) continue
          break
        case 'seedGrow':
          // 「布局」（bugv14 播种 / bugv17 #7 重做）：长期收益（植物 = 技能货币 + 连珠加伤）。
          // 只在"魔力植物这局开着"时才值得放；棋盘下满时也没有空位可长。
          //
          // ⚠️ bugv15：**必须要求这一手没有成线机会**。布局只在"落子不成连珠"时
          // 才触发 —— 若这一手本来就能成线攻击，放了布局也只能二选一：
          // 要么白花 2 棵植物（落子成线、什么都没长），要么放弃这一击。
          // ⚠️ bugv17 #7：新版是 **2 费 + 九宫格含棋子 + 归属按"谁压着"派生**
          // ⇒ 落子那一刻**只有落点自己**（以及九宫格里本来就压着己方棋子的格子）算自己的；
          // 空格上长出来的都是**无主**植物（谁先落子谁占）。
          // 所以"种一片立刻归我"的时代结束了 —— 手里植物够花时依然不该播。
          if (!this.magicEnabled) continue
          if (mineAttack) continue
          if (owned.length > PLANT_SPENDABLE + 1) continue
          break
        case 'guardShare':
          // 净赚 1 点护盾：有威胁或残血时给（否则等于把节奏让给对手）
          if (!mineAttack && !foeAttack && this.hp[player] > 3) continue
          break
        case 'tempArmor': {
          // bugv32 用户战略口径：「精密计算」的护甲覆盖"我的回合 + 对手回合 + 我的下个回合"，
          // 价值 = 两回合无伤进攻 / 扛大威胁。
          // ⚠️ 用户红线：**绝不能无意义地开护甲浪费** —— 到期必作废的护甲是纯亏。
          //
          // 三档闸门（`AI_POLICY.armorGate`，可用 `--policy` 镜像对撞验证）：
          //   - `loose`（旧）：对手能成线（`foeAttack`）就放 —— 但"对手能成线"在四子棋里
          //     几乎永远成立 ⇒ 护甲被当成"冷却好了就放"，实测败局里 78% 到期作废。
          //   - `threat`（默认）：只认真会用到护甲的情形（见下）。
          //   - `strict`：在 `threat` 上再要求"我挡不住"（这一手自己没成线点来对撞抵消）。
          const armoredNow = this.tempArmor[player] > 0 && this.tempArmorUntil[player] > this.turnNo
          if (armoredNow) continue // 护甲还盖着，别重复买（纯浪费）
          const gate = AI_POLICY.armorGate
          if (gate === 'loose') {
            if (!foeAttack && !this.hasOwnFlameLineMove(player) && !fireballOpensLine) continue
          } else {
          // threat / strict 共用的"真会用到护甲"判据：
          //   ① 这一手我要攻击、对手也能反击（`mineAttack && foeAttack`）→ 护甲吸收反击、支持连续进攻；
          //   ② 对手有 ≥2 个成线点（挡不过来的大威胁）→ 开护甲硬扛；
          //   ③ 这一手要走自己的火成线（自伤 1 点）→ 护甲正好吸收这 1 点。
          // ⚠️ bugv33 收紧：**去掉"火球能开线"这个分支**。它只表示"我有 3 己方 + 1 敌子窗口"，
          //   完全不要求对手有威胁，是护甲"乱开"（用户观察：对手没连珠也开）的主要来源——
          //   聚焦循环赛里 gtp 护甲放了 774 次（比火球 762 还多），植物全被这 8 点大护甲烧掉。
          const foeBigThreat = this.lineMoveCount(other(player)) >= 2
          const base =
            (mineAttack && foeAttack) ||
            foeBigThreat ||
            this.hasOwnFlameLineMove(player) ||
            (AI_POLICY.armorAllowFbOpen && fireballOpensLine)
          if (gate === 'strict') {
              // strict 再要求"我这一手没有自己的成线点可对撞抵消"（= 挡不住）
              if (!base || mineAttack) continue
            } else if (!base) continue
          }
          break
        }
        case 'bloom':
          // ⚠️ 双子星把连珠门槛降到 2（`TWIN_STAR_LINE_LENGTH`）：只要**两连**就能发起攻击。
          // 绝不能用「能否成 4 连」去卡它 —— 那会让这个技能几乎永远放不出来（实测 ready 34 次只放出 1 次）。
          if (!this.hasPairMove(player)) continue
          break
        case 'immune':
          // bugv12 #2 回滚：无敌覆盖"当前回合 + 对手的下个回合"（能扛住对手一整个回合的进攻），
          // 所以"我要攻击 / 对手有威胁 / 我残血"任一成立就值得放。
          if (!mineAttack && !foeAttack && this.hp[player] > 2) continue
          break
        case 'heal':
          if (this.hp[player] >= this.initialHp) continue
          break
        case 'shield':
          if (!mineAttack && !foeAttack && this.hp[player] > 3) continue
          break
        case 'sabotage':
          if (this.sabotageTargets(player, this.scratchSab).length === 0) continue
          break
        case 'localDeploy': {
          if (AI_POLICY.deployGate === 'prep') {
            // bugv34o 用户口径 —— 只在"这次释放能换到东西"时放：
            //   ① 这一手能成线 → 实打实的净 +1 伤害；
            //   ② 否则必须能"预置"：落点落在「我方 2 子 + 2 空位 + 0 对手」的窗口上
            //      ⇒ 下回合补第 4 颗即成线，被换过来的植物正好位在将来那条连珠上。
            // 两种情形都只烧 `spare`（不在任何"我方≥2 子"窗口里的闲置植物）：
            // 烧它不削减这一击的植物加伤，也不会掐掉某条正在发育的线。
            if (spare.length < costNow) continue
            if (!mineAttack && !this.hasDeployPrepMove(player)) continue
            out.push({ slot, cells: spare.slice(0, costNow), target: -1, effect: spec.effect })
            continue
          }
          // `'anytime'`（现口径）：成线那一手 = 实打实的 +1 伤害；不成线 = 落点白长一棵植物
          // （等于把那棵植物挪到自己刚下的子上）。没有重复释放限制，冷却还被被动削得很快，
          // 所以"这一手能成线"或"植物这局开着"都放；棋盘下满时没有落点可长，不值得花那 1 棵。
          //
          // ⚠️ 实测（`scripts/probe-qwen.ts`）：非攻击释放占 74%，且会吃掉「小千问」的燃料。
          // `AI_POLICY.deployOnlyOnAttack=true` 可收紧成"只为 +1 伤害而放"。
          if (AI_POLICY.deployOnlyOnAttack && !mineAttack) continue
          if (!mineAttack && (!this.magicEnabled || !this.hasEmptyCell())) continue
          // 优先烧"用不上的"植物：别烧占在成线窗口上、每棵 +1 伤害的那几棵
          if (AI_POLICY.deployPreferSpareFuel && spare.length >= costNow) {
            out.push({ slot, cells: spare.slice(0, costNow), target: -1, effect: spec.effect })
            continue
          }
          break
        }
        default:
          break
      }
      out.push({ slot, cells: cost.slice(), target: -1, effect: spec.effect })
    }
  }

  // -------------------------------------------------------------------------
  // 评估
  // -------------------------------------------------------------------------

  /** 终局分（越早赢越好 / 越晚输越好）。 */
  private evalTerminal(depth: number): number {
    const me = this.root
    const foe = other(me)
    const mine = this.hp[me]
    const theirs = this.hp[foe]
    if (mine <= 0 && theirs <= 0) return mine > theirs ? WIN - 1 : mine < theirs ? -(WIN - 1) : 0
    if (theirs <= 0) return WIN + depth
    return -(WIN + depth)
  }

  /**
   * 静态评估：血量差 + 四连窗口的形态分。
   *
   * 窗口分怎么理解：一个"3 己方 + 1 空位"的窗口，就是"下一步落子即可发起攻击"，
   * 因此分值故意给得很高（约 3 点血的量级）；"活三"会被相邻的两个窗口各算一次，
   * 于是天然比分死三更高 —— 这正是本作里"挡不住的杀招"的价值。
   */
  evaluate(turn: PlayerIndex): number {
    const me = this.root
    const foe = other(me)
    const tMe = me + 1
    const tFoe = foe + 1
    // 血量才是唯一真实货币；护盾与临时护甲**折价**计入（bugv15，见 SHIELD_WEIGHT 注释）。
    // 临时护甲更脆（到期作废），再折一档。
    let score =
      (this.hp[me] - this.hp[foe]) * HP_WEIGHT +
      (this.shield[me] - this.shield[foe]) * SHIELD_WEIGHT +
      (this.tempArmor[me] - this.tempArmor[foe]) * AI_POLICY.tempArmorWeight +
      (turn === me ? TEMPO : -TEMPO)
    let shape = 0

    const board = this.board
    const windows = WINDOWS
    // 叠子（毒鸡蛋）让某一格对**双方**都算己方棋子，所以有叠子时要把 overlay 也算进窗口
    const hasOverlay = this.overlay.size > 0
    for (let w = 0; w < WINDOW_COUNT; w++) {
      const base = w << 2
      let mine = 0
      let theirs = 0
      for (let k = 0; k < 4; k++) {
        const idx = windows[base + k]
        const v = board[idx]
        if (v === tMe) mine += 1
        else if (v === tFoe) theirs += 1
        if (hasOverlay) {
          const stack = this.overlay.get(idx)
          if (stack === me) {
            if (v !== tMe) mine += 1
          } else if (stack === foe && v !== tFoe) theirs += 1
        }
      }
      if (theirs === 0) {
        if (mine === 3) shape += W_THREE
        else if (mine === 2) shape += W_TWO
        else if (mine === 1) shape += W_ONE
        // bugv16：我方窗口里的**己方植物** = 这条线将来多打 1 点伤害/棵。
        // 只在窗口已经"有威胁"（≥2 颗我方棋子）时才算，避免把"满地撒植物"算成收益。
        if (mine >= 2 && this.magicEnabled) {
          let plantsHere = 0
          for (let k = 0; k < 4; k++) if (this.plants.get(windows[base + k]) === me) plantsHere += 1
          if (plantsHere > 0) shape += plantsHere * PLANT_LINE_VALUE
        }
      } else if (mine === 0) {
        if (theirs === 3) shape -= W_THREE_OPP
        else if (theirs === 2) shape -= W_TWO_OPP
        else if (theirs === 1) shape -= W_ONE_OPP
      }
    }
    score += shape

    // 植物（技能货币 + 攻击加成）：已到手的分 3 档 —— 我方 > 可转化 > 敌方。
    // bugv15：中立植物若紧挨我方棋子（多半会被我接手，比如「播种」长出来的那一圈）
    // 给一个中间价，否则"2 费换一地植物"在搜索里是 0 收益。
    if (this.magicEnabled) {
      let minePlants = 0
      let foePlants = 0
      let claimScore = 0
      for (const [cell, owner] of this.plants) {
        if (owner === me) minePlants += 1
        else if (owner === foe) foePlants += 1
        else {
          const mineNear = this.stonesAround(cell, me)
          const foeNear = this.stonesAround(cell, foe)
          // ⚠️ 必须"≥2 颗我方棋子相邻"才算大概率归我：播种长出的那一圈每棵都紧挨着
          // 刚下的那一颗，用"≥1"判会让整圈植物都变成虚假收益。
          if (mineNear >= 2 && foeNear === 0) claimScore += PLANT_CLAIM_EXCLUSIVE
          else if (foeNear >= 2 && mineNear === 0) claimScore -= PLANT_CLAIM_EXCLUSIVE
          else if (mineNear > foeNear) claimScore += PLANT_CLAIM_SHARED
          else if (foeNear > mineNear) claimScore -= PLANT_CLAIM_SHARED
        }
      }
      // bugv16：已到手的植物**按"花得掉的量"计价**，超出储备的部分只算残值（见 PLANT_VALUE 注释）
      score += ownedPlantScore(minePlants) - ownedPlantScore(foePlants) + claimScore
      // bugv32「火球植物溢价」：有 fireball 技能的一方（gtp），手里前 FIREBALL_PLANT_BONUS_CAP
      // 棵植物能兑换"碎子开线"这个胜负手（bugv33 起是 2 费档），价值远超通用 260。给它们额外计价，
      // 逼 AI 攥住植物。
      if (AI_POLICY.fireballPlantBonus > 0) {
        const bonus = AI_POLICY.fireballPlantBonus
        const hasFireball = (p: PlayerIndex): boolean =>
          (this.skills[p] ?? []).some((s) => s.effect === 'fireball')
        if (hasFireball(me)) score += Math.min(minePlants, FIREBALL_PLANT_BONUS_CAP) * bonus
        if (hasFireball(foe)) score -= Math.min(foePlants, FIREBALL_PLANT_BONUS_CAP) * bonus
      }
    }

    // 烈焰封锁（bugv15）：我方放的烈焰 = 对手 16 格进不来（只有我能踩着走）。
    if (this.flames.size > 0) {
      let flameScore = 0
      for (const [cell] of this.flames) {
        const owner = this.flameOwner.get(cell)
        if (owner === me) flameScore += AI_POLICY.flameWeight
        else if (owner === foe) flameScore -= AI_POLICY.flameWeight
      }
      score += flameScore
    }

    // 未兑现的伤害加成（bugv12 #3）：当作"即将到手但还没兑现"的伤害估价，
    // 逼 AI 早点把持续性增伤打出去，而不是攥着拖到下一回合。
    {
      let pending = 0
      if (this.powerBonus[me] > 0 && this.powerUntil[me] > this.turnNo) pending += this.powerBonus[me]
      pending += this.sabotageBonus[me]
      if (this.powerBonus[foe] > 0 && this.powerUntil[foe] > this.turnNo) pending -= this.powerBonus[foe]
      pending -= this.sabotageBonus[foe]
      score += pending * PENDING_DAMAGE_WEIGHT
    }

    // 极小的中腹偏好：在完全对称的局面里给搜索一个稳定的倾向。
    for (let i = 0; i < CELL_COUNT; i++) {
      const v = board[i]
      if (v === 0) continue
      const row = (i / BOARD_SIZE) | 0
      const col = i % BOARD_SIZE
      const centrality = 4 - Math.max(Math.abs(row - 4), Math.abs(col - 4))
      if (v === tMe) score += centrality
      else if (v === tFoe) score -= centrality
    }

    return score
  }

  // -------------------------------------------------------------------------
  // 着法生成
  // -------------------------------------------------------------------------

  /**
   * 生成候选着法（按优先级降序）。
   *
   * 候选 = 4 连窗口里"有战术价值"的空位 ∪ 已有棋子周围两格内的空位。
   * 排序优先级：一步成线 > 挡住对手的一步成线 > 补三 > 补二 > 靠近棋子 > 靠中腹。
   */
  private generateMoves(player: PlayerIndex, limit: number): number[] {
    const prio = this.prio
    prio.fill(0)

    const tMe = player + 1
    const windows = WINDOWS
    const board = this.board

    for (let w = 0; w < WINDOW_COUNT; w++) {
      const base = w << 2
      let mine = 0
      let other = 0
      let empty = 0
      let e0 = -1
      let e1 = -1
      let e2 = -1
      let e3 = -1
      let v = board[windows[base]]
      if (v === 0) {
        e0 = windows[base]
        empty += 1
      } else if (v === tMe) mine += 1
      else other += 1
      v = board[windows[base + 1]]
      if (v === 0) {
        e1 = windows[base + 1]
        empty += 1
      } else if (v === tMe) mine += 1
      else other += 1
      v = board[windows[base + 2]]
      if (v === 0) {
        e2 = windows[base + 2]
        empty += 1
      } else if (v === tMe) mine += 1
      else other += 1
      v = board[windows[base + 3]]
      if (v === 0) {
        e3 = windows[base + 3]
        empty += 1
      } else if (v === tMe) mine += 1
      else other += 1

      if (other === 0) {
        if (mine === 3 && empty === 1) {
          prio[e0 >= 0 ? e0 : e1 >= 0 ? e1 : e2 >= 0 ? e2 : e3] += PRIO_ATTACK_MINE
        } else if (mine === 2 && empty === 2) {
          if (e0 >= 0) prio[e0] += PRIO_THREE_MINE
          if (e1 >= 0) prio[e1] += PRIO_THREE_MINE
          if (e2 >= 0) prio[e2] += PRIO_THREE_MINE
          if (e3 >= 0) prio[e3] += PRIO_THREE_MINE
        }
      } else if (mine === 0) {
        if (other === 3 && empty === 1) {
          prio[e0 >= 0 ? e0 : e1 >= 0 ? e1 : e2 >= 0 ? e2 : e3] += PRIO_ATTACK_OPP
        } else if (other === 2 && empty === 2) {
          if (e0 >= 0) prio[e0] += PRIO_THREE_OPP
          if (e1 >= 0) prio[e1] += PRIO_THREE_OPP
          if (e2 >= 0) prio[e2] += PRIO_THREE_OPP
          if (e3 >= 0) prio[e3] += PRIO_THREE_OPP
        }
      }
    }

    // 棋子周围（距离 1 / 2）
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (board[cell] === 0) continue
      const base = cell * NB_STRIDE
      for (let k = 0; k < NB_STRIDE; k++) {
        const nb = NB24[base + k]
        if (nb >= 0 && board[nb] === 0) prio[nb] += k < 8 ? PRIO_NEAR1 : PRIO_NEAR2
      }
    }

    // 魔力植物格（bugv13 #3）：可被"落子认领 / 抢走"的植物必须进候选集。
    //
    // ⚠️ 为什么不能只靠叶子评估里的 `PLANT_VALUE`：候选集是**资格**、评估是**价值**。
    // 植物格本身不在棋子附近时优先级是 0，会在进入评估之前就被 `slice(0, limit)` 剪掉，
    // 于是评估里给它打多少分都无意义（实测一局 AI 认领 0 棵植物）。
    // 只有**空格**上的植物能被落子认领（火焰格踩上去会碎，后面统一过滤掉）。
    if (this.magicEnabled) {
      for (const [cell, owner] of this.plants) {
        if (board[cell] !== 0) continue
        if (owner === null) prio[cell] += PRIO_PLANT_NEUTRAL
        else if (owner !== player) prio[cell] += PRIO_PLANT_FOE
      }
    }

    // 「毒鸡蛋」：可以叠在敌方棋子上的位置（能连珠的），单独作为高优先级候选。
    // 只有叠子会占用"非空"的落点，所以后面的候选收集允许 `prio > 0` 的非空格通过。
    if (this.sabotage[player]) {
      const sab = this.sabotageTargets(player, this.scratchSab)
      for (let i = 0; i < sab.length; i++) prio[sab[i]] += PRIO_ATTACK_MINE
    }

    // ⚠️ 候选集必须先按**纯位置优先级**（战术 + 靠近棋子）确定，再看 killer/history：
    // 否则空盘的第二轮迭代会被 killer 加分"造"出一堆假候选，天元的兜底就失效了。
    // 同时跳过烈焰格：踩上去只会白白作废一手。
    const moves: number[] = []
    for (let i = 0; i < CELL_COUNT; i++) {
      if (prio[i] > 0 && !this.blockedByFlame(i, player) && !this.wastefulFlameWalk(i, player)) moves.push(i)
    }
    if (moves.length === 0) {
      // 兜底：没有任何"贴着棋子 / 有战术价值"的空位。
      //
      // ⚠️ 这里**绝不能**无条件返回 `[CENTER]` —— 深搜时棋盘可能已经下满，
      // 那时天元被占着，`applyPlace` 会覆盖掉原有棋子、撤销时又把它恢复成空位，
      // 棋盘就被永久改脏（实测：深搜第 10 层以后中心格会凭空消失，
      // 随后 AI 会返回"已占用的落点"）。
      let empties = 0
      let gatedOut = 0
      for (let i = 0; i < CELL_COUNT; i++) {
        if (board[i] !== 0 || this.blockedByFlame(i, player)) continue
        empties += 1
        if (this.wastefulFlameWalk(i, player)) {
          gatedOut += 1
          continue
        }
        moves.push(i)
      }
      // bugv19 闸门把**所有**空位都挡掉了（整片空位都是自己的火）→ 放宽闸门，
      // 宁可自伤 1 点也不能返回"无着可走"（那会让上层拿到非法落点）。
      if (moves.length === 0 && gatedOut > 0) {
        for (let i = 0; i < CELL_COUNT; i++) {
          if (board[i] === 0 && !this.blockedByFlame(i, player)) moves.push(i)
        }
      }
      if (moves.length === 0) return moves // 没有可落点（棋盘下满 / 全被烈焰覆盖）
      if (empties === CELL_COUNT) return [CENTER] // 空盘：只走天元
      return moves
    }

    // 🚩 bugv34o：**本地部署窗口开着**（只可能发生在"已经放了本地部署"的子树里）时，
    // 落点必须真的用得上那棵植物 —— 否则这一手等于白烧 1 棵（用户明确否掉的时机）。
    // 只改这一条子树：`this.deploy[player]` 为 false 的分支一律不受影响。
    // ⚠️ 过滤后一个都不剩时**保留原候选**（宁可放过，也不能让上层拿到"无着可走"）。
    if (AI_POLICY.deployGate === 'prep' && this.deploy[player]) {
      const usable = moves.filter((cell) => this.deployTargetOk(cell, player))
      if (usable.length > 0) {
        moves.length = 0
        for (const cell of usable) moves.push(cell)
      }
    }

    // killer / history：只在已确定的候选集内调整先后（把"上次引发剪枝的好棋"提前）
    const kA = this.killerA[player]
    const kB = this.killerB[player]
    const history = this.history
    if (moves.includes(kA)) prio[kA] += 60_000
    if (moves.includes(kB)) prio[kB] += 30_000
    for (let i = 0; i < moves.length; i++) {
      const cell = moves[i]
      if (history[cell] > 0) prio[cell] += history[cell] >> 1
    }

    moves.sort((a, b) => prio[b] - prio[a] || a - b)
    return moves.length > limit ? moves.slice(0, limit) : moves
  }

  /** 可以直接成线的空位（用于叶子节点的成线延伸）。烈焰格踩上去会碎，不算。 */
  private collectAttackCells(player: PlayerIndex, out: number[]): void {
    out.length = 0
    const tMe = player + 1
    const windows = WINDOWS
    const board = this.board
    for (let w = 0; w < WINDOW_COUNT; w++) {
      const base = w << 2
      let mine = 0
      let other = 0
      let empty = 0
      let emptyCell = -1
      for (let k = 0; k < 4; k++) {
        const v = board[windows[base + k]]
        if (v === 0) {
          empty += 1
          emptyCell = windows[base + k]
        } else if (v === tMe) mine += 1
        else other += 1
      }
      if (mine === 3 && other === 0 && empty === 1 && !this.blockedByFlame(emptyCell, player) && out.indexOf(emptyCell) < 0) {
        out.push(emptyCell)
      }
    }
  }

  /** 防守阶段的候选落点：高光位（削弱）> 一步成线（反击）> 棋子周围。 */
  private generateDefenseMoves(defender: PlayerIndex, frame: AttackFrame, limit: number): number[] {
    const prio = this.prio
    prio.fill(0)
    const board = this.board

    for (let i = 0; i < frame.cells.length; i++) {
      const cell = frame.cells[i]
      if (board[cell] === 0 && !this.blockedByFlame(cell, defender)) prio[cell] += 4_000 * frame.weights[i]
    }

    const counters = this.scratchCells
    this.collectAttackCells(defender, counters)
    for (const cell of counters) prio[cell] += 1_000_000

    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (board[cell] === 0) continue
      const base = cell * NB_STRIDE
      for (let k = 0; k < NB_STRIDE; k++) {
        const nb = NB24[base + k]
        if (nb >= 0 && board[nb] === 0 && !this.blockedByFlame(nb, defender)) prio[nb] += k < 8 ? PRIO_NEAR1 : PRIO_NEAR2
      }
    }

    // 踩到烈焰的防守等于"硬吃这一击"，候选里直接排除
    const moves: number[] = []
    for (let i = 0; i < CELL_COUNT; i++) {
      if (board[i] === 0 && prio[i] > 0 && !this.blockedByFlame(i, defender)) moves.push(i)
    }
    if (moves.length === 0) {
      for (let i = 0; i < CELL_COUNT; i++) {
        if (board[i] === 0 && !this.blockedByFlame(i, defender)) moves.push(i)
      }
      return moves
    }
    moves.sort((a, b) => prio[b] - prio[a] || a - b)
    return moves.length > limit ? moves.slice(0, limit) : moves
  }

  // -------------------------------------------------------------------------
  // 搜索
  // -------------------------------------------------------------------------

  /**
   * 「行动」节点：返回**根玩家视角**的分数。
   *
   * 本作里 8 个技能全是"用完不交回合"，所以这里把一轮行动看成
   * "任意个技能 + 一个落子"：**技能节点原样递归**（还是同一方、同一深度），
   * 只有落子才推进局面（`continues` = 连下两颗时也还是同一方）。
   *
   * `depth <= 0` 时进入"成线延伸"：只有在能一击成线时才继续展开（否则直接评估），
   * 这样叶子节点永远不会停在"这一手要打出去、但结果还没看"的位置上。
   */
  searchPlace(depth: number, alpha: number, beta: number, turn: PlayerIndex): number {
    this.nodes += 1
    if ((this.nodes & 511) === 0 && this.timeUp()) this.aborted = true
    if (this.aborted) return this.evaluate(turn)

    const me = this.root
    const foe = other(me)
    if (this.hp[me] <= 0 || this.hp[foe] <= 0) return this.evalTerminal(depth)

    const quiesce = depth <= 0
    if (quiesce && depth <= -QUIESCE_LIMIT) return this.evaluate(turn)

    const maximizing = turn === me
    let moves: number[]
    if (quiesce) {
      const forced = this.scratchCells
      this.collectAttackCells(turn, forced)
      if (forced.length === 0) return this.evaluate(turn)
      moves = forced.slice()
    } else {
      moves = this.generateMoves(turn, MAX_MOVES)
    }

    // 技能着法（叶子层不生成：那一层只关心"成线延伸"）
    const skills: SkillMove[] = []
    if (!quiesce) this.generateSkillMoves(turn, skills)

    if (moves.length === 0 && skills.length === 0) {
      return this.hp[me] === this.hp[foe] ? 0 : this.hp[me] > this.hp[foe] ? BOARD_WIN : -BOARD_WIN
    }

    let key = 0
    let ttMove = -1
    if (!quiesce) {
      key = this.hash(turn)
      const cached = this.table.get(key)
      if (cached) {
        ttMove = cached.move
        if (cached.depth >= depth) {
          if (cached.flag === TT_EXACT) return cached.score
          if (cached.flag === TT_LOWER) {
            if (cached.score > alpha) alpha = cached.score
          } else if (cached.flag === TT_UPPER) {
            if (cached.score < beta) beta = cached.score
          }
          if (alpha >= beta) return cached.score
        }
      }
      // TT 里的最佳着法只有当它是"落子"时才用于排序（技能候选本来就少）
      if (ttMove >= 0 && ttMove < CELL_COUNT) {
        const at = moves.indexOf(ttMove)
        if (at > 0) {
          moves.splice(at, 1)
          moves.unshift(ttMove)
        }
      }
    }

    const alphaOrig = alpha
    const betaOrig = beta
    /**
     * 叶子层（`quiesce`）的 **stand-pat**：攻击**不是强制的**，可以"不动"。
     *
     * ⚠️ bugv13 #1 的核心修复。没有 stand-pat 时，叶子层用 `collectAttackCells`
     * 只给"成线着法"，等于把当前行动方**强行**变成"必须攻击"；而本作里攻击会把
     * **反击机会**交给对手（对手成线就抵消、差值反打），所以"被迫攻击"经常是亏的。
     * 于是血量领先的一方在叶子层凭空拿到"必胜"：
     * 实测同一个局面，奇数深度下**全部着法并列同一个必胜分**（`WIN − 4`），
     * 偶数深度却是普通分 —— 选点随深度奇偶来回翻转，AI 强度随机器负载抖动。
     *
     * 加上 stand-pat 后，"被迫攻击"这条假线路会被静态评估比下去，假必胜消失；
     * 同时保留"叶子不会停在未结算的攻击上"的本意（真去攻击就照常结算）。
     */
    let best: number
    if (quiesce) {
      best = this.evaluate(turn)
      if (maximizing) {
        if (best > alpha) alpha = best
      } else if (best < beta) {
        beta = best
      }
      if (alpha >= beta) return best
    } else {
      best = maximizing ? -INF : INF
    }
    let bestId = moves.length > 0 ? moves[0] : skills.length > 0 ? skillMoveId(skills[0].slot, skills[0].target) : -1
    let cut = false

    // ① 技能着法：数量很少，放前面 —— 一旦出现好棋，后面的落子很快被 alpha-beta 剪掉
    for (let i = 0; i < skills.length && !cut; i++) {
      const sk = skills[i]
      const applied = this.applySkill(turn, sk.slot, sk.cells, sk.target)
      let value: number
      // bugv14：「最直接、最不绕弯子」用完会**直接进入攻击阶段**（和落子成线一样要搜防守）
      if (applied.frame !== null) value = this.searchDefend(depth - 1, alpha, beta, turn)
      else if (applied.continues) value = this.searchPlace(depth, alpha, beta, turn)
      else value = this.searchPlace(depth - 1, alpha, beta, other(turn))
      this.endUndo(applied)

      if (maximizing ? value > best : value < best) {
        best = value
        bestId = skillMoveId(sk.slot, sk.target)
      }
      if (maximizing) {
        if (best > alpha) alpha = best
      } else if (best < beta) {
        beta = best
      }
      if (alpha >= beta) cut = true
      if (this.aborted) cut = true
    }

    // ② 落子
    for (let i = 0; i < moves.length && !cut; i++) {
      const move = moves[i]
      const applied = this.applyPlace(move, turn)
      let value: number
      if (applied.frame !== null) value = this.searchDefend(depth - 1, alpha, beta, turn)
      else if (applied.continues) value = this.searchPlace(depth - 1, alpha, beta, turn)
      else value = this.searchPlace(depth - 1, alpha, beta, other(turn))
      this.endUndo(applied)

      if (maximizing ? value > best : value < best) {
        best = value
        bestId = move
      }
      if (maximizing) {
        if (best > alpha) alpha = best
      } else if (best < beta) {
        beta = best
      }
      if (alpha >= beta) {
        if (!quiesce && i > 0) {
          if (this.killerA[turn] !== move) {
            this.killerB[turn] = this.killerA[turn]
            this.killerA[turn] = move
          }
          this.history[move] += depth * depth
        }
        cut = true
      }
      if (this.aborted) cut = true
    }

    if (!quiesce && !this.aborted && Math.abs(best) < BOARD_WIN) {
      const flag = best <= alphaOrig ? TT_UPPER : best >= betaOrig ? TT_LOWER : TT_EXACT
      this.table.set(key, { depth, score: best, flag, move: bestId })
    }
    return best
  }

  /**
   * 防守节点：防守方在攻击阶段落一颗子，随后攻击结算，回合回到攻击方。
   *
   * 判定阶段（`depth <= 0`）也**一定**会展开一次 —— 这样搜索永远不会停在
   * "这一手打出去了、但结果还没看"的位置上（视界效应）。
   */
  searchDefend(depth: number, alpha: number, beta: number, attacker: PlayerIndex): number {
    this.nodes += 1
    if ((this.nodes & 511) === 0 && this.timeUp()) this.aborted = true
    if (this.aborted) return this.evaluate(other(attacker))

    const defender = other(attacker)
    const frame = this.frames[this.frames.length - 1]
    const moves = this.generateDefenseMoves(defender, frame, MAX_MOVES)
    const maximizing = defender === this.root
    let best = maximizing ? -INF : INF

    for (let i = 0; i < moves.length; i++) {
      const applied = this.applyDefense(moves[i], frame)
      // 防守也是"一步棋"，同样消耗一层深度：这样"成线路线"与"普通路线"
      // 在同等深度下的**手数奇偶完全一致**，叶子节点的行棋权（tempo）才不会
      // 一边是己方走、一边是对手走，从而避免各深度结论来回翻转。
      const value = this.searchPlace(depth - 1, alpha, beta, attacker)
      this.endUndo(applied)

      if (maximizing ? value > best : value < best) best = value
      if (maximizing) {
        if (best > alpha) alpha = best
      } else if (best < beta) {
        beta = best
      }
      if (alpha >= beta) break
      if (this.aborted) break
    }
    return best
  }

  private hash(turn: PlayerIndex): number {
    let h = ZOBRIST_TURN[turn]
    const board = this.board
    for (let i = 0; i < CELL_COUNT; i++) {
      const v = board[i]
      if (v !== 0) h ^= ZOBRIST[v - 1][i]
    }
    h ^= Math.imul(this.hp[0] + 40, 0x85ebca6b)
    h ^= Math.imul(this.hp[1] + 40, 0xc2b2ae35)
    // 植物也是局面的一部分：位置与归属决定"加伤 / 抢植物 / 被清掉"，
    // 不混进置换表会把不同局面算成同一个。
    if (this.magicEnabled) {
      let plants = 0
      for (const [cell, owner] of this.plants) {
        plants += Math.imul(cell * 3 + (owner === null ? 1 : owner + 2), 0x27d4eb2f)
      }
      h ^= plants
    }
    // 技能 / 回合状态同理：护盾、连击、增伤、叠子、双子星、无敌、烈焰、冷却……
    // 少算任何一项都会让"局面相同但可用技能不同"的两个节点撞进同一条置换表项。
    if (this.skillEnabled) {
      h ^= Math.imul(this.shield[0] + 1, 0x165667b1)
      h ^= Math.imul(this.shield[1] + 1, 0x9e3779b1)
      h ^= Math.imul(this.bonusActions[0] + 1, 0x7feb352d)
      h ^= Math.imul(this.bonusActions[1] + 1, 0x846ca68b)
      h ^= Math.imul(this.actionsTaken[0] + 1, 0x27d4eb2f)
      h ^= Math.imul(this.actionsTaken[1] + 1, 0xd6e8feb9)
      h ^= Math.imul(this.powerBonus[0] + 1, 0x1b873593)
      h ^= Math.imul(this.powerBonus[1] + 1, 0xcc9e2d51)
      // 增伤的**持续时间**也是局面的一部分（同伤害、不同剩余回合是不同的局面）
      h ^= Math.imul(this.powerUntil[0] + 1, 0x85ebca77)
      h ^= Math.imul(this.powerUntil[1] + 1, 0xc2b2ae4d)
      if (this.sabotage[0]) h ^= 0x5bf03635
      if (this.sabotage[1]) h ^= 0x01234567
      h ^= Math.imul(this.sabotageBonus[0] + 1, 0x6f0f5a91)
      h ^= Math.imul(this.sabotageBonus[1] + 1, 0x3c7a2b6d)
      if (this.twinStar[0]) h ^= 0x2468ace0
      if (this.twinStar[1]) h ^= 0x89abcdef
      if (this.bloomCheaperNext[0]) h ^= 0x1357ace0
      if (this.bloomCheaperNext[1]) h ^= 0x2468bdf1
      // bugv14：临时护甲（值 + 到期回合）、深度思考（值 + 到期回合）、播种窗口、烈焰归属
      h ^= Math.imul(this.tempArmor[0] + 1, 0x1b873593)
      h ^= Math.imul(this.tempArmor[1] + 1, 0xcc9e2d51)
      h ^= Math.imul(this.tempArmorUntil[0] + 1, 0x85ebca7b)
      h ^= Math.imul(this.tempArmorUntil[1] + 1, 0xc2b2ae51)
      h ^= Math.imul(this.strikeBonus[0] + 1, 0x27d4eb3d)
      h ^= Math.imul(this.strikeBonus[1] + 1, 0x165667c5)
      h ^= Math.imul(this.strikeUntil[0] + 1, 0x9e3779c1)
      h ^= Math.imul(this.strikeUntil[1] + 1, 0x85ebcab7)
      if (this.seedGrow[0]) h ^= 0x1b8735a1
      if (this.seedGrow[1]) h ^= 0xcc9e2d61
      for (const [cell, owner] of this.flameOwner) h ^= Math.imul(cell * 3 + owner + 1, 0x6f0f5a91)
      h ^= Math.imul(this.immuneUntil[0] + 1, 0x85ebca6b)
      h ^= Math.imul(this.immuneUntil[1] + 1, 0xc2b2ae35)
      h ^= Math.imul(this.turnNo + 1, 0x9e3779b1)
      for (let p = 0; p < 2; p++) {
        const ready = this.skillReadyAt[p]
        const casts = this.skillCasts[p]
        for (let s = 0; s < ready.length; s++) {
          h ^= Math.imul(ready[s] + 1, 0x7feb352d + p * 7 + s * 13)
          h ^= Math.imul(casts[s] + 1, 0x846ca68b + p * 7 + s * 13)
        }
      }
      for (const [cell, owner] of this.overlay) h ^= Math.imul(cell * 4 + owner + 1, 0x27d4eb2f)
      for (const [cell, left] of this.flames) h ^= Math.imul(cell * 64 + left + 1, 0x165667b1)
    }
    return h | 0
  }

  /**
   * 根节点：选**下一条行动**（技能 或 落子）。
   *
   * 因为 8 个技能都是"用完不交回合"，根节点的完整计划是"任意个技能 + 一个落子"。
   * `decideMove` 会反复调用本方法：拿到技能就先施加它、再来一次；拿到落子就收工。
   */
  searchRootStep(
    depth: number,
    previous: ReadonlyMap<number, number> | null,
  ): { action: RootAction; score: number; scores: Map<number, number> } {
    const turn = this.root
    const moves = this.generateMoves(turn, MAX_ROOT_MOVES)
    if (previous && previous.size > 0) {
      moves.sort((a, b) => (previous.get(b) ?? -INF) - (previous.get(a) ?? -INF))
    }
    const skills: SkillMove[] = []
    this.generateSkillMoves(turn, skills)

    const scores = new Map<number, number>()
    let best = -INF
    let bestAction: RootAction =
      moves.length > 0
        ? { kind: 'place', cell: moves[0] }
        : skills.length > 0
          ? { kind: 'skill', slot: skills[0].slot, cells: skills[0].cells, target: skills[0].target }
          : { kind: 'place', cell: -1 }

    // ① 技能着法
    for (let i = 0; i < skills.length; i++) {
      const sk = skills[i]
      const applied = this.applySkill(turn, sk.slot, sk.cells, sk.target)
      let value: number
      // bugv14：「最直接、最不绕弯子」直接进入攻击阶段 → 要搜防守方的应对
      if (applied.frame !== null) value = this.searchDefend(depth - 1, best, INF, turn)
      else if (applied.continues) value = this.searchPlace(depth, best, INF, turn)
      else value = this.searchPlace(depth - 1, best, INF, other(turn))
      this.endUndo(applied)

      scores.set(skillMoveId(sk.slot, sk.target), value)
      if (value > best) {
        best = value
        bestAction = { kind: 'skill', slot: sk.slot, cells: sk.cells.slice(), target: sk.target }
      }
      if (this.aborted) break
      if (best >= WIN) break
    }

    // ② 落子
    for (let i = 0; i < moves.length; i++) {
      const move = moves[i]
      const applied = this.applyPlace(move, turn)
      let value: number
      if (applied.frame !== null) value = this.searchDefend(depth - 1, best, INF, turn)
      else if (applied.continues) value = this.searchPlace(depth - 1, best, INF, turn)
      else value = this.searchPlace(depth - 1, best, INF, other(turn))
      this.endUndo(applied)

      scores.set(move, value)
      if (value > best) {
        best = value
        bestAction = { kind: 'place', cell: move }
      }
      if (this.aborted) break
      if (best >= WIN) break
    }
    return { action: bestAction, score: best, scores }
  }

  /**
   * 根节点：解出**完整计划**（任意个技能 + 一个落子）。
   *
   * 技能"用完不交回合"，所以计划可能多步：反复 `searchRootStep`，拿到技能就先施加、
   * 继续解下一步；拿到落子就收工。方法内部会把为"解计划"而施加的技能全部回滚，
   * 离开时搜索器状态与调用前一致。
   */
  searchRootPlan(
    depth: number,
    previous: ReadonlyMap<number, number> | null,
  ): { plan: RootAction[]; score: number; scores: Map<number, number> | null; aborted: boolean } {
    const pending: Undo[] = []
    const plan: RootAction[] = []
    let score = -INF
    let scores: Map<number, number> | null = null
    let aborted = false

    for (let step = 0; step < MAX_ROOT_STEPS; step++) {
      const r = this.searchRootStep(depth, step === 0 ? previous : null)
      if (this.aborted) {
        aborted = true
        break
      }
      plan.push(r.action)
      if (step === 0) {
        score = r.score
        scores = r.scores
      }
      if (r.action.kind === 'place') break
      const applied = this.applySkill(this.root, r.action.slot, r.action.cells, r.action.target)
      pending.push(applied)
      // endsTurn 技能：用完回合已经交给对手，本回合不能再落子 → 计划到此为止
      // （bugv32 起没有技能 endsTurn 了，但保留通用判断）
      if (!applied.continues) break
      // bugv14：「最直接、最不绕弯子」用完直接进入攻击阶段 → 计划也到此为止
      if (applied.frame !== null) break
    }
    for (let i = pending.length - 1; i >= 0; i--) this.endUndo(pending[i])
    return { plan, score, scores, aborted }
  }

  /**
   * 根节点（攻击阶段的防守回合）。`frame` 由请求构造。
   *
   * 防守回合有一个**确定性的立即结算**：落子之后马上就能算出"我掉几点血、他掉几点血、
   * 有没有被打死"，而且攻击阶段结束后回合**一定回到攻击方** —— 也就是说防守这一手
   * 没有节奏代价，唯一的即时后果就是血量。因此先用它做一次**硬过滤**
   * （不被杀死 > 打死对手 > 净血量收益最大），只有在"立即结果完全相同"的候选之间，
   * 才交给搜索去比较后续走势。
   *
   * 为什么必须这样：hp 只有 6，一次攻击就是 3~5 点。用浅层搜索去比较
   * "现在白吃 4 血、将来能赚回来"这种推测，很容易被视界效应带偏
   * （实测：会为了"保住场上棋子"而白吃 4 点伤害，20 手内被打死；
   * 而同样局面下选择"反击抵消、一点血不掉"的着法最终能赢）。
   */
  searchRootDefend(
    depth: number,
    frame: AttackFrame,
    previous: ReadonlyMap<number, number> | null,
  ): { move: number; score: number; scores: Map<number, number> } {
    const defender = other(frame.attacker)
    const moves = this.generateDefenseMoves(defender, frame, MAX_ROOT_MOVES)

    // ① 立即结算：给每个候选算出确定性的结果并排序（按**实际掉血**，护盾也算进去）
    const rank = new Map<number, number>()
    let bestRank = -Infinity
    let fallback = moves[0]
    for (let i = 0; i < moves.length; i++) {
      const move = moves[i]
      const hpMeBefore = this.hp[defender]
      const hpFoeBefore = this.hp[frame.attacker]
      const applied = this.applyDefense(move, frame)
      const myDamage = hpMeBefore - this.hp[defender]
      const theirDamage = hpFoeBefore - this.hp[frame.attacker]
      const lethalMe = this.hp[defender] <= 0
      const lethalThem = this.hp[frame.attacker] <= 0
      const value = lethalThem ? 1_000_000 : lethalMe ? -1_000_000 : theirDamage - myDamage
      rank.set(move, value)
      if (value > bestRank) {
        bestRank = value
        fallback = move
      }
      this.endUndo(applied)
    }

    // ② 只有"立即结果一样好"的那些候选才值得再往下搜
    const candidates = moves.filter((move) => rank.get(move) === bestRank)
    if (candidates.length <= 1) {
      return { move: fallback, score: bestRank, scores: new Map([[fallback, bestRank]]) }
    }
    if (previous && previous.size > 0) {
      candidates.sort((a, b) => (previous.get(b) ?? -INF) - (previous.get(a) ?? -INF))
    }

    const scores = new Map<number, number>()
    let best = -INF
    let bestMove = candidates[0]

    for (let i = 0; i < candidates.length; i++) {
      const move = candidates[i]
      const applied = this.applyDefense(move, frame)
      const value = this.searchPlace(depth - 1, best, INF, frame.attacker)
      this.endUndo(applied)

      scores.set(move, value)
      if (value > best) {
        best = value
        bestMove = move
      }
      if (this.aborted) break
      if (best >= WIN) break
    }
    return { move: bestMove, score: best, scores }
  }
}
