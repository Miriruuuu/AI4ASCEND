/**
 * gtp 技能诊断（bugv18 #3）：量出 AI 到底会不会用「精密计算 + 恶龙吐息 + 走进自己的火」这套连招。
 *
 * 人类回放里这套连招是赢棋主轴（3 局全胜，每局走火 1~4 次）；这里统计 AI 的对应行为：
 *   - 火球释放次数 / 走火次数 / "踏上火焰后当场成线攻击"的次数
 *   - 火球点燃后，有几成回合真的踏进自己刚点的那片火
 *
 * 用法：pnpm exec tsx scripts/probe-gtp.ts [局数] [节点预算] [手数上限] [角色A] [角色B]
 */
import { decideMove, type AiDifficulty } from '../src/ai/baseline'
import { applyAiSkills, fallbackPlacement } from './harness'
import { skillsOfCharacter, type CharacterId } from '../src/core/characters'
import { GameEngine } from '../src/core/engine'
import { INITIAL_HP, other, type Board, type PlayerIndex } from '../src/core/types'
import { mulberry32 } from './variants'

const games = Number(process.argv[2] ?? 8)
const nodeLimit = Number(process.argv[3] ?? 15872)
const maxPlies = Number(process.argv[4] ?? 220)
const idA = (process.argv[5] ?? 'gtp') as CharacterId
const idB = (process.argv[6] ?? 'deepseek') as CharacterId
const difficulty: AiDifficulty = 'expert'

const stat = {
  fireball: 0,
  tempArmor: 0,
  walks: 0,
  walkIntoFresh: 0,
  attacksFromFlame: 0,
  attacks: 0,
  turnsWithFreshFlame: 0,
}
let gamesCount = 0

for (let g = 0; g < games; g++) {
  const rng = mulberry32(0x9e3779b1 + g * 2654435761)
  const engine = new GameEngine({
    initialHp: INITIAL_HP,
    fixedFirstPlayer: 0,
    magic: { enabled: true },
    skills: [skillsOfCharacter(idA), skillsOfCharacter(idB)],
  })
  engine.takeEvents()
  const magicCtx = () => ({
    plants: [...engine.magic.values()].map((p) => [p.cell, p.owner] as [number, PlayerIndex | null]),
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
  // 自己点出来的火焰格（用来判断"踏进刚点的火"）
  const myFlames = new Set<number>()
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
        nodeLimit,
        magic: magicCtx(),
        skills: skillCtx(),
        attackBaseDamage: engine.attack?.baseDamage,
        attackPlants: engine.attack?.attackerPlants,
      })
      if (d.move < 0 || engine.board[d.move] !== 0) break
      // ⚠️ 必须看**此刻**棋盘上的烈焰：`myFlames` 是"历史上曾经归我的格子"，
      // 火早就烧完了，那些格子后来被正常走一手会被误记成"走火"（修过）。
      const wasMyFlame = defender === 0 && engine.flames.has(d.move) && engine.flameOwner.get(d.move) === 0
      const ev = engine.defend(d.move)
      if (defender === 0 && wasMyFlame) {
        stat.walks += 1
        if (ev.some((e) => e.type === 'attackResolved')) stat.attacksFromFlame += 1
      }
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
      nodeLimit,
      magic: magicCtx(),
      skills: skillCtx(),
    })
    const applied = applyAiSkills(engine, player, d.skills)
    for (const used of applied.used) {
      if (player !== 0) continue
      if (used.effect === 'fireball') {
        stat.fireball += 1
        for (const f of engine.flameOwner.entries()) if (f[1] === 0) myFlames.add(f[0])
      }
      if (used.effect === 'tempArmor') stat.tempArmor += 1
    }
    if (applied.skipPlacement) continue
    // 记录"这一手之前，场上是否已有自己点的火"
    let liveFlames = 0
    for (const cell of engine.flames.keys()) if (engine.flameOwner.get(cell) === 0) liveFlames += 1
    const hadFresh = player === 0 && liveFlames > 0
    let move = d.move
    if (move < 0 || !engine.canPlaceAt(move)) {
      const pick = fallbackPlacement(engine, player)
      if (pick === undefined) break
      move = pick
    }
    const steppingOnFlame = player === 0 && engine.flames.has(move) && engine.flameOwner.get(move) === 0
    engine.commit(move)
    if (player === 0 && hadFresh) stat.turnsWithFreshFlame += 1
    if (steppingOnFlame) {
      stat.walks += 1
      if (engine.phase === 'awaitingDefense') stat.attacksFromFlame += 1
    }
    engine.takeEvents()
  }
  stat.attacks += 0
  gamesCount += 1
}

console.log(`gtp(${idA}) vs ${idB} · ${gamesCount} 局 · 每手 ${nodeLimit} 节点`)
console.log(`  火球释放      ${stat.fireball} 次  （${(stat.fireball / gamesCount).toFixed(2)}/局）`)
console.log(`  精密计算      ${stat.tempArmor} 次  （${(stat.tempArmor / gamesCount).toFixed(2)}/局）`)
console.log(`  走进自己的火  ${stat.walks} 次  （${(stat.walks / gamesCount).toFixed(2)}/局）`)
console.log(`  其中当场成线攻击 ${stat.attacksFromFlame} 次`)
console.log(`  已有自己火焰的回合数 ${stat.turnsWithFreshFlame}（用来对照"有机会却不走"）`)
