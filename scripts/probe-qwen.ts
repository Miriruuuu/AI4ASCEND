/**
 * Qwen 技能"空放率"探针（bugv34m 诊断）。
 *
 * ⛔ 只**观察行为**，不改任何规则、不改 AI。
 *
 * 回答一个问题：Qwen 的技能被**放得很多**（本地部署 ~9.6 次/局、小千问 ~3.8 次/局），
 * 但胜率仍显著低于 deepseek —— 到底是"技能本来就弱"，还是"AI 放得不是时候"？
 *
 * 逐次释放把结果分成三档（口径全部来自**引擎真实事件**，不猜）：
 *   · 本地部署（localDeploy）1 费：
 *       attack  = 这一手成了连珠 → 实打实 +1 伤害（有效）
 *       plant   = 没成线但落点长出一棵植物（把植物挪到了自己的新子上，基本中性偏正）
 *       waste   = 没成线、落点已有植物 ⇒ **白耗 1 棵植物**（负）
 *   · 小千问（redeploy）1~2 费：
 *       real     = 真把棋子重新部署出去了（placed ≥ 1）
 *       refunded = 没有任何可放位置 ⇒ 棋子 + 植物 + 冷却全部退回（**纯白放一个行动点**）
 *       discard  = 成线导致待部署作废（棋子真没了）——闸门应当拦掉，出现即为 bug
 *
 * 用法：`npx tsx scripts/probe-qwen.ts [对数=10] [每手ms=70] [node=8000] [随机开局手数=8]`
 */
import { applyAiSkills, fallbackPlacement } from './harness'
import {
  AI_POLICY,
  decideMove,
  debugRootSkillMoves,
  type AiMagicContext,
  type AiRequest,
  type AiSkillContext,
} from '../src/ai/baseline'
import { skillsOfCharacter } from '../src/core/characters'
import { GameEngine } from '../src/core/engine'
import { INITIAL_HP, other, type Board, type PlayerIndex } from '../src/core/types'
import { WINDOWS, WINDOW_COUNT } from '../src/ai/policy'
import { mulberry32 } from './variants'

const QWEN = skillsOfCharacter('qwen')
const DEEPSEEK = skillsOfCharacter('deepseek')

interface CastStats {
  gateOpen: number
  cast: number
  /** 落点成线 ⇒ 实打实 +1 伤害（用户口径的"应该放 ①"）。 */
  attack: number
  /** 落点长出一棵植物（消费 1 棵、长回 1 棵 ⇒ 数量持平但换了位置）。 */
  plant: number
  /** 其中落点在"下回合可直接成线"的窗口里 ⇒ **预置成功**（用户口径的"应该放 ②"）。 */
  prep: number
  /** 其中落点对将来那条线没用 ⇒ 净耗 0、收益近 0（**空挪**）。 */
  wash: number
  /** 落点本来就有植物 ⇒ `deployGrow` 跳过，**白耗 1 棵**（用户明确否掉的时机①）。 */
  waste: number
  /** 本地部署在"成线"场合实际加到的伤害总和（应为 cast 数一致的 1 点）。 */
  deployDamage: number
}

interface RedeployStats {
  gateOpen: number
  cast: number
  real: number
  refunded: number
  discard: number
  /** 真实重新部署出去的棋子总数。 */
  stonesMoved: number
  /** 其中落在"本来就有魔力植物"的空位上的颗数（bugv34n 的首要优先级）。 */
  onPlant: number
}

interface Tally {
  games: number
  winsAsQwen: number
  actions: number
  readyChances: number
  skillUses: number
  localDeploy: CastStats
  redeploy: RedeployStats
  /** 对手（deepseek）的闸门开启情况，用于对比"分支膨胀"。 */
  foeGateOpen: Record<string, number>
  foeActions: number
}

function emptyTally(): Tally {
  return {
    games: 0,
    winsAsQwen: 0,
    actions: 0,
    readyChances: 0,
    skillUses: 0,
    localDeploy: { gateOpen: 0, cast: 0, attack: 0, plant: 0, prep: 0, wash: 0, waste: 0, deployDamage: 0 },
    redeploy: { gateOpen: 0, cast: 0, real: 0, refunded: 0, discard: 0, stonesMoved: 0, onPlant: 0 },
    foeGateOpen: {},
    foeActions: 0,
  }
}

