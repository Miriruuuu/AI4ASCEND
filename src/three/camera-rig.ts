/**
 * 摄像机机位：轻微俯视 + 随鼠标的细微偏移（视差）+ 受击震屏。
 *
 * 棋盘本身也会跟着鼠标做很小的旋转 / 位移（见 `SceneController`），
 * 两者叠加形成“3D 棋盘随鼠标移动”的手感。
 */
import { PerspectiveCamera, Vector3 } from 'three'
import { clamp, damp } from './anim'

export interface CameraRigOptions {
  /** 视差强度（0 关闭）。 */
  parallax?: number
  /** 基础仰角（弧度）。 */
  pitch?: number
  /** 距离（缺省按视口宽高比自动计算，保证棋盘完整入镜）。 */
  distance?: number
}

const BASE_PITCH = 0.92
const DEFAULT_DISTANCE = 15.4
/**
 * 取景范围：棋盘交点跨度 ±4，网格线再向外延伸 1.4（无边界观感）。
 * 这里以交点区域为准并留出边距，避免线条延伸把主体挤小。
 */
const BOARD_HALF = 4.75
/** 棋盘占视口的比例（其余留给左上 / 右上的玩家 HUD）。 */
const FILL_RATIO = 0.92

/** 试算取景距离时使用的候选值。 */
const DISTANCE_CANDIDATES = Array.from({ length: 65 }, (_, index) => 8 + index * 0.5)

/**
 * bugv26 #2：双指缩放（仅手机端）的倍率范围。
 *
 * 倍率是**距离的乘数**：< 1 拉近（棋盘变大）、> 1 拉远。
 */
const MIN_ZOOM = 0.62
const MAX_ZOOM = 1.4

export class CameraRig {
  readonly camera = new PerspectiveCamera(38, 1, 0.1, 200)

  /** 归一化指针位置（-1..1）。 */
  private pointer = { x: 0, y: 0 }
  /** 平滑后的指针位置。 */
  private smooth = { x: 0, y: 0 }
  private shake = { x: 0, y: 0, z: 0, strength: 0 }
  private time = 0
  private readonly parallax: number
  private readonly basePitch: number
  private readonly baseDistance: number
  private readonly autoDistance: boolean
  private readonly target = new Vector3(0, -0.65, 0)
  /** 当前机位到取景目标的距离（最近一帧）。 */
  private viewDistance = DEFAULT_DISTANCE
  /** bugv26 #2：双指缩放倍率（1 = 自动取景）。 */
  private zoom = 1
  /** 一次双指手势开始时的倍率（`pinchUpdate` 以它为基准）。 */
  private pinchBase = 1
  private viewWidth = 1
  private viewHeight = 1
  /** 取景距离缓存（仅与视口宽高比有关）。 */
  private fittedCache: { aspect: number; distance: number } | null = null

  constructor(options: CameraRigOptions = {}) {
    this.parallax = options.parallax ?? 1
    this.basePitch = options.pitch ?? BASE_PITCH
    this.autoDistance = options.distance === undefined
    this.baseDistance = options.distance ?? DEFAULT_DISTANCE
    this.place(0, 0, 1)
  }

  setPointer(x: number, y: number): void {
    this.pointer.x = Math.max(-1, Math.min(1, x))
    this.pointer.y = Math.max(-1, Math.min(1, y))
  }

  /** 触发一次震屏。 */
  kick(strength = 0.5): void {
    this.shake.strength = Math.min(1.6, this.shake.strength + strength)
  }

  /**
   * bugv26 #2：双指缩放。
   *
   * - `beginPinch()`：手势开始（记住当前倍率当基准）；
   * - `pinchUpdate(scale)`：`scale` = 两指距离相对手势起点的比值
   *   （> 1 拉近放大、< 1 拉远缩小）；
   * - `setZoom(1)`：回到自动取景。
   *
   * 倍率会写进 `distance`，因此 `ndcPoint` / `worldToScreen` 等换算自动跟着走。
   */
  beginPinch(): void {
    this.pinchBase = this.zoom
  }

  pinchUpdate(scale: number): void {
    if (!Number.isFinite(scale) || scale <= 0) return
    this.zoom = clamp(this.pinchBase / scale, MIN_ZOOM, MAX_ZOOM)
  }

