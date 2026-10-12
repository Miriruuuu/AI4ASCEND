/**
 * 一次性探针（bugv19 #3）：复现「gtp 连招」局面，对比闸门开/关时 AI 的选择。
 *
 * 用法：pnpm exec tsx scripts/probe-combo.ts
 */
import { decideMove, type AiSkillContext } from '../src/ai/baseline'
import { skillsOfCharacter } from '../src/core/characters'
import { BOARD_SIZE, type Board, type PlayerIndex } from '../src/core/types'

const E = '.'
const cellId = (row: number, col: number): number => row * BOARD_SIZE + col

function parseBoard(rows: readonly string[]): Board {
  const board = new Array<number>(BOARD_SIZE * BOARD_SIZE).fill(0)
  rows.forEach((row, r) => {
    for (let c = 0; c < BOARD_SIZE; c += 1) {
      const ch = row[c] ?? E
      board[r * BOARD_SIZE + c] = ch === '.' ? 0 : ch === 'R' ? 1 : ch === 'B' ? 2 : Number(ch)
    }
  })
  return board
}

function skillCtxFor(player: PlayerIndex, character: 'deepseek' | 'gemini' | 'gtp' | 'glm'): AiSkillContext {
  const specs = skillsOfCharacter(character)
  const empty: readonly [] = []
  return {
    skills: player === 0 ? [specs, empty] : [empty, specs],
    skillReadyAt: player === 0 ? [[0, 0], []] : [[], [0, 0]],
    skillCasts: player === 0 ? [[0, 0], []] : [[], [0, 0]],
    initialHp: 6,
  }
}

const board = parseBoard([E, E, E, E, 'RRRB.....', E, E, E, E])
const plants: Array<[number, PlayerIndex | null]> = [
  [cellId(8, 0), 0],
  [cellId(8, 2), 0],
  [cellId(8, 4), 0],
]

for (const nodes of [1000, 2000, 3000, 4000, 5000, 6000, 8000, 12000, 16000, 20000]) {
  const decision = decideMove({
    board,
    player: 0,
    selfHp: 6,
    opponentHp: 4,
    mode: 'attack',
    difficulty: 'normal',
    maxDepth: 4,
    nodeLimit: nodes,
    magic: { plants, damagePerPlant: 1 },
    skills: skillCtxFor(0, 'gtp'),
  })
  const hasFire = decision.skills?.some((s) => s.slot === 1 && s.target === cellId(4, 3)) ?? false
  console.log(
    `nodes=${nodes} → ${hasFire ? '✅' : '❌'} move=${decision.move} score=${decision.score.toFixed(1)} skills=${JSON.stringify(decision.skills)}`,
  )
}

// ② 火球打完之后的局面：烈焰在 (4,3) 且归我方、挡路的敌子已经碎掉。
//    AI 必须仍然愿意**走进自己的火**（那一手当场成线）—— 闸门不能把它挡掉。
const fireRow = parseBoard([E, E, E, E, 'RRR......', E, E, E, E])
const walk = decideMove({
  board: fireRow,
  player: 0,
  selfHp: 6,
  opponentHp: 4,
  mode: 'attack',
  difficulty: 'expert',
  maxDepth: 4,
  nodeLimit: 8000,
  magic: { plants: [[cellId(8, 0), 0]], damagePerPlant: 1 },
  skills: {
    skills: [skillsOfCharacter('gtp'), []],
    skillReadyAt: [[99, 99], []],
    skillCasts: [[0, 0], []],
    initialHp: 8,
    flames: [[cellId(4, 3), 12]],
    flameOwner: [[cellId(4, 3), 0]],
    turnNo: 1,
  },
})
console.log(`走进自己的火 → move=${walk.move} (期望 ${cellId(4, 3)}) score=${walk.score.toFixed(1)}`)

// ③ 反例：自己的火**不能成线**时，闸门应该把它从候选里剔除（选点不该落在火上）。
const farFlame = decideMove({
  board: parseBoard([E, E, '.........', E, 'RRR......', E, E, E, E]),
  player: 0,
  selfHp: 8,
  opponentHp: 8,
  mode: 'attack',
  difficulty: 'expert',
  maxDepth: 4,
  nodeLimit: 8000,
  magic: { plants: [[cellId(8, 0), 0]], damagePerPlant: 1 },
  skills: {
    skills: [skillsOfCharacter('gtp'), []],
    skillReadyAt: [[99, 99], []],
    skillCasts: [[0, 0], []],
    initialHp: 8,
    flames: [[cellId(2, 4), 12]],
    flameOwner: [[cellId(2, 4), 0]],
    turnNo: 1,
  },
})
console.log(`火在别处（不能成线）→ move=${farFlame.move}（期望 ≠ ${cellId(2, 4)}）score=${farFlame.score.toFixed(1)}`)
