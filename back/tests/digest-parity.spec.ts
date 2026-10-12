/**
 * 前后端指纹（digest）一致性契约测试（bugv27 #4）。
 *
 * 背景：联机对局里两端各跑一份引擎，每一步后比较指纹，不一致就 `sync` 自愈。
 * 但**指纹的字段清单写了两遍**：
 *   - 客户端 `src/app/useConnectGame.ts` 的 `localDigest()`
 *   - 服务端 `src/digest.ts` 的 `digestOfEngine()`
 *
 * 只要服务端少传一项，同一局面两端就会算出**两个不同的指纹** ⇒ 客户端每一步都
 * 判定"状态漂移"、疯狂 `requestSync()`。这不是理论问题：`tempArmor`（gtp「精密计算」）、
 * `flameOwner`（恶龙吐息的烈焰归属）、`powerUntil`（glm「小一哥」增伤到期）等
 * 新角色的字段服务端一直没传 —— 用这些角色联机时每手都触发一次整局重同步。
 *
 * 这个测试把**客户端的字段清单照抄一份**并要求两边结果相等：
 * 以后任一侧新增字段而另一侧忘了跟，这里立刻变红。
 */
import { describe, expect, it } from 'vitest'
import { GameEngine } from '../src/core/engine'
import { stateDigest } from '../src/core/digest'
import { skillsOfCharacter, type CharacterId } from '../src/core/characters'
import { cellId, type Board, type PlayerIndex } from '../src/core/types'
import { digestOfEngine } from '../src/digest'

/**
 * 客户端的字段清单（与 `localDigest()` 一一对应，改前端时这里也要改）。
 */
function clientDigest(engine: GameEngine): string {
  return stateDigest({
    board: engine.board,
    hp: engine.hp,
    phase: engine.phase,
    current: engine.current,
    firstPlayer: engine.firstPlayer,
    highlightOwner: engine.highlightOwner,
    highlights: engine.highlights,
    magic: engine.magic,
    magicGrowths: engine.magicGrowths,
    magicCooldown: engine.magicCooldown,
    shield: engine.shield,
    bonusActions: engine.bonusActions,
    actionsTaken: engine.actionsTaken,
    skillReadyAt: engine.skillReadyAt,
    turnNo: engine.turnNo,
    immuneUntil: engine.immuneUntil,
    powerUntil: engine.powerUntil,
    flames: engine.flames,
    overlay: engine.overlay,
    twinStar: engine.twinStar,
    sabotage: engine.sabotage,
    sabotageBonus: engine.sabotageBonus,
    bloomCheaperNext: engine.bloomCheaperNext,
    skillCasts: engine.skillCasts,
    tempArmor: engine.tempArmor,
    tempArmorUntil: engine.tempArmorUntil,
    strikeBonus: engine.strikeBonus,
    strikeUntil: engine.strikeUntil,
    seedGrow: engine.seedGrow,
    noPlantBonus: engine.noPlantBonus,
    // bugv34m：Qwen 的两个技能状态
    deploy: engine.deploy,
    deployBonus: engine.deployBonus,
    redeployPending: engine.redeployPending,
    flameOwner: engine.flameOwner,
    nightPhase: engine.nightPhase,
    nightCountdown: engine.nightCountdown,
    nightTurns: engine.nightTurns,
    turnsSinceNight: engine.turnsSinceNight,
    weather: engine.weather,
    attacksLaunched: engine.attacksLaunched,
    nightAttackBase: engine.nightAttackBase,
    nightFromStart: engine.nightFromStart,
  })
}

/** 造一个"所有技能状态都非默认值"的局面，把两边可能漏掉的字段全部点亮。 */
function buildEngine(characters: [CharacterId, CharacterId]): GameEngine {
  const engine = new GameEngine()
  engine.skills = [skillsOfCharacter(characters[0]), skillsOfCharacter(characters[1])]
  const board = new Array<number>(81).fill(0) as Board
  board[cellId(8, 0)] = 1
  board[cellId(7, 0)] = 1
  board[cellId(8, 8)] = 2
  engine.loadScenario(board, {
    hp: [5, 6],
    current: 0,
    firstPlayer: 1,
    magic: [
      { cell: cellId(8, 0), kind: 'flower', owner: 0 },
      { cell: cellId(8, 8), kind: 'grass', owner: 1 },
    ],
    magicGrowths: 3,
    magicCooldown: 1,
    shield: [2, 1],
    bonusActions: [1, 0],
    actionsTaken: [7, 6],
    skillReadyAt: [
      [7, 9],
      [6, 8],
    ],
    turnNo: 4,
    immuneUntil: [5, 5],
    powerUntil: [6, 0],
    powerBonus: [1, 0],
    flames: [
      [cellId(4, 4), 3],
      [cellId(5, 5), 1],
    ],
    flameOwner: [
      [cellId(4, 4), 1],
      [cellId(5, 5), 0],
    ],
    overlay: [[cellId(7, 0), 0]],
    sabotage: [true, false],
    sabotageBonus: [1, 0],
    twinStar: [true, false],
    bloomCheaperNext: [false, true],
    skillCasts: [
      [1, 2],
      [0, 1],
    ],
    tempArmor: [6, 0],
    tempArmorUntil: [6, 0],
    strikeBonus: [1, 0],
    strikeUntil: [5, 0],
    seedGrow: [true, false],
    noPlantBonus: [true, false],
    // bugv34m：Qwen 的两个技能状态
    deploy: [true, false],
    deployBonus: [1, 0],
    redeployPending: [[cellId(3, 3) * 2, cellId(3, 4) * 2 + 1], []],
    lastPlacedBy: [cellId(8, 0), cellId(8, 8)],
    // bugv34：黑夜 / 天气 / 攻击棋子计数
    nightPhase: 'active',
    nightCountdown: 2,
    nightTurns: 7,
    turnsSinceNight: 12,
    weather: 'thunder',
    attacksLaunched: [11, 9],
    nightAttackBase: [4, 3],
    nightFromStart: true,
  })
  return engine
}

