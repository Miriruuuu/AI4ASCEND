/**
 * 决策级实验：**GPU 到底能不能加速"一次真实决策"？**
 *
 * 做法（不碰任何规则，也不改 AI）：
 *   1. 用真实引擎 + 现有 AI 走出若干**真实中盘局面**（关掉魔力植物与技能，先隔离出搜索本身）；
 *   2. 对每个局面，用真实引擎枚举**深度 2 的全部叶子**（我走一步 × 对手应对一步）；
 *   3. 同一批叶子分别用 **CPU（单线程）** 与 **GPU（一次 dispatch）** 打分，校验逐位一致；
 *   4. 打印**每步决策的耗时拆解** —— 叶子生成 / CPU 打分 / GPU 打分 / 传输。
 *
 * 为什么要拆解：叶子生成跑的是真实规则（有状态、必须走 CPU），
 * **它才是端到端的大头**。只看"打分快 18×"会得出错误结论。
 *
 * 用法：
 *   npx tsx scripts/gpu/decision-bench.ts [局面数=10] [每局间隔手数=24]
 */
import { other, type Board, type PlayerIndex } from '../../src/core/types'
import { GameEngine } from '../../src/core/engine'
import { decideMove } from '../../src/ai/baseline'
import { startStaticServer, launch } from './cdp.mjs'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const POSITIONS = Number(process.argv[2] ?? 10)
const PLY_STEP = Number(process.argv[3] ?? 24)
const ROOT = resolve(import.meta.dirname ?? '.')
const DATA_DIR = resolve(ROOT, '.tmp')

const N = 9
const CELLS = N * N
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
]
const WINDOWS: number[][] = (() => {
  const out: number[][] = []
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++)
      for (const [dr, dc] of DIRS) {
        const cells: number[] = []
        let ok = true
        for (let k = 0; k < 4; k++) {
          const rr = r + dr * k
          const cc = c + dc * k
          if (rr < 0 || rr >= N || cc < 0 || cc >= N) { ok = false; break }
          cells.push(rr * N + cc)
        }
        if (ok) out.push(cells)
      }
  return out
})()

/**
 * 对比用的打分就是**棋盘窗口项**（GPU 内核与 CPU 参考实现逐句对应）。
 * 真实评估里还有血量/植物/技能等项，但它们不依赖棋盘扫描，用哪种设备算都一样，
 * 所以这里**刻意只比"棋盘扫描"这一段**，避免把无关差异混进来。
 */

/** CPU 参考打分：**只算棋盘窗口项**，与 WGSL 内核逐句对应（整数，保证逐位一致）。低位=我方。 */
function scoreCpu(boards: Uint32Array, count: number, out: Int32Array): void {
  for (let p = 0; p < count; p++) {
    const base = p * CELLS
    let acc = 0
    for (let w = 0; w < WINDOWS.length; w++) {
      const cells = WINDOWS[w]
      let mine = 0
      let theirs = 0
      for (let k = 0; k < 4; k++) {
        const v = boards[base + cells[k]]
        if (v === 1) mine++
        else if (v === 2) theirs++
      }
      if (theirs === 0 && mine > 0) acc += mine * mine * 10
      else if (mine === 0 && theirs > 0) acc -= theirs * theirs * 11
    }
    out[p] = acc
  }
}

interface Snap {
  board: number[]
  hp: [number, number]
  phase: 'playing' | 'awaitingDefense' | 'finished'
  current: PlayerIndex
}

function snapshot(engine: GameEngine): Snap {
  return {
    board: (engine.board as number[]).slice(),
    hp: [engine.hp[0], engine.hp[1]],
    phase: engine.phase,
    current: engine.current,
  }
}

function restore(engine: GameEngine, s: Snap): void {
  engine.loadScenario(s.board as Board, { hp: s.hp, phase: s.phase, current: s.current })
}

/** 把棋盘值重映射成"1 = player 的棋子、2 = 对手"，好让内核直接给出该方视角的分数。 */
function orient(board: readonly number[], player: PlayerIndex): number[] {
  const mine = player + 1
  const raw = mine === 1 ? board : board.map((v) => (v === 0 ? 0 : v === 1 ? 2 : 1))
  return raw as number[]
}

function legal(engine: GameEngine): number[] {
  return engine.legalMoves().filter((c) => engine.canPlaceAt(c))
}

