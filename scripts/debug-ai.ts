/** 临时调参脚本：打印指定局面下根节点各候选着法的搜索分数。 */
import { debugRootScores, debugBoardAfterSearch, debugEval, decideMove, attackPiecesAt } from '../src/ai/baseline'
import { GameEngine } from '../src/core/engine'
import { BOARD_SIZE, cellId, INITIAL_HP, type Board, type PlayerIndex } from '../src/core/types'

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

function show(name: string, rows: readonly string[], player: PlayerIndex, hp: [number, number]): void {
  const board = parseBoard(rows)
  console.log(`\n=== ${name} ===`)
  console.log(rows.join('\n'))
  for (const depth of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const scores = debugRootScores(board, hp, player, depth)
    const top = scores.slice(0, 6).map((s) => `${s.move}(${s.score})`).join(' ')
    const picked = scores.find((s) => s.move === 9)?.score
    const picked2 = scores.find((s) => s.move === 13)?.score
    const picked3 = scores.find((s) => s.move === 14)?.score
    console.log(
      `  depth ${depth}: ${top}   [9=${picked} 13=${picked2} 14=${picked3}]`,
    )
  }
  const t0 = Date.now()
  const decision = decideMove({ board, player, selfHp: hp[player], opponentHp: hp[1 - player], mode: 'attack', difficulty: 'normal' })
  console.log(`  decideMove(normal) -> move ${decision.move} score ${decision.score} nodes ${decision.nodes} ${Date.now() - t0}ms`)
  if (decision.move >= 0 && board[decision.move] === 0) {
    const pieces = attackPiecesAt(board, player, decision.move)
    if (pieces.length > 0) console.log(`    该落点成线：棋子 ${pieces.join(',')} 攻击值 ${pieces.length}`)
  }
}

show('测试1：能抓住一步成线的机会', [E, '.RRR.....', E, '.BBB.....', E, E, E, E, E], 0, [6, 6])
show('测试2：阻挡对手', [E, E, '.BBB.....', E, E, E, E, '..R......', E], 0, [6, 6])
show('空盘', [E, E, E, E, E, E, E, E, E], 0, [6, 6])

// 空盘逐深度看分数（只有一个候选：天元）
{
  const board = parseBoard([E, E, E, E, E, E, E, E, E])
  console.log('\n=== 空盘 天元 逐深度 ===')
  for (const depth of [1, 2, 3, 4]) {
    const scores = debugRootScores(board, [6, 6], 0, depth)
    console.log(`  depth ${depth}: ${scores.map((s) => `${s.move}(${s.score})`).join(' ')}`)
  }
}

// 单独调用 decideMove
{
  const board = parseBoard([E, E, E, E, E, E, E, E, E])
  const before = board.join('')
  console.log('\n=== 空盘 单独 decideMove ===')
  for (const difficulty of ['easy', 'normal', 'hard'] as const) {
    const d = decideMove({ board, player: 0, selfHp: 6, opponentHp: 6, mode: 'attack', difficulty })
    console.log(`  ${difficulty}: move=${d.move} score=${d.score} nodes=${d.nodes} ${d.elapsedMs}ms`)
  }
  console.log(`  board 是否被改动：${board.join('') !== before}`)
}

// 空盘各棋力下根候选（检查候选表）
{
  const board = parseBoard([E, E, E, E, E, E, E, E, E])
  const scores = debugRootScores(board, [6, 6], 0, 3)
  console.log(`\n空盘 depth3 候选数：${scores.length}`)
  console.log(`  前 12：${scores.slice(0, 12).map((s) => `${s.move}(${s.score})`).join(' ')}`)
}

// 防守局面：P0 在 row0 形成 4 连，P1 在 row8 已有 3 连（可反击成 4 抵消）
{
  const board = parseBoard([E, E, E, E, E, E, E, E, E])
  board[cellId(0, 0)] = 1
  board[cellId(0, 1)] = 1
  board[cellId(0, 2)] = 1
  board[cellId(0, 3)] = 1
  board[cellId(8, 0)] = 2
  board[cellId(8, 1)] = 2
  board[cellId(8, 2)] = 2
  // 模拟引擎：攻击方的棋子已移除，只剩高光
  for (const c of [cellId(0, 0), cellId(0, 1), cellId(0, 2), cellId(0, 3)]) board[c] = 0
  const weights = new Map<number, number>([
    [cellId(0, 0), 1],
    [cellId(0, 1), 1],
    [cellId(0, 2), 1],
    [cellId(0, 3), 1],
  ])
  console.log('\n=== 防守局面（P1 守，可 (8,3) 反击抵消）===')
  for (const depth of [1, 2, 3, 4]) {
    const scores = debugRootScores(board, [6, 6], 1, depth, 'defend', weights)
    console.log(`  depth ${depth}: ${scores.slice(0, 6).map((s) => `${s.move}(${s.score})`).join(' ')}`)
  }
  const d = decideMove({
    board,
    player: 1,
    selfHp: 6,
    opponentHp: 6,
    mode: 'defend',
    highlightWeights: weights,
    difficulty: 'normal',
  })
  console.log(`  decideMove(defend,normal) -> move ${d.move} score ${d.score} nodes ${d.nodes}`)
}

