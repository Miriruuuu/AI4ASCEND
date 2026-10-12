/**
 * 同角色「规则对撞」：**同一个角色**坐两边，一侧用变体规则、另一侧用基准规则。
 *
 * 为什么需要它（而不是循环赛）：
 *   跨角色循环赛每个角色只有 100 多局样本（±9% 噪声），而"某个技能是加强还是削弱"
 *   这种问题需要的分辨率是 ±3%。同角色对撞把变量压到只剩**一条数值差异**：
 *   基础规则、角色、AI、开局全部相同，胜负差 100% 归因于那一条差异。
 *
 * 配对设计：每组打两局，A/B 各先手一次，且两局用**同一个随机开局种子**（盘面相同）
 *   → 同时抵消开局运气与先后手偏差。只要优势方两局都赢，就能立刻看出方向。
 *
 * 用法：
 *   pnpm exec tsx scripts/duel.ts [角色] [变体A] [变体B] [对数] [每手ms] [手数上限] [随机开局手数]
 *   例：pnpm exec tsx scripts/duel.ts gtp base immune1 40 70 220 8
 *      （gtp 用"免疫2回合" vs gtp 用"免疫1回合"）
 *
 * 分片（大样本并行）：加 `--shard=k/N` 只跑第 k 片，加 `--json` 输出机器可读结果，
 * 再加 `--merge a.json b.json ...` 合并。分片只影响"跑哪几对"，结果与串行**逐字节等价**。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { applyAiSkills, fallbackPlacement } from './harness'
import { AI_POLICY, decideMove, type AiDifficulty, type AiMagicContext, type AiSkillContext, type ArmorGate } from '../src/ai/baseline'
import { CHARACTER_SPECS, type CharacterId } from '../src/core/characters'
import { GameEngine } from '../src/core/engine'
import { INITIAL_HP, other, type Board, type PlayerIndex, type SkillSpec } from '../src/core/types'
import { makeSpecResolver, mulberry32 } from './variants'

const raw = process.argv.slice(2)
const flags = raw.filter((a) => a.startsWith('--'))
const argv = raw.filter((a) => !a.startsWith('--'))
/**
 * 取 `--name=value` 的值。
 *
 * ⚠️ **必须容忍调用方带/不带 `--` 前缀** —— 这里踩过一次：`flagValue('nodes')`
 * 在"要求带前缀"的实现下永远匹配不到 `--nodes=...`，于是 `--nodes=15872`
 * **静默失效**（整轮对撞退回 70ms 时间预算，还浑然不知）。
 * 现在统一把两边的前缀都剥掉再比，杜绝这类静默失败。
 */
const flagValue = (name: string): string | undefined => {
  const key = `--${name.replace(/^--/, '')}=`
  const hit = flags.find((f) => f.startsWith(key))
  return hit ? hit.slice(key.length) : undefined
}

const character = (argv[0] ?? 'gtp') as CharacterId
const variantA = argv[1] ?? 'base'
const variantB = argv[2] ?? 'base'
const pairs = Number(argv[3] ?? 40)
const budget = Number(argv[4] ?? 70)
const maxPlies = Number(argv[5] ?? 220)
const randomOpenPlies = Number(argv[6] ?? 8)
const difficulty: AiDifficulty = 'expert'
/**
 * 确定性预算（bugv18）：`--nodes=15872` ≈ 本机 70ms。
 * 给了它之后同角色对撞**完全可复现**（AI 不再受 CPU 负载影响），
 * 于是"两组规则的差异"里不再混入测量噪声。
 */
const nodeLimit = Math.max(0, Number(flagValue('--nodes') ?? 0))

const shardSpec = flagValue('--shard')
const shardMatch = shardSpec ? /^(\d+)\/(\d+)$/.exec(shardSpec) : null
const shardIndex = shardMatch ? Number(shardMatch[1]) : 0
const shardCount = shardMatch ? Number(shardMatch[2]) : 1
const jsonOut = flags.includes('--json')

