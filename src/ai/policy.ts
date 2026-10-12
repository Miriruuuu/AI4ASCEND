/* AI 的可调参数与常量：所有"魔法数字"（权重 / 优先级 / 几何表 / AI_POLICY）集中在这里。 */
import { BOARD_SIZE, CELL_COUNT, cellId, isInsideBoard } from '../core/types'
import type { AiDifficulty } from './types'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 胜/负的分值（远大于任何局面评估值）。 */
export const WIN = 10_000_000
/** 棋盘下满时按血量判胜负的分值。 */
export const BOARD_WIN = 1_000_000
export const INF = 1 << 30

/**
 * 血量在评估里的权重：1 点血量相当于多少"棋盘分"。
 *
 * ⚠️ 这个值必须**远大于**任何形态分（W_THREE 等），否则评估会为了"保住一条三连"
 * 而放弃已经到手的真实伤害。实测：`W_THREE=130 / HP_WEIGHT=100` 时，一条三连
 * 被算成 1.3 点血，反而盖过了一次 3~4 点的真实攻击 —— AI 会放着一步成线不走。
 * 血量只有 6，攻击一次就是 3~5，它才是这一作里唯一真实的货币。
 */
export const HP_WEIGHT = 1_000
/**
 * 四连窗口里 3 颗己方 + 1 空位（"一步成线"，可发起攻击）的分值。
 *
 * 注意别调太高：一个"三"只是**下一步可以攻击**，而这一击经常会被对手的反击
 * 抵消掉（本作的常态），所以它的期望价值远不到"一次攻击的 4 点伤害"。
 * 早期取值 320（≈3.2 点血）会让评估为了"保住一条三连"而放弃已经到手的
 * 3 点真实伤害 —— 实测会直接放走必胜局面。
 */
export const W_THREE = 200
/** 2 颗己方 + 2 空位。 */
export const W_TWO = 30
/** 1 颗己方 + 3 空位。 */
export const W_ONE = 3
/**
 * 对手威胁的惩罚权重。
 *
 * ⚠️ 故意给得比 `W_THREE` 更大（防守权重 > 进攻权重）：对手一条"一步成线"的三连
 * 意味着**下一手就能发起 4 点攻击**，而自己的三连还要看对手让不让走 —— 威胁是不对称的，
 * 先手压制对手的成线点，比自己去搭一条等效的三连更值。实测：对称取值时 AI 会放任
 * 对手的活三去别处发展；改成 1.5 倍后它会主动去封。
 */
export const W_THREE_OPP = 300
export const W_TWO_OPP = 45
export const W_ONE_OPP = 4
/**
 * 行棋权（tempo）在评估里的权重。
 *
 * 本作里"轮到谁走"是**一等的资源**：一次攻击会把双方连珠棋子都清掉，
 * 谁能先动手谁就能先建立威胁。评估函数只看棋盘形状、不看轮次的话，
 * 会把"清理干净 + 我接着走"和"清理干净 + 对手接着走"算成同一个分数，
 * 于是在成线与不成线之间反复摇摆（实测：会放着一击成线不走，去搭虚势）。
 *
 * ⚠️ 但它必须**远小于** HP_WEIGHT：tempo 只出现在叶子、符号由叶子深度奇偶决定
 * （轮到我 → +TEMPO，轮到对手 → -TEMPO），一旦它大到能和血量/形态掰手腕，
 * 同一局面在 depth-2 / depth-4 / depth-6 会被判成相反的结论（实测振荡 ±200+）。
 * 压到 40（≈0.04 点血）后它只够在完全平局时做稳定 tiebreak。
 */
export const TEMPO = 40

/**
 * 一棵"被我方棋子占用"的魔力植物在评估里的价值。
 *
 * 植物有两个用途：**技能货币**（放技能要消耗它）与**攻击加成**（连珠上的己方植物 +1 伤）。
 * 评估里不给它赋值的话，AI 会把"放一个技能"看成纯赚 —— 实测会无脑刷护盾把植物耗光，
 * 反而丢掉后面的攻击加成。给一个远小于 1 点血、又明显大于 0 的价，消耗才有代价。
 *
 * ⚠️ bugv16：**只给"花得掉的那几棵"全价**（`PLANT_SPENDABLE`），超出的折价。
 * 起因：「播种」把长出的植物变成**归施法者所有**之后，一局能种出 **50+ 棵**，
 * 于是 `260 × 手里 20 多棵 = 5000+`，比整条血（1000/点）还值钱
 * ⇒ AI 的评估被植物完全主导：为了多长几棵植物放弃进攻、放弃走子质量，
 * 实测 `claude[全技能] vs claude[禁用播种]` 掉到 **22.8%**，而且**每局耗时涨 10 倍**
 * （植物格进了候选集 → 分支爆炸 → 固定 70ms 预算下搜索变浅）。
 * 一个"花不掉的资源"在真实价值上接近 0，所以超出部分按残值计。
 */
