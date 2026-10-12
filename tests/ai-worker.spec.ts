/**
 * AI worker 协议的回归测试（bugv14 #1）。
 *
 * 背景：实机人机对战走 `AiClient → Worker`。曾经 `client.ts` 发的是
 * `magic: { plants, damagePerPlant }`，而 `worker.ts` 读的是扁平的
 * `magicPlants` / `magicDamagePerPlant` —— 字段名不一致，**worker 永远拿不到植物**。
 *
 * 实机后果（用户回放里表现为"AI 在明显会被反击的情况下反复攻击"）：
 * 1. 反击强度按"没有植物"算：对手 4 子 + 2 棵植物 = 6，AI 以为是 4，与自己的 4 相等
 *    → 以为只是"抵消"（0 伤），实际被反打 2 点；
 * 2. AI 看不见植物资源 → 整局不捡植物；
 * 3. 技能要花植物 → AI 以为自己一棵没有 → 整局不放技能。
 *
 * 单测以前抓不到，是因为 node / jsdom 下没有 Worker，`AiClient` 会退回同步
 * `decideMove`（那条路径一直是好的）。所以这里既锁协议形状，又锁"植物必须参与反击计算"。
 */
import { describe, expect, it } from 'vitest'
import { decideMove, type AiMagicContext, type AiSkillContext } from '../src/ai/baseline'
import { buildWorkerMessage, readWorkerRequest } from '../src/ai/protocol'
import { INITIAL_HP, cellId, type Board, type Cell, type PlayerIndex } from '../src/core/types'

/** 把 9 行字符串（`.` 空 / `X` 玩家 1 / `O` 玩家 0）铺成棋盘。 */
function boardOf(rows: readonly string[]): Board {
  const board: Cell[] = new Array(81).fill(0)
  rows.forEach((row, r) => {
    for (let c = 0; c < 9; c++) {
      const ch = row[c]
      board[r * 9 + c] = ch === 'X' ? 2 : ch === 'O' ? 1 : 0
    }
  })
  return board
}

// ── 局面（AI = X = 玩家 1）──
// AI：row4 的 (4,0)(4,1)(4,2) 三连，落 (4,3) 即成 4 连攻击（攻击值 4）
// 对手：col6 的 (0,6)(1,6)(2,6) 三连，落 (3,6) 即成 4 连**反击**；这两棵植物归对手 → 反击 4+2=6
const ATTACK = cellId(4, 3)
const COUNTER = cellId(3, 6)
const BOARD = boardOf([
  '......O..',
  '......O..',
  '......O..',
  '.........',
  'XXX......',
  '.........',
  '.........',
  '.........',
  '.........',
])

const PLANTS: Array<[number, PlayerIndex | null]> = [
  [cellId(0, 6), 0],
  [cellId(1, 6), 0],
  [cellId(8, 8), null],
]

const EMPTY_SKILLS: AiSkillContext = {
  skills: [[], []],
  shield: [0, 0],
  bonusActions: [0, 0],
  actionsTaken: [0, 0],
  skillReadyAt: [[], []],
  skillCasts: [[], []],
  powerBonus: [0, 0],
  powerUntil: [0, 0],
  sabotage: [false, false],
  sabotageBonus: [0, 0],
  twinStar: [false, false],
  bloomCheaperNext: [false, false],
  immuneUntil: [0, 0],
  turnNo: 0,
  flames: [],
  overlay: [],
  initialHp: INITIAL_HP,
}

describe('AI worker 协议', () => {
  it('整体透传：植物与技能上下文必须原样送到 worker（曾经因字段名不一致整局丢失）', () => {
    const magic: AiMagicContext = { plants: PLANTS, damagePerPlant: 1 }
    const request = {
      board: BOARD,
      player: 1 as const,
      selfHp: 6,
      opponentHp: 6,
      mode: 'attack' as const,
      difficulty: 'normal' as const,
      magic,
      skills: EMPTY_SKILLS,
    }

    const message = buildWorkerMessage(7, request)
    // 模拟 postMessage：结构化克隆
    const delivered = readWorkerRequest(structuredClone(message))

    expect(message.id).toBe(7)
    expect(delivered.magic?.plants).toEqual(magic.plants)
    expect(delivered.magic?.damagePerPlant).toBe(1)
    expect(delivered.skills).toEqual(EMPTY_SKILLS)
    expect(delivered.mode).toBe('attack')
  })

  it('AI 必须把植物算进反击强度：缺了植物上下文它就会主动送死', () => {
    const base = {
      board: BOARD,
      player: 1 as const,
      selfHp: 6,
      opponentHp: 6,
      mode: 'attack' as const,
      maxDepth: 4,
      timeLimitMs: 3000,
    }

    // 知道反击是 4 子 + 2 棵植物 = 6 > 自己的 4 → 先封住对手的反击线
    const informed = decideMove({ ...base, magic: { plants: PLANTS, damagePerPlant: 1 } })
    expect(informed.move).toBe(COUNTER)

    // 看不到植物：以为反击只有 4，与自己相等（只是"抵消"）→ 直接成线攻击，实战被反打
    const blind = decideMove({ ...base })
    expect(blind.move).toBe(ATTACK)
  })

  it('确定性预算：给了 nodeLimit 后同一请求两次调用给出完全相同的决策（bugv18）', () => {
    const req = {
      board: BOARD,
      player: 1 as const,
      selfHp: 5,
      opponentHp: 5,
      mode: 'attack' as const,
      maxDepth: 22,
      // 时间预算仍传（不影响结果）：给了 nodeLimit 后 `now()` 完全不参与决策
      timeLimitMs: 3000,
      nodeLimit: 12000,
      magic: { plants: PLANTS, damagePerPlant: 1 },
    }
    const a = decideMove(req)
    const b = decideMove(req)
    expect(b.move).toBe(a.move)
    expect(b.score).toBe(a.score)
    expect(b.skills).toEqual(a.skills)
    // 连访问节点数都一样 ⇒ 两次搜索走的是完全相同的轨迹
    expect(b.nodes).toBe(a.nodes)
  })
})
