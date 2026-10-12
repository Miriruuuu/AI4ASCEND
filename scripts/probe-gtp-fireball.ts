/**
 * gtp「恶龙吐息」3 费档（碎子开线）瓶颈诊断（bugv32）。
 *
 * gtp 的胜负手是「3 费火球碎掉挡我成线的敌子 → 走自己的火成线」。但这个胜负手
 * 打不出来的原因可能有三层，探针把每层拆开量：
 *
 *   A. 火球冷却好时，手里有几棵植物（`owned` 分布）—— 是不是卡在"植物不够 3 棵"；
 *   B. 火球冷却好时，棋盘上有没有"挡我成线的敌子"（`fireballOpensLine` 的机会）；
 *   C. 有了机会（B 成立）且植物够 3 棵时，AI 到底有没有真的放 3 费档。
 *
 * 只统计 gtp 自己的行动手，分「火球冷却中 / 冷却好」两种状态看 owned 分布。
 * 用法：NODES=15872 npx tsx scripts/probe-gtp-fireball.ts [对手=deepseek] [局数=20] [每手ms=70]
 */
import { applyAiSkills, fallbackPlacement } from './harness'
import { decideMove, type AiMagicContext, type AiSkillContext } from '../src/ai/baseline'
import { GameEngine } from '../src/core/engine'
import { skillsOfCharacter, type CharacterId } from '../src/core/characters'
import { INITIAL_HP, other, type Board, type PlayerIndex } from '../src/core/types'
import { mulberry32 } from './variants'

const GTP: CharacterId = 'gtp'
const FOE: CharacterId = (process.argv[2] ?? 'deepseek') as CharacterId
const GAMES = Number(process.argv[3] ?? 20)
const BUDGET = Number(process.argv[4] ?? 70)
const NODES = Number(process.env.NODES ?? 0)
const MAX_PLIES = 220
const RANDOM_OPEN_PLIES = 8

const DIRS: Array<[number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
]

/** 火球 3 费档的"碎子开线"机会：棋盘上有没有"挡在我方成线窗口里的敌子"（3 己方 + 1 敌方）。 */
function hasBlocker(board: Board, player: PlayerIndex): boolean {
  const target = player + 1
  for (let cell = 0; cell < 81; cell++) {
    if (board[cell] !== other(player) + 1) continue
    const row = Math.floor(cell / 9)
    const col = cell % 9
    for (const [dr, dc] of DIRS) {
      for (let start = -3; start <= 0; start++) {
        let mine = 0
        let foeCell = -1
        let ok = true
        for (let k = 0; k < 4; k++) {
          const r = row + (start + k) * dr
          const c = col + (start + k) * dc
          if (r < 0 || r >= 9 || c < 0 || c >= 9) {
            ok = false
            break
          }
          const v = board[r * 9 + c]
          if (v === target) mine += 1
          else if (v !== 0) foeCell = r * 9 + c
        }
        if (ok && mine === 3 && foeCell === cell) return true
      }
    }
  }
  return false
}

/** 这一方有没有"落一子即成线"的空位。 */
function hasLineMove(board: Board, player: PlayerIndex): boolean {
  const tMe = player + 1
  for (let w = 0; w < 81; w++) {
    if (board[w] !== 0) continue
    const row = Math.floor(w / 9)
    const col = w % 9
    for (const [dr, dc] of DIRS) {
      for (let start = -3; start <= 0; start++) {
        let mine = 0
        let other_ = 0
        let empty = 0
        let emptyCell = -1
        let ok = true
        for (let k = 0; k < 4; k++) {
          const r = row + (start + k) * dr
          const c = col + (start + k) * dc
          if (r < 0 || r >= 9 || c < 0 || c >= 9) {
            ok = false
            break
          }
          const v = board[r * 9 + c]
          if (v === 0) {
            empty += 1
            emptyCell = r * 9 + c
          } else if (v === tMe) mine += 1
          else other_ += 1
        }
        if (ok && mine === 3 && other_ === 0 && empty === 1 && emptyCell === w) return true
      }
    }
  }
  return false
}