/**
 * 枚举深度 2 叶子。返回：
 *   boards   —— 每个叶子的**我方视角**棋盘（length × 81，u32）
 *   hpDiff   —— 每个叶子的 (我方血 − 对手血)
 *   rootOf   —— 每个叶子属于哪个根着法（用于 min/max 归约）
 *   roots    —— 根着法列表
 */
function enumerateLeaves(engine: GameEngine, base: Snap, player: PlayerIndex) {
  const foe = other(player)
  const roots = legal(engine)
  const boardChunks: number[][] = []
  const hpDiff: number[] = []
  const rootOf: number[] = []

  for (const r of roots) {
    restore(engine, base)
    if (!engine.canPlaceAt(r)) continue
    engine.commit(r)
    engine.takeEvents()
    const afterRoot = snapshot(engine)

    if (engine.isOver) {
      // 我这一步直接结束了对局
      boardChunks.push(orient(afterRoot.board, player))
      hpDiff.push(afterRoot.hp[player] - afterRoot.hp[foe])
      rootOf.push(r)
      continue
    }

    const replies = engine.awaitingDefense ? engine.emptyCells() : legal(engine)
    if (replies.length === 0) {
      boardChunks.push(orient(afterRoot.board, player))
      hpDiff.push(afterRoot.hp[player] - afterRoot.hp[foe])
      rootOf.push(r)
      continue
    }
    for (const c of replies) {
      restore(engine, afterRoot)
      if (engine.awaitingDefense) engine.defend(c)
      else if (engine.canPlaceAt(c)) engine.commit(c)
      else continue
      engine.takeEvents()
      const leaf = snapshot(engine)
      boardChunks.push(orient(leaf.board, player))
      hpDiff.push(leaf.hp[player] - leaf.hp[foe])
      rootOf.push(r)
    }
  }

  const count = boardChunks.length
  const boards = new Uint32Array(count * CELLS)
  for (let i = 0; i < count; i++) boards.set(boardChunks[i], i * CELLS)
  return { boards, hpDiff: Int32Array.from(hpDiff), rootOf: Int32Array.from(rootOf), roots, count }
}

/** 收集真实中盘局面：用现有 AI 自对弈，每隔 PLY_STEP 手抓一个。 */
function collectPositions(want: number): Snap[] {
  const out: Snap[] = []
  // 关掉植物与技能，先只考察"搜索本身"
  const engine = new GameEngine({ initialHp: 8, fixedFirstPlayer: 0, magic: null, skills: null })
  engine.takeEvents()
  let plies = 0
  while (!engine.isOver && plies < 400 && out.length < want) {
    plies += 1
    if (plies % PLY_STEP === 0 && !engine.awaitingDefense) out.push(snapshot(engine))
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
        difficulty: 'expert',
        nodeLimit: 4000,
      })
      engine.defend(dec.move)
    } else {
      const player = engine.current
      const dec = decideMove({
        board: engine.board as Board,
        player,
        selfHp: engine.hp[player],
        opponentHp: engine.hp[other(player)],
        mode: 'attack',
        difficulty: 'expert',
        nodeLimit: 4000,
      })
      const mv = dec.move >= 0 && engine.canPlaceAt(dec.move) ? dec.move : legal(engine)[0]
      if (mv === undefined) break
      engine.commit(mv)
    }
    engine.takeEvents()
  }
  return out
}

// ───────────────────────────── 主流程 ─────────────────────────────

const positions = collectPositions(POSITIONS)
console.log(`收集到 ${positions.length} 个真实中盘局面（每 ${PLY_STEP} 手取一个）`)
if (positions.length === 0) process.exit(1)

// 枚举叶子 + CPU 打分
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })
const engine = new GameEngine({ initialHp: 8, fixedFirstPlayer: 0, magic: null, skills: null })
engine.takeEvents()

interface Case {
  idx: number
  file: string
  count: number
  roots: number
  genMs: number
  cpuMs: number
  cpuScores: Int32Array
  boards: Uint32Array
  rootOf: Int32Array
}
const cases: Case[] = []

