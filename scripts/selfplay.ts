/** 临时脚本：自对弈强度抽查（强档 vs 弱档），确认搜索没有被写坏。 */
import { decideMove, type AiDifficulty } from '../src/ai/baseline'
import { GameEngine } from '../src/core/engine'
import { BOARD_SIZE, INITIAL_HP, other, type PlayerIndex } from '../src/core/types'

interface Side {
  difficulty: AiDifficulty
  label: string
  budget: number
}

function playGame(strong: Side, weak: Side, strongFirst: boolean, gameIndex: number) {
  const engine = new GameEngine({ initialHp: INITIAL_HP, fixedFirstPlayer: strongFirst ? 0 : 1 })
  engine.takeEvents()
  const sides: [Side, Side] = strongFirst ? [strong, weak] : [weak, strong]
  let plies = 0

  while (!engine.isOver && plies < 200) {
    plies += 1
    const defender: PlayerIndex = other(engine.highlightOwner ?? 0)
    if (engine.awaitingDefense) {
      const decision = decideMove({
        board: engine.board,
        player: defender,
        selfHp: engine.hp[defender],
        opponentHp: engine.hp[other(defender)],
        mode: 'defend',
        highlightWeights: engine.highlights,
        difficulty: sides[defender].difficulty,
        timeLimitMs: sides[defender].budget,
      })
      if (decision.move < 0) break
      engine.defend(decision.move)
    } else if (engine.awaitingPlacement) {
      const player = engine.current
      const decision = decideMove({
        board: engine.board,
        player,
        selfHp: engine.hp[player],
        opponentHp: engine.hp[other(player)],
        mode: 'attack',
        difficulty: sides[player].difficulty,
        timeLimitMs: sides[player].budget,
      })
      if (decision.move < 0) break
      engine.commit(decision.move)
    } else {
      break
    }
    engine.takeEvents()
  }

  const winner = engine.result?.winner ?? null
  const strongSide: PlayerIndex = strongFirst ? 0 : 1
  const strongWon = winner === strongSide
  console.log(
    `game ${gameIndex}: ${strong.label}(${strongFirst ? '先手' : '后手'}) vs ${weak.label} ->`,
    `winner=${winner === null ? 'draw' : winner === strongSide ? strong.label : weak.label}`,
    `hp=${engine.hp[0]}:${engine.hp[1]}`,
    `plies=${plies}`,
  )
  return { strongWon, draw: winner === null }
}

const strong: Side = { difficulty: 'expert', label: 'expert', budget: Number(process.env.BUDGET ?? 80) }
const weak: Side = { difficulty: 'easy', label: 'easy', budget: Number(process.env.BUDGET ?? 80) }

let strongWins = 0
let draws = 0
const games = Number(process.env.GAMES ?? 8)
const started = Date.now()
for (let i = 0; i < games; i++) {
  const result = playGame(strong, weak, i % 2 === 0, i + 1)
  if (result.strongWon) strongWins += 1
  if (result.draw) draws += 1
}
console.log(
  `\n${strong.label} 胜 ${strongWins} / 平 ${draws} / 负 ${games - strongWins - draws}（共 ${games} 局，耗时 ${(
    (Date.now() - started) / 1000
  ).toFixed(1)}s）`,
)
// 棋盘尺寸常量只是给 lint 用
void BOARD_SIZE
