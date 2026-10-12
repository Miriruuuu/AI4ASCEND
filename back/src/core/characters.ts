/**
 * 角色目录（bugv9 #13 引入，bugv10 #9 扩充到 4 个角色）。
 *
 * 这里只放**纯数据**（id / 名字 / 特征色 / 技能数值），不依赖任何资源或框架：
 * - 前端 `src/app/characters.ts` 在它之上补立绘（PNG）与图标；
 * - 服务端用它校验联机对局里的角色与技能（bugv10 #11 技能联机）。
 *
 * 因此该文件与其它 `src/core/*` 一样会被 `pnpm sync:core` 同步到 `back/src/core/`，
 * 两端必须**逐字节一致**。
 */
import type { SkillSpec } from './types'

/** 角色 id。 */
export type CharacterId = 'deepseek' | 'gemini' | 'gtp' | 'glm' | 'claude' | 'seedance' | 'qwen'

export interface CharacterSpec {
  readonly id: CharacterId
  readonly name: string
  /** 特征色（棋盘配色 / 棋子光晕 / 技能图标都用它）。 */
  readonly color: number
  readonly glow: number
  readonly deep: number
  /** 一句话介绍。 */
  readonly tagline: string
  /** 两个技能。 */
  readonly skills: readonly [SkillSpec, SkillSpec]
}

