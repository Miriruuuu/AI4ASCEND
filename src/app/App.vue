<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Vector3 } from 'three'
import AttackPanel from './components/AttackPanel.vue'
import AuthPanel from './components/AuthPanel.vue'
import DiceOverlay from './components/DiceOverlay.vue'
import GameBoard from './components/GameBoard.vue'
import GameMenu from './components/GameMenu.vue'
import GameRulesModal from './components/GameRulesModal.vue'
import MiniPlayer from './components/MiniPlayer.vue'
import NoticeModal from './components/NoticeModal.vue'
import OnlineLobby from './components/OnlineLobby.vue'
import PlayerPanel from './components/PlayerPanel.vue'
import PromiseModal from './components/PromiseModal.vue'
import ReplayPanel from './components/ReplayPanel.vue'
import ResultModal from './components/ResultModal.vue'
import RoomChat from './components/RoomChat.vue'
import RoomSettingsPanel from './components/RoomSettingsPanel.vue'
import RoomView from './components/RoomView.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import SkillBar from './components/SkillBar.vue'
import SkillDrawer from './components/SkillDrawer.vue'
import StartMenu from './components/StartMenu.vue'
import { UI_PHASE, useConnectGame } from './useConnectGame'
import { CHARACTERS } from './characters'
// bugv17 #3：血条格数 / 护盾条比例都必须跟着**本局血量上限**走。
// 以前这里（含 ResultModal）写死了 6，改血量上限后立绘上的血条还是 6 格。
// bugv34：改用 `game.matchHpCap`（非联机跟随设置 8/12/16，联机固定 12）。
import type { PlayerIndex } from '../core/types'
import { weatherDef } from '../core/types'

const game = useConnectGame()
const { ui, players, statusText, isAiTurn, isMyOnlineTurn, bgmTracks, history, replay, online, humanDefense, magicConfig, bgmState, bgmCurrent, onlineCountdown, matchHpCap } =
  game

/** 可选角色列表（bugv9 #13）。 */
const characterList = CHARACTERS

// --- bugv34 黑夜与天气 ------------------------------------------------------
const weatherDetailOpen = ref(false)
/** 黑夜预告文案（回合标识上方）。 */
const nightWarning = computed(() =>
  ui.nightPhase === 'pending' && ui.nightCountdown > 0
    ? `黑夜即将降临 · 剩余 ${ui.nightCountdown} 回合`
    : '',
)
const weatherInfo = computed(() => (ui.weather ? weatherDef(ui.weather) : null))

// --- bugv34e 联机房间（大厅） ------------------------------------------------
/** 房间设置弹层是否打开（只有房主能改）。 */
const roomSettingsOpen = ref(false)
/** 我是不是这间房的房主。 */
const isRoomHost = computed(
  () => online.room?.members.find((member) => member.playerId === online.room?.you)?.host === true,
)
/** 房间聊天栏是否展开。 */
const roomChatOpen = computed(() => online.chatOpen)
/** 自己在不在对局中（对局中聊天栏默认收起、只留标签与未读角标）。 */
const roomPlaying = computed(() => online.room?.phase === 'playing')

/** 回车快速打开聊天（bugv34e）；已在输入框里时交给输入框自己处理。 */
function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey) return
  if (!online.room) return
  const target = event.target as HTMLElement | null
  const tag = target?.tagName?.toLowerCase()
  // 输入框 / 文本域 / 按钮上的回车保持原语义（发送、提交、点击）
  if (tag === 'input' || tag === 'textarea' || tag === 'button' || target?.isContentEditable) return
  event.preventDefault()
  game.toggleRoomChat(true)
}
// 天气结束（天亮）时自动收起详情
watch(
  () => ui.weather,
  (w) => {
    if (!w) weatherDetailOpen.value = false
  },
)

// 暴露给自动化冒烟测试 / 浏览器控制台调试
Object.assign(window, { __CONNECT4__: game, __THREE_VECTOR3__: Vector3, __UI_PHASE__: UI_PHASE })

const sceneReady = ref(false)
/**
 * 游玩须知（bugv28 #1）。
 *
 * 每次进入游戏（页面初始化）弹一次；点「不再弹出」后写 localStorage，之后不再弹。
 */
const PROMISE_KEY = 'connect4.promiseDismissed.v1'
const promiseOpen = ref(false)

function promiseDismissed(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(PROMISE_KEY) === '1'
  } catch {
    return false
  }
}

/** 本次不再弹（仅关闭）。 */
function closePromise(): void {
  promiseOpen.value = false
}

/** 「不再弹出」：记住并关闭。 */
function neverShowPromise(): void {
  try {
    localStorage?.setItem(PROMISE_KEY, '1')
  } catch {
    /* 存不下就算了，本次先关掉 */
  }
  promiseOpen.value = false
}

/** 游戏规则弹窗（bugv30 #5）：只由开始菜单的「游戏规则」按钮打开。 */
const rulesOpen = ref(false)
/** 根容器：拖尾 canvas 挂在它内部，从而受页面层叠上下文管理（bugv6 #3）。 */
const root = ref<HTMLElement | null>(null)

/** 悬浮在攻击棋子旁边的总攻击数（位置由 3D 层每帧写入，bugv3 #6）。 */
const tally0 = ref<HTMLElement | null>(null)
const tally1 = ref<HTMLElement | null>(null)

