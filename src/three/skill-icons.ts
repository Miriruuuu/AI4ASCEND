/**
 * 技能图标（bugv9 #13）：**程序化生成**，不依赖任何图标资源。
 *
 * 每个图标画在 96×96 的画布上（2 倍图，缩到 48 显示），
 * 用渐变 + 细描边做出"简易但精致"的观感，最后返回 data URL 供 `<img>` / CSS 使用。
 */
import type { SkillIconId } from '../app/characters'

const SIZE = 96
const cache = new Map<string, string>()

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

/** 圆形底盘 + 内圈细描边。 */
function drawPlate(context: CanvasRenderingContext2D, color: number, glow: number): void {
  const center = SIZE / 2
  const plate = context.createRadialGradient(center * 0.72, center * 0.66, 2, center, center, SIZE * 0.52)
  plate.addColorStop(0, 'rgba(255,255,255,0.96)')
  plate.addColorStop(0.55, `${hex(glow)}cc`)
  plate.addColorStop(1, `${hex(color)}e6`)
  context.fillStyle = plate
  context.beginPath()
  context.arc(center, center, SIZE * 0.46, 0, Math.PI * 2)
  context.fill()

  context.strokeStyle = 'rgba(255,255,255,0.7)'
  context.lineWidth = 1.4
  context.beginPath()
  context.arc(center, center, SIZE * 0.4, 0, Math.PI * 2)
  context.stroke()
}

/** 护盾：盾形 + 中缝。 */
function shieldIcon(color: number, glow: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext('2d')
  if (!context) return ''
  drawPlate(context, color, glow)
  context.save()
  context.translate(SIZE / 2, SIZE / 2 - 2)
  const path = new Path2D()
  path.moveTo(0, -22)
  path.lineTo(18, -14)
  path.lineTo(18, 4)
  path.quadraticCurveTo(18, 18, 0, 25)
  path.quadraticCurveTo(-18, 18, -18, 4)
  path.lineTo(-18, -14)
  path.closePath()
  const fill = context.createLinearGradient(0, -22, 0, 25)
  fill.addColorStop(0, '#ffffff')
  fill.addColorStop(1, '#cfd6e6')
  context.fillStyle = fill
  context.fill(path)
  context.strokeStyle = 'rgba(24,28,40,0.5)'
  context.lineWidth = 2
  context.stroke(path)
  // 中缝
  context.strokeStyle = 'rgba(24,28,40,0.28)'
  context.lineWidth = 1.6
  context.beginPath()
  context.moveTo(0, -18)
  context.lineTo(0, 21)
  context.stroke()
  context.restore()
  return canvas.toDataURL()
}

/** 连续行动：两个叠加的箭头。 */
function doubleIcon(color: number, glow: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext('2d')
  if (!context) return ''
  drawPlate(context, color, glow)
  context.save()
  context.translate(SIZE / 2, SIZE / 2)
  context.strokeStyle = '#ffffff'
  context.lineWidth = 5
  context.lineCap = 'round'
  context.lineJoin = 'round'
  for (const offset of [-8, 4]) {
    context.beginPath()
    context.moveTo(-16, offset)
    context.lineTo(6, offset)
    context.lineTo(0, offset - 7)
    context.moveTo(6, offset)
    context.lineTo(0, offset + 7)
    context.stroke()
  }
  context.strokeStyle = 'rgba(24,28,40,0.35)'
  context.lineWidth = 1.4
  context.beginPath()
  context.moveTo(-20, -16)
  context.lineTo(16, -16)
  context.moveTo(-20, 16)
  context.lineTo(16, 16)
  context.stroke()
  context.restore()
  return canvas.toDataURL()
}

/** 回血：十字 + 心形轮廓。 */
function healIcon(color: number, glow: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext('2d')
  if (!context) return ''
  drawPlate(context, color, glow)
  context.save()
  context.translate(SIZE / 2, SIZE / 2)
  // 心形
  const heart = new Path2D()
  heart.moveTo(0, 20)
  heart.bezierCurveTo(-26, 2, -20, -20, -1, -12)
  heart.bezierCurveTo(18, -20, 24, 2, 0, 20)
  context.fillStyle = 'rgba(255,255,255,0.9)'
  context.fill(heart)
  context.strokeStyle = 'rgba(24,28,40,0.45)'
  context.lineWidth = 1.8
  context.stroke(heart)
  // 十字
  context.fillStyle = hex(color)
  context.fillRect(-2.6, -9, 5.2, 15)
  context.fillRect(-7.5, -4, 15, 5.2)
  context.restore()
  return canvas.toDataURL()
}

