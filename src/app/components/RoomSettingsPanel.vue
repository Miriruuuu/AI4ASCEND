<script setup lang="ts">
/**
 * 房间设置（bugv34e，**仅房主**）。
 *
 * 三块（与需求一一对应）：
 * 1. **对局偏好** —— 目前只有血量上限（8 / 12 / 16）；
 * 2. **魔力植物** —— 开关与全部数值；
 * 3. **黑夜** —— 开关、预告、进入 / 结束 / 强制结束条件。
 *
 * 与单机「设置」里的同名分节口径一致，但这里改的是**这一间房**的设置，
 * 开局时下发给两端（服务端裁决用的就是它）。
 */
import { computed } from 'vue'
import {
  DEFAULT_MAGIC_CONFIG,
  DEFAULT_NIGHT_CONFIG,
  HP_LIMITS,
  type MagicConfig,
  type NightConfig,
} from '../../core/types'
import type { OnlineRoomSettings, OnlineRoomSettingsPatch } from '../online'

/** 黑夜可调项（与「设置 → 黑夜」同口径）。 */
type NightNumberKey =
  | 'warnTurns'
  | 'minGap'
  | 'startTurnThreshold'
  | 'entryAttackThreshold'
  | 'entryPlantThreshold'
  | 'exitTurnsA'
  | 'exitAttacksA'
  | 'exitTurnsB'
  | 'exitAttacksB'

const props = defineProps<{
  open: boolean
  settings: OnlineRoomSettings
  /** 房主才能改（非房主打开时只读）。 */
  editable: boolean
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'patch', patch: OnlineRoomSettingsPatch): void
  (event: 'reset'): void
}>()

const magic = computed(() => props.settings.magic as unknown as MagicConfig)
const night = computed(() => props.settings.night as unknown as NightConfig)

const MAGIC_FIELDS: ReadonlyArray<{ key: keyof MagicConfig; label: string; min: number; max: number }> = [
  { key: 'cooldownTurns', label: '生长冷却（回合）', min: 1, max: 99 },
  { key: 'lineCooldownCut', label: '连珠加速（回合）', min: 0, max: 99 },
  { key: 'baseCount', label: '每次长出（棵）', min: 1, max: 8 },
  { key: 'growthStep', label: '每几次 +1 棵', min: 1, max: 99 },
  { key: 'maxCount', label: '单次上限（棵）', min: 1, max: 8 },
  { key: 'damagePerPlant', label: '每棵加伤', min: 0, max: 5 },
]

const NIGHT_FIELDS: ReadonlyArray<{ group: string; key: NightNumberKey; label: string }> = [
  { group: '进入条件', key: 'minGap', label: '距上次黑夜间隔' },
  { group: '进入条件', key: 'startTurnThreshold', label: '开局回合阈值' },
  { group: '进入条件', key: 'entryAttackThreshold', label: '攻击棋子阈值' },
  { group: '进入条件', key: 'entryPlantThreshold', label: '场上植物阈值' },
  { group: '结束条件', key: 'exitTurnsA', label: '持续回合（≥）' },
  { group: '结束条件', key: 'exitAttacksA', label: '期间攻击棋子（≥）' },
  { group: '强制结束', key: 'exitTurnsB', label: '持续回合（>）' },
  { group: '强制结束', key: 'exitAttacksB', label: '期间攻击棋子（>）' },
  { group: '预告', key: 'warnTurns', label: '预告回合数' },
]

function patchMagic(key: keyof MagicConfig, raw: string): void {
  const value = Number(raw)
  if (!Number.isFinite(value)) return
  emit('patch', { magic: { [key]: value } as Record<string, unknown> })
}

function patchNight(key: NightNumberKey, raw: string): void {
  const value = Number(raw)
  if (!Number.isFinite(value)) return
  emit('patch', { night: { [key]: value } as Record<string, unknown> })
}

/** 当前设置是否已经是默认值（决定"恢复默认"按钮是否可点）。 */
const isDefault = computed(
  () =>
    props.settings.hpLimit === 12 &&
    MAGIC_FIELDS.every((field) => magic.value[field.key] === DEFAULT_MAGIC_CONFIG[field.key]) &&
    NIGHT_FIELDS.every((field) => night.value[field.key] === DEFAULT_NIGHT_CONFIG[field.key]) &&
    magic.value.enabled === DEFAULT_MAGIC_CONFIG.enabled &&
    night.value.enabled === DEFAULT_NIGHT_CONFIG.enabled,
)