export const PLANT_VALUE = 260
/** 手里留几棵算"随时花得掉"（技能 1~2 费、冷却 5~6 次行动，储备 3 棵足够）。 */
export const PLANT_SPENDABLE = 3
/** 超出储备的部分：一时花不掉，还可能随连珠被扫走，只给残值。 */
export const PLANT_SURPLUS_VALUE = 20

/**
 * **我方窗口里的己方植物**（bugv16）：成线时每棵 +1 伤害（`damagePerPlant`）。
 *
 * 这是播种真正的价值所在 —— 它把植物长在**你刚落下的那颗子周围**，也就是你接下来要
 * 连线的地方。但"手里有植物"和"植物正好在我这条线上"是两个完全不同的价值，
 * 原先的评估只认前者 ⇒ 播种被当成"攒货币"，而 claude 每 6 次行动才花得掉 1 棵，
 * 攒了也是白攒（实测付 2 费时只有 36.9%，降到 1 费也只有 39.5% —— 显著负）。
 * 给"落在自己窗口里的植物"单独计价，让它有机会被真正兑现成伤害。
 * 量级取 120（< `W_THREE = 200`）：它是"这条线将来多打 1 点"的期权，不该盖过线本身。
 */
export const PLANT_LINE_VALUE = 120

/** bugv32「火球植物溢价」最多算几棵（正好是「恶龙吐息」max 费档的需求量；bugv33 max 3→2）。 */
export const FIREBALL_PLANT_BONUS_CAP = 2

/** 已到手植物的估价：前 `PLANT_SPENDABLE` 棵全价，其余按残值（bugv16）。 */
export function ownedPlantScore(stock: number): number {
  if (stock <= PLANT_SPENDABLE) return stock * PLANT_VALUE
  return PLANT_SPENDABLE * PLANT_VALUE + (stock - PLANT_SPENDABLE) * PLANT_SURPLUS_VALUE
}

/**
 * **可转化**的中立植物（bugv15）：不在任何一方名下、但算得上"我方地盘"的植物。
 *
 * 「播种」（claude 2 技能）一次就在落点周围长出几棵**中立**植物 —— 而中立植物
 * 在评估里原本是 0 分，于是"2 费换一地植物"这笔长期账在搜索里**完全看不见**。
 *
 * ⚠️ 但给价必须**贴着实测转化率**，否则会给出一笔假收益、把 AI 骗进亏本交易。
 * 实测（12 局 claude 镜像自对弈）：播种长出的 90 棵里，后来被人占下的只有 **14%**、
 * 52% 到终局仍无主、其余随连珠一起被扫掉。而且"紧挨 1 颗我方棋子"格外不可靠 ——
 * 播种长出的那一圈**每棵**都紧挨着刚下的那颗，所以"相邻 1 颗"几乎没有信息量。
 * 因此判据收紧成**被我方棋子夹住（相邻 ≥2 颗）**才算"大概率归我"：
 * - `mineNear >= 2 && foeNear == 0` → 大概率归我（取 200，≈ `W_THREE`，即"收割"与"搭三连"同价）；
 * - 只有 1 颗相邻 / 双方都挨着 → 抢，期望值折到 40。
 */
export const PLANT_CLAIM_EXCLUSIVE = 200
export const PLANT_CLAIM_SHARED = 40

/**
 * 每格"我方放出的烈焰"在评估里的价值（bugv15）。
 *
 * 烈焰原本对 `evaluate` **完全不可见** —— 但封锁才是火球最大的效果：整行整列锁死，
 * **对手的棋子落上去直接碎裂**（等于永久封路），只有施法者自己能踩着走（代价 1 点）。
 * 按"一格 = 一点封锁"给分，量级取小（整行整列 16 格 ≈ 350 分），
 * 免得 AI 为了铺火而无脑放火球。
 */
