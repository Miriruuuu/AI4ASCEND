/**
 * 表现层总控：three.js 场景 + 事件动画编排。
 *
 * 与业务层（core）完全解耦：只消费 `GameEvent`，只暴露动画 API。
 *
 * 关键设计（见 bugv1.md / bugv2.md / bugv3.md）：
 * - 画布**完全透明**（alpha:0），棋盘直接呈现在页面背景上，没有画布边界与背景圆盘；
 * - 不使用点光源，只用方向光 + 半球光，避免棋子出现“两个明显光源”和鼠标移动时闪烁；
 * - 棋子落在**交叉点**上，本体是黑白棋子，红蓝只作为特征色（bugv3 #8）；
 * - 攻击阶段：连珠棋子飞到**自己那一侧、贴近屏幕边缘**的空中舞台悬停（bugv3 #1 / #4），
 *   舞台锚点用 NDC 屏幕坐标换算，任何画幅都在画面内且贴着边；
 * - 对撞只在中央发生“参与对撞的那一对”，其余棋子始终留在自己那一侧（bugv3 #1）；
 * - 场地光照变暗时，悬浮棋子、对撞特效与血条**不被压暗**（bugv3 #2）；
 * - 悬浮位置附近显示发光的总攻击数（bugv3 #6）。
 */
