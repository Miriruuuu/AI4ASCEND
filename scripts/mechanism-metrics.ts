/**
 * 技能"机制指标"诊断（bugv15）。
 *
 * 为什么需要它：只看胜率时，分不清"技能没用"是 **放得太少**、**放得太多**，
 * 还是 **放了没生效**。胜率还会被噪声吞掉（320 局 ±5.4），机制指标不会。
 *
 * 它跑**同角色镜像自对弈**，统计三类可解释的量：
 * - **到期浪费率**：限时效果里"到期清零的部分 / 释放总量"。
 *   本项目实测：护甲 80% 到期作废 → 直指"一有冷却就放"这个毛病。
 * - **资源转化率**：生成的资源里"后来真被占下/使用的比例"。
 *   本项目实测：播种长出的植物只有 14~21% 被占下、50% 随连珠被扫掉。
 * - **连招使用率**：连招第一步（打在专门靶子上）的占比 + 第二步（走自己的火）
 *   当步就成线的比例。这是"用户说的那套连招到底有没有在跑"的唯一硬证据。
 *
 * 用法：
 *   pnpm exec tsx scripts/mechanism-metrics.ts [角色,角色,...] [局数] [每手ms]
 *   例：pnpm exec tsx scripts/mechanism-metrics.ts gtp,claude 12 70
 *
 * bugv20：新增"技能收益兑现"一组指标（用户要求检查"AI 是不是在**一定能兑现**时才放技能"）：
 * - **同手兑现率**：放了技能的这一手里，真的形成了连珠攻击的比例（按 effect 分档）；
 * - **可变消耗分布**：每个技能实际花了多少棵植物（如「杀鲸霸拳」到底选 2 档还是 3 档）；
 * - **小一哥持续兑现**：释放次数 / 至少兑现一次的比例 / 平均兑现次数（每次生效内成线几次）。
 *
 * 确定性：`NODES=<节点预算> pnpm exec tsx ...`（不传则退回 `每手ms` 时间预算）。
 */
import { applyAiSkills, fallbackPlacement } from './harness'
import { decideMove, type AiMagicContext, type AiSkillContext } from '../src/ai/baseline'
import { GameEngine } from '../src/core/engine'
import { skillsOfCharacter, type CharacterId } from '../src/core/characters'
import { INITIAL_HP, other, type Board, type PlayerIndex } from '../src/core/types'
import { mulberry32 } from './variants'

const chars = (process.argv[2] ?? 'gtp').split(',').filter(Boolean) as CharacterId[]
const PAIRS = Number(process.argv[3] ?? 10)
const BUDGET = Number(process.argv[4] ?? 70)
/** >0 时用确定性节点预算（同命令两遍结果一致），否则用 `BUDGET` 毫秒。 */
const NODES = Number(process.env.NODES ?? 0)
const DIFFICULTY = 'expert' as const
const MAX_PLIES = 220
const RANDOM_OPEN_PLIES = 8

interface Stats {
  games: number
  plies: number
  skillUses: Record<string, number>
  /** 限时护甲：释放点 / 被伤害吃掉 / 到期浪费 */
  armorCast: number
  armorAbsorbed: number
  armorWasted: number
  /**
   * 护盾（永久，只在终局才会"剩下"）：授予 / 被伤害吃掉 / 终局剩余。
   *
   * 🚩 这一组是**校准 `SHIELD_WEIGHT` 的唯一依据**：
   * 护盾点数的真实价值 = `HP_WEIGHT × 被吃掉的比例`（剩下的那部分等于白花）。
   * 把它和"一棵植物值多少"对比，就能看出当前定价是偏高还是偏低。
   */
  shieldGranted: number
  shieldAbsorbed: number
  shieldLeftover: number
  /** 播种：长出的植物 / 后来有主 / 终局仍无主 */
  seeds: number
  seedOwned: number
  seedIdle: number
  /** 火球：释放次数 / 打在"挡我方成线的敌子"上的次数 */
  fbCast: number
  fbOnBlocker: number
  /** 连招第二步：走自己的火 / 其中当步就成线 */
  flameWalk: number
  flameWalkLine: number
  // --- bugv20：技能收益兑现 ---------------------------------------------
  /** 每次**放了技能**的决策里，该技能对应的"这一手有没有真的开打"。 */
  handCast: Record<string, number>
  handAttacked: Record<string, number>
  /** 可变消耗技能实际花掉的植物数分布：effect -> 「棵数」-> 次数。 */
  costHist: Record<string, Record<string, number>>
  /** 「小一哥」：释放次数 / 至少兑现过一次的释放数 / 生效期内成线总次数。 */
  powerCast: number
  powerCashedCasts: number
  powerMatches: number
}