/**
 * 落点 `cell` 是否在一条「我方 3 子 + 1 空位 + 0 对手」的窗口里。
 *
 * 成立 ⇒ **下回合补第 4 颗就成线**，而落在 `cell` 上的那棵魔力植物正好在那条线上
 * ⇒ 下回合成线时吃到 +1 伤害。这就是用户说的"预置"成功。
 */
function inPrepWindow(board: Board, player: PlayerIndex, cell: number): boolean {
  const tMe = player + 1
  for (let w = 0; w < WINDOW_COUNT; w++) {
    const base = w << 2
    let here = false
    let mine = 0
    let foe = 0
    let empty = 0
    for (let k = 0; k < 4; k++) {
      const idx = WINDOWS[base + k]
      if (idx === cell) here = true
      const v = board[idx]
      if (v === tMe) mine += 1
      else if (v === 0) empty += 1
      else foe += 1
    }
    if (here && mine === 3 && foe === 0 && empty === 1) return true
  }
  return false
}

function playGame(
  qwenSeat: PlayerIndex,
  budget: number,
  nodeLimit: number,
  maxPlies: number,
  randomOpenPlies: number,
  seed: number,
  t: Tally,
): void {
  const rng = mulberry32(seed)
  const engine = new GameEngine({
    initialHp: INITIAL_HP,
    fixedFirstPlayer: qwenSeat,
    magic: { enabled: true },
    skills: [qwenSeat === 0 ? QWEN : DEEPSEEK, qwenSeat === 0 ? DEEPSEEK : QWEN],
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
    deploy: [engine.deploy[0], engine.deploy[1]],
    deployBonus: [engine.deployBonus[0], engine.deployBonus[1]],
    redeployPending: [engine.redeployPending[0].slice(), engine.redeployPending[1].slice()],
    flameOwner: [...engine.flameOwner.entries()] as Array<[number, number]>,
    immuneUntil: [engine.immuneUntil[0], engine.immuneUntil[1]],
    turnNo: engine.turnNo,
    flames: [...engine.flames.entries()],
    overlay: [...engine.overlay.entries()] as Array<[number, number]>,
    initialHp: INITIAL_HP,
  })

  let plies = 0
  while (!engine.isOver && plies < maxPlies) {
    plies += 1

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
      engine.defend(
        decideMove({
          board: engine.board as Board,
          player: defender,
          selfHp: engine.hp[defender],
          opponentHp: engine.hp[other(defender)],
          mode: 'defend',
          highlightWeights: engine.highlights,
          timeLimitMs: budget,
          nodeLimit: nodeLimit > 0 ? nodeLimit : undefined,
          magic: magicCtx(),
          skills: skillCtx(),
        }).move,
      )
      engine.takeEvents()
      continue
    }

    const player = engine.current
    const request: AiRequest = {
      board: engine.board as Board,
      player,
      selfHp: engine.hp[player],
      opponentHp: engine.hp[other(player)],
      mode: 'attack',
      timeLimitMs: budget,
      nodeLimit: nodeLimit > 0 ? nodeLimit : undefined,
      magic: magicCtx(),
      skills: skillCtx(),
    }
    const isQwen = player === qwenSeat
    // 「闸门可放」= AI 真正考虑过的技能着法（唯一暴露闸门的口子）
    const gate = debugRootSkillMoves(request)
    if (isQwen) t.actions += 1
    else t.foeActions += 1

    const decision = decideMove(request)
    const ready = engine.skillStates()[player].some((state) => state.ready)

    if (isQwen) {
      if (ready) t.readyChances += 1
      for (const m of gate) {
        if (m.effect === 'localDeploy') t.localDeploy.gateOpen += 1
        if (m.effect === 'redeploy') t.redeploy.gateOpen += 1
      }
    } else {
      for (const m of gate) t.foeGateOpen[m.effect] = (t.foeGateOpen[m.effect] ?? 0) + 1
    }

    const beforePlants = engine.magic.size
    const applied = applyAiSkills(engine, player, decision.skills)
    if (isQwen) {
      for (const used of applied.used) {
        t.skillUses += 1
        if (used.effect === 'localDeploy') t.localDeploy.cast += 1
        if (used.effect === 'redeploy') t.redeploy.cast += 1
      }
    }
    const afterSkillsPlants = engine.magic.size
    const castDeploy = isQwen && applied.used.some((u) => u.effect === 'localDeploy')
    const castRedeploy = isQwen && applied.used.some((u) => u.effect === 'redeploy')
    if (applied.skipPlacement) continue

    let move = decision.move
    if (move < 0 || !engine.canPlaceAt(move)) {
      const pick = fallbackPlacement(engine, player)
      if (pick === undefined) break
      move = pick
    }
    // 落子**之前**盘上的植物格（用于判断"小千问挪过去的棋子有没有吃到植物"）
    const plantsBefore = castRedeploy ? new Set(engine.magic.keys()) : null
    const events = engine.commit(move)
    engine.takeEvents()

    if (!isQwen) continue
    // ⚠️ 必须用 `awaitingDefense`（= phase）判断是否真的进入攻击阶段：
    // `engine.attack` 在对局里**第一击之后就恒为非 null**（只有 loadScenario 会清空），
    // 用它当闸门会让后面每一手都被误判成"攻击"（踩过）。
    const attacked = engine.awaitingDefense

    if (castDeploy) {
      if (attacked) {
        t.localDeploy.attack += 1
        t.localDeploy.deployDamage += engine.attack?.deployBonus ?? 0
      } else if (engine.magic.size > afterSkillsPlants) {
        // 落点长出了一棵（消费 1 棵、长回 1 棵 ⇒ 数量持平但换了位置）
        t.localDeploy.plant += 1
        if (inPrepWindow(engine.board as Board, qwenSeat, move)) t.localDeploy.prep += 1
        else t.localDeploy.wash += 1
      } else {
        t.localDeploy.waste += 1
      }
      void beforePlants
    }

    if (castRedeploy) {
      const ev = events.find((e) => e.type === 'redeployStones')
      if (!ev || ev.type !== 'redeployStones') {
        // 成线 → 待部署作废（闸门本应拦掉；出现即 bug）
        t.redeploy.discard += 1
      } else if (ev.placed.length === 0) {
        t.redeploy.refunded += 1
      } else {
        t.redeploy.real += 1
        t.redeploy.stonesMoved += ev.placed.length
        if (plantsBefore) {
          for (const cell of ev.placed) if (plantsBefore.has(cell)) t.redeploy.onPlant += 1
        }
      }
    }
  }

  t.games += 1
  if (engine.result?.winner === qwenSeat) t.winsAsQwen += 1
}

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const PAIRS = Number(argv[0] ?? 10)
const BUDGET = Number(argv[1] ?? 70)
const NODES = Number(argv[2] ?? 8000)
const OPEN = Number(argv[3] ?? 8)