/** 全部角色（顺序 = 开始菜单里轮播的顺序）。 */
export const CHARACTER_SPECS: readonly CharacterSpec[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    color: 0x3964fe,
    glow: 0x8fb3ff,
    deep: 0x16307f,
    tagline: '呱！好劲口也！',
    skills: [
      {
        id: 'ds-shield',
        name: '大胃袋',
        cost: 1,
        cooldown: 5,
        effect: 'shield',
        amount: 1,
        desc: '获得 1 点护盾：护盾先于血量承伤，可叠加、无上限',
      },
      {
        id: 'ds-double',
        name: '杀鲸霸拳',
        // bugv19：3 费 → **可变 2~3 费**。选 2 棵 = 本回合魔力植物不加伤（换更快打出）。
        cost: 2,
        cooldown: 10,
        effect: 'double',
        amount: 1,
        // 冷却固定 10：两个档位是"同一次连下的两种打法"，不是"越贵越强"。
        variableCost: { min: 2, max: 3, cooldownPerUnit: 0, flatCooldown: true, minCostPenalty: 'noPlantBonus' },
        desc:
          '本回合可以连下两颗子：两颗都下完才进入攻击阶段（第一颗成线也不会被反击）。' +
          '消耗 **2 棵**：本回合内你的魔力植物**不提供伤害加成**',
      },
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini',
    color: 0xd45fb9,
    glow: 0xff9ade,
    deep: 0x6b1f57,
    tagline: '哈基米才不是啥子猫',
    skills: [
      {
        id: 'gm-heal',
        name: '猫的憩息',
        cost: 1,
        cooldown: 5,
        effect: 'heal',
        amount: 1,
        // bugv18 #2：受到伤害后刷新冷却；bugv24 由"立即就绪（清零）"改为"前进 2 手"
        cooldownAdvanceOnDamage: 2,
        desc: '恢复 1 点血量（不会超过初始血量）；**受到伤害后冷却前进 2 手**',
      },
      {
        id: 'gm-bloom',
        name: '双子星',
        cost: 2,
        cooldown: 10,
        effect: 'bloom',
        amount: 1,
        // bugv18 #2：条件奖励由"不进冷却 + 下次消耗 -1"改为"恢复 1 点血量"
        desc:
          '本回合落下的这颗子只要形成两连就能直接发起攻击，并且这一击免疫对手的反击伤害。' +
          '若本回合真的成线攻击、且对手没能成线反击，则**恢复 1 点血量**',
      },
    ],
  },
  {
    id: 'gtp',
    name: 'GTP',
    color: 0xc7bef0,
    glow: 0xf1ecff,
    deep: 0x6d63a8,
    tagline: '无敌(指五小时内)',
    skills: [
      {
        id: 'gt-immune',
        name: '精密计算',
        cost: 1,
        // bugv12 #3：冷却 10 → 5（提高可用率）
        // bugv30：5 → 6（上一轮循环赛 gtp 仍偏弱但护甲太容易续航，先回调一手冷却）
        cooldown: 6,
        // bugv14：从"无敌（免疫全部伤害）"改成"临时护甲"
        // bugv15：3 点 → 6 点（用户指定）——6 点护甲刚好能吃下一次完整攻击（3~5 伤）
        // bugv29：改为"等同于生命上限"（`amountFromMaxHp`，改血量上限时自动跟随）
        effect: 'tempArmor',
        amount: 8,
        amountFromMaxHp: true,
        // bugv29：由"持续到对手的下个回合结束前"改为"持续到自己的下个回合结束前"（多扛一整轮）
        duration: 3,
        desc:
          '直到自己的下个回合结束前获得**等同于生命上限**的临时护甲：护甲先于护盾与血量承伤，' +
          '到期后**未用完的部分直接作废**',
      },
      {
        id: 'gt-fireball',
        name: '恶龙吐息',
        // bugv12 #3：消耗 3 → 2、冷却 12 → 6（提高可用率）
        // bugv33：碎子档降价到 2 费，冷却改 6 → 12 平衡；循环赛 gtp 仍垫底（27.5%），
        //          cd12 过重（火球是 gtp 唯一输出、整局只能放 1~2 次）→ 回落到 8
        cost: 2,
        cooldown: 8,
        effect: 'fireball',
        amount: 6,
        targetsCell: true,
        // bugv11 #6：开局不进入冷却，而且第一次释放不消耗魔力植物
        startReady: true,
        freeFirst: true,
        /**
         * bugv33：改成 **1 费 / 2 费两档**，且**两档都不结束回合**。
         *
         * - **1 费档**（下限）：只燃火，**不直击碎子**（目标格上的棋子原样保留）；
         *   首次免费释放按 1 费档算（同样不碎子）。
         * - **2 费档**：直击碎子 + 燃火（完整效果）。
         *
         * 冷却两档共用（`flatCooldown`）。档位判定：`消耗 >= 2 棵 ⇒ 碎子`。
         */
        variableCost: { min: 1, max: 2, cooldownPerUnit: 0, flatCooldown: true },
        desc:
          '向棋盘上任意位置投射一颗硕大火球，随后该位置**整行整列的空位**燃起熊熊烈焰' +
          '（6 个回合，双方各走一步算 1 回合），**空位上的魔力植物会被直接摧毁**。' +
          '对手的棋子下在烈焰上会直接碎裂；己方棋子不会碎裂，但会受到 1 点伤害' +
          '（护甲 / 护盾可以先吸收）。' +
          '消耗 **1 棵**：只燃火、**不击碎目标格的棋子**；' +
          '消耗 **2 棵**：额外**直击该格的棋子使其碎裂**（这一格的魔力植物一并消失）。' +
          '两档**都不结束回合**，放完还能继续行动。' +
          '开局即可使用、首次释放不消耗魔力植物（按 1 费档，同样不碎子）',
      },
    ],
  },
  {
    id: 'claude',
    name: 'Claude',
    color: 0xd97757,
    glow: 0xf3b7a0,
    deep: 0x7d3a20,
    tagline: '你说的对，但Claude是由Anthropic自主研发的一款全新开放世界对话模型',
    skills: [
      {
        id: 'cl-first',
        // bugv17 #6：改名为「力大砖飞」（原「深度思考」）
        name: '力大砖飞',
        cost: 1,
        // bugv30：6 → 5（用户指定；同时技能口径改成"加伤 + 破盾"）
        cooldown: 5,
        effect: 'firstStrike',
        amount: 1,
        duration: 2,
        // bugv30：效果还在生效期间不能重复释放
        noRepeat: true,
        // bugv30：这一击成功造成伤害后，把受伤方的护盾全部移除（破盾）
        // bugv31：破盾扩展到**临时护甲**（与护盾一起清空）
        breakShield: true,
        desc:
          '直到自己的下个回合结束前：**首个连珠攻击**伤害 +1；' +
          '**若成功造成伤害，伤害结算后移除其护盾与临时护甲**（目标身上的护盾、临时护甲全部清空）；' +
          '技能生效期间**不能重复释放**',
      },
      {
        id: 'cl-seed',
        // bugv17 #6：改名「布局」（原「播种」）。
        // bugv17 #7：由用户重新定义 —— 0 费改回 **2 费**，九宫格改为"含落点自身 +
        // 空位与棋子都长"，归属严格按"有棋子压着才算归属"派生。
        name: '布局',
        cost: 2,
        cooldown: 5,
        effect: 'seedGrow',
        amount: 1,
        desc:
          '本回合落子若**没有形成连珠**：落点以及它周围 1 格的**所有位置**（空位与棋子，无论敌我）' +
          '都长出魔力植物',
      },
    ],
  },
  {
    id: 'seedance',
    name: 'Seedance',
    color: 0x2bb3a3,
    glow: 0x8fe3d8,
    deep: 0x0f5d55,
    tagline: '我将用最直白，最直接，最不绕弯子...',
    skills: [
      {
        id: 'sd-guard',
        name: '稳稳的接住你',
        cost: 1,
        cooldown: 5,
        effect: 'guardShare',
        amount: 2,
        shareToFoe: 1,
        desc: '自己获得 2 点护盾、**对手也获得 1 点护盾**',
      },
      {
        id: 'sd-assault',
        // bugv17 #6：改名为「最不绕弯子」（原「最直接、最不绕弯子」）
        name: '最不绕弯子',
        cost: 1,
        cooldown: 4,
        effect: 'assault',
        amount: 1,
        // 可变消耗：自选 1~4 棵，冷却 = 4 × 实际消耗（1 费 4 冷却 ~ 4 费 16 冷却）
        variableCost: { min: 1, max: 4, cooldownPerUnit: 4 },
        desc:
          '消耗 1~4 棵魔力植物**直接进入攻击阶段**：攻击值 = 消耗的植物数量（不需要落子、也不形成连珠），' +
          '冷却 = 4 × 消耗的植物数量',
      },
    ],
  },
  {
    id: 'glm',
    name: 'GLM',
    color: 0x27314a,
    glow: 0x7d90bb,
    deep: 0x131a2b,
    tagline: '代码自己在上传',
    skills: [
      {
        id: 'gl-power',
        name: '小一哥',
        cost: 1,
        cooldown: 5,
        effect: 'power',
        amount: 1,
        // bugv18 #2：持续 2 回合 → **5 回合**，且每次形成连珠消耗 2 回合；生效期间不能重复释放
        duration: 5,
        // bugv30：原来"不能重复释放"是写死在 `effect === 'power'` 里的，现在改成通用开关
        noRepeat: true,
        desc:
          '伤害 +1 持续 5 回合：**每次形成连珠后持续时间减少 2 回合**；' +
          '技能生效期间**不能重复释放**',
      },
      {
        id: 'gl-sabotage',
        name: '毒鸡蛋',
        // bugv12 #3 曾把费用降到 1；bugv12 #4 回到 2（保留"释放后本回合伤害 +1"）
        cost: 2,
        cooldown: 10,
        effect: 'sabotage',
        amount: 1,
        desc:
          '本回合可以下在**敌方棋子**上（必须能形成连珠）：原棋子不被顶替，' +
          '而且这一格上如果有魔力植物会被你**抢过来**；释放后本回合伤害 +1（可与小一哥叠加）',
      },
    ],
  },
  {
    id: 'qwen',
    name: 'Qwen',
    // bugv34m：特征色 #284deb（用户指定）
    color: 0x284deb,
    glow: 0x8fa9ff,
    deep: 0x132a80,
    tagline: '本地部署，离线也能跑',
    skills: [
      {
        id: 'qw-deploy',
        name: '本地部署',
        cost: 1,
        cooldown: 5,
        effect: 'localDeploy',
        amount: 1,
        // 被动：每次形成连珠且连珠上有魔力植物 → 本技能冷却减少「连珠上的植物数量」回合
        cooldownCutOnMatchPlants: true,
        desc:
          '使用后**本回合落子**：未形成连珠，则在**落点**长出一棵魔力植物' +
          '（该格上已有魔力植物则跳过）；形成连珠，则这一击**伤害 +1**。' +
          '被动：己方每次形成连珠且连珠上有魔力植物时，本技能冷却减少' +
          '**该连珠上的魔力植物数量**回合',
      },
      {
        id: 'qw-redeploy',
        name: '小千问',
        cost: 1,
        cooldown: 3,
        effect: 'redeploy',
        amount: 1,
        // 可变消耗：1~2 棵，冷却 = 3 × **实际放下**的棋子数量（放不下的会连植物一起退还）
        variableCost: { min: 1, max: 2, cooldownPerUnit: 3 },
        desc:
          '消耗 **1~2 棵**魔力植物，并**移除压在这些植物上的棋子**；' +
          '本回合落子后若**未形成连珠**，就等量把棋子重新下到棋盘的空位上' +
          '（优先落在**有无主魔力植物的空位**——顺手吃下那棵植物；没有植物可吃时' +
          '落在**离落点最近的一圈**），**不会下在会形成连珠的位置**；' +
          '放不下的棋子**回到原位**并返还那棵魔力植物，冷却 = 3 × 实际放下的棋子数量' +
          '（例：消耗 2 棵但只放下 1 颗 → 冷却 3 回合）',
      },
    ],
  },
]

/** 默认角色（先手 / 后手）。 */
export const DEFAULT_CHARACTERS: readonly [CharacterId, CharacterId] = ['deepseek', 'gemini']

/** 判断一个字符串是不是合法角色 id。 */
export function isCharacterId(value: unknown): value is CharacterId {
  return typeof value === 'string' && CHARACTER_SPECS.some((character) => character.id === value)
}

/** 查角色（未知 id 退回第一个角色）。 */
export function findCharacterSpec(id: CharacterId | string | null | undefined): CharacterSpec {
  return CHARACTER_SPECS.find((character) => character.id === id) ?? CHARACTER_SPECS[0]
}

/** 某个角色的技能表（引擎只认数值）。 */
export function skillsOfCharacter(id: CharacterId | string | null | undefined): readonly SkillSpec[] {
  return findCharacterSpec(id).skills
}
