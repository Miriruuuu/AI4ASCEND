/**
 * 棋子层：**黑白实体棋子**（像真实的围棋棋子），落在网格交叉点上。
 *
 * - 几何：`LatheGeometry` 旋转一条“中凸、带倒角”的剖面线，得到圆润凸起的棋子，
 *   而不是圆柱 / 瓶盖那种中间凹陷的形状；
 * - 颜色（bugv3 #8）：棋子本体是**黑子 / 白子**，红蓝只作为**特征色**保留下来 ——
 *   连珠时棋子自发光转为特征色、高光点用特征色、悬浮的攻击棋子外面再套一层
 *   特征色“附着层”（aura）；
 * - 每颗棋子带一个柔和的接地阴影，白子在浅色页面上也能看清轮廓；
 * - 每颗棋子持有**独立材质实例**，因此连珠高亮 / 攻击高亮互不干扰。
 */
import {
  AdditiveBlending,
  CanvasTexture,
  CircleGeometry,
  Color,
  DoubleSide,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type Material,
  type Texture,
} from 'three'
import type { PlayerIndex } from '../core/types'
import { CELL_SIZE, cellToWorld } from './board-view'
import type { Palette } from './palette'

/** 棋子半径。 */
export const PIECE_RADIUS = CELL_SIZE * 0.34
/** 棋子厚度（凸起高度）。 */
export const PIECE_HEIGHT = CELL_SIZE * 0.13

/**
 * 棋盘棋子的基础自发光：**恒为 0**。
 *
 * bugv4 #1：场上的黑棋必须是真的黑色，棋盘棋子的颜色不受特征色影响
 * （特征色只出现在高光点、特效与悬浮攻击棋子的附着层上）。
 */
const BASE_EMISSIVE = 0
/** 连珠高光：只用**亮度**表达（白色自发光），不给黑子染上特征色。 */
const MATCH_GLOW_BLACK = 0.42
const MATCH_GLOW_WHITE = 0.1
/**
 * 悬浮攻击棋子：本体仍是黑子 / 白子，靠外面那层特征色附着层（aura）着色，
 * 所以自发光压得很低（数值看着小，但经过 sRGB 编码后已经足够显色）。
 */
const STAGE_EMISSIVE = 0.14
const STAGE_EMISSIVE_DARK = 0.85
/** 特征色附着层（比棋子略大一圈的自发光外壳）。 */
const AURA_SCALE = 1.09
const AURA_OPACITY = 0.26
const AURA_OPACITY_DARK = 0.5
/** 接地阴影。 */
const GROUND_SCALE = 1.85

/** 棋子归属存在 mesh.userData 上，供舞台棋子复用。 */
const OWNER_KEY = 'owner'
const GROUND_KEY = 'ground'
const AURA_KEY = 'aura'
/** 技能挑选时的高光标识（bugv10 #2）。 */
const MARKER_KEY = 'select-marker'
/** 叠子（bugv10 #9）：比原棋子小一圈，架在它上面。 */
const OVERLAY_SCALE = 0.78
/** 技能挑选时未选中棋子的透明度（"变暗"）。 */
const DIMMED_OPACITY = 0.16
/** 选中 / 悬停棋子的自发光强度。 */
const SPOTLIGHT_EMISSIVE = 0.42
const SPOTLIGHT_HOVER_EMISSIVE = 0.85

interface PieceRecord {
  mesh: Mesh
  owner: PlayerIndex
  material: MeshStandardMaterial
}

/** 棋子炸开后的碎片（bugv5 #8）。 */
interface Shard {
  mesh: Mesh
  velocity: Vector3
  spin: Vector3
  life: number
  maxLife: number
  size: number
}

/** 碎片数量与寿命。 */
const SHARD_COUNT = 13
const SHARD_LIFE_MIN = 0.42
const SHARD_LIFE_MAX = 0.78
/** 重力：调大一点，碎片才会"炸出去再掉下来"，而不是慢慢飘。 */
const SHARD_GRAVITY = -17
/** 初速度（bugv8 #7：更快、更有冲击力）。 */
const SHARD_SPEED_MIN = 7.5
const SHARD_SPEED_MAX = 15
/** 沿"从爆心向外"的径向偏置，让碎片有明显的方向感。 */
const SHARD_RADIAL_BIAS = 0.35

