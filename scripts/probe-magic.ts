/**
 * 调试探针：魔力植物"残留"体检。
 *
 * 检测规则（用户 bugv17 #4/#5/#10）：**棋子被破坏时，压在上面的魔力植物必须一并消失**。
 *
 * 判定分两档：
 * - `transient`：这一步"棋子消失了但植物还在"（可能下一步才清）
 * - `permanent`：再走完一整步，植物仍在，且这一步**没有在那一格重新长植物** → 真残留
 *
 * 用法：tsx scripts/probe-magic.ts [局数] [角色表]
 */
import { findCharacterSpec, type CharacterId } from '../src/core/characters'
import { GameEngine as Engine } from '../src/core/engine'
import { CELL_COUNT, other } from '../src/core/types'
import type { GameEvent } from '../src/core/types'

const GAMES = Number(process.argv[2] ?? 60)
const CHARS = (process.argv[3] ?? 'deepseek,gemini,gtp,glm,claude,seedance').split(',') as CharacterId[]

interface Leak {
  game: number
  step: number
  cell: number
  ownerAtBefore: number | null
  boardBefore: number
  detail: string
}

function pick(engine: Engine, avoidFlames = true): number {
  const cells: number[] = []
  for (let i = 0; i < CELL_COUNT; i += 1) {
    if (engine.board[i] !== 0) continue
    if (avoidFlames && engine.flames.has(i)) continue
    cells.push(i)
  }
  if (cells.length === 0) for (let i = 0; i < CELL_COUNT; i += 1) if (engine.board[i] === 0) cells.push(i)
  return cells[Math.floor(Math.random() * cells.length)]
}

function describe(events: GameEvent[]): string {
  return events
    .map((e) => {
      if (e.type === 'magicRemoved') return `magicRemoved[${e.cells.join(',')}]`
      if (e.type === 'magicGrown') return `magicGrown[${e.plants.map((p) => p.cell).join(',')}]`
      if (e.type === 'magicClaimed') return `magicClaimed[${e.cell}]`
      if (e.type === 'magicConsumed') return `magicConsumed[${e.cells.join(',')}]`
      if (e.type === 'stonesRemoved') return `stonesRemoved[${e.cells.join(',')}]${e.kept ? 'kept=' + e.kept.join(',') : ''}`
      if (e.type === 'stonePlaced') return `stonePlaced[${e.cell}]${e.stacked ? 'stack' : ''}`
      if (e.type === 'defenderPlaced') return `defenderPlaced[${e.cell}]${e.shattered ? 'shatter' : ''}`
      if (e.type === 'stoneShattered') return `stoneShattered[${e.cell}]`
      if (e.type === 'skillUsed') return `skillUsed(${e.effect})`
      return e.type
    })
    .join(' ')
}

function playGame(pair: [CharacterId, CharacterId], game: number) {
  const engine = new Engine({
    skills: [findCharacterSpec(pair[0]).skills, findCharacterSpec(pair[1]).skills],
    magic: { cooldownTurns: 8, baseCount: 3, growthStep: 2, maxCount: 5, requireLine: false },
  })
  const transient: Leak[] = []
  const permanent: Leak[] = []
  const pending: Array<{ leak: Leak; age: number }> = []
  const trace: string[] = []
  let step = 0

  while (!engine.isOver && step < 400) {
    step += 1
    const boardBefore = engine.board.slice()
    const plantsBefore = new Map(engine.magic)

    let events: GameEvent[] = []
    let action = ''
    try {
      if (engine.phase === 'playing') {
        const cell = pick(engine)
        action = `P${engine.current} commit(${cell})`
        events = engine.commit(cell)
      } else if (engine.phase === 'awaitingDefense') {
        const cell = pick(engine)
        action = `P${other(engine.highlightOwner ?? 0)} defend(${cell})`
        events = engine.defend(cell)
      } else break
    } catch {
      break
    }
    const grew = new Set<number>()
    for (const event of events) if (event.type === 'magicGrown') for (const p of event.plants) grew.add(p.cell)
    trace.push(`step${step} ${action} | magic=${engine.magic.size} | ${describe(events)}`)
    if (trace.length > 40) trace.shift()

    // 1) 上一步的"漏"：走完这一步后还在吗（且这一步没在那一格重新长）？
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const entry = pending[i]
      entry.age += 1
      if (entry.age < 1) continue
      if (engine.magic.has(entry.leak.cell) && !grew.has(entry.leak.cell)) {
        entry.leak.detail += '\n      轨迹:\n        ' + trace.slice(-7).join('\n        ')
        permanent.push(entry.leak)
      }
      pending.splice(i, 1)
    }

    // 2) 这一步新出现的"漏"
    for (let cell = 0; cell < CELL_COUNT; cell += 1) {
      if (boardBefore[cell] === 0 || engine.board[cell] !== 0) continue
      const had = plantsBefore.get(cell)
      if (!had || grew.has(cell)) continue
      if (!engine.magic.has(cell)) continue
      const leak: Leak = {
        game,
        step,
        cell,
        ownerAtBefore: had.owner,
        boardBefore: boardBefore[cell],
        detail: `棋子被移除（${boardBefore[cell]}）但植物还在（owner=${engine.magic.get(cell)?.owner}）`,
      }
      transient.push(leak)
      pending.push({ leak, age: 0 })
    }
  }
  return { transient, permanent }
}

let allTransient: Leak[] = []
let allPermanent: Leak[] = []
for (let g = 0; g < GAMES; g += 1) {
  const result = playGame([CHARS[g % CHARS.length], CHARS[(g + 1) % CHARS.length]], g)
  allTransient = allTransient.concat(result.transient)
  allPermanent = allPermanent.concat(result.permanent)
}

console.log(`\n=== 探针：${GAMES} 局 ===`)
console.log(`瞬时（下一步才清）：${allTransient.length} 处`)
console.log(`永久残留：${allPermanent.length} 处`)
for (const leak of allPermanent.slice(0, 6)) {
  console.log(
    `  #${leak.game} step${leak.step} cell=${leak.cell}(r${Math.floor(leak.cell / 9)},c${leak.cell % 9}) 原棋子=${leak.boardBefore} 植物owner=${leak.ownerAtBefore} ${leak.detail}`,
  )
}
