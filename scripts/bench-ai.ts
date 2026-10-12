/**
 * A/B 强度基准：让两版 AI 在**真实 GameEngine** 上对下，统计胜负。
 *
 * 用法：
 *   pnpm exec tsx scripts/bench-ai.ts [局数] [每步预算ms] [新AI棋力] [旧AI棋力] [手数上限] [植物开关] [对手] [角色对]
 * 默认：20 局 / 200ms / expert vs expert / 400 手 / 植物开 / 对手 legacy / deepseek vs deepseek
 *
 * 对手可选：
 * - `legacy`（默认）：旧的启发式 AI；
 * - `new-blind`：同强度的新 AI，但**不喂植物**（假装看不见）—— 隔离验证"植物建模"值多少分；
 * - `new-no-skill`：同强度的新 AI，但**不喂技能**（假装没有技能）—— 隔离验证"技能建模"值多少分；
 * - `new-blank`：既不喂植物也不喂技能。
 */
import { decideMove as decideNew, type AiDifficulty, type AiMagicContext, type AiSkillContext } from '../src/ai/baseline'
import { applyAiSkills, fallbackPlacement } from './harness'
import { decideMove as decideLegacy } from './legacy-baseline'
import { skillsOfCharacter, type CharacterId } from '../src/core/characters'
import { GameEngine } from '../src/core/engine'
import { INITIAL_HP, other, type Board, type PlayerIndex } from '../src/core/types'

type Decider = typeof decideNew

interface Config {
  label: string
  decide: Decider
  difficulty: AiDifficulty
  /** 是否把"场上植物"喂给这个 AI（false = 假装看不见，用于隔离对照）。 */
  useMagic?: boolean
  /** 是否把"技能表与技能状态"喂给这个 AI（false = 假装没有技能）。 */
  useSkills?: boolean
}

interface GameStats {
  winner: number | null
  plies: number
  hp: [number, number]
  attacks: number
  damage: number
  skills: Record<string, number>
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function playGame(
  newFirst: boolean,
  budget: number,
  newConfig: Config,
  oldConfig: Config,
  maxPlies: number,
  magicOn: boolean,
  charIds: readonly [CharacterId, CharacterId],
  randomOpenPlies: number,
  seed: number,
): GameStats {
  const rng = mulberry32(seed)
  const engine = new GameEngine({
    initialHp: INITIAL_HP,
    fixedFirstPlayer: (newFirst ? 0 : 1) as PlayerIndex,
    magic: { enabled: magicOn },
    skills: [skillsOfCharacter(charIds[0]), skillsOfCharacter(charIds[1])],
  })
  engine.takeEvents()
  const sides: [Config, Config] = newFirst ? [newConfig, oldConfig] : [oldConfig, newConfig]
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

  const skills: Record<string, number> = {}
  let plies = 0
  let attacks = 0
  const hpStart: [number, number] = [engine.hp[0], engine.hp[1]]
  while (!engine.isOver && plies < maxPlies) {
    plies += 1

    // 随机开局：前几手双方随机落子，打破"两边都是确定性 AI → 每局完全一样"的退化
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
      attacks += 1
      const defender: PlayerIndex = other(engine.highlightOwner ?? 0)
      const cfg = sides[defender]
      const decision = cfg.decide({
        board: engine.board as Board,
        player: defender,
        selfHp: engine.hp[defender],
        opponentHp: engine.hp[other(defender)],
        mode: 'defend',
        highlightWeights: engine.highlights,
        // bugv17 #4：与宿主一致 —— 攻击方的加伤锁定在宣告那一刻
        attackBaseDamage: engine.attack?.baseDamage,
        attackPlants: engine.attack?.attackerPlants,
        difficulty: cfg.difficulty,
        timeLimitMs: budget,
        ...(cfg.useMagic === false ? {} : { magic: magicCtx() }),
        // bugv13 #2：防守搜索也要看得到技能状态（护盾 / 增伤 / 无敌 / 烈焰 / 叠子）
        ...(cfg.useSkills === false ? {} : { skills: skillCtx() }),
      })
      if (decision.move < 0 || engine.board[decision.move] !== 0) throw new Error('防守方给出了非法落点')
      engine.defend(decision.move)
      engine.takeEvents()
      continue
    }

    const player = engine.current
    const cfg = sides[player]
    const decision = cfg.decide({
      board: engine.board as Board,
      player,
      selfHp: engine.hp[player],
      opponentHp: engine.hp[other(player)],
      mode: 'attack',
      difficulty: cfg.difficulty,
      timeLimitMs: budget,
      ...(cfg.useMagic === false ? {} : { magic: magicCtx() }),
      ...(cfg.useSkills === false ? {} : { skills: skillCtx() }),
    })

    // 技能"用完不交回合"：先按计划放技能，再落子
    const appliedSkills = applyAiSkills(engine, player, decision.skills)
    for (const used of appliedSkills.used) skills[used.effect] = (skills[used.effect] ?? 0) + 1
    // endsTurn / assault：用完这一手不再落子（bugv14 收敛到 harness.applyAiSkills）
    if (appliedSkills.skipPlacement) continue

    // 落点兜底：技能没放成 / 叠子机会消失时退回一个合法落点
    let move = decision.move
    if (move < 0 || !engine.canPlaceAt(move)) {
      const pick = fallbackPlacement(engine, player)
      if (pick === undefined) break
      move = pick
    }
    engine.commit(move)
    engine.takeEvents()
  }