// --- 结束动画：全体棋子炸飞（bugv9 #11） -------------------------------------
/** 往玩家方向（+z）的速度范围。 */
const FLYER_FORWARD_MIN = 15
const FLYER_FORWARD_MAX = 24
/** 横向（x/y）随机偏移幅度。 */
const FLYER_SPREAD = 9
const FLYER_LIFT = 6
/** 速度衰减系数（越大减速越快）。 */
const FLYER_DRAG = 1.02
/** 飞过摄像机所在的 z（≈9.3）之后就没必要继续算了。 */
const FLYER_RECYCLE_Z = 12
/** 兜底：离原点太远或飞太久就回收。 */
const FLYER_RECYCLE_DISTANCE = 24
const FLYER_MAX_LIFE = 2.6

/**
 * 生成棋子剖面：从底部圆心 → 底部边缘 → 侧面倒角 → 凸起的顶面 → 顶部圆心。
 * 这条剖面绕 Y 轴旋转后就是一颗中凸的棋子。
 */
function createStoneProfile(): Vector2[] {
  const points: Vector2[] = []
  const bottom = -PIECE_HEIGHT / 2
  const top = PIECE_HEIGHT / 2

  // 底面（略微内凹，避免与棋盘贴合处出现缝隙感）
  for (let i = 0; i <= 6; i++) {
    const t = i / 6
    const radius = PIECE_RADIUS * t
    const y = bottom + (1 - t * t) * PIECE_HEIGHT * 0.05
    points.push(new Vector2(radius, y))
  }

  // 侧壁倒角
  const bevel = [
    [1, 0.1],
    [0.995, 0.28],
    [0.975, 0.46],
  ] as const
  for (const [radiusFactor, heightFactor] of bevel) {
    points.push(new Vector2(PIECE_RADIUS * radiusFactor, bottom + PIECE_HEIGHT * heightFactor))
  }

  // 凸起顶面：中心最高，向边缘平滑过渡
  const crownSteps = 14
  for (let i = crownSteps; i >= 0; i--) {
    const t = i / crownSteps
    const radius = PIECE_RADIUS * 0.975 * t
    const y = bottom + PIECE_HEIGHT * (0.46 + 0.54 * (1 - t ** 2.6))
    points.push(new Vector2(radius, Math.min(y, top)))
  }

  return points
}

