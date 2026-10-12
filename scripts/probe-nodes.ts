/**
 * 标定探针（bugv18）：量出"每手 70ms"下 AI 实际访问了多少节点，
 * 好把确定性预算 `nodeLimit` 设成与现有强度相当的量级。用完即删。
 *
 * 用法：pnpm exec tsx scripts/probe-nodes.ts [角色A] [角色B] [每手ms] [手数上限]
 */
import { decideMove, type AiDifficulty } from '../src/ai/baseline'
import { applyAiSkills, fallbackPlacement } from './harness'
import { skillsOfCharacter, type CharacterId } from '../src/core/characters'
import { GameEngine } from '../src/core/engine'
import { INITIAL_HP, other, type Board, type PlayerIndex } from '../src/core/types'
import { mulberry32 } from './variants'

const a = (process.argv[2] ?? 'deepseek') as CharacterId
const b = (process.argv[3] ?? 'gemini') as CharacterId
const budget = Number(process.argv[4] ?? 70)
const maxPlies = Number(process.argv[5] ?? 120)
const difficulty: AiDifficulty = 'expert'

const rng = mulberry32(0x9e3779b1)
const engine = new GameEngine({
  initialHp: INITIAL_HP,
  fixedFirstPlayer: 0,
  magic: { enabled: true },
  skills: [skillsOfCharacter(a), skillsOfCharacter(b)],
})
engine.takeEvents()

const magicCtx = () => ({
  plants: [...engine.magic.values()].map(
    (p) => [p.cell, p.owner] as [number, PlayerIndex | null],
  ),
  damagePerPlant: engine.magicConfig.damagePerPlant,
})
const skillCtx = () => ({
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

const nodesPerCall: number[] = []
const msPerCall: number[] = []
let plies = 0
while (!engine.isOver && plies < maxPlies) {
  plies += 1
  if (plies <= 8) {
    if (engine.awaitingDefense) {
      const e = engine.emptyCells()
      if (!e.length) break
      engine.defend(e[Math.floor(rng() * e.length)])
    } else {
      const legal = engine.legalMoves().filter((c) => !engine.flames.has(c))
      if (!legal.length) break
      engine.commit(legal[Math.floor(rng() * legal.length)])
    }
    engine.takeEvents()
    continue
  }
  if (engine.awaitingDefense) {
    const defender: PlayerIndex = other(engine.highlightOwner ?? 0)
    const d = decideMove({
      board: engine.board as Board,
      player: defender,
      selfHp: engine.hp[defender],
      opponentHp: engine.hp[other(defender)],
      mode: 'defend',
      highlightWeights: engine.highlights,
      difficulty,
      timeLimitMs: budget,
      magic: magicCtx(),
      skills: skillCtx(),
      attackBaseDamage: engine.attack?.baseDamage,
      attackPlants: engine.attack?.attackerPlants,
    })
    nodesPerCall.push(d.nodes)
    msPerCall.push(d.elapsedMs)
    if (d.move < 0 || engine.board[d.move] !== 0) throw new Error('非法防守落点')
    engine.defend(d.move)
    engine.takeEvents()
    continue
  }
  const player = engine.current
  const d = decideMove({
    board: engine.board as Board,
    player,
    selfHp: engine.hp[player],
    opponentHp: engine.hp[other(player)],
    mode: 'attack',
    difficulty,
    timeLimitMs: budget,
    magic: magicCtx(),
    skills: skillCtx(),
  })
  nodesPerCall.push(d.nodes)
  msPerCall.push(d.elapsedMs)
  const applied = applyAiSkills(engine, player, d.skills)
  if (applied.skipPlacement) continue
  let move = d.move
  if (move < 0 || !engine.canPlaceAt(move)) {
    const pick = fallbackPlacement(engine, player)
    if (pick === undefined) break
    move = pick
  }
  engine.commit(move)
  engine.takeEvents()
}

const sorted = [...nodesPerCall].sort((x, y) => x - y)
const med = sorted[Math.floor(sorted.length / 2)] ?? 0
const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0
const mean = nodesPerCall.reduce((s, n) => s + n, 0) / Math.max(1, nodesPerCall.length)
const msMean = msPerCall.reduce((s, n) => s + n, 0) / Math.max(1, msPerCall.length)
console.log(
  `每手 ${budget}ms 实测：调用 ${nodesPerCall.length} 次 | 节点 中位 ${med} 均值 ${Math.round(mean)} p90 ${p90} 最大 ${sorted[sorted.length - 1]}`,
)
console.log(`  平均耗时 ${msMean.toFixed(1)}ms/手`)
console.log(
  `  建议 nodeLimit（取中位数的 512 倍数）= ${Math.ceil(med / 512) * 512}`,
)
