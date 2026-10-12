/**
 * 烈焰层（bugv10 #9 恶龙吐息）：**火球** + 棋盘上的**熊熊烈焰**。
 *
 * - `fireball()`：从 `from` 飞向 `to` 的硕大火球（熔岩球 + 外发光壳 + 白炽核心 + 彗尾 + 旋转光环），
 *   走一条向上拱起 2.2 单位的二次曲线；命中瞬间回调 `onImpact`，随后播爆炸
 *   （三层扩散环 + 闪光球 + 火星迸射），Promise 在爆炸播完后兑现。
 * - `ignite() / setRemaining() / clear()`：按格子维护持久燃烧的火焰，
 *   每格 = 3 条火舌 + 地面余烬光斑 + 地面暗斑 + 2 颗上升火星 = 7 个 mesh。
 *
 * 视觉风格与 `effects-view.ts` 一致（加色混合 + 程序化 canvas 贴图），
 * 但贴图与几何都在本文件里自建、自管，`dispose()` 会全部释放。
 *
 * 坐标约定：所有火球相关对象都是 `group` 的**直接子节点**，位置即世界坐标；
 * 火焰格子是 `group` 下的子组，位置由 `cellToWorld()` 给出。
 * 时间约定：`update(dt, elapsed)`，`elapsed` 是开局以来的秒数。
 */
import {
  AdditiveBlending,
  CanvasTexture,
  CircleGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
  type Texture,
} from 'three'
import { CELL_SIZE, cellToWorld } from './board-view'
import { clamp } from './anim'

// ---------------------------------------------------------------------------
// 配色：深红 → 橙 → 黄 → 近白
// ---------------------------------------------------------------------------

/** 火焰基色（火舌根部 / 余烬 / 火星）。 */
const DEEP_RED = 0xff2b06
/** 火舌中段。 */
const ORANGE = 0xff7a18
/** 火舌上段。 */
const YELLOW = 0xffc233
/** 火舌尖端。 */
const WHITE_HOT = 0xfff2c2
/** 火球熔岩外表的暗红。 */
const MOLTEN_DARK = 0x931302
/** 火球与爆炸的亮橙。 */
const BLAZE = 0xff7b14
/** 爆炸闪光的近白色。 */
const FLASH = 0xffe6a8
/** 地面暗斑（非加色，靠遮挡压出"地面被烤焦"的观感）。 */
const SCORCH = 0x1c0703
/** bugv26 #1：青蓝火的"烤焦"暗斑（偏冷，别在蓝火下面留一块橙褐色）。 */
const FOE_SCORCH = 0x04101f
/**
 * bugv14：**对手烈焰**的配色（1 号位）。
 *
 * 加色混合下与暖橙最容易区分的是青蓝；三档保持越旺越亮的层次。
 */
const FOE_DEEP = 0x0a2ff0
const FOE_ORANGE = 0x1f8bff
const FOE_YELLOW = 0x55d8ff
const FOE_HOT = 0xd8f6ff
/** bugv26 #1：青蓝版火球的暗部 / 亮部 / 闪光（与暖橙三兄弟一一对应）。 */
const FOE_MOLTEN = 0x0b1a8a
const FOE_BLAZE = 0x2f9bff
const FOE_FLASH = 0xd8f6ff

/**
 * bugv26 #1：一套完整的"火焰配色"。
 *
 * 以前**只有棋盘上的火舌**按主人换色，火球本体 / 彗尾 / 爆炸 / 粒子仍是暖橙 ——
 * 1 号位放火球时观感割裂（飞过来是橙色，落地却变蓝）。
 * 现在整套（火球 + 爆炸 + 点燃涟漪）都用同一套配色。
 */
export interface FirePalette {
  /** 火舌根部 / 余烬 / 火星的深色。 */
  readonly deep: number
  /** 火舌中段 / 光环。 */
  readonly orange: number
  /** 火舌上段 / 拖尾。 */
  readonly yellow: number
  /** 火舌尖端 / 白炽核心。 */
  readonly hot: number
  /** 熔岩外表的暗色。 */
  readonly molten: number
  /** 火球外发光的亮色。 */
  readonly blaze: number
  /** 爆炸闪光的近白色。 */
  readonly flash: number
}

/** 0 号位：暖橙（原样）。 */
const WARM_PALETTE: FirePalette = {
  deep: DEEP_RED,
  orange: ORANGE,
  yellow: YELLOW,
  hot: WHITE_HOT,
  molten: MOLTEN_DARK,
  blaze: BLAZE,
  flash: FLASH,
}
/** 1 号位：青蓝。 */
const COOL_PALETTE: FirePalette = {
  deep: FOE_DEEP,
  orange: FOE_ORANGE,
  yellow: FOE_YELLOW,
  hot: FOE_HOT,
  molten: FOE_MOLTEN,
  blaze: FOE_BLAZE,
  flash: FOE_FLASH,
}

/** 按主人取火焰配色（`0` 暖橙 / `1` 青蓝）。 */
export function firePalette(owner: 0 | 1): FirePalette {
  return owner === 1 ? COOL_PALETTE : WARM_PALETTE
}
/** 火球飞行的最大拱高（世界单位）。 */
const ARC_HEIGHT = 2.2
/** 默认飞行时长（秒）。 */
const DEFAULT_FLIGHT = 0.75
/** 命中后爆炸的时长（秒）。 */
const EXPLOSION_TIME = 0.9
/** 熄灭动画时长（秒）。 */
const CLEAR_TIME = 0.3

/** 单格火焰的几何缩放基准（格宽 CELL_SIZE = 1）—— 火舌最高约 0.85 格。 */
/** 每一格火焰的整体放大（bugv10 追加 #7：火焰要更明显）。 */
const FLAME_BASE_SCALE = 1.35
// ---------------------------------------------------------------------------
// 确定性噪声
// ---------------------------------------------------------------------------

