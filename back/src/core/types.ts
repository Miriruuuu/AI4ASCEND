/**
 * 四子棋（9×9 连珠对战）核心类型定义。
 *
 * 该文件不依赖任何渲染库或框架，可直接被 Vue3 + TS 宿主工程复用。
 */

/** 棋盘边长。 */
export const BOARD_SIZE = 9
/**
 * 初始血量（同时是回血上限与**护盾上限**，见 `GameEngine.addShield`）。
 *
 * bugv16：6 → 8（用户指定）。血量抬高会显著改变节奏：
 * 一次成线攻击只有 3~5 伤、回血 1 点/次，所以"打不死"的局面变多，
 * 长局与资源（植物 / 护盾）的价值随之上升。
 *
 * bugv34：8 → 12。这是**默认血量上限**：
 * - 非联机对局可在设置里选 8 / 12 / 16（`ui.hpLimit`，默认 12，见 useConnectGame）；
 * - **联机对局固定用这个默认值**（联机两端必须一致，不接受本地设置）。
 */
export const INITIAL_HP = 12
/** 非联机"血量上限"可选项（bugv34）。 */
export const HP_LIMITS: readonly number[] = [8, 12, 16]
/** 触发攻击所需的连珠长度。 */
export const MIN_LINE_LENGTH = 4
/** 棋盘总格数。 */
export const CELL_COUNT = BOARD_SIZE * BOARD_SIZE
/** 攻击方最终攻击值的下限（规则 2.5：正常规则下不会降至 0）。 */
export const MIN_ATTACK_VALUE = 1

/** 0 = 先手方（红），1 = 后手方（蓝）。 */
export type PlayerIndex = 0 | 1
/** 0 = 空位，否则为落子方。 */
export type Cell = 0 | 1 | 2

/** 一维棋盘，索引 = row * BOARD_SIZE + col。长度恒为 81。 */
export type Board = Cell[]

/** 行列坐标。 */
export interface CellPos {
  readonly row: number
  readonly col: number
}

/** 由坐标生成稳定 id（同时也是棋盘数组下标）。 */
export function cellId(row: number, col: number): number {
  return row * BOARD_SIZE + col
}

/** 由棋盘下标还原坐标。 */
export function cellPos(index: number): CellPos {
  return { row: Math.floor(index / BOARD_SIZE), col: index % BOARD_SIZE }
}

/** 坐标是否在棋盘内。 */
export function isInsideBoard(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE
}

/** 单元格归属：1 表示先手方，2 表示后手方。 */
export function cellOf(player: PlayerIndex): Cell {
  return (player + 1) as Cell
}

/** 由单元格归属反推玩家（空位返回 null）。 */
export function playerOf(cell: Cell): PlayerIndex | null {
  if (cell === 0) return null
  return (cell - 1) as PlayerIndex
}

/** 对手。 */
export function other(player: PlayerIndex): PlayerIndex {
  return player === 0 ? 1 : 0
}

/** 创建空棋盘。 */
export function createBoard(): Board {
  return new Array<Cell>(CELL_COUNT).fill(0)
}

/** 复制棋盘。 */
export function cloneBoard(board: Board): Board {
  return board.slice()
}

// ---------------------------------------------------------------------------
// 连珠
// ---------------------------------------------------------------------------

export interface Line {
  /** 连珠长度（正常 ≥ `MIN_LINE_LENGTH`；双子星把门槛降到 2，bugv11 #5）。 */
  readonly length: number
  /** 该连珠包含的棋盘下标，按方向顺序排列。 */
  readonly cells: readonly number[]
  /** 归一化方向：{dr, dc}，dc >= 0，用于稳定排序与展示。 */
  readonly direction: readonly [number, number]
}

/** 四个检测方向（只保留半个方向集合，避免重复）。 */
export const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], // 横
  [1, 0], // 竖
  [1, 1], // 主对角
  [1, -1], // 副对角
]

export function directionName(dir: readonly [number, number]): '横' | '竖' | '斜' {
  if (dir[0] === 0) return '横'
  if (dir[1] === 0) return '竖'
  return '斜'
}

// ---------------------------------------------------------------------------
// 回合 / 阶段
// ---------------------------------------------------------------------------

export type MatchPhase =
  /** 掷骰子决定先后手。 */
  | 'setup'
  /** 等待先手方（或当前回合方）落子。 */
  | 'playing'
  /** 攻击方已宣告攻击，等待防守方下子抵消。 */
  | 'awaitingDefense'
  /** 攻击阶段结算完成，等待下一回合开始。 */
  | 'resolving'
  /** 对局结束。 */
  | 'gameOver'

/** 结算方式。 */
export type ResolutionMode =
  /** 攻击方直接造成伤害。 */
  | 'damage'
  /** 攻击方棋子飞向防守方血条。 */
  | 'defenderDamaged'
  /** 防守方棋子飞向攻击方血条。 */
  | 'attackerDamaged'
  /** 双方抵消，无伤害。 */
  | 'canceled'
  /** 伤害被「精密计算」的无敌完全挡下（bugv10 #9）。 */
  | 'immune'

export type GameResultReason =
  /** 血量归零。 */
  | 'hp'
  /** 棋盘下满，血多者胜。 */
  | 'boardFull'

export interface GameResult {
  /** null 表示平局。 */
  readonly winner: PlayerIndex | null
  readonly reason: GameResultReason
  readonly hp: readonly [number, number]
}

