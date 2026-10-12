<script setup lang="ts">
/**
 * 角色技能详情（bugv34k，从 `StartMenu.vue` 抽出来复用）。
 *
 * 单机开始菜单的右栏用它；联机房间里也用它，让"房间内选角色"与单机**完全一致**
 * （同一套立绘 + 名称 + 技能图标 / 消耗 / 冷却 / 效果文案）。
 */
import type { PlayerIndex, SkillSpec } from '../../core/types'
import { skillEffectText, skillIcon, type CharacterDef } from '../characters'
import { skillIconUrl } from '../../three/skill-icons'

const props = withDefaults(
  defineProps<{
    character: CharacterDef
    /** 这一侧是谁（先手 / 后手）；房间里恒为 0（只有"我"）。 */
    side?: PlayerIndex
    /** 是否选了「随机」（选了的话补一句"下面是本次预览"）。 */
    random?: boolean
    /** 先手 / 后手标签（联机房间里没有"方"的概念，可以改成别的文案）。 */
    sideLabel?: string
  }>(),
  {
    side: 0,
    random: false,
    sideLabel: '',
  },
)

const SIDE_LABEL: Record<PlayerIndex, string> = { 0: '先手方（左）', 1: '后手方（右）' }

/** 没有外部标签时按座位给默认文案。 */
const eyebrow = (): string => (props.sideLabel ? props.sideLabel : SIDE_LABEL[props.side])

/** 技能图标：与对局里技能槽同一张程序化生成的图，不要用字形占位。 */
function iconOf(skill: SkillSpec): string {
  return skillIconUrl(skillIcon(skill), props.character.color, props.character.glow)
}

function hex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`
}
</script>

<template>
  <aside
    class="character-detail"
    :style="{ '--char-color': hex(character.color), '--char-glow': hex(character.glow) }"
    :data-detail-side="side"
  >
    <div class="detail-char">
      <img
        v-if="character.art.idle"
        class="detail-char__art"
        :src="character.art.idle"
        :alt="character.name"
        draggable="false"
      />
      <span v-else class="detail-char__art detail-char__art--empty">{{ character.name.slice(0, 1) }}</span>
      <span class="detail-char__meta">
        <span class="detail-char__eyebrow">{{ eyebrow() }} · 当前选择</span>
        <span class="detail-char__name">{{ character.name }}</span>
        <span class="detail-char__tagline">{{ character.tagline }}</span>
      </span>
    </div>

    <p v-if="random" class="detail-roll">
      该方已选择「随机」：进入游戏时会重新抽取角色，下面是本次预览。
    </p>

    <ul class="detail-skills">
      <li v-for="skill in character.skills" :key="skill.id" class="detail-skill">
        <div class="detail-skill__top">
          <span class="detail-skill__icon">
            <img v-if="iconOf(skill)" :src="iconOf(skill)" :alt="skill.name" draggable="false" />
            <span v-else class="detail-skill__glyph">{{ skill.name.slice(0, 1) }}</span>
          </span>
          <span class="detail-skill__name">{{ skill.name }}</span>
          <span class="detail-skill__meta">消耗 {{ skill.cost }} · 冷却 {{ skill.cooldown }}</span>
        </div>
        <p class="detail-skill__desc">{{ skillEffectText(skill) }}</p>
      </li>
    </ul>

    <p class="detail-tip">技能消耗场上被我方棋子占用的魔力植物，开局即处于冷却中。</p>
  </aside>
</template>