/** 整数哈希 → [0, 1)，用于"每格形状固定"。 */
function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123
  return x - Math.floor(x)
}

/** 以 cell / 序号为种子的稳定随机数。 */
function seeded(cell: number, slot: number): number {
  return hash01(cell * 17.13 + slot * 3.77 + 0.37)
}

// ---------------------------------------------------------------------------
// 程序化贴图
// ---------------------------------------------------------------------------

/**
 * 火舌贴图：**底部亮、尖端透明**的加色光锥。
 *
 * 贴图本身画成白色，颜色全靠材质的 `color` 相乘；
 * 火焰柱做成两端收细的纺锤形（中间最宽），避免看起来像一根方柱子。
 */
function createFlameTexture(): Texture | null {
  if (typeof document === 'undefined') return null
  const width = 128
  const height = 256
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null

  // 纵向渐隐：底部 1 → 尖端 0（加成后就是"越往上越淡"）
  const vertical = context.createLinearGradient(0, height, 0, 0)
  vertical.addColorStop(0, 'rgba(255, 255, 255, 1)')
  vertical.addColorStop(0.3, 'rgba(255, 255, 255, 0.78)')
  vertical.addColorStop(0.62, 'rgba(255, 255, 255, 0.36)')
  vertical.addColorStop(1, 'rgba(255, 255, 255, 0)')

  // 横向纺锤：中间宽、两侧收边
  const across = context.createLinearGradient(0, 0, width, 0)
  across.addColorStop(0, 'rgba(255, 255, 255, 0)')
  across.addColorStop(0.24, 'rgba(255, 255, 255, 0.55)')
  across.addColorStop(0.5, 'rgba(255, 255, 255, 1)')
  across.addColorStop(0.76, 'rgba(255, 255, 255, 0.55)')
  across.addColorStop(1, 'rgba(255, 255, 255, 0)')

  context.fillStyle = vertical
  context.fillRect(0, 0, width, height)
  context.globalCompositeOperation = 'destination-in'
  context.fillStyle = across
  context.fillRect(0, 0, width, height)
  context.globalCompositeOperation = 'destination-over'
  // 底部再压一层椭圆光核，火根更亮
  const root = context.createRadialGradient(width / 2, height, 0, width / 2, height, height * 0.44)
  root.addColorStop(0, 'rgba(255, 255, 255, 0.95)')
  root.addColorStop(0.45, 'rgba(255, 255, 255, 0.34)')
  root.addColorStop(1, 'rgba(255, 255, 255, 0)')
  context.fillStyle = root
  context.fillRect(0, 0, width, height)
  context.globalCompositeOperation = 'source-over'

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

/** 柔和径向光斑：地面余烬 / 火球光壳 / 爆炸闪光共用一张。 */
function createGlowTexture(): Texture | null {
  if (typeof document === 'undefined') return null
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) return null
  const center = size / 2

  const glow = context.createRadialGradient(center, center, 0, center, center, center)
  glow.addColorStop(0, 'rgba(255, 255, 255, 1)')
  glow.addColorStop(0.18, 'rgba(255, 255, 255, 0.62)')
  glow.addColorStop(0.45, 'rgba(255, 255, 255, 0.2)')
  glow.addColorStop(0.75, 'rgba(255, 255, 255, 0.05)')
  glow.addColorStop(1, 'rgba(255, 255, 255, 0)')
  context.fillStyle = glow
  context.fillRect(0, 0, size, size)

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

/**
 * 熔岩贴图：暗红底 + 亮橙裂纹细丝（加色后像烧红的石壳）。
 * 每颗火球生成一次，随机裂纹让每次施法都不太一样。
 */
function createLavaTexture(): Texture | null {
  if (typeof document === 'undefined') return null
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) return null

  context.fillStyle = '#3d0b02'
  context.fillRect(0, 0, size, size)

  const cracks = 30
  context.lineCap = 'round'
  for (let i = 0; i < cracks; i++) {
    let x = Math.random() * size
    let y = Math.random() * size
    context.beginPath()
    context.moveTo(x, y)
    const segments = 3 + Math.floor(Math.random() * 4)
    for (let s = 0; s < segments; s++) {
      x += (Math.random() - 0.5) * size * 0.34
      y += (Math.random() - 0.5) * size * 0.34
      context.lineTo(x, y)
    }
    context.strokeStyle = `rgba(255, ${Math.floor(140 + Math.random() * 90)}, ${Math.floor(
      Math.random() * 60,
    )}, ${0.5 + Math.random() * 0.5})`
    context.lineWidth = 1 + Math.random() * 4
    context.stroke()
  }

  const rim = context.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size * 0.5)
  rim.addColorStop(0, 'rgba(255, 170, 60, 0.35)')
  rim.addColorStop(0.6, 'rgba(255, 120, 30, 0.12)')
  rim.addColorStop(1, 'rgba(255, 90, 20, 0)')
  context.fillStyle = rim
  context.fillRect(0, 0, size, size)

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

// ---------------------------------------------------------------------------
// 内部记录
// ---------------------------------------------------------------------------

/** 火舌模板：形状在构造时就"随机"（每格再按种子微调），所以几何是共享的。 */
interface TongueTemplate {
  /** 相对格心的位置（y 为火根高度，围绕格心散开）。 */
  readonly offset: Vector3
  /** 朝向：让平面从格心朝外，多个角度都能看见。 */
  readonly angle: number
  /** 尺寸。 */
  readonly sx: number
  readonly sy: number
  /** 颜色渐变的一档（0 最暗红 → 1 近白）。 */
  readonly tier: number
  /** 该档颜色插值的固定相位 / 速率。 */
  readonly phase: number
  readonly speed: number
  /** 绕自身竖轴的自转速度（弧度/秒）。 */
  readonly spin: number
}

interface EmberTemplate {
  /** 上升的相位偏移（0..1）。 */
  readonly phase: number
  /** 起点相对格心的偏移方向（半径比例）。 */
  readonly rx: number
  readonly rz: number
}

