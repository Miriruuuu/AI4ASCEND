/**
 * 回放诊断（实机人机对战）。
 *
 * 用法：
 *   pnpm exec tsx scripts/diagnose-replay.ts [回放文件=replay/replay.txt] [--decisions]
 *
 * 做三件事：
 * 1. 把回放（`C4R1:` + base64 JSON）用**真实引擎**重放一遍，校验血量逐步一致
 *    （不一致说明回放与当前规则不符，后面的结论都不能信）；
 * 2. 对 AI 的**每一次攻击**，用真实引擎**枚举全部防守应对**，统计有多少种能
 *    反打 / 抵消 / 被打 —— 判断"这次攻击是不是送死"必须看这个分布，
 *    只看进攻值会把它误判成"必杀"；
 * 3. `--decisions` 时，用当前 AI 在同样的局面重算一次，对比实机落点，
 *    区分"AI 选点错了"和"AI 输入少了东西"。
 *
 * ⚠️ 回放不含技能状态（`extra`），所以第 3 步只能用回放能还原的那部分状态；
 * 技能相关的结论要靠第 1、2 步 + 引擎事件流。
 */
import { readFileSync } from 'node:fs'
import { GameEngine } from '../src/core/engine'
import { skillsOfCharacter, type CharacterId } from '../src/core/characters'
import { createsLine, decideMove, type AiMagicContext, type AiSkillContext } from '../src/ai/baseline'
import { INITIAL_HP, other, type PlayerIndex } from '../src/core/types'

const argv = process.argv.slice(2)
const withDecisions = argv.includes('--decisions')
const file = argv.find((a) => !a.startsWith('--')) ?? 'replay/replay.txt'

const NAME_MAP: Record<string, CharacterId> = {
  DeepSeek: 'deepseek',
  Gemini: 'gemini',
  GTP: 'gtp',
  GLM: 'glm',
}

interface ReplayStep {
  p: PlayerIndex
  c: number
  d: number
  m: number
  b: string
  h: [number, number]
  g?: string
  e?: Array<Record<string, any>>
}

const raw = readFileSync(file, 'utf8').trim()
if (!raw.startsWith('C4R1:')) {
  console.error('不是 C4R1 回放文件')
  process.exit(1)
}
const data = JSON.parse(Buffer.from(raw.slice(5), 'base64').toString('utf8')) as {
  mode: string
  names: string[]
  result: { winner: PlayerIndex; reason: string; hp: number[] }
  durationMs: number
  playedAt: string
  steps: ReplayStep[]
}
const steps = data.steps
const chars = data.names.map((n) => NAME_MAP[n] ?? 'gemini')

const makeEngine = (): GameEngine => {
  const e = new GameEngine({
    initialHp: INITIAL_HP,
    fixedFirstPlayer: steps[0]?.p ?? 0,
    magic: { enabled: true },
    skills: [skillsOfCharacter(chars[0]), skillsOfCharacter(chars[1])],
  })
  e.takeEvents()
  return e
}
const applyStep = (e: GameEngine, s: ReplayStep) => (s.d === 1 ? e.defend(s.c) : e.commit(s.c))
const replayTo = (i: number): GameEngine => {
  const e = makeEngine()
  for (let k = 0; k < i; k++) applyStep(e, steps[k])
  return e
}

