// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { cellId } from '../src/core/types'
import { impactExpression, matchExpression } from '../src/app/characters'
import { useConnectGame } from '../src/app/useConnectGame'

/**
 * 无 WebGL 环境下的端到端验证：
 * 表现层不可用时 store 会退化为“直接应用事件”，
 * 因此这里校验的是「编排 + 规则 + AI」这条主链路。
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(25)
  }
  return predicate()
}

describe('应用编排（无 WebGL 退化模式）', () => {
  it('掷骰子后可以开局', async () => {
    const game = useConnectGame()
    await game.startMatch()
    expect(game.ui.dice).not.toBeNull()
    expect(['playing', 'awaitingDefense']).toContain(game.ui.phase)
    expect(game.ui.busy).toBe(false)
  })

  it('人类落子后模型立即同步，并交接给对手', async () => {
    const game = useConnectGame()
    game.ui.mode = 'pvp'
    await game.startMatch()

    const engine = game.engine.value
    const starter = engine.current
    const move = cellId(4, 4)
    await game.handleCellPick(move)

    expect(engine.board[move]).toBe(starter + 1)
    expect(engine.current).toBe(starter === 0 ? 1 : 0)
    expect(game.ui.board[move]).toBe(starter + 1)
    expect(game.ui.busy).toBe(false)
  })

  it('人机模式下 AI 会自动落子', async () => {
    const game = useConnectGame()
    game.setDifficulty('easy')
    game.ui.mode = 'pve'
    await game.startMatch()

    const engine = game.engine.value
    const starter = engine.current
    const startMoves = engine.moveCount.value

    // 若人类先手，先走一步，随后应由 AI 接管
    if (starter === 0) {
      await game.handleCellPick(cellId(4, 4))
    }

    const advanced = await waitFor(() => engine.moveCount.value > startMoves, 3000)
    expect(advanced).toBe(true)
    expect(engine.current === 0 || engine.current === 1).toBe(true)
  })

  it('形成连珠后进入攻击阶段，防守方在高光位落子可削弱', async () => {
    const game = useConnectGame()
    game.ui.mode = 'pvp'
    await game.startMatch()

    const engine = game.engine.value
    const board = engine.board.slice()
    board[cellId(0, 0)] = 1
    board[cellId(0, 1)] = 1
    board[cellId(0, 2)] = 1
    board[cellId(8, 8)] = 2
    engine.loadScenario(board, { hp: [6, 6], current: 0, firstPlayer: 0 })

    await game.handleCellPick(cellId(0, 3))
    expect(engine.phase).toBe('awaitingDefense')
    expect(game.ui.highlights).toHaveLength(4)
    // 暗场由 3D 层回调驱动；无 WebGL 时以界面阶段表达
    expect(game.ui.phase).toBe('defense')
    expect(game.ui.attackPanelOpen).toBe(true)

    // 记录攻击快照（进攻方 4 子，削弱 1 后期望伤害 3）
    await game.handleCellPick(cellId(0, 0))
    expect(engine.hp[1]).toBe(3)
    expect(game.ui.hp[1]).toBe(3)
    expect(engine.phase).toBe('playing')
    expect(engine.current).toBe(0)
    expect(game.ui.highlights).toHaveLength(0)
    expect(game.ui.phase).toBe('playing')
    expect(game.ui.attack).toMatchObject({ baseDamage: 4, weakness: 1, finalAttack: 3, diff: 3 })
  })

  it('血量归零后判负并展示结算', async () => {
    const game = useConnectGame()
    game.ui.mode = 'pvp'
    await game.startMatch()

    const engine = game.engine.value
    const board = engine.board.slice()
    board[cellId(0, 0)] = 1
    board[cellId(0, 1)] = 1
    board[cellId(0, 2)] = 1
    engine.loadScenario(board, { hp: [6, 2], current: 0, firstPlayer: 0 })

    await game.handleCellPick(cellId(0, 3))
    await game.handleCellPick(cellId(4, 4))

    expect(engine.hp[1]).toBeLessThanOrEqual(0)
    expect(engine.result).toMatchObject({ winner: 0, reason: 'hp' })
    expect(game.ui.showResult).toBe(true)
    expect(game.ui.result?.winner).toBe(0)
  })

  // -------------------------------------------------------------------------
  // bugv11
  // -------------------------------------------------------------------------

  it('恶龙吐息：开局就能用且首次免费；烈焰在 6 个回合（双方各走一步）后全部熄灭（bugv11 #1 / #6）', async () => {
    const game = useConnectGame()
    game.ui.mode = 'pvp'
    game.setCharacter(0, 'gtp')
    game.setCharacter(1, 'deepseek')
    await game.startMatch()

    const engine = game.engine.value
    engine.current = 0
    game.syncUi()
    // 开局不进入冷却 + 首次释放不消耗魔力植物
    expect(game.ui.skills[0][1].ready).toBe(true)
    expect(game.ui.skills[0][1].costNow).toBe(0)

    game.toggleSkill(0, 1)
    expect(game.ui.skillSelect?.stage).toBe('cell')
    await game.handleCellPick(cellId(4, 4))
    expect(engine.flames.size).toBeGreaterThan(0)
    expect(game.ui.flames).toHaveLength(engine.flames.size)

    // 双方交替落子：12 个半回合（各走 6 步）之后烈焰必须全部熄灭 ——
    // 以前客户端会把剩余回合数写回模型，烈焰就会"永远烧下去"
    const moves: number[] = []
    for (const col of [0, 1, 2, 3, 5, 6, 7, 8]) moves.push(cellId(8, col))
    for (const col of [0, 1, 2, 3, 5, 6, 7]) moves.push(cellId(7, col))
    let handovers = 0
    for (const cell of moves) {
      await game.handleCellPick(cell)
      handovers += 1
      if (engine.flames.size === 0) break
    }
    expect(handovers).toBeLessThanOrEqual(12)
    expect(engine.flames.size).toBe(0)
    expect(game.ui.flames).toEqual([])
  })

  it('攻击阶段里防守方反击成线也切 atk，对撞打平后回到默认（bugv20 #2）', async () => {
    const game = useConnectGame()
    game.ui.mode = 'pvp'
    await game.startMatch()

    const engine = game.engine.value
    const board = engine.board.slice()
    board[cellId(8, 0)] = 1
    board[cellId(8, 1)] = 1
    board[cellId(8, 2)] = 1
    board[cellId(4, 4)] = 2
    board[cellId(5, 4)] = 2
    board[cellId(6, 4)] = 2
    engine.loadScenario(board, { hp: [6, 6], current: 0, firstPlayer: 0 })

    // 攻击方成线：切到 atk
    await game.handleCellPick(cellId(8, 3))
    expect(engine.phase).toBe('awaitingDefense')
    expect(game.ui.expression).toEqual(['atk', 'idle'])

    // 防守方补一颗成线（对撞 4 : 4，无伤害）：
    // bugv20 #2 防守方也要切 atk（中间态），结算完之后两边都回默认
    await game.handleCellPick(cellId(3, 4))
    expect(engine.hp).toEqual([6, 6])
    expect(game.ui.expression).toEqual(['idle', 'idle'])
  })
})

describe('立绘差分推导（bugv20）', () => {
  it('matchExpression：攻击阶段里防守方成线也切 atk，且不顶掉攻击方', () => {
    // 常规落子成线：只有成线方 atk
    expect(matchExpression(0, ['idle', 'idle'], false)).toEqual(['atk', 'idle'])
    expect(matchExpression(1, ['idle', 'idle'], false)).toEqual(['idle', 'atk'])
    // 攻击阶段反击成线：两边同时 atk
    expect(matchExpression(1, ['atk', 'idle'], true)).toEqual(['atk', 'atk'])
    expect(matchExpression(0, ['idle', 'atk'], true)).toEqual(['atk', 'atk'])
  })

  it('impactExpression：第一颗撞上立刻 hit，血量归零切 lose 并维持', () => {
    // 第一颗撞中 → hit（不再等整套撞击动画播完）
    expect(impactExpression(1, ['atk', 'atk'], 5, 0)).toEqual(['atk', 'hit'])
    // 后续撞击保持 hit
    expect(impactExpression(1, ['atk', 'hit'], 4, 1)).toEqual(['atk', 'hit'])
    // 血量被打到 0 及以下 → lose
    expect(impactExpression(1, ['atk', 'hit'], 0, 3)).toEqual(['atk', 'lose'])
    // 已经是 lose 就维持（不会被后续撞击/结算改回 hit）
    expect(impactExpression(1, ['atk', 'lose'], -1, 4)).toEqual(['atk', 'lose'])
    // 不是第一颗、血量也还健康 → 不动
    expect(impactExpression(0, ['idle', 'idle'], 6, 2)).toEqual(['idle', 'idle'])
  })
})

// ---------------------------------------------------------------------------
// bugv28
// ---------------------------------------------------------------------------

describe('动画速度（bugv28 #3）', () => {
  it('默认 1×，可切到 1.5×/2× 并写进 localStorage，非法值回退 1×', () => {
    localStorage.clear()
    const game = useConnectGame()
    expect(game.ui.animationSpeed).toBe(1)

    game.setAnimationSpeed(2)
    expect(game.ui.animationSpeed).toBe(2)
    expect(localStorage.getItem('connect4.animSpeed.v1')).toBe('2')

    game.setAnimationSpeed(1.5)
    expect(game.ui.animationSpeed).toBe(1.5)

    // 非法档位回退到 1×（并覆盖存档）
    game.setAnimationSpeed(3)
    expect(game.ui.animationSpeed).toBe(1)
    expect(localStorage.getItem('connect4.animSpeed.v1')).toBe('1')

    // 下一次进入游戏会读取存档
    game.setAnimationSpeed(2)
    const next = useConnectGame()
    expect(next.ui.animationSpeed).toBe(2)
    localStorage.clear()
  })
})

describe('上一步落子标记（bugv28 #2）', () => {
  it('未成线的落子会被标记；成线的那一手不标记', async () => {
    const game = useConnectGame()
    game.ui.mode = 'pvp'
    await game.startMatch()

    const engine = game.engine.value
    const starter = engine.current
    const move = cellId(4, 4)
    await game.handleCellPick(move)
    expect(game.ui.lastMark).toEqual({ cell: move, player: starter })

    // 摆一个"再落一颗就成线"的局面，落下去这一手成线 → 不该再有标记
    const board = engine.board.slice()
    board[cellId(0, 0)] = 1
    board[cellId(0, 1)] = 1
    board[cellId(0, 2)] = 1
    engine.loadScenario(board, { hp: [6, 6], current: 0, firstPlayer: 0 })
    await game.handleCellPick(cellId(0, 3))
    expect(game.ui.lastMark).toBeNull()
  })
})

describe('联机倒计时（bugv28 #4）', () => {
  it('回合开始时定下"结束的世界时间"；离开对局即清除', async () => {
    const game = useConnectGame()
    game.ui.mode = 'online'
    game.online.status = 'playing'
    game.online.matchId = 'test-match'
    await game.startMatch()

    expect(game.ui.screen).toBe('playing')
    // 定的是绝对时间戳（世界时间），且就在 20 秒之后
    const ahead = game.online.deadline - Date.now()
    expect(ahead).toBeGreaterThan(19_000)
    expect(ahead).toBeLessThanOrEqual(20_000)
    expect(game.online.deadlineKind).toBe('place')
    expect(game.onlineCountdown.value.active).toBe(true)
    expect(game.onlineCountdown.value.seconds).toBe(20)

    game.backToMenu()
    expect(game.online.deadline).toBe(0)
    expect(game.onlineCountdown.value.active).toBe(false)
  })
})
