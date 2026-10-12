/**
 * AI 客户端（bugv5 #4）：优先把决策丢给 worker，没有 Worker 时同步回退。
 *
 * 为什么需要它：强档单步要搜 0.5~1.2 秒，主线程被占满时动画会直接停住。
 * worker 里算就没有这个问题；而 jsdom / 老环境没有 Worker，就退回同步计算，
 * 保证功能和单测都不受影响。
 */
import {
  decideMove,
  type AiDecision,
  type AiRequest,
} from './baseline'
import type { AiWorkerRequest, AiWorkerResponse } from './protocol'
import { buildWorkerMessage } from './protocol'

/**
 * 请求 AI 决策的参数。
 *
 * ⚠️ 现在**直接就是 `AiRequest`**（bugv14 #1）：以前这里另立了一份字段声明、
 * 再由 `decide()` 拆成扁平消息发给 worker，结果 client 发的是 `magic`、
 * worker 读的是 `magicPlants`，实机 AI 整局拿不到植物。
 * 统一成一个类型 + `protocol.ts` 的整体透传，这类漂移就没法再发生。
 */
export type AiMoveRequest = AiRequest

interface Pending {
  resolve: (decision: AiDecision) => void
  reject: (error: unknown) => void
}

/** 能不能用 worker（Vite 会把这个 URL 拆成独立产物）。 */
function canUseWorker(): boolean {
  return typeof Worker !== 'undefined' && typeof URL !== 'undefined'
}

export class AiClient {
  private worker: Worker | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private disabled = false

  private ensureWorker(): Worker | null {
    if (this.disabled || !canUseWorker()) return null
    if (this.worker) return this.worker
    try {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      worker.addEventListener('message', (event: MessageEvent<AiWorkerResponse>) => {
        const data = event.data
        const entry = this.pending.get(data.id)
        if (!entry) return
        this.pending.delete(data.id)
        entry.resolve(data.decision)
      })
      worker.addEventListener('error', () => {
        // worker 挂了：把等待中的请求全部退回同步计算
        this.disabled = true
        const entries = [...this.pending.values()]
        this.pending.clear()
        this.worker?.terminate()
        this.worker = null
        for (const entry of entries) entry.reject(new Error('ai worker failed'))
      })
      this.worker = worker
      return worker
    } catch {
      this.disabled = true
      return null
    }
  }

  /** 请求一次决策（异步，不阻塞渲染）。 */
  async decide(request: AiMoveRequest): Promise<AiDecision> {
    const worker = this.ensureWorker()
    if (!worker) return decideMove(request)

    const id = this.nextId++
    // bugv14 #1：整体透传 request（结构化克隆），不做任何字段搬运。
    const message: AiWorkerRequest = buildWorkerMessage(id, request)

    try {
      return await new Promise<AiDecision>((resolve, reject) => {
        this.pending.set(id, { resolve, reject })
        worker.postMessage(message)
      })
    } catch {
      // worker 出问题就同步算一次，宁可卡一下也不能不下棋
      this.pending.delete(id)
      return decideMove(request)
    }
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
    this.pending.clear()
  }
}