const magicCtx = (e: GameEngine): AiMagicContext => ({
  plants: [...e.magic.values()].map((p) => [p.cell, p.owner] as [number, PlayerIndex | null]),
  damagePerPlant: e.magicConfig.damagePerPlant,
})
const skillCtx = (e: GameEngine): AiSkillContext => ({
  skills: e.skills,
  shield: [e.shield[0], e.shield[1]],
  bonusActions: [e.bonusActions[0], e.bonusActions[1]],
  actionsTaken: [e.actionsTaken[0], e.actionsTaken[1]],
  skillReadyAt: [e.skillReadyAt[0].slice(), e.skillReadyAt[1].slice()],
  skillCasts: [e.skillCasts[0].slice(), e.skillCasts[1].slice()],
  powerBonus: [e.powerBonus[0], e.powerBonus[1]],
  powerUntil: [e.powerUntil[0], e.powerUntil[1]],
  sabotage: [e.sabotage[0], e.sabotage[1]],
  sabotageBonus: [e.sabotageBonus[0], e.sabotageBonus[1]],
  twinStar: [e.twinStar[0], e.twinStar[1]],
  bloomCheaperNext: [e.bloomCheaperNext[0], e.bloomCheaperNext[1]],
  immuneUntil: [e.immuneUntil[0], e.immuneUntil[1]],
  tempArmor: [e.tempArmor[0], e.tempArmor[1]],
  tempArmorUntil: [e.tempArmorUntil[0], e.tempArmorUntil[1]],
  strikeBonus: [e.strikeBonus[0], e.strikeBonus[1]],
  strikeUntil: [e.strikeUntil[0], e.strikeUntil[1]],
  seedGrow: [e.seedGrow[0], e.seedGrow[1]],
  turnNo: e.turnNo,
  flames: [...e.flames.entries()],
  flameOwner: [...e.flameOwner.entries()] as Array<[number, number]>,
  overlay: [...e.overlay.entries()] as Array<[number, number]>,
  initialHp: INITIAL_HP,
})

const cellName = (c: number) => `c${c}(r${Math.floor(c / 9)},col${c % 9})`

// ── 0. 概况 ────────────────────────────────────────────────────────────────
console.log(`回放：${data.names.join(' vs ')}（${data.mode}）  手数 ${steps.length}  时长 ${(data.durationMs / 1000).toFixed(0)}s`)
console.log(`结果：winner=P${data.result.winner}（${data.result.reason}） hp=[${data.result.hp}]  玩家 = P0 = ${data.names[0]}`)

// ── 1. 重放校验 ────────────────────────────────────────────────────────────
{
  const e = makeEngine()
  let bad = 0
  for (let k = 0; k < steps.length; k++) {
    applyStep(e, steps[k])
    const want = steps[k].h
    if (e.hp[0] !== want[0] || e.hp[1] !== want[1]) {
      if (bad < 3) console.log(`⚠️ 第 ${k} 步血量不符：重放[${e.hp}] vs 回放[${want}]`)
      bad += 1
    }
  }
  console.log(`\n重放校验：血量不符 ${bad}/${steps.length} 处；终局 hp=[${e.hp}]`)
  if (bad > 0) console.log('⚠️ 回放与当前规则不一致，后续结论需要谨慎。')
}

// ── 2. 事件统计：植物 / 技能 / 连珠 ─────────────────────────────────────────
{
  const ev: Record<string, number> = {}
  const claims: [number, number] = [0, 0]
  const skills: [number, number] = [0, 0]
  let grown = 0
  let firstGrow = -1
  for (let i = 0; i < steps.length; i++) {
    for (const e of steps[i].e ?? []) {
      ev[e.type] = (ev[e.type] ?? 0) + 1
      if (e.type === 'magicClaimed') claims[e.player as 0 | 1] += 1
      if (e.type === 'magicGrown') {
        grown += (e.plants ?? []).length
        if (firstGrow < 0) firstGrow = i
      }
      if (e.type === 'skillUsed') skills[(e.player ?? 0) as 0 | 1] += 1
    }
  }
  console.log(`\n植物：共长出 ${grown} 棵，首棵在第 ${firstGrow} 手`)
  console.log(`认领：P0=${claims[0]} 棵 ｜ P1(AI)=${claims[1]} 棵`)
  console.log(`技能：P0=${skills[0]} 次 ｜ P1(AI)=${skills[1]} 次`)
  if (claims[1] === 0 && grown > 0) {
    console.log('  ⚠️ AI 整局零认领 —— 先查"AI 到底有没有拿到植物上下文"（见协议/透传），再看候选集。')
  }
  if (skills[1] === 0 && claims[1] >= 2) {
    console.log('  ⚠️ AI 手里有植物却不放技能 —— 查技能闸门 / 冷却 / 是否缺上下文。')
  }
  console.log(`事件：${JSON.stringify(ev)}`)
}

