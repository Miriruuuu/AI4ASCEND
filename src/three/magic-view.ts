/**
 * 魔力植物层（bugv8 #4 引入，bugv9 #2 大改，bugv10 #12 重做形态，bugv11 #4 配色回退）。
 *
 * 三种植物全部用**程序化几何**拼出来，不需要任何贴图资源：
 * - `flower` 小花：随机弯折的枝条 + 随机数量 / 分布的花瓣 + 花心；
 * - `grass`  劲草：3 ~ 5 根朝随机角度弯折的草叶 + 枝尖的草穗；
 * - `fern`   蕨类：矮茎 + 弯折的叶轴 + 左右数量 / 长度 / 角度都随机的带柄叶片。
 *
 * 配色（bugv11 #4，用户反馈"千层饼"混色看起来更怪，要求退回按部位分色）：
 * **每个部位一种颜色**，四种颜色按下面的表固定分配 ——
 * - 枝干 / 叶轴 / 小柄 / 根座 → 褐 `0x8a5a33`
 * - 叶片 / 蕨叶 / 草叶 → 绿 `0x4f9d5d`
 * - 花心 / 草穗 → 黄 `0xf0c247`
 * - 花瓣 → 银白 `0xf2f6fd`
 *
 * 实现上按"部位"分组烘焙（零件建的时候就写好自己的部位）：整株植物最多 4 个 draw call，
 * 每个 mesh 只有一个纯色材质（不再有半透明叠层，所以也不会再出现一段一段的分节）。
 *
 * 其余表现（随机弯曲的主干、蕨叶长在枝条上、生长动画 / 摇曳 / 萤火虫 / 爆风 /
 * 归属魔法阵 / 特征色外覆层）保持不变。
 *
 * 随机数一律来自 `plantRng(cell, kind)`：同一格 + 同一种永远长出同一株植物，
 * 因此联机两端、回放里看到的都一致。
 */
