/**
 * 鼠标拖尾（bugv6 #3 → bugv7 #2 重做）。
 *
 * 前两版都不对：
 * - bugv5 是「一排 CSS 圆点 + 递增 transition 延迟」，像糊在一起的斑点；
 * - bugv6 用了 `cursor-effects` 的粒子（先 trailingCursor 再 characterCursor），
 *   效果像**放烟花**：粒子四散、大小随机、还带星点，根本不像"尾巴"。
 *
 * 现在自己画一条**彗星式拖尾**：记录光标最近约半秒的轨迹点，每帧用多段线
 * 描出来，越靠尾端越细越淡，头部保留一颗亮点。整条尾迹是**连续的**（相邻采样点
 * 之间直接连线，所以鼠标再快也不会断开），颜色统一为蓝，只在头部略微提亮。
 *
 * 只有一个覆盖层 canvas，每帧最多 ~50 段描边、DOM 里没有任何逐帧元素；
 * `prefers-reduced-motion` 与触摸设备下不启用。
 */

/** 拖尾蓝（bugv7 #2 明确要求）：尾部 → 头部三档蓝。 */
export const TRAIL_TAIL = '#1f5fd0'
export const TRAIL_BLUE = '#2b7fff'
export const TRAIL_HEAD = '#9ecbff'

/** 轨迹点寿命（秒）：越短越"干脆"，越长尾巴越飘。 */
const LIFE = 0.3
/** 采样：位移超过该像素或间隔超过该毫秒就记一个点。 */
const MIN_STEP = 1.6
const MIN_INTERVAL = 0.012
/** 轨迹点上限（防止长时间不动时数组无限增长）。 */
const MAX_POINTS = 48
/** 尾巴最大宽度（CSS 像素，bugv8 #1：细一些）。 */
const MAX_WIDTH = 3.4

interface TrailPoint {
  x: number
  y: number
  /** 记录时刻（秒，`performance.now()/1000`）。 */
  t: number
}

