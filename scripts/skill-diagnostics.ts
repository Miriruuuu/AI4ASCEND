/**
 * 技能可用性诊断：把「角色胜率低」拆成两种截然不同的原因。
 *
 * - **用不出来**（资源/条件卡死）：技能就绪门槛根本达不到 → 是**技能设计/数值**的问题；
 * - **用出来了但没效果 / 该用时不用**：AI 的**释放时机**问题 → 是搜索与评估的问题。
 *
 * 统计口径：在每个「己方落子回合」的行动点上，对每个技能槽记录
 *   - 是否 ready（冷却好了 + 植物够 + 条件满足）；
 *   - 若没 ready，卡在哪一条（冷却 / 植物 / 条件）；
 *   - 本回合实际有没有放掉。
 * 另外记录「场上被己方棋子占用的植物数」的分布 —— 这是技能经济的燃料表。
 *
 * 用法：
 *   pnpm exec tsx scripts/skill-diagnostics.ts [局数] [每步预算ms] [手数上限] [随机开局手数] [角色列表]
 * 默认：40 局 / 70ms / 220 手 / 8 手随机开局 / 全部 4 角色
 */
import { decideMove, type AiDifficulty, type AiMagicContext, type AiSkillContext } from '../src/ai/baseline'
import { CHARACTER_SPECS, skillsOfCharacter, type CharacterId } from '../src/core/characters'
import { GameEngine } from '../src/core/engine'
import { INITIAL_HP, other, type Board, type PlayerIndex } from '../src/core/types'

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface SkillStat {
  name: string
  effect: string
  cost: number
  /** 己方行动点总数（分母）。 */
  turns: number
  /** ready 的行动点数。 */
  ready: number
  /** 卡在冷却。 */
  blockCooldown: number
  /** 卡在植物不足。 */
  blockPlants: number
  /** 卡在条件（毒鸡蛋无目标）。 */
  blockCondition: number
  /** 「闸门本可放」的行动点数（ready 且 AI 认为这一手有意义）。 */
  allowed: number
  /** 实际释放次数。 */
  casts: number
  /**
   * **可变消耗技能**的档位分布（下标 = 实际交的植物数）。
   *
   * bugv31 加：恶龙吐息改成"2 费档交回合 / 3 费档不交回合"之后，
   * 只看释放次数已经看不出 AI 到底会不会挑档位了。
   */
  tiers: number[]
}

const BOARD = 9

/** 本地版「落子即可成线」判定（不修改引擎，只看棋盘数组）。 */
function hasLineMove(board: readonly number[], player: PlayerIndex, minLen: number): boolean {
  const target = player + 1
  for (let r = 0; r < BOARD; r++) {
    for (let c = 0; c < BOARD; c++) {
      const cell = r * BOARD + c
      if (board[cell] !== 0) continue
      const dirs = [
        [0, 1],
        [1, 0],
        [1, 1],
        [1, -1],
      ] as const
      for (const [dr, dc] of dirs) {
        let len = 1
        let rr = r - dr
        let cc = c - dc
        while (rr >= 0 && rr < BOARD && cc >= 0 && cc < BOARD && board[rr * BOARD + cc] === target) {
          len += 1
          rr -= dr
          cc -= dc
        }
        rr = r + dr
        cc = c + dc
        while (rr >= 0 && rr < BOARD && cc >= 0 && cc < BOARD && board[rr * BOARD + cc] === target) {
          len += 1
          rr += dr
          cc += dc
        }
        if (len >= minLen) return true
      }
    }
  }
  return false
}

interface CharStat {
  id: CharacterId
  name: string
  games: number
  wins: number
  skills: SkillStat[]
  /** 己方行动点上的「己方植物数」分布。 */
  plantHist: number[]
  /** 己方行动点上的「对手植物数」分布（看总量是否够）。 */
  totalPlantHist: number[]
}

