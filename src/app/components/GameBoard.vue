<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{
  /** 场景是否处于可交互状态。 */
  interactive: boolean
  /**
   * bugv26 #2：是否开启双指缩放（**仅手机端**）。
   *
   * 桌面端保持原样 —— 鼠标没有双指手势，多点触控也只在触屏上出现。
   */
  pinch?: boolean
}>()

const emit = defineEmits<{
  (event: 'ready', canvas: HTMLCanvasElement, container: HTMLElement): void
  (event: 'pointer', clientX: number, clientY: number): void
  (event: 'picker', clientX: number, clientY: number): void
  (event: 'leave'): void
  (event: 'resize'): void
  /** 双指手势开始（宿主据此记录"当前倍率"当基准）。 */
  (event: 'pinchstart'): void
  /** 双指手势更新：`scale` = 两指距离 / 手势起点的两指距离。 */
  (event: 'pinch', scale: number): void
}>()

const stage = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
let observer: ResizeObserver | null = null

onMounted(() => {
  if (canvas.value && stage.value) emit('ready', canvas.value, stage.value)
  observer = new ResizeObserver(() => emit('resize'))
  if (stage.value) observer.observe(stage.value)
  window.addEventListener('resize', requestResize)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  window.removeEventListener('resize', requestResize)
})

function requestResize(): void {
  emit('resize')
}

// ---------------------------------------------------------------------------
// bugv26 #2：双指缩放（仅手机端；画布上 touch-action: pan-y ⇒ 单指纵向仍可滚动页面）
// ---------------------------------------------------------------------------

/** 手势开始时两指的间距（0 = 当前没有进行中的双指手势）。 */
let pinchStart = 0

function touchGap(event: TouchEvent): number {
  const [a, b] = [event.touches[0], event.touches[1]]
  if (!a || !b) return 0
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

function onTouchStart(event: TouchEvent): void {
  if (!props.pinch) return
  if (event.touches.length !== 2) {
    pinchStart = 0
    return
  }
  pinchStart = touchGap(event)
  emit('pinchstart')
}

function onTouchMove(event: TouchEvent): void {
  if (!props.pinch || pinchStart <= 0 || event.touches.length !== 2) return
  const gap = touchGap(event)
  if (gap <= 0) return
  // 交给 JS 处理，别让浏览器去做页面缩放，否则手势会被中途接管
  if (event.cancelable) event.preventDefault()
  emit('pinch', gap / pinchStart)
}

function onTouchEnd(event: TouchEvent): void {
  if (event.touches.length < 2) pinchStart = 0
}

const classes = computed(() => ({ 'is-locked': !props.interactive }))
</script>

<template>
  <div id="board-stage" ref="stage" class="board-stage">
    <canvas
      id="board-canvas"
      ref="canvas"
      class="board-canvas"
      :class="classes"
      @pointermove="emit('pointer', $event.clientX, $event.clientY)"
      @pointerleave="emit('leave')"
      @click="emit('picker', $event.clientX, $event.clientY)"
      @touchstart.passive="onTouchStart"
      @touchmove="onTouchMove"
      @touchend="onTouchEnd"
      @touchcancel="onTouchEnd"
    />
    <slot />
  </div>
</template>