// 政策开关（只改候选集，不改 AI 能看到的信息）：用环境变量做 A/B
if (process.env.POLICY_DEPLOY_ATTACK === '1') AI_POLICY.deployOnlyOnAttack = true
if (process.env.POLICY_DEPLOY_GATE === 'prep') AI_POLICY.deployGate = 'prep'
if (process.env.POLICY_DEPLOY_GATE === 'anytime') AI_POLICY.deployGate = 'anytime'
if (process.env.POLICY_REDEPLOY_PLANT === '1') AI_POLICY.redeployRequirePlantTarget = true
if (process.env.POLICY_REDEPLOY_PLANT === '0') AI_POLICY.redeployRequirePlantTarget = false
if (process.env.POLICY_NO_REDEPLOY === '1') AI_POLICY.redeployEnabled = false
if (process.env.POLICY_DEPLOY_SPARE === '1') AI_POLICY.deployPreferSpareFuel = true
const policyTag = [
  `deployGate=${AI_POLICY.deployGate}`,
  `deployOnlyOnAttack=${AI_POLICY.deployOnlyOnAttack}`,
  `deployPreferSpareFuel=${AI_POLICY.deployPreferSpareFuel}`,
  `redeployEnabled=${AI_POLICY.redeployEnabled}`,
  `redeployRequirePlantTarget=${AI_POLICY.redeployRequirePlantTarget}`,
].join(' · ')