/**
 * **AI 政策**（bugv20）：变体表只能改技能数值，而"AI 该不该更激进地放某个技能"是政策。
 *
 * `--policy-a` / `--policy-b` 用逗号分隔的 token 覆盖 `AI_POLICY`，默认全为线上默认值：
 *   - `power-line`     ：小一哥退回旧闸门（必须这一手成线才放）〔= 线上默认〕
 *   - `power-longterm` ：小一哥按长线投资放（有闲植物就放）
 *   - `armor-loose`    ：精密计算退回旧闸门（我要攻击/对手能成线/残血 任一即可放）
 *   - `armor-threat`   ：精密计算仅"真会用到护甲"才放〔= 线上默认〕
 *   - `armor-strict`   ：在 `armor-threat` 上再要求"我挡不住"
 *   - `deploy-attack`  ：Qwen「本地部署」只在"这一手能成线"时进候选
 *   - `deploy-anytime` ：Qwen「本地部署」不成线时也放（旧口径）〔= 线上默认〕
 *   - `deploy-prep`    ：Qwen「本地部署」按用户口径放 —— 成线时照放；不成线时只在
 *                        "这手能布下下回合可直接成线的形状"且手里有闲置植物时才放
 *   - `deploy-spare`   ：Qwen「本地部署」优先烧"用不上的"植物（别烧占在成线窗口上的）
 *   - `no-redeploy`    ：Qwen「小千问」不进候选（测"它是不是净负担"）
 *   - `redeploy-plant` ：Qwen「小千问」要求场上真有能顺手吃下的无主植物目标（数量 ≥ 消耗量）
 *   - `redeploy-noplant`：Qwen「小千问」不看目标〔= 线上默认〕
 * 例：`--policy-a=default --policy-b=armor-loose`
 */
interface AiPolicyFlags {
  powerLongTerm: boolean
  armorGate: ArmorGate
  armorAllowFbOpen: boolean
  flameWeight: number
  tempArmorWeight: number
  fireballPlantBonus: number
  deployOnlyOnAttack: boolean
  deployPreferSpareFuel: boolean
  deployGate: 'anytime' | 'prep'
  redeployEnabled: boolean
  redeployRequirePlantTarget: boolean
}
function parsePolicy(spec: string | undefined, label: string): AiPolicyFlags {
  const out: AiPolicyFlags = {
    powerLongTerm: AI_POLICY.powerLongTerm,
    armorGate: AI_POLICY.armorGate,
    armorAllowFbOpen: AI_POLICY.armorAllowFbOpen,
    flameWeight: AI_POLICY.flameWeight,
    tempArmorWeight: AI_POLICY.tempArmorWeight,
    fireballPlantBonus: AI_POLICY.fireballPlantBonus,
    deployOnlyOnAttack: AI_POLICY.deployOnlyOnAttack,
    deployPreferSpareFuel: AI_POLICY.deployPreferSpareFuel,
    deployGate: AI_POLICY.deployGate,
    redeployEnabled: AI_POLICY.redeployEnabled,
    redeployRequirePlantTarget: AI_POLICY.redeployRequirePlantTarget,
  }
  for (const token of (spec ?? '').split(',').map((t) => t.trim()).filter(Boolean)) {
    switch (token) {
      case 'default':
        break
      case 'deploy-attack':
        out.deployOnlyOnAttack = true
        break
      case 'deploy-anytime':
        out.deployOnlyOnAttack = false
        break
      case 'deploy-prep':
        out.deployGate = 'prep'
        break
      case 'deploy-prep-off':
        out.deployGate = 'anytime'
        break
      case 'deploy-spare':
        out.deployPreferSpareFuel = true
        break
      case 'redeploy-plant':
        out.redeployRequirePlantTarget = true
        break
      case 'redeploy-noplant':
        out.redeployRequirePlantTarget = false
        break
      case 'no-redeploy':
        out.redeployEnabled = false
        break
      case 'power-line':
        out.powerLongTerm = false
        break
      case 'power-longterm':
        out.powerLongTerm = true
        break
      case 'armor-loose':
        out.armorGate = 'loose'
        break
      case 'armor-threat':
        out.armorGate = 'threat'
        break
      case 'armor-strict':
        out.armorGate = 'strict'
        break
      case 'armor-fb-open':
        out.armorAllowFbOpen = true
        break
      default: {
        const flame = /^flame-w(\d+)$/.exec(token)
        const armor = /^armor-w(\d+)$/.exec(token)
        const fbPlant = /^fb-plant-(\d+)$/.exec(token)
        if (flame) {
          out.flameWeight = Number(flame[1])
          break
        }
        if (armor) {
          out.tempArmorWeight = Number(armor[1])
          break
        }
        if (fbPlant) {
          out.fireballPlantBonus = Number(fbPlant[1])
          break
        }
        console.error(
          `未知政策 token：${token}（${label}）。可选：default / power-line / power-longterm / ` +
            'armor-loose / armor-threat / armor-strict / armor-fb-open / deploy-attack / deploy-anytime / ' +
            'deploy-prep / deploy-prep-off / deploy-spare / no-redeploy / redeploy-plant / redeploy-noplant / ' +
            'flame-w<数字> / armor-w<数字> / fb-plant-<数字>',
        )
        process.exit(1)
      }
    }
  }
  return out
}
const policyA = parsePolicy(flagValue('--policy-a'), '--policy-a')
const policyB = parsePolicy(flagValue('--policy-b'), '--policy-b')
const policyText = (p: AiPolicyFlags): string =>
  `${p.powerLongTerm ? '长线小一哥' : '成线才放小一哥'} / 护甲:${{ loose: '宽闸门', threat: '仅威胁', strict: '且挡不住' }[p.armorGate]}${p.armorAllowFbOpen ? '+开线' : ''}` +
  ` / 烈焰${p.flameWeight}·护甲${p.tempArmorWeight}·火球植物${p.fireballPlantBonus}` +
  ` / 本地部署:${p.deployGate === 'prep' ? '预置口径' : p.deployOnlyOnAttack ? '只成线' : '随时'}${p.deployPreferSpareFuel ? '+烧闲植物' : ''}` +
  ` / 小千问:${p.redeployEnabled ? (p.redeployRequirePlantTarget ? '要植物目标' : '开') : '关'}`
