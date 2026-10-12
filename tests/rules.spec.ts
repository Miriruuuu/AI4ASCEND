import { describe, expect, it } from 'vitest'
import type { AiSkillContext } from '../src/ai/baseline'
import { GameEngine, previewAttackPieces } from '../src/core/engine'
import { stateDigest } from '../src/core/digest'
import { skillsOfCharacter, isCharacterId } from '../src/core/characters'
import {
  damageDiff,
  finalAttackValue,
  findLines,
  lineWeightAt,
  summarizeMatch,
  threatHints,
  totalLineLength,
  uniquePieceCells,
  uniquePieceCount,
} from '../src/core/lines'
import {
  BOARD_SIZE,
  WEATHERS,
  cellId,
  cellOf,
  createBoard,
  DEFAULT_MAGIC_CONFIG,
  DEFAULT_NIGHT_CONFIG,
  INITIAL_HP,
  type Board,
  type GameEvent,
  type PlayerIndex,
  type SkillSpec,
  type WeatherId,
} from '../src/core/types'

// ---------------------------------------------------------------------------
// 测试工具
// ---------------------------------------------------------------------------

/** 用字符串棋盘快速构造（'R' 先手 / 'B' 后手 / '.' 空）。 */
function parseBoard(rows: readonly string[]): Board {
  const board = createBoard()
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const ch = row[c]
      board[cellId(r, c)] = (ch === 'R' ? 1 : ch === 'B' ? 2 : 0) as 0 | 1 | 2
    }
  })
  return board
}

const E = '.........'

/** 从引擎原始棋盘的 81 位数字串还原（0 空 / 1 P0 / 2 P1）。 */
function parseBoardString(text: string): Board {
  const board = createBoard()
  for (let i = 0; i < board.length; i++) board[i] = Number(text[i]) as 0 | 1 | 2
  return board
}

/** 构造一个已进入 playing 阶段、由指定玩家行动的引擎（含开局事件）。 */
function engineFor(player: PlayerIndex, hp = 6): GameEngine {
  const engine = new GameEngine({ fixedFirstPlayer: player, initialHp: hp })
  engine.setFirstPlayer(player)
  engine.takeEvents()
  return engine
}

/** 依次落子（自动区分普通回合 / 防守回合），返回每步事件。 */
function run(engine: GameEngine, moves: readonly number[]): GameEvent[][] {
  return moves.map((move) => (engine.awaitingDefense ? engine.defend(move) : engine.commit(move)))
}

function eventOf<T extends GameEvent['type']>(events: readonly GameEvent[], type: T): Extract<GameEvent, { type: T }> | undefined {
  return events.find((event): event is Extract<GameEvent, { type: T }> => event.type === type)
}

// ---------------------------------------------------------------------------
// 魔力植物（bugv8 #4）
// ---------------------------------------------------------------------------

