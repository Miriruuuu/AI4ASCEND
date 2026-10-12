<script setup lang="ts">
/**
 * 左右上角的角色立绘 + 血条（bugv9 #13，bugv10 #6 调整）。
 *
 * 需求（bugv10 #6）：
 * - 立绘的长宽各增加 200%（也就是变成原来的 3 倍），不再显得那么小；
 * - 不再显示 "6 HP" 这类数字，只保留立绘与血条；
 * - 血条放在立绘**上方**，并且与立绘**等宽**。
 *
 * 因此这里只保留：
 * - 角色立绘（含 idle / atk / hit / win / lose 五个表情差分）；
 * - 血条（护盾显示为**金属质感的银色**段落，叠在血条最左侧，也就是最先被打掉的位置）。
 *
 * 血量数字仍然留在 DOM 里（`.hp-value`，视觉上裁剪隐藏），方便辅助技术 / 校验脚本读取。
 */
import { computed, nextTick, ref, watch } from 'vue'
import type { PlayerIndex } from '../../core/types'
import type { Expression } from '../characters'
import type { PlayerMeta } from '../useConnectGame'

const props = defineProps<{
  player: PlayerMeta
  side: PlayerIndex
  hp: number
  shield: number
  /** 临时护甲（bugv14 精密计算）：先于护盾承伤，到期作废。 */
  tempArmor: number
  initialHp: number
  active: boolean
  attacker: boolean
  defender: boolean
  isAi: boolean
  /** 当前表情差分（bugv9 #13）。 */
  expression: Expression
  /** 还能连续行动几次（>0 时显示标记）。 */
  bonusActions: number
  /**
   * bugv25 #2：本回合的**增伤总额**（>0 时在立绘旁挂徽章）。
   *
   * 组成：`powerBonus`（glm「小一哥」持续增伤）+ `strikeBonus`（claude「力大砖飞」）
   * + `sabotageBonus`（glm「毒鸡蛋」本回合 +1）。
   * 以前只有"连续行动"有标识，玩家看不出自己其实正在加成状态里。
   */
  damageBonus: number
  /**
   * 此刻是否处于**免疫状态**（bugv17 #8）。
   *
   * 组成：`isDamageImmune()` = 「双子星」爆发窗口（gemini 2 技能）或「精密计算」的无敌。
   * 免疫时在血条旁边直接挂一个"免疫"徽章，否则玩家只能从伤害为 0 反推。
   */
  immune: boolean
  /** 每次撞击 +1（用于血条抖动与飘字重播）。 */
  impactTick: number
  /** 每次撞击 +1，避免相同数值不触发 watch。 */
  damageFlash: number
  /**
   * 联机倒计时（bugv28 #4）：轮到这一方行动时，剩余毫秒（null = 不显示）。
   *
   * 由宿主每帧从"回合结束的世界时间"反推，不用计时器。
   */
  timeLeft?: number | null
  /** 本次倒计时总时长（毫秒），用来画进度环。 */
  timeTotal?: number
  /**
   * 护盾到手计数（bugv29 #4）：每次 +1 就让立绘播一次 2 秒的**镜面反光**。
   */
  shieldFlash?: number
  /**
   * 护盾 / 临时护甲被击碎计数（bugv31）：每次 +1 让立绘播一次**镜面破碎**。
   */
  armorBreak?: number
}>()

const hex = (value: number) => `#${value.toString(16).padStart(6, '0')}`

const themeVars = computed(() => ({
  '--side-color': hex(props.player.palette.color),
  '--side-glow': hex(props.player.palette.glow),
}))

/** 立绘地址（缺表情时回退到基础立绘）。 */
const art = computed(() => props.player.art?.[props.expression] || props.player.art?.idle || '')

const ratio = computed(() => {
  const value = Math.max(0, props.hp)
  return Math.max(0, Math.min(1, value / props.initialHp))
})

/** 护盾占血条的比例（无上限，但条上最多画满一格）。 */
const shieldRatio = computed(() => Math.max(0, Math.min(1, props.shield / props.initialHp)))
/** bugv14：临时护甲的条宽（与护盾同一条血条上，叠在护盾里侧）。 */
const armorRatio = computed(() => Math.max(0, Math.min(1, props.tempArmor / props.initialHp)))

/** 血条“残影”：先显示上一段血量，再回落。 */
const ghostRatio = ref(ratio.value)
watch(
  () => props.hp,
  (value, previous) => {
    if (previous === undefined || value >= previous) {
      ghostRatio.value = ratio.value
      return
    }
    globalThis.setTimeout(() => {
      ghostRatio.value = Math.max(0, Math.min(1, value / props.initialHp))
    }, 380)
  },
)