import {
  AdditiveBlending,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RingGeometry,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { MagicKind, PlayerIndex } from '../core/types'
import { CELL_SIZE, cellToWorld } from './board-view'
import { createMagicTexture } from './magic-texture'
import type { Palette } from './palette'

/** 生长 / 消失动画时长（秒）。 */
const GROW_DURATION = 0.5
const FADE_DURATION = 0.26
/** 植物整体的缩放（bugv9 #2：比原来大一圈）。 */
const PLANT_SCALE = 2.05
/** 摆动幅度（bugv9 #2：要求"幅度可以大一些"）。 */
const SWAY_ANGLE = 0.12
const SWAY_TWIST = 0.09
/** 占地光环（保留：被 `ring` 引用的兼容字段现在指向魔法阵）。 */
const RING_INNER = CELL_SIZE * 0.3
const RING_OUTER = CELL_SIZE * 0.4
/** 占位魔法阵的直径（与悬浮棋子的魔法阵同一套贴图）。 */
const PLANT_CIRCLE_SIZE = CELL_SIZE * 0.92
/** 接地阴影：浅色页面上"银白植物"容易糊在背景里，需要一个暗底托着。 */
const SHADOW_RADIUS = CELL_SIZE * 0.2

/**
 * 四种颜色（bugv11 #4 按"部位"分配，十六进制值被验证脚本读取，**不要改**）。
 */
const OUTER_COLOR = 0xf2f6fd
const INNER_COLOR = 0xf0c247
const BASE_COLOR = 0x8a5a33
/** 第四色：绿（叶片 / 花瓣）。 */
const GREEN_COLOR = 0x4f9d5d
/** 污染体的深红高光（bugv34「雷暴」）：body 用深红、自发光用亮红，读起来像"被污染"。 */
const POLLUTION_COLOR = 0x8b1e2d
const POLLUTION_GLOW = 0xff3b30
/** 冻结的魔力植物（bugv34c「暴雪」）：整体雪白 + 淡蓝自发光（表面另撒冰晶）。 */
const FROZEN_COLOR = 0xeaf4ff
const FROZEN_GLOW = 0x8fd0ff

/**
 * 某种植物的"部位 → 基准色"。
 *
 * 普通植物按部位分四色；**污染体 / 冻结体整株单色**。
 * ⚠️ `applyDim()` 会用这张表把颜色重置回去（压暗 / 恢复），
 * 所以它必须**按 kind** 取色 —— 否则技能挑选一来，冻结体就被刷回绿褐色了。
 */
function partColors(kind: MagicKind): { outer: number; inner: number; base: number; green: number } {
  if (kind === 'pollution') {
    return { outer: POLLUTION_COLOR, inner: POLLUTION_COLOR, base: POLLUTION_COLOR, green: POLLUTION_COLOR }
  }
  if (kind === 'frozen') {
    return { outer: FROZEN_COLOR, inner: FROZEN_COLOR, base: FROZEN_COLOR, green: FROZEN_COLOR }
  }
  return { outer: OUTER_COLOR, inner: INNER_COLOR, base: BASE_COLOR, green: GREEN_COLOR }
}
/** 技能挑选时被压暗的系数（bugv10 #2）。 */
const DIM_FACTOR = 0.34
/** 特征色外覆层的透明度。 */
const AURA_OPACITY = 0.34
/** 爆风影响半径（格数）与最长恢复时间。 */
const BLAST_RADIUS = 3.4
const BLAST_DECAY = 2.6

/**
 * 一株植物的四套材质。名字沿用 bugv9 的 `outer / inner / base`（银白 / 黄 / 褐），
 * 外加 `green`；每一株都会 clone 一份，被占住时要单独改外覆层、也要能单独释放。
 */
interface PlantMaterials {
  /** 银白：花瓣。 */
  outer: MeshStandardMaterial
  /** 黄：花心 / 草穗。 */
  inner: MeshStandardMaterial
  /** 褐：枝干 / 叶轴 / 小柄 / 根座。 */
  base: MeshStandardMaterial
  /** 绿：叶片 / 蕨叶 / 草叶。 */
  green: MeshStandardMaterial
}

/** 部位（决定用哪一套材质）。 */
type PlantColorKey = keyof PlantMaterials

/** 部位 → 颜色（bugv11 #4 的分配表，验证脚本按它断言）。 */
const PART_NAMES: Record<PlantColorKey, string> = {
  base: '枝干',
  green: '叶片',
  inner: '花心',
  outer: '花瓣',
}

/**
 * 全视图共用的"单位几何"：具体长短粗细由每个 mesh 的 `scale` 决定。
 * 这样一株 20 ~ 40 个 mesh 的植物只用到 4 个几何体，绘制开销和显存都可控。
 */
interface PlantGeometries {
  /** 单位锥台：底半径 1 / 顶半径 0.62 / 高 1（缩放后就是任意一节枝干或小柄）。 */
  stem: CylinderGeometry
  /** 单位叶片：半径 0.5 的球（压扁之后就是花瓣 / 蕨叶）。 */
  leaf: SphereGeometry
  /** 单位球（半径 1）：花心 / 根座。 */
  sphere: SphereGeometry
  /** 单位圆锥（半径 1 / 高 1）：草穗。 */
  cone: ConeGeometry
}

interface BuildContext {
  materials: PlantMaterials
  geometries: PlantGeometries
  random: () => number
}

interface Firefly {
  mesh: Mesh
  material: MeshBasicMaterial
  /** 绕植物中心的公转相位 / 半径 / 高度 / 速度。 */
  phase: number
  radius: number
  height: number
  speed: number
}

interface PlantRecord {
  cell: number
  kind: MagicKind
  owner: PlayerIndex | null
  /** 根节点：位置 / 生长缩放 / 摆动都写在这里。 */
  root: Group
  /** 植物本体（四色几何）。 */
  plant: Group
  /** 特征色外覆层（被占住时显示）。 */
  aura: Group
  /** 外覆层材质（每株独立，便于单独改色 / 释放）。 */
  auraMaterial: MeshStandardMaterial
  /** 归属魔法阵（被占住时显示）。兼容字段名 `ring`。 */
  ring: Mesh
  /** 技能挑选时"已勾选"的高光圆环（bugv10 #2）。 */
  pickRing: Mesh
  shadow: Mesh
  fireflies: Firefly[]
  materials: PlantMaterials
  /** 每棵植物错开的摇摆相位。 */
  phase: number
  /** 0 → 1 的生长进度。 */
  grow: number
  /** 正在消失（倒计时）。 */
  fading: number | null
  /** 爆风造成的偏转：方向 + 强度（随时间衰减并回弹）。 */
  blastDir: Vector3
  blastStrength: number
  blastAge: number
  /** 是否处于技能挑选高亮（bugv9 #13）。 */
  selecting: boolean
  /** 技能挑选时是否已经被勾选（bugv10 #2）。 */
  picked: boolean
  /** 是否被"挑选状态"压暗（bugv10 #2）。 */
  dimmed: boolean
  /** 烘焙前的零件统计（验证 / 调试用）。 */
  parts: PlantParts
}

/** 由格子 + 种类派生的确定性随机（保证联机两端、回放里的长相一致）。 */
function plantRng(cell: number, kind: MagicKind): () => number {
  const kindSeed = kind === 'flower' ? 0x9e3779b9 : kind === 'grass' ? 0x85ebca6b : 0xc2b2ae35
  let state = (Math.imul(cell + 1, 0x27d4eb2d) ^ kindSeed) >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface StemOptions {
  /** 节数（主干 5 ~ 7 节最自然）。 */
  segments: number
  /** 总长。 */
  length: number
  /** 根部半径。 */
  radius: number
  /** 整体朝 `yaw` 方向倾倒的总角度（弧度）——均摊到每一节。 */
  lean: number
  /** 倾倒方向。 */
  yaw: number
  /**
   * 逐节的**小噪声**（弧度）。
   *
   * 只负责"不那么规整"的一点点抖动；真正的弯曲量看 `curve`。
   */
  jitter: number
  /**
   * 整根枝条额外的**总弯曲弧度**（bugv11 追加 #6）。
   *
   * 以前只有 `jitter`（每节独立随机）→ 累加起来是"白噪声折线"，
   * 远看还是一条直棍、近看全是硬折角。现在把它按一条**正弦形状**分配到各节，
   * 逐节累加就是一条平滑的弧线（S 形），这才是"能弯曲"。
   */
  curve?: number
  /**
   * 颜色循环的起始偏移（bugv10 #12 的"每节换色"遗留）。
   *
   * bugv11 #4 起整根枝条只有一个颜色，这个偏移已经不影响配色，
   * 保留是为了让"每根枝条的节长随机"保持同一套随机数序列。
   */
  colorOffset: number
  /**
   * 这一串枝干算哪个部位（bugv11 #4）。
   *
   * 默认褐色（枝干 / 叶轴 / 小柄）；草的叶子虽然也是用"锥台"拼的，
   * 但它显然是叶片，所以传 `'green'`。
   */
  part?: PlantColorKey
}

/**
 * 一串首尾相接、逐节随机偏转的枝干。
 *
 * 关键点是 `tip`：它是最后一节的末端挂点，位置和朝向都包含了前面所有节的累积弯折，
 * 所以花头 / 草穗 / 叶轴挂在它上面，就一定长在枝尖、并且顺着枝的弯折方向。
 * `joints[k]` 是第 k 节的起点坐标系（局部 +Y 就是这一节的方向），叶子的挂点用它。
 */
interface StemChain {
  group: Group
  tip: Group
  joints: Group[]
  lengths: number[]
  /** 总长（= options.length，方便按比例取点）。 */
  length: number
}

/**
 * 弯折枝干（bugv10 #12 引入，bugv11 追加 #6 改成平滑弧线）。
 *
 * 把主干切成 `segments` 小节：
 * - 整体倾倒角 `lean` 均摊到每一节（保证"整体朝某个方向长"）；
 * - 再把总弯曲量 `curve` 按 `sin` 形状分配到各节 —— 逐节累加后是一条**平滑的 S 形弧线**，
 *   而不是每节独立随机造成的硬折角（那样看起来还是竹竿/狗腿）；
 * - 最后叠一点点 `jitter` 噪声，让它不那么规整。
 *
 * 关键点是 `tip`：它是最后一节的末端挂点，位置与朝向都包含前面所有节的累积弯折，
 * 所以花头 / 草穗 / 叶轴挂在它上面，就一定长在枝尖、并且顺着枝的弯折方向。
 */
function buildStemChain(context: BuildContext, options: StemOptions): StemChain {
  const { materials, geometries, random } = context
  const part: PlantColorKey = options.part ?? 'base'
  const segments = Math.max(1, Math.round(options.segments))
  // 每一节的长度带随机：等分的节看起来还是"竹节"
  const weights: number[] = []
  let weightSum = 0
  for (let i = 0; i < segments; i++) {
    const weight = 0.78 + random() * 0.44
    weights.push(weight)
    weightSum += weight
  }
  const lengths = weights.map((weight) => (options.length * weight) / weightSum)
  const leanStep = options.lean / segments
  const yawStep = options.yaw / segments
  const curve = options.curve ?? 0
  // 正弦形状的弯曲分配：Σ(每节) ≈ curve（面积归一），两端小、中间大 → 自然弧线
  const curveStep = (curve * Math.PI) / (2 * segments)
  const curveFreq = 0.7 + random() * 0.6
  const curvePhase = random() * Math.PI * 2
  // 侧向也带一点同相位的摆动，枝条才不会只在同一个平面里弯
  const yawCurveStep = curveStep * (0.25 + random() * 0.35)

  const group = new Group()
  const joints: Group[] = []
  let cursor: Group = group
  for (let i = 0; i < segments; i++) {
    const t = segments <= 1 ? 0.5 : (i + 0.5) / segments
    const wave = Math.sin(t * Math.PI * curveFreq + curvePhase)
    const yawWave = Math.cos(t * Math.PI * curveFreq * 0.85 + curvePhase)
    const joint = new Group()
    // 平滑弧线（curveStep·wave 逐节累加 = 弧线）+ 一点点随机噪声
    joint.rotation.y = yawStep + yawCurveStep * yawWave + (random() * 2 - 1) * options.jitter * 0.5
    joint.rotation.z = leanStep + curveStep * wave + (random() * 2 - 1) * options.jitter * 0.7
    joint.rotation.x = curveStep * wave * 0.35 + (random() * 2 - 1) * options.jitter * 0.5
    cursor.add(joint)
    joints.push(joint)

    const height = lengths[i]
    // 越往上越细：看得出是枝条而不是柱子
    const radius = options.radius * (1 - (i / segments) * 0.4)
    // bugv11 #4：一整串枝干只有一个颜色（枝干褐 / 草叶绿）
    const mesh = new Mesh(geometries.stem, materials[part])
    mesh.userData.part = part
    mesh.scale.set(radius, height, radius)
    mesh.position.y = height / 2
    joint.add(mesh)

    const end = new Group()
    end.position.y = height
    joint.add(end)
    cursor = end
  }
  return { group, tip: cursor, joints, lengths, length: options.length }
}

/**
 * 在弯折枝干上找一个挂点：`t` 是沿枝长的比例（0 = 根部，1 = 枝尖）。
 * 返回的 Group 是**该节坐标系**里的一个点，局部 +Y 就是枝轴方向，
 * 因此围着 Z 轴转一下就是"从枝条上朝外长出去"。
 */
function socketOnStem(chain: StemChain, t: number): Group {
  const target = Math.min(Math.max(t, 0), 0.999) * chain.length
  let index = 0
  let before = 0
  while (index < chain.lengths.length - 1 && before + chain.lengths[index] < target) {
    before += chain.lengths[index]
    index += 1
  }
  const socket = new Group()
  socket.position.y = Math.max(target - before, 0)
  chain.joints[index].add(socket)
  return socket
}

/**
 * 一片花瓣（bugv11 #4 银白，追加 #6 改成**扁平**花瓣）。
 *
 * 两小节只负责"根部平、尖端微微上翘/侧卷"的形状。关键是**厚度**：
 * 以前用 `width * 0.42` 的胖椭球，5~8 片凑在一起就成了一坨（用户反馈"花瓣拧成一团"），
 * 现在压到 `width * 0.13` 左右，才是花瓣而不是花瓣形的球。
 */
function buildBandedPetal(
  context: BuildContext,
  length: number,
  width: number,
  colorOffset: number,
  bend: number,
): Group {
  const { materials, geometries } = context
  void colorOffset
  const group = new Group()
  const half = length / 2

  const inner = new Mesh(geometries.leaf, materials.outer)
  inner.userData.part = 'outer'
  inner.scale.set(width, half, width * 0.13)
  inner.position.y = half / 2
  group.add(inner)

  const outerJoint = new Group()
  outerJoint.position.y = half
  outerJoint.rotation.z = bend
  const outer = new Mesh(geometries.leaf, materials.outer)
  outer.userData.part = 'outer'
  outer.scale.set(width * 0.72, half, width * 0.1)
  outer.position.y = half / 2
  outerJoint.add(outer)
  group.add(outerJoint)
  return group
}

/** 随机化的小花：随机弯折的枝条 + 从花心长出来的花瓣 + 花心 + 花萼。 */
function buildFlower(context: BuildContext): Group {
  const { materials, geometries, random } = context
  const group = new Group()
  const stem = buildStemChain(context, {
    // bugv11 追加 #6：节数多 + 平滑弧线（curve），主干是自然弯曲的茎，不再是竹竿
    segments: 8 + Math.floor(random() * 3),
    length: 0.3 + random() * 0.16,
    radius: 0.017,
    lean: 0.16 + random() * 0.44,
    yaw: random() * Math.PI * 2,
    jitter: 0.03,
    curve: 0.55 + random() * 0.4,
    colorOffset: Math.floor(random() * 4),
  })
  group.add(stem.group)

  // 花头挂在枝尖挂点上：位置与朝向都跟着弯折走，绝不会浮空
  const head = new Group()
  head.rotation.y = random() * Math.PI * 2
  head.rotation.z = (random() * 2 - 1) * 0.18
  stem.tip.add(head)

  const coreRadius = 0.032
  const core = new Mesh(geometries.sphere, materials.inner)
  core.userData.part = 'inner'
  core.scale.setScalar(coreRadius)
  head.add(core)

  /**
   * 花瓣绕花心一圈（bugv11 追加 #7）。
   *
   * ⚠️ 关键在于 Euler 的**旋转顺序**：three.js 默认 `'XYZ'` 是"先绕 Z、再绕 Y、最后绕 X"，
   * 所以"先平铺再转到方位角"必须写成 `'YXZ'`（先 Z、再 X、最后 Y）。
   * 之前用默认顺序 + `rotation.y = -angle`，方位角几乎被后面的 X 旋转吃掉，
   * 结果是**所有花瓣都朝同一个方向**、叠在一起（用户反馈"堆叠到一起/拧成一团"）。
   *
   * 现在：花瓣沿半径方向均匀分布在一圈上（只留 ±0.05rad 的抖动），
   * 每片先平铺（抬 6~16°）再绕 Y 转到自己的方位角，根部落在花心表面内侧。
   */
  const petals = 5 + Math.floor(random() * 3)
  for (let i = 0; i < petals; i++) {
    const angle = (i / petals) * Math.PI * 2 + (random() * 2 - 1) * 0.05
    const radius = coreRadius * 0.85 + random() * 0.003
    const petal = new Group()
    petal.position.set(Math.cos(angle) * radius, 0.002 + random() * 0.006, Math.sin(angle) * radius)
    petal.rotation.order = 'YXZ'
    petal.rotation.set(
      // 平铺：抬离水平面 6~16°，花瓣才不会立起来糊在一起
      Math.PI / 2 - (0.1 + random() * 0.18),
      // 方位角：让花瓣指向它所在的那条半径（沿 +Z 转过来）
      Math.PI / 2 - angle,
      // 沿自身轴一点点侧卷
      (random() * 2 - 1) * 0.1,
    )
    petal.add(
      buildBandedPetal(
        context,
        0.09 + random() * 0.025,
        0.042 + random() * 0.012,
        i + Math.floor(random() * 4),
        random() * 0.5 - 0.25,
      ),
    )
    head.add(petal)
  }

  // 花萼：花头底下的一小截托子
  const calyx = buildStemChain(context, {
    segments: 3,
    length: 0.038,
    radius: 0.03,
    lean: 0,
    yaw: random() * Math.PI * 2,
    jitter: 0.14,
    curve: 0.18,
    colorOffset: Math.floor(random() * 4),
  })
  calyx.group.rotation.x = Math.PI
  head.add(calyx.group)
  return group
}

/**
 * 草穗（bugv11 追加 #6）：以前是"一根粗圆锥"，看起来像导弹发射器。
 * 现在用 3 节**细长锥台**串成一根麦穗（半径 0.0075、随叶尖方向自然微弯），
 * 尖端再收一个更小的细锥，观感是"穗"而不是"弹头"。
 */
function buildEar(context: BuildContext, tip: Group, random: () => number): void {
  const { materials, geometries } = context
  const spike = buildStemChain(context, {
    segments: 3,
    length: 0.055 + random() * 0.02,
    radius: 0.0075,
    lean: 0.1 + random() * 0.12,
    yaw: random() * Math.PI * 2,
    jitter: 0.05,
    curve: 0.35,
    colorOffset: 0,
    part: 'inner',
  })
  tip.add(spike.group)
  // 尖端：很细的小锥，收出麦芒感
  const tipCap = new Mesh(geometries.cone, materials.inner)
  tipCap.userData.part = 'inner'
  tipCap.scale.set(0.0055, 0.026, 0.0055)
  tipCap.position.y = 0.013
  spike.tip.add(tipCap)
}

/** 3 ~ 5 根朝随机角度弯曲的草，草穗长在枝尖挂点上。 */
function buildGrass(context: BuildContext): Group {
  const { materials, geometries, random } = context
  const group = new Group()

  // 根部基座：两小块叠在一起（bugv11 #4：根座算"枝干"部位，褐色）
  const base = new Mesh(geometries.sphere, materials.base)
  base.userData.part = 'base'
  base.scale.set(0.052, 0.024, 0.052)
  base.position.y = 0.016
  group.add(base)
  const baseTop = new Mesh(geometries.sphere, materials.base)
  baseTop.userData.part = 'base'
  baseTop.scale.set(0.036, 0.022, 0.036)
  baseTop.position.y = 0.032
  group.add(baseTop)

  const blades = 3 + Math.floor(random() * 3)
  for (let i = 0; i < blades; i++) {
    const yaw = (i / blades) * Math.PI * 2 + random() * 0.8
    const blade = buildStemChain(context, {
      // bugv11 追加 #6：草叶是一条长长的弧线（curve 更大），不是直线
      segments: 8 + Math.floor(random() * 3),
      length: 0.28 + random() * 0.2,
      radius: 0.019,
      lean: 0.4 + random() * 0.75,
      yaw,
      jitter: 0.035,
      curve: 0.9 + random() * 0.55,
      colorOffset: Math.floor(random() * 4),
      // 草叶就是叶子，走"叶片"部位（绿色）
      part: 'green',
    })
    // 草穗：细长麦穗挂在枝尖挂点上，跟着弯折走
    buildEar(context, blade.tip, random)
    group.add(blade.group)
  }
  return group
}

/**
 * 蕨叶：内端（小柄的根部）就锚在叶轴的挂点上，朝枝轴的外侧偏上伸出去。
 * bugv11 #4：小柄是褐（枝干部位）、叶片是绿（叶片部位）。
 */
function buildFernLeaf(context: BuildContext, socket: Group, sign: number, colorOffset: number): void {
  const { materials, geometries, random } = context
  void colorOffset
  const petioleLength = 0.02 + random() * 0.016
  const bladeLength = 0.085 + random() * 0.055
  const bladeWidth = 0.04 + random() * 0.022

  // 小柄：细枝，从挂点（一定落在叶轴上）往外长
  const petiole = new Mesh(geometries.stem, materials.base)
  petiole.userData.part = 'base'
  petiole.scale.set(petioleLength * 0.3, petioleLength, petioleLength * 0.3)
  petiole.position.y = petioleLength / 2
  socket.add(petiole)

  // 叶片：接在小柄末端
  const bladeJoint = new Group()
  bladeJoint.position.y = petioleLength
  // 再往外抬一点：叶子整体朝枝轴外侧（大致水平偏上）伸出去
  bladeJoint.rotation.z = sign * (0.1 + random() * 0.3)
  bladeJoint.rotation.x = (random() * 2 - 1) * 0.2
  const blade = new Mesh(geometries.leaf, materials.green)
  blade.userData.part = 'green'
  blade.scale.set(bladeWidth, bladeLength, bladeWidth * 0.36)
  blade.position.y = bladeLength / 2
  bladeJoint.add(blade)
  socket.add(bladeJoint)
}

/** 蕨类：矮茎 + 弯折的叶轴 + 左右数量 / 长度 / 角度都随机的带柄叶片。 */
function buildFern(context: BuildContext): Group {
  const { random } = context
  const group = new Group()

  // 矮茎：4 ~ 5 节的弯折枝条（bugv11 追加 #6：平滑弧线）
  const baseStem = buildStemChain(context, {
    segments: 4 + Math.floor(random() * 2),
    length: 0.15 + random() * 0.05,
    radius: 0.018,
    lean: 0.12 + random() * 0.26,
    yaw: random() * Math.PI * 2,
    jitter: 0.03,
    curve: 0.3 + random() * 0.25,
    colorOffset: Math.floor(random() * 4),
  })
  group.add(baseStem.group)

  // 叶轴（rachis）：同样用弯折链，叶子直接挂在它的关节上，跟着弯折一起走
  // bugv11 追加 #6：8 节 + 明显的平滑外弯 —— 蕨叶的叶轴是舒展的弧线
  const rachis = buildStemChain(context, {
    segments: 8 + Math.floor(random() * 2),
    length: 0.22 + random() * 0.07,
    radius: 0.0085,
    lean: 0.24 + random() * 0.34,
    yaw: random() * Math.PI * 2,
    jitter: 0.03,
    curve: 0.7 + random() * 0.45,
    colorOffset: Math.floor(random() * 4),
  })
  baseStem.tip.add(rachis.group)

  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? -1 : 1
    // 每侧 4 ~ 6 片
    const leaves = 4 + Math.floor(random() * 3)
    // 两侧交错排布（真实蕨叶就是这样），第二侧整体错开半格
    const offset = side === 0 ? 0 : 0.5 / leaves
    for (let i = 0; i < leaves; i++) {
      const t = Math.min(0.16 + ((i + 0.5) / leaves + offset) * 0.78, 0.98)
      const socket = socketOnStem(rachis, t)
      socket.rotation.y = (random() * 2 - 1) * 0.45
      // 相对枝轴朝外、略向上伸出去
      socket.rotation.z = sign * (0.9 + random() * 0.4)
      socket.rotation.x = (random() * 2 - 1) * 0.22
      buildFernLeaf(context, socket, sign, i + side * 2 + Math.floor(random() * 4))
    }
  }
  return group
}

/**
 * 污染体（bugv34「雷暴」天气）：形态复用蕨类，但**整株**（最外层）都覆盖深红色高光
 * —— 结算伤害时每棵 +2（引擎里实现）。
 *
 * 直接改写这一株克隆出来的四套材质（它们是本株私有的，改色不会影响别的植物），
 * 再交给 `buildFern` 拼几何。
 */
function buildPollution(context: BuildContext): Group {
  for (const material of [
    context.materials.base,
    context.materials.green,
    context.materials.inner,
    context.materials.outer,
  ]) {
    material.color.setHex(POLLUTION_COLOR)
    material.emissive.setHex(POLLUTION_GLOW)
    material.emissiveIntensity = 0.9
  }
  return buildFern(context)
}

/**
 * 「暴雪」：**冻结的魔力植物**（bugv34c）。
 *
 * 需求原文："魔力植物的配色换为雪白色、表面随机分布不规则的冰晶"。
 * 做法：先把整套材质换成雪白 + 淡蓝自发光，再在蕨形本体外面随机撒一把
 * 细长的"冰晶"（圆锥压细 → 像冰锥/晶簇），每株的朝向、长度、位置都随种子变化。
 */
function buildFrozen(context: BuildContext): Group {
  const { materials, geometries, random } = context
  for (const material of [materials.base, materials.green, materials.inner, materials.outer]) {
    material.color.setHex(FROZEN_COLOR)
    material.emissive.setHex(FROZEN_GLOW)
    material.emissiveIntensity = 0.55
  }
  const group = buildFern(context)

  const crystalCount = 7 + Math.floor(random() * 6)
  for (let index = 0; index < crystalCount; index += 1) {
    const crystal = new Mesh(geometries.cone, materials.outer)
    crystal.userData.part = 'outer'
    const length = 0.028 + random() * 0.05
    const radius = 0.008 + random() * 0.009
    crystal.scale.set(radius, length, radius)
    crystal.position.set(
      (random() * 2 - 1) * 0.075,
      0.03 + random() * 0.19,
      (random() * 2 - 1) * 0.075,
    )
    crystal.rotation.set((random() * 2 - 1) * 1.15, random() * Math.PI * 2, (random() * 2 - 1) * 1.15)
    group.add(crystal)
  }
  return group
}

const GEOMETRY_BUILDERS: Record<MagicKind, (context: BuildContext) => Group> = {
  flower: buildFlower,
  grass: buildGrass,
  fern: buildFern,
  pollution: buildPollution,
  frozen: buildFrozen,
}

/** 每株植物烘焙前的零件统计（验证 / 调试用，bugv10 追加 #3 之后几何被合并了）。 */
interface PlantParts {
  /** 叶片（扁球）数量。 */
  leaves: number
  /** 枝干（锥台）数量。 */
  stems: number
  /** 每片叶子的"内端"到最近枝干中心的距离（植物局部单位，越大越像漂浮）。 */
  maxLeafGap: number
  /** 枝干在水平方向上的最大偏移（越大越弯）。 */
  bend: number
}

/** 统计 / 量测一株植物的零件（在烘焙之前调用）。 */
function measureParts(built: Group): PlantParts {
  built.updateWorldMatrix(true, true)
  const stems: Array<{ mesh: Mesh; at: Vector3 }> = []
  const leaves: Array<{ mesh: Mesh; at: Vector3 }> = []
  built.traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const at = mesh.getWorldPosition(new Vector3())
    if (mesh.geometry.type === 'CylinderGeometry') stems.push({ mesh, at })
    else if (mesh.geometry.type === 'SphereGeometry') leaves.push({ mesh, at })
  })
  let maxLeafGap = 0
  for (const leaf of leaves) {
    const inner = leaf.mesh.localToWorld(new Vector3(0, -0.5, 0))
    let best = Number.POSITIVE_INFINITY
    for (const stem of stems) best = Math.min(best, inner.distanceTo(stem.at))
    if (Number.isFinite(best)) maxLeafGap = Math.max(maxLeafGap, best)
  }
  const bend = stems.reduce((max, stem) => Math.max(max, Math.hypot(stem.at.x, stem.at.z)), 0)
  return { leaves: leaves.length, stems: stems.length, maxLeafGap, bend }
}

