<script setup lang="ts">
/**
 * 角色技能槽（bugv9 #13，bugv10 #7 改气泡）。
 *
 * 画面左右侧中间各一组，每组两个技能：
 * - 冷却中 / 植物不够时按钮变灰，点击后在**技能槽旁边**冒出一个气泡说明原因；
 * - 可用时点击进入"挑选魔力植物"状态（画面变暗、场上我方的植物高亮），
 *   这时气泡变成该技能的详情（消耗 / 冷却 / 效果说明）；
 * - 挑选过程中按钮上显示"已选 n/need"，再点一次取消。
 *
 * bugv10 #7：点击技能**不再弹窗**，详情改用贴在技能槽旁的泡泡显示。
 */
import type { PlayerIndex } from '../../core/types'
import type { SkillUi } from '../useConnectGame'

const props = defineProps<{
  player: PlayerIndex
  side: PlayerIndex
  skills: SkillUi[]
  /** 是否轮到这一方行动。 */
  active: boolean
  /** 正在为哪个技能挑植物（null = 没在挑）。 */
  selectingSlot: number | null
  selectedCount: number
  /** 联机对局禁用技能。 */
  disabled: boolean
  /**
   * bugv25 #1：**只读展示**（回放）。
   *
   * 与 `disabled` 的区别：`disabled` 用 0.5 透明度表示"现在轮不到你"，
   * 而回放里技能框的用途是**看当时的冷却状态**，太淡会看不见（用户反馈的问题），
   * 所以只读模式保持不透明，仅去掉交互。
   */
  readOnly?: boolean
  /** 角色名（悬停提示里显示）。 */
  characterName: string
  /** bugv10 #7：哪个技能槽的气泡是打开的（null = 没有气泡）。 */
  bubbleSlot?: number | null
  /** bugv10 #7：气泡里额外显示的"为什么现在用不了"（空字符串 = 只是看详情）。 */
  notice?: string
  /**
   * bugv11 #2：刚刚被释放的技能槽（`{ slot, key }`）。
   *
   * 高亮 + 流光播 `SKILL_FLASH_MS` 毫秒后自动消失；`key` 每次释放都变，
   * 因此连着用同一个技能时动画也会重播。
   */
  flash?: { slot: number; key: number } | null
}>()

const emit = defineEmits<{
  (event: 'cast', slot: number): void
}>()

void props.player

/** 气泡里的一句话状态：冷却中还要等几次 / 可以释放。 */
function stateText(skill: SkillUi): string {
  if (skill.remaining > 0) return `冷却中：还要行动 ${skill.remaining} 次`
  if (skill.ready) return '可以释放'
  return skill.reason ?? '暂时不可用'
}

/**
 * 消耗的显示文案（bugv14）。
 *
 * 可变消耗技能（「最直接、最不绕弯子」）显示 `1~4 棵`，其余显示固定数量；
 * 首次免费 / 减费也在这里体现。
 */
function costText(skill: SkillUi): string {
  if (skill.freeNow) return '免费'
  const min = skill.costMin ?? skill.costNow
  const max = skill.costMax ?? skill.costNow
  const range = max > min ? `${min}~${max}` : `${skill.costNow}`
  if (skill.discountedNow) return `${range}（减 1）`
  return range
}
</script>

<template>
  <div
    class="skill-bar"
    :class="[
      `is-side-${side}`,
      { 'is-active': active && !disabled, 'is-disabled': disabled, 'is-readonly': readOnly === true },
    ]"
    :data-skill-bar="side"
  >
    <button
      v-for="skill in skills"
      :key="skill.id"
      type="button"
      class="skill-slot"
      :disabled="readOnly === true"
      :class="[
        `is-${skill.effectKind}`,
        {
          'is-ready': skill.ready && active && !disabled,
          'is-cooling': skill.remaining > 0,
          'is-picking': selectingSlot === skill.slot,
          'has-bubble': bubbleSlot === skill.slot,
          'is-flash': flash !== null && flash !== undefined && flash.slot === skill.slot,
        },
      ]"
      :data-flash="flash && flash.slot === skill.slot ? flash.key : undefined"
      :title="`${characterName} · ${skill.name}｜消耗 ${
        skill.costNow > 0 ? `${costText(skill)} 棵魔力植物` : '无（首次释放免费）'
      }｜${skill.desc}${skill.reason ? `（${skill.reason}）` : ''}`"
      :data-skill="skill.id"
      @click="emit('cast', skill.slot)"
    >
      <!-- bugv11 #2：释放瞬间扫过一道流光，提醒对手"他用了技能" -->
      <span
        v-if="flash && flash.slot === skill.slot"
        :key="flash.key"
        class="skill-slot__flash"
        aria-hidden="true"
      />

      <span class="skill-slot__icon">
        <img v-if="skill.icon" :src="skill.icon" :alt="skill.name" draggable="false" />
        <span v-else class="skill-slot__glyph">{{ skill.name.slice(0, 1) }}</span>
      </span>
      <span class="skill-slot__name">{{ skill.name }}</span>
      <span v-if="!skill.ready" class="skill-slot__state">
        {{ skill.remaining > 0 ? '冷却中' : '不可用' }}
      </span>
      <span v-else-if="skill.freeNow" class="skill-slot__state is-free">首次免费</span>
      <span class="skill-slot__cost">
        <i class="skill-slot__leaf" aria-hidden="true" />
        {{ costText(skill) }}
      </span>
      <span v-if="skill.remaining > 0" class="skill-slot__cd">{{ skill.remaining }}</span>
      <span v-else-if="selectingSlot === skill.slot" class="skill-slot__pick">
        {{ selectedCount }}/{{ skill.costNow }}
      </span>

      <!-- bugv10 #7：贴在技能槽旁边的详情气泡（不弹窗） -->
      <Transition name="skill-bubble">
        <span
          v-if="bubbleSlot === skill.slot"
          class="skill-bubble"
          :class="[`is-side-${side}`, { 'is-warning': notice !== undefined && notice !== '' }]"
          role="tooltip"
        >
          <span class="skill-bubble__tail" aria-hidden="true" />
          <span class="skill-bubble__head">
            <span class="skill-bubble__name">{{ skill.name }}</span>
            <span class="skill-bubble__state" :class="{ 'is-cooling': skill.remaining > 0 }">
              {{ stateText(skill) }}
            </span>
          </span>
          <span class="skill-bubble__cost">
            <i class="skill-slot__leaf" aria-hidden="true" />
            <template v-if="skill.freeNow">首次释放<span class="skill-bubble__free">免费</span></template>
            <template v-else>需要 {{ costText(skill) }} 棵魔力植物</template>
            <em class="skill-bubble__owned">场上已有 {{ skill.owned }} 棵</em>
          </span>
          <span class="skill-bubble__desc">{{ skill.desc }}</span>
          <span v-if="notice" class="skill-bubble__notice">{{ notice }}</span>
        </span>
      </Transition>
    </button>
  </div>
</template>