/** 绽放：一圈环绕的小芽 + 中心的嫩叶。 */
function bloomIcon(color: number, glow: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext('2d')
  if (!context) return ''
  drawPlate(context, color, glow)
  context.save()
  context.translate(SIZE / 2, SIZE / 2)
  // 环绕的小芽
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2
    context.save()
    context.rotate(angle)
    context.translate(0, -22)
    context.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.95)' : hex(glow)
    context.beginPath()
    context.ellipse(0, 0, 5, 3.2, 0.5, 0, Math.PI * 2)
    context.fill()
    context.restore()
  }
  // 中心的叶子
  context.fillStyle = '#ffffff'
  context.beginPath()
  context.ellipse(-4, 3, 5, 9, -0.42, 0, Math.PI * 2)
  context.fill()
  context.beginPath()
  context.ellipse(4.5, 2, 4.6, 8.4, 0.42, 0, Math.PI * 2)
  context.fill()
  context.strokeStyle = 'rgba(24,28,40,0.4)'
  context.lineWidth = 1.5
  context.beginPath()
  context.moveTo(0, 12)
  context.lineTo(0, -8)
  context.stroke()
  context.restore()
  return canvas.toDataURL()
}

/** 无敌（精密计算）：六边形护壁 + 内部的计算刻度（bugv10 #9）。 */
function immuneIcon(color: number, glow: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext('2d')
  if (!context) return ''
  drawPlate(context, color, glow)
  context.save()
  context.translate(SIZE / 2, SIZE / 2)
  // 六边形护壁
  const hexagon = new Path2D()
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2 - Math.PI / 2
    const x = Math.cos(angle) * 21
    const y = Math.sin(angle) * 21
    if (i === 0) hexagon.moveTo(x, y)
    else hexagon.lineTo(x, y)
  }
  hexagon.closePath()
  const fill = context.createLinearGradient(0, -21, 0, 21)
  fill.addColorStop(0, 'rgba(255,255,255,0.95)')
  fill.addColorStop(1, `${hex(glow)}dd`)
  context.fillStyle = fill
  context.fill(hexagon)
  context.strokeStyle = 'rgba(24,28,40,0.5)'
  context.lineWidth = 2
  context.stroke(hexagon)
  // 内部刻度（"计算"感）
  context.strokeStyle = 'rgba(24,28,40,0.55)'
  context.lineWidth = 2.2
  context.lineCap = 'round'
  for (let i = 0; i < 3; i++) {
    const y = -6 + i * 6
    context.beginPath()
    context.moveTo(-9, y)
    context.lineTo(i === 1 ? 9 : 4, y)
    context.stroke()
  }
  context.restore()
  return canvas.toDataURL()
}

/** 火球（恶龙吐息）：双层火焰 + 火星（bugv10 #9）。 */
function fireballIcon(color: number, glow: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext('2d')
  if (!context) return ''
  drawPlate(context, color, glow)
  context.save()
  context.translate(SIZE / 2, SIZE / 2 + 4)
  // 外焰
  const outer = new Path2D()
  outer.moveTo(0, -26)
  outer.bezierCurveTo(12, -12, 20, -4, 16, 8)
  outer.bezierCurveTo(12, 20, -12, 20, -16, 8)
  outer.bezierCurveTo(-20, -4, -12, -12, 0, -26)
  const outerFill = context.createLinearGradient(0, -26, 0, 22)
  outerFill.addColorStop(0, '#fff6d8')
  outerFill.addColorStop(0.5, '#ffcf5c')
  outerFill.addColorStop(1, '#ff7a3c')
  context.fillStyle = outerFill
  context.fill(outer)
  context.strokeStyle = 'rgba(24,28,40,0.45)'
  context.lineWidth = 2
  context.stroke(outer)
  // 内焰
  const inner = new Path2D()
  inner.moveTo(0, -12)
  inner.bezierCurveTo(7, -3, 9, 2, 6, 9)
  inner.bezierCurveTo(3, 15, -3, 15, -6, 9)
  inner.bezierCurveTo(-9, 2, -7, -3, 0, -12)
  context.fillStyle = 'rgba(255,255,255,0.92)'
  context.fill(inner)
  // 火星
  context.fillStyle = 'rgba(255,236,180,0.95)'
  for (const [x, y, r] of [
    [-20, -14, 2.6],
    [19, -18, 2.2],
    [22, -4, 1.8],
  ] as const) {
    context.beginPath()
    context.arc(x, y, r, 0, Math.PI * 2)
    context.fill()
  }
  context.restore()
  return canvas.toDataURL()
}