function playGame(
  charIds: readonly [CharacterId, CharacterId],
  firstPlayer: PlayerIndex,
  budget: number,
  maxPlies: number,
  randomOpenPlies: number,
  seed: number,
  difficulty: AiDifficulty,
  stats: Map<CharacterId, CharStat>,
): void {
  const rng = mulberry32(seed)
  const engine = new GameEngine({
    initialHp: INITIAL_HP,
    fixedFirstPlayer: firstPlayer,
    magic: { enabled: true },
    skills: [skillsOfCharacter(charIds[0]), skillsOfCharacter(charIds[1])],
  })
  engine.takeEvents()

  const magicCtx = (): AiMagicContext => ({
    plants: [...engine.magic.values()].map(
      (plant) => [plant.cell, plant.owner] as [number, PlayerIndex | null],
    ),
    damagePerPlant: engine.magicConfig.damagePerPlant,
  })
  const skillCtx = (): AiSkillContext => ({
    skills: engine.skills,
    shield: [engine.shield[0], engine.shield[1]],
    bonusActions: [engine.bonusActions[0], engine.bonusActions[1]],
    actionsTaken: [engine.actionsTaken[0], engine.actionsTaken[1]],
    skillReadyAt: [engine.skillReadyAt[0].slice(), engine.skillReadyAt[1].slice()],
    skillCasts: [engine.skillCasts[0].slice(), engine.skillCasts[1].slice()],
    powerBonus: [engine.powerBonus[0], engine.powerBonus[1]],
    powerUntil: [engine.powerUntil[0], engine.powerUntil[1]],
    sabotage: [engine.sabotage[0], engine.sabotage[1]],
    sabotageBonus: [engine.sabotageBonus[0], engine.sabotageBonus[1]],
    twinStar: [engine.twinStar[0], engine.twinStar[1]],
    bloomCheaperNext: [engine.bloomCheaperNext[0], engine.bloomCheaperNext[1]],
    tempArmor: [engine.tempArmor[0], engine.tempArmor[1]],
    tempArmorUntil: [engine.tempArmorUntil[0], engine.tempArmorUntil[1]],
    strikeBonus: [engine.strikeBonus[0], engine.strikeBonus[1]],
    strikeUntil: [engine.strikeUntil[0], engine.strikeUntil[1]],
    seedGrow: [engine.seedGrow[0], engine.seedGrow[1]],
    flameOwner: [...engine.flameOwner.entries()] as Array<[number, number]>,
    immuneUntil: [engine.immuneUntil[0], engine.immuneUntil[1]],
    turnNo: engine.turnNo,
    flames: [...engine.flames.entries()],
    overlay: [...engine.overlay.entries()] as Array<[number, number]>,
    initialHp: INITIAL_HP,
  })

  let plies = 0
  while (!engine.isOver && plies < maxPlies) {
    plies += 1

    if (plies <= randomOpenPlies) {
      if (engine.awaitingDefense) {
        const empties = engine.emptyCells()
        if (empties.length === 0) break
        engine.defend(empties[Math.floor(rng() * empties.length)])
      } else {
        const legal = engine.legalMoves().filter((cell) => !engine.flames.has(cell))
        if (legal.length === 0) break
        engine.commit(legal[Math.floor(rng() * legal.length)])
      }
      engine.takeEvents()
      continue
    }

    if (engine.awaitingDefense) {
      const defender: PlayerIndex = other(engine.highlightOwner ?? 0)
      const decision = decideMove({
        board: engine.board as Board,
        player: defender,
        selfHp: engine.hp[defender],
        opponentHp: engine.hp[other(defender)],
        mode: 'defend',
        highlightWeights: engine.highlights,
        difficulty,
        timeLimitMs: budget,
        magic: magicCtx(),
        // bugv13 #2：防守搜索也要看得到技能状态
        skills: skillCtx(),
      })
      if (decision.move < 0 || engine.board[decision.move] !== 0) throw new Error('防守方给出非法落点')
      engine.defend(decision.move)
      engine.takeEvents()
      continue
    }

    const player = engine.current
    const charId = charIds[player]
    const cs = stats.get(charId)!

    // ---- 采样技能可用性 ----
    const states = engine.skillStates()[player]
    const owned = engine.ownedPlants(player).length
    const totalPlants = engine.magic.size
    cs.plantHist[Math.min(owned, 8)] += 1
    cs.totalPlantHist[Math.min(totalPlants, 12)] += 1

    // 复刻 AI 的闸门口径，区分「该放却没放」与「闸门判定不该放」
    const boardArr = engine.board as readonly number[]
    const mineAttack4 = hasLineMove(boardArr, player, 4)
    const mineAttack2 = hasLineMove(boardArr, player, 2)
    const foeAttack4 = hasLineMove(boardArr, other(player), 4)
    const hp = engine.hp[player]

    for (const st of states) {
      const s = cs.skills.find((x) => x.name === st.name)!
      s.turns += 1
      if (st.ready) {
        s.ready += 1
        switch (st.effect) {
          case 'power':
            if (mineAttack4) s.allowed += 1
            break
          case 'bloom':
            if (mineAttack2) s.allowed += 1
            break
          case 'immune':
            if (mineAttack4 || foeAttack4 || hp <= 2) s.allowed += 1
            break
          case 'shield':
            if (mineAttack4 || foeAttack4 || hp <= 3) s.allowed += 1
            break
          case 'heal':
            if (hp < INITIAL_HP) s.allowed += 1
            break
          case 'sabotage':
            if (engine.sabotageTargets(player).length > 0) s.allowed += 1
            break
          default:
            s.allowed += 1
            break
        }
      } else if (st.reason && st.reason.startsWith('冷却中')) {
        s.blockCooldown += 1
      } else if (st.reason && st.reason.startsWith('魔力植物不足')) {
        s.blockPlants += 1
      } else if (st.reason && st.reason.startsWith('场上没有')) {
        s.blockCondition += 1
      }
    }

    const decision = decideMove({
      board: engine.board as Board,
      player,
      selfHp: engine.hp[player],
      opponentHp: engine.hp[other(player)],
      mode: 'attack',
      difficulty,
      timeLimitMs: budget,
      magic: magicCtx(),
      skills: skillCtx(),
    })

    for (const use of decision.skills ?? []) {
      if (engine.current !== player) break
      const state = engine.skillStateFor(player, use.slot)
      if (!state || !state.ready) break
      // ⚠️ bugv31：可变消耗技能的合法植物数是一个**区间**（恶龙吐息 2~3），
      // 不能再用 `=== skillCostNow()` 去卡 —— 那样 AI 的 3 费档候选会被全部拒掉，
      // 诊断结果会假装"AI 从来不用 3 费档"。
      // 首次免费（costNow === 0）时则必须正好 0 棵。
      const cells = (use.cells ?? []).filter((cell) => engine.magic.get(cell)?.owner === player)
      const min = state.costNow <= 0 ? 0 : (state.costMin ?? state.costNow)
      const max = state.costNow <= 0 ? 0 : (state.costMax ?? state.costNow)
      if (cells.length < min || cells.length > max) break
      if (state.targetsCell && (use.target === undefined || use.target < 0)) break
      const s = cs.skills.find((x) => x.name === state.name)!
      s.casts += 1
      s.tiers[cells.length] = (s.tiers[cells.length] ?? 0) + 1
      engine.useSkill(player, use.slot, cells, state.targetsCell ? use.target : null)
      engine.takeEvents()
    }

    // endsTurn 技能（恶龙吐息）：用完回合已经交给对手，这一手不再落子
    if (engine.current !== player) continue

    let move = decision.move
    if (move < 0 || !engine.canPlaceAt(move)) {
      const legal = engine.legalMoves().filter((cell) => engine.canPlaceAt(cell) && !engine.flames.has(cell))
      const pick = legal[0] ?? engine.legalMoves().find((cell) => engine.canPlaceAt(cell))
      if (pick === undefined) break
      move = pick
    }
    engine.commit(move)
    engine.takeEvents()
  }

  if (engine.result) {
    const ws = stats.get(charIds[engine.result.winner])!
    ws.wins += 1
  }
  stats.get(charIds[0])!.games += 1
  stats.get(charIds[1])!.games += 1
}

