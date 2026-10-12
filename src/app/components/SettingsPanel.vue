<script setup lang="ts">
/**
 * 设置面板（bugv6 #1 改版）。
 *
 * 旧版是一列到底的长表单，需要滚动才能看全；现在改成**左侧分栏 + 右侧内容**的
 * 现代设置面板：左边是分节标题（对局 / 棋力 / 外观 / 音频 / 联机 / 规则），
 * 右边只显示当前分节的内容，高度固定、不跳动。
 *
 * 背景音乐也从按钮列表改成**下拉框**（bugv6 #2）。
 */
import { computed, ref, watch } from 'vue'
import type { AiDifficulty } from '../../ai/baseline'
import { DEFAULT_MAGIC_CONFIG, DEFAULT_NIGHT_CONFIG, HP_LIMITS, type MagicConfig, type MagicSpawnPreference, type NightConfig, type PlayerIndex } from '../../core/types'
import type { SoundName } from '../../three/audio'
import CharacterPicker from './CharacterPicker.vue'
import type { CharacterId } from '../characters'
import type { CharacterDef, GameMode, PlayerMeta } from '../useConnectGame'

interface SoundTriggerOption {
  name: SoundName
  label: string
  styles: ReadonlyArray<{ id: string; label: string }>
}

const props = defineProps<{  open: boolean
  players: [PlayerMeta, PlayerMeta]
  mode: GameMode
  difficulty: AiDifficulty
  soundEnabled: boolean
  bgmTracks: ReadonlyArray<{ name: string; label: string }>
  bgmTrack: string
  /** 魔力植物配置（bugv8 #4）。 */
  magicConfig: MagicConfig
  /** 音效风格（bugv9 #10）。 */
  soundStyles: Record<string, string>
  soundTriggers: ReadonlyArray<SoundTriggerOption>
  /** 角色系统（bugv9 #13）。 */
  characters: ReadonlyArray<CharacterDef>
  characterValue: [CharacterId, CharacterId]
  /** 哪一方选了「随机角色」（bugv10 #8）。 */
  randomValue?: [boolean, boolean]
  /** 动画速度倍率（bugv28 #3）。 */
  animationSpeed: number
  /** 血量上限（bugv34）：8 / 12 / 16，仅非联机。 */
  hpLimit: number
  /** 黑夜设置（bugv34 补充）：进入 / 结束 / 强制结束条件 + 预告 + 开关，仅非联机。 */
  night: NightConfig
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'setMode', mode: GameMode): void
  (event: 'setDifficulty', difficulty: AiDifficulty): void
  (event: 'rename', player: PlayerIndex, name: string): void
  (event: 'setSound', enabled: boolean): void
  (event: 'setBgm', name: string): void
  (event: 'setSoundStyle', name: SoundName, styleId: string): void
  (event: 'resetSoundStyles'): void
  (event: 'pickCharacter', player: PlayerIndex, id: CharacterId | 'random'): void
  (event: 'setMagic', patch: Partial<MagicConfig>): void
  (event: 'resetMagic'): void
  /** bugv28 #3：动画速度。 */
  (event: 'setAnimationSpeed', speed: number): void
  /** bugv34：血量上限（8 / 12 / 16，仅非联机）。 */
  (event: 'setHpLimit', limit: number): void
  /** bugv34 补充：黑夜设置（仅非联机）。 */
  (event: 'setNight', patch: Partial<NightConfig>): void
  (event: 'resetNight'): void
}>()

const MODES: ReadonlyArray<{ value: GameMode; label: string; hint: string }> = [
  { value: 'pve', label: '人机', hint: '你执先手，AI 执后手' },
  { value: 'pvp', label: '双人', hint: '左右双方同屏对弈' },
  { value: 'eve', label: 'AI 对战', hint: '两个最强 AI 自动对弈（固定专家棋力）' },
  { value: 'online', label: '联机', hint: '进入联机大厅：在线匹配或匹配码开局' },
]