/**
 * 按"部位"分色（bugv11 #4）。
 *
 * 每个零件在建的时候就写好自己的部位（`mesh.userData.part`），这里按部位分组烘焙：
 * 一株植物最多 4 个 mesh（4 个 draw call），每个 mesh 一个纯色 ——
 * 枝干 / 叶轴 / 小柄 褐、叶片 / 蕨叶 / 草叶 绿、花心与草穗 黄、花瓣 银白。
 */
const PART_LAYERS: ReadonlyArray<keyof PlantMaterials> = ['base', 'green', 'inner', 'outer']

/**
 * 把一株"零件拼出来的"植物的**某个部位**烘焙成一个 BufferGeometry：
 * 只挑标了这个部位的零件，按它在植物里的世界变换烘进同一个几何。
 *
 * 好处：整株植物从几十个 draw call 变成最多 4 个，而配色仍然是"每个部位一块纯色"。
 */
function bakePart(built: Group, part: keyof PlantMaterials): BufferGeometry | null {
  built.updateWorldMatrix(true, true)
  const parts: BufferGeometry[] = []
  built.traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    if (mesh.userData.part !== part) return
    const geometry = mesh.geometry.clone()
    geometry.applyMatrix4(mesh.matrixWorld)
    // 统一属性集合，保证可以合并（本视图只用位置 / 法线 / uv）
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') geometry.deleteAttribute(name)
    }
    parts.push(geometry)
  })
  if (parts.length === 0) return null
  const merged = mergeGeometries(parts, false)
  for (const item of parts) item.dispose()
  return merged
}

