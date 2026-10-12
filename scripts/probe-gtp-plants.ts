/**
 * gtp 植物流向探针（bugv32）：AI 到底认领了几棵植物、消耗了几棵、被抢/被清了几棵。
 *
 * 只统计 gtp 侧，把「植物从哪来、到哪去」逐笔记清楚，回答：
 *   - gtp 平均持有 0.98 棵，是因为**不认领**还是**认领了立刻被技能烧掉**？
 *   - 无主植物（谁落子谁占）到底有多少次摆在 gtp 面前，gtp 落子时压上去过几次？
 *
 * 用法：NODES=15872 npx tsx scripts/probe-gtp-plants.ts [对手=deepseek] [局数=20] [每手ms=70]
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

interface Counters {
  // 认领：gtp 落子/防守落子时，落点上原本是无主植物 / 对手植物
  claimedNeutral: number
  claimedFoe: number
  // 落子那一刻，棋盘上无主植物的总棵数（衡量"机会有多少"）
  neutralOnBoardSamples: number[]
  // gtp 落点恰好压在植物上的次数（有主+无主都算）
  landedOnPlant: number
  // 技能消耗的植物（按 effect）
  spentBySkill: Record<string, number>
  // 被对手抢走（magicClaimed stolen 且受害方是 gtp）
  stolenByFoe: number
  // 被连珠/火焰清除（gtp 的植物消失）
  lostPlants: number
}

function empty(): Counters {
  return {
    claimedNeutral: 0,
    claimedFoe: 0,
    neutralOnBoardSamples: [],
    landedOnPlant: 0,
    spentBySkill: {},
    stolenByFoe: 0,
    lostPlants: 0,
  }
}

type AnyEvent = { type: string } & Record<string, unknown>

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

  const c = empty()
  // gtp 每步之前持有的植物数（用来对照"机会"）
  let plies = 0
  const ownedBefore = (): number => {
    let n = 0
    for (const p of engine.magic.values()) if (p.owner === gtpSeat) n += 1
    return n
  }
  const neutralCount = (): number => {
    let n = 0
    for (const p of engine.magic.values()) if (p.owner === null || p.owner === undefined) n += 1
    return n
  }

  // 全局事件：认领 / 被抢 / 被清，都从这里归因到 gtp。
  // 植物消失时 engine.magic 已经删掉，无法事后查归属，所以用「落点压过」的格子集合回捞：
  // gtp 压上过某格的植物（claimed），之后那格植物没了（magicRemoved）→ 记一次「gtp 的植物被清」。
  const gtpClaimedCells = new Set<number>()
  const drain = (events: readonly AnyEvent[], gtpJustMovedTo: number | null): void => {
    for (const e of events) {
      if (e.type === 'magicClaimed') {
        const player = e.player as PlayerIndex
        if (player === gtpSeat) {
          gtpClaimedCells.add(Number(e.cell))
          if (e.stolen) c.claimedFoe += 1
          else c.claimedNeutral += 1
        } else if (e.stolen) {
          c.stolenByFoe += 1
        }
      } else if (e.type === 'magicRemoved' || e.type === 'magicCleared') {
        const cells = (e.cells ?? []) as number[]
        for (const cell of cells) {
          if (gtpClaimedCells.has(cell)) {
            c.lostPlants += 1
            gtpClaimedCells.delete(cell)
          }
        }
      }
    }
  }

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
      const plantAt = engine.magic.get(dec.move)?.owner
      engine.defend(dec.move)
      if (defender === gtpSeat && plantAt !== undefined) c.landedOnPlant += 1
      engine.takeEvents()
      continue
    }

    const player = engine.current
    const isGtp = player === gtpSeat

    if (isGtp) {
      c.neutralOnBoardSamples.push(neutralCount())
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
      const owned = ownedBefore()
      for (const use of dec.skills ?? []) {
        const spec = engine.skills[player][use.slot]
        if (!spec) continue
        const cost = (use.cells ?? []).length
        if (cost > 0) c.spentBySkill[spec.effect] = (c.spentBySkill[spec.effect] ?? 0) + cost
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
    const plantAt = engine.magic.get(move)?.owner
    const ev = engine.commit(move) as AnyEvent[]
    if (isGtp && plantAt !== undefined) c.landedOnPlant += 1
    drain(ev, isGtp ? move : null)
    engine.takeEvents()
  }
  return c
}

function run(): void {
  const acc = empty()
  const merge = (a: Counters, b: Counters): void => {
    acc.claimedNeutral += b.claimedNeutral
    acc.claimedFoe += b.claimedFoe
    acc.landedOnPlant += b.landedOnPlant
    acc.stolenByFoe += b.stolenByFoe
    acc.lostPlants += b.lostPlants
    acc.neutralOnBoardSamples.push(...b.neutralOnBoardSamples)
    for (const [k, v] of Object.entries(b.spentBySkill)) acc.spentBySkill[k] = (acc.spentBySkill[k] ?? 0) + v
  }
  for (let i = 0; i < GAMES; i++) {
    const gtpSeat: PlayerIndex = i % 2 === 0 ? 0 : 1
    merge(acc, playGame(1000 + i * 7919, gtpSeat))
  }

  const avg = (xs: number[]): string =>
    xs.length === 0 ? '—' : (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)

  console.log(`\n===== gtp 植物流向 · vs ${FOE} · ${GAMES} 局 =====`)
  console.log(`认领：中立 ${acc.claimedNeutral} 棵 · 抢对手 ${acc.claimedFoe} 棵（${((acc.claimedNeutral + acc.claimedFoe) / GAMES).toFixed(2)}/局）`)
  console.log(`gtp 行动手棋盘上的无主植物：平均 ${avg(acc.neutralOnBoardSamples)} 棵/手`)
  console.log(`gtp 落点恰好压在植物上：${acc.landedOnPlant} 次（${(acc.landedOnPlant / GAMES).toFixed(2)}/局）`)
  console.log(`技能消耗植物：${JSON.stringify(acc.spentBySkill)}`)
  console.log(`被对手抢走：${acc.stolenByFoe} 棵（${(acc.stolenByFoe / GAMES).toFixed(2)}/局）`)
}

run()