const LEVELS: ReadonlyArray<{ value: AiDifficulty; label: string; hint: string }> = [
  { value: 'easy', label: '轻松', hint: '思考 1 层 · 只看眼前' },
  { value: 'normal', label: '标准', hint: '思考 3 层 · 常规应对' },
  { value: 'hard', label: '进阶', hint: '思考 5 层 · 会做攻防权衡' },
  { value: 'expert', label: '专家', hint: '思考 7 层 · 单步最多 1.2 秒' },
]

type TabKey = 'match' | 'character' | 'ai' | 'magic' | 'night' | 'audio' | 'view' | 'online' | 'rules'

const TABS: ReadonlyArray<{ key: TabKey; label: string; caption: string }> = [
  { key: 'match', label: '对局', caption: '模式与规则入口' },
  { key: 'character', label: '角色', caption: '立绘 / 技能 / 昵称' },
  { key: 'ai', label: '棋力', caption: 'AI 难度' },
  { key: 'magic', label: '魔力植物', caption: '生长与伤害参数' },
  { key: 'night', label: '黑夜', caption: '入夜条件与天气' },
  { key: 'audio', label: '音频', caption: '音效与背景音乐' },
  { key: 'view', label: '表现', caption: '动画速度' },
  { key: 'online', label: '联机', caption: '昵称' },
  { key: 'rules', label: '规则', caption: '玩法说明' },
]

/** 动画速度可选项（bugv28 #3）。 */
const ANIMATION_SPEEDS: ReadonlyArray<{ value: number; label: string; hint: string }> = [
  { value: 1, label: '1×', hint: '标准' },
  { value: 1.5, label: '1.5×', hint: '稍快' },
  { value: 2, label: '2×', hint: '很快' },
]

/** 血量上限可选项（bugv34，仅非联机；联机固定 12）。 */
const HP_OPTIONS: ReadonlyArray<{ value: number; label: string; hint: string }> = HP_LIMITS.map((value) => ({
  value,
  label: String(value),
  hint: value === 12 ? '标准（默认）' : value === 8 ? '快节奏' : '耐久战',
}))

/** 魔力植物生成位置偏好（bugv34）。 */
const MAGIC_SPAWN_OPTIONS: ReadonlyArray<{ value: MagicSpawnPreference; label: string; hint: string }> = [
  { value: 'random', label: '随机位置', hint: '任意空位（默认）' },
  { value: 'nearStone', label: '优先在棋子附近', hint: '贴着已有棋子长' },
]

/** 魔力植物可调项（bugv8 #4）。 */
const MAGIC_FIELDS: ReadonlyArray<{
  key: 'cooldownTurns' | 'lineCooldownCut' | 'baseCount' | 'growthStep' | 'maxCount' | 'damagePerPlant'
  label: string
  hint: string
  min: number
  max: number
}> = [
  { key: 'cooldownTurns', label: '生长冷却（回合）', hint: '长出一次之后，再过这么多回合才会长下一批', min: 1, max: 40 },
  { key: 'lineCooldownCut', label: '连珠加速（回合）', hint: '任意一方形成连珠时，冷却立刻减少这么多回合', min: 0, max: 40 },
  { key: 'baseCount', label: '初始每次数量', hint: '第一批一次长出几棵', min: 1, max: 4 },
  { key: 'growthStep', label: '每几次 +1 棵', hint: '每长出这么多次，单次数量 +1', min: 1, max: 9 },
  { key: 'maxCount', label: '单次数量上限', hint: '一次最多长出几棵', min: 1, max: 8 },
  { key: 'damagePerPlant', label: '每棵加伤', hint: '连珠上每有一棵魔力植物，最终伤害 +N', min: 0, max: 5 },
]

function magicValue(key: (typeof MAGIC_FIELDS)[number]['key']): number {
  return props.magicConfig[key]
}

function patchMagic(key: (typeof MAGIC_FIELDS)[number]['key'], value: string): void {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return
  emit('setMagic', { [key]: parsed } as Partial<MagicConfig>)
}

/** 黑夜可调项（bugv34 补充）：进入条件 / 结束条件 / 强制结束条件。 */
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

