/**
 * 回放"总攻击数"回归探针（bugv25）。
 *
 * 用法：`npx tsx scripts/probe-replay-attack.ts replay/replay4.txt`
 *
 * 逐步骤比较三种值：
 *   ① **旧逻辑**（只按高光格反推攻击值）—— 防守步会退化成 `[0,0]`；
 *   ② **新逻辑**（防守步用这一步自己的 `attackResolved.snapshot` 恢复）；
 *   ③ 真值（`attackResolved.snapshot.finalAttack / defenderAttack`）。
 *
 * 实测（两个 94/66 步的人类对局回放）：**21 个攻击步旧逻辑 21/21 全错**、
 * 新逻辑 0 错。改动见 `useConnectGame.seekReplay()` 与
 * `GameEngine.loadScenario({ attackSnapshot })`。
 */

import { readFileSync } from 'node:fs'
import { GameEngine } from '../src/core/engine'
import type { Board, Cell, PlayerIndex } from '../src/core/types'

const file = process.argv[2]
const raw = readFileSync(file, 'utf8').trim()
const payload = JSON.parse(Buffer.from(raw.slice(5), 'base64').toString('utf8')) as {
  names: [string, string]
  steps: Array<{
    p: number
    c: number
    d: number
    b: string
    h: [number, number]
    g?: string
    e?: any[]
  }>
}

const steps = payload.steps.map((s) => ({
  player: s.p as PlayerIndex,
  cell: s.c,
  board: s.b.split('').map((ch) => (ch === '1' ? 1 : ch === '2' ? 2 : 0) as Cell),
  hp: [s.h[0], s.h[1]] as [number, number],
  magic: (s.g ?? '')
    .split(',')
    .filter(Boolean)
    .map((entry) => {
      const [cell, kind, owner] = entry.split(':')
      return { cell: Number(cell) || 0, kind: kind as any, owner: owner === '0' ? 0 : owner === '1' ? 1 : null }
    }),
  events: s.e && s.e.length > 0 ? s.e : undefined,
}))

function attackerHighlightsAt(index: number) {
  const step = steps[index - 1]
  const next = steps[index]
  if (!step || !next) return null
  if (!(next.events ?? []).some((e) => e.type === 'defenderPlaced')) return null
  const shown = (step.events ?? []).find((e) => e.type === 'highlightShown')
  if (!shown) return null
  return { owner: shown.owner as PlayerIndex, cells: [...shown.cells], weights: [...shown.weights] }
}

const tallyOf = (engine: GameEngine) => {
  const snap = engine.attack
  if (!snap) return [0, 0]
  return [
    snap.attacker === 0 ? snap.finalAttack : snap.defenderAttack,
    snap.attacker === 1 ? snap.finalAttack : snap.defenderAttack,
  ]
}

console.log(`文件：${file}  对局：${payload.names.join(' vs ')}  步数：${steps.length}\n`)
console.log('步  │ 旧逻辑(只反推) │ 新逻辑(含真快照) │ 真值 │ 结果')

let oldBad = 0
let newBad = 0
let checked = 0
for (let i = 1; i <= steps.length; i++) {
  const step = steps[i - 1]
  const highlights = attackerHighlightsAt(i)
  const resolved = (step.events ?? []).find((e) => e.type === 'attackResolved')
  const truth = resolved
    ? [
        resolved.snapshot.attacker === 0 ? resolved.snapshot.finalAttack : resolved.snapshot.defenderAttack,
        resolved.snapshot.attacker === 1 ? resolved.snapshot.finalAttack : resolved.snapshot.defenderAttack,
      ]
    : null

  const highlightMap = new Map<number, number>(
    highlights ? highlights.cells.map((cell, k) => [cell, highlights.weights[k] ?? 1]) : [],
  )
  const build = (engine: GameEngine, withSnapshot: boolean) => {
    const snap = resolved?.snapshot ?? null
    const attackSnapshot = withSnapshot ? snap : null
    const enterAttackStage = !step.defense && (highlights !== null || false)
    const needAttackCtx = enterAttackStage || attackSnapshot !== null
    engine.loadScenario(step.board as Board, {
      hp: step.hp,
      current: steps[i]?.player ?? step.player,
      magic: step.magic,
      ...(needAttackCtx
        ? {
            phase: 'awaitingDefense' as const,
            attacker: highlights?.owner ?? attackSnapshot?.attacker ?? 0,
            highlights: highlightMap,
            ...(attackSnapshot ? { attackSnapshot: attackSnapshot as any } : {}),
          }
        : {}),
    })
    return tallyOf(engine)
  }

  const oldTally = build(new GameEngine(), false)
  const newTally = build(new GameEngine(), true)
  if (!truth && !highlights) continue
  // 只对"有真值可查"的步做判定
  if (truth) {
    checked += 1
    const okOld = oldTally[0] === truth[0] && oldTally[1] === truth[1]
    const okNew = newTally[0] === truth[0] && newTally[1] === truth[1]
    if (!okOld) oldBad += 1
    if (!okNew) newBad += 1
    if (!okOld || !okNew) {
      console.log(
        `${String(i).padStart(3)} │ [${oldTally}]${' '.repeat(Math.max(0, 10 - String(oldTally).length))}│ [${newTally}]${' '.repeat(Math.max(0, 12 - String(newTally).length))}│ [${truth}] │ ${okOld ? '旧✓' : '旧✗'} ${okNew ? '新✓' : '新✗'}`,
      )
    }
  }
}
console.log(`\n可核对攻击步 ${checked} 个：旧逻辑错 ${oldBad} 个 → 新逻辑错 ${newBad} 个。`)

