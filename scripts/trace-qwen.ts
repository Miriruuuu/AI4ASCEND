/**
 * Qwen 逐手行为追踪（bugv34o）：小样本对局**每一步**打点，逐条核对
 * 「用户口径的释放时机」到底有没有被真正执行 —— 这是比胜率更直接的一把尺子。
 *
 * 与 `trace-behavior.ts`（gtp 版）同一套思路：小样本 + 逐手打点 + 分组统计；
 * 区别是这里把 Qwen 两个技能的**每一手**落到"用户说的对不对"上：
 *
 *   ✅ 一技能·成线加伤   这一手成连珠 → 净 +1 伤害
 *   ✅ 一技能·预置       非攻击手，落点落在「我方 3 子 + 1 空位 + 0 对手」的窗口里
 *                        ⇒ 下回合补第 4 颗即成线，被换过来的植物正好在那条线上
 *   ⚠️ 一技能·空挪       非攻击手，落点对将来那条线没用（植物换了位置、收益近 0）
 *   ❌ 一技能·白耗       落点本来就有植物、又不成线（`deployGrow` 跳过 ⇒ 白扔 1 棵）
 *   ❌ 一技能·封堵手上放 用户明确否掉：植物长在孤立的封堵子上，将来用不上
 *   ✅/❌ 二技能         真部署的落点有没有吃到无主植物；有没有白放（全退回 / 成线作废）
 *
 * 另外统计"**该放却没放**"的机会：成线手 + 手里有闲置植物 + 技能已就绪，却没放一技能。
 *
 * 用法：
 *   pnpm exec tsx scripts/trace-qwen.ts [对手=deepseek] [局数=10] [每手ms=70]
 *   QUIET=1 NODES=8000 pnpm exec tsx scripts/trace-qwen.ts deepseek 10 70   # 只看汇总
 *   HP=8 …（血量上限）/ POLICY_* …（同 `probe-qwen.ts` 的环境变量）
 */
import { applyAiSkills, fallbackPlacement } from './harness'
import {
  AI_POLICY,
  decideMove,
  debugRootSkillMoves,
  type AiMagicContext,
  type AiSkillContext,
} from '../src/ai/baseline'
import { WINDOWS, WINDOW_COUNT } from '../src/ai/policy'
import { GameEngine, previewAttackPieces } from '../src/core/engine'
import { skillsOfCharacter, type CharacterId } from '../src/core/characters'
import { INITIAL_HP, other, type Board, type PlayerIndex } from '../src/core/types'
import { mulberry32 } from './variants'

// ── AI 政策（与 probe-qwen.ts 同一套环境变量）───────────────────────────────
if (process.env.POLICY_DEPLOY_GATE === 'prep') AI_POLICY.deployGate = 'prep'
if (process.env.POLICY_DEPLOY_GATE === 'anytime') AI_POLICY.deployGate = 'anytime'
if (process.env.POLICY_REDEPLOY_PLANT === '1') AI_POLICY.redeployRequirePlantTarget = true
if (process.env.POLICY_REDEPLOY_PLANT === '0') AI_POLICY.redeployRequirePlantTarget = false
if (process.env.POLICY_NO_REDEPLOY === '1') AI_POLICY.redeployEnabled = false

const FOE: CharacterId = (process.argv[2] ?? 'deepseek') as CharacterId
const GAMES = Number(process.argv[3] ?? 10)
const BUDGET = Number(process.argv[4] ?? 70)
const NODES = Number(process.env.NODES ?? 0)
const HP = Number(process.env.HP ?? INITIAL_HP)
const QUIET = process.env.QUIET === '1'
const MAX_PLIES = 220
const OPEN = 8

const QWEN = skillsOfCharacter('qwen')
const FOE_SPECS = skillsOfCharacter(FOE)