export class MagicView {
  readonly group = new Group()

  private palette: Palette
  private readonly plants = new Map<number, PlantRecord>()
  private readonly ringGeometry = new RingGeometry(RING_INNER, RING_OUTER, 28)
  private readonly circleGeometry = new PlaneGeometry(1, 1)
  private readonly shadowGeometry = new CircleGeometry(SHADOW_RADIUS, 24)
  private readonly fireflyGeometry = new SphereGeometry(0.026, 8, 6)
  /** "已勾选"的高光圆环（bugv10 #2）。 */
  private readonly pickRingGeometry = new RingGeometry(CELL_SIZE * 0.36, CELL_SIZE * 0.46, 36)
  private readonly shadowMaterial = new MeshBasicMaterial({
    color: 0x2a3140,
    transparent: true,
    opacity: 0.1,
    depthWrite: false,
  })
  /** 魔法阵贴图（与悬浮攻击棋子共用）。 */
  private readonly magicTexture = createMagicTexture()
  /**
   * 全视图共用的"单位几何"（bugv10 #12）：一株植物几十个 mesh 也只引用这 4 个几何体，
   * 具体尺寸全部写在 `mesh.scale` 上。
   */
  private readonly geometries: PlantGeometries = {
    stem: new CylinderGeometry(0.62, 1, 1, 6),
    leaf: new SphereGeometry(0.5, 8, 6),
    sphere: new SphereGeometry(1, 10, 8),
    cone: new ConeGeometry(1, 1, 5),
  }
  /**
   * 四色材质模板（每棵植物会 clone 一份，便于单独释放）。
   * 模板本身不挂到场景上，只用于 clone。
   */
  private readonly materialTemplate: PlantMaterials

