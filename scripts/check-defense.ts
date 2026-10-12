/**
 * 临时脚本：用"实际对局结果"裁决某个防守回合的几种落点谁更好。
 *
 * 构造：P0 在 row0 连成 4 连发起攻击（棋子已移除只剩高光），
 * P1 在 row8 已有 3 连。此时 P1 可选：
 *   - 落在高光上削弱（0/1/2/3）
 *   - 落 (8,3) 自己成 4 连抵消（75）
 *   - 落别处
 * 每个选择之后，双方都用新 AI 继续下到底，看最终谁赢。
 */
import { decideMove } from '../src/ai/baseline'
import { GameEngine } from '../src/core/engine'
import { cellId, INITIAL_HP, other, type Board, type PlayerIndex } from '../src/core/types'

const budget = Number(process.argv[2] ?? 100)

function setup(): GameEngine {
  const engine = new GameEngine({ initialHp: INITIAL_HP, fixedFirstPlayer: 0, magic: { enabled: false } })
  engine.takeEvents()
  const opening = [cellId(0, 0), cellId(8, 0), cellId(0, 1), cellId(8, 1), cellId(0, 2), cellId(8, 2)]
  for (const move of opening) {
    engine.commit(move)
    engine.takeEvents()
  }
  engine.commit(cellId(0, 3))
  engine.takeEvents()
  return engine
}

function playOut(engine: GameEngine): { winner: string; hp: [number, number]; plies: number } {
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
      engine.commit(decision.move)
    }
    engine.takeEvents()
  }
  const winner = engine.result?.winner
  return { winner: winner === undefined || winner === null ? '平' : `P${winner}`, hp: [engine.hp[0], engine.hp[1]], plies }
}

const choices = [cellId(8, 3), cellId(0, 0), cellId(0, 1), cellId(0, 2), cellId(0, 3), cellId(6, 2), cellId(8, 4)]
console.log('P1 的防守选择 -> 后续结果（P0 是攻击方，继续先手）')
for (const move of choices) {
  const engine = setup()
  const damageEvents = engine.defend(move)
  const snapshot = engine.attack
  engine.takeEvents()
  void damageEvents
  const result = playOut(engine)
  console.log(
    `  P1 落 ${String(move).padStart(2)} → 本回合 攻=${snapshot?.finalAttack} 防=${snapshot?.defenderAttack} ` +
      `削弱=${snapshot?.weakness} 本次伤害=${snapshot?.mode === 'canceled' ? 0 : snapshot?.diff} ` +
      `| 续下结果 winner=${result.winner} hp=${result.hp} plies=${result.plies}`,
  )
}
