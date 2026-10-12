/**
 * 特效层：冲击波圆环、连珠发光带、撞击光晕、屏幕闪光，以及**环境光暗场**。
 *
 * 光照设计（见 bugv1.md 第 4 / 8 条）：
 * - 页面默认是亮的，相当于白色环境光；攻击阶段整体压暗；
 * - 只用三盏方向光（主光 / 补光 / 轮廓光），不再有跟随棋子的点光源，
 *   因此不会出现“棋子上有两个明显光源”或在鼠标移动时闪烁。
 */
import {
  AdditiveBlending,
  CanvasTexture,
  CircleGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  PlaneGeometry,
  PointLight,
  RingGeometry,
  ShaderMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type Texture,
} from 'three'
import { CELL_SIZE, cellToWorld } from './board-view'
import { clamp, smoothstep } from './anim'
import { createMagicTexture as createMagicCircleTexture } from './magic-texture'
import type { Palette } from './palette'

interface RingRecord {
  mesh: Mesh
  life: number
  maxLife: number
  from: number
  to: number
  opacity: number
}

interface BurstRecord {
  mesh: Mesh
  life: number
  maxLife: number
  from: number
  to: number
  opacity: number
  angle: number
}

interface SunRecord {
  mesh: Mesh
  life: number
  maxLife: number
  from: number
  to: number
  opacity: number
  spin: number
}

/** 两端收细的针状光带（梭形旋转体）。 */
function createNeedleGeometry(length: number, radius: number): LatheGeometry {
  const steps = 14
  const points: Vector2[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const r = radius * Math.sin(Math.PI * t) ** 0.75
    points.push(new Vector2(Math.max(r, 0.0004), (t - 0.5) * length))
  }
  return new LatheGeometry(points, 16)
}

/**
 * 程序化生成的“太阳”贴图：炽热核心 + 日冕 + 长短相间的光芒。
 *
 * bugv9 #5：原来的光芒是"长短两档、宽度固定、均匀分布"的规整形状，看起来像标准剪影。
 * 现在每一道光束的**长度、张角、起始角度、形状**都各自随机：
 * - 长度在 `0.34 ~ 1.0` 之间连续随机（不再是两档）；
 * - 一半是尖头光锥（带随机张角），另一半是**带弧度的细光束**（quadratic 曲线 + 圆头描边）；
 * - 每道光束的角度还叠一个随机抖动，整体不再是等分角。
 */
function createSunTexture(): Texture | null {
  if (typeof document === 'undefined') return null
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) return null
  const center = size / 2

  // 光芒（画在核心下面）
  const rays = 26 + Math.floor(Math.random() * 12)
  context.translate(center, center)
  context.lineCap = 'round'
  for (let i = 0; i < rays; i++) {
    const angle = (i / rays) * Math.PI * 2 + (Math.random() - 0.5) * ((Math.PI * 2) / rays) * 0.9
    // 长度连续随机：短的 0.34、长的到 1.0，中间连续分布
    const reach = center * (0.34 + Math.random() * 0.66)
    context.save()
    context.rotate(angle)

    if (Math.random() < 0.5) {
      // ① 尖头光锥：张角、长度、亮度都随机
      const spread = reach * (0.02 + Math.random() * 0.075)
      const gradient = context.createLinearGradient(0, 0, reach, 0)
      gradient.addColorStop(0, `rgba(255, 255, 255, ${0.7 + Math.random() * 0.3})`)
      gradient.addColorStop(0.22, `rgba(255, 255, 255, ${0.3 + Math.random() * 0.25})`)
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
      context.fillStyle = gradient
      context.beginPath()
      context.moveTo(0, 0)
      context.lineTo(reach, -spread)
      // 有些光锥带一点弯曲的侧边，看起来像被拉伸的火舌
      context.quadraticCurveTo(reach * 1.05, 0, reach, spread)
      context.closePath()
      context.fill()
    } else {
      // ② 弧形细光束：用二次曲线描边，粗细随机
      const bend = (Math.random() * 2 - 1) * reach * 0.32
      context.strokeStyle = `rgba(255, 255, 255, ${0.35 + Math.random() * 0.5})`
      context.lineWidth = 1.5 + Math.random() * 9
      context.beginPath()
      context.moveTo(0, 0)
      context.quadraticCurveTo(reach * 0.55, bend, reach, bend * 0.7)
      context.stroke()
      // 再叠一条更细更亮的芯
      context.strokeStyle = `rgba(255, 255, 255, ${0.5 + Math.random() * 0.5})`
      context.lineWidth = 0.8 + Math.random() * 2.4
      context.beginPath()
      context.moveTo(0, 0)
      context.quadraticCurveTo(reach * 0.55, bend, reach, bend * 0.7)
      context.stroke()
    }
    context.restore()
  }
  context.setTransform(1, 0, 0, 1, 0, 0)

  // 日冕
  const corona = context.createRadialGradient(center, center, 0, center, center, center * 0.72)
  corona.addColorStop(0, 'rgba(255, 255, 255, 1)')
  corona.addColorStop(0.16, 'rgba(255, 255, 255, 0.85)')
  corona.addColorStop(0.34, 'rgba(255, 255, 255, 0.34)')
  corona.addColorStop(0.62, 'rgba(255, 255, 255, 0.1)')
  corona.addColorStop(1, 'rgba(255, 255, 255, 0)')
  context.fillStyle = corona
  context.fillRect(0, 0, size, size)

  // 几圈薄环，做出镜头光晕的味道
  context.strokeStyle = 'rgba(255, 255, 255, 0.35)'
  context.lineWidth = 3
  for (const scale of [0.3, 0.46]) {
    context.beginPath()
    context.arc(center, center, center * scale, 0, Math.PI * 2)
    context.stroke()
  }

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

