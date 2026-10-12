/**
 * 纯逻辑动画工具：缓动函数 + 轻量补间调度，避免引入 tween 依赖。
 *
 * 所有补间在同一个 `update(dt)` 中推进，便于与渲染循环绑定。
 */

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * 平滑阶跃：在 `edge0..edge1` 之间做 3 次多项式过渡（首尾导数为 0）。
 *
 * 用于特效的淡入淡出（bugv6 #7）：线性淡出在结尾会显得“忽然没了”，
 * 用 smoothstep 收尾才能看出过渡。
 */
export function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** 指数衰减插值（与帧率无关），用于鼠标视差跟随。 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt))
}

export const Easing = {
  linear: (t: number) => t,
  quadIn: (t: number) => t * t,
  quadOut: (t: number) => t * (2 - t),
  cubicIn: (t: number) => t * t * t,
  cubicOut: (t: number) => 1 - (1 - t) ** 3,
  cubicInOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  expoOut: (t: number) => (t === 1 ? 1 : 1 - 2 ** (-10 * t)),
  backOut: (t: number) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
  elasticOut: (t: number) => {
    if (t === 0 || t === 1) return t
    return 2 ** (-10 * t) * Math.sin(((t * 10 - 0.75) * (2 * Math.PI)) / 3) + 1
  },
  /** 先冲高再缓落，适合“掉落”手感。 */
  dropOut: (t: number) => 1 - (1 - t) ** 4,
} as const

export interface Tween {
  /** 已经过时间（秒）。 */
  elapsed: number
  duration: number
  /** 起始时刻（墙上时钟，秒）。 */
  startedAt: number
  update: (progress: number, dt: number) => void
  onComplete?: () => void
}

/**
 * 补间管理器。
 *
 * 进度以**墙上时钟**推进（而不是累加帧间隔），
 * 这样即使浏览器把多帧挤压在一次 rAF 回调里（后台标签页、无 vsync 的无头环境），
 * 动画的总时长依然与预期一致。
 */
export class Animator {
  private tweens: Tween[] = []
  private readonly now: () => number
  /**
   * 动画速度倍率（bugv28：设置面板可调 1 / 1.5 / 2）。
   *
   * 直接缩放"已经过时间"，所以**所有**基于 `run` / `wait` 的动画一起变速，
   * 不需要逐个改时长；中途改倍率也不会让正在播的动画倒退。1 = 原速。
   */
  timeScale = 1

  constructor(now: () => number = () => performance.now()) {
    this.now = now
  }

  /** 推进所有补间。 */
  update(_dt: number): void {
    if (this.tweens.length === 0) return
    const timestamp = this.now() / 1000
    const scale = this.timeScale > 0 ? this.timeScale : 1
    const completed: Tween[] = []
    for (const tween of this.tweens) {
      const previous = tween.elapsed
      // 乘倍率后与"上一帧的 elapsed"取大值：降速时不会让进度回退（bugv28）
      const next = Math.max((timestamp - tween.startedAt) * scale, tween.elapsed)
      const progress = tween.duration <= 0 ? 1 : clamp(next / tween.duration, 0, 1)
      tween.elapsed = next
      tween.update(progress, Math.max(next - previous, 0))
      if (progress >= 1) completed.push(tween)
    }
    if (completed.length > 0) {
      this.tweens = this.tweens.filter((tween) => !completed.includes(tween))
      for (const tween of completed) tween.onComplete?.()
    }
  }

  /**
   * 便捷写法：在 duration 秒内把进度从 0 推到 1（可带 delay 秒延迟）。
   * 返回的 Promise 在补间结束时兑现，便于串行编排动画。
   */
  run(
    duration: number,
    onUpdate: (t: number, dt: number) => void,
    options: { delay?: number; ease?: (t: number) => number; onComplete?: () => void } = {},
  ): Promise<void> {
    const ease = options.ease ?? Easing.linear
    const delay = options.delay ?? 0
    const total = Math.max(delay + Math.max(duration, 1e-6), 1e-6)
    return new Promise<void>((resolve) => {
      this.tweens.push({
        elapsed: 0,
        duration: total,
        startedAt: this.now() / 1000,
        update: (progress, dt) => {
          const seconds = progress * total
          const local = duration <= 0 ? 1 : clamp((seconds - delay) / duration, 0, 1)
          onUpdate(ease(local), dt)
        },
        onComplete: () => {
          options.onComplete?.()
          resolve()
        },
      })
    })
  }

  /** 等待若干秒（不阻塞其它补间）。 */
  wait(seconds: number): Promise<void> {
    return this.run(seconds, () => {})
  }

  /** 立即完成所有补间（用于“跳过动画”）。 */
  finishAll(): void {
    const pending = this.tweens.slice()
    this.tweens = []
    for (const tween of pending) {
      tween.update(1, 0)
      tween.onComplete?.()
    }
  }

  get pending(): number {
    return this.tweens.length
  }

  clear(): void {
    // 不能直接丢掉补间：那些 Promise 的等待者（回放 / 事件编排）会永远挂着。
    // 统一走 finishAll，让所有等待者都被唤醒（bugv9 #9：跳步要能中断正在播的动画）。
    this.finishAll()
  }
}
