/**
 * gtp 逐手行为打点 + 胜负归因（bugv32）。
 *
 * 循环赛只有一个总分，看不出 gtp 到底哪一手在送。这个脚本反过来：挑一个均衡对手
 * （deepseek / gemini），小样本跑若干局，把 gtp **每一手**的行为打上标签，
 * 然后按「胜局 vs 败局」分开统计 —— 哪种行为在败局里明显更多，哪种就是输因。
 *
 * 用法：
 *   pnpm exec tsx scripts/trace-behavior.ts [对手=deepseek] [局数=20] [每手ms=70]
 *   NODES=15872 pnpm exec tsx scripts/trace-behavior.ts deepseek 20 70   # 确定性
 *
 * 对手角色可选：deepseek（中等强度） / gemini（当前最强）。
 * gtp 一半局坐先手、一半坐后手，抵消先手优势。
 */
import { applyAiSkills, fallbackPlacement } from './harness'
import { decideMove, type AiMagicContext, type AiSkillContext } from '../src/ai/baseline'
import { GameEngine } from '../src/core/engine'
import { skillsOfCharacter, type CharacterId } from '../src/core/characters'
import { INITIAL_HP, other, type Board, type PlayerIndex } from '../src/core/types'
import { mulberry32 } from './variants'

const GTP: CharacterId = 'gtp'
const FOE: CharacterId = (process.argv[2] ?? 'deepseek') as CharacterId
const GAMES = Number(process.argv[3] ?? 20)
const BUDGET = Number(process.argv[4] ?? 70)
const NODES = Number(process.env.NODES ?? 0)
const MAX_PLIES = 220
const RANDOM_OPEN_PLIES = 8

// ---- 棋盘窗口辅助（与 AI 的 collectMyWindowBlockers / collectFoeKeyStones / collectAttackCells 同口径）----
const DIRS: Array<[number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
]

type AnyEvent = { type: string } & Record<string, unknown>

/** cell 是不是"挡在我方成线窗口里的敌子"（窗口恰好 3 己方 + 1 敌方）。 */
function blockerOfMine(board: Board, player: PlayerIndex, cell: number): boolean {
  if (board[cell] !== other(player) + 1) return false
  const target = player + 1
  const row = Math.floor(cell / 9)
  const col = cell % 9
  for (const [dr, dc] of DIRS) {
    for (let start = -3; start <= 0; start++) {
      let mine = 0
      let foeCell = -1
      let ok = true
      for (let k = 0; k < 4; k++) {
        const r = row + (start + k) * dr
        const c = col + (start + k) * dc
        if (r < 0 || r >= 9 || c < 0 || c >= 9) {
          ok = false
          break
        }
        const v = board[r * 9 + c]
        if (v === target) mine += 1
        else if (v !== 0) foeCell = r * 9 + c
      }
      if (ok && mine === 3 && foeCell === cell) return true
    }
  }
  return false
}

/** cell 是不是对手"3 对手 + 1 空位"窗口里的一颗棋（碎掉它 = 拆掉对手这条线）。 */
function foeKeyStoneOf(board: Board, foe: PlayerIndex, cell: number): boolean {
  if (board[cell] !== foe + 1) return false
  const target = foe + 1
  const row = Math.floor(cell / 9)
  const col = cell % 9
  for (const [dr, dc] of DIRS) {
    for (let start = -3; start <= 0; start++) {
      let stones = 0
      let empty = 0
      let otherStone = 0
      let ok = true
      for (let k = 0; k < 4; k++) {
        const r = row + (start + k) * dr
        const c = col + (start + k) * dc
        if (r < 0 || r >= 9 || c < 0 || c >= 9) {
          ok = false
          break
        }
        const v = board[r * 9 + c]
        if (v === target) stones += 1
        else if (v === 0) empty += 1
        else otherStone += 1
      }
      if (ok && stones === 3 && empty === 1 && otherStone === 0) return true
    }
  }
  return false
}