/** 攻击阶段的完整快照，供 UI 结算面板展示。 */
export interface AttackSnapshot {
  readonly attacker: PlayerIndex
  readonly defender: PlayerIndex
  /** 攻击方参与连珠的实体棋子（去重）数量 = 基础伤害。 */
  readonly baseDamage: number
  /** 攻击方连珠总长（所有连珠长度之和）。 */
  readonly lineLengthSum: number
  /** 防守方落子位置。 */
  readonly defenseCell: number | null
  /** 该位置属于攻击方几条连珠。 */
  readonly weakness: number
  /** 攻击方最终攻击值 = baseDamage + 魔力植物加成 - weakness。 */
  readonly finalAttack: number
  /** 防守方攻击值（未形成连珠为 0，含其魔力植物加成）。 */
  readonly defenderAttack: number
  /** |finalAttack - defenderAttack|。 */
  readonly diff: number
  readonly mode: ResolutionMode | null
  /** 受击方。 */
  readonly damaged: PlayerIndex | null
  /** 攻击方计入伤害的魔力植物数量（bugv8 #4，已被抢走的不算）。 */
  readonly attackerPlants?: number
  /** 防守方计入伤害的魔力植物数量（含从攻击方抢来的）。 */
  readonly defenderPlants?: number
  /** 攻击方因本次防守被抢走的魔力植物数量。 */
  readonly stolenPlants?: number
  /** 攻击方因「小一哥」获得的额外攻击棋子数（bugv10 #9）。 */
  readonly powerBonus?: number
  /** 攻击方因「毒鸡蛋」获得的额外伤害（bugv12 #3，本回合 +1，可与小一哥叠加）。 */
  readonly sabotageBonus?: number
  /** 攻击方因「本地部署」获得的额外伤害（bugv34m，本回合 +1，成连珠才生效）。 */
  readonly deployBonus?: number
  /**
   * bugv19「杀鲸霸拳」降低消耗（2 棵）时：这一回合**魔力植物不提供伤害加成**。
   *
   * 两个字段分别表示攻击方 / 防守方的植物加伤被关掉了（UI 提示用；数值本身已经按 0 算）。
   */
  readonly attackerPlantBonusOff?: boolean
  readonly defenderPlantBonusOff?: boolean
  /** 攻击方因「深度思考」获得的额外攻击棋子数（bugv14，首个连珠攻击 +N / 对手无反成线再 +N）。 */
  readonly strikeBonus?: number
  /** 「深度思考」在"对手没能成线反击"时**追加**的伤害（bugv14）。 */
  readonly strikeExtra?: number
  /** 本次伤害被「精密计算」的无敌完全挡下（bugv10 #9，值为无敌的一方）。 */
  readonly immune?: PlayerIndex | null
  /**
   * 本次攻击时正在生效的天气（bugv34d）。
   *
   * 与下面两个 `*Delta` 一起给结算面板显示"天气造成了多少增伤 / 减伤"。
   */
  readonly weather?: WeatherId | null
  /**
   * 天气对**攻击方**最终攻击值的净影响（正 = 增伤，负 = 减伤，可正可负）。
   *
   * 口径：`含天气的最终攻击值 − 无天气时的最终攻击值`。因此它天然涵盖
   * 雷暴污染体 +2、枯竭/暴雪植物不加伤、干涸 −1、瘟疫分裂给攻击方的那一份。
   * 纯展示字段，**不参与联机指纹**（快照本来就不在指纹里）。
   */
  readonly weatherAttackDelta?: number
  /** 天气对**防守方**反击值的净影响（口径同上）。 */
  readonly weatherDefenderDelta?: number
}

// ---------------------------------------------------------------------------
// 魔力植物（bugv8 #4）
// ---------------------------------------------------------------------------

/**
 * 魔力植物种类：小花 / 劲草 / 矮蕨（bugv10 #12：银白 + 褐 + 黄 + 绿四色相间）。
 *
 * bugv34：新增 `'pollution'` —— 黑夜「雷暴」天气下长出的**污染体**（最外层盖深红高光，
 * 结算伤害时每棵 +2，见 `Weather.md`）。
 * bugv34c：新增 `'frozen'` —— 黑夜「暴雪」天气下被**冻结**的植物（雪白 + 冰晶，
 * **不提供伤害加成**；被棋子占有的在连珠后解冻）。
 *
 * ⚠️ 这两种都是**天气造成的临时种类**，**不要**加进 `MAGIC_KINDS`（那是随机生长的取值表）。
 */
export type MagicKind = 'flower' | 'grass' | 'fern' | 'pollution' | 'frozen'

/** 棋盘上的一棵魔力植物。`cell` 必为棋盘下标；`owner` 为 null 表示还没被任何一方"占住"。 */
export interface MagicPlant {
  readonly cell: number
  readonly kind: MagicKind
  readonly owner: PlayerIndex | null
}

/**
 * 魔力植物的可调参数（bugv8 #4：写在配置里、设置面板可改、联机固定用默认值）。
 *
 * 生长规则（对应需求原文）：
 * - 冷却 `cooldownTurns` 回合（默认 10）后，在空位长出 `baseCount`（默认 2）棵；
 * - 任意一方形成连珠时，冷却立刻减少 `lineCooldownCut`（默认 8）回合；
 * - `requireLine` 时，必须先有至少一方连珠过，才会开始长；
 * - 每长出 `growthStep`（默认 3）次，单次数量 +1，上限 `maxCount`（默认 4）；
 * - 连珠上每有一棵魔力植物，最终伤害 +`damagePerPlant`（默认 1）；
 * - `spawnPreference`（bugv34）决定长在哪：`random` = 任意空位；`nearStone` = 优先贴着已有棋子。
 */
export interface MagicConfig {
  readonly enabled: boolean
  readonly cooldownTurns: number
  readonly lineCooldownCut: number
  readonly baseCount: number
  readonly growthStep: number
  readonly maxCount: number
  readonly damagePerPlant: number
  readonly requireLine: boolean
  /** 生成位置偏好（bugv34）：随机空位 / 优先在棋子附近。 */
  readonly spawnPreference: MagicSpawnPreference
}