/** 每一步之前按"该谁走"切换政策（两边同进程，必须逐步设置）。 */
const applyPolicy = (p: AiPolicyFlags): void => {
  AI_POLICY.powerLongTerm = p.powerLongTerm
  AI_POLICY.armorGate = p.armorGate
  AI_POLICY.armorAllowFbOpen = p.armorAllowFbOpen
  AI_POLICY.flameWeight = p.flameWeight
  AI_POLICY.tempArmorWeight = p.tempArmorWeight
  AI_POLICY.fireballPlantBonus = p.fireballPlantBonus
  AI_POLICY.deployOnlyOnAttack = p.deployOnlyOnAttack
  AI_POLICY.deployPreferSpareFuel = p.deployPreferSpareFuel
  AI_POLICY.deployGate = p.deployGate
  AI_POLICY.redeployEnabled = p.redeployEnabled
  AI_POLICY.redeployRequirePlantTarget = p.redeployRequirePlantTarget
}

if (!CHARACTER_SPECS.some((spec) => spec.id === character)) {
  console.error(`未知角色：${character}（可选 ${CHARACTER_SPECS.map((s) => s.id).join(' / ')}）`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 合并模式：只做数据相加，**不跑任何对局**（必须放在最前面短路）
// ---------------------------------------------------------------------------
interface DuelSummary {
  character: string
  variantA: string
  variantB: string
  policyA?: string
  policyB?: string
  pairs: number
  games: number
  winsA: number
  winsB: number
  draws: number
  sweepA: number
  sweepB: number
  hpSum: number
  pliesSum: number
  totalA: Record<string, number>
  totalB: Record<string, number>
  ci: number
  rateA: number
}

if (flags.some((f) => f === '--merge')) {
  const files = argv.filter((a) => a.endsWith('.json'))
  if (files.length === 0) {
    console.error('--merge 需要给出至少一个 JSON 文件')
    process.exit(1)
  }
  const parts = files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as DuelSummary)
  const acc = {
    games: 0, winsA: 0, winsB: 0, draws: 0, sweepA: 0, sweepB: 0, hpSum: 0, pliesSum: 0,
    totalA: {} as Record<string, number>, totalB: {} as Record<string, number>,
  }
  for (const p of parts) {
    acc.games += p.games
    acc.winsA += p.winsA
    acc.winsB += p.winsB
    acc.draws += p.draws
    acc.sweepA += p.sweepA
    acc.sweepB += p.sweepB
    acc.hpSum += p.hpSum
    acc.pliesSum += p.pliesSum
    for (const [k, v] of Object.entries(p.totalA)) acc.totalA[k] = (acc.totalA[k] ?? 0) + v
    for (const [k, v] of Object.entries(p.totalB)) acc.totalB[k] = (acc.totalB[k] ?? 0) + v
  }
  const rate = acc.games === 0 ? 0 : (acc.winsA + acc.draws / 2) / acc.games
  const seM = Math.sqrt(Math.max(rate * (1 - rate), 1e-9) / Math.max(acc.games, 1))
  const ciM = 1.96 * seM
  const head = parts[0]
  console.log(`规则对撞（合并 ${parts.length} 片）：${head.character} [A=${head.variantA}] vs ${head.character} [B=${head.variantB}]`)
  if (head.policyA || head.policyB) {
    console.log(`  A 政策：${head.policyA ?? '—'} ｜ B 政策：${head.policyB ?? '—'}`)
  }
  console.log(`  A 胜 ${acc.winsA} · 平 ${acc.draws} · 负 ${acc.winsB}（共 ${acc.games} 局，${acc.games / 2} 组）`)
  console.log(`  → A 胜率 ${(rate * 100).toFixed(1)}%  (95% CI ±${(ciM * 100).toFixed(1)})`)
  console.log(`  配对横扫：A 两局全胜 ${acc.sweepA} 组 · B 两局全胜 ${acc.sweepB} 组`)
  console.log(`  平均血量差（A−B）${(acc.hpSum / Math.max(acc.games, 1)).toFixed(2)} · 平均手数 ${(acc.pliesSum / Math.max(acc.games, 1)).toFixed(1)}`)
  console.log(`  A 技能使用：${JSON.stringify(acc.totalA)}`)
  console.log(`  B 技能使用：${JSON.stringify(acc.totalB)}`)
  if (rate - ciM > 0.5) console.log(`判定：A（${head.variantA}）**显著更强**`)
  else if (rate + ciM < 0.5) console.log(`判定：A（${head.variantA}）**显著更弱**`)
  else console.log(`判定：不显著（CI 跨过 50%）`)
  process.exit(0)
}

interface DuelOutcome {
  /** A 方的血量差（正 = A 占优）。 */
  hpMarginA: number
  winner: 0 | 1 | null
  /** A 是否执先手。 */
  aFirst: boolean
  skillsA: Record<string, number>
  skillsB: Record<string, number>
  plies: number
}

/** 单局：`specs[0]` = A 方（座位上永远在 0），`specs[1]` = B 方。 */
function playDuel(
  seed: number,
  specs: readonly [readonly SkillSpec[], readonly SkillSpec[]],
  policies: readonly [AiPolicyFlags, AiPolicyFlags],
): DuelOutcome {
  const rng = mulberry32(seed)
  const engine = new GameEngine({
    initialHp: INITIAL_HP,
    fixedFirstPlayer: 0,
    magic: { enabled: true },
    skills: [specs[0], specs[1]],
    night: { enabled: false },
  })
  engine.takeEvents()

  const magicCtx = (): AiMagicContext => ({
    plants: [...engine.magic.values()].map(
      (plant) => [plant.cell, plant.owner] as [number, PlayerIndex | null],
    ),
    damagePerPlant: engine.magicConfig.damagePerPlant,
  })
  const skillCtx = (): AiSkillContext => ({
    skills: engine.skills,
    shield: [engine.shield[0], engine.shield[1]],
    bonusActions: [engine.bonusActions[0], engine.bonusActions[1]],
    actionsTaken: [engine.actionsTaken[0], engine.actionsTaken[1]],
    skillReadyAt: [engine.skillReadyAt[0].slice(), engine.skillReadyAt[1].slice()],
    skillCasts: [engine.skillCasts[0].slice(), engine.skillCasts[1].slice()],
    powerBonus: [engine.powerBonus[0], engine.powerBonus[1]],
    powerUntil: [engine.powerUntil[0], engine.powerUntil[1]],
    sabotage: [engine.sabotage[0], engine.sabotage[1]],
    sabotageBonus: [engine.sabotageBonus[0], engine.sabotageBonus[1]],
    twinStar: [engine.twinStar[0], engine.twinStar[1]],
    bloomCheaperNext: [engine.bloomCheaperNext[0], engine.bloomCheaperNext[1]],
    tempArmor: [engine.tempArmor[0], engine.tempArmor[1]],
    tempArmorUntil: [engine.tempArmorUntil[0], engine.tempArmorUntil[1]],
    strikeBonus: [engine.strikeBonus[0], engine.strikeBonus[1]],
    strikeUntil: [engine.strikeUntil[0], engine.strikeUntil[1]],
    seedGrow: [engine.seedGrow[0], engine.seedGrow[1]],
    flameOwner: [...engine.flameOwner.entries()] as Array<[number, number]>,
    immuneUntil: [engine.immuneUntil[0], engine.immuneUntil[1]],
    turnNo: engine.turnNo,
    flames: [...engine.flames.entries()],
    overlay: [...engine.overlay.entries()] as Array<[number, number]>,
    initialHp: INITIAL_HP,
  })

  const skills: [Record<string, number>, Record<string, number>] = [{}, {}]
  let plies = 0

  while (!engine.isOver && plies < maxPlies) {
    plies += 1

    // 随机开局：前 N 手双方随机落子（制造不同的局面，避免确定性 AI 每局完全重复）
    if (plies <= randomOpenPlies) {
      if (engine.awaitingDefense) {
        const empties = engine.emptyCells()
        if (empties.length === 0) break
        engine.defend(empties[Math.floor(rng() * empties.length)])
      } else {
        const legal = engine.legalMoves().filter((cell) => !engine.flames.has(cell))
        if (legal.length === 0) break
        engine.commit(legal[Math.floor(rng() * legal.length)])
      }
      engine.takeEvents()
      continue
    }

    if (engine.awaitingDefense) {
      const defender: PlayerIndex = other(engine.highlightOwner ?? 0)
      applyPolicy(policies[defender])
      const decision = decideMove({
        board: engine.board as Board,
        player: defender,
        selfHp: engine.hp[defender],
        opponentHp: engine.hp[other(defender)],
        mode: 'defend',
        highlightWeights: engine.highlights,
        // bugv17 #4：攻击方的加伤在宣告攻击时就锁定了（植物已随棋子删除），
        // 必须显式传过去，否则防守方会低估来袭伤害
        attackBaseDamage: engine.attack?.baseDamage,
        attackPlants: engine.attack?.attackerPlants,
        difficulty,
        timeLimitMs: budget,
        nodeLimit: nodeLimit > 0 ? nodeLimit : undefined,
        magic: magicCtx(),
        // bugv13 #2：防守搜索也要看得到技能状态
        skills: skillCtx(),
      })
      if (decision.move < 0 || engine.board[decision.move] !== 0) throw new Error('防守方给出非法落点')
      engine.defend(decision.move)
      engine.takeEvents()
      continue
    }

    const player = engine.current
    applyPolicy(policies[player])
    const decision = decideMove({
      board: engine.board as Board,
      player,
      selfHp: engine.hp[player],
      opponentHp: engine.hp[other(player)],
      mode: 'attack',
      difficulty,
      timeLimitMs: budget,
      nodeLimit: nodeLimit > 0 ? nodeLimit : undefined,
      magic: magicCtx(),
      skills: skillCtx(),
    })

    const appliedSkills = applyAiSkills(engine, player, decision.skills)
    for (const used of appliedSkills.used) skills[player][used.effect] = (skills[player][used.effect] ?? 0) + 1
    // endsTurn / assault：用完这一手不再落子（bugv14 收敛到 harness.applyAiSkills）
    if (appliedSkills.skipPlacement) continue

    let move = decision.move
    if (move < 0 || !engine.canPlaceAt(move)) {
      const pick = fallbackPlacement(engine, player)
      if (pick === undefined) break
      move = pick
    }
    engine.commit(move)
    engine.takeEvents()
  }

  return {
    hpMarginA: engine.hp[0] - engine.hp[1],
    winner: engine.result?.winner ?? null,
    aFirst: true,
    skillsA: skills[0],
    skillsB: skills[1],
    plies,
  }
}

const specA = makeSpecResolver(variantA)(character)
const specB = makeSpecResolver(variantB)(character)

let winsA = 0
let winsB = 0
let draws = 0
let hpSum = 0
let pliesSum = 0
const totalA: Record<string, number> = {}
const totalB: Record<string, number> = {}
/** 两边都赢/都输的组数：说明这条差异确实分出了胜负，而不是噪声。 */
let sweepA = 0
let sweepB = 0

const describe = (specs: readonly SkillSpec[]): string =>
  specs.map((s) => `${s.id}=${JSON.stringify({ cost: s.cost, amount: s.amount, duration: s.duration ?? 1, endsTurn: s.endsTurn ?? false })}`).join(' ')

if (!jsonOut) {
  console.log(`规则对撞：${character} [A=${variantA}] vs ${character} [B=${variantB}]`)
  console.log(`  A 技能：${describe(specA)}`)
  console.log(`  B 技能：${describe(specB)}`)
  console.log(`  A 政策：${policyText(policyA)}`)
  console.log(`  B 政策：${policyText(policyB)}`)
  console.log(
    `  ${pairs} 对 × 2 局（同种子、A/B 各先手一次）× 每手 ${budget}ms × 随机开局 ${randomOpenPlies} 手` +
      (shardCount > 1 ? ` × 分片 ${shardIndex}/${shardCount}` : '') +
      '\n',
  )
}

const started = Date.now()
for (let i = 0; i < pairs; i++) {
  // 分片：只跑属于本片的那些"对"（种子按 i 确定，与串行完全一致）
  if (shardCount > 1 && i % shardCount !== shardIndex) continue
  const seed = 1000 + i * 7919
  // 第一局：A 执先手
  const g1 = playDuel(seed, [specA, specB], [policyA, policyB])
  // 第二局：同一个种子，但 A/B 换边 → B 执先手（盘面与第一局相同）
  const g2 = playDuel(seed, [specB, specA], [policyB, policyA])

  const results: Array<{ winner: 0 | 1 | null; aIsP0: boolean; skillsA: Record<string, number>; skillsB: Record<string, number>; hpMarginA: number; plies: number }> = [
    { winner: g1.winner, aIsP0: true, skillsA: g1.skillsA, skillsB: g1.skillsB, hpMarginA: g1.hpMarginA, plies: g1.plies },
    { winner: g2.winner, aIsP0: false, skillsA: g2.skillsB, skillsB: g2.skillsA, hpMarginA: -g2.hpMarginA, plies: g2.plies },
  ]

  let pairA = 0
  let pairB = 0
  for (const r of results) {
    if (r.winner === null) draws += 1
    else if ((r.winner === 0) === r.aIsP0) { winsA += 1; pairA += 1 }
    else { winsB += 1; pairB += 1 }
    hpSum += r.hpMarginA
    pliesSum += r.plies
    for (const [k, v] of Object.entries(r.skillsA)) totalA[k] = (totalA[k] ?? 0) + v
    for (const [k, v] of Object.entries(r.skillsB)) totalB[k] = (totalB[k] ?? 0) + v
  }
  if (pairA === 2) sweepA += 1
  if (pairB === 2) sweepB += 1
}

const games = winsA + winsB + draws
const rateA = games === 0 ? 0 : (winsA + draws / 2) / games
/** 单样本胜率的标准误 → 95% 置信区间（±1.96σ）。 */
const se = Math.sqrt(Math.max(rateA * (1 - rateA), 1e-9) / Math.max(games, 1))
const ci = 1.96 * se
const sweepTotal = sweepA + sweepB

/** 汇总数据（`--json` 输出，供分片合并）。 */
const summary = {
  character,
  variantA,
  variantB,
  policyA: policyText(policyA),
  policyB: policyText(policyB),
  pairs,
  games,
  winsA,
  winsB,
  draws,
  sweepA,
  sweepB,
  hpSum,
  pliesSum,
  totalA,
  totalB,
  ci,
  rateA,
}

if (jsonOut) {
  process.stdout.write(JSON.stringify(summary))
} else {
  console.log(`  A 政策：${policyText(policyA)}`)
  console.log(`  B 政策：${policyText(policyB)}`)
  console.log('\n结果（A = 变体侧，B = 基准侧）')
  console.log(`  A 胜 ${winsA} · 平 ${draws} · 负 ${winsB}   →  A 胜率 ${(rateA * 100).toFixed(1)}%  (95% CI ±${(ci * 100).toFixed(1)})`)
  console.log(`  配对横扫：A 两局全胜 ${sweepA} 组 · B 两局全胜 ${sweepB} 组（共 ${sweepTotal + (pairs - sweepTotal)} 组）`)
  console.log(`  平均血量差（A−B）${(hpSum / Math.max(games, 1)).toFixed(2)} · 平均手数 ${(pliesSum / Math.max(games, 1)).toFixed(1)}`)
  console.log(`  A 技能使用：${JSON.stringify(totalA)}`)
  console.log(`  B 技能使用：${JSON.stringify(totalB)}`)
  console.log(`\n墙钟耗时：${((Date.now() - started) / 1000).toFixed(1)}s`)
  if (rateA - ci > 0.5) console.log(`判定：A（${variantA}）**显著更强**`)
  else if (rateA + ci < 0.5) console.log(`判定：A（${variantA}）**显著更弱**`)
  else console.log(`判定：差异不显著（CI 跨过 50%）—— 需要更多对局`)
}