  constructor(palette: Palette) {
    this.palette = palette
    this.materialTemplate = {
      outer: new MeshStandardMaterial({
        color: OUTER_COLOR,
        emissive: 0xbcd2ee,
        emissiveIntensity: 0.42,
        metalness: 0.3,
        roughness: 0.3,
      }),
      inner: new MeshStandardMaterial({
        color: INNER_COLOR,
        emissive: 0xc98f18,
        emissiveIntensity: 0.5,
        metalness: 0.2,
        roughness: 0.38,
      }),
      base: new MeshStandardMaterial({
        color: BASE_COLOR,
        emissive: 0x2a1608,
        emissiveIntensity: 0.16,
        metalness: 0.1,
        roughness: 0.68,
      }),
      green: new MeshStandardMaterial({
        color: GREEN_COLOR,
        emissive: 0x1f5c2f,
        emissiveIntensity: 0.34,
        metalness: 0.15,
        roughness: 0.52,
      }),
    }
  }

  get count(): number {
    return this.plants.size
  }

  /** 某格上的植物（验证脚本 / 调试用）。 */
  at(cell: number): PlantRecord | undefined {
    return this.plants.get(cell)
  }

  get cells(): number[] {
    return [...this.plants.keys()].sort((a, b) => a - b)
  }

