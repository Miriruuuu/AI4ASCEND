<script setup lang="ts">
import { computed, watch } from 'vue'
import type { PlayerIndex } from '../../core/types'

interface PlayerMetaLike {
  name: string
  palette: { color: number; glow: number }
}

const props = defineProps<{
  visible: boolean
  rolling: boolean
  rolls: [number, number] | null
  first: PlayerIndex | null
  players: [PlayerMetaLike, PlayerMetaLike]
  /** 掷骰结束后延迟淡出（毫秒，0 = 不自动隐藏）。 */
  autoHideMs?: number
}>()

const emit = defineEmits<{ (event: 'hidden'): void }>()

/** 骰子点数 -> 3×3 点阵。 */
const PIP_MAP: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
}

const pips = (value: number): boolean[] => {
  const on = new Set(PIP_MAP[value] ?? [4])
  return Array.from({ length: 9 }, (_, index) => on.has(index))
}

const decided = computed(() => !props.rolling && props.first !== null && props.rolls !== null)

watch(decided, (value) => {
  if (!value) return
  const delay = props.autoHideMs ?? 1500
  if (delay <= 0) return
  window.setTimeout(() => emit('hidden'), delay)
})

const hex = (value: number) => `#${value.toString(16).padStart(6, '0')}`

function sideStyle(side: PlayerIndex) {
  const palette = props.players[side].palette
  return { '--side-color': hex(palette.color), '--side-glow': hex(palette.glow) }
}
</script>

<template>
  <transition name="dice-fade">
    <div v-if="visible" class="dice-overlay">
      <div class="dice-pair">
        <div
          v-for="side in ([0, 1] as PlayerIndex[])"
          :key="side"
          class="dice"
          :class="{ 'is-rolling': rolling, 'is-winner': decided && first === side }"
          :style="sideStyle(side)"
        >
          <span
            v-for="(on, index) in pips(rolls ? rolls[side] : 1)"
            :key="index"
            class="dice__pip"
            :class="{ 'is-on': on }"
          />
        </div>
      </div>

      <div v-if="!decided" class="dice-caption">掷骰子决定先后手</div>
      <div v-else class="dice-caption">
        <strong :style="sideStyle(first ?? 0)">{{ players[first ?? 0].name }}</strong> 先手
      </div>
    </div>
  </transition>
</template>

<style scoped>
.dice-fade-enter-active,
.dice-fade-leave-active {
  transition: opacity 0.42s var(--ease-out);
}

.dice-fade-enter-from,
.dice-fade-leave-to {
  opacity: 0;
}
</style>