/** 程序化生成的“魔法阵”贴图：两个交错的正方形 + 外圈（bugv5 #10 / bugv8 #5）。 */
function createMagicTexture(): Texture | null {
  // bugv9 #2：贴图抽到 magic-texture.ts，供魔力植物的归属标识复用
  return createMagicCircleTexture()
}

/** 程序化生成的“光芒炸裂”贴图：中心光晕 + 放射光条。 */
function createBurstTexture(): Texture | null {
  if (typeof document === 'undefined') return null
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) return null
  const center = size / 2

  const core = context.createRadialGradient(center, center, 0, center, center, center * 0.6)
  core.addColorStop(0, 'rgba(255, 255, 255, 1)')
  core.addColorStop(0.22, 'rgba(255, 255, 255, 0.62)')
  core.addColorStop(0.6, 'rgba(255, 255, 255, 0.16)')
  core.addColorStop(1, 'rgba(255, 255, 255, 0)')
  context.fillStyle = core
  context.fillRect(0, 0, size, size)

  const spokes = 20
  context.translate(center, center)
  for (let i = 0; i < spokes; i++) {
    const long = i % 2 === 0
    const length = center * (long ? 1 : 0.6)
    const spread = length * (long ? 0.075 : 0.05)
    context.save()
    context.rotate((i / spokes) * Math.PI * 2)
    const gradient = context.createLinearGradient(0, 0, length, 0)
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.95)')
    gradient.addColorStop(0.3, 'rgba(255, 255, 255, 0.45)')
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
    context.fillStyle = gradient
    context.beginPath()
    context.moveTo(0, 0)
    context.lineTo(length, -spread)
    context.lineTo(length, spread)
    context.closePath()
    context.fill()
    context.restore()
  }
  context.setTransform(1, 0, 0, 1, 0, 0)

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

interface BeamRecord {
  mesh: Mesh
  life: number
  maxLife: number
  opacity: number
  /** 'out'：直接淡出；'pulse'：先亮起再淡出（连珠提示针）。 */
  shape: 'out' | 'pulse'
}

/** 频谱状圆环的着色器（bugv5 #3）：不平滑的锯齿波纹。 */
const RING_VERTEX_SHADER = /* glsl */ `
uniform float uAmp;
uniform float uSpikes;
uniform float uSeed;
uniform float uTime;
varying float vAngle;
varying float vAcross;

void main() {
  float r = length(position.xy);
  float a = atan(position.y, position.x);
  // 三组正弦叠加：像圆形音乐频谱那样高低起伏、并且持续跳动
  float wave = 0.55
    + 0.30 * sin(a * uSpikes + uSeed + uTime * 2.6)
    + 0.18 * sin(a * uSpikes * 2.3 - uSeed - uTime * 4.1)
    + 0.12 * sin(a * uSpikes * 4.7 + uSeed * 1.7 + uTime * 6.3);
  float scale = 1.0 + uAmp * (wave - 0.55);
  vec3 p = vec3(position.xy * scale, position.z);
  vAngle = a;
  vAcross = (r - 0.4) / 0.1;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`