/** cell 是不是对手"一步成线"的空位（对手落上去就成线）。 */
function foeWinCellOf(board: Board, foe: PlayerIndex, cell: number): boolean {
  if (board[cell] !== 0) return false
  const target = foe + 1
  const row = Math.floor(cell / 9)
  const col = cell % 9
  for (const [dr, dc] of DIRS) {
    for (let start = -3; start <= 0; start++) {
      let stones = 0
      let empty = 0
      let otherStone = 0
      let ok = true
      for (let k = 0; k < 4; k++) {
        const r = row + (start + k) * dr
        const c = col + (start + k) * dc
        if (r < 0 || r >= 9 || c < 0 || c >= 9) {
          ok = false
          break
        }
        const v = board[r * 9 + c]
        if (v === target) stones += 1
        else if (v === 0) empty += 1
        else otherStone += 1
      }
      if (ok && stones === 3 && empty === 1 && otherStone === 0) return true
    }
  }
  return false
}

// ---- 行为桶 -------------------------------------------------------------
type Behavior =
  | '护甲释放'
  | '火球1费'
  | '火球3费'
  | '火球开线'
  | '火球断对手线'
  | '火球空放'
  | '走火'
  | '走火成线'
  | '成线攻击'
  | '被反击受伤'

interface PerGame {
  won: boolean
  plies: number
  /** behavior -> 本局出现次数 */
  counts: Map<Behavior, number>
  // 即时兑现统计
  armorCast: number
  armorAbsorbed: number
  armorWasted: number
  fbCast: number
  fbOnBlocker: number
  fbOnFoeLine: number
  fbBlank: number
  flameWalk: number
  flameWalkLine: number
  attacks: number
  counterHit: number
  // 死亡方式（bugv32：gtp 是怎么死的）
  /** 每次 gtp 实际掉血的量（hpChanged，含走火自伤）。 */
  gtpHits: number[]
  /** 对手攻击 gtp 的原始伤害（attackResolved.damage，护甲/护盾吸收前）。 */
  foeRawHits: number[]
}

function emptyGame(won: boolean): PerGame {
  return {
    won,
    plies: 0,
    counts: new Map(),
    armorCast: 0,
    armorAbsorbed: 0,
    armorWasted: 0,
    fbCast: 0,
    fbOnBlocker: 0,
    fbOnFoeLine: 0,
    fbBlank: 0,
    flameWalk: 0,
    flameWalkLine: 0,
    attacks: 0,
    counterHit: 0,
    gtpHits: [],
    foeRawHits: [],
  }
}

