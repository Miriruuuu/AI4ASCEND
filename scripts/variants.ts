/**
 * 技能数值变体注册表（平衡性 A/B 实验的**唯一真理来源**）。
 *
 * 角色之间基础规则完全相同，唯一的差别就是各自的两个技能 ——
 * 所以只覆盖数值再跑一遍，胜率差 100% 归因于这些技能。
 *
 * 被 `tournament.ts`（跨角色循环赛）与 `duel.ts`（同角色一对一规则对撞）共用。
 */
import { skillsOfCharacter, type CharacterId } from '../src/core/characters'
import type { SkillEffect, SkillSpec, VariableCost } from '../src/core/types'

export interface SkillPatch {
  cost?: number
  cooldown?: number
  amount?: number
  desc?: string
  /**
   * 覆盖"技能效果类型"。
   *
   * ⚠️ 这是**回到旧口径**的唯一手段，但要求引擎里那条旧分支还在
   * （例：`gt-immune` 的 `'immune'` 分支一直在，所以能把「精密计算」退回
   * "无敌"版本做整套对撞）。若旧效果已被删除，改 `effect` 只会在运行时抛错 ——
   * 那种情况必须走真正的代码分支，别用变体假装。
   */
  effect?: SkillEffect
  /** 覆盖"效果持续回合数"（小一哥 / 免疫）。 */
  duration?: number
  /** 覆盖"用完是否结束回合"（显式设 false 可以取消）。 */
  endsTurn?: boolean
  /** 覆盖"开局是否即可使用"。 */
  startReady?: boolean
  /** 覆盖"首次释放是否免费"。 */
  freeFirst?: boolean
  /**
   * 覆盖"可变消耗"。设 `null` = **取消可变消耗**（退回 `cost` 的单一价）。
   *
   * 用于 A/B「可变 2~3 费」vs「固定 3 费」（bugv20）。
   */
  variableCost?: VariableCost | null
  /**
   * 覆盖"受到伤害后冷却前进的手数"。设一个远大于任何冷却的值（如 `99`）
   * = 回到 bugv24 之前的**"受伤立即就绪"**行为，用于 A/B。
   */
  cooldownAdvanceOnDamage?: number
}

/**
 * "把某个技能彻底禁用"的最小补丁。
 *
 * 用**冷却推到天上 + 开局不可用**来禁用，而不是改效果 ——
 * 这样另一侧的行为完全不变，胜负差就纯归因于"有没有这个技能"。
 */
export const disabled = (): SkillPatch => ({ cooldown: 999, startReady: false, freeFirst: false })

