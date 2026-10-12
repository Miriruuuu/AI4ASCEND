/**
 * 阶段三正确性校验：把 AI 迷你引擎的「角色技能」逻辑与真实 `GameEngine` 逐步对拍。
 *
 * 随机角色 + 随机释放技能（含恶龙吐息的目标点、毒鸡蛋的叠子、杀鲸霸拳的连下两颗），
 * 每一步都把迷你引擎的状态转移与引擎逐字段比对：
 *
 *   board / hp / 护盾 / 连击 / 行动次数 / 冷却 / 释放次数 / 增伤 / 叠子旗标 / 双子星 /
 *   无敌 / 回合序号 / 烈焰 / 叠子 / 场上植物 / 该谁走 / 是否在防守阶段
 *
 * ⚠️ 与阶段二一样：这一步**新长出来的**植物 AI 本来就不该知道（不预测生长），
 * 比对时按 `magicGrown` 事件排除。
 *
 * 跑法：`pnpm exec tsx scripts/verify-ai-skills.ts [局数]`
 */
import { debugSimulate, type AiMagicContext, type AiSkillContext } from '../src/ai/baseline'
import { CHARACTER_SPECS } from '../src/core/characters'
import { GameEngine } from '../src/core/engine'
import { INITIAL_HP, other, type PlayerIndex } from '../src/core/types'
import type { GameEvent } from '../src/core/types'

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

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function samePairs(a: ReadonlyArray<readonly [number, number]>, b: ReadonlyArray<readonly [number, number]>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false
  return true
}

type PlantList = Array<[number, PlayerIndex | null]>

function plantsOf(engine: GameEngine): PlantList {
  return [...engine.magic.values()]
    .map((p) => [p.cell, p.owner] as [number, PlayerIndex | null])
    .sort((a, b) => a[0] - b[0])
}

function samePlants(a: PlantList, b: PlantList): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false
  }
  return true
}

/**
 * 这一步由**自然生长**新种下的格子（AI 先生不知道，比对时排除）。
 *
 * ⚠️ bugv14：「播种」种下的植物**不能**排除 —— 那是技能效果的一部分，
 * 迷你引擎会（也必须）一起模拟出来；把它排除掉反而会误报不一致。
 * ⚠️ bugv34m：同理，「本地部署」（`deploy`）与「小千问」退还的（`redeploy`）也要算进来。
 */
function grownCellsFrom(events: readonly GameEvent[]): Set<number> {
  const cells = new Set<number>()
  for (const event of events) {
    if (event.type !== 'magicGrown') continue
    // 只排除真正的"自然生成"（`nature`）与天气落下的（`weather`）—— 那两类迷你引擎不模拟
    if (event.source !== undefined && event.source !== 'nature' && event.source !== 'weather') continue
    for (const plant of event.plants) cells.add(plant.cell)
  }
  return cells
}

function magicCtxOf(engine: GameEngine): AiMagicContext {
  return {
    plants: plantsOf(engine),
    damagePerPlant: engine.magicConfig.damagePerPlant,
  }
}

function skillCtxOf(engine: GameEngine): AiSkillContext {
  return {
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
    noPlantBonus: [engine.noPlantBonus[0], engine.noPlantBonus[1]],
    // bugv34m：Qwen 的两个技能状态（少了这几项迷你引擎会算错，用例必红）
    deploy: [engine.deploy[0], engine.deploy[1]],
    deployBonus: [engine.deployBonus[0], engine.deployBonus[1]],
    redeployPending: [engine.redeployPending[0].slice(), engine.redeployPending[1].slice()],
    flameOwner: [...engine.flameOwner.entries()] as Array<[number, number]>,
    immuneUntil: [engine.immuneUntil[0], engine.immuneUntil[1]],
    turnNo: engine.turnNo,
    flames: [...engine.flames.entries()],
    overlay: [...engine.overlay.entries()] as Array<[number, number]>,
    initialHp: INITIAL_HP,
  }
}

interface Mismatch {
  game: number
  step: number
  kind: string
  detail: string
}

const mismatches: Mismatch[] = []
let steps = 0
let skillUses = 0
let attacks = 0
let defenses = 0
let shatters = 0
let stacks = 0
let flames = 0
let byEffect: Record<string, number> = {}

function check(game: number, step: number, kind: string, ok: boolean, detail: string): void {
  if (ok) return
  if (mismatches.length < 20) mismatches.push({ game, step, kind, detail })
}

