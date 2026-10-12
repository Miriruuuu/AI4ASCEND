<script setup lang="ts">
import { computed } from 'vue'
import { weatherDef, type AttackSnapshot, type WeatherId } from '../../core/types'
import { UI_PHASE } from '../useConnectGame'
import type { PlayerMeta } from '../useConnectGame'

const props = defineProps<{
  attack: AttackSnapshot | null
  /** 面板是否展示（结算后仍会滞留一小段时间）。 */
  open: boolean
  players: [PlayerMeta, PlayerMeta]
  phase: string
  /** 防守方是否是人类玩家（决定提示文案）。 */
  humanDefense: boolean
  /** 当前天气（bugv34：只用来显示「瘟疫」这类会改写攻防数值的效果提示）。 */
  weather?: string | null
}>()

const hex = (value: number) => `#${value.toString(16).padStart(6, '0')}`

const attackerColor = computed(() =>
  props.attack ? hex(props.players[props.attack.attacker].palette.color) : '#1b1e26',
)

const defending = computed(() => props.phase === UI_PHASE.defense)

/** 魔力植物计数（bugv8 #4）。 */
const plants = computed(() => ({
  attacker: props.attack?.attackerPlants ?? 0,
  defender: props.attack?.defenderPlants ?? 0,
  stolen: props.attack?.stolenPlants ?? 0,
  // bugv19：「杀鲸霸拳」低消耗档 → 本回合植物不加伤（数值已经按 0 算，这里只做提示）
  attackerOff: props.attack?.attackerPlantBonusOff === true,
  defenderOff: props.attack?.defenderPlantBonusOff === true,
}))

/**
 * bugv25 #3：**攻击方的增伤明细**（>0 才列出）。
 *
 * 以前结算面板只显示"连珠总长 / 攻击棋子数 / 魔力植物 / 占位削弱 / 最终攻击值"，
 * 「小一哥」（glm 1 技能）、「力大砖飞」（claude 1 技能，原名「深度思考」）、
 * 「毒鸡蛋」（glm 2 技能）的加成是**隐式**加进最终攻击值的 —— 玩家看不懂为什么攻击值比棋子数大。
 */
const bonuses = computed(() => {
  const snapshot = props.attack
  if (!snapshot) return []
  const out: Array<{ key: string; label: string; hint: string; value: number }> = []
  const power = snapshot.powerBonus ?? 0
  const strike = snapshot.strikeBonus ?? 0
  const sabotage = snapshot.sabotageBonus ?? 0
  // bugv26 #3：两列布局下标签列很窄 ⇒ 去掉"增伤 ·"前缀（数值本身是琥珀色，含义已明确）
  if (power > 0) out.push({ key: 'power', label: '小一哥', hint: '增伤 · 小一哥', value: power })
  if (strike > 0) out.push({ key: 'strike', label: '力大砖飞', hint: '增伤 · 力大砖飞', value: strike })
  if (sabotage > 0) out.push({ key: 'sabotage', label: '毒鸡蛋', hint: '增伤 · 毒鸡蛋', value: sabotage })
  return out
})

/** 天气对本次结算的影响提示（bugv34：目前只有「瘟疫」会直接改写攻防数值）。 */
const weatherNote = computed(() =>
  props.weather === 'plague' ? '瘟疫 · 连珠上的魔力植物为双方各提供 1 颗攻击棋子' : null,
)

/**
 * bugv34d：**天气造成的增伤 / 减伤明细**。
 *
 * 引擎在快照里给了两边的"净影响"（实际值 − 无天气时的基线值），这里只负责显示。
 * 涵盖：雷暴（污染体 +2）、干涸（−1）、枯竭（植物不加伤）、暴雪（冻结不加伤）、瘟疫（分裂加成）。
 * 天气是"改写数值"的，玩家看不懂为什么最终攻击值对不上棋子数 —— 所以必须列出来。
 */
const weatherEffect = computed(() => {
  const snapshot = props.attack
  if (!snapshot) return null
  const atk = snapshot.weatherAttackDelta ?? 0
  const def = snapshot.weatherDefenderDelta ?? 0
  if (atk === 0 && def === 0) return null
  const name = snapshot.weather ? weatherDef(snapshot.weather as WeatherId).name : '天气'
  return { name, atk, def, hasAtk: atk !== 0, hasDef: def !== 0 }
})

const modeLabel = computed(() => {
  const snapshot = props.attack
  if (!snapshot || !snapshot.mode) return null
  switch (snapshot.mode) {
    case 'canceled':
      return `双方各 ${snapshot.defenderAttack} 颗对撞抵消 · 无伤害`
    case 'defenderDamaged':
      return `${props.players[snapshot.defender].name}受到 ${snapshot.diff} 点伤害`
    case 'attackerDamaged':
      return `${props.players[snapshot.attacker].name}受到 ${snapshot.diff} 点伤害`
    default:
      return null
  }
})
</script>

