<script setup lang="ts">
/**
 * 角色选择（bugv9 #13 引入，bugv10 #8 改成横向轮播）。
 *
 * 开局与设置面板共用：可以为先手方 / 后手方分别选角色，两边可以选同一个角色。
 *
 * bugv10 #8：
 * - 横向轮播：一行两张卡（立绘 + 名称），左右箭头翻页，翻到头会绕回另一端；
 * - 第一张卡是「随机」：进入游戏时随机抽角色；
 * - 上方两个小标签切换正在编辑哪一方，并紧凑地显示两边当前的pick。
 *
 * 设置面板（`compact`）里同样能用，只是卡片更矮。
 */
import { computed, ref } from 'vue'
import type { PlayerIndex } from '../../core/types'
import type { CharacterDef, CharacterId } from '../characters'

const props = withDefaults(
  defineProps<{
    characters: ReadonlyArray<CharacterDef>
    value: [CharacterId, CharacterId]
    /** 只显示某一方（设置面板里按方设置时用）；不传就是两方都可选。 */
    only?: PlayerIndex
    /** 紧凑模式（设置面板里空间有限）。 */
    compact?: boolean
    /** 每一方是否选了「随机」（bugv10 #8，由 store 的 ui.characterRandom 传入）。 */
    random?: [boolean, boolean]
  }>(),
  {
    compact: false,
    random: () => [false, false] as [boolean, boolean],
  },
)

const emit = defineEmits<{
  (event: 'pick', player: PlayerIndex, id: CharacterId | 'random'): void
  /** 正在编辑哪一方（开始菜单用它决定右侧详情面板显示谁）。 */
  (event: 'side', player: PlayerIndex): void
}>()

const SIDE_LABEL: Record<PlayerIndex, string> = { 0: '先手方（左）', 1: '后手方（右）' }
const SIDE_LABEL_SHORT: Record<PlayerIndex, string> = { 0: '先手', 1: '后手' }

/** 每一页放两张卡（bugv10 #8：2 个角色一行）。 */
const PER_PAGE = 2

interface PickerCard {
  key: string
  kind: 'random' | 'character'
  name: string
  hint: string
  character?: CharacterDef
}

const sides = computed<PlayerIndex[]>(() => (props.only === undefined ? [0, 1] : [props.only]))
const editingSide = ref<PlayerIndex>(props.only ?? 0)

const cards = computed<PickerCard[]>(() => [
  { key: 'random', kind: 'random', name: '随机', hint: '进入游戏时随机选择角色' },
  ...props.characters.map((character) => ({
    key: character.id as string,
    kind: 'character' as const,
    name: character.name,
    hint: character.tagline,
    character,
  })),
])

const pageCount = computed(() => Math.max(1, Math.ceil(cards.value.length / PER_PAGE)))
const page = ref(0)
const safePage = computed(() => Math.max(0, Math.min(page.value, pageCount.value - 1)))
const pageCards = computed(() =>
  cards.value.slice(safePage.value * PER_PAGE, safePage.value * PER_PAGE + PER_PAGE),
)

/** 新一页从哪个方向滑进来（纯装饰）。 */
const slideX = ref('10px')

/** 翻页（到头绕回另一端）。 */
function step(delta: number): void {
  const count = pageCount.value
  slideX.value = delta >= 0 ? '10px' : '-10px'
  page.value = (safePage.value + delta + count) % count
}

function goTo(index: number): void {
  const target = Math.max(0, Math.min(index, pageCount.value - 1))
  slideX.value = target >= safePage.value ? '10px' : '-10px'
  page.value = target
}

function isRandom(side: PlayerIndex): boolean {
  return props.random[side] === true
}

function isSelected(card: PickerCard, side: PlayerIndex): boolean {
  if (card.kind === 'random') return isRandom(side)
  return !isRandom(side) && props.value[side] === card.key
}

function currentOf(side: PlayerIndex): CharacterDef | undefined {
  return props.characters.find((character) => character.id === props.value[side])
}