/** 一个燃烧中的格子。 */
interface FlameCell {
  readonly cell: number
  readonly seed: number
  /** bugv14：这批火的主人（决定火舌配色）。 */
  readonly owner: 0 | 1
  /** bugv26 #1：这一格的火焰配色（由 `owner` 决定，火球也共用同一套）。 */
  readonly palette: FirePalette
  readonly group: Group
  readonly tongues: Mesh[]
  readonly embers: Mesh[]
  readonly glow: Mesh
  readonly scorch: Mesh
  /** 剩余燃烧回合（用于强度）。 */
  remaining: number
  /** 正在熄灭。 */
  clearing: boolean
  unlit: number
  /** 点燃/加档时的小爆闪（1 → 0 衰减）。 */
  flash: number
  /** 强度插值（0..1）。 */
  strength: number
}

/** 一次飞行 / 爆炸。 */
interface FireballRun {
  readonly head: Group
  /** 熔岩球本体（命中瞬间立刻消失，bugv11 追加 #4）。 */
  readonly body: Mesh
  /** bugv26 #1：这次飞行的整套配色（火球 / 彗尾 / 爆炸）。 */
  readonly palette: FirePalette
  readonly halo: Mesh
  readonly core: Mesh
  readonly trail: Mesh[]
  readonly ringA: Mesh
  readonly ringB: Mesh
  readonly history: Vector3[]
  readonly direction: Vector3
  readonly from: Vector3
  readonly to: Vector3
  readonly trailCount: number
  readonly duration: number
  readonly onImpact: (() => void) | undefined
  readonly resolve: () => void
  phase: 'fly' | 'explode' | 'done'
  time: number
  impactFired: boolean
  /** 爆炸元素（命中时才建，避免每次施法都白建一堆 mesh）。 */
  burst: BurstRecord | null
}

/** 爆炸：扩散环 + 闪光球 + 火星。 */
interface BurstRecord {
  readonly flash: Mesh
  readonly rings: Mesh[]
  readonly embers: Mesh[]
  readonly emberVelocities: Vector3[]
  readonly emberAngles: number[]
  readonly emberSpeeds: number[]
}

/**
 * 恶龙吐息的可视层。
 *
 * 典型接线（由 `scene-controller.ts` 调用）：
 * ```ts
 * this.flame.ignite(cells, turns)
 * this.flame.setRemaining(cells, remaining)
 * this.flame.clear(cells)
 * await this.flame.fireball(from, to, { onImpact: () => this.effects.sunburst(to, 0xff7b14) })
 * // 每帧：
 * this.flame.update(dt, this.clock.time)
 * ```
 */
export class FlameView {
  readonly group = new Group()

  // --- 共享几何 ---
  private readonly tongueGeometry: PlaneGeometry
  private readonly haloGeometry: SphereGeometry
  private readonly coreGeometry: SphereGeometry
  private readonly trailGeometry: PlaneGeometry
  private readonly ringGeometry: TorusGeometry
  private readonly glowDiscGeometry: CircleGeometry
  private readonly emberGeometry: PlaneGeometry

  // --- 共享材质（按火舌档位 / 用途各一份，所有格子复用） ---
  /** `[主人][火舌档位]`（bugv14：双方都是 gtp 时靠它区分是谁的火）。 */
  private readonly tongueMaterials: MeshBasicMaterial[][]
  private readonly tongueBaseColors: Color[][]
  private readonly tongueLightColors: Color[][]
  /** bugv26 #1：余烬 / 地面光斑 / 暗斑也按主人分两套（以前是共享材质，青蓝火也配暖橙余烬）。 */
  private readonly emberMaterials: MeshBasicMaterial[]
  private readonly glowMaterials: MeshBasicMaterial[]
  private readonly scorchMaterials: MeshBasicMaterial[]

  // --- 贴图 ---
  private readonly flameTexture: Texture | null
  private readonly glowTexture: Texture | null
  private readonly lavaTexture: Texture | null

  private readonly templates: TongueTemplate[] = []
  private readonly emberTemplates: EmberTemplate[] = []

  private readonly flames = new Map<number, FlameCell>()
  private readonly seeds = new Map<number, number>()
  private readonly runs: FireballRun[] = []

  /** 自累计时间（`update(0, …)` 连续调用时也能停住动画）。 */
  private time = 0
  private disposed = false