const NIGHT_FIELDS: ReadonlyArray<{
  group: string
  key: NightNumberKey
  label: string
  hint: string
  min: number
  max: number
}> = [
  {
    group: '进入条件',
    key: 'minGap',
    label: '距上次黑夜间隔（回合）',
    hint: '距离上一次黑夜结束至少要过这么多回合，才可能再次入夜',
    min: 0,
    max: 200,
  },
  {
    group: '进入条件',
    key: 'startTurnThreshold',
    label: '开局回合阈值',
    hint: '游戏开始这么多回合之后（与下一项满足其一即可）',
    min: 0,
    max: 400,
  },
  {
    group: '进入条件',
    key: 'entryAttackThreshold',
    label: '攻击棋子阈值',
    hint: '双方发起过的攻击棋子总数超过它（与上一项满足其一即可）',
    min: 0,
    max: 200,
  },
  {
    group: '进入条件',
    key: 'entryPlantThreshold',
    label: '场上植物阈值',
    hint: '场上魔力植物（含被占有的与无主的）严格超过这个数',
    min: 0,
    max: 81,
  },
  {
    group: '结束条件',
    key: 'exitTurnsA',
    label: '持续回合（≥）',
    hint: '黑夜持续至少这么多回合，且同时满足下面那条，即天亮',
    min: 0,
    max: 400,
  },
  {
    group: '结束条件',
    key: 'exitAttacksA',
    label: '期间攻击棋子（≥）',
    hint: '黑夜持续期间双方攻击棋子增量至少这么多',
    min: 0,
    max: 400,
  },
  {
    group: '强制结束',
    key: 'exitTurnsB',
    label: '持续回合（>）',
    hint: '黑夜持续超过这么多回合 → 立刻天亮',
    min: 0,
    max: 400,
  },
  {
    group: '强制结束',
    key: 'exitAttacksB',
    label: '期间攻击棋子（>）',
    hint: '黑夜期间双方攻击棋子增量超过这么多 → 立刻天亮',
    min: 0,
    max: 400,
  },
  {
    group: '预告',
    key: 'warnTurns',
    label: '预告回合数',
    hint: '入夜前提前这么多回合提示"黑夜即将降临"',
    min: 0,
    max: 20,
  },
]

function nightValue(key: NightNumberKey): number {
  return props.night[key]
}

function patchNight(key: NightNumberKey, value: string): void {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return
  emit('setNight', { [key]: parsed } as Partial<NightConfig>)
}

/** 黑夜设置是否全为默认值。 */
const nightIsDefault = computed(() =>
  (Object.keys(DEFAULT_NIGHT_CONFIG) as Array<keyof NightConfig>).every(
    (key) => props.night[key] === DEFAULT_NIGHT_CONFIG[key],
  ),
)

/** 当前配置是不是默认值（联机固定用默认值）。 */
const magicIsDefault = computed(() =>
  (Object.keys(DEFAULT_MAGIC_CONFIG) as Array<keyof MagicConfig>).every(
    (key) => props.magicConfig[key] === DEFAULT_MAGIC_CONFIG[key],
  ),
)

const tab = ref<TabKey>('match')

// 打开时按当前模式落到合适的分节，减少一次点击
watch(
  () => props.open,
  (open) => {
    if (!open) return
    tab.value = props.mode === 'online' ? 'online' : 'match'
  },
)

/** 某一方当前的昵称（空 = 跟随角色名，bugv10 追加 #8）。 */
function nameOf(player: PlayerIndex): string {
  const character = props.characters.find((item) => item.id === props.characterValue[player])
  return props.players[player].name === character?.name ? '' : props.players[player].name
}

const modeHint = computed(() => MODES.find((item) => item.value === props.mode)?.hint ?? '')
const levelHint = computed(() => LEVELS.find((item) => item.value === props.difficulty)?.hint ?? '')
</script>