describe('前后端 fingerprint 字段清单必须一致（bugv27 #4）', () => {
  it('全技能状态非默认值时，服务端 digest 与客户端口径完全一致', () => {
    const engine = buildEngine(['gtp', 'glm'])
    expect(digestOfEngine(engine)).toBe(clientDigest(engine))
  })

  it('每个技能字段单独变化都会改变指纹（否则漂移检测形同虚设）', () => {
    const mutate: Array<[string, (engine: GameEngine) => void]> = [
      ['powerUntil', (e) => (e.powerUntil = [9, 0])],
      ['sabotageBonus', (e) => (e.sabotageBonus = [2, 0])],
      ['bloomCheaperNext', (e) => (e.bloomCheaperNext = [true, true])],
      ['tempArmor', (e) => (e.tempArmor = [3, 0])],
      ['tempArmorUntil', (e) => (e.tempArmorUntil = [8, 0])],
      ['strikeBonus', (e) => (e.strikeBonus = [2, 0])],
      ['strikeUntil', (e) => (e.strikeUntil = [8, 0])],
      ['seedGrow', (e) => (e.seedGrow = [false, true])],
      ['noPlantBonus', (e) => (e.noPlantBonus = [false, true])],
      ['deploy', (e) => (e.deploy = [false, true])],
      ['deployBonus', (e) => (e.deployBonus = [2, 0])],
      ['redeployPending', (e) => (e.redeployPending = [[cellId(1, 1) * 2], []])],
      ['flameOwner', (e) => (e.flameOwner = new Map<number, PlayerIndex>([[cellId(1, 1), 1]]))],
      ['nightPhase', (e) => (e.nightPhase = 'pending')],
      ['nightCountdown', (e) => (e.nightCountdown = 5)],
      ['nightTurns', (e) => (e.nightTurns = 9)],
      ['turnsSinceNight', (e) => (e.turnsSinceNight = 3)],
      ['weather', (e) => (e.weather = 'plague')],
      ['attacksLaunched', (e) => (e.attacksLaunched = [1, 2])],
      ['nightAttackBase', (e) => (e.nightAttackBase = [8, 8])],
      ['nightFromStart', (e) => (e.nightFromStart = false)],
    ]
    for (const [name, apply] of mutate) {
      const before = digestOfEngine(buildEngine(['gtp', 'glm']))
      const engine = buildEngine(['gtp', 'glm'])
      apply(engine)
      expect(digestOfEngine(engine), `${name} 必须参与指纹`).not.toBe(before)
    }
  })

  it('自检：服务端少传任意一项，指纹就会不同（证明上面的断言真的能发现问题）', () => {
    const engine = buildEngine(['gtp', 'glm'])
    const full = {
      board: engine.board,
      hp: engine.hp,
      phase: engine.phase,
      current: engine.current,
      firstPlayer: engine.firstPlayer,
      highlightOwner: engine.highlightOwner,
      highlights: engine.highlights,
      magic: engine.magic,
      magicGrowths: engine.magicGrowths,
      magicCooldown: engine.magicCooldown,
      shield: engine.shield,
      bonusActions: engine.bonusActions,
      actionsTaken: engine.actionsTaken,
      skillReadyAt: engine.skillReadyAt,
      turnNo: engine.turnNo,
      immuneUntil: engine.immuneUntil,
      powerUntil: engine.powerUntil,
      flames: engine.flames,
      overlay: engine.overlay,
      twinStar: engine.twinStar,
      sabotage: engine.sabotage,
      sabotageBonus: engine.sabotageBonus,
      bloomCheaperNext: engine.bloomCheaperNext,
      skillCasts: engine.skillCasts,
      tempArmor: engine.tempArmor,
      tempArmorUntil: engine.tempArmorUntil,
      strikeBonus: engine.strikeBonus,
      strikeUntil: engine.strikeUntil,
      seedGrow: engine.seedGrow,
      noPlantBonus: engine.noPlantBonus,
      deploy: engine.deploy,
      deployBonus: engine.deployBonus,
      redeployPending: engine.redeployPending,
      flameOwner: engine.flameOwner,
      nightPhase: engine.nightPhase,
      nightCountdown: engine.nightCountdown,
      nightTurns: engine.nightTurns,
      turnsSinceNight: engine.turnsSinceNight,
      weather: engine.weather,
      attacksLaunched: engine.attacksLaunched,
      nightAttackBase: engine.nightAttackBase,
      nightFromStart: engine.nightFromStart,
    }
    const expectOk = clientDigest(engine)
    // 逐项抹掉再算一次：任何一项都不该"抹了还一样"。
    // 排除项：`board` / `hp` / `phase` / `current` / `highlights` 是必填（抹掉会抛错），
    // `highlightOwner` 在本局面里是 `null`（等于默认值，抹掉自然不影响指纹）。
    const skip = new Set(['board', 'hp', 'phase', 'current', 'highlights', 'highlightOwner'])
    for (const key of Object.keys(full) as Array<keyof typeof full>) {
      if (skip.has(String(key))) continue
      const reduced = { ...full, [key]: undefined }
      expect(stateDigest(reduced), `漏传 ${String(key)} 必须导致指纹不同`).not.toBe(expectOk)
    }
  })
})
