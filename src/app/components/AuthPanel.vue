<script setup lang="ts">
/**
 * 联机登录（bugv34i；bugv34k 简化交互）。
 *
 * 交互只有一条路径 —— **不用在「登录 / 注册」之间切换**：
 * 1. 填**账号 + 密码**，点「登录」；
 * 2. 服务端查到账号 → 直接登录成功；
 * 3. 服务端回 `userNotFound`（账号不存在）→ **自动进入注册流程**：
 *    在下方多出一个**昵称**输入框（做高一点，显得大气），
 *    再点一次「登录」就以这组账号密码注册并登录。
 *
 * 登录成功后令牌存在本地，**不退出登录就一直保持登录态**。
 */
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  /**
   * 当前处于哪一步：
   * - `login`：还没查过 / 账号存在；
   * - `register`：服务端说账号不存在 → 已展开昵称输入框。
   */
  mode: 'login' | 'register'
  /** 请求是否在途。 */
  busy: boolean
  /** 提示 / 报错文案。 */
  message: string
  /** 是否已连上服务器（未连上时提示"正在连接"）。 */
  connected: boolean
}>()

const emit = defineEmits<{
  /** 点「登录」：父组件先按账号登录，账号不存在会自动切到注册流程。 */
  (event: 'submit', username: string, password: string, nickname: string): void
  (event: 'back'): void
}>()

const username = ref('')
const password = ref('')
const nickname = ref('')

/** 是否已经进入「注册流程」（账号不存在 → 展开昵称栏）。 */
const needNickname = computed(() => props.mode === 'register')

const canSubmit = computed(() => {
  if (props.busy) return false
  if (username.value.trim().length < 3) return false
  if (password.value.length < 4) return false
  if (needNickname.value && nickname.value.trim() === '') return false
  return true
})

/** 账号自动不存在、切到注册流程时，把账号名预填进昵称，少打一次字。 */
watch(
  () => props.mode,
  (mode) => {
    if (mode === 'register' && nickname.value.trim() === '') nickname.value = username.value.trim()
  },
)

function submit(): void {
  if (!canSubmit.value) return
  emit('submit', username.value.trim(), password.value, nickname.value.trim())
}
</script>

<template>
  <div class="start-menu">
    <div class="start-menu__inner auth-panel">
      <header class="start-menu__brand">
        <h1>联机对战</h1>
        <p>ONLINE · 需要账号登录</p>
      </header>

      <div class="auth-panel__hint">
        <template v-if="needNickname">
          账号 <b>{{ username.trim() || '（待填）' }}</b> 不存在 ——
          补一个<b>昵称</b>后点下面的「登录」，就会以此注册并直接进入联机。
        </template>
        <template v-else>
          输入<b>账号</b>与<b>密码</b>点「登录」。如果这个账号还没注册过，
          我们会让你补一个昵称，然后自动完成注册。
        </template>
      </div>

      <form class="auth-panel__form" @submit.prevent="submit">
        <label class="auth-field">
          <span class="auth-field__label">账号</span>
          <input
            v-model="username"
            class="auth-field__input"
            type="text"
            autocomplete="username"
            maxlength="20"
            placeholder="3-20 位字母 / 数字 / 下划线"
            spellcheck="false"
            @keydown.enter.prevent="submit"
          />
        </label>

        <label class="auth-field">
          <span class="auth-field__label">密码</span>
          <input
            v-model="password"
            class="auth-field__input"
            type="password"
            :autocomplete="needNickname ? 'new-password' : 'current-password'"
            maxlength="64"
            placeholder="至少 4 位"
            @keydown.enter.prevent="submit"
          />
        </label>

        <!-- 账号不存在时才出现：昵称（取代了设置里的"联机昵称"） -->
        <label v-if="needNickname" class="auth-field auth-field--extra">
          <span class="auth-field__label">昵称（新账号）</span>
          <input
            v-model="nickname"
            class="auth-field__input"
            type="text"
            maxlength="16"
            placeholder="显示给对手的名字"
            @keydown.enter.prevent="submit"
          />
        </label>

        <p v-if="message" class="online-lobby__message is-error">{{ message }}</p>
        <p v-else-if="!connected" class="online-lobby__message">正在连接服务器…</p>

        <!-- 底部并排两个按钮：登录 / 返回主菜单 -->
        <nav class="auth-panel__actions">
          <button class="menu-btn menu-btn--primary" type="submit" :disabled="!canSubmit">
            <span class="menu-btn__label">{{ busy ? '请稍候…' : needNickname ? '注册并登录' : '登录' }}</span>
            <span class="menu-btn__meta">
              {{ needNickname ? '账号不存在，补昵称即可注册' : '已有账号直接进；没有就自动注册' }}
            </span>
          </button>

          <button class="menu-btn" type="button" :disabled="busy" @click="emit('back')">
            <span class="menu-btn__label">返回主菜单</span>
            <span class="menu-btn__meta">登录状态会保留在本机</span>
          </button>
        </nav>
      </form>
    </div>
  </div>
</template>
