<script setup lang="ts">
/**
 * 联机大厅（bugv6 #8，bugv11 追加 #7 去掉连接配置）。
 *
 * 三种入口：在线匹配（FIFO 队列）、创建房间拿到 6 位匹配码、输入对方的匹配码加入。
 * 开局之后这个界面会被换掉，交给 3D 棋盘；对局中断（对手离开）时会再回到这里。
 *
 * bugv11 追加 #7：后端地址已经内置，进入大厅会**自动连接**，
 * 所以这里不再显示服务器地址 / 连接 / 断开这类东西，只留一句人话状态。
 */
import { computed, ref } from 'vue'

const props = defineProps<{
  status: string
  connected: boolean
  /** 已登录账号的昵称（bugv34i）。 */
  accountName: string
  message: string
  code: string
  queuePosition: number
  opponent: string
  seat: number
  /** 已从服务器拉到的回放数量。 */
  replayCount: number
}>()

const emit = defineEmits<{
  (event: 'back'): void
  (event: 'logout'): void
  (event: 'queue'): void
  (event: 'cancel'): void
  (event: 'create'): void
  (event: 'join', code: string): void
  (event: 'replays'): void
  (event: 'settings'): void
}>()

const joinCode = ref('')
const copied = ref(false)

const statusLabel = computed(() => {
  switch (props.status) {
    case 'connecting':
      return '正在连接服务器…'
    case 'idle':
      return '已就绪'
    case 'queued':
      return `匹配中 · 队列第 ${Math.max(props.queuePosition, 1)} 位`
    case 'room':
      return '房间已创建，等待对手'
    case 'playing':
      return '对局中'
    case 'ended':
      return '对局已结束'
    case 'error':
      return props.message || '连接异常'
    default:
      return '正在连接服务器…'
  }
})

const tone = computed(() =>
  props.status === 'idle' || props.status === 'playing' || props.status === 'queued'
    ? 'ok'
    : props.status === 'connecting' || props.status === 'room'
      ? 'busy'
      : props.status === 'error' || props.status === 'ended'
        ? 'bad'
        : 'idle',
)

function submitCode(): void {
  const value = joinCode.value.trim().toUpperCase()
  if (value.length < 4) return
  emit('join', value)
}

async function copyCode(): Promise<void> {
  if (!props.code) return
  try {
    await navigator.clipboard?.writeText(props.code)
  } catch {
    /* 剪贴板不可用时忽略，用户还能手动抄 */
  }
  copied.value = true
  globalThis.setTimeout(() => {
    copied.value = false
  }, 1600)
}
</script>

<template>
  <div class="start-menu">
    <div class="start-menu__inner online-lobby">
      <header class="start-menu__brand">
        <h1>联机对战</h1>
        <p>ONLINE · WebSocket · MongoDB</p>
      </header>

      <div class="online-lobby__status">
        <span class="online-dot" :class="`is-${tone}`" />
        <span>{{ statusLabel }}</span>
        <span v-if="accountName" class="online-lobby__account">已登录 · {{ accountName }}</span>
        <span v-if="opponent" class="online-lobby__opponent">对手：{{ opponent }}</span>
      </div>

      <p class="online-lobby__tip">
        同一个浏览器开两个标签页会共用同一身份与登录态，自测请用无痕窗口。
      </p>

      <div v-if="code" class="online-lobby__code">
        <div class="online-lobby__code-label">匹配码</div>
        <div class="online-lobby__code-value">{{ code }}</div>
        <button class="ghost-btn" type="button" @click="copyCode">{{ copied ? '已复制' : '复制' }}</button>
      </div>

      <nav class="start-menu__actions">
        <button
          v-if="props.status !== 'queued'"
          class="menu-btn menu-btn--primary"
          type="button"
          @click="emit('queue')"
        >
          <span class="menu-btn__label">在线匹配</span>
          <span class="menu-btn__meta">随机匹配一位在线玩家</span>
        </button>
        <button v-else class="menu-btn" type="button" @click="emit('cancel')">
          <span class="menu-btn__label">取消匹配</span>
          <span class="menu-btn__meta">正在队列中等待对手…</span>
        </button>

        <button class="menu-btn" type="button" @click="emit('create')">
          <span class="menu-btn__label">创建房间</span>
          <span class="menu-btn__meta">生成 6 位匹配码发给对手</span>
        </button>

        <div class="online-lobby__join">
          <input
            v-model="joinCode"
            class="online-lobby__input online-lobby__input--code"
            maxlength="6"
            placeholder="输入匹配码"
            spellcheck="false"
            @keydown.enter="submitCode"
          />
          <button class="primary-btn" type="button" @click="submitCode">加入</button>
        </div>

        <button class="menu-btn" type="button" @click="emit('replays')">
          <span class="menu-btn__label">服务器回放</span>
          <span class="menu-btn__meta">
            {{ replayCount > 0 ? `已拉取 ${replayCount} 局` : '从服务器读取历史对局' }}
          </span>
        </button>
      </nav>

      <p v-if="message" class="online-lobby__message" :class="{ 'is-error': props.status === 'error' }">
        {{ message }}
      </p>

      <footer class="start-menu__footer">
        <button class="link-btn" type="button" @click="emit('logout')">退出登录</button>
        <button class="link-btn" type="button" @click="emit('settings')">设置</button>
        <button class="link-btn" type="button" @click="emit('back')">返回主菜单</button>
      </footer>
    </div>
  </div>
</template>