/** 增伤（小一哥）：向上的粗箭头 + 加号（bugv10 #9）。 */
function powerIcon(color: number, glow: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext('2d')
  if (!context) return ''
  drawPlate(context, color, glow)
  context.save()
  context.translate(SIZE / 2, SIZE / 2)
  const arrow = new Path2D()
  arrow.moveTo(0, -22)
  arrow.lineTo(15, -4)
  arrow.lineTo(6, -4)
  arrow.lineTo(6, 18)
  arrow.lineTo(-6, 18)
  arrow.lineTo(-6, -4)
  arrow.lineTo(-15, -4)
  arrow.closePath()
  const fill = context.createLinearGradient(0, -22, 0, 18)
  fill.addColorStop(0, '#ffffff')
  fill.addColorStop(1, `${hex(glow)}e6`)
  context.fillStyle = fill
  context.fill(arrow)
  context.strokeStyle = 'rgba(24,28,40,0.5)'
  context.lineWidth = 2
  context.stroke(arrow)
  // 加号
  context.fillStyle = hex(color)
  context.fillRect(16, -24, 4.4, 14)
  context.fillRect(11.2, -19.2, 14, 4.4)
  context.restore()
  return canvas.toDataURL()
}

/** 毒蛋（毒鸡蛋）：裂开的蛋 + 毒气泡（bugv10 #9）。 */
function sabotageIcon(color: number, glow: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext('2d')
  if (!context) return ''
  drawPlate(context, color, glow)
  context.save()
  context.translate(SIZE / 2, SIZE / 2 + 2)
  // 蛋
  const egg = new Path2D()
  egg.moveTo(0, -22)
  egg.bezierCurveTo(14, -8, 17, 2, 14, 10)
  egg.bezierCurveTo(11, 20, -11, 20, -14, 10)
  egg.bezierCurveTo(-17, 2, -14, -8, 0, -22)
  const eggFill = context.createLinearGradient(0, -22, 0, 20)
  eggFill.addColorStop(0, '#fbfff4')
  eggFill.addColorStop(1, '#c9e2a8')
  context.fillStyle = eggFill
  context.fill(egg)
  context.strokeStyle = 'rgba(24,28,40,0.5)'
  context.lineWidth = 2
  context.stroke(egg)
  // 裂缝
  context.strokeStyle = 'rgba(24,28,40,0.62)'
  context.lineWidth = 2.2
  context.lineJoin = 'round'
  context.beginPath()
  context.moveTo(-12, -2)
  context.lineTo(-4, 2)
  context.lineTo(1, -5)
  context.lineTo(7, 1)
  context.lineTo(13, -3)
  context.stroke()
  // 毒气泡
  context.fillStyle = `${hex(glow)}ee`
  for (const [x, y, r] of [
    [-18, -14, 3.4],
    [18, -16, 2.6],
    [21, 4, 2.2],
  ] as const) {
    context.beginPath()
    context.arc(x, y, r, 0, Math.PI * 2)
    context.fill()
  }
  context.restore()
  return canvas.toDataURL()
}

/** 临时护甲（精密计算）：盾牌里叠三层（bugv14）。 */
function tempArmorIcon(color: number, glow: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext('2d')
  if (!context) return ''
  drawPlate(context, color, glow)
  context.save()
  context.translate(SIZE / 2, SIZE / 2 + 2)
  const shield = new Path2D()
  shield.moveTo(0, -21)
  shield.lineTo(16, -13)
  shield.lineTo(16, 4)
  shield.bezierCurveTo(16, 14, 7, 20, 0, 22)
  shield.bezierCurveTo(-7, 20, -16, 14, -16, 4)
  shield.lineTo(-16, -13)
  shield.closePath()
  context.fillStyle = `${hex(glow)}ee`
  context.fill(shield)
  context.strokeStyle = 'rgba(24,28,40,0.5)'
  context.lineWidth = 2
  context.stroke(shield)
  // 三层甲片
  context.strokeStyle = `${hex(color)}cc`
  context.lineWidth = 2.4
  for (const y of [-11, -3, 5]) {
    context.beginPath()
    context.moveTo(-11, y)
    context.lineTo(0, y + 4)
    context.lineTo(11, y)
    context.stroke()
  }
  context.restore()
  return canvas.toDataURL()
}