  setZoom(zoom: number): void {
    this.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM)
  }

  /** 当前缩放倍率（1 = 自动取景）。 */
  get zoomLevel(): number {
    return this.zoom
  }

  resize(width: number, height: number): void {
    this.viewWidth = Math.max(width, 1)
    this.viewHeight = Math.max(height, 1)
    this.camera.aspect = this.viewWidth / this.viewHeight
    this.camera.updateProjectionMatrix()
  }

  update(dt: number): void {
    this.time += dt
    this.smooth.x = damp(this.smooth.x, this.pointer.x, 2.6, dt)
    this.smooth.y = damp(this.smooth.y, this.pointer.y, 2.6, dt)

    // 呼吸感：极缓慢的上下浮动
    const breathe = Math.sin(this.time * 0.45) * 0.12

    this.shake.strength = Math.max(0, this.shake.strength - dt * 2.6)
    const shakeAmount = this.shake.strength ** 2 * 0.55
    this.shake.x = Math.sin(this.time * 61) * shakeAmount
    this.shake.y = Math.cos(this.time * 47) * shakeAmount * 0.7
    this.shake.z = Math.sin(this.time * 39) * shakeAmount * 0.3

    this.place(this.smooth.x, this.smooth.y, 1, breathe)
  }

  /**
   * 按视口宽高比计算取景距离：把棋盘四角投影到 NDC，
   * 取满足“完整入镜 + 目标填充率”的最小距离。
   */
  private fittedDistance(): number {
    const aspect = this.camera.aspect
    if (this.fittedCache && this.fittedCache.aspect === aspect) return this.fittedCache.distance

    const probe = this.camera.clone()
    probe.aspect = aspect
    probe.updateProjectionMatrix()

    const corners = [
      new Vector3(-BOARD_HALF, 0, -BOARD_HALF),
      new Vector3(BOARD_HALF, 0, -BOARD_HALF),
      new Vector3(BOARD_HALF, 0, BOARD_HALF),
      new Vector3(-BOARD_HALF, 0, BOARD_HALF),
    ]

    let fallback = DEFAULT_DISTANCE
    for (const distance of DISTANCE_CANDIDATES) {
      const horizontal = Math.cos(this.basePitch) * distance
      probe.position.set(0, Math.sin(this.basePitch) * distance, horizontal)
      probe.lookAt(this.target)
      probe.updateMatrixWorld(true)
      probe.updateProjectionMatrix()

      let maxX = 0
      let maxY = 0
      for (const corner of corners) {
        const ndc = corner.clone().project(probe)
        maxX = Math.max(maxX, Math.abs(ndc.x))
        maxY = Math.max(maxY, Math.abs(ndc.y))
      }

      fallback = distance
      if (maxX <= FILL_RATIO && maxY <= FILL_RATIO) {
        this.fittedCache = { aspect, distance }
        return distance
      }
    }
    this.fittedCache = { aspect, distance: fallback }
    return fallback
  }

  private place(px: number, py: number, dampFactor: number, breathe = 0): void {
    const yaw = px * 0.115 * this.parallax
    const pitch = this.basePitch - py * 0.07 * this.parallax
    const base = this.autoDistance ? this.fittedDistance() : this.baseDistance
    // bugv26 #2：双指缩放只改"离棋盘多远"，不动取景/视差逻辑
    const distance = base * this.zoom * (1 - Math.abs(py) * 0.012) * dampFactor
    this.viewDistance = distance

    const horizontal = Math.cos(pitch) * distance
    const x = Math.sin(yaw) * horizontal + this.shake.x
    const z = Math.cos(yaw) * horizontal + this.shake.z
    const y = Math.sin(pitch) * distance + breathe + this.shake.y

    this.camera.position.set(x, y, z)
    this.camera.lookAt(this.target)
  }

  /** 取景距离：把屏幕锚点换算到和棋盘同一景深时使用。 */
  get distance(): number {
    return this.viewDistance
  }

  /**
   * 归一化屏幕坐标（NDC，-1..1，y 向上）→ 沿视线方向距离为 `distance` 的世界坐标。
   *
   * 用于把“贴着屏幕边缘”的舞台位置换算到世界里，这样无论画幅宽高比如何
   * 都不会跑到画面外（bugv3 #1 / #4）。
   */
  ndcPoint(x: number, y: number, distance: number, out = new Vector3()): Vector3 {
    const projected = new Vector3(x, y, 0.5).unproject(this.camera)
    const direction = projected.sub(this.camera.position).normalize()
    return out.copy(this.camera.position).addScaledVector(direction, distance)
  }

  /** 棋盘自身随鼠标的细微偏移（位置 + 旋转幅度）。 */
  boardTilt(): { offsetX: number; offsetZ: number; rotateZ: number; rotateX: number } {
    return {
      offsetX: this.smooth.x * 0.2 * this.parallax,
      offsetZ: this.smooth.y * 0.16 * this.parallax,
      rotateZ: -this.smooth.x * 0.012 * this.parallax,
      rotateX: this.smooth.y * 0.012 * this.parallax,
    }
  }

  /** 世界坐标 -> 屏幕像素（相对画布）。 */
  worldToScreen(point: Vector3): { x: number; y: number } {
    const projected = point.clone().project(this.camera)
    return {
      x: ((projected.x + 1) / 2) * this.viewWidth,
      y: ((1 - projected.y) / 2) * this.viewHeight,
    }
  }

  /** 世界坐标 -> 归一化屏幕坐标（NDC，-1..1，y 向上）。 */
  worldToNdc(point: Vector3): { x: number; y: number } {
    const projected = point.clone().project(this.camera)
    return { x: projected.x, y: projected.y }
  }

  setViewSize(width: number, height: number): void {
    this.viewWidth = Math.max(width, 1)
    this.viewHeight = Math.max(height, 1)
  }

  /**
   * 屏幕像素 -> 与棋盘平面 y = height 相交的世界坐标。
   */
  screenToWorld(x: number, y: number, planeY = 0.4): Vector3 | null {
    const ndc = new Vector3((x / this.viewWidth) * 2 - 1, -(y / this.viewHeight) * 2 + 1, 0.5)
    ndc.unproject(this.camera)
    const direction = ndc.sub(this.camera.position).normalize()
    if (Math.abs(direction.y) < 1e-4) return null
    const t = (planeY - this.camera.position.y) / direction.y
    if (t <= 0) return null
    return this.camera.position.clone().add(direction.multiplyScalar(t))
  }
}