for (let i = 0; i < positions.length; i++) {
  const s = positions[i]
  const player = s.current
  const t0 = performance.now()
  // 只取打分需要的两份；`hpDiff`（血量项）在两边都不参与——保证对比是**同一份计算**
  const { boards, rootOf, roots, count } = enumerateLeaves(engine, s, player)
  const genMs = performance.now() - t0
  if (count === 0) continue

  const cpuScores = new Int32Array(count)
  const t1 = performance.now()
  scoreCpu(boards, count, cpuScores)
  const cpuMs = performance.now() - t1

  const file = `.tmp/leaves-${i}.bin`
  writeFileSync(resolve(ROOT, file), Buffer.from(boards.buffer, boards.byteOffset, boards.byteLength))
  cases.push({ idx: i, file, count, roots: roots.length, genMs, cpuMs, cpuScores, boards, rootOf })
}

const totalLeaves = cases.reduce((a, c) => a + c.count, 0)
console.log(
  `叶子总数 ${totalLeaves}（平均 ${(totalLeaves / cases.length).toFixed(0)}/局面） · ` +
    `二进制已写入 ${DATA_DIR}`,
)
console.log('')

// GPU 侧
const { url, close: closeServer } = await startStaticServer(ROOT)
let closeBrowser = async () => {}
try {
  const { cdp, close, version } = await launch({
    url: `${url}/webgpu-eval.html`,
    readyExpr: 'typeof window.__scoreBoardsFromUrl === "function"',
  })
  closeBrowser = close
  console.log(`🌐 ${version.Browser} · 本地服务 ${url}`)

  const gpuMs: number[] = []
  const fetchMs: number[] = []
  let bytes = 0
  let allExact = true
  let maxDiff = 0

  for (const c of cases) {
    const r = await cdp.eval(`window.__scoreBoardsFromUrl(${JSON.stringify(c.file)}, ${c.count}, 3)`, {
      awaitPromise: true,
    })
    if (!r || !r.scores) throw new Error('GPU 没有返回分数')
    gpuMs.push(r.ms)
    fetchMs.push(r.fetchMs)
    bytes += r.bytes
    for (let k = 0; k < c.count; k++) {
      const d = Math.abs(r.scores[k] - c.cpuScores[k])
      if (d > maxDiff) maxDiff = d
      if (d !== 0) allExact = false
    }
  }

  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
  const n = cases.length
  const avgGen = sum(cases.map((c) => c.genMs)) / n
  const avgCpu = sum(cases.map((c) => c.cpuMs)) / n
  const avgGpu = sum(gpuMs) / n
  const avgFetch = sum(fetchMs) / n
  const avgLeaves = totalLeaves / n

  console.log('')
  console.log('══════ 每个决策的耗时拆解 ══════')
  console.log(`  平均叶子数：${avgLeaves.toFixed(0)}`)
  console.log(`  ① 叶子生成（真实规则，只能 CPU）：${avgGen.toFixed(2)} ms`)
  console.log(`  ② CPU 单线程打分              ：${avgCpu.toFixed(2)} ms`)
  console.log(`  ③ GPU 打分（一次 dispatch）   ：${avgGpu.toFixed(2)} ms   ← 打分环节快 ${(avgCpu / avgGpu).toFixed(1)}×`)
  console.log(`  ④ 二进制传输（本实验是 http fetch，真实集成会用 writeBuffer）：${avgFetch.toFixed(2)} ms`)
  console.log('')
  const cpuTotal = avgGen + avgCpu
  const gpuTotal = avgGen + avgGpu + avgFetch
  console.log(`  ⇒ 纯 CPU 端到端：${cpuTotal.toFixed(2)} ms/决策`)
  console.log(`  ⇒ GPU 端到端   ：${gpuTotal.toFixed(2)} ms/决策（含传输）`)
  console.log(`  ⇒ **端到端只快 ${(cpuTotal / gpuTotal).toFixed(2)}×**（打分环节快 ${(avgCpu / avgGpu).toFixed(1)}×）`)
  console.log(`  ⇒ 若传输可以忽略（iGPU 共享内存/常驻 writeBuffer）：${(cpuTotal / (avgGen + avgGpu)).toFixed(2)}×`)
  console.log('')
  console.log(`  逐位一致：${allExact ? '✅ 是' : `❌ 否（最大偏差 ${maxDiff}）`}`)
  console.log(`  对比基准：现有 AI 的确定性预算 = 15872 节点/决策`)
} catch (e) {
  console.error('❌ ' + (e?.message ?? e))
} finally {
  await closeBrowser()
  closeServer()
  rmSync(DATA_DIR, { recursive: true, force: true })
}
