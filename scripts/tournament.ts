/**
 * 角色循环赛：**同强度 AI、不同角色**对打，测角色/技能的强度排行。
 *
 * 设计要点（为了「排除『不会用技能』导致的偏差」）：
 * - 双方都是同一个线上 AI（`decideMove`）、同一棋力、同一预算；
 * - 双方都拿到**完整的技能上下文**与植物上下文，所以差距只可能来自「角色技能本身」；
 * - **配对设计**：每组对手都打两局 —— A 先手一局、B 先手一局，两局用**同一个随机
 *   开局种子**（盘面完全相同），从而把「开局运气 + 先后手」配对抵消。
 *
 * ⚠️ 为什么一场要跑十几分钟？
 *   `decideMove` 是**迭代加深 + 时间上限**：每一手都会把 `budget` 跑满（除非提前算出
 *   必胜或到深度上限）。所以耗时 ≈ `局数 × 平均手数 × 每手预算(ms)`，这是**设计使然**
 *   而不是性能问题。200 局 × 72 手 × 70ms ≈ 1000s，和实测一致。
 *   要更快：① 降 `budget`（会略微减弱 AI，但两边一样所以对比仍公平）；
 *   ② **并行分片**（推荐，结果完全不变）——见下面 `--shard` / `--parallel`。
 *
 * 用法：
 *   串行：  pnpm exec tsx scripts/tournament.ts [对数] [每手ms] [手数上限] [随机开局手数] [角色列表] [植物1/0] [mirror]
 *   分片：  ... 同上 ... --shard=0/8 --json           # 输出该分片的 JSON
 *           ... 同上 ... --progress=.tmp/s0.json      # 每打完一局写一次进度快照
 *   合并：  pnpm exec tsx scripts/tournament.ts --merge a.json b.json ...
 *   实时战报：pnpm exec tsx scripts/tournament.ts --watch --dir=.tmp --total=300 --matchups=21
 *            （每 1.5s 合并全部分片进度 → 刷新桌面「四子棋循环赛-实时战报.log」，
 *              目录里出现 `.done` 后写最后一帧并退出；由 tournament-parallel.sh 自动启动）
 *   并行：  bash scripts/tournament-parallel.sh [对数] [每手ms] [分片数] [手数上限]
 *
 * 可选 flag：
 *   --hp=<n>       初始血量上限（默认 12 = `INITIAL_HP`）。调小能大幅缩短对局
 *   --variant=<名> 技能数值变体（见 `VARIANTS`）
 *   --focus=<角色> 只打「该角色 vs 其余每个角色」
 *   --nodes=<n>    确定性预算（≈ 本机 70ms 的搜索量 = 15872）
 *   --shard=i/N · --json · --progress=<路径> · --merge · --watch
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { applyAiSkills, fallbackPlacement } from './harness'
import {
  AI_POLICY,
  decideMove,
  type AiDifficulty,
  type AiMagicContext,
  type AiSkillContext,
} from '../src/ai/baseline'
import { CHARACTER_SPECS, skillsOfCharacter, type CharacterId } from '../src/core/characters'
import { GameEngine } from '../src/core/engine'
import { INITIAL_HP, other, type Board, type PlayerIndex, type SkillSpec } from '../src/core/types'
import { VARIANTS, makeSpecResolver, mulberry32 } from './variants'


/**
 * AI 政策开关（bugv34o）：与 `scripts/probe-qwen.ts` **同一套环境变量**，方便 A/B。
 *
 * 只影响 AI 的**着法生成门槛**，不改任何规则；每个进程只在启动时读一次。
 *   `POLICY_DEPLOY_GATE=prep|anytime`／`POLICY_REDEPLOY_PLANT=1|0`
 *   `POLICY_DEPLOY_ATTACK=1`／`POLICY_DEPLOY_SPARE=1`／`POLICY_NO_REDEPLOY=1`
 * 完整的 token 列表见 `scripts/duel.ts --policy-a/--policy-b`。
 */
{
  const env = process.env
  if (env.POLICY_DEPLOY_GATE === 'prep') AI_POLICY.deployGate = 'prep'
  if (env.POLICY_DEPLOY_GATE === 'anytime') AI_POLICY.deployGate = 'anytime'
  if (env.POLICY_REDEPLOY_PLANT === '1') AI_POLICY.redeployRequirePlantTarget = true
  if (env.POLICY_REDEPLOY_PLANT === '0') AI_POLICY.redeployRequirePlantTarget = false
  if (env.POLICY_DEPLOY_ATTACK === '1') AI_POLICY.deployOnlyOnAttack = true
  if (env.POLICY_DEPLOY_SPARE === '1') AI_POLICY.deployPreferSpareFuel = true
  if (env.POLICY_NO_REDEPLOY === '1') AI_POLICY.redeployEnabled = false
}
/** 政策摘要（写进 config / 战报，避免"跑了半天不知道哪一档"）。 */
const POLICY_TAG = `deployGate=${AI_POLICY.deployGate} · redeployRequirePlantTarget=${AI_POLICY.redeployRequirePlantTarget}`