/** 事件类型集合（引擎 `GameEvent` 的判别联合太窄，这里只做结构匹配）。 */
type AnyEvent = { type: string } & Record<string, unknown>

/** `cell` 是不是"挡在我方成线窗口里的敌子"（窗口恰好 3 己方 + 1 敌方）。 */
export function blockerOfMine(board: Board, player: PlayerIndex, cell: number): boolean {
  if (board[cell] !== other(player) + 1) return false
  const target = player + 1
  const row = Math.floor(cell / 9)
  const col = cell % 9
  const dirs: Array<[number, number]> = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ]
  for (const [dr, dc] of dirs) {
    for (let start = -3; start <= 0; start++) {
      let mine = 0
      let ok = true
      for (let k = 0; k < 4; k++) {
        const r = row + (start + k) * dr
        const c = col + (start + k) * dc
        if (r < 0 || r >= 9 || c < 0 || c >= 9) {
          ok = false
          break
        }
        const idx = r * 9 + c
        const v = board[idx]
        if (v === target) mine += 1
        else if (v !== 0 && idx !== cell) ok = false
      }
      if (ok && mine === 3) return true
    }
  }
  return false
}

function emptyStats(): Stats {
  return {
    games: 0,
    plies: 0,
    skillUses: {},
    armorCast: 0,
    armorAbsorbed: 0,
    armorWasted: 0,
    shieldGranted: 0,
    shieldAbsorbed: 0,
    shieldLeftover: 0,
    seeds: 0,
    seedOwned: 0,
    seedIdle: 0,
    fbCast: 0,
    fbOnBlocker: 0,
    flameWalk: 0,
    flameWalkLine: 0,
    handCast: {},
    handAttacked: {},
    costHist: {},
    powerCast: 0,
    powerCashedCasts: 0,
    powerMatches: 0,
  }
}