  constructor() {
    // ---------- 共享几何 ----------
    // 底面贴在 y = 0，向上生长 —— 缩放/拉伸都绕火根，不会把火苗拽到地下
    this.tongueGeometry = new PlaneGeometry(1, 1).translate(0, 0.5, 0)
    this.haloGeometry = new SphereGeometry(1, 20, 14)
    this.coreGeometry = new SphereGeometry(1, 16, 12)
    this.trailGeometry = new PlaneGeometry(1, 1)
    this.ringGeometry = new TorusGeometry(1, 0.075, 10, 44)
    this.glowDiscGeometry = new CircleGeometry(1, 48).rotateX(-Math.PI / 2)
    this.emberGeometry = new PlaneGeometry(1, 1)

    // ---------- 贴图 ----------
    this.flameTexture = createFlameTexture()
    this.glowTexture = createGlowTexture()
    this.lavaTexture = createLavaTexture()

    // ---------- 材质 ----------
    // 三档颜色：深红→橙、橙→黄、黄→近白；每档一份材质，所有格子复用。
    // bugv14：**按主人分成两套**（双方都是 gtp 时能一眼看出这团火是谁的）——
    // 0 号位是原来的暖橙，1 号位整体偏青蓝（加色混合下与暖橙区分度足够，
    // 又不会盖过棋子的黑白配色）。
    const tierBase = [DEEP_RED, ORANGE, YELLOW]
    const tierLight = [ORANGE, YELLOW, WHITE_HOT]
    const tierBaseFoe = [FOE_DEEP, FOE_ORANGE, FOE_YELLOW]
    const tierLightFoe = [FOE_ORANGE, FOE_YELLOW, FOE_HOT]
    const buildMaterials = (bases: readonly number[]) =>
      bases.map(
        (base) =>
          new MeshBasicMaterial({
            map: this.flameTexture,
            color: base,
            transparent: true,
            opacity: 0.9,
            depthWrite: false,
            side: DoubleSide,
            blending: AdditiveBlending,
          }),
      )
    /** `[owner][tier]`。 */
    this.tongueMaterials = [buildMaterials(tierBase), buildMaterials(tierBaseFoe)]
    this.tongueBaseColors = [tierBase.map((c) => new Color(c)), tierBaseFoe.map((c) => new Color(c))]
    this.tongueLightColors = [tierLight.map((c) => new Color(c)), tierLightFoe.map((c) => new Color(c))]

    const makeEmber = (color: number) =>
      new MeshBasicMaterial({
        map: this.glowTexture,
        color,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: AdditiveBlending,
      })
    const makeGlow = (color: number) =>
      new MeshBasicMaterial({
        map: this.glowTexture,
        color,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        side: DoubleSide,
        blending: AdditiveBlending,
      })
    const makeScorch = (color: number) =>
      new MeshBasicMaterial({
        map: this.glowTexture,
        color,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        side: DoubleSide,
      })
    this.emberMaterials = [makeEmber(WARM_PALETTE.deep), makeEmber(COOL_PALETTE.deep)]
    this.glowMaterials = [makeGlow(WARM_PALETTE.deep), makeGlow(COOL_PALETTE.deep)]
    this.scorchMaterials = [makeScorch(SCORCH), makeScorch(FOE_SCORCH)]

    // ---------- 每格火舌模板 ----------
    // 用固定"花瓣"角排布 + 种子抖动，保证 3 条火舌能围住格心
    const templateCount = 3
    for (let i = 0; i < templateCount; i++) {
      const petal = (i / templateCount) * Math.PI * 2
      const jitterAngle = petal + (hash01(i * 7.31 + 1.7) - 0.5) * 0.7
      const radius = CELL_SIZE * (0.1 + hash01(i * 2.9 + 4.1) * 0.14)
      const sy = CELL_SIZE * (0.6 + hash01(i * 5.13 + 2.3) * 0.3)
      const sx = sy * (0.36 + hash01(i * 3.37 + 6.1) * 0.16)
      this.templates.push({
        offset: new Vector3(Math.cos(jitterAngle) * radius, 0, Math.sin(jitterAngle) * radius),
        angle: jitterAngle,
        sx,
        sy,
        tier: i % 3,
        phase: hash01(i * 11.7 + 3.3) * Math.PI * 2,
        speed: 6.5 + hash01(i * 4.7 + 8.2) * 5.5,
        spin: (hash01(i * 9.1 + 5.5) - 0.5) * 1.6,
      })
    }

    // ---------- 每格火星模板 ----------
    for (let i = 0; i < 2; i++) {
      const angle = hash01(i * 6.13 + 12.7) * Math.PI * 2
      const radius = CELL_SIZE * (0.1 + hash01(i * 8.27 + 9.4) * 0.2)
      this.emberTemplates.push({
        phase: hash01(i * 5.51 + 15.2),
        rx: Math.cos(angle) * radius,
        rz: Math.sin(angle) * radius,
      })
    }

    this.group.name = 'flame-view'
  }

  // -------------------------------------------------------------------------
  // 状态查询
  // -------------------------------------------------------------------------

  /** 某格现在是否在燃烧（含正在熄灭的余焰）。 */
  has(cell: number): boolean {
    return this.flames.has(cell)
  }

  /** 当前燃烧的格子。 */
  get cells(): number[] {
    return [...this.flames.keys()]
  }

  /**
   * 这一格的火是谁的（bugv26 #1：碎裂 / 走火特效要跟着火的主人配色）。
   *
   * `null` = 这格没有火。
   */
  ownerAt(cell: number): 0 | 1 | null {
    return this.flames.get(cell)?.owner ?? null
  }

  // -------------------------------------------------------------------------
  // 点燃 / 衰减 / 熄灭
  // -------------------------------------------------------------------------

  /** 点燃这些格子；`turns` = 还能燃烧几个回合（决定火焰强度）。 */
  ignite(cells: readonly number[], turns: number, owner: 0 | 1 = 0): void {
    if (this.disposed) return
    const strength = 1 - clamp((turns - 1) / 8, 0, 0.45)
    for (const cell of cells) {
      const existing = this.flames.get(cell)
      if (existing) {
        // 已经在烧：只加档 + 爆闪，不重建几何
        existing.remaining = turns
        existing.clearing = false
        existing.unlit = 0
        existing.flash = 1
        continue
      }
      const flame = this.createCell(cell, turns, strength, owner)
      this.flames.set(cell, flame)
      this.group.add(flame.group)
    }
  }

  /** 更新剩余回合（整行整列一起衰减时用）—— 回合越少火焰越小。 */
  setRemaining(cells: readonly number[], remaining: number): void {
    for (const cell of cells) {
      const flame = this.flames.get(cell)
      if (!flame) continue
      flame.remaining = remaining
      flame.clearing = false
      flame.unlit = 0
    }
  }

  /** 熄灭这些格子（先播收火动画，播完自行移除）。 */
  clear(cells: readonly number[]): void {
    for (const cell of cells) {
      const flame = this.flames.get(cell)
      if (!flame || flame.clearing) continue
      flame.clearing = true
      flame.remaining = 0
      flame.unlit = 0
    }
  }

  /** 全部清空（重开一局）：火焰立刻消失，飞行中的火球只做清理、不兑现 Promise。 */
  reset(): void {
    for (const flame of this.flames.values()) flame.group.removeFromParent()
    this.flames.clear()
    for (const run of this.runs) {
      run.head.removeFromParent()
      run.phase = 'done'
    }
    this.runs.length = 0
    this.time = 0
  }