// ---- CLI ----
const games = Number(process.argv[2] ?? 40)
const budget = Number(process.argv[3] ?? 70)
const maxPlies = Number(process.argv[4] ?? 220)
const randomOpenPlies = Number(process.argv[5] ?? 8)
const charList = (process.argv[6] ?? CHARACTER_SPECS.map((c) => c.id).join(','))
  .split(',')
  .filter(Boolean) as CharacterId[]

// ⚠️ 对局是"角色两两配对"生成的（`for i / for j>i`）—— 只传 1 个角色会**一局都跑不出来**。
// 之前这里静默输出"0 局 / 全 0"，很容易被当成"这个角色技能根本用不出来"。
if (charList.length < 2) {
  console.error(`❌ 至少需要 2 个角色（角色是两两配对的），当前只有 ${charList.length} 个：${charList.join(',') || '(空)'}`)
  process.exit(2)
}

const stats = new Map<CharacterId, CharStat>()
for (const id of charList) {
  const spec = CHARACTER_SPECS.find((c) => c.id === id)!
  stats.set(id, {
    id,
    name: spec.name,
    games: 0,
    wins: 0,
    skills: spec.skills.map((sk) => ({
      name: sk.name,
      effect: sk.effect,
      cost: sk.cost,
      turns: 0,
      ready: 0,
      blockCooldown: 0,
      blockPlants: 0,
      blockCondition: 0,
      allowed: 0,
      casts: 0,
      tiers: [],
    })),
    plantHist: new Array(9).fill(0),
    totalPlantHist: new Array(13).fill(0),
  })
}

