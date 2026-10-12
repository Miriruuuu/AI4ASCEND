/**
 * 棋盘：落在**交叉点**上的无边界深色实线网格。
 *
 * - 9×9 条线 → 9×9 个交点，棋子落在交点上；
 * - 线条在棋盘外侧多延伸一段，形成“无边框、笔画出界”的观感；
 * - 没有底板、没有圆盘、没有外框，画布本身透明；
 * - 攻击阶段整片网格切换为红色。
 */
import {
  AdditiveBlending,
  BufferGeometry,
  CircleGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RingGeometry,
  Vector3,
  type Material,
} from 'three'
import { BOARD_SIZE, cellId } from '../core/types'
import { damp, smoothstep } from './anim'
import type { Palette } from './palette'

/** 相邻交点间距。 */
export const CELL_SIZE = 1
/** 棋盘跨度（8 格）。 */
export const BOARD_SPAN = CELL_SIZE * (BOARD_SIZE - 1)
/** 网格线在棋盘外的延伸长度（很短一截，保留“无边框”的手感）。 */
export const GRID_OVERHANG = CELL_SIZE * 0.34
/**
 * 攻击阶段棋盘换色的半周期（秒）——bugv9 #4：在双方特征色之间每 0.5 秒切换一次，
 * 切换过程用 smoothstep 做过渡（不是硬切）。
 */
export const ATTACK_SWITCH_SECONDS = 0.5

/** 棋盘下标 -> 世界坐标（交点）。 */
export function cellToWorld(index: number, out = new Vector3()): Vector3 {
  const row = Math.floor(index / BOARD_SIZE)
  const col = index % BOARD_SIZE
  return out.set((col - (BOARD_SIZE - 1) / 2) * CELL_SIZE, 0, (row - (BOARD_SIZE - 1) / 2) * CELL_SIZE)
}

/** 世界坐标 -> 最近的交点；越界返回 null。 */
export function worldToCell(point: Vector3): number | null {
  const col = Math.round(point.x / CELL_SIZE + (BOARD_SIZE - 1) / 2)
  const row = Math.round(point.z / CELL_SIZE + (BOARD_SIZE - 1) / 2)
  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return null
  return cellId(row, col)
}

export class BoardView {
  readonly group = new Group()
  /** 射线拾取用（比棋盘略大，方便边缘落子）。 */
  readonly pickPlane = new Mesh(
    new PlaneGeometry(BOARD_SPAN + CELL_SIZE * 2.4, BOARD_SPAN + CELL_SIZE * 2.4),
    new MeshBasicMaterial({ visible: false }),
  )

  private readonly grid: LineSegments
  private readonly gridMaterial: LineBasicMaterial
  private readonly highlights = new Map<number, Mesh>()
  private readonly highlightGroup = new Group()
  private readonly hover: Mesh
  /**
   * 上一步落子标记（bugv28 #2）：在"对手上一回合未成线的落子"外面套一圈特征色光环。
   *
   * 与攻击高光（`highlights`）分开管理：高光会被攻击流程反复清掉，这个标记要一直留到下一次落子。
   */
  private readonly lastMark: Mesh
  /** 技能挑选时的准心（bugv10 #9）。 */
  private readonly targetGroup: Group
  private readonly crosshair: Group
  private readonly baseColor = new Color()
  /** 黑夜的棋盘线色（bugv34：深红）。 */
  private readonly nightColor = new Color(0x9e1b28)
  /** 黑夜过渡（0 = 白天，1 = 黑夜）。 */
  private nightMix = 0
  private nightTarget = 0
  /** 攻击阶段的当前目标色（在双方特征色之间循环，bugv9 #4）。 */
  private readonly attackColor = new Color()
  private readonly attackColorA = new Color()
  private readonly attackColorB = new Color()
  private readonly mixScratch = new Color()
  private paletteSides: Palette['sides']
  private attackMix = 0
  private attackTarget = 0
  /** 换色相位：0 → 1 → 0 循环，每个半周期 0.5 秒。 */
  private attackCycle = 0
  /** 技能挑选时的压暗程度（bugv10 #2）。 */
  private skillDim = 0
  private skillDimTarget = 0
  private targetVisible = false