/** 魔力植物的生成位置偏好（bugv34）。 */
export type MagicSpawnPreference = 'random' | 'nearStone'

// ---------------------------------------------------------------------------
// 黑夜机制与天气（bugv34，规格见 Weather.md）
// ---------------------------------------------------------------------------

/** 黑夜阶段：`none` = 白天；`pending` = 预告中（还剩几回合）；`active` = 黑夜降临中。 */
export type NightPhase = 'none' | 'pending' | 'active'

/** 七种黑夜天气（bugv34 四种 + bugv34c 追加三种）。 */
export type WeatherId =
  | 'thunder'
  | 'drought'
  | 'depletion'
  | 'plague'
  | 'dryLightning'
  | 'blizzard'
  | 'aurora'

export interface WeatherDef {
  readonly id: WeatherId
  readonly name: string
  /** 主题色（棋盘下方文字 / 详情弹窗用，互不相同以便区分）。 */
  readonly color: string
  readonly detail: string
}

/** 天气表（顺序即抽取顺序，联机两端必须一致）。 */
export const WEATHERS: readonly WeatherDef[] = [
  {
    id: 'thunder',
    name: '雷暴',
    color: '#a855f7',
    // 文案口径见项目根的 `Weather.md`（对局内只显示这句话）
    detail: '魔力植物转变为污染体，为最终伤害+2。',
  },
  {
    id: 'drought',
    name: '干涸',
    color: '#f59e0b',
    detail: '场上不再生成魔力植物，双方在攻击阶段伤害-1。',
  },
  {
    id: 'depletion',
    name: '枯竭',
    color: '#38bdf8',
    detail: '结算伤害时魔力植物不再提供伤害加成。',
  },
  {
    id: 'plague',
    name: '瘟疫',
    color: '#22c55e',
    detail: '连珠后魔力植物会为双方提供伤害加成。',
  },
  {
    id: 'dryLightning',
    name: '旱雷',
    color: '#eab308',
    detail: '魔力植物会遭受雷击。',
  },
  {
    id: 'blizzard',
    name: '暴雪',
    color: '#0891b2',
    detail: '魔力植物会被冻结。',
  },
  {
    id: 'aurora',
    name: '极光',
    color: '#ec4899',
    detail: '魔力植物可治愈双方。',
  },
]

/** 按 id 取天气定义。 */
export function weatherDef(id: WeatherId): WeatherDef {
  return WEATHERS.find((w) => w.id === id) ?? WEATHERS[0]
}

/** 黑夜机制的可调参数（bugv34，写在配置里、联机固定用默认值）。 */
export interface NightConfig {
  /** 总开关。 */
  readonly enabled: boolean
  /**
   * 「黑夜开局」（bugv34 补充）：开局就直接进入黑夜（**没有预告**），默认关闭。
   *
   * 开启后跳过进入条件与预告，第一手棋落下时黑夜已经生效。
   */
  readonly startInNight: boolean
  /** 预告持续几回合（双方回合）。 */
  readonly warnTurns: number
  /** 距上次黑夜结束至少要过几回合才能再次触发。 */
  readonly minGap: number
  /** 触发条件的"回合数"阈值：游戏开始这么多回合后满足。 */
  readonly startTurnThreshold: number
  /** 触发条件的"攻击棋子数"阈值（或：双方攻击棋子总数超过它）。 */
  readonly entryAttackThreshold: number
  /** 触发条件的"场上植物数"阈值（严格大于）。 */
  readonly entryPlantThreshold: number
  /** 退出条件 A：黑夜持续 ≥ 这么多回合。 */
  readonly exitTurnsA: number
  /** 退出条件 A：黑夜期间双方攻击棋子增量 ≥ 这个数。 */
  readonly exitAttacksA: number
  /** 退出条件 B：黑夜持续 > 这么多回合（直接退）。 */
  readonly exitTurnsB: number
  /** 退出条件 B：黑夜期间攻击棋子增量 > 这个数（直接退）。 */
  readonly exitAttacksB: number
}

export const DEFAULT_NIGHT_CONFIG: NightConfig = {
  enabled: true,
  startInNight: false,
  /** 预告 3 回合（bugv34d，原 2）。 */
  warnTurns: 3,
  minGap: 20,
  /** 开局 50 回合（bugv34d，原 60）或双方攻击棋子 > 10。 */
  startTurnThreshold: 50,
  entryAttackThreshold: 10,
  entryPlantThreshold: 10,
  /** 结束条件 A：持续 ≥ 30 且期间攻击 ≥ 20（bugv34d，原 15）。 */
  exitTurnsA: 30,
  exitAttacksA: 20,
  /** 强制结束：持续 > 60（原 50）/ 期间攻击 > 40（原 30）。 */
  exitTurnsB: 60,
  exitAttacksB: 40,
}

