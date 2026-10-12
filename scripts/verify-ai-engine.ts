/**
 * AI 正确性校验：把 `src/ai/baseline.ts` 里那套"迷你引擎"与真实的
 * `GameEngine` 逐步对拍。
 *
 * 为什么要这样做：AI 的强度完全建立在"它对规则的推演与真实引擎一致"上。
 * 只要迷你引擎在任何一个分支（成线移子 / 高光削弱 / 防守方反打 / 原攻击方继续）
 * 上与引擎有一点偏差，搜索出来的"最优解"就是错的。
 *
 * 跑法：`pnpm exec tsx scripts/verify-ai-engine.ts [局数]`
 */
import { debugSimulate } from '../src/ai/baseline'
import { GameEngine } from '../src/core/engine'
import { INITIAL_HP, other, type PlayerIndex } from '../src/core/types'

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

interface Mismatch {
  game: number
  step: number
  kind: string
  detail: string
}

const mismatches: Mismatch[] = []
let steps = 0
let attacks = 0
let counterAttacks = 0
let immunity = 0

function check(
  game: number,
  step: number,
  label: string,
  ok: boolean,
  detail: string,
): void {
  if (ok) return
  if (mismatches.length < 25) mismatches.push({ game, step, kind: label, detail })
}

const games = Number(process.argv[2] ?? 400)

for (let game = 0; game < games; game++) {
  const rng = mulberry32(0x1234567 + game * 7919)
  // 阶段一只校验基础规则：关掉魔力植物（植物会给攻击 +1 伤害，属阶段二）
  const engine = new GameEngine({
    initialHp: INITIAL_HP,
    fixedFirstPlayer: (game % 2) as PlayerIndex,
    magic: { enabled: false },
  })
  engine.takeEvents()

  let step = 0
  while (!engine.isOver && step < 400) {
    step += 1
    steps += 1

    if (engine.awaitingDefense) {
      const attacker = engine.highlightOwner ?? 0
      const defender: PlayerIndex = other(attacker)
      const empties = engine.emptyCells()
      if (empties.length === 0) break
      const move = empties[Math.floor(rng() * empties.length)]

      const boardBefore = [...engine.board]
      const hpBefore: [number, number] = [engine.hp[0], engine.hp[1]]
      const highlights = new Map(engine.highlights)

      const sim = debugSimulate(boardBefore, hpBefore, defender, 'defend', move, highlights)
      engine.defend(move)

      if (!sameBoard(sim.board, engine.board)) {
        check(game, step, 'defend.board', false, `move=${move} sim=${sim.board.join('')} real=${engine.board.join('')}`)
      }
      if (sim.hp[0] !== engine.hp[0] || sim.hp[1] !== engine.hp[1]) {
        check(game, step, 'defend.hp', false, `sim=${sim.hp} real=${engine.hp}`)
      }
      if (sim.awaitingDefense) check(game, step, 'defend.phase', false, 'sim 仍在防守阶段')
      // 对局刚结束的这一步，引擎不会再 beginTurn，current 停在防守方 —— 不做比较
      if (!engine.isOver && sim.turn !== engine.current) {
        check(game, step, 'defend.turn', false, `sim=${sim.turn} real=${engine.current}`)
      }
      if ((engine.attack?.defenderAttack ?? 0) > 0) counterAttacks += 1
    } else {
      const player = engine.current
      const empties = engine.emptyCells()
      if (empties.length === 0) break
      const move = empties[Math.floor(rng() * empties.length)]

      const boardBefore = [...engine.board]
      const hpBefore: [number, number] = [engine.hp[0], engine.hp[1]]
      const sim = debugSimulate(boardBefore, hpBefore, player, 'attack', move)
      engine.commit(move)

      if (!sameBoard(sim.board, engine.board)) {
        check(game, step, 'attack.board', false, `move=${move} sim=${sim.board.join('')} real=${engine.board.join('')}`)
      }
      if (sim.hp[0] !== engine.hp[0] || sim.hp[1] !== engine.hp[1]) {
        check(game, step, 'attack.hp', false, `sim=${sim.hp} real=${engine.hp}`)
      }
      if (sim.awaitingDefense !== engine.awaitingDefense) {
        check(game, step, 'attack.phase', false, `sim=${sim.awaitingDefense} real=${engine.awaitingDefense}`)
      }
      if (!engine.isOver && sim.turn !== engine.current) {
        check(game, step, 'attack.turn', false, `sim=${sim.turn} real=${engine.current}`)
      }
      if (engine.awaitingDefense) attacks += 1
    }

    engine.takeEvents()
  }
  void immunity
}

console.log(`对局 ${games} 局 / 步数 ${steps} / 攻击 ${attacks} / 防守成线 ${counterAttacks}`)
if (mismatches.length === 0) {
  console.log('✅ 迷你引擎与 GameEngine 完全一致')
} else {
  console.log(`❌ 发现 ${mismatches.length} 处不一致：`)
  for (const m of mismatches) console.log(`  game ${m.game} step ${m.step} [${m.kind}] ${m.detail}`)
  process.exitCode = 1
}
