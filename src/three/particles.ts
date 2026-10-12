/**
 * GPU 粒子系统：用于落子冲击、连珠爆闪、撞击火花等 3D 特效。
 *
 * 单一 `Points` 对象 + 预分配缓冲，发射时不产生新对象，适合在动画循环中频繁调用。
 */
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three'

const VERTEX_SHADER = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (420.0 / max(-mvPosition.z, 0.001));
  gl_Position = projectionMatrix * mvPosition;
}
`

const FRAGMENT_SHADER = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float dist = length(uv);
  if (dist > 0.5) discard;
  float falloff = smoothstep(0.5, 0.0, dist);
  gl_FragColor = vec4(vColor, vAlpha * falloff);
}
`

export interface BurstOptions {
  count?: number
  speed?: number
  size?: number
  life?: number
  gravity?: number
  spread?: number
  color?: number
  /** 沿此方向的锥形喷射；缺省为全向。 */
  direction?: Vector3
  drag?: number
}

export class ParticleSystem {
  readonly points: Points
  private readonly capacity: number
  private readonly positions: Float32Array
  private readonly colors: Float32Array
  private readonly sizes: Float32Array
  private readonly alphas: Float32Array
  private readonly velocities: Float32Array
  private readonly life: Float32Array
  private readonly maxLife: Float32Array
  private readonly gravity: Float32Array
  private readonly drag: Float32Array
  private cursor = 0
  private readonly geometry: BufferGeometry
  private readonly material: ShaderMaterial
  private readonly random = { state: 1 }

  constructor(capacity = 1400) {
    this.capacity = capacity
    this.positions = new Float32Array(capacity * 3)
    this.colors = new Float32Array(capacity * 3)
    this.sizes = new Float32Array(capacity)
    this.alphas = new Float32Array(capacity)
    this.velocities = new Float32Array(capacity * 3)
    this.life = new Float32Array(capacity)
    this.maxLife = new Float32Array(capacity)
    this.gravity = new Float32Array(capacity)
    this.drag = new Float32Array(capacity)

    this.geometry = new BufferGeometry()
    this.geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3))
    this.geometry.setAttribute('aColor', new Float32BufferAttribute(this.colors, 3))
    this.geometry.setAttribute('aSize', new Float32BufferAttribute(this.sizes, 1))
    this.geometry.setAttribute('aAlpha', new Float32BufferAttribute(this.alphas, 1))
    this.geometry.setDrawRange(0, 0)
    this.geometry.boundingSphere = null

    this.material = new ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    })

    this.points = new Points(this.geometry, this.material)
    this.points.frustumCulled = false
  }

  private rand(): number {
    // 轻量 LCG，避免依赖全局随机（表现层无需可复现性，但保持可预测的开销）
    this.random.state = (this.random.state * 1664525 + 1013904223) >>> 0
    return this.random.state / 4294967296
  }

  burst(origin: Vector3, options: BurstOptions = {}): void {
    const count = options.count ?? 24
    const speed = options.speed ?? 2.2
    const size = options.size ?? 0.16
    const life = options.life ?? 0.7
    const gravity = options.gravity ?? -6
    const spread = options.spread ?? 1
    const drag = options.drag ?? 1.6
    const color = new Color(options.color ?? 0xffffff)
    const direction = options.direction

    for (let i = 0; i < count; i++) {
      const index = this.cursor
      this.cursor = (this.cursor + 1) % this.capacity
      const offset = index * 3

      let vx = this.rand() * 2 - 1
      let vy = this.rand() * 2 - 1
      let vz = this.rand() * 2 - 1
      if (direction) {
        // 锥形：方向向量 + 球面扰动
        vx = direction.x + vx * spread
        vy = direction.y + Math.abs(vy) * spread
        vz = direction.z + vz * spread
      } else {
        vy = Math.abs(vy) * 0.75
      }
      const length = Math.hypot(vx, vy, vz) || 1
      const magnitude = speed * (0.45 + this.rand() * 0.75)

      this.positions[offset] = origin.x
      this.positions[offset + 1] = origin.y
      this.positions[offset + 2] = origin.z
      this.velocities[offset] = (vx / length) * magnitude
      this.velocities[offset + 1] = (vy / length) * magnitude
      this.velocities[offset + 2] = (vz / length) * magnitude

      const tint = 0.75 + this.rand() * 0.45
      this.colors[offset] = color.r * tint
      this.colors[offset + 1] = color.g * tint
      this.colors[offset + 2] = color.b * tint

      this.sizes[index] = size * (0.6 + this.rand() * 0.9)
      this.alphas[index] = 1
      this.life[index] = life * (0.65 + this.rand() * 0.7)
      this.maxLife[index] = this.life[index]
      this.gravity[index] = gravity
      this.drag[index] = drag

      this.geometry.setDrawRange(0, this.capacity)
    }
  }

  update(dt: number): void {
    if (dt <= 0) return
    let active = false
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) {
        if (this.alphas[i] !== 0) this.alphas[i] = 0
        continue
      }
      active = true
      const offset = i * 3
      this.life[i] -= dt
      const damping = Math.exp(-this.drag[i] * dt)
      this.velocities[offset] *= damping
      this.velocities[offset + 1] = (this.velocities[offset + 1] + this.gravity[i] * dt) * damping
      this.velocities[offset + 2] *= damping

      this.positions[offset] += this.velocities[offset] * dt
      this.positions[offset + 1] += this.velocities[offset + 1] * dt
      this.positions[offset + 2] += this.velocities[offset + 2] * dt

      const ratio = Math.max(this.life[i] / this.maxLife[i], 0)
      this.alphas[i] = ratio * ratio
      this.sizes[i] *= this.life[i] > 0 ? 0.985 : 1
    }
    if (active) {
      this.geometry.attributes.position.needsUpdate = true
      this.geometry.attributes.aAlpha.needsUpdate = true
      this.geometry.attributes.aSize.needsUpdate = true
      this.geometry.attributes.aColor.needsUpdate = true
    }
  }

  reset(): void {
    this.life.fill(0)
    this.alphas.fill(0)
    this.geometry.setDrawRange(0, 0)
    this.geometry.attributes.aAlpha.needsUpdate = true
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    this.points.removeFromParent()
  }
}