function reset(): void {
  emit('patch', {
    hpLimit: 12,
    magic: { ...DEFAULT_MAGIC_CONFIG } as unknown as Record<string, unknown>,
    night: { ...DEFAULT_NIGHT_CONFIG } as unknown as Record<string, unknown>,
  })
}
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div class="room-settings">
      <header class="room-settings__head">
        <h2>房间设置</h2>
        <p>
          {{ editable ? '只有房主可以修改；改完立刻同步给房间里的所有人。' : '只有房主可以修改（当前为只读）。' }}
        </p>
        <button class="icon-btn" type="button" @click="emit('close')">✕</button>
      </header>

      <div class="room-settings__body">
        <section class="room-settings__section">
          <h3>对局偏好</h3>
          <div class="room-settings__row">
            <span class="room-settings__label">血量上限</span>
            <div class="segmented">
              <button
                v-for="limit in HP_LIMITS"
                :key="limit"
                type="button"
                :disabled="!editable"
                :class="{ 'is-active': settings.hpLimit === limit }"
                @click="emit('patch', { hpLimit: limit })"
              >
                {{ limit }}
              </button>
            </div>
            <span class="settings-note">同时是回血上限与护盾上限；开局血量 = 该上限。</span>
          </div>
        </section>

        <section class="room-settings__section">
          <h3>魔力植物</h3>
          <div class="room-settings__row">
            <span class="room-settings__label">生成魔力植物</span>
            <div class="segmented">
              <button
                type="button"
                :disabled="!editable"
                :class="{ 'is-active': magic.enabled }"
                @click="emit('patch', { magic: { enabled: true } })"
              >
                开启
              </button>
              <button
                type="button"
                :disabled="!editable"
                :class="{ 'is-active': !magic.enabled }"
                @click="emit('patch', { magic: { enabled: false } })"
              >
                关闭
              </button>
            </div>
          </div>
          <div class="room-settings__grid">
            <label v-for="field in MAGIC_FIELDS" :key="field.key" class="room-settings__field">
              <span>{{ field.label }}</span>
              <input
                type="number"
                :min="field.min"
                :max="field.max"
                :disabled="!editable"
                :value="magic[field.key]"
                @change="patchMagic(field.key, ($event.target as HTMLInputElement).value)"
              />
            </label>
          </div>
        </section>

        <section class="room-settings__section">
          <h3>黑夜</h3>
          <div class="room-settings__row">
            <span class="room-settings__label">黑夜机制</span>
            <div class="segmented">
              <button
                type="button"
                :disabled="!editable"
                :class="{ 'is-active': night.enabled }"
                @click="emit('patch', { night: { enabled: true } })"
              >
                开启
              </button>
              <button
                type="button"
                :disabled="!editable"
                :class="{ 'is-active': !night.enabled }"
                @click="emit('patch', { night: { enabled: false } })"
              >
                关闭
              </button>
            </div>
            <span class="settings-note">联机固定不开「黑夜开局」（它只作用于单机）。</span>
          </div>
          <div v-for="group in ['进入条件', '结束条件', '强制结束', '预告']" :key="group" class="room-settings__group">
            <div class="room-settings__group-title">{{ group }}</div>
            <div class="room-settings__grid">
              <label v-for="field in NIGHT_FIELDS.filter((f) => f.group === group)" :key="field.key" class="room-settings__field">
                <span>{{ field.label }}</span>
                <input
                  type="number"
                  min="0"
                  max="400"
                  :disabled="!editable"
                  :value="night[field.key]"
                  @change="patchNight(field.key, ($event.target as HTMLInputElement).value)"
                />
              </label>
            </div>
          </div>
        </section>
      </div>

      <footer class="room-settings__foot">
        <button class="ghost-btn" type="button" :disabled="!editable || isDefault" @click="reset">恢复默认</button>
        <button class="primary-btn" type="button" @click="emit('close')">完成</button>
      </footer>
    </div>
  </div>
</template>
