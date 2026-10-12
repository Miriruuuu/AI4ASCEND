<script setup lang="ts">
/**
 * 游戏规则弹窗（bugv30 #5）。
 *
 * 内容直接读工程根目录的 `help.md`（规则说明），居中不可滚动到外面地展示；
 * 轻量解析：
 * - 空行分段；
 * - `数字.` 开头的行当作**规则条目**（序号 + 正文）；
 * - `(注意…)` 这种整行括号包裹的行当作**附注**；
 * - 其它行当作普通段落。
 *
 * ⚠️ `?raw` 的路径是相对**本文件**的：组件在 `src/app/components/`，
 * 工程根目录要往上一共三层 → `../../../help.md?raw`。
 */
import { computed } from 'vue'
import helpRaw from '../../../help.md?raw'

defineProps<{ visible: boolean }>()

const emit = defineEmits<{
  (event: 'close'): void
}>()

interface RuleBlock {
  /** 序号（没有序号 = 普通段落）。 */
  no: string | null
  /** 是否是附注（整行括号包裹）。 */
  note: boolean
  text: string
}

const blocks = computed<RuleBlock[]>(() =>
  helpRaw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const numbered = /^(\d+)\.\s*(.*)$/.exec(line)
      if (numbered) return { no: numbered[1], note: false, text: numbered[2] }
      const note = /^[(（].*[)）]$/.test(line)
      return { no: null, note, text: line }
    }),
)
</script>

<template>
  <transition name="modal-fade">
    <div v-if="visible" class="overlay overlay--rules" @click.self="emit('close')">
      <div class="modal rules-modal">
        <div class="modal__title">RULE BOOK</div>
        <div class="modal__headline">游戏规则</div>
        <div class="rules-modal__body">
          <template v-for="(block, index) in blocks" :key="index">
            <p v-if="block.no" class="rules-modal__item">
              <span class="rules-modal__no">{{ block.no }}</span>
              <span class="rules-modal__text">{{ block.text }}</span>
            </p>
            <p v-else-if="block.note" class="rules-modal__note">{{ block.text }}</p>
            <p v-else class="rules-modal__para">{{ block.text }}</p>
          </template>
        </div>
        <div class="modal__actions rules-modal__actions">
          <button class="primary-btn" type="button" @click="emit('close')">知道了</button>
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

.overlay--rules {
  z-index: 15;
}

.rules-modal {
  width: min(640px, 94vw);
  justify-items: start;
  text-align: left;
}

.rules-modal__body {
  display: grid;
  gap: 9px;
  max-height: min(62vh, 520px);
  overflow-y: auto;
  padding-right: 8px;
  font-size: 13px;
  line-height: 1.66;
  color: var(--c-ink-dim);
  scrollbar-width: thin;
}

.rules-modal__item {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 8px;
  margin: 0;
}

.rules-modal__no {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  font-family: var(--font-num);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--c-ink);
  border-radius: 50%;
  border: 1px solid var(--c-border);
  background: rgba(255, 255, 255, 0.72);
}

.rules-modal__text {
  padding-top: 1px;
}

.rules-modal__para {
  margin: 0;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--c-ink);
}

.rules-modal__note {
  margin: 2px 0 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px dashed var(--c-border-strong);
  background: rgba(255, 255, 255, 0.55);
  font-size: 12.5px;
}

.rules-modal__actions {
  grid-template-columns: minmax(0, 1fr);
}
</style>
