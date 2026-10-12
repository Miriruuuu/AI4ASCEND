<script setup lang="ts">
/**
 * 房间聊天（bugv34e）。
 *
 * 左侧可收起的聊天框：
 * - **房间里**与**对局中**都挂载（`App.vue` 在 `online.room` 有值时渲染）；
 * - **进入游戏后自动收起**（由 store 的 `onMatched` 把 `chatOpen` 置 false）；
 * - **回车快速打开**（全局快捷键在 `App.vue` 里绑，打开后自动聚焦输入框）；
 * - 收起时左侧留一个竖排"聊天"标签 + 未读角标，点它或按回车即可展开。
 *
 * 断开连接时输入框禁用（消息发不出去）。
 */
import { nextTick, ref, watch } from 'vue'
import type { OnlineRoomChatEntry } from '../online'

const props = defineProps<{
  open: boolean
  chat: OnlineRoomChatEntry[]
  you: string
  unread: number
  connected: boolean
  /** 对局中（收起后仍可聊，但提示会变）。 */
  playing: boolean
}>()

const emit = defineEmits<{
  (event: 'toggle', open: boolean): void
  (event: 'send', text: string): void
}>()

const draft = ref('')
const inputEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLDivElement | null>(null)

/** 展开时聚焦输入框并滚到底部。 */
watch(
  () => props.open,
  async (open) => {
    if (!open) return
    await nextTick()
    inputEl.value?.focus()
    scrollToBottom()
  },
)

/** 新消息到达时滚到底部。 */
watch(
  () => props.chat.length,
  async () => {
    await nextTick()
    scrollToBottom()
  },
)

function scrollToBottom(): void {
  const el = listEl.value
  if (el) el.scrollTop = el.scrollHeight
}

function submit(): void {
  const text = draft.value.trim()
  if (!text || !props.connected) return
  emit('send', text)
  draft.value = ''
}

/** 让外部（全局回车 / 快捷键）能把焦点打进输入框。 */
defineExpose({ focus: () => inputEl.value?.focus() })

function timeLabel(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
</script>

<template>
  <div class="room-chat" :class="{ 'is-open': open }">
    <!-- 收起状态的竖排标签（带未读数） -->
    <button
      v-if="!open"
      class="room-chat__flap"
      type="button"
      title="回车打开聊天"
      @click="emit('toggle', true)"
    >
      <span class="room-chat__flap-text">聊天</span>
      <span v-if="unread > 0" class="room-chat__flap-badge">{{ unread > 99 ? '99+' : unread }}</span>
    </button>

    <div v-else class="room-chat__panel">
      <header class="room-chat__head">
        <span>聊天</span>
        <span class="room-chat__head-tip">{{ playing ? '对局中' : '房间内' }} · 回车发送 / Esc 收起</span>
        <button class="icon-btn" type="button" title="收起" @click="emit('toggle', false)">✕</button>
      </header>

      <div ref="listEl" class="room-chat__list">
        <p v-if="chat.length === 0" class="room-chat__empty">还没有消息，打个招呼吧</p>
        <div
          v-for="entry in chat"
          :key="entry.id"
          class="room-chat__item"
          :class="{ 'is-mine': entry.playerId === you }"
        >
          <div class="room-chat__item-head">
            <span class="room-chat__item-name">{{ entry.name }}</span>
            <span class="room-chat__item-time">{{ timeLabel(entry.at) }}</span>
          </div>
          <div class="room-chat__item-text">{{ entry.text }}</div>
        </div>
      </div>

      <div class="room-chat__input">
        <input
          ref="inputEl"
          v-model="draft"
          maxlength="120"
          placeholder="说点什么…"
          spellcheck="false"
          :disabled="!connected"
          @keydown.enter.prevent="submit"
          @keydown.esc.prevent="emit('toggle', false)"
        />
        <button class="primary-btn" type="button" :disabled="!connected || draft.trim() === ''" @click="submit">
          发送
        </button>
      </div>
    </div>
  </div>
</template>