/** 先手压制（深度思考）：向前的双箭头 +「1」（bugv14）。 */
function firstStrikeIcon(color: number, glow: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext('2d')
  if (!context) return ''
  drawPlate(context, color, glow)
  context.save()
  context.translate(SIZE / 2, SIZE / 2 + 2)
  context.strokeStyle = hex(glow)
  context.lineWidth = 5
  context.lineJoin = 'round'
  context.lineCap = 'round'
  for (const dx of [-9, 4]) {
    context.beginPath()
    context.moveTo(dx - 7, 12)
    context.lineTo(dx + 5, 0)
    context.lineTo(dx - 7, -12)
    context.stroke()
  }
  context.fillStyle = hex(color)
  context.fillRect(13, -20, 4.4, 14)
  context.fillRect(8.2, -15.2, 14, 4.4)
  context.restore()
  return canvas.toDataURL()
}

/** 播种：从土里冒出的三株幼苗（bugv14）。 */
function seedGrowIcon(color: number, glow: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext('2d')
  if (!context) return ''
  drawPlate(context, color, glow)
  context.save()
  context.translate(SIZE / 2, SIZE / 2 + 6)
  // 土
  context.fillStyle = `${hex(color)}dd`
  context.beginPath()
  context.moveTo(-20, 8)
  context.lineTo(20, 8)
  context.lineTo(14, 18)
  context.lineTo(-14, 18)
  context.closePath()
  context.fill()
  // 幼苗
  context.strokeStyle = hex(glow)
  context.lineWidth = 2.6
  context.lineCap = 'round'
  for (const [x, h] of [
    [-9, -13],
    [0, -19],
    [9, -11],
  ] as const) {
    context.beginPath()
    context.moveTo(x, 7)
    context.lineTo(x, h)
    context.stroke()
    context.beginPath()
    context.ellipse(x - 5, h + 1, 5, 3, -0.5, 0, Math.PI * 2)
    context.fillStyle = `${hex(glow)}cc`
    context.fill()
    context.beginPath()
    context.ellipse(x + 5, h + 3, 5, 3, 0.5, 0, Math.PI * 2)
    context.fill()
  }
  context.restore()
  return canvas.toDataURL()
}

/** 本地部署（Qwen 1 技能）：一台机箱 + 向左下的部署箭头，顶上冒出新芽（bugv34m）。 */
function localDeployIcon(color: number, glow: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext('2d')
  if (!context) return ''
  drawPlate(context, color, glow)
  context.save()
  context.translate(SIZE / 2, SIZE / 2 + 2)
  // 机箱（圆角矩形）
  context.strokeStyle = hex(glow)
  context.lineWidth = 2.8
  context.lineJoin = 'round'
  const box = new Path2D()
  box.moveTo(-19, -12)
  box.lineTo(19, -12)
  box.lineTo(19, 13)
  box.lineTo(-19, 13)
  box.closePath()
  context.stroke(box)
  // 三个"指示灯"
  context.fillStyle = `${hex(glow)}dd`
  for (const y of [-6, 0, 6]) {
    context.beginPath()
    context.arc(-11, y, 2.4, 0, Math.PI * 2)
    context.fill()
  }
  // 部署箭头（向下）
  context.strokeStyle = hex(color)
  context.lineWidth = 3.2
  context.lineCap = 'round'
  context.beginPath()
  context.moveTo(6, -6)
  context.lineTo(6, 7)
  context.stroke()
  const arrow = new Path2D()
  arrow.moveTo(0, 4)
  arrow.lineTo(12, 4)
  arrow.lineTo(6, 12)
  arrow.closePath()
  context.fillStyle = hex(color)
  context.fill(arrow)
  // 顶上的新芽（落点长植物）
  context.strokeStyle = hex(glow)
  context.lineWidth = 2.2
  context.beginPath()
  context.moveTo(-2, -12)
  context.lineTo(-2, -20)
  context.stroke()
  context.fillStyle = `${hex(glow)}cc`
  context.beginPath()
  context.ellipse(-7, -19, 5, 2.8, -0.5, 0, Math.PI * 2)
  context.fill()
  context.beginPath()
  context.ellipse(3, -21, 5, 2.8, 0.5, 0, Math.PI * 2)
  context.fill()
  context.restore()
  return canvas.toDataURL()
}

/** 小千问（Qwen 2 技能）：三颗棋子从天而降重新落位（bugv34m）。 */
function redeployIcon(color: number, glow: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext('2d')
  if (!context) return ''
  drawPlate(context, color, glow)
  context.save()
  context.translate(SIZE / 2, SIZE / 2 + 2)
  // 三条下落箭头（特征色光流）
  context.strokeStyle = `${hex(glow)}cc`
  context.lineWidth = 2.6
  context.lineCap = 'round'
  for (const x of [-12, 0, 12]) {
    context.beginPath()
    context.moveTo(x, -20)
    context.lineTo(x, -7)
    context.stroke()
    const head = new Path2D()
    head.moveTo(x - 4.6, -10)
    head.lineTo(x + 4.6, -10)
    head.lineTo(x, -3)
    head.closePath()
    context.fillStyle = `${hex(glow)}cc`
    context.fill(head)
  }
  // 落点的三颗棋子
  for (const x of [-12, 0, 12]) {
    context.beginPath()
    context.arc(x, 9, 6.4, 0, Math.PI * 2)
    context.fillStyle = hex(color)
    context.fill()
    context.strokeStyle = `${hex(glow)}ee`
    context.lineWidth = 1.8
    context.stroke()
  }
  context.restore()
  return canvas.toDataURL()
}