export function resolveNightConfig(partial?: Partial<NightConfig> | null): NightConfig {
  if (!partial) return DEFAULT_NIGHT_CONFIG
  const int = (v: number | undefined, fb: number): number =>
    v === undefined || !Number.isFinite(v) ? fb : Math.max(0, Math.round(v))
  return {
    enabled: partial.enabled ?? DEFAULT_NIGHT_CONFIG.enabled,
    startInNight: partial.startInNight ?? DEFAULT_NIGHT_CONFIG.startInNight,
    warnTurns: int(partial.warnTurns, DEFAULT_NIGHT_CONFIG.warnTurns),
    minGap: int(partial.minGap, DEFAULT_NIGHT_CONFIG.minGap),
    startTurnThreshold: int(partial.startTurnThreshold, DEFAULT_NIGHT_CONFIG.startTurnThreshold),
    entryAttackThreshold: int(partial.entryAttackThreshold, DEFAULT_NIGHT_CONFIG.entryAttackThreshold),
    entryPlantThreshold: int(partial.entryPlantThreshold, DEFAULT_NIGHT_CONFIG.entryPlantThreshold),
    exitTurnsA: int(partial.exitTurnsA, DEFAULT_NIGHT_CONFIG.exitTurnsA),
    exitAttacksA: int(partial.exitAttacksA, DEFAULT_NIGHT_CONFIG.exitAttacksA),
    exitTurnsB: int(partial.exitTurnsB, DEFAULT_NIGHT_CONFIG.exitTurnsB),
    exitAttacksB: int(partial.exitAttacksB, DEFAULT_NIGHT_CONFIG.exitAttacksB),
  }
}

/**
 * 默认配置（联机固定使用这一份）。
 *
 * ⚠️ bugv13 #4：`requireLine` 从 `true` 改成 `false`。
 *
 * 原来"必须先出现连珠才长植物"会让**技能在前半场结构上不可用**：实测一局实机回放里
 * 首个连珠出现在第 72 手（全场 103 手），第一棵植物到第 75 手才出现 ——
 * 也就是说 73% 的对局时间里一张棋盘上没有任何植物，而两个技能都要 1~2 棵植物，
 * 于是 AI 的全场技能释放次数是 0。
 *
 * 自对弈对照（12 局 / 双方专家档 / 70ms）：
 * | 配置 | 首次长植物 | 植物/局 | 技能释放 P0/P1 | 平均手数 |
 * |---|---|---|---|---|
 * | `requireLine: true`（旧默认） | 第 20.3 手 | 24.3 | 3.4 / 1.8 | 69.5 |
 * | **`requireLine: false`（新默认）** | **第 10.0 手** | 25.9 | 4.2 / 2.2 | 60.1 |
 * | 并降冷却到 6 | 第 6.0 手 | 34.5 | 4.7 / 2.1 | 53.6 |
 *
 * 取中间那档：植物提前到第 10 手左右，技能使用率上升；不再降冷却是因为
 * 每局 34.5 棵会把棋盘铺得太满。玩家仍可在设置面板里改回 `requireLine: true`。
 */
export const DEFAULT_MAGIC_CONFIG: MagicConfig = {
  enabled: true,
  cooldownTurns: 10,
  lineCooldownCut: 8,
  baseCount: 2,
  growthStep: 3,
  maxCount: 4,
  damagePerPlant: 1,
  requireLine: false,
  spawnPreference: 'random',
}

