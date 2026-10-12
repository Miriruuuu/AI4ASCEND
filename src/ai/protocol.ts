/**
 * AI worker 的消息协议（bugv14 #1）。
 *
 * ⚠️ **必须整体透传 `AiRequest`，不要拆成扁平字段。**
 *
 * 踩过的坑：`client.ts` 曾经发 `magic: { plants, damagePerPlant }`，
 * 而 `worker.ts` 读的是扁平的 `magicPlants` / `magicDamagePerPlant` ——
 * 字段名不一致，于是 **worker 永远拿不到植物信息**（`magicPlants` 全项目没有任何地方写过）。
 *
 * 后果（实机可复现，人机对战整局）：
 * 1. AI 看不见植物资源 → 整局不去捡（候选集里植物格的优先级依赖 `magic`）；
 * 2. 技能要花植物 → AI 以为自己一棵都没有 → **整局不放技能**；
 * 3. 最致命：反击强度按"没有植物"算。实测一局里对手的防守连珠是
 *    `4 子 + 2 棵植物 = 6`，AI 以为是 `4`，和自己攻击值 4 相等 → 以为只会"抵消"（0 伤），
 *    实际是被反打 2 点直接阵亡 —— 这就是"**在明显会被反击的情况下反复攻击**"的来源。
 *
 * 单测抓不到它，是因为 jsdom / node 下没有 Worker，`AiClient` 会退回同步 `decideMove`
 * （那条路径一直是好的）。所以这里把协议收敛成"一个对象、一个字段"，
 * 让字段名漂移在结构上不可能发生，并用单测锁住"植物/技能必须原样送达"。
 */
import type { AiDecision, AiRequest } from './baseline'

/** 主线程 → worker：整体透传请求（结构化克隆）。 */
export interface AiWorkerRequest {
  id: number
  request: AiRequest
}

/** worker → 主线程：只回 `id` + 决策。 */
export interface AiWorkerResponse {
  id: number
  decision: AiDecision
}

/**
 * 打包一次决策请求（主线程侧）。
 *
 * 刻意只做"套一个信封"，**不改动任何字段** —— 任何"把 `AiRequest` 拆成
 * 扁平字段再在 worker 里拼回去"的写法都是漂移的温床。
 */
export function buildWorkerMessage(id: number, request: AiRequest): AiWorkerRequest {
  return { id, request }
}

/** 拆开一次决策请求（worker 侧）。与 `buildWorkerMessage` 严格互逆。 */
export function readWorkerRequest(message: AiWorkerRequest): AiRequest {
  return message.request
}
