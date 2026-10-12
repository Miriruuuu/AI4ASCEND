<script setup lang="ts">
/**
 * 回放面板（bugv6 #4 引入，bugv9 #9 改版）。
 *
 * 现在有两处来源：
 * - **本地存档**：每局结束自动写进 localStorage，刷新后依然在（可删除、可清空）；
 * - **服务器存档**：联机对局由后端写入 MongoDB，点「服务器回放」按需拉取。
 *
 * bugv9 #9 的三点：
 * 1. 面板挪到**右下角**并且可以折叠，不再挡住棋盘；
 * 2. 回放会走完整的动画事件流（特效 / 攻击结算 / 血条都会出现），
 *    快进快退时先掐掉正在播的动画再落到当前步；
 * 3. 支持**导出 / 导入回放代码**，复制粘贴即可播放。
 */
import { computed, ref } from 'vue'
import type { MatchRecord } from '../useConnectGame'

const props = defineProps<{
  open: boolean
  record: MatchRecord | null
  index: number
  total: number
  playing: boolean
  history: MatchRecord[]
  onlineReplays: MatchRecord[]
  onlineLoading: boolean
  playerNames: [string, string]
  /** 面板是否折叠（bugv9 #9）。 */
  collapsed: boolean
  /** 导出 / 导入代码文本。 */
  codeText: string
  codeMessage: string
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'seek', index: number): void
  (event: 'toggle'): void
  (event: 'select', record: MatchRecord): void
  (event: 'remove', id: MatchRecord['id']): void
  (event: 'clear'): void
  (event: 'refresh'): void
  (event: 'collapse', value: boolean): void
  (event: 'export'): void
  (event: 'import'): void
  (event: 'code', value: string): void
}>()

const tab = ref<'local' | 'server'>('local')
/** 代码区是否展开。 */
const codeOpen = ref(false)

const resultText = computed(() => {
  const record = props.record
  if (!record) return ''
  if (record.result.winner === null) return '平局'
  return `${props.playerNames[record.result.winner]} 胜利`
})

const moveLabel = computed(() => {
  const record = props.record
  if (!record || props.index === 0) return '开局'
  const step = record.steps[props.index - 1]
  if (!step) return '开局'
  const name = props.playerNames[step.player]
  return `${name} ${step.defense ? '抵消' : '落子'} · 第 ${props.index} 手${step.match ? '（成线）' : ''}`
})

const progress = computed(() => (props.total === 0 ? 0 : (props.index / props.total) * 100))

const MODE_LABEL: Record<string, string> = {
  pvp: '双人',
  pve: '人机',
  eve: 'AI 对战',
  online: '联机',
}

function meta(record: MatchRecord): string {
  const winner = record.result.winner === null ? '平局' : `${record.playerNames[record.result.winner]}胜`
  const mode = MODE_LABEL[record.mode] ?? record.mode
  return `${mode} · ${winner} · ${record.result.hp[0]}:${record.result.hp[1]} · ${record.steps.length} 手`
}

function duration(record: MatchRecord): string {
  if (!record.durationMs) return ''
  const total = Math.round(record.durationMs / 1000)
  const minutes = Math.floor(total / 60)
  return minutes > 0 ? `${minutes} 分 ${total % 60} 秒` : `${total} 秒`
}

/** 带特效的步骤数量（老存档没有事件，这里告诉用户回放能播到什么程度）。 */
const animatedSteps = computed(() => {
  const record = props.record
  if (!record) return 0
  return record.steps.filter((step) => (step.events?.length ?? 0) > 0).length
})
</script>

