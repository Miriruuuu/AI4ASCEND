<script setup lang="ts">
/**
 * 游玩须知弹窗（bugv28 #1）。
 *
 * 内容直接读工程根目录的 `promise.md`（版权与使用声明），居中展示；
 * 底部两个按钮：
 * - 「我已知晓」：只是关闭，下次进入游戏还会弹；
 * - 「不再弹出」：写 localStorage，之后永远不再弹（由 App 判断）。
 *
 * 解析只做很轻量的一件事：按空行分段、把 `[文字](链接)` 与裸 URL 变成可点链接。
 */
import { computed } from 'vue'
import promiseRaw from '../../../promise.md?raw'

defineProps<{ visible: boolean }>()

const emit = defineEmits<{
  (event: 'confirm'): void
  (event: 'never'): void
}>()

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 把一行文本里的 markdown 链接与裸 URL 变成 `<a>`。 */
function renderInline(text: string): string {
  let out = escapeHtml(text)
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, url: string) =>
      `<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>`,
  )
  out = out.replace(
    /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    (_match, prefix: string, url: string) =>
      `${prefix}<a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>`,
  )
  return out
}

interface Block {
  heading: boolean
  text: string
  html: string
}

const blocks = computed<Block[]>(() =>
  promiseRaw
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n').map((line) => line.trim())
      // 单行、且很短（如"严正声明"）当作小标题
      const heading = lines.length === 1 && lines[0].length <= 8
      return {
        heading,
        text: block,
        html: lines.map(renderInline).join('<br />'),
      }
    }),
)
</script>

<template>
  <transition name="modal-fade">
    <div v-if="visible" class="overlay overlay--promise">
      <div class="modal promise-modal">
        <div class="modal__title">NOTICE</div>
        <div class="modal__headline">游玩须知</div>
        <div class="promise-modal__body">
          <template v-for="(block, index) in blocks" :key="index">
            <h3 v-if="block.heading" class="promise-modal__heading">{{ block.text }}</h3>
            <p v-else class="promise-modal__para" v-html="block.html" />
          </template>
        </div>
        <div class="modal__actions promise-modal__actions">
          <button class="ghost-btn" type="button" @click="emit('never')">不再弹出</button>
          <button class="primary-btn" type="button" @click="emit('confirm')">我已知晓</button>
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

.overlay--promise {
  z-index: 14;
}

.promise-modal {
  width: min(600px, 94vw);
  justify-items: start;
  text-align: left;
}

.promise-modal__body {
  display: grid;
  gap: 10px;
  max-height: min(58vh, 460px);
  overflow-y: auto;
  padding-right: 6px;
  font-size: 13px;
  line-height: 1.62;
  color: var(--c-ink-dim);
  scrollbar-width: thin;
}

.promise-modal__heading {
  margin: 2px 0 2px;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--c-ink);
}

.promise-modal__para {
  margin: 0;
  word-break: break-word;
}

.promise-modal__body :deep(a) {
  color: #2b6cd6;
  text-decoration: underline;
  text-underline-offset: 3px;
  word-break: break-all;
}

.promise-modal__actions {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
</style>