  constructor(palette: Palette) {
    this.baseColor.setHex(palette.grid)
    this.attackColor.setHex(palette.gridAttack)
    this.attackColorA.setHex(palette.sides[0].color)
    this.attackColorB.setHex(palette.sides[1].color)
    this.paletteSides = palette.sides

    // --- 无边界网格线 ---
    this.gridMaterial = new LineBasicMaterial({
      color: palette.grid,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    })
    this.grid = new LineSegments(this.buildGridGeometry(), this.gridMaterial)
    this.grid.position.y = 0
    this.group.add(this.grid)

    // --- 高光层（攻击方原位置） ---
    const highlightGeometry = new CircleGeometry(CELL_SIZE * 0.3, 40)
    for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
      const mesh = new Mesh(
        highlightGeometry,
        new MeshBasicMaterial({
          color: palette.sides[0].color,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      )
      mesh.rotation.x = -Math.PI / 2
      cellToWorld(i, mesh.position)
      mesh.position.y = 0.012
      mesh.visible = false
      this.highlights.set(i, mesh)
      this.highlightGroup.add(mesh)
    }
    this.group.add(this.highlightGroup)

    // --- 上一步落子标记（bugv28 #2）：一环特征色光环，套在棋子外面 ---
    this.lastMark = new Mesh(
      new RingGeometry(CELL_SIZE * 0.38, CELL_SIZE * 0.52, 48),
      new MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        side: DoubleSide,
      }),
    )
    this.lastMark.rotation.x = -Math.PI / 2
    this.lastMark.position.y = 0.014
    this.lastMark.visible = false
    this.group.add(this.lastMark)

    // --- 悬停指示 ---
    this.hover = new Mesh(
      new CircleGeometry(CELL_SIZE * 0.28, 36),
      new MeshBasicMaterial({
        color: palette.sides[0].color,
        transparent: true,
        opacity: 0.14,
        depthWrite: false,
      }),
    )
    this.hover.rotation.x = -Math.PI / 2
    this.hover.position.y = 0.01
    this.hover.visible = false
    this.group.add(this.hover)

