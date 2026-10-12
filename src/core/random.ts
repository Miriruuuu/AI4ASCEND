/** 可复现的伪随机数发生器（mulberry32）。 */
export class Rng {
  private state: number

  constructor(seed = Date.now() >>> 0) {
    this.state = seed >>> 0
  }

  /** [0, 1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** [min, max] 闭区间整数。 */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]
  }
}

/** 掷一颗骰子（1..6）。 */
export function rollDie(rng: Rng): number {
  return rng.int(1, 6)
}
