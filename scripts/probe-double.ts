/**
 * 「杀鲸霸拳」（deepseek 二技能）**AI 用法探针**（bugv21）。
 *
 * ⛔ 只观察行为，**不改任何规则、不改任何数值**。
 * 要回答的问题是：**给定现在的 2~3 棵费用，AI 有没有用对这个技能？**
 * 而不是「把这个技能改强会怎样」（那是平衡决策，不是诊断）。
 *
 * 统计口径：
 *   1. **可得性**：每次轮到自己时，技能处于 可用 / 冷却中 / 卡植物 的哪一档；
 *   2. **档位**：实际选 2 棵还是 3 棵；选 2 棵时**放弃了多少真实加伤**（惩罚的真实成本）；
 *   3. **时机**：释放时我方本就能成线 / 对手能成线 / 都没有（投资）；
 *   4. **兑现**：本次行动窗口内是否真的形成连珠（未成线再追"下一两次行动内"是否补上）。
 *
 * 用法：
 *   pnpm exec tsx scripts/probe-double.ts [局数=12] [每手ms=70]
 *   NODES=15872 pnpm exec tsx scripts/probe-double.ts 12 70    # 确定性节点预算
 */
import { applyAiSkills, fallbackPlacement } from './harness'
import { decideMove, type AiMagicContext, type AiSkillContext } from '../src/ai/baseline'
import { GameEngine } from '../src/core/engine'
import { skillsOfCharacter } from '../src/core/characters'
import {
  BOARD_SIZE,
  CELL_COUNT,
  INITIAL_HP,
  MIN_LINE_LENGTH,
  other,
  type Board,
  type PlayerIndex,
} from '../src/core/types'
import { mulberry32 } from './variants'

const GAMES = Number(process.argv[2] ?? 12)
const BUDGET = Number(process.argv[3] ?? 70)
const NODES = Number(process.env.NODES ?? 0) // 0 = 退回时间预算
const DIFFICULTY = 'expert' as const
const RANDOM_OPEN_PLIES = 8
const MAX_PLIES = 260
const CHAR = 'deepseek' as const

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
]

/** 落一颗子在空位后能否形成 ≥4 连（只看经过该点的线）。 */
function makesLineAt(board: Board, cell: number, target: number): boolean {
  const row = Math.floor(cell / BOARD_SIZE)
  const col = cell % BOARD_SIZE
  for (const [dr, dc] of DIRS) {
    let run = 1
    for (const sign of [1, -1]) {
      for (let k = 1; k < MIN_LINE_LENGTH; k++) {
        const r = row + sign * dr * k
        const c = col + sign * dc * k
        if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) break
        if (board[r * BOARD_SIZE + c] !== target) break
        run += 1
      }
    }
    if (run >= MIN_LINE_LENGTH) return true
  }
  return false
}

/** 这一手有没有"落子即成线"的点（= 不靠技能也能发起攻击）。 */
function hasLineMove(board: Board, player: PlayerIndex): boolean {
  const target = player + 1
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    if (board[cell] !== 0) continue
    board[cell] = target as 1 | 2
    const ok = makesLineAt(board, cell, target)
    board[cell] = 0
    if (ok) return true
  }
  return false
}

/**
 * 手里有多少棵植物**正占在"我方 ≥2 子且无对手子"的成线窗口里**
 * —— 口径与 `baseline.ts` 的 `plantOnLineWindow` 一致，这些植物是**真加伤**。
 * 选最低档 = 放弃它们的加伤，这就是惩罚的真实成本。
 */
function plantsOnLineWindows(
  board: Board,
  plants: ReadonlyMap<number, { cell: number; owner: PlayerIndex | null }>,
  player: PlayerIndex,
): number {
  const target = player + 1
  let count = 0
  for (const p of plants.values()) {
    if (p.owner !== player) continue
    const cell = p.cell
    const row = Math.floor(cell / BOARD_SIZE)
    const col = cell % BOARD_SIZE
    let onWindow = false
    for (const [dr, dc] of DIRS) {
      for (let start = -3; start <= 0 && !onWindow; start++) {
        let mine = 0
        let theirs = 0
        let inside = true
        for (let k = 0; k < 4; k++) {
          const r = row + (start + k) * dr
          const c = col + (start + k) * dc
          if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) {
            inside = false
            break
          }
          const v = board[r * BOARD_SIZE + c]
          if (v === target) mine += 1
          else if (v !== 0) theirs += 1
        }
        if (inside && mine >= 2 && theirs === 0) onWindow = true
      }
      if (onWindow) break
    }
    if (onWindow) count += 1
  }
  return count
}