  // -------------------------------------------------------------------------
  // 每帧
  // -------------------------------------------------------------------------

  /**
   * 每帧调用。
   *
   * @param dt 距上一帧的秒数（飞行/爆炸时长以它累计，帧率无关）
   * @param elapsed 开局以来的秒数（火舌闪动、火焰流动的相位）
   */
  update(dt: number, elapsed: number): void {
    this.time += dt
    this.updateFlames(dt, elapsed)
    this.updateFireballs(dt, elapsed)
  }

  // -------------------------------------------------------------------------
  // 火焰实现
  // -------------------------------------------------------------------------

  private createCell(cell: number, turns: number, strength: number, owner: 0 | 1): FlameCell {
    let seed = this.seeds.get(cell)
    if (seed === undefined) {
      seed = hash01(cell * 3.19 + 0.71)
      this.seeds.set(cell, seed)
    }

    const group = new Group()
    cellToWorld(cell, group.position)
    group.name = `flame-${cell}`

    const tongues: Mesh[] = []
    for (let i = 0; i < this.templates.length; i++) {
      const template = this.templates[i]
      const material = this.tongueMaterials[owner][template.tier]
      const mesh = new Mesh(this.tongueGeometry, material)
      const jitterAngle = template.angle + (seeded(cell, i * 3 + 1) - 0.5) * 0.6
      const radius = Math.hypot(template.offset.x, template.offset.z) * (0.7 + seeded(cell, i * 5 + 2) * 0.7)
      mesh.position.set(Math.cos(jitterAngle) * radius, 0, Math.sin(jitterAngle) * radius)
      mesh.rotation.y = jitterAngle
      const widen = FLAME_BASE_SCALE * (0.85 + seeded(cell, i * 7 + 3) * 0.3)
      mesh.scale.set(template.sx * widen, template.sy * widen, 1)
      mesh.userData.baseScale = new Vector3(template.sx * widen, template.sy * widen, template.sx * widen)
      mesh.userData.phase = template.phase + seed * 6.283
      mesh.userData.speed = template.speed * (0.85 + seeded(cell, i * 11 + 4) * 0.4)
      mesh.userData.spin = template.spin * (0.6 + seeded(cell, i * 13 + 5) * 0.9)
      mesh.renderOrder = 4
      tongues.push(mesh)
      group.add(mesh)
    }

    // 地面暗斑（非加色，先加进去、靠 depthWrite:false + renderOrder 压在网格之下）
    const scorch = new Mesh(this.glowDiscGeometry, this.scorchMaterials[owner])
    scorch.scale.setScalar(CELL_SIZE * 0.36)
    scorch.position.y = 0.004
    scorch.renderOrder = 1
    group.add(scorch)

    // 地面余烬光斑
    const glow = new Mesh(this.glowDiscGeometry, this.glowMaterials[owner])
    glow.scale.setScalar(CELL_SIZE * 0.42)
    glow.position.y = 0.018
    glow.renderOrder = 2
    group.add(glow)

    // 上升火星
    const embers: Mesh[] = []
    for (let i = 0; i < this.emberTemplates.length; i++) {
      const template = this.emberTemplates[i]
      const mesh = new Mesh(this.emberGeometry, this.emberMaterials[owner])
      mesh.position.set(template.rx, 0.05, template.rz)
      mesh.userData.phase = (template.phase + seed) % 1
      mesh.userData.rx = template.rx
      mesh.userData.rz = template.rz
      mesh.renderOrder = 6
      embers.push(mesh)
      group.add(mesh)
    }

    return {
      cell,
      seed,
      owner,
      palette: firePalette(owner),
      group,
      tongues,
      embers,
      glow,
      scorch,
      remaining: turns,
      clearing: false,
      unlit: 0,
      flash: 1,
      strength,
    }
  }

  /** 剩余回合 → 火焰强度（1 档最多，烧到最后也始终看得见；bugv10 追加 #7 整体调亮）。 */
  private targetStrength(remaining: number): number {
    return 1 - clamp((remaining - 1) / 6, 0, 0.32)
  }

