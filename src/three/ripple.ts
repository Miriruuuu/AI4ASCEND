/**
 * 全屏波纹：对撞 / 撞击血条时向整个画面扩散的冲击波。
 *
 * 用一张覆盖视口的着色器平面绘制（在 3D 场景里保持与摄像机对齐），
 * 只保留一圈带柔边的亮环，因此不会遮挡棋盘。
 */
import { AdditiveBlending, Color, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from 'three'

const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const FRAGMENT_SHADER = /* glsl */ `
uniform float uProgress;
uniform float uIntensity;
uniform vec3 uColor;
uniform vec2 uCenter;
uniform float uAspect;
uniform float uTime;
uniform float uPhase;
varying vec2 vUv;

void main() {
  vec2 p = vUv - uCenter;
  p.x *= uAspect;
  float dist = length(p);
  // bugv6 #5：每次波纹都给一个随机起始角，谱线的朝向不再千篇一律
  float angle = atan(p.y, p.x) + uPhase;

  // 频谱状锯齿（bugv5 #3）：半径与亮度都按角度抖动，不再是平滑圆环
  float jitter = 0.030 * sin(angle * 27.0 + uTime * 3.6)
               + 0.017 * sin(angle * 49.0 - uTime * 5.3)
               + 0.011 * sin(angle * 13.0 + uTime * 2.1);

  // 波纹半径从中心扩散到覆盖整个画面
  float radius = mix(0.02, 1.35, uProgress) + jitter;
  float thickness = mix(0.015, 0.12, uProgress);
  float ring = 1.0 - smoothstep(0.0, thickness, abs(dist - radius));

  // 沿圆周的谱线
  float bars = 0.35 + 0.65 * pow(abs(sin(angle * 33.0 + uTime * 2.8)), 1.4);

  // 内侧余晖
  float glow = exp(-max(dist - radius, 0.0) * 4.0) * 0.25;

  float fade = pow(1.0 - uProgress, 1.6);
  float alpha = clamp((ring * (0.5 + 0.5 * bars) + glow) * uIntensity * fade, 0.0, 1.0);

  if (alpha < 0.002) discard;
  gl_FragColor = vec4(uColor, alpha);
}
`

export interface RippleOptions {
  color?: number
  intensity?: number
  duration?: number
}

export class FullScreenRipple {
  readonly mesh: Mesh
  private readonly material: ShaderMaterial
  private elapsed = 0
  private duration = 0.75
  private active = false
  private time = 0
  /** 最近一次波纹的随机起始角（bugv6 #5，供验证脚本读取）。 */
  phase = 0

  constructor() {
    this.material = new ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
      uniforms: {
        uProgress: { value: 0 },
        uIntensity: { value: 0 },
        uColor: { value: new Color(0xffffff) },
        uCenter: { value: { x: 0.5, y: 0.5 } },
        uAspect: { value: 1 },
        uTime: { value: 0 },
        uPhase: { value: 0 },
      },
    })
    this.mesh = new Mesh(new PlaneGeometry(1, 1), this.material)
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    this.mesh.renderOrder = 10
  }

  /** 触发一次全屏波纹。 */
  fire(options: RippleOptions = {}): void {
    this.material.uniforms.uColor.value.setHex(options.color ?? 0xffffff)
    this.material.uniforms.uIntensity.value = options.intensity ?? 1
    this.material.uniforms.uProgress.value = 0
    // bugv6 #5：每次波纹的谱线朝向随机（否则一圈一圈看起来都一样）
    this.phase = Math.random() * Math.PI * 2
    this.material.uniforms.uPhase.value = this.phase
    this.duration = options.duration ?? 0.75
    this.elapsed = 0
    this.active = true
    this.mesh.visible = true
  }

  /**
   * 每帧更新。
   *
   * @param camera 用于把平面贴在摄像机前（保持满屏）
   * @param screenCenter 波纹中心（0..1 的屏幕比例坐标）
   * @param aspect 视口宽高比
   */
  update(dt: number, camera: import('three').Camera, screenCenter: [number, number], aspect: number): void {
    this.time += dt
    // 平面始终贴在摄像机正前方，铺满视口
    attachToViewport(this.mesh, camera, aspect, 1.2)

    this.material.uniforms.uAspect.value = aspect
    this.material.uniforms.uTime.value = this.time
    this.material.uniforms.uCenter.value = { x: screenCenter[0], y: screenCenter[1] }

    if (!this.active) return
    this.elapsed += dt
    const progress = Math.min(this.elapsed / this.duration, 1)
    this.material.uniforms.uProgress.value = progress
    if (progress >= 1) {
      this.active = false
      this.mesh.visible = false
    }
  }

  /** 把世界坐标换算成屏幕比例坐标（0..1，y 向上）。 */
  static toScreenUv(point: Vector3, camera: import('three').Camera): [number, number] {
    const projected = point.clone().project(camera)
    return [(projected.x + 1) / 2, (projected.y + 1) / 2]
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.mesh.removeFromParent()
  }
}

const FLASH_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
varying vec2 vUv;

void main() {
  // 中心更亮、边缘渐隐：是“光晕”而不是死白的整屏
  float d = distance(vUv, vec2(0.5));
  float falloff = 1.0 - smoothstep(0.05, 0.78, d);
  float alpha = clamp(uIntensity * (0.16 + falloff * 0.95), 0.0, 1.0);
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(uColor, alpha);
}
`

/**
 * 全屏闪光：对撞 / 撞击血条瞬间的“闪光灯”。
 *
 * 与全屏波纹共用「贴在摄像机前的加色平面」这套做法，因此同样不受暗场灯光影响
 * （bugv3 #2：对撞特效不应该跟着场地一起变暗）。
 */
export class ScreenFlash {
  readonly mesh: Mesh
  private readonly material: ShaderMaterial

  constructor() {
    this.material = new ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FLASH_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
      uniforms: {
        uColor: { value: new Color(0xffffff) },
        uIntensity: { value: 0 },
      },
    })
    this.mesh = new Mesh(new PlaneGeometry(1, 1), this.material)
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    this.mesh.renderOrder = 11
  }

  /** 每帧更新：`intensity` 由 EffectsView 的闪光衰减曲线给出。 */
  update(camera: import('three').Camera, aspect: number, intensity: number, color: number): void {
    const amount = Math.max(0, Math.min(1, intensity))
    if (amount <= 0.003) {
      if (this.mesh.visible) this.mesh.visible = false
      return
    }
    if (!this.mesh.visible) this.mesh.visible = true
    attachToViewport(this.mesh, camera, aspect, 1.0)
    this.material.uniforms.uIntensity.value = amount
    ;(this.material.uniforms.uColor.value as Color).setHex(color)
  }

  reset(): void {
    this.material.uniforms.uIntensity.value = 0
    this.mesh.visible = false
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.mesh.removeFromParent()
  }
}

/** 把一块平面贴到摄像机正前方并铺满视口。 */
function attachToViewport(mesh: Mesh, camera: import('three').Camera, aspect: number, distance: number): void {
  mesh.position.copy(camera.position)
  mesh.quaternion.copy(camera.quaternion)
  mesh.translateZ(-distance)
  const height = 2 * Math.tan((((camera as import('three').PerspectiveCamera).fov ?? 50) * Math.PI) / 360) * distance
  mesh.scale.set(height * aspect * 1.05, height * 1.05, 1)
}
