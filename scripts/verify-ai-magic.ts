/**
 * 阶段二正确性校验：把 AI 迷你引擎的「魔力植物」逻辑与真实 `GameEngine` 逐步对拍。
 *
 * ⚠️ 公平性前提：AI **只使用棋盘上看得见的植物**，不预测未来生长（见 `AiMagicContext`）。
 * 所以比对口径是：
 *
 *   sim.plants  ==  realPlants 中「这一步之前就存在、且不是这一步新长出来的」那些格子
 *
 * 即：场上植物怎么被占、被抢、被连珠清掉，必须逐格一致；而这一步由生长新增的植物
 * （`magicGrown` 事件里的位置）AI 本来就不该知道，比对时排除。
 *
 * 跑法：`pnpm exec tsx scripts/verify-ai-magic.ts [局数]`
 */
import { debugSimulate, type AiMagicContext } from '../src/ai/baseline'
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

function sameBoard(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
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

/** 这一步由生长新种下的格子（AI 先生不知道，比对时排除）。 */
function grownCellsFrom(events: readonly GameEvent[]): Set<number> {
  const cells = new Set<number>()
  for (const event of events) {
    if (event.type === 'magicGrown') for (const plant of event.plants) cells.add(plant.cell)
  }
  return cells
}

interface Mismatch {
  game: number
  step: number
  kind: string
  detail: string
}

const mismatches: Mismatch[] = []
let steps = 0
let grownEvents = 0
let steals = 0
let attacks = 0
let plantBoosted = 0

function check(game: number, step: number, kind: string, ok: boolean, detail: string): void {
  if (ok) return
  if (mismatches.length < 20) mismatches.push({ game, step, kind, detail })
}

const games = Number(process.argv[2] ?? 300)

for (let game = 0; game < games; game++) {
  const rng = mulberry32(0x51ed270b + game * 7919)
  const engine = new GameEngine({
    initialHp: INITIAL_HP,
    fixedFirstPlayer: (game % 2) as PlayerIndex,
    magic: { enabled: true },
    // bugv34：离线 AI 对拍关闭黑夜（迷你引擎未建模天气），保证迷你引擎与真实引擎逐字节等价
    night: { enabled: false },
  })
  engine.takeEvents()

  let step = 0
  while (!engine.isOver && step < 400) {
    step += 1
    steps += 1

    const boardBefore = [...engine.board]
    const hpBefore: [number, number] = [engine.hp[0], engine.hp[1]]
    const beforePlants = plantsOf(engine)
    const beforeCells = new Set(beforePlants.map((p) => p[0]))
    // 给 AI 的上下文 = 场上看得见的植物 + 每棵加伤点数
    const magic: AiMagicContext = {
      plants: beforePlants,
      damagePerPlant: engine.magicConfig.damagePerPlant,
    }

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
        undefined,
        undefined,
        undefined,
        // bugv17 #4：攻击方的加伤在宣告攻击时就锁定了（植物已随棋子删除），
        // 高光格表达不了它 —— 必须显式传 `attackerPlants`
        { attackerPlants: engine.attack?.attackerPlants },
      )
      events = engine.defend(move)
      phase = 'defend'
      if ((engine.attack?.stolenPlants ?? 0) > 0) steals += 1
      if (sim.awaitingDefense) check(game, step, 'defend.phase', false, 'sim 仍在防守阶段')
    } else {
      const player = engine.current
      const empties = engine.emptyCells()
      if (empties.length === 0) break
      const move = empties[Math.floor(rng() * empties.length)]
      sim = debugSimulate(boardBefore, hpBefore, player, 'attack', move, undefined, magic)
      events = engine.commit(move)
      phase = 'attack'
      if (engine.awaitingDefense) {
        attacks += 1
        if ((engine.attack?.attackerPlants ?? 0) > 0) plantBoosted += 1
      }
      if (sim.awaitingDefense !== engine.awaitingDefense) {
        check(game, step, 'attack.phase', false, `sim=${sim.awaitingDefense} real=${engine.awaitingDefense}`)
      }
    }
    events = events.concat(engine.takeEvents())

    if (!sameBoard(sim.board, engine.board)) {
      check(game, step, `${phase}.board`, false, `sim=${sim.board.join('')} real=${engine.board.join('')}`)
    }
    if (sim.hp[0] !== engine.hp[0] || sim.hp[1] !== engine.hp[1]) {
      check(game, step, `${phase}.hp`, false, `sim=${sim.hp} real=${engine.hp}`)
    }
    if (!engine.isOver && sim.turn !== engine.current) {
      check(game, step, `${phase}.turn`, false, `sim=${sim.turn} real=${engine.current}`)
    }

    const grown = grownCellsFrom(events)
    if (grown.size > 0) grownEvents += 1
    const expected = plantsOf(engine).filter((p) => beforeCells.has(p[0]) && !grown.has(p[0]))
    if (!samePlants(sim.plants, expected)) {
      check(
        game,
        step,
        `${phase}.plants`,
        false,
        `sim=${JSON.stringify(sim.plants)}\n      expect=${JSON.stringify(expected)}` +
          `\n      real=${JSON.stringify(plantsOf(engine))} grown=[${[...grown].join(',')}]`,
      )
    }
  }
}

console.log(
  `对局 ${games} 局 / 步数 ${steps} / 攻击 ${attacks} / 生长批次 ${grownEvents} / 抢植物 ${steals} / 带植物加伤的攻击 ${plantBoosted}`,
)
if (mismatches.length === 0) {
  console.log('✅ 迷你引擎的植物逻辑与 GameEngine 完全一致（AI 只看得到场上的植物）')
} else {
  console.log(`❌ 发现 ${mismatches.length} 处不一致：`)
  for (const m of mismatches) console.log(`  game ${m.game} step ${m.step} [${m.kind}] ${m.detail}`)
  process.exitCode = 1
}