// ── 局面小工具（口径与 `src/ai/search.ts` 一致）──────────────────────────────
/** 落点是否在「我方 3 子 + 1 空位 + 0 对手」的窗口里，且 `cell` 就是那 3 子之一。 */
function onPrepLine(board: Board, player: PlayerIndex, cell: number): boolean {
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

/** 这一方手里有没有"落一子即成线"的空位。 */
function hasLineMove(board: Board, player: PlayerIndex): boolean {
  for (let cell = 0; cell < board.length; cell++) {
    if (board[cell] !== 0) continue
    if (previewAttackPieces(board, player, cell).length > 0) return true
  }
  return false
}

/** 己方植物格（升序，与引擎 `ownedPlantCells` 同口径）。 */
function ownedPlants(engine: GameEngine, player: PlayerIndex): number[] {
  const out: number[] = []
  for (const [cell, plant] of engine.magic) if (plant.owner === player) out.push(cell)
  out.sort((a, b) => a - b)
  return out
}

/** "用不上的"植物：不在任何「我方 ≥2 子且无对手子」的窗口里（与 `sparePlants` 同口径）。 */
function sparePlantsOf(board: Board, engine: GameEngine, player: PlayerIndex): number[] {
  const tMe = player + 1
  const out: number[] = []
  for (const cell of ownedPlants(engine, player)) {
    let useful = false
    for (let w = 0; w < WINDOW_COUNT && !useful; w++) {
      const base = w << 2
      let here = false
      let mine = 0
      let theirs = 0
      for (let k = 0; k < 4; k++) {
        const idx = WINDOWS[base + k]
        if (idx === cell) here = true
        const v = board[idx]
        if (v === tMe) mine += 1
        else if (v !== 0) theirs += 1
      }
      if (here && mine >= 2 && theirs === 0) useful = true
    }
    if (!useful) out.push(cell)
  }
  return out
}

// ── 统计桶 ────────────────────────────────────────────────────────────────
interface Stats {
  games: number
  wins: number
  pliesSum: number
  qwenMoves: number
  // 一技能
  deployCast: number
  deployAttack: number
  deployPrep: number
  deployWash: number
  deployWaste: number
  deployBlockOnly: number
  deployMissed: number // 成线手 + 有闲置植物 + 就绪却没放
  deployReadyChances: number
  missedDetail: string[]
  // 二技能
  redeployCast: number
  redeployReal: number
  redeployStones: number
  redeployStonesOnPlant: number
  redeployRefunded: number
  redeployDiscard: number
  // 逐手明细（打印用）
  log: string[]
  violations: string[]
}

function emptyStats(): Stats {
  return {
    games: 0,
    wins: 0,
    pliesSum: 0,
    qwenMoves: 0,
    deployCast: 0,
    deployAttack: 0,
    deployPrep: 0,
    deployWash: 0,
    deployWaste: 0,
    deployBlockOnly: 0,
    deployMissed: 0,
    deployReadyChances: 0,
    missedDetail: [],
    redeployCast: 0,
    redeployReal: 0,
    redeployStones: 0,
    redeployStonesOnPlant: 0,
    redeployRefunded: 0,
    redeployDiscard: 0,
    log: [],
    violations: [],
  }
}

const cellName = (cell: number): string => `r${Math.floor(cell / 9)}c${cell % 9}`

function playGame(seed: number, qwenSeat: PlayerIndex, st: Stats, gameNo: number): void {
  const rng = mulberry32(seed)
  const specs = [qwenSeat === 0 ? QWEN : FOE_SPECS, qwenSeat === 0 ? FOE_SPECS : QWEN]
  const engine = new GameEngine({
    initialHp: HP,
    fixedFirstPlayer: 0,
    magic: { enabled: true },
    skills: [specs[0], specs[1]],
    night: { enabled: false },
  })
  engine.takeEvents()

  const magicCtx = (): AiMagicContext => ({
    plants: [...engine.magic.values()].map((p) => [p.cell, p.owner] as [number, PlayerIndex | null]),
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
    initialHp: HP,
  })

  let plies = 0
  let lastHp = `${engine.hp[0]}:${engine.hp[1]}`
  while (!engine.isOver && plies < MAX_PLIES) {
    plies += 1

    if (plies <= OPEN) {
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

    // 防守手：Qwen 只用技能的话这里不落子（技能不消耗回合、也不参与防守），直接由 AI 选点
    if (engine.awaitingDefense) {
      const defender: PlayerIndex = other(engine.highlightOwner ?? 0)
      const dec = decideMove({
        board: engine.board as Board,
        player: defender,
        selfHp: engine.hp[defender],
        opponentHp: engine.hp[other(defender)],
        mode: 'defend',
        highlightWeights: engine.highlights,
        attackBaseDamage: engine.attack?.baseDamage,
        attackPlants: engine.attack?.attackerPlants,
        difficulty: 'expert',
        timeLimitMs: BUDGET,
        nodeLimit: NODES,
        magic: magicCtx(),
        skills: skillCtx(),
      })
      engine.defend(dec.move)
      engine.takeEvents()
      continue
    }

    const player = engine.current
    const isQwen = player === qwenSeat
    const boardBefore = engine.board as Board
    const plantsBefore = new Set(engine.magic.keys())

    // 决策前的局面事实（用于核对"该放却没放"）
    const mineAttack = hasLineMove(boardBefore, player)
    const spareBefore = isQwen ? sparePlantsOf(boardBefore, engine, player) : []
    const ownedBefore = isQwen ? ownedPlants(engine, player) : []
    const selfHpBefore = engine.hp[player]
    const foeHpBefore = engine.hp[other(player)]
    const deploySlot = QWEN.findIndex((s) => s.effect === 'localDeploy')
    const deployReady =
      deploySlot >= 0 && engine.skillReadyAt[player][deploySlot] <= engine.actionsTaken[player]

    const dec = decideMove({
      board: boardBefore,
      player,
      selfHp: selfHpBefore,
      opponentHp: foeHpBefore,
      mode: 'attack',
      difficulty: 'expert',
      timeLimitMs: BUDGET,
      nodeLimit: NODES,
      magic: magicCtx(),
      skills: skillCtx(),
    })

    if (isQwen) st.qwenMoves += 1

    const applied = applyAiSkills(engine, player, dec.skills)
    const usedEffects = applied.used.map((u) => u.effect)
    const castDeploy = isQwen && usedEffects.includes('localDeploy')
    const castRedeploy = isQwen && usedEffects.includes('redeploy')
    // ⚠️ 检测"落点到底有没有长出新植物"的基准必须取**技能结算之后**的数量：
    // 本地部署自己会先消耗 1 棵，用技能前的数量比会把"消耗 1 + 长回 1"误判成白耗（踩过）。
    const afterSkillsPlants = engine.magic.size
    if (castDeploy) st.deployCast += 1
    if (castRedeploy) st.redeployCast += 1
    if (isQwen && deployReady) st.deployReadyChances += 1

    if (applied.skipPlacement) {
      engine.takeEvents()
      continue
    }

    let move = dec.move
    if (move < 0 || !engine.canPlaceAt(move)) {
      const pick = fallbackPlacement(engine, player)
      if (pick === undefined) break
      move = pick
    }
    const willLine = previewAttackPieces(boardBefore, player, move).length > 0
    const blocksFoe = previewAttackPieces(boardBefore, other(player), move).length > 0
    const events = engine.commit(move)
    engine.takeEvents()

    if (!isQwen) continue

    const tag: string[] = []
    if (usedEffects.length > 0) tag.push(`技能[${usedEffects.join('+')}]`)

    if (castDeploy) {
      if (willLine) {
        st.deployAttack += 1
        tag.push(`一技能:成线加伤(+${engine.attack?.deployBonus ?? 0}伤)`)
      } else if (engine.magic.size > afterSkillsPlants && engine.magic.has(move)) {
        if (onPrepLine(engine.board as Board, player, move)) {
          st.deployPrep += 1
          tag.push('一技能:预置✅')
        } else {
          st.deployWash += 1
          tag.push('一技能:空挪⚠️')
          st.violations.push(
            `G${gameNo} #${plies} 一技能空挪：落子 ${cellName(move)} 既不成线、也不在"下回合可成线"的窗口里`,
          )
        }
      } else {
        st.deployWaste += 1
        tag.push('一技能:白耗❌')
        st.violations.push(
          `G${gameNo} #${plies} 一技能白耗：落子 ${cellName(move)} 本来就有植物且不成线 ⇒ 白扔 1 棵`,
        )
      }
      // 封堵手：这一手是挡对手的成线点（用户明确否掉"为封堵而放一技能"）
      if (blocksFoe && !willLine && !onPrepLine(engine.board as Board, player, move)) {
        st.deployBlockOnly += 1
        tag.push('一技能:封堵手❌')
        st.violations.push(
          `G${gameNo} #${plies} 一技能在封堵手释放：落子 ${cellName(move)} 是挡对手的成线点，自己的植物长在孤立的封堵子上`,
        )
      }
    } else if (isQwen && mineAttack && willLine && spareBefore.length >= 1 && deployReady) {
      // 该放却没放：**这一手真的成了连珠**、手里有闲置植物当燃料、技能也好了
      // （要求 `willLine`，否则"盘上存在成线点但 AI 选择去封堵/发育"会被误记）
      st.deployMissed += 1
      tag.push('一技能:未放（成线手+有闲植物+就绪）❓')
      // 诊断：闸门到底有没有把 localDeploy 交给搜索？
      const offered = debugRootSkillMoves({
        board: boardBefore,
        player,
        selfHp: selfHpBefore,
        opponentHp: foeHpBefore,
        mode: 'attack',
        difficulty: 'expert',
        timeLimitMs: BUDGET,
        nodeLimit: NODES,
        magic: magicCtx(),
        skills: skillCtx(),
      }).some((m) => m.effect === 'localDeploy')
      st.missedDetail.push(
        `G${gameNo} #${plies} 落子 ${cellName(move)}（成线✓）· 闲置植物 ${spareBefore.length} 棵 ` +
          `· localDeploy ${offered ? '**已进候选但搜索没选**' : '**没进候选（闸门拦掉）**'}`,
      )
    }

    if (castRedeploy) {
      const ev = events.find((e) => e.type === 'redeployStones')
      if (!ev || ev.type !== 'redeployStones') {
        st.redeployDiscard += 1
        tag.push('二技能:成线作废❌')
        st.violations.push(`G${gameNo} #${plies} 二技能成线作废：待部署的棋子直接没了（用户明确否掉）`)
      } else if (ev.placed.length === 0) {
        st.redeployRefunded += 1
        tag.push('二技能:全退回⚠️')
        st.violations.push(`G${gameNo} #${plies} 二技能全退回：没有任何可放位置 ⇒ 白放一个行动点`)
      } else {
        st.redeployReal += 1
        st.redeployStones += ev.placed.length
        let onPlant = 0
        for (const cell of ev.placed) if (plantsBefore.has(cell)) onPlant += 1
        st.redeployStonesOnPlant += onPlant
        tag.push(`二技能:重部署 ${ev.placed.length} 颗(吃植物 ${onPlant})`)
        if (onPlant < ev.placed.length) {
          st.violations.push(
            `G${gameNo} #${plies} 二技能有 ${ev.placed.length - onPlant} 颗落在没有植物的格子上（应优先吃无主植物）`,
          )
        }
      }
    }

    if (tag.length === 0) tag.push('普通落子')

    st.log.push(
      `  #${String(plies).padStart(3)} P${player} ${isQwen ? 'Qwen' : FOE.padEnd(4)} ` +
        `hp${lastHp}→${engine.hp[0]}:${engine.hp[1]} ` +
        `${cellName(move).padEnd(6)} ${willLine ? '成线✓' : '成线✗'} ` +
        `我植物${ownedBefore.length} 闲置${spareBefore.length} 场上${engine.magic.size} | ${tag.join(' ')}`,
    )
    lastHp = `${engine.hp[0]}:${engine.hp[1]}`
  }

  st.games += 1
  st.pliesSum += plies
  if (engine.result?.winner === qwenSeat) st.wins += 1
  if (!QUIET) {
    st.log.push(
      `  —— 第 ${gameNo} 局结束：${engine.result?.winner === qwenSeat ? 'Qwen 胜' : engine.result?.winner === null ? '平' : 'Qwen 负'}` +
        `（${plies} 手，终局 hp ${engine.hp[0]}:${engine.hp[1]}）`,
    )
    st.log.push('')
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const st = emptyStats()
const started = Date.now()
for (let i = 0; i < GAMES; i++) {
  const qwenSeat: PlayerIndex = i % 2 === 0 ? 0 : 1
  playGame(1000 + i * 7919, qwenSeat, st, i + 1)
}

const pct = (n: number, d: number): string => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`)

console.log('')
console.log('Qwen 逐手行为追踪')
console.log('='.repeat(72))
console.log(
  `配置    : 对手 ${FOE} · ${GAMES} 局（Qwen 先/后手各半）· 血量上限 ${HP} · ` +
    `${NODES > 0 ? `确定性 ${NODES} 节点/手` : `时间预算 ${BUDGET}ms（结果会抖动）`} · 随机开局 ${OPEN} 手`,
)
console.log(
  `政策    : deployGate=${AI_POLICY.deployGate} · redeployRequirePlantTarget=${AI_POLICY.redeployRequirePlantTarget}` +
    ` · redeployEnabled=${AI_POLICY.redeployEnabled}`,
)
console.log(
  `Qwen 胜率: ${pct(st.wins, st.games)}（${st.wins}/${st.games}）· 平均 ${(st.pliesSum / Math.max(1, st.games)).toFixed(1)} 手 · ` +
    `Qwen 行动点 ${st.qwenMoves}`,
)

console.log('')
console.log('— ① 一技能「本地部署」逐条核对 —')
console.log(
  `  成线加伤 ✅ ${st.deployAttack} ｜ 预置 ✅ ${st.deployPrep} ｜ 空挪 ⚠️ ${st.deployWash} ｜ 白耗 ❌ ${st.deployWaste} ｜ 封堵手 ❌ ${st.deployBlockOnly}`,
)
console.log(`  合计释放 ${st.deployCast} 次（技能就绪的行动点 ${st.deployReadyChances} 个）`)
console.log(
  `  ⇒ "符合预期（成线加伤 + 预置）"占 ${pct(st.deployAttack + st.deployPrep, st.deployCast)}，` +
    `"无意义/负收益"占 ${pct(st.deployWash + st.deployWaste + st.deployBlockOnly, st.deployCast)}`,
)
console.log(`  ❓ 该放却没放（成线手 + 有闲置植物 + 技能就绪）：${st.deployMissed} 次`)
for (const d of st.missedDetail) console.log(`     · ${d}`)

console.log('')
console.log('— ② 二技能「小千问」逐条核对 —')
console.log(
  `  真部署 ${st.redeployReal} 次（共挪 ${st.redeployStones} 颗）｜ 全退回 ⚠️ ${st.redeployRefunded} ｜ 成线作废 ❌ ${st.redeployDiscard}`,
)
console.log(
  `  ⇒ 落点吃到无主植物 ${st.redeployStonesOnPlant}/${st.redeployStones} 颗 = ${pct(
    st.redeployStonesOnPlant,
    st.redeployStones,
  )}（用户口径：应优先吃无主植物）`,
)
console.log(
  `  ⇒ 释放 ${st.redeployCast} 次中，真兑现 ${pct(st.redeployReal, st.redeployCast)}，` +
    `白放（全退回 + 成线作废）${pct(st.redeployRefunded + st.redeployDiscard, st.redeployCast)}`,
)

console.log('')
if (st.violations.length === 0) {
  console.log('✅ 没有发现违反用户口径的释放（逐手明细见上）。')
} else {
  console.log(`⚠️ 发现 ${st.violations.length} 处不符合预期口径的释放：`)
  for (const v of st.violations.slice(0, 40)) console.log(`   · ${v}`)
  if (st.violations.length > 40) console.log(`   …… 其余 ${st.violations.length - 40} 条从略`)
}

if (!QUIET) {
  console.log('')
  console.log('— 逐手明细（Qwen 的每一手）—')
  for (const line of st.log) console.log(line)
}

console.log('')
console.log(`墙钟 ${((Date.now() - started) / 1000).toFixed(1)}s`)