function playGame(seed: number, gtpSeat: PlayerIndex): PerGame {
  const rng = mulberry32(seed)
  const specs = [skillsOfCharacter(gtpSeat === 0 ? GTP : FOE), skillsOfCharacter(gtpSeat === 0 ? FOE : GTP)]
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

  const armorAmount = Math.max(1, specs[gtpSeat].find((s) => s.effect === 'tempArmor')?.amount ?? 8)
  const g = emptyGame(false) // 胜负最后再填
  const bump = (b: Behavior): void => {
    g.counts.set(b, (g.counts.get(b) ?? 0) + 1)
  }

  // 全局事件结算：只认 gtp 自己的护甲 / 连珠（`e.player` / `match.owner` 归因），
  // 这样对手攻击 gtp 时（发生在防守结算里）打掉护甲也能被记到。
  const drain = (events: readonly AnyEvent[]): void => {
    const damaged = events.some(
      (e) => e.type === 'attackResolved' || e.type === 'flameWalked' || e.type === 'hpChanged',
    )
    for (const e of events) {
      if (e.type === 'tempArmorChanged') {
        const p = e.player as PlayerIndex | undefined
        if (p !== gtpSeat) continue
        const delta = Number(e.from ?? 0) - Number(e.to ?? 0)
        if (delta > 0) {
          if (damaged) g.armorAbsorbed += delta
          else g.armorWasted += delta
        }
      } else if (e.type === 'matchFormed') {
        const owner = Number((e.match as { owner?: number } | undefined)?.owner ?? -1)
        if (owner === gtpSeat) {
          g.attacks += 1
          bump('成线攻击')
        }
      }
      if (e.type === 'hpChanged' && e.player === gtpSeat && Number(e.to) < Number(e.from)) {
        g.gtpHits.push(Number(e.from) - Number(e.to))
      }
      if (e.type === 'attackResolved') {
        const snap = e.snapshot as { damaged?: number } | undefined
        if (snap?.damaged === gtpSeat) g.foeRawHits.push(Number(e.damage ?? 0))
      }
    }
  }

  let plies = 0
  while (!engine.isOver && plies < MAX_PLIES) {
    plies += 1

    if (plies <= RANDOM_OPEN_PLIES) {
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
      const defender = other(engine.highlightOwner ?? 0)
      const attacker = engine.highlightOwner ?? 0
      const gtpHpBefore = engine.hp[gtpSeat]
      const dec = decideMove({
        board: engine.board as Board,
        player: defender,
        selfHp: engine.hp[defender],
        opponentHp: engine.hp[other(defender)],
        mode: 'defend',
        highlightWeights: engine.highlights,
        attackBaseDamage: engine.attack?.baseDamage,
        attackPlants: engine.attack?.attackerPlants,
        difficulty: 'expert',
        timeLimitMs: BUDGET,
        nodeLimit: NODES,
        magic: magicCtx(),
        skills: skillCtx(),
      })
      const events = engine.defend(dec.move) as AnyEvent[]
      engine.takeEvents()
      drain(events)
      // gtp 发起攻击、却被对手反击打掉血 → 「被反击受伤」
      if (attacker === gtpSeat && engine.hp[gtpSeat] < gtpHpBefore) {
        bump('被反击受伤')
        g.counterHit += 1
      }
      continue
    }

    const player = engine.current
    const isGtp = player === gtpSeat
    const hpBefore = engine.hp[player]
    const dec = decideMove({
      board: engine.board as Board,
      player,
      selfHp: engine.hp[player],
      opponentHp: engine.hp[other(player)],
      mode: 'attack',
      difficulty: 'expert',
      timeLimitMs: BUDGET,
      nodeLimit: NODES,
      magic: magicCtx(),
      skills: skillCtx(),
    })

    const boardBefore = engine.board as Board

    if (isGtp) {
      for (const use of dec.skills ?? []) {
        const spec = engine.skills[player][use.slot]
        if (!spec || spec.effect !== 'fireball') continue
        g.fbCast += 1
        const cost = (use.cells ?? []).length
        const free = (engine.skillCasts[player][use.slot] ?? 0) === 0 && spec.freeFirst === true
        if (free || cost <= 1) bump('火球1费')
        else if (cost >= 3) bump('火球3费')
        const target = use.target
        if (target !== undefined && target >= 0) {
          if (blockerOfMine(boardBefore, player, target)) {
            g.fbOnBlocker += 1
            bump('火球开线')
          } else if (
            foeKeyStoneOf(boardBefore, other(player), target) ||
            foeWinCellOf(boardBefore, other(player), target)
          ) {
            g.fbOnFoeLine += 1
            bump('火球断对手线')
          } else {
            g.fbBlank += 1
            bump('火球空放')
          }
        }
      }
    }

    const applied = applyAiSkills(engine, player, dec.skills)
    if (isGtp) {
      for (const used of applied.used) {
        if (used.effect === 'tempArmor') {
          bump('护甲释放')
          g.armorCast += armorAmount
        }
      }
    }
    if (applied.skipPlacement) {
      engine.takeEvents()
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
    engine.takeEvents()

    if (isGtp) {
      if (walked) {
        g.flameWalk += 1
        bump('走火')
        if (events.some((e) => e.type === 'matchFormed')) {
          g.flameWalkLine += 1
          bump('走火成线')
        }
      }
      if (engine.hp[player] < hpBefore) {
        // 走火自伤不算"被反击"，其余掉血都算
        if (!walked) {
          bump('被反击受伤')
          g.counterHit += 1
        }
      }
    }
    drain(events)
  }

  g.won = engine.hp[gtpSeat] > engine.hp[other(gtpSeat)]
  g.plies = plies
  return g
}

function run(): void {
  const wonGames: PerGame[] = []
  const lostGames: PerGame[] = []
  for (let i = 0; i < GAMES; i++) {
    const gtpSeat: PlayerIndex = i % 2 === 0 ? 0 : 1
    const g = playGame(1000 + i * 7919, gtpSeat)
    if (g.won) wonGames.push(g)
    else lostGames.push(g)
  }

  const nWon = wonGames.length
  const nLost = lostGames.length
  console.log(`\n===== gtp vs ${FOE} · ${GAMES} 局（gtp 坐先手/后手各半）=====`)
  console.log(`gtp 胜率：${((nWon / GAMES) * 100).toFixed(1)}%（${nWon}/${GAMES}） · 胜局均手数 ${avg(wonGames.map((g) => g.plies))} / 败局 ${avg(lostGames.map((g) => g.plies))}`)

  // 一、逐手行为：胜局 vs 败局的每局均值
  console.log('\n一、逐手行为（每局均值：胜局 vs 败局）')
  console.log('  ' + '行为'.padEnd(10) + '胜局均值'.padStart(10) + '败局均值'.padStart(10) + '差(败-胜)'.padStart(10))
  const behaviors: Behavior[] = [
    '护甲释放',
    '火球1费',
    '火球3费',
    '火球开线',
    '火球断对手线',
    '火球空放',
    '走火',
    '走火成线',
    '成线攻击',
    '被反击受伤',
  ]
  const sumCount = (gs: PerGame[], b: Behavior): number => gs.reduce((acc, g) => acc + (g.counts.get(b) ?? 0), 0)
  for (const b of behaviors) {
    const w = sumCount(wonGames, b) / Math.max(1, nWon)
    const l = sumCount(lostGames, b) / Math.max(1, nLost)
    const d = l - w
    console.log(
      `  ${b.padEnd(10)}${w.toFixed(2).padStart(10)}${l.toFixed(2).padStart(10)}${(d >= 0 ? '+' : '') + d.toFixed(2).padStart(10)}`,
    )
  }
  console.log('  （差 = 败局 − 胜局，正数 = 这种行为在败局里更多 → 疑似输因；负数 = 赢家行为）')

  // 二、即时兑现率
  console.log('\n二、即时兑现率（胜局 vs 败局）')
  const pct = (n: number, d: number): string => (d === 0 ? '—' : `${((n / d) * 100).toFixed(0)}%`)
  const armorCastW = wonGames.reduce((a, g) => a + g.armorCast, 0)
  const armorCastL = lostGames.reduce((a, g) => a + g.armorCast, 0)
  const armorAbsW = wonGames.reduce((a, g) => a + g.armorAbsorbed, 0)
  const armorAbsL = lostGames.reduce((a, g) => a + g.armorAbsorbed, 0)
  const armorWasW = wonGames.reduce((a, g) => a + g.armorWasted, 0)
  const armorWasL = lostGames.reduce((a, g) => a + g.armorWasted, 0)
  console.log(
    `  护甲：被伤害吃掉  胜 ${pct(armorAbsW, armorCastW)}（${armorAbsW}/${armorCastW}）` +
      `  败 ${pct(armorAbsL, armorCastL)}（${armorAbsL}/${armorCastL}）`,
  )
  console.log(
    `  护甲：到期作废    胜 ${pct(armorWasW, armorCastW)}（${armorWasW}/${armorCastW}）` +
      `  败 ${pct(armorWasL, armorCastL)}（${armorWasL}/${armorCastL}）`,
  )
  const fbW = wonGames.reduce((a, g) => a + g.fbCast, 0)
  const fbL = lostGames.reduce((a, g) => a + g.fbCast, 0)
  const blkW = wonGames.reduce((a, g) => a + g.fbOnBlocker, 0)
  const blkL = lostGames.reduce((a, g) => a + g.fbOnBlocker, 0)
  const foeW = wonGames.reduce((a, g) => a + g.fbOnFoeLine, 0)
  const foeL = lostGames.reduce((a, g) => a + g.fbOnFoeLine, 0)
  const blankW = wonGames.reduce((a, g) => a + g.fbBlank, 0)
  const blankL = lostGames.reduce((a, g) => a + g.fbBlank, 0)
  console.log(
    `  火球：开线(打拦路石) 胜 ${pct(blkW, fbW)}  败 ${pct(blkL, fbL)}` +
      ` ｜ 断对手线 胜 ${pct(foeW, fbW)}  败 ${pct(foeL, fbL)}` +
      ` ｜ 空放 胜 ${pct(blankW, fbW)}  败 ${pct(blankL, fbL)}`,
  )
  const walkW = wonGames.reduce((a, g) => a + g.flameWalk, 0)
  const walkL = lostGames.reduce((a, g) => a + g.flameWalk, 0)
  const walkLineW = wonGames.reduce((a, g) => a + g.flameWalkLine, 0)
  const walkLineL = lostGames.reduce((a, g) => a + g.flameWalkLine, 0)
  console.log(
    `  走火：当步成线 胜 ${pct(walkLineW, walkW)}  败 ${pct(walkLineL, walkL)}` +
      `（走火总次 胜 ${walkW} / 败 ${walkL}）`,
  )

  // 三、死亡方式：gtp 是不是被大连击秒了
  console.log('\n三、gtp 是怎么死的（每局）')
  const hitsOf = (gs: PerGame[]): number[] => gs.flatMap((g) => g.gtpHits)
  const rawOf = (gs: PerGame[]): number[] => gs.flatMap((g) => g.foeRawHits)
  const hitW = hitsOf(wonGames)
  const hitL = hitsOf(lostGames)
  const rawW = rawOf(wonGames)
  const rawL = rawOf(lostGames)
  const maxOf = (xs: number[]): string => (xs.length === 0 ? '—' : String(Math.max(...xs)))
  const avgOf = (xs: number[]): string => (xs.length === 0 ? '—' : (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1))
  const hitsPerGame = (xs: number[], n: number): string => (n === 0 ? '—' : (xs.length / n).toFixed(1))
  console.log(
    `  被击中次数（实际掉血） 胜 ${hitsPerGame(hitW, nWon)}/局  败 ${hitsPerGame(hitL, nLost)}/局` +
      ` ｜ 平均每次掉血 胜 ${avgOf(hitW)}  败 ${avgOf(hitL)}`,
  )
  console.log(
    `  对手攻击原始伤害      平均 ${avgOf(rawW)} vs ${avgOf(rawL)}` +
      ` ｜ **单次最大** ${maxOf(rawW)} vs ${maxOf(rawL)}`,
  )
  // 对手攻击的伤害分布（桶）
  const bucket = (xs: number[]): string => {
    if (xs.length === 0) return '—'
    const b: Record<string, number> = {}
    for (const x of xs) {
      const k = x >= 7 ? '7+' : x >= 6 ? '6' : x >= 5 ? '5' : x >= 4 ? '4' : '≤3'
      b[k] = (b[k] ?? 0) + 1
    }
    return Object.entries(b)
      .sort((a, z) => Number(a[0] === '7+' ? 7 : a[0] === '≤3' ? 3 : a[0]) - Number(z[0] === '7+' ? 7 : z[0] === '≤3' ? 3 : z[0]))
      .map(([k, v]) => `${k}伤害×${v}`)
      .join('  ')
  }
  console.log(`  对手攻击伤害分布（败局）：${bucket(rawL)}`)
  console.log(`  （本作 4 连基础伤害 4，5 连=5、6 连=6；伤害 ≥6 才算"大连击"）`)
}

function avg(xs: number[]): string {
  if (xs.length === 0) return '—'
  return (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)
}

run()
