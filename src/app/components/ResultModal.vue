<script setup lang="ts">
import { computed } from 'vue'
import type { GameResult } from '../../core/types'
import type { PlayerMeta } from '../useConnectGame'

const props = defineProps<{
  visible: boolean
  result: GameResult | null
  players: [PlayerMeta, PlayerMeta]
  initialHp: number
}>()

const emit = defineEmits<{
  (event: 'restart'): void
  (event: 'close'): void
  /** 回放刚刚结束的这一局（bugv6 #4）。 */
  (event: 'replay'): void
  /** 回到开始菜单（bugv10 #10）。 */
  (event: 'menu'): void
}>()

const hex = (value: number) => `#${value.toString(16).padStart(6, '0')}`

const winnerName = computed(() => (props.result?.winner == null ? null : props.players[props.result.winner].name))

const headline = computed(() => {
  if (!props.result) return ''
  return props.result.winner === null ? '平局' : `${winnerName.value} 胜利`
})

const sideStyle = computed(() => {
  const winner = props.result?.winner
  if (winner == null) return { '--side-color': '#eef1f8' }
  return { '--side-color': hex(props.players[winner].palette.color) }
})

const reasonText = computed(() => {
  if (!props.result) return ''
  if (props.result.reason === 'hp') {
    const loser = props.result.hp[0] <= 0 ? 0 : 1
    return `${props.players[loser].name}血量归零，攻击阶段已完整结算。`
  }
  return '棋盘已下满，按血量高低判定胜负。'
})
</script>

<template>
  <transition name="modal-fade">
    <div v-if="visible && result" class="overlay" @click.self="emit('close')">
      <div class="modal" :style="sideStyle">
        <div class="modal__title">对局结算</div>
        <div class="modal__headline">
          <em>{{ headline }}</em>
        </div>

        <div class="modal__body">
          <div>{{ reasonText }}</div>
          <div>
            最终血量：
            <strong>{{ players[0].name }} {{ result.hp[0] }}</strong>
            ·
            <strong>{{ players[1].name }} {{ result.hp[1] }}</strong>
            <span style="opacity: 0.5">（初始 {{ initialHp }}）</span>
          </div>
          <div v-if="result.hp[0] < 0 || result.hp[1] < 0" style="opacity: 0.7">血量可扣至负数，以完整结算为准。</div>
        </div>

        <div class="modal__actions">
          <button class="ghost-btn" type="button" @click="emit('replay')">回放本局</button>
          <button class="ghost-btn" type="button" @click="emit('close')">查看棋盘</button>
          <button class="ghost-btn" type="button" @click="emit('menu')">返回主菜单</button>
          <button class="primary-btn" type="button" @click="emit('restart')">再来一局</button>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.3s var(--ease-out);
}

.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}
</style>