  private updateFlames(dt: number, elapsed: number): void {
    for (const flame of this.flames.values()) {
      const owner = flame.owner
      flame.flash = Math.max(0, flame.flash - dt * 2.6)
      if (flame.clearing) {
        flame.unlit += dt
      } else {
        flame.unlit = 0
      }
      const target = flame.clearing ? 0 : this.targetStrength(flame.remaining)
      // 收火 0.3 秒内线性收干；点起来则用指数逼近
      flame.strength = flame.clearing
        ? Math.max(0, flame.strength - dt / CLEAR_TIME)
        : flame.strength + (target - flame.strength) * Math.min(dt * 3.4, 1)

      // 点燃爆闪只加亮、略微加高（否则一闪就会窜出格子）
      const spark = 1 + flame.flash * 0.15
      const ember = clamp(flame.strength * spark, 0, 1.2)
      const brightness = clamp(ember, 0, 1)

      // 火舌：绕自身竖轴慢转 + 竖直抽动 + 颜色在档内来回闪
      for (let i = 0; i < flame.tongues.length; i++) {
        const mesh = flame.tongues[i]
        const base = mesh.userData.baseScale as Vector3
        const phase = mesh.userData.phase as number
        const speed = mesh.userData.speed as number
        const spin = mesh.userData.spin as number
        const surge = 0.5 + 0.5 * Math.sin(elapsed * speed + phase)
        const breath = 0.82 + 0.26 * Math.sin(elapsed * speed * 1.63 + phase * 1.7)
        const width = 0.8 + 0.28 * Math.sin(elapsed * speed * 0.71 + phase * 2.3)
        mesh.scale.set(base.x * width * ember, base.y * (0.62 + 0.5 * surge) * breath * ember, base.z * ember)
        mesh.rotation.y += spin * dt
        mesh.rotation.z = Math.sin(elapsed * speed * 0.6 + phase * 1.9) * 0.12

        const tier = i % this.tongueMaterials[owner].length
        const material = this.tongueMaterials[owner][tier]
        const tint = 0.2 + 0.8 * clamp(surge * 0.7 + 0.3 * Math.sin(elapsed * speed * 2.7 + phase), 0, 1)
        material.color.copy(this.tongueBaseColors[owner][tier])
        material.color.lerp(this.tongueLightColors[owner][tier], tint)
        // 亮度下限：暗淡的瞬间也不能让火焰"看不见"（bugv10 追加 #7 抬高下限）
        material.opacity = brightness * (0.66 + 0.34 * tint)
      }

      // 地面余烬光斑：呼吸 + 随强度放大
      const glowPulse = 0.86 + 0.18 * Math.sin(elapsed * 1.9 + flame.seed * 6.283)
      flame.glow.scale.setScalar(CELL_SIZE * (0.42 + 0.18 * brightness) * glowPulse)
      flame.scorch.scale.setScalar(CELL_SIZE * (0.4 + 0.12 * brightness))
      flame.scorch.scale.y = 1

      // 上升火星：0..1 循环上升并淡出
      for (let i = 0; i < flame.embers.length; i++) {
        const mesh = flame.embers[i]
        const phase = (mesh.userData.phase as number) + elapsed * 0.42
        const t = phase - Math.floor(phase)
        const rise = CELL_SIZE * (0.25 + t * 0.72)
        // 上升时略微向外飘
        const swirl = Math.sin(elapsed * 1.6 + flame.seed * 5.1 + i * 2.2)
        mesh.position.set(
          (mesh.userData.rx as number) * (1 + t * 0.8) + swirl * 0.03,
          rise,
          (mesh.userData.rz as number) * (1 + t * 0.8),
        )
        const fade = Math.sin(Math.PI * t)
        const size = CELL_SIZE * (0.05 + 0.05 * fade) * (0.55 + 0.45 * brightness)
        mesh.scale.setScalar(Math.max(size, 0.001))
        mesh.rotation.z = swirl * 0.6
      }

      if (flame.clearing && flame.strength <= 0.001) {
        flame.group.removeFromParent()
        this.flames.delete(flame.cell)
      }
    }
  }

  // -------------------------------------------------------------------------
  // 火球
  // -------------------------------------------------------------------------

