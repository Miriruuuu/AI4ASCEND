<script setup lang="ts">
import type { PlayerMeta } from '../useConnectGame'

const props = defineProps<{
  open: boolean
  players: [PlayerMeta, PlayerMeta]
  resultText: string
  canResume: boolean
}>()

const emit = defineEmits<{
  (event: 'resume'): void
  (event: 'restart'): void
  (event: 'settings'): void
  (event: 'menu'): void
  (event: 'close'): void
}>()

void props
</script>

<template>
  <transition name="fade">
    <div v-if="open" class="overlay overlay--menu" @click.self="emit('close')">
      <div class="game-menu">
        <div class="game-menu__title">菜单</div>
        <div class="game-menu__sub">{{ resultText }}</div>

        <div class="game-menu__actions">
          <button v-if="canResume" class="menu-btn menu-btn--primary" type="button" @click="emit('resume')">
            <span class="menu-btn__label">继续对局</span>
            <span class="menu-btn__meta">回到棋盘</span>
          </button>
          <button class="menu-btn" type="button" @click="emit('restart')">
            <span class="menu-btn__label">重新开始</span>
            <span class="menu-btn__meta">重掷骰子决定先后手</span>
          </button>
          <button class="menu-btn" type="button" @click="emit('settings')">
            <span class="menu-btn__label">设置</span>
            <span class="menu-btn__meta">模式 · 难度 · 特征色</span>
          </button>
          <button class="menu-btn" type="button" @click="emit('menu')">
            <span class="menu-btn__label">返回主菜单</span>
            <span class="menu-btn__meta">结束当前对局</span>
          </button>
        </div>

        <div class="game-menu__players">
          <div v-for="player in players" :key="player.name" class="game-menu__player">
            <span
              class="game-menu__dot"
              :style="{ background: `#${player.palette.color.toString(16).padStart(6, '0')}` }"
            />
            {{ player.name }} · {{ player.isAi ? 'AI' : '玩家' }}
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>