interface Stats {
  games: number
  plies: number
  /** 轮到自己时的技能状态。 */
  turnReady: number
  turnCooldown: number
  turnStarved: number
  /** 释放量。 */
  casts: number
  castTier2: number
  castTier3: number
  /** 释放时局面。 */
  castMineCanAttack: number
  castFoeCanAttack: number
  castNoLine: number
  /** 选最低档时放弃的加伤（点）。 */
  forgoneTotal: number
  forgoneSamples: number
  forgoneZero: number
  /** 兑现。 */
  cashedSameTurn: number
  cashedLater: number
  neverCashed: number
  /** 白放（本次行动没成线）时的局面。"纯投资"占比很关键。 */
  wasteNoLine: number
  damageTotal: number
  /** 档位细分：**当手成线**的释放里，最低档放弃了多少加伤 / 那一手实际打了多少伤害。 */
  cashedForgoneTotal: number
  cashedForgoneSamples: number
  cashedDamageTotal: number
}

function emptyStats(): Stats {
  return {
    games: 0,
    plies: 0,
    turnReady: 0,
    turnCooldown: 0,
    turnStarved: 0,
    casts: 0,
    castTier2: 0,
    castTier3: 0,
    castMineCanAttack: 0,
    castFoeCanAttack: 0,
    castNoLine: 0,
    forgoneTotal: 0,
    forgoneSamples: 0,
    forgoneZero: 0,
    cashedSameTurn: 0,
    cashedLater: 0,
    neverCashed: 0,
    wasteNoLine: 0,
    damageTotal: 0,
    cashedForgoneTotal: 0,
    cashedForgoneSamples: 0,
    cashedDamageTotal: 0,
  }
}

type AnyEvent = { type: string; [key: string]: unknown }