// ── 3. AI 每次攻击 × 枚举全部防守 ───────────────────────────────────────────
console.log('\n========== AI(P1) 每次攻击 × 全部防守应对 ==========')
for (let i = 1; i < steps.length; i++) {
  const s = steps[i]
  if (s.d !== 1) continue // 只看向"防守"那一步
  const attackStep = steps[i - 1]
  if (attackStep.p !== 1 || attackStep.d !== 0) continue // 只分析"AI 是攻击方"的那次

  const before = replayTo(i - 1)
  const empties = before.legalMoves().filter((c) => !before.flames.has(c))
  const foeThreats = empties.filter((c) => createsLine(before.board, 0, c))

  const eng = replayTo(i - 1)
  eng.commit(attackStep.c)
  const legal = eng.legalMoves().filter((c) => !eng.flames.has(c))
  const shots: Array<{ cell: number; mode: string; damage: number; hp: [number, number] }> = []
  for (const c of legal) {
    const e2 = replayTo(i - 1)
    e2.commit(attackStep.c)
    e2.takeEvents()
    const evs = e2.defend(c)
    const r = evs.find((x: any) => x.type === 'attackResolved') as any
    if (r) shots.push({ cell: c, mode: r.snapshot.mode, damage: r.damage, hp: [e2.hp[0], e2.hp[1]] })
  }
  const actual = shots.find((x) => x.cell === s.c)
  const hurt = shots.filter((x) => x.mode === 'attackerDamaged')
  const cancel = shots.filter((x) => x.mode === 'canceled')
  const good = shots.filter((x) => x.mode === 'defenderDamaged')
  console.log(`\n--- 第 ${i - 1} 手 AI 在 ${cellName(attackStep.c)} 成线（攻击前 hp=[${attackStep.h}]）---`)
  console.log(`  攻击前对手能一步成线的格：${foeThreats.length} 个 ${foeThreats.map(cellName).join(' ')}`)
  console.log(
    `  ${shots.length} 种防守：被打 ${hurt.length} ｜ 抵消 ${cancel.length} ｜ 对手挨打 ${good.length}`,
  )
  if (hurt.length) console.log(`    能反打的格：${hurt.map((x) => `${cellName(x.cell)}(伤${x.damage})`).join(' ')}`)
  console.log(
    `  实际：${cellName(s.c)} → ${actual?.mode} 伤${actual?.damage} 终局 hp=[${actual?.hp}]${actual?.mode === 'defenderDamaged' ? ' ✅ 有效' : ' ❌ 被化解'}`,
  )

  if (withDecisions) {
    const e = replayTo(i - 1)
    const dec = decideMove({
      board: e.board.slice(),
      player: 1,
      selfHp: e.hp[1],
      opponentHp: e.hp[0],
      mode: 'attack',
      difficulty: 'expert',
      magic: magicCtx(e),
      skills: skillCtx(e),
    })
    const tag = createsLine(e.board, 1, dec.move) ? '(攻击)' : ''
    console.log(`  【当前 AI 重算】c${dec.move}${tag}  ${dec.move === attackStep.c ? '与实机相同' : '≠ 实机'}`)
  }
}

// ── 4. 逐手概览（便于定位） ─────────────────────────────────────────────────
console.log('\n========== 逐手 ==========')
steps.forEach((s, i) => {
  const evs = (s.e ?? [])
    .filter((e) => e.type !== 'turnStarted')
    .map((e) => (e.type === 'attackResolved' ? `ATK(${e.snapshot?.mode},伤${e.damage})` : e.type))
  console.log(
    `${String(i).padStart(2)} p${s.p} ${s.d === 1 ? '守' : '下'}${String(s.c).padStart(3)} hp=[${s.h}] 植物${s.g ? s.g.split(',').filter(Boolean).length : 0} ${evs.join(' ')}`,
  )
})
void other