const games = Number(process.argv[2] ?? 250)

for (let game = 0; game < games; game++) {
  const rng = mulberry32(0x2f3a91c7 + game * 6151)
  const c0 = CHARACTER_SPECS[game % CHARACTER_SPECS.length]
  const c1 = CHARACTER_SPECS[(game >> 2) % CHARACTER_SPECS.length]
  const engine = new GameEngine({
    initialHp: INITIAL_HP,
    fixedFirstPlayer: (game % 2) as PlayerIndex,
    // 植物给得很足（每步都长、一次长 4 棵）：这样 cost 3 的技能（杀鲸霸拳 / 毒鸡蛋 /
    // 双子星）也能频繁放出来，昂贵的技能路径才真正被验到。
    magic: { enabled: true, requireLine: false, cooldownTurns: 1, baseCount: 4, growthStep: 1, maxCount: 8 },
    skills: [c0.skills, c1.skills],
    night: { enabled: false },
  })
  engine.takeEvents()

  let step = 0
  while (!engine.isOver && step < 500) {
    step += 1
    steps += 1

    const boardBefore = [...engine.board]
    const hpBefore: [number, number] = [engine.hp[0], engine.hp[1]]
    const magic = magicCtxOf(engine)
    const skills = skillCtxOf(engine)

    let phase: string
    let sim: ReturnType<typeof debugSimulate>
    let events: GameEvent[] = []

    if (engine.awaitingDefense) {
      const attacker = engine.highlightOwner ?? 0
      const defender: PlayerIndex = other(attacker)
      const empties = engine.emptyCells()
      if (empties.length === 0) break
      const move = empties[Math.floor(rng() * empties.length)]
      sim = debugSimulate(
        boardBefore,
        hpBefore,
        defender,
        'defend',
        move,
        new Map(engine.highlights),
        magic,
        skills,
        undefined,
        undefined,
        // bugv14：把引擎真实的攻击上下文一起传进去 —— 高光格表达不了
        // "攻击值 = 消耗植物数"（最直接、最不绕弯子）与「深度思考」的加成。
        {
          baseDamage: engine.attack?.baseDamage,
          strikeBonus: engine.attack?.strikeBonus,
          strikeExtra: engine.attack?.strikeExtra,
          // bugv30：「力大砖飞」的破盾（高光格体现不出来）
          breakShield: engine.attackBreakShield,
          // bugv17 #4：攻击方植物加伤在宣告攻击时就锁定了
          attackerPlants: engine.attack?.attackerPlants,
        },
      )
      events = engine.defend(move)
      phase = 'defend'
      defenses += 1
    } else {
      const player = engine.current

      // ① 有 60% 概率先放一个可用技能（优先放"覆盖得少"的技能，保证每种都被验到）
      const states = engine.skillStates()[player]
        .filter((s) => s.ready)
        .sort((a, b) => (byEffect[a.effect] ?? 0) - (byEffect[b.effect] ?? 0))
      if (states.length > 0 && rng() < 0.6) {
        const state = states[Math.floor(rng() * states.length)]
        const owned = engine.ownedPlants(player)
        const cells = owned.slice(0, state.costNow)
        const target = state.targetsCell ? Math.floor(rng() * 81) : -1
        sim = debugSimulate(
          boardBefore,
          hpBefore,
          player,
          'skill',
          state.slot,
          undefined,
          magic,
          skills,
          cells,
          target,
        )
        events = engine.useSkill(player, state.slot, cells, state.targetsCell ? target : null)
        phase = `skill:${state.effect}`
        skillUses += 1
        byEffect[state.effect] = (byEffect[state.effect] ?? 0) + 1
        for (const e of events) {
          if (e.type === 'flamesIgnited') flames += 1
        }
      } else {
        // ② 落子（毒鸡蛋生效时可以叠在敌方棋子上；有叠子机会时优先去叠）
        const legal = engine.emptyCells()
        const stackCells: number[] = []
        if (engine.sabotage[player]) {
          for (let i = 0; i < 81; i++) if (engine.canStackAt(i)) stackCells.push(i)
        }
        let move: number
        if (stackCells.length > 0 && rng() < 0.7) move = stackCells[Math.floor(rng() * stackCells.length)]
        else {
          if (legal.length === 0) break
          move = legal[Math.floor(rng() * legal.length)]
        }
        sim = debugSimulate(boardBefore, hpBefore, player, 'attack', move, undefined, magic, skills)
        const before = engine.board[move]
        events = engine.commit(move)
        phase = 'attack'
        if (before !== 0) stacks += 1
        if (engine.awaitingDefense) attacks += 1
        if (events.some((e) => e.type === 'stoneShattered')) shatters += 1
      }
    }
    events = events.concat(engine.takeEvents())

    if (sim.board.length !== engine.board.length || !sameNumbers(sim.board, engine.board)) {
      check(game, step, `${phase}.board`, false, `sim=${sim.board.join('')} real=${engine.board.join('')}`)
    }
    if (sim.hp[0] !== engine.hp[0] || sim.hp[1] !== engine.hp[1]) {
      check(game, step, `${phase}.hp`, false, `sim=${sim.hp} real=${engine.hp}`)
    }
    if (sim.shield[0] !== engine.shield[0] || sim.shield[1] !== engine.shield[1]) {
      check(game, step, `${phase}.shield`, false, `sim=${sim.shield} real=${engine.shield}`)
    }
    if (sim.bonusActions[0] !== engine.bonusActions[0] || sim.bonusActions[1] !== engine.bonusActions[1]) {
      check(game, step, `${phase}.bonus`, false, `sim=${sim.bonusActions} real=${engine.bonusActions}`)
    }
    if (sim.actionsTaken[0] !== engine.actionsTaken[0] || sim.actionsTaken[1] !== engine.actionsTaken[1]) {
      check(game, step, `${phase}.acted`, false, `sim=${sim.actionsTaken} real=${engine.actionsTaken}`)
    }
    if (!sameNumbers(sim.skillReadyAt[0], engine.skillReadyAt[0]) || !sameNumbers(sim.skillReadyAt[1], engine.skillReadyAt[1])) {
      check(game, step, `${phase}.ready`, false, `sim=${JSON.stringify(sim.skillReadyAt)} real=${JSON.stringify(engine.skillReadyAt)}`)
    }
    if (!sameNumbers(sim.skillCasts[0], engine.skillCasts[0]) || !sameNumbers(sim.skillCasts[1], engine.skillCasts[1])) {
      check(game, step, `${phase}.casts`, false, `sim=${JSON.stringify(sim.skillCasts)} real=${JSON.stringify(engine.skillCasts)}`)
    }
    if (sim.powerBonus[0] !== engine.powerBonus[0] || sim.powerBonus[1] !== engine.powerBonus[1]) {
      check(game, step, `${phase}.power`, false, `sim=${sim.powerBonus} real=${engine.powerBonus}`)
    }
    if (sim.sabotage[0] !== engine.sabotage[0] || sim.sabotage[1] !== engine.sabotage[1]) {
      check(game, step, `${phase}.sabotage`, false, `sim=${sim.sabotage} real=${engine.sabotage}`)
    }
    if (sim.sabotageBonus[0] !== engine.sabotageBonus[0] || sim.sabotageBonus[1] !== engine.sabotageBonus[1]) {
      check(game, step, `${phase}.sabotageBonus`, false, `sim=${sim.sabotageBonus} real=${engine.sabotageBonus}`)
    }
    if (sim.twinStar[0] !== engine.twinStar[0] || sim.twinStar[1] !== engine.twinStar[1]) {
      check(game, step, `${phase}.twin`, false, `sim=${sim.twinStar} real=${engine.twinStar}`)
    }
    if (sim.bloomCheaperNext[0] !== engine.bloomCheaperNext[0] || sim.bloomCheaperNext[1] !== engine.bloomCheaperNext[1]) {
      check(game, step, `${phase}.bloomCheaperNext`, false, `sim=${sim.bloomCheaperNext} real=${engine.bloomCheaperNext}`)
    }
    if (sim.immuneUntil[0] !== engine.immuneUntil[0] || sim.immuneUntil[1] !== engine.immuneUntil[1]) {
      check(game, step, `${phase}.immune`, false, `sim=${sim.immuneUntil} real=${engine.immuneUntil}`)
    }
    // bugv14：临时护甲 / 深度思考 / 播种 / 烈焰归属 逐字段对齐
    if (sim.tempArmor[0] !== engine.tempArmor[0] || sim.tempArmor[1] !== engine.tempArmor[1]) {
      check(game, step, `${phase}.tempArmor`, false, `sim=${sim.tempArmor} real=${engine.tempArmor}`)
    }
    if (sim.tempArmorUntil[0] !== engine.tempArmorUntil[0] || sim.tempArmorUntil[1] !== engine.tempArmorUntil[1]) {
      check(game, step, `${phase}.tempArmorUntil`, false, `sim=${sim.tempArmorUntil} real=${engine.tempArmorUntil}`)
    }
    if (sim.strikeBonus[0] !== engine.strikeBonus[0] || sim.strikeBonus[1] !== engine.strikeBonus[1]) {
      check(game, step, `${phase}.strikeBonus`, false, `sim=${sim.strikeBonus} real=${engine.strikeBonus}`)
    }
    if (sim.strikeUntil[0] !== engine.strikeUntil[0] || sim.strikeUntil[1] !== engine.strikeUntil[1]) {
      check(game, step, `${phase}.strikeUntil`, false, `sim=${sim.strikeUntil} real=${engine.strikeUntil}`)
    }
    if (sim.seedGrow[0] !== engine.seedGrow[0] || sim.seedGrow[1] !== engine.seedGrow[1]) {
      check(game, step, `${phase}.seedGrow`, false, `sim=${sim.seedGrow} real=${engine.seedGrow}`)
    }
    // bugv19：低消耗档「杀鲸霸拳」→ 本回合本方植物不加伤
    if (sim.noPlantBonus[0] !== engine.noPlantBonus[0] || sim.noPlantBonus[1] !== engine.noPlantBonus[1]) {
      check(game, step, `${phase}.noPlantBonus`, false, `sim=${sim.noPlantBonus} real=${engine.noPlantBonus}`)
    }
    if (!samePairs(sim.flameOwner, [...engine.flameOwner.entries()].sort((a, b) => a[0] - b[0]))) {
      check(
        game,
        step,
        `${phase}.flameOwner`,
        false,
        `sim=${JSON.stringify(sim.flameOwner)} real=${JSON.stringify([...engine.flameOwner.entries()])}`,
      )
    }
    if (sim.turnNo !== engine.turnNo) {
      check(game, step, `${phase}.turnNo`, false, `sim=${sim.turnNo} real=${engine.turnNo}`)
    }
    if (!samePairs(sim.flames, [...engine.flames.entries()].sort((a, b) => a[0] - b[0]))) {
      check(game, step, `${phase}.flames`, false, `sim=${JSON.stringify(sim.flames)} real=${JSON.stringify([...engine.flames.entries()])}`)
    }
    if (!samePairs(sim.overlay, [...engine.overlay.entries()].sort((a, b) => a[0] - b[0]))) {
      check(game, step, `${phase}.overlay`, false, `sim=${JSON.stringify(sim.overlay)} real=${JSON.stringify([...engine.overlay.entries()])}`)
    }
    if (!engine.isOver && sim.turn !== engine.current) {
      check(game, step, `${phase}.turn`, false, `sim=${sim.turn} real=${engine.current}`)
    }
    if (sim.awaitingDefense !== engine.awaitingDefense) {
      check(game, step, `${phase}.phase`, false, `sim=${sim.awaitingDefense} real=${engine.awaitingDefense}`)
    }

    const grown = grownCellsFrom(events)
    // 期望值 = 引擎真实植物 − **自然生长**（那是唯一"AI 先生不该知道"的变化）。
    // bugv14：不能再额外过滤 `beforeCells` —— 「播种」种下的植物在本步之前并不存在，
    // 但迷你引擎会（也必须）一起模拟出来，滤掉它反而会误报。
    const expected = plantsOf(engine).filter((p) => !grown.has(p[0]))
    if (!samePlants(sim.plants, expected)) {
      check(
        game,
        step,
        `${phase}.plants`,
        false,
        `sim=${JSON.stringify(sim.plants)} expect=${JSON.stringify(expected)}` +
          ` real=${JSON.stringify(plantsOf(engine))} grown=[${[...grown].join(',')}]`,
      )
    }
  }
}

console.log(
  `对局 ${games} 局 / 步数 ${steps} / 技能 ${skillUses} / 攻击 ${attacks} / 防守 ${defenses} / 碎裂 ${shatters} / 叠子 ${stacks} / 火球 ${flames}`,
)
console.log(`  技能分布：${JSON.stringify(byEffect)}`)
if (mismatches.length === 0) {
  console.log('✅ 迷你引擎的技能逻辑与 GameEngine 完全一致')
} else {
  console.log(`❌ 发现 ${mismatches.length} 处不一致：`)
  for (const m of mismatches) console.log(`  game ${m.game} step ${m.step} [${m.kind}] ${m.detail}`)
  process.exitCode = 1
}