/** 菜单开关：ESC 或右下角按钮呼出。 */
const menuOpen = computed({
  get: () => ui.showSettings || ui.showGameMenu,
  set: (value: boolean) => {
    ui.showSettings = value
    ui.showGameMenu = value
  },
})

/** 右下角微型播放器是否展开（bugv9 #7）。 */
const playerOpen = ref(false)

/**
 * bugv25 #5：是否走**手机竖屏**那套布局。
 *
 * 只影响"技能入口 + 结算面板摆放"这两处，桌面端一律走原样（`isMobile === false`）。
 * 阈值与 `styles.css` 里手机布局的媒体查询保持一致（`--mobile-layout`，见下方常量）。
 */
const MOBILE_QUERY = '(max-width: 720px)'
const isMobile = ref(false)
let mobileMedia: MediaQueryList | null = null
const syncMobile = (event?: MediaQueryListEvent): void => {
  isMobile.value = event ? event.matches : (mobileMedia?.matches ?? false)
}

/** 手机端技能抽屉里展示的是哪个技能（null = 关闭）。 */
const drawerSkill = ref<{ player: PlayerIndex; slot: number } | null>(null)
const drawerData = computed(() => {
  const target = drawerSkill.value
  if (!target) return null
  return ui.skills[target.player]?.[target.slot] ?? null
})

/** 点立绘下方的小按钮：打开抽屉。 */
function openSkillDrawer(player: PlayerIndex, slot: number): void {
  drawerSkill.value = { player, slot }
}

/** 抽屉里的「使用技能」：关闭抽屉并进入挑选魔力植物环节。 */
function useDrawerSkill(): void {
  const target = drawerSkill.value
  if (!target) return
  drawerSkill.value = null
  game.toggleSkill(target.player, target.slot)
}

async function handleReady(canvas: HTMLCanvasElement, container: HTMLElement): Promise<void> {
  await game.initScene(canvas, container)
  sceneReady.value = game.scene.value !== null
  game.scene.value?.setTallyElements({ 0: tally0.value ?? undefined, 1: tally1.value ?? undefined })
  game.refreshHudRects()
  if (game.scene.value) game.scene.value.resize()
}

function handlePointer(clientX: number, clientY: number): void {
  game.scene.value?.handlePointerMove(clientX, clientY)
}

function handlePicker(clientX: number, clientY: number): void {
  // 首次点击顺带解锁音频（浏览器自动播放策略）
  game.unlockAudio()
  game.scene.value?.handleClick(clientX, clientY)
}

function handleLeave(): void {
  game.scene.value?.handlePointerLeave()
  ui.hoverCell = null
}

/** bugv26 #2：双指手势开始 —— 记录当前倍率当基准。 */
function handlePinchStart(): void {
  game.scene.value?.beginPinch()
}

/** bugv26 #2：双指缩放（scale = 两指间距 / 手势起点间距）。 */
function handlePinch(scale: number): void {
  game.unlockAudio()
  game.scene.value?.pinchUpdate(scale)
}

function handleResize(): void {
  game.scene.value?.resize()
  game.refreshHudRects()
}