  /** 长出一棵植物。 */
  spawn(cell: number, kind: MagicKind, owner: PlayerIndex | null = null, animate = true): void {
    this.despawn(cell)
    const random = plantRng(cell, kind)

    const root = new Group()
    const materials: PlantMaterials = {
      outer: this.materialTemplate.outer.clone(),
      inner: this.materialTemplate.inner.clone(),
      base: this.materialTemplate.base.clone(),
      green: this.materialTemplate.green.clone(),
    }
    // 每棵植物高矮略有差异，一片植物才不会像复制粘贴
    const sizeVariation = 0.88 + random() * 0.26
    // 明暗差异写在自发光强度上：`color` 的十六进制值必须保持精确（验证脚本会读它们）
    const tone = 0.9 + random() * 0.22
    for (const material of [materials.outer, materials.inner, materials.base, materials.green]) {
      material.emissiveIntensity *= tone
    }
    root.userData.sizeVariation = sizeVariation

    const plant = new Group()
    // bugv11 #4：先按零件把植物搭出来，再按"部位"烘焙成最多 4 块纯色几何
    const built = GEOMETRY_BUILDERS[kind]({ materials, geometries: this.geometries, random })
    // 烘焙之后零件就合并了，先把结构指标记下来（验证脚本仍然能检查叶片长在枝条上）
    const parts = measureParts(built)
    for (const key of PART_LAYERS) {
      const geometry = bakePart(built, key)
      if (!geometry) continue
      const material = materials[key]
      // 每个部位都是不透明纯色：不再有叠层混色，也就不会出现"一段一段"的分节
      material.transparent = false
      material.opacity = 1
      material.depthWrite = true
      material.side = DoubleSide
      const mesh = new Mesh(geometry, material)
      mesh.renderOrder = 0
      mesh.name = `plant-part-${key}`
      mesh.userData.partLabel = PART_NAMES[key]
      plant.add(mesh)
    }
    root.add(plant)

    // 特征色外覆层：整株再套一层略大的同形外壳（bugv9 #2 第 3 点）
    const auraMaterial = new MeshStandardMaterial({
      color: this.palette.sides[owner ?? 0].color,
      emissive: this.palette.sides[owner ?? 0].glow,
      emissiveIntensity: 0.75,
      transparent: true,
      opacity: AURA_OPACITY,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    })
    const aura = plant.clone(true)
    aura.traverse((object) => {
      const mesh = object as Mesh
      if (!mesh.isMesh) return
      mesh.material = auraMaterial
      mesh.scale.multiplyScalar(1.14)
    })
    aura.visible = owner !== null
    root.add(aura)

    // 接地阴影
    const shadow = new Mesh(this.shadowGeometry, this.shadowMaterial)
    shadow.rotation.x = -Math.PI / 2
    shadow.position.y = 0.002
    shadow.renderOrder = -1
    root.add(shadow)

    // 归属魔法阵（bugv9 #2 第 6 点：与悬浮棋子一致的旋转双正方形）
    const circleMaterial = new MeshBasicMaterial({
      map: this.magicTexture,
      color: this.palette.sides[owner ?? 0].color,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    })
    const ring = new Mesh(this.circleGeometry, circleMaterial)
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.006
    ring.scale.setScalar(PLANT_CIRCLE_SIZE)
    ring.visible = owner !== null
    root.add(ring)

    // 萤火虫：3 ~ 5 颗绕着植物飘的荧光点（bugv9 #2 第 4 点）
    const fireflies: Firefly[] = []
    const motes = 3 + Math.floor(random() * 3)
    for (let i = 0; i < motes; i++) {
      const material = new MeshBasicMaterial({
        color: 0xf6f2c8,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        blending: AdditiveBlending,
      })
      const mesh = new Mesh(this.fireflyGeometry, material)
      const phase = random() * Math.PI * 2
      const radius = CELL_SIZE * (0.2 + random() * 0.26)
      const height = 0.22 + random() * 0.42
      const speed = 0.7 + random() * 1.1
      mesh.position.set(Math.cos(phase) * radius, height, Math.sin(phase) * radius)
      root.add(mesh)
      fireflies.push({ mesh, material, phase, radius, height, speed })
    }

    // bugv10 #2：技能挑选时"已勾选"的高光标识（一圈明亮的特征色圆环）
    const pickMaterial = new MeshBasicMaterial({
      color: this.palette.sides[owner ?? 0].color,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    })
    const pickRing = new Mesh(this.pickRingGeometry, pickMaterial)
    pickRing.rotation.x = -Math.PI / 2
    pickRing.position.y = 0.02
    pickRing.visible = false
    root.add(pickRing)

    // 错开一点位置，看起来像自己从棋盘里钻出来，而不是排成阵列
    const offsetX = (((cell * 37) % 7) - 3) * 0.026
    const offsetZ = (((cell * 53) % 7) - 3) * 0.026
    const position = cellToWorld(cell)
    root.position.set(position.x + offsetX, 0, position.z + offsetZ)
    root.scale.setScalar(animate ? 0.01 : PLANT_SCALE * sizeVariation)
    this.group.add(root)

    this.plants.set(cell, {
      cell,
      kind,
      owner,
      root,
      plant,
      aura,
      auraMaterial,
      ring,
      pickRing,
      shadow,
      fireflies,
      materials,
      phase: (cell % 9) * 0.7 + (cell % 5) * 0.31,
      grow: animate ? 0 : 1,
      fading: null,
      blastDir: new Vector3(0, 0, 0),
      blastStrength: 0,
      blastAge: 0,
      selecting: false,
      picked: false,
      dimmed: false,
      parts,
    })
  }