<template>
  <transition name="fade">
    <div v-if="open" class="replay-panel" :class="{ 'is-collapsed': collapsed }" data-replay-panel>
      <header class="replay-panel__head">
        <div class="replay-panel__heading">
          <div class="replay-panel__title">对局回放</div>
          <div v-if="!collapsed" class="replay-panel__sub">
            {{ record?.playedAt ?? '—' }} · {{ resultText }}
            <template v-if="record"> · {{ record.playerNames[0] }} vs {{ record.playerNames[1] }}</template>
            <template v-if="record && duration(record)"> · {{ duration(record) }}</template>
          </div>
          <div v-else class="replay-panel__sub">
            第 {{ index }}/{{ total }} 手 · {{ playing ? '播放中' : '已暂停' }}
          </div>
        </div>
        <div class="replay-panel__head-actions">
          <button
            class="icon-btn icon-btn--sm"
            type="button"
            :title="collapsed ? '展开回放面板' : '折叠回放面板'"
            @click="emit('collapse', !collapsed)"
          >
            {{ collapsed ? '▴' : '▾' }}
          </button>
          <button class="icon-btn icon-btn--sm" type="button" title="返回菜单" @click="emit('close')">✕</button>
        </div>
      </header>

      <template v-if="!collapsed">
        <div class="replay-panel__move">{{ moveLabel }}</div>

        <input
          class="replay-panel__range"
          type="range"
          min="0"
          :max="total"
          :value="index"
          :style="{ '--progress': `${progress}%` }"
          @input="emit('seek', Number(($event.target as HTMLInputElement).value))"
        />

        <div class="replay-panel__controls">
          <button class="ghost-btn" type="button" @click="emit('seek', 0)">⏮ 开局</button>
          <button class="ghost-btn" type="button" @click="emit('seek', Math.max(0, index - 1))">◀ 上一步</button>
          <button class="primary-btn" type="button" @click="emit('toggle')">
            {{ playing ? '⏸ 暂停' : '▶ 播放' }}
          </button>
          <button class="ghost-btn" type="button" @click="emit('seek', Math.min(total, index + 1))">下一步 ▶</button>
          <button class="ghost-btn" type="button" @click="emit('seek', total)">末步 ⏭</button>
        </div>

        <div class="replay-panel__note">
          逐手播放会重播落子 / 连珠 / 对撞 / 撞击血条的全部特效；拖动进度条会立刻掐掉动画落到该步。
          <template v-if="record"> 可重播特效 {{ animatedSteps }}/{{ total }} 手。</template>
        </div>

        <button class="link-btn replay-panel__code-toggle" type="button" @click="codeOpen = !codeOpen">
          {{ codeOpen ? '收起回放代码' : '导出 / 导入回放代码' }}
        </button>

        <div v-if="codeOpen" class="replay-panel__code">
          <textarea
            class="replay-panel__textarea"
            rows="3"
            spellcheck="false"
            placeholder="点「导出代码」生成，或把别人分享的代码粘贴到这里"
            :value="codeText"
            @input="emit('code', ($event.target as HTMLTextAreaElement).value)"
          />
          <div class="replay-panel__code-actions">
            <button class="ghost-btn" type="button" @click="emit('export')">导出代码</button>
            <button class="ghost-btn" type="button" @click="emit('import')">导入并播放</button>
          </div>
          <div v-if="codeMessage" class="replay-panel__note">{{ codeMessage }}</div>
        </div>

        <div class="replay-tabs">
          <button
            type="button"
            class="replay-tabs__item"
            :class="{ 'is-active': tab === 'local' }"
            @click="tab = 'local'"
          >
            本地存档（{{ history.length }}）
          </button>
          <button
            type="button"
            class="replay-tabs__item"
            :class="{ 'is-active': tab === 'server' }"
            @click="tab = 'server'"
          >
            服务器（{{ onlineReplays.length }}）
          </button>
        </div>

        <div v-if="tab === 'local'" class="replay-panel__list">
          <div class="replay-panel__list-title">
            <span>每局结束自动保存到本地（最多 30 局）</span>
            <button v-if="history.length > 0" class="link-btn" type="button" @click="emit('clear')">清空</button>
          </div>
          <div v-for="item in history" :key="item.id" class="replay-row">
            <button
              class="replay-chip"
              :class="{ 'is-active': item.id === record?.id }"
              type="button"
              @click="emit('select', item)"
            >
              <span>{{ item.playedAt }}</span>
              <span class="replay-chip__meta">{{ meta(item) }}</span>
            </button>
            <button class="icon-btn icon-btn--sm" type="button" title="删除这局" @click="emit('remove', item.id)">
              ✕
            </button>
          </div>
          <div v-if="history.length === 0" class="replay-panel__empty">还没有保存的对局</div>
        </div>

        <div v-else class="replay-panel__list">
          <div class="replay-panel__list-title">
            <span>联机对局由服务器保存（MongoDB）</span>
            <button class="link-btn" type="button" :disabled="onlineLoading" @click="emit('refresh')">
              {{ onlineLoading ? '读取中…' : '刷新' }}
            </button>
          </div>
          <div v-for="item in onlineReplays" :key="item.id" class="replay-row">
            <button
              class="replay-chip"
              :class="{ 'is-active': item.id === record?.id }"
              type="button"
              @click="emit('select', item)"
            >
              <span>{{ item.playedAt }}</span>
              <span class="replay-chip__meta">{{ meta(item) }}</span>
            </button>
          </div>
          <div v-if="onlineReplays.length === 0" class="replay-panel__empty">
            点「刷新」从服务器读取历史对局
          </div>
        </div>
      </template>
    </div>
  </transition>
</template>