interface Counters {
  // 冷却好时的 owned 分布（0/1/2/3+ 棵）
  readyOwned: Record<string, number>
  readyHands: number
  // 冷却好且有开线机会（hasBlocker）时的 owned 分布
  oppOwned: Record<string, number>
  oppHands: number
  // 机会成立 + 植物够 3 时的次数，以及其中 AI 真的放 3 费档的次数
  oppReady: number
  oppFired: number
  // 冷却中（不可放）时的 owned 分布
  cdOwned: Record<string, number>
  cdHands: number
  // 实际释放
  fbCast: number
  fbTier3: number
  fbTier1: number
  fbFree: number
  // 手里植物总数（每次 gtp 行动手）
  ownedSamples: number[]
}

function emptyCounters(): Counters {
  return {
    readyOwned: {},
    readyHands: 0,
    oppOwned: {},
    oppHands: 0,
    oppReady: 0,
    oppFired: 0,
    cdOwned: {},
    cdHands: 0,
    fbCast: 0,
    fbTier3: 0,
    fbTier1: 0,
    fbFree: 0,
    ownedSamples: [],
  }
}

function ownedOf(engine: GameEngine, player: PlayerIndex): number {
  let n = 0
  for (const p of engine.magic.values()) if (p.owner === player) n += 1
  return n
}