/** 撞击抖动：短时间内的连续撞击不打断动画，避免看起来在“抽搐”。 */
const shaking = ref(false)
let shakeTimer: ReturnType<typeof globalThis.setTimeout> | null = null
watch(
  () => props.impactTick,
  () => {
    if (shaking.value) return
    shaking.value = true
    if (shakeTimer !== null) globalThis.clearTimeout(shakeTimer)
    shakeTimer = globalThis.setTimeout(() => {
      shaking.value = false
    }, 430)
  },
)

/** 飘字：每次撞击都播一次“-1”（用 key 强制重播动画）。 */
const damageKey = ref(0)
const damageVisible = ref(false)
let damageTimer: ReturnType<typeof globalThis.setTimeout> | null = null
watch(
  () => props.damageFlash,
  (value) => {
    if (!value) return
    damageKey.value = value
    damageVisible.value = false
    globalThis.requestAnimationFrame(() => {
      damageVisible.value = true
    })
    if (damageTimer !== null) globalThis.clearTimeout(damageTimer)
    damageTimer = globalThis.setTimeout(() => {
      damageVisible.value = false
    }, 900)
  },
)

const hpClass = computed(() => ({
  'is-low': props.hp > 0 && props.hp <= 2,
  'is-negative': props.hp <= 0,
}))

const ticks = computed(() => Math.max(1, props.initialHp))

/** 联机倒计时进度环（bugv28 #4）。 */
const TIMER_CIRCUMFERENCE = 2 * Math.PI * 19
const timerVisible = computed(() => props.timeLeft !== null && props.timeLeft !== undefined)
const timerRatio = computed(() => {
  const total = props.timeTotal ?? 0
  const left = props.timeLeft ?? 0
  if (total <= 0) return 0
  return Math.max(0, Math.min(1, left / total))
})
const timerSeconds = computed(() => Math.max(0, Math.ceil((props.timeLeft ?? 0) / 1000)))
const timerUrgent = computed(() => timerVisible.value && (props.timeLeft ?? 0) <= 5000)
const timerDash = computed(() => `${TIMER_CIRCUMFERENCE * timerRatio.value} ${TIMER_CIRCUMFERENCE}`)

/**
 * bugv29 #4：护盾到手 → 立绘扫一道镜面反光（2 秒）。
 *
 * 用 `key` 强制重播：连续两次拿护盾时，同一个 DOM 上的 CSS 动画不会自己重头放。
 */
const glossKey = ref(0)
const glossVisible = ref(false)
let glossTimer: ReturnType<typeof globalThis.setTimeout> | null = null
watch(
  () => props.shieldFlash ?? 0,
  (value) => {
    if (!value) return
    glossKey.value = value
    glossVisible.value = false
    // 用 `nextTick` 而不是 `requestAnimationFrame` 强制重播 —— 后台标签页 / headless 里
    // rAF 会被节流甚至暂停，用 rAF 会让反光**永远不出现**（验收脚本实测踩到）。
    void nextTick(() => {
      glossVisible.value = true
    })
    if (glossTimer !== null) globalThis.clearTimeout(glossTimer)
    glossTimer = globalThis.setTimeout(() => {
      glossVisible.value = false
    }, 2000)
  },
)

/**
 * bugv31：护盾 / 临时护甲被**击碎** → 立绘播一次「镜面破碎」。
 *
 * 做法：把立绘本身切成 8 片（每片都是一整张立绘 + `clip-path` 裁出的三角形，
 * 所以碎片拼起来与立绘完全对齐），让它们从中心向外飞散、旋转、淡出，
 * 再叠一记瞬时白光。整段 0.85 秒，结束后自动卸载。
 *
 * 同样用 `key` 强制重播（连续两次被打碎时，同一 DOM 的 CSS 动画不会自己重头放），
 * 并且用 `nextTick` 而不是 `requestAnimationFrame`（后台标签页 / headless 里 rAF 会被节流）。
 */
const shatterKey = ref(0)
const shatterVisible = ref(false)
let shatterTimer: ReturnType<typeof globalThis.setTimeout> | null = null
watch(
  () => props.armorBreak ?? 0,
  (value) => {
    if (!value) return
    shatterKey.value = value
    shatterVisible.value = false
    void nextTick(() => {
      shatterVisible.value = true
    })
    if (shatterTimer !== null) globalThis.clearTimeout(shatterTimer)
    shatterTimer = globalThis.setTimeout(() => {
      shatterVisible.value = false
    }, 900)
  },
)

/**
 * 8 片碎片：矩形被"中心 + 两条对角线 + 中线"切成 8 个三角形，刚好铺满立绘。
 *
 * `dx/dy` 是飞散方向（百分比，相对立绘宽高），`rot` 是自转角度，`delay` 让碎片错开一丁点。
 */