<template>
  <div v-if="open && attack" class="attack-card" :style="{ '--side-color': attackerColor }">
    <div class="attack-card__title">
      <span class="attack-card__dot" />
      攻击阶段
      <span>{{ defending ? '· 等待防守方落子' : '· 结算完成' }}</span>
    </div>

    <div class="attack-stats">
      <div class="stat">
        <span class="stat__label">连珠总长</span>
        <span class="stat__value is-dim">{{ attack.lineLengthSum }}</span>
      </div>
      <div class="stat">
        <span class="stat__label">攻击棋子数</span>
        <span class="stat__value">{{ attack.baseDamage }}</span>
      </div>
      <!-- 魔力植物（bugv8 #4）：连珠上每有一棵 +1。bugv17 #4 起这些植物会随棋子一起
           被破坏，所以数值在**宣告攻击时**就锁定了（不再出现"被抢走"的实时扣减）。 -->
      <div v-if="plants.attacker > 0" class="stat">
        <span class="stat__label">
          魔力植物
          <span v-if="plants.attackerOff" class="stat__tag">本回合不加伤</span>
        </span>
        <span class="stat__value" :class="{ 'is-magic': !plants.attackerOff, 'is-dim': plants.attackerOff }">
          +{{ plants.attackerOff ? 0 : plants.attacker }}
        </span>
      </div>
      <!-- bugv25 #3：增伤明细（小一哥 / 力大砖飞 / 毒鸡蛋） -->
      <div v-for="bonus in bonuses" :key="bonus.key" class="stat" :title="bonus.hint">
        <span class="stat__label is-bonus">{{ bonus.label }}</span>
        <span class="stat__value is-bonus">+{{ bonus.value }}</span>
      </div>
      <!-- bugv34d：天气对攻击方的增伤 / 减伤（雷暴 +2、干涸 −1、枯竭与暴雪不加伤、瘟疫分裂） -->
      <div
        v-if="weatherEffect && weatherEffect.hasAtk"
        class="stat"
        :title="`天气 · ${weatherEffect.name} 对攻击方最终攻击值的净影响`"
      >
        <span class="stat__label is-weather">{{ weatherEffect.name }}</span>
        <span class="stat__value" :class="weatherEffect.atk > 0 ? 'is-weather-up' : 'is-weather-down'">
          {{ weatherEffect.atk > 0 ? `+${weatherEffect.atk}` : weatherEffect.atk }}
        </span>
      </div>
      <div class="stat">
        <span class="stat__label">占位削弱</span>
        <span class="stat__value" :class="{ 'is-dim': attack.weakness === 0 }">
          {{ attack.weakness > 0 ? `-${attack.weakness}` : '0' }}
        </span>
      </div>
      <div class="stat">
        <span class="stat__label">最终攻击值</span>
        <span class="stat__value is-accent">{{ attack.finalAttack }}</span>
      </div>
      <div class="stat">
        <span class="stat__label">防守方攻击值</span>
        <span class="stat__value" :class="{ 'is-dim': attack.defenderAttack === 0 }">
          {{ attack.defenderAttack }}
        </span>
      </div>
      <div v-if="plants.defender > 0" class="stat">
        <span class="stat__label">
          防守方植物
          <span v-if="plants.defenderOff" class="stat__tag">本回合不加伤</span>
        </span>
        <span class="stat__value" :class="{ 'is-magic': !plants.defenderOff, 'is-dim': plants.defenderOff }">
          +{{ plants.defenderOff ? 0 : plants.defender }}
        </span>
      </div>
      <!-- bugv34d：天气对防守方反击值的增伤 / 减伤 -->
      <div
        v-if="weatherEffect && weatherEffect.hasDef"
        class="stat"
        :title="`天气 · ${weatherEffect.name} 对防守方反击值的净影响`"
      >
        <span class="stat__label is-weather">{{ weatherEffect.name }}·守</span>
        <span class="stat__value" :class="weatherEffect.def > 0 ? 'is-weather-up' : 'is-weather-down'">
          {{ weatherEffect.def > 0 ? `+${weatherEffect.def}` : weatherEffect.def }}
        </span>
      </div>
      <div v-if="!defending && attack.diff > 0" class="stat">
        <span class="stat__label">差值伤害</span>
        <span class="stat__value is-accent">-{{ attack.diff }}</span>
      </div>
    </div>

    <div class="attack-card__hint">
      <template v-if="defending">
        <template v-if="humanDefense">
          高光位落子：每属于 1 条连珠，攻击方 -1；抢对手植物每棵 +1；自成线则进入对撞抵消。
        </template>
        <template v-else>对方正在选择抵消位置…</template>
      </template>
      <template v-else-if="modeLabel">{{ modeLabel }}</template>
    </div>

    <div v-if="weatherNote" class="attack-card__weather">{{ weatherNote }}</div>
  </div>
</template>