function parseHex(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace('#', ''), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function mix(from: [number, number, number], to: [number, number, number], k: number): [number, number, number] {
  return [
    Math.round(from[0] + (to[0] - from[0]) * k),
    Math.round(from[1] + (to[1] - from[1]) * k),
    Math.round(from[2] + (to[2] - from[2]) * k),
  ]
}

const TAIL_RGB = parseHex(TRAIL_TAIL)
const HEAD_RGB = parseHex(TRAIL_HEAD)
const CORE_RGB = parseHex(TRAIL_BLUE)

export interface CursorTrail {
  destroy(): void
}

/** 是否应该启用拖尾：需要精确指针（鼠标），并且用户没有要求减少动效。 */
export function prefersTrail(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches === true
}

/**
 * 启动拖尾。
 *
 * `container` 决定 canvas 挂在哪里：挂在 `.app-root` 内部（position:absolute）
 * 就能受页面层叠上下文管理 —— z-index 30 让它盖过棋盘与弹窗。
 */
export function startCursorTrail(container: HTMLElement): CursorTrail | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.className = 'cursor-trail-canvas'
  canvas.style.position = 'absolute'
  canvas.style.top = '0px'
  canvas.style.left = '0px'
  canvas.style.pointerEvents = 'none'
  // 盖在棋盘（1）、HUD（6）、弹窗（8/9）之上：拖尾是指针装饰，被面板挡住就不叫拖尾了
  canvas.style.zIndex = '30'
  canvas.dataset.trail = 'on'
  const context = canvas.getContext('2d')
  if (!context) return null
  container.appendChild(canvas)

  let width = 0
  let height = 0
  let dpr = 1
  const points: TrailPoint[] = []
  let pointer: { x: number; y: number } | null = null
  let frame = 0
  let running = true
  const now = () => performance.now() / 1000

  function resize(): void {
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    width = container.clientWidth || window.innerWidth
    height = container.clientHeight || window.innerHeight
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    context?.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  function onMove(event: PointerEvent): void {
    if (event.pointerType === 'touch') return
    const rect = container.getBoundingClientRect()
    pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    const head = points[points.length - 1]
    const t = now()
    // 采样：移动够远或隔得够久就压一个点（相邻点之间会被连成线，所以不会断）
    if (!head || Math.hypot(pointer.x - head.x, pointer.y - head.y) >= MIN_STEP || t - head.t >= MIN_INTERVAL) {
      points.push({ x: pointer.x, y: pointer.y, t })
      if (points.length > MAX_POINTS) points.splice(0, points.length - MAX_POINTS)
    }
  }

  function onLeave(): void {
    pointer = null
  }

  function drawGlow(from: TrailPoint, to: TrailPoint, k: number, alpha: number, lineWidth: number): void {
    const color = mix(TAIL_RGB, HEAD_RGB, k)
    context!.strokeStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha.toFixed(3)})`
    context!.lineWidth = lineWidth
    context!.beginPath()
    context!.moveTo(from.x, from.y)
    context!.lineTo(to.x, to.y)
    context!.stroke()
  }

  function frameLoop(): void {
    if (!running) return
    frame = requestAnimationFrame(frameLoop)
    if (!context) return
    const t = now()

    // 丢掉过期点；如果太久没有新点（手停了），尾巴自然缩回去
    while (points.length > 0 && t - points[0].t > LIFE) points.shift()
    if (points.length === 0) {
      context.clearRect(0, 0, width, height)
      return
    }

    context.clearRect(0, 0, width, height)
    context.lineCap = 'round'
    context.lineJoin = 'round'

    // 第一遍：宽而淡的外发光（bugv8 #1：整体更细，不再抢视线）
    for (let i = 1; i < points.length; i++) {
      const from = points[i - 1]
      const to = points[i]
      const k = Math.max(1 - (t - to.t) / LIFE, 0)
      drawGlow(from, to, k, 0.03 + 0.1 * k * k, MAX_WIDTH * (0.35 + 0.65 * k) + 1.6)
    }
    // 第二遍：细而实的芯，颜色从尾巴的深蓝渐变到头部的亮蓝
    for (let i = 1; i < points.length; i++) {
      const from = points[i - 1]
      const to = points[i]
      const k = Math.max(1 - (t - to.t) / LIFE, 0)
      drawGlow(from, to, k, 0.08 + 0.5 * k ** 1.25, 0.6 + (MAX_WIDTH - 0.6) * k ** 0.9)
    }

    // 头部亮点：让尾巴有个"彗核"（bugv8 #1：也跟着缩小一圈）
    const head = points[points.length - 1]
    const headAge = t - head.t
    if (pointer && headAge < 0.1) {
      const radius = 1.6
      const gradient = context.createRadialGradient(head.x, head.y, 0, head.x, head.y, radius * 2.6)
      gradient.addColorStop(0, `rgba(255, 255, 255, 0.95)`)
      gradient.addColorStop(0.35, `rgba(${CORE_RGB[0]}, ${CORE_RGB[1]}, ${CORE_RGB[2]}, 0.85)`)
      gradient.addColorStop(1, `rgba(${CORE_RGB[0]}, ${CORE_RGB[1]}, ${CORE_RGB[2]}, 0)`)
      context.fillStyle = gradient
      context.beginPath()
      context.arc(head.x, head.y, radius * 2.6, 0, Math.PI * 2)
      context.fill()
    }
  }

  resize()
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null
  observer?.observe(container)
  window.addEventListener('resize', resize)
  window.addEventListener('pointermove', onMove, { passive: true })
  window.addEventListener('pointerdown', onMove, { passive: true })
  window.addEventListener('pointerleave', onLeave)
  document.addEventListener('pointerleave', onLeave)
  frame = requestAnimationFrame(frameLoop)

  return {
    destroy(): void {
      running = false
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerdown', onMove)
      window.removeEventListener('pointerleave', onLeave)
      document.removeEventListener('pointerleave', onLeave)
      points.length = 0
      canvas.remove()
    },
  }
}