export const FLAME_CONTROL_WEIGHT = 22

/**
 * 护盾在评估里的权重（bugv15 引入，bugv16 定稿）。
 *
 * 历史：原本 `hp + shield + tempArmor` **同价**（`HP_WEIGHT = 1000`），而一棵植物只值 260
 * ⇒ "1 费换 1 点护盾"账面 **+740**，AI 数学上"永远该换"，实测 seedance 镜像局
 * **3 次/局**刷护盾、20 局里 18 局打成平局（僵局）。
 *
 * bugv15 一度砍到 120，结果**过冲**：机制指标显示**永久护盾会被真正吃掉 70~97%**
 * （不同于"到期作废"的临时护甲，后者只被吃掉 17~25%），
 * 也就是护盾的真实价值 ≈ `0.9 × HP_WEIGHT ≈ 900`，定 120 等于让 AI 严重欠买
 * → deepseek 一局护盾从 6.2 点掉到 …、胜率直接掉 26 个点。
 *
 * bugv16 取 **600**：保留"护盾比满血便宜"的折扣（它毕竟要靠对手来打才兑现），
 * 同时不再让 AI 拒买。搭配"护盾上限 = 血量上限"（引擎 `addShield`）之后，
 * 刷护盾不会退化成无限对刷，「攒植物 → 打真实伤害」与「买护盾」重新平衡。
 */
export const SHIELD_WEIGHT = 600
/** 临时护甲更脆（到期未用完直接作废，实测只被吃掉 17~25%）⇒ 单价还要更低（6×30 = 180 < 260）。 */
export const TEMP_ARMOR_WEIGHT = 30

/**
 * 未兑现的伤害加成（小一哥 / 毒鸡蛋）在评估里的权重。
 *
 * bugv12 #3：持续性增伤（小一哥 duration=2、毒鸡蛋 +1）是"欠我、但还没拿到手"的伤害。
 * 评估原本**完全忽略**它 → AI 会把"攥着加成不攻击"当成零成本，于是拖到下一回合才出手
 * （实测：同一局面 duration=1 成线攻击、duration=2 改成养棋点，只差 5 分）。
 * 给一个**低于已兑现伤害（HP_WEIGHT=1000）**的价：既让 AI 珍惜它（不乱丢），
 * 又让"立刻兑现成真实伤害"始终比"攥着"更值 —— 逼它早点把加成打出去。
 * 取 400（> W_THREE=200、< HP_WEIGHT=1000）：能盖过"保住一条三连"的诱惑，又不会盖过真伤害。
 */
export const PENDING_DAMAGE_WEIGHT = 400

/** 叶子节点的成线延伸上限（负深度到多少为止）。 */
export const QUIESCE_LIMIT = 4
/** 每个节点最多展开多少个候选着法。 */
export const MAX_MOVES = 34
/** 根节点最多展开多少个候选着法。 */
export const MAX_ROOT_MOVES = 48
/** 根节点最多解几步"行动"（技能 + 落子；8 个技能用完不交回合，最多也就几步）。 */
export const MAX_ROOT_STEPS = 4

/**
 * AI **政策**开关（bugv20）—— 只影响"着法生成的门槛"，**不影响规则**。
 *
 * 为什么要有它：`scripts/variants.ts` 只能改技能**数值**，而"AI 该不该更激进地放某个技能"
 * 属于政策。`scripts/duel.ts --policy-a/--policy-b` 会在每一步之前按边设置这里的字段，
 * 于是"政策改动"也能用同角色对撞拿到 ±5% 级别的结论。
 *
 * ⚠️ 线上（`src/app`）不设置它 ⇒ 永远用下面的默认值。
 */