/** 一个角色在整场比赛里的累计统计。 */
interface Tally {
  wins: number
  losses: number
  draws: number
  winsAsP0: number
  winsAsP1: number
  gamesAsP0: number
  gamesAsP1: number
  attacks: number
  hpMargin: number
  plies: number
  skills: Record<string, number>
  readyChances: number
  skillUses: number
}

function emptyTally(): Tally {
  return {
    wins: 0,
    losses: 0,
    draws: 0,
    winsAsP0: 0,
    winsAsP1: 0,
    gamesAsP0: 0,
    gamesAsP1: 0,
    attacks: 0,
    hpMargin: 0,
    plies: 0,
    skills: {},
    readyChances: 0,
    skillUses: 0,
  }
}

interface MatchupResult {
  a: CharacterId
  b: CharacterId
  aWins: number
  bWins: number
  draws: number
}

/** 一次循环赛（或一个分片）的全部原始数据，可 JSON 序列化后合并。 */
interface TournamentData {
  config: {
    pairsPerMatchup: number
    budget: number
    /**
     * 确定性预算（bugv18）：>0 时 AI 按"访问节点数上限"收手，同一输入必定同一着法。
     * 0 = 沿用时间预算（结果会随机器负载漂移）。
     */
    nodeLimit?: number
    maxPlies: number
    randomOpenPlies: number
    /**
     * 初始血量上限（bugv34o 加）：默认 `INITIAL_HP`（12）。
     * 调小（如 8）会**大幅缩短对局**（血量少 ⇒ 少挨几下就分胜负），
     * 用 `--hp=8` 或 `HP=8 bash scripts/tournament-parallel.sh …`。
     * ⚠️ 必须同时传给 `AiSkillContext.initialHp`（回血上限 / 护盾上限都按它算）。
     */
    initialHp: number
    /** AI 政策摘要（bugv34o）：`POLICY_*` 环境变量生效后的档位。 */
    policy?: string
  charList: CharacterId[]
  magicOn: boolean
  /** 数值变体名（见 `VARIANTS`）。 */
  variant: string
  shard: string
}
  gameNo: number
  /** 正在进行的这一局（实时战报用；正式 JSON 里一般不关心）。 */
  current?: string
  pliesSum: number
  shortGames: number
  midGames: number
  longGames: number
  gamesWithSkill: number
  /** 镜像（同角色自对局）统计：量"先手优势"，**不计胜负**。 */
  mirrorGames: number
  mirrorP0Wins: number
  mirrorP1Wins: number
  mirrorDraws: number
  skillTotals: Record<string, number>
  tallies: Record<string, Tally>
  matchups: MatchupResult[]
}

interface GameOutcome {
  winner: PlayerIndex | null
  plies: number
  hp: [number, number]
  attacks: [number, number]
  skills: [Record<string, number>, Record<string, number>]
  readyChances: [number, number]
}