  /**
   * 一颗硕大的火球：从 `from` 飞到 `to`（世界坐标），沿弧线飞行、拖着彗尾；
   * **命中瞬间**调用 `options.onImpact()` 并让 Promise 兑现（bugv11 追加 #4：
   * 爆炸特效留在后台自己播完，调用方不用等它，否则后续的"烈焰点燃"会迟到近 1 秒）。
   *
   * bugv26 #1：`options.owner` 决定整套配色（火球 / 彗尾 / 爆炸 / 火星），
   * 与棋盘上火舌的主人配色保持同一套 —— 1 号位放出的就是青蓝火球。
   */
  fireball(
    from: Vector3,
    to: Vector3,
    options: { onImpact?: () => void; duration?: number; owner?: 0 | 1 } = {},
  ): Promise<void> {
    const duration = Math.max(options.duration ?? DEFAULT_FLIGHT, 0.05)
    const palette = firePalette(options.owner ?? 0)
    const head = new Group()
    head.name = 'fireball-head'
    head.position.copy(from)

    // 熔岩球：暗红外壳（贴图带亮橙裂纹）
    const body = new Mesh(
      this.haloGeometry,
      new MeshBasicMaterial({
        map: this.lavaTexture,
        color: palette.blaze,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      }),
    )
    body.scale.setScalar(0.5)
    head.add(body)

    // 外发光壳：略大的球，双面加色
    const halo = new Mesh(
      this.haloGeometry,
      new MeshBasicMaterial({
        map: this.glowTexture,
        color: palette.blaze,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        side: DoubleSide,
        blending: AdditiveBlending,
      }),
    )
    halo.scale.setScalar(0.86)
    head.add(halo)

    // 白炽核心
    const core = new Mesh(
      this.coreGeometry,
      new MeshBasicMaterial({
        map: this.glowTexture,
        color: palette.hot,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    )
    core.scale.setScalar(0.27)
    head.add(core)

    // 旋转光环（两个不同倾角）
    const ringA = new Mesh(
      this.ringGeometry,
      new MeshBasicMaterial({
        color: palette.orange,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    )
    ringA.scale.setScalar(0.72)
    const ringB = new Mesh(
      this.ringGeometry,
      new MeshBasicMaterial({
        color: palette.yellow,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    )
    ringB.scale.setScalar(0.92)
    ringB.rotation.set(1.1, 0.4, 0)
    head.add(ringA, ringB)

    this.group.add(head)

    // 彗尾：12 片拖尾，位置从"历史轨迹"里采样
    const trailCount = 12
    const trail: Mesh[] = []
    for (let i = 0; i < trailCount; i++) {
      const mesh = new Mesh(
        this.trailGeometry,
        new MeshBasicMaterial({
          map: this.glowTexture,
          color: i < trailCount * 0.4 ? palette.yellow : i < trailCount * 0.75 ? palette.orange : palette.molten,
          transparent: true,
          opacity: 0.5,
          depthWrite: false,
          blending: AdditiveBlending,
        }),
      )
      const size = 0.42 * (1 - i / (trailCount + 2))
      mesh.scale.setScalar(Math.max(size, 0.05))
      mesh.position.copy(from)
      mesh.renderOrder = 5
      this.group.add(mesh)
      trail.push(mesh)
    }

    let resolveFn: () => void = () => {}
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve
    })

    const direction = to.clone().sub(from)
    const length = direction.length()
    if (length > 0.0001) direction.multiplyScalar(1 / length)

    this.runs.push({
      head,
      body,
      palette,
      halo,
      core,
      trail,
      ringA,
      ringB,
      history: Array.from({ length: trailCount }, () => from.clone()),
      direction,
      from: from.clone(),
      to: to.clone(),
      trailCount,
      duration,
      onImpact: options.onImpact,
      resolve: resolveFn,
      phase: 'fly',
      time: 0,
      impactFired: false,
      burst: null,
    })

    return promise
  }

  private updateFireballs(dt: number, elapsed: number): void {
    for (let i = this.runs.length - 1; i >= 0; i--) {
      const run = this.runs[i]
      run.time += dt

      if (run.phase === 'fly') {
        this.updateFlight(run, elapsed)
        if (run.time >= run.duration) {
          // 命中：先摆到终点，再回调（回调里可能叠加别的撞击特效）
          this.placeHead(run, 1)
          run.phase = 'explode'
          run.time = 0
          if (!run.impactFired) {
            run.impactFired = true
            try {
              run.onImpact?.()
            } catch {
              // 回调里的异常不能把整局动画带崩
            }
            // bugv11 追加 #4：**命中瞬间**就兑现 Promise（以前要等 0.9 秒爆炸播完），
            // 这样后续事件（烈焰点燃）紧接着就能开始，火焰不会迟到 1 秒。
            // 爆炸本身继续在后台自己播完并回收，不需要调用方等它。
            run.resolve()
          }
        }
        continue
      }

      if (run.phase === 'explode') {
        this.updateExplosion(run, dt)
        if (run.time >= EXPLOSION_TIME) {
          run.phase = 'done'
          this.finishRun(run)
          this.runs.splice(i, 1)
        }
      }
    }
  }

  /** 抛物线飞行：`t` → 位置 + 彗尾采样 + 光环自转。 */
  private updateFlight(run: FireballRun, elapsed: number): void {
    const t = clamp(run.time / run.duration, 0, 1)
    this.placeHead(run, t)

    // 彗尾：每帧把头部位置押进历史队列，再按延迟采样
    run.history.unshift(run.head.position.clone())
    if (run.history.length > run.trailCount) run.history.pop()
    for (let i = 0; i < run.trail.length; i++) {
      const sample = run.history[Math.min(i, run.history.length - 1)]
      const mesh = run.trail[i]
      mesh.position.copy(sample)
      // 拖尾随时间缩小、抖动，像被风吹散
      const wobble = Math.sin(elapsed * 7.3 + i * 1.7) * 0.05
      const base = 0.42 * (1 - i / (run.trailCount + 2))
      mesh.scale.setScalar(Math.max(base * (0.6 + 0.5 * (1 - i / run.trailCount)) + wobble * 0.1, 0.04))
      mesh.rotation.z = wobble * 2
      const material = mesh.material as MeshBasicMaterial
      material.opacity = 0.55 * (1 - i / run.trailCount) ** 1.2
    }

    // 火球本体：呼吸 + 自转
    const spin = elapsed * 3.4
    run.ringA.rotation.set(Math.PI / 2 + Math.sin(spin * 0.7) * 0.5, spin, spin * 0.4)
    run.ringB.rotation.set(1.1 + Math.cos(spin * 0.5) * 0.4, spin * -0.8, spin * 0.3)
    const pulse = 1 + Math.sin(elapsed * 12) * 0.06
    run.halo.scale.setScalar(0.86 * pulse)
    run.core.scale.setScalar(0.27 * (1 + Math.sin(elapsed * 17) * 0.12))
  }

  /** 把头部放到飞行进度 `t` 对应的位置上（二次曲线，最高拱起 ARC_HEIGHT）。 */
  private placeHead(run: FireballRun, t: number): void {
    const clamped = clamp(t, 0, 1)
    run.head.position.lerpVectors(run.from, run.to, clamped)
    run.head.position.y += ARC_HEIGHT * 4 * clamped * (1 - clamped)
  }

  /** 命中：建爆炸元素并开始播放。 */
  private updateExplosion(run: FireballRun, dt: number): void {
    if (!run.burst) run.burst = this.createBurst(run)
    const burst = run.burst
    const t = clamp(run.time / EXPLOSION_TIME, 0, 1)

    // bugv11 追加 #4：火球砸到棋盘上要**立刻**消失 ——
    // 熔岩球本体当场隐掉，光晕 / 白炽核心 0.08 秒内让位给爆炸；
    // 彗尾（12 片拖尾）0.22 秒内散掉，不再定格在棋盘上等爆炸播完。
    run.body.visible = false
    const handover = 1 - clamp(run.time / 0.08, 0, 1)
    run.halo.scale.setScalar(0.86 * (1 + (1 - handover) * 2.6))
    ;(run.halo.material as MeshBasicMaterial).opacity = 0.45 * handover
    ;(run.core.material as MeshBasicMaterial).opacity = 0.95 * handover
    run.ringA.rotation.z += dt * 9
    run.ringB.rotation.y -= dt * 7

    const trailFade = 1 - clamp(run.time / 0.22, 0, 1)
    for (let i = 0; i < run.trail.length; i++) {
      const mesh = run.trail[i]
      if (trailFade <= 0) {
        mesh.visible = false
        continue
      }
      ;(mesh.material as MeshBasicMaterial).opacity = 0.55 * trailFade * (1 - i / run.trailCount) ** 1.2
      mesh.scale.multiplyScalar(1 - Math.min(dt * 5, 0.5))
    }

    // 闪光球：迅速胀大再收淡
    const flashT = clamp(t / 0.42, 0, 1)
    burst.flash.scale.setScalar(0.4 + 3.1 * Math.sqrt(flashT))
    ;(burst.flash.material as MeshBasicMaterial).opacity = 1 - flashT

    // 三层扩散环，速度不同
    const ringSpeeds = [7.4, 5.2, 3.4]
    const ringLife = [0.5, 0.7, 0.9]
    for (let i = 0; i < burst.rings.length; i++) {
      const mesh = burst.rings[i]
      const local = clamp(run.time / ringLife[i], 0, 1)
      const radius = 0.35 + ringSpeeds[i] * local
      mesh.scale.setScalar(Math.max(radius, 0.01))
      ;(mesh.material as MeshBasicMaterial).opacity = 0.7 * (1 - local) ** 1.4
    }

    // 火星迸射：向外飞散 + 一点重力
    for (let i = 0; i < burst.embers.length; i++) {
      const mesh = burst.embers[i]
      const life = clamp(run.time / burst.emberSpeeds[i], 0, 1)
      const velocity = burst.emberVelocities[i]
      const eased = 1 - (1 - life) ** 2
      mesh.position.copy(velocity).multiplyScalar(eased * 2.4)
      mesh.position.y -= 1.4 * life * life
      mesh.rotation.z = burst.emberAngles[i] + run.time * 5
      const size = Math.max((0.14 + 0.05 * (1 - life)) * (1 - life) * 1.4, 0.001)
      mesh.scale.setScalar(size)
      ;(mesh.material as MeshBasicMaterial).opacity = 0.95 * (1 - life) ** 1.3
    }
  }

  /** 生成命中爆炸所需的全部 mesh（一次性）。 */
  private createBurst(run: FireballRun): BurstRecord {
    const origin = run.to
    const palette = run.palette
    const flash = new Mesh(
      this.haloGeometry,
      new MeshBasicMaterial({
        map: this.glowTexture,
        color: palette.flash,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    )
    flash.position.copy(origin)
    flash.scale.setScalar(0.4)
    this.group.add(flash)

    const rings: Mesh[] = []
    const ringColors = [palette.hot, palette.yellow, palette.orange]
    for (let i = 0; i < 3; i++) {
      const mesh = new Mesh(
        this.ringGeometry,
        new MeshBasicMaterial({
          color: ringColors[i],
          transparent: true,
          opacity: 0.7,
          depthWrite: false,
          blending: AdditiveBlending,
        }),
      )
      mesh.position.copy(origin)
      // 与棋盘面贴合（平躺），保证俯视角能看到
      mesh.rotation.set(Math.PI / 2, 0, 0)
      mesh.scale.setScalar(0.35)
      mesh.renderOrder = 7
      this.group.add(mesh)
      rings.push(mesh)
    }

    const embers: Mesh[] = []
    const emberVelocities: Vector3[] = []
    const emberAngles: number[] = []
    const emberSpeeds: number[] = []
    const emberColors = [palette.hot, palette.yellow, palette.orange, palette.deep]
    const emberColor = new Color()
    const emberCount = 14
    for (let i = 0; i < emberCount; i++) {
      const azimuth = (i / emberCount) * Math.PI * 2 + Math.random() * 0.5
      const lift = 0.35 + Math.random() * 1.1
      const spread = 0.5 + Math.random() * 0.9
      emberColor.setHex(emberColors[i % emberColors.length])
      const mesh = new Mesh(
        this.emberGeometry,
        new MeshBasicMaterial({
          map: this.glowTexture,
          color: emberColor.getHex(),
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
          blending: AdditiveBlending,
        }),
      )
      mesh.position.copy(origin)
      mesh.renderOrder = 8
      this.group.add(mesh)
      embers.push(mesh)
      emberVelocities.push(new Vector3(Math.cos(azimuth) * spread, lift, Math.sin(azimuth) * spread))
      emberAngles.push(Math.random() * Math.PI * 2)
      emberSpeeds.push(0.5 + Math.random() * 0.4)
    }

    return { flash, rings, embers, emberVelocities, emberAngles, emberSpeeds }
  }

  /** 收尾：把火球与爆炸的元素从场景里摘掉并释放它们的材质。 */
  private finishRun(run: FireballRun): void {
    run.head.removeFromParent()
    this.disposeTree(run.head)
    for (const mesh of run.trail) {
      mesh.removeFromParent()
      this.disposeMaterial(mesh.material)
    }
    run.trail.length = 0
    const burst = run.burst
    if (!burst) return
    for (const mesh of [burst.flash, ...burst.rings, ...burst.embers]) {
      mesh.removeFromParent()
      this.disposeMaterial(mesh.material)
    }
    burst.rings.length = 0
    burst.embers.length = 0
    run.burst = null
  }

  /** 释放一棵子树里所有 mesh 的材质（几何是共享的，不能在这里 dispose）。 */
  private disposeTree(root: Group): void {
    for (const child of root.children) {
      if (child instanceof Mesh) this.disposeMaterial(child.material)
      else if (child instanceof Group) this.disposeTree(child)
    }
    root.clear()
  }

  private disposeMaterial(material: Material | Material[]): void {
    if (Array.isArray(material)) {
      for (const item of material) item.dispose()
      return
    }
    material.dispose()
  }

  // -------------------------------------------------------------------------
  // 销毁
  // -------------------------------------------------------------------------

  /** 释放自己创建的所有几何 / 材质 / 贴图。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.reset()

    const geometries: BufferGeometry[] = [
      this.tongueGeometry,
      this.haloGeometry,
      this.coreGeometry,
      this.trailGeometry,
      this.ringGeometry,
      this.glowDiscGeometry,
      this.emberGeometry,
    ]
    for (const geometry of geometries) geometry.dispose()

    for (const material of [
      ...this.tongueMaterials[0],
      ...this.tongueMaterials[1],
      ...this.emberMaterials,
      ...this.glowMaterials,
      ...this.scorchMaterials,
    ]) {
      material.dispose()
    }
    this.tongueMaterials.length = 0

    this.flameTexture?.dispose()
    this.glowTexture?.dispose()
    this.lavaTexture?.dispose()
    this.templates.length = 0
    this.emberTemplates.length = 0
    this.seeds.clear()
    this.group.removeFromParent()
    this.group.clear()
  }
}