function playGame(seed: number): Stats {
  const rng = mulberry32(seed)
  const specs = [skillsOfCharacter(CHAR), skillsOfCharacter(CHAR)]
  const engine = new GameEngine({
    initialHp: INITIAL_HP,
    fixedFirstPlayer: 0,
    magic: { enabled: true },
    skills: [specs[0], specs[1]],
  })
  engine.takeEvents()

  const doubleSlot = specs[0].findIndex((s) => s.effect === 'double')
  const damagePerPlant = engine.magicConfig.damagePerPlant

  const magicCtx = (): AiMagicContext => ({
    plants: [...engine.magic.values()].map((p) => [p.cell, p.owner] as [number, PlayerIndex | null]),
    damagePerPlant,
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

  const st = emptyStats()
  st.games = 1

  /** 一次释放的"待兑现"窗口。 */
  interface Pending {
    player: PlayerIndex
    tier: number
    atAction: number
    /** 释放时我方是否本就能成线（`false` 且未成线 ⇒ 没成线时不一定是"投资"）。 */
    hadOwnLineAvailable: boolean
    /** 最低档放弃的加伤点数（非最低档为 0）。 */
    forgone: number
    cashed: boolean
  }
  let pending: Pending | null = null
  /**
   * 每一次释放的记录（按玩家留一份）—— `attackResolved` 发生在 `defend()` 里，
   * 比 `matchFormed` **晚一步**，此时窗口已经关闭，必须靠这张表回捞伤害。
   */
  const lastCast: Array<Pending | null> = [null, null]
  /** 未当手兑现、等待"下一次自己行动内补上"的记录。 */
  const followUp = new Map<PlayerIndex, { casts: number[]; cashed: number }>()

  const noteMatch = (owner: PlayerIndex): void => {
    if (pending && pending.player === owner) {
      if (!pending.cashed) {
        st.cashedSameTurn += 1
        // 只有"当手就成线"的释放，被放弃的加伤才是**真损失**
        st.cashedForgoneTotal += pending.forgone
        st.cashedForgoneSamples += 1
      }
      pending.cashed = true
      return
    }
    // 延迟兑现：未成线的那几次释放，在自己接下来的两次行动内补上了
    const rec = followUp.get(owner)
    if (!rec || rec.casts.length === 0) return
    const at = engine.actionsTaken[owner]
    const idx = rec.casts.findIndex((a) => at - a <= 2)
    if (idx >= 0) {
      rec.casts.splice(idx, 1)
      rec.cashed += 1
      st.cashedLater += 1
    }
  }

  const closeWindow = (): void => {
    if (!pending) return
    if (!pending.cashed) {
      st.neverCashed += 1
      if (!pending.hadOwnLineAvailable) st.wasteNoLine += 1
      const rec = followUp.get(pending.player) ?? { casts: [], cashed: 0 }
      rec.casts.push(engine.actionsTaken[pending.player])
      followUp.set(pending.player, rec)
    }
    pending = null
  }

  const drain = (events: readonly AnyEvent[]): void => {
    for (const e of events) {
      if (e.type === 'matchFormed') {
        const owner = Number((e.match as { owner?: number } | undefined)?.owner ?? -1)
        if (owner === 0 || owner === 1) noteMatch(owner as PlayerIndex)
      } else if (e.type === 'attackResolved') {
        const dmg = Number(e.damage ?? 0)
        const snap = e.snapshot as { attacker?: number } | undefined
        const attacker = Number(snap?.attacker ?? -1)
        if (dmg > 0) {
          // 只有"真打到对手身上"才算这次攻击的收益（对撞落败会打自己）
          const damaged = Number((e.snapshot as { damaged?: number | null } | undefined)?.damaged ?? -1)
          const landed = damaged !== attacker
          if (landed) {
            st.damageTotal += dmg
            const rec = attacker === 0 || attacker === 1 ? lastCast[attacker] : null
            if (rec && rec.cashed) {
              st.cashedDamageTotal += dmg
              lastCast[attacker] = null // 只归因一次
            }
          }
        }
      }
    }
  }

  let plies = 0
  while (!engine.isOver && plies < MAX_PLIES) {
    plies += 1

    // 谁在行动（判定"自己的行动窗口"有没有结束）
    const actor: PlayerIndex = engine.awaitingDefense
      ? other(engine.highlightOwner ?? 0)
      : engine.current
    if (pending && pending.player !== actor) closeWindow()

    if (plies <= RANDOM_OPEN_PLIES) {
      if (engine.awaitingDefense) {
        const empties = engine.emptyCells()
        if (empties.length === 0) break
        drain(engine.defend(empties[Math.floor(rng() * empties.length)]) as AnyEvent[])
      } else {
        const legal = engine.legalMoves().filter((cell) => !engine.flames.has(cell))
        if (legal.length === 0) break
        drain(engine.commit(legal[Math.floor(rng() * legal.length)]) as AnyEvent[])
      }
      continue
    }

    if (engine.awaitingDefense) {
      const defender = other(engine.highlightOwner ?? 0)
      const dec = decideMove({
        board: engine.board as Board,
        player: defender,
        selfHp: engine.hp[defender],
        opponentHp: engine.hp[other(defender)],
        mode: 'defend',
        highlightWeights: engine.highlights,
        attackBaseDamage: engine.attack?.baseDamage,
        attackPlants: engine.attack?.attackerPlants,
        difficulty: DIFFICULTY,
        timeLimitMs: BUDGET,
        nodeLimit: NODES,
        magic: magicCtx(),
        skills: skillCtx(),
      })
      drain(engine.defend(dec.move) as AnyEvent[])
      continue
    }

    const player = engine.current

    // ---- 可得性：轮到自己时这个技能处于哪一档 ----
    const stateBefore = engine.skillStateFor(player, doubleSlot)
    if (stateBefore) {
      if (stateBefore.ready) st.turnReady += 1
      else if (stateBefore.remaining > 0) st.turnCooldown += 1
      else st.turnStarved += 1 // 冷却好了但植物不够
    }

    const dec = decideMove({
      board: engine.board as Board,
      player,
      selfHp: engine.hp[player],
      opponentHp: engine.hp[other(player)],
      mode: 'attack',
      difficulty: DIFFICULTY,
      timeLimitMs: BUDGET,
      nodeLimit: NODES,
      magic: magicCtx(),
      skills: skillCtx(),
    })

    // ---- 释放前的局面快照（技能生效前）----
    const mineCanAttack = hasLineMove(engine.board as Board, player)
    const foeCanAttack = hasLineMove(engine.board as Board, other(player))
    const onWindow = plantsOnLineWindows(engine.board as Board, engine.magic, player)

    const applied = applyAiSkills(engine, player, dec.skills)
    for (const used of applied.used) {
      if (used.effect !== 'double') continue
      const tier = used.cells.length
      st.casts += 1
      if (tier <= 2) st.castTier2 += 1
      else st.castTier3 += 1
      if (mineCanAttack) st.castMineCanAttack += 1
      if (foeCanAttack) st.castFoeCanAttack += 1
      if (!mineCanAttack && !foeCanAttack) st.castNoLine += 1
      if (tier <= 2) {
        // 惩罚：本回合植物不加伤 ⇒ 这些是真被放弃的伤害
        const forgone = onWindow * damagePerPlant
        st.forgoneTotal += forgone
        st.forgoneSamples += 1
        if (forgone === 0) st.forgoneZero += 1
      }
      pending = {
        player,
        tier,
        atAction: engine.actionsTaken[player],
        hadOwnLineAvailable: mineCanAttack,
        forgone: tier <= 2 ? onWindow * damagePerPlant : 0,
        cashed: false,
      }
      lastCast[player] = pending
    }
    if (applied.skipPlacement) continue

    let move = dec.move
    if (move < 0 || !engine.canPlaceAt(move)) {
      const pick = fallbackPlacement(engine, player)
      if (pick === undefined) break
      move = pick
    }
    drain(engine.commit(move) as AnyEvent[])
  }
  closeWindow()

  st.plies = plies
  return st
}

function pct(a: number, b: number): string {
  return b === 0 ? '—' : `${((100 * a) / b).toFixed(1)}%`
}

const total = emptyStats()
for (let i = 0; i < GAMES; i++) {
  const s = playGame(1000 + i * 7919)
  total.games += 1
  total.plies += s.plies
  for (const k of Object.keys(total) as Array<keyof Stats>) total[k] += s[k]
}

const g = total.games
console.log(
  `「杀鲸霸拳」AI 用法探针 · deepseek 自对弈 ${g} 局（平均 ${(total.plies / g).toFixed(1)} 手）` +
    `${NODES > 0 ? ` · 确定性 ${NODES} 节点` : ` · 时间预算 ${BUDGET}ms`}`,
)
console.log('')
console.log('【一、可得性】轮到自己时的技能状态')
console.log(
  `  可用 ${total.turnReady} 次 · 冷却中 ${total.turnCooldown} 次 · ` +
    `卡植物 ${total.turnStarved} 次`,
)
console.log(
  `  ⇒ **冷却已好时，植物不够的比例 = ${pct(total.turnStarved, total.turnReady + total.turnStarved)}**` +
    `（${total.turnStarved}/${total.turnReady + total.turnStarved}）`,
)
console.log('')
console.log('【二、档位】')
console.log(
  `  共释放 ${total.casts} 次（${(total.casts / g).toFixed(2)} 次/局）· ` +
    `2 棵 ${total.castTier2} 次（${pct(total.castTier2, total.casts)}）/ 3 棵 ${total.castTier3} 次（${pct(total.castTier3, total.casts)}）`,
)
if (total.forgoneSamples > 0) {
  const avg = total.forgoneTotal / total.forgoneSamples
  console.log(
    `  选最低档时**放弃的加伤**：平均 ${avg.toFixed(2)} 点/次 · ` +
      `其中 ${pct(total.forgoneZero, total.forgoneSamples)} 次放弃 **0 点**（惩罚白挨）`,
  )
}
console.log('')
console.log('【三、释放时的局面】')
console.log(
  `  我方本就能成线 ${total.castMineCanAttack} 次（${pct(total.castMineCanAttack, total.casts)}）· ` +
    `对手能成线 ${total.castFoeCanAttack} 次（${pct(total.castFoeCanAttack, total.casts)}）`,
)
console.log(
  `  两边都没有成线点（纯布局/投资）${total.castNoLine} 次（${pct(total.castNoLine, total.casts)}）`,
)
console.log('')
console.log('【四、兑现】')
console.log(
  `  本次行动内成线 ${total.cashedSameTurn} 次（${pct(total.cashedSameTurn, total.casts)}）· ` +
    `随后两次行动内补上 ${total.cashedLater} 次 · 始终没成线 ${total.neverCashed} 次（${pct(total.neverCashed, total.casts)}）`,
)
console.log(
  `  没成线的里面：释放时**本来就没有成线机会**的占 ${total.wasteNoLine} 次（${pct(total.wasteNoLine, total.neverCashed)}）`,
)
console.log(`  总伤害 ${total.damageTotal}（${(total.damageTotal / g).toFixed(1)}/局）`)
console.log('')
console.log('【五、档位选得对不对】只看"当手就成线"的释放（被放弃的加伤才是真损失）')
if (total.cashedForgoneSamples > 0) {
  const f = total.cashedForgoneTotal / total.cashedForgoneSamples
  const d = total.cashedDamageTotal / total.cashedForgoneSamples
  console.log(
    `  当手成线 ${total.cashedForgoneSamples} 次：平均放弃加伤 **${f.toFixed(2)} 点** · ` +
      `而这些释放平均打出 **${d.toFixed(2)} 点**伤害 ⇒ 放弃占伤害的 ${pct(f, d + f)}`,
  )
  console.log(
    `  （即：这些攻击本可以更重；改用高档只多花 1 棵植物。这是"AI 愿不愿意用 1 棵植物换这些伤害"的取舍。）`,
  )
} else {
  console.log('  样本不足')
}