  /** 归属变化（被某一方占住 / 抢走）。 */
  claim(cell: number, owner: PlayerIndex): void {
    const record = this.plants.get(cell)
    if (!record) return
    record.owner = owner
    this.applyOwnerColor(record, owner)
    // 被抢的一瞬间弹一下
    record.ring.scale.setScalar(PLANT_CIRCLE_SIZE * 1.7)
  }

  /** 把特征色写到外覆层与魔法阵上。 */
  private applyOwnerColor(record: PlantRecord, owner: PlayerIndex): void {
    const side = this.palette.sides[owner]
    record.auraMaterial.color.setHex(side.color)
    record.auraMaterial.emissive.setHex(side.glow)
    const circleMaterial = record.ring.material as MeshBasicMaterial
    circleMaterial.color.setHex(side.color)
    ;(record.pickRing.material as MeshBasicMaterial).color.setHex(side.color)
    record.aura.visible = true
    record.ring.visible = true
  }

  /**
   * 爆风（bugv9 #2 第 5 点）：攻击棋子对撞 / 撞击血条时把附近的植物吹歪。
   *
   * 离爆心越近影响越大；只影响水平方向（植物绕着根部倾斜），
   * 之后由 `update()` 里做衰减 + 回弹。
   */
  blast(position: Vector3, strength = 1): void {
    for (const record of this.plants.values()) {
      const dx = record.root.position.x - position.x
      const dz = record.root.position.z - position.z
      const distance = Math.hypot(dx, dz)
      if (distance > BLAST_RADIUS) continue
      // 方向：从爆心指向植物。爆心正好压在植物上时（对撞点可能就在它正上方）
      // 退化成"背离棋盘中心"，保证一定有可见的偏转。
      let dirX = dx
      let dirZ = dz
      if (distance < 1e-3) {
        dirX = record.root.position.x
        dirZ = record.root.position.z
      }
      const length = Math.hypot(dirX, dirZ)
      if (length < 1e-3) {
        dirX = 1
        dirZ = 0
      } else {
        dirX /= length
        dirZ /= length
      }
      const falloff = 1 - distance / BLAST_RADIUS
      record.blastDir.set(dirX, 0, dirZ)
      // 再叠一个与距离无关的下限，近距离直击也一定有明显的歪斜
      record.blastStrength = Math.max(record.blastStrength, falloff * falloff * strength * 1.5 + 0.35 * strength)
      record.blastAge = 0
      // 萤火虫被吹散一下（提高亮度与转速）
      for (const firefly of record.fireflies) {
        firefly.material.opacity = Math.min(1, firefly.material.opacity + 0.3)
      }
    }
  }

  /** 连珠结算 / 被消耗：这些格子上的植物缩小消失。 */
  remove(cells: readonly number[]): void {
    for (const cell of cells) {
      const record = this.plants.get(cell)
      if (record && record.fading === null) record.fading = FADE_DURATION
    }
  }

  /** 全量对齐（回放 / 重连 / 开局）。 */
  sync(plants: ReadonlyArray<{ cell: number; kind: MagicKind; owner: PlayerIndex | null }>): void {
    const wanted = new Map(plants.map((plant) => [plant.cell, plant]))
    for (const cell of [...this.plants.keys()]) {
      if (!wanted.has(cell)) this.despawn(cell)
    }
    for (const plant of plants) {
      const existing = this.plants.get(plant.cell)
      if (!existing) {
        this.spawn(plant.cell, plant.kind, plant.owner, false)
        continue
      }
      if (existing.kind !== plant.kind) {
        this.despawn(plant.cell)
        this.spawn(plant.cell, plant.kind, plant.owner, false)
        continue
      }
      if (plant.owner === null) {
        existing.owner = null
        existing.aura.visible = false
        existing.ring.visible = false
      } else if (existing.owner !== plant.owner) {
        this.claim(plant.cell, plant.owner)
      }
    }
  }

  /**
   * 天气变化时改变某些植物的种类（bugv34 补充）。
   *
   * 目前用于：**雷暴结束**时把场上的「污染体」（无论是否被棋子占有）变回普通魔力植物。
   * 归属保留、不播生长动画。
   */
  transform(plants: ReadonlyArray<{ cell: number; kind: MagicKind }>): void {
    for (const plant of plants) {
      const record = this.plants.get(plant.cell)
      if (!record || record.kind === plant.kind) continue
      const owner = record.owner
      this.despawn(plant.cell)
      this.spawn(plant.cell, plant.kind, owner, false)
    }
  }

  /** 立即清空（重开一局）。 */
  clear(): void {
    for (const record of this.plants.values()) this.disposeRecord(record)
    this.plants.clear()
  }

  /**
   * 进入 / 退出"挑选魔力植物"状态（bugv9 #13 / bugv10 #2：技能消耗植物时使用）。
   *
   * 挑选状态下：
   * - 只有该方占用的植物保持明亮，**其它植物整体压暗**（需求原文"其他棋子和魔力植物都应该变暗"）；
   * - `picked` 里已经勾选的植物额外加一圈高光标识（多选技能，需求原文）；
   * - 退出挑选时所有植物恢复原本的外观。
   */
  setSelecting(player: PlayerIndex | null, picked: readonly number[] = []): void {
    const pickedSet = new Set(picked)
    for (const record of this.plants.values()) {
      const active = player !== null && record.owner === player
      if (player === null) {
        record.aura.visible = record.owner !== null
        record.ring.visible = record.owner !== null
      } else {
        record.aura.visible = active
        record.ring.visible = active
      }
      record.selecting = active
      record.picked = active && pickedSet.has(record.cell)
      this.applyDim(record, player !== null && !active)
      record.pickRing.visible = record.picked
      if (record.picked) {
        ;(record.pickRing.material as MeshBasicMaterial).color.setHex(this.palette.sides[player ?? 0].color)
      }
    }
  }

  /** 这一方占用的魔力植物格子（技能挑选高亮用，bugv10 #2）。 */
  plantsOf(player: PlayerIndex): number[] {
    const cells: number[] = []
    for (const record of this.plants.values()) {
      if (record.owner === player) cells.push(record.cell)
    }
    return cells.sort((a, b) => a - b)
  }