/** 共享护甲（稳稳的接住你）：两只手托住一面盾（bugv14）。 */
function guardShareIcon(color: number, glow: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext('2d')
  if (!context) return ''
  drawPlate(context, color, glow)
  context.save()
  context.translate(SIZE / 2, SIZE / 2 + 2)
  const shield = new Path2D()
  shield.moveTo(0, -19)
  shield.lineTo(14, -12)
  shield.lineTo(14, 3)
  shield.bezierCurveTo(14, 12, 6, 17, 0, 19)
  shield.bezierCurveTo(-6, 17, -14, 12, -14, 3)
  shield.lineTo(-14, -12)
  shield.closePath()
  context.fillStyle = `${hex(glow)}ee`
  context.fill(shield)
  context.strokeStyle = 'rgba(24,28,40,0.5)'
  context.lineWidth = 2
  context.stroke(shield)
  // 托住它的两只手
  context.strokeStyle = hex(color)
  context.lineWidth = 4
  context.lineCap = 'round'
  for (const sign of [-1, 1] as const) {
    context.beginPath()
    context.moveTo(sign * 22, 20)
    context.lineTo(sign * 13, 12)
    context.stroke()
  }
  context.restore()
  return canvas.toDataURL()
}

/** 正面强攻（最直接、最不绕弯子）：直冲的粗箭头（bugv14）。 */
function assaultIcon(color: number, glow: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext('2d')
  if (!context) return ''
  drawPlate(context, color, glow)
  context.save()
  context.translate(SIZE / 2, SIZE / 2 + 2)
  context.strokeStyle = 'rgba(24,28,40,0.35)'
  context.lineWidth = 2
  context.setLineDash([4, 5])
  for (const x of [-12, 0, 12]) {
    context.beginPath()
    context.moveTo(x, -20)
    context.lineTo(x, 20)
    context.stroke()
  }
  context.setLineDash([])
  const arrow = new Path2D()
  arrow.moveTo(-20, -7)
  arrow.lineTo(7, -7)
  arrow.lineTo(7, -16)
  arrow.lineTo(21, 0)
  arrow.lineTo(7, 16)
  arrow.lineTo(7, 7)
  arrow.lineTo(-20, 7)
  arrow.closePath()
  context.fillStyle = hex(glow)
  context.fill(arrow)
  context.strokeStyle = 'rgba(24,28,40,0.5)'
  context.lineWidth = 2
  context.stroke(arrow)
  context.restore()
  return canvas.toDataURL()
}

/** 效果 -> 绘制函数（bugv14 起共 13 种）。 */
const ICON_BUILDERS: Record<SkillIconId, (color: number, glow: number) => string> = {
  shield: shieldIcon,
  double: doubleIcon,
  heal: healIcon,
  bloom: bloomIcon,
  immune: immuneIcon,
  fireball: fireballIcon,
  power: powerIcon,
  sabotage: sabotageIcon,
  tempArmor: tempArmorIcon,
  firstStrike: firstStrikeIcon,
  seedGrow: seedGrowIcon,
  guardShare: guardShareIcon,
  assault: assaultIcon,
  // bugv34m：Qwen 的两个技能
  localDeploy: localDeployIcon,
  redeploy: redeployIcon,
}

/**
 * 取一个技能图标的 data URL（同一个角色 + 图标只生成一次）。
 *
 * 无 DOM（jsdom / SSR）时返回空串，UI 会退化为纯文字按钮。
 */
export function skillIconUrl(kind: SkillIconId, color: number, glow: number): string {
  if (typeof document === 'undefined') return ''
  const key = `${kind}:${color}:${glow}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const draw = ICON_BUILDERS[kind] ?? shieldIcon
  const url = draw(color, glow)
  cache.set(key, url)
  return url
}

/** 预生成某角色全部技能的图标（角色切换时调用，避免首帧闪烁）。 */
export function warmSkillIcons(
  specs: ReadonlyArray<{ effect: string }>,
  color: number,
  glow: number,
): void {
  for (const spec of specs) skillIconUrl(spec.effect as SkillIconId, color, glow)
}