/** 合并用户配置（设置面板里只改其中几项）。 */
export function resolveMagicConfig(partial?: Partial<MagicConfig> | null): MagicConfig {
  if (!partial) return DEFAULT_MAGIC_CONFIG
  return {
    enabled: partial.enabled ?? DEFAULT_MAGIC_CONFIG.enabled,
    cooldownTurns: clampInt(partial.cooldownTurns, 1, 99, DEFAULT_MAGIC_CONFIG.cooldownTurns),
    lineCooldownCut: clampInt(partial.lineCooldownCut, 0, 99, DEFAULT_MAGIC_CONFIG.lineCooldownCut),
    baseCount: clampInt(partial.baseCount, 1, 8, DEFAULT_MAGIC_CONFIG.baseCount),
    growthStep: clampInt(partial.growthStep, 1, 99, DEFAULT_MAGIC_CONFIG.growthStep),
    maxCount: clampInt(partial.maxCount, 1, 8, DEFAULT_MAGIC_CONFIG.maxCount),
    damagePerPlant: clampInt(partial.damagePerPlant, 0, 5, DEFAULT_MAGIC_CONFIG.damagePerPlant),
    requireLine: partial.requireLine ?? DEFAULT_MAGIC_CONFIG.requireLine,
    spawnPreference:
      partial.spawnPreference === 'nearStone' || partial.spawnPreference === 'random'
        ? partial.spawnPreference
        : DEFAULT_MAGIC_CONFIG.spawnPreference,
  }
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** 第 `growths` 次生长（0 起）会一次长出几棵。 */
export function magicCountForGrowth(growths: number, config: MagicConfig = DEFAULT_MAGIC_CONFIG): number {
  const steps = Math.floor(Math.max(growths, 0) / Math.max(config.growthStep, 1))
  return Math.min(config.maxCount, config.baseCount + steps)
}

/** 魔力植物的中文名（UI 展示）。 */
export function magicKindName(kind: MagicKind): string {
  if (kind === 'flower') return '银白小花'
  if (kind === 'grass') return '三叶劲草'
  if (kind === 'pollution') return '污染体'
  if (kind === 'frozen') return '冻结的魔力植物'
  return '银蕨'
}

// ---------------------------------------------------------------------------
// 角色技能（bugv9 #13）
// ---------------------------------------------------------------------------

/**
 * 技能效果类型。
 *
 * - `shield`   获得护盾（先于血量承伤，无上限）；deepseek 1 技能「大胃袋」
 * - `heal`     恢复血量（不超过初始血量）；gemini 1 技能「猫的憩息」
 * - `double`   当前回合可连续下两颗子（下完两颗才进入攻击阶段，bugv10 #4）；deepseek 2 技能「杀鲸霸拳」
 * - `bloom`    点亮「双子星」爆发窗口：本回合形成**两连**即可发起攻击，并且这一击免疫对手的
 *              反击伤害（bugv11 #5；最初"长魔力植物"的效果已按需求去掉）；gemini 2 技能「双子星」
 * - `immune`   直到对手的下个回合结束前无敌；gtp 1 技能「精密计算」
 * - `fireball` 向棋盘点选的位置投射火球，该位置横竖的空位被烈焰覆盖；gtp 2 技能「恶龙吐息」
 * - `power`    当前回合伤害 +N（生成攻击棋子时额外从技能槽飞出一颗）；glm 1 技能「小一哥」
 * - `sabotage` 当前回合可以下在敌方棋子上（不顶替原棋子）；glm 2 技能「毒鸡蛋」
 */
export type SkillEffect =
  | 'shield'
  | 'heal'
  | 'double'
  | 'bloom'
  | 'immune'
  | 'fireball'
  | 'power'
  | 'sabotage'
  /** bugv14：临时护甲（只在这段时间内承伤，到期清零）。gtp「精密计算」。 */
  | 'tempArmor'
  /** bugv14：首个连珠攻击 +N；对手没能成线反击则再 +N。claude「深度思考」。 */
  | 'firstStrike'
  /** bugv14：本回合落子若**未成连珠**，在落点周围长魔力植物。claude「播种」。 */
  | 'seedGrow'
  /** bugv14：自己 +N 护甲、对手 +M 护甲（`shareToFoe`）。seedance「稳稳的接住你」。 */
  | 'guardShare'
  /** bugv14：直接进入攻击阶段，攻击值 = 消耗的魔力植物数量。seedance「最直接、最不绕弯子」。 */
  | 'assault'
  /**
   * bugv34m：「本地部署」（Qwen 1 技能）。
   *
   * 使用后本回合落子时：**未成连珠** → 在落点长出一棵魔力植物（该格已有植物则跳过）；
   * **成连珠** → 本次攻击伤害 +1。另有一条**被动**：己方每次形成连珠且连珠上有魔力植物，
   * 本技能冷却减少「该连珠上的魔力植物数量」回合（见 `SkillSpec.cooldownCutOnMatchPlants`）。
   */
  | 'localDeploy'
  /**
   * bugv34m：「小千问」（Qwen 2 技能）。
   *
   * 消耗 1~2 棵魔力植物并**移除压在这些植物上的棋子**；本回合落子后若**未成连珠**，
   * 随机把这批棋子重新下到空位（优先"落点周围且带魔力植物"的空位），
   * 剔除所有会形成连珠的位置；放不下的棋子回原位、植物一并返还，
   * 冷却按 `3 × 实际放下数量` 计（可变消耗 `cooldownPerUnit = 3`）。
   */
  | 'redeploy'

/**
 * 可变消耗（bugv14「最直接、最不绕弯子」）。
 *
 * 释放时由玩家自选消耗 `min ~ max` 棵魔力植物，冷却 = `cooldownPerUnit × 实际消耗`。
 * 标了这个字段的技能，`SkillSpec.cost` / `cooldown` 只是展示用的下限（= min / min × perUnit）。
 */
export interface VariableCost {
  readonly min: number
  readonly max: number
  /** 每消耗 1 棵植物要等几次行动才能再用。 */
  readonly cooldownPerUnit: number
  /**
   * bugv19：冷却**不随消耗变化**（固定用 `SkillSpec.cooldown`）。
   *
   * seedance「最不绕弯子」是"消耗越多越强、冷却也越久"，所以按 `cooldownPerUnit` 线性缩放；
   * deepseek「杀鲸霸拳」的两个档位是**同一次连下的两种打法**，冷却保持 10 不变。
   */
  readonly flatCooldown?: boolean
  /**
   * bugv19：按**下限**数量释放时附带的代价。
   *
   * - `'noPlantBonus'`：这一回合该玩家的魔力植物不提供伤害加成
   *   （deepseek「杀鲸霸拳」：2 费可以更快打出，但换来的这一手打不出植物加伤 ——
   *   用于大连击 / 封堵，而不是用来打爆发）。
   */
  readonly minCostPenalty?: 'noPlantBonus'
}

/**
 * 一个技能的数值定义。
 *
 * 引擎只认这份数值，不认"角色"：宿主（Vue store）把角色的技能表传进来，
 * 服务端 / 单测可以传任意技能表。
 */
export interface SkillSpec {
  readonly id: string
  readonly name: string
  /** 消耗几棵"被我方棋子占用的魔力植物"。 */
  readonly cost: number
  /** 冷却：用完之后需要再行动几次才能再用（开局即处于冷却中）。 */
  readonly cooldown: number
  readonly effect: SkillEffect
  /** 效果强度（护盾点数 / 回血点数 / 连续行动次数 / 生长半径 / 伤害加成 / 燃烧回合数）。 */
  readonly amount: number
  /**
   * 强度按**生命上限**取值（bugv29：gtp「精密计算」——临时护甲 = 生命上限）。
   *
   * 设置后忽略 `amount`，改用引擎的 `initialHp`。这样改血量上限时护甲自动跟着走。
   */
  readonly amountFromMaxHp?: boolean
  /**
   * 效果**持续几个回合**（默认 1 = 只有使用它的那个回合）。
   *
   * bugv12 #2：`power`（小一哥）的增伤持续 2 回合 —— 使用技能的当前回合 + 自己的下一个回合。
   */
  readonly duration?: number
  /** 用完之后是否立刻把回合交给对手（默认 false：还能继续落子）。 */
  readonly endsTurn?: boolean
  /** 挑完魔力植物之后是否还需要在棋盘上点一个目标格（bugv10 #9 恶龙吐息）。 */
  readonly targetsCell?: boolean
  /** 开局**不进入冷却**：一上来就能用（bugv11 #6 恶龙吐息）。 */
  readonly startReady?: boolean
  /** **首次释放无需消耗**魔力植物（bugv11 #6：只有第一次免费，用掉之后按 cost 收费）。 */
  readonly freeFirst?: boolean
  /**
   * 释放时**对手**额外获得的护盾点数（bugv14「稳稳的接住你」：自己 +2、对手 +1）。
   *
   * ⚠️ 只有 `guardShare` 会读它；其它效果一律忽略。
   */
  readonly shareToFoe?: number
  /** 可变消耗（bugv14：「直接进入攻击阶段，攻击数 = 消耗的植物数」）。 */
  readonly variableCost?: VariableCost
  /**
   * 受到伤害后，冷却**前进的手数**（bugv18「猫的憩息」）。
   *
   * bugv24：由"立即清零"改为前进 N 手（gemini 取 `2`）—— 原"随时可治"实测过强
   * （约 7 次/局 ≈ 一整条命）。未定义 = 受伤不影响冷却。
   */
  readonly cooldownAdvanceOnDamage?: number
  /**
   * 效果**还在生效期间**不能重复释放（bugv18「小一哥」的口径，bugv30 变成通用开关）。
   *
   * 生效判定按效果各自的"到期回合"字段：`power` 看 `powerUntil`、
   * `firstStrike` 看 `strikeUntil`（见 `GameEngine.effectActive`）。
   */
  readonly noRepeat?: boolean
  /**
   * 这一击**成功造成伤害**后，把受伤方的**护盾与临时护甲全部移除**（bugv30 破盾 / bugv31 扩到护甲）。
   *
   * 判定时机：伤害结算完成之后；被完全免疫（伤害 0）时不触发。
   */
  readonly breakShield?: boolean
  /**
   * bugv34m：己方每次形成连珠**且连珠上有魔力植物**时，把本技能的剩余冷却减少
   * 「该连珠上的魔力植物数量」回合（Qwen「本地部署」的被动）。
   *
   * 触发时机 = `noteMatch()`（攻击连珠与防守反击连珠都算），所以它是一条**被动**，
   * 与本技能是否处于生效窗口无关。
   */
  readonly cooldownCutOnMatchPlants?: boolean
  /** 一句话说明（技能气泡 / 规则面板用）。 */
  readonly desc?: string
}

/** 技能在某个时刻能不能用（UI 直接展示）。 */
export interface SkillState {
  readonly slot: number
  readonly id: string
  readonly name: string
  /** 技能标称消耗。 */
  readonly cost: number
  /** **此刻**实际要消耗几棵（首次免费时为 0，bugv11 #6）。 */
  readonly costNow: number
  /**
   * 可变消耗技能的取值范围（bugv14）：玩家可以自选 `costMin ~ costMax` 棵。
   * 非可变技能为 `null`，此时 `costNow` 就是唯一解。
   */
  readonly costMin: number | null
  readonly costMax: number | null
  /**
   * bugv19：按下限数量释放的代价 —— 本回合本方魔力植物**不提供伤害加成**
   * （deepseek「杀鲸霸拳」选 2 棵）。UI 用它给出明确提示。
   */
  readonly minCostPenalty?: 'noPlantBonus' | null
  /** 这一手是不是"首次释放免费"（UI 提示用）。 */
  readonly freeNow: boolean
  /** 这一手是不是"消耗减少"（bugv14 双子星条件奖励，UI 提示用）。 */
  readonly discountedNow: boolean
  readonly effect: SkillEffect
  /** 还需要行动几次才能再用（0 = 可用）。 */
  readonly remaining: number
  /** 该玩家场上被自己棋子占用的魔力植物数量。 */
  readonly owned: number
  /** 冷却已好 + 植物够。 */
  readonly ready: boolean
  /** 不能用的原因（可用时为 null）。 */
  readonly reason: string | null
  /**
   * 用完之后是否立刻把回合交给对手。
   *
   * 目前没有技能用这个字段（bugv32 起 gtp「恶龙吐息」也不再交回合），
   * 保留字段以备将来；真正判定在 `useSkill` 里按 `spec.endsTurn` 做。
   */
  readonly endsTurn: boolean
  /** 是否还需要在棋盘上点一个目标格。 */
  readonly targetsCell: boolean
  /** 一句话说明。 */
  readonly desc: string
}

// ---------------------------------------------------------------------------
// 事件（驱动 3D 表现层）
// ---------------------------------------------------------------------------

/** 连珠命中信息，供表现层做闪光与连线特效。 */
export interface MatchInfo {
  readonly owner: PlayerIndex
  readonly lines: readonly Line[]
  readonly cells: readonly number[]
  /** 去重后的实体棋子数量。 */
  readonly uniqueCount: number
}

export type GameEvent =
  | { readonly type: 'diceRolled'; readonly first: PlayerIndex; readonly rolls: readonly [number, number] }
  | {
      readonly type: 'stonePlaced'
      readonly player: PlayerIndex
      readonly cell: number
      /** 叠在敌方棋子上（bugv10 #9 毒鸡蛋）：原棋子仍然留在棋盘上。 */
      readonly stacked?: boolean
    }
  | { readonly type: 'matchFormed'; readonly match: MatchInfo }
  | {
      readonly type: 'stonesRemoved'
      readonly player: PlayerIndex
      readonly cells: readonly number[]
      /** 移除时是否留下高光（仅攻击方留下）。 */
      readonly highlight: boolean
      /**
       * 只飞走了"叠在敌方棋子上"的那一颗，底下的原棋子还在（bugv10 #9）。
       * 表现层对这几格**不能**移除原棋子。
       */
      readonly kept?: readonly number[]
    }
  | {
      readonly type: 'highlightShown'
      readonly owner: PlayerIndex
      readonly cells: readonly number[]
      /** 每个高光位置属于几条连珠。 */
      readonly weights: readonly number[]
    }
  | {
      readonly type: 'defenderPlaced'
      readonly player: PlayerIndex
      readonly cell: number
      readonly weakened: number
      /**
       * 防守方落子之后攻击方的最终攻击值（bugv9 #6）。
       *
       * 表现层要用它把"悬浮的棋子数量"对齐总攻击数：被削弱或被抢走魔力植物时，
       * 场上悬浮的棋子要立刻少掉相应的数量，否则会出现"总攻击数 3、悬浮 4 颗、
       * 最后多出一颗永远飞不出去"的错位。
       */
      readonly finalAttack?: number
      /** 防守方这一手之后自己的攻击值（含抢来的魔力植物）。 */
      readonly defenderAttack?: number
      /** 落在烈焰上：棋子直接碎裂，棋盘上不会出现这颗子（bugv10 #9）。 */
      readonly shattered?: boolean
    }
  | {
      /**
       * 棋子从棋盘上碎裂 / 被移除。
       *
       * - `flame`：落在烈焰上碎裂（bugv10 #9 恶龙吐息）；
       * - `skill`：被技能移除（bugv34m「小千问」移除了压在被消耗植物上的棋子）。
       */
      readonly type: 'stoneShattered'
      readonly player: PlayerIndex
      readonly cell: number
      readonly reason: 'flame' | 'skill'
    }
  | {
      /**
       * bugv34m「小千问」的结算：本回合落子未成连珠 → 把之前移除的棋子随机重新下到空位。
       *
       * - `placed`：**成功落下**的格子（表现层演"特征色光流棋子从天而降"）；
       * - `refunded`：**放不下、回到原位**的格子（植物也一并返还，见同批 `magicGrown`）；
       * - 两者数量之和 = 本次实际消耗的植物数量。
       *
       * ⚠️ 这两批棋子都已经写进棋盘 / 叠子表，事件只负责演出。
       */
      readonly type: 'redeployStones'
      readonly player: PlayerIndex
      /** 成功落下的格子（一定是空位，不会形成连珠）。 */
      readonly placed: readonly number[]
      /** 放不下、回到原位的棋子（`overlay: true` = 原本是叠在敌方棋子上的那一颗）。 */
      readonly refunded: ReadonlyArray<{ readonly cell: number; readonly overlay: boolean }>
    }
  | {
      /**
       * 走在**自己的**烈焰上（bugv14）：棋子不碎裂，改为该方受到 1 点伤害。
       *
       * 与 `stoneShattered` 互斥 —— 只有"这批烈焰的主人"才能这么走。
       */
      readonly type: 'flameWalked'
      readonly player: PlayerIndex
      readonly cell: number
      /** 这次走火实际扣掉的生命（被护甲 / 护盾吸收后为 0）。 */
      readonly damage: number
    }
  | {
      /** 临时护甲变化（bugv14 精密计算：到期即清零）。 */
      readonly type: 'tempArmorChanged'
      readonly player: PlayerIndex
      readonly from: number
      readonly to: number
    }
  | {
      /** 「深度思考」的额外攻击值变化（bugv14）。 */
      readonly type: 'strikeChanged'
      readonly player: PlayerIndex
      readonly to: number
    }
  | {
      /** 烈焰点燃 / 蔓延（bugv10 #9）。 */
      readonly type: 'flamesIgnited'
      readonly cells: readonly number[]
      /** 每处烈焰还能烧几回合。 */
      readonly turns: number
      /** 这批烈焰的主人（bugv14）：只有主人的棋子能走在上面。 */
      readonly owner?: PlayerIndex
    }
  | {
    /**
     * 烈焰剩余回合数变化（每次换手递减 1 个半回合）。
     *
     * ⚠️ `remaining` 是"这批火里最旺的那一处的剩余回合数"，**只用于展示**：
     * 每格精确的剩余半回合数只在引擎的 `flames` 里，表现层不要拿它回写模型
     * （bugv11 #1：以前客户端拿 `remaining * 2` 覆盖模型，把低格数一路顶回去，
     * 烈焰因此永远烧不完）。
     */
      readonly type: 'flamesChanged'
      readonly cells: readonly number[]
      readonly remaining: number
    }
  | {
      /** 烈焰熄灭。 */
      readonly type: 'flamesCleared'
      readonly cells: readonly number[]
    }
  | {
      readonly type: 'magicGrown'
      readonly plants: ReadonlyArray<{
        readonly cell: number
        readonly kind: MagicKind
        /**
         * 这一棵**自己的**归属（bugv17 #7「布局」需要逐棵区分）：
         * 落在空格上 = `null`（无主）；落在棋子上 = 压在它上面的那一方。
         * 缺省时回退到批次级的 `owner`。
         */
        readonly owner?: PlayerIndex | null
      }>
      /** 本次是第几次生长（1 起），用于 UI 展示与调试。 */
      readonly growth: number
      /**
       * 这次生长的来源（bugv14）：
       * - `nature`（默认）= 冷却到点的自然生长；
       * - `seed` = 「布局」技能在落点九宫格里种出来的。
       */
      readonly source?: 'nature' | 'seed' | 'weather' | 'deploy' | 'redeploy'
      /**
       * 这批植物的**批次级**归属（bugv16 起）：自然生长为无主（`null`）。
       * 逐棵的归属优先看 `plants[].owner`（bugv17 #7）。
       */
      readonly owner?: PlayerIndex | null
    }
  | {
      readonly type: 'magicClaimed'
      readonly cell: number
      readonly kind: MagicKind
      readonly player: PlayerIndex
      /** 是否是从对手手里抢过来的。 */
      readonly stolen: boolean
    }
  | {
      readonly type: 'magicRemoved'
      readonly cells: readonly number[]
      /**
       * 为什么消失：
       * - `line`：压着它的棋子被连珠结算拿走了（同生共死）；
       * - `flame`：火球把整行整列点着，空位上的植物被烧掉（bugv18 #1）。
       * - `weather`：「旱雷」雷击（bugv34c）。
       */
      readonly reason: 'line' | 'flame' | 'weather'
    }
  | {
      /**
       * 天气导致的植物**种类变更**（bugv34；不是增删，所以单独一个事件）。
       *
       * 目前三处触发：
       * - **雷暴结束**：场上所有「污染体」（无论是否被棋子占有）变回普通魔力植物；
       * - **暴雪降临**：场上所有植物（含刚长出的）变成「冻结的魔力植物」；
       * - **暴雪结束**：场上所有冻结的植物解冻（恢复普通种类）。
       * 归属一律保留。
       *
       * ⚠️ 「暴雪**解冻**」（连珠后）**不走这个事件** —— 用户口径是"冻结植物随棋子一起消失、
       * 在原地重新长出一棵"，所以拆成 `magicRemoved`（消失）+ `magicGrown(source:'weather')`
       * （原地长出非冻结的），表现层才会有"消失 → 长出"的观感。
       */
      readonly type: 'magicReverted'
      readonly plants: ReadonlyArray<{ readonly cell: number; readonly kind: MagicKind }>
      /** 这次变更的原因（表现层可据此换演出）。 */
      readonly reason?: 'thunderEnd' | 'blizzardStart' | 'blizzardEnd'
    }
  | {
      /** 黑夜即将降临的预告（bugv34）：`countdown` = 还剩几个双方回合。 */
      readonly type: 'nightPending'
      readonly countdown: number
    }
  | {
      /** 黑夜降临（bugv34）：随机抽到了 `weather`。 */
      readonly type: 'nightFell'
      readonly weather: WeatherId
    }
  | {
      /** 黑夜结束（bugv34）：天亮。 */
      readonly type: 'nightEnded'
    }
  | {
      /** 「雷暴」：闪电落在这些格子上（表现层演出用，bugv34）。 */
      readonly type: 'lightningStruck'
      readonly cells: readonly number[]
    }
  | {
      /** 「瘟疫」：攻击棋子分裂给双方（bugv34）。 */
      readonly type: 'attackStoneSplit'
      readonly player: PlayerIndex
      readonly cell: number
      /** 分裂出的那一颗加入哪一方。 */
      readonly to: PlayerIndex
    }
  | {
      /** 技能消耗掉了这些格子上被我方占用的魔力植物（bugv9 #13）。 */
      readonly type: 'magicConsumed'
      readonly player: PlayerIndex
      readonly cells: readonly number[]
    }
  | {
      /** 使用技能（bugv9 #13）。 */
      readonly type: 'skillUsed'
      readonly player: PlayerIndex
      readonly slot: number
      readonly skillId: string
      readonly skillName: string
      readonly effect: SkillEffect
      readonly cells: readonly number[]
      /** 需要点选目标格的技能（恶龙吐息）的目标格（bugv10 #9）。 */
      readonly target?: number | null
    }
  | {
      /** 「双子星」的爆发窗口开 / 关（bugv11 #5：两连即可攻击 + 免反击）。 */
      readonly type: 'twinStarChanged'
      readonly player: PlayerIndex
      readonly active: boolean
    }
  | {
      /** 护盾变化（bugv9 #13）。 */
      readonly type: 'shieldChanged'
      readonly player: PlayerIndex
      readonly from: number
      readonly to: number
    }
  | {
      /**
       * bugv31「力大砖飞」：护盾 / 临时护甲被一击**打碎**（区别于被伤害逐点磨掉）。
       *
       * 表现层拿它给受伤方的立绘播一段「镜面破碎」；
       * 两个值分别是这一下**碎掉**的护盾与临时护甲（可能有一个为 0）。
       */
      readonly type: 'armorBroken'
      readonly player: PlayerIndex
      readonly shield: number
      readonly armor: number
    }
  | {
      /** 连击（连续行动）次数变化（bugv9 #13）。 */
      readonly type: 'bonusActionsChanged'
      readonly player: PlayerIndex
      readonly to: number
    }
  | {
      /** 无敌状态变化（bugv10 #9 精密计算）。 */
      readonly type: 'immuneChanged'
      readonly player: PlayerIndex
      readonly active: boolean
      /** 无敌持续到的回合序号（含）。 */
      readonly until: number
    }
  | {
      /** 本回合伤害加成变化（bugv10 #9 小一哥）。 */
      readonly type: 'powerChanged'
      readonly player: PlayerIndex
      readonly to: number
    }
  | {
      /** 本回合是否可以在敌方棋子上落子（bugv10 #9 毒鸡蛋）。 */
      readonly type: 'sabotageChanged'
      readonly player: PlayerIndex
      readonly active: boolean
    }
  | {
      /** 双子星条件奖励触发（bugv12 #3：成线攻击且对手未成线 → 不进冷却 + 下次免费）。 */
      readonly type: 'bloomRewarded'
      readonly player: PlayerIndex
    }
  | {
      readonly type: 'attackResolved'
      readonly snapshot: AttackSnapshot
      /** 参与对撞的数量。 */
      readonly clashCount: number
      /** 飞向血条的剩余棋子数量。 */
      readonly damage: number
    }
  | { readonly type: 'hpChanged'; readonly player: PlayerIndex; readonly from: number; readonly to: number; readonly hits: number }
  | { readonly type: 'highlightsCleared' }
  | { readonly type: 'turnStarted'; readonly player: PlayerIndex }
  | { readonly type: 'gameOver'; readonly result: GameResult }

export type GameEventType = GameEvent['type']
