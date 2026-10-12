/**
 * 表现层配色。
 *
 * 设计前提（见 bugv1.md）：
 * - 画布**完全透明**，棋盘直接落在页面背景上，没有画布边界；
 * - 页面默认是亮的（相当于白色环境光），攻击阶段整体压暗；
 * - 棋盘是无边界的深色实线网格，攻击阶段转为红色。
 */
export interface SidePalette {
  /** 主特征色（高光 / 特效 / 悬浮棋子的附着层颜色）。 */
  readonly color: number
  /** 高亮 / 自发光色。 */
  readonly glow: number
  /** 深色（暗面 / 立体感）。 */
  readonly deep: number
  /**
   * 棋子实体色（bugv3 #8：场上的棋子改为黑白棋子，特征色只保留在
   * 连珠高光、特效与悬浮棋子的附着层上）。
   */
  readonly stone: number
}

export interface Palette {
  /** 棋盘深色实线。 */
  readonly grid: number
  /** 攻击阶段棋盘实线（要求：变为红色）。 */
  readonly gridAttack: number
  /** 环境光颜色（默认偏白，模拟白色环境光）。 */
  readonly ambient: number
  /** 主光。 */
  readonly keyLight: number
  /** 补光。 */
  readonly fillLight: number
  /** 轮廓光（让棋子在白底上也有边缘质感）。 */
  readonly rimLight: number
  /** 攻击阶段光照保留比例。 */
  readonly darkFactor: number
  /** 高光 / 击中粒子。 */
  readonly spark: number
  readonly sides: readonly [SidePalette, SidePalette]
}

export const DEFAULT_PALETTE: Palette = {
  // 深色实线棋盘（在白底上清晰可读）
  grid: 0x1b1e26,
  gridAttack: 0xff2d3f,
  // 白色环境光
  ambient: 0xffffff,
  keyLight: 0xffffff,
  fillLight: 0xdfe6f5,
  rimLight: 0xffffff,
  darkFactor: 0.34,
  spark: 0xffcf6a,
  sides: [
    // 赤方：黑子（特征色赤红，只用于高光 / 特效 / 悬浮附着层）
    { color: 0xe0273c, glow: 0xff6b7d, deep: 0x6d0a15, stone: 0x0b0c10 },
    // 青方：白子（特征色青蓝）
    { color: 0x1668d6, glow: 0x59a6ff, deep: 0x08305f, stone: 0xf6f7f9 },
  ],
}

/** 允许宿主覆盖特征色（规则 10：默认红蓝，可在设置中更改）。 */
export function withSideColors(overrides: Partial<Record<'red' | 'blue', Partial<SidePalette>>>): Palette {
  const sides = DEFAULT_PALETTE.sides.map((side, index) => {
    const key = index === 0 ? 'red' : 'blue'
    const patch = overrides[key]
    return patch ? { ...side, ...patch } : side
  }) as unknown as readonly [SidePalette, SidePalette]
  return { ...DEFAULT_PALETTE, sides }
}