  const damage = hpStart[0] - engine.hp[0] + (hpStart[1] - engine.hp[1])
  const winner = engine.result?.winner ?? null
  return { winner, plies, hp: [engine.hp[0], engine.hp[1]], attacks, damage, skills }
}

const games = Number(process.argv[2] ?? 20)
const budget = Number(process.argv[3] ?? 200)
const newDifficulty = (process.argv[4] ?? 'expert') as AiDifficulty
const oldDifficulty = (process.argv[5] ?? 'expert') as AiDifficulty
const maxPlies = Number(process.argv[6] ?? 400)
/** 是否开启魔力植物（默认开）。传 0 关闭，用于阶段一/阶段二对照。 */
const magicOn = (process.argv[7] ?? '1') !== '0'
const opponent = process.argv[8] ?? 'legacy'
const charPair = (process.argv[9] ?? 'deepseek,deepseek').split(',') as [CharacterId, CharacterId]
/** 开局前几手随机落子（打破确定性循环，让样本有意义）。 */
const randomOpenPlies = Number(process.argv[10] ?? 0)

const newConfig: Config = {
  label: `new/${newDifficulty}`,
  decide: decideNew,
  difficulty: newDifficulty,
  useMagic: true,
  useSkills: true,
}
const oldConfig: Config =
  opponent === 'new-blind'
    ? { label: `new-blind/${oldDifficulty}`, decide: decideNew, difficulty: oldDifficulty, useMagic: false, useSkills: true }
    : opponent === 'new-no-skill'
      ? { label: `new-no-skill/${oldDifficulty}`, decide: decideNew, difficulty: oldDifficulty, useMagic: true, useSkills: false }
      : opponent === 'new-blank'
        ? { label: `new-blank/${oldDifficulty}`, decide: decideNew, difficulty: oldDifficulty, useMagic: false, useSkills: false }
        : { label: `legacy/${oldDifficulty}`, decide: decideLegacy, difficulty: oldDifficulty }

let newWins = 0
let oldWins = 0
let draws = 0
const totalSkills: Record<string, number> = {}
const started = Date.now()

for (let i = 0; i < games; i++) {
  const newFirst = i % 2 === 0
  const result = playGame(newFirst, budget, newConfig, oldConfig, maxPlies, magicOn, charPair, randomOpenPlies, 0x51ed270b + i * 7919)
  for (const [effect, count] of Object.entries(result.skills)) {
    totalSkills[effect] = (totalSkills[effect] ?? 0) + count
  }
  if (result.winner === null) draws += 1
  else if (newFirst ? result.winner === 0 : result.winner === 1) newWins += 1
  else oldWins += 1
  console.log(
    `game ${String(i + 1).padStart(2)} ${newFirst ? 'new先手' : 'old先手'} -> ` +
      `${result.winner === null ? '平局' : (newFirst ? result.winner === 0 : result.winner === 1) ? 'new 胜' : 'old 胜'} ` +
      `hp=${result.hp[0]}:${result.hp[1]} plies=${result.plies} 攻击${result.attacks}次/总伤害${result.damage} ` +
      `技能${JSON.stringify(result.skills)}`,
  )
}

console.log(
  `\n${newConfig.label} vs ${oldConfig.label}（植物${magicOn ? '开' : '关'}，角色 ${charPair[0]} vs ${charPair[1]}）：` +
    `new 胜 ${newWins} / 平 ${draws} / 负 ${oldWins}` +
    `（共 ${games} 局，${((Date.now() - started) / 1000).toFixed(1)}s，每步 ${budget}ms）`,
)
console.log(`全场技能使用：${JSON.stringify(totalSkills)}`)