const PORTRAIT_SHARDS: readonly { readonly dx: string; readonly dy: string; readonly rot: string; readonly delay: string }[] = [
  { dx: '-86%', dy: '-70%', rot: '-22deg', delay: '0s' },
  { dx: '-26%', dy: '-96%', rot: '14deg', delay: '0.01s' },
  { dx: '34%', dy: '-88%', rot: '-18deg', delay: '0.02s' },
  { dx: '92%', dy: '-44%', rot: '20deg', delay: '0s' },
  { dx: '84%', dy: '38%', rot: '-14deg', delay: '0.015s' },
  { dx: '28%', dy: '92%', rot: '17deg', delay: '0s' },
  { dx: '-32%', dy: '86%', rot: '-20deg', delay: '0.02s' },
  { dx: '-90%', dy: '34%', rot: '12deg', delay: '0.01s' },
]
</script>

<template>
  <section
    class="player-panel"
    :class="{ 'is-active': active, 'is-attacker': attacker, [`is-${expression}`]: true }"
    :style="themeVars"
    :data-player-panel="side"
    :data-expression="expression"
  >
    <!-- 血条 + 护盾（在立绘上方，与立绘等宽） -->
    <div class="vitals">
      <div class="hp-bar" :class="{ 'is-hit': shaking }">
        <div class="hp-bar__damage" :style="{ width: `${ghostRatio * 100}%` }" />
        <div class="hp-bar__fill" :style="{ width: `${ratio * 100}%` }" />
        <div v-if="shield > 0" class="hp-bar__shield" :style="{ width: `${shieldRatio * 100}%` }" />
        <!-- bugv14：临时护甲（精密计算），比护盾更靠内侧 -->
        <div
          v-if="tempArmor > 0"
          class="hp-bar__shield hp-bar__armor"
          :style="{ width: `${armorRatio * 100}%` }"
          :title="`临时护甲 ${tempArmor}`"
        />
        <div class="hp-ticks">
          <span v-for="tick in ticks" :key="tick" />
        </div>
      </div>
      <!-- bugv17 #8：免疫状态在血条旁直接标出来（双子星窗口 / 精密计算无敌） -->
      <div v-if="immune" class="immune-badge" title="免疫：这一击的伤害会被完全挡下">免疫</div>
    </div>

    <!-- 立绘（表情差分，bugv10 #6：放大到 3 倍） -->
    <div class="portrait">
      <img v-if="art" class="portrait__art" :src="art" :alt="player.name" draggable="false" />
      <div v-else class="portrait__fallback">{{ player.name.slice(0, 1) }}</div>
      <!-- bugv29 #4：拿到护盾时的镜面反光（2 秒扫光） -->
      <span v-if="glossVisible" :key="glossKey" class="portrait__gloss" aria-hidden="true" />
      <!-- bugv31：护盾 / 护甲被击碎时的「镜面破碎」（立绘裂成 8 片飞散） -->
      <span v-if="shatterVisible" :key="`shatter-${shatterKey}`" class="portrait__shatter" aria-hidden="true">
        <span
          v-for="(shard, index) in PORTRAIT_SHARDS"
          :key="index"
          class="portrait__shard"
          :class="`is-${index}`"
          :style="{
            backgroundImage: art ? `url(${art})` : undefined,
            '--dx': shard.dx,
            '--dy': shard.dy,
            '--rot': shard.rot,
            '--delay': shard.delay,
          }"
        />
        <span class="portrait__shatter-flash" />
      </span>
    </div>

    <!-- bugv28 #4：轮到这一方时的联机倒计时环（剩余时间由世界时间反推） -->
    <div
      v-if="timerVisible"
      class="round-timer"
      :class="{ 'is-urgent': timerUrgent }"
      :title="`剩余 ${timerSeconds} 秒`"
    >
      <svg class="round-timer__ring" viewBox="0 0 44 44" aria-hidden="true">
        <circle class="round-timer__track" cx="22" cy="22" r="19" />
        <circle class="round-timer__prog" cx="22" cy="22" r="19" :stroke-dasharray="timerDash" />
      </svg>
      <span class="round-timer__num">{{ timerSeconds }}</span>
    </div>

    <!-- bugv25 #2：增伤标识（小一哥 / 力大砖飞 / 毒鸡蛋），与"连续行动"并排 -->
    <!-- bugv26 #3：两个徽章**浮在立绘下沿**，不再作为网格行撑高面板 ——
         否则面板一变高就会顶到技能槽上（而且徽章随回合出现/消失会让技能槽来回跳）。 -->
    <div v-if="bonusActions > 0 || damageBonus > 0" class="player-status">
      <div v-if="bonusActions > 0" class="combo-badge">连续行动 ×{{ bonusActions + 1 }}</div>
      <div v-if="damageBonus > 0" class="power-badge" title="本回合的攻击伤害加成">
        伤害 +{{ damageBonus }}
      </div>
    </div>
    <div v-if="damageVisible" :key="damageKey" class="damage-float">-1</div>

    <!-- bugv10 #6：血量数字不再显示；保留在 DOM 里（视觉隐藏）供辅助技术读取 -->
    <span class="hp-value" :class="hpClass" aria-hidden="true">{{ hp }}</span>
  </section>
</template>