export const AI_POLICY = {
  /**
   * 「小一哥」（持续 5 回合的增伤）是否按**长线投资**放。
   *
   * `true`：只要有"用不上的植物"当燃料就放（不要求这一手能成线）。
   * `false`：退回旧闸门（必须这一手能成线）。
   *
   * ⚠️ bugv21 对撞 320 局（±5.5）：长线闸门 **46.9% vs 53.1%** ⇒ **不显著（略负）**。
   * 口径上"无真空期 + 不占落子"说得通，但测不出收益 ⇒ **默认回退到 `false`**。
   */
  powerLongTerm: false,
  /**
   * 「精密计算」（临时护甲）的闸门档位 —— 三档递进，越往后放得越少。
   *
   * - `loose`（旧）：对手能成线（`foeAttack`）就放 —— "对手能成线"在四子棋里几乎恒真，
   *   护甲被当成"冷却好了就放"，实测败局里 78% 到期作废。
   * - `threat`（默认，bugv32 收紧）：只认真会用到护甲的情形 ——
   *   ① 我要攻击、对手也能反击（`mineAttack && foeAttack`）② 对手 ≥2 个成线点（大威胁）
   *   ③ 这一手走自己的火成线（自伤 1 点）。⚠️ bugv33 起**默认不再**包含"火球能开线"
   *   （`armorAllowFbOpen=false`）：那条不要求对手威胁，是护甲乱开（聚焦赛 774 次）的主因。
   * - `strict`（bugv21 新）：在 `threat` 上再要求**我挡不住**（这一手自己没有成线点可用来对撞抵消）。
   */
  armorGate: 'threat' as ArmorGate,
  /**
   * 精密计算 `threat` 档是否保留"火球能开线"这个放行分支（bugv33）。
   * `false`（默认）= 收紧：护甲只在"对手能反击 / 对手 ≥2 成线点 / 走火自伤"时放，
   *   不再因为"我有 3 己方+1 敌子窗口、火球能开线"就开 —— 这是护甲乱开（聚焦赛 774 次）
   *   的主因。用 `--policy=armor-fb-open` 可镜像对撞验证旧口径。
   */
  armorAllowFbOpen: false,
  /**
   * 烈焰封锁的叶子估价（每格）。默认 = `FLAME_CONTROL_WEIGHT`。
   *
   * bugv32 调研：gtp 掉分主因在火球，而火球的长期价值就是烈焰控场 + 直击碎子。
   * 这里放开成政策开关，用对撞验证"AI 是不是低估了烈焰"（`--policy-b=flame-w60` 之类）。
   */
  flameWeight: FLAME_CONTROL_WEIGHT,
  /**
   * 临时护甲的叶子估价（每点）。默认 = `TEMP_ARMOR_WEIGHT`。
   *
   * bugv32 调研：现口径护甲到期浪费 60%，怀疑"30/点"过低估了真会被吃掉的护甲。
   * 放开成政策开关（`--policy-b=armor-w120` 之类）。
   */
  tempArmorWeight: TEMP_ARMOR_WEIGHT,
  /**
   * gtp「恶龙吐息」的**植物溢价**（每棵，最多算 `FIREBALL_PLANT_BONUS_CAP` 棵）。
   *
   * bugv32 诊断：gtp 平均只持有 0.98 棵植物，火球冷却好时 86% 的手 <3 棵 ⇒ 3 费碎子开线
   * 放不出来。而 gtp 认领植物并不懒（11 次/局），问题是**攥不住**：护甲 + 1 费火球把植物
   * 即时烧光。根因是 AI 把 gtp 的植物当"通用 260 分"，但对 gtp 来说 3 棵植物 = 一次
   * "碎掉挡我成线的敌子 → 走火成线"的胜负手，价值远超 780。
   *
   * 这个溢价只加给**有 fireball 技能**的一方（`evaluate` 里判断），不影响其他角色。
   * 镜像对撞扫描（100 对 / 200 局，确定性）：
   *   300 → 64.0%（±6.7）· 500 → 75.0%（±6.0）· 800 → 76.0%（±5.9）
   * ⇒ 500 已到拐点（800 只 +1 点在 CI 内），取 500。
   */
  fireballPlantBonus: 500,
  /**
   * Qwen「本地部署」（bugv34m）：是否**只在"这一手能成线"时**才进候选。
   *
   * `false`（默认）：不成线时也放（消耗 1 棵、在**落点**长回 1 棵，等于把那棵植物挪到自己刚下的子）。
   * `true`：收紧成"只为 +1 伤害而放"（与 `firstStrike` 同口径）。
   *
   * 📊 **证据冲突，暂不采纳收紧**（bugv34n 结论）：
   *   - 探针 `scripts/probe-qwen.ts`（qwen vs deepseek，60 局 × 两轮）都显示收紧更好：
   *     「成线加伤」108 → 193 次，胜率 53.3% → 61.7%（另一轮 55.0% → 66.7%）。
   *   - 但**同角色镜像对撞**（320 局，CI ±5.5%）**测不出**：旧口径 51.7% vs 收紧 48.3% ⇒ 不显著。
   *   - 两轮探针**复用同一批开局种子**，不是独立样本；按本项目方法论，
   *     单条 AI 政策改动应以镜像对撞为准 ⇒ **默认保持 `false`**。
   *   - 机制猜测：非攻击释放的"挪植物"本身有收益（把植物挪到自己棋子上 = 成线窗口加伤 + 抢归属），
   *     消耗的植物换回来的不只是 +1 伤害 ⇒ 收紧后的收益被抵消。**对手不同结论还会翻转。**
   * 想继续跟：`--policy=deploy-attack`（镜像对撞）/ `POLICY_DEPLOY_ATTACK=1`（探针）。
   * ⚠️ bugv34o 起默认走 `deployGate='prep'`（另一套闸门），本开关**只在 `'anytime'` 档生效**。
   */
  deployOnlyOnAttack: false,
  /**
   * Qwen「小千问」（bugv34m）是否允许 AI 使用 —— `false` = 该技能根本不进候选。
   *
   * 用途：判定"这个技能对 AI 来说是不是净负担"（消耗 1~2 棵植物 + 把我方棋子挪到
   * 半随机的空位）。用 `--policy=no-redeploy` / `POLICY_NO_REDEPLOY=1` 验证。
   */
  redeployEnabled: true,
  /**
   * Qwen「本地部署」烧哪棵植物当燃料。
   *
   * `false`（默认，现口径）= 按格子序号取第一棵 `owned[0]` —— 可能正是**占在成线窗口上**
   *   的那棵（每有一棵就 +1 伤害），烧掉等于白丢 1 点攻击值。
   * `true` = 优先烧"用不上的"（`spare`：不在成线窗口上的己方植物），不够再退回 `owned`。
   *   ⚠️ 「小一哥」（`power`）一直是优先烧 spare 的，这里只是把**同一口径**补给本地部署。
   *
   * 📊 实测（探针 60 局）：胜率 **61.7% vs 61.7%（无差别）**，「成线加伤」184 vs 193（反而略低）
   *   ⇒ **测不出收益，保持关闭** —— 不因为"看起来更讲究"就打开。
   * 用 `--policy=deploy-spare` / `POLICY_DEPLOY_SPARE=1` 复核。
   * ⚠️ bugv34o 起默认走 `deployGate='prep'` —— 那一档**本来就只烧 `spare`**（不够就干脆不放），
   *   所以本开关只在 `'anytime'` 档有意义。
   */
  deployPreferSpareFuel: false,
  /**
   * Qwen「本地部署」的放行口径（bugv34o，**用户口述的释放时机**）。
   *
   * `'anytime'`（默认，现口径）：成线 → 放；不成线 → 只要植物系统开着且有空格就放
   *   （消耗 1 棵、在**落点**长回 1 棵 = 把那棵植物挪到自己刚下的子上）。
   * `'prep'`（用户口径）：只在"这次释放能换到东西"时放 ——
   *   ① 这一手能成线（发起攻击）⇒ 净 +1 伤害；
   *   ② 否则必须**这一手能布下"下回合可直接成线的形状"**：落点落在一个
   *      「我方 2 子 + 2 空位 + 0 对手」的窗口上 ⇒ 下回合补第 4 颗即成线，
   *      于是被换过来的那棵植物**正好预置在将来那条连珠上**、下回合成线时吃到 +1。
   *   两种情形都要求手里有 `spare`（不在任何"我方≥2 子"窗口里的闲置植物）当燃料 ——
   *   烧"用不上的"那棵才不削减这一击的植物加伤，也才符合用户说的"空闲的、暂时难以利用的"。
   *
   * 用户明确**否掉**的时机（`'prep'` 会拦掉）：
   *   ① 放了技能却下在"既有植物、又不成线"的位置（`deployGrow` 跳过 ⇒ 白耗 1 棵）；
   *   ② 为了封堵对手而放（⚠️ 由条件①②自动排除：封堵手不会让它自己的窗口变成 2 子）。
   *
   * 用 `--policy=deploy-prep`（镜像对撞）/ `POLICY_DEPLOY_GATE=prep`（探针）验证。
   *
   * 📊 bugv34o 实测（**三处测量方向一致**）：
   *   · 探针 `scripts/probe-qwen.ts` 60 局（qwen vs deepseek）：胜率 51.7% → **70.0%**；
   *     一技能释放量 512 → 171 次（砍掉的多是"把一棵**有用的**植物挪到新子上再进冷却"），
   *     落点落在"下回合可成线"窗口里的比例 286/512 → 101/171。
   *   · 同角色镜像对撞（`--policy-b=deploy-prep`，60 局）：新口径 **53.3%**（A 46.7%，CI ±12.6）。
   *   · 同角色镜像对撞（`--policy-b=deploy-prep,redeploy-plant`，60 局）：新口径 **58.3%**
   *     （A 41.7%，CI ±12.5）。
   *   ⚠️ 单次 60 局都**未达显著**（CI 跨过 50%），但三处点估计同向且机制自洽 ⇒ 采纳为默认；
   *   `--policy=deploy-prep-off` 可一键退回旧口径。
   */
  deployGate: 'prep' as 'anytime' | 'prep',
  /**
   * Qwen「小千问」是否要求"场上真的有能顺手吃下的无主植物目标"（bugv34o 用户口径）。
   *
   * 用户口径：只有在"场上有**多个无主**魔力植物、且它们在我能轻松利用的位置上"时才用二技能。
   * 目标口径 = 空位 ∧ 不会形成连珠 ∧ 该格有魔力植物（空位上的植物必为无主 ——
   * 归属由"压着的棋子"派生），与 `pickRedeployCell` 的首要优先级**同一集合**。
   *
   * `false`（默认，现口径）= 不看目标，只要有空格就进候选（挪出去的棋子常常只是
   *   "落在离落点最近的一圈"，吃不到植物）。
   * `true` = 目标数必须 ≥ 本次消耗量（1 费要 1 个、2 费要 2 个）。
   * 用 `--policy=redeploy-plant`（镜像对撞）/ `POLICY_REDEPLOY_PLANT=1`（探针）验证。
   *
   * 📊 bugv34o 实测：探针里"挪出去的棋子落在本来有植物的格子上"的比例 97.6% → **99.3%**；
   *   镜像对撞 60 局里与 `deploy-prep` 搭配拿到 **58.3%**（对照 41.7%，CI ±12.5）。
   *   单次未达显著，但机制正确（没有目标时这个技能只能把棋子丢在"最近一圈"，收益薄）⇒ 采纳。
   * `--policy=redeploy-noplant` 可退回旧口径。
   */
  redeployRequirePlantTarget: true,
}

