/**
 * 魔法阵贴图（两个交错的正方形 + 内外圈 + 刻度）。
 *
 * bugv5 #10 引入（悬浮攻击棋子脚下），bugv9 #12 明确"颜色由特征色决定"，
 * bugv9 #2 又被魔力植物复用（占位时下方的归属标识换成同一款魔法阵）。
 * 贴图本身画成纯白，颜色一律由材质的 `color` 相乘得到，因此两处共用同一张。
 */
import { CanvasTexture, SRGBColorSpace, type Texture } from 'three'

/** 贴图里的正方形半边长（相对画布）。 */
const HALF_RATIO = 0.33

export function createMagicTexture(): Texture | null {
  if (typeof document === 'undefined') return null
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) return null
  const center = size / 2
  /**
   * bugv8 #5：正方形原来画到 `0.4 * size`，旋转 45° 之后对角线要伸到
   * `0.4 * √2 ≈ 0.566 * size`，早就超出画布了 —— 所以四个角被切掉。
   * 现在收到 `0.33`（对角线 0.467 * size），角完整落在画布内。
   */
  const half = size * HALF_RATIO

  context.strokeStyle = 'rgba(255, 255, 255, 0.95)'
  // 边线加粗：细线在这种小尺寸贴图里几乎看不见
  context.lineWidth = size * 0.03
  context.translate(center, center)
  // 两个交错的正方形
  for (const angle of [0, Math.PI / 4]) {
    context.save()
    context.rotate(angle)
    context.beginPath()
    context.rect(-half, -half, half * 2, half * 2)
    context.stroke()
    context.restore()
  }
  // 外圈 + 内圈
  context.lineWidth = size * 0.014
  context.beginPath()
  context.arc(0, 0, half * 1.32, 0, Math.PI * 2)
  context.stroke()
  context.beginPath()
  context.arc(0, 0, half * 0.62, 0, Math.PI * 2)
  context.stroke()
  // 刻度
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2
    context.save()
    context.rotate(angle)
    context.beginPath()
    context.moveTo(half * 1.16, 0)
    context.lineTo(half * 1.32, 0)
    context.stroke()
    context.restore()
  }
  context.setTransform(1, 0, 0, 1, 0, 0)

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}