function hex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`
}

const statusSideColor = computed(() => hex(game.currentSideColor.value))

/**
 * 联机倒计时（bugv28 #4）。
 *
 * 剩余时间来自 `online.remainingMs`（由"回合结束的世界时间"反推），
 * 这里只做展示：状态条上一个总览 + 正在计时那一方的立绘环。
 */
const countdownActive = computed(() => onlineCountdown.value.active)
const countdownSeconds = computed(() => onlineCountdown.value.seconds)
const countdownUrgent = computed(() => onlineCountdown.value.urgent)
const countdownKindLabel = computed(() => (onlineCountdown.value.kind === 'defense' ? '防守' : '落子'))

/** 某一方立绘旁的倒计时（不是他的回合就返回 null）。 */
function playerTimer(side: PlayerIndex): { left: number | null; total: number } {
  const info = onlineCountdown.value
  if (!info.active || info.side !== side) return { left: null, total: 0 }
  return { left: online.remainingMs, total: online.deadlineTotal }
}

/**
 * bugv29 #4：全屏演出的样式。
 *
 * - 速度线（deepseek「杀鲸霸拳」）：用落子方的特征色，从下往上扫。
 *   （火球「恶龙吐息」的全屏火红演出见 `styles.css` 的 `.screen-fx--fire`。）
 */
const SPEED_LINES = Array.from({ length: 30 }, (_, index) => ({
  left: `${((index + 0.5) * 100) / 30}%`,
  delay: `${((index % 7) * -0.07).toFixed(2)}s`,
  duration: `${(0.4 + (index % 4) * 0.06).toFixed(2)}s`,
}))

const speedLineStyle = computed<Record<string, string>>(() => {
  const fx = ui.speedLine
  const color = fx ? hex(players[fx.player].palette.glow) : '#8fb3ff'
  return { '--fx-color': color }
})

/**
 * 总攻击数数字的样式（bugv3 #6）：数字越大字号越大、辉光越强。
 */
function tallyStyle(side: 0 | 1): Record<string, string> {
  const value = ui.tally[side]
  const scale = Math.min(2.05, 0.88 + value * 0.1)
  return {
    '--side-color': hex(players[side].palette.color),
    '--side-glow': hex(players[side].palette.glow),
    '--tally-scale': scale.toFixed(2),
    '--tally-weight': Math.min(1, value / 8).toFixed(2),
  }
}

/** 两边的标注：正在进攻的那一侧是“总攻击”，另一侧是“反击”。 */
const tallyLabels = computed<[string, string]>(() => {
  const attacker = ui.attacker
  if (attacker === null) return ['总攻击', '总攻击']
  return [attacker === 0 ? '总攻击' : '反击', attacker === 1 ? '总攻击' : '反击']
})

/**
 * bugv25 #2：立绘旁的**增伤总额**（三种来源相加，>0 才显示徽章）。
 *
 * - `ui.power`：glm「小一哥」的持续增伤（可跨回合）；
 * - `ui.strikeBonus`：claude「力大砖飞」的首个连珠额外伤害；
 * - `ui.sabotageBonus`：glm「毒鸡蛋」本回合 +1（只在这一回合有效）。
 */
const damageBonus = computed<[number, number]>(() => [
  Math.max(0, (ui.power?.[0] ?? 0) + (ui.strikeBonus?.[0] ?? 0) + (ui.sabotageBonus?.[0] ?? 0)),
  Math.max(0, (ui.power?.[1] ?? 0) + (ui.strikeBonus?.[1] ?? 0) + (ui.sabotageBonus?.[1] ?? 0)),
])

/** 攻击阶段整体压暗（规则 4.1.6）：由 3D 场景回调驱动，防守方落子后才变暗。 */
const isDimmed = computed(() => ui.dark || ui.skillSelect !== null)

/**
 * 黑夜中（bugv34 补充）。
 *
 * 场地变暗由页面级压暗层（`.app-root.is-night::after`）完成 —— 它在画布**之下**，
 * 因此只压暗页面背景与"场地"，棋盘上的棋子显示效果完全不变。
 */
const isNight = computed(() => ui.nightPhase === 'active')

/**
 * bugv19：挑选魔力植物时的确认按钮状态。
 *
 * 可变消耗技能（「杀鲸霸拳」2~3 棵 / 「最不绕弯子」1~4 棵）在**下限**时就允许释放，
 * 所以必须在棋盘下方给一个明确的确认按钮 —— 选满上限自动释放只是便捷路径。
 */
const plantSelect = computed(() => {
  const select = ui.skillSelect
  if (!select || select.stage !== 'plants') return null
  const picked = select.picked.length
  const skill = ui.skills[select.player]?.[select.slot]
  // 可变消耗技能的两个注释（bugv19）：把"多选/少选"的差别写在按钮旁边
  const penalty = skill?.minCostPenalty === 'noPlantBonus'
  return {
    picked,
    need: select.need,
    max: select.max,
    name: skill?.name ?? '',
    /** 可变消耗技能（有下限~上限区间）。 */
    variable: select.max > select.need,
    /** 已经选够下限，可以确认了。 */
    ready: picked >= select.need,
    /** 按下限释放会失去本回合植物加伤（bugv19「杀鲸霸拳」）。 */
    penalty,
    note:
      skill?.effectKind === 'assault'
        ? `攻击值 = 消耗的植物数量（自选 ${select.need}~${select.max} 棵）`
        : penalty
          ? `选 ${select.need} 棵会失去本回合的植物加伤`
          : // bugv32：gtp「恶龙吐息」的两个档位差别是"要不要直击碎子"（bugv33 碎子档 3→2 费）
            skill?.effect === 'fireball'
            ? picked >= select.max
              ? `${select.max} 费：直击碎子 + 燃火`
              : `${select.need} 费：只燃火、不碎子`
            : '',
  }
})

const interactive = computed(
  () =>
    ui.screen === 'playing' &&
    !ui.busy &&
    !ui.diceVisible &&
    !ui.result &&
    !isAiTurn.value &&
    // 联机对局只有轮到自己时才允许点击
    (ui.mode !== 'online' || isMyOnlineTurn.value) &&
    sceneReady.value,
)

const resultText = computed(() => {
  if (!ui.result) return '对局进行中'
  if (ui.result.winner === null) return '平局'
  return `${players[ui.result.winner].name}胜利 · ${ui.result.hp[0]}:${ui.result.hp[1]}`
})

const inGame = computed(() => ui.screen === 'playing' || ui.screen === 'setup')
/**
 * 回放时也要显示顶部立绘 / 血条与攻击结算面板（bugv9 #9）：
 * 需求要求"回放需与实际游戏一样"，之前回放界面把整个 HUD 都藏起来了，所以看不到血条。
 */
const hudVisible = computed(() => inGame.value || ui.screen === 'replay')

async function openMenu(): Promise<void> {
  ui.showGameMenu = true
  // 打开菜单时暂停一切输入
  game.scene.value?.setInteractive(false)
}

function closeMenu(): void {
  ui.showGameMenu = false
  ui.showSettings = false
  game.scene.value?.setInteractive(ui.screen === 'playing' && !ui.busy && !ui.result)
}

function openSettings(): void {
  ui.showGameMenu = false
  ui.showSettings = true
}

async function startGame(): Promise<void> {
  if (ui.mode === 'online') {
    game.openOnlineLobby()
    return
  }
  await game.startMatch()
}

async function restart(): Promise<void> {
  ui.showResult = false
  closeMenu()
  await game.restart()
}

/** 结算面板里的「回放本局」。 */
function replayThisMatch(): void {
  ui.showResult = false
  game.resetExpressions()
  game.openReplay(history[0])
}

/** 结算面板里的「返回主菜单」（bugv10 #10）。 */
function backToMenuFromResult(): void {
  ui.showResult = false
  closeMenu()
  game.backToMenu()
}

/** 一次性提示（bugv8 #3）：确认后按类型决定去处。 */
function onNoticeConfirm(): void {
  const wasOnline = online.status === 'ended' || online.status === 'error'
  game.dismissNotice()
  if (wasOnline && ui.mode === 'online') {
    ui.showResult = false
    game.openOnlineLobby()
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.target instanceof HTMLInputElement) return
  game.unlockAudio()
  const key = event.key.toLowerCase()

  if (key === 'escape') {
    if (ui.showSettings) {
      ui.showSettings = false
      ui.showGameMenu = inGame.value
      return
    }
    if (ui.showResult) {
      game.closeResult()
      return
    }
    if (inGame.value) {
      if (ui.showGameMenu) closeMenu()
      else void openMenu()
    }
    return
  }

  if (ui.showSettings || ui.showGameMenu) return

  if (key === 'h') {
    game.skipAnimations()
    game.hideDice()
  } else if (key === 'r') {
    if (inGame.value) void restart()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  // bugv34e：回车快速打开房间聊天
  window.addEventListener('keydown', onGlobalKeydown)
  // bugv11 #3：技能详情气泡点"外面"也要能关掉
  window.addEventListener('mousedown', onPointerDownOutside, true)
  // bugv28 #1：每次进入游戏弹一次游玩须知（除非点了"不再弹出"）
  if (!promiseDismissed()) promiseOpen.value = true
  // bugv25 #5：手机竖屏走另一套技能入口（立绘下方小按钮 + 底部抽屉）
  mobileMedia = window.matchMedia(MOBILE_QUERY)
  syncMobile()
  mobileMedia.addEventListener('change', syncMobile)
  // 鼠标拖尾（bugv6 #3）：第三方库，只在精确指针设备上启用
  game.startTrail(root.value ?? undefined)
})

/**
 * bugv26 #3：技能槽的 `top` 与结算面板的 `max-height` 都依赖**实测**的 HUD / 技能槽几何。
 *
 * 立绘旁的状态徽章（连续行动 / 伤害 +N）显示或消失会改变 HUD 的占位，
 * 所以这里在它变化后重新量一次；顺带覆盖"角色切换导致名字换行"这类情况。
 */
watch(
  () => [...ui.bonusActions, ...damageBonus.value, ...ui.shield, ...ui.tempArmor].join(','),
  () => {
    void nextTick(() => game.refreshHudRects())
  },
)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('keydown', onGlobalKeydown)
  window.removeEventListener('mousedown', onPointerDownOutside, true)
  mobileMedia?.removeEventListener('change', syncMobile)
  game.dispose()
})

/**
 * 点击技能气泡以外的地方就收起气泡（bugv11 #3）。
 *
 * 用捕获阶段监听 `mousedown`：这样无论是点棋盘（画布）、点设置面板还是点空白处
 * 都能收起来；技能槽与气泡自身除外，否则"点开就立刻被自己关掉"。
 */
function onPointerDownOutside(event: MouseEvent): void {
  if (!ui.skillBubble) return
  const target = event.target
  if (target instanceof HTMLElement && target.closest('.skill-slot')) return
  if (target instanceof HTMLElement && target.closest('.skill-bubble')) return
  game.closeSkillBubble()
}

async function setMode(mode: typeof ui.mode): Promise<void> {
  await game.setMode(mode)
}

async function openReplay(): Promise<void> {
  game.openReplay()
}

/** 打开服务器回放：先拉取，再展示面板。 */
async function openOnlineReplays(): Promise<void> {
  await game.refreshOnlineReplays()
  const first = online.replays[0]
  if (first) game.openReplay(first, 'online')
}

async function refreshOnlineReplays(): Promise<void> {
  await game.refreshOnlineReplays()
}

async function startReplay(): Promise<void> {
  // 联机对局不能本地重开：回到大厅重新匹配
  if (ui.mode === 'online') {
    game.openOnlineLobby()
    return
  }
  await game.startMatch()
}
</script>

<template>
  <div
    ref="root"
    class="app-root"
    :class="{
      'is-dimmed': isDimmed,
      'is-night': isNight,
      'is-playing': inGame,
      'is-plant-selecting': ui.skillSelect !== null,
    }"
  >
    <!-- 3D 棋盘：整屏铺满、无边框、透明画布 -->
    <GameBoard
      class="board-layer"
      :interactive="interactive"
      :pinch="isMobile"
      @ready="handleReady"
      @pointer="handlePointer"
      @picker="handlePicker"
      @leave="handleLeave"
      @resize="handleResize"
      @pinchstart="handlePinchStart"
      @pinch="handlePinch"
    >
      <!-- 骰子 -->
      <DiceOverlay
        :visible="ui.diceVisible"
        :rolling="ui.rolling"
        :rolls="ui.dice?.rolls ?? null"
        :first="ui.dice?.first ?? null"
        :players="players"
        :auto-hide-ms="1400"
        @hidden="game.hideDice()"
      />

      <!-- 攻击阶段：悬浮棋子旁边的总攻击数（位置由 3D 层驱动） -->
      <div class="tally-layer" aria-hidden="true">
        <div ref="tally0" class="tally" :style="tallyStyle(0)">
          <span class="tally__label">{{ tallyLabels[0] }}</span>
          <span class="tally__value"><span class="tally__glyph">{{ ui.tally[0] }}</span></span>
        </div>
        <div ref="tally1" class="tally" :style="tallyStyle(1)">
          <span class="tally__label">{{ tallyLabels[1] }}</span>
          <span class="tally__value"><span class="tally__glyph">{{ ui.tally[1] }}</span></span>
        </div>
      </div>

      <!-- bugv34：黑夜预告（显示在回合标识上方） -->
      <div
        v-if="nightWarning && inGame && !ui.unsupported && !menuOpen"
        class="night-warning"
      >
        {{ nightWarning }}
      </div>

      <!-- 状态条 -->
      <div
        v-if="inGame && !ui.unsupported && !ui.attackPanelOpen && !menuOpen"
        class="status-strip"
        :style="{ '--side-color': statusSideColor }"
      >
        <span class="status-strip__side" />
        {{ statusText }}
        <template v-if="ui.busy"> · 动画播放中</template>
        <!-- bugv28 #4：联机回合倒计时（从世界时间反推，不用计时器） -->
        <span v-if="countdownActive" class="status-strip__timer" :class="{ 'is-urgent': countdownUrgent }">
          {{ countdownKindLabel }} {{ countdownSeconds }}s
        </span>
      </div>

      <!-- WebGL 降级 -->
      <div v-if="ui.unsupported" class="fallback">
        <h2>当前环境不支持 WebGL</h2>
        <p>3D 棋盘无法渲染，但规则与 AI 仍可正常对局。<br />请使用支持 WebGL2 的现代浏览器。</p>
      </div>
    </GameBoard>

    <!-- bugv34：黑夜天气（棋盘下方居中显示；点击查看详情） -->
    <div v-if="weatherInfo && hudVisible" class="weather-bar">
      <button
        type="button"
        class="weather-chip"
        :style="{ '--weather-color': weatherInfo.color }"
        @click="weatherDetailOpen = !weatherDetailOpen"
      >
        <span class="weather-chip__dot" />
        {{ weatherInfo.name }}
      </button>
    </div>

    <!-- bugv34：天气详情（桌面气泡 / 手机底部抽屉） -->
    <transition name="modal-fade">
      <div
        v-if="weatherDetailOpen && weatherInfo"
        class="weather-detail"
        @click.self="weatherDetailOpen = false"
      >
        <div class="weather-detail__card">
          <div class="weather-detail__head" :style="{ '--weather-color': weatherInfo.color }">
            <span class="weather-detail__dot" />
            <h3>{{ weatherInfo.name }}</h3>
            <button class="icon-btn" type="button" @click="weatherDetailOpen = false">✕</button>
          </div>
          <p class="weather-detail__body">{{ weatherInfo.detail }}</p>
        </div>
      </div>
    </transition>

    <!-- 攻击结算卡
         bugv25 #5：从棋盘插槽里**移出来**挂到根节点 —— 手机端要把它改成
         "正常文档流（棋盘下方）"，放在插槽里会被画布容器裁住。桌面端仍是绝对定位。 -->
    <AttackPanel
      v-if="hudVisible && !ui.unsupported"
      :attack="ui.attack"
      :open="ui.attackPanelOpen"
      :players="players"
      :phase="ui.phase"
      :human-defense="humanDefense"
      :weather="ui.weather"
    />

    <!-- 对局中：顶部左右两侧的角色立绘 + 血条（bugv9 #13 只保留这两样） -->
    <header v-if="hudVisible" class="hud">
      <PlayerPanel
        :player="players[0]"
        :side="0"
        :hp="ui.hp[0]"
        :shield="ui.shield[0]"
        :temp-armor="ui.tempArmor[0]"
        :initial-hp="matchHpCap"
        :active="ui.phase !== UI_PHASE.over && ui.current === 0"
        :attacker="ui.phase === UI_PHASE.defense && ui.attacker === 0"
        :defender="ui.phase === UI_PHASE.defense && ui.defender === 0"
        :is-ai="players[0].isAi"
        :expression="ui.expression[0]"
        :bonus-actions="ui.bonusActions[0]"
        :damage-bonus="damageBonus[0]"
        :immune="ui.immune[0] || ui.twinStar[0]"
        :impact-tick="ui.impactTick[0]"
        :damage-flash="ui.damageFlash[0]"
        :time-left="playerTimer(0).left"
        :time-total="playerTimer(0).total"
        :shield-flash="ui.shieldFlash[0]"
        :armor-break="ui.armorBreak[0]"
      />
      <PlayerPanel
        :player="players[1]"
        :side="1"
        :hp="ui.hp[1]"
        :shield="ui.shield[1]"
        :temp-armor="ui.tempArmor[1]"
        :initial-hp="matchHpCap"
        :active="ui.phase !== UI_PHASE.over && ui.current === 1"
        :attacker="ui.phase === UI_PHASE.defense && ui.attacker === 1"
        :defender="ui.phase === UI_PHASE.defense && ui.defender === 1"
        :is-ai="players[1].isAi"
        :expression="ui.expression[1]"
        :bonus-actions="ui.bonusActions[1]"
        :damage-bonus="damageBonus[1]"
        :immune="ui.immune[1] || ui.twinStar[1]"
        :impact-tick="ui.impactTick[1]"
        :damage-flash="ui.damageFlash[1]"
        :time-left="playerTimer(1).left"
        :time-total="playerTimer(1).total"
        :shield-flash="ui.shieldFlash[1]"
        :armor-break="ui.armorBreak[1]"
      />
    </header>

    <!-- bugv25 #5：手机竖屏 —— 技能入口改成**立绘下方两个无图标小按钮**。
         点按钮弹出底部抽屉（详情 + 使用），而不是桌面那套左右大槽位。
         左右两组并排在同一行（左二 / 右二），不额外占用纵向空间。 -->
    <div
      v-if="isMobile && hudVisible && (ui.screen === 'playing' || ui.screen === 'replay')"
      class="mobile-skills"
    >
      <div
        v-for="side in ([0, 1] as const)"
        :key="side"
        class="mobile-skills__group"
        :class="`is-side-${side}`"
        :style="{ '--side-color': hex(players[side].palette.color) }"
        :data-mobile-skills="side"
      >
        <button
          v-for="skill in ui.skills[side]"
          :key="skill.id"
          type="button"
          class="mobile-skill-btn"
          :class="{
            'is-ready': skill.ready && ui.screen === 'playing' && !players[side].isAi,
            'is-cooling': skill.remaining > 0,
          }"
          :disabled="ui.screen === 'replay'"
          @click="openSkillDrawer(side, skill.slot)"
        >
          <span class="mobile-skill-btn__name">{{ skill.name }}</span>
          <span class="mobile-skill-btn__meta">
            {{ skill.remaining > 0 ? `冷却 ${skill.remaining}` : skill.freeNow ? '免费' : `${skill.costNow} 植物` }}
          </span>
        </button>
      </div>
    </div>

    <!-- bugv25 #5：手机端技能详情抽屉（底部弹出） -->
    <SkillDrawer
      v-if="isMobile"
      :open="drawerSkill !== null"
      :skill="drawerData"
      :character-name="players[drawerSkill?.player ?? 0].name"
      :color="hex(players[drawerSkill?.player ?? 0].palette.color)"
      :glow="hex(players[drawerSkill?.player ?? 0].palette.glow)"
      :active="ui.screen === 'playing' && ui.current === (drawerSkill?.player ?? 0) && ui.phase !== UI_PHASE.over"
      :disabled="ui.screen === 'replay' || players[drawerSkill?.player ?? 0].isAi"
      @close="drawerSkill = null"
      @use="useDrawerSkill"
    />

    <!-- 画面左右侧中间的技能槽（bugv9 #13 / bugv10 #7 气泡）
         bugv25：**回放时也要显示**（显示的是那一手之后的冷却 / 可用状态），但不可点击。
         bugv25 #5：窄屏不再用这套大槽位，改为立绘下方的小按钮 + 底部抽屉。 -->
    <template v-if="hudVisible && !isMobile && (ui.screen === 'playing' || ui.screen === 'replay')">
      <SkillBar
        :player="0"
        :side="0"
        :skills="ui.skills[0]"
        :active="ui.screen === 'playing' && ui.current === 0 && ui.phase !== UI_PHASE.over"
        :selecting-slot="ui.skillSelect?.player === 0 ? ui.skillSelect.slot : null"
        :selected-count="ui.skillSelect?.player === 0 ? ui.skillSelect.picked.length : 0"
        :disabled="ui.screen === 'replay' || players[0].isAi || (ui.mode === 'online' && online.seat !== 0)"
        :read-only="ui.screen === 'replay'"
        :bubble-slot="ui.skillBubble?.player === 0 ? ui.skillBubble.slot : null"
        :notice="ui.skillBubble?.player === 0 ? ui.skillBubble.notice : ''"
        :flash="ui.skillFlash?.player === 0 ? { slot: ui.skillFlash.slot, key: ui.skillFlash.key } : null"
        :character-name="players[0].name"
        @cast="(slot) => game.toggleSkill(0, slot)"
      />
      <SkillBar
        :player="1"
        :side="1"
        :skills="ui.skills[1]"
        :active="ui.screen === 'playing' && ui.current === 1 && ui.phase !== UI_PHASE.over"
        :selecting-slot="ui.skillSelect?.player === 1 ? ui.skillSelect.slot : null"
        :selected-count="ui.skillSelect?.player === 1 ? ui.skillSelect.picked.length : 0"
        :disabled="ui.screen === 'replay' || players[1].isAi || (ui.mode === 'online' && online.seat !== 1)"
        :read-only="ui.screen === 'replay'"
        :bubble-slot="ui.skillBubble?.player === 1 ? ui.skillBubble.slot : null"
        :notice="ui.skillBubble?.player === 1 ? ui.skillBubble.notice : ''"
        :flash="ui.skillFlash?.player === 1 ? { slot: ui.skillFlash.slot, key: ui.skillFlash.key } : null"
        :character-name="players[1].name"
        @cast="(slot) => game.toggleSkill(1, slot)"
      />
    </template>

    <!-- 技能挑选 / 选目标格的提示（bugv9 #13 / bugv10 #9）
         bugv19：确认按钮单独放在棋盘**下方**的操作条里，不压住棋盘
         bugv25 #5：手机端**去掉那段提示文字**（入口已改成抽屉），只保留"已选 n/N + 确认"。 -->
    <div
      v-if="ui.skillSelect"
      class="skill-dock"
      :class="{ 'is-compact': isMobile }"
      :style="{ '--side-color': hex(players[ui.skillSelect.player].palette.color) }"
    >
      <div class="skill-hint">
        <span class="skill-hint__dot" :style="{ '--side-color': hex(players[ui.skillSelect.player].palette.color) }" />
        <template v-if="isMobile">
          已选
          <b>{{ ui.skillSelect.picked.length }}/{{ ui.skillSelect.max > ui.skillSelect.need ? `${ui.skillSelect.need}~${ui.skillSelect.max}` : ui.skillSelect.need }}</b>
          棵植物
        </template>
        <template v-else-if="ui.skillSelect.stage === 'cell'">
          火球目标：点击棋盘上<b>任意一个位置</b> · 该位置横竖的空位与植物都会被烈焰覆盖 ·
        </template>
        <template v-else>
          点击场上<b>我方棋子占用</b>的魔力植物（已选 {{ ui.skillSelect.picked.length }}/{{
            ui.skillSelect.max > ui.skillSelect.need
              ? `${ui.skillSelect.need}~${ui.skillSelect.max}`
              : ui.skillSelect.need
          }}）<template v-if="plantSelect?.note"> · {{ plantSelect.note }}</template> ·
        </template>
        <button class="link-btn" type="button" @click="game.cancelSkillSelect()">取消</button>
      </div>
      <button
        v-if="plantSelect"
        class="skill-confirm"
        type="button"
        :disabled="!plantSelect.ready"
        @click="game.confirmSkillSelect()"
      >
        {{ plantSelect.ready ? `确认选择（消耗 ${plantSelect.picked} 棵）` : `还需选择 ${plantSelect.need - plantSelect.picked} 棵` }}
      </button>
    </div>

    <!-- 右下角侧边：微型播放器（bugv9 #7） -->
    <div class="side-dock">
      <MiniPlayer
        :open="playerOpen"
        :playing="bgmState.playing"
        :muted="bgmState.muted"
        :volume="bgmState.volume"
        :label="bgmCurrent?.label ?? ''"
        :name="bgmCurrent?.name ?? ''"
        :index="bgmState.index"
        :total="bgmTracks.length"
        :supported="bgmState.supported"
        @open="playerOpen = $event"
        @toggle="game.bgmToggle()"
        @prev="game.bgmStep(-1)"
        @next="game.bgmStep(1)"
        @volume="game.bgmSetVolume($event)"
        @mute="game.bgmToggleMute()"
      />

      <!-- 右下角设置按钮 -->
      <button
        v-if="inGame"
        class="corner-btn"
        type="button"
        title="设置（Esc）"
        @click="menuOpen ? closeMenu() : openMenu()"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Zm0 5.2a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6Z"
          />
          <path
            fill="currentColor"
            d="m20.3 13.5.9-.7-1.4-2.4-1.1.4a3 3 0 0 0-.9-.5l-.2-1.2h-2.8l-.2 1.2a3 3 0 0 0-.9.5l-1.1-.4L11.2 13l.9.7a3 3 0 0 0 0 1l-.9.7 1.4 2.4 1.1-.4c.3.2.6.4.9.5l.2 1.2h2.8l.2-1.2c.3-.1.6-.3.9-.5l1.1.4 1.4-2.4-.9-.7a3 3 0 0 0 0-1Zm-6.1.5a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6Z"
            opacity="0.35"
          />
        </svg>
      </button>
    </div>

    <!-- bugv29 #4：全屏火红演出（火球）。bugv32 起去掉环绕屏幕的火舌，只留火红渐晕。指针事件全透传。 -->
    <div
      v-if="ui.fireScreen"
      :key="`fire-${ui.fireScreen}`"
      class="screen-fx screen-fx--fire"
      aria-hidden="true"
    />
    <div
      v-if="ui.speedLine"
      :key="`speed-${ui.speedLine.key}`"
      class="screen-fx screen-fx--speed"
      :style="speedLineStyle"
      aria-hidden="true"
    >
      <span
        v-for="(line, index) in SPEED_LINES"
        :key="index"
        class="speed-line"
        :style="{ left: line.left, animationDelay: line.delay, animationDuration: line.duration }"
      />
    </div>

    <!-- 开始菜单 -->
    <StartMenu
      v-if="ui.screen === 'menu'"
      :mode="ui.mode"
      :difficulty="ui.difficulty"
      :has-replay="history.length > 0"
      :replay-count="history.length"
      :characters="characterList"
      :character-value="[game.characters[0], game.characters[1]]"
      :random-value="[ui.characterRandom[0], ui.characterRandom[1]]"
      @start="startGame"
      @replay="openReplay"
      @settings="openSettings"
      @promise="promiseOpen = true"
      @rules="rulesOpen = true"
      @set-mode="setMode"
      @pick-character="game.setCharacter"
    />

    <!-- 联机（bugv34i）：未登录先登录 → 在房间里就显示房间大厅 → 否则显示匹配大厅 -->
    <AuthPanel
      v-if="ui.screen === 'online' && !online.user"
      :mode="online.authMode"
      :busy="online.authBusy"
      :message="online.authMessage"
      :connected="online.connected"
      @submit="(name, password, nickname) => game.onlineAuthSubmit(name, password, nickname)"
      @back="game.closeOnlineLobby()"
    />

    <RoomView
      v-if="ui.screen === 'online' && online.user && online.room"
      :room="online.room"
      :connected="online.connected"
      :message="online.message"
      @leave="game.leaveRoom()"
      @ready="(ready) => game.setRoomReady(ready)"
      @settings-panel="roomSettingsOpen = true"
      @transfer="(playerId) => game.transferRoomHost(playerId)"
      @character="(characterId) => game.pickRoomCharacter(characterId)"
    />

    <!-- 联机匹配大厅（bugv6 #8；bugv11 追加 #7：地址内置，自动连接） -->
    <OnlineLobby
      v-if="ui.screen === 'online' && online.user && !online.room"
      :status="online.status"
      :connected="online.connected"
      :account-name="online.user?.nickname ?? ''"
      :message="online.message"
      :code="online.code"
      :queue-position="online.queuePosition"
      :opponent="online.opponent"
      :seat="online.seat"
      :replay-count="online.replays.length"
      @back="game.closeOnlineLobby()"
      @logout="game.onlineLogout()"
      @queue="game.onlineQueue()"
      @cancel="game.onlineCancel()"
      @create="game.onlineCreateRoom()"
      @join="(code) => game.onlineJoinRoom(code)"
      @replays="openOnlineReplays"
      @settings="openSettings"
    />

    <!-- 房间聊天（bugv34e）：房间内与对局中都挂着，进游戏自动收起、回车打开 -->
    <RoomChat
      v-if="online.room"
      :open="roomChatOpen"
      :chat="online.room.chat"
      :you="online.room.you"
      :unread="online.chatUnread"
      :connected="online.connected"
      :playing="roomPlaying"
      @toggle="(open) => game.toggleRoomChat(open)"
      @send="(text) => game.sendRoomChat(text)"
    />

    <!-- 房间设置（bugv34e，仅房主可改） -->
    <RoomSettingsPanel
      :open="roomSettingsOpen"
      :settings="online.room?.settings ?? { hpLimit: 12, magic: {}, night: {} }"
      :editable="isRoomHost"
      @close="roomSettingsOpen = false"
      @patch="(patch) => game.setRoomSettings(patch)"
    />

    <!-- 游戏内菜单 -->
    <GameMenu
      :open="ui.showGameMenu"
      :players="players"
      :result-text="resultText"
      :can-resume="ui.screen === 'playing'"
      @resume="closeMenu"
      @restart="restart"
      @settings="openSettings"
      @menu="game.backToMenu()"
      @close="closeMenu"
    />

    <!-- 回放 -->
    <ReplayPanel
      :open="ui.showReplay"
      :record="replay.record"
      :index="replay.index"
      :total="replay.total"
      :playing="replay.playing"
      :history="history"
      :online-replays="online.replays"
      :online-loading="online.loadingReplays"
      :player-names="[players[0].name, players[1].name]"
      :collapsed="replay.collapsed"
      :code-text="replay.codeText"
      :code-message="replay.codeMessage"
      @close="game.closeReplay()"
      @seek="game.seekReplay"
      @toggle="game.toggleReplay"
      @collapse="game.setReplayCollapsed"
      @export="game.fillReplayCode()"
      @import="game.playReplayCode()"
      @code="replay.codeText = $event"
      @select="(record) => game.openReplay(record, online.replays.includes(record) ? 'online' : 'menu')"
      @remove="(id) => game.deleteReplay(id)"
      @clear="game.clearHistory()"
      @refresh="refreshOnlineReplays"
    />

    <!-- 结算 -->
    <ResultModal
      :visible="ui.showResult"
      :result="ui.result"
      :players="players"
      :initial-hp="matchHpCap"
      @restart="startReplay"
      @replay="replayThisMatch"
      @menu="backToMenuFromResult"
      @close="game.closeResult()"
    />

    <!-- 一次性提示（bugv8 #3：对手掉线等） -->
    <NoticeModal
      :visible="ui.notice !== null"
      :title="ui.notice?.title ?? ''"
      :text="ui.notice?.text ?? ''"
      :action="ui.notice?.action ?? '知道了'"
      :tone="ui.notice?.tone ?? 'info'"
      @confirm="onNoticeConfirm"
    />

    <!-- 游玩须知（bugv28 #1：每次进入游戏弹一次，可"不再弹出"） -->
    <PromiseModal :visible="promiseOpen" @confirm="closePromise" @never="neverShowPromise" />

    <!-- 游戏规则（bugv30 #5：开始菜单的「游戏规则」按钮打开，读 help.md） -->
    <GameRulesModal :visible="rulesOpen" @close="rulesOpen = false" />

    <!-- 设置 -->
    <SettingsPanel
      :open="ui.showSettings"
      :players="players"
      :mode="ui.mode"
      :difficulty="ui.difficulty"
      :sound-enabled="ui.soundEnabled"
      :bgm-tracks="bgmTracks"
      :bgm-track="ui.bgmTrack"
      :magic-config="magicConfig"
      :sound-styles="game.soundStyles"
      :sound-triggers="game.soundTriggers"
      :characters="characterList"
      :character-value="[game.characters[0], game.characters[1]]"
      :animation-speed="ui.animationSpeed"
      :hp-limit="ui.hpLimit"
      :night="ui.nightConfig"
      @close="closeMenu"
      @pick-character="game.setCharacter"
      @set-mode="setMode"
      @set-difficulty="game.setDifficulty"
      @set-sound="game.setSound"
      @set-bgm="game.setBgmTrack"
      @set-sound-style="game.setSoundStyle"
      @reset-sound-styles="game.resetSoundStyles"
      @set-magic="game.setMagicConfig"
      @reset-magic="game.resetMagicConfig"
      @set-animation-speed="game.setAnimationSpeed"
      @set-hp-limit="game.setHpLimit"
      @set-night="game.setNightConfig"
      @reset-night="game.resetNightConfig"
      @rename="game.renamePlayer"
    />
  </div>
</template>
