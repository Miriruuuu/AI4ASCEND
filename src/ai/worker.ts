/**
 * AI 计算 worker（bugv5 #4）。
 *
 * 强档（hard / expert）单步要搜几百毫秒到 1 秒以上，放在主线程会把
 * requestAnimationFrame 卡住 —— 表现就是"轮到 AI 时动画直接停住"。
 * 这里把 `decideMove` 挪到 worker 线程里跑，主线程继续渲染。
 *
 * 只依赖 `src/core`，因此这个 worker 的包非常小（不含 three）。
 *
 * ⚠️ 协议见 `protocol.ts`：**整体透传 `AiRequest`**，不要在这里逐字段重建 ——
 * 曾经因为字段名和客户端对不上（`magic` vs `magicPlants`），实机 AI 整局丢掉植物上下文。
 */
import { decideMove } from './baseline'
import { readWorkerRequest, type AiWorkerRequest, type AiWorkerResponse } from './protocol'

const scope = self as unknown as Worker

scope.addEventListener('message', (event: MessageEvent<AiWorkerRequest>) => {
  const { id } = event.data
  const request = readWorkerRequest(event.data)
  const decision = decideMove(request)
  const response: AiWorkerResponse = { id, decision }
  scope.postMessage(response)
})
