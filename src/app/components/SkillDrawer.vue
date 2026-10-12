<script setup lang="ts">
/**
 * 移动端（竖屏）技能抽屉（bugv25 #5）。
 *
 * 手机上没有空间放左右两侧的大技能槽，于是改成：
 * 1. 立绘下方两个**无图标小按钮**（由 `App.vue` 渲染，本组件只管抽屉）；
 * 2. 点按钮 → 从**底部弹出抽屉**，显示该技能的完整详情；
 * 3. 抽屉底部的「使用」按钮 → 关闭抽屉并**进入挑选魔力植物**环节；
 *    不可用时按钮置灰并显示原因（与桌面气泡里的 `notice` 同源）。
 *
 * 桌面的技能槽 / 气泡完全不受影响 —— 这套 UI 只在窄屏渲染。
 */
import { computed } from 'vue'
import type { SkillUi } from '../useConnectGame'

const props = defineProps<{
  open: boolean
  skill: SkillUi | null
  /** 技能所属角色名（抽屉标题）。 */
  characterName: string
  /** 侧边特征色（与桌面技能槽一致的视觉语言）。 */
  color: string
  glow: string
  /** 是否轮到我方行动（不是则「使用」置灰）。 */
  active: boolean
  /** 只读（回放 / 联机旁观）时禁用「使用」。 */
  disabled: boolean
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'use'): void
}>()

/** 消耗文案（与桌面气泡一致：可变消耗显示区间）。 */
const costText = computed(() => {
  const skill = props.skill
  if (!skill) return ''
  if (skill.freeNow) return '免费'
  const min = skill.costMin ?? skill.costNow
  const max = skill.costMax ?? skill.costNow
  const range = max > min ? `${min}~${max}` : `${skill.costNow}`
  return skill.discountedNow ? `${range}（减 1）` : range
})

const stateText = computed(() => {
  const skill = props.skill
  if (!skill) return ''
  if (skill.remaining > 0) return `冷却中：还要行动 ${skill.remaining} 次`
  if (skill.ready) return '可以释放'
  return skill.reason ?? '暂时不可用'
})

const canUse = computed(
  () => Boolean(props.skill?.ready) && props.active && !props.disabled,
)
</script>

<template>
  <Transition name="drawer">
    <div v-if="open && skill" class="skill-drawer">
      <div class="skill-drawer__mask" @click="emit('close')" />
      <section
        class="skill-drawer__sheet"
        :style="{ '--side-color': color, '--side-glow': glow }"
        role="dialog"
        aria-modal="true"
      >
        <div class="skill-drawer__handle" aria-hidden="true" />

        <header class="skill-drawer__head">
          <span class="skill-drawer__char">{{ characterName }}</span>
          <!-- bugv26 #2：抽屉里也要显示技能图标（桌面技能槽一直有，手机上别丢） -->
          <span class="skill-drawer__icon" :class="{ 'is-cooling': skill.remaining > 0 }">
            <img v-if="skill.icon" :src="skill.icon" :alt="skill.name" draggable="false" />
            <i v-else class="skill-slot__leaf" aria-hidden="true" />
          </span>
          <span class="skill-drawer__name">{{ skill.name }}</span>
          <span class="skill-drawer__state" :class="{ 'is-cooling': skill.remaining > 0 }">
            {{ stateText }}
          </span>
        </header>

        <p class="skill-drawer__cost">
          <i class="skill-slot__leaf" aria-hidden="true" />
          <template v-if="skill.freeNow">首次释放<b>免费</b></template>
          <template v-else>需要 <b>{{ costText }}</b> 棵魔力植物</template>
          <em>场上已有 {{ skill.owned }} 棵</em>
        </p>

        <p class="skill-drawer__desc">{{ skill.desc }}</p>

        <div class="skill-drawer__actions">
          <button class="ghost-btn" type="button" @click="emit('close')">关闭</button>
          <button class="primary-btn" type="button" :disabled="!canUse" @click="emit('use')">
            {{ canUse ? '使用技能' : '暂不可用' }}
          </button>
        </div>
      </section>
    </div>
  </Transition>
</template>