  /**
   * 压暗 / 恢复一株植物。
   *
   * 直接把四色材质调暗（而不是改透明度），这样在浅色页面上也能看出"它变暗了"。
   */
  private applyDim(record: PlantRecord, dim: boolean): void {
    if (record.dimmed === dim) return
    record.dimmed = dim
    const factor = dim ? DIM_FACTOR : 1
    const colors = partColors(record.kind)
    record.materials.outer.color.setHex(colors.outer).multiplyScalar(factor)
    record.materials.inner.color.setHex(colors.inner).multiplyScalar(factor)
    record.materials.base.color.setHex(colors.base).multiplyScalar(factor)
    record.materials.green.color.setHex(colors.green).multiplyScalar(factor)
    for (const firefly of record.fireflies) {
      firefly.material.opacity = dim ? 0.08 : 0.7
    }
    if (dim) record.pickRing.visible = false
  }

  /** 运行中切换特征色（角色系统 / 设置面板）。 */
  setPalette(palette: Palette): void {
    this.palette = palette
    for (const record of this.plants.values()) {
      if (record.owner !== null) this.applyOwnerColor(record, record.owner)
    }
  }

  /** 每帧：生长动画 + 摇曳 + 萤火虫 + 爆风回弹。 */
  update(dt: number, elapsed: number): void {
    for (const [cell, record] of [...this.plants]) {
      if (record.fading !== null) {
        record.fading -= dt
        const k = Math.max(record.fading / FADE_DURATION, 0)
        record.root.scale.setScalar(this.baseScale(record) * k)
        if (record.fading <= 0) {
          this.disposeRecord(record)
          this.plants.delete(cell)
        }
        continue
      }
      const base = this.baseScale(record)
      // 技能挑选高亮：被选中的植物整体放大并呼吸（bugv9 #13），
      // 已经勾选的再大一点 + 转一圈高光圆环（bugv10 #2）
      const selectPulse = record.selecting
        ? (record.picked ? 1.3 : 1.18) + Math.sin(elapsed * 4.2) * 0.07
        : 1
      if (record.pickRing.visible) {
        record.pickRing.rotation.z = elapsed * 1.9
        record.pickRing.scale.setScalar(1 + Math.sin(elapsed * 5.2) * 0.08)
      }
      if (record.grow < 1) {
        record.grow = Math.min(record.grow + dt / GROW_DURATION, 1)
        // 轻微过冲，像"顶出来"一样
        const t = record.grow
        const pop = t < 0.7 ? (t / 0.7) * 1.12 : 1.12 - 0.12 * ((t - 0.7) / 0.3)
        record.root.scale.setScalar(base * pop)
        record.root.position.y = -0.04 * (1 - t)
      } else {
        record.root.scale.setScalar(base * selectPulse)
        if (Math.abs(record.root.position.y) > 1e-4) record.root.position.y = 0
      }

      // 静止时慢慢摇曳（bugv9 #2：幅度更大），并叠上爆风造成的偏转
      const sway = Math.sin(elapsed * 1.35 + record.phase) * SWAY_ANGLE
      const twist = Math.cos(elapsed * 1.05 + record.phase * 1.3) * SWAY_TWIST
      let blastX = 0
      let blastZ = 0
      if (record.blastStrength > 0.001) {
        record.blastAge += dt
        // 指数衰减 + 余弦回弹：被吹歪之后会来回晃两下再立起来
        const decay = Math.exp(-BLAST_DECAY * record.blastAge)
        const wobble = Math.cos(record.blastAge * 15) * decay
        const amount = record.blastStrength * wobble
        blastX = record.blastDir.z * amount * 0.7
        blastZ = -record.blastDir.x * amount * 0.7
        if (decay < 0.02) record.blastStrength = 0
      }
      record.root.rotation.z = sway + blastX
      record.root.rotation.x = twist + blastZ

      // 魔法阵：持续旋转（与悬浮棋子的魔法阵表现一致）
      if (record.ring.visible) {
        record.ring.rotation.z = elapsed * 1.6 + record.phase
        if (record.ring.scale.x > PLANT_CIRCLE_SIZE) {
          record.ring.scale.setScalar(Math.max(record.ring.scale.x - dt * 2.2, PLANT_CIRCLE_SIZE))
        } else {
          record.ring.scale.setScalar(PLANT_CIRCLE_SIZE)
        }
      }

      // 萤火虫：绕着植物公转 + 上下浮动 + 呼吸闪烁
      for (let i = 0; i < record.fireflies.length; i++) {
        const firefly = record.fireflies[i]
        const angle = elapsed * firefly.speed + firefly.phase
        firefly.mesh.position.set(
          Math.cos(angle) * firefly.radius,
          firefly.height + Math.sin(elapsed * 1.6 + firefly.phase * 2) * 0.07,
          Math.sin(angle) * firefly.radius,
        )
        const breathe = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(elapsed * 2.4 + firefly.phase * 3))
        firefly.material.opacity += (breathe - firefly.material.opacity) * Math.min(dt * 3, 1)
        // 爆风后更亮
        if (record.blastStrength > 0.01) {
          firefly.material.opacity = Math.min(1, firefly.material.opacity + 0.25)
        }
      }
    }
  }

  /** 植物"本该有"的缩放（含每株的高矮差异）。 */
  private baseScale(record: PlantRecord): number {
    const variation = (record.root.userData.sizeVariation as number | undefined) ?? 1
    return PLANT_SCALE * variation
  }

  dispose(): void {
    this.clear()
    this.ringGeometry.dispose()
    this.circleGeometry.dispose()
    this.pickRingGeometry.dispose()
    this.shadowGeometry.dispose()
    this.fireflyGeometry.dispose()
    this.shadowMaterial.dispose()
    this.magicTexture?.dispose()
    this.geometries.stem.dispose()
    this.geometries.leaf.dispose()
    this.geometries.sphere.dispose()
    this.geometries.cone.dispose()
    this.materialTemplate.outer.dispose()
    this.materialTemplate.inner.dispose()
    this.materialTemplate.base.dispose()
    this.materialTemplate.green.dispose()
  }

  private despawn(cell: number): void {
    const record = this.plants.get(cell)
    if (!record) return
    this.disposeRecord(record)
    this.plants.delete(cell)
  }

  private disposeRecord(record: PlantRecord): void {
    record.root.removeFromParent()
    // 外覆层与魔法阵的材质是每株独立的（外层克隆过），要一起释放；
    // 几何体是全视图共用的，不在这里释放。
    record.auraMaterial.dispose()
    ;(record.ring.material as MeshBasicMaterial).dispose()
    ;(record.pickRing.material as MeshBasicMaterial).dispose()
    for (const firefly of record.fireflies) firefly.material.dispose()
    // bugv10 追加 #3：每株的 4 层几何是"烘焙"出来的独立几何（几何体是共用的，只释放这 4 个）
    for (const child of record.plant.children) {
      const mesh = child as Mesh
      if (mesh.isMesh) mesh.geometry.dispose()
    }
    record.materials.outer.dispose()
    record.materials.inner.dispose()
    record.materials.base.dispose()
    record.materials.green.dispose()
  }
}