/** 柔和的圆形阴影贴图（接触阴影，让白子在浅色底上也有轮廓）。 */
function createGroundTexture(): Texture | null {
  if (typeof document === 'undefined') return null
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) return null
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, 'rgba(14, 16, 22, 0.5)')
  gradient.addColorStop(0.45, 'rgba(14, 16, 22, 0.26)')
  gradient.addColorStop(1, 'rgba(14, 16, 22, 0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, size, size)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

export class PiecesView {
  readonly group = new Group()
  /**
   * 攻击舞台：悬浮棋子的容器。
   *
   * 注意：它**不放在棋盘组里**（见 SceneController），这样舞台棋子不会跟随
   * 棋盘的鼠标偏移 / 旋转，屏幕边缘的悬浮位置才稳定（bugv3 #1 / #4）。
   */
  readonly stageGroup = new Group()

  private readonly records = new Map<number, PieceRecord>()
  /** 叠在敌方棋子上的额外棋子（bugv10 #9 毒鸡蛋）。 */
  private readonly overlays = new Map<number, PieceRecord>()
  /** 技能挑选时保持明亮的棋子（null = 没在挑选，bugv10 #2）。 */
  private spotlight: Set<number> | null = null
  private spotlightColor = 0xffffff
  private hoverMarkerCell: number | null = null
  private readonly markerGeometry = new RingGeometry(PIECE_RADIUS * 0.92, PIECE_RADIUS * 1.16, 28)
  private readonly free: Mesh[] = []
  /** 碎片（棋子炸开，bugv5 #8）。 */
  private readonly shards: Shard[] = []
  private readonly shardPool: Mesh[] = []
  /** 结束动画里被炸飞的棋子（bugv9 #11）。 */
  private readonly flyers: { mesh: Mesh; life: number; velocity: Vector3; spin: Vector3 }[] = []
  private readonly geometry: LatheGeometry
  private readonly groundGeometry: CircleGeometry
  private readonly groundMaterial: MeshBasicMaterial
  private readonly shared = new Set<Material>()
  private readonly auraMaterials = new Map<Mesh, MeshBasicMaterial>()
  private palette: Palette
  /** 舞台棋子的提亮程度（暗场里更强，bugv3 #2）。 */
  private stageBoost = 0

  constructor(palette: Palette) {
    this.palette = palette
    this.geometry = new LatheGeometry(createStoneProfile(), 56)
    this.groundGeometry = new CircleGeometry(PIECE_RADIUS * GROUND_SCALE, 40)
    const groundTexture = createGroundTexture()
    this.groundMaterial = new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    })
    if (groundTexture) this.groundMaterial.map = groundTexture
    this.shared.add(this.groundMaterial)
    this.stageGroup.name = 'piece-stage'
  }

  private createMaterial(owner: PlayerIndex): MeshStandardMaterial {
    const side = this.palette.sides[owner]
    return new MeshStandardMaterial({
      // 黑子 / 白子：本体颜色与特征色无关（bugv4 #1）
      color: side.stone,
      emissive: 0x000000,
      emissiveIntensity: BASE_EMISSIVE,
      metalness: 0.06,
      roughness: owner === 0 ? 0.34 : 0.44,
    })
  }

  // -------------------------------------------------------------------------
  // 生成 / 回收
  // -------------------------------------------------------------------------

  /** 在指定交点生成一颗棋子（不播放动画）。 */
  spawn(index: number, owner: PlayerIndex): Mesh {
    if (this.records.has(index)) this.despawn(index)

    const mesh = this.free.pop() ?? new Mesh(this.geometry)
    const material = this.createMaterial(owner)

    mesh.material = material
    mesh.visible = true
    mesh.scale.setScalar(1)
    mesh.rotation.set(0, 0, 0)
    mesh.userData[OWNER_KEY] = owner
    cellToWorld(index, mesh.position)
    mesh.position.y = PIECE_HEIGHT / 2
    this.group.add(mesh)

    this.records.set(index, { mesh, owner, material })
    return mesh
  }

  /** 棋盘上的棋子统一补上接地阴影（重建场景时调用）。 */
  groundAll(): void {
    for (const record of this.records.values()) this.attachGround(record.mesh)
  }

  /**
   * 生成一颗**不挂在棋盘上**的棋子（bugv9 #6）。
   *
   * 用在"舞台补位"：魔力植物会给总攻击数 +1，防守方削弱又会 -1，
   * 悬浮棋子的数量必须随时和总攻击数一致，多退少补的棋子不走棋盘格。
   */
  spawnDetached(owner: PlayerIndex): Mesh {
    const mesh = this.free.pop() ?? new Mesh(this.geometry)
    mesh.material = this.createMaterial(owner)
    mesh.visible = true
    mesh.scale.setScalar(1)
    mesh.rotation.set(0, 0, 0)
    mesh.userData[OWNER_KEY] = owner
    this.stageGroup.add(mesh)
    this.detachGround(mesh)
    this.attachAura(mesh)
    return mesh
  }

  // -------------------------------------------------------------------------
  // 棋子炸开成碎片（bugv5 #8）
  // -------------------------------------------------------------------------

  /**
   * 把一颗棋子“炸开”：棋子本体消失，同时抛出十几块碎片
   * （用棋子自己的旋转体几何缩小而成，像玻璃 / 石头碎裂）。
   *
   * bugv6 #6：碎片的颜色**取双方的特征色**（`palette.sides[].color`），
   * 不再是棋子本体的黑 / 白 —— 对撞时还能传入对手，让一部分碎片变成对手的特征色，
   * 于是炸开的一瞬间能同时看到两种颜色。这里没有任何写死的色值。
   */
  shatter(mesh: Mesh, owner: PlayerIndex, origin?: Vector3, other?: PlayerIndex): void {
    const center = origin?.clone() ?? mesh.position.clone()
    mesh.visible = false
    const own = new Color(this.palette.sides[owner].color)
    const rival = other === undefined ? null : new Color(this.palette.sides[other].color)
    const blend = rival ? own.clone().lerp(rival, 0.5) : null
    // 爆心（对撞点 / 血条命中点）在碎片中心略上方，径向方向从它往外算
    const blast = center.clone().add(new Vector3(0, 0.16, 0))

    for (let i = 0; i < SHARD_COUNT; i++) {
      const shard = this.shardPool.pop() ?? this.createShard(owner)
      if (!shard) return
      const material = shard.material as MeshStandardMaterial
      // 混合比例固定（不随机），保证两种特征色都稳定出现，便于验证
      const tint = !rival
        ? own
        : i % 4 === 0
          ? rival
          : i % 4 === 1
            ? (blend as Color)
            : own
      material.color.copy(tint)
      material.emissive.copy(tint).lerp(new Color(0xffffff), 0.22)
      material.emissiveIntensity = 0.8 + (i % 3) * 0.16

      const size = 0.22 + Math.random() * 0.2
      shard.visible = true
      shard.scale.setScalar(size)
      shard.position.copy(center)
      shard.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3)
      this.stageGroup.add(shard)

      // bugv8 #7：更快更"炸"——沿圆周均匀铺开，再叠加一个向外 + 向上的径向偏置
      const angle = (i / SHARD_COUNT) * Math.PI * 2 + Math.random() * 0.45
      const speed = SHARD_SPEED_MIN + Math.random() * (SHARD_SPEED_MAX - SHARD_SPEED_MIN)
      const outX = Math.cos(angle)
      const outZ = Math.sin(angle)
      const radial = shard.position.clone().sub(blast)
      radial.y = 0
      if (radial.lengthSq() > 1e-4) radial.normalize()
      this.shards.push({
        mesh: shard,
        velocity: new Vector3(
          outX * speed + radial.x * speed * SHARD_RADIAL_BIAS,
          2.4 + Math.random() * 5.6,
          outZ * speed * 0.72 + radial.z * speed * SHARD_RADIAL_BIAS,
        ),
        // 自旋也比之前更急，看起来才像被崩开的碎块
        spin: new Vector3((Math.random() - 0.5) * 26, (Math.random() - 0.5) * 26, (Math.random() - 0.5) * 26),
        life: 0,
        maxLife: SHARD_LIFE_MIN + Math.random() * (SHARD_LIFE_MAX - SHARD_LIFE_MIN),
        size,
      })
    }
  }

  /**
   * 结束动画：棋盘上的**所有**棋子高速炸飞出去（bugv9 #11）。
   *
   * 每颗棋子的初速度都是"高速"，方向以 +z（朝向玩家）为主，xy 各带随机偏移；
   * 之后按 `FLYER_DRAG` 指数减速 —— 速度由快变慢，直到飞出屏幕被回收。
   */
  launchAll(): void {
    for (const record of this.records.values()) {
      this.detachGround(record.mesh)
      this.detachAura(record.mesh)
      this.flyers.push({
        mesh: record.mesh,
        life: 0,
        velocity: new Vector3(
          (Math.random() * 2 - 1) * FLYER_SPREAD,
          // 往斜上方飞一点，最后才是往玩家方向冲出来
          1.6 + Math.random() * FLYER_LIFT,
          FLYER_FORWARD_MIN + Math.random() * (FLYER_FORWARD_MAX - FLYER_FORWARD_MIN),
        ),
        spin: new Vector3((Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18),
      })
    }
    this.records.clear()
  }

  private detachAura(mesh: Mesh): void {
    const aura = mesh.getObjectByName(AURA_KEY)
    if (!aura) return
    mesh.remove(aura)
    this.auraMaterials.delete(mesh)
  }

  /** 推进"炸飞"的棋子（与碎片共用一个每帧钩子）。 */
  private updateFlyers(dt: number): void {
    for (let i = this.flyers.length - 1; i >= 0; i--) {
      const flyer = this.flyers[i]
      // 指数衰减：一开始很快，越飞越慢，但位移足够离开屏幕
      flyer.velocity.multiplyScalar(Math.exp(-FLYER_DRAG * dt))
      flyer.mesh.position.addScaledVector(flyer.velocity, dt)
      flyer.mesh.rotation.x += flyer.spin.x * dt
      flyer.mesh.rotation.y += flyer.spin.y * dt
      flyer.mesh.rotation.z += flyer.spin.z * dt
      // 飞远之后顺便缩小一点，做出"冲出画面"的透视感
      flyer.mesh.scale.multiplyScalar(Math.exp(-0.35 * dt))
      flyer.life += dt
      const gone =
        flyer.life > FLYER_MAX_LIFE ||
        flyer.mesh.position.z > FLYER_RECYCLE_Z ||
        flyer.mesh.position.length() > FLYER_RECYCLE_DISTANCE
      if (gone) {
        this.flyers.splice(i, 1)
        this.recycle(flyer.mesh)
      }
    }
  }

  private clearFlyers(): void {
    for (const flyer of this.flyers) this.recycle(flyer.mesh)
    this.flyers.length = 0
  }

  private createShard(owner: PlayerIndex): Mesh | null {
    const side = this.palette.sides[owner]
    const mesh = new Mesh(
      this.geometry,
      new MeshStandardMaterial({
        // 底色就是特征色（每次炸开还会按归属重新着色，见 shatter()）
        color: side.color,
        emissive: side.color,
        emissiveIntensity: 0.8,
        metalness: 0.12,
        roughness: 0.38,
      }),
    )
    // 用一个很小的随机缩放做出不规则碎片感
    mesh.scale.setScalar(0.2)
    return mesh
  }

  /** 推进碎片（由 SceneController 每帧调用）。 */
  updateShards(dt: number): void {
    this.updateFlyers(dt)
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const shard = this.shards[i]
      shard.life += dt
      const t = Math.min(shard.life / shard.maxLife, 1)
      shard.velocity.y += SHARD_GRAVITY * dt
      shard.mesh.position.addScaledVector(shard.velocity, dt)
      shard.mesh.rotation.x += shard.spin.x * dt
      shard.mesh.rotation.y += shard.spin.y * dt
      shard.mesh.rotation.z += shard.spin.z * dt
      // 越接近尾声越小，最后收掉
      shard.mesh.scale.setScalar(shard.size * (1 - t) ** 0.6)
      if (t >= 1) {
        shard.mesh.removeFromParent()
        shard.mesh.visible = false
        this.shardPool.push(shard.mesh)
        this.shards.splice(i, 1)
      }
    }
  }

  private clearShards(): void {
    for (const shard of this.shards) {
      shard.mesh.removeFromParent()
      shard.mesh.visible = false
      this.shardPool.push(shard.mesh)
    }
    this.shards.length = 0
  }

  /** 给某颗棋盘棋子补上接地阴影（落子动画结束时调用）。 */
  groundAt(index: number): void {
    const record = this.records.get(index)
    if (record) this.attachGround(record.mesh)
  }

  private attachGround(mesh: Mesh): void {
    if (mesh.getObjectByName(GROUND_KEY)) return
    const ground = new Mesh(this.groundGeometry, this.groundMaterial)
    ground.name = GROUND_KEY
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -PIECE_HEIGHT / 2 + 0.004
    ground.renderOrder = -1
    mesh.add(ground)
  }

  private detachGround(mesh: Mesh): void {
    const ground = mesh.getObjectByName(GROUND_KEY)
    if (ground) mesh.remove(ground)
  }

  get(index: number): Mesh | null {
    return this.records.get(index)?.mesh ?? null
  }

  ownerAt(index: number): PlayerIndex | null {
    return this.records.get(index)?.owner ?? null
  }

  /** 从记录中移除；`keep` 为 true 时保留对象以便继续做动画。 */
  despawn(index: number, options: { keep?: boolean } = {}): Mesh | null {
    const record = this.records.get(index)
    if (!record) return null
    // 技能挑选的高光标识不能跟着棋子飞出去（bugv10 #2）
    this.removeMarkerFrom(record.mesh)
    this.records.delete(index)
    if (!options.keep) {
      this.recycle(record.mesh)
      return null
    }
    return record.mesh
  }

  // -------------------------------------------------------------------------
  // 叠子（bugv10 #9 毒鸡蛋）
  // -------------------------------------------------------------------------

  /**
   * 在**已有的敌方棋子**上再叠一颗我方棋子。
   *
   * 需求原文"并不会顶替掉原棋子"：底下的原棋子照旧留在棋盘上，
   * 这一颗稍微小一点、架在它上面，两颗都要能看见。
   */
  spawnOverlay(index: number, owner: PlayerIndex): Mesh {
    this.takeOverlay(index)

    const mesh = this.free.pop() ?? new Mesh(this.geometry)
    const material = this.createMaterial(owner)
    mesh.material = material
    mesh.visible = true
    mesh.scale.setScalar(OVERLAY_SCALE)
    mesh.rotation.set(0, 0, 0)
    mesh.userData[OWNER_KEY] = owner
    cellToWorld(index, mesh.position)
    mesh.position.y = PIECE_HEIGHT * (1 + OVERLAY_SCALE * 0.5) + 0.01
    this.group.add(mesh)

    this.overlays.set(index, { mesh, owner, material })
    return mesh
  }

  /** 取走某一格的叠子（`keep` 为 true 时保留对象，用于飞离动画）。 */
  takeOverlay(index: number, options: { keep?: boolean } = {}): Mesh | null {
    const record = this.overlays.get(index)
    if (!record) return null
    this.overlays.delete(index)
    if (!options.keep) {
      this.recycle(record.mesh)
      return null
    }
    return record.mesh
  }

  /** 这一格上的叠子属于谁（没有则 null）。 */
  overlayAt(index: number): PlayerIndex | null {
    return this.overlays.get(index)?.owner ?? null
  }

  /** 全量对齐叠子（联机 sync / 回放跳步）。 */
  syncOverlay(entries: ReadonlyArray<{ cell: number; owner: PlayerIndex }>): void {
    const wanted = new Map(entries.map((entry) => [entry.cell, entry.owner]))
    for (const cell of [...this.overlays.keys()]) {
      if (!wanted.has(cell)) this.takeOverlay(cell)
    }
    for (const [cell, owner] of wanted) {
      if (this.overlays.get(cell)?.owner !== owner) this.spawnOverlay(cell, owner)
    }
  }

  // -------------------------------------------------------------------------
  // 技能挑选聚光（bugv10 #2）
  // -------------------------------------------------------------------------

  /**
   * 技能挑选时"只亮这些棋子"。
   *
   * `cells` 为 null 表示退出挑选：所有棋子恢复正常。
   * 非 null 时：列表里的棋子加一圈特征色高光标识，其它棋子压暗（需求原文
   * "只有我方在魔力植物上的棋子…高亮 其他棋子…变暗"）。
   */
  setSelectSpotlight(cells: readonly number[] | null, color: number): void {
    this.spotlight = cells === null ? null : new Set(cells)
    this.spotlightColor = color
    for (const [index, record] of this.records) {
      const lit = this.spotlight === null || this.spotlight.has(index)
      if (this.spotlight === null) {
        record.material.transparent = false
        record.material.opacity = 1
        record.material.depthWrite = true
        record.material.emissive.setHex(0x000000)
        record.material.emissiveIntensity = BASE_EMISSIVE
        this.removeMarker(index)
      } else {
        record.material.transparent = true
        record.material.opacity = lit ? 1 : DIMMED_OPACITY
        record.material.depthWrite = lit
        record.material.emissive.setHex(lit ? color : 0x000000)
        record.material.emissiveIntensity = lit ? SPOTLIGHT_EMISSIVE : 0
        if (lit) this.ensureMarker(index, color, false)
        else this.removeMarker(index)
      }
    }
    // 聚光会覆盖"悬停更亮"的自发光：重新应用到当前悬停的那一颗（bugv10 #2）
    const hover = this.hoverMarkerCell
    this.hoverMarkerCell = null
    if (this.spotlight === null || hover === null || !this.spotlight.has(hover)) return
    this.setSelectHover(hover)
  }

  /** 鼠标悬停到可选棋子上：换一个更亮的标识（bugv10 #2）。 */
  setSelectHover(index: number | null): void {
    if (this.hoverMarkerCell === index) return
    if (this.hoverMarkerCell !== null) {
      // 之前那一颗退回"已选中"的普通标识
      if (this.spotlight?.has(this.hoverMarkerCell)) this.ensureMarker(this.hoverMarkerCell, this.spotlightColor, false)
      else this.removeMarker(this.hoverMarkerCell)
    }
    this.hoverMarkerCell = index
    if (index !== null && this.spotlight?.has(index)) {
      this.ensureMarker(index, this.spotlightColor, true)
      const record = this.records.get(index)
      if (record) {
        record.material.emissive.setHex(this.spotlightColor)
        record.material.emissiveIntensity = SPOTLIGHT_HOVER_EMISSIVE
      }
    }
  }

  /** 给某一颗棋子挂/更新高光标识（一个悬在棋子上方的发光圆环）。 */
  private ensureMarker(index: number, color: number, hover: boolean): void {
    const record = this.records.get(index)
    if (!record) return
    let marker = record.mesh.getObjectByName(MARKER_KEY) as Mesh | undefined
    if (!marker) {
      marker = new Mesh(this.markerGeometry, new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        blending: AdditiveBlending,
        side: DoubleSide,
      }))
      marker.name = MARKER_KEY
      marker.rotation.x = -Math.PI / 2
      marker.position.y = PIECE_HEIGHT * 0.55
      record.mesh.add(marker)
    }
    const material = marker.material as MeshBasicMaterial
    material.color.setHex(color)
    material.opacity = hover ? 1 : 0.72
    marker.scale.setScalar(hover ? 1.32 : 1)
    marker.visible = true
  }

  private removeMarker(index: number): void {
    const record = this.records.get(index)
    if (record) this.removeMarkerFrom(record.mesh)
  }

  /** 摘掉某颗棋子上的"技能挑选"高光标识（连同它自己的材质）。 */
  private removeMarkerFrom(mesh: Mesh): void {
    const marker = mesh.getObjectByName(MARKER_KEY) as Mesh | undefined
    if (!marker) return
    mesh.remove(marker)
    ;(marker.material as MeshBasicMaterial).dispose()
  }

  /**
   * 把 mesh 挂到攻击舞台，并给它套上一层特征色附着层（bugv3 #8）。
   */
  detachToStage(mesh: Mesh): Mesh {
    this.group.remove(mesh)
    this.stageGroup.add(mesh)
    this.detachGround(mesh)
    this.attachAura(mesh)
    return mesh
  }

  /** 特征色附着层：比棋子略大一圈的自发光外壳，悬浮时像蒙了一层特征色。 */
  private attachAura(mesh: Mesh): void {
    const owner = (mesh.userData[OWNER_KEY] as PlayerIndex | undefined) ?? 0
    const side = this.palette.sides[owner]
    const material = new MeshBasicMaterial({
      color: side.color,
      transparent: true,
      opacity: AURA_OPACITY + this.stageBoost * (AURA_OPACITY_DARK - AURA_OPACITY),
      depthWrite: false,
      blending: AdditiveBlending,
    })
    const aura = new Mesh(this.geometry, material)
    aura.name = AURA_KEY
    aura.scale.setScalar(AURA_SCALE)
    mesh.add(aura)
    this.auraMaterials.set(mesh, material)

    // 悬浮棋子的特征色来自“附着层”，本体仍保持黑 / 白，只是被外壳染上一层色
    const base = mesh.material as MeshStandardMaterial
    base.emissive.setHex(side.color)
    base.emissiveIntensity = STAGE_EMISSIVE + this.stageBoost * (STAGE_EMISSIVE_DARK - STAGE_EMISSIVE)
  }

  /** 暗场时让悬浮棋子更亮（bugv3 #2：棋子 / 对撞特效不被压暗）。 */
  setStageBoost(amount: number): void {
    const boost = Math.max(0, Math.min(1, amount))
    if (Math.abs(boost - this.stageBoost) < 0.001) return
    this.stageBoost = boost
    for (const [mesh, material] of this.auraMaterials) {
      material.opacity = AURA_OPACITY + boost * (AURA_OPACITY_DARK - AURA_OPACITY)
      const base = mesh.material as MeshStandardMaterial
      base.emissiveIntensity = STAGE_EMISSIVE + boost * (STAGE_EMISSIVE_DARK - STAGE_EMISSIVE)
    }
  }

  /** 回收 mesh 到对象池（材质为每颗棋子独占，直接释放；共享材质跳过）。 */
  recycle(mesh: Mesh): void {
    this.auraMaterials.delete(mesh)
    const material = mesh.material as MeshStandardMaterial | undefined
    // 挂在棋子上的接地阴影 / 特征色附着层一起清掉并释放材质（共享材质跳过）
    for (const child of mesh.children.slice()) {
      const childMaterial = (child as Mesh).material as Material | undefined
      if (childMaterial && !this.shared.has(childMaterial)) childMaterial.dispose()
      mesh.remove(child)
    }
    if (material) material.dispose()
    mesh.removeFromParent()
    mesh.rotation.set(0, 0, 0)
    mesh.scale.setScalar(1)
    delete mesh.userData[OWNER_KEY]
    if (!this.free.includes(mesh)) this.free.push(mesh)
  }

  /** 清空所有棋子。 */
  reset(): void {
    // 先收碎片与炸飞的棋子：它们也挂在 group / stageGroup 上，否则会被当成棋子回收进对象池
    this.clearShards()
    this.clearFlyers()
    for (const record of this.records.values()) this.recycle(record.mesh)
    this.records.clear()
    // 叠子（bugv10 #9）与技能挑选标识（bugv10 #2）一起清掉
    for (const record of this.overlays.values()) this.recycle(record.mesh)
    this.overlays.clear()
    this.spotlight = null
    this.hoverMarkerCell = null
    for (const child of this.stageGroup.children.slice()) {
      // 魔法阵等辅助物件由 SceneController 持有引用，这里跳过（它会自行回收）
      if ((child as Mesh).userData.helper === true) continue
      this.recycle(child as Mesh)
    }
    this.auraMaterials.clear()
  }

  /** 连珠瞬间的整体高亮（只提亮度，不给棋子染上特征色，bugv4 #1）。 */
  setMatchGlow(strength: number): void {
    for (const record of this.records.values()) {
      if (strength > 0) record.material.emissive.setHex(0xffffff)
      else record.material.emissive.setHex(0x000000)
      record.material.emissiveIntensity = strength * (record.owner === 0 ? MATCH_GLOW_BLACK : MATCH_GLOW_WHITE)
    }
  }

  /** 运行中更新配色（设置面板；棋盘与舞台棋子一起更新）。 */
  setPalette(palette: Palette): void {
    this.palette = palette
    // 棋盘棋子：只换“黑白本体”，自发光始终为 0，不受特征色影响
    for (const record of this.records.values()) {
      const side = palette.sides[record.owner]
      record.material.color.setHex(side.stone)
    }
    // 舞台棋子：本体仍是黑白，但自发光与附着层用特征色（bugv3 #8）
    for (const child of this.stageGroup.children) {
      const mesh = child as Mesh
      const owner = (mesh.userData[OWNER_KEY] as PlayerIndex | undefined) ?? 0
      const side = palette.sides[owner]
      const material = mesh.material as MeshStandardMaterial
      material.color.setHex(side.stone)
      material.emissive.setHex(side.color)
      const aura = this.auraMaterials.get(mesh)
      if (aura) aura.color.setHex(side.color)
    }
  }

  get boardPieces(): readonly number[] {
    return [...this.records.keys()]
  }

  /** 正在被炸飞的棋子数量（bugv9 #11 验证用）。 */
  get flyingCount(): number {
    return this.flyers.length
  }

  /** 正在飞行的棋子的当前速度（验证"高速逐渐减速"）。 */
  get flyingSpeeds(): number[] {
    return this.flyers.map((flyer) => flyer.velocity.length())
  }

  /** 棋盘上某交点的棋子世界坐标。 */
  worldOf(index: number, out = new Vector3()): Vector3 {
    const mesh = this.records.get(index)?.mesh
    if (!mesh) return cellToWorld(index, out).setY(PIECE_HEIGHT / 2)
    return out.copy(mesh.position)
  }

  dispose(): void {
    this.reset()
    this.geometry.dispose()
    this.groundGeometry.dispose()
    this.markerGeometry.dispose()
    this.groundMaterial.map?.dispose()
    this.groundMaterial.dispose()
    for (const mesh of this.free) mesh.removeFromParent()
    this.free.length = 0
    for (const mesh of this.shardPool) {
      ;(mesh.material as MeshStandardMaterial).dispose()
    }
    this.shardPool.length = 0
  }
}