/** 「精密计算」闸门档位。 */
export type ArmorGate = 'loose' | 'threat' | 'strict'

/** 着法排序优先级（战术 >>> 位置）。 */
export const PRIO_ATTACK_MINE = 1_000_000
export const PRIO_ATTACK_OPP = 400_000
export const PRIO_THREE_MINE = 20_000
export const PRIO_THREE_OPP = 8_000
/**
 * 魔力植物格（bugv13 #3）。
 *
 * ⚠️ 植物必须**进候选集**，而不只是进叶子评估 —— 「落子即成线」的战术优先级把
 * 候选集撑满之后，离棋子较远的植物格会被 `slice(0, limit)` 直接剪掉，
 * AI 于是表现为"看不见植物"（实机回放里一整局 AI 认领 0 棵，而它两个技能都要植物）。
 *
 * 量级取在"战术窗口（≥8k）之下、贴近棋子（≤220）之上"：
 * 这游戏里成线攻击是决定性的，战术永远优先；但**抢对手的植物**同时抬升自己、
 * 削弱对手，所以比捡中立植物更值钱。
 */
export const PRIO_PLANT_FOE = 3_000
export const PRIO_PLANT_NEUTRAL = 1_200
export const PRIO_NEAR1 = 220
export const PRIO_NEAR2 = 40