const started = Date.now()
let gameNo = 0
for (let i = 0; i < charList.length; i++) {
  for (let j = i + 1; j < charList.length; j++) {
    for (let g = 0; g < Math.ceil(games / (charList.length * 2)); g++) {
      const seed = 0x1234567 + (i * 100 + j) * 7919 + g * 104729
      for (const [c0, c1] of [
        [charList[i], charList[j]],
        [charList[j], charList[i]],
      ] as Array<[CharacterId, CharacterId]>) {
        gameNo += 1
        playGame([c0, c1], 0, budget, maxPlies, randomOpenPlies, seed, 'expert', stats)
      }
    }
  }
}

console.log(`共 ${gameNo} 局，用时 ${((Date.now() - started) / 1000).toFixed(1)}s\n`)

for (const id of charList) {
  const cs = stats.get(id)!
  console.log(
    `${cs.name}（${id}）  ${cs.games} 局 胜 ${cs.wins}  （胜率 ${((cs.wins / Math.max(1, cs.games)) * 100).toFixed(1)}%）`,
  )
  console.log('  技能              行动点    ready   卡冷却  卡植物  卡条件   闸门可放   实放   实放/闸门')
  for (const s of cs.skills) {
    const rate = s.allowed === 0 ? 0 : (s.casts / s.allowed) * 100
    console.log(
      `  ${s.name.padEnd(8)}(cost${s.cost}) ${String(s.turns).padStart(6)}` +
        ` ${String(s.ready).padStart(6)} ${String(s.blockCooldown).padStart(7)}` +
        ` ${String(s.blockPlants).padStart(7)} ${String(s.blockCondition).padStart(7)}` +
        ` ${String(s.allowed).padStart(9)} ${String(s.casts).padStart(6)}   ${rate.toFixed(1).padStart(5)}%`,
    )
    // 可变消耗技能：把"交了几棵"摊开看清楚（bugv31）
    const tierTotal = s.tiers.reduce((a, b) => a + (b ?? 0), 0)
    if (tierTotal > 0) {
      const parts = s.tiers
        .map((n, k) => (n ? `${k}棵×${n}` : null))
        .filter((x): x is string => x !== null)
        .join('  ')
      console.log(`    档位分布：${parts}`)
    }
  }
  const ownAvg =
    cs.plantHist.reduce((acc, n, k) => acc + n * k, 0) / Math.max(1, cs.plantHist.reduce((a, b) => a + b, 0))
  const totalAvg =
    cs.totalPlantHist.reduce((acc, n, k) => acc + n * k, 0) /
    Math.max(1, cs.totalPlantHist.reduce((a, b) => a + b, 0))
  console.log(
    `  己方植物数分布(0~8+): ${cs.plantHist.join(' ')}   均值 ${ownAvg.toFixed(2)}` +
      ` | 全盘植物均值 ${totalAvg.toFixed(2)}`,
  )
  console.log('')
}