describe('魔力植物', () => {
  /** 把一棵植物直接放到指定格子上（绕过随机生长，便于精确断言伤害）。 */
  function plantAt(engine: GameEngine, cell: number, owner: PlayerIndex | null = null): void {
    engine.magic.set(cell, { cell, kind: 'flower', owner })
  }

  it('requireLine 门槛：要求"先有连珠"时，连珠之前一棵都不长（bugv13 #4 的开关）', () => {
    // ⚠️ bugv13 #4：默认值已从 requireLine:true 改成 false（见 DEFAULT_MAGIC_CONFIG 的说明），
    // 所以这里显式打开门槛来钉住这条规则本身。
    const engine = new GameEngine({
      fixedFirstPlayer: 0,
      initialHp: 6,
      magic: { enabled: true, requireLine: true },
    })
    engine.setFirstPlayer(0)
    engine.takeEvents()
    expect(engine.magic.size).toBe(0)
    // 双方交替下在隔一格的位置上，谁都不会连成 4 子
    const safe = [
      cellId(8, 0), cellId(7, 0), cellId(8, 2), cellId(7, 2), cellId(8, 4), cellId(7, 4),
      cellId(8, 6), cellId(7, 6), cellId(8, 8), cellId(7, 8), cellId(6, 0), cellId(5, 0),
      cellId(6, 2), cellId(5, 2), cellId(6, 4), cellId(5, 4), cellId(6, 6), cellId(5, 6),
    ]
    for (const cell of safe) run(engine, [cell])
    expect(engine.moveCount.value).toBe(safe.length)
    expect(engine.magic.size).toBe(0)
    expect(engine.magicLineSeen).toBe(false)

    // 造一次连珠：冷却从 10 直接减 8 → 还剩 2 回合
    const board = parseBoard([E, '.RRR.....', E, E, E, E, E, E, E])
    engine.loadScenario(board, { hp: [6, 6], current: 0, firstPlayer: 0 })
    engine.commit(cellId(1, 4))
    expect(engine.magicLineSeen).toBe(true)
    expect(engine.magicCooldown).toBe(2)
    expect(engine.magic.size).toBe(0)

    // 攻击阶段走完算 1 回合（2→1），再走 1 回合（1→0）→ 长出来
    engine.defend(cellId(8, 8))
    expect(engine.magicCooldown).toBe(1)
    engine.commit(cellId(8, 7))
    expect(engine.magic.size).toBe(2)
    expect(engine.magicGrowths).toBe(1)
    expect(engine.magicCooldown).toBe(10)
  })

  it('默认配置不要求先连珠：开头就有植物，技能不必等到中后盘（bugv13 #4）', () => {
    // 旧默认要求"先有连珠"，会让技能在前半场结构上不可用
    // （实机回放里第一棵植物到第 75 手才出现，全场技能释放 0 次）。
    expect(DEFAULT_MAGIC_CONFIG.requireLine).toBe(false)
    const engine = engineFor(0) // engineFor 不带 magic 配置 → 走默认值
    expect(engine.magicConfig.requireLine).toBe(false)
    const safe = [
      cellId(8, 0), cellId(7, 0), cellId(8, 2), cellId(7, 2), cellId(8, 4), cellId(7, 4),
      cellId(8, 6), cellId(7, 6), cellId(8, 8), cellId(7, 8),
    ]
    for (const cell of safe) run(engine, [cell])
    // 10 手冷却走完，即使一次连珠都没有，植物也该长出来
    expect(engine.magicLineSeen).toBe(false)
    expect(engine.magic.size).toBeGreaterThan(0)
  })

  it('连珠上每有一棵魔力植物，最终伤害 +1', () => {
    const engine = engineFor(0)
    const board = parseBoard([E, '.RRR.....', E, E, E, E, E, E, 'B........'])
    engine.loadScenario(board, { hp: [6, 6], current: 0, firstPlayer: 0 })
    plantAt(engine, cellId(1, 3), 0)
    const events = engine.commit(cellId(1, 4))
    const attack = eventOf(events, 'highlightShown')
    expect(attack).toBeDefined()
    expect(engine.attack?.baseDamage).toBe(4)
    expect(engine.attack?.finalAttack).toBe(5)
    expect(engine.attack?.attackerPlants).toBe(1)
  })

  it('攻击方连珠上的植物留到防守方落子后，防守方可以抢走（bugv18 #1 恢复 bugv8 #4）', () => {
    const engine = engineFor(0)
    // 赤方：row1 的 (1,1)(1,2)(1,3) + 落 (1,4) 成 4 连
    // 青方：col3 的 (2,3)(3,3)(4,3) + 落在 (1,3) 也成 4 连
    const board = parseBoard([E, '.RRR.....', '...B.....', '...B.....', '...B.....', E, E, E, E])
    engine.loadScenario(board, { hp: [8, 8], current: 0, firstPlayer: 0 })
    plantAt(engine, cellId(1, 3), 0)
    const declared = engine.commit(cellId(1, 4)) // 赤方 4 连（含植物）→ 攻击 5
    expect(engine.attack?.finalAttack).toBe(5)
    // bugv18 #1：宣告攻击时**不**删植物 —— 它们是防守方的"抢夺窗口"，要留到防守方落子之后
    expect(eventOf(declared, 'magicRemoved')).toBeUndefined()
    expect(engine.magic.size).toBe(1)

    // 青方落在那颗棋子的原位置（高光位）完成自己的 4 连，并把植物抢过来
    const events = engine.defend(cellId(1, 3))
    const snapshot = eventOf(events, 'attackResolved')?.snapshot
    // 赤方：4 基础 + 0 植物（被抢走）- 1 削弱 = 3
    expect(snapshot?.attackerPlants).toBe(0)
    expect(snapshot?.stolenPlants).toBe(1)
    expect(snapshot?.finalAttack).toBe(3)
    // 青方：4 基础 + 1 抢来的植物 = 5
    expect(snapshot?.defenderPlants).toBe(1)
    expect(snapshot?.defenderAttack).toBe(5)
    // 5 vs 3 → 差值 2 由赤方承担
    expect(snapshot?.diff).toBe(2)
    expect(engine.hp[0]).toBe(6)
    // 抢夺窗口关闭：参与本次连珠的植物一起消失
    expect(engine.magic.size).toBe(0)
    expect(eventOf(events, 'magicRemoved')?.cells).toEqual([cellId(1, 3)])
  })

  it('防守方落在高光位抢走植物：攻击方少 1 点、防守方多 1 点（bugv18 #1）', () => {
    const engine = engineFor(0)
    const board = parseBoard([E, '.RRR.....', E, E, E, E, E, E, E])
    engine.loadScenario(board, { hp: [8, 8], current: 0, firstPlayer: 0 })
    plantAt(engine, cellId(1, 3), 0)
    engine.commit(cellId(1, 4))
    expect(engine.attack?.finalAttack).toBe(5)
    const events = engine.defend(cellId(1, 3))
    const snapshot = eventOf(events, 'attackResolved')?.snapshot
    // 青方没成线 → 0；赤方 4 + 0（被抢）- 1（削弱）= 3
    expect(snapshot?.attackerPlants).toBe(0)
    expect(snapshot?.stolenPlants).toBe(1)
    expect(snapshot?.defenderAttack).toBe(0)
    expect(snapshot?.finalAttack).toBe(3)
    expect(engine.hp[1]).toBe(5)
    expect(engine.magic.size).toBe(0)
  })

  it('在魔力植物上落子会把它占为己有（未被抢时归落子方）', () => {
    const engine = engineFor(0)
    plantAt(engine, cellId(4, 4), null)
    const events = engine.commit(cellId(4, 4))
    const claimed = eventOf(events, 'magicClaimed')
    expect(claimed?.player).toBe(0)
    expect(claimed?.stolen).toBe(false)
    expect(engine.magic.get(cellId(4, 4))?.owner).toBe(0)
  })

  it('loadScenario 能恢复植物与冷却（联机 sync / 回放用）', () => {
    const engine = engineFor(0)
    engine.loadScenario(createBoard(), {
      hp: [5, 4],
      current: 1,
      magic: [
        { cell: 40, kind: 'fern', owner: 1 },
        { cell: 12, kind: 'grass', owner: null },
      ],
      magicGrowths: 4,
      magicCooldown: 3,
      magicLineSeen: true,
    })
    expect(engine.magic.size).toBe(2)
    expect(engine.magic.get(40)).toEqual({ cell: 40, kind: 'fern', owner: 1 })
    expect(engine.magicGrowths).toBe(4)
    expect(engine.magicCooldown).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// 预判线（bugv9 #3）
// ---------------------------------------------------------------------------

describe('连珠预判线', () => {
  it('连续 3 颗 + 一端空位：提示那个空位', () => {
    const board = parseBoard([E, '.RRR.....', E, E, E, E, E, E, E])
    const hints = threatHints(board, 0, cellId(1, 3))
    expect(hints).toHaveLength(1)
    expect(hints[0].direction).toEqual([0, 1])
    expect(hints[0].gap).toBe(cellId(1, 0))
  })

  it('2 + 1 中间空一格（X X _ X）也要提示（bugv9 #3 的核心场景）', () => {
    const board = parseBoard([E, '.RR.R....', E, E, E, E, E, E, E])
    const hints = threatHints(board, 0, cellId(1, 4))
    expect(hints).toHaveLength(1)
    expect(hints[0].direction).toEqual([0, 1])
    expect(hints[0].gap).toBe(cellId(1, 3))
    // 落子位置与缺口都在同一个四连窗口里
    expect(hints[0].cells).toEqual([cellId(1, 1), cellId(1, 2), cellId(1, 3), cellId(1, 4)])
  })

  it('缺口在斜向 / 竖向时同样识别', () => {
    const diagonal = parseBoard([E, '.R......', '..R.....', E, '....R...', E, E, E, E])
    expect(threatHints(diagonal, 0, cellId(4, 4))[0]?.gap).toBe(cellId(3, 3))

    const column = parseBoard([E, '.R......', E, '.R......', '.R......', E, E, E, E])
    const vertical = threatHints(column, 0, cellId(4, 1))
    expect(vertical[0].direction).toEqual([1, 0])
    expect(vertical[0].gap).toBe(cellId(2, 1))
  })

  it('对手挡在窗口里就不提示（补不成线）', () => {
    const board = parseBoard([E, '.RRB.....', E, E, E, E, E, E, E])
    expect(threatHints(board, 0, cellId(1, 2))).toHaveLength(0)
  })

  it('落点不是己方棋子（已被移除 / 是对手的子）就不提示', () => {
    const board = parseBoard([E, '.RR.R....', E, E, E, E, E, E, E])
    expect(threatHints(board, 0, cellId(1, 3))).toHaveLength(0)
    expect(threatHints(board, 1, cellId(1, 4))).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 角色技能（bugv9 #13）
// ---------------------------------------------------------------------------

describe('角色技能', () => {
  const DEEPSEEK = [
    { id: 'ds-shield', name: '超维护盾', cost: 1, cooldown: 5, effect: 'shield' as const, amount: 1 },
    { id: 'ds-double', name: '双核推演', cost: 5, cooldown: 10, effect: 'double' as const, amount: 1 },
  ]
  const GEMINI = [
    { id: 'gm-heal', name: '生命回响', cost: 1, cooldown: 5, effect: 'heal' as const, amount: 1 },
    { id: 'gm-bloom', name: '万物生长', cost: 3, cooldown: 15, effect: 'bloom' as const, amount: 1 },
  ]

  function skillEngine(first: PlayerIndex = 0): GameEngine {
    const engine = new GameEngine({
      fixedFirstPlayer: first,
      initialHp: 6,
      skills: [DEEPSEEK, GEMINI],
    })
    engine.setFirstPlayer(first)
    engine.takeEvents()
    return engine
  }

  /** 给某一方种几棵"被它占用"的植物（绕过生长随机）。 */
  function ownPlants(engine: GameEngine, player: PlayerIndex, cells: readonly number[]): void {
    for (const cell of cells) {
      engine.board[cell] = cellOf(player)
      engine.magic.set(cell, { cell, kind: 'flower', owner: player })
    }
  }

  it('开局所有技能都在冷却中（默认进入冷却）', () => {
    const engine = skillEngine()
    const states = engine.skillStates()
    expect(states[0].map((state) => state.remaining)).toEqual([5, 10])
    expect(states[1].map((state) => state.remaining)).toEqual([5, 15])
    expect(states[0][0].ready).toBe(false)
    expect(states[0][0].reason).toContain('冷却')
  })

  it('消耗 1 棵魔力植物获得 1 点护盾，并重新进入冷却', () => {
    const engine = skillEngine()
    ownPlants(engine, 0, [cellId(4, 4)])
    engine.skillReadyAt[0][0] = 0
    const events = engine.useSkill(0, 0, [cellId(4, 4)])
    expect(eventOf(events, 'skillUsed')?.effect).toBe('shield')
    expect(eventOf(events, 'magicConsumed')?.cells).toEqual([cellId(4, 4)])
    expect(engine.shield[0]).toBe(1)
    expect(engine.magic.size).toBe(0)
    // 冷却：用完之后要再行动 5 次
    expect(engine.skillStateFor(0, 0)?.remaining).toBe(5)
  })

  it('护盾先于血量承伤（金属血条打完才扣血）', () => {
    const engine = skillEngine()
    ownPlants(engine, 0, [cellId(4, 4)])
    engine.skillReadyAt[0][0] = 0
    engine.useSkill(0, 0, [cellId(4, 4)])
    expect(engine.shield[0]).toBe(1)
    // 让 1 号位对 0 号位造成 4 点伤害，护盾 2 点先扛
    engine.loadScenario(createBoard(), { hp: [6, 6], current: 0 })
    engine.shield = [2, 0]
    engine.magic.clear()
    engine.board = parseBoard([E, '..BBB....', E, E, E, E, E, E, E])
    engine.current = 1
    engine.commit(cellId(1, 1))
    engine.defend(cellId(5, 5))
    expect(engine.shield[0]).toBe(0)
    expect(engine.hp[0]).toBe(4)
  })

  it('回血不超过初始血量', () => {
    const engine = skillEngine()
    ownPlants(engine, 1, [cellId(2, 2)])
    engine.current = 1
    engine.skillReadyAt[1][0] = 0
    engine.hp[1] = 4
    engine.useSkill(1, 0, [cellId(2, 2)])
    expect(engine.hp[1]).toBe(5)
    engine.skillReadyAt[1][0] = 0
    engine.magic.set(cellId(2, 3), { cell: cellId(2, 3), kind: 'fern', owner: 1 })
    engine.useSkill(1, 0, [cellId(2, 3)])
    expect(engine.hp[1]).toBe(6)
    engine.skillReadyAt[1][0] = 0
    engine.magic.set(cellId(2, 4), { cell: cellId(2, 4), kind: 'fern', owner: 1 })
    engine.useSkill(1, 0, [cellId(2, 4)])
    expect(engine.hp[1]).toBe(6)
  })

  it('连续行动：下一次落子后还是自己走（再走一次才交回合）', () => {
    const engine = skillEngine()
    // 5 棵分散的植物（故意不连成线，免得触发攻击阶段）
    const plants = [cellId(0, 0), cellId(0, 2), cellId(0, 4), cellId(2, 0), cellId(2, 2)]
    ownPlants(engine, 0, plants)
    engine.skillReadyAt[0][1] = 0
    engine.useSkill(0, 1, plants)
    expect(engine.bonusActions[0]).toBe(1)
    engine.commit(cellId(8, 8))
    expect(engine.current).toBe(0)
    expect(engine.bonusActions[0]).toBe(0)
    engine.commit(cellId(8, 7))
    expect(engine.current).toBe(1)
  })

  it('双子星：只点亮爆发窗口，不再长魔力植物（bugv11 追加 #2）', () => {
    const engine = skillEngine()
    ownPlants(engine, 1, [cellId(0, 0), cellId(0, 1), cellId(0, 2)])
    engine.current = 1
    engine.skillReadyAt[1][1] = 0
    const armed = engine.useSkill(1, 1, [cellId(0, 0), cellId(0, 1), cellId(0, 2)])
    expect(eventOf(armed, 'twinStarChanged')?.active).toBe(true)
    expect(engine.twinStar[1]).toBe(true)
    expect(engine.magic.size).toBe(0)

    // 落子：不再有任何植物长出来（这一手也不成线）
    const placed = engine.commit(cellId(4, 4))
    expect(eventOf(placed, 'magicGrown')).toBeUndefined()
    expect(engine.magic.size).toBe(0)
  })

  it('植物不够 / 不是自己的植物 / 别动别人回合都会拒绝', () => {
    const engine = skillEngine()
    ownPlants(engine, 0, [cellId(4, 4)])
    engine.skillReadyAt[0][0] = 0
    expect(() => engine.useSkill(0, 0, [cellId(0, 0)])).toThrow()
    expect(() => engine.useSkill(0, 0, [cellId(4, 4), cellId(4, 5)])).toThrow()
    engine.current = 1
    expect(() => engine.useSkill(0, 0, [cellId(4, 4)])).toThrow()
  })

  it('loadScenario 能恢复护盾 / 连续行动 / 冷却（回放用）', () => {
    const engine = skillEngine()
    engine.loadScenario(createBoard(), {
      hp: [3, 5],
      shield: [2, 1],
      bonusActions: [1, 0],
      actionsTaken: [7, 7],
      skillReadyAt: [[9, 10], [8, 15]],
      lastPlacedBy: [cellId(4, 4), null],
    })
    expect(engine.shield).toEqual([2, 1])
    expect(engine.bonusActions).toEqual([1, 0])
    expect(engine.skillStateFor(0, 0)?.remaining).toBe(2)
    expect(engine.lastPlacedBy[0]).toBe(cellId(4, 4))
  })
})

// ---------------------------------------------------------------------------
// bugv10 #9：新角色的技能（免疫 / 火球 / 增伤 / 叠子）与 bugv10 #4 的连下两颗
// ---------------------------------------------------------------------------

describe('bugv10 新技能', () => {
  const DEEPSEEK = [
    { id: 'ds-shield', name: '大胃袋', cost: 1, cooldown: 5, effect: 'shield' as const, amount: 1 },
    { id: 'ds-double', name: '杀鲸霸拳', cost: 3, cooldown: 10, effect: 'double' as const, amount: 1 },
  ]
  const GTP = [
    // bugv14：精密计算改成"临时护甲"；bugv15：3 点 → 6 点。用完**不结束回合**
    {
      id: 'gt-immune',
      name: '精密计算',
      cost: 1,
      // bugv12 #3：冷却 10 → 5
      cooldown: 5,
      effect: 'tempArmor' as const,
      amount: 6,
      duration: 2,
    },
    {
      id: 'gt-fireball',
      name: '恶龙吐息',
      // bugv12 #3：消耗 3 → 2、冷却 12 → 6；bugv33：冷却 6 → 12 → 8
      cost: 2,
      cooldown: 8,
      effect: 'fireball' as const,
      amount: 5,
      // bugv32：1 费档只燃火 / max 费档才直击碎子（bugv33 max 3→2，本 describe 的简化镜像）
      variableCost: { min: 1, max: 2, cooldownPerUnit: 0, flatCooldown: true },
      // bugv12 #2：用完**不结束回合**
      targetsCell: true,
    },
  ]
  const GLM = [
    // bugv18 #2：小一哥持续时间 2 → **5 回合**（每次形成连珠再消耗 2 回合，生效期间不能重复释放）
    {
      id: 'gl-power',
      name: '小一哥',
      cost: 1,
      cooldown: 5,
      effect: 'power' as const,
      amount: 1,
      duration: 5,
      // bugv30：不能重复释放改成通用开关（以前写死在 `effect === 'power'` 里）
      noRepeat: true,
    },
    // bugv12 #3 曾降到 1 费；bugv12 #4 回到 2 费（保留"本回合伤害 +1"）
    { id: 'gl-sabotage', name: '毒鸡蛋', cost: 2, cooldown: 10, effect: 'sabotage' as const, amount: 1 },
  ]

  /** 0 号位用 gtp、1 号位用 glm 的引擎。 */
  function newSkillEngine(first: PlayerIndex = 0): GameEngine {
    const engine = new GameEngine({ fixedFirstPlayer: first, initialHp: 6, skills: [GTP, GLM] })
    engine.setFirstPlayer(first)
    engine.takeEvents()
    return engine
  }

  function ownPlants(engine: GameEngine, player: PlayerIndex, cells: readonly number[]): void {
    for (const cell of cells) {
      engine.board[cell] = cellOf(player)
      engine.magic.set(cell, { cell, kind: 'flower', owner: player })
    }
  }

  it('杀鲸霸拳（连下两颗）：第一颗成线也不进入攻击阶段，两颗下完才结算', () => {
    const engine = new GameEngine({ fixedFirstPlayer: 0, skills: [DEEPSEEK, GLM] })
    engine.setFirstPlayer(0)
    engine.takeEvents()
    // 先摆一个 3 连（再补一颗就能连珠），植物放在别处
    engine.board = parseBoard([E, '.RRR.....', E, E, E, E, E, E, E])
    ownPlants(engine, 0, [cellId(8, 0), cellId(8, 2), cellId(8, 4)])
    engine.skillReadyAt[0][1] = 0

    engine.useSkill(0, 1, [cellId(8, 0), cellId(8, 2), cellId(8, 4)])
    expect(engine.bonusActions[0]).toBe(1)
    expect(engine.current).toBe(0)

    // 第一颗子成线：**不**进入攻击阶段（防守方还不能反击）
    const first = engine.commit(cellId(1, 4))
    expect(engine.phase).toBe('playing')
    expect(engine.current).toBe(0)
    expect(engine.bonusActions[0]).toBe(0)
    expect(eventOf(first, 'matchFormed')?.match.owner).toBe(0)
    expect(eventOf(first, 'highlightShown')).toBeUndefined()
    expect(engine.highlightOwner).toBe(null)

    // 第二颗子下完：按最终局面进入攻击阶段
    const second = engine.commit(cellId(8, 8))
    expect(engine.phase).toBe('awaitingDefense')
    expect(engine.highlightOwner).toBe(0)
    expect(eventOf(second, 'highlightShown')?.owner).toBe(0)
    expect(engine.highlights.size).toBeGreaterThanOrEqual(4)
    expect(engine.current).toBe(1)
  })

  it('杀鲸霸拳 2 费档：本回合植物不加伤，冷却仍固定 10（bugv19）', () => {
    const real = skillsOfCharacter('deepseek')
    const build = (cells: number[]) => {
      const engine = new GameEngine({ fixedFirstPlayer: 0, skills: [real, GLM] })
      engine.setFirstPlayer(0)
      engine.takeEvents()
      engine.board = parseBoard([E, '.RRR.....', E, E, E, E, E, E, E])
      // (1,2) 在连珠上 → 会给攻击方加伤；其余三棵是"货币"
      ownPlants(engine, 0, [cellId(1, 2), cellId(8, 0), cellId(8, 2), cellId(8, 4)])
      engine.skillReadyAt[0][1] = 0
      expect(engine.skillCostRange(0, 1)).toEqual([2, 3])
      engine.useSkill(0, 1, cells)
      // 冷却门槛 - 释放那一刻的已行动次数 = 这个档位的冷却
      const cooldown = engine.skillReadyAt[0][1] - engine.actionsTaken[0]
      engine.commit(cellId(1, 4)) // 第一颗：成线，但"连下两颗"要等第二颗
      const events = engine.commit(cellId(8, 8)) // 第二颗：进入攻击阶段
      return { engine, events, cooldown }
    }

    // 2 棵（下限）→ 本回合魔力植物不提供伤害加成
    const cheap = build([cellId(8, 0), cellId(8, 2)])
    expect(cheap.engine.noPlantBonus[0]).toBe(true)
    expect(cheap.engine.attack?.attackerPlants).toBe(1)
    expect(eventOf(cheap.events, 'highlightShown')).toBeDefined()
    expect(cheap.engine.attack?.finalAttack).toBe(4) // 4 颗棋子 + 0（植物被关掉）
    // bugv19：冷却不随消耗变化（flatCooldown）—— 两档都是 10
    expect(cheap.cooldown).toBe(10)

    // 3 棵 → 植物加伤照常
    const full = build([cellId(8, 0), cellId(8, 2), cellId(8, 4)])
    expect(full.engine.noPlantBonus[0]).toBe(false)
    expect(full.engine.attack?.attackerPlants).toBe(1)
    expect(full.engine.attack?.finalAttack).toBe(5) // 4 + 1
    expect(full.cooldown).toBe(10)
  })

  it('精密计算：6 点临时护甲吃掉对手的反击（血量不掉，护甲少 1）', () => {
    const engine = newSkillEngine()
    ownPlants(engine, 0, [cellId(0, 0)])
    engine.skillReadyAt[0][0] = 0
    const events = engine.useSkill(0, 0, [cellId(0, 0)])
    expect(eventOf(events, 'skillUsed')?.effect).toBe('tempArmor')
    expect(engine.tempArmor[0]).toBe(6)
    // 用完**不结束回合**，还是自己走
    expect(engine.current).toBe(0)
    expect(engine.phase).toBe('playing')

    // 本回合发起攻击：P0 补一颗成 4 连（攻击值 4），P1 反手一个 5 连反击（5）
    // → 差值 1 本该打向 P0，被临时护甲吃掉
    engine.board = parseBoard([E, '.RRR.....', E, E, E, E, 'BBBBB....', E])
    engine.current = 0
    engine.commit(cellId(1, 4))
    expect(engine.phase).toBe('awaitingDefense')
    expect(engine.attack?.attacker).toBe(0)
    expect(engine.attack?.finalAttack).toBe(4)
    const resolved = eventOf(engine.defend(cellId(8, 8)), 'attackResolved')
    expect(resolved?.snapshot.defenderAttack).toBe(5)
    expect(resolved?.snapshot.mode).toBe('attackerDamaged')
    expect(resolved?.damage).toBe(1)
    // 1 点伤害被护甲完全吸收：血不掉、护甲 6 → 5
    expect(engine.hp[0]).toBe(6)
    expect(engine.tempArmor[0]).toBe(5)
  })

  it('恶龙吐息：目标位置横竖的空位燃起烈焰，棋子落在上面会碎裂', () => {
    const engine = newSkillEngine()
    ownPlants(engine, 0, [cellId(7, 0), cellId(7, 2), cellId(7, 4)])
    engine.skillReadyAt[0][1] = 0
    // 目标选 (4,4)：整行整列的空位都点上（bugv12 #3：火球 2 费）
    const events = engine.useSkill(0, 1, [cellId(7, 0), cellId(7, 2)], cellId(4, 4))
    const ignited = eventOf(events, 'flamesIgnited')
    expect(ignited?.turns).toBe(5)
    expect(ignited?.cells).toContain(cellId(4, 4))
    expect(ignited?.cells).toContain(cellId(4, 0))
    expect(ignited?.cells).toContain(cellId(0, 4))
    // 整行 9 格 + 整列剩下的 7 格空位（(4,4) 只算一次、(7,4) 上有棋子不算）
    expect(engine.flames.size).toBe(16)
    expect(engine.flames.has(cellId(7, 4))).toBe(false)
    // bugv12 #2：用完**不结束回合**，还是自己的回合（当回合照样可以落子）
    expect(engine.current).toBe(0)
    expect(engine.phase).toBe('playing')

    // 对手在烈焰格上落子：棋子还没成形就碎了，这一手作废
    engine.current = 1
    const shattered = engine.commit(cellId(4, 4))
    expect(eventOf(shattered, 'stoneShattered')?.cell).toBe(cellId(4, 4))
    expect(engine.board[cellId(4, 4)]).toBe(0)
    expect(engine.current).toBe(0)
  })

  it('恶龙吐息：2 费档直击格上的棋子碎裂，该格也会燃起烈焰，且用完**不**结束回合（bugv12 #2 / bugv32 / bugv33）', () => {
    const engine = newSkillEngine()
    ownPlants(engine, 0, [cellId(7, 0), cellId(7, 2)])
    engine.skillReadyAt[0][1] = 0
    // 在 (4,4) 摆一颗 1 号位（glm）的棋子作为直击目标
    engine.board[cellId(4, 4)] = cellOf(1)

    const events = engine.useSkill(0, 1, [cellId(7, 0), cellId(7, 2)], cellId(4, 4))
    // 直击：那颗棋子直接碎裂
    const shattered = eventOf(events, 'stoneShattered')
    expect(shattered?.cell).toBe(cellId(4, 4))
    expect(shattered?.player).toBe(1)
    expect(engine.board[cellId(4, 4)]).toBe(0)
    // 打空之后，这一格自己也进了燃火列表（"也会留下火焰"）
    const ignited = eventOf(events, 'flamesIgnited')
    expect(ignited?.cells).toContain(cellId(4, 4))
    expect(engine.flames.has(cellId(4, 4))).toBe(true)
    // bugv12 #2：用完**不结束回合**，当回合还能继续落子
    expect(engine.current).toBe(0)
    expect(engine.phase).toBe('playing')
    engine.commit(cellId(8, 8))
    expect(engine.current).toBe(1)
  })

  it('小一哥：伤害 +1 持续 5 回合，每形成连珠消耗 2 回合、生效期间不能重复释放（bugv18 #2）', () => {
    const engine = newSkillEngine(1)
    engine.current = 1
    ownPlants(engine, 1, [cellId(0, 0)])
    engine.skillReadyAt[1][0] = 0
    const events = engine.useSkill(1, 0, [cellId(0, 0)])
    expect(eventOf(events, 'powerChanged')?.to).toBe(1)
    expect(engine.current).toBe(1)
    // 记下释放那一刻的到期回合，稍后验证"形成连珠 -2"
    const untilAtCast = engine.powerUntil[1]

    // 摆一个四连（4 颗实体棋子）→ 攻击值应为 4 + 1 = 5
    engine.board = parseBoard([E, '.BBB.....', E, E, E, E, E, E, E])
    engine.current = 1
    engine.commit(cellId(1, 4))
    expect(engine.attack?.baseDamage).toBe(4)
    expect(engine.attack?.finalAttack).toBe(5)
    expect(engine.attack?.powerBonus).toBe(1)
    // 攻击阶段的伤害也带上这一颗
    const resolved = eventOf(engine.defend(cellId(8, 8)), 'attackResolved')
    expect(resolved?.damage).toBe(5)
    expect(engine.hp[0]).toBe(1)

    // bugv18 #2：持续 5 回合，且**每形成一次连珠消耗 2 回合** → 剩余时间少 2，但加成仍在
    expect(engine.powerBonus[1]).toBe(1)
    // 规则 11.2：下一个普通回合由原攻击方开始 → P1 继续行动，加成仍然有效
    expect(engine.current).toBe(1)
    expect(engine.powerBonus[1]).toBe(1)
    // 形成了一次连珠 → 剩余时间正好少 2 回合
    expect(engine.powerUntil[1]).toBe(untilAtCast - 2)
    // 生效期间**不能重复释放**
    ownPlants(engine, 1, [cellId(0, 4)])
    engine.skillReadyAt[1][0] = 0
    expect(() => engine.useSkill(1, 0, [cellId(0, 4)])).toThrow()
  })

  it('毒鸡蛋：可以叠在敌方棋子上，形成连珠且不顶替原棋子', () => {
    const engine = newSkillEngine(1)
    engine.current = 1
    ownPlants(engine, 1, [cellId(0, 0), cellId(0, 2), cellId(0, 4)])
    engine.skillReadyAt[1][1] = 0
    // bugv12 #4：毒鸡蛋 2 费（挑 2 棵），且本回合伤害 +1
    engine.useSkill(1, 1, [cellId(0, 0), cellId(0, 2)])
    expect(engine.sabotage[1]).toBe(true)
    expect(engine.sabotageBonus[1]).toBe(1)

    // 0 号位（R）在 (2,1) 有一颗子，右边三颗是 1 号位（B）的子
    engine.board = parseBoard([E, E, '.RBBB....', E, E, E, E, E, E])
    engine.current = 1
    expect(engine.canStackAt(cellId(2, 1))).toBe(true)
    expect(engine.sabotageTargets(1)).toContain(cellId(2, 1))
    const events = engine.commit(cellId(2, 1))
    expect(eventOf(events, 'stonePlaced')?.stacked).toBe(true)
    // 原棋子没有被顶替
    expect(engine.board[cellId(2, 1)]).toBe(cellOf(0))
    // 连珠成立：叠子飞走（overlay 里已经没有它了），原棋子留下
    const removed = eventOf(events, 'stonesRemoved')
    expect(removed?.kept).toContain(cellId(2, 1))
    expect(removed?.cells).toContain(cellId(2, 2))
    expect(engine.overlay.size).toBe(0)
    expect(engine.board[cellId(2, 1)]).toBe(cellOf(0))
    expect(engine.highlightOwner).toBe(1)
  })

  it('毒鸡蛋：没有能连珠的位置时技能不可用（提示用户）', () => {
    const engine = newSkillEngine(1)
    engine.current = 1
    ownPlants(engine, 1, [cellId(0, 0), cellId(0, 2), cellId(0, 4)])
    engine.skillReadyAt[1][1] = 0
    engine.board = parseBoard([E, 'B........', E, E, E, E, E, E, E])
    const state = engine.skillStateFor(1, 1)
    expect(state?.ready).toBe(false)
    expect(state?.reason).toContain('连珠')
  })

  it('毒鸡蛋：本回合伤害 +1，可与小一哥叠加（bugv12 #3）', () => {
    const engine = newSkillEngine(1)
    engine.current = 1
    ownPlants(engine, 1, [cellId(0, 0), cellId(0, 2), cellId(0, 4)])
    engine.skillReadyAt[1][0] = 0
    engine.skillReadyAt[1][1] = 0
    // 先开小一哥（+1，持续 2 回合），再开毒鸡蛋（+1，仅本回合；2 费）
    engine.useSkill(1, 0, [cellId(0, 0)])
    engine.useSkill(1, 1, [cellId(0, 2), cellId(0, 4)])
    expect(engine.powerBonus[1]).toBe(1)
    expect(engine.sabotageBonus[1]).toBe(1)

    // 四连攻击：4 + 1（小一哥） + 1（毒鸡蛋） = 6
    engine.board = parseBoard([E, '.BBB.....', E, E, E, E, E, E, E])
    engine.current = 1
    engine.commit(cellId(1, 4))
    expect(engine.attack?.baseDamage).toBe(4)
    expect(engine.attack?.finalAttack).toBe(6)
    expect(engine.attack?.powerBonus).toBe(1)
    expect(engine.attack?.sabotageBonus).toBe(1)
    const resolved = eventOf(engine.defend(cellId(8, 8)), 'attackResolved')
    expect(resolved?.damage).toBe(6)
    expect(engine.hp[0]).toBe(0)
  })

  it('指纹把技能状态算进去（护盾 / 烈焰 / 叠子）', () => {
    const engine = newSkillEngine()
    const base = stateDigest({ board: engine.board, hp: engine.hp, phase: engine.phase, current: engine.current })
    const withShield = stateDigest({
      board: engine.board,
      hp: engine.hp,
      phase: engine.phase,
      current: engine.current,
      shield: [1, 0],
    })
    const withFlames = stateDigest({
      board: engine.board,
      hp: engine.hp,
      phase: engine.phase,
      current: engine.current,
      flames: [[cellId(4, 4), 3]],
    })
    const withOverlay = stateDigest({
      board: engine.board,
      hp: engine.hp,
      phase: engine.phase,
      current: engine.current,
      overlay: [[cellId(2, 2), 1]],
    })
    expect(withShield).not.toBe(base)
    expect(withFlames).not.toBe(base)
    expect(withOverlay).not.toBe(base)
    expect(withFlames).not.toBe(withShield)
  })
})

// ---------------------------------------------------------------------------
// bugv11：双子星（两连即可攻击 + 免疫反击）、恶龙吐息（开局可用 / 首次免费 / 会烧完）
// ---------------------------------------------------------------------------

describe('bugv11 技能调整', () => {
  const DEEPSEEK = [
    { id: 'ds-shield', name: '大胃袋', cost: 1, cooldown: 5, effect: 'shield' as const, amount: 1 },
    { id: 'ds-double', name: '杀鲸霸拳', cost: 3, cooldown: 10, effect: 'double' as const, amount: 1 },
  ]
  /** 和 `src/core/characters.ts` 里的 gemini 一致（含两连攻击 / 免疫反击）。 */
  const GEMINI = [
    { id: 'gm-heal', name: '猫的憩息', cost: 1, cooldown: 5, effect: 'heal' as const, amount: 1 },
    { id: 'gm-bloom', name: '双子星', cost: 2, cooldown: 10, effect: 'bloom' as const, amount: 1 },
  ]
  /** 和 `src/core/characters.ts` 里的 gtp 一致（无敌 2 回合 + 开局可用 + 首次免费 + 烧 6 回合、不交回合）。 */
  const GTP = [
    { id: 'gt-immune', name: '精密计算', cost: 1, cooldown: 5, effect: 'immune' as const, amount: 2 },
    {
      id: 'gt-fireball',
      name: '恶龙吐息',
      cost: 2,
      cooldown: 6,
      effect: 'fireball' as const,
      amount: 6,
      targetsCell: true,
      startReady: true,
      freeFirst: true,
    },
  ]

  function ownPlants(engine: GameEngine, player: PlayerIndex, cells: readonly number[]): void {
    for (const cell of cells) {
      engine.board[cell] = cellOf(player)
      engine.magic.set(cell, { cell, kind: 'flower', owner: player })
    }
  }

  it('双子星：本回合形成两连即可发起攻击（bugv11 #5）', () => {
    const engine = new GameEngine({ fixedFirstPlayer: 1, skills: [DEEPSEEK, GEMINI] })
    engine.setFirstPlayer(1)
    engine.takeEvents()
    engine.current = 1
    // 1 号位（gemini）用技能：没有任何植物消耗之外的即时效果
    ownPlants(engine, 1, [cellId(8, 0), cellId(8, 2)])
    engine.skillReadyAt[1][1] = 0
    engine.useSkill(1, 1, [cellId(8, 0), cellId(8, 2)])
    expect(engine.twinStar[1]).toBe(true)

    // 场上只有一颗自己的子，落下第二颗 → **两连**就进入攻击阶段
    engine.board = parseBoard([E, E, E, E, E, E, E, E, E])
    engine.board[cellId(4, 4)] = cellOf(1)
    engine.current = 1
    const events = engine.commit(cellId(4, 5))
    expect(eventOf(events, 'matchFormed')?.match.owner).toBe(1)
    expect(engine.phase).toBe('awaitingDefense')
    expect(engine.highlightOwner).toBe(1)
    expect(engine.attack?.baseDamage).toBe(2)
  })

  it('双子星：只有刚落下的这一格参与两连才算（随便下一手不会白打一次）', () => {
    const engine = new GameEngine({ fixedFirstPlayer: 1, skills: [DEEPSEEK, GEMINI] })
    engine.setFirstPlayer(1)
    engine.takeEvents()
    engine.current = 1
    ownPlants(engine, 1, [cellId(8, 0), cellId(8, 2)])
    engine.skillReadyAt[1][1] = 0
    engine.useSkill(1, 1, [cellId(8, 0), cellId(8, 2)])

    // 远处早就有一对，但落下的这一格和它们不相邻 → 不进入攻击阶段
    engine.board = parseBoard([E, '.BB......', E, E, E, E, E, E, E])
    engine.current = 1
    const events = engine.commit(cellId(7, 7))
    expect(eventOf(events, 'matchFormed')).toBeUndefined()
    expect(engine.phase).toBe('playing')
    // 换手后爆发窗口关闭
    expect(engine.twinStar[1]).toBe(false)
  })

  it('双子星：这一击免疫对手的反击伤害（bugv11 #5）', () => {
    const engine = new GameEngine({ fixedFirstPlayer: 1, skills: [DEEPSEEK, GEMINI] })
    engine.setFirstPlayer(1)
    engine.takeEvents()
    engine.current = 1
    ownPlants(engine, 1, [cellId(8, 0), cellId(8, 2)])
    engine.skillReadyAt[1][1] = 0
    engine.useSkill(1, 1, [cellId(8, 0), cellId(8, 2)])

    // 攻击方两连（基础 2，双子星已经不再附带植物加成），
    // 防守方摆一个 5 连反击（5）→ 正常情况下攻击方要挨 3 点，
    // 但双子星这一击免疫反击伤害
    engine.board = parseBoard(['RRRRR....', E, E, E, E, E, E, E, E])
    engine.board[cellId(4, 4)] = cellOf(1)
    engine.current = 1
    engine.commit(cellId(4, 5))
    expect(engine.phase).toBe('awaitingDefense')
    expect(engine.attack?.attacker).toBe(1)
    expect(engine.attack?.finalAttack).toBe(2)
    const resolved = eventOf(engine.defend(cellId(3, 3)), 'attackResolved')
    expect(resolved?.snapshot.defenderAttack).toBeGreaterThan(resolved?.snapshot.finalAttack ?? 0)
    // 反击更强时受击方是攻击方自己（damaged = 1），但伤害被双子星完全挡下
    expect(resolved?.snapshot.damaged).toBe(1)
    expect(resolved?.snapshot.mode).toBe('immune')
    expect(resolved?.damage).toBe(0)
    expect(engine.hp[1]).toBe(INITIAL_HP)
  })

  it('双子星：本回合成线攻击且对手未成线 → 恢复 1 点血量（bugv18 #2）', () => {
    const engine = new GameEngine({ fixedFirstPlayer: 1, skills: [DEEPSEEK, GEMINI] })
    engine.setFirstPlayer(1)
    engine.takeEvents()
    engine.current = 1
    // 先摆一个 3 连（再补一颗就能成线攻击）
    engine.board = parseBoard([E, '.BBB.....', E, E, E, E, E, E, E])
    ownPlants(engine, 1, [cellId(8, 0), cellId(8, 2)])
    engine.skillReadyAt[1][1] = 0
    engine.useSkill(1, 1, [cellId(8, 0), cellId(8, 2)])
    expect(engine.twinStar[1]).toBe(true)

    // 把双子星打到残血，好观察"恢复 1 点血量"
    engine.hp[1] = 5
    // 成线攻击（4 连），对手（P0）没有可成线的点 → 触发奖励
    engine.current = 1
    engine.commit(cellId(1, 4))
    expect(engine.phase).toBe('awaitingDefense')
    // 对手随便走一步（不成线）→ 结算触发奖励
    engine.defend(cellId(8, 8))
    // bugv18 #2：奖励从"不进冷却 + 下一次消耗 -1"改成 **恢复 1 点血量**
    expect(engine.hp[1]).toBe(6)
    // 冷却照常计算（不再"不进冷却"）
    expect(engine.skillRemaining(1, 1)).toBeGreaterThan(0)
    expect(engine.bloomCheaperNext[1]).toBe(false)
  })

  it('双子星：对手成线反击时不触发奖励（bugv12 #3）', () => {
    const engine = new GameEngine({ fixedFirstPlayer: 1, skills: [DEEPSEEK, GEMINI] })
    engine.setFirstPlayer(1)
    engine.takeEvents()
    engine.current = 1
    // 自己 3 连、对手也 3 连（能反击）
    engine.board = parseBoard([E, '.BBB.....', E, '.RRR.....', E, E, E, E, E])
    ownPlants(engine, 1, [cellId(8, 0), cellId(8, 2)])
    engine.skillReadyAt[1][1] = 0
    engine.useSkill(1, 1, [cellId(8, 0), cellId(8, 2)])
    engine.current = 1
    engine.commit(cellId(1, 4))
    expect(engine.phase).toBe('awaitingDefense')
    // 对手成线反击（4 连）→ 不触发奖励
    engine.defend(cellId(3, 4))
    expect(engine.bloomCheaperNext[1]).toBe(false)
    expect(engine.skillCostNow(1, 1)).toBe(2)
  })

  it('恶龙吐息：开局不进入冷却，而且首次释放不消耗魔力植物（bugv11 #6）', () => {
    const engine = new GameEngine({ fixedFirstPlayer: 0, skills: [GTP, DEEPSEEK] })
    engine.setFirstPlayer(0)
    engine.takeEvents()
    expect(engine.skillReadyAt[0][1]).toBe(0)
    expect(engine.skillStateFor(0, 1)?.ready).toBe(true)
    expect(engine.skillStateFor(0, 1)?.costNow).toBe(0)
    expect(engine.isFirstFree(0, 1)).toBe(true)

    // 一颗植物都没有也能放
    const events = engine.useSkill(0, 1, [], cellId(4, 4))
    expect(eventOf(events, 'flamesIgnited')?.turns).toBe(6)
    expect(engine.flames.size).toBeGreaterThan(0)
    // 第二次按标称消耗收费，并且进入冷却
    expect(engine.isFirstFree(0, 1)).toBe(false)
    const again = engine.skillStateFor(0, 1)
    expect(again?.costNow).toBe(2)
    expect(again?.remaining).toBe(6)
  })

  it('恶龙吐息：6 回合（双方各走一步算 1 回合）之后烈焰全部熄灭（bugv11 #1）', () => {
    const engine = new GameEngine({ fixedFirstPlayer: 0, skills: [GTP, DEEPSEEK] })
    engine.setFirstPlayer(0)
    engine.takeEvents()
    engine.useSkill(0, 1, [], cellId(4, 4))
    expect(engine.flames.size).toBeGreaterThan(0)
    const ignited = [...engine.flames.values()]
    expect(Math.max(...ignited)).toBe(12)

    // 双方各走一步算 1 回合：走满 6 个回合（= 12 个半回合）之后必须全部烧完
    const moves: number[] = []
    for (const col of [0, 1, 2, 3, 5, 6, 7, 8]) moves.push(cellId(8, col))
    for (const col of [0, 1, 2, 3, 5, 6, 7]) moves.push(cellId(7, col))
    let handovers = 0
    for (const cell of moves) {
      if (engine.phase === 'awaitingDefense') engine.defend(cell)
      else engine.commit(cell)
      handovers += 1
      if (engine.flames.size === 0) break
    }
    // 12 个半回合 = 双方各走 6 步（攻击回合会同时消耗攻守两步）
    expect(handovers).toBeLessThanOrEqual(12)
    expect(engine.flames.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// bugv29：GTP 技能口径调整
//   ① 精密计算 → 直到**自己的下个回合结束前**、护甲 = 生命上限（不交回合）
// bugv31：恶龙吐息 → 由"永远结束回合"改成**可变消耗**：
//   2 费档（含首次免费）结束回合；3 费档放完还能继续行动
// ---------------------------------------------------------------------------

describe('bugv29 / bugv31：GTP 的两个技能（精密计算不交回合 / 恶龙吐息按档位交回合）', () => {
  /** 给某一方铺几棵归它的魔力植物（棋子在下面压着才算归属）。 */
  function ownPlants(engine: GameEngine, player: PlayerIndex, cells: readonly number[]): void {
    for (const cell of cells) {
      engine.board[cell] = cellOf(player)
      engine.magic.set(cell, { cell, kind: 'flower', owner: player })
    }
  }

  /** gtp（0 号位）对 deepseek 的一局，已开局。 */
  function gtpTable(): GameEngine {
    const engine = new GameEngine({
      fixedFirstPlayer: 0,
      skills: [skillsOfCharacter('gtp'), skillsOfCharacter('deepseek')],
    })
    engine.setFirstPlayer(0)
    engine.takeEvents()
    return engine
  }

  it('精密计算用完之后还能继续落子', () => {
    const gtp = skillsOfCharacter('gtp')
    const engine = gtpTable()
    engine.board[cellId(0, 0)] = cellOf(0)
    engine.magic.set(cellId(0, 0), { cell: cellId(0, 0), kind: 'flower', owner: 0 })

    // 精密计算：用完之后还是自己走（它开局仍在冷却，这里直接把冷却清掉）
    engine.skillReadyAt[0][0] = 0
    engine.useSkill(0, 0, [cellId(0, 0)])
    // bugv29：护甲 = 生命上限（默认 8）
    expect(engine.tempArmor[0]).toBe(INITIAL_HP)
    expect(engine.current).toBe(0)
    expect(engine.phase).toBe('playing')
    engine.commit(cellId(4, 4))
    expect(engine.current).toBe(1)

    // 技能表：精密计算与恶龙吐息都不再结束回合
    expect(gtp.map((spec) => spec.endsTurn === true)).toEqual([false, false])
    expect(gtp[1].variableCost).toMatchObject({ min: 1, max: 2 })
  })

  it('恶龙吐息：1 费档只燃火不碎子、2 费档才直击碎子，两档都不结束回合（bugv33）', () => {
    // ① 首次免费（按 1 费档）：只燃火、不碎子、不结束回合
    const free = gtpTable()
    free.board[cellId(2, 2)] = cellOf(1) // 目标格有对手棋子
    free.useSkill(0, 1, [], cellId(2, 2))
    expect(free.flames.size).toBeGreaterThan(0)
    expect(free.board[cellId(2, 2)]).toBe(cellOf(1)) // 没碎
    expect(free.current).toBe(0) // 不结束回合
    expect(free.phase).toBe('playing')

    // ② 交 1 棵 → 仍只燃火、不碎子、不结束回合
    const one = gtpTable()
    ownPlants(one, 0, [cellId(0, 0), cellId(0, 1), cellId(0, 2)])
    one.skillCasts[0][1] = 1 // 已经不是"首次免费"
    one.skillReadyAt[0][1] = 0
    one.board[cellId(4, 4)] = cellOf(1)
    one.useSkill(0, 1, [cellId(0, 0)], cellId(4, 4))
    expect(one.board[cellId(4, 4)]).toBe(cellOf(1)) // 没碎
    expect(one.current).toBe(0) // 不结束回合
    expect(one.magic.has(cellId(0, 0))).toBe(false)
    expect(one.magic.has(cellId(0, 2))).toBe(true)

    // ③ 交 2 棵 → 直击碎子 + 燃火；仍不结束回合
    const two = gtpTable()
    ownPlants(two, 0, [cellId(0, 0), cellId(0, 1), cellId(0, 2)])
    two.skillCasts[0][1] = 1
    two.skillReadyAt[0][1] = 0
    two.board[cellId(4, 4)] = cellOf(1)
    two.useSkill(0, 1, [cellId(0, 0), cellId(0, 1)], cellId(4, 4))
    expect(two.board[cellId(4, 4)]).toBe(0) // 碎了
    expect(two.current).toBe(0) // 不结束回合
    expect(two.phase).toBe('playing')
    expect(two.magic.size).toBe(1) // 还剩 1 棵没交
    // 放完还能接着落子（"一二技能连用"的节奏）
    two.commit(cellId(6, 6))
    expect(two.current).toBe(1)
  })

  it('恶龙吐息：首次免费那一手不接受植物消耗', () => {
    const engine = gtpTable()
    ownPlants(engine, 0, [cellId(0, 0), cellId(0, 1), cellId(0, 2)])
    engine.skillReadyAt[0][1] = 0
    expect(() => engine.useSkill(0, 1, [cellId(0, 0)], cellId(2, 2))).toThrow(/首次释放免费/)
    engine.useSkill(0, 1, [], cellId(2, 2))
    expect(engine.magic.size).toBe(3)
  })

  it('恶龙吐息：非首次时消耗数量必须落在 1~2 之间（bugv33）', () => {
    const engine = gtpTable()
    ownPlants(engine, 0, [cellId(0, 0), cellId(0, 1), cellId(0, 2)])
    engine.skillCasts[0][1] = 1
    engine.skillReadyAt[0][1] = 0
    expect(() => engine.useSkill(0, 1, [], cellId(2, 2))).toThrow(/需要选择 1~2 棵/)
    expect(engine.skillCostRange(0, 1)).toEqual([1, 2])
    expect(engine.skillStateFor(0, 1)?.endsTurn).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 1. 连珠检测
// ---------------------------------------------------------------------------

describe('findLines 连珠检测', () => {
  it('识别横向 4 连', () => {
    const board = parseBoard([E, '.RRRR....', E, E, E, E, E, E, E])
    const lines = findLines(board, 0)
    expect(lines).toHaveLength(1)
    expect(lines[0].length).toBe(4)
    expect(lines[0].cells).toEqual([cellId(1, 1), cellId(1, 2), cellId(1, 3), cellId(1, 4)])
  })

  it('识别纵向 5 连为一条极大连珠（不拆成两条 4 连）', () => {
    const board = parseBoard(['..B......', '..B......', '..B......', '..B......', '..B......', E, E, E, E])
    const lines = findLines(board, 1)
    expect(lines).toHaveLength(1)
    expect(lines[0].length).toBe(5)
    expect(lines[0].cells).toHaveLength(5)
  })

  it('识别两条对角线方向', () => {
    const board = parseBoard([
      'R........',
      '.R.......',
      '..R......',
      '...R.....',
      '....B....',
      '...B.....',
      '..B......',
      '.B.......',
      E,
    ])
    expect(findLines(board, 0)[0].cells).toEqual([cellId(0, 0), cellId(1, 1), cellId(2, 2), cellId(3, 3)])
    expect(findLines(board, 1)[0].cells).toEqual([cellId(4, 4), cellId(5, 3), cellId(6, 2), cellId(7, 1)])
  })

  it('长度不足 4 不算连珠', () => {
    const board = parseBoard([E, '.RRR.....', E, E, E, E, E, E, E])
    expect(findLines(board, 0)).toHaveLength(0)
  })

  it('横竖两条 4 连共享交点：连珠总长 8、攻击棋子数 7（规则示例 2）', () => {
    const board = parseBoard(['....R....', '....R....', '....R....', '.RRRR....', E, E, E, E, E])
    const summary = summarizeMatch(board, 0)
    expect(summary.lines).toHaveLength(2)
    expect(summary.lineLengthSum).toBe(8)
    expect(summary.uniqueCount).toBe(7)
    expect(summary.weights.get(cellId(3, 4))).toBe(2)
    expect(summary.weights.get(cellId(0, 4))).toBe(1)
  })

  it('7 连珠 + 4 连珠共享 1 子：连珠总长 11、攻击棋子数 10（规则示例 3）', () => {
    const board = parseBoard(['.RRRRRRR.', '....R....', '....R....', '....R....', E, E, E, E, E])
    const summary = summarizeMatch(board, 0)
    expect(summary.lineLengthSum).toBe(11)
    expect(summary.uniqueCount).toBe(10)
    expect(uniquePieceCells(summary.lines)).toHaveLength(10)
    expect(summary.weights.get(cellId(0, 4))).toBe(2)
  })

  it('工具函数与规则 2.2 / 2.3 / 2.5 / 6.3 一致', () => {
    const lines = findLines(parseBoard([E, '.RRRR....', E, E, E, E, E, E, E]), 0)
    expect(totalLineLength(lines)).toBe(4)
    expect(uniquePieceCount(lines)).toBe(4)
    expect(lineWeightAt(lines, cellId(1, 2))).toBe(1)
    expect(finalAttackValue(4, 1)).toBe(3)
    expect(finalAttackValue(10, 2)).toBe(8)
    expect(damageDiff(3, 4)).toBe(1)
    expect(damageDiff(4, 4)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. 普通回合
// ---------------------------------------------------------------------------

describe('普通回合', () => {
  it('未形成连珠则交换回合', () => {
    const engine = engineFor(0)
    const events = engine.commit(cellId(4, 4))
    expect(engine.current).toBe(1)
    expect(engine.phase).toBe('playing')
    expect(events.map((e) => e.type)).toEqual(['stonePlaced', 'turnStarted'])
  })

  it('形成连珠则进入攻击阶段，连珠棋子被移除并留下高光（规则 4.1）', () => {
    const engine = engineFor(0)
    run(engine, [cellId(0, 0), cellId(8, 8), cellId(0, 1), cellId(8, 7), cellId(0, 2), cellId(8, 6)])
    const events = engine.commit(cellId(0, 3))

    expect(events.map((e) => e.type)).toEqual([
      'stonePlaced',
      'matchFormed',
      'stonesRemoved',
      'highlightShown',
    ])
    expect(engine.phase).toBe('awaitingDefense')
    expect(engine.current).toBe(1)

    for (const cell of [cellId(0, 0), cellId(0, 1), cellId(0, 2), cellId(0, 3)]) {
      expect(engine.board[cell]).toBe(0)
    }
    expect(engine.highlights.size).toBe(4)
    expect([...engine.highlights.values()]).toEqual([1, 1, 1, 1])
    expect(engine.highlightOwner).toBe(0)
    expect(eventOf(events, 'stonesRemoved')).toMatchObject({ player: 0, highlight: true })
    expect(eventOf(events, 'matchFormed')?.match.uniqueCount).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// 2b. bugv14：新角色与新机制
// ---------------------------------------------------------------------------

describe('bugv14：新角色与新机制', () => {
  const CLAUDE = skillsOfCharacter('claude')
  const SEEDANCE = skillsOfCharacter('seedance')
  const GTP = skillsOfCharacter('gtp')
  const DEEPSEEK = skillsOfCharacter('deepseek')
  const GLM = skillsOfCharacter('glm')

  function ownPlants(engine: GameEngine, player: PlayerIndex, cells: readonly number[]): void {
    for (const cell of cells) {
      engine.board[cell] = cellOf(player)
      engine.magic.set(cell, { cell, kind: 'flower', owner: player })
    }
  }

  /** 建一局并指定先手 / 双方技能表。 */
  function table(first: PlayerIndex, skills: [readonly SkillSpec[], readonly SkillSpec[]]): GameEngine {
    const engine = new GameEngine({ fixedFirstPlayer: first, skills })
    engine.setFirstPlayer(first)
    engine.takeEvents()
    return engine
  }

  it('新角色已登记：claude / seedance 各有两个技能，且数值符合设计', () => {
    expect(isCharacterId('claude')).toBe(true)
    expect(isCharacterId('seedance')).toBe(true)
    expect(CLAUDE.map((s) => [s.id, s.effect, s.cost, s.cooldown])).toEqual([
      // bugv30：力大砖飞冷却 6 → 5
      ['cl-first', 'firstStrike', 1, 5],
      ['cl-seed', 'seedGrow', 2, 5],
    ])
    expect(SEEDANCE[0]).toMatchObject({ effect: 'guardShare', cost: 1, cooldown: 5, amount: 2, shareToFoe: 1 })
    expect(SEEDANCE[1]).toMatchObject({ effect: 'assault', variableCost: { min: 1, max: 4, cooldownPerUnit: 4 } })
  })

  it('精密计算：护甲等于生命上限，先于护盾与血量承伤（bugv29）', () => {
    const engine = table(0, [GTP, DEEPSEEK])
    engine.board[cellId(0, 0)] = cellOf(0)
    engine.magic.set(cellId(0, 0), { cell: cellId(0, 0), kind: 'flower', owner: 0 })
    engine.skillReadyAt[0][0] = 0
    const events = engine.useSkill(0, 0, [cellId(0, 0)])
    expect(eventOf(events, 'skillUsed')?.effect).toBe('tempArmor')
    // bugv29：强度 = 生命上限
    expect(engine.tempArmor[0]).toBe(INITIAL_HP)
    expect(engine.shield[0]).toBe(0)

    // 走自己的火来扣血：护甲先扛
    engine.flames.set(cellId(5, 5), 8)
    engine.flameOwner.set(cellId(5, 5), 0)
    engine.commit(cellId(5, 5))
    expect(engine.tempArmor[0]).toBe(INITIAL_HP - 1)
    expect(engine.hp[0]).toBe(INITIAL_HP)
    void events
  })

  it('精密计算：护甲持续到自己的下个回合结束前（bugv29）', () => {
    const engine = table(0, [GTP, DEEPSEEK])
    engine.board[cellId(0, 0)] = cellOf(0)
    engine.magic.set(cellId(0, 0), { cell: cellId(0, 0), kind: 'flower', owner: 0 })
    engine.skillReadyAt[0][0] = 0
    engine.useSkill(0, 0, [cellId(0, 0)])
    expect(engine.tempArmor[0]).toBe(INITIAL_HP)

    // 我走一步 → 对手走一步 → 回到我自己的回合：护甲仍在
    engine.commit(cellId(4, 0))
    expect(engine.current).toBe(1)
    expect(engine.tempArmor[0]).toBe(INITIAL_HP)
    engine.commit(cellId(4, 1))
    expect(engine.current).toBe(0)
    expect(engine.tempArmor[0]).toBe(INITIAL_HP)

    // 我自己的这个回合也走完 → 护甲到期清零
    engine.commit(cellId(4, 2))
    expect(engine.tempArmor[0]).toBe(0)
  })

  it('恶龙吐息：2 费档直击格的棋子碎裂，该格的植物与魔法阵一并消失（bugv17 #5 / bugv32 / bugv33）', () => {
    const engine = table(0, [GTP, DEEPSEEK])
    engine.skillCasts[0][1] = 1 // 非首次，走 2 费档（碎子）
    engine.skillReadyAt[0][1] = 0
    ownPlants(engine, 0, [cellId(7, 0), cellId(7, 2)])
    const target = cellId(4, 4)
    // 目标格：一颗对手棋子 + 压在它上面的一棵植物（归对手）
    engine.board[target] = cellOf(1)
    engine.magic.set(target, { cell: target, kind: 'fern', owner: 1 })
    // 另摆一棵**空位上的**植物：它不该被直击影响
    const bystander = cellId(0, 0)
    engine.magic.set(bystander, { cell: bystander, kind: 'grass', owner: null })

    const events = engine.useSkill(0, 1, [cellId(7, 0), cellId(7, 2)], target)
    expect(eventOf(events, 'stoneShattered')?.cell).toBe(target)
    expect(engine.board[target]).toBe(0)
    // 直击格的植物随棋子一起消失
    expect(eventOf(events, 'magicRemoved')?.cells).toEqual([target])
    expect(engine.magic.has(target)).toBe(false)
    // 无关格子上的植物不受影响
    expect(engine.magic.has(bystander)).toBe(true)
  })

  it('恶龙吐息：整行整列被点着，空位上的魔力植物也被烧掉（bugv18 #1）', () => {
    const engine = table(0, [GTP, DEEPSEEK])
    engine.skillReadyAt[0][1] = 0
    const target = cellId(4, 4)
    // 目标行 / 目标列上各有一棵"空位上的"植物（无主或有主都该被烧掉）
    const onRow = cellId(4, 7)
    const onCol = cellId(1, 4)
    engine.magic.set(onRow, { cell: onRow, kind: 'grass', owner: null })
    engine.magic.set(onCol, { cell: onCol, kind: 'fern', owner: 1 })
    // 既不在行、也不在列上的那棵不受影响
    const outside = cellId(0, 0)
    engine.magic.set(outside, { cell: outside, kind: 'flower', owner: null })

    const events = engine.useSkill(0, 1, [], target)
    const removed = eventOf(events, 'magicRemoved')
    expect(removed?.reason).toBe('flame')
    expect([...(removed?.cells ?? [])].sort((a, b) => a - b)).toEqual(
      [onCol, onRow].sort((a, b) => a - b),
    )
    expect(engine.magic.has(onRow)).toBe(false)
    expect(engine.magic.has(onCol)).toBe(false)
    expect(engine.magic.has(outside)).toBe(true)
  })

  it('恶龙吐息：自己的棋子走在自己的烈焰上不碎裂，只扣 1 点血；对手的棋子照样碎裂', () => {
    const engine = table(0, [GTP, DEEPSEEK])
    // bugv29：恶龙吐息释放后**结束回合**，不能再"先放火、自己再走"。
    // 这里直接铺一片归 0 号位的烈焰来验证"走在火上的结算"。
    const own = cellId(0, 4)
    const foeCell = cellId(0, 3)
    for (const cell of [own, foeCell]) {
      engine.flames.set(cell, 12)
      engine.flameOwner.set(cell, 0)
    }

    // 0 号位走在自己的火上：棋子留下、扣 1 血
    const events = engine.commit(own)
    expect(eventOf(events, 'stoneShattered')).toBeUndefined()
    expect(eventOf(events, 'flameWalked')?.damage).toBe(1)
    expect(engine.board[own]).toBe(cellOf(0))
    expect(engine.hp[0]).toBe(INITIAL_HP - 1)

    // 轮到 1 号位，走在 0 号位的火上 → 碎裂
    expect(engine.current).toBe(1)
    const events2 = engine.commit(foeCell)
    expect(eventOf(events2, 'stoneShattered')?.player).toBe(1)
    expect(engine.board[foeCell]).toBe(0)
  })

  it('力大砖飞（bugv30）：首个连珠攻击伤害 +1，命中后清空对手护盾与临时护甲，生效期间不能重复释放', () => {
    const engine = table(0, [CLAUDE, DEEPSEEK])
    ownPlants(engine, 0, [cellId(8, 0), cellId(8, 2)])
    engine.skillReadyAt[0][0] = 0
    const events = engine.useSkill(0, 0, [cellId(8, 0)])
    expect(eventOf(events, 'skillUsed')?.effect).toBe('firstStrike')
    expect(engine.strikeBonus[0]).toBe(1)

    // 生效期间不能重复释放（把冷却手动清零，单独验这一条闸门）
    engine.skillReadyAt[0][0] = engine.actionsTaken[0]
    expect(engine.skillStateFor(0, 0)?.ready).toBe(false)
    expect(() => engine.useSkill(0, 0, [cellId(8, 2)])).toThrow(/还在生效中/)

    // 摆 3 连 → 补一颗成 4 连攻击（R = 0 号位），对手先攒 3 点护盾 + 8 点临时护甲
    engine.board = parseBoard([E, '.RRR.....', E, E, E, E, E, E, E])
    engine.current = 0
    engine.shield[1] = 3
    // bugv31：破盾也吃临时护甲（gtp「精密计算」那种一整条护甲也会被一击打碎）
    engine.tempArmor[1] = 8
    engine.commit(cellId(1, 4))
    // 基础攻击 = 4 连 + 1（力大砖飞）
    expect(engine.attack?.baseDamage).toBe(5)
    expect(engine.attack?.strikeBonus).toBe(1)
    // bugv30：不再有"对手没成线反击再多 +1"的第二段
    expect(engine.attack?.strikeExtra).toBe(0)
    const attack = engine.attack
    const defense = engine.defend(cellId(8, 8))
    const resolved = eventOf(defense, 'attackResolved')
    expect(resolved?.snapshot.mode).toBe('defenderDamaged')
    // 对手不成线 → 伤害 = 最终攻击值（护甲 / 护盾先替它承伤）
    expect(resolved?.damage).toBe(attack?.finalAttack ?? 0)
    // 成功造成伤害 → 对手的护盾与临时护甲被**全部**移除
    expect(engine.shield[1]).toBe(0)
    expect(engine.tempArmor[1]).toBe(0)
    // 表现层靠这条事件播「镜面破碎」；注意护甲已经先替它挨了这一击（8 → 3），
    // 所以"碎掉"的是**剩下的那部分**，不是当初放下去的那个 8。
    expect(eventOf(defense, 'armorBroken')).toMatchObject({ player: 1, shield: 3, armor: 3 })
    // 用掉之后清零（只对首个连珠攻击生效）
    expect(engine.strikeBonus[0]).toBe(0)
  })

  it('力大砖飞（bugv30）：对手成线反击、且是攻击方自己吃伤害时不破盾', () => {
    const engine = table(0, [CLAUDE, DEEPSEEK])
    ownPlants(engine, 0, [cellId(8, 0)])
    engine.skillReadyAt[0][0] = 0
    engine.useSkill(0, 0, [cellId(8, 0)])
    // 攻击方 4 连（攻击值 = 4 + 1 = 5）；防守方在列 0 攒 6 颗，落 (2,0) 后成 7 连反击（>5）
    engine.board = parseBoard([
      E,
      '.RRR.....',
      E,
      'B........',
      'B........',
      'B........',
      'B........',
      'B........',
      'B........',
    ])
    engine.current = 0
    engine.shield[1] = 3
    engine.commit(cellId(1, 4))
    expect(engine.attack).not.toBeNull()
    // 防守方成线反击且更强 → 由**攻击方**吃伤害
    const resolved = eventOf(engine.defend(cellId(2, 0)), 'attackResolved')
    expect(resolved?.snapshot.mode).toBe('attackerDamaged')
    expect(resolved?.snapshot.damaged).toBe(0)
    // 挨打的是攻击方自己 ⇒ 这一击没打到目标，防守方护盾不受影响
    expect(engine.shield[1]).toBe(3)
  })

  it('布局：2 费；落子未成连珠时，落点九宫格（含落点、含棋子）长出植物（bugv17 #7）', () => {
    const engine = table(0, [CLAUDE, DEEPSEEK])
    // 付账用的两棵植物
    ownPlants(engine, 0, [cellId(8, 0), cellId(8, 1)])
    engine.skillReadyAt[0][1] = 0
    const events = engine.useSkill(0, 1, [cellId(8, 0), cellId(8, 1)])
    expect(eventOf(events, 'skillUsed')?.effect).toBe('seedGrow')
    expect(engine.seedGrow[0]).toBe(true)

    // 九宫格里各摆一颗棋子：落点周围放一颗自己的、一颗对手的
    const center = cellId(4, 4)
    const mine = cellId(3, 3)
    const foe = cellId(5, 5)
    engine.board[mine] = cellOf(0)
    engine.board[foe] = cellOf(1)

    const placed = engine.commit(center)
    const grown = placed.filter((e) => e.type === 'magicGrown') as Array<Extract<GameEvent, { type: 'magicGrown' }>>
    expect(grown.length).toBe(1)
    expect(grown[0].source).toBe('seed')

    const cells = grown[0].plants.map((p) => p.cell).sort((a, b) => a - b)
    const ring: number[] = []
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) ring.push(cellId(4 + dr, 4 + dc))
    }
    // 含落点自身在内的完整九宫格
    expect(cells).toEqual(ring.sort((a, b) => a - b))

    // 归属按"有棋子压着才算归属"派生：落点归我、我的棋子那格归我、对手棋子那格归对手、空格无主
    const ownerAt = (cell: number) => engine.magic.get(cell)?.owner
    expect(ownerAt(center)).toBe(0)
    expect(ownerAt(mine)).toBe(0)
    expect(ownerAt(foe)).toBe(1)
    expect(ownerAt(cellId(4, 5))).toBe(null)
    // 只有被自己棋子压着的那两棵算"自己的植物"
    expect(engine.ownedPlants(0)).toEqual([mine, center].sort((a, b) => a - b))

    // 本回合只触发一次
    expect(engine.seedGrow[0]).toBe(false)
  })

  it('植物归属：连珠植物留到防守方落子后再破坏，归属随棋子走（bugv18 #1/#2）', () => {
    const engine = table(0, [DEEPSEEK, DEEPSEEK])
    // P0 一行 4 连，其中两格压着 P0 的植物 → 攻击宣告时植物随棋子一起消失
    const line = [cellId(2, 0), cellId(2, 1), cellId(2, 2), cellId(2, 3)]
    for (const cell of line.slice(0, 3)) engine.board[cell] = cellOf(0)
    engine.magic.set(line[1], { cell: line[1], kind: 'flower', owner: 0 })
    engine.magic.set(line[2], { cell: line[2], kind: 'grass', owner: 0 })
    engine.magic.set(cellId(0, 0), { cell: cellId(0, 0), kind: 'fern', owner: 0 })

    const placed = engine.commit(cellId(2, 3))
    // bugv18 #1：宣告攻击时植物**不**删 —— 它们是防守方的"抢夺窗口"
    expect(eventOf(placed, 'magicRemoved')).toBeUndefined()
    // 加伤在宣告时锁定：4 颗棋子 + 2 棵植物 = 6
    expect(engine.attack?.attackerPlants).toBe(2)
    expect(engine.attack?.finalAttack).toBe(6)
    expect(engine.magic.has(line[1])).toBe(true)
    expect(engine.magic.has(line[2])).toBe(true)

    // 防守方落子（没落在连珠格上、没抢）→ 加伤不变，随后植物才一同消失
    const defense = engine.defend(cellId(8, 8))
    expect(eventOf(defense, 'attackResolved')?.snapshot.finalAttack).toBe(6)
    expect(eventOf(defense, 'magicRemoved')?.cells).toEqual([line[1], line[2]])
    expect(engine.magic.has(line[1])).toBe(false)
    expect(engine.magic.has(line[2])).toBe(false)
    // 没参与连珠的那棵不受影响
    expect(engine.magic.has(cellId(0, 0))).toBe(true)

    // 毒鸡蛋叠子：把敌方棋子上的植物抢过来
    const engine2 = table(0, [GLM, DEEPSEEK])
    const target = cellId(6, 6)
    engine2.board[target] = cellOf(1)
    engine2.magic.set(target, { cell: target, kind: 'flower', owner: 1 })
    engine2.sabotage[0] = true
    engine2.commit(target)
    expect(engine2.magic.get(target)?.owner).toBe(0)
  })

  it('走自己的烈焰把自己走死：这 1 点先结算，直接死亡、不进攻击阶段（bugv18 #5）', () => {
    const engine = table(0, [GTP, DEEPSEEK])
    // bugv29：恶龙吐息已经结束回合 —— 直接铺火，再让 0 号位踩上去
    const flame = cellId(4, 8)
    engine.flames.set(flame, 12)
    engine.flameOwner.set(flame, 0)
    expect(engine.flames.has(flame)).toBe(true)

    // 摆一个 3 连，第 4 颗正好踩在自己的火上（本来能成线发起攻击）
    for (const c of [5, 6, 7]) engine.board[cellId(4, c)] = cellOf(0)
    engine.hp[0] = 1
    const events = engine.commit(flame)
    expect(eventOf(events, 'flameWalked')?.damage).toBe(1)
    // 归零 → 直接结束，不再进入 awaitingDefense
    expect(engine.phase).toBe('gameOver')
    expect(engine.result?.winner).toBe(1)
  })

  it('猫的憩息：受到伤害后冷却前进 2 手（bugv24，原为"受伤即就绪"）', () => {
    const GEMINI = skillsOfCharacter('gemini')
    const engine = table(0, [GEMINI, DEEPSEEK])
    ownPlants(engine, 0, [cellId(0, 0)])
    engine.skillReadyAt[0][0] = 0
    engine.useSkill(0, 0, [cellId(0, 0)])
    expect(engine.skillRemaining(0, 0)).toBe(5)

    // 受到 1 点伤害（护甲 / 护盾也先吸收；这里直接走内部结算路径）
    const raw = engine as unknown as { applyDamage: (p: PlayerIndex, n: number) => void }
    raw.applyDamage(0, 1)
    expect(engine.hp[0]).toBe(INITIAL_HP - 1)
    // 冷却**前进 2 手**（5 → 3），而不是清零
    expect(engine.skillRemaining(0, 0)).toBe(3)
    expect(engine.skillStateFor(0, 0)?.remaining).toBe(3)

    // 冷却没走完 → 即使有植物也不能放
    ownPlants(engine, 0, [cellId(0, 2)])
    expect(engine.skillStateFor(0, 0)?.ready).toBe(false)

    // 再挨两下（累计前进 6 手 ≥ 冷却 5）→ 才就绪
    raw.applyDamage(0, 1)
    raw.applyDamage(0, 1)
    expect(engine.skillRemaining(0, 0)).toBe(0)
    expect(engine.skillStateFor(0, 0)?.ready).toBe(true)
  })

  it('稳稳的接住你：自己 +2 护盾、对手 +1 护盾', () => {
    const engine = table(0, [SEEDANCE, DEEPSEEK])
    ownPlants(engine, 0, [cellId(8, 0)])
    engine.skillReadyAt[0][0] = 0
    const events = engine.useSkill(0, 0, [cellId(8, 0)])
    expect(eventOf(events, 'skillUsed')?.effect).toBe('guardShare')
    expect(engine.shield[0]).toBe(2)
    expect(engine.shield[1]).toBe(1)
  })

  it('最直接、最不绕弯子：直接进入攻击阶段，攻击值 = 消耗的植物数，冷却 = 4 × 消耗', () => {
    const engine = table(0, [SEEDANCE, DEEPSEEK])
    ownPlants(engine, 0, [cellId(8, 0), cellId(8, 1), cellId(8, 2), cellId(8, 3)])
    engine.skillReadyAt[0][1] = 0
    const state = engine.skillStateFor(0, 1)
    expect(state?.costMin).toBe(1)
    expect(state?.costMax).toBe(4)

    const events = engine.useSkill(0, 1, [cellId(8, 0), cellId(8, 1), cellId(8, 2)])
    expect(eventOf(events, 'skillUsed')?.effect).toBe('assault')
    // 直接进入攻击阶段，攻击方还是 0 号位，防守方是 1 号位
    expect(engine.phase).toBe('awaitingDefense')
    expect(engine.attack?.attacker).toBe(0)
    expect(engine.attack?.baseDamage).toBe(3)
    // 没有连珠棋子
    expect(engine.highlights.size).toBe(0)
    // 冷却 = 4 × 3 = 12
    expect(engine.skillRemaining(0, 1)).toBe(12)

    // 对手不成线 → 直接吃 3 点
    const resolved = eventOf(engine.defend(cellId(0, 0)), 'attackResolved')
    expect(resolved?.damage).toBe(3)
    expect(engine.hp[1]).toBe(INITIAL_HP - 3)
    // 攻击阶段结束后回合回到攻击方
    expect(engine.phase).toBe('playing')
    expect(engine.current).toBe(0)
  })

  it('可变消耗的"显示区间"恒为标称值，不随场上植物数收缩（bugv27 #3）', () => {
    // 场上只给 2 棵：UI 仍要显示 `2~3` / `1~4`，而不是被压成 `2` / `1~2`
    const dual = table(0, [DEEPSEEK, GLM])
    ownPlants(dual, 0, [cellId(8, 0), cellId(8, 1)])
    expect(dual.skillStateFor(0, 1)?.costMin).toBe(2)
    expect(dual.skillStateFor(0, 1)?.costMax).toBe(3)

    const assault = table(0, [SEEDANCE, GLM])
    ownPlants(assault, 0, [cellId(8, 0), cellId(8, 1)])
    expect(assault.skillStateFor(0, 1)?.costMin).toBe(1)
    expect(assault.skillStateFor(0, 1)?.costMax).toBe(4)

    // 只有 1 棵时还是一样（`costNow` 仍是下限，用来卡"够不够放"）
    const one = table(0, [SEEDANCE, GLM])
    ownPlants(one, 0, [cellId(8, 0)])
    expect(one.skillStateFor(0, 1)?.costMax).toBe(4)
    expect(one.skillStateFor(0, 1)?.costNow).toBe(1)
  })

  it('非可变消耗技能不显示区间（costMin/costMax 为 null）', () => {
    const engine = table(0, [GLM, DEEPSEEK])
    ownPlants(engine, 0, [cellId(8, 0), cellId(8, 1)])
    const sabotage = engine.skillStateFor(0, 1)
    expect(sabotage?.costNow).toBe(2)
    expect(sabotage?.costMin).toBeNull()
    expect(sabotage?.costMax).toBeNull()
  })

  it('护盾上限 = 血量上限：叠满之后再加不再增长（bugv16）', () => {
    const engine = table(0, [SEEDANCE, DEEPSEEK])
    const cells = [
      cellId(8, 0),
      cellId(8, 1),
      cellId(8, 2),
      cellId(8, 3),
      cellId(8, 4),
      cellId(8, 5),
      cellId(8, 6),
      cellId(8, 7),
    ]
    ownPlants(engine, 0, cells)
    // 「稳稳的接住你」自己 +2
    engine.skillReadyAt[0][0] = 0
    engine.useSkill(0, 0, [cells[0]])
    expect(engine.shield[0]).toBe(2)

    // 反复叠加：每放一次 +2，但**不超过血量上限**
    for (const cell of cells.slice(1)) {
      engine.skillReadyAt[0][0] = 0
      engine.useSkill(0, 0, [cell])
    }
    // 8 次 × 2 = 16 点 > INITIAL_HP，被上限卡在 INITIAL_HP
    expect(engine.shield[0]).toBe(INITIAL_HP)
  })

})

// ---------------------------------------------------------------------------
// 3. 攻击阶段：占位削弱（规则 4.2 / 5）
// ---------------------------------------------------------------------------

describe('攻击阶段：占位削弱与伤害', () => {
  it('防守方下在高光位：削弱 1，最终攻击值 3（规则示例 1）', () => {
    const engine = engineFor(0)
    run(engine, [cellId(0, 1), cellId(8, 8), cellId(0, 2), cellId(8, 7), cellId(0, 3), cellId(8, 6)])
    engine.commit(cellId(0, 4)) // 横向 4 连 (0,1)-(0,4)

    const events = engine.defend(cellId(0, 1))
    const resolved = eventOf(events, 'attackResolved')
    expect(resolved).toBeDefined()
    expect(resolved?.damage).toBe(3)
    expect(resolved?.clashCount).toBe(0)
    expect(resolved?.snapshot).toMatchObject({
      baseDamage: 4,
      weakness: 1,
      finalAttack: 3,
      defenderAttack: 0,
      mode: 'defenderDamaged',
      damaged: 1,
    })
    expect(engine.hp).toEqual([6, 3])
    // 防守棋子留在棋盘（规则 5.4）
    expect(engine.board[cellId(0, 1)]).toBe(2)
    // 高光清除、环境恢复、由原攻击方开始下一回合（规则 6.3 收尾 / 11.2）
    expect(engine.highlights.size).toBe(0)
    expect(engine.phase).toBe('playing')
    expect(engine.current).toBe(0)
    expect(eventOf(events, 'highlightsCleared')).toBeDefined()
  })

  it('防守方下在非高光位：不削弱，受到 4 点伤害', () => {
    const engine = engineFor(0)
    run(engine, [cellId(0, 1), cellId(8, 8), cellId(0, 2), cellId(8, 7), cellId(0, 3), cellId(8, 6)])
    engine.commit(cellId(0, 4))
    const events = engine.defend(cellId(4, 4))
    expect(eventOf(events, 'attackResolved')?.snapshot).toMatchObject({ weakness: 0, finalAttack: 4 })
    expect(engine.hp).toEqual([6, 2])
    expect(engine.board[cellId(4, 4)]).toBe(2)
  })

  it('共享交点高光削弱 2：攻击值 7 -> 5（规则示例 2）', () => {
    const board = parseBoard(['....R....', '....R....', '....R....', '...RRRR..', E, E, E, E, E])
    const engine = engineFor(0)
    engine.loadScenario(board, { phase: 'awaitingDefense', attacker: 0, hp: [6, 6] })

    expect(engine.phase).toBe('awaitingDefense')
    expect(engine.highlights.get(cellId(3, 4))).toBe(2)
    expect(engine.highlights.size).toBe(7)
    // 攻击方棋子已被移除
    expect(engine.board[cellId(3, 4)]).toBe(0)

    const events = engine.defend(cellId(3, 4))
    expect(eventOf(events, 'attackResolved')?.snapshot).toMatchObject({
      baseDamage: 7,
      lineLengthSum: 8,
      weakness: 2,
      finalAttack: 5,
      defenderAttack: 0,
    })
    expect(engine.hp).toEqual([6, 1])
  })
})

// ---------------------------------------------------------------------------
// 4. 抵消（规则 6）
// ---------------------------------------------------------------------------

describe('防守方形成连珠与抵消', () => {
  /**
   * 局面：
   *  - 先手（R）第 8 行横铺 4 连，攻击值 4。
   *  - 后手（B）第 1~3 行 column 4 有 3 子，在高光位 (0,4) 落子可成 4 连。
   */
  function clashBoard(): Board {
    return parseBoard([
      '.........',
      '....B....',
      '....B....',
      '....B....',
      E,
      E,
      E,
      E,
      'RRRR.....',
    ])
  }

  it('防守方在高光位成线（4 vs 4 抵消，无伤害）', () => {
    const engine = engineFor(0)
    engine.loadScenario(clashBoard(), { phase: 'awaitingDefense', attacker: 0, hp: [6, 6] })
    const events = engine.defend(cellId(0, 4))

    expect(eventOf(events, 'matchFormed')?.match.owner).toBe(1)
    const resolved = eventOf(events, 'attackResolved')
    expect(resolved?.snapshot).toMatchObject({
      baseDamage: 4,
      weakness: 0,
      finalAttack: 4,
      defenderAttack: 4,
      diff: 0,
      mode: 'canceled',
      damaged: null,
    })
    expect(resolved?.clashCount).toBe(4)
    expect(resolved?.damage).toBe(0)
    expect(engine.hp).toEqual([6, 6])
    // 防守方连珠棋子被移除且不留下高光（规则 6.1）
    for (const cell of [cellId(0, 4), cellId(1, 4), cellId(2, 4), cellId(3, 4)]) {
      expect(engine.board[cell]).toBe(0)
    }
    expect(engine.highlights.size).toBe(0)
    expect(engine.current).toBe(0)
  })

  it('防守方成线且数值相等时双方均无伤害', () => {
    // B 的 column 4 三子位于第 4~6 行，(3,4) 是成线点且为普通空位
    const board = parseBoard([
      E,
      E,
      E,
      E,
      '....B....',
      '....B....',
      '....B....',
      E,
      'RRRR.....',
    ])
    const engine = engineFor(0)
    engine.loadScenario(board, { phase: 'awaitingDefense', attacker: 0, hp: [6, 6] })
    const events = engine.defend(cellId(3, 4))
    const resolved = eventOf(events, 'attackResolved')
    expect(resolved?.snapshot).toMatchObject({
      baseDamage: 4,
      weakness: 0,
      finalAttack: 4,
      defenderAttack: 4,
      diff: 0,
      mode: 'canceled',
      damaged: null,
    })
    expect(resolved?.clashCount).toBe(4)
    expect(resolved?.damage).toBe(0)
    expect(engine.hp).toEqual([6, 6])
  })

  it('防守方反击值更高时攻击方受到差值伤害（规则 6.3）', () => {
    const board = parseBoard([
      E,
      '....B....',
      '....B....',
      '....B....',
      '....B....',
      '....B....',
      E,
      E,
      'RRRR.....',
    ])
    const engine = engineFor(0)
    engine.loadScenario(board, { phase: 'awaitingDefense', attacker: 0, hp: [6, 6] })
    const events = engine.defend(cellId(0, 4))
    const resolved = eventOf(events, 'attackResolved')
    // 攻击方最终攻击值 4（非高光位），防守方 6 连 -> 攻击方受伤 2
    expect(resolved?.snapshot).toMatchObject({ weakness: 0, finalAttack: 4, defenderAttack: 6, diff: 2, damaged: 0 })
    expect(engine.hp).toEqual([4, 6])
  })
})

// ---------------------------------------------------------------------------
// 5. 血量与胜负（规则 7 / 8）
// ---------------------------------------------------------------------------

describe('血量与胜负', () => {
  it('伤害可以超过血量并显示负数，结算后判负', () => {
    const engine = engineFor(0, 2)
    run(engine, [cellId(0, 0), cellId(8, 8), cellId(0, 1), cellId(8, 7), cellId(0, 2), cellId(8, 6)])
    engine.commit(cellId(0, 3))
    const events = engine.defend(cellId(4, 4))

    expect(engine.hp).toEqual([2, -2])
    expect(engine.phase).toBe('gameOver')
    expect(engine.result).toMatchObject({ winner: 0, reason: 'hp' })
    expect(eventOf(events, 'hpChanged')).toMatchObject({ player: 1, from: 2, to: -2, hits: 4 })
    expect(eventOf(events, 'gameOver')?.result.hp).toEqual([2, -2])
  })

  it('棋盘下满且血量相同判平局', () => {
    const board = fullBoardExceptOne()
    const engine = engineFor(0)
    engine.loadScenario(board, { hp: [6, 6], current: 0 })
    engine.commit(cellId(8, 8))
    expect(engine.isBoardFull()).toBe(true)
    expect(engine.phase).toBe('gameOver')
    expect(engine.result).toMatchObject({ winner: null, reason: 'boardFull' })
  })

  it('棋盘下满时血多者获胜', () => {
    const board = fullBoardExceptOne()
    const engine = engineFor(0)
    engine.loadScenario(board, { hp: [5, 3], current: 0 })
    engine.commit(cellId(8, 8))
    expect(engine.result).toMatchObject({ winner: 0, reason: 'boardFull' })
  })

  it('攻击阶段结束前不判负，结算完成后才结束对局', () => {
    // R 攻击值 4 全被 B 的 4 连抵消，双方均无伤害 —— 不会结束对局
    const board = parseBoard([E, '....B....', '....B....', '....B....', E, E, E, E, 'RRRR.....'])
    const engine = engineFor(0, 1)
    engine.loadScenario(board, { phase: 'awaitingDefense', attacker: 0, hp: [1, 6] })
    expect(engine.phase).toBe('awaitingDefense')
    expect(engine.isOver).toBe(false)
    engine.defend(cellId(0, 4))
    expect(engine.isOver).toBe(false)
    expect(engine.hp).toEqual([1, 6])

    // 换一个没有反击的局面：R 的 4 连直接打死对手
    const lethal = parseBoard([
      E,
      '....B....',
      '....B....',
      '....B....',
      E,
      E,
      E,
      E,
      'RRRR.....',
    ])
    const engine2 = engineFor(0)
    engine2.loadScenario(lethal, { phase: 'awaitingDefense', attacker: 0, hp: [6, 1] })
    engine2.defend(cellId(8, 8))
    expect(engine2.isOver).toBe(true)
    expect(engine2.result).toMatchObject({ winner: 0, reason: 'hp' })
    expect(engine2.hp).toEqual([6, -3])
  })
})

/**
 * 构造一个铺满除 (8,8) 以外所有格子的棋盘，且不存在任何 4 连。
 * 图案：2 列分块交错叠加行奇偶，任意方向的连续 4 格都不会同色。
 */
function fullBoardExceptOne(): Board {
  const board = createBoard()
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (r === 8 && c === 8) continue
      board[cellId(r, c)] = ((Math.floor(c / 2) + r) % 2 === 0 ? 1 : 2) as 1 | 2
    }
  }
  expect(board.filter((cell) => cell === 0)).toHaveLength(1)
  expect(findLines(board, 0)).toHaveLength(0)
  expect(findLines(board, 1)).toHaveLength(0)
  return board
}

// ---------------------------------------------------------------------------
// 6. 连续攻击 / 高光生命周期 / 开局
// ---------------------------------------------------------------------------

describe('连续攻击、高光与开局', () => {
  it('攻击结束后由原攻击方继续，允许连续攻击（规则 8.3 / 11.3）', () => {
    const engine = engineFor(0)
    run(engine, [cellId(0, 0), cellId(8, 0), cellId(0, 1), cellId(8, 1), cellId(0, 2), cellId(8, 2)])
    engine.commit(cellId(0, 3))
    engine.defend(cellId(4, 4))

    expect(engine.current).toBe(0)
    expect(engine.phase).toBe('playing')
    // 原连珠位置成为空位，可再次落子
    expect(engine.isEmpty(0, 0)).toBe(true)
    const events = engine.commit(cellId(0, 0))
    expect(events[0]).toMatchObject({ type: 'stonePlaced', player: 0, cell: cellId(0, 0) })
  })

  it('高光在结算后清除，且高光位置在攻击阶段可以落子（规则 4.1.5）', () => {
    const engine = engineFor(0)
    run(engine, [cellId(0, 0), cellId(8, 0), cellId(0, 1), cellId(8, 1), cellId(0, 2), cellId(8, 2)])
    engine.commit(cellId(0, 3))
    expect(engine.highlights.size).toBe(4)
    expect(engine.canPlaceAt(cellId(0, 0))).toBe(true)
    engine.defend(cellId(4, 4))
    expect(engine.highlights.size).toBe(0)
    expect(engine.highlightOwner).toBeNull()
  })

  it('掷骰子决定先后手（规则 11.1）', () => {
    const engine = new GameEngine({ seed: 20261004 })
    const dice = eventOf(engine.takeEvents(), 'diceRolled')
    expect(dice).toBeDefined()
    expect(engine.phase).toBe('playing')
    expect(engine.current).toBe(engine.firstPlayer)
    expect(dice?.first).toBe(engine.firstPlayer)
  })

  it('非法操作会抛出异常', () => {
    const engine = engineFor(0)
    engine.commit(cellId(0, 0))
    expect(() => engine.commit(cellId(0, 0))).toThrow()
    expect(() => engine.defend(cellId(1, 1))).toThrow()
  })

  it('一整局流程可以完整推进到结束（无异常、无死循环）', () => {
    const engine = new GameEngine({ seed: 7, initialHp: 6 })
    engine.takeEvents()
    let guard = 0
    while (!engine.isOver && guard++ < 400) {
      const cells = engine.emptyCells()
      if (cells.length === 0) break
      const player = engine.current
      // 选择第一个能成线的位置（否则取中心附近）
      const winning = cells.find((cell) => {
        const probe = engine.board.slice()
        probe[cell] = (player + 1) as 1 | 2
        return findLines(probe, player).length > 0
      })
      const move = winning ?? cells[Math.floor(cells.length / 2)]
      if (engine.awaitingDefense) engine.defend(move)
      else engine.commit(move)
    }
    expect(guard).toBeLessThan(400)
    expect(engine.phase === 'gameOver' || engine.emptyCells().length === 0).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 7. 基准 AI
// ---------------------------------------------------------------------------

describe('基准 AI', () => {
  it('能抓住一步成线的机会（对手挡不住时，成线即击杀）', async () => {
    const { decideMove } = await import('../src/ai/baseline')
    // ⚠️ bugv13 #1：这条断言以前用的是"双方各有一个三连"的局面（P0 `.RRR` + P1 `.BBB`），
    // 断言 AI 必须去补成 4 连。但真实引擎裁决说明那样**会输**：
    //   · 去成线 → 攻击值 4，而对手用同一个三连反击成 4 → 完全抵消（伤害 0），
    //     自己白白清掉 4 颗子 → 实测 P1 胜（两档预算、两个成线点都是 P1 胜）；
    //   · 改成下天元 (4,4) → 实测 P0 胜。
    // 也就是说「能成线就必须成线」是五子棋直觉，在本作里不成立（攻击会被反击抵消）。
    // （旁证：同文件「小一哥」那条因为多了 +2 攻击加成，4+2 > 反击 4，成线才变成正着。）
    //
    // 所以这里换成一个**无争议**的局面：对手没有任何能反击的线，成线即击杀（对手只有 1 血）。
    const board = parseBoard([E, '.RRR.....', E, '.B.......', E, E, E, E, '.B.......'])
    // 固定深度 + 放宽时间：时间受限的搜索会因机器负载落到不同深度、给出不同着法。
    const decision = decideMove({
      board,
      player: 0,
      selfHp: 6,
      opponentHp: 1,
      mode: 'attack',
      difficulty: 'normal',
      timeLimitMs: 4000,
      maxDepth: 5,
    })
    // 两种补法都成 4 连；攻击值 4 ≥ 对手 1 血 → 一步带走。
    expect([cellId(1, 0), cellId(1, 4)]).toContain(decision.move)
    // 而且搜索必须**认出这是胜**（而不是随便挑一个"还不错的"着法）。
    expect(decision.score).toBeGreaterThan(9_000_000)
  })

  it('无成线机会时不会走出崩盘着法（对手活三挡不住，「必须挡」是五子棋直觉）', async () => {
    const { decideMove } = await import('../src/ai/baseline')
    const board = parseBoard([E, E, '.BBB.....', E, E, E, E, '..R......', E])
    // 固定深度让结果确定（时间受限的搜索会因机器负载落到不同深度、给出不同着法）。
    const decision = decideMove({
      board,
      player: 0,
      selfHp: 6,
      opponentHp: 6,
      mode: 'attack',
      difficulty: 'normal',
      timeLimitMs: 5000,
      maxDepth: 4,
    })
    // B 是"活三"（两端都空）：挡一端挡不住 —— 另一端照样能补成 4 并发起攻击。
    // 所以"必须去挡"是五子棋直觉，不是本作的硬性要求（本作里挡下的子很快又会被清掉）。
    // 用真实 GameEngine 裁决（`scripts/check-position.ts`，每步 60ms 自对弈）：
    //   18 / 22 / 40 / 64 / 66 都能赢，只有 57 会输。
    // 因此这里只要求 AI 落在"已裁决为不亏"的着法里，不必死锁在某一种思路。
    expect([cellId(2, 0), cellId(2, 4), cellId(4, 4), cellId(7, 1), cellId(7, 3)]).toContain(
      decision.move,
    )
  })

  it('防守阶段会以“净伤害最小”为目标落子（规则 4.2 的削弱 / 规则 6 的抵消）', async () => {
    const { decideMove } = await import('../src/ai/baseline')
    const engine = engineFor(0)
    run(engine, [cellId(0, 0), cellId(8, 0), cellId(0, 1), cellId(8, 1), cellId(0, 2), cellId(8, 2)])
    engine.commit(cellId(0, 3))
    expect(engine.awaitingDefense).toBe(true)

    const decision = decideMove({
      board: engine.board,
      player: 1,
      selfHp: 6,
      opponentHp: 6,
      mode: 'defend',
      highlightWeights: engine.highlights,
      difficulty: 'normal',
    })

    // 决策必须落在“削弱高光”或“自己成线抵消”这两类要点上
    const highlights = [cellId(0, 0), cellId(0, 1), cellId(0, 2), cellId(0, 3)]
    const ownLine = [cellId(8, 3)]
    expect([...highlights, ...ownLine]).toContain(decision.move)

    // 实际执行该决策，验证防守方不受伤（攻击方 4 连 vs 防守方 4 连抵消）
    const events = engine.defend(decision.move)
    expect(eventOf(events, 'attackResolved')?.damage).toBe(0)
    expect(engine.hp).toEqual([6, 6])
  })

  // -------------------------------------------------------------------------
  // bugv13 #1：叶子层缺 stand-pat → "被迫攻击"造出假必胜
  //
  // 症状来自一局实机回放：AI 明明 6 血打对手 2 血，却整局乱走、40 次成线机会只用了 1 次。
  // 根因：叶子层（quiesce）只用 `collectAttackCells` 展开"成线着法"，
  // 等于把当前行动方**强行**变成"必须攻击"；而本作里攻击会把**反击机会**交给对手
  // （对手成线就抵消、差值反打），所以"被迫攻击"经常是亏的 —— 血量领先的一方
  // 因此在叶子层凭空拿到"必胜"。实测同一局面：奇数深度下**全部着法并列同一个必胜分**
  // （`WIN − 4`，正好是 `QUIESCE_LIMIT = 4`），偶数深度却是普通分 → 选点随深度来回翻转。
  //
  // 修法：叶子层加 **stand-pat**（允许"不动、保持静态评估"）。
  // -------------------------------------------------------------------------

  it('叶子层不会造出假必胜：同一局面各深度的候选分数一致、且不出现凭空"必胜"（bugv13 #1）', async () => {
    const { debugRootScores } = await import('../src/ai/baseline')
    // 取自实机回放第 79 手：P0（玩家）2 血 / P1（AI）6 血，P1 走，
    // 场上有 3 棵植物（c38 归 P0、c36 与 c60 中立）。
    // ⚠️ 这个局面 AI **并非**必胜：枚举 P0 的全部应对后，攻击 c49 会撞上 7/38 种有效防守
    //   （6 种反击成线 → 伤害完全抵消，1 种反打 AI 3 点），所以"全体着法必胜"是假的。
    const board = parseBoardString(
      '212122012222110221221201110000000010001021021010100011200220012210122001000011000',
    )
    const magic = {
      plants: [
        [38, 0],
        [36, null],
        [60, null],
      ] as ReadonlyArray<readonly [number, PlayerIndex | null]>,
      damagePerPlant: 1,
    }
    for (const depth of [1, 2, 3, 4]) {
      const scores = debugRootScores(board, [2, 6], 1, depth, 'attack', undefined, magic, null)
      expect(scores.length).toBeGreaterThan(1)
      // ① 不能出现"必胜"分（`WIN = 10_000_000` 量级）
      for (const entry of scores) expect(Math.abs(entry.score)).toBeLessThan(9_000_000)
      // ② 更不能整盘并列（并列 = 搜索放弃了比较，选点会退化成"按着法顺序随手挑"）
      const first = scores[0].score
      expect(scores.some((entry) => entry.score !== first)).toBe(true)
    }
  })

  it('会去认领棋盘上的魔力植物（候选集不能把植物格剪掉，bugv13 #3）', async () => {
    const { decideMove } = await import('../src/ai/baseline')
    const board = parseBoardString(
      '212122012222110221221201110000000010001021021010100011200220012210122001000011000',
    )
    // 用户报的实机回放里：全场长了 12 棵植物，玩家认领 9 棵、**AI 一棵都没拿到**，
    // 于是 gemini 那两个"1 费 / 2 费"的技能全程放不出来（`skillUsed` 事件 0 个）。
    // 根因：候选集只按"战术窗口 + 贴近棋子 + 毒鸡蛋目标"定优先级，**没有植物格** ——
    // 植物离棋子稍远就在进入评估之前被 `slice(0, limit)` 剪掉，`PLANT_VALUE` 再高也没用。
    const magic = {
      plants: [
        [38, 0],
        [36, null],
        [60, null],
      ] as ReadonlyArray<readonly [number, PlayerIndex | null]>,
      damagePerPlant: 1,
    }
    // 固定深度 + 小预算：只要搜索认得这棵植物就够，不必跑满时间
    // （⚠️ 各档预算之和必须留在 vitest 的 5s 默认超时之内）。
    for (const maxDepth of [2, 3]) {
      const decision = decideMove({
        board,
        player: 1,
        selfHp: 6,
        opponentHp: 2,
        mode: 'attack',
        difficulty: 'normal',
        maxDepth,
        timeLimitMs: 900,
        magic,
      })
      // c36 / c60 是中立植物：落上去就归自己（技能货币 + 连珠加伤）
      expect([cellId(4, 0) /* 36 */, cellId(6, 6) /* 60 */]).toContain(decision.move)
    }
  })

  it('防守搜索看得到技能状态（护盾先于血量承伤，bugv13 #2）', async () => {
    const { debugRootScores } = await import('../src/ai/baseline')
    const { GameEngine } = await import('../src/core/engine')
    const { skillsOfCharacter } = await import('../src/core/characters')
    // 实机 AI 的对局走 `useConnectGame.playAiMove()`；它的**防守分支**曾经只传 `magic`、
    // 不传 `skills`，于是防守搜索里护盾 / 增伤 / 无敌全按 0 算 → 误判来袭伤害。
    // （本测试直接钉住"搜索确实消费技能状态"这一条契约。）
    const specs = [skillsOfCharacter('deepseek'), skillsOfCharacter('gemini')] as const
    const board = parseBoard([E, '.RRR.....', E, E, E, E, E, E, E])
    const engine = new GameEngine({ fixedFirstPlayer: 0, initialHp: 6, skills: [specs[0], specs[1]] })
    engine.loadScenario(board, { hp: [6, 2], current: 0, firstPlayer: 0 })
    engine.takeEvents()
    engine.commit(cellId(1, 4)) // P0 成线攻击 4，轮到 P1（2 血）防守

    const skillCtx = (shield: number) => ({
      skills: [specs[0], specs[1]] as const,
      shield: [0, shield] as [number, number],
      actionsTaken: [1, 0] as [number, number],
      turnNo: 1,
    })
    const best = (shield: number) => {
      const scores = debugRootScores(
        engine.board,
        [6, 2],
        1,
        3,
        'defend',
        engine.highlights,
        null,
        skillCtx(shield),
      )
      return [...scores].sort((a, b) => b.score - a.score)[0].score
    }
    // 攻击 4 打 2 血：没护盾必死；护盾 ≥2 就能活下来 → 分数必须明显更好
    expect(best(0)).toBeLessThan(-9_000_000)
    expect(best(2)).toBeGreaterThan(-9_000_000)
    expect(best(3)).toBeGreaterThan(best(2))
  })

  it('返回合法位置且思考时间在预算内', async () => {
    const { decideMove } = await import('../src/ai/baseline')
    const board = createBoard()
    board[cellId(4, 4)] = 1
    board[cellId(4, 5)] = 2
    const decision = decideMove({ board, player: 0, selfHp: 6, opponentHp: 6, mode: 'attack', difficulty: 'hard' })
    expect(board[decision.move]).toBe(0)
    expect(decision.elapsedMs).toBeLessThan(2000)
  })

  it('空棋盘返回 -1', async () => {
    const { decideMove } = await import('../src/ai/baseline')
    const board = createBoard().map(() => 1) as Board
    const decision = decideMove({ board, player: 0, selfHp: 6, opponentHp: 6, mode: 'attack' })
    expect(decision.move).toBe(-1)
  })

  it('迷你引擎认识魔力植物：连珠格上的己方植物会加伤（阶段二）', async () => {
    const { debugSimulate } = await import('../src/ai/baseline')
    // P0 在 (1,1)(1,2)(1,3) 有 3 连，落 (1,0) 成 4 连
    const board = parseBoard([E, '.RRR.....', E, E, E, E, E, E, E])
    const attack = debugSimulate(board, [6, 6], 0, 'attack', cellId(1, 0))
    expect(attack.awaitingDefense).toBe(true)

    // 高光 = 连珠的 4 格；防守方落 (0,0)：不在高光上、自己也不成线
    const highlights = new Map<number, number>([
      [cellId(1, 0), 1],
      [cellId(1, 1), 1],
      [cellId(1, 2), 1],
      [cellId(1, 3), 1],
    ])

    // ① 没有植物：攻击值 4 → 防守方掉 4 点
    const plain = debugSimulate(attack.board as Board, attack.hp, 1, 'defend', cellId(0, 0), highlights)
    expect(plain.hp).toEqual([6, 2])

    // ② 连珠第 2 格上有 P0 自己的植物：攻击值 4 + 1 = 5 → 掉 5 点
    const withPlant = debugSimulate(attack.board as Board, attack.hp, 1, 'defend', cellId(0, 0), highlights, {
      plants: [[cellId(1, 1), 0]],
      damagePerPlant: 1,
    })
    expect(withPlant.hp).toEqual([6, 1])

    // ③ 那棵植物归对手 → 不加伤，回到 4 点
    const enemyPlant = debugSimulate(attack.board as Board, attack.hp, 1, 'defend', cellId(0, 0), highlights, {
      plants: [[cellId(1, 1), 1]],
      damagePerPlant: 1,
    })
    expect(enemyPlant.hp).toEqual([6, 2])
  })

  // -------------------------------------------------------------------------
  // 阶段三：角色技能
  // -------------------------------------------------------------------------

  /** 只让 `player` 拥有某个角色的技能，另一方没有技能（方便构造局面）。 */
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

  it('迷你引擎认识技能：「大胃袋」加护盾、消耗植物，且用完不交回合（阶段三）', async () => {
    const { debugSimulate } = await import('../src/ai/baseline')
    const board = parseBoard([E, E, E, E, E, E, E, E, E])
    const skills = skillCtxFor(0, 'deepseek')
    const plant = cellId(4, 4)
    const sim = debugSimulate(board, [6, 6], 0, 'skill', 0, undefined, { plants: [[plant, 0]] }, skills, [plant], -1)

    expect(sim.shield[0]).toBe(1) // 护盾 +1
    expect(sim.plants).toEqual([]) // 那棵植物被消耗掉
    expect(sim.skillCasts[0][0]).toBe(1) // 释放计数 +1
    expect(sim.skillReadyAt[0][0]).toBe(5) // 冷却门槛 = 已行动 0 次 + 冷却 5
    expect(sim.turn).toBe(0) // 用完**不交回合**（8 个技能都是这样）
  })

  it('迷你引擎认识技能：护盾先于血量承伤（防守结算，阶段三）', async () => {
    const { debugSimulate } = await import('../src/ai/baseline')
    // P1 在 (1,1)(1,2)(1,3) 有 3 连（高光 3 格），P0 防守落 (0,0)：不削弱、也不成线
    const board = parseBoard([E, '.BBB.....', E, E, E, E, E, E, E])
    const highlights = new Map<number, number>([
      [cellId(1, 1), 1],
      [cellId(1, 2), 1],
      [cellId(1, 3), 1],
    ])
    const skills: AiSkillContext = {
      ...skillCtxFor(0, 'deepseek'),
      shield: [2, 0],
    }
    const sim = debugSimulate(board, [6, 6], 0, 'defend', cellId(0, 0), highlights, undefined, skills)
    // 攻击值 3 → 护盾先吃掉 2 → 只掉 1 点血
    expect(sim.hp[0]).toBe(5)
    expect(sim.shield[0]).toBe(0)
  })

  it('迷你引擎认识技能：「恶龙吐息」点燃整行整列的空位（阶段三）', async () => {
    const { debugSimulate } = await import('../src/ai/baseline')
    const board = parseBoard([E, E, E, E, E, E, E, E, E])
    const skills = skillCtxFor(0, 'gtp')
    // 槽 1 = 恶龙吐息：开局就绪 + 首次释放免费（skillCasts 为 0 → 不用交植物）
    const sim = debugSimulate(board, [6, 6], 0, 'skill', 1, undefined, undefined, skills, [], cellId(4, 4))
    // 第 4 行 9 格 ∪ 第 4 列 9 格（共用天元）= 17 格；烈焰按"半回合"存 → 6 回合 = 12
    expect(sim.flames.length).toBe(17)
    expect(sim.flames.every(([, left]) => left === 12)).toBe(true)
    // bugv32：恶龙吐息不再结束回合，用完仍是自己走
    expect(sim.turn).toBe(0)
  })

  it('迷你引擎认识技能：「小一哥」让这一击多打 1 点（阶段三）', async () => {
    const { debugSimulate } = await import('../src/ai/baseline')
    const board = parseBoard([E, '.RRR.....', E, E, E, E, E, E, E])
    const attack = debugSimulate(board, [6, 6], 0, 'attack', cellId(1, 0))
    expect(attack.awaitingDefense).toBe(true)
    const highlights = new Map<number, number>([
      [cellId(1, 0), 1],
      [cellId(1, 1), 1],
      [cellId(1, 2), 1],
      [cellId(1, 3), 1],
    ])
    const skills: AiSkillContext = { ...skillCtxFor(0, 'glm'), powerBonus: [1, 0] }
    const boosted = debugSimulate(attack.board as Board, attack.hp, 1, 'defend', cellId(0, 0), highlights, undefined, skills)
    // 攻击值 4 + 增伤 1 = 5
    expect(boosted.hp).toEqual([6, 1])
  })

  it('gtp 连招：2 费火球碎掉挡路敌子，同回合走自己的火成线（bugv32：不再结束回合 / bugv33：碎子档 3→2 费）', () => {
    const engine = new GameEngine({
      initialHp: 6,
      fixedFirstPlayer: 0,
      skills: [skillsOfCharacter('gtp'), skillsOfCharacter('deepseek')],
    })
    engine.setFirstPlayer(0)
    engine.takeEvents()
    engine.board = parseBoard([E, E, E, E, 'RRRB.....', E, E, E, E]).slice() as Board
    engine.hp = [6, 4]
    engine.current = 0
    engine.skillReadyAt[0] = [0, 0]
    engine.skillCasts[0][1] = 1 // 非首次 → 走 2 费档（碎子）
    for (const cell of [cellId(8, 0), cellId(8, 2)]) {
      engine.board[cell] = cellOf(0)
      engine.magic.set(cell, { cell, kind: 'flower', owner: 0 })
    }
    engine.takeEvents()

    // 2 费火球直击 (4,3)：挡路的敌子碎裂，那一格变成我自己的烈焰
    engine.useSkill(0, 1, [cellId(8, 0), cellId(8, 2)], cellId(4, 3))
    expect(engine.board[cellId(4, 3)]).toBe(0)
    expect(engine.flameOwner.get(cellId(4, 3))).toBe(0)
    // bugv32：用完**不结束回合**，当回合就能接着走自己的火
    expect(engine.current).toBe(0)
    const events = engine.commit(cellId(4, 3))
    expect(eventOf(events, 'matchFormed')).toBeDefined()
    expect(eventOf(events, 'flameWalked')).toBeDefined()
    expect(engine.hp[0]).toBe(5) // 走火自伤 1 点（没护甲兜着）
  })

  it('AI 会在发起攻击之前先用「小一哥」把伤害抬起来（阶段三）', async () => {
    const { decideMove } = await import('../src/ai/baseline')
    const plant = cellId(4, 4)

    // ① 只要这一手能成线发起攻击，计划里就必须先开「小一哥」（免费、不交回合）
    const attackBoard = parseBoard([E, '.RRR.....', E, '.BBB.....', E, E, E, E, E])
    const planned = decideMove({
      board: attackBoard,
      player: 0,
      selfHp: 6,
      opponentHp: 6,
      mode: 'attack',
      timeLimitMs: 3000,
      maxDepth: 4,
      magic: { plants: [[plant, 0]], damagePerPlant: 1 },
      skills: skillCtxFor(0, 'glm'),
    })
    expect(planned.skills).toEqual([{ slot: 0, cells: [plant] }])

    // ② 有"一步成 5 连"的强攻机会时，AI 会立刻把这一手打出去（不会错过成线）
    const openBoard = parseBoard([E, '.RRRR....', E, E, E, E, E, E, E])
    const striking = decideMove({
      board: openBoard,
      player: 0,
      selfHp: 6,
      opponentHp: 6,
      mode: 'attack',
      timeLimitMs: 3000,
      maxDepth: 4,
      magic: { plants: [[plant, 0]], damagePerPlant: 1 },
      skills: skillCtxFor(0, 'glm'),
    })
    expect([cellId(1, 0), cellId(1, 5)]).toContain(striking.move)
  })

  // -------------------------------------------------------------------------
  // 阶段四回归：技能闸门
  //
  // 闸门写错的代价是**技能永远放不出来**，而且从对局结果里极难看出来 ——
  // 只表现为"某个角色莫名很弱"。实际踩过两次（双子星被 4 连卡死、毒鸡蛋自锁），
  // 所以这里直接钉住闸门的判定口径。
  // -------------------------------------------------------------------------

  it('技能闸门：「毒鸡蛋」只要存在可叠目标就必须被给出（阶段四回归）', async () => {
    const { debugRootSkillMoves } = await import('../src/ai/baseline')
    // P0 在 (4,0)(4,1)(4,2) 三连，但 (4,3) 被 P1 占住 → 正常落子打不出去；
    // 叠到 (4,3) 就能凑成 4 连。这正是毒鸡蛋存在的意义。
    const board = parseBoard([E, E, E, E, 'RRRB.....', E, E, E, E])
    const moves = debugRootSkillMoves({
      board,
      player: 0,
      selfHp: 6,
      opponentHp: 6,
      mode: 'attack',
      magic: {
        plants: [
          [cellId(4, 0), 0],
          [cellId(4, 1), 0],
          [cellId(4, 2), 0],
        ],
        damagePerPlant: 1,
      },
      skills: skillCtxFor(0, 'glm'),
    })
    // 槽 1 = 毒鸡蛋（cost 2）。曾经因为判据里检查了"技能已释放"标记 → 永远为空。
    expect(moves.some((m) => m.slot === 1 && m.effect === 'sabotage')).toBe(true)
  })

  it('技能闸门：「双子星」只要有两连落点就必须被给出（阶段四回归）', async () => {
    const { debugRootSkillMoves } = await import('../src/ai/baseline')
    // 盘上只有一颗孤子（远不成四连），但相邻有空位 → 两连成立，双子星就该可用
    const board = parseBoard([E, E, E, '....R....', E, E, E, E, E])
    const moves = debugRootSkillMoves({
      board,
      player: 0,
      selfHp: 6,
      opponentHp: 6,
      mode: 'attack',
      magic: {
        plants: [
          [cellId(0, 0), 0],
          [cellId(8, 8), 0],
        ],
        damagePerPlant: 1,
      },
      skills: skillCtxFor(0, 'gemini'),
    })
    // 槽 1 = 双子星（cost 2）。曾经用"能否成四连"去卡它 → 几乎永远放不出来。
    expect(moves.some((m) => m.slot === 1 && m.effect === 'bloom')).toBe(true)
  })

  it('技能闸门：植物不够时一个技能着法都不给（阶段四回归）', async () => {
    const { debugRootSkillMoves } = await import('../src/ai/baseline')
    const board = parseBoard([E, E, E, '....R....', E, E, E, E, E])
    const moves = debugRootSkillMoves({
      board,
      player: 0,
      selfHp: 6,
      opponentHp: 6,
      mode: 'attack',
      // 场上那棵植物归对手 → 自己一棵都没有
      magic: { plants: [[cellId(0, 0), 1]], damagePerPlant: 1 },
      skills: skillCtxFor(0, 'gemini'),
    })
    expect(moves).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// bugv34：黑夜机制与天气
// ---------------------------------------------------------------------------

/** 造一个"黑夜条件一推就满足"的引擎（阈值全部压到最低）。 */
function nightEngine(): GameEngine {
  const engine = new GameEngine({
    fixedFirstPlayer: 0,
    magic: { enabled: true },
    night: {
      enabled: true,
      warnTurns: 2,
      minGap: 0,
      startTurnThreshold: 1,
      entryAttackThreshold: 0,
      entryPlantThreshold: 0,
    },
  })
  engine.setFirstPlayer(0, [6, 1])
  engine.takeEvents()
  // 至少一方连珠过 + 场上 11 棵无主植物
  engine.magicLineSeen = true
  for (let c = 0; c < 11; c += 1) engine.magic.set(c, { cell: c, kind: 'grass', owner: null })
  engine.takeEvents()
  return engine
}

describe('黑夜机制（bugv34）', () => {
  it('条件满足 → 先预告 2 回合 → 降临并抽到天气', () => {
    const engine = nightEngine()
    // 第 1 手结束 → 进入预告
    let events = engine.commit(cellId(8, 0))
    expect(events.find((e) => e.type === 'nightPending')).toBeDefined()
    expect(engine.nightPhase).toBe('pending')
    expect(engine.nightCountdown).toBe(2)

    // 第 2 手 → 倒数到 1（预告不因条件变化而终止）
    events = engine.commit(cellId(8, 1))
    expect(engine.nightPhase).toBe('pending')
    expect(engine.nightCountdown).toBe(1)

    // 第 3 手 → 倒数到 0 → 黑夜降临，抽到一种天气
    events = engine.commit(cellId(8, 2))
    expect(events.find((e) => e.type === 'nightFell')).toBeDefined()
    expect(engine.nightPhase).toBe('active')
    expect(engine.weather).not.toBeNull()
    expect(WEATHERS.some((w) => w.id === engine.weather)).toBe(true)
  })

  it('退出条件：场上的植物全部被占有（无无主植物）→ 天亮', () => {
    const engine = nightEngine()
    engine.commit(cellId(8, 0))
    engine.commit(cellId(8, 1))
    engine.commit(cellId(8, 2))
    expect(engine.nightPhase).toBe('active')

    // 把场上植物全部变成"有主" → 下一回合直接天亮
    for (const [cell, plant] of [...engine.magic]) engine.magic.set(cell, { ...plant, owner: 0 })
    const events = engine.commit(cellId(8, 8))
    expect(events.find((e) => e.type === 'nightEnded')).toBeDefined()
    expect(engine.nightPhase).toBe('none')
    expect(engine.weather).toBeNull()
  })

  it('场上完全没有植物时，不会因"无无主植物"而秒退黑夜（bugv34 补充）', () => {
    const engine = nightEngine()
    engine.commit(cellId(8, 0))
    engine.commit(cellId(8, 1))
    engine.commit(cellId(8, 2))
    expect(engine.nightPhase).toBe('active')

    // 一棵植物都没有：0 棵无主植物 ≠ "场上没有无主植物"的退出条件
    engine.magic.clear()
    const events = engine.commit(cellId(8, 3))
    expect(events.find((e) => e.type === 'nightEnded')).toBeUndefined()
    expect(engine.nightPhase).toBe('active')
  })

  it('「黑夜开局」：开局直接进入黑夜（没有预告）', () => {
    const engine = new GameEngine({
      fixedFirstPlayer: 0,
      night: { enabled: true, startInNight: true },
    })
    const events = engine.takeEvents()
    expect(events.find((e) => e.type === 'nightPending')).toBeUndefined()
    expect(events.find((e) => e.type === 'nightFell')).toBeDefined()
    expect(engine.nightPhase).toBe('active')
    expect(engine.weather).not.toBeNull()
  })

  it('「黑夜开局」的首个黑夜：不判"场上没有被棋子占有的魔力植物"（bugv34d）', () => {
    const engine = new GameEngine({
      fixedFirstPlayer: 0,
      night: { enabled: true, startInNight: true },
    })
    engine.takeEvents()
    expect(engine.nightPhase).toBe('active')
    expect(engine.nightFromStart).toBe(true)

    // 开局 0 棵植物 —— 常规规则下这一手就会天亮（`magic.size > 0` 的 guard 只挡 0 棵，
    // 这里额外挡住：哪怕是"有植物但全被占有"也必须留到真正的退出条件）。
    for (let i = 0; i < 5; i += 1) engine.commit(engine.legalMoves()[0])
    expect(engine.nightPhase).toBe('active')

    // 场上全是**被占有**的植物（0 棵无主）—— 开局这次黑夜依然不因它而天亮
    for (let cell = 0; cell < 40; cell += 1) engine.magic.set(cell, { cell, kind: 'grass', owner: 0 })
    expect([...engine.magic.values()].filter((plant) => plant.owner === null).length).toBe(0)
    engine.commit(engine.legalMoves()[0])
    expect(engine.nightPhase).toBe('active')

    // 但真正的强制退出条件（持续回合）仍然生效 —— 只是"无主植物"这一条被豁免
    engine.nightTurns = 999
    const events = engine.commit(engine.legalMoves()[0])
    expect(events.find((e) => e.type === 'nightEnded')).toBeDefined()
    expect(engine.nightPhase).toBe('none')
    expect(engine.nightFromStart).toBe(false)
  })

  it('非「黑夜开局」的黑夜："无主植物"退出条件照常生效（豁免只给开局那一次）', () => {
    const engine = nightEngine()
    engine.commit(cellId(8, 0))
    engine.commit(cellId(8, 1))
    engine.commit(cellId(8, 2))
    expect(engine.nightPhase).toBe('active')
    expect(engine.nightFromStart).toBe(false)

    // 场上只剩被占有的植物（0 棵无主）→ 立刻天亮
    engine.magic.clear()
    engine.magic.set(0, { cell: 0, kind: 'grass', owner: 0 })
    const events = engine.commit(cellId(8, 3))
    expect(events.find((e) => e.type === 'nightEnded')).toBeDefined()
    expect(engine.nightPhase).toBe('none')
  })

  it('默认黑夜常量（bugv34d）：间隔 20 / 开局 50 / 攻击 10 / 植物 10 / 结束 30+20 / 强制 60+40 / 预告 3', () => {
    expect(DEFAULT_NIGHT_CONFIG).toEqual({
      enabled: true,
      startInNight: false,
      warnTurns: 3,
      minGap: 20,
      startTurnThreshold: 50,
      entryAttackThreshold: 10,
      entryPlantThreshold: 10,
      exitTurnsA: 30,
      exitAttacksA: 20,
      exitTurnsB: 60,
      exitAttacksB: 40,
    })
  })

  it('「雷暴」结束：场上的污染体（无论是否被占有）都变回普通魔力植物', () => {
    const engine = nightEngine()
    engine.commit(cellId(8, 0))
    engine.commit(cellId(8, 1))
    engine.commit(cellId(8, 2))
    expect(engine.nightPhase).toBe('active')

    engine.weather = 'thunder'
    engine.magic.set(0, { cell: 0, kind: 'pollution', owner: null })
    engine.magic.set(1, { cell: 1, kind: 'pollution', owner: 0 })
    // 直接顶到"持续超过 exitTurnsB"的退出条件
    engine.nightTurns = 999

    const events = engine.commit(cellId(8, 8))
    expect(events.find((e) => e.type === 'magicReverted')).toBeDefined()
    expect(events.find((e) => e.type === 'nightEnded')).toBeDefined()
    expect(engine.magic.get(0)?.kind).not.toBe('pollution')
    expect(engine.magic.get(1)?.kind).not.toBe('pollution')
    // 归属保留
    expect(engine.magic.get(1)?.owner).toBe(0)
  })

  it('天气抽取是"局面派生"的确定性随机：同局面必得同一天气（联机两端一致）', () => {
    const a = nightEngine()
    const b = nightEngine()
    for (const e of [a, b]) {
      e.commit(cellId(8, 0))
      e.commit(cellId(8, 1))
      e.commit(cellId(8, 2))
    }
    expect(a.weather).toBe(b.weather)
  })

  it('「黑夜开局」每局天气不固定（开局局面一样，不能永远抽到同一种）', () => {
    // 用不同 seed 造 24 局，理论上 1/4^23 的概率全同 —— 只要出现过 ≥2 种就说明抽取不再退化成常量。
    const seen = new Set<string>()
    for (let seed = 1; seed <= 24; seed += 1) {
      const engine = new GameEngine({
        fixedFirstPlayer: 0,
        seed,
        night: { enabled: true, startInNight: true },
      })
      engine.takeEvents()
      if (engine.weather) seen.add(engine.weather)
    }
    expect(seen.size).toBeGreaterThan(1)
  })
})

describe('瘟疫（bugv34）', () => {
  /**
   * 攻击方在 row1 有 `.RRR.....`，(1,1) 是攻击方自己的魔力植物；
   * 落 (1,4) 成 4 连（含 1 棵植物 ⇒ 最终攻击 5）。防守方只在别处随便落一颗（不成线）。
   */
  function plagueEngine(plague: boolean): GameEngine {
    const engine = engineFor(0, 8)
    const board = parseBoard([E, '.RRR.....', E, E, E, E, E, E, E])
    engine.loadScenario(board, { hp: [8, 8], current: 0, firstPlayer: 0 })
    engine.magic.set(cellId(1, 1), { cell: cellId(1, 1), kind: 'flower', owner: 0 })
    engine.weather = plague ? 'plague' : null
    engine.nightPhase = plague ? 'active' : 'none'
    return engine
  }

  it('带植物的攻击棋子分裂一颗给防守方：**宣告攻击时就已挂到防守方**（落子前即可见）', () => {
    const engine = plagueEngine(true)
    const declared = engine.commit(cellId(1, 4))
    expect(engine.attack?.finalAttack).toBe(5)
    // 攻击阶段刚开、防守方还没下子 → 防守方已经握有 1 颗分裂来的棋子
    expect(engine.attack?.defenderAttack).toBe(1)
    expect(eventOf(declared, 'attackStoneSplit')).toBeDefined()

    const events = engine.defend(cellId(8, 8))
    const snapshot = eventOf(events, 'attackResolved')?.snapshot
    // 防守方没成线，但靠这 1 颗分裂来的棋子参与对撞
    expect(snapshot?.defenderAttack).toBe(1)
    // 5 vs 1 ⇒ 防守方只承担 4（没有瘟疫时是 5）
    expect(snapshot?.diff).toBe(4)
    expect(engine.hp[1]).toBe(4)
  })

  it('非瘟疫天气：防守方没成线时不会分裂，照常吃满伤害', () => {
    const engine = plagueEngine(false)
    engine.commit(cellId(1, 4))
    const events = engine.defend(cellId(8, 8))
    const snapshot = eventOf(events, 'attackResolved')?.snapshot
    expect(snapshot?.defenderAttack).toBe(0)
    expect(eventOf(events, 'attackStoneSplit')).toBeUndefined()
    expect(snapshot?.diff).toBe(5)
    expect(engine.hp[1]).toBe(3)
  })

  /**
   * 对称方向（用户口径）：**防守方**成线反击时，防守方连珠上的植物同样分裂一颗给攻击方。
   * 攻击方 row1 `.RRR.....`（无植物），防守方 row8 `.BBB.....` 且 (8,2) 有防守方植物。
   */
  function counterEngine(plague: boolean): GameEngine {
    const engine = engineFor(0, 8)
    const board = parseBoard([E, '.RRR.....', E, E, E, E, E, E, '.BBB.....'])
    engine.loadScenario(board, { hp: [8, 8], current: 0, firstPlayer: 0 })
    engine.magic.set(cellId(8, 2), { cell: cellId(8, 2), kind: 'grass', owner: 1 })
    engine.weather = plague ? 'plague' : null
    engine.nightPhase = plague ? 'active' : 'none'
    return engine
  }

  it('防守方成线反击：防守方的植物也分裂一颗给攻击方（对两边都生效）', () => {
    const engine = counterEngine(true)
    engine.commit(cellId(1, 4)) // 攻击方 4 连（本次连珠上没有植物）
    const events = engine.defend(cellId(8, 4)) // 防守方 4 连反击，含 1 棵防守方植物
    const snapshot = eventOf(events, 'attackResolved')?.snapshot
    // 攻击方 = 4 + 分裂来的 1 = 5；防守方 = 4 颗棋子 + 自己 1 棵植物 = 5 ⇒ 抵消
    expect(snapshot?.finalAttack).toBe(5)
    expect(snapshot?.defenderAttack).toBe(5)
    expect(snapshot?.diff).toBe(0)
    const splits = events.filter((e) => e.type === 'attackStoneSplit') as Array<
      Extract<GameEvent, { type: 'attackStoneSplit' }>
    >
    expect(splits.length).toBe(1)
    expect(splits[0].to).toBe(0)
  })

  it('非瘟疫：防守方成线反击时不会给攻击方补棋子（攻击方仍只 4）', () => {
    const engine = counterEngine(false)
    engine.commit(cellId(1, 4))
    const events = engine.defend(cellId(8, 4))
    const snapshot = eventOf(events, 'attackResolved')?.snapshot
    expect(snapshot?.finalAttack).toBe(4)
    expect(snapshot?.defenderAttack).toBe(5)
    expect(eventOf(events, 'attackStoneSplit')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 天气修正 + bugv34c 追加的三种天气（Weather.md 第 5~7 条）
// ---------------------------------------------------------------------------

describe('天气修正与新增天气（bugv34c）', () => {
  /** 造一个指定天气的对局（天气由测试直接注入，跳过黑夜状态机）。 */
  function weatherEngine(
    weather: WeatherId | null,
    rows: readonly string[],
    hp: [number, number] = [12, 12],
  ): GameEngine {
    const engine = engineFor(0, 12)
    engine.loadScenario(parseBoard(rows), { hp, current: 0, firstPlayer: 0 })
    engine.weather = weather
    engine.nightPhase = weather ? 'active' : 'none'
    return engine
  }

  it('「干涸」的"随机碎一颗攻击棋子"只是表现：最终伤害只 −1（4 连 → 3）', () => {
    const engine = weatherEngine('drought', [E, '.RRR.....', E, E, E, E, E, E, E])
    engine.commit(cellId(1, 4))
    // 4 连 − 1（天气）= 3，**不是** 4−1(碎) −1(天气) = 2
    expect(engine.attack?.finalAttack).toBe(3)
    const events = engine.defend(cellId(8, 8))
    expect(eventOf(events, 'attackResolved')?.snapshot.diff).toBe(3)
    expect(engine.hp[1]).toBe(9)
  })

  it('「干涸」不再发"碎一颗"事件（bugv34d）：−1 的表现交给悬浮棋子数量对齐，避免播两遍', () => {
    const engine = weatherEngine('drought', [E, '.RRR.....', E, E, E, E, E, E, '.BBB.....'])
    const attackEvents = engine.commit(cellId(1, 4))
    const defendEvents = engine.defend(cellId(8, 4))
    const all = [...attackEvents, ...defendEvents]
    // 攻击方 / 防守方都不该再有这个事件（否则 3D 会在舞台上凭空补一颗再炸，与对账重复）
    expect(all.some((event) => (event as { type: string }).type === 'attackStoneShattered')).toBe(false)
    // 数值仍照常 −1（双方各 −1）
    const snapshot = eventOf(defendEvents, 'attackResolved')?.snapshot
    expect(snapshot?.finalAttack).toBe(3)
    expect(snapshot?.defenderAttack).toBe(3)
  })

  it('「干涸」碎子那一格的魔力植物不会残留场上（以前 draft.cells 被剔掉了那一格）', () => {
    const engine = weatherEngine('drought', [E, '.RRR.....', E, E, E, E, E, E, E])
    const line = [cellId(1, 1), cellId(1, 2), cellId(1, 3), cellId(1, 4)]
    for (const cell of line) engine.magic.set(cell, { cell, kind: 'flower', owner: 0 })
    engine.commit(cellId(1, 4))
    engine.defend(cellId(8, 8))
    expect(line.filter((cell) => engine.magic.has(cell))).toEqual([])
  })

  it('「干涸」防守方成线反击时同样 −1', () => {
    const engine = weatherEngine('drought', [E, '.RRR.....', E, E, E, E, E, E, '.BBB.....'])
    engine.commit(cellId(1, 4))
    const snapshot = eventOf(engine.defend(cellId(8, 4)), 'attackResolved')?.snapshot
    expect(snapshot?.finalAttack).toBe(3)
    expect(snapshot?.defenderAttack).toBe(3)
    expect(snapshot?.diff).toBe(0)
  })

  it('「暴雪」冻结的植物不提供伤害加成（4 连 + 1 冻结植物 → 4）', () => {
    const engine = weatherEngine('blizzard', [E, '.RRR.....', E, E, E, E, E, E, E])
    engine.magic.set(cellId(1, 1), { cell: cellId(1, 1), kind: 'frozen', owner: 0 })
    engine.commit(cellId(1, 4))
    expect(engine.attack?.finalAttack).toBe(4)
    expect(eventOf(engine.defend(cellId(8, 8)), 'attackResolved')?.snapshot.diff).toBe(4)
  })

  it('「暴雪」连珠上被冻结的植物：随棋子消失、并在**原地**长出一棵非冻结的（= 解冻）', () => {
    const engine = weatherEngine('blizzard', [E, '.RRR.....', E, E, E, E, E, E, E])
    const spot = cellId(1, 1)
    engine.magic.set(spot, { cell: spot, kind: 'frozen', owner: 0 })
    engine.commit(cellId(1, 4))
    const events = engine.defend(cellId(8, 8))

    // ① 消失：原来那棵冻结植物随棋子一起被清掉
    expect(eventOf(events, 'magicRemoved')?.cells).toContain(spot)
    // ② 重生：**同一格**又长出一棵，且**不是冻结**的（source 标为 weather）
    const grown = eventOf(events, 'magicGrown')
    expect(grown?.source).toBe('weather')
    expect(grown?.plants.map((plant) => plant.cell)).toEqual([spot])
    expect(grown?.plants[0].kind).not.toBe('frozen')
    // ③ 场上最终就是"一棵非冻结的植物在那里"
    const plant = engine.magic.get(spot)
    expect(plant).toBeDefined()
    expect(plant?.kind).not.toBe('frozen')
    // ④ 不再是"就地改色"（旧实现）—— 不该再发 magicReverted
    expect(eventOf(events, 'magicReverted')).toBeUndefined()
  })

  it('「暴雪」解冻对**双方**都生效：防守方连珠上的冻结植物同样"消失 + 原地重生"', () => {
    const engine = weatherEngine('blizzard', [E, '.RRR.....', E, E, E, E, E, E, '.BBB.....'])
    const spot = cellId(8, 1)
    engine.magic.set(spot, { cell: spot, kind: 'frozen', owner: 1 })
    engine.commit(cellId(1, 4))
    const events = engine.defend(cellId(8, 4)) // 防守方也成 4 连

    expect(eventOf(events, 'magicRemoved')?.cells).toContain(spot)
    const grown = eventOf(events, 'magicGrown')
    expect(grown?.plants.map((plant) => plant.cell)).toEqual([spot])
    expect(grown?.plants[0].kind).not.toBe('frozen')
    expect(engine.magic.get(spot)?.kind).not.toBe('frozen')
  })

  it('「暴雪」降临：场上所有现有植物立刻冻结', () => {
    // 天气是"局面派生"的确定性随机（种子 = 棋盘 + 血量 + 走子数 + salt）
    // ⇒ 换几组血量就能扫到暴雪，扫不到就说明抽取被改坏了。
    let hit: GameEngine | null = null
    for (let hp = 1; hp <= 60 && hit === null; hp += 1) {
      const engine = new GameEngine({
        fixedFirstPlayer: 0,
        magic: { enabled: true },
        night: {
          enabled: true,
          warnTurns: 0,
          minGap: 0,
          startTurnThreshold: 1,
          entryAttackThreshold: 0,
          entryPlantThreshold: 0,
        },
      })
      engine.setFirstPlayer(0, [6, 1])
      engine.loadScenario(createBoard(), { hp: [hp, hp], current: 0, firstPlayer: 0 })
      engine.takeEvents()
      engine.magicLineSeen = true
      for (let c = 0; c < 11; c += 1) engine.magic.set(c, { cell: c, kind: 'flower', owner: null })
      engine.takeEvents()
      engine.commit(cellId(8, 0))
      engine.commit(cellId(8, 1))
      if (engine.weather === 'blizzard') hit = engine
    }
    expect(hit).not.toBeNull()
    const plants = [...hit!.magic.values()]
    expect(plants.length).toBeGreaterThan(0)
    expect(plants.every((plant) => plant.kind === 'frozen')).toBe(true)
  })

  it('「极光」连珠后、伤害结算前为双方各回"连珠上植物数"的血', () => {
    const engine = weatherEngine('aurora', [E, '.RRR.....', E, E, E, E, E, E, E], [6, 6])
    engine.magic.set(cellId(1, 1), { cell: cellId(1, 1), kind: 'flower', owner: 0 })
    engine.magic.set(cellId(1, 2), { cell: cellId(1, 2), kind: 'grass', owner: 0 })
    engine.commit(cellId(1, 4))
    // 2 棵植物 ⇒ 双方各回 2
    expect(engine.hp).toEqual([8, 8])
    // 随后照常结算：4 连 + 2 棵植物 = 6 伤
    engine.defend(cellId(8, 8))
    expect(engine.hp).toEqual([8, 2])
  })

  it('「旱雷」每方落子后雷击自己占用的一棵植物，并在空位补长一棵（总数不变）', () => {
    const engine = weatherEngine('dryLightning', [E, '.RRR.....', E, E, E, E, E, E, E])
    const mine = cellId(5, 5)
    engine.magic.set(mine, { cell: mine, kind: 'grass', owner: 0 })
    engine.magic.set(cellId(7, 7), { cell: cellId(7, 7), kind: 'fern', owner: null })
    const before = engine.magic.size

    const events = engine.commit(cellId(0, 0))
    expect(eventOf(events, 'lightningStruck')).toBeDefined()
    const removed = eventOf(events, 'magicRemoved')
    expect(removed?.reason).toBe('weather')
    expect(removed?.cells).toEqual([mine])
    const grown = eventOf(events, 'magicGrown')
    expect(grown?.plants.length).toBe(1)
    // 优先长在原棋子周围（切比雪夫距离 ≤ 1）
    const by = removed!.cells[0]
    const row = Math.floor(by / BOARD_SIZE)
    const col = by % BOARD_SIZE
    const planted = grown!.plants[0].cell
    expect(Math.max(Math.abs(Math.floor(planted / BOARD_SIZE) - row), Math.abs((planted % BOARD_SIZE) - col))).toBeLessThanOrEqual(1)
    expect(engine.magic.size).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// bugv34d：结算面板的「天气增伤 / 减伤」快照字段
// ---------------------------------------------------------------------------

describe('结算面板的天气增减伤快照（bugv34d）', () => {
  /** 指定天气 + 指定连珠形状的对局（天气直接注入，跳过黑夜状态机）。 */
  function withWeather(weather: WeatherId | null, rows: readonly string[]): GameEngine {
    const engine = engineFor(0, 12)
    engine.loadScenario(parseBoard(rows), { hp: [12, 12], current: 0, firstPlayer: 0 })
    engine.weather = weather
    engine.nightPhase = weather ? 'active' : 'none'
    return engine
  }

  it('无天气时两个 delta 都是 0（面板不显示这一行）', () => {
    const engine = withWeather(null, [E, '.RRR.....', E, E, E, E, E, E, E])
    engine.commit(cellId(1, 4))
    expect(engine.attack?.weatherAttackDelta).toBe(0)
    expect(engine.attack?.weatherDefenderDelta).toBe(0)
  })

  it('「干涸」：攻击方 delta = −1', () => {
    const engine = withWeather('drought', [E, '.RRR.....', E, E, E, E, E, E, E])
    engine.commit(cellId(1, 4))
    // 4 连（无植物）→ 基线 4、实际 3
    expect(engine.attack?.finalAttack).toBe(3)
    expect(engine.attack?.weatherAttackDelta).toBe(-1)
    expect(engine.attack?.weather).toBe('drought')
  })

  it('「雷暴」：污染体 +2 → delta = +1（比普通植物多 1）', () => {
    const engine = withWeather('thunder', [E, '.RRR.....', E, E, E, E, E, E, E])
    const cell = cellId(1, 1)
    engine.magic.set(cell, { cell, kind: 'pollution', owner: 0 })
    engine.commit(cellId(1, 4))
    // 4 连 + 污染体 2 = 6；基线 = 4 + 1（普通植物）= 5 ⇒ delta +1
    expect(engine.attack?.finalAttack).toBe(6)
    expect(engine.attack?.weatherAttackDelta).toBe(1)
  })

  it('「枯竭」：植物不加伤 → delta = −棵数', () => {
    const engine = withWeather('depletion', [E, '.RRR.....', E, E, E, E, E, E, E])
    for (const cell of [cellId(1, 1), cellId(1, 2)]) engine.magic.set(cell, { cell, kind: 'flower', owner: 0 })
    engine.commit(cellId(1, 4))
    // 4 连 + 0 = 4；基线 = 4 + 2 = 6 ⇒ delta −2
    expect(engine.attack?.finalAttack).toBe(4)
    expect(engine.attack?.weatherAttackDelta).toBe(-2)
  })

  it('「暴雪」：冻结植物不加伤 → delta = −冻结棵数', () => {
    const engine = withWeather('blizzard', [E, '.RRR.....', E, E, E, E, E, E, E])
    const cell = cellId(1, 1)
    engine.magic.set(cell, { cell, kind: 'frozen', owner: 0 })
    engine.commit(cellId(1, 4))
    expect(engine.attack?.finalAttack).toBe(4)
    expect(engine.attack?.weatherAttackDelta).toBe(-1)
  })

  it('防守方 delta：干涸下防守方成线反击同样记 −1', () => {
    const engine = withWeather('drought', [E, '.RRR.....', E, E, E, E, E, E, '.BBB.....'])
    engine.commit(cellId(1, 4))
    const snapshot = eventOf(engine.defend(cellId(8, 4)), 'attackResolved')?.snapshot
    expect(snapshot?.defenderAttack).toBe(3)
    expect(snapshot?.weatherDefenderDelta).toBe(-1)
  })

  it('防守方 delta：非干涸且无植物时为 0（避免面板凭空显示一行）', () => {
    const engine = withWeather(null, [E, '.RRR.....', E, E, E, E, E, E, '.BBB.....'])
    engine.commit(cellId(1, 4))
    const snapshot = eventOf(engine.defend(cellId(8, 4)), 'attackResolved')?.snapshot
    expect(snapshot?.defenderAttack).toBe(4)
    expect(snapshot?.weatherDefenderDelta).toBe(0)
  })

  it('「瘟疫」：分裂给双方的棋子计入对应一侧的天气 delta', () => {
    const engine = withWeather('plague', [E, '.RRR.....', E, E, E, E, E, E, E])
    const cell = cellId(1, 1)
    engine.magic.set(cell, { cell, kind: 'flower', owner: 0 })
    engine.commit(cellId(1, 4))
    // 宣告时：攻击方 4+1=5（基线 5 ⇒ delta 0），防守方拿到 1 颗 ⇒ delta +1
    expect(engine.attack?.weatherAttackDelta).toBe(0)
    expect(engine.attack?.weatherDefenderDelta).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Qwen（bugv34m）：本地部署 / 小千问
// ---------------------------------------------------------------------------

describe('Qwen（bugv34m）', () => {
  const QWEN = skillsOfCharacter('qwen')
  const DEEPSEEK_SKILLS = skillsOfCharacter('deepseek')

  function qwenEngine(first: PlayerIndex = 0): GameEngine {
    const engine = new GameEngine({ fixedFirstPlayer: first, skills: [QWEN, DEEPSEEK_SKILLS] })
    engine.setFirstPlayer(first)
    engine.takeEvents()
    engine.current = first
    return engine
  }

  /** 把一棵植物直接放到格子上（并把该格摆上 `owner` 的棋子，形成归属）。 */
  function givePlant(engine: GameEngine, player: PlayerIndex, cell: number): void {
    engine.board[cell] = cellOf(player)
    engine.magic.set(cell, { cell, kind: 'flower', owner: player })
  }

  function stoneCount(engine: GameEngine, player: PlayerIndex): number {
    let n = 0
    for (let i = 0; i < engine.board.length; i++) if (engine.board[i] === cellOf(player)) n += 1
    return n
  }

  it('「本地部署」：1 费 / 冷却 5；本回合落子未成连珠 → 只在落点长一棵植物', () => {
    expect(QWEN[0].effect).toBe('localDeploy')
    expect(QWEN[0].cost).toBe(1)
    expect(QWEN[0].cooldown).toBe(5)
    expect(QWEN[0].cooldownCutOnMatchPlants).toBe(true)

    const engine = qwenEngine(0)
    givePlant(engine, 0, cellId(8, 0))
    engine.skillReadyAt[0][0] = 0
    const used = engine.useSkill(0, 0, [cellId(8, 0)])
    expect(eventOf(used, 'skillUsed')?.effect).toBe('localDeploy')
    expect(engine.deploy[0]).toBe(true)
    expect(engine.deployBonus[0]).toBe(1)

    const center = cellId(4, 4)
    const events = engine.commit(center)
    const grown = events.filter(
      (e): e is Extract<GameEvent, { type: 'magicGrown' }> => e.type === 'magicGrown',
    )
    expect(grown.length).toBe(1)
    expect(grown[0].source).toBe('deploy')
    // 只长落点这一格（不是「布局」那样的九宫格），归属跟着刚落的棋子
    expect(grown[0].plants.map((p) => p.cell)).toEqual([center])
    expect(engine.magic.get(center)?.owner).toBe(0)
    // 窗口用完即关；没成连珠 → 加伤也随回合结束清掉
    expect(engine.deploy[0]).toBe(false)
    expect(engine.deployBonus[0]).toBe(0)
  })

  it('「本地部署」：落点已经有魔力植物时跳过（不覆盖、不换主人）', () => {
    const engine = qwenEngine(0)
    givePlant(engine, 0, cellId(8, 0))
    engine.skillReadyAt[0][0] = 0
    engine.useSkill(0, 0, [cellId(8, 0)])

    const center = cellId(4, 4)
    engine.magic.set(center, { cell: center, kind: 'grass', owner: null })
    const events = engine.commit(center)
    expect(events.filter((e) => e.type === 'magicGrown').length).toBe(0)
    expect(engine.magic.get(center)?.kind).toBe('grass')
  })

  it('「本地部署」：本回合落子成连珠 → 这一击伤害 +1', () => {
    const engine = qwenEngine(0)
    engine.board = parseBoard([E, '.RRR.....', E, E, E, E, E, E, E])
    givePlant(engine, 0, cellId(8, 0))
    engine.skillReadyAt[0][0] = 0
    engine.useSkill(0, 0, [cellId(8, 0)])

    engine.commit(cellId(1, 4))
    // 4 颗棋子 + 0 棵植物 + 「本地部署」+1 = 5
    expect(engine.attack?.deployBonus).toBe(1)
    expect(engine.attack?.finalAttack).toBe(5)
  })

  it('「本地部署」被动：形成连珠且连珠上有魔力植物 → 冷却按植物数量削减', () => {
    const engine = qwenEngine(0)
    engine.board = parseBoard([E, '.RRR.....', E, E, E, E, E, E, E])
    engine.magic.set(cellId(1, 1), { cell: cellId(1, 1), kind: 'flower', owner: 0 })
    engine.magic.set(cellId(1, 2), { cell: cellId(1, 2), kind: 'flower', owner: 0 })
    // 技能还在冷却中（还剩 4 手）
    engine.actionsTaken[0] = 0
    engine.skillReadyAt[0][0] = 4

    engine.commit(cellId(1, 4))
    // 连珠上有 2 棵植物 → 冷却 4 → 2
    expect(engine.skillReadyAt[0][0]).toBe(2)
  })

  it('「本地部署」被动：连珠上没有植物时不削冷却', () => {
    const engine = qwenEngine(0)
    engine.board = parseBoard([E, '.RRR.....', E, E, E, E, E, E, E])
    engine.actionsTaken[0] = 0
    engine.skillReadyAt[0][0] = 4
    engine.commit(cellId(1, 4))
    expect(engine.skillReadyAt[0][0]).toBe(4)
  })

  it('「小千问」：1~2 费；移除压在被消耗植物上的棋子，未成连珠时重新部署（冷却 = 3 × 实际放下数）', () => {
    expect(QWEN[1].effect).toBe('redeploy')
    expect(QWEN[1].variableCost).toMatchObject({ min: 1, max: 2, cooldownPerUnit: 3 })

    const engine = qwenEngine(0)
    const from = cellId(0, 0)
    givePlant(engine, 0, from)
    engine.skillReadyAt[0][1] = 0
    const used = engine.useSkill(0, 1, [from])
    expect(eventOf(used, 'skillUsed')?.effect).toBe('redeploy')
    // 棋子被移除、植物被消耗
    expect(engine.board[from]).toBe(0)
    expect(engine.magic.has(from)).toBe(false)
    expect(engine.redeployPending[0]).toEqual([from * 2])
    // 冷却先按"实际消耗"进账：1 棵 → 3
    expect(engine.skillReadyAt[0][1]).toBe(3)

    const before = stoneCount(engine, 0)
    const events = engine.commit(cellId(4, 4))
    const ev = eventOf(events, 'redeployStones')
    expect(ev).toBeDefined()
    expect(ev?.placed.length).toBe(1)
    expect(ev?.refunded.length).toBe(0)
    // 落子 1 颗 + 重新部署 1 颗
    expect(stoneCount(engine, 0)).toBe(before + 2)
    // 自动落下的棋子一定不会形成连珠
    expect(previewAttackPieces(engine.board, 0, ev!.placed[0]).length).toBe(0)
    expect(engine.redeployPending[0]).toEqual([])
    // 全部放下 → 冷却不退，仍是 3
    expect(engine.skillReadyAt[0][1]).toBe(3)
  })

  it('「小千问」：本回合落子成了连珠 → 待部署作废（棋子就是真没了）', () => {
    const engine = qwenEngine(0)
    engine.board = parseBoard([E, '.RRR.....', E, E, E, E, E, E, E])
    const from = cellId(8, 0)
    givePlant(engine, 0, from)
    engine.skillReadyAt[0][1] = 0
    engine.useSkill(0, 1, [from])
    expect(engine.redeployPending[0].length).toBe(1)

    const events = engine.commit(cellId(1, 4))
    expect(eventOf(events, 'redeployStones')).toBeUndefined()
    expect(engine.redeployPending[0]).toEqual([])
    expect(engine.board[from]).toBe(0)
    expect(engine.magic.has(from)).toBe(false)
  })

  it('「小千问」：唯一剩下的格子会形成连珠 → 棋子回原位 + 植物返还 + 冷却按实际放下数退回', () => {
    const engine = qwenEngine(0)
    // 造一个"只剩两格"的棋盘：配色 (r + 2c) % 4 < 2，四个方向的最大连续同色都是 2，
    // 所以整盘没有任何连珠。再把第 0 行改成 `O . 0 0 L` 的形状：
    //   O = (0,0) 付账用的植物格（被移除后空出来）；L = (0,3) 留给玩家落子；
    //   (0,1)、(0,2) 预先摆上 P0 的棋子。
    const from = cellId(4, 4)
    const last = cellId(4, 5)
    const board = createBoard()
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const cell = cellId(r, c)
        if (cell === last) continue
        board[cell] = ((r + 2 * c) % 4 < 2 ? 1 : 2) as 0 | 1 | 2
      }
    }
    // 第 4 行改成 `O L 0 0 1`：O = 付账的植物格（移除后空出）、L = 玩家要落的那一格，
    // (4,6)/(4,7) 预先摆上 P0 的棋子 —— 玩家在 L 落子只凑出 3 连，
    // 但之后把 O 补回去就是 P0 的四连 ⇒ 它必须被剔除，于是这颗棋子只能回原位。
    board[cellId(4, 7)] = 1
    board[cellId(4, 8)] = 2
    engine.board = board
    // 前置断言：此时盘上只剩 L 一个空位
    expect(engine.emptyCells()).toEqual([last])

    givePlant(engine, 0, from)
    engine.skillReadyAt[0][1] = 0
    engine.useSkill(0, 1, [from])
    expect(engine.board[from]).toBe(0)
    // 移除之后只剩 O 与 L（玩家只能落在 L）
    expect(engine.emptyCells()).toEqual([from, last])
    // 而 O 一旦被补回去就是 P0 的四连 ⇒ 它必须被剔除
    const withOrigin = board.slice()
    withOrigin[last] = 1
    expect(previewAttackPieces(withOrigin, 0, from).length).toBeGreaterThan(0)

    const events = engine.commit(last)
    const ev = eventOf(events, 'redeployStones')
    expect(ev?.placed).toEqual([])
    expect(ev?.refunded).toEqual([{ cell: from, overlay: false }])
    // 棋子与植物都回原位
    expect(engine.board[from]).toBe(cellOf(0))
    expect(engine.magic.get(from)?.owner).toBe(0)
    // 冷却按实际放下数（0）算 ⇒ 立即可用
    expect(engine.skillRemaining(0, 1)).toBe(0)
  })

  it('「小千问」：重新部署**优先落在有无主魔力植物的空位**（哪怕离落点很远，bugv34n）', () => {
    const engine = qwenEngine(0)
    const from = cellId(0, 0) // 付账用的植物格（消费后空出来）
    const far1 = cellId(8, 8) // 两棵**无主**植物：空格上长着、没有棋子压着
    const far2 = cellId(8, 0)
    const landing = cellId(4, 4) // 落点离 far1 / far2 都很远
    engine.board = createBoard()
    givePlant(engine, 0, from)
    engine.magic.set(far1, { cell: far1, kind: 'flower', owner: null })
    engine.magic.set(far2, { cell: far2, kind: 'flower', owner: null })

    engine.skillReadyAt[0][1] = 0
    engine.useSkill(0, 1, [from])
    expect(engine.redeployPending[0].length).toBe(1)

    const events = engine.commit(landing)
    const ev = eventOf(events, 'redeployStones')
    expect(ev?.placed.length).toBe(1)
    const cell = ev!.placed[0]
    // ⚠️ 用户报的 bug 就是"丢到了毫无意义的远处格子"：必须正好吃下其中一棵植物
    expect([far1, far2]).toContain(cell)
    expect(engine.magic.get(cell)?.owner).toBe(0)
    // 落点周围的近圈**不是**优先项（那是"没有植物可吃"时的退路）
    const r = (cell / BOARD_SIZE) | 0
    const c = cell % BOARD_SIZE
    expect(Math.max(Math.abs(r - 4), Math.abs(c - 4))).toBe(4)
  })

  it('「小千问」：没有无主植物可吃时，落在**离落点最近的一圈**（不再整盘随机，bugv34n）', () => {
    const engine = qwenEngine(0)
    const from = cellId(0, 0)
    const landing = cellId(4, 4)
    engine.board = createBoard()
    givePlant(engine, 0, from)
    engine.skillReadyAt[0][1] = 0
    engine.useSkill(0, 1, [from])

    const events = engine.commit(landing)
    const ev = eventOf(events, 'redeployStones')
    expect(ev?.placed.length).toBe(1)
    const cell = ev!.placed[0]
    const r = (cell / BOARD_SIZE) | 0
    const c = cell % BOARD_SIZE
    // 落点自己已被占用 ⇒ 最近的一圈就是切比雪夫距离 1
    expect(Math.max(Math.abs(r - 4), Math.abs(c - 4))).toBe(1)
    expect(previewAttackPieces(engine.board, 0, cell).length).toBe(0)
  })
})