export const DIFFICULTY: Record<AiDifficulty, { depth: number; budget: number }> = {
  easy: { depth: 2, budget: 60 },
  normal: { depth: 6, budget: 250 },
  hard: { depth: 11, budget: 800 },
  expert: { depth: 22, budget: 1500 },
}

export const TT_EXACT = 0
export const TT_LOWER = 1
export const TT_UPPER = 2

export const CENTER = cellId(BOARD_SIZE >> 1, BOARD_SIZE >> 1)

/** 「双子星」把连珠门槛降到 2（与 `GameEngine` 的 `TWIN_STAR_LINE_LENGTH` 一致）。 */
export const TWIN_STAR_LINE_LENGTH = 2

/** 走在自己的烈焰上的代价（bugv14，与引擎的 `FLAME_WALK_DAMAGE` 一致）。 */
export const FLAME_WALK_DAMAGE = 1

/**
 * bugv19：踏入**自己的**烈焰的闸门。
 *
 * 实测（`scripts/probe-gtp.ts`，10 局 gtp vs deepseek）：AI 走进自己的火 **11.3 次/局**，
 * 其中只有 **34%** 当场成线攻击 —— 约 2/3 是"白走"，每次白付 1 点血 ⇒ **每局自伤 ~7.5 点**
 * （gtp 只有 8 点血）。人类回放里只有 1~4 次，且基本都是终结技。
 *
 * 于是：自己的火焰格**只有在**下面两种情况才进候选集 ——
 * ① 这一手当场成线（发起攻击，1 点血换一击）；
 * ② 这一手能挡住对手的一步成线（防守刚需）。
 *
 * ⚠️ ② 在火焰格上几乎不可能成立（对手根本进不来），所以闸门实际上等效于"只为攻击走火"；
 * 保留 ② 是为了语义完整（将来若有别的"能踩的地形"可以复用同一判据）。
 */