import {
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  SRGBColorSpace,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { BOARD_SIZE, other, type GameEvent, type MagicKind, type PlayerIndex } from '../core/types'
import { Animator, Easing } from './anim'
import { SoundEngine, type SoundName } from './audio'
import { BoardView, CELL_SIZE, cellToWorld, worldToCell } from './board-view'
import { CameraRig } from './camera-rig'
import { EffectsView } from './effects-view'
import { MagicView } from './magic-view'
import { FlameView, firePalette } from './flame-view'
import { DEFAULT_PALETTE, type Palette } from './palette'
import { ParticleSystem } from './particles'
import { PIECE_HEIGHT, PIECE_RADIUS, PiecesView } from './pieces-view'
import { FullScreenRipple, ScreenFlash } from './ripple'

export interface SceneHooks {
  /** 某个事件对应的模型已经可以安全提交。 */
  onApply: (event: GameEvent) => void
  /** 每一颗棋子撞击血条时触发（用于推进血条数字与抖动）。 */
  onImpact: (player: PlayerIndex, index: number) => void
  /** 一次对撞发生。 */
  onClash: (index: number) => void
  /** 对局结束动画播完。 */
  onGameOver: () => void
  /** 棋盘格被点击（仅允许落子时触发）。 */
  onCellPick: (cell: number) => void
  /** 悬停格变化（null 表示离开棋盘）。 */
  onHover: (cell: number | null) => void
  /** WebGL 上下文丢失。 */
  onRendererLost: () => void
  /** 暗场状态变化（宿主据此压暗页面）。 */
  onDarkChange: (dark: boolean) => void
  /** 播放音效（宿主可接管 / 静音）。 */
  onSound: (name: SoundName, variant: number) => void
}

export interface SceneOptions extends Partial<SceneHooks> {
  canvas: HTMLCanvasElement
  container?: HTMLElement
  palette?: Palette
  /** 视差强度。 */
  parallax?: number
  /** 是否启用程序化音效。 */
  sound?: boolean
}

interface SideHudRects {
  0?: DOMRect
  1?: DOMRect
}

interface SideElements {
  0?: HTMLElement
  1?: HTMLElement
}

/** 舞台上的棋子状态。 */
interface StagedPiece {
  mesh: Mesh
  owner: PlayerIndex
  spinAxis: Vector3
  spinSpeed: number
  bobPhase: number
  base: Vector3
  /** 悬浮时脚下旋转的“魔法阵”（bugv5 #10）。 */
  magic: Mesh | null
}

/**
 * 攻击舞台：**贴着屏幕左右边缘**（bugv3 #1 / #4）。
 *
 * 这里用归一化屏幕坐标（NDC）描述位置，再换算到世界坐标，
 * 因此不受画幅宽高比影响：宽屏时贴着左右边，窄屏也不会飞出画面。
 * player 0 永远在屏幕左侧、player 1 在右侧，与顶部血条的左右位置一致。
 */
const STAGE_NDC_X = 0.88
const STAGE_NDC_X_STEP = 0.085
const STAGE_NDC_Y = 0.56
const STAGE_NDC_Y_STEP = 0.14
/** 每列排几颗，超过就换一列（更靠画面中间一点）。 */
const STAGE_ROWS = 4
/**
 * 悬浮棋子的随机散布（bugv8 #5）：按 (owner, index) 派生的确定性抖动。
 *
 * 用确定性而不是 `Math.random()`，否则每帧重算会让棋子自己抖起来；
 * 这样每个位置在一局内固定，但整体不再是一条直线 / 一个方阵。
 */
function stageJitter(owner: PlayerIndex, index: number): { x: number; y: number; z: number } {
  const hash = (salt: number): number => {
    let value = (owner * 73856093) ^ (index * 19349663) ^ (salt * 83492791)
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return (((value ^ (value >>> 14)) >>> 0) / 4294967296) * 2 - 1
  }
  return { x: hash(11), y: hash(29), z: hash(47) }
}
/** 舞台景深：相对取景距离的比例（略靠近相机，保证悬浮棋子在最前层）。 */
const STAGE_DEPTH = 0.9
/** 总攻击数数字的位置（NDC），紧邻悬浮棋子一列。 */
const TALLY_NDC_X = 0.68
const TALLY_NDC_Y = 0.34
const TALLY_NDC_Y_STEP = 0.16
/** 对撞点高度（旧实现，保留作为基准值）。 */
const CLASH_HEIGHT = 1.55
/**
 * 对撞点的随机浮动（bugv9 #1）。
 *
 * 原来的对撞点固定在 `(0, CLASH_HEIGHT, 0.2)`，每局都撞在同一个地方。
 * 现在用 NDC 描述一块「屏幕中间」的随机区域：左右 ±0.26，
 * 上下围绕基准高度（把 CLASH_HEIGHT 投影成 NDC 得到）±0.2。
 */
const CLASH_NDC_X_RANGE = 0.26
const CLASH_NDC_Y_RANGE = 0.2
const CLASH_BASE_POINT = new Vector3(0, CLASH_HEIGHT, 0.2)
/** 弧线轨道的横向偏移范围与抬升范围（bugv9 #1）。 */
const CLASH_ARC_SIDE = 1.15
const CLASH_ARC_LIFT_MIN = 0.5
const CLASH_ARC_LIFT_RANGE = 1.3
/**
 * 动作速度系数（bugv3 #3 + bugv4 #7）：
 * 对撞 / 撞血条先加速 50%，再减慢 30% —— 净效果是原始时长 ×0.952。
 */
const ACTION_SCALE = (1 / 1.5) / 0.7
/** 悬浮自由翻转速度：bugv3 #4 +50%，bugv4 #7 再 +50%。 */
const SPIN_UP = 1.5 * 1.5
/**
 * 抵消阶段双方棋子入位的位置（bugv4 #8）：
 * 棋盘网格在 x = ±4.34 结束，这里取 ±4.9 —— 紧贴棋盘左右两侧，
 * 明显比"贴着屏幕边缘"的悬浮位置（世界 x ≈ ±5.5）更靠内。
 */
const GATHER_X = CELL_SIZE * 4.9
const GATHER_Y = 1.7
/** 入位动画时长（bugv4 #8 指定 1.5 秒）。 */
const GATHER_DURATION = 1.5
/** 落子后棋盘短暂倾斜的峰值角度（弧度）与时长（bugv4 #4）。 */
const PLACE_TILT = 0.085
const PLACE_TILT_DURATION = 0.85
/** 落子动画时长（bugv4 #5：不再下落，只做一个很短的“弹一下”）。 */
const PLACE_DURATION = 0.3
/** 结束爆炸动画时长（秒，bugv9 #11）。 */
export const GAME_OVER_FLIGHT_SECONDS = 1.35

export class SceneController {
  readonly scene = new Scene()
  readonly rig: CameraRig
  readonly board: BoardView
  readonly pieces: PiecesView
  readonly effects: EffectsView
  readonly particles: ParticleSystem
  /** 魔力植物（bugv8 #4）。 */
  readonly magic: MagicView
  /** 烈焰与火球（bugv10 #9 恶龙吐息）。 */
  readonly flames = new FlameView()

  private readonly canvas: HTMLCanvasElement
  private readonly container: HTMLElement
  private palette: Palette
  private readonly renderer: WebGLRenderer
  private readonly raycaster = new Raycaster()
  private readonly pointer = new Vector2()
  private readonly animator = new Animator()
  private readonly tiltGroup = new Group()
  private readonly hooks: Partial<SceneHooks>
  private readonly clock = { last: 0, time: 0 }
  /** 程序化音效（也可由宿主通过 onSound 接管）。 */
  readonly audio = new SoundEngine()
  private readonly ripple = new FullScreenRipple()
  private readonly screenFlash = new ScreenFlash()

  private rafId = 0
  private hoverCell: number | null = null
  private hoverColor = 0x1b1e26
  private interactive = true
  private disposed = false
  private staged: StagedPiece[] = []
  /** 正在攻击舞台上飞行的棋子：原棋盘格 -> 舞台棋子（对账时跳过，避免被误回收）。 */
  private stagedByCell = new Map<number, StagedPiece>()
  private hudRects: SideHudRects = {}
  /** 技能槽的屏幕位置（bugv10 #9：额外攻击棋子从技能槽飞出）。 */
  private skillRects: SideHudRects = {}
  /** 是否处于"选目标格"模式（恶龙吐息）。 */
  private targeting = false
  /**
   * 最近一次火球的落点（bugv11 追加 #4）。
   *
   * 烈焰点燃时按"离落点几圈"由内到外逐圈烧起来，这个落点由 `animateSkill` 写入。
   */
  private flameOrigin: number | null = null
  /** 总攻击数数字（宿主给出的 DOM 元素，位置每帧由这里贴到舞台边上）。 */
  private tallyElements: SideElements = {}
  private readonly tallyVisible: [boolean, boolean] = [false, false]
  private readonly tmpVec = new Vector3()
  private playing = false
  private darkActive = false
  private idle = true
  private idleAngle = 0
  /** 落子后的短暂棋盘倾斜（bugv4 #4）：叠加在鼠标视差之上，随后自行回正。 */
  private readonly placeTilt = { x: 0, z: 0 }
  /** 高光权重（由宿主在攻击开始前注入，多重连珠交点更亮）。 */
  private pendingWeights = new Map<number, number>()
  /**
   * 上一步落子标记（bugv28 #2）：对手上一回合未成线的落子高亮。
   *
   * 存下来是为了在**换角色 / 换色**后仍能按新特征色重绘（见 `setPalette`）。
   */
  private lastMark: { cell: number; owner: PlayerIndex } | null = null
  /** 最近一次对撞点的世界坐标与 NDC 坐标（bugv9 #1 验证用）。 */
  lastClashPoint: [number, number, number] | null = null
  lastClashNdc: [number, number] | null = null
  /** 最近一次对撞双方各自的飞行轨道（起点 / 中点 / 终点）。 */
  lastClashTrack: {
    left: { from: [number, number, number]; mid: [number, number, number]; to: [number, number, number] }
    right: { from: [number, number, number]; mid: [number, number, number]; to: [number, number, number] }
  } | null = null

  constructor(options: SceneOptions) {
    this.canvas = options.canvas
    this.container = options.container ?? options.canvas.parentElement ?? document.body
    this.palette = options.palette ?? DEFAULT_PALETTE
    this.hooks = options

    this.rig = new CameraRig({ parallax: options.parallax ?? 1 })
    this.board = new BoardView(this.palette)
    this.pieces = new PiecesView(this.palette)
    this.effects = new EffectsView(this.palette)
    this.particles = new ParticleSystem(1400)
    this.magic = new MagicView(this.palette)

    // 植物长在棋盘上，跟着棋盘一起倾斜
    this.tiltGroup.add(this.board.group, this.pieces.group, this.magic.group, this.flames.group)
    // 舞台棋子**不跟随**棋盘做鼠标偏移 / 旋转，屏幕边缘的悬浮位置才稳定（bugv3 #1 / #4）
    this.scene.add(
      this.tiltGroup,
      this.pieces.stageGroup,
      this.effects.group,
      this.particles.points,
      this.ripple.mesh,
      this.screenFlash.mesh,
    )

    this.effects.onBillboard = (mesh) => mesh.quaternion.copy(this.rig.camera.quaternion)
    this.audio.setEnabled(options.sound !== false)

    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      // 透明画布：棋盘直接落在页面背景上
      alpha: true,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
    })
    this.renderer.setClearColor(new Color(0x000000), 0)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.outputColorSpace = SRGBColorSpace

    this.canvas.addEventListener('webglcontextlost', this.handleContextLost, false)
    this.resize()
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault()
    this.stop()
    this.hooks.onRendererLost?.()
  }

  private size(): { width: number; height: number; dpr: number } {
    const rect = this.container.getBoundingClientRect()
    const width = Math.max(rect.width || this.container.clientWidth || 960, 1)
    const height = Math.max(rect.height || this.container.clientHeight || 640, 1)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    return { width, height, dpr }
  }

  resize(): void {
    const { width, height, dpr } = this.size()
    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(width, height, false)
    this.rig.resize(width, height)
    this.rig.setViewSize(width, height)
  }

  // -------------------------------------------------------------------------
  // bugv26 #2：双指缩放（仅手机端接线）
  // -------------------------------------------------------------------------

  /** 双指手势开始（记住当前倍率当基准）。 */
  beginPinch(): void {
    this.rig.beginPinch()
  }

  /**
   * 双指手势更新。
   *
   * @param scale 两指距离相对手势起点的比值（> 1 放大、< 1 缩小）
   */
  pinchUpdate(scale: number): void {
    this.rig.pinchUpdate(scale)
  }

  /** 回到自动取景（重开一局时调用）。 */
  resetZoom(): void {
    this.rig.setZoom(1)
  }

  // -------------------------------------------------------------------------
  // 循环
  // -------------------------------------------------------------------------

  start(): void {
    if (this.rafId !== 0 || this.disposed) return
    this.clock.last = performance.now() / 1000
    const loop = (): void => {
      if (this.disposed) return
      const now = performance.now() / 1000
      const dt = Math.min(now - this.clock.last, 1 / 20)
      this.clock.last = now
      this.clock.time += dt
      this.update(dt)
      this.rafId = requestAnimationFrame(loop)
    }
    this.rafId = requestAnimationFrame(loop)
  }

  stop(): void {
    if (this.rafId !== 0) cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }

  private update(dt: number): void {
    this.animator.update(dt)
    this.rig.update(dt)
    this.effects.update(dt)
    this.particles.update(dt)
    // 暗场时网格线一起变淡（页面本身由 CSS 压暗，画布内容保持清晰，bugv3 #2）
    this.board.update(dt, this.clock.time, this.effects.darkAmount)
    this.updateIdle()

    const tilt = this.rig.boardTilt()
    this.tiltGroup.position.set(tilt.offsetX, 0, tilt.offsetZ)
    this.tiltGroup.rotation.z = tilt.rotateZ + this.placeTilt.z
    this.tiltGroup.rotation.x = tilt.rotateX + this.placeTilt.x
    this.tiltGroup.rotation.y = this.idle ? this.idleAngle : 0

    this.updateStaged(dt)
    this.pieces.updateShards(dt)
    this.magic.update(dt, this.clock.time)
    this.flames.update(dt, this.clock.time)
    this.updateTally()
    this.ripple.update(dt, this.rig.camera, this.rippleCenter, this.rig.camera.aspect)
    this.screenFlash.update(this.rig.camera, this.rig.camera.aspect, this.effects.flashAmount, this.effects.color)

    const dark = this.effects.darkAmount > 0.35
    if (dark !== this.darkActive) {
      this.darkActive = dark
      this.hooks.onDarkChange?.(dark)
    }

    this.renderer.render(this.scene, this.rig.camera)
  }

  /** 全屏波纹的中心（0..1 屏幕比例，y 向上）。 */
  private rippleCenter: [number, number] = [0.5, 0.5]

  /** 播放音效：默认走内置合成器，宿主可通过 onSound 接管。 */
  private playSound(name: SoundName, variant = 0): void {
    if (this.hooks.onSound) {
      this.hooks.onSound(name, variant)
      return
    }
    this.audio.play(name, variant)
  }

  /** 触发一次“全场”特效：扩散波纹 + 全屏闪光 + 震屏。 */
  private playBlast(position: Vector3, color: number, options: { strength?: number; flat?: boolean } = {}): void {
    const strength = options.strength ?? 1
    this.rippleCenter = FullScreenRipple.toScreenUv(position, this.rig.camera)
    this.ripple.fire({ color, intensity: 0.85 * strength, duration: 0.8 })
    this.effects.shockwave(position, {
      color,
      from: 0.25,
      to: 3.4 * strength,
      life: 0.5,
      opacity: 0.7,
      flat: options.flat ?? false,
    })
    this.effects.flash(0.34 * strength, color)
    this.rig.kick(0.7 * strength)
    // 光芒炸裂（bugv4 #6）：中心一道放射光 + 一圈横向扩散的碎光
    this.effects.starburst(position, color, 2.2 * strength)
    this.effects.starburst(position, 0xffffff, 1.35 * strength)
    this.particles.burst(position, {
      count: Math.round(40 * strength),
      speed: 6.4 * strength,
      size: 0.19,
      life: 0.72,
      color,
      gravity: -1.4,
      drag: 2.2,
      spread: 1,
    })
    this.particles.burst(position, {
      count: Math.round(22 * strength),
      speed: 4.4,
      size: 0.15,
      life: 0.9,
      color: 0xffffff,
      gravity: -0.8,
      drag: 1.6,
      spread: 1,
    })
    this.particles.burst(position, {
      count: Math.round(12 * strength),
      speed: 8.6 * strength,
      size: 0.1,
      life: 0.5,
      color: 0xffffff,
      gravity: -2.6,
      drag: 3.2,
    })
    this.effects.impactGlow(position, color, 2.4 * strength)
    // bugv9 #2：爆风也会吹到附近的魔力植物（对撞 / 撞击血条都会走这里）
    this.magic.blast(position, strength)
  }

  /** 待机展示：菜单状态的缓慢摆动。 */
  private updateIdle(): void {
    if (!this.idle) {
      this.idleAngle = 0
      return
    }
    this.idleAngle = Math.sin(this.clock.time * 0.22) * 0.16
  }

  private updateStaged(dt: number): void {
    for (const staged of this.staged) {
      staged.mesh.rotateOnAxis(staged.spinAxis, staged.spinSpeed * dt)
      staged.bobPhase += dt * staged.spinSpeed * 0.9
      staged.mesh.position.y = staged.base.y + Math.sin(staged.bobPhase) * 0.1
      staged.mesh.position.x = staged.base.x + Math.sin(staged.bobPhase * 0.7) * 0.05

      // 魔法阵：跟随棋子位置、始终面向镜头、并且持续旋转（bugv5 #10）
      const magic = staged.magic
      if (magic) {
        magic.position.copy(staged.base)
        magic.quaternion.copy(this.rig.camera.quaternion)
        magic.rotateZ(this.clock.time * 1.5 + staged.bobPhase * 0.4)
      }
    }
  }

  /**
   * 总攻击数数字：贴着悬浮棋子一列（bugv3 #6）。
   *
   * 位置每帧由 3D 层直接写进 DOM（宿主只负责文本与样式），
   * 这样鼠标视差 / 受击震屏时数字会跟着舞台一起动。
   */
  private updateTally(): void {
    for (const owner of [0, 1] as PlayerIndex[]) {
      const element = this.tallyElements[owner]
      if (!element) continue
      const active = this.staged.some((item) => item.owner === owner)
      if (active) {
        const side = owner === 0 ? -1 : 1
        // 悬浮棋子排成几列，数字就往下挪几格，始终贴在棋子旁边
        const column = Math.min(Math.max(Math.ceil(this.stagedCount(owner) / STAGE_ROWS) - 1, 0), 1)
        const world = this.rig.ndcPoint(
          side * TALLY_NDC_X,
          TALLY_NDC_Y - column * TALLY_NDC_Y_STEP,
          this.rig.distance * STAGE_DEPTH,
          this.tmpVec,
        )
        const screen = this.rig.worldToScreen(world)
        element.style.transform = `translate3d(${screen.x.toFixed(1)}px, ${screen.y.toFixed(1)}px, 0) translate(-50%, -50%)`
      }
      if (active !== this.tallyVisible[owner]) {
        this.tallyVisible[owner] = active
        element.classList.toggle('is-visible', active)
      }
    }
  }

  private stagedCount(owner: PlayerIndex): number {
    let count = 0
    for (const item of this.staged) if (item.owner === owner) count += 1
    return count
  }

  /** 由宿主注入总攻击数数字的 DOM 元素。 */
  setTallyElements(elements: SideElements): void {
    this.tallyElements = elements
    for (const owner of [0, 1] as PlayerIndex[]) {
      const element = this.tallyElements[owner]
      if (!element) continue
      element.classList.toggle('is-visible', this.tallyVisible[owner])
    }
  }

  /**
   * 攻击舞台的锚点：第 `index` 颗悬浮棋子的世界坐标。
   *
   * 位置由 NDC 屏幕坐标换算而来，因此永远贴着**自己那一侧**的屏幕边缘，
   * 且不受画幅宽高比影响。
   *
   * bugv8 #5：原来是严格的行列网格，看起来"排得太整齐"。
   * 现在每个位置都叠一小撮**确定性**的抖动（按 owner + index 派生，逐帧稳定，
   * 不会让悬浮棋子自己抖起来），整体仍然待在己方那一侧的范围内。
   */
  private stageAnchor(owner: PlayerIndex, index: number): Vector3 {
    const side = owner === 0 ? -1 : 1
    const row = index % STAGE_ROWS
    const column = Math.floor(index / STAGE_ROWS)
    const jitter = stageJitter(owner, index)
    return this.rig.ndcPoint(
      side * (STAGE_NDC_X - column * STAGE_NDC_X_STEP) + jitter.x * 0.055,
      STAGE_NDC_Y - row * STAGE_NDC_Y_STEP + jitter.y * 0.085,
      this.rig.distance * (STAGE_DEPTH + jitter.z * 0.12),
    )
  }

  // -------------------------------------------------------------------------
  // 输入
  // -------------------------------------------------------------------------

  setInteractive(interactive: boolean): void {
    this.interactive = interactive
    if (!interactive) this.board.setHover(null)
  }

  /** 待机展示模式（开始菜单）。 */
  setIdle(idle: boolean): void {
    this.idle = idle
    if (idle) this.board.setHover(null)
  }

  /** 由宿主设置悬停指示色（当前回合方的颜色）。 */
  setHoverColor(color: number): void {
    this.hoverColor = color
  }

  handlePointerMove(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    this.pointer.set((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1)
    this.rig.setPointer(this.pointer.x, this.pointer.y)

    if (!this.interactive || this.playing) {
      this.board.setHover(null)
      return
    }

    const cell = this.pickCell()
    if (cell !== this.hoverCell) {
      this.hoverCell = cell
      this.hooks.onHover?.(cell)
    }
    // bugv10 #2：技能挑选时，悬停到我方"站在魔力植物上的棋子"要高亮这一颗
    this.pieces.setSelectHover(cell)
    // bugv10 #9：选目标格时把准心放到鼠标那一格
    if (this.targeting) this.board.setTargetCell(cell)
    this.board.setHover(cell, this.hoverColor, cell !== null)
  }

  handlePointerLeave(): void {
    this.hoverCell = null
    this.rig.setPointer(0, 0)
    this.board.setHover(null)
    this.pieces.setSelectHover(null)
    if (this.targeting) this.board.setTargetCell(null)
    this.hooks.onHover?.(null)
  }

  handleClick(clientX: number, clientY: number): void {
    if (!this.interactive || this.playing) return
    const rect = this.canvas.getBoundingClientRect()
    this.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    const cell = this.pickCell()
    if (cell === null) return
    this.hooks.onCellPick?.(cell)
  }

  private pickCell(): number | null {
    this.raycaster.setFromCamera(this.pointer, this.rig.camera)
    const hits = this.raycaster.intersectObject(this.board.pickPlane, false)
    if (hits.length === 0) return null
    return worldToCell(hits[0].point)
  }

  /** 由宿主告知左右两块 HUD 的屏幕位置，用于“撞击血条”。 */
  setHudRects(rects: SideHudRects): void {
    this.hudRects = rects
  }

  // -------------------------------------------------------------------------
  // 基础表现 API
  // -------------------------------------------------------------------------

  /** 把所有棋子按模型重建（立刻生效）。 */
  syncBoard(board: ArrayLike<number>): void {
    // 整体重建时舞台引用必须一起作废，否则残留的 stagedByCell 会挡住后续的离场动画
    this.clearStaged()
    this.pieces.reset()
    for (let i = 0; i < board.length; i++) {
      const cell = board[i]
      if (cell === 0) continue
      this.pieces.spawn(i, (cell - 1) as PlayerIndex)
    }
    this.pieces.groundAll()
  }

  /** 清空舞台棋子及其索引（重开 / 回放 / 重建棋盘时调用）。 */
  private clearStaged(): void {
    for (const staged of this.staged) {
      this.disposeMagic(staged.magic)
      this.pieces.recycle(staged.mesh)
    }
    this.staged = []
    this.stagedByCell.clear()
    this.pieces.setStageBoost(0)
  }

  /**
   * 把棋盘视觉与模型对齐：模型里已消失的棋子做飞出动画，模型里已有但没显示的补齐。
   * 已在舞台上的棋子会被跳过，因此对撞不会被误回收。
   */
  async syncBoardAsync(board: ArrayLike<number>): Promise<void> {
    const desired = new Set<number>()
    for (let i = 0; i < board.length; i++) {
      if (board[i] !== 0) desired.add(i)
    }
    const stale = this.pieces.boardPieces.filter((cell) => !desired.has(cell) && !this.stagedByCell.has(cell))
    const missing: number[] = []
    for (const cell of desired) {
      if (!this.pieces.get(cell) && !this.stagedByCell.has(cell)) missing.push(cell)
    }

    if (stale.length > 0) {
      await this.animateRemoval(this.pieces.ownerAt(stale[0]) ?? 0, stale, false)
    }
    for (const cell of missing) {
      await this.animatePlacement((board[cell] - 1) as PlayerIndex, cell)
    }
  }

  showHighlights(cells: readonly number[], weights: readonly number[], owner: PlayerIndex, intensity = 1): void {
    this.board.showHighlights(cells, weights, owner, intensity)
  }

  /**
   * 全量对齐棋盘上的魔力植物（bugv8 #4）。
   *
   * 用在不走事件流的场景：开局 / 回放跳步 / 联机 `sync` 重建。
   */
  syncMagic(plants: ReadonlyArray<{ cell: number; kind: MagicKind; owner: PlayerIndex | null }>): void {
    this.magic.sync(plants)
  }

  /** 重开一局时清掉所有植物。 */
  clearMagic(): void {
    this.magic.clear()
  }

  /**
   * 技能挑选状态（bugv9 #13 / bugv10 #2）：高亮某一方占用的魔力植物。
   *
   * - `player` 非 null 时：**只有**该方棋子占用的魔力植物与站在上面的棋子保持明亮，
   *   其它棋子与植物一起压暗（需求原文）；
   * - `picked` 里已经勾选的植物会额外加一圈高光标识（多选技能）；
   * - `stage === 'cell'`（恶龙吐息）时进场"选目标"模式：整个棋盘变暗、只留准心。
   */
  setSkillSelecting(
    player: PlayerIndex | null,
    options: { picked?: readonly number[]; stage?: 'plants' | 'cell' } = {},
  ): void {
    const picked = options.picked ?? []
    this.magic.setSelecting(player, picked)
    // 只有"站在我方魔力植物上的棋子"参与高亮（bugv10 #2）
    const spotlight =
      player === null ? null : [...this.magic.plantsOf(player)].filter((cell) => this.pieces.get(cell) !== null)
    this.pieces.setSelectSpotlight(spotlight, this.palette.sides[player ?? 0].color)
    this.board.setSkillDim(player !== null)
    if (player === null) this.setTargeting(false)
  }

  /**
   * "选目标格"模式（bugv10 #9 恶龙吐息）：棋盘压暗 + 鼠标处显示准心。
   */
  setTargeting(active: boolean): void {
    this.targeting = active
    this.board.setTargeting(active)
    if (!active) this.board.setTargetCell(null)
  }

  /**
   * 悬停到我方"站在魔力植物上的棋子"时的高亮标识（bugv10 #2）。
   *
   * `null` 表示没有悬停在任何可选棋子上。
   */
  setSelectHover(cell: number | null): void {
    this.pieces.setSelectHover(cell)
  }

  /** 全量对齐棋盘上的烈焰（联机 sync / 回放跳步 / 开局）。 */
  syncFlames(
    entries: ReadonlyArray<readonly [number, number]>,
    /** bugv14：烈焰归属 —— `[cell, owner]`，决定火舌配色（双方都是 gtp 时靠它区分）。 */
    owners: ReadonlyArray<readonly [number, number]> = [],
  ): void {
    this.flames.reset()
    if (entries.length === 0) return
    const ownerOf = new Map<number, 0 | 1>()
    for (const [cell, owner] of owners) ownerOf.set(cell, owner === 1 ? 1 : 0)
    const turns = Math.max(...entries.map((entry) => entry[1]))
    const byOwner: [number[], number[]] = [[], []]
    for (const [cell] of entries) byOwner[ownerOf.get(cell) ?? 0].push(cell)
    for (const owner of [0, 1] as const) {
      if (byOwner[owner].length > 0) this.flames.ignite(byOwner[owner], turns, owner)
    }
    for (const entry of entries) {
      if (entry[1] !== turns) this.flames.setRemaining([entry[0]], entry[1])
    }
  }

  /**
   * 全量对齐"叠在敌方棋子上的额外棋子"（bugv10 #9 毒鸡蛋）。
   *
   * `board` 是底层棋盘（原棋子的归属），`entries` 是 `[cell, player][]`。
   */
  syncOverlay(board: ArrayLike<number>, entries: ReadonlyArray<readonly [number, number]>): void {
    this.pieces.syncOverlay(entries.map((entry) => ({ cell: entry[0], owner: (entry[1] === 1 ? 1 : 0) as PlayerIndex })))
    void board
  }

  /** 由宿主提供技能槽的屏幕位置（bugv10 #9：小一哥的额外棋子从这里飞出来）。 */
  setSkillRects(rects: SideHudRects): void {
    this.skillRects = rects
  }

  /** 某格现在是否在燃烧（验证脚本用）。 */
  flameAt(cell: number): boolean {
    return this.flames.has(cell)
  }

  clearHighlights(): void {
    this.board.clearHighlights()
  }

  /** 攻击方连珠成立：网格转为红色（此时**还不变暗**，bugv2 #5）。 */
  setAttackMode(active: boolean): void {
    this.board.setAttackMode(active)
    if (!active) this.effects.setDark(false)
  }

  /**
   * 环境暗场：防守方落子后才开启，攻击阶段结束即恢复（bugv2 #5）。
   *
   * 只压暗**场地**（页面背景 + 棋盘网格 + 棋盘上的棋子），
   * 悬浮棋子会同时被提亮，对撞特效本身是不受光照影响的加色材质（bugv3 #2）。
   */
  setDarkMode(active: boolean): void {
    this.effects.setDark(active)
    this.pieces.setStageBoost(active ? 1 : 0)
  }

  /**
   * 黑夜降临 / 结束（bugv34）：棋盘线转为深红色。
   *
   * ⚠️ 这里**不改 3D 光源** —— 黑夜的"场地变暗"由页面级 CSS 压暗层（`.app-root.is-night`）
   * 负责，压暗层在画布**之下**，因此棋子的显示效果完全不变（bugv34 补充：用户要的是
   * "场地暗下来、棋子显示效果不变"）。
   */
  setNight(active: boolean): void {
    this.board.setNight(active)
  }

  /** 运行中切换特征色（设置面板 / 角色系统）。 */
  setPalette(palette: Palette): void {
    this.palette = palette
    this.board.setPalette(palette)
    this.pieces.setPalette(palette)
    this.effects.setPalette(palette)
    this.magic.setPalette(palette)
    // bugv9 #12：悬浮棋子的魔法阵颜色由特征色决定，换色后必须重新着色
    for (const staged of this.staged) {
      if (staged.magic) this.effects.recolorMagic(staged.magic, staged.owner)
    }
    // bugv28 #2：上一步落子标记也按特征色重绘
    if (this.lastMark) this.board.setLastMark(this.lastMark.cell, palette.sides[this.lastMark.owner].color)
  }

  /**
   * 上一步落子标记（bugv28 #2）。
   *
   * `cell === null` 清除；否则在该格画一圈**落子方特征色**的光环。
   */
  setLastMark(cell: number | null, owner: PlayerIndex = 0): void {
    this.lastMark = cell === null ? null : { cell, owner }
    this.board.setLastMark(cell, this.palette.sides[owner].color)
  }

  /** 动画速度倍率（bugv28 #3，设置面板）。1 = 原速。 */
  setAnimationSpeed(speed: number): void {
    this.animator.timeScale = speed > 0 ? speed : 1
  }

  /** 当前动画速度倍率（验收脚本用）。 */
  get animationSpeed(): number {
    return this.animator.timeScale
  }

  /** 上一步落子标记（验收脚本用；无标记返回 null）。 */
  get lastMarkInfo(): { cell: number; owner: PlayerIndex } | null {
    return this.lastMark
  }

  /** 高光权重（由宿主在攻击开始前注入）。 */
  setHighlightWeights(weights: ReadonlyMap<number, number>): void {
    this.pendingWeights = new Map(weights)
  }

  /** 清空所有临时特效与舞台棋子（重开对局 / 回到菜单）。 */
  resetTransient(): void {
    this.effects.reset()
    this.particles.reset()
    this.screenFlash.reset()
    this.animator.clear()
    this.clearStaged()
    this.pendingWeights.clear()
    this.board.clearHighlights()
    // bugv28 #2：上一步落子标记也一起清掉（新一局 / 回菜单）
    this.board.setLastMark(null)
    this.lastMark = null
    this.board.setAttackMode(false)
    this.effects.setDark(false)
    this.setTallyVisible(false)
    this.magic.clear()
    // bugv10 #9：烈焰、叠子、技能挑选状态一起复位
    this.flames.reset()
    this.pieces.syncOverlay([])
    this.setSkillSelecting(null)
    this.setTargeting(false)
    this.flameOrigin = null
    this.playing = false
    // bugv26 #2：缩放也复位（新一局回到自动取景）
    this.rig.setZoom(1)
  }

  /** 隐藏总攻击数数字（没有悬浮棋子时）。 */
  private setTallyVisible(visible: boolean): void {
    for (const owner of [0, 1] as PlayerIndex[]) {
      this.tallyVisible[owner] = visible
      this.tallyElements[owner]?.classList.toggle('is-visible', visible)
    }
  }

  /** 跳过当前正在播放的动画。 */
  skipAnimations(): void {
    this.animator.finishAll()
  }

  // -------------------------------------------------------------------------
  // 事件动画编排
  // -------------------------------------------------------------------------

  /**
   * 依次播放一组事件动画。
   *
   * 每个事件动画结束时调用 `hooks.onApply(event)`，宿主据此推进模型状态，
   * 保证“看到的”和“算出来的”始终一致。
   */
  async playEvents(
    events: readonly GameEvent[],
    options: {
      shouldAbort?: () => boolean
      /** 每个事件动画**开始前**调用，用于把棋盘视觉与模型对齐。 */
      onSettled?: (event: GameEvent) => Promise<void> | void
    } = {},
  ): Promise<void> {
    const { shouldAbort, onSettled } = options
    this.playing = true
    try {
      for (const event of events) {
        if (this.disposed || shouldAbort?.()) return
        await onSettled?.(event)
        if (this.disposed || shouldAbort?.()) return
        await this.playEvent(event)
        if (this.disposed || shouldAbort?.()) return
        this.hooks.onApply?.(event)
      }
    } finally {
      this.playing = false
    }
  }

  private async playEvent(event: GameEvent): Promise<void> {
    switch (event.type) {
      case 'diceRolled':
        await this.animator.wait(0.55)
        break
      case 'turnStarted':
        await this.animator.wait(0.1)
        break
      case 'stonePlaced':
        if (event.stacked) await this.animateStack(event.player, event.cell)
        else await this.animatePlacement(event.player, event.cell)
        break
      case 'matchFormed':
        await this.animateMatch(event.match.owner, event.match.lines.map((line) => line.cells))
        break
      case 'stonesRemoved':
        // 防守方形成连珠：不留高光，其余高光（攻击方原位置）立刻消失（bugv2 #4）
        if (!event.highlight) this.clearHighlights()
        await this.animateRemoval(event.player, event.cells, event.highlight, event.kept ?? [])
        break
      case 'highlightShown':
        await this.animator.wait(0.16)
        break
      case 'defenderPlaced':
        if (event.shattered) await this.animateShatter(event.player, event.cell)
        else await this.animatePlacement(event.player, event.cell)
        break
      case 'redeployStones':
        // bugv34m「小千问」：自动落子 → 特征色光流棋子从天而降
        await this.animateRedeploy(event.player, event.placed, event.refunded)
        break
      case 'attackResolved':
        // 防守方已经落子：此刻才把环境压暗（bugv2 #5）
        this.setDarkMode(true)
        await this.animateAttackResolved(event)
        break
      case 'hpChanged':
        await this.animator.wait(0.05)
        break
      // --- 魔力植物（bugv8 #4） ---------------------------------------------
      case 'magicGrown':
        await this.animateMagicGrown(event)
        break
      case 'magicClaimed':
        this.magic.claim(event.cell, event.player)
        this.playSound(event.stolen ? 'magicSteal' : 'magic', event.stolen ? 1 : 0)
        await this.animator.wait(event.stolen ? 0.26 : 0.12)
        break
      case 'magicRemoved':
        this.animateMagicRemoved(event.cells)
        await this.animator.wait(0.18)
        break
      case 'magicReverted':
        // bugv34 补充：雷暴结束 → 污染体变回普通魔力植物
        // bugv34c：暴雪「冻结 / 解冻」也走这个事件，按 reason 加一圈霜白爆风
        this.magic.transform(event.plants)
        if (event.reason === 'blizzardStart' || event.reason === 'blizzardEnd') {
          for (const plant of event.plants) {
            this.effects.shockwave(cellToWorld(plant.cell, new Vector3()), {
              color: 0xdff1ff,
              from: 0.2,
              to: 1.6,
              life: 0.42,
              opacity: 0.5,
            })
          }
          if (event.plants.length > 0) this.playSound('magic', event.plants.length)
        }
        await this.animator.wait(0.12)
        break
      case 'lightningStruck':
        // bugv34 补充：雷暴天气长植物前的"闪电从天而降"演出
        await this.animateLightning(event.cells)
        break
      case 'attackStoneSplit':
        // bugv34「瘟疫」：带魔力植物的攻击棋子分裂成两颗 —— 在它原位闪一圈绿光
        this.effects.shockwave(cellToWorld(event.cell, new Vector3()), {
          color: 0x22c55e,
          from: 0.2,
          to: 2.2,
          life: 0.5,
          opacity: 0.55,
          jagged: 0.16,
        })
        await this.animator.wait(0.12)
        break
      case 'magicConsumed':
        // bugv10 #5：技能消耗掉的魔力植物（含它上面的魔法阵）必须真的消失
        this.animateMagicRemoved(event.cells)
        this.playSound('magic', event.cells.length)
        await this.animator.wait(0.22)
        break
      case 'skillUsed':
        await this.animateSkill(event)
        break
      // --- bugv10 #9：新角色的技能特效 ---------------------------------------
      case 'stoneShattered':
        await this.animateShatter(event.player, event.cell)
        break
      case 'flamesIgnited':
        await this.animateFlamesIgnited(event.cells, event.turns, event.owner === 1 ? 1 : 0)
        break
      case 'flamesChanged':
        this.flames.setRemaining(event.cells, event.remaining)
        await this.animator.wait(0.05)
        break
      case 'flamesCleared':
        this.flames.clear(event.cells)
        await this.animator.wait(0.05)
        break
      case 'immuneChanged':
        if (event.active) await this.animateImmune(event.player)
        else await this.animator.wait(0.05)
        break
      case 'twinStarChanged':
        // 「双子星」窗口开 / 关（bugv11 #5 / 追加 #2：只做"两连即可攻击 + 免反击"）。
        // 开的时候在施法者那一侧亮一圈，提示对手"这一回合他能两连开打"。
        if (event.active) {
          this.effects.shockwave(this.playerSidePoint(event.player), {
            color: this.palette.sides[event.player].glow,
            from: 0.2,
            to: 2.4,
            life: 0.6,
            opacity: 0.45,
          })
          this.playSound('magic', 2)
          await this.animator.wait(0.24)
        } else {
          await this.animator.wait(0.05)
        }
        break
      case 'powerChanged':
      case 'sabotageChanged':
        await this.animator.wait(0.05)
        break
      case 'highlightsCleared':
        this.clearHighlights()
        this.setDarkMode(false)
        await this.animator.wait(0.14)
        break
      case 'gameOver':
        // bugv9 #11：分出胜负后棋盘上的棋子高速炸飞出去（往朝向玩家的方向）
        await this.animateGameOver()
        this.hooks.onGameOver?.()
        break
      default:
        break
    }
  }

  /**
   * 无敌挡下伤害的表现（bugv10 #9「精密计算」）。
   *
   * 攻击方的悬浮棋子一起撞向对方的血条，在血条前被一层结界弹开、化掉；
   * 受保护的一方一滴血都不掉。
   */
  private async animateImmuneBlock(player: PlayerIndex): Promise<void> {
    const side = this.palette.sides[player]
    const hud = this.hudWorldTarget(player, 0)
    const strikers = this.staged.filter((item) => item.owner === other(player))
    this.playSound('counter', 2)
    this.effects.flash(0.22, side.glow)
    this.rig.kick(0.5)

    const plan = strikers.map((item, index) => {
      const from = item.base.clone()
      const target = hud.clone().add(new Vector3((index % 5) * 0.16 - 0.3, 0, 0.2))
      return { item, from, target }
    })
    await this.animator.run(0.4, (t) => {
      const eased = 1 - (1 - t) ** 3
      for (const entry of plan) {
        entry.item.base.lerpVectors(entry.from, entry.target, eased)
        entry.item.mesh.position.copy(entry.item.base)
        entry.item.mesh.rotateZ(t * 3)
      }
    })

    // 结界：在血条前挡下这一击
    this.effects.shockwave(hud, { color: side.glow, from: 0.25, to: 4.4, life: 0.9, opacity: 0.6, flat: true })
    this.effects.shockwave(hud, { color: 0xffffff, from: 0.1, to: 2.2, life: 0.6, opacity: 0.45, flat: true })
    this.effects.sunburst(hud, side.glow, 2.6)
    this.particles.burst(hud, {
      count: 44,
      speed: 6.4,
      size: 0.16,
      life: 0.75,
      color: side.glow,
      gravity: -0.6,
      drag: 2.2,
      spread: 1,
    })
    this.playSound('impact', 0)
    for (const entry of plan) {
      const at = entry.item.mesh.position.clone()
      this.pieces.shatter(entry.item.mesh, entry.item.owner, at)
      this.particles.burst(at, {
        count: 10,
        speed: 3.6,
        size: 0.12,
        life: 0.5,
        color: side.color,
        gravity: -4,
        drag: 2.4,
      })
      this.releaseStaged(entry.item)
    }
    await this.animator.wait(0.36)
  }

  /**
   * 对局结束动画（bugv9 #11）。
   *
   * 棋盘上的棋子**全部**以高速炸飞出去：xy 轴随机偏移、整体往 +z（朝向玩家的方向）
   * 冲出去，速度由高速逐渐衰减，直到飞出屏幕。舞台上残留的棋子也一起清掉。
   *
   * bugv10 #1：魔力植物（以及它们脚下的魔法阵）也必须一起消失，
   * 不能再留在棋盘上。
   */
  private async animateGameOver(): Promise<void> {
    this.clearStaged()
    this.pieces.launchAll()
    // 植物与烈焰跟着一起清掉（bugv10 #1）
    this.magic.remove(this.magic.cells)
    this.magic.clear()
    this.flames.reset()
    this.rig.kick(1.1)
    this.effects.flash(0.28)
    this.playSound('clash', 4)
    await this.animator.wait(GAME_OVER_FLIGHT_SECONDS)
  }

  /** 结束动画的总时长（秒），宿主用它安排结算弹窗的时机。 */
  static get gameOverDuration(): number {
    return GAME_OVER_FLIGHT_SECONDS
  }

  /** 魔力植物破土而出：银色光点 + 一圈很淡的涟漪 + 音效（bugv8 #4）。 */
  /**
   * 雷暴天气：闪电从天而降落在棋盘格上（bugv34 补充）。
   *
   * 事件顺序是 `lightningStruck` → `magicGrown`，所以这里播完雷电后，
   * 紧接着的 `animateMagicGrown` 才会在落点长出「污染体」。
   */
  private async animateLightning(cells: readonly number[]): Promise<void> {
    if (cells.length === 0) return
    for (const cell of cells) {
      this.effects.lightningStrike(cellToWorld(cell, new Vector3()))
    }
    this.playSound('impact', 1)
    await this.animator.wait(0.36)
  }

  private async animateMagicGrown(event: Extract<GameEvent, { type: 'magicGrown' }>): Promise<void> {
    if (event.plants.length === 0) return
    /**
     * bugv29 #4：Claude「布局」种下的植物**逐棵间隔 0.5 秒**冒出来，每棵带一次阳光闪烁。
     *
     * 自然生长仍然一次性铺开（那样才像"一批植物同时长出来"）。
     */
    if (event.source === 'seed') {
      for (let index = 0; index < event.plants.length; index++) {
        const plant = event.plants[index]
        const owner = plant.owner !== undefined ? plant.owner : (event.owner ?? null)
        this.magic.spawn(plant.cell, plant.kind, owner, true)
        this.sunlightFlash(plant.cell)
        this.playSound('magic', index + 1)
        // 最后一棵不再等（总时长 = (n-1) × 0.5 秒）
        if (index < event.plants.length - 1) await this.animator.wait(0.5)
      }
      await this.animator.wait(0.2)
      return
    }

    for (const plant of event.plants) {
      // bugv17 #7：逐棵归属优先 —— 「布局」的九宫格里既有空格（无主）也有棋子（归棋子主人）
      const owner = plant.owner !== undefined ? plant.owner : (event.owner ?? null)
      this.magic.spawn(plant.cell, plant.kind, owner, true)
    }
    for (const plant of event.plants) {
      const position = cellToWorld(plant.cell, new Vector3())
      this.effects.shockwave(position, { color: 0xdfe9f7, from: 0.12, to: 1.15, life: 0.7, opacity: 0.4 })
      this.particles.burst(position, {
        count: 12,
        speed: 1.5,
        size: 0.09,
        life: 0.6,
        color: 0xeaf1fb,
        gravity: -1.4,
        spread: 1,
        drag: 2.4,
      })
    }
    this.playSound('magic', event.plants.length)
    await this.animator.wait(0.42)
  }

  /**
   * bugv29 #4：阳光闪烁（Claude「布局」长出植物时的那一下暖金光）。
   *
   * 一次太阳爆发 + 一圈暖光环 + 少量金色光点，短促而亮，像光照到叶子反光。
   */
  private sunlightFlash(cell: number): void {
    const position = cellToWorld(cell, new Vector3())
    position.y = 0.22
    this.effects.sunburst(position, 0xffdf8a, 2.4)
    this.effects.shockwave(position, { color: 0xfff0bd, from: 0.12, to: 1.5, life: 0.55, opacity: 0.6 })
    this.particles.burst(position, {
      count: 16,
      speed: 2.1,
      size: 0.09,
      life: 0.55,
      color: 0xffe6a3,
      gravity: -1.3,
      spread: 1,
      drag: 2.2,
    })
  }

  /** 魔力植物随连珠消失（缩小 + 银色碎光）。 */
  private animateMagicRemoved(cells: readonly number[]): void {
    for (const cell of cells) {
      const position = cellToWorld(cell, new Vector3())
      position.y = 0.12
      this.particles.burst(position, {
        count: 10,
        speed: 1.9,
        size: 0.08,
        life: 0.5,
        color: 0xe6eefb,
        gravity: -3,
        spread: 1,
      })
    }
    this.magic.remove(cells)
  }

  // -------------------------------------------------------------------------
  // bugv10 #9：新角色的技能表现
  // -------------------------------------------------------------------------

  /**
   * 技能释放的整体表现。
   *
   * 「恶龙吐息」发射一颗硕大的火球（`FlameView.fireball`），命中瞬间把已有的
   * 棋子对撞特效整套叠上去（太阳爆发 + 全屏波纹 + 粒子 + 震屏），
   * 因此观感比普通对撞还要华丽。
   */
  private async animateSkill(event: Extract<GameEvent, { type: 'skillUsed' }>): Promise<void> {
    const side = this.palette.sides[event.player]
    if (event.effect === 'fireball' && event.target !== null && event.target !== undefined) {
      const target = cellToWorld(event.target as number, new Vector3())
      target.y = PIECE_HEIGHT * 0.7
      // 从施法者那一侧的上空投出（p0 在屏幕左、p1 在右）
      const from = new Vector3(event.player === 0 ? -6.4 : 6.4, 3.6, 5.4)
      // bugv26 #1：整套火球配色跟着施法者走（1 号位 = 青蓝），
      // 否则"飞过来是橙火、落地变蓝焰"观感割裂。
      const fire = firePalette(event.player === 1 ? 1 : 0)
      // bugv11 追加 #4：记下落点，烈焰会从这一格由内到外逐圈烧起来
      this.flameOrigin = event.target as number
      this.playSound('fire')
      this.rig.kick(0.5)
      await this.flames.fireball(from, target, {
        owner: event.player === 1 ? 1 : 0,
        onImpact: () => {
          // 叠加"棋子相撞"那一整套特效
          this.effects.sunburst(target, fire.hot, 4.2)
          this.effects.sunburst(target, fire.orange, 2.8)
          this.playBlast(target, fire.blaze, { strength: 1.35, flat: false })
          this.playBlast(target, side.color, { strength: 0.8, flat: false })
          this.particles.burst(target, {
            count: 60,
            speed: 9.2,
            size: 0.2,
            life: 0.8,
            color: fire.yellow,
            gravity: -1.2,
            drag: 2,
            spread: 1,
          })
          this.particles.burst(target, {
            count: 34,
            speed: 6.2,
            size: 0.16,
            life: 1,
            color: fire.deep,
            gravity: -0.6,
            drag: 1.8,
            spread: 1,
          })
          this.playSound('clash', 5)
          this.playSound('impact', 3)
        },
      })
      return
    }
    // bugv18 #4「最不绕弯子」（seedance 2 技能）：消耗 N 棵植物**直接攻击**。
    // 它没有落子、没有连珠、也没有高光格 —— 只靠通用特效玩家根本看不出"有人打我"，
    // 只会觉得"技能进冷却了但什么都没发生"。所以这里补一段明确的"蓄力 → 打向棋盘"演出。
    // （真正的伤害仍要等防守方落子后才结算，这里只是把"攻击已经开始"讲清楚。）
    if (event.effect === 'assault') {
      const beams = Math.max(1, event.cells.length)
      const origin = this.playerSidePoint(event.player)
      const impact = cellToWorld(40, new Vector3())
      impact.y = PIECE_HEIGHT * 0.6
      this.rig.kick(0.45)
      this.effects.shockwave(origin, { color: side.color, from: 0.3, to: 3.2, life: 0.5, opacity: 0.55 })
      this.effects.impactGlow(origin, side.glow, 2.2)
      this.particles.burst(origin, {
        count: 36,
        speed: 6.4,
        size: 0.16,
        life: 0.7,
        color: side.glow,
        gravity: 0.6,
        spread: 1,
      })
      this.playSound('magic', 2)
      await this.animator.wait(0.2)
      // 每消耗 1 棵植物 = 1 发，全部砸向棋盘中心（攻击值 = 消耗数量）
      for (let i = 0; i < beams; i++) {
        this.particles.burst(impact, {
          count: 14,
          speed: 4.6,
          size: 0.15,
          life: 0.5,
          color: side.color,
          gravity: 0.4,
          spread: 1,
        })
      }
      this.effects.sunburst(impact, side.glow, 3.8)
      this.playBlast(impact, side.color, { strength: 1.15, flat: false })
      this.playSound('impact', 3)
      await this.animator.wait(0.24)
      return
    }
    // 其余技能：脚下扩散一圈特征色能量环 + 少量上升粒子
    const origin = this.playerSidePoint(event.player)
    this.effects.shockwave(origin, { color: side.color, from: 0.3, to: 2.6, life: 0.6, opacity: 0.5 })
    this.effects.impactGlow(origin, side.glow, 1.4)
    this.particles.burst(origin, {
      count: 22,
      speed: 3.2,
      size: 0.12,
      life: 0.6,
      color: side.glow,
      gravity: 1.8,
      spread: 1,
    })
    this.playSound('magic', 1)
    await this.animator.wait(0.24)
  }

  /**
   * bugv34m「小千问」的自动落子演出：**特征色光流棋子从天而降**。
   *
   * 参考 glm「毒鸡蛋」那道暗色光流（见 `animateStack`），区别是：
   * - 用**施法者自己的特征色**（不是黑色），因为它是"自己的棋子被重新部署"；
   * - 一次可能落下好几颗 → 做成"一颗接一颗"的连落，每颗都拖一道发光光流。
   */
  private async animateRedeploy(
    player: PlayerIndex,
    placed: readonly number[],
    refunded: ReadonlyArray<{ cell: number; overlay: boolean }>,
  ): Promise<void> {
    const side = this.palette.sides[player]
    const all: Array<{ cell: number; overlay: boolean; back: boolean }> = [
      ...placed.map((cell) => ({ cell, overlay: false, back: false })),
      ...refunded.map((item) => ({ cell: item.cell, overlay: item.overlay, back: true })),
    ]
    if (all.length === 0) return
    this.playSound('magic', Math.min(all.length, 3))

    for (const item of all) {
      const mesh = item.overlay ? this.pieces.spawnOverlay(item.cell, player) : this.pieces.spawn(item.cell, player)
      const rest = mesh.position.clone()
      const dropHeight = 7.2
      const top = new Vector3(rest.x, rest.y + dropHeight, rest.z)
      const streakTo = new Vector3(rest.x, rest.y + 0.05, rest.z)
      mesh.position.copy(top)
      mesh.scale.setScalar(0.7)

      // 起步先铺一道长光流，再用"加速下坠 + 途中持续补光流"做出流动感
      this.effects.lightStreak(top, streakTo, side.glow, { radius: CELL_SIZE * 0.17, life: 0.42, opacity: 0.5 })
      await this.animator.run(0.26, (t) => {
        const eased = Easing.cubicIn(t)
        mesh.position.set(rest.x, rest.y + dropHeight * (1 - eased), rest.z)
        mesh.rotateY(t * 6)
        if (Math.random() < 0.6) {
          this.effects.lightStreak(
            new Vector3(rest.x, mesh.position.y + 1.8, rest.z),
            streakTo,
            side.glow,
            { radius: CELL_SIZE * 0.1, life: 0.26, opacity: 0.38 },
          )
        }
      })

      // 落地：轻震 + 特征色涟漪 + 光点
      mesh.position.copy(rest)
      this.rig.kick(0.32)
      this.effects.shockwave(rest, { color: side.color, from: 0.16, to: 2.4, life: 0.7, opacity: 0.5 })
      this.effects.impactGlow(rest, side.glow, 1.1)
      this.particles.burst(rest, {
        count: 16,
        speed: 2.6,
        size: 0.12,
        life: 0.5,
        color: side.color,
        gravity: -4.5,
        spread: 1,
      })
      this.playSound(item.back ? 'magic' : 'place', 2)
      await this.animator.run(0.16, (t) => {
        const pop = 1 + Math.sin(Math.PI * Math.min(t * 1.3, 1)) * 0.16
        mesh.scale.setScalar(0.7 * pop)
      })
      mesh.scale.setScalar(1)
      if (!item.overlay) this.pieces.groundAt(item.cell)
    }
  }

  /** 叠子（毒鸡蛋）：在敌方棋子上再落一颗，加一圈特征色涟漪（bugv10 #9）。 */
  /**
   * 毒鸡蛋叠子（bugv10 #9）。
   *
   * bugv29 #4 演出：这一颗子**从天上高速砸下来**（加速下坠 + 落地重震），
   * 身后拖一道**黑色光流**，落地炸开紫色光点。
   */
  private async animateStack(player: PlayerIndex, cell: number): Promise<void> {
    const side = this.palette.sides[player]
    const mesh = this.pieces.spawnOverlay(cell, player)
    const at = mesh.position.clone()
    const rest = at.clone()
    const dropHeight = 6.4
    mesh.position.set(at.x, at.y + dropHeight, at.z)
    mesh.scale.setScalar(0.78)
    this.playSound('place', 3)

    // 黑色光流：先从高空铺一条到落点
    const streakTo = new Vector3(at.x, at.y + 0.05, at.z)
    this.effects.darkStreak(new Vector3(at.x, at.y + dropHeight, at.z), streakTo, {
      radius: CELL_SIZE * 0.2,
      life: 0.5,
      opacity: 0.55,
    })

    // 加速下坠：越接近落点越快
    await this.animator.run(0.3, (t) => {
      const eased = Easing.cubicIn(t)
      mesh.position.set(at.x, at.y + dropHeight * (1 - eased), at.z)
      mesh.rotateY(t * 7)
      // 下坠途中持续补黑色光流，形成"流动"感
      if (Math.random() < 0.55) {
        this.effects.darkStreak(new Vector3(at.x, mesh.position.y + 1.7, at.z), streakTo, {
          radius: CELL_SIZE * 0.13,
          life: 0.32,
          opacity: 0.4,
        })
      }
    })

    // 落地：重震 + 暗色冲击 + 紫色光点
    mesh.position.copy(rest)
    this.rig.kick(0.5)
    this.effects.shockwave(rest, { color: 0x6b3fa0, from: 0.18, to: 2.7, life: 0.85, opacity: 0.55 })
    this.effects.shockwave(rest, { color: side.color, from: 0.15, to: 2.1, life: 0.8, opacity: 0.5 })
    this.effects.impactGlow(rest, side.color, 1.2)
    this.effects.darkStreak(new Vector3(at.x, at.y + 3.6, at.z), streakTo, {
      radius: CELL_SIZE * 0.26,
      life: 0.6,
      opacity: 0.62,
    })
    this.particles.burst(rest, {
      count: 26,
      speed: 3,
      size: 0.13,
      life: 0.6,
      color: 0x8a5cd6,
      gravity: -5,
      spread: 1,
    })
    this.particles.burst(rest, {
      count: 14,
      speed: 1.7,
      size: 0.11,
      life: 0.55,
      color: side.glow,
      gravity: -3,
      spread: 1,
    })
    await this.animator.run(0.22, (t) => {
      const pop = 1 + Math.sin(Math.PI * Math.min(t * 1.3, 1)) * 0.18
      mesh.scale.setScalar(0.78 * pop)
    })
    mesh.scale.setScalar(0.78)
  }

  /**
   * 棋子落在烈焰上碎裂（bugv10 #9）。
   *
   * 这颗棋子**不会**留在棋盘上：先让它出现一下，然后当场炸成碎片 + 碎裂音效。
   */
  private async animateShatter(player: PlayerIndex, cell: number): Promise<void> {
    const side = this.palette.sides[player]
    // bugv26 #1：碎裂特效的"火色"跟着这一格火的主人（1 号位 = 青蓝）。
    const fire = firePalette(this.flames.ownerAt(cell) ?? 0)
    const mesh = this.pieces.spawn(cell, player)
    const at = mesh.position.clone()
    this.playSound('shatter', cell % 4)
    this.pieces.shatter(mesh, player, at)
    this.effects.shockwave(at, { color: fire.blaze, from: 0.12, to: 1.6, life: 0.5, opacity: 0.55 })
    this.effects.impactGlow(at, fire.blaze, 1.2)
    this.particles.burst(at, {
      count: 24,
      speed: 5.2,
      size: 0.13,
      life: 0.6,
      color: fire.orange,
      gravity: -8,
      drag: 2.2,
      spread: 1,
    })
    this.particles.burst(at, {
      count: 14,
      speed: 3.4,
      size: 0.1,
      life: 0.7,
      color: side.glow,
      gravity: -3,
      drag: 1.6,
      spread: 1,
    })
    this.rig.kick(0.35)
    await this.animator.wait(0.42)
    this.pieces.despawn(cell)
  }

  /**
   * 烈焰点燃（恶龙吐息爆炸后）：整行整列烧起来（bugv10 #9）。
   *
   * bugv11 追加 #4：不再整行整列同时亮 —— 按"离火球落点几圈"分组，
   * **由内到外一圈一圈**点燃（每圈 45ms 时差），看起来才像火从落点向外蔓延。
   */
  private async animateFlamesIgnited(cells: readonly number[], turns: number, owner: 0 | 1 = 0): Promise<void> {
    if (cells.length === 0) return
    // bugv26 #1：点燃时的涟漪 / 火星也跟着主人配色（1 号位是青蓝）。
    const fire = firePalette(owner)
    const origin = this.flameOrigin
    const originRow = origin === null ? 0 : Math.floor(origin / BOARD_SIZE)
    const originCol = origin === null ? 0 : origin % BOARD_SIZE

    /** 离落点几圈（落点本身是第 0 圈）。 */
    const ringOf = (cell: number): number => {
      if (origin === null) return 0
      const row = Math.floor(cell / BOARD_SIZE)
      const col = cell % BOARD_SIZE
      // 棋盘距离（每走一格算一圈），沿整行整列扩散时就是"第几格"
      return Math.abs(row - originRow) + Math.abs(col - originCol)
    }

    const rings = new Map<number, number[]>()
    for (const cell of cells) {
      const ring = ringOf(cell)
      const bucket = rings.get(ring)
      if (bucket) bucket.push(cell)
      else rings.set(ring, [cell])
    }
    const order = [...rings.keys()].sort((a, b) => a - b)

    for (let i = 0; i < order.length; i++) {
      const group = rings.get(order[i]) ?? []
      if (group.length === 0) continue
      // 这一圈整体烧起来（火焰自身的"点起来"动画由 FlameView 负责）
      this.flames.ignite(group, turns, owner)
      for (const cell of group) {
        const at = cellToWorld(cell, new Vector3())
        at.y = 0.06
        this.effects.shockwave(at, { color: fire.blaze, from: 0.1, to: 1.3, life: 0.6, opacity: 0.42 })
        this.particles.burst(at, {
          count: 9,
          speed: 3.1,
          size: 0.11,
          life: 0.6,
          color: fire.yellow,
          gravity: 1.2,
          spread: 1,
        })
      }
      if (i === 0) this.playSound('fire', 1)
      // 圈与圈之间的时差：越往外越慢一点点，扩散感更明显
      if (i < order.length - 1) await this.animator.wait(0.045)
    }
    this.rig.kick(0.3)
    await this.animator.wait(0.32)
  }

  /** 无敌（精密计算）：一圈结界的金色/特征色光壁 + 全屏涟漪（bugv10 #9）。 */
  private async animateImmune(player: PlayerIndex): Promise<void> {
    const side = this.palette.sides[player]
    const at = this.playerSidePoint(player)
    this.playSound('counter', 1)
    this.playSound('ui', 2)
    this.effects.shockwave(at, { color: side.glow, from: 0.4, to: 4.2, life: 0.9, opacity: 0.55 })
    this.effects.shockwave(at, { color: 0xffffff, from: 0.2, to: 2.6, life: 0.6, opacity: 0.4 })
    this.effects.sunburst(at, side.glow, 2.2)
    this.effects.flash(0.2, side.color)
    this.particles.burst(at, {
      count: 34,
      speed: 3.8,
      size: 0.13,
      life: 0.9,
      color: side.glow,
      gravity: 0.6,
      drag: 1.4,
      spread: 1,
    })
    // 血条方向也亮一下，提示"这段时间打不动"
    const hud = this.hudWorldTarget(player, 0)
    this.effects.impactGlow(hud, side.glow, 1.6)
    this.effects.shockwave(hud, { color: side.glow, from: 0.1, to: 1.8, life: 0.6, opacity: 0.45, flat: true })
    await this.animator.wait(0.5)
  }

  /**
   * 「小一哥」的额外攻击棋子（bugv10 #9）：从**技能槽**飞出来，落到悬浮棋子堆里。
   */
  private async animatePowerBonus(owner: PlayerIndex, count: number): Promise<void> {
    if (count <= 0) return
    const side = this.palette.sides[owner]
    const rect = this.skillRects[owner as 0 | 1]
    for (let i = 0; i < count; i++) {
      const staged = this.spawnStagePiece(owner)
      const target = staged.base.clone()
      let from: Vector3
      if (rect) {
        const canvasRect = this.canvas.getBoundingClientRect()
        const screenX = rect.left + rect.width * 0.5 - canvasRect.left
        const screenY = rect.top + rect.height * 0.5 - canvasRect.top
        from = this.rig.screenToWorld(screenX, screenY, 1.4)?.clone() ?? target.clone().add(new Vector3(0, 3, 2))
      } else {
        from = target.clone().add(new Vector3(owner === 0 ? -3 : 3, 3.4, 2.6))
      }
      staged.base.copy(from)
      staged.mesh.position.copy(from)
      this.particles.burst(from, {
        count: 16,
        speed: 2.8,
        size: 0.12,
        life: 0.5,
        color: side.color,
        gravity: -2,
        spread: 1,
      })
      this.playSound('magic', 2)
      const control = from.clone().lerp(target, 0.5).add(new Vector3(0, 1.4, 0.4))
      const start = from.clone()
      await this.animator.run(0.46, (t) => {
        const a = start.clone().lerp(control, t)
        const b = control.clone().lerp(target, t)
        staged.base.copy(a.lerp(b, t))
        staged.mesh.position.copy(staged.base)
        staged.mesh.rotateZ(t * 2.4)
      })
      staged.base.copy(target)
    }
  }

  /** 某一方"自己那一侧"的空中参考点（技能特效的起点）。 */
  private playerSidePoint(player: PlayerIndex): Vector3 {
    const side = player === 0 ? -1 : 1
    return new Vector3(side * 3.2, 0.35, 1.2)
  }

  /**
   * 落子：**不下落**，直接出现在棋盘内（bugv4 #5），
   * 同时按落点方位给棋盘一个很短的倾斜（bugv4 #4），
   * 并在落点放一圈“更大、更慢、更炫”的涟漪。
   */
  private async animatePlacement(player: PlayerIndex, cell: number, duration = PLACE_DURATION): Promise<void> {
    const side = this.palette.sides[player]
    const mesh = this.pieces.spawn(cell, player)
    const target = cellToWorld(cell, new Vector3())
    target.y = PIECE_HEIGHT / 2

    // 直接出现在棋盘内
    mesh.position.copy(target)
    mesh.scale.setScalar(0.86)
    this.pieces.groundAt(cell)
    this.tiltBoardTowards(cell)

    // 落点涟漪：两层扩散更慢更远的圆环 + 光晕 + 粒子
    // （bugv5 #2：落子不再打全屏大波纹，只留落点附近的小波纹）
    this.effects.shockwave(target, { color: side.color, from: 0.16, to: 2.7, life: 1.05, opacity: 0.55 })
    this.effects.shockwave(target, { color: side.glow, from: 0.45, to: 3.9, life: 1.4, opacity: 0.24 })
    this.effects.impactGlow(target, side.color, 1.15)
    this.particles.burst(target, {
      count: 18,
      speed: 2.4,
      size: 0.13,
      life: 0.75,
      color: side.color,
      gravity: -6,
      spread: 1,
    })
    this.playSound('place')

    await this.animator.run(
      duration,
      (t) => {
        // 出现时轻轻弹一下（不是下落）
        const pop = 1 + Math.sin(Math.PI * Math.min(t * 1.5, 1)) * 0.14
        mesh.scale.setScalar(0.86 + (pop - 1) * 1.6)
      },
      { ease: Easing.linear },
    )
    mesh.scale.setScalar(1)
  }

  /**
   * 落子后棋盘按落点方位短暂倾斜（bugv4 #4）：
   * 靠上 / 靠下决定俯仰方向，靠左 / 靠右决定侧倾方向，离中心越远角度越大，随后自行回正。
   */
  private tiltBoardTowards(cell: number): void {
    const row = Math.floor(cell / BOARD_SIZE)
    const col = cell % BOARD_SIZE
    const half = (BOARD_SIZE - 1) / 2
    const forward = (row - half) / half // -1（最上）.. 1（最下）
    const sideways = (col - half) / half // -1（最左）.. 1（最右）
    const peakX = forward * PLACE_TILT
    const peakZ = -sideways * PLACE_TILT

    void this.animator.run(
      PLACE_TILT_DURATION,
      (t) => {
        // 快速压向落点一侧，再平滑回正
        const envelope = Math.sin(Math.PI * Math.min(1, t * 1.4))
        this.placeTilt.x = peakX * envelope
        this.placeTilt.z = peakZ * envelope
      },
      { ease: Easing.linear },
    )
  }

  /** 形成连珠：发光带 + 逐颗脉冲 + 粒子。 */
  private async animateMatch(owner: PlayerIndex, lines: readonly (readonly number[])[]): Promise<void> {
    const side = this.palette.sides[owner]
    const cells = new Set<number>()
    for (const line of lines) {
      for (const cell of line) cells.add(cell)
      this.effects.matchBeam(line, side.color)
    }

    this.rig.kick(0.45)
    this.effects.flash(0.25)
    this.pieces.setMatchGlow(1)
    this.board.flashCells([...cells], side.color)
    this.playSound('match', lines.length > 1 ? Math.max(...lines.map((line) => line.length)) : lines[0]?.length ?? 4)

    for (const cell of cells) {
      const position = cellToWorld(cell, new Vector3())
      position.y = PIECE_HEIGHT / 2
      this.particles.burst(position, {
        count: 9,
        speed: 2.3,
        size: 0.15,
        life: 0.5,
        color: side.color,
        gravity: -4,
      })
    }

    await this.animator.run(0.42, (t) => {
      const pulse = Math.sin(Math.PI * t)
      for (const cell of cells) {
        const mesh = this.pieces.get(cell)
        if (mesh) mesh.scale.setScalar(1 + pulse * 0.18)
      }
    })

    this.pieces.setMatchGlow(0)
    for (const cell of cells) {
      const mesh = this.pieces.get(cell)
      if (mesh) mesh.scale.setScalar(1)
    }
  }

  /**
   * 连珠棋子离开棋盘：飞到**自己那一侧**贴近屏幕边缘的空中舞台悬停翻滚。
   * `highlight` 为 true 时在原位置留下高光（仅攻击方，规则 4.1.4）。
   *
   * bugv10 #9：`kept` 里的格子只飞走"叠上去的那一颗"，底下的原棋子留在棋盘上。
   */
  private async animateRemoval(
    player: PlayerIndex,
    cells: readonly number[],
    highlight: boolean,
    kept: readonly number[] = [],
  ): Promise<void> {
    if (cells.length === 0) return
    const keptSet = new Set(kept)

    const flight = cells.map((cell, index) => {
      // 这一格原来的棋子已经在舞台上了（重复事件 / 已处理过）→ 跳过
      const staged = this.stagedByCell.get(cell)
      if (staged && !this.pieces.get(cell)) return null

      // 注意：上面这条判断不能只看 stagedByCell —— 防守方在攻击方高光位落子并成线时
      // （bugv3 #5），这一格已经放了**新**棋子，而 stagedByCell 里记录的是早已飞走的那颗，
      // 新棋子必须照常离场。
      let mesh: Mesh | null
      if (keptSet.has(cell)) {
        // 叠子：只取走上面那一颗（bugv10 #9）
        mesh = this.pieces.takeOverlay(cell, { keep: true })
      } else {
        mesh = this.pieces.get(cell)
        // 模型领先于动画时的兜底：补生成一颗再送上舞台
        if (!mesh) mesh = this.pieces.spawn(cell, player)
        mesh = this.pieces.despawn(cell, { keep: true })
      }
      if (!mesh) return null
      this.pieces.detachToStage(mesh)
      const target = this.stageAnchor(player, index)
      const from = mesh.position.clone()
      return { mesh, from, target }
    })

    for (const item of flight) {
      if (!item) continue
      this.particles.burst(item.from, {
        count: 7,
        speed: 1.5,
        size: 0.12,
        life: 0.4,
        color: this.palette.sides[player].color,
        gravity: -3,
      })
    }
    this.rig.kick(0.3)

    await this.animator.run(
      0.66,
      (t) => {
        const eased = 1 - (1 - t) ** 3
        for (const item of flight) {
          if (!item) continue
          const arc = Math.sin(Math.PI * t) * 1.8
          item.mesh.position.lerpVectors(item.from, item.target, eased)
          item.mesh.position.y += arc
          item.mesh.rotateY(t * 0.2)
          item.mesh.rotateX(t * 0.1)
        }
      },
      { ease: Easing.linear },
    )

    cells.forEach((cell, index) => {
      const item = flight[index]
      if (!item) return
      this.adoptStaged(item.mesh, player, cell)
    })

    if (!highlight) return
    // 攻击方原位置留下高光
    const weights = cells.map((cell) => this.pendingWeights.get(cell) ?? 1)
    this.board.showHighlights(cells, weights, player, 0.9)
    this.effects.highlightPulse(cells, this.palette.sides[player].color)
  }

  /**
   * 把一颗飞行完毕的棋子登记到攻击舞台（bugv9 #6 抽出，供补位复用）。
   */
  private adoptStaged(mesh: Mesh, owner: PlayerIndex, cell?: number): StagedPiece {
    const staged: StagedPiece = {
      mesh,
      owner,
      spinAxis: new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
      // 悬浮时的自由翻转：加快 50%（bugv3 #4）
      spinSpeed: (0.9 + Math.random() * 0.9) * SPIN_UP,
      bobPhase: Math.random() * Math.PI * 2,
      base: mesh.position.clone(),
      magic: this.createMagic(owner),
    }
    this.staged.push(staged)
    if (cell !== undefined) this.stagedByCell.set(cell, staged)
    return staged
  }

  /**
   * 直接生成一颗悬浮棋子（没有对应的棋盘格）。
   *
   * 用途：① 魔力植物带来的额外攻击棋子；② 回放跳到攻击阶段时把舞台补出来。
   */
  private spawnStagePiece(owner: PlayerIndex): StagedPiece {
    const mesh = this.pieces.spawnDetached(owner)
    const base = this.stageAnchor(owner, this.stagedCount(owner))
    mesh.position.copy(base)
    return this.adoptStaged(mesh, owner)
  }

  /**
   * 让舞台上的悬浮棋子数量与**总攻击数**严格一致（bugv9 #6）。
   *
   * 需求原文的 bug：4 连珠时防守方在高光位落子会削弱 1 点攻击，但悬浮棋子还是 4 颗，
   * 最后留下一颗永远飞不出去；反过来魔力植物会让总攻击数 +1，却只有 4 颗棋子。
   *
   * 这里按 `tally` 多退少补：多出来的当场炸成碎片（视觉上就是"被抵消掉"），
   * 不够的补生成一颗悬浮棋子。
   */
  async reconcileStage(tally: readonly [number, number], only?: PlayerIndex): Promise<void> {
    const surplus: StagedPiece[] = []
    const owners: PlayerIndex[] = only === undefined ? [0, 1] : [only]
    for (const owner of owners) {
      const desired = Math.max(0, Math.round(tally[owner] ?? 0))
      let current = this.stagedCount(owner)
      while (current < desired) {
        this.spawnStagePiece(owner)
        current += 1
      }
      while (current > desired) {
        const victim = [...this.staged].reverse().find((item) => item.owner === owner)
        if (!victim) break
        surplus.push(victim)
        this.releaseStaged(victim)
        current -= 1
      }
    }
    if (surplus.length === 0) return
    // 多出来的棋子被"抵消"：炸成碎片 + 一圈冲击波，玩家能看懂数量为什么少了
    for (const item of surplus) {
      const at = item.mesh.position.clone()
      this.pieces.shatter(item.mesh, item.owner, at)
      this.effects.shockwave(at, {
        color: this.palette.sides[item.owner].color,
        from: 0.15,
        to: 0.9,
        life: 0.42,
        opacity: 0.5,
        flat: false,
      })
      this.particles.burst(at, {
        count: 10,
        speed: 3.4,
        size: 0.11,
        life: 0.42,
        color: this.palette.sides[item.owner].glow,
        gravity: -6,
        drag: 2.4,
      })
    }
    this.playSound('counter')
    await this.animator.wait(0.2)
  }

  /**
   * 回放专用：把攻击阶段的舞台一次性补出来（bugv9 #9）。
   *
   * 回放跳步不会播放"棋子飞到舞台"的过程，因此这里直接按总攻击数把悬浮棋子摆好；
   * 高光、攻击模式也一并恢复，于是后续的对撞 / 撞击血条动画与真实对局完全一致。
   */
  stageFromHighlights(
    owner: PlayerIndex,
    cells: readonly number[],
    weights: readonly number[],
    tally: readonly [number, number],
  ): void {
    this.pendingWeights = new Map(cells.map((cell, index) => [cell, weights[index] ?? 1]))
    this.board.showHighlights(cells, weights, owner, 0.9)
    this.setAttackMode(true)
    void this.reconcileStage(tally)
  }

  /** 舞台棋子数量（按归属）。 */
  stageCount(owner: PlayerIndex): number {
    return this.stagedCount(owner)
  }

  /** 把某一方的悬浮棋子补到指定数量（只补不删）。 */
  private ensureStageCount(owner: PlayerIndex, want: number): void {
    const desired = Math.max(0, Math.round(want))
    while (this.stagedCount(owner) < desired) this.spawnStagePiece(owner)
  }

  /**
   * 攻击结算：双方棋子**始终留在自己那一侧**，
   * 防守方也成线时先一起移到棋盘左右两侧（入位）再逐对相撞，
   * 剩余棋子最后逐颗撞向劣势方血条。
   *
   * 注意：舞台棋子每帧会按 `base` 做悬停浮动（`updateStaged`），
   * 因此所有“飞行”动画都必须写入 `base`，而不是直接写 `mesh.position`，
   * 否则会被浮动逻辑覆盖掉。
   */
  private async animateAttackResolved(event: Extract<GameEvent, { type: 'attackResolved' }>): Promise<void> {
    const { snapshot, clashCount, damage } = event
    // bugv10 #9「精密计算」：伤害被无敌完全挡下 —— 播一圈结界，不撞血条
    if (snapshot.mode === 'immune') {
      await this.animateImmuneBlock(snapshot.damaged ?? snapshot.defender)
      await this.dismissStaged([...this.staged])
      return
    }
    // bugv10 #9：结算前先把两侧的悬浮棋子补齐到总攻击数，
    // 这样"参与对撞的数量"与"飞向血条的数量"永远与面板上的数字对得上
    // （也顺带修好了回放跳步后直接进结算时舞台上没有棋子的情况，bugv9 #9）
    this.ensureStageCount(snapshot.attacker, snapshot.finalAttack - (snapshot.powerBonus ?? 0))
    this.ensureStageCount(snapshot.defender, snapshot.defenderAttack)
    // 「小一哥」额外的那几颗从技能槽飞出来（攻击方的加成棋子）
    await this.animatePowerBonus(snapshot.attacker, snapshot.powerBonus ?? 0)
    const attackerPieces = this.staged.filter((item) => item.owner === snapshot.attacker)
    const defenderPieces = this.staged.filter((item) => item.owner === snapshot.defender)

    const pairCount = Math.min(clashCount, attackerPieces.length, defenderPieces.length)
    // 防守方也有连珠（即将进入抵消）→ 插入 1.5 秒的“入位”动画（bugv4 #8）
    if (pairCount > 0) {
      await this.gatherForClash(attackerPieces, defenderPieces)
    }

    // 一颗一颗对撞（规则 6.3.2）：各自从己侧冲向中央
    for (let i = 0; i < pairCount; i++) {
      await this.runClash(attackerPieces[i], defenderPieces[i], this.clashPointFor(), i)
    }

    // 剩余棋子飞向劣势方血条（规则 5.3 / 6.3.5）：
    // 撞血条的必须是**赢的一方**（血量劣势方的对手）的棋子
    const target: PlayerIndex | null = damage > 0 ? snapshot.damaged ?? snapshot.defender : null
    if (target !== null) {
      const striker = other(target)
      const strikers = this.staged.filter((item) => item.owner === striker).slice(0, damage)
      await this.flyToHud(strikers, target)
    }
    await this.dismissStaged([...this.staged])
  }

  /**
   * 抵消前的“入位”：双方的攻击棋子从屏幕边缘移到**棋盘左右两侧**
   * （比页面两侧更靠内），耗时 1.5 秒，然后再开始逐对对撞（bugv4 #8）。
   *
   * 注意（bugv5 #1）：棋子去哪一侧只由**属于哪一方**决定（player 0 = 左、player 1 = 右），
   * 与谁是攻击方无关 —— 否则后手方发起攻击时两边棋子会交换位置跑到对面去。
   */
  private async gatherForClash(
    attackerPieces: readonly StagedPiece[],
    defenderPieces: readonly StagedPiece[],
  ): Promise<void> {
    const plan = (list: readonly StagedPiece[]) =>
      list.map((item, index) => {
        const side = item.owner === 0 ? -1 : 1
        // 每一方按行堆叠，列与列之间略微错开，避免完全重叠
        const row = index % 4
        const column = Math.floor(index / 4)
        return {
          item,
          from: item.base.clone(),
          target: new Vector3(
            side * (GATHER_X + column * 0.55),
            GATHER_Y - row * 0.42,
            -0.5 + (index % 2) * 0.6,
          ),
        }
      })

    const plans = [...plan(attackerPieces), ...plan(defenderPieces)]
    if (plans.length === 0) return

    this.playSound('ui')
    await this.animator.run(
      GATHER_DURATION,
      (t) => {
        const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
        for (const entry of plans) {
          entry.item.base.lerpVectors(entry.from, entry.target, eased)
          entry.item.mesh.position.copy(entry.item.base)
        }
      },
      { ease: Easing.linear },
    )
  }

  /**
   * 单次对撞的撞击点（bugv9 #1）。
   *
   * 原来是**固定**在 `(0, CLASH_HEIGHT, 0.2)` + `(i % 3) * 0.12` 上，于是每一局看起来
   * 都撞在同一个位置。现在改成在屏幕中间一块区域内随机浮动：
   *
   * - 用 NDC 描述范围，因此任何画幅下都在**屏幕内**；
   * - 左右在中间 ±0.26 内浮动，上下围绕原来的高度 ±0.2 浮动。
   */
  private clashPointFor(): Vector3 {
    const ndcX = (Math.random() * 2 - 1) * CLASH_NDC_X_RANGE
    const baseY = this.rig.worldToNdc(CLASH_BASE_POINT).y
    const ndcY = baseY + (Math.random() * 2 - 1) * CLASH_NDC_Y_RANGE
    const point = this.rig.ndcPoint(ndcX, ndcY, this.rig.distance * STAGE_DEPTH, new Vector3())
    // 记下最近一次的对撞点（验证脚本 / 调试用）
    this.lastClashPoint = [point.x, point.y, point.z]
    this.lastClashNdc = [ndcX, ndcY]
    return point
  }

  /** 单次对撞：两颗棋子沿**弧线**相向飞行 + 光芒炸裂 + 粒子爆发 + 全屏波纹（bugv2 #6 / bugv4 #6 / bugv9 #1）。 */
  private async runClash(left: StagedPiece, right: StagedPiece, clashPoint: Vector3, index: number): Promise<void> {
    const fromLeft = left.base.clone()
    const fromRight = right.base.clone()
    const targetLeft = clashPoint.clone().add(new Vector3(-0.3, 0, 0))
    const targetRight = clashPoint.clone().add(new Vector3(0.3, 0, 0))

    /**
     * bugv9 #1：飞行轨道不再是直线 —— 给每条轨道一个随机的二次贝塞尔控制点，
     * 控制点在"水平面内的垂直方向"上随机偏移，并叠一个随机抬升，
     * 于是同一对棋子的两条轨迹会各自绕出一个弧度不同的弧线。
     */
    const arc = (from: Vector3, to: Vector3): Vector3 => {
      const direction = to.clone().sub(from)
      const lateral = new Vector3(direction.z, 0, -direction.x)
      if (lateral.lengthSq() < 1e-5) lateral.set(1, 0, 0)
      lateral.normalize()
      return from
        .clone()
        .lerp(to, 0.5)
        .addScaledVector(lateral, (Math.random() * 2 - 1) * CLASH_ARC_SIDE)
        .add(new Vector3(0, CLASH_ARC_LIFT_MIN + Math.random() * CLASH_ARC_LIFT_RANGE, 0))
    }
    const controlLeft = arc(fromLeft, targetLeft)
    const controlRight = arc(fromRight, targetRight)
    const scratch = new Vector3()

    /** 二次贝塞尔求值（写进 out）。 */
    const bezier = (from: Vector3, control: Vector3, to: Vector3, t: number, out: Vector3): Vector3 => {
      const a = from.clone().lerp(control, t)
      const b = control.clone().lerp(to, t)
      return out.copy(a.lerp(b, t))
    }

    // 记录本次轨道（起点 / 中点 / 终点），供验证脚本判断"不是直线"（bugv9 #1）
    this.lastClashTrack = {
      left: {
        from: fromLeft.toArray() as [number, number, number],
        mid: bezier(fromLeft, controlLeft, targetLeft, 0.5, scratch).toArray() as [number, number, number],
        to: targetLeft.toArray() as [number, number, number],
      },
      right: {
        from: fromRight.toArray() as [number, number, number],
        mid: bezier(fromRight, controlRight, targetRight, 0.5, scratch).toArray() as [number, number, number],
        to: targetRight.toArray() as [number, number, number],
      },
    }

    // 相向飞行时略微拉伸，强化“撞”的速度感（bugv3 #3：整体加速 50%）
    await this.animator.run(0.24 * ACTION_SCALE, (t) => {
      const eased = t * t
      left.base.copy(bezier(fromLeft, controlLeft, targetLeft, eased, scratch))
      right.base.copy(bezier(fromRight, controlRight, targetRight, eased, scratch))
      left.mesh.position.copy(left.base)
      right.mesh.position.copy(right.base)
      // 弧线飞行时翻滚一下，更明显能看出走的不是直线
      left.mesh.rotateZ(t * 1.6)
      right.mesh.rotateZ(-t * 1.6)
      const stretch = 1 + t * 0.35
      left.mesh.scale.set(stretch, 1 - t * 0.12, stretch)
      right.mesh.scale.set(stretch, 1 - t * 0.12, stretch)
    })

    // 撞击瞬间：太阳式爆发 + 光芒炸裂 + 碎片 + 双向粒子 + 全屏波纹 + 震屏
    const mixed = new Color(this.palette.sides[left.owner].color).lerp(
      new Color(this.palette.sides[right.owner].color),
      0.5,
    )
    const mixedHex = mixed.getHex()
    // 两颗棋子当场炸开成碎片（bugv5 #8），并使用它们的实际位置作为爆发中心；
    // 每颗都传入对手，碎片里会同时出现两种特征色（bugv6 #6）
    const leftAt = left.mesh.position.clone()
    const rightAt = right.mesh.position.clone()
    this.pieces.shatter(left.mesh, left.owner, leftAt, right.owner)
    this.pieces.shatter(right.mesh, right.owner, rightAt, left.owner)
    // 太阳的中心偏白（白热核心 + 特征色日冕），否则混色看起来像紫色烟花
    this.effects.sunburst(clashPoint, mixed.clone().lerp(new Color(0xffffff), 0.55).getHex(), 3.4)
    this.playBlast(clashPoint, mixedHex, { strength: 0.95, flat: false })
    this.particles.burst(clashPoint, {
      count: 46,
      speed: 7.4,
      size: 0.19,
      life: 0.62,
      color: 0xffffff,
      gravity: -1.6,
      drag: 2.6,
      spread: 1,
    })
    this.particles.burst(clashPoint, {
      count: 30,
      speed: 5,
      size: 0.17,
      life: 0.78,
      color: this.palette.sides[right.owner].color,
      gravity: -1.2,
      drag: 1.8,
      spread: 1,
    })
    this.particles.burst(clashPoint, {
      count: 30,
      speed: 5,
      size: 0.17,
      life: 0.78,
      color: this.palette.sides[left.owner].color,
      gravity: -1.2,
      drag: 1.8,
      spread: 1,
    })
    this.playSound('clash', index)

    // 对撞后消散（bugv5 #8：棋子已经碎掉了，这里只做一点余韵）
    await this.animator.run(0.2 * ACTION_SCALE, (t) => {
      left.mesh.scale.setScalar(Math.max(1 - t * 1.6, 0.01))
      right.mesh.scale.setScalar(Math.max(1 - t * 1.6, 0.01))
    })

    this.releaseStaged(left)
    this.releaseStaged(right)
  }

  /** 剩余的棋子在原地淡出。 */
  private async dismissStaged(items: readonly StagedPiece[]): Promise<void> {
    if (items.length === 0) return
    await this.animator.run(0.28, (t) => {
      for (const item of items) item.mesh.scale.setScalar(Math.max(1 - t, 0.01))
    })
    for (const item of items) this.releaseStaged(item)
  }

  /** 悬浮棋子的“魔法阵”：两个交错的正方形 + 外圈，特征色、持续旋转（bugv5 #10）。 */
  private createMagic(owner: PlayerIndex): Mesh | null {
    // 尺寸贴着棋子（略大一圈）；bugv8 #5 把贴图里的正方形收小以露出四个角，
    // 这里等比例放大一点，视觉大小基本不变
    const magic = this.effects.createMagicMesh(owner, PIECE_RADIUS * 2.9)
    if (!magic) return null
    magic.userData.helper = true
    this.scene.add(magic)
    return magic
  }

  private disposeMagic(magic: Mesh | null): void {
    if (!magic) return
    magic.removeFromParent()
    const material = magic.material as MeshBasicMaterial
    material.dispose()
    magic.geometry.dispose()
  }

  private releaseStaged(item: StagedPiece): void {
    this.disposeMagic(item.magic)
    this.pieces.recycle(item.mesh)
    this.staged = this.staged.filter((entry) => entry !== item)
    for (const [cell, entry] of this.stagedByCell) {
      if (entry === item) this.stagedByCell.delete(cell)
    }
  }

  /** 逐颗飞向血条并触发撞击回调。 */
  private async flyToHud(items: readonly StagedPiece[], target: PlayerIndex): Promise<void> {
    if (items.length === 0) return
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const hudTarget = this.hudWorldTarget(target, i)
      const from = item.base.clone()
      const control = from.clone().lerp(hudTarget, 0.5).add(new Vector3(0, 1.6, 0.6))

      // 二次贝塞尔：飞出弧线（写入 base，避免被悬停浮动覆盖）；bugv3 #3 加速 50%
      await this.animator.run(0.42 * ACTION_SCALE, (t) => {
        // 二次贝塞尔：飞出弧线（写入 base，避免被悬停浮动覆盖）
        const a = from.clone().lerp(control, t)
        const b = control.clone().lerp(hudTarget, t)
        item.base.copy(a.lerp(b, t))
        item.mesh.position.copy(item.base)
        item.mesh.rotateZ(t * 2.2)
        item.mesh.scale.setScalar(1 - t * 0.2)
      })

      // 撞击血条：太阳式爆发 + 同级的全场特效 + 逐颗音效（bugv2 #1 / #6 / bugv5 #8）
      this.hooks.onImpact?.(target, i)
      const impactColor = this.palette.sides[target].color
      this.pieces.shatter(item.mesh, item.owner, hudTarget)
      // 撞击血条：白热核心 + 受击方特征色日冕
      this.effects.sunburst(hudTarget, new Color(impactColor).lerp(new Color(0xffffff), 0.5).getHex(), 3)
      this.playBlast(hudTarget, impactColor, { strength: 0.92, flat: true })
      this.particles.burst(hudTarget, {
        count: 40,
        speed: 5.6,
        size: 0.18,
        life: 0.66,
        color: impactColor,
        gravity: -1,
        drag: 2.4,
        spread: 1,
      })
      this.particles.burst(hudTarget, {
        count: 18,
        speed: 7.6,
        size: 0.12,
        life: 0.5,
        color: 0xffffff,
        gravity: -2,
        drag: 3,
      })
      this.playSound('impact', i)
      this.releaseStaged(item)
    }
  }

  /**
   * 血条命中点：优先使用宿主提供的 HUD 屏幕矩形换算成世界坐标，
   * 否则退化为画面左右上方的空中位置。
   */
  private hudWorldTarget(player: PlayerIndex, index: number): Vector3 {
    const rect = this.hudRects[player as 0 | 1]
    if (rect) {
      const canvasRect = this.canvas.getBoundingClientRect()
      const x = rect.left + rect.width * 0.5 - canvasRect.left
      const y = rect.top + rect.height * 0.55 - canvasRect.top
      const world = this.rig.screenToWorld(x, y, 1.6)
      if (world) return world.clone().add(new Vector3(0, (index % 3) * 0.12, 0))
    }
    const side = player === 0 ? -1 : 1
    return new Vector3(side * 5.4, 2.6 + (index % 3) * 0.28, 1.6)
  }

  /** 记录当前攻击方（宿主在攻击阶段开始时调用）。 */
  setAttacker(attacker: PlayerIndex | null): void {
    if (attacker === null) return
    this.setHoverColor(this.palette.sides[attacker].color)
  }

  /**
   * 连珠提示针（bugv5 #7 / bugv9 #3）：落子后如果"再补一颗就能成线"，
   * 在该方向上拉出很长的针状提示线；"2 + 1 中间空一格"时还会把那一格单独圈出来。
   */
  showThreatHints(
    cell: number,
    hints: ReadonlyArray<{ direction: readonly [number, number]; gap: number }>,
    owner: PlayerIndex,
  ): void {
    if (hints.length === 0) return
    const color = this.palette.sides[owner].glow
    for (const hint of hints) this.effects.threatHint(cell, hint.direction, color, { gap: hint.gap })
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost)
    this.animator.clear()
    this.board.dispose()
    this.pieces.dispose()
    this.effects.dispose()
    this.particles.dispose()
    this.magic.dispose()
    this.flames.dispose()
    this.ripple.dispose()
    this.screenFlash.dispose()
    this.audio.dispose()
    this.renderer.dispose()
  }
}

/** 便于外部复用：计算某个交点的世界坐标。 */
export function cellWorldPosition(cell: number, out = new Vector3()): Vector3 {
  return cellToWorld(cell, out).setY(PIECE_HEIGHT / 2)
}

export { CELL_SIZE }