// 测试1 里落 9 成线之后，P1 的每种防守选择会得到什么评估
{
  console.log('\n=== 测试1 落 9 成线之后的防守选择 ===')
  const board = parseBoard([E, '.RRR.....', E, '.BBB.....', E, E, E, E, E])
  board[9] = 1
  const cells = [9, 10, 11, 12]
  for (const c of cells) board[c] = 0
  const probes: Array<[string, number]> = [
    ['高光 9（削弱1）', 9],
    ['高光 10（削弱1）', 10],
    ['高光 11（削弱1）', 11],
    ['高光 12（削弱1）', 12],
    ['反击成4 27=(3,0)', cellId(3, 0)],
    ['反击成4 31=(3,4)', cellId(3, 4)],
    ['其他 28=(3,1)', cellId(3, 1)],
  ]
  for (const [label, move] of probes) {
    const b = board.slice()
    b[move] = 2
    const weakness = cells.includes(move) ? 1 : 0
    const finalAttack = Math.max(1, 4 - weakness)
    // 防守方是否成线
    let defenderAttack = 0
    const dCells: number[] = []
    {
      const row = Math.floor(move / 9)
      const col = move % 9
      for (const [dr, dc] of [
        [0, 1],
        [1, 0],
        [1, 1],
        [1, -1],
      ] as const) {
        const run: number[] = [move]
        for (const sign of [-1, 1]) {
          let r = row + dr * sign
          let c = col + dc * sign
          while (r >= 0 && r < 9 && c >= 0 && c < 9 && b[r * 9 + c] === 2) {
            run.push(r * 9 + c)
            r += dr * sign
            c += dc * sign
          }
        }
        if (run.length >= 4) for (const x of run) if (!dCells.includes(x)) dCells.push(x)
      }
      defenderAttack = dCells.length
      for (const c of dCells) b[c] = 0
    }
    const hp: [number, number] = [6, 6]
    const diff = Math.abs(finalAttack - defenderAttack)
    if (diff > 0) hp[finalAttack > defenderAttack ? 1 : 0] -= diff
    const ev1 = debugEval(b, hp, 1, 0)
    const ev2 = debugEval(b, hp, 0, 0)
    console.log(
      `  ${label}: 攻=${finalAttack} 防=${defenderAttack} hp=${hp} 评估(P1视角)=${ev1} 评估(P0视角)=${ev2}`,
    )
  }
}

// 搜索后局面复原检查（棋盘 + 血量）
{
  console.log('\n=== 撤销完整性检查（搜索后棋盘与血量必须与输入一致）===')
  let checked = 0
  let bad = 0

  const cases: Array<[string, Board]> = [
    ['空盘', parseBoard([E, E, E, E, E, E, E, E, E])],
    ['测试1', parseBoard([E, '.RRR.....', E, '.BBB.....', E, E, E, E, E])],
    ['测试2', parseBoard([E, E, '.BBB.....', E, E, E, E, '..R......', E])],
  ]

  // 再加一批"真实对局中段"的局面
  {
    const engine = new GameEngine({ initialHp: INITIAL_HP, fixedFirstPlayer: 0, magic: { enabled: false } })
    engine.takeEvents()
    let seed = 12345
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let step = 0; step < 60; step++) {
      if (engine.isOver) break
      if (engine.awaitingDefense) {
        const empties = engine.emptyCells()
        engine.defend(empties[Math.floor(rnd() * empties.length)])
      } else {
        const empties = engine.emptyCells()
        engine.commit(empties[Math.floor(rnd() * empties.length)])
      }
      engine.takeEvents()
      if (step % 10 === 3) cases.push([`对局第${step}步`, engine.board.slice()])
    }
  }

  for (const [name, board] of cases) {
    const boardBefore = board.join('')
    for (const depth of [1, 2, 3]) {
      for (const player of [0, 1] as PlayerIndex[]) {
        const hpBefore: [number, number] = [6, 6]
        const after = debugBoardAfterSearch(board, hpBefore, player, depth)
        checked += 1
        if (after.board.join('') !== boardBefore || after.hp[0] !== 6 || after.hp[1] !== 6) {
          bad += 1
          if (bad <= 3) {
            console.log(`  ${name} depth ${depth} P${player}: ❌ board ${after.board.join('') === boardBefore ? 'ok' : '变了'} hp=${after.hp}`)
          }
        }
      }
    }
  }
  console.log(`  共检查 ${checked} 次，异常 ${bad} 次`)
}
