/**
 * 临时脚本：用"后续实际对局结果"裁决某个局面的几个候选着法谁更好。
 *
 * 用法：pnpm exec tsx scripts/check-position.ts [预算ms]
 */
import { decideMove } from '../src/ai/baseline'
import { GameEngine } from '../src/core/engine'
import { attackPiecesAt } from '../src/ai/baseline'
import { BOARD_SIZE, cellId, INITIAL_HP, other, type Board, type PlayerIndex } from '../src/core/types'

const budget = Number(process.argv[2] ?? 120)
const E = '.........'

function parseBoard(rows: readonly string[]): Board {
  const board = new Array<number>(BOARD_SIZE * BOARD_SIZE).fill(0)
  rows.forEach((row, r) => {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const ch = row[c]
      if (ch === 'R') board[cellId(r, c)] = 1
      else if (ch === 'B') board[cellId(r, c)] = 2
    }
  })
  return board
}

function playOut(engine: GameEngine): string {
  let plies = 0
  while (!engine.isOver && plies < 300) {
    plies += 1
    if (engine.awaitingDefense) {
      const defender: PlayerIndex = other(engine.highlightOwner ?? 0)
      const decision = decideMove({
        board: engine.board as Board,
        player: defender,
        selfHp: engine.hp[defender],
        opponentHp: engine.hp[other(defender)],
        mode: 'defend',
        highlightWeights: engine.highlights,
        difficulty: 'expert',
        timeLimitMs: budget,
      })
      if (decision.move < 0 || engine.board[decision.move] !== 0) {
        console.log(
          `    ⚠️ 防守返回非法落点 ${decision.move} phase=defend hp=${engine.hp} ` +
            `board=${engine.board.join('')} 高光=${[...engine.highlights.keys()].join(',')}`,
        )
        return '非法落点'
      }
      engine.defend(decision.move)
    } else {
      const player = engine.current
      const decision = decideMove({
        board: engine.board as Board,
        player,
        selfHp: engine.hp[player],
        opponentHp: engine.hp[other(player)],
        mode: 'attack',
        difficulty: 'expert',
        timeLimitMs: budget,
      })
      if (decision.move < 0 || engine.board[decision.move] !== 0) {
        const empties = engine.emptyCells()
        console.log(
          `    ⚠️ 落子返回非法落点 ${decision.move} P${player} phase=${engine.phase} hp=${engine.hp}\n` +
            `       board=${engine.board.join('')}\n` +
            `       空位(${empties.length})=${empties.join(',')}\n` +
            `       board[${decision.move}]=${engine.board[decision.move]} score=${decision.score} nodes=${decision.nodes}`,
        )
        return '非法落点'
      }
      engine.commit(decision.move)
    }
    engine.takeEvents()
  }
  const winner = engine.result?.winner
  const label = winner === undefined || winner === null ? '平' : `P${winner}`
  return `winner=${label} hp=${engine.hp[0]}:${engine.hp[1]} plies=${plies}`
}

function verdict(name: string, rows: readonly string[], player: PlayerIndex, candidates: number[]): void {
  const board = parseBoard(rows)
  console.log(`\n=== ${name}（P${player} 走）===`)
  console.log(rows.join('\n'))
  for (const move of candidates) {
    const engine = new GameEngine({ initialHp: INITIAL_HP, fixedFirstPlayer: 0, magic: { enabled: false } })
    engine.loadScenario(board, { hp: [6, 6], phase: 'playing', current: player, firstPlayer: 0 })
    engine.takeEvents()
    const pieces = attackPiecesAt(board, player, move)
    engine.commit(move)
    engine.takeEvents()
    console.log(
      `  落 ${String(move).padStart(2)}${pieces.length > 0 ? `(成线攻值${pieces.length})` : '(不成线)'} → ${playOut(engine)}`,
    )
  }
}

// 测试1：R 有 3 连（可立刻成 4 攻击），B 也有 3 连（可反击抵消）
verdict('测试1', [E, '.RRR.....', E, '.BBB.....', E, E, E, E, E], 0, [
  cellId(1, 0),
  cellId(1, 4),
  cellId(1, 5),
  cellId(5, 1),
  cellId(3, 0),
  cellId(4, 4),
])

// 测试2：B 有活三（两端都开），R 只有一颗子
verdict('测试2', [E, E, '.BBB.....', E, E, E, E, '..R......', E], 0, [
  cellId(2, 0),
  cellId(2, 4),
  cellId(7, 3),
  cellId(7, 1),
  cellId(6, 3),
  cellId(4, 4),
])

// 对照：B 只有"冲四"（一端被堵），此时挡是必须的
verdict('对照：堵冲四（一端已堵）', [E, E, 'RBBB.....', E, E, E, E, '..R......', E], 0, [
  cellId(2, 4),
  cellId(6, 3),
  cellId(4, 4),
])