function playGame(seed: number, gtpSeat: PlayerIndex): Counters {
  const rng = mulberry32(seed)
  const specs = [skillsOfCharacter(gtpSeat === 0 ? GTP : FOE), skillsOfCharacter(gtpSeat === 0 ? FOE : GTP)]
  const engine = new GameEngine({
    initialHp: INITIAL_HP,
    fixedFirstPlayer: 0,
    magic: { enabled: true },
    skills: [specs[0], specs[1]],
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
    flameOwner: [...engine.flameOwner.entries()] as Array<[number, number]>,
    immuneUntil: [engine.immuneUntil[0], engine.immuneUntil[1]],
    turnNo: engine.turnNo,
    flames: [...engine.flames.entries()],
    overlay: [...engine.overlay.entries()] as Array<[number, number]>,
    initialHp: INITIAL_HP,
  })

  const c = emptyCounters()
  const fireballSlot = specs[gtpSeat].findIndex((s) => s.effect === 'fireball')
  const vMax = specs[gtpSeat][fireballSlot].variableCost?.max ?? 3

  let plies = 0
  while (!engine.isOver && plies < MAX_PLIES) {
    plies += 1
    if (plies <= RANDOM_OPEN_PLIES) {
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
      const defender = other(engine.highlightOwner ?? 0)
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
    const isGtp = player === gtpSeat

    if (isGtp) {
      const owned = ownedOf(engine, player)
      c.ownedSamples.push(owned)
      const remaining = engine.skillStateFor(player, fireballSlot)?.ready
      const key = owned >= vMax ? `${vMax}+` : String(owned)
      if (remaining) {
        c.readyHands += 1
        c.readyOwned[key] = (c.readyOwned[key] ?? 0) + 1
        const opp = hasBlocker(engine.board as Board, player)
        if (opp) {
          c.oppHands += 1
          c.oppOwned[key] = (c.oppOwned[key] ?? 0) + 1
          if (owned >= vMax) c.oppReady += 1
        }
      } else {
        c.cdHands += 1
        c.cdOwned[key] = (c.cdOwned[key] ?? 0) + 1
      }
    }

    const dec = decideMove({
      board: engine.board as Board,
      player,
      selfHp: engine.hp[player],
      opponentHp: engine.hp[other(player)],
      mode: 'attack',
      difficulty: 'expert',
      timeLimitMs: BUDGET,
      nodeLimit: NODES,
      magic: magicCtx(),
      skills: skillCtx(),
    })

    if (isGtp) {
      const hadOpp = hasBlocker(engine.board as Board, player)
      const hadOwned = ownedOf(engine, player)
      for (const use of dec.skills ?? []) {
        const spec = engine.skills[player][use.slot]
        if (!spec || spec.effect !== 'fireball') continue
        c.fbCast += 1
        const cost = (use.cells ?? []).length
        const free = (engine.skillCasts[player][use.slot] ?? 0) === 0 && spec.freeFirst === true
        if (free) c.fbFree += 1
        else if (cost >= vMax) c.fbTier3 += 1
        else c.fbTier1 += 1
        if (hadOpp && hadOwned >= vMax) c.oppFired += 1
      }
    }

    const applied = applyAiSkills(engine, player, dec.skills)
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
    engine.commit(move)
    engine.takeEvents()
  }
  return c
}

function run(): void {
  const acc = emptyCounters()
  const merge = (a: Counters, b: Counters): void => {
    for (const k of Object.keys(b.readyOwned)) a.readyOwned[k] = (a.readyOwned[k] ?? 0) + b.readyOwned[k]
    for (const k of Object.keys(b.oppOwned)) a.oppOwned[k] = (a.oppOwned[k] ?? 0) + b.oppOwned[k]
    for (const k of Object.keys(b.cdOwned)) a.cdOwned[k] = (a.cdOwned[k] ?? 0) + b.cdOwned[k]
    a.readyHands += b.readyHands
    a.oppHands += b.oppHands
    a.oppReady += b.oppReady
    a.oppFired += b.oppFired
    a.cdHands += b.cdHands
    a.fbCast += b.fbCast
    a.fbTier3 += b.fbTier3
    a.fbTier1 += b.fbTier1
    a.fbFree += b.fbFree
    a.ownedSamples.push(...b.ownedSamples)
  }
  for (let i = 0; i < GAMES; i++) {
    const gtpSeat: PlayerIndex = i % 2 === 0 ? 0 : 1
    merge(acc, playGame(1000 + i * 7919, gtpSeat))
  }

  const vMax = skillsOfCharacter('gtp').find((s) => s.effect === 'fireball')?.variableCost?.max ?? 2
  const hist = (m: Record<string, number>): string =>
    ['0', '1', ...(vMax >= 3 ? ['2'] : []), `${vMax}+`].map((k) => `${k}棵×${m[k] ?? 0}`).join('  ')
  const pct = (n: number, d: number): string => (d === 0 ? '—' : `${((n / d) * 100).toFixed(0)}%`)
  const avgOwned =
    acc.ownedSamples.length === 0 ? '—' : (acc.ownedSamples.reduce((a, b) => a + b, 0) / acc.ownedSamples.length).toFixed(2)

  console.log(`\n===== gtp 火球 max 费档（碎子开线）瓶颈诊断 · vs ${FOE} · ${GAMES} 局 =====`)
  console.log(`gtp 每次行动手平均持有植物：${avgOwned} 棵`)
  console.log(`\nA. 火球【冷却好】时的植物持有分布（${acc.readyHands} 手）：`)
  console.log(`   ${hist(acc.readyOwned)}`)
  console.log(`B. 火球【冷却中】时的植物持有分布（${acc.cdHands} 手）：`)
  console.log(`   ${hist(acc.cdOwned)}`)
  console.log(`\nC. 火球冷却好 & 棋盘上有"挡我成线的敌子"（开线机会）时（${acc.oppHands} 手）：`)
  console.log(`   ${hist(acc.oppOwned)}`)
  console.log(`   其中植物够 ${vMax} 棵的机会手：${acc.oppReady} 次`)
  console.log(`   其中 AI 真的放了 max 费档：${acc.oppFired} 次（${pct(acc.oppFired, acc.oppReady)}）`)
  console.log(`\nD. 实际释放：火球共 ${acc.fbCast} 次 = 免费 ${acc.fbFree} / 1费 ${acc.fbTier1} / max费 ${acc.fbTier3}`)
  const readyShort = Object.entries(acc.readyOwned).reduce((a, [k, v]) => (k !== `${vMax}+` ? a + v : a), 0)
  console.log(`   冷却好但植物 <${vMax} 棵的占比：${pct(readyShort, acc.readyHands)}`)
}

run()
