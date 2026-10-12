/** 临时复现脚本：AI 在"棋子很多"的盘面上返回了已占用的中心格。 */
import { debugRootScores, debugBoardAfterSearch, decideMove } from '../src/ai/baseline'
import type { Board, PlayerIndex } from '../src/core/types'

function diffCells(after: readonly number[]): string {
  const out: string[] = []
  for (let i = 0; i < 81; i++) {
    const want = Number(raw[i])
    if (after[i] !== want) out.push(`${i}:${want}->${after[i]}`)
  }
  return out.join(' ')
}

const raw = '212210121121112211212221210222112210211211122122122111011221220021112211001212212'
const board: Board = new Array<number>(81).fill(0)
for (let i = 0; i < 81; i++) board[i] = Number(raw[i]) as 1 | 2 | 0

const empties: number[] = []
for (let i = 0; i < 81; i++) if (board[i] === 0) empties.push(i)
console.log('空位:', empties.join(','))
console.log('board[40] =', board[40])

for (const player of [0, 1] as PlayerIndex[]) {
  for (const depth of [1, 2, 3]) {
    const scores = debugRootScores(board, [6, 6], player, depth)
    console.log(`P${player} depth ${depth}: 候选数=${scores.length} 前8=${scores.slice(0, 8).map((s) => `${s.move}(${s.score})`).join(' ')}`)
  }
}

console.log('\n迭代加深后的局面完整性：')
for (const depth of [1, 2, 3, 4, 5, 6, 7, 8, 10, 12]) {
  const after = debugBoardAfterSearch(board, [6, 6], 1, depth)
  const dirty = after.board.join('') !== raw || after.hp[0] !== 6 || after.hp[1] !== 6
  console.log(`  depth ${depth}: ${dirty ? '❌ 脏' : 'ok'}${dirty ? ` hp=${after.hp} diff=${diffCells(after.board)}` : ''}`)
}

for (const difficulty of ['normal', 'hard', 'expert'] as const) {
  const decided = decideMove({ board, player: 1, selfHp: 6, opponentHp: 6, mode: 'attack', difficulty, timeLimitMs: 60 })
  console.log(
    `${difficulty}: move=${decided.move} (board=${board[decided.move]}) score=${decided.score} nodes=${decided.nodes} ${decided.elapsedMs}ms`,
  )
}