const tally = emptyTally()
const started = Date.now()
for (let g = 0; g < PAIRS; g++) {
  const seed = 0x9e3779b1 + g * 2654435761
  playGame(0, BUDGET, NODES, 220, OPEN, seed, tally)
  playGame(1, BUDGET, NODES, 220, OPEN, seed, tally)
  const done = (g + 1) * 2
  process.stdout.write(
    `\r  跑 ${done}/${PAIRS * 2} 局  用时 ${((Date.now() - started) / 1000).toFixed(0)}s   `,
  )
}
console.log('')

const rate = (a: number, b: number): string => (b === 0 ? '—' : `${((a / b) * 100).toFixed(1)}%`)
const ld = tally.localDeploy
const rd = tally.redeploy

console.log('')
console.log('Qwen vs deepseek · 技能兑现诊断')
console.log('='.repeat(62))
console.log(`规模      : ${tally.games} 局（qwen 先后手各半）· 每手 ${NODES} 节点 · 随机开局 ${OPEN} 手`)
console.log(`政策      : ${policyTag}`)
console.log(`Qwen 胜率 : ${rate(tally.winsAsQwen, tally.games)}（${tally.winsAsQwen}/${tally.games}）`)
console.log('')
console.log('— 技能使用量 —')
console.log(
  `Qwen 行动点 : ${tally.actions}   有技能可用 : ${tally.readyChances} (${rate(
    tally.readyChances,
    tally.actions,
  )})   实际释放 : ${tally.skillUses} (转化 ${rate(tally.skillUses, tally.readyChances)})`,
)
console.log('')
console.log('— ① 本地部署 localDeploy（1 费） —')
console.log(`  闸门可放 ${ld.gateOpen} 次 → 实放 ${ld.cast} 次（${rate(ld.cast, ld.gateOpen)}）`)
console.log(
  `  ✅ 成线加伤 ${ld.attack} 次（累计 +${ld.deployDamage} 伤）｜ ✅ 预置成功 ${ld.prep} 次` +
    '（落点落在"下回合可直接成线"的窗口里）',
)
console.log(`  ⚠️ 空挪 ${ld.wash} 次（植物换了位置、对将来那条线没用）｜ ❌ 白耗植物 ${ld.waste} 次`)
if (ld.cast > 0) {
  console.log(
    `  ⇒ 正收益占比 ${rate(ld.attack + ld.prep, ld.cast)}，**无意义或负收益 ${rate(
      ld.wash + ld.waste,
      ld.cast,
    )}**`,
  )
}
console.log('')
console.log('— ② 小千问 redeploy（1~2 费） —')
console.log(`  闸门可放 ${rd.gateOpen} 次 → 实放 ${rd.cast} 次（${rate(rd.cast, rd.gateOpen)}）`)
console.log(
  `  真部署 ${rd.real} 次（共挪走 ${rd.stonesMoved} 颗，${(rd.stonesMoved / Math.max(1, rd.real)).toFixed(
    2,
  )} 颗/次）｜ **全部退回 ${rd.refunded} 次**｜ 成线作废 ${rd.discard} 次`,
)
console.log(
  `  ⇒ 落点吃到无主植物：${rd.onPlant}/${rd.stonesMoved} 颗（${rate(rd.onPlant, rd.stonesMoved)}）` +
    '  ← bugv34n 的首要优先级',
)
if (rd.cast > 0) {
  console.log(`  ⇒ 真兑现 ${rate(rd.real, rd.cast)}，**纯白放 ${rate(rd.refunded + rd.discard, rd.cast)}**`)
}
console.log('')
console.log('— 分支膨胀对照（每行动点的"闸门可放技能数"）—')
const qwenSkillTotal = ld.gateOpen + rd.gateOpen
console.log(`  Qwen     : ${(qwenSkillTotal / Math.max(1, tally.actions)).toFixed(2)} 个/行动点`)
const foeTotal = Object.values(tally.foeGateOpen).reduce((a, b) => a + b, 0)
console.log(
  `  deepseek : ${(foeTotal / Math.max(1, tally.foeActions)).toFixed(2)} 个/行动点  ${JSON.stringify(
    tally.foeGateOpen,
  )}`,
)