function playGame(char: CharacterId, seed: number): Stats {
  const rng = mulberry32(seed)
  const specs = [skillsOfCharacter(char), skillsOfCharacter(char)]
  const engine = new GameEngine({
    initialHp: INITIAL_HP,
    fixedFirstPlayer: 0,
    magic: { enabled: true },
    skills: [specs[0], specs[1]],
  })
  engine.takeEvents()

  const magicCtx = (): AiMagicContext => ({
    plants: [...engine.magic.values()].map((p) => [p.cell, p.owner] as [number, PlayerIndex | null]),
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

  const st = emptyStats()
  st.games = 1
  /** 已被"播种"长出来的格子 → 最后归谁（`null` = 仍无主）。 */
  const seeded = new Map<number, PlayerIndex | null>()
  /** bugv20：`小一哥` 是否处于"本次释放还没兑现过"的状态（每方一份）。 */
  const powerActive: [boolean, boolean] = [false, false]
  const powerCounted: [boolean, boolean] = [false, false]
  const armorAmount = Math.max(1, specs[0][0].amount ?? 1)
  const shieldSpec = specs[0].find((s) => s.effect === 'shield')
  const shieldAmount = Math.max(0, shieldSpec?.amount ?? 0)
  const guardSpec = specs[0].find((s) => s.effect === 'guardShare')
  const guardAmount = Math.max(0, guardSpec?.amount ?? 0)
  const guardShare = Math.max(0, guardSpec?.shareToFoe ?? 0)

  /** 处理一次落子/防守产生的事件（⚠️ `commit()`/`defend()` 会**清空**事件队列，别再 takeEvents）。 */
  const drain = (events: readonly AnyEvent[], walked: boolean): void => {
    // 走火要看"这一步有没有落在自己的火上"，由调用方在落子前判定（更可靠）
    if (walked) {
      st.flameWalk += 1
      if (events.some((e) => e.type === 'matchFormed')) st.flameWalkLine += 1
    }
    const damaged = events.some(
      (e) => e.type === 'attackResolved' || e.type === 'flameWalked' || e.type === 'hpChanged',
    )
    for (const e of events) {
      if (e.type === 'tempArmorChanged') {
        const delta = Number(e.from ?? 0) - Number(e.to ?? 0)
        if (delta > 0) {
          if (damaged) st.armorAbsorbed += delta
          else st.armorWasted += delta
        }
      } else if (e.type === 'shieldChanged') {
        const delta = Number(e.to ?? 0) - Number(e.from ?? 0)
        if (delta > 0) st.shieldGranted += delta
        else st.shieldAbsorbed += -delta
      } else if (e.type === 'magicGrown' && e.source === 'seed') {
        for (const p of (e.plants ?? []) as Array<{ cell: number }>) {
          st.seeds += 1
          seeded.set(p.cell, null)
        }
      } else if (e.type === 'magicClaimed') {
        const cell = Number(e.cell)
        if (seeded.has(cell)) seeded.set(cell, e.player as PlayerIndex)
      } else if (e.type === 'matchFormed') {
        // bugv20：`小一哥`（伤害 +1）在生效期内真的被打进伤害了吗
        const owner = Number((e.match as { owner?: number } | undefined)?.owner ?? -1)
        if ((owner === 0 || owner === 1) && powerActive[owner] && engine.powerBonus[owner] > 0) {
          st.powerMatches += 1
          if (!powerCounted[owner]) {
            powerCounted[owner] = true
            st.powerCashedCasts += 1
          }
        }
      }
    }
    // `小一哥` 到期（或被连珠吃光）→ 结束这一次"待兑现"窗口
    for (const p of [0, 1] as PlayerIndex[]) if (engine.powerBonus[p] <= 0) powerActive[p] = false
  }

  let plies = 0
  while (!engine.isOver && plies < MAX_PLIES) {
    plies += 1

    // 随机开局：避免确定性 AI 每局完全重复
    if (plies <= RANDOM_OPEN_PLIES) {
      if (engine.awaitingDefense) {
        const empties = engine.emptyCells()
        if (empties.length === 0) break
        drain(engine.defend(empties[Math.floor(rng() * empties.length)]) as AnyEvent[], false)
      } else {
        const legal = engine.legalMoves().filter((cell) => !engine.flames.has(cell))
        if (legal.length === 0) break
        const move = legal[Math.floor(rng() * legal.length)]
        const walked = engine.flames.has(move) && engine.flameOwner.get(move) === engine.current
        drain(engine.commit(move) as AnyEvent[], walked)
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
        // bugv17 #4：攻击方的加伤锁定在宣告那一刻，必须显式传
        attackBaseDamage: engine.attack?.baseDamage,
        attackPlants: engine.attack?.attackerPlants,
        difficulty: DIFFICULTY,
        timeLimitMs: BUDGET,
        nodeLimit: NODES,
        magic: magicCtx(),
        skills: skillCtx(),
      })
      const walked = engine.flames.has(dec.move) && engine.flameOwner.get(dec.move) === defender
      drain(engine.defend(dec.move) as AnyEvent[], walked)
      continue
    }

    const player = engine.current
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

    // 火球靶子要在**技能生效前**判（生效后那颗棋子已经碎了）
    const boardBefore = engine.board as Board
    for (const use of dec.skills ?? []) {
      const spec = engine.skills[player][use.slot]
      if (!spec || spec.effect !== 'fireball') continue
      st.fbCast += 1
      const target = use.target
      if (target !== undefined && target >= 0 && blockerOfMine(boardBefore, player, target)) st.fbOnBlocker += 1
    }

    const applied = applyAiSkills(engine, player, dec.skills)
    /** bugv20：这一手放了哪些技能（用来算"同手兑现率"）。 */
    const usedEffects: string[] = []
    for (const used of applied.used) {
      st.skillUses[used.effect] = (st.skillUses[used.effect] ?? 0) + 1
      usedEffects.push(used.effect)
      // 可变消耗技能实际花了几棵（「杀鲸霸拳」2 档 vs 3 档、「最不绕弯子」1~4）
      const hist = (st.costHist[used.effect] ??= {})
      const key = String(used.cells.length)
      hist[key] = (hist[key] ?? 0) + 1
      // ⚠️ applyAiSkills 内部会 takeEvents()，所以技能事件看不到 —— 用返回值补记
      if (used.effect === 'tempArmor') st.armorCast += armorAmount
      // 护盾的"授予"也发生在技能里（同样看不到事件）→ 按技能规格补记
      if (used.effect === 'shield') st.shieldGranted += shieldAmount
      if (used.effect === 'guardShare') st.shieldGranted += guardAmount + guardShare
      if (used.effect === 'power') {
        st.powerCast += 1
        powerActive[player] = true
        powerCounted[player] = false
      }
    }
    if (applied.skipPlacement) {
      // 「最不绕弯子」打完就直接进攻击阶段 → 这一手本身就是一次"兑现"；
      // 其它交回合的技能（如「恶龙吐息」）不算攻击手。
      const isAttackHand = applied.used.some((used) => used.effect === 'assault')
      for (const effect of usedEffects) {
        st.handCast[effect] = (st.handCast[effect] ?? 0) + 1
        if (isAttackHand) st.handAttacked[effect] = (st.handAttacked[effect] ?? 0) + 1
      }
      continue
    }

    let move = dec.move
    if (move < 0 || !engine.canPlaceAt(move)) {
      const pick = fallbackPlacement(engine, player)
      if (pick === undefined) break
      move = pick
    }
    const walked = engine.flames.has(move) && engine.flameOwner.get(move) === player
    const events = engine.commit(move) as AnyEvent[]
    // 这一手有没有真的形成连珠攻击（"技能收益当手兑现"的判据）
    const handAttacked = events.some((e) => e.type === 'matchFormed')
    for (const effect of usedEffects) {
      st.handCast[effect] = (st.handCast[effect] ?? 0) + 1
      if (handAttacked) st.handAttacked[effect] = (st.handAttacked[effect] ?? 0) + 1
    }
    drain(events, walked)
  }

  st.plies = plies
  // 终局仍留在身上的护盾 = 白花掉的那部分
  st.shieldLeftover = engine.shield[0] + engine.shield[1]
  for (const [cell] of seeded) {
    const live = engine.magic.get(cell)
    if (!live) continue // 被连珠一起扫掉了
    if (live.owner === null || live.owner === undefined) st.seedIdle += 1
    else st.seedOwned += 1
  }
  return st
}

function run(char: CharacterId): void {
  const total = emptyStats()
  for (let i = 0; i < PAIRS; i++) {
    const s = playGame(char, 1000 + i * 7919)
    total.games += 1
    total.plies += s.plies
    total.armorCast += s.armorCast
    total.armorAbsorbed += s.armorAbsorbed
    total.armorWasted += s.armorWasted
    total.shieldGranted += s.shieldGranted
    total.shieldAbsorbed += s.shieldAbsorbed
    total.shieldLeftover += s.shieldLeftover
    total.seeds += s.seeds
    total.seedOwned += s.seedOwned
    total.seedIdle += s.seedIdle
    total.fbCast += s.fbCast
    total.fbOnBlocker += s.fbOnBlocker
    total.flameWalk += s.flameWalk
    total.flameWalkLine += s.flameWalkLine
    total.powerCast += s.powerCast
    total.powerCashedCasts += s.powerCashedCasts
    total.powerMatches += s.powerMatches
    for (const [k, v] of Object.entries(s.skillUses)) total.skillUses[k] = (total.skillUses[k] ?? 0) + v
    for (const [effect, hist] of Object.entries(s.handCast)) {
      total.handCast[effect] = (total.handCast[effect] ?? 0) + hist
    }
    for (const [effect, n] of Object.entries(s.handAttacked)) {
      total.handAttacked[effect] = (total.handAttacked[effect] ?? 0) + n
    }
    for (const [effect, hist] of Object.entries(s.costHist)) {
      const acc = (total.costHist[effect] ??= {})
      for (const [k, n] of Object.entries(hist)) acc[k] = (acc[k] ?? 0) + n
    }
  }

  const g = Math.max(1, total.games)
  const pct = (n: number, d: number): string => (d === 0 ? '—' : `${((n / d) * 100).toFixed(0)}%`)
  console.log(`\n===== ${char}（${total.games} 局，平均 ${(total.plies / g).toFixed(1)} 手）=====`)
  console.log('  技能使用：', JSON.stringify(total.skillUses))
  if (total.armorCast > 0) {
    console.log(
      `  限时护甲：释放 ${total.armorCast} 点（${(total.armorCast / g).toFixed(1)}/局）` +
        ` · 被伤害吃掉 ${pct(total.armorAbsorbed, total.armorCast)}` +
        ` · **到期浪费 ${pct(total.armorWasted, total.armorCast)}**`,
    )
  }
  if (total.shieldGranted > 0) {
    console.log(
      `  护盾：授予 ${total.shieldGranted} 点（${(total.shieldGranted / g).toFixed(1)}/局）` +
        ` · 被伤害吃掉 ${pct(total.shieldAbsorbed, total.shieldGranted)}` +
        ` · 终局剩余 ${pct(total.shieldLeftover, total.shieldGranted)}`,
    )
  }
  if (total.fbCast > 0) {
    console.log(
      `  火球连招：释放 ${total.fbCast} 次 · 其中打在"挡我方成线的敌子"上 ${total.fbOnBlocker} 次（${pct(total.fbOnBlocker, total.fbCast)}）`,
    )
  }
  if (total.flameWalk > 0) {
    console.log(
      `  走自己的火：${total.flameWalk} 次（${(total.flameWalk / g).toFixed(2)}/局）` +
        ` · **当步就成线 ${pct(total.flameWalkLine, total.flameWalk)}**`,
    )
  }
  if (total.seeds > 0) {
    console.log(
      `  播种：长出 ${total.seeds} 棵（${(total.seeds / g).toFixed(1)}/局）` +
        ` · 后来有主 ${pct(total.seedOwned, total.seeds)} · 终局仍无主 ${total.seedIdle}`,
    )
  }
  // --- bugv20：技能收益兑现 -------------------------------------------------
  const effects = Object.keys(total.handCast)
  if (effects.length > 0) {
    console.log('  「放了技能的这一手，真的开打了吗」（同手兑现率）：')
    for (const effect of effects) {
      const cast = total.handCast[effect]
      const hit = total.handAttacked[effect] ?? 0
      const cost = total.costHist[effect]
      const costText = cost
        ? ` · 消耗分布 ${Object.entries(cost)
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([k, v]) => `${k}棵×${v}`)
            .join(' / ')}`
        : ''
      console.log(`    ${effect.padEnd(11)} 释放 ${cast} 手 · 同手兑现 ${hit} 手（${pct(hit, cast)}）${costText}`)
    }
    console.log('    （口径：这一手放了技能后，本手是否形成连珠攻击。⚠️「连下两颗 / 直接开打」类技能')
    console.log('      跨两手结算，其"同手兑现"会被低估，看它们要结合机制指标而非只看这一行。）')
  }
  if (total.powerCast > 0) {
    console.log(
      `  「小一哥」持续兑现：释放 ${total.powerCast} 次 · **至少兑现一次 ${pct(total.powerCashedCasts, total.powerCast)}**` +
        ` · 平均兑现 ${(total.powerMatches / Math.max(1, total.powerCast)).toFixed(2)} 次/释放`,
    )
  }
}

for (const char of chars) run(char)