export const VARIANTS: Record<string, Record<string, SkillPatch>> = {
  /** 什么都不改（对照：bugv12 #2 之后的口径）。 */
  base: {},
  /** 消融①：免疫退回"仅当前回合"（纯免疫反击）。 */
  immune1: {
    'gt-immune': { amount: 1 },
  },
  /** 消融②：火球退回"用完结束回合"。 */
  fbend: {
    'gt-fireball': { endsTurn: true },
  },
  /** 消融③：小一哥退回"仅本回合"。 */
  power1: {
    'gl-power': { duration: 1 },
  },
  /** 把三个 3 费技能降到 2 费：验证"植物经济"是不是卡死它们的元凶。 */
  cheap3: {
    'ds-double': { cost: 2 },
    'gl-sabotage': { cost: 2 },
    'gt-fireball': { cost: 2 },
  },
  /** 削弱最强的续航（猫的憩息 冷却 5 → 7）。 */
  healcd7: {
    'gm-heal': { cooldown: 7 },
  },
  /** 强化增伤（小一哥 +1 伤 → +2 伤）。 */
  power2: {
    'gl-power': { amount: 2, desc: '本回合伤害 +2' },
  },
  /** 缓解"护盾无上限叠加"的隐患（先降冷却换取节奏）。 */
  shieldcd7: {
    'ds-shield': { cooldown: 7 },
  },
  /**
   * 「布局」降到 1 费（bugv17 #7 之后的 A/B）。
   *
   * 动机：claude 两个技能都只要 1~2 棵植物、冷却却是 5~6 次行动
   * ⇒ **植物需求上限 ≈ 每 6 手 1 棵**，种再多也花不掉。
   * bugv16 实测 2 费时 `claude[全技能] vs claude[禁用播种]` 只有 36.9%（显著负），
   * 所以要看新版"九宫格含棋子 + 归属按棋子派生"是否改变了这个结论。
   */
  seed1: {
    'cl-seed': { cost: 1 },
  },
  /**
   * 「布局」**完全免费**（bugv16 调研 / bugv17 复核）。
   *
   * 真正的病根曾是**播种和「力大砖飞」抢同一份稀缺资源**（植物）：claude 的植物
   * 花销上限 ≈ 每 6 次行动 1 棵，所以"2 费买一堆植物"永远输给"1 费换 +1~2 颗攻击棋子"。
   * 0 费时不抢资源，只占用一个"本来也打不了攻击"的回合。
   */
  seed0: {
    'cl-seed': { cost: 0 },
  },
  // -------------------------------------------------------------------------
  // 单技能归因（同角色对撞专用）：把某一个技能**彻底禁用**，
  // 与"全技能"基准对撞 → 胜率落差 = 这个技能的真实贡献。
  // -------------------------------------------------------------------------
  /** gtp 没有「精密计算」（只留火球）。 */
  'no-imm': { 'gt-immune': disabled() },
  /** gtp 没有「恶龙吐息」（只留免疫）。 */
  'no-fb': { 'gt-fireball': disabled() },
  /** deepseek 没有「大胃袋」（只留杀鲸霸拳）。 */
  'no-shield': { 'ds-shield': disabled() },
  /** deepseek 没有「杀鲸霸拳」（只留大胃袋）。 */
  'no-double': { 'ds-double': disabled() },
  /** gemini 没有「猫的憩息」（只留双子星）。 */
  'no-heal': { 'gm-heal': disabled() },
  /** gemini 没有「双子星」（只留猫的憩息）。 */
  'no-bloom': { 'gm-bloom': disabled() },
  /** glm 没有「小一哥」（只留毒鸡蛋）。 */
  'no-power': { 'gl-power': disabled() },
  /** glm 没有「毒鸡蛋」（只留小一哥）。 */
  'no-sabotage': { 'gl-sabotage': disabled() },
  /** claude 没有「力大砖飞」（只留布局）。 */
  'no-first': { 'cl-first': disabled() },
  /** claude 没有「布局」（只留力大砖飞）。 */
  'no-seed': { 'cl-seed': disabled() },
  /** seedance 没有「稳稳的接住你」（只留最直接）。 */
  'no-guard': { 'sd-guard': disabled() },
  /** seedance 没有「最不绕弯子」（只留共享护甲）。 */
  'no-assault': { 'sd-assault': disabled() },
  // -------------------------------------------------------------------------
  // "整套技能组"的对撞：两个技能一起禁掉 → 直接回答"这个角色的技能值不值"。
  // -------------------------------------------------------------------------
  /** claude 没有任何技能。 */
  'no-claude': { 'cl-first': disabled(), 'cl-seed': disabled() },
  /** gtp 没有任何技能。 */
  'no-gtp': { 'gt-immune': disabled(), 'gt-fireball': disabled() },
  /** seedance 没有任何技能。 */
  'no-seedance': { 'sd-guard': disabled(), 'sd-assault': disabled() },
  /** glm 没有任何技能。 */
  'no-glm': { 'gl-power': disabled(), 'gl-sabotage': disabled() },
  // -------------------------------------------------------------------------
  // bugv20：可变消耗 vs 单一定价
  // -------------------------------------------------------------------------
  /**
   * 「杀鲸霸拳」回到**固定 3 费**（取消可变消耗）——
   * 用来回答"分 2 档到底比只有 3 费一种消耗强不强"。
   * ⚠️ `cost` 必须一起改成 3（可变消耗取的是 `min/max`，取消后引擎读 `cost`）。
   */
  'ds-fixed3': { 'ds-double': { cost: 3, variableCost: null } },
  /**
   * ⛔ **平衡变体，不是 AI 诊断**（bugv21 教训）。
   *
   * 「杀鲸霸拳」下限降到 1 棵 ⇒ 对撞 74.1%。**这是"把大招费用砍一半"，当然更强**——
   * 74% 是同义反复，**不能证明"AI 的瓶颈是费用门槛"**。
   * 用户已明确否定：该技能当前费用是平衡的，**不要**采纳此变体，也不要再拿它当结论。
   * 保留在注册表里只为记录"为什么这个方向是错的"。
   */
  'ds-min1': {
    'ds-double': {
      variableCost: { min: 1, max: 3, cooldownPerUnit: 0, flatCooldown: true, minCostPenalty: 'noPlantBonus' },
    },
  },
  /**
   * ⚪ 「杀鲸霸拳」**取消最低档惩罚**（2~3 档，两档都正常结算植物加伤）。
   *
   * 这个是干净的 AI/设计问题：既然 AI 91% 都选 2 棵，"本回合不加伤"这条惩罚
   * 到底有没有实际成本？**对撞 320 局 54.8%（复跑 55.3%）⇒ 不显著**（偏正但不显著）。
   */
  'ds-nopenalty': {
    'ds-double': {
      variableCost: { min: 2, max: 3, cooldownPerUnit: 0, flatCooldown: true },
    },
  },
  /**
   * ⚪ 「杀鲸霸拳」冷却 10 → 7。**对撞 320 局 48.0% ⇒ 不显著**
   * （释放量 +27% 但胜率不动）。10 是全场最长冷却，看"更常打出来"值不值钱。
   */
  'ds-cd7': { 'ds-double': { cooldown: 7 } },
  /**
   * ⛔ 同 `ds-min1`：平衡变体，**不是 AI 诊断**，已被用户否定（勿再提）。
   */
  'ds-min1max2': {
    'ds-double': {
      variableCost: { min: 1, max: 2, cooldownPerUnit: 0, flatCooldown: true, minCostPenalty: 'noPlantBonus' },
    },
  },
  // -------------------------------------------------------------------------
  // bugv24：gemini「猫的憩息」削弱 —— 受伤后"冷却前进 2 手"（替代原"立即就绪"）
  // -------------------------------------------------------------------------
  /**
   * A/B 的**旧行为对照**：把刷新退回 bugv24 之前的"受伤立即就绪"
   * （`99` ≫ 任何冷却 ⇒ 等价于原 `= actionsTaken` 清零）。
   *
   * `base` 现在 = 前进 2 手（削弱后）；本变体 = 旧值。跑同一批对局即可量化"削 2 手"的力度。
   */
  'gm-heal-instant': { 'gm-heal': { cooldownAdvanceOnDamage: 99 } },
  /**
   * 更狠的削法（备用）：受伤后冷却只前进 1 手。
   */
  'gm-heal-adv1': { 'gm-heal': { cooldownAdvanceOnDamage: 1 } },
  /**
   * 完全不刷新（回到 bugv18 之前）。
   */
  'gm-heal-none': { 'gm-heal': { cooldownAdvanceOnDamage: 0 } },
  // -------------------------------------------------------------------------
  // bugv30：本轮的数值改动 A/B（`base` 就是改后口径）
  // -------------------------------------------------------------------------
  /**
   * 「精密计算」冷却退回 bugv30 之前的 **5**（base 是 6）。
   *
   * 用法：`bash scripts/duel-parallel.sh gtp base gtp-armor5 160 70 8`
   * —— 循环赛里 gtp 的胜率崩了，但那**不可能**只用"冷却 5→6"解释；
   * 要归因必须用同角色对撞，别拿循环赛的数字下结论。
   */
  'gtp-armor5': { 'gt-immune': { cooldown: 5 } },
  /**
   * 「力大砖飞」冷却退回 bugv30 之前的 **6**（base 是 5）。
   *
   * ⚠️ 只回到冷却，**回不到旧效果**（旧版"对手没成线反击再多 +1 颗"是引擎逻辑，
   * 不是 `SkillSpec` 能覆盖的字段）。想 A/B"加伤+破盾" vs 旧版第二段加成，
   * 得走真正的代码分支，别用变体假装。
   */
  'claude-first6': { 'cl-first': { cooldown: 6 } },
  // -------------------------------------------------------------------------
  // bugv31：恶龙吐息改成可变消耗（2 费档交回合 / 3 费档不交回合）
  // -------------------------------------------------------------------------
  /**
   * ⚠️ 这**不是**"旧 gtp"，只是**单变量隔离**：只把火球退回"固定 2 费、用完不结束回合"，
   * **1 技能保持现状（护甲=生命上限）**。
   *
   * 所以 `base vs gtp-old-fb` 测的是"**只削 2 技能**值多少"（实测 A=34.1%，即 −16 点），
   * ⛔ **不能**拿它当"现在的 gtp vs 以前的 gtp"。要回答整体强弱，用下面的 `gtp-old-kit`。
   */
  'gtp-old-fb': {
    'gt-fireball': { cost: 2, variableCost: null, endsTurn: false },
  },
  /**
   * 🚩 **真正的"旧 gtp 整套"**（bugv29 之前的完整口径），用户口径：
   * 「1 技能 = 直到**你的对手**的下个回合结束前**无敌**；火球固定 2 费、不跳回合」。
   *
   * 设计意图（用户明确）：bugv29 把 1 技能从"无敌"加强成"直到**自己的**下个回合结束前、
   * 护甲 = 生命上限"（多扛一整轮 ⇒ 两回合内能试两次进攻、容错极高），
   * **2 技能的削弱就是给这次加强买单的**。所以两边要**整套比**：
   * ```
   * bash scripts/duel-parallel.sh gtp base gtp-old-kit 160 70 8
   * ```
   * 判读：若接近 50% ⇒ "1 技能加强 ↔ 2 技能削弱"这一揽子是平衡的
   * （即现在 gtp 不比以前弱，符合用户的人类游玩体感）。
   * ⚠️ 1 技能同时回到旧冷却 **5**（bugv30 才 5→6）与旧的 `amount: 2`（覆盖对手的下个回合）。
   */
  'gtp-old-kit': {
    'gt-immune': { effect: 'immune', amount: 2, cooldown: 5 },
    'gt-fireball': { cost: 2, variableCost: null, endsTurn: false },
  },
  /**
   * **只换 1 技能**：效果退回旧的「无敌 2 回合」，**火球保持现状**。
   * 冷却**保持现状的 6**（只隔离 `tempArmor → immune` 这一个变量，不含 bugv30 的 5→6）。
   *
   * 用法：`bash scripts/duel-parallel.sh gtp base gtp-old-armor 80 70 8`
   * 读数 = "把 1 技能从 8 点护甲换回无敌，AI 手里值多少"。加上 `gtp-old-fb` 那一半
   * （−16）≈ 整套 `gtp-old-kit` 的差。
   */
  'gtp-old-armor': {
    'gt-immune': { effect: 'immune', amount: 2, cooldown: 6 },
  },
}

/** 按变体名生成"角色 → 技能表"的解析器（未知变体 = 原样返回）。 */
export function makeSpecResolver(variant: string): (id: CharacterId) => readonly SkillSpec[] {
  const patch = VARIANTS[variant] ?? {}
  return (id) =>
    skillsOfCharacter(id).map((spec) => {
      const p = patch[spec.id]
      if (!p) return spec
      const { variableCost, ...rest } = { ...spec, ...p }
      // `null` = 显式取消可变消耗（退回 `cost`）
      return (variableCost === null ? rest : { ...rest, variableCost }) as SkillSpec
    })
}

/** 可复现的伪随机数（与 `tournament.ts` 用的是同一个）。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