    // --- 技能"选目标格"的准心（bugv10 #9 恶龙吐息） ---
    this.crosshair = new Group()
    const crossMaterial = new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    })
    const outer = new Mesh(new RingGeometry(CELL_SIZE * 0.3, CELL_SIZE * 0.36, 40), crossMaterial)
    const inner = new Mesh(new RingGeometry(CELL_SIZE * 0.1, CELL_SIZE * 0.14, 28), crossMaterial)
    const barA = new Mesh(new PlaneGeometry(CELL_SIZE * 0.96, CELL_SIZE * 0.022), crossMaterial)
    const barB = new Mesh(new PlaneGeometry(CELL_SIZE * 0.022, CELL_SIZE * 0.96), crossMaterial)
    this.crosshair.add(outer, inner, barA, barB)
    this.crosshair.rotation.x = -Math.PI / 2
    this.crosshair.visible = false
    this.targetGroup = new Group()
    this.targetGroup.visible = false
    this.targetGroup.add(this.crosshair)
    this.group.add(this.targetGroup)

    this.pickPlane.rotation.x = -Math.PI / 2
    this.pickPlane.position.y = 0.01
    this.group.add(this.pickPlane)
  }

  /** 9 条横线 + 9 条竖线，向两端各延伸 GRID_OVERHANG。 */
  private buildGridGeometry(): BufferGeometry {
    const half = BOARD_SPAN / 2
    const reach = half + GRID_OVERHANG
    const positions: number[] = []

    for (let i = 0; i < BOARD_SIZE; i++) {
      const offset = -half + i * CELL_SIZE
      // 横线
      positions.push(-reach, 0, offset, reach, 0, offset)
      // 竖线
      positions.push(offset, 0, -reach, offset, 0, reach)
    }

    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    return geometry
  }

  /** 显示高光（规则 4.1.4：仅攻击方原位置）。 */
  showHighlights(cells: readonly number[], weights: readonly number[], owner: 0 | 1, intensity = 1): void {
    const side = this.paletteSides[owner]
    cells.forEach((cell, index) => {
      const mesh = this.highlights.get(cell)
      if (!mesh) return
      const weight = weights[index] ?? 1
      const material = mesh.material as MeshBasicMaterial
      material.color.setHex(weight > 1 ? side.deep : side.color)
      material.opacity = Math.min(0.85, (0.4 + weight * 0.2) * intensity)
      mesh.visible = true
      mesh.scale.setScalar(1)
    })
  }

  clearHighlights(): void {
    for (const mesh of this.highlights.values()) {
      mesh.visible = false
      ;(mesh.material as MeshBasicMaterial).opacity = 0
    }
  }

  /**
   * 上一步落子标记（bugv28 #2）：`cell === null` 隐藏，否则在该格画一圈 `color` 色的光环。
   */
  setLastMark(cell: number | null, color = 0xffffff): void {
    if (cell === null) {
      this.lastMark.visible = false
      return
    }
    cellToWorld(cell, this.lastMark.position)
    this.lastMark.position.y = 0.014
    ;(this.lastMark.material as MeshBasicMaterial).color.setHex(color)
    this.lastMark.scale.setScalar(1)
    this.lastMark.visible = true
  }

  /** 棋盘点闪光（形成连珠时使用）。 */
  flashCells(cells: readonly number[], color: number): void {
    for (const cell of cells) {
      const mesh = this.highlights.get(cell)
      if (!mesh) continue
      const material = mesh.material as MeshBasicMaterial
      material.color.setHex(color)
      material.opacity = 0.6
      mesh.visible = true
      mesh.scale.setScalar(1.4)
    }
  }

  setHover(cell: number | null, color = 0x1b1e26, allowed = true): void {
    if (cell === null || !allowed) {
      this.hover.visible = false
      return
    }
    cellToWorld(cell, this.hover.position)
    this.hover.position.y = 0.01
    this.hover.visible = true
    ;(this.hover.material as MeshBasicMaterial).color.setHex(color)
  }

  /** 攻击阶段：网格转红。 */
  setAttackMode(active: boolean): void {
    this.attackTarget = active ? 1 : 0
  }

  /** 黑夜（bugv34）：棋盘线默认颜色转为深红。 */
  setNight(active: boolean): void {
    this.nightTarget = active ? 1 : 0
  }

  /**
   * 技能挑选时把棋盘压暗（bugv10 #2）。
   *
   * 与攻击阶段的暗场不同：这里只压网格线，让"我方魔力植物 + 上面的棋子"跳出来。
   */
  setSkillDim(active: boolean): void {
    this.skillDimTarget = active ? 1 : 0
  }

  /**
   * "选目标格"模式（bugv10 #9 恶龙吐息）：显示一个跟随鼠标的准心。
   *
   * 准心由 3 层同心圆环 + 十字线组成，棋盘同时压暗一点。
   */
  setTargeting(active: boolean): void {
    this.targetVisible = active
    this.targetGroup.visible = active
    if (active) this.skillDimTarget = 1
    else if (this.skillDimTarget === 1) this.skillDimTarget = 0
  }

  /** 把准心移到某一格（null = 隐藏，但仍在选目标模式）。 */
  setTargetCell(cell: number | null): void {
    if (cell === null) {
      this.crosshair.visible = false
      return
    }
    this.crosshair.visible = true
    cellToWorld(cell, this.crosshair.position)
    this.crosshair.position.y = 0.02
  }

  /** 技能暗场强度（验证脚本用）。 */
  get skillDimAmount(): number {
    return this.skillDim
  }

  /** 准心当前所在的格子（验证脚本用；未显示时为 null）。 */
  get targetCell(): number | null {
    if (!this.targetVisible || !this.crosshair.visible) return null
    return worldToCell(this.crosshair.position)
  }

  /** 运行中更新配色（设置面板）。 */
  setPalette(palette: Palette): void {
    this.baseColor.setHex(palette.grid)
    this.attackColor.setHex(palette.gridAttack)
    this.attackColorA.setHex(palette.sides[0].color)
    this.attackColorB.setHex(palette.sides[1].color)
    this.paletteSides = palette.sides
  }

  /** 当前攻击混合度（0 = 常态，1 = 全红），供外部做暗场同步。 */
  get attackAmount(): number {
    return this.attackMix
  }

  /**
   * 攻击阶段棋盘当前实际颜色（bugv9 #4 验证用）。
   *
   * 攻击阶段在双方特征色之间每 `ATTACK_SWITCH_SECONDS` 秒来回切换，
   * 处于过渡区间时返回的是插值色。
   */
  get attackColorCurrent(): number {
    return this.mixScratch.copy(this.baseColor).lerp(this.attackColor, this.attackMix).getHex()
  }

  /** 换色相位（0..1，0 与 1 分别对应两方特征色）。 */
  get attackPhase(): number {
    return this.attackCycle <= 1 ? this.attackCycle : 2 - this.attackCycle
  }

  update(dt: number, time: number, dark = 0): void {
    this.attackMix = damp(this.attackMix, this.attackTarget, 3.2, dt)
    // bugv9 #4：攻击阶段在双方特征色之间循环；离开攻击阶段后相位归零，回到黑色
    if (this.attackTarget > 0 || this.attackMix > 0.002) {
      this.attackCycle = (this.attackCycle + dt / ATTACK_SWITCH_SECONDS) % 2
    } else {
      this.attackCycle = 0
    }
    const wave = this.attackPhase
    // smoothstep 让两次切换之间是渐变而不是硬切
    const blend = smoothstep(0, 1, wave)
    this.attackColor.copy(this.attackColorA).lerp(this.attackColorB, blend)
    const color = this.mixScratch.copy(this.baseColor).lerp(this.attackColor, this.attackMix)
    // bugv34 黑夜：棋盘线默认颜色转为深红
    this.nightMix = damp(this.nightMix, this.nightTarget, 2.2, dt)
    if (this.nightMix > 0.002) color.lerp(this.nightColor, this.nightMix)
    this.gridMaterial.color.copy(color)
    // 暗场时网格一起收淡：页面背景由 CSS 压暗，画布上的线条随之安静下来（bugv3 #2）
    // bugv10 #2：技能挑选时再压暗一档，让高亮的植物与棋子跳出来
    this.skillDim = damp(this.skillDim, this.skillDimTarget, 6, dt)
    const dim =
      (1 - 0.55 * Math.max(0, Math.min(1, dark))) * (1 - 0.62 * Math.max(0, Math.min(1, this.skillDim)))
    this.gridMaterial.opacity = (0.9 + Math.sin(time * 2.2) * 0.03 * this.attackMix) * dim

    // 高光呼吸
    for (const mesh of this.highlights.values()) {
      if (!mesh.visible) continue
      mesh.scale.setScalar(1 + Math.sin(time * 3.1 + mesh.position.x) * 0.06)
    }
    // 上一步落子标记：呼吸（bugv28 #2）
    if (this.lastMark.visible) {
      this.lastMark.scale.setScalar(1 + Math.sin(time * 3.4) * 0.1)
    }
    if (this.hover.visible) {
      this.hover.scale.setScalar(0.94 + Math.sin(time * 5) * 0.06)
    }
    // 准心：反向自转 + 呼吸（bugv10 #9）
    if (this.targetVisible) {
      this.crosshair.rotation.z = -time * 0.9
      this.crosshair.scale.setScalar(1 + Math.sin(time * 4.4) * 0.07)
    }
  }

  dispose(): void {
    this.grid.geometry.dispose()
    this.gridMaterial.dispose()
    for (const mesh of this.highlights.values()) {
      mesh.geometry.dispose()
      ;(mesh.material as MeshBasicMaterial).dispose()
    }
    this.highlightGroup.clear()
    this.highlights.clear()
    this.lastMark.geometry.dispose()
    ;(this.lastMark.material as MeshBasicMaterial).dispose()
    this.hover.geometry.dispose()
    ;(this.hover.material as MeshBasicMaterial).dispose()
    // 准心（bugv10 #9）：两个环 + 两条长条共用一个材质
    let crossMaterial: Material | null = null
    for (const child of this.crosshair.children) {
      const mesh = child as Mesh
      mesh.geometry.dispose()
      crossMaterial = mesh.material as Material
    }
    crossMaterial?.dispose()
    this.crosshair.clear()
    this.pickPlane.geometry.dispose()
    ;(this.pickPlane.material as MeshBasicMaterial).dispose()
  }
}
