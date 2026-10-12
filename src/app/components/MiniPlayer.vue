<script setup lang="ts">
/**
 * 右下角微型播放器（bugv9 #7）。
 *
 * - 收起时只是一个很小的音符箭头按钮（点击展开）；
 * - 展开后整体弹出：歌名 + 播放 / 暂停 + 上一首 / 下一首 + 音量 / 静音；
 * - 再点箭头收回。
 */
import { computed } from 'vue'

const props = defineProps<{
  open: boolean
  playing: boolean
  muted: boolean
  volume: number
  label: string
  name: string
  index: number
  total: number
  /** 宿主环境是否支持播放（不支持时只展示状态）。 */
  supported: boolean
}>()

const emit = defineEmits<{
  (event: 'toggle'): void
  (event: 'open', value: boolean): void
  (event: 'prev'): void
  (event: 'next'): void
  (event: 'volume', value: number): void
  (event: 'mute'): void
}>()

const volumePercent = computed(() => Math.round((props.muted ? 0 : props.volume) * 100))

function onVolume(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value)) emit('volume', value / 100)
}
</script>

<template>
  <div class="mini-player" :class="{ 'is-open': open }" data-mini-player>
    <!-- 收起状态：只有一个小箭头按钮 -->
    <button
      class="mini-player__handle"
      type="button"
      :title="open ? '收起播放器' : '展开播放器'"
      :aria-expanded="open"
      @click="emit('open', !open)"
    >
      <span class="mini-player__handle-arrow" :class="{ 'is-open': open }" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="9" height="9">
          <path fill="currentColor" d="M15.5 4.5 8 12l7.5 7.5 1.6-1.6L10.9 12l6.2-5.9z" />
        </svg>
      </span>
      <span class="mini-player__handle-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="15" height="15">
          <path
            fill="currentColor"
            d="M9 18V7.2l9-1.8v9.1a2.9 2.9 0 1 1-1.6-2.6V9.1l-5.8 1.2v6.1A2.9 2.9 0 1 1 9 18Z"
          />
        </svg>
      </span>
      <span v-if="playing" class="mini-player__pulse" aria-hidden="true" />
    </button>

    <!-- 展开状态：整体播放器 -->
    <transition name="mini-player-pop">
      <div v-if="open" class="mini-player__panel">
        <div class="mini-player__meta">
          <div class="mini-player__name" :title="label">{{ label || '未选择曲目' }}</div>
          <div class="mini-player__sub">
            {{ name }}.mp3 · {{ index + 1 }}/{{ total }}
            <template v-if="muted"> · 已静音</template>
          </div>
        </div>

        <div class="mini-player__controls">
          <button class="mini-btn" type="button" title="上一首" @click="emit('prev')">
            <svg viewBox="0 0 24 24" width="15" height="15">
              <path fill="currentColor" d="M7 6h2v12H7zm3 6 8-6v12z" />
            </svg>
          </button>
          <button
            class="mini-btn mini-btn--primary"
            type="button"
            :title="playing ? '暂停' : '播放'"
            @click="emit('toggle')"
          >
            <svg v-if="!playing" viewBox="0 0 24 24" width="16" height="16">
              <path fill="currentColor" d="M8 5.5v13l11-6.5z" />
            </svg>
            <svg v-else viewBox="0 0 24 24" width="16" height="16">
              <path fill="currentColor" d="M7.5 5.5h3.4v13H7.5zm5.6 0h3.4v13h-3.4z" />
            </svg>
          </button>
          <button class="mini-btn" type="button" title="下一首" @click="emit('next')">
            <svg viewBox="0 0 24 24" width="15" height="15">
              <path fill="currentColor" d="M15 6h2v12h-2zM6 6l8 6-8 6z" />
            </svg>
          </button>
        </div>

        <div class="mini-player__volume">
          <button class="mini-btn mini-btn--ghost" type="button" :title="muted ? '取消静音' : '静音'" @click="emit('mute')">
            <svg v-if="muted || volumePercent === 0" viewBox="0 0 24 24" width="15" height="15">
              <path fill="currentColor" d="M4 9h3l4-3.5v13L7 15H4z" />
              <path fill="currentColor" d="m14.6 9.4 1.4-1.4 5 5-1.4 1.4z" />
              <path fill="currentColor" d="m19.6 8 1.4 1.4-5 5-1.4-1.4z" />
            </svg>
            <svg v-else viewBox="0 0 24 24" width="15" height="15">
              <path fill="currentColor" d="M4 9h3l4-3.5v13L7 15H4z" />
              <path fill="currentColor" d="M14.5 8.2a5 5 0 0 1 0 7.6l-1.1-1.2a3.4 3.4 0 0 0 0-5.2z" />
              <path fill="currentColor" d="M17.4 5.6a9 9 0 0 1 0 12.8l-1.1-1.2a7.4 7.4 0 0 0 0-10.4z" />
            </svg>
          </button>
          <input
            class="mini-player__range"
            type="range"
            min="0"
            max="100"
            :value="volumePercent"
            :style="{ '--progress': `${volumePercent}%` }"
            aria-label="音量"
            @input="onVolume"
          />
          <span class="mini-player__percent">{{ volumePercent }}%</span>
        </div>

        <div v-if="!supported" class="mini-player__tip">当前环境不支持播放音频</div>
      </div>
    </transition>
  </div>
</template>