export const GATE_OWN_FLAME_WALK = true

export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
]

/** 所有长度为 4 的窗口（4 个格子下标依次排布），共 180 个。 */
export const WINDOWS: Int32Array = (() => {
  const list: number[] = []
  for (const [dr, dc] of DIRS) {
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const r3 = row + dr * 3
        const c3 = col + dc * 3
        if (!isInsideBoard(r3, c3)) continue
        list.push(
          cellId(row, col),
          cellId(row + dr, col + dc),
          cellId(row + dr * 2, col + dc * 2),
          cellId(r3, c3),
        )
      }
    }
  }
  return Int32Array.from(list)
})()
export const WINDOW_COUNT = WINDOWS.length / 4

/** 每个格子距离 1 与距离 2 的邻居（前 8 个是距离 1），越界记 -1。 */
export const NB24: Int32Array = (() => {
  const order: Array<[number, number]> = []
  const far: Array<[number, number]> = []
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      if (dr === 0 && dc === 0) continue
      if (Math.max(Math.abs(dr), Math.abs(dc)) === 1) order.push([dr, dc])
      else far.push([dr, dc])
    }
  }
  const list = [...order, ...far]
  const out = new Int32Array(CELL_COUNT * list.length).fill(-1)
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const base = cellId(row, col) * list.length
      for (let k = 0; k < list.length; k++) {
        const r = row + list[k][0]
        const c = col + list[k][1]
        out[base + k] = isInsideBoard(r, c) ? cellId(r, c) : -1
      }
    }
  }
  return out
})()
export const NB_STRIDE = NB24.length / CELL_COUNT

/** Zobrist 哈希表（置换表用）。 */
export const ZOBRIST: Int32Array[] = (() => {
  let seed = 0x9e3779b9
  const next = (): number => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return seed | 0
  }
  return [new Int32Array(CELL_COUNT), new Int32Array(CELL_COUNT)].map((row) => {
    for (let i = 0; i < CELL_COUNT; i++) row[i] = next()
    return row
  })
})()
export const ZOBRIST_TURN = [0x2468ace, -0x1234567]

export const now: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now()

// ---------------------------------------------------------------------------
// 迷你引擎：与 GameEngine 的状态转移保持一致
// ---------------------------------------------------------------------------

/** 空的植物副作用列表常量（避免每次分配）。 */
/** 差分种类（`Undo.diff` 里的三元组 `[kind, cell, value]`）。 */
export const DIFF_BOARD = 0
export const DIFF_PLANT = 1
export const DIFF_FLAME = 2
export const DIFF_OVERLAY = 3
/** bugv14：烈焰归属（与 `DIFF_FLAME` 分开记，这样两张表能各自精确回滚）。 */
export const DIFF_FLAME_OWNER = 4

/** 植物归属在差分里的编码：-1 = 原本没有；-2 = 中立（无主）；0 / 1 = 归属。 */
export const PLANT_ABSENT = -1
export const PLANT_NEUTRAL = -2

/** 空数组常量（避免每次分配）。 */
export const EMPTY_CELLS: number[] = []
