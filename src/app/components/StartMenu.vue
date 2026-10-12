<script setup lang="ts">
/**
 * 开始菜单（bugv10 #8：左右两栏）。
 *
 * 左栏：品牌 + 模式 + 角色轮播 + 操作按钮 + 键盘提示；
 * 右栏：当前选中角色的技能详情（点角色卡 / 切换先手后手时同步刷新）。
 *
 * 这样菜单不再那么高，角色只用大立绘 + 名称展示。
 */
import { computed, ref } from 'vue'
import type { PlayerIndex } from '../../core/types'
import CharacterDetail from './CharacterDetail.vue'
import CharacterPicker from './CharacterPicker.vue'
import type { CharacterId } from '../characters'
import type { CharacterDef, GameMode } from '../useConnectGame'

const props = withDefaults(
  defineProps<{
    mode: GameMode
    difficulty: string
    hasReplay: boolean
    replayCount: number
    /** 可选角色（bugv9 #13）。 */
    characters: ReadonlyArray<CharacterDef>
    characterValue: [CharacterId, CharacterId]
    /** 两方是否选了「随机」（bugv10 #8，由 store 的 ui.characterRandom 传入）。 */
    randomValue?: [boolean, boolean]
  }>(),
  {
    randomValue: () => [false, false] as [boolean, boolean],
  },
)

const emit = defineEmits<{
  (event: 'start'): void
  (event: 'replay'): void
  (event: 'settings'): void
  /** bugv28 #1：游玩须知（版权与使用声明）。 */
  (event: 'promise'): void
  /** bugv30 #5：游戏规则（读 help.md）。 */
  (event: 'rules'): void
  (event: 'setMode', mode: GameMode): void
  (event: 'pickCharacter', player: PlayerIndex, id: CharacterId | 'random'): void
}>()

const MODES: ReadonlyArray<{ value: GameMode; label: string; hint: string }> = [
  { value: 'pve', label: '人机对战', hint: '你执先手，AI 执后手' },
  { value: 'pvp', label: '双人对战', hint: '左右双方同屏对弈' },
  { value: 'eve', label: 'AI 对战', hint: '两个最强 AI 自动对弈，可当观战' },
  { value: 'online', label: '联机对战', hint: '在线匹配或匹配码开局，联机对局也能回放' },
]

const modeLabel = computed(() => MODES.find((item) => item.value === props.mode)?.label ?? '人机对战')
const modeHint = computed(() => MODES.find((item) => item.value === props.mode)?.hint ?? '')

const difficultyLabel = computed(() => {
  switch (props.difficulty) {
    case 'easy':
      return '轻松'
    case 'hard':
      return '进阶'
    case 'expert':
      return '专家'
    default:
      return '标准'
  }
})

/** 右侧详情面板展示哪一方的角色（跟随轮播里正在编辑的那一方）。 */
const detailSide = ref<PlayerIndex>(0)

const detailCharacter = computed<CharacterDef | undefined>(() =>
  props.characters.find((character) => character.id === props.characterValue[detailSide.value]),
)

const detailRandom = computed(() => props.randomValue[detailSide.value] === true)

function onPick(player: PlayerIndex, id: CharacterId | 'random'): void {
  detailSide.value = player
  emit('pickCharacter', player, id)
}

function onSide(player: PlayerIndex): void {
  detailSide.value = player
}
</script>

<template>
  <div class="start-menu">
    <!-- ⚠️ `start-menu__inner--solo`：窄屏下的单栏重排（`order` 那一串）**只属于主菜单**，
         房间 / 大厅 / 登录面板同样是单栏，若继承会把标题推到面板最底部（bugv34l）。 -->
    <div class="start-menu__inner start-menu__inner--solo">
      <div class="start-menu__left">
        <header class="start-menu__brand">
          <h1>四子棋</h1>
          <p>9 × 9 · 连珠对战 · 3D</p>
        </header>

        <div class="start-menu__modes">
          <button
            v-for="item in MODES"
            :key="item.value"
            type="button"
            class="mode-chip"
            :class="{ 'is-active': mode === item.value }"
            @click="emit('setMode', item.value)"
          >
            {{ item.label }}
          </button>
        </div>
        <p class="start-menu__hint">{{ modeHint }}</p>

        <!-- 角色选择（bugv10 #8：横向轮播 + 随机卡） -->
        <CharacterPicker
          :characters="characters"
          :value="characterValue"
          :random="randomValue"
          @pick="onPick"
          @side="onSide"
        />

        <nav class="start-menu__actions">
          <!-- bugv30 #1：动作按钮改成「一行两个」；主按钮（开始游戏）整行通栏 -->
          <button class="menu-btn menu-btn--wide menu-btn--primary" type="button" @click="emit('start')">
            <span class="menu-btn__label">{{ mode === 'eve' ? '开始观战' : '开始游戏' }}</span>
            <span class="menu-btn__meta">{{ modeLabel }} · {{ difficultyLabel }}</span>
          </button>

          <button class="menu-btn" type="button" :disabled="!hasReplay" @click="emit('replay')">
            <span class="menu-btn__label">查看回放</span>
            <span class="menu-btn__meta">
              {{ hasReplay ? `已保存 ${replayCount} 局` : '暂无可回放对局' }}
            </span>
          </button>

          <button class="menu-btn" type="button" @click="emit('settings')">
            <span class="menu-btn__label">更改设置</span>
            <span class="menu-btn__meta">模式 · 难度 · 角色 · 技能</span>
          </button>

          <!-- bugv30 #5：游戏规则（读 help.md） -->
          <button class="menu-btn" type="button" @click="emit('rules')">
            <span class="menu-btn__label">游戏规则</span>
            <span class="menu-btn__meta">落子 · 连珠 · 魔力植物</span>
          </button>

          <!-- bugv28 #1：游玩须知（版权与使用声明） -->
          <button class="menu-btn" type="button" @click="emit('promise')">
            <span class="menu-btn__label">游玩须知</span>
            <span class="menu-btn__meta">版权声明 · 素材来源</span>
          </button>
        </nav>

        <footer class="start-menu__footer">
          <span><kbd>Esc</kbd> 呼出菜单</span>
          <span><kbd>R</kbd> 重开一局</span>
          <span><kbd>H</kbd> 跳过动画</span>
        </footer>
      </div>

      <!-- 右栏：选中角色的技能详情（bugv10 #8；bugv34k 抽成公共组件，联机房间复用） -->
      <CharacterDetail
        v-if="detailCharacter"
        class="start-menu__detail"
        :character="detailCharacter"
        :side="detailSide"
        :random="detailRandom"
      />
    </div>
  </div>
</template>