<template>
  <transition name="modal-fade">
    <div v-if="open" class="overlay" @click.self="emit('close')">
      <div class="settings-dialog">
        <header class="settings-dialog__head">
          <div>
            <div class="settings-dialog__eyebrow">SETTINGS</div>
            <h2 class="settings-dialog__title">设置</h2>
          </div>
          <button class="icon-btn" type="button" title="关闭" @click="emit('close')">✕</button>
        </header>

        <div class="settings-dialog__body">
          <!-- 左侧分节 -->
          <nav class="settings-nav">
            <button
              v-for="item in TABS"
              :key="item.key"
              type="button"
              class="settings-nav__item"
              :class="{ 'is-active': tab === item.key }"
              @click="tab = item.key"
            >
              <span class="settings-nav__label">{{ item.label }}</span>
              <span class="settings-nav__caption">{{ item.caption }}</span>
            </button>
          </nav>

          <!-- 右侧内容 -->
          <section class="settings-pane">
            <div v-if="tab === 'match'" class="settings-pane__section">
              <div class="settings-pane__head">
                <h3>对局模式</h3>
                <p>{{ modeHint }}</p>
              </div>
              <div class="choice-grid">
                <button
                  v-for="item in MODES"
                  :key="item.value"
                  type="button"
                  class="choice"
                  :class="{ 'is-active': mode === item.value }"
                  @click="emit('setMode', item.value)"
                >
                  <span class="choice__label">{{ item.label }}</span>
                  <span class="choice__hint">{{ item.hint }}</span>
                </button>
              </div>

              <!-- 对局偏好（bugv34）：仅非联机生效 -->
              <div class="settings-pane__head">
                <h3>对局偏好</h3>
                <p>仅作用于<b>非联机</b>对局；联机对局固定使用默认值。改动对<b>新开的一局</b>生效。</p>
              </div>
              <div class="settings-field">
                <div class="settings-field__label">血量上限</div>
                <div class="choice-grid">
                  <button
                    v-for="item in HP_OPTIONS"
                    :key="item.value"
                    type="button"
                    class="choice"
                    :class="{ 'is-active': hpLimit === item.value }"
                    @click="emit('setHpLimit', item.value)"
                  >
                    <span class="choice__label">{{ item.label }}</span>
                    <span class="choice__hint">{{ item.hint }}</span>
                  </button>
                </div>
                <div class="settings-note">
                  血量上限同时是回血上限与护盾上限；开局血量 = 该上限。
                </div>
              </div>
            </div>

            <div v-else-if="tab === 'character'" class="settings-pane__section">
              <div class="settings-pane__head">
                <h3>角色</h3>
                <p>
                  每个角色有自己的立绘、特征色与两个专属技能。<b>特征色跟随角色</b>，不再单独设置；
                  双方可以选择同一个角色。技能需要消耗场上被我方棋子占用的魔力植物，并且开局就处于冷却中。
                </p>
              </div>
              <CharacterPicker
                :characters="characters"
                :value="characterValue"
                :random="randomValue"
                compact
                @pick="(player, id) => emit('pickCharacter', player, id)"
              />

              <!-- 昵称（bugv10 追加 #8：外观分节删除，昵称并到这里；留空 = 跟随角色名） -->
              <div v-for="player in ([0, 1] as PlayerIndex[])" :key="`name-${player}`" class="settings-field">
                <div class="settings-field__label">
                  {{ player === 0 ? '先手方（左）' : '后手方（右）' }} · 昵称
                </div>
                <div class="field">
                  <input
                    :value="nameOf(player)"
                    maxlength="8"
                    :placeholder="`跟随角色名（${players[player].name}）`"
                    @input="emit('rename', player, ($event.target as HTMLInputElement).value)"
                  />
                </div>
              </div>

              <div v-for="character in characters" :key="character.id" class="settings-note">
                <b>{{ character.name }}</b>：{{ character.tagline }} ——
                <template v-for="(skill, index) in character.skills" :key="skill.id">
                  <template v-if="index > 0"> · </template>
                  {{ skill.name }}（消耗 {{ skill.cost }}，冷却 {{ skill.cooldown }} 回合）
                </template>
              </div>
              <div class="settings-note">
                联机对局<b>同样支持技能</b>（bugv10 #11）：请求发给服务端裁决，两端跑同一份引擎；
                联机时只能使用自己那一方的技能，并且要等轮到你。
              </div>
            </div>

            <div v-else-if="tab === 'ai'" class="settings-pane__section">
              <div class="settings-pane__head">
                <h3>AI 难度</h3>
                <p>{{ levelHint }}</p>
              </div>
              <div class="choice-grid">
                <button
                  v-for="item in LEVELS"
                  :key="item.value"
                  type="button"
                  class="choice"
                  :class="{ 'is-active': difficulty === item.value }"
                  @click="emit('setDifficulty', item.value)"
                >
                  <span class="choice__label">{{ item.label }}</span>
                  <span class="choice__hint">{{ item.hint }}</span>
                </button>
              </div>
              <div class="settings-note">AI 对战（观战）模式下双方固定使用专家棋力。</div>
            </div>

            <div v-else-if="tab === 'magic'" class="settings-pane__section">
              <div class="settings-pane__head">
                <h3>魔力植物</h3>
                <p>
                  连珠上每有一棵魔力植物，最终伤害 +1；防守方落在带植物的格子上可以把它抢过去。
                  参数写在本地配置里，<b>改动对下一局生效</b>；联机对局固定使用默认参数。
                </p>
              </div>

              <div class="settings-field">
                <div class="settings-field__label">开关</div>
                <div class="segmented">
                  <button
                    type="button"
                    :class="{ 'is-active': magicConfig.enabled }"
                    @click="emit('setMagic', { enabled: true })"
                  >
                    开启
                  </button>
                  <button
                    type="button"
                    :class="{ 'is-active': !magicConfig.enabled }"
                    @click="emit('setMagic', { enabled: false })"
                  >
                    关闭
                  </button>
                </div>
              </div>

              <div class="settings-field">
                <div class="settings-field__label">生长前置：必须先有连珠</div>
                <div class="segmented">
                  <button
                    type="button"
                    :class="{ 'is-active': magicConfig.requireLine }"
                    @click="emit('setMagic', { requireLine: true })"
                  >
                    需要
                  </button>
                  <button
                    type="button"
                    :class="{ 'is-active': !magicConfig.requireLine }"
                    @click="emit('setMagic', { requireLine: false })"
                  >
                    不需要
                  </button>
                </div>
              </div>

              <!-- 生成偏好（bugv34）：长在哪儿 -->
              <div class="settings-field">
                <div class="settings-field__label">生成偏好</div>
                <div class="segmented">
                  <button
                    v-for="item in MAGIC_SPAWN_OPTIONS"
                    :key="item.value"
                    type="button"
                    :class="{ 'is-active': magicConfig.spawnPreference === item.value }"
                    @click="emit('setMagic', { spawnPreference: item.value })"
                  >
                    {{ item.label }}
                  </button>
                </div>
                <div class="settings-note">
                  随机位置：任意空位；优先在棋子附近：贴着已有棋子长（更容易被双方争夺）。
                </div>
              </div>

              <div v-for="field in MAGIC_FIELDS" :key="field.key" class="settings-field magic-field">
                <div class="magic-field__text">
                  <div class="settings-field__label">{{ field.label }}</div>
                  <div class="settings-note">{{ field.hint }}</div>
                </div>
                <input
                  class="magic-field__input"
                  type="number"
                  :min="field.min"
                  :max="field.max"
                  :value="magicValue(field.key)"
                  @change="patchMagic(field.key, ($event.target as HTMLInputElement).value)"
                />
              </div>

              <div class="settings-field">
                <div class="segmented">
                  <button class="ghost-btn" type="button" :disabled="magicIsDefault" @click="emit('resetMagic')">
                    恢复默认
                  </button>
                </div>
                <div class="settings-note">
                  默认：冷却 {{ DEFAULT_MAGIC_CONFIG.cooldownTurns }} 回合 · 连珠加速
                  {{ DEFAULT_MAGIC_CONFIG.lineCooldownCut }} · 每次 {{ DEFAULT_MAGIC_CONFIG.baseCount }} 棵 ·
                  每 {{ DEFAULT_MAGIC_CONFIG.growthStep }} 次 +1 · 上限 {{ DEFAULT_MAGIC_CONFIG.maxCount }} 棵 ·
                  每棵 +{{ DEFAULT_MAGIC_CONFIG.damagePerPlant }}
                </div>
              </div>
            </div>

            <div v-else-if="tab === 'night'" class="settings-pane__section">
              <div class="settings-pane__head">
                <h3>黑夜</h3>
                <p>
                  入夜后场地变暗、棋盘线转深红，并随机降临一种天气。下面把黑夜的<b>完整规则</b>写出来：
                </p>
              </div>

              <div class="settings-field">
                <div class="settings-field__label">规则：进入条件（须全部满足）</div>
                <ul class="settings-rules">
                  <li>开局后<b>至少有一方连珠过</b>；</li>
                  <li>距上一次黑夜结束已过 <b>{{ night.minGap }}</b> 回合以上；</li>
                  <li>
                    <b>或</b>：游戏开始 <b>{{ night.startTurnThreshold }}</b> 回合后 ｜ 双方发起过的攻击棋子（连珠后飞出的总棋子数，<b>不是最终伤害</b>）合计 <b>超过 {{ night.entryAttackThreshold }}</b>；
                  </li>
                  <li>场上魔力植物（<b>含被棋子占有的与无主的</b>）<b>超过 {{ night.entryPlantThreshold }}</b> 株。</li>
                </ul>
                <div class="settings-note">
                  满足后先在回合标识上方显示预告「黑夜即将降临 · 剩余 {{ night.warnTurns }} 回合」
                  （{{ night.warnTurns }} 回合 = 双方各走一步；预告开始后<b>不会</b>因条件不再满足而中断）。
                </div>
              </div>

              <div class="settings-field">
                <div class="settings-field__label">规则：结束条件（满足其一即天亮）</div>
                <ul class="settings-rules">
                  <li>黑夜已持续 <b>≥ {{ night.exitTurnsA }}</b> 回合<b>且</b>期间双方攻击棋子增量 <b>≥ {{ night.exitAttacksA }}</b>；</li>
                  <li><b>或</b>直接退出：持续 <b>&gt; {{ night.exitTurnsB }}</b> 回合；</li>
                  <li><b>或</b>期间双方攻击棋子增量 <b>&gt; {{ night.exitAttacksB }}</b>；</li>
                  <li>
                    <b>或</b>场上<b>没有被棋子占有的魔力植物</b>（即所有植物都被棋子压着；场上至少存在植物时才算）。
                    <span class="settings-note-inline">「黑夜开局」的首个黑夜<b>不判这一条</b>，避免开局 0 棵植物立刻天亮。</span>
                  </li>
                </ul>
              </div>

              <div class="settings-field">
                <div class="settings-field__label">参数调节（仅非联机，改动对新开的一局生效）</div>

                <!--
                  bugv34m：原来「黑夜开/关」与「是否黑夜开局」挤在同一个 4 按钮分段控件里，
                  两件事混在一起看不出是两组独立设置。现在拆成两个独立的开关。
                -->
                <div class="settings-toggles">
                  <button
                    class="toggle-row"
                    type="button"
                    role="switch"
                    :aria-checked="night.enabled"
                    @click="emit('setNight', { enabled: !night.enabled })"
                  >
                    <span class="toggle-row__text">
                      <span class="toggle-row__title">黑夜</span>
                      <span class="toggle-row__hint">关闭后本局永远不会入夜</span>
                    </span>
                    <span class="toggle-switch" :class="{ 'is-on': night.enabled }">
                      <span class="toggle-switch__knob" />
                    </span>
                  </button>

                  <button
                    class="toggle-row"
                    type="button"
                    role="switch"
                    :aria-checked="night.startInNight"
                    @click="emit('setNight', { startInNight: !night.startInNight })"
                  >
                    <span class="toggle-row__text">
                      <span class="toggle-row__title">黑夜开局</span>
                      <span class="toggle-row__hint">开局直接进入黑夜（没有预告），随机天气立即生效</span>
                    </span>
                    <span class="toggle-switch" :class="{ 'is-on': night.startInNight }">
                      <span class="toggle-switch__knob" />
                    </span>
                  </button>
                </div>

                <div class="settings-note">
                  两个开关彼此独立：<b>「黑夜」关闭</b>时本局永远不会入夜（此时「黑夜开局」不生效）；
                  <b>「黑夜开局」</b>只决定开局那一刻是否已经是黑夜，不影响后续的自然入夜。
                </div>
              </div>

              <div v-for="group in ['进入条件', '结束条件', '强制结束', '预告']" :key="group" class="settings-field">
                <div class="settings-field__label">{{ group }}</div>
                <div class="magic-fields">
                  <label v-for="field in NIGHT_FIELDS.filter((f) => f.group === group)" :key="field.key" class="magic-field">
                    <span class="magic-field__label" :title="field.hint">{{ field.label }}</span>
                    <input
                      class="magic-field__input"
                      type="number"
                      :min="field.min"
                      :max="field.max"
                      :value="nightValue(field.key)"
                      @change="patchNight(field.key, ($event.target as HTMLInputElement).value)"
                    />
                  </label>
                </div>
              </div>

              <div class="settings-field">
                <div class="segmented">
                  <button class="ghost-btn" type="button" :disabled="nightIsDefault" @click="emit('resetNight')">
                    恢复默认
                  </button>
                </div>
                <div class="settings-note">
                  默认：间隔 {{ DEFAULT_NIGHT_CONFIG.minGap }} 回合 · 开局 {{ DEFAULT_NIGHT_CONFIG.startTurnThreshold }}
                  回合或攻击 {{ DEFAULT_NIGHT_CONFIG.entryAttackThreshold }} · 场上植物 &gt;
                  {{ DEFAULT_NIGHT_CONFIG.entryPlantThreshold }} · 结束 {{ DEFAULT_NIGHT_CONFIG.exitTurnsA }} 回合且攻击
                  {{ DEFAULT_NIGHT_CONFIG.exitAttacksA }} · 强制结束 {{ DEFAULT_NIGHT_CONFIG.exitTurnsB }} 回合 /
                  攻击 {{ DEFAULT_NIGHT_CONFIG.exitAttacksB }} · 预告 {{ DEFAULT_NIGHT_CONFIG.warnTurns }} 回合
                </div>
              </div>
            </div>

            <div v-else-if="tab === 'audio'" class="settings-pane__section">
              <div class="settings-pane__head">
                <h3>音频</h3>
                <p>音效为程序化合成：落子 · 连珠 · 对撞抵消 · 撞击血条。</p>
              </div>

              <div class="settings-field">
                <div class="settings-field__label">音效</div>
                <div class="segmented">
                  <button type="button" :class="{ 'is-active': soundEnabled }" @click="emit('setSound', true)">开启</button>
                  <button type="button" :class="{ 'is-active': !soundEnabled }" @click="emit('setSound', false)">关闭</button>
                </div>
              </div>

              <div class="settings-field">
                <div class="settings-field__label">背景音乐</div>
                <label class="select">
                  <select
                    class="select__input"
                    :value="bgmTrack"
                    @change="emit('setBgm', ($event.target as HTMLSelectElement).value)"
                  >
                    <option v-for="track in bgmTracks" :key="track.name" :value="track.name">
                      {{ track.label }}（{{ track.name }}.mp3）
                    </option>
                  </select>
                  <span class="select__arrow" aria-hidden="true" />
                </label>
                <div class="settings-note">
                  把 mp3 放进 <code>src/assets/bgm/</code> 会自动出现在这个下拉框里。
                </div>
              </div>

              <!-- 每个扳机单独选择音效（bugv9 #10） -->
              <div class="settings-field sound-styles">
                <div class="settings-field__head">
                  <div class="settings-field__label">音效风格</div>
                  <button class="link-btn" type="button" @click="emit('resetSoundStyles')">全部恢复默认</button>
                </div>
                <div class="settings-note">
                  每个扳机都可以单独挑一套程序化合成的音效，点击即试听（共
                  {{ soundTriggers.reduce((sum, item) => sum + item.styles.length, 0) }} 套）。
                </div>
                <div v-for="trigger in soundTriggers" :key="trigger.name" class="sound-style-row">
                  <div class="sound-style-row__label">{{ trigger.label }}</div>
                  <div class="sound-style-row__styles">
                    <button
                      v-for="style in trigger.styles"
                      :key="style.id"
                      type="button"
                      class="style-chip"
                      :class="{ 'is-active': (soundStyles[trigger.name] ?? '') === style.id }"
                      @click="emit('setSoundStyle', trigger.name, style.id)"
                    >
                      {{ style.label }}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div v-else-if="tab === 'view'" class="settings-pane__section">
              <div class="settings-pane__head">
                <h3>动画速度</h3>
                <p>调整对局中所有 3D 动画（落子 / 连珠 / 对撞 / 攻击结算）的播放倍率。即时生效并本地保存。</p>
              </div>
              <div class="choice-grid">
                <button
                  v-for="item in ANIMATION_SPEEDS"
                  :key="item.value"
                  type="button"
                  class="choice"
                  :class="{ 'is-active': animationSpeed === item.value }"
                  @click="emit('setAnimationSpeed', item.value)"
                >
                  <span class="choice__label">{{ item.label }}</span>
                  <span class="choice__hint">{{ item.hint }}</span>
                </button>
              </div>
              <div class="settings-note">
                2× 适合想快速推进对局的玩家；慢速（1×）能看清连珠与结算的细节。
              </div>
            </div>

            <div v-else-if="tab === 'online'" class="settings-pane__section">
              <div class="settings-pane__head">
                <h3>联机</h3>
                <p>
                  联机**需要登录**：进入<b>联机对战</b>时用<b>账号 + 密码</b>登录（没有账号就在同一面板注册，
                  注册时填的<b>昵称</b>会显示给对手）。登录状态保留在本机，直到你主动退出登录。
                </p>
              </div>

              <div class="settings-field">
                <div class="settings-field__label">说明</div>
                <div class="settings-note">
                  匹配 / 房间 / 服务器回放都在联机大厅里；同一浏览器开两个标签页会共用身份，
                  自测请用无痕窗口。同一账号在别处登录会顶掉先登录的那一边（提示「登录已失效」）。
                </div>
              </div>
            </div>

            <div v-else class="settings-pane__section">
              <div class="settings-pane__head">
                <h3>规则</h3>
                <p>9 × 9 交叉点落子，任意方向连续 ≥ 4 子成线。</p>
              </div>
              <div class="rules">
                <div><b>连珠</b>：横 / 竖 / 斜任意方向连续 ≥4 子。</div>
                <div><b>攻击值</b>：参与连珠的实体棋子（去重）数量。</div>
                <div><b>魔力植物</b>：连珠上每有一棵 +1 伤害；防守方落在该格可抢走（抢后攻击方 -1）。</div>
                <div><b>削弱</b>：防守方下在高光位，每属于 1 条连珠则 -1。</div>
                <div><b>抵消</b>：防守方成线则双方对撞，差值伤害由劣势方承担。</div>
                <div><b>先手</b>：攻击结算后由原攻击方继续落子。</div>
                <div><b>结束</b>：血量 ≤0 或棋盘下满（血多者胜）。</div>
                <div><kbd>H</kbd> 跳过动画 · <kbd>R</kbd> 重开一局 · <kbd>Esc</kbd> 呼出菜单</div>
              </div>
            </div>
          </section>
        </div>

        <footer class="settings-dialog__foot">
          <span class="settings-dialog__tip">设置即时生效并自动保存</span>
          <button class="primary-btn" type="button" @click="emit('close')">完成</button>
        </footer>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.3s var(--ease-out);
}

.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}
</style>
