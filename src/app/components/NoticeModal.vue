<script setup lang="ts">
/**
 * 一次性提示弹窗（bugv8 #3）。
 *
 * 联机时对手掉线、身份被顶替这类事情发生时，玩家正盯着棋盘，
 * 光在日志/大厅里写一句是不够的 —— 必须有个看得见的提示 + 一个去处。
 */
defineProps<{
  visible: boolean
  title: string
  text: string
  action: string
  tone: 'info' | 'warn'
}>()

const emit = defineEmits<{
  (event: 'confirm'): void
}>()
</script>

<template>
  <transition name="modal-fade">
    <div v-if="visible" class="overlay overlay--notice">
      <div class="modal notice" :class="`is-${tone}`">
        <div class="notice__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22">
            <path
              fill="currentColor"
              d="M12 2.6 22 20.2H2L12 2.6Zm0 5.6a1.2 1.2 0 0 0-1.2 1.3l.35 5.1h1.7l.35-5.1A1.2 1.2 0 0 0 12 8.2Zm0 8.2a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z"
            />
          </svg>
        </div>
        <div class="modal__title">提示</div>
        <div class="modal__headline">{{ title }}</div>
        <div class="modal__body">
          <div>{{ text }}</div>
        </div>
        <div class="modal__actions">
          <button class="primary-btn" type="button" @click="emit('confirm')">{{ action }}</button>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.28s var(--ease-out);
}

.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}
</style>
