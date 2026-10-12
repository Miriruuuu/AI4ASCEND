/** 临时脚本：新 AI(P0) vs 旧 AI(P1) 完整对局逐手打印，用于定位具体失误。 */
import { decideMove as decideNew, attackPiecesAt } from '../src/ai/baseline'
import { decideMove as decideLegacy } from './legacy-baseline'
import { GameEngine } from '../src/core/engine'
import { INITIAL_HP, other, type Board, type PlayerIndex } from '../src/core/types'

const budget = Number(process.argv[2] ?? 200)
const maxPlies = Number(process.argv[3] ?? 200)

const engine = new GameEngine({ initialHp: INITIAL_HP, fixedFirstPlayer: 0, magic: { enabled: false } })
engine.takeEvents()

let plies = 0
while (!engine.isOver && plies < maxPlies) {
  plies += 1
  if (engine.awaitingDefense) {
    const defender: PlayerIndex = other(engine.highlightOwner ?? 0)
    const decide = defender === 0 ? decideNew : decideLegacy
    const decision = decide({
      board: engine.board as Board,
      player: defender,
      selfHp: engine.hp[defender],
      opponentHp: engine.hp[other(defender)],
      mode: 'defend',
      highlightWeights: engine.highlights,
      difficulty: 'expert',
      timeLimitMs: budget,
    })
    const hl = [...engine.highlights.keys()].map((c) => `${c}w${engine.highlights.get(c)}`).join(' ')
    console.log(`#${plies} 防守 P${defender}(${defender === 0 ? 'new' : 'old'}) move=${decision.move} 高光=[${hl}]`)
    engine.defend(decision.move)
  } else {
    const player = engine.current
    const decide = player === 0 ? decideNew : decideLegacy
    const decision = decide({
      board: engine.board as Board,
      player,
      selfHp: engine.hp[player],
      opponentHp: engine.hp[other(player)],
      mode: 'attack',
      difficulty: 'expert',
      timeLimitMs: budget,
    })
    const pieces = decision.move >= 0 ? attackPiecesAt(engine.board as Board, player, decision.move) : []
    console.log(
      `#${plies} 落子 P${player}(${player === 0 ? 'new' : 'old'}) move=${decision.move}` +
        `${pieces.length > 0 ? ` 成线(攻值${pieces.length})` : ''} hp=${engine.hp[0]}:${engine.hp[1]}`,
    )
    engine.commit(decision.move)
  }
  engine.takeEvents()
}
console.log(`结束 plies=${plies} hp=${engine.hp} winner=${engine.result?.winner ?? '平'}`)