const RING_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uSpikes;
uniform float uSeed;
uniform float uTime;
varying float vAngle;
varying float vAcross;

void main() {
  float across = clamp(vAcross, 0.0, 1.0);
  // 环中心最亮，两侧收边
  float band = pow(1.0 - abs(across - 0.5) * 2.0, 1.3);
  // 沿圆周的谱线：一亮一暗，随时间推移
  float bars = 0.3 + 0.7 * pow(abs(sin(vAngle * uSpikes * 0.5 + uSeed + uTime * 1.7)), 1.5);
  float alpha = uOpacity * band * bars;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(uColor, alpha);
}
`

interface GlowRecord {
  mesh: Mesh
  life: number
  maxLife: number
  from: number
  to: number
  opacity: number
}

export interface ShockwaveOptions {
  color?: number
  from?: number
  to?: number
  life?: number
  opacity?: number
  /** 圆环是否水平（默认 true，贴合棋盘面）。 */
  flat?: boolean
  /** 锯齿起伏幅度（0 = 平滑圆环）。 */
  jagged?: number
}

/** 闪电从多高的地方落下（bugv34 补充）。 */
const LIGHTNING_TOP = 17

export class EffectsView {
  readonly group = new Group()
  readonly lights = new Group()

  private readonly ambient: HemisphereLight
  private readonly key: DirectionalLight
  private readonly fill: DirectionalLight
  private readonly rim: DirectionalLight

  private readonly rings: RingRecord[] = []
  private readonly ringPool: Mesh[] = []
  private readonly beams: BeamRecord[] = []
  private readonly glows: GlowRecord[] = []
  private readonly glowPool: Mesh[] = []
  /** 光芒炸裂（对撞 / 撞击血条，bugv4 #6）。 */
  private readonly bursts: BurstRecord[] = []
  private readonly burstPool: Mesh[] = []
  private burstTexture: Texture | null = null
  /** 太阳式爆发（bugv5 #8）。 */
  private readonly suns: SunRecord[] = []
  private readonly sunPool: Mesh[] = []
  private sunTexture: Texture | null = null
  /** 魔法阵贴图（悬浮棋子用，bugv5 #10）。 */
  private magicTexture: Texture | null = null
  /** 撞击瞬间的点光：像太阳一样短暂照亮周围。 */
  private readonly sunLight = new PointLight(0xffffff, 0, 10, 2)
  private sunLightLife = 0
  private sunLightMax = 0.34
  private sunLightPeak = 26
  /** 频谱动画用的累计时间。 */
  private elapsed = 0

  private palette: Palette
  private darkTarget = 0
  private darkMix = 0
  private flashLevel = 0
  private flashColor = 0xffffff

  constructor(palette: Palette) {
    this.palette = palette

    // 白色环境光 + 三盏方向光（无点光源）
    this.ambient = new HemisphereLight(palette.ambient, 0xb9c0cf, 1.55)
    this.key = new DirectionalLight(palette.keyLight, 2.35)
    this.key.position.set(-6, 11, 7)
    this.fill = new DirectionalLight(palette.fillLight, 0.75)
    this.fill.position.set(8, 6, -6)
    this.rim = new DirectionalLight(palette.rimLight, 0.55)
    this.rim.position.set(2, 4, -9)
    this.lights.add(this.ambient, this.key, this.fill, this.rim, this.sunLight)
    this.group.add(this.lights)
  }

  // -------------------------------------------------------------------------
  // 冲击波
  // -------------------------------------------------------------------------

  shockwave(position: Vector3, options: ShockwaveOptions = {}): void {
    const mesh = this.ringPool.pop() ?? this.createRingMesh()
    const material = mesh.material as ShaderMaterial
    const opacity = options.opacity ?? 0.85
    material.uniforms.uColor.value.setHex(options.color ?? 0xffffff)
    material.uniforms.uOpacity.value = opacity
    material.uniforms.uSpikes.value = 16 + Math.random() * 14
    material.uniforms.uSeed.value = Math.random() * Math.PI * 2
    material.uniforms.uAmp.value = options.jagged ?? 0.14
    mesh.visible = true
    mesh.position.copy(position)
    if (options.flat === false) {
      mesh.rotation.set(0, Math.PI / 4, Math.random() * Math.PI * 2)
    } else {
      // Euler 顺序 XYZ：先绕自身 z 轴（环所在平面）随机转一下，再躺平到棋盘面。
      // bugv6 #5：谱线朝向随机，不再每个波纹都长一样。
      mesh.rotation.set(-Math.PI / 2, 0, Math.random() * Math.PI * 2)
    }
    mesh.scale.setScalar(options.from ?? 0.25)
    this.group.add(mesh)

    this.rings.push({
      mesh,
      life: 0,
      maxLife: options.life ?? 0.6,
      from: options.from ?? 0.25,
      to: options.to ?? 2.6,
      opacity,
    })
  }

  private createRingMesh(): Mesh {
    return new Mesh(
      new RingGeometry(0.4, 0.5, 128),
      new ShaderMaterial({
        vertexShader: RING_VERTEX_SHADER,
        fragmentShader: RING_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        blending: AdditiveBlending,
        uniforms: {
          uColor: { value: new Color(0xffffff) },
          uOpacity: { value: 0.8 },
          uAmp: { value: 0.14 },
          uSpikes: { value: 20 },
          uSeed: { value: 0 },
          uTime: { value: 0 },
        },
      }),
    )
  }

  // -------------------------------------------------------------------------
  // 连珠发光带 / 提示针
  // -------------------------------------------------------------------------

  /**
   * 沿一条线拉出**两端收细的针状**光带（bugv5 #6）：用旋转体做梭形，
   * 而不是原来那种等粗圆柱。
   */
  private addNeedle(
    from: Vector3,
    to: Vector3,
    color: number,
    options: { radius: number; opacity: number; life: number; shape: 'out' | 'pulse'; lift?: number },
  ): void {
    const direction = to.clone().sub(from)
    const length = direction.length()
    if (length < 0.001) return

    const mesh = new Mesh(
      createNeedleGeometry(length, options.radius),
      new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: options.opacity,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    )
    mesh.position.copy(from).add(to).multiplyScalar(0.5)
    mesh.position.y += options.lift ?? CELL_SIZE * 0.14
    mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize())
    this.group.add(mesh)

    this.beams.push({ mesh, life: 0, maxLife: options.life, opacity: options.opacity, shape: options.shape })
  }

  /** 连珠发光带：细针状，两端收细（bugv5 #6）。 */
  matchBeam(cells: readonly number[], color: number): void {
    if (cells.length < 2) return
    const first = cellToWorld(cells[0], new Vector3())
    const last = cellToWorld(cells[cells.length - 1], new Vector3())
    this.addNeedle(first, last, color, {
      radius: CELL_SIZE * 0.042,
      opacity: 0.9,
      life: 0.6,
      shape: 'out',
    })
  }

  /**
   * bugv29 #4：**黑色光流**（glm「毒鸡蛋」落子时从天而降的那道暗色流）。
   *
   * 复用针状几何，但材质换成**普通混合** —— 加色混合下黑色是完全看不见的，
   * 只有普通混合的深色才能在亮底页面上压出一条"墨流"。
   */
  darkStreak(
    from: Vector3,
    to: Vector3,
    options: { radius?: number; life?: number; color?: number; opacity?: number } = {},
  ): void {
    const direction = to.clone().sub(from)
    const length = direction.length()
    if (length < 0.001) return
    const opacity = options.opacity ?? 0.62
    const mesh = new Mesh(
      createNeedleGeometry(length, options.radius ?? CELL_SIZE * 0.19),
      new MeshBasicMaterial({
        color: options.color ?? 0x150c22,
        transparent: true,
        opacity,
        depthWrite: false,
        blending: NormalBlending,
        side: DoubleSide,
      }),
    )
    mesh.position.copy(from).add(to).multiplyScalar(0.5)
    mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize())
    this.group.add(mesh)
    this.beams.push({ mesh, life: 0, maxLife: options.life ?? 0.55, opacity, shape: 'out' })
  }

  /**
   * bugv34m：**发光光流**（Qwen「小千问」自动落子时从天而降的那道特征色流光）。
   *
   * 与 `darkStreak` 的区别只在混合方式：光流要"发光"→ 用加色混合（`addNeedle`），
   * 暗流要"压暗"→ 用普通混合。两者都复用针状几何。
   */
  lightStreak(
    from: Vector3,
    to: Vector3,
    color: number,
    options: { radius?: number; life?: number; opacity?: number } = {},
  ): void {
    this.addNeedle(from, to, color, {
      radius: options.radius ?? CELL_SIZE * 0.14,
      opacity: options.opacity ?? 0.45,
      life: options.life ?? 0.3,
      shape: 'pulse',
    })
  }

  /**
   * 连珠提示针（bugv5 #7）：从落点沿某个方向拉一条很长的针状线，
   * 提示"再补一颗就能成线"。
   *
   * bugv9 #3：`gap` 是"需要补上去的那一格"。提示针改以「落点 + 空位」的中点为轴，
   * 并在空位上单独点一圈光环 —— 这样"2 + 1 中间空一格"时能一眼看出补哪里。
   */
  threatHint(
    cell: number,
    dir: readonly [number, number],
    color: number,
    options: { gap?: number; cells?: number } = {},
  ): void {
    const length = options.cells ?? 13
    const center = cellToWorld(cell, new Vector3())
    if (options.gap !== undefined) {
      center.add(cellToWorld(options.gap, new Vector3())).multiplyScalar(0.5)
    }
    const half = (length * CELL_SIZE) / 2
    const offset = new Vector3(dir[1] * half, 0, dir[0] * half)
    this.addNeedle(center.clone().sub(offset), center.clone().add(offset), color, {
      radius: CELL_SIZE * 0.05,
      opacity: 0.75,
      life: 1.25,
      shape: 'pulse',
    })
    // 落点再叠一圈频谱光环，强调"这一颗很关键"
    this.shockwave(center, { color, from: 0.25, to: 2.2, life: 0.9, opacity: 0.4, jagged: 0.2 })
    if (options.gap === undefined) return
    // 需要补的那一格：更大的双环 + 一根短针，指向"就下这里"
    const target = cellToWorld(options.gap, new Vector3())
    this.shockwave(target, { color, from: 0.2, to: 1.6, life: 1.05, opacity: 0.5, jagged: 0.12 })
    this.shockwave(target, { color: 0xffffff, from: 0.5, to: 0.95, life: 0.7, opacity: 0.3 })
    this.impactGlow(target, color, 0.9)
  }

  // -------------------------------------------------------------------------
  // 闪电（雷暴天气，bugv34 补充）
  // -------------------------------------------------------------------------

  /**
   * 闪电从天而降，落在指定的棋盘格上。
   *
   * 由几段带横向抖动的"针"拼出一条锯齿状雷柱（从高空一直劈到格子），
   * 落点再补一圈强光 + 冲击波 + 太阳式爆发 + 全屏闪光。
   */
  lightningStrike(position: Vector3, color = 0xbfd4ff): void {
    const top = position.clone()
    top.y += LIGHTNING_TOP
    const segments = 4
    let prev = top
    for (let i = 1; i <= segments; i += 1) {
      const t = i / segments
      const spread = CELL_SIZE * 1.5 * (1 - t)
      const next = new Vector3(
        position.x + (i === segments ? 0 : (Math.random() - 0.5) * spread),
        position.y + LIGHTNING_TOP * (1 - t),
        position.z + (i === segments ? 0 : (Math.random() - 0.5) * spread),
      )
      this.addNeedle(prev, next, color, {
        radius: CELL_SIZE * 0.038,
        opacity: 0.95,
        life: 0.4,
        shape: 'out',
      })
      prev = next
    }
    this.impactGlow(position, 0xffffff, 1.4)
    this.shockwave(position, { color, from: 0.2, to: 2.8, life: 0.5, opacity: 0.6, jagged: 0.22 })
    this.sunburst(position, color, 2.2)
    this.flash(0.3, color)
  }

  // -------------------------------------------------------------------------
  // 撞击光晕（面向相机）
  // -------------------------------------------------------------------------

  impactGlow(position: Vector3, color: number, size = 1.6): void {
    const mesh = this.glowPool.pop() ?? this.createGlowMesh()
    const material = mesh.material as MeshBasicMaterial
    material.color.setHex(color)
    material.opacity = 0.6
    mesh.visible = true
    mesh.position.copy(position)
    mesh.scale.setScalar(size)
    this.group.add(mesh)
    this.glows.push({ mesh, life: 0, maxLife: 0.42, from: size, to: size * 1.9, opacity: 0.6 })
  }

  private createGlowMesh(): Mesh {
    return new Mesh(
      new CircleGeometry(0.5, 48),
      new MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
      }),
    )
  }

  // -------------------------------------------------------------------------
  // 光芒炸裂（bugv4 #6）
  // -------------------------------------------------------------------------

  /**
   * 放射状光芒炸裂：面向相机的加色贴片，短时间内从小到大炸开。
   * 用于对撞抵消与棋子撞击血条，配合粒子爆发一起使用。
   */
  starburst(position: Vector3, color: number, size = 1.6): void {
    const mesh = this.burstPool.pop() ?? this.createBurstMesh()
    if (!mesh) return
    const material = mesh.material as MeshBasicMaterial
    material.color.setHex(color)
    material.opacity = 0.95
    mesh.visible = true
    mesh.position.copy(position)
    mesh.scale.setScalar(size * 0.45)
    this.group.add(mesh)
    this.bursts.push({
      mesh,
      life: 0,
      maxLife: 0.52,
      from: size * 0.45,
      to: size * 3.6,
      opacity: 0.95,
      angle: Math.random() * Math.PI * 2,
    })
  }

  private createBurstMesh(): Mesh | null {
    if (!this.burstTexture) this.burstTexture = createBurstTexture()
    if (!this.burstTexture) return null
    return new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({
        map: this.burstTexture,
        color: 0xffffff,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        depthTest: false,
        blending: AdditiveBlending,
      }),
    )
  }

  // -------------------------------------------------------------------------
  // 太阳式爆发（bugv5 #8）
  // -------------------------------------------------------------------------

  /**
   * 两颗棋子相撞时炸出的“太阳”：炽热核心 + 日冕 + 长短相间的光芒，
   * 同时点亮一盏瞬时点光，把周围的棋子也照亮一下。
   */
  sunburst(position: Vector3, color: number, size = 2.4): void {
    const mesh = this.sunPool.pop() ?? this.createSunMesh()
    if (mesh) {
      const material = mesh.material as MeshBasicMaterial
      material.color.setHex(color)
      material.opacity = 1
      mesh.visible = true
      mesh.position.copy(position)
      mesh.scale.setScalar(size * 0.35)
      this.group.add(mesh)
      this.suns.push({
        mesh,
        life: 0,
        maxLife: 0.78,
        from: size * 0.35,
        to: size * 2.7,
        opacity: 1,
        spin: 0.5 + Math.random() * 0.5,
      })
    }

    this.sunLight.position.copy(position)
    this.sunLight.color.setHex(color)
    this.sunLightPeak = 30
    this.sunLightMax = 0.36
    this.sunLightLife = this.sunLightMax
    this.sunLight.intensity = 0
  }

  private createSunMesh(): Mesh | null {
    if (!this.sunTexture) this.sunTexture = createSunTexture()
    if (!this.sunTexture) return null
    return new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({
        map: this.sunTexture,
        color: 0xffffff,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        depthTest: false,
        blending: AdditiveBlending,
      }),
    )
  }

  /** 悬浮棋子的“魔法阵”贴图（两个交错正方形，bugv5 #10）。 */
  createMagicMesh(owner: 0 | 1, size: number): Mesh | null {
    if (!this.magicTexture) this.magicTexture = createMagicTexture()
    if (!this.magicTexture) return null
    const mesh = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({
        map: this.magicTexture,
        // bugv9 #12：魔法阵的颜色完全由该方的特征色决定（贴图本身是白色，
        // 这里用材质 color 相乘），换了特征色 / 选了角色之后必须跟着变
        color: this.palette.sides[owner].color,
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
        depthTest: false,
        blending: AdditiveBlending,
      }),
    )
    mesh.scale.setScalar(size)
    mesh.renderOrder = 9
    mesh.userData.magicOwner = owner
    return mesh
  }

  /** 运行中切换配色时同步魔法阵颜色。 */
  recolorMagic(mesh: Mesh, owner: 0 | 1): void {
    ;(mesh.material as MeshBasicMaterial).color.setHex(this.palette.sides[owner].color)
  }

  /** 运行中更新配色（bugv9 #12：魔法阵要跟着特征色走）。 */
  setPalette(palette: Palette): void {
    this.palette = palette
  }

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  /** 屏幕闪光叠加（对撞 / 致命一击）：实际由全屏闪光平面绘制（ScreenFlash）。 */
  flash(strength = 0.6, color = 0xffffff): void {
    this.flashLevel = clamp(Math.max(this.flashLevel, strength), 0, 1)
    this.flashColor = color
  }

  /** 攻击阶段暗场（规则 4.1.6）。 */
  setDark(active: boolean): void {
    this.darkTarget = active ? 1 : 0
  }

  get flashAmount(): number {
    return this.flashLevel
  }

  get color(): number {
    return this.flashColor
  }

  get darkAmount(): number {
    return this.darkMix
  }

  // -------------------------------------------------------------------------
  // 循环
  // -------------------------------------------------------------------------

  /** 由 SceneController 注入：让光晕面向相机。 */
  onBillboard: ((mesh: Mesh) => void) | null = null

  update(dt: number): void {
    this.elapsed += dt
    // 暗场：整体光照压暗（只用于攻击阶段；黑夜的"场地变暗"改由页面级 CSS 压暗层实现，
    // 这样 3D 光源保持中性 ⇒ 棋子外观完全不变）
    this.darkMix = clamp(this.darkMix + (this.darkTarget - this.darkMix) * Math.min(dt * 3.4, 1), 0, 1)
    const factor = 1 - (1 - this.palette.darkFactor) * this.darkMix
    this.ambient.intensity = 1.55 * factor
    this.key.intensity = 2.35 * factor
    this.fill.intensity = 0.75 * factor
    this.rim.intensity = 0.55 * factor

    // 撞击瞬间的点光（像太阳一样照亮周围，很快就衰减掉）
    if (this.sunLightLife > 0) {
      this.sunLightLife = Math.max(0, this.sunLightLife - dt)
      const t = this.sunLightLife / this.sunLightMax
      this.sunLight.intensity = this.sunLightPeak * t * t
      if (this.sunLightLife === 0) this.sunLight.intensity = 0
    }

    // 光芒炸裂（太阳）整体缓慢转动
    for (const sun of this.suns) {
      sun.life += dt
      const t = clamp(sun.life / sun.maxLife, 0, 1)
      ;(sun.mesh.material as MeshBasicMaterial).opacity = sun.opacity * (1 - t) ** 1.5
      sun.mesh.scale.setScalar(sun.from + (sun.to - sun.from) * (1 - (1 - t) ** 2.4))
      this.onBillboard?.(sun.mesh)
      sun.mesh.rotateZ(sun.spin * dt)
      if (t >= 1) {
        sun.mesh.removeFromParent()
        sun.mesh.visible = false
        this.sunPool.push(sun.mesh)
        this.suns.splice(this.suns.indexOf(sun), 1)
      }
    }

    this.flashLevel = Math.max(0, this.flashLevel - dt * 2.2)

    // 冲击波（频谱状圆环，bugv5 #3）
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i]
      ring.life += dt
      const t = clamp(ring.life / ring.maxLife, 0, 1)
      ring.mesh.scale.setScalar(ring.from + (ring.to - ring.from) * (1 - (1 - t) ** 3))
      const material = ring.mesh.material as ShaderMaterial
      material.uniforms.uOpacity.value = ring.opacity * (1 - t) ** 2
      material.uniforms.uTime.value = this.elapsed
      if (t >= 1) {
        ring.mesh.removeFromParent()
        ring.mesh.visible = false
        this.ringPool.push(ring.mesh)
        this.rings.splice(i, 1)
      }
    }

    // 发光带 / 提示针（bugv6 #7：淡入淡出都用 smoothstep，收尾不再“啪”地消失）
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const beam = this.beams[i]
      beam.life += dt
      const t = clamp(beam.life / beam.maxLife, 0, 1)
      const fadeIn = smoothstep(0, 0.1, t)
      const outStart = beam.shape === 'pulse' ? 0.5 : 0.32
      const fadeOut = 1 - smoothstep(outStart, 1, t)
      const fade = fadeIn * fadeOut
      const material = beam.mesh.material as MeshBasicMaterial
      material.opacity = beam.opacity * fade
      // 余晖渐弱的同时把针收成一根更细的丝，避免直接闪断
      const taper = 0.34 + 0.66 * fade
      beam.mesh.scale.set(taper, 1, taper)
      if (t >= 1) {
        beam.mesh.removeFromParent()
        beam.mesh.geometry.dispose()
        material.dispose()
        this.beams.splice(i, 1)
      }
    }

    // 撞击光晕
    for (let i = this.glows.length - 1; i >= 0; i--) {
      const glow = this.glows[i]
      glow.life += dt
      const t = clamp(glow.life / glow.maxLife, 0, 1)
      ;(glow.mesh.material as MeshBasicMaterial).opacity = glow.opacity * (1 - t)
      glow.mesh.scale.setScalar(glow.from + (glow.to - glow.from) * t)
      this.onBillboard?.(glow.mesh)
      if (t >= 1) {
        glow.mesh.removeFromParent()
        glow.mesh.visible = false
        this.glowPool.push(glow.mesh)
        this.glows.splice(i, 1)
      }
    }

    // 光芒炸裂
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const burst = this.bursts[i]
      burst.life += dt
      const t = clamp(burst.life / burst.maxLife, 0, 1)
      ;(burst.mesh.material as MeshBasicMaterial).opacity = burst.opacity * (1 - t) ** 1.6
      burst.mesh.scale.setScalar(burst.from + (burst.to - burst.from) * (1 - (1 - t) ** 3))
      this.onBillboard?.(burst.mesh)
      burst.mesh.rotateZ(burst.angle - burst.mesh.rotation.z)
      if (t >= 1) {
        burst.mesh.removeFromParent()
        burst.mesh.visible = false
        this.burstPool.push(burst.mesh)
        this.bursts.splice(i, 1)
      }
    }
  }

  /** 高光脉冲：在指定交点上叠一圈扩散光环。 */
  highlightPulse(cells: readonly number[], color: number): void {
    for (const cell of cells) {
      const position = cellToWorld(cell, new Vector3())
      position.y += CELL_SIZE * 0.05
      this.shockwave(position, { color, from: 0.3, to: 1.5, life: 0.55, opacity: 0.45 })
    }
  }

  reset(): void {
    for (const ring of this.rings) {
      ring.mesh.removeFromParent()
      this.ringPool.push(ring.mesh)
    }
    this.rings.length = 0
    for (const beam of this.beams) {
      beam.mesh.removeFromParent()
      beam.mesh.geometry.dispose()
      ;(beam.mesh.material as MeshBasicMaterial).dispose()
    }
    this.beams.length = 0
    for (const glow of this.glows) {
      glow.mesh.removeFromParent()
      this.glowPool.push(glow.mesh)
    }
    this.glows.length = 0
    for (const burst of this.bursts) {
      burst.mesh.removeFromParent()
      this.burstPool.push(burst.mesh)
    }
    this.bursts.length = 0
    for (const sun of this.suns) {
      sun.mesh.removeFromParent()
      this.sunPool.push(sun.mesh)
    }
    this.suns.length = 0
    this.sunLightLife = 0
    this.sunLight.intensity = 0
    this.darkTarget = 0
    this.darkMix = 0
    this.flashLevel = 0
  }

  dispose(): void {
    this.reset()
    for (const mesh of this.ringPool) {
      mesh.geometry.dispose()
      ;(mesh.material as MeshBasicMaterial).dispose()
    }
    this.ringPool.length = 0
    for (const mesh of this.glowPool) {
      mesh.geometry.dispose()
      ;(mesh.material as MeshBasicMaterial).dispose()
    }
    this.glowPool.length = 0
    for (const mesh of this.burstPool) {
      mesh.geometry.dispose()
      ;(mesh.material as MeshBasicMaterial).dispose()
    }
    this.burstPool.length = 0
    this.burstTexture?.dispose()
    this.burstTexture = null
    for (const mesh of this.sunPool) {
      mesh.geometry.dispose()
      ;(mesh.material as MeshBasicMaterial).dispose()
    }
    this.sunPool.length = 0
    this.sunTexture?.dispose()
    this.sunTexture = null
    this.magicTexture?.dispose()
    this.magicTexture = null
  }
}

/** 把颜色按比例调亮 / 调暗。 */
export function shade(color: number, amount: number): number {
  return new Color(color).multiplyScalar(amount).getHex()
}