function playGame(
  charIds: readonly [CharacterId, CharacterId],
  firstPlayer: PlayerIndex,
  budget: number,
  maxPlies: number,
  randomOpenPlies: number,
  magicOn: boolean,
  seed: number,
  difficulty: AiDifficulty,
  specs: (id: CharacterId) => readonly SkillSpec[],
  nodeLimit = 0,
  initialHp = INITIAL_HP,
): GameOutcome {
  const rng = mulberry32(seed)
  const engine = new GameEngine({
    initialHp,
    fixedFirstPlayer: firstPlayer,
    magic: { enabled: magicOn },
    skills: [specs(charIds[0]), specs(charIds[1])],
    night: { enabled: false },
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
    initialHp,
  })

  const skills: [Record<string, number>, Record<string, number>] = [{}, {}]
  const attacks: [number, number] = [0, 0]
  const readyChances: [number, number] = [0, 0]
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
      attacks[engine.highlightOwner ?? 0] += 1
      const decision = decideMove({
        board: engine.board as Board,
        player: defender,
        selfHp: engine.hp[defender],
        opponentHp: engine.hp[other(defender)],
        mode: 'defend',
        highlightWeights: engine.highlights,
        difficulty,
        timeLimitMs: budget,
        nodeLimit: nodeLimit > 0 ? nodeLimit : undefined,
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
    const decision = decideMove({
      board: engine.board as Board,
      player,
      selfHp: engine.hp[player],
      opponentHp: engine.hp[other(player)],
      mode: 'attack',
      difficulty,
      timeLimitMs: budget,
      nodeLimit: nodeLimit > 0 ? nodeLimit : undefined,
      magic: magicCtx(),
      skills: skillCtx(),
    })

    if (engine.skillStates()[player].some((state) => state.ready)) readyChances[player] += 1

    const appliedSkills = applyAiSkills(engine, player, decision.skills)
    for (const used of appliedSkills.used) skills[player][used.effect] = (skills[player][used.effect] ?? 0) + 1
    // endsTurn / assault：用完这一手不再落子（bugv14 收敛到 harness.applyAiSkills）
    if (appliedSkills.skipPlacement) continue

    let move = decision.move
    if (move < 0 || !engine.canPlaceAt(move)) {
      const pick = fallbackPlacement(engine, player)
      if (pick === undefined) break
      move = pick
    }
    engine.commit(move)
    engine.takeEvents()
  }

  return {
    winner: engine.result?.winner ?? null,
    plies,
    hp: [engine.hp[0], engine.hp[1]],
    attacks,
    skills,
    readyChances,
  }
}

/** 跑一个分片（或全部）的对局，返回原始数据。 */
function collect(
  cfg: TournamentData['config'],
  matchupList: Array<[CharacterId, CharacterId]>,
  difficulty: AiDifficulty,
  quiet = false,
  progressPath?: string,
): TournamentData {
  const specs = makeSpecResolver(cfg.variant)
  const data: TournamentData = {
    config: cfg,
    gameNo: 0,
    pliesSum: 0,
    shortGames: 0,
    midGames: 0,
    longGames: 0,
    gamesWithSkill: 0,
    mirrorGames: 0,
    mirrorP0Wins: 0,
    mirrorP1Wins: 0,
    mirrorDraws: 0,
    skillTotals: {},
    tallies: {},
    matchups: [],
  }
  for (const id of cfg.charList) data.tallies[id] = emptyTally()

  let gameNo = 0
  for (const [a, b] of matchupList) {
    let aWins = 0
    let bWins = 0
    let localDraws = 0

    for (let g = 0; g < cfg.pairsPerMatchup; g++) {
      const seed = 0x9e3779b1 + (cfg.charList.indexOf(a) * 1000 + cfg.charList.indexOf(b) * 100 + g) * 2654435761
      const mirror = a === b
      // 非镜像：同一开局，A 先手一局 + B 先手一局（配对抵消先后手偏差）。
      // 镜像：两边同角色，两局完全相同 → 只跑一局，否则会重复计数。
      const runs: Array<[CharacterId, CharacterId, PlayerIndex]> = mirror
        ? [[a, b, 0]]
        : [
            [a, b, 0],
            [b, a, 0],
          ]
      for (const [c0, c1, first] of runs) {
        gameNo += 1
        const out = playGame(
          [c0, c1],
          first,
          cfg.budget,
          cfg.maxPlies,
          cfg.randomOpenPlies,
          cfg.magicOn,
          seed,
          difficulty,
          specs,
          cfg.nodeLimit ?? 0,
          cfg.initialHp ?? INITIAL_HP,
        )
        data.pliesSum += out.plies
        if (out.plies <= 30) data.shortGames += 1
        else if (out.plies <= 80) data.midGames += 1
        else data.longGames += 1
        if (Object.keys(out.skills[0]).length > 0 || Object.keys(out.skills[1]).length > 0) {
          data.gamesWithSkill += 1
        }

        // ⚠️ 镜像对局里 c0 === c1 → t0 与 t1 是**同一个对象**：
        // 自对局的"一胜一负"对角色强度毫无意义，只会把胜率强行拉成 50%。
        // 所以镜像局**不计胜负**，只单独累计"先手 / 后手谁赢"（用来量先手优势）。
        const sameTally = c0 === c1
        const t0 = data.tallies[c0]
        const t1 = data.tallies[c1]

        const absorb = (t: Tally, side: 0 | 1): void => {
          t.attacks += out.attacks[side]
          t.hpMargin += out.hp[side] - out.hp[1 - side]
          t.readyChances += out.readyChances[side]
          for (const [eff, n] of Object.entries(out.skills[side])) {
            t.skills[eff] = (t.skills[eff] ?? 0) + n
            data.skillTotals[eff] = (data.skillTotals[eff] ?? 0) + n
            t.skillUses += n
          }
        }

        absorb(t0, 0)
        if (sameTally) absorb(t0, 1)
        else absorb(t1, 1)

        if (sameTally) {
          // 自对局：只量"先手优势"，不进胜负账（同一角色，胜=负没有意义）
          data.mirrorGames += 1
          if (out.winner === 0) {
            data.mirrorP0Wins += 1
            aWins += 1
          } else if (out.winner === 1) {
            data.mirrorP1Wins += 1
            bWins += 1
          } else {
            data.mirrorDraws += 1
            localDraws += 1
          }
        } else {
          t0.gamesAsP0 += 1
          t0.plies += out.plies
          t1.gamesAsP1 += 1
          t1.plies += out.plies

          if (out.winner === null) {
            t0.draws += 1
            t1.draws += 1
            localDraws += 1
          } else if (out.winner === 0) {
            t0.wins += 1
            t1.losses += 1
            t0.winsAsP0 += 1
            if (c0 === a) aWins += 1
            else bWins += 1
          } else {
            t1.wins += 1
            t0.losses += 1
            t1.winsAsP1 += 1
            // ⚠️ 这里 c1 才是赢家：c1 === a 表示 a 赢，必须记到 aWins（曾经写反过）
            if (c1 === a) aWins += 1
            else bWins += 1
          }
        }

        // 实时战报（bugv18）：每打完一局就把本分片的快照原子写到 `--progress=` 指定的文件。
        // 写失败只是"这一帧没刷新"，绝不能影响赛程本身。
        data.gameNo = gameNo
        data.current = `${c0} vs ${c1}`
        if (progressPath) writeProgress(progressPath, data)
      }
    }
    data.gameNo = gameNo
    data.matchups.push({ a, b, aWins, bWins, draws: localDraws })
    // 这一组打完了 —— 再刷一帧，否则"组合进度"会永远差最后一组
    if (progressPath) writeProgress(progressPath, data)
    if (!quiet) {
      console.log(
        `  ${a.padEnd(9)} vs ${b.padEnd(9)} : ${a} ${aWins} - ${localDraws} - ${bWins}` +
          `   （${cfg.pairsPerMatchup} 对 = ${cfg.pairsPerMatchup * 2} 局）`,
      )
    }  }
  data.gameNo = gameNo
  return data
}

/** 合并多个分片的数据。 */
function merge(all: TournamentData[]): TournamentData {
  const base = JSON.parse(JSON.stringify(all[0])) as TournamentData
  base.config = { ...base.config, shard: 'merged' }
  for (let i = 1; i < all.length; i++) {
    const d = all[i]
    base.gameNo += d.gameNo
    base.pliesSum += d.pliesSum
    base.shortGames += d.shortGames
    base.midGames += d.midGames
    base.longGames += d.longGames
    base.gamesWithSkill += d.gamesWithSkill
    base.mirrorGames += d.mirrorGames
    base.mirrorP0Wins += d.mirrorP0Wins
    base.mirrorP1Wins += d.mirrorP1Wins
    base.mirrorDraws += d.mirrorDraws
    for (const [eff, n] of Object.entries(d.skillTotals)) {
      base.skillTotals[eff] = (base.skillTotals[eff] ?? 0) + n
    }
    for (const [id, t] of Object.entries(d.tallies)) {
      const acc = (base.tallies[id] ??= emptyTally())
      acc.wins += t.wins
      acc.losses += t.losses
      acc.draws += t.draws
      acc.winsAsP0 += t.winsAsP0
      acc.winsAsP1 += t.winsAsP1
      acc.gamesAsP0 += t.gamesAsP0
      acc.gamesAsP1 += t.gamesAsP1
      acc.attacks += t.attacks
      acc.hpMargin += t.hpMargin
      acc.plies += t.plies
      acc.readyChances += t.readyChances
      acc.skillUses += t.skillUses
      for (const [eff, n] of Object.entries(t.skills)) acc.skills[eff] = (acc.skills[eff] ?? 0) + n
    }
    base.matchups.push(...d.matchups)
  }
  return base
}

/** 打印报告。 */
function report(data: TournamentData, elapsedMs: number): void {
  const { config: cfg } = data
  // 配对总分（每个组合的净胜场，A 视角）
  const pairNet = new Map<CharacterId, number>()
  for (const id of cfg.charList) pairNet.set(id, 0)
  for (const m of data.matchups) {
    if (m.a === m.b) continue
    pairNet.set(m.a, (pairNet.get(m.a) ?? 0) + (m.aWins - m.bWins))
    pairNet.set(m.b, (pairNet.get(m.b) ?? 0) + (m.bWins - m.aWins))
  }

  const rows = cfg.charList.map((id) => {
    const t = data.tallies[id]
    const games = t.wins + t.losses + t.draws
    const score = games === 0 ? 0 : (t.wins + t.draws * 0.5) / games
    return { id, t, games, score, hp: t.hpMargin / Math.max(1, games), net: pairNet.get(id) ?? 0 }
  })
  rows.sort((x, y) => y.score - x.score || y.hp - x.hp)

  if (cfg.nodeLimit && cfg.nodeLimit > 0) {
    console.log(`\n【确定性预算】每手 ≤ ${cfg.nodeLimit} 节点（同样输入必定同样着法，结果可复现）`)
  }
  if (cfg.variant && cfg.variant !== 'base') {
    const patches = VARIANTS[cfg.variant] ?? {}
    const desc = Object.entries(patches)
      .map(([id, p]) => `${id}{${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(',')}}`)
      .join(' ')
    console.log(`\n【数值变体 ${cfg.variant}】${desc}`)
  }

  console.log('\n逐组合比分（每组合打两局：双方各先手一次）')
  for (const m of data.matchups) {
    const total = m.aWins + m.bWins + m.draws
    const tag = m.a === m.b ? '（镜像：左 = 先手胜，右 = 后手胜）' : ''
    const left = m.a === m.b ? '先手' : m.a
    const right = m.a === m.b ? '后手' : m.b
    console.log(
      `  ${m.a.padEnd(9)} vs ${m.b.padEnd(9)} : ${left} ${String(m.aWins).padStart(2)} - 平 ${String(m.draws).padStart(2)} - ${String(m.bWins).padStart(2)} ${right}` +
        `   （${total} 局）${tag}`,
    )
  }

  console.log('\n角色强度排行（胜率 = 胜 + 平/2；镜像自对局不计）')
  console.log('排名  角色        胜/平/负    胜率     配对净胜  均血量差  场均手数  攻击   技能使用')
  for (let i = 0; i < rows.length; i++) {
    const { id, t, games, score, hp, net } = rows[i]
    const skillStr = Object.entries(t.skills)
      .sort((x, y) => y[1] - x[1])
      .map(([eff, n]) => `${eff}:${n}`)
      .join(' ')
    console.log(
      ` ${i + 1}    ${id.padEnd(10)} ${String(t.wins).padStart(2)}/${String(t.draws).padStart(2)}/${String(t.losses).padStart(2)}` +
        `   ${(score * 100).toFixed(1).padStart(5)}%   ${String(net).padStart(6)}` +
        `   ${hp.toFixed(2).padStart(6)}   ${(t.plies / Math.max(1, games)).toFixed(1).padStart(6)}` +
        `   ${String(t.attacks).padStart(4)}   ${skillStr || '-'}`,
    )
  }

  console.log('\n先手优势（同角色自对局：双方完全一样，唯一差别就是谁先走）')
  if (data.mirrorGames > 0) {
    console.log(
      `  ${data.mirrorGames} 局：先手胜 ${data.mirrorP0Wins} · 平 ${data.mirrorDraws} · 后手胜 ${data.mirrorP1Wins}` +
        `   → 先手胜率 ${(((data.mirrorP0Wins + data.mirrorDraws * 0.5) / data.mirrorGames) * 100).toFixed(1)}%`,
    )
  } else {
    console.log('  （未开启镜像组，加 `mirror` 位置参数可测）')
  }

  console.log('\n先后手偏差（跨全部对局，含镜像：注意镜像只算先手）')
  for (const { id, t } of rows) {
    console.log(`  ${id.padEnd(10)} 先手 ${t.winsAsP0}/${t.gamesAsP0}  后手 ${t.winsAsP1}/${t.gamesAsP1}`)
  }

  console.log('\n技能使用率（有可用技能的行动点里，真正放掉的比例）')
  for (const { id, t } of rows) {
    const rate = t.readyChances === 0 ? 0 : t.skillUses / t.readyChances
    console.log(
      `  ${id.padEnd(10)} 放了 ${String(t.skillUses).padStart(3)} / 可用行动点 ${String(t.readyChances).padStart(4)}  = ${(rate * 100).toFixed(1)}%`,
    )
  }

  console.log(`\n全场技能使用：${JSON.stringify(data.skillTotals)}`)
  console.log('\n对局诊断')
  console.log(
    `  平均手数 ${(data.pliesSum / Math.max(1, data.gameNo)).toFixed(1)}` +
      ` | ≤30 手 ${data.shortGames} · 31~80 手 ${data.midGames} · >80 手 ${data.longGames}`,
  )
  console.log(
    `  技能真正参与的对局 ${data.gamesWithSkill}/${data.gameNo}` +
      `（${((data.gamesWithSkill / Math.max(1, data.gameNo)) * 100).toFixed(1)}%）`,
  )

  const thinkSeconds = (data.pliesSum * cfg.budget) / 1000
  console.log('\n性能账')
  console.log(
    `  列数 ${data.gameNo} 局 / 总手数 ${data.pliesSum} / 每手预算 ${cfg.budget}ms` +
      `${cfg.nodeLimit && cfg.nodeLimit > 0 ? `（确定性：${cfg.nodeLimit} 节点/手）` : ''}` +
      `  → AI 纯思考 ${thinkSeconds.toFixed(1)}s，实际墙钟 ${(elapsedMs / 1000).toFixed(1)}s`,
  )
  console.log(`  （每加一倍并行分片，墙钟≈减半；AI 行为完全不变）`)
}

// ---------------------------------------------------------------------------
// 实时战报（bugv18）
//
// 并行分片时，每个分片每打完一局就把快照原子写到自己的 `.progress.json`；
// 这里以 `--watch` 模式每 1.5s 把全部分片合并一次，刷新到**桌面**的日志文件。
// 与串行/分片的结果完全一致（只是把"跑完才报"变成"边跑边报"）。
// ---------------------------------------------------------------------------

/** 把一个分片的当前快照原子写入 `path`（失败不影响赛程）。 */
function writeProgress(path: string, data: TournamentData): void {
  try {
    const text = JSON.stringify(data)
    const tmp = `${path}.tmp`
    writeFileSync(tmp, text)
    try {
      // 先写临时文件再改名 = 读者永远看到完整 JSON（Windows 目标被占用时退化为直接写）
      renameSync(tmp, path)
    } catch {
      writeFileSync(path, text)
    }
  } catch {
    /* 实时战报是"尽力而为"，写不进去不能让比赛挂掉 */
  }
}

/** 同步睡眠（watch 轮询用，不引入异步）。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 默认把战报写到桌面（用 node 自己解析路径，避免中文文件名经 shell 传参乱码）。 */
function defaultLivePath(): string {
  return join(homedir(), 'Desktop', '四子棋循环赛-实时战报.log')
}

/** 按"显示宽度"补齐（CJK 记 2 格），让中英文混排也能对齐。 */
function padCell(value: string | number, width: number): string {
  const str = String(value)
  let w = 0
  for (const ch of str) w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1
  return str + ' '.repeat(Math.max(0, width - w))
}

/** 胜率（胜 + 平/2）与它的 95% 置信区间半宽。 */
function scoreOf(t: Tally): { games: number; score: number; ci: number } {
  const games = t.wins + t.losses + t.draws
  const score = games === 0 ? 0 : (t.wins + t.draws * 0.5) / games
  const ci = games === 0 ? 0 : 1.96 * Math.sqrt(Math.max(0, score * (1 - score)) / games)
  return { games, score, ci }
}

/** 生成一帧实时战报文本。`data` 为 null 表示还没拿到任何分片数据。 */
function renderLive(
  data: TournamentData | null,
  opts: { total: number; matchupsTotal: number; startedAt: number; final: boolean; shards: number },
): string {
  const L: string[] = []
  const now = new Date()
  const hhmmss = (d: Date): string =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
      d.getSeconds(),
    ).padStart(2, '0')}`
  const cfg = data?.config

  L.push('四子棋循环赛 · 实时战报')
  L.push('═'.repeat(64))
  L.push(`开始时间  : ${new Date(opts.startedAt).toLocaleString('zh-CN')}${cfg ? '' : '（等待分片启动…）'}`)
  if (cfg) {
    L.push(
      `配置      : 变体 ${cfg.variant} · 每手 ${cfg.budget}ms · ${opts.shards} 分片 · 植物${
        cfg.magicOn ? '开' : '关'
      } · 血量上限 ${cfg.initialHp ?? INITIAL_HP} · 随机开局 ${cfg.randomOpenPlies} 手 · 手数上限 ${cfg.maxPlies}`,
    )
    L.push(`角色      : ${cfg.charList.join(', ')}`)
    if (cfg.policy) L.push(`AI 政策   : ${cfg.policy}`)
  }
  L.push(`目标规模  : ${opts.total} 局（含镜像自对局；镜像只量先手优势，不计胜负）`)
  L.push('')

  const done = data?.gameNo ?? 0
  const pct = opts.total > 0 ? Math.min(1, done / opts.total) : 0
  const barW = 30
  const filled = Math.round(pct * barW)
  const bar = '█'.repeat(filled) + '░'.repeat(barW - filled)
  const elapsed = Math.max(0, (now.getTime() - opts.startedAt) / 1000)
  const eta = done > 0 && !opts.final ? (elapsed * (opts.total - done)) / done : 0
  L.push(`进度      : [${bar}] ${(pct * 100).toFixed(1)}%   ${done}/${opts.total} 局`)
  L.push(
    `组合进度  : ${data?.matchups.length ?? 0}/${opts.matchupsTotal} 组` +
      `${data?.current ? `    当前对局：${data.current}` : ''}`,
  )
  L.push(`计时      : 已用时 ${elapsed.toFixed(0)}s${opts.final ? '（已结束）' : ` · 预计剩余 ${eta.toFixed(0)}s`}`)

  if (data && cfg) {
    L.push('')
    L.push('排名  角色        胜    平    负     总     胜率      ±95%CI    均血量差  场均手数')
    const rows = cfg.charList
      .map((id) => ({ id, t: data.tallies[id] ?? emptyTally() }))
      .map((r) => ({ ...r, ...scoreOf(r.t) }))
      .sort((x, y) => y.score - x.score || y.games - x.games)
    rows.forEach((r, i) => {
      const hp = r.t.hpMargin / Math.max(1, r.games)
      const plies = r.t.plies / Math.max(1, r.games)
      L.push(
        ` ${String(i + 1).padStart(2)}   ${padCell(r.id, 10)}` +
          `${String(r.t.wins).padStart(4)}${String(r.t.draws).padStart(6)}${String(r.t.losses).padStart(6)}` +
          `${String(r.games).padStart(7)}   ${(r.score * 100).toFixed(1).padStart(5)}%` +
          `   ${`±${(r.ci * 100).toFixed(1)}`.padStart(8)}` +
          `${(hp >= 0 ? '+' : '') + hp.toFixed(2)}`.padStart(10) +
          `${plies.toFixed(1)}`.padStart(10),
      )
    })

    if (data.mirrorGames > 0) {
      L.push('')
      L.push(
        `镜像自对局: ${data.mirrorGames} 局 — 先手胜 ${data.mirrorP0Wins} · 平 ${data.mirrorDraws} · ` +
          `后手胜 ${data.mirrorP1Wins}  → 先手胜率 ${(
            ((data.mirrorP0Wins + data.mirrorDraws * 0.5) / data.mirrorGames) * 100
          ).toFixed(1)}%`,
      )
    }

    if (opts.final) {
      L.push('')
      L.push(`全场技能使用：${JSON.stringify(data.skillTotals)}`)
      L.push('')
      L.push('技能使用率（有可用技能的行动点里，真正放掉的比例）')
      for (const id of cfg.charList) {
        const t = data.tallies[id]
        const rate = t.readyChances === 0 ? 0 : t.skillUses / t.readyChances
        L.push(
          `  ${padCell(id, 10)} 放了 ${String(t.skillUses).padStart(3)} / 可用 ${String(t.readyChances).padStart(4)} = ${(
            rate * 100
          ).toFixed(1)}%`,
        )
      }
      L.push('')
      L.push(
        `对局诊断：平均手数 ${(data.pliesSum / Math.max(1, data.gameNo)).toFixed(1)}` +
          ` | ≤30 手 ${data.shortGames} · 31~80 手 ${data.midGames} · >80 手 ${data.longGames}` +
          ` | 技能真正参与 ${data.gamesWithSkill}/${data.gameNo}`,
      )
    }
  } else {
    L.push('')
    L.push('  （等待第一个分片产出数据…）')
  }

  L.push('')
  L.push('─'.repeat(64))
  L.push(
    opts.final
      ? `✅ 比赛结束 · 本文件即最终战报（${hhmmss(now)}）`
      : `🔄 每 1.5 秒自动刷新 · 最近更新 ${hhmmss(now)}`,
  )
  return L.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const flags = argv.filter((x) => x.startsWith('--'))
const positional = argv.filter((x) => !x.startsWith('--'))
const jsonOut = flags.includes('--json')
const shardFlag = flags.find((f) => f.startsWith('--shard='))
const flagValue = (name: string): string | undefined => {
  const hit = flags.find((f) => f.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

// 实时战报：每 1.5s 把全部分片的进度快照合并后写到桌面日志，直到出现 `<dir>/.done`。
if (flags.includes('--watch')) {
  const dir = flagValue('dir') ?? '.tournament-tmp'
  const out = flagValue('out') ?? defaultLivePath()
  const total = Number(flagValue('total') ?? 0)
  const matchupsTotal = Number(flagValue('matchups') ?? 0)
  const shards = Number(flagValue('shards') ?? 0)
  const doneMarker = join(dir, '.done')
  const startedAt = Date.now()
  try {
    mkdirSync(dirname(out), { recursive: true })
  } catch {
    /* 桌面不存在时再报错也来得及 */
  }
  // 第一行把解析出来的路径打给 shell（中文文件名由 node 生成，绕开 shell 传参编码问题）
  console.log(`LIVE_OUT ${out}`)
  const readSnapshot = (): TournamentData | null => {
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.progress.json'))
    } catch {
      return null
    }
    const parts: TournamentData[] = []
    for (const f of files) {
      try {
        parts.push(JSON.parse(readFileSync(join(dir, f), 'utf8')) as TournamentData)
      } catch {
        /* 该分片正在写 → 这一帧先跳过它，下一帧会补上 */
      }
    }
    return parts.length > 0 ? merge(parts) : null
  }
  for (;;) {
    const finished = existsSync(doneMarker)
    const snapshot = readSnapshot()
    try {
      writeFileSync(out, renderLive(snapshot, { total, matchupsTotal, startedAt, final: finished, shards }))
    } catch {
      /* 忽略瞬时写失败 */
    }
    if (finished) break
    sleepSync(1500)
  }
  process.exit(0)
}

if (flags.includes('--merge')) {
  const files = positional
  const all: TournamentData[] = files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as TournamentData)
  const merged = merge(all)
  report(merged, 0)
  process.exit(0)
}

const pairsPerMatchup = Number(positional[0] ?? 10)
const budget = Number(positional[1] ?? 70)
const maxPlies = Number(positional[2] ?? 220)
const randomOpenPlies = Number(positional[3] ?? 8)
const charList = (positional[4] ?? CHARACTER_SPECS.map((c) => c.id).join(','))
  .split(',')
  .filter(Boolean) as CharacterId[]
const magicOn = (positional[5] ?? '1') !== '0'
const includeMirror = positional[6] === 'mirror'
const variantFlag = flags.find((f) => f.startsWith('--variant='))
const variant = variantFlag ? variantFlag.slice('--variant='.length) : 'base'
if (!VARIANTS[variant]) {
  throw new Error(`未知变体 ${variant}，可选：${Object.keys(VARIANTS).join(' / ')}`)
}

const [shardIdx, shardCount] = shardFlag
  ? shardFlag.slice('--shard='.length).split('/').map(Number)
  : [0, 1]

const allMatchups: Array<[CharacterId, CharacterId]> = []
// 🚩 `--focus=<角色>`（bugv32）：只生成「焦点角色 vs 其余每个角色」的组合，
// 跳过其它角色之间的对局 —— 想单独盯一个角色的强度（如 gtp）时，把循环赛
// 从 n(n+1)/2 组砍到 n−1 组，省 ~4 倍时间。焦点角色与自己的镜像组不生成
// （焦点强度直接看它 vs 其余角色的胜负，不需要自对）。
const focus = flagValue('focus')
if (focus) {
  if (!charList.includes(focus as CharacterId)) {
    throw new Error(`--focus=${focus} 不在角色列表 ${charList.join(',')} 里`)
  }
  for (const other of charList) {
    if (other === focus) continue
    allMatchups.push([focus as CharacterId, other])
  }
} else {
  for (let i = 0; i < charList.length; i++) {
    for (let j = includeMirror ? i : i + 1; j < charList.length; j++) {
      allMatchups.push([charList[i], charList[j]])
    }
  }
}
// 🚩 均衡重排（bugv32）：让每个角色的对局在时间轴上均匀交错。
// 原来的"对角块"顺序（i 从头扫）会让 charList 靠前的角色先打完、靠后的角色
// 半天不开张（实测 gtp 已 80 局 / seedance 才 18 局，实时战报进度严重失衡）。
// 贪心：每次挑"两个角色已出场次数之和最小"的组合；镜像（[x,x]）会让该角色
// 出场次数 +2 → 自然被推迟到后面。确定性重排（无随机），每局 seed 只依赖
// (a,b,g) 与顺序无关，所以合并结果与重排前完全一致，只改进度均匀性。
{
  const freq = new Map<CharacterId, number>()
  for (const c of charList) freq.set(c, 0)
  const rest = allMatchups.slice()
  const ordered: Array<[CharacterId, CharacterId]> = []
  while (rest.length > 0) {
    let pick = 0
    let pickScore = Infinity
    for (let k = 0; k < rest.length; k++) {
      const [x, y] = rest[k]
      const score = (freq.get(x)! + freq.get(y)!) * 1000 + Math.max(freq.get(x)!, freq.get(y)!)
      if (score < pickScore) {
        pickScore = score
        pick = k
      }
    }
    const [x, y] = rest[pick]
    ordered.push(rest[pick])
    freq.set(x, freq.get(x)! + 1)
    freq.set(y, freq.get(y)! + 1)
    rest.splice(pick, 1)
  }
  allMatchups.length = 0
  allMatchups.push(...ordered)
}
const myMatchups = allMatchups.filter((_, idx) => idx % shardCount === shardIdx)

// 确定性预算（bugv18）：`--nodes=15872` ≈ 本机 70ms。给了它就完全可复现。
const nodeLimit = Math.max(0, Number(flagValue('nodes') ?? 0))
// 血量上限（bugv34o）：调小能大幅缩短对局。默认就是线上口径 `INITIAL_HP`（12）。
const initialHp = Math.max(1, Math.round(Number(flagValue('hp') ?? INITIAL_HP)))

const cfg: TournamentData['config'] = {
  pairsPerMatchup,
  budget,
  nodeLimit,
  maxPlies,
  randomOpenPlies,
  initialHp,
  policy: POLICY_TAG,
  charList,
  magicOn,
  variant,
  shard: `${shardIdx}/${shardCount}`,
}

if (!jsonOut) {
  console.log(
    `循环赛：${pairsPerMatchup} 对/组合 × ${myMatchups.length} 个组合（共 ${allMatchups.length}）` +
      ` × 2 局 = ${myMatchups.length * pairsPerMatchup * 2} 局` +
      `（每手 ${budget}ms，专家档，血量上限 ${initialHp}，植物${magicOn ? '开' : '关'}${
        includeMirror ? '，含镜像' : ''
      }` +
      `${variant === 'base' ? '' : `，变体 ${variant}`}` +
      `${nodeLimit > 0 ? `，确定性预算 ${nodeLimit} 节点` : ''}）\n  🎛️ 政策：${POLICY_TAG}`,
  )
}

const started = Date.now()
const data = collect(cfg, myMatchups, 'expert', jsonOut, flagValue('progress'))
const elapsed = Date.now() - started

if (jsonOut) {
  const out = flags.find((f) => f.startsWith('--out='))
  const text = JSON.stringify(data)
  if (out) writeFileSync(out.slice('--out='.length), text)
  else process.stdout.write(text)
} else {
  report(data, elapsed)
}