function currentName(side: PlayerIndex): string {
  return currentOf(side)?.name ?? '—'
}

function currentArt(side: PlayerIndex): string {
  return currentOf(side)?.art.idle ?? ''
}

function chooseSide(side: PlayerIndex): void {
  editingSide.value = side
  emit('side', side)
}

/** 点卡片：随机卡发 'random'，普通卡发角色 id。 */
function pick(card: PickerCard): void {
  const side = editingSide.value
  emit('side', side)
  if (card.kind === 'random') {
    emit('pick', side, 'random')
    return
  }
  if (card.character) emit('pick', side, card.character.id)
}

function hex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`
}

function cardStyle(card: PickerCard): Record<string, string> {
  const character = card.character
  if (!character) return { '--char-color': '#6d7688', '--char-glow': '#d7dceb' }
  return { '--char-color': hex(character.color), '--char-glow': hex(character.glow) }
}
</script>

<template>
  <div class="character-picker" :class="{ 'is-compact': compact }">
    <!-- 双方当前的选择 + 正在编辑哪一方（bugv10 #8） -->
    <div v-if="sides.length > 1" class="character-picker__tabs" role="tablist">
      <button
        v-for="side in sides"
        :key="side"
        type="button"
        role="tab"
        class="picker-tab"
        :class="{ 'is-active': editingSide === side }"
        :data-side="side"
        :aria-selected="editingSide === side"
        @click="chooseSide(side)"
      >
        <span class="picker-tab__label">{{ compact ? SIDE_LABEL_SHORT[side] : SIDE_LABEL[side] }}</span>
        <span class="picker-tab__pick">
          <img
            v-if="currentArt(side)"
            class="picker-tab__art"
            :src="currentArt(side)"
            alt=""
            draggable="false"
          />
          <span v-else class="picker-tab__art picker-tab__art--random">?</span>
          <span class="picker-tab__name">{{ currentName(side) }}</span>
          <span v-if="isRandom(side)" class="picker-tab__tag">随机</span>
        </span>
      </button>
    </div>

    <!-- 横向轮播 -->
    <div class="character-carousel">
      <button class="carousel-arrow" type="button" data-carousel="prev" aria-label="上一页角色" @click="step(-1)">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M14.5 5 7.5 12l7 7"
          />
        </svg>
      </button>

      <div class="character-carousel__viewport">
        <div
          :key="safePage"
          class="character-carousel__page character-picker__cards"
          :style="{ '--slide-x': slideX }"
        >
          <button
            v-for="card in pageCards"
            :key="card.key"
            type="button"
            class="character-card"
            :class="{
              'is-active': isSelected(card, editingSide),
              'is-random': card.kind === 'random',
              'character-card--random': card.kind === 'random',
            }"
            :style="cardStyle(card)"
            :data-character="card.key"
            :title="card.kind === 'random' ? card.hint : `${card.name}｜${card.hint}`"
            @click="pick(card)"
          >
            <img
              v-if="card.character && card.character.art.idle"
              class="character-card__art"
              :src="card.character.art.idle"
              :alt="card.name"
              draggable="false"
            />
            <span v-else class="character-card__art character-card__art--glyph">
              {{ card.kind === 'random' ? '?' : card.name.slice(0, 1) }}
            </span>
            <span class="character-card__name">{{ card.name }}</span>
            <span v-if="card.kind === 'random'" class="character-card__hint">{{ card.hint }}</span>
          </button>
        </div>
      </div>

      <button class="carousel-arrow" type="button" data-carousel="next" aria-label="下一页角色" @click="step(1)">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M9.5 5l7 7-7 7"
          />
        </svg>
      </button>

      <div v-if="pageCount > 1" class="character-carousel__dots">
        <button
          v-for="index in pageCount"
          :key="index"
          type="button"
          class="carousel-dot"
          :class="{ 'is-active': safePage === index - 1 }"
          :aria-label="`第 ${index} 页`"
          @click="goTo(index - 1)"
        />
      </div>
    </div>
  </div>
</template>
