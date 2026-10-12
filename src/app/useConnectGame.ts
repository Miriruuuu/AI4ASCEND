/**
 * 应用状态：把纯逻辑引擎（core）、3D 表现层（three）与 Vue UI 串起来。
 *
 * 数据流：
 *   用户 / AI 决策 → engine.commit()/defend() → 事件序列
 *     → SceneController.playEvents() 逐个播放动画
 *       → 每个事件动画结束时 store.applyEvent() 推进模型
 *         → Vue 响应式 UI 更新
 *
 * 界面阶段（screen）：menu（开始菜单）→ playing（对局中）→ replay（回放）。
 */
import { computed, reactive, shallowRef } from 'vue'
import { AiClient } from '../ai/client'
import type { AiDifficulty, AiMagicContext, AiSkillContext, AiSkillUse } from '../ai/baseline'
import { GameEngine } from '../core/engine'
import { stateDigest } from '../core/digest'
import { findLines, threatHints } from '../core/lines'
import {
  BOARD_SIZE,
  CELL_COUNT,
  DEFAULT_MAGIC_CONFIG,
  DEFAULT_NIGHT_CONFIG,
  HP_LIMITS,
  INITIAL_HP,
  cellId,
  other,
  resolveMagicConfig,
  resolveNightConfig,
  weatherDef,
  type AttackSnapshot,
  type Board,
  type Cell,
  type GameEvent,
  type GameResult,
  type MagicConfig,
  type MagicPlant,
  type NightConfig,
  type NightPhase,
  type PlayerIndex,
  type SkillSpec,
  type SkillState,
  type WeatherId,
} from '../core/types'
import { BgmPlayer } from '../three/bgm'
import { DEFAULT_SOUND_STYLES, SOUND_TRIGGER_OPTIONS, type SoundName } from '../three/audio'
import { skillIconUrl, warmSkillIcons } from '../three/skill-icons'
import { SceneController } from '../three/scene-controller'
import {
  CHARACTERS,
  DEFAULT_CHARACTERS,
  findCharacter,
  impactExpression,
  matchExpression,
  skillEffectText,
  skillIcon,
  skillsOf,
  type CharacterId,
  type Expression,
} from './characters'
import { DEFAULT_PALETTE, type Palette } from '../three/palette'
import { prefersTrail, startCursorTrail } from './cursor-trail'
import {
  OnlineClient,
  storedUser,
  type OnlineApplied,
  type OnlineMatched,
  type OnlineReplayDoc,
  type OnlineRoomSettings,
  type OnlineRoomSettingsPatch,
  type OnlineRoomState,
  type OnlineStateMessage,
  type OnlineStatus,
  type OnlineUser,
} from './online'
import { buildRecord, clearReplays, loadReplays, persistReplays } from './replay-store'

/**
 * 背景音乐曲库（bugv5 #5）：把 `src/assets/bgm/` 里所有 mp3 都列出来，
 * 宿主丢新文件进去就会自动出现在设置面板里。
 *
 * bugv9 #7：默认播放 `let me go.mp3`，找不到就播第一首。
 */
const BGM_MODULES = import.meta.glob('../assets/bgm/*.mp3', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

/** 内置曲目的中文名（新增文件没有配置就显示文件名）。 */
const BGM_LABELS: Record<string, string> = {
  'let me go': 'Let Me Go',
  bgm: '默认',
  calm: '平静',
  tense: '紧张',
  piano: '钢琴',
}

const BGM_TRACKS: ReadonlyArray<{ name: string; label: string; url: string }> = Object.entries(BGM_MODULES)
  .map(([path, url]) => {
    const file = path.split('/').pop() ?? path
    const name = file.replace(/\.mp3$/i, '')
    return { name, label: BGM_LABELS[name] ?? name, url }
  })
  .sort((a, b) => (a.name === 'bgm' ? -1 : b.name === 'bgm' ? 1 : a.name.localeCompare(b.name)))

/** 默认曲目：优先 `let me go.mp3`，没有就播第一首（bugv9 #7）。 */
const DEFAULT_BGM =
  BGM_TRACKS.find((track) => track.name.toLowerCase() === 'let me go') ?? BGM_TRACKS[0]
const DEFAULT_BGM_INDEX = Math.max(
  0,
  BGM_TRACKS.findIndex((track) => track.name === DEFAULT_BGM?.name),
)

export type GameMode = 'pvp' | 'pve' | 'eve' | 'online'
/** 界面所处的大阶段。 */
export type Screen = 'menu' | 'setup' | 'playing' | 'replay' | 'online'

/** 界面用自己的阶段常量，避免与引擎内部的 MatchPhase / 事件类型混淆。 */
export const UI_PHASE = {
  idle: 'idle',
  rolling: 'rolling',
  playing: 'playing',
  defense: 'defense',
  over: 'over',
} as const
export type UiPhase = (typeof UI_PHASE)[keyof typeof UI_PHASE]

export interface PlayerMeta {
  name: string
  avatar: string
  /** 选用的角色（bugv9 #13）。 */
  character: CharacterId
  /** 各表情的立绘地址。 */
  art: Record<Expression, string>
  palette: { color: number; glow: number; deep: number; stone: number }
  isAi: boolean
}

/** 技能挑选的两个阶段（bugv10 #9：恶龙吐息先挑植物再点目标格）。 */
export type SkillSelectStage = 'plants' | 'cell'

/** 技能槽用的展示信息（引擎状态 + 图标 + 说明）。 */
export interface SkillUi extends SkillState {
  icon: string
  desc: string
  /** 图标对应的效果（CSS 用）。 */
  effectKind: string
}

export type { CharacterDef, CharacterId, Expression } from './characters'

/** 回放用的一步快照。 */
export interface ReplayStep {
  player: PlayerIndex
  cell: number
  defense: boolean
  /** 该步之后是否形成连珠。 */
  match: boolean
  /** 快照：这一手结算完毕后的棋盘。 */
  board: Cell[]
  hp: [number, number]
  /** 该步之后的魔力植物（bugv8 #4，老存档没有这个字段）。 */
  magic?: MagicPlant[]
  /**
   * 该步产生的完整事件序列（bugv9 #9）。
   *
   * 有了它，回放就能像真实对局一样把落子 / 连珠 / 对撞 / 撞击血条的特效**重播**出来，
   * 而不只是把棋盘快照贴上去。老存档没有这个字段时退化为"直接跳步"。
   */
  events?: GameEvent[]
  /** 该步是一次技能（bugv10 #11，联机回放由服务端给出）。 */
  skill?: { slot: number; cells: number[]; target: number | null }
  /**
   * 该步之后引擎的一些"新"状态（bugv10 #9/#11）。
   *
   * 联机回放没有本地事件序列，必须靠这个快照把护盾 / 连击 / 冷却 / 无敌 / 烈焰 / 叠子恢复出来。
   */
  extra?: ReplayExtra
}

/** 回放时用于恢复技能相关状态的快照（bugv10 #9/#11）。 */
export interface ReplayExtra {
  shield?: [number, number]
  bonusActions?: [number, number]
  actionsTaken?: [number, number]
  skillReadyAt?: [number[], number[]]
  lastPlacedBy?: [number | null, number | null]
  turnNo?: number
  immuneUntil?: [number, number]
  /** 增伤到期回合（bugv12 #2：「小一哥」持续 2 回合）。 */
  powerUntil?: [number, number]
  flames?: Array<[number, number]>
  overlay?: Array<[number, number]>
  /** 本回合毒鸡蛋的额外伤害（bugv12 #3）。 */
  sabotageBonus?: [number, number]
  /** 「双子星」的爆发窗口（bugv11 #5）。 */
  twinStar?: [boolean, boolean]
  /** 下次双子星是否**消耗 -1**（bugv12 #3 / bugv14）。 */
  bloomCheaperNext?: [boolean, boolean]
  /** 临时护甲与到期回合（bugv14 精密计算）。 */
  tempArmor?: [number, number]
  tempArmorUntil?: [number, number]
  /** 「深度思考」的额外攻击值与到期回合（bugv14）。 */
  strikeBonus?: [number, number]
  strikeUntil?: [number, number]
  /** 「播种」窗口（bugv14）。 */
  seedGrow?: [boolean, boolean]
  /** bugv19：低消耗档「杀鲸霸拳」——本回合本方植物不加伤。 */
  noPlantBonus?: [boolean, boolean]
  /** bugv34m：Qwen「本地部署」的窗口与本回合伤害加成。 */
  deploy?: [boolean, boolean]
  deployBonus?: [number, number]
  /** bugv34m：Qwen「小千问」待重新部署的棋子（编码值：原格 * 2 + 叠子位）。 */
  redeployPending?: [number[], number[]]
  /**
   * bugv25：这一步处于**攻击阶段**时，直接存下引擎的攻击快照。
   *
   * 回放时靠它把悬浮"总攻击数"还原成真值 —— 只按高光格数反推会丢掉
   * 魔力植物加伤 / 「小一哥」增伤 / 「最不绕弯子」的 baseDamage（反推恒为 0）。
   */
  attackSnapshot?: AttackSnapshot
  /** 烈焰归属（bugv14）：`[格子, 主人][]`。 */
  flameOwner?: Array<[number, number]>
  /** 各技能已经释放过几次（bugv11 #6：首次免费）。 */
  skillCasts?: [number[], number[]]
  /** 黑夜阶段 / 预告剩余 / 持续回合 / 距上次结束（bugv34）。 */
  nightPhase?: NightPhase
  nightCountdown?: number
  nightTurns?: number
  turnsSinceNight?: number
  /** 当前天气（bugv34）。 */
  weather?: WeatherId | null
  /** 双方发起过的攻击棋子数 + 本次黑夜起点（bugv34）。 */
  attacksLaunched?: [number, number]
  nightAttackBase?: [number, number]
  /**
   * 当前这次黑夜是不是「黑夜开局」触发的（bugv34d）。
   *
   * 只用于回放：这一档的首个黑夜不判"场上没有被棋子占有的魔力植物"。
   * 联机固定 `startInNight: false` ⇒ 服务端不会给这个字段，缺省即 `false`（正确）。
   */
  nightFromStart?: boolean
}

/** 一局对战记录（回放存档，bugv6 #4 会写进 localStorage）。 */
export interface MatchRecord {
  /** 本地回放是 `local-xxx`，联机对局直接用服务端 matchId。 */
  id: string | number
  mode: GameMode
  playedAt: string
  /** 时间戳（排序 / 展示用）。 */
  playedAtMs?: number
  steps: ReplayStep[]
  result: GameResult
  durationMs: number
  playerNames: [string, string]
  /** 联机对局在服务端的 id。 */
  serverId?: string
  /** 双方角色（bugv10 #11：回放里也要用同一套技能表）。 */
  characters?: [string, string]
}

const SIDE_META: readonly [PlayerMeta, PlayerMeta] = [
  {
    // bugv10 追加 #8：不再用"赤方 / 青方"，直接用角色名
    name: findCharacter(DEFAULT_CHARACTERS[0]).name,
    avatar: '先',
    character: DEFAULT_CHARACTERS[0],
    art: { ...findCharacter(DEFAULT_CHARACTERS[0]).art },
    palette: { ...DEFAULT_PALETTE.sides[0] },
    isAi: false,
  },
  {
    name: findCharacter(DEFAULT_CHARACTERS[1]).name,
    avatar: '后',
    character: DEFAULT_CHARACTERS[1],
    art: { ...findCharacter(DEFAULT_CHARACTERS[1]).art },
    palette: { ...DEFAULT_PALETTE.sides[1] },
    isAi: true,
  },
]

/**
 * 特征色预设（bugv9 #13：把两个角色的特征色也加进列表）。
 *
 * gemini `#d45fb9` / deepseek `#3964fe` 排在前面，因为选角色时默认就用它们。
 */
const COLOR_PRESETS: ReadonlyArray<{ label: string; color: number; glow: number; deep: number }> = [
  { label: 'DeepSeek 蓝', color: 0x3964fe, glow: 0x8fb3ff, deep: 0x16307f },
  { label: 'Gemini 粉', color: 0xd45fb9, glow: 0xff9ade, deep: 0x6b1f57 },
  { label: '赤红', color: 0xe0273c, glow: 0xff6b7d, deep: 0x6d0a15 },
  { label: '琥珀', color: 0xe08a12, glow: 0xffc46b, deep: 0x6d3f04 },
  { label: '翠绿', color: 0x14a86a, glow: 0x6fe0aa, deep: 0x055034 },
  { label: '青蓝', color: 0x1668d6, glow: 0x59a6ff, deep: 0x08305f },
  { label: '紫罗兰', color: 0x7c46d6, glow: 0xb894ff, deep: 0x371266 },
  { label: '炭黑', color: 0x2b2f38, glow: 0x7d8595, deep: 0x0c0e13 },
]

/** 攻击结算面板的展示时长（毫秒）。 */
const ATTACK_PANEL_LINGER = 2200
/** 骰子浮层的兜底隐藏时间（毫秒）：即使宿主没有挂载骰子组件也不会一直锁着棋盘。 */
const DICE_LINGER = 1900
/** 本地回放记录上限（localStorage 存档）。 */
const HISTORY_LIMIT = 30
/** 回放自动播放时每步之间的停顿（毫秒，bugv9 #9）。 */
const REPLAY_STEP_PAUSE = 520
/** 分出胜负后等待多久再弹结算（毫秒，bugv9 #13：先切表情再结算）。 */
const RESULT_DELAY = 1000
/** 魔力植物设置（bugv8 #4）在 localStorage 里的键。 */
const MAGIC_CONFIG_KEY = 'connect4.magic.v1'
/** 音效风格选择（bugv9 #10）在 localStorage 里的键。 */
const SOUND_STYLE_KEY = 'connect4.sounds.v1'
/** 动画速度倍率（bugv28 #3）在 localStorage 里的键。 */
const ANIMATION_SPEED_KEY = 'connect4.animSpeed.v1'
/** 动画速度可选项（bugv28 #3）。 */
export const ANIMATION_SPEEDS: readonly number[] = [1, 1.5, 2]
/** 联机倒计时：下子时限（秒，bugv28 #4）。 */
const ONLINE_PLACE_SECONDS = 20
/** 联机倒计时：攻击阶段防守方时限（秒，bugv28 #4）。 */
const ONLINE_DEFENSE_SECONDS = 60
/** 全屏火红（gtp 恶龙吐息）的持续时间（毫秒，bugv29 #4）。 */
const FIRE_SCREEN_MS = 3400

/** 读出本地保存的动画速度（非法值回退 1）。 */
function loadAnimationSpeed(): number {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(ANIMATION_SPEED_KEY)
    const value = Number(raw)
    return ANIMATION_SPEEDS.includes(value) ? value : 1
  } catch {
    return 1
  }
}

function persistAnimationSpeed(speed: number): void {
  try {
    localStorage?.setItem(ANIMATION_SPEED_KEY, String(speed))
  } catch {
    /* 存不下就算了，不影响对局 */
  }
}

/** 血量上限设置（bugv34，**仅非联机**）在 localStorage 里的键。 */
const HP_LIMIT_KEY = 'connect4.hp.v1'

/** 读出本地保存的血量上限（非法值回退默认 `INITIAL_HP`）。 */
function loadHpLimit(): number {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(HP_LIMIT_KEY)
    const value = Number(raw)
    return HP_LIMITS.includes(value) ? value : INITIAL_HP
  } catch {
    return INITIAL_HP
  }
}

function persistHpLimit(value: number): void {
  try {
    localStorage?.setItem(HP_LIMIT_KEY, String(value))
  } catch {
    /* 存不下就算了，不影响对局 */
  }
}

/**
 * 黑夜设置（bugv34 补充，**仅非联机**）在 localStorage 里的键。
 *
 * 存的是整份 `NightConfig`（进入条件 / 结束条件 / 强制结束条件 / 预告 / 开关）。
 */
const NIGHT_KEY = 'connect4.night.v1'
/** 旧的「黑夜开局」键（只读，用于平滑升级）。 */
const NIGHT_START_KEY = 'connect4.nightStart.v1'

/** 读出本地保存的黑夜设置（缺失项用默认值补齐；损坏数据整体回退默认）。 */
function loadNightConfig(): NightConfig {
  let partial: Partial<NightConfig> | null = null
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(NIGHT_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') partial = parsed as Partial<NightConfig>
    }
    // 兼容旧版本的「黑夜开局」键
    if (!partial || partial.startInNight === undefined) {
      const legacy = typeof localStorage === 'undefined' ? null : localStorage.getItem(NIGHT_START_KEY)
      if (legacy !== null) partial = { ...(partial ?? {}), startInNight: legacy === '1' }
    }
  } catch {
    partial = null
  }
  return resolveNightConfig(partial)
}

function persistNightConfig(config: NightConfig): void {
  try {
    localStorage?.setItem(NIGHT_KEY, JSON.stringify(config))
  } catch {
    /* 存不下就算了，不影响对局 */
  }
}

/** 读出本地保存的音效风格（损坏数据回退默认）。 */
function loadSoundStyles(): Record<string, string> {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(SOUND_STYLE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function persistSoundStyles(styles: Record<string, string>): void {
  try {
    localStorage?.setItem(SOUND_STYLE_KEY, JSON.stringify(styles))
  } catch {
    /* 存不下就算了，不影响对局 */
  }
}

/** 读出本地保存的魔力植物配置（损坏数据回退默认值）。 */
function loadMagicConfig(): MagicConfig {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(MAGIC_CONFIG_KEY)
    if (!raw) return { ...DEFAULT_MAGIC_CONFIG }
    return resolveMagicConfig(JSON.parse(raw) as Partial<MagicConfig>)
  } catch {
    return { ...DEFAULT_MAGIC_CONFIG }
  }
}

function persistMagicConfig(config: MagicConfig): void {
  try {
    localStorage?.setItem(MAGIC_CONFIG_KEY, JSON.stringify(config))
  } catch {
    /* 存不下就算了，不影响对局 */
  }
}

function hexToCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`
}

export function useConnectGame() {
  // --- 引擎 ---
  /**
   * 魔力植物配置（bugv8 #4）：本地对局用设置面板里的值，**联机固定用默认值**。
   */
  const magicConfig = reactive<MagicConfig>({ ...loadMagicConfig() })

  /**
   * 双方选用的角色（bugv9 #13）。
   *
   * 双方可以选择同一个角色；角色决定特征色、立绘与两个技能。
   * 声明在引擎之前：引擎构造时就要拿到技能表。
   */
  const characters = reactive<[CharacterId, CharacterId]>([
    DEFAULT_CHARACTERS[0],
    DEFAULT_CHARACTERS[1],
  ])

  /** 双方的技能表（引擎只认数值，bugv9 #13）。 */
  function engineSkills(): [readonly SkillSpec[], readonly SkillSpec[]] {
    return [skillsOf(characters[0]), skillsOf(characters[1])]
  }

  const engine = shallowRef(
    new GameEngine({ initialHp: INITIAL_HP, magic: magicConfig, skills: engineSkills() }),
  )
  const scene = shallowRef<SceneController | null>(null)

  // --- 响应式 UI 状态 ---
  const ui = reactive({
    screen: 'menu' as Screen,
    phase: UI_PHASE.idle as UiPhase,
    board: new Array<Cell>(BOARD_SIZE * BOARD_SIZE).fill(0),
    hp: [INITIAL_HP, INITIAL_HP] as [number, number],
    current: 0 as PlayerIndex,
    attacker: null as PlayerIndex | null,
    defender: null as PlayerIndex | null,
    highlights: [] as number[],
    highlightWeights: [] as number[],
    attack: null as AttackSnapshot | null,
    /** 攻击结算面板是否展示（结算后滞留一段时间再关闭）。 */
    attackPanelOpen: false,
    result: null as GameResult | null,
    busy: false,
    lastMove: null as number | null,
    /**
     * 上一步落子标记（bugv28 #2）：对局中"对手上一回合未成线的落子"。
     *
     * 与 3D 层同步（`refreshLastMark`），同时供 HUD / 自动化验收读取。
     */
    lastMark: null as { cell: number; player: PlayerIndex } | null,
    // --- bugv29 #4：特效演出 -------------------------------------------------
    /** 护盾到手时立绘的镜面反光触发计数（每次 +1，立绘据此播 2 秒扫光）。 */
    shieldFlash: [0, 0] as [number, number],
    /** bugv31：护盾 / 临时护甲被击碎时立绘的「镜面破碎」触发计数。 */
    armorBreak: [0, 0] as [number, number],
    /** gtp「恶龙吐息」的全屏火红（0 = 关闭；>0 为触发键，换键重播）。 */
    fireScreen: 0,
    /** deepseek「杀鲸霸拳」的全屏速度线；null = 关闭，维持到攻击阶段结束。 */
    speedLine: null as { player: PlayerIndex; key: number } | null,
    dice: null as { rolls: [number, number]; first: PlayerIndex } | null,
    rolling: false,
    /** 开局掷骰子的浮层是否还盖在棋盘上（bugv4 #2：骰子没消失前不能落子）。 */
    diceVisible: false,
    hoverCell: null as number | null,
    mode: 'pve' as GameMode,
    difficulty: 'normal' as AiDifficulty,
    showSettings: false,
    showGameMenu: false,
    showResult: false,
    showReplay: false,
    /** 音效开关（程序化生成，见 three/audio.ts）。 */
    soundEnabled: true,
    /** 动画速度倍率（bugv28 #3）：1 / 1.5 / 2，设置面板可调并本地保存。 */
    animationSpeed: loadAnimationSpeed(),
    /** 血量上限（bugv34）：8 / 12 / 16，**仅非联机生效**，默认 12，设置面板可调并本地保存。 */
    hpLimit: loadHpLimit(),
    /**
     * 黑夜设置（bugv34 补充）：进入条件 / 结束条件 / 强制结束条件 / 预告 / 开关 / 黑夜开局，
     * **仅非联机生效**，设置面板可调并本地保存。
     */
    nightConfig: loadNightConfig(),
    /** 黑夜阶段（bugv34）：none / pending（预告中）/ active（黑夜中）。 */
    nightPhase: 'none' as NightPhase,
    /** 黑夜预告剩余回合（>0 时在回合标识上方显示"黑夜即将降临 剩余 N 回合"）。 */
    nightCountdown: 0,
    /** 当前天气（黑夜中有效，棋盘下方居中显示）。 */
    weather: null as WeatherId | null,
    /** 当前背景音乐曲目名（bugv5 #5）。 */
    bgmTrack: DEFAULT_BGM?.name ?? '',
    /** 攻击阶段整体压暗：由 3D 场景回调驱动（防守方落子后才会变暗，bugv2 #5）。 */
    dark: false,
    /** 血条抖动的触发计数（每次撞击 +1）。 */
    impactTick: [0, 0] as [number, number],
    /** 每次撞击 +1，用于让“-1”飘字动画重复播放。 */
    damageFlash: [0, 0] as [number, number],
    /** 单次撞击的扣血量（用于飘字文本）。 */
    lastDamage: [0, 0] as [number, number],
    unsupported: false,
    hint: '' as string,
    /**
     * 悬浮在攻击棋子旁边的“总攻击数”（bugv3 #6）：
     * 下标是玩家，值为该玩家本轮的连珠棋子数（防守方是反击数）。
     */
    tally: [0, 0] as [number, number],
    /** 鼠标拖尾是否已启用（bugv6 #3，改用第三方库）。 */
    trailActive: false,
    /** 棋盘上的魔力植物数量（bugv8 #4，UI 展示用）。 */
    magicCount: 0,
    /** 已经长出过几次（影响每次数量）。 */
    magicGrowths: 0,
    /** 距下次生长还剩几回合。 */
    magicCooldown: 0,
    /**
     * 需要用户知道的一次性提示（bugv8 #3：对手掉线等）。
     * 为 null 表示不展示。
     */
    notice: null as { title: string; text: string; action: string; tone: 'info' | 'warn' } | null,
    // --- 角色系统（bugv9 #13） ---------------------------------------------
    /** 双方当前表情差分。 */
    expression: ['idle', 'idle'] as [Expression, Expression],
    /** 护盾值（金属血色条）。 */
    shield: [0, 0] as [number, number],
    /** 还能连续行动几次。 */
    bonusActions: [0, 0] as [number, number],
    /** 双方的技能状态（含图标，供技能槽直接渲染）。 */
    skills: [[], []] as [SkillUi[], SkillUi[]],
    /** 正在为某个技能挑魔力植物：
     * `{ player, slot, need, max, picked }`；为 null 表示没在挑。
     * bugv14：可变消耗技能的 `max > need`，选满 `max` 自动释放，
     * 也可以在选到 `need ~ max` 之间时手动点「释放」。
     */
    skillSelect: null as {
      player: PlayerIndex
      slot: number
      /** 至少要选几棵（可变消耗的下限）。 */
      need: number
      /** 最多能选几棵（非可变消耗技能等于 `need`）。 */
      max: number
      picked: number[]
      /** bugv10 #9：还需要点一个目标格的技能先挑植物、再点位置。 */
      stage: SkillSelectStage
      targetsCell: boolean
      target: number | null
    } | null,
    // --- bugv10 #9：新角色的技能状态 ---------------------------------------
    /** 棋盘上的烈焰：格子 -> 剩余回合。 */
    flames: [] as Array<{ cell: number; remaining: number }>,
    /** 无敌状态（精密计算）。 */
    immune: [false, false] as [boolean, boolean],
    /** 本回合伤害加成（小一哥）。 */
    power: [0, 0] as [number, number],
    /** 本回合可以在敌方棋子上落子（毒鸡蛋）。 */
    sabotage: [false, false] as [boolean, boolean],
    /** 本回合毒鸡蛋的额外伤害（bugv12 #3）。 */
    sabotageBonus: [0, 0] as [number, number],
    /** 毒鸡蛋当前合法的敌方棋子位置（只有能连珠的才算）。 */
    sabotageTargets: [] as number[],
    /** 「双子星」的爆发窗口（bugv11 #5：两连即可攻击 + 免疫反击）。 */
    twinStar: [false, false] as [boolean, boolean],
    /** 下次双子星是否**消耗 -1**（bugv12 #3 / bugv14）。 */
    bloomCheaperNext: [false, false] as [boolean, boolean],
    /** 临时护甲（bugv14 精密计算，UI 血条要单独显示）。 */
    tempArmor: [0, 0] as [number, number],
    /** 「深度思考」的额外攻击值（bugv14）。 */
    strikeBonus: [0, 0] as [number, number],
    /** 「播种」窗口（bugv14）。 */
    seedGrow: [false, false] as [boolean, boolean],
    /** bugv19：低消耗档「杀鲸霸拳」——本回合本方植物不加伤。 */
    noPlantBonus: [false, false] as [boolean, boolean],
    /** 烈焰归属（bugv14）：格子 -> 主人（表现层按归属分色）。 */
    flameOwner: [] as Array<[number, number]>,
    /** 随机角色占位（bugv10 #8）：开始游戏时再真正抽一个角色。 */
    characterRandom: [false, false] as [boolean, boolean],
    /** 开始菜单右侧展示的技能详情属于哪一方。 */
    infoSide: 0 as PlayerIndex,
    /**
     * 技能气泡（bugv10 #7）：点技能时不再弹窗，而是在技能旁边冒一个泡泡显示详情。
     *
     * `notice` 是"为什么现在用不了"的一句话；为空表示只是看详情。
     */
    skillBubble: null as { player: PlayerIndex; slot: number; notice: string } | null,
    /**
     * 刚刚被释放的技能（bugv11 #2）：技能框高亮 + 流光一段时间，
     * 让对手也看得见"他刚刚用了技能"。`key` 每次释放都换，动画才会重播。
     */
    skillFlash: null as { player: PlayerIndex; slot: number; key: number } | null,
  })

  const players = reactive<[PlayerMeta, PlayerMeta]>([
    { ...SIDE_META[0], palette: { ...SIDE_META[0].palette } },
    { ...SIDE_META[1], palette: { ...SIDE_META[1].palette } },
  ])

  /**
   * 双方昵称是否被手动改过（bugv10 追加 #8）。
   *
   * 没改过时昵称跟随角色名（DeepSeek / Gemini / GTP / GLM），改过就保留玩家自己填的
   * （联机昵称也走这里）。
   */
  const customNames: [boolean, boolean] = [false, false]

  /** 把角色的特征色写进该方的调色板。 */
  function applyCharacterPalette(player: PlayerIndex): void {
    const character = findCharacter(characters[player])
    players[player].palette = {
      color: character.color,
      glow: character.glow,
      deep: character.deep,
      stone: players[player].palette.stone,
    }
  }

  /** 给双方的调色板套上默认角色色（开局初始化）。 */
  function applyDefaultCharacters(): void {
    applyCharacterPalette(0)
    applyCharacterPalette(1)
    players[0].character = characters[0]
    players[0].art = { ...findCharacter(characters[0]).art }
    players[1].character = characters[1]
    players[1].art = { ...findCharacter(characters[1]).art }
    players[0].name = findCharacter(characters[0]).name
    players[1].name = findCharacter(characters[1]).name
  }
  applyDefaultCharacters()

  /** 历史对战记录（本地持久化，bugv6 #4）。 */
  const history = reactive<MatchRecord[]>(loadReplays())
  /**
   * 每个扳机选用的音效风格（bugv9 #10）。
   *
   * 默认值来自 `DEFAULT_SOUND_STYLES`，用户在设置面板里逐个扳机挑；
   * 选择时立刻试听，并持久化到 localStorage。
   */
  const soundStyles = reactive<Record<string, string>>({
    ...DEFAULT_SOUND_STYLES,
    ...loadSoundStyles(),
  })
  /** 回放状态。 */
  const replay = reactive({
    index: 0,
    total: 0,
    playing: false,
    record: null as MatchRecord | null,
    /** 关闭回放后回到哪个界面。 */
    returnTo: 'menu' as 'menu' | 'online',
    /** 导出 / 导入的代码文本（bugv9 #9）。 */
    codeText: '',
    /** 导入结果提示。 */
    codeMessage: '',
    /** 面板是否折叠（避免挡住棋盘，bugv9 #9）。 */
    collapsed: false,
  })

  /**
   * 联机状态（bugv6 #8）：大厅 / 匹配 / 对局都由这里驱动。
   */
  const online = reactive({
    status: 'offline' as OnlineStatus,
    /** 连接是否真正就绪（握手完成）——棋盘能否落子看它，而不是看 status 文案。 */
    connected: false,
    serverUrl: '',
    name: '玩家',
    code: '' as string,
    matchId: '' as string,
    seat: 0 as PlayerIndex,
    opponent: '',
    queuePosition: 0,
    /** 最近一次错误 / 提示。 */
    message: '',
    /** 服务端回放列表。 */
    replays: [] as MatchRecord[],
    loadingReplays: false,
    /** 服务端已确认的步数（用于校验消息连续性）。 */
    seq: 0,
    /**
     * 联机倒计时（bugv28 #4）。
     *
     * ⚠️ 不用计时器自减：回合开始时把"回合结束的世界时间"（绝对毫秒时间戳）定下来，
     * 剩余时间一律由 `Date.now()` 与它相减得到（见 `armOnlineDeadline` / 展示层）。
     */
    deadline: 0,
    /** 本次倒计时的总时长（毫秒），用于画进度环。 */
    deadlineTotal: 0,
    /** 倒计时类型：`place` 下子 / `defense` 攻击阶段防守。 */
    deadlineKind: null as 'place' | 'defense' | null,
    /** 剩余毫秒（展示层每帧刷新）。 */
    remainingMs: 0,
    /**
     * 当前房间（bugv34e）。
     *
     * 匹配成功 / 建房 / 加入 / 回到房间之后都有值；不在房间里为 `null`。
     * 房间设置里的 `hpLimit` 就是**联机的血量上限**（由房主决定、两端一致）。
     */
    room: null as OnlineRoomState | null,
    /** 房间聊天栏是否展开（进游戏自动收起；回车快速打开）。 */
    chatOpen: false,
    /** 对局中收到的未读聊天条数（聊天栏收起时显示角标）。 */
    chatUnread: 0,
    /** 输了一半的房间号（输入框）。 */
    joinCode: '',
    /** 聊天输入框内容由组件本地管理（这里只放一个空串占位，避免组件 key 抖动）。 */
    chatDraft: '',
    /**
     * 本局的**血量上限**（bugv34e）。
     *
     * 非联机用设置里的 `ui.hpLimit`；联机由**房间设置**决定（开局时从 `matched` 取，
     * 重连时从 `roomState` 取），所以单独存一份，`matchHpCap` 读它。
     */
    hpLimit: INITIAL_HP,
    /**
     * 当前登录的账号（bugv34i）。
     *
     * `null` = 未登录 —— 联机面板此时显示"账号 / 密码"表单，登录成功才进大厅。
     */
    user: null as OnlineUser | null,
    /** 登录面板当前是「登录」还是「注册」（账号不存在时自动切到注册）。 */
    authMode: 'login' as 'login' | 'register',
    /** 登录 / 注册请求是否在途（按钮禁用）。 */
    authBusy: false,
    /** 登录面板的提示文案（错误或引导）。 */
    authMessage: '',
  })

  // bugv34i：本地存着登录态就直接用账号昵称（令牌会在 hello 时回传给服务端）
  {
    const saved = storedUser()
    if (saved) {
      online.user = { ...saved.user }
      online.name = saved.user.nickname
    }
  }

  const palette = computed<Palette>(() => ({
    ...DEFAULT_PALETTE,
    sides: [players[0].palette, players[1].palette],
  }))

  /** 背景音乐（bugv3 #7）：用一个音频元素循环播放打包后的资源。 */
  const bgm = new BgmPlayer(DEFAULT_BGM?.url ?? '', { enabled: true, volume: 0.3 })
  /** 播放器状态（bugv9 #7：右下角迷你播放器用）。 */
  const bgmState = reactive({
    playing: false,
    muted: false,
    volume: 0.3,
    /** 当前曲目在 `BGM_TRACKS` 里的下标。 */
    index: DEFAULT_BGM_INDEX,
    /** 宿主环境是否支持播放 mp3（不支持时播放器只做展示）。 */
    supported: true,
  })
  bgm.onChange = (): void => {
    bgmState.playing = bgm.playing
    bgmState.muted = bgm.muted
    bgmState.volume = bgm.volume
  }
  /** AI 客户端：优先在 worker 里算，避免卡住动画（bugv5 #4）。 */
  const ai = new AiClient()

  /**
   * 联机客户端（bugv6 #8）。
   *
   * 回调里只改 UI 状态与本地模型；真正的落子在 `applyOnlineMove()` 里完成，
   * 并且用一条 Promise 队列串行化，避免两条消息同时打断动画。
   */
  const onlineClient = new OnlineClient({
    onLoggedIn: (user: OnlineUser) => {
      online.user = { ...user }
      online.name = user.nickname
      online.authBusy = false
      online.authMode = 'login'
      online.authMessage = ''
      online.message = ''
      // 联机昵称由账号决定，视为"自定义名"
      customNames[online.seat] = true
      renamePlayer(online.seat, user.nickname)
      syncUi()
    },
    onLoggedOut: () => {
      online.user = null
      online.authBusy = false
      online.authMessage = ''
      online.message = ''
      syncUi()
    },
    // bugv34l「顶号」：同一账号在别处登录 → 本机登录已失效，清态并回到登录面板
    onSessionExpired: (reason) => {
      online.user = null
      online.room = null
      online.code = ''
      online.chatOpen = false
      online.chatUnread = 0
      online.authBusy = false
      online.authMode = 'login'
      online.authMessage = ''
      online.message = ''
      showNotice({
        title: '登录已失效',
        text: `${reason}本机登录状态已清除，请重新登录。`,
        action: '重新登录',
        tone: 'warn',
      })
      if (ui.mode === 'online') {
        ui.screen = 'online'
        showMenuScene()
      }
      syncUi()
    },
    onStatus: (status, detail) => {
      online.status = status
      // 连接是否就绪、对局身份都以客户端为准（bugv7 #1：不能只看 status 文案）
      online.connected = onlineClient.connected
      online.matchId = onlineClient.matchId ?? ''
      online.seat = onlineClient.seat
      if (detail) online.message = detail
    },
    onQueue: (position) => {
      online.queuePosition = position
      online.message = position > 1 ? `已进入匹配队列（第 ${position} 位）` : '已进入匹配队列，等待对手…'
    },
    onRoom: (room) => {
      // bugv34e：房间（大厅）状态整体替换
      online.room = {
        code: room.code,
        you: room.you,
        members: room.members.map((member) => ({ ...member })),
        settings: room.settings,
        phase: room.phase,
        matchId: room.matchId,
        chat: room.chat.map((entry) => ({ ...entry })),
        canStart: room.canStart,
      }
      online.code = room.code
      online.chatDraft = ''
      online.message = ''
      // 房间设置里的血量上限 = 联机的血量上限（重连回来的客户端也要知道）
      online.hpLimit = room.settings.hpLimit
      // 房间里正在对局（刷新 / 断线重连回来）→ 直接进对局并补一次完整局面
      if (room.phase === 'playing' && room.matchId) {
        // 还没为这一局搭过镜像引擎（例如整页刷新）→ 用房间设置现搭一份，再去 sync
        if (onlineEngineFor !== room.matchId) {
          prepareOnlineEngine(room.settings)
          onlineEngineFor = room.matchId
          ui.mode = 'online'
          ui.screen = 'setup'
          ui.phase = UI_PHASE.rolling
          ui.dice = null
          ui.rolling = false
          ui.diceVisible = false
          ui.busy = true
          ui.nightPhase = 'none'
          ui.nightCountdown = 0
          ui.weather = null
          scene.value?.setNight(false)
          syncUi()
        }
        online.matchId = room.matchId
        if (onlineClient.connected) onlineClient.requestSync()
      }
      syncUi()
    },
    onRoomChat: (entry) => {
      if (!online.room) return
      if (!online.room.chat.some((item) => item.id === entry.id)) online.room.chat.push({ ...entry })
      // 房间聊天栏有新消息 → 让它可见（对局中则只记未读数）
      if (ui.screen === 'playing' || ui.screen === 'setup') online.chatUnread += 1
      else online.chatOpen = true
      syncUi()
    },
    onRoomClosed: (reason) => {
      online.room = null
      online.code = ''
      online.chatOpen = false
      online.chatUnread = 0
      online.message = reason === 'empty' ? '房间已解散' : '已退出房间'
      syncUi()
    },
    onMatched: (info) => {
      online.matchId = info.matchId
      online.seat = info.seat
      online.code = info.code ?? ''
      online.opponent = info.opponent
      online.queuePosition = 0
      online.seq = 0
      online.message = ''
      // bugv34e：开局时房间里的聊天栏自动收起
      online.chatOpen = false
      online.chatUnread = 0
      // bugv8 #2：对手进来了 —— 敲一声门铃（匹配码房间与在线匹配都算）
      scene.value?.audio.unlock()
      scene.value?.audio.play('doorbell')
      void startOnlineMatch(info)
    },
    onApplied: (message) => {
      enqueueOnline(() => applyOnlineMove(message))
    },
    onState: (message) => {
      enqueueOnline(async () => applyOnlineState(message))
    },
    onGameOver: (_result, replayId) => {
      if (replayId) online.message = `对局已保存到服务器（${replayId}）`
    },
    onOpponentLeft: (reason) => {
      online.status = 'ended'
      online.message = reason
      ui.busy = false
      syncInteractive()
      // bugv8 #3：对手掉线时玩家正在看棋盘，必须给一个看得见的提示
      showNotice({
        title: '对手已断开连接',
        text: `${reason}。本局已结束，可以回到大厅重新匹配。`,
        action: '返回大厅',
        tone: 'warn',
      })
    },
    onError: (code, message) => {
      // bugv34i：登录 / 注册失败 → 显示在登录面板上；账号不存在则自动切到"注册"
      const authCodes = ['userNotFound', 'wrongPassword', 'usernameTaken', 'badUsername', 'badPassword']
      if (authCodes.includes(code)) {
        online.authBusy = false
        online.message = ''
        if (code === 'userNotFound') {
          // 账号不存在**不是错误**：这一步就是注册流程的入口（bugv34k）
          online.authMode = 'register'
          online.authMessage = ''
        } else {
          online.authMessage = message
          if (code === 'usernameTaken') online.authMode = 'login'
        }
        syncUi()
        return
      }
      online.message = `${message}${code ? `（${code}）` : ''}`
      if (code === 'duplicateLogin') {
        showNotice({
          title: '身份已被接管',
          text: '同一个身份在别处登录了，这个页面不再参与对局。',
          action: '返回大厅',
          tone: 'warn',
        })
      }
    },
  })
  online.serverUrl = onlineClient.serverUrl

  /** 联机消息串行队列：保证同一时刻只有一次 `runEvents()` 在播动画。 */
  let onlineChain: Promise<void> = Promise.resolve()
  /** 已发出、但还没被服务端确认的落子（用于超时解锁棋盘）。 */
  let pendingOnlineMove: number | null = null
  function enqueueOnline(task: () => Promise<void>): void {
    onlineChain = onlineChain.then(task).catch((error: unknown) => {
      console.error('[connect4] 联机消息处理失败', error)
    })
  }

  /** 弹一个"必须让用户看到"的提示（bugv8 #3）。 */
  function showNotice(notice: { title: string; text: string; action: string; tone: 'info' | 'warn' }): void {
    ui.notice = notice
  }

  function dismissNotice(): void {
    ui.notice = null
  }

  const isAiTurn = computed(() =>
    ui.mode === 'eve' ? true : ui.mode === 'pve' ? players[ui.current].isAi : false,
  )

  /**
   * 联机对局中是否轮到自己（决定棋盘能否点击 / 提示文案）。
   *
   * ⚠️ 这里**必须**用响应式的 `ui.current`，不能读 `engine.value.current`：
   * `engine` 是 `shallowRef`，只有整体替换才会触发更新，引擎内部 `current` 的
   * 变化对 computed 是不可见的 —— 缓存下来的"轮到我了吗"会一直停在开局掷骰子的那一刻，
   * 于是有一方永远点不动棋盘（bugv7 #1 的第二个根因）。
   */
  const isMyOnlineTurn = computed(
    () =>
      ui.mode === 'online' &&
      online.matchId !== '' &&
      ui.current === online.seat &&
      isOnlinePlaying.value,
  )

  /** 联机对局是否仍在进行（对手离开 / 掉线后不再允许落子）。 */
  const isOnlinePlaying = computed(
    () => online.status !== 'ended' && online.status !== 'offline' && online.status !== 'error',
  )

  /**
   * 本局血量上限（bugv34）。
   *
   * - 非联机：跟随设置 `ui.hpLimit`（8 / 12 / 16，默认 12）。
   * - 联机：固定用默认值 `INITIAL_HP`（两端必须一致，不接受本地设置）。
   */
  const matchHpCap = computed(() => (ui.mode === 'online' ? online.hpLimit : ui.hpLimit))

  /**
   * 回合归属后缀（bugv34）：人机模式下在"XX落子 / 思考中"后面补"你的回合 / 对手回合"。
   * 双人（同屏）与观战（AI 对战）没有"你"的视角，返回空串；联机在 `statusText` 里单独处理。
   */
  const turnSuffix = computed(() =>
    ui.mode === 'pve' ? (isAiTurn.value ? ' · 对手回合' : ' · 你的回合') : '',
  )

  /** 是否轮到 AI 做出**防守**决策。 */
  const isAiDefense = computed(() => {
    if (ui.phase !== UI_PHASE.defense) return false
    const defender = ui.attacker === null ? 0 : other(ui.attacker)
    if (ui.mode === 'eve') return true
    return ui.mode === 'pve' && players[defender].isAi
  })

  const statusText = computed(() => {
    if (ui.screen === 'menu') return '准备开始'
    if (ui.phase === UI_PHASE.over) {
      if (ui.result?.winner === null || ui.result === null) return '平局'
      return `${players[ui.result.winner].name}胜利`
    }
    switch (ui.phase) {
      case UI_PHASE.rolling:
        return '掷骰子决定先后手'
      case UI_PHASE.defense:
        return isAiDefense.value
          ? `${players[ui.attacker ?? 0].name}发起攻击 · 对方正在选择抵消位置`
          : `${players[ui.attacker ?? 0].name}发起攻击 · 在高光位落子可削弱`
      case UI_PHASE.idle:
        return '准备开始'
      default:
        // bugv34：联机时补上"你的回合 / 对手回合"（同样用响应式的 ui.current，理由见 isMyOnlineTurn）
        if (ui.mode === 'online' && online.matchId !== '') {
          const mine = ui.current === online.seat
          return mine
            ? `${players[ui.current].name}落子 · 你的回合`
            : `${players[ui.current].name}思考中… · 对手回合`
        }
        // bugv10 #9：无敌 / 毒鸡蛋生效中，状态条上直接说出来
        if (ui.immune[ui.current]) return `${players[ui.current].name}无敌中 · 精密计算${turnSuffix.value}`
        // bugv11 #5：双子星窗口（两连即可攻击 + 免疫反击）
        if (ui.twinStar[ui.current]) {
          return `${players[ui.current].name} 双子星 · 本回合两连即可发起攻击（免疫反击）${turnSuffix.value}`
        }
        if (ui.sabotage[ui.current]) {
          return `${players[ui.current].name}落子 · 毒鸡蛋：可下在敌方棋子上（${ui.sabotageTargets.length} 个位置能连珠）${turnSuffix.value}`
        }
        return (
          (isAiTurn.value ? `${players[ui.current].name}思考中…` : `${players[ui.current].name}落子`) +
          turnSuffix.value
        )
    }
  })

  /** 当前回合方的特征色（悬停指示 / 状态条用）。 */
  const currentSideColor = computed(() => {
    const player = ui.phase === UI_PHASE.defense ? other(ui.attacker ?? 0) : ui.current
    return players[player].palette.color
  })

  /** 人类本轮是否需要在攻击阶段落子。 */
  const humanDefense = computed(() => {
    if (ui.phase !== UI_PHASE.defense) return false
    const defender = other(ui.attacker ?? 0)
    if (ui.mode === 'eve') return false
    // 联机：只有自己是防守方时才算"轮到我"
    if (ui.mode === 'online') return defender === online.seat
    if (ui.mode === 'pve') return !players[defender].isAi
    return true
  })

  // --- 内部记录 ---
  let playToken = 0
  let stepLog: ReplayStep[] = []
  let matchStartedAt = 0
  let attackPanelTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  /** 骰子浮层的兜底隐藏计时器。 */
  let diceTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  let pendingMatch = false
  /**
   * 上一步落子（bugv28 #2）：用于在场上标出"对手上一回合未成线的落子"。
   *
   * `matched` 为 true 表示这一手形成了连珠（连珠棋子会被移除，无需标记）。
   */
  let lastPlacement: { cell: number; player: PlayerIndex; matched: boolean } | null = null
  /**
   * 正在逐颗撞击血条：界面血量按“撞击一次扣一次”推进（bugv2 #1）。
   *
   * 引擎在 `defend()`/`commit()` 里就把血量算到最终值了，所以这期间
   * **任何** `syncUi()` 都不能用模型血量覆盖界面。
   */
  let damagePending = false

  function clearAttackPanelTimer(): void {
    if (attackPanelTimer !== null) {
      globalThis.clearTimeout(attackPanelTimer)
      attackPanelTimer = null
    }
  }

  /**
   * 刷新"上一步落子"光环（bugv28 #2）。
   *
   * 只在**对局中**、且这一手**没有形成连珠**时才显示；否则清掉。
   * 于是对手每次落子后，你都能一眼看到他的子下在哪。
   */
  function refreshLastMark(): void {
    const controller = scene.value
    if (ui.screen !== 'playing' || !lastPlacement || lastPlacement.matched) {
      ui.lastMark = null
      controller?.setLastMark(null)
      return
    }
    ui.lastMark = { cell: lastPlacement.cell, player: lastPlacement.player }
    controller?.setLastMark(lastPlacement.cell, lastPlacement.player)
  }

  // --- bugv29 #4：全屏演出 ---------------------------------------------------

  /** 火球全屏火红（gtp「恶龙吐息」）的计时器。 */
  let fireScreenTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  let fireScreenKey = 0

  /** 点燃全屏火红（3.4 秒后自动熄灭；重复触发会重播）。 */
  function showFireScreen(): void {
    fireScreenKey += 1
    ui.fireScreen = fireScreenKey
    if (fireScreenTimer !== null) globalThis.clearTimeout(fireScreenTimer)
    fireScreenTimer = globalThis.setTimeout(() => {
      fireScreenTimer = null
      ui.fireScreen = 0
    }, FIRE_SCREEN_MS)
  }

  function clearFireScreen(): void {
    if (fireScreenTimer !== null) {
      globalThis.clearTimeout(fireScreenTimer)
      fireScreenTimer = null
    }
    ui.fireScreen = 0
  }

  /** 速度线（deepseek「杀鲸霸拳」）：维持到攻击阶段结束 / 本回合结束。 */
  let speedLineKey = 0

  function showSpeedLine(player: PlayerIndex): void {
    speedLineKey += 1
    ui.speedLine = { player, key: speedLineKey }
  }

  function clearSpeedLine(): void {
    ui.speedLine = null
  }

  /**
   * 统一决定棋盘是否可交互（bugv4 #2）。
   *
   * 骰子浮层还在屏幕上时不允许落子 —— 之前只看 busy，而骰子比开局动画多停留一段时间，
   * 于是"骰子还没消失就能下子"。
   */
  function syncInteractive(): void {
    let ready = ui.screen === 'playing' && !ui.busy && !ui.diceVisible && !engine.value.isOver
    // 联机时还要轮到自己（对手回合棋盘不可点，避免误触发出非法请求）；
    // 与 isMyOnlineTurn 用同一个判断，避免两处口径不一致
    if (ready && ui.mode === 'online') ready = isMyOnlineTurn.value
    scene.value?.setInteractive(ready)
  }

  /** 骰子浮层已淡出。 */
  function hideDice(): void {
    if (diceTimer !== null) {
      globalThis.clearTimeout(diceTimer)
      diceTimer = null
    }
    if (!ui.diceVisible) return
    ui.diceVisible = false
    syncInteractive()
    // 骰子消失后才轮到 AI 起手
    afterStateSettled()
  }

  /** 结算弹窗的延时器（bugv9 #13：先切表情，等 1 秒再结算）。 */
  let resultTimer: ReturnType<typeof globalThis.setTimeout> | null = null

  /**
   * 安排结算弹窗（bugv9 #13）。
   *
   * 结束动画播完后先让立绘切成 win / lose，等 1 秒再弹结算面板。
   * 没有 3D（WebGL 降级）时没有立绘可等，立刻弹出。
   */
  function scheduleResult(delay = RESULT_DELAY): void {
    if (!scene.value) {
      ui.showResult = true
      return
    }
    if (resultTimer !== null) globalThis.clearTimeout(resultTimer)
    resultTimer = globalThis.setTimeout(() => {
      resultTimer = null
      if (ui.screen === 'playing' && ui.result) ui.showResult = true
    }, Math.max(0, delay))
  }

  function clearResultTimer(): void {
    if (resultTimer !== null) {
      globalThis.clearTimeout(resultTimer)
      resultTimer = null
    }
  }

  // -------------------------------------------------------------------------
  // 场景
  // -------------------------------------------------------------------------

  async function initScene(canvas: HTMLCanvasElement, container: HTMLElement): Promise<void> {
    try {
      const controller = new SceneController({
        canvas,
        container,
        palette: palette.value,
        sound: ui.soundEnabled,
        onApply: (event) => applyEvent(event),
        onImpact: (player: PlayerIndex, index: number) => {
          // 撞击一次扣一次血：界面血量按“逐颗”推进（bugv2 #1）
          ui.impactTick[player] += 1
          if (damagePending) {
            // bugv9 #13 / bugv14：承伤顺序必须与引擎一致 —— 临时护甲 → 护盾 → 血量，
            // 否则会出现"护甲还是满的、血却先掉了一格"的错位（bugv20 #3 修）
            if (ui.tempArmor[player] > 0) ui.tempArmor[player] = ui.tempArmor[player] - 1
            else if (ui.shield[player] > 0) ui.shield[player] = ui.shield[player] - 1
            else ui.hp[player] = ui.hp[player] - 1
            // 飘字每次撞击都刷新（组件用 watch + 计数触发动画）
            ui.damageFlash[player] = (ui.damageFlash[player] ?? 0) + 1
            ui.lastDamage = [player === 0 ? 1 : 0, player === 1 ? 1 : 0]
          }
          // bugv20 #1 / bugv27 #2：立绘不再等整套撞击动画播完 —— 第一颗撞上就切 hit，
          // 血量被打到 0 及以下立刻切 lose（并维持）。
          //
          // ⚠️ 这里**不能**再用 `ui.result` 当闸门：引擎在 `defend()` 里已经把对局判成结束，
          // 于是攻击动画刚开始 `ui.result` 就为真，导致"受击的前几颗棋子完全不切差分"
          // （用户实测：前 4 颗维持普通立绘）。`impactExpression` 自己会处理"血量 ≤0 → lose"，
          // 结算最终态由 `gameOver` / `attackResolved` 覆盖，不会互相打架。
          ui.expression = impactExpression(player, ui.expression, ui.hp[player], index)
        },
        onClash: () => {
          /* 对撞特效已在 3D 层播放（含全屏波纹 / 粒子 / 闪光） */
        },
        onGameOver: () => {
          // 回放里播到"对局结束"不应该弹结算（bugv9 #9）
          if (!recording) return
          scheduleResult()
        },
        onCellPick: (cell: number) => void handleCellPick(cell),
        onHover: (cell: number | null) => {
          ui.hoverCell = cell
        },
        onRendererLost: () => {
          ui.unsupported = true
          ui.hint = 'WebGL 上下文丢失，已切换为无 3D 模式'
        },
        onDarkChange: (dark: boolean) => {
          ui.dark = dark
        },
        onSound: (name, variant) => {
          // 由宿主统一发声：程序化音效 + 大特效时压低背景音乐
          scene.value?.audio.play(name, variant)
          if (name === 'clash' || name === 'impact') bgm.duck(0.4, 0.45)
        },
      })
      scene.value = controller
      // 把已保存的音效风格装进合成器（bugv9 #10）
      controller.audio.setStyles(soundStyles)
      // bugv28 #3：把已保存的动画速度装上
      controller.setAnimationSpeed(ui.animationSpeed)
      controller.start()
      showMenuScene()
    } catch (error) {
      console.error('[connect4] WebGL 初始化失败，已降级为无 3D 模式', error)
      scene.value = null
      ui.unsupported = true
    }
  }

  /** 由 App 在首次用户手势时调用，解锁浏览器音频（含背景音乐）。 */
  function unlockAudio(): void {
    scene.value?.audio.unlock()
    if (ui.soundEnabled) bgm.play()
  }

  /** 开关音效（背景音乐共用同一个开关）。 */
  function setSound(enabled: boolean): void {
    ui.soundEnabled = enabled
    scene.value?.audio.setEnabled(enabled)
    bgm.setEnabled(enabled)
    if (enabled) {
      scene.value?.audio.unlock()
      bgm.play()
    }
    bgm.onChange?.()
  }

  /**
   * 设置动画速度倍率（bugv28 #3）：即时生效并本地保存。
   *
   * 3D 层的所有动画都挂在同一个 `Animator` 上，所以只改它的倍率即可。
   */
  function setAnimationSpeed(speed: number): void {
    const value = ANIMATION_SPEEDS.includes(speed) ? speed : 1
    ui.animationSpeed = value
    scene.value?.setAnimationSpeed(value)
    persistAnimationSpeed(value)
  }

  /**
   * 设置血量上限（bugv34）：8 / 12 / 16，**仅非联机生效**，本地保存。
   *
   * 只改设置、不打断正在进行的对局 —— 新的一局（`startMatch`）才会用新值建引擎。
   */
  function setHpLimit(limit: number): void {
    const value = HP_LIMITS.includes(limit) ? limit : INITIAL_HP
    ui.hpLimit = value
    persistHpLimit(value)
  }

  /**
   * 更新黑夜设置（bugv34 补充）：进入条件 / 结束条件 / 强制结束条件 / 预告 / 开关 / 黑夜开局。
   *
   * 只改设置、不打断正在进行的对局 —— 新的一局（`startMatch`）才会生效。
   * **仅非联机生效**（联机固定用默认值）。
   */
  function setNightConfig(patch: Partial<NightConfig>): void {
    ui.nightConfig = resolveNightConfig({ ...ui.nightConfig, ...patch })
    persistNightConfig(ui.nightConfig)
  }

  /** 黑夜设置恢复默认（bugv34 补充）。 */
  function resetNightConfig(): void {
    setNightConfig({ ...DEFAULT_NIGHT_CONFIG })
  }

  /** 切换背景音乐（bugv5 #5）。 */
  function setBgmTrack(name: string): void {
    const index = BGM_TRACKS.findIndex((item) => item.name === name)
    const track = BGM_TRACKS[index]
    if (!track) return
    bgmState.index = Math.max(0, index)
    ui.bgmTrack = track.name
    bgm.setSource(track.url)
    if (ui.soundEnabled) bgm.play()
    bgm.onChange?.()
  }

  // --- 迷你播放器（bugv9 #7） -----------------------------------------------

  /** 播放 / 暂停。 */
  function bgmToggle(): void {
    unlockAudio()
    bgm.toggle()
    bgm.onChange?.()
  }

  /** 上一首 / 下一首（`delta` = ±1），循环。 */
  function bgmStep(delta: number): void {
    if (BGM_TRACKS.length === 0) return
    const next = (bgmState.index + delta + BGM_TRACKS.length) % BGM_TRACKS.length
    setBgmTrack(BGM_TRACKS[next].name)
    unlockAudio()
  }

  /** 设置音量（0..1）。 */
  function bgmSetVolume(volume: number): void {
    bgm.setVolume(volume)
    bgm.onChange?.()
  }

  /** 静音开关。 */
  function bgmToggleMute(): void {
    bgm.toggleMute()
    bgm.onChange?.()
  }

  // --- 音效风格（bugv9 #10） -------------------------------------------------

  /**
   * 为某个扳机选择音效风格：立刻试听并保存。
   *
   * 选择时播放是需求明确要求的（"选择时播放音效"）。
   */
  function setSoundStyle(name: SoundName, styleId: string): void {
    soundStyles[name] = styleId
    const controller = scene.value
    controller?.audio.setStyles({ [name]: styleId })
    controller?.audio.unlock()
    controller?.audio.preview(name, styleId, name === 'match' ? 4 : 1)
    persistSoundStyles({ ...soundStyles })
  }

  /** 全部恢复默认风格。 */
  function resetSoundStyles(): void {
    for (const [name, styleId] of Object.entries(DEFAULT_SOUND_STYLES)) soundStyles[name] = styleId
    scene.value?.audio.setStyles(DEFAULT_SOUND_STYLES)
    persistSoundStyles({ ...soundStyles })
  }

  /** 组件卸载：释放 3D 场景与音频。 */
  function dispose(): void {
    stopTrail()
    scene.value?.dispose()
    scene.value = null
    ai.dispose()
    onlineClient.disconnect(true)
    bgm.dispose()
  }

  // -------------------------------------------------------------------------
  // 鼠标拖尾（bugv6 #3）
  // -------------------------------------------------------------------------

  /** 第三方拖尾实例（`cursor-effects` 的 trailingCursor）。 */
  let trailEffect: { destroy(): void } | null = null

  /**
   * 启动鼠标拖尾。
   *
   * 默认只在「精确指针 + 未要求减少动效」的浏览器上启用；
   * `force` 供自动化验证脚本在无头环境里强制打开。
   */
  function startTrail(container?: HTMLElement, options: { force?: boolean } = {}): boolean {
    if (trailEffect) return true
    if (typeof document === 'undefined') return false
    if (!options.force && !prefersTrail()) return false
    const host = container ?? document.querySelector<HTMLElement>('.app-root') ?? document.body
    const effect = startCursorTrail(host)
    if (!effect) return false
    trailEffect = effect
    ui.trailActive = true
    return true
  }

  /** 关掉拖尾（卸载 / 关闭开关）。 */
  function stopTrail(): void {
    trailEffect?.destroy()
    trailEffect = null
    ui.trailActive = false
  }

  /**
   * 修改魔力植物配置（bugv8 #4）。
   *
   * 引擎在**构造时**读取配置，所以改动对下一局生效（设置面板里有说明）；
   * 联机对局一律用默认配置，这里改不动也改不了。
   */
  function setMagicConfig(patch: Partial<MagicConfig>): void {
    const next = resolveMagicConfig({ ...magicConfig, ...patch })
    Object.assign(magicConfig, next)
    persistMagicConfig(next)
  }

  /** 恢复默认配置。 */
  function resetMagicConfig(): void {
    setMagicConfig({ ...DEFAULT_MAGIC_CONFIG })
  }

  /** 开始菜单：棋盘上摆几颗装饰棋子，缓慢摆动（待机展示）。 */
  function showMenuScene(): void {
    const controller = scene.value
    if (!controller) return
    controller.resetTransient()
    controller.setIdle(true)
    controller.setInteractive(false)
    ui.diceVisible = false
    controller.syncBoard(new Array<number>(BOARD_SIZE * BOARD_SIZE).fill(0))
    // 一个简单好看的示意局面
    const cells = [cellId(4, 4), cellId(3, 4), cellId(4, 3), cellId(5, 4), cellId(4, 5), cellId(2, 6)]
    const owners: PlayerIndex[] = [0, 1, 1, 1, 0, 0]
    cells.forEach((cell, index) => controller.pieces.spawn(cell, owners[index]))
    ui.board = new Array<Cell>(BOARD_SIZE * BOARD_SIZE).fill(0)
    ui.phase = UI_PHASE.idle
    ui.dark = false
    ui.highlights = []
    ui.tally = [0, 0]
  }

  /** 用引擎状态重建场景（开局 / 重开 / 重连）。 */
  function syncSceneFromEngine(): void {
    const controller = scene.value
    if (!controller) return
    const state = engine.value
    controller.resetTransient()
    controller.setIdle(false)
    controller.setInteractive(true)
    // bugv11 #7：重连时可能正停在攻击阶段，立绘规则要跟着一起对齐
    attackPhaseActive = state.phase === 'awaitingDefense'
    controller.syncBoard(state.board)
    // 魔力植物也要一起对齐（开局是空的；`sync` / 回放重建时不是）
    controller.syncMagic([...state.magic.values()])
    // bugv10 #9：烈焰与叠子也要能重建（联机 sync / 回放跳步）
    controller.syncFlames([...state.flames.entries()], [...state.flameOwner.entries()] as Array<[number, number]>)
    controller.syncOverlay(state.board, [...state.overlay.entries()])
    controller.setAttackMode(state.phase === 'awaitingDefense')
    if (state.highlights.size > 0) {
      const cells = [...state.highlights.keys()]
      const weights = cells.map((cell) => state.highlights.get(cell) ?? 1)
      controller.setHighlightWeights(state.highlights)
      controller.showHighlights(cells, weights, state.highlightOwner ?? 0)
    }
  }

  /** 同步响应式 UI（在事件应用后调用）。 */
  function syncUi(): void {
    const state = engine.value
    ui.board = state.board.slice()
    ui.magicCount = state.magic.size
    ui.magicGrowths = state.magicGrowths
    ui.magicCooldown = state.magicCooldown
    // 逐颗撞击过程中不要用模型的“最终血量”覆盖界面（bugv2 #1）；
    // bugv20 #3：护盾与临时护甲同样要逐格扣，不能直接刷成结果
    if (!damagePending) {
      ui.hp = [state.hp[0], state.hp[1]]
      ui.shield = [state.shield[0], state.shield[1]]
      ui.tempArmor = [state.tempArmor[0], state.tempArmor[1]]
    }
    ui.bonusActions = [state.bonusActions[0], state.bonusActions[1]]
    // bugv10 #9：新角色的技能状态（烈焰按"半回合"存，对外显示向上取整的回合数）
    ui.flames = [...state.flames.entries()]
      .map(([cell, halfTurns]) => ({ cell, remaining: Math.ceil(halfTurns / 2) }))
      .sort((a, b) => a.cell - b.cell)
    ui.immune = [state.isImmune(0), state.isImmune(1)]
    // bugv11 #5：双子星爆发窗口（两连即可攻击 + 免反击）
    ui.twinStar = [state.twinStar[0], state.twinStar[1]]
    ui.power = [state.powerBonus[0], state.powerBonus[1]]
    ui.sabotage = [state.sabotage[0], state.sabotage[1]]
    ui.sabotageBonus = [state.sabotageBonus[0], state.sabotageBonus[1]]
    ui.bloomCheaperNext = [state.bloomCheaperNext[0], state.bloomCheaperNext[1]]
    // bugv20 #3：`tempArmor` 已经在上面的 `!damagePending` 分支里逐格推进，这里不再覆盖
    ui.strikeBonus = [state.strikeBonus[0], state.strikeBonus[1]]
    ui.seedGrow = [state.seedGrow[0], state.seedGrow[1]]
    ui.noPlantBonus = [state.noPlantBonus[0], state.noPlantBonus[1]]
    ui.flameOwner = [...state.flameOwner.entries()].sort((a, b) => a[0] - b[0])
    ui.sabotageTargets = state.sabotage[state.current] ? state.sabotageTargets(state.current) : []
    ui.current = state.current
    // 技能状态（bugv9 #13）：冷却 / 可用 / 植物够不够 + 程序化图标
    ui.skills = ([0, 1] as PlayerIndex[]).map((player) => {
      const character = findCharacter(characters[player])
      const list: SkillUi[] = []
      state.skills[player].forEach((spec, slot) => {
        const skill = state.skillStateFor(player, slot)
        if (!skill) return
        list.push({
          ...skill,
          icon: skillIconUrl(skillIcon(spec), character.color, character.glow),
          desc: skillEffectText(spec),
          effectKind: skill.effect,
        })
      })
      return list
    }) as [SkillUi[], SkillUi[]]

    const defending = state.phase === 'awaitingDefense'
    const highlightOwner = state.highlightOwner
    ui.attacker = defending ? highlightOwner : state.attack?.attacker ?? null
    ui.defender = defending
      ? highlightOwner === null
        ? null
        : other(highlightOwner)
      : state.attack?.defender ?? null
    ui.highlights = [...state.highlights.keys()]
    ui.highlightWeights = ui.highlights.map((cell) => state.highlights.get(cell) ?? 0)

    // 界面阶段
    if (ui.screen === 'menu') ui.phase = UI_PHASE.idle
    else if (ui.screen === 'replay') ui.phase = UI_PHASE.idle
    else if (state.phase === 'gameOver') ui.phase = UI_PHASE.over
    else if (defending) ui.phase = UI_PHASE.defense
    else if (ui.rolling) ui.phase = UI_PHASE.rolling
    else ui.phase = UI_PHASE.playing

    // 攻击详情面板：仅攻击阶段与结算展示期内可见（bugv1 #7）
    if (defending) {
      clearAttackPanelTimer()
      ui.attack = state.attack
      ui.attackPanelOpen = true
    } else if (state.phase === 'gameOver' || state.phase === 'playing') {
      if (!ui.attackPanelOpen) ui.attack = state.attack
    }

    ui.result = state.result
    if (!defending) scene.value?.setAttackMode(false)
    scene.value?.setHoverColor(players[state.current].palette.color)
    // 总攻击数（bugv3 #6）：攻击方是最终攻击值，防守方是反击值
    const snapshot = state.attack
    ui.tally = snapshot
      ? [
          snapshot.attacker === 0 ? snapshot.finalAttack : snapshot.defenderAttack,
          snapshot.attacker === 1 ? snapshot.finalAttack : snapshot.defenderAttack,
        ]
      : [0, 0]
    replay.total = replay.record?.steps.length ?? 0
    // 联机 / 骰子等状态变化后重新评估棋盘可交互性
    syncInteractive()
  }

  /** 关闭攻击详情面板（结算滞留结束后调用）。 */
  function closeAttackPanel(): void {
    clearAttackPanelTimer()
    ui.attackPanelOpen = false
    ui.attack = null
  }

  /**
   * 让悬浮的攻击棋子数量与**总攻击数**严格一致（bugv9 #6）。
   *
   * 触发时机：
   * - 防守方落子后（被削弱 / 被抢走魔力植物）→ 只对齐攻击方；
   * - 连珠棋子飞上舞台后 → 两侧一起对齐（含魔力植物带来的额外棋子）。
   *
   * `only` 用于避免"防守方的棋子还没飞上舞台就先补出一批"。
   */
  function syncStageCount(only?: PlayerIndex): void {
    const controller = scene.value
    const snapshot = engine.value.attack
    if (!controller || !snapshot) return
    const tally: [number, number] = [
      snapshot.attacker === 0 ? snapshot.finalAttack : snapshot.defenderAttack,
      snapshot.attacker === 1 ? snapshot.finalAttack : snapshot.defenderAttack,
    ]
    void controller.reconcileStage(tally, only)
  }

  /**
   * 记录当前局面快照（供回放）。
   *
   * bugv25：事件改用 `stepBuffer`（**跨多次 `runEvents` 累积**）。
   *
   * 以前读的是"当前这一批" `currentBatch`，而 AI 的"技能 → 落子"是**两次独立**的
   * `runEvents`：放技能那次播完 `finally` 就把批次清空了，落子那次重新赋值 ——
   * 于是**技能事件（`skillUsed` / 技能产生的状态变化）永远不会进入回放步骤**。
   * 回放里因此看不到技能框高亮、没有技能特效，攻击数也缺了一块。
   */
  function snapshotStep(player: PlayerIndex, cell: number, defense: boolean): void {
    if (!recording) return
    const state = engine.value
    stepLog.push({
      player,
      cell,
      defense,
      match: pendingMatch,
      board: state.board.slice(),
      hp: [state.hp[0], state.hp[1]],
      magic: [...state.magic.values()].map((plant) => ({ ...plant })),
      // 这一手的事件序列（bugv9 #9）：回放时按它重播特效
      events: stepBuffer.length > 0 ? stepBuffer.map(cloneEvent) : undefined,
      // bugv10 #9/#11：技能相关的状态（联机回放靠它恢复）
      extra: replayExtra(),
    })
    pendingMatch = false
    stepBuffer = []
  }

  /**
   * bugv25：给"**只用技能、没落子**"的行动单独记一步。
   *
   * 典型是 seedance「最不绕弯子」：用完直接进攻击阶段，没有落子 ⇒
   * 以前**这一步完全不存在**，回放里那次攻击凭空出现、攻击数显示 0。
   * `cell = -1` 表示"这一步没有落子"。
   */
  function snapshotSkillStep(player: PlayerIndex, use: { slot: number; cells: number[]; target?: number | null }): void {
    if (!recording) return
    const state = engine.value
    stepLog.push({
      player,
      cell: -1,
      defense: false,
      match: false,
      board: state.board.slice(),
      hp: [state.hp[0], state.hp[1]],
      magic: [...state.magic.values()].map((plant) => ({ ...plant })),
      events: stepBuffer.length > 0 ? stepBuffer.map(cloneEvent) : undefined,
      skill: { slot: use.slot, cells: [...use.cells], target: use.target ?? null },
      extra: replayExtra(),
    })
    pendingMatch = false
    stepBuffer = []
  }

  /** 把引擎里"新"的状态打包成回放快照（bugv10 #9/#11）。 */
  function replayExtra(): ReplayExtra {
    const state = engine.value
    return {
      shield: [state.shield[0], state.shield[1]],
      bonusActions: [state.bonusActions[0], state.bonusActions[1]],
      actionsTaken: [state.actionsTaken[0], state.actionsTaken[1]],
      skillReadyAt: [[...state.skillReadyAt[0]], [...state.skillReadyAt[1]]],
      lastPlacedBy: [state.lastPlacedBy[0], state.lastPlacedBy[1]],
      turnNo: state.turnNo,
      immuneUntil: [state.immuneUntil[0], state.immuneUntil[1]],
      powerUntil: [state.powerUntil[0], state.powerUntil[1]],
      flames: [...state.flames.entries()].sort((a, b) => a[0] - b[0]),
      overlay: [...state.overlay.entries()].sort((a, b) => a[0] - b[0]),
      tempArmor: [state.tempArmor[0], state.tempArmor[1]],
      tempArmorUntil: [state.tempArmorUntil[0], state.tempArmorUntil[1]],
      strikeBonus: [state.strikeBonus[0], state.strikeBonus[1]],
      strikeUntil: [state.strikeUntil[0], state.strikeUntil[1]],
      seedGrow: [state.seedGrow[0], state.seedGrow[1]],
      noPlantBonus: [state.noPlantBonus[0], state.noPlantBonus[1]],
      // bugv34m：Qwen 的两个技能状态（回放跳步要能恢复）
      deploy: [state.deploy[0], state.deploy[1]],
      deployBonus: [state.deployBonus[0], state.deployBonus[1]],
      redeployPending: [[...state.redeployPending[0]], [...state.redeployPending[1]]],
      flameOwner: [...state.flameOwner.entries()].sort((a, b) => a[0] - b[0]),
      // bugv11 #5/#6：双子星窗口 / 各技能释放次数（首次免费靠它判定）
      twinStar: [state.twinStar[0], state.twinStar[1]],
      sabotageBonus: [state.sabotageBonus[0], state.sabotageBonus[1]],
      bloomCheaperNext: [state.bloomCheaperNext[0], state.bloomCheaperNext[1]],
      skillCasts: [[...state.skillCasts[0]], [...state.skillCasts[1]]],
      // bugv34：黑夜 / 天气（回放跳步要能恢复）
      nightPhase: state.nightPhase,
      nightCountdown: state.nightCountdown,
      nightTurns: state.nightTurns,
      turnsSinceNight: state.turnsSinceNight,
      weather: state.weather,
      attacksLaunched: [state.attacksLaunched[0], state.attacksLaunched[1]],
      nightAttackBase: [state.nightAttackBase[0], state.nightAttackBase[1]],
      nightFromStart: state.nightFromStart,
      // bugv25：攻击阶段存下真快照，回放的"总攻击数"才不会显示成 0
      ...(state.phase === 'awaitingDefense' && state.attack ? { attackSnapshot: { ...state.attack } } : {}),
    }
  }

  /**
   * 正在播放的事件批次（bugv9 #9）。
   *
   * 每调用一次 `runEvents()` 就把这批事件原样存进这一步快照，
   * 回放时按事件重播动画就能"和真实对局一样"。
   */
  /**
   * bugv25：自上次快照依赖的**全部**事件（跨多次 `runEvents` 累积）。
   *
   * 一次"行动"可能由多次 `runEvents` 组成（AI 先放技能、再落子），
   * 回放的一步要包含它们的并集。`snapshotStep` / `snapshotSkillStep` 消费后清空。
   * （以前这里叫 `currentBatch`，只看"最近一批" ⇒ 技能事件全丢。）
   */
  let stepBuffer: GameEvent[] = []
  /** 回放时不要写历史 / 不要弹结算（bugv9 #9）。 */
  let recording = true

  /** 事件是纯数据，深拷贝一份避免回放 / 后续修改互相影响。 */
  function cloneEvent(event: GameEvent): GameEvent {
    return JSON.parse(JSON.stringify(event)) as GameEvent
  }

  /** 把"该步之后的魔力植物"写回快照（植物变化发生在落子/结算之后）。 */
  function touchStepMagic(): void {
    if (stepLog.length === 0) return
    stepLog[stepLog.length - 1].magic = [...engine.value.magic.values()].map((plant) => ({ ...plant }))
  }

  /** 播放期间把“棋盘写入模型”推迟到动画结束，避免视觉层与模型互相打架。 */
  let deferBoard = false

  /**
   * 当前是否处于攻击阶段（bugv11 #7）。
   *
   * 攻击阶段里 `atk` 差分只属于**发起攻击的一方**：防守方落子成线（对撞）时
   * 不能再改立绘，否则"进攻方刚切到 atk 又被顶回 idle"。
   */
  let attackPhaseActive = false

  /** 技能框流光持续多久（毫秒，bugv11 #2）。 */
  const SKILL_FLASH_MS = 2600
  let skillFlashTimer: ReturnType<typeof globalThis.setTimeout> | null = null

  /** 技能释放后让技能框高亮 + 流光一段时间（对手也能看见，bugv11 #2）。 */
  function flashSkill(player: PlayerIndex, slot: number): void {
    if (skillFlashTimer !== null) globalThis.clearTimeout(skillFlashTimer)
    ui.skillFlash = { player, slot, key: (ui.skillFlash?.key ?? 0) + 1 }
    skillFlashTimer = globalThis.setTimeout(() => {
      skillFlashTimer = null
      ui.skillFlash = null
    }, SKILL_FLASH_MS)
  }

  /** 应用单个事件到模型（与 3D 动画一一对应）。 */
  function applyEvent(event: GameEvent): void {
    const state = engine.value
    switch (event.type) {
      case 'stonePlaced':
        if (event.stacked) {
          // bugv10 #9 毒鸡蛋：叠在敌方棋子上 —— 底下的原棋子还在，只多一颗
          state.overlay.set(event.cell, event.player)
        } else {
          state.board[event.cell] = (event.player + 1) as Cell
        }
        if (!deferBoard) ui.board = state.board.slice()
        ui.lastMove = event.cell
        // bugv28 #2：记下这一手，回合结束后决定要不要给它加"上一步"光环
        if (ui.screen === 'playing') lastPlacement = { cell: event.cell, player: event.player, matched: false }
        // 新的落子：表情回到常态（bugv9 #13 的 win / lose / hit / atk 由此清掉）
        if (!ui.result) ui.expression = ['idle', 'idle']
        snapshotStep(event.player, event.cell, false)
        syncUi()
        break
      case 'defenderPlaced':
        if (!event.shattered) state.board[event.cell] = (event.player + 1) as Cell
        if (!deferBoard) ui.board = state.board.slice()
        ui.lastMove = event.cell
        // bugv28 #2：防守落子同样记一笔（未成线时也要标出来）
        if (ui.screen === 'playing') lastPlacement = { cell: event.cell, player: event.player, matched: false }
        snapshotStep(event.player, event.cell, true)
        syncUi()
        // bugv9 #6：被削弱 / 被抢走魔力植物后，攻击方悬浮的棋子要立刻少掉相应数量
        syncStageCount(other(event.player))
        break
      case 'matchFormed':
        pendingMatch = true
        if (stepLog.length > 0) stepLog[stepLog.length - 1].match = true
        // bugv28 #2：这一手成了连珠 —— 连珠棋子会被移除，不用再标"上一步"
        if (lastPlacement) lastPlacement.matched = true
        // bugv9 #13：完成连珠的一方切到 atk 差分。
        // bugv20 #2：攻击阶段里防守方反击成线时，**也要切 atk**（与攻击方一致），
        // 而不是被旧逻辑挡回去、等 attackResolved 再给结果。
        ui.expression = matchExpression(event.match.owner, ui.expression, attackPhaseActive)
        break
      case 'stonesRemoved':
        {
          // bugv10 #9：`kept` 里的格子只飞走了叠上去的那一颗，底下的原棋子留下
          const kept = new Set(event.kept ?? [])
          for (const cell of event.cells) {
            if (kept.has(cell)) state.overlay.delete(cell)
            else state.board[cell] = 0
          }
        }
        if (!deferBoard) ui.board = state.board.slice()
        // 结算后更新该步快照（攻击阶段移除棋子后才是最终形态）
        if (stepLog.length > 0) stepLog[stepLog.length - 1].board = state.board.slice()
        syncUi()
        // 两侧的悬浮棋子补到总攻击数（魔力植物 +N 时也要补出对应的棋子）
        syncStageCount()
        break
      case 'highlightShown':
        // 攻击方成线：棋盘进入攻击配色（bugv9 #4：在双方特征色之间循环，
        // 之前这里漏了 setAttackMode(true)，实战里棋盘一直是黑的）
        attackPhaseActive = true
        scene.value?.setAttackMode(true)
        /**
         * bugv25「最不绕弯子」（seedance 2 技能）：它的攻击**没有连珠棋子、没有高光格**
         * （`cells` 为空），所以普通攻击靠 `stonesRemoved` 把棋子飞上舞台的那条路走不通 ——
         * 结果就是"技能特效一闪，然后什么都不像在打人"。
         *
         * 这里按攻击值直接把悬浮棋子摆出来，配合已经打开的结算面板，
         * 让"用技能后**直接进入攻击阶段**"在画面上成立。
         */
        if (event.cells.length === 0) syncStageCount()
        syncUi()
        break
      case 'diceRolled':
        ui.dice = { rolls: [event.rolls[0], event.rolls[1]], first: event.first }
        ui.rolling = false
        syncUi()
        break
      case 'attackResolved': {
        // bugv29 #4：「杀鲸霸拳」的速度线维持到攻击阶段结束
        clearSpeedLine()
        attackPhaseActive = false
        ui.attack = event.snapshot
        ui.attackPanelOpen = true
        // 有伤害时：界面血量进入“逐颗推进”模式（bugv2 #1）
        damagePending = event.damage > 0 && event.snapshot.damaged !== null
        // bugv9 #13 / bugv20 #1：表情差分。
        // 受击方的 `hit` 已经由撞击回调在**第一颗棋子撞上血条时**切好了；
        // 这里只负责补"这一手谁赢"的另一侧，并保证被打死的那一方停在 `lose`。
        const snapshot = event.snapshot
        const attacker = snapshot.attacker
        const defender = other(attacker)
        /**
         * bugv27 #2：判"被打死"不能只看引擎血量。
         *
         * 回放路径里事件是"只播动画、不重跑引擎"的，而 `attackResolved` 在事件序列里
         * **排在 `hpChanged` 之前** ⇒ 这一行跑的时候 `engine.hp` 还是旧值，于是
         * "最后一颗棋子撞完"会把已经切好的 `lose` 顶回 `hit`（用户实测）。
         * 逐颗撞击已经把 `ui.hp` 推到最终值，因此两者取其一为 ≤0 即算倒下。
         */
        const down = (player: PlayerIndex) => engine.value.hp[player] <= 0 || ui.hp[player] <= 0
        const hurt = (player: PlayerIndex): Expression => (down(player) ? 'lose' : 'hit')
        if (snapshot.mode === 'immune') {
          // 伤害被完全挡下（精密计算 / 双子星）：没有撞击，两边都回默认
          ui.expression = ['idle', 'idle']
        } else if (event.clashCount > 0) {
          if (snapshot.damaged !== null) {
            const face = hurt(snapshot.damaged)
            ui.expression = snapshot.damaged === 0 ? [face, 'win'] : ['win', face]
          } else {
            ui.expression = ['idle', 'idle']
          }
        } else {
          // 防守方没挡住：攻击方赢下这一手，防守方受伤（被打死则 lose）
          const face = hurt(defender)
          ui.expression = attacker === 0 ? ['win', face] : [face, 'win']
        }
        break
      }
      case 'hpChanged':
        // 模型血量立刻更新，但界面血量要等“逐颗撞击”播完再落定（bugv2 #1）
        state.hp[event.player] = event.to
        if (stepLog.length > 0) stepLog[stepLog.length - 1].hp = [state.hp[0], state.hp[1]]
        if (!damagePending) {
          ui.hp = [state.hp[0], state.hp[1]]
          syncUi()
        }
        break
      // --- 魔力植物（bugv8 #4） ---------------------------------------------
      case 'magicGrown':
        for (const plant of event.plants) {
          // bugv17 #7：逐棵归属优先（「布局」九宫格里既有空格也有棋子）
          const owner = plant.owner !== undefined ? plant.owner : (event.owner ?? null)
          state.magic.set(plant.cell, { cell: plant.cell, kind: plant.kind, owner })
        }
        state.magicGrowths = event.growth
        syncUi()
        touchStepMagic()
        break
      case 'magicClaimed':
        state.magic.set(event.cell, { cell: event.cell, kind: event.kind, owner: event.player })
        syncUi()
        touchStepMagic()
        break
      case 'magicRemoved':
        for (const cell of event.cells) state.magic.delete(cell)
        syncUi()
        touchStepMagic()
        break
      case 'magicReverted':
        // bugv34 补充：雷暴结束 → 场上的污染体变回普通魔力植物（归属保留）
        for (const plant of event.plants) {
          const current = state.magic.get(plant.cell)
          if (current) state.magic.set(plant.cell, { ...current, kind: plant.kind })
        }
        syncUi()
        break
      // --- 黑夜与天气（bugv34，规格见 Weather.md） --------------------------
      case 'nightPending':
        ui.nightPhase = 'pending'
        ui.nightCountdown = event.countdown
        ui.hint = `黑夜即将降临 · 剩余 ${event.countdown} 回合`
        syncUi()
        break
      case 'nightFell':
        ui.nightPhase = 'active'
        ui.nightCountdown = 0
        ui.weather = event.weather
        state.nightPhase = 'active'
        state.weather = event.weather
        ui.hint = `黑夜降临 · ${weatherDef(event.weather).name}`
        scene.value?.setNight(true)
        syncUi()
        break
      case 'nightEnded':
        ui.nightPhase = 'none'
        ui.nightCountdown = 0
        ui.weather = null
        state.nightPhase = 'none'
        state.weather = null
        ui.hint = '天亮了'
        scene.value?.setNight(false)
        syncUi()
        break
      case 'lightningStruck':
        ui.hint = '雷暴：闪电落下，长出污染体'
        syncUi()
        break
      case 'attackStoneSplit':
        ui.hint = `瘟疫：攻击棋子分裂给双方`
        syncUi()
        break
      // --- 角色技能（bugv9 #13） -------------------------------------------
      case 'magicConsumed':
        for (const cell of event.cells) state.magic.delete(cell)
        syncUi()
        touchStepMagic()
        break
      case 'shieldChanged':
        state.shield[event.player] = event.to
        if (!damagePending) ui.shield = [state.shield[0], state.shield[1]]
        // bugv29 #4：护盾到手 → 立绘播一次镜面反光（2 秒）
        if (event.to > event.from) ui.shieldFlash[event.player] += 1
        syncUi()
        break
      case 'armorBroken':
        // bugv31「力大砖飞」：护盾 / 临时护甲被一击**打碎**（不是被伤害逐点磨掉）
        // → 受伤方立绘播一次「镜面破碎」
        ui.armorBreak[event.player] += 1
        syncUi()
        break
      case 'bonusActionsChanged':
        state.bonusActions[event.player] = event.to
        ui.bonusActions = [state.bonusActions[0], state.bonusActions[1]]
        break
      case 'skillUsed':
        ui.hint = `${players[event.player].name} 使用了 ${event.skillName}`
        // bugv11 #2：技能框高亮 + 流光一段时间（对手也能看见他用了技能）
        flashSkill(event.player, event.slot)
        // bugv29 #4：两个"大场面"技能各配一段全屏演出
        if (event.effect === 'fireball') showFireScreen()
        if (event.effect === 'double') showSpeedLine(event.player)
        syncUi()
        break
      // --- bugv10 #9：新角色的技能 -------------------------------------------
      case 'stoneShattered':
        // 棋子落在烈焰上直接碎裂：棋盘上不会出现这颗子
        ui.hint = `${players[event.player].name} 的棋子落在烈焰上，还没成形就碎了`
        syncUi()
        break
      case 'flamesIgnited':
        // ⚠️ bugv11 #1：这里**不能**把 `event.turns`（回合数）写回模型。
        // 引擎内部按"半回合"存（回合数 ×2），写回会导致烈焰提前烧完；
        // 更糟的是配合下面的 `flamesChanged` 会把剩余回合反复顶回去，烈焰永远不灭。
        // 引擎的 `flames` 在事件产生时就已是最终值，模型直接跟随即可。
        ui.hint = `${event.cells.length} 个空位被烈焰覆盖（燃烧 ${event.turns} 回合）`
        syncUi()
        break
      case 'flamesChanged':
        // 同上：`event.remaining` 只是给表现层展示用的“最旺那一处”，不能回写模型
        syncUi()
        break
      case 'flamesCleared':
        // 引擎已删掉这些格子，模型跟随
        syncUi()
        break
      case 'twinStarChanged':
        state.twinStar[event.player] = event.active
        if (event.active) {
          // bugv11 追加 #2：双子星不再长植物，只给"两连即可攻击 + 免反击"的窗口
          ui.hint = `${players[event.player].name} 的双子星已就绪：本回合两连即可发起攻击，并免疫反击伤害`
        }
        syncUi()
        break
      case 'immuneChanged':
        state.immuneUntil[event.player] = event.active ? event.until : 0
        syncUi()
        break
      case 'powerChanged':
        state.powerBonus[event.player] = event.to
        syncUi()
        break
      case 'sabotageChanged':
        state.sabotage[event.player] = event.active
        syncUi()
        break
      case 'bloomRewarded':
        // bugv12 #3：双子星条件奖励 —— 冷却已退还 + 下一次免费（syncUi 会从引擎重读）
        ui.hint = `${players[event.player].name} 的双子星达成连击：本次不进冷却，下一次释放免费`
        syncUi()
        break
      case 'highlightsCleared':
        attackPhaseActive = false
        syncUi()
        break
      case 'turnStarted':
        ui.current = event.player
        // bugv29 #4：「杀鲸霸拳」没用出连珠 → 换手时速度线直接结束
        if (ui.speedLine && ui.speedLine.player !== event.player) clearSpeedLine()
        // 注意（bugv9 #13）：这里**不能**把表情重置成 idle ——
        // 一次防守回合的最后一个事件就是 turnStarted，会把刚切好的 win / lose / hit 顶掉。
        // 表情统一在新的落子（stonePlaced）时重置。
        syncUi()
        // 攻击阶段结束：面板再保留一小段时间展示结算结果
        if (ui.attackPanelOpen) {
          clearAttackPanelTimer()
          attackPanelTimer = globalThis.setTimeout(closeAttackPanel, ATTACK_PANEL_LINGER)
        }
        break
      case 'gameOver':
        ui.result = event.result
        // bugv29 #2：对局结束后"上一步落子"高亮必须摘掉（结算面板会一直挂着，圈着棋子很脏）
        lastPlacement = null
        ui.lastMark = null
        scene.value?.setLastMark(null)
        // bugv29 #4：速度线属于"回合内演出"，对局结束必须收掉
        clearSpeedLine()
        // bugv9 #13：分出胜负 → 胜方 win、负方 lose（等 1 秒再弹结算）
        if (event.result.winner === null) ui.expression = ['idle', 'idle']
        else ui.expression = event.result.winner === 0 ? ['win', 'lose'] : ['lose', 'win']
        if (recording) pushHistory(event.result)
        syncUi()
        if (recording && !scene.value) scheduleResult()
        break
      default:
        break
    }
  }

  /** 记录一局对战（供回放）：写进内存列表并立刻持久化（bugv6 #4）。 */
  function pushHistory(result: GameResult): void {
    if (stepLog.length === 0) return
    const record = buildRecord({
      id: ui.mode === 'online' && online.matchId ? online.matchId : undefined,
      mode: ui.mode,
      steps: stepLog,
      result,
      durationMs: matchStartedAt > 0 ? Date.now() - matchStartedAt : 0,
      playerNames: [players[0].name, players[1].name],
      serverId: ui.mode === 'online' && online.matchId ? online.matchId : undefined,
      // bugv10 #11：把双方角色一起存下来，回放时才能用同一套技能表
      characters: [characters[0], characters[1]],
    })
    history.unshift(record)
    if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT
    persistReplays(history)
  }

  /** 删除一局回放（bugv6 #4）。 */
  function deleteReplay(id: MatchRecord['id']): void {
    const index = history.findIndex((record) => record.id === id)
    if (index >= 0) history.splice(index, 1)
    if (replay.record?.id === id) {
      replay.record = null
      replay.total = 0
      replay.index = 0
    }
    persistReplays(history)
  }

  /** 清空本地回放。 */
  function clearHistory(): void {
    history.length = 0
    clearReplays()
  }

  /**
   * 重置"本局录像"（bugv9 #9）。
   *
   * 宿主（或自动化脚本）用 `loadScenario` 直接摆局面时不会走 `startMatch()`，
   * 这时调用它可以把上面积累的步骤清掉，保证接下来保存的回放只包含本局。
   */
  function resetRecording(): void {
    stepLog = []
    pendingMatch = false
    stepBuffer = []
    matchStartedAt = Date.now()
  }

  /** 播放一组事件（含串行动画）。 */
  async function runEvents(
    events: GameEvent[],
    options: { rolling?: boolean; replay?: boolean } = {},
  ): Promise<void> {
    const token = ++playToken
    ui.busy = true
    ui.hint = ''
    if (options.rolling) ui.rolling = true
    const controller = scene.value
    controller?.setInteractive(false)
    controller?.setIdle(false)
    if (engine.value.highlights.size > 0) controller?.setHighlightWeights(engine.value.highlights)

    const aborted = () => token !== playToken
    // 播放期间模型只做“记账”，棋盘快照在动画结束后统一提交
    deferBoard = Boolean(controller)
    // 回放重播：不写历史、不弹结算（bugv9 #9）
    const previousRecording = recording
    if (options.replay) recording = false
    // bugv25：累积到"本步"的事件里（一次行动可能有多批：技能一批、落子一批）
    if (recording) stepBuffer.push(...events)
    /**
     * 引擎在 commit()/defend() 里已经把血量算到最终值，
     * 因此只要本次事件会改变血量，就立刻锁住界面血量，
     * 由“逐颗撞击”回调逐次扣减（bugv2 #1）。
     *
     * 回放路径下引擎还没被改动（事件是"将要播出"的），所以直接看事件里有没有扣血。
     */
    const hpBefore: [number, number] = [engine.value.hp[0], engine.value.hp[1]]
    const uiHpBefore: [number, number] = [ui.hp[0], ui.hp[1]]
    /**
     * bugv20 #3：只看 `hpChanged` 是不够的 —— 伤害被**临时护甲 / 护盾完全吸收**时
     * 根本没有 `hpChanged`，于是逐颗撞击期间 `damagePending` 一直是 false：
     * 血条不逐格扣，`syncUi()` 还会把护甲/护盾直接刷成最终值（"没有过程，直接出结果"）。
     * 所以把"护甲 / 护盾被**扣减**"也算进来（注意只认减少，施放技能**增加**护盾不算）。
     */
    const willChangeVitals =
      events.some(
        (event) =>
          event.type === 'hpChanged' ||
          (event.type === 'shieldChanged' && event.to < event.from) ||
          (event.type === 'tempArmorChanged' && event.to < event.from),
      ) ||
      hpBefore[0] !== uiHpBefore[0] ||
      hpBefore[1] !== uiHpBefore[1]
    if (willChangeVitals) damagePending = true
    /**
     * 进入结算动画前先对齐视觉：把模型里仍在棋盘上的棋子补齐，
     * 已经上舞台的棋子（stagedByCell）不会被误回收，因此对撞仍然可见。
     */
    const onSettled = (event: GameEvent): Promise<void> | void => {
      if (!controller) return
      if (event.type === 'attackResolved') {
        return controller.syncBoardAsync(engine.value.board)
      }
      // bugv5 #7 / bugv9 #3：落子后若"只差一颗子即可连珠"，沿这些方向拉出很长的针状提示线；
      // "2 + 1 中间空一格"（X X _ X）也会被识别，并把要补的那一格圈出来
      if (event.type === 'stonePlaced' || event.type === 'defenderPlaced') {
        const hints = threatHints(engine.value.board, event.player, event.cell)
        if (hints.length > 0) controller.showThreatHints(event.cell, hints, event.player)
        return
      }
      return
    }

    try {
      if (controller) {
        await controller.playEvents(events, { shouldAbort: aborted, onSettled })
      } else {
        for (const event of events) {
          if (aborted()) return
          applyEvent(event)
        }
      }
    } finally {
      deferBoard = false
      recording = previousRecording
      if (token === playToken) {
        ui.busy = false
        ui.rolling = false
        ui.hint = ''
        ui.board = engine.value.board.slice()
        // 逐颗撞击播放完毕：界面血量落到模型最终值（bugv2 #1）
        damagePending = false
        ui.hp = [engine.value.hp[0], engine.value.hp[1]]
        ui.lastDamage = [0, 0]
        syncUi()
        refreshHudRects()
        syncInteractive()
        afterStateSettled()
      }
    }
  }

  /** 一局开始（含掷骰子）。 */
  async function startMatch(): Promise<void> {
    clearAttackPanelTimer()
    clearResultTimer()
    playToken += 1
    // bugv10 #8：选了"随机角色"的两方在开局时各抽一次
    rollRandomCharacters()
    // bugv10 追加 #4：开局先把立绘复位（上一局结束时的 win / lose 不能带进新一局）
    resetExpressions()
    // bugv11 #2：上一局的技能流光也不能带进新一局
    resetSkillFlash()
    // 本地对局用设置里的魔力植物配置（联机在 startOnlineMatch 里固定用默认值）
    // bugv34：非联机用设置里的血量上限（8/12/16），联机固定用默认值
    // bugv34 补充：非联机的黑夜设置（含"黑夜开局"）也在这里下发（联机固定用默认值）
    engine.value = new GameEngine({
      initialHp: matchHpCap.value,
      magic: ui.mode === 'online' ? null : magicConfig,
      night: ui.mode === 'online' ? null : ui.nightConfig,
      skills: engineSkills(),
    })
    stepLog = []
    pendingMatch = false
    matchStartedAt = Date.now()
    ui.screen = 'setup'
    ui.phase = UI_PHASE.rolling
    ui.result = null
    ui.showResult = false
    ui.showReplay = false
    ui.showSettings = false
    ui.attack = null
    ui.attackPanelOpen = false
    ui.highlights = []
    ui.highlightWeights = []
    ui.lastMove = null
    lastPlacement = null
    // bugv29 #4：新一局要把上一局的全屏演出收干净
    clearFireScreen()
    clearSpeedLine()
    ui.shieldFlash = [0, 0]
    ui.armorBreak = [0, 0]
    // bugv34：新一局把黑夜 / 天气状态收干净
    ui.nightPhase = 'none'
    ui.nightCountdown = 0
    ui.weather = null
    scene.value?.setNight(false)
    ui.dice = null
    ui.rolling = true
    ui.diceVisible = true
    ui.busy = true
    ui.tally = [0, 0]
    syncSceneFromEngine()
    syncUi()

    const events = engine.value.takeEvents()
    await runEvents(events, { rolling: true })
    // 动画播完后进入正式对局；棋盘的可交互性由 syncInteractive() 统一管理，
    // 骰子浮层淡出之前一律不可落子（bugv4 #2）
    if (ui.screen === 'setup') ui.screen = 'playing'
    syncUi()
    syncInteractive()
    afterStateSettled()
    // 兜底：骰子浮层（组件）会在淡出后回调 hideDice；这里再保一层，
    // 免得宿主没挂骰子组件时棋盘一直锁着
    if (diceTimer !== null) globalThis.clearTimeout(diceTimer)
    diceTimer = globalThis.setTimeout(hideDice, DICE_LINGER)
    // 开始对局的点击同样是一次用户手势，可以顺势起播背景音乐
    unlockAudio()
  }

  /** 重开一局（重掷骰子）。 */
  async function restart(): Promise<void> {
    if (ui.mode === 'online') {
      // 联机对局不能本地重开：回到大厅重新匹配
      leaveOnlineMatch()
      openOnlineLobby()
      return
    }
    await startMatch()
  }

  // -------------------------------------------------------------------------
  // 联机（bugv6 #8）
  // -------------------------------------------------------------------------

  /** 进入联机大厅。 */
  function openOnlineLobby(): void {
    playToken += 1
    clearAttackPanelTimer()
    stopReplayTimer()
    ui.mode = 'online'
    ui.screen = 'online'
    ui.showResult = false
    ui.showReplay = false
    ui.showSettings = false
    ui.showGameMenu = false
    ui.attackPanelOpen = false
    ui.attack = null
    ui.busy = false
    ui.result = null
    ui.diceVisible = false
    ui.highlights = []
    ui.tally = [0, 0]
    replay.playing = false
    players[0].isAi = false
    players[1].isAi = false
    // bugv10 追加 #4：进大厅也把立绘复位
    resetExpressions()
    resetSkillFlash()
    showMenuScene()
    // bugv11 追加 #7：进联机大厅**自动连上内置后端**（地址不再让玩家填）
    if (!onlineClient.connected) connectOnline()
  }

  /** 保存服务器地址（设置面板 / 大厅都能改）。 */
  function setServerUrl(url: string): void {
    onlineClient.setIdentity(online.name, url)
    online.serverUrl = onlineClient.serverUrl
  }

  /** 连接服务器（地址可覆盖）。 */
  function connectOnline(url?: string): void {
    onlineClient.setIdentity(online.name, url)
    online.serverUrl = onlineClient.serverUrl
    online.message = ''
    onlineClient.connect(online.serverUrl)
    online.connected = onlineClient.connected
  }

  /** 断开连接。 */
  function disconnectOnline(): void {
    onlineClient.disconnect()
    online.status = 'offline'
    online.connected = false
    online.message = ''
  }

  /**
   * 把本端要用的角色告诉联机客户端（bugv10 #11）。
   *
   * 联机时"我"用的是先手位那一份角色配置；如果玩家选了"随机"，
   * 就在发请求之前抽一次（抽到什么由服务端在 `matched` 里确认）。
   */
  function prepareOnlineCharacter(): void {
    if (ui.characterRandom[0]) applyCharacter(0, pickRandomCharacter())
    onlineClient.character = characters[0]
  }

  /**
   * 已经为哪个 matchId 搭好了镜像引擎（bugv34e）。
   *
   * 用途：`roomState` 在"房间里正在对局"时会要求客户端去 `sync`，
   * 但整页刷新后镜像引擎还没建过 —— 必须**先用房间设置**建一份，
   * 否则 `loadScenario` 会作用在一份配置不对（血量上限 / 魔力植物 / 黑夜不同）的引擎上，
   * 指纹立刻漂移。
   */
  let onlineEngineFor: string | null = null

  /**
   * 按**房间设置**搭建联机镜像引擎（bugv34e）。
   *
   * ⚠️ 两端必须用同一份设置（服务端裁决用的就是房间设置），否则每一步指纹都会对不上。
   */
  function prepareOnlineEngine(settings: OnlineRoomSettings | null): void {
    online.hpLimit = settings?.hpLimit ?? INITIAL_HP
    engine.value = new GameEngine({
      initialHp: online.hpLimit,
      autoRoll: false,
      magic: (settings?.magic as MagicConfig | undefined) ?? null,
      night: (settings?.night as NightConfig | undefined) ?? DEFAULT_NIGHT_CONFIG,
      skills: engineSkills(),
    })
  }

  /** 在线匹配。 */
  function onlineQueue(): void {
    online.message = '正在匹配…'
    online.room = null
    prepareOnlineCharacter()
    onlineClient.queue(online.name)
    if (!onlineClient.connected) connectOnline()
  }

  /** 取消匹配 / 取消房间。 */
  function onlineCancel(): void {
    onlineClient.cancelQueue()
    online.message = ''
  }

  /** 创建房间（bugv34e：创建后进入房间，等房主点开始）。 */
  function onlineCreateRoom(): void {
    online.message = '正在创建房间…'
    prepareOnlineCharacter()
    onlineClient.createRoom(online.name)
    if (!onlineClient.connected) connectOnline()
  }

  /** 用房间号加入。 */
  function onlineJoinRoom(code: string): void {
    const clean = code.trim().toUpperCase()
    if (!clean) return
    online.message = '正在加入房间…'
    online.joinCode = clean
    prepareOnlineCharacter()
    onlineClient.joinRoom(clean, online.name)
    if (!onlineClient.connected) connectOnline()
  }

  /** 凭房间号回到房间（断线 / 刷新后回来）。 */
  function onlineRejoinRoom(code: string): void {
    const clean = code.trim().toUpperCase()
    if (!clean) return
    online.message = '正在回到房间…'
    online.joinCode = clean
    prepareOnlineCharacter()
    onlineClient.rejoinRoom(clean, online.name)
    if (!onlineClient.connected) connectOnline()
  }

  /** 房间设置（仅房主；服务端会校验）。 */
  function setRoomSettings(patch: OnlineRoomSettingsPatch): void {
    onlineClient.setRoomSettings(patch)
  }

  /** 房间里改自己的角色。 */
  function pickRoomCharacter(characterId: string): void {
    const id = findCharacter(characterId).id
    onlineClient.character = id
    onlineClient.pickCharacter(id)
    // 本地也立刻切一下自己的角色（服务端广播回来后会再对齐一次）
    const selfSeat = online.room?.you === undefined ? null : online.seat
    if (selfSeat !== null) applyCharacter(selfSeat, id)
  }

  /** 发送聊天。 */
  function sendRoomChat(text: string): void {
    const clean = text.trim()
    if (!clean) return
    onlineClient.chat(clean)
  }

  /** 在房间内切换聊天栏展开状态。 */
  function toggleRoomChat(open?: boolean): void {
    online.chatOpen = open ?? !online.chatOpen
    if (online.chatOpen) online.chatUnread = 0
    syncUi()
  }

  /** 转让房主。 */
  function transferRoomHost(toPlayerId: string): void {
    onlineClient.transferHost(toPlayerId)
  }

  /** 点「准备」/ 取消准备（bugv34i：双方都准备 → 服务端自动开局）。 */
  function setRoomReady(ready: boolean): void {
    onlineClient.setReady(ready)
  }

  // --- 账号（bugv34i） ------------------------------------------------------

  /** 登录；账号不存在时服务端会回 `userNotFound`，面板自动切到「注册」。 */
  function onlineLogin(username: string, password: string): void {
    if (online.authBusy) return
    online.authBusy = true
    online.authMessage = ''
    if (!onlineClient.connected) connectOnline()
    onlineClient.login(username.trim(), password)
    // 未连上时客户端会把请求记成"待发意图"，握手完成后自动补发
    globalThis.setTimeout(() => {
      if (online.authBusy && !onlineClient.connected) online.authBusy = false
    }, 6000)
  }

  /** 注册（昵称必填 —— 它取代了原来设置里的"联机昵称"）。 */
  function onlineRegister(username: string, password: string, nickname: string): void {
    if (online.authBusy) return
    online.authBusy = true
    online.authMessage = ''
    if (!onlineClient.connected) connectOnline()
    onlineClient.register(username.trim(), password, nickname.trim())
    globalThis.setTimeout(() => {
      if (online.authBusy && !onlineClient.connected) online.authBusy = false
    }, 6000)
  }

  /**
   * 登录面板唯一的提交入口（bugv34k）。
   *
   * - 还没确认过账号 → 先按**登录**试（服务端回 `userNotFound` 会自动切到注册流程）；
   * - 已经处于注册流程（账号不存在）→ 直接**注册并登录**。
   */
  function onlineAuthSubmit(username: string, password: string, nickname: string): void {
    if (online.authMode === 'register') onlineRegister(username, password, nickname)
    else onlineLogin(username, password)
  }

  /** 切换登录面板的「登录 / 注册」（现在只由"账号不存在"自动触发）。 */
  function setAuthMode(mode: 'login' | 'register'): void {
    online.authMode = mode
    online.authMessage = ''
  }

  /** 退出登录（作废令牌，回到登录面板）。 */
  function onlineLogout(): void {
    onlineClient.logout()
    online.user = null
    online.room = null
    online.code = ''
    online.authMode = 'login'
    online.authMessage = ''
    online.message = ''
    if (ui.mode === 'online') {
      ui.screen = 'online'
      showMenuScene()
    }
    syncUi()
  }

  /** 主动退出房间。 */
  function leaveRoom(): void {
    onlineClient.leaveRoom()
    online.room = null
    online.code = ''
    online.chatOpen = false
    online.chatUnread = 0
    online.message = ''
    syncUi()
  }

  /** 认输并退出对局。 */
  function onlineResign(): void {
    onlineClient.resign()
    onlineClient.leave()
    openOnlineLobby()
  }

  /** 离开当前对局（不认输，直接回大厅）。 */
  function leaveOnlineMatch(): void {
    if (onlineClient.matchId) {
      onlineClient.leave()
    }
    online.matchId = ''
    online.seq = 0
  }

  /** 关闭大厅回到主菜单。 */
  function closeOnlineLobby(): void {
    onlineClient.cancelQueue()
    leaveOnlineMatch()
    backToMenu()
  }

  /**
   * 服务端判定开局（`matched`）：用服务端的骰子结果开局。
   *
   * 联机模式双方都不是 AI，客户端**只**负责播放服务端确认的每一步。
   */
  async function startOnlineMatch(info: OnlineMatched): Promise<void> {
    clearAttackPanelTimer()
    if (diceTimer !== null) {
      globalThis.clearTimeout(diceTimer)
      diceTimer = null
    }
    playToken += 1
    // bugv10 #11：联机也用同一套技能表，角色由服务端在 `matched` 里下发
    if (Array.isArray(info.characters)) {
      applyCharacter(0, findCharacter(info.characters[0]).id)
      applyCharacter(1, findCharacter(info.characters[1]).id)
      ui.characterRandom = [false, false]
    }
    // bugv8 #4 / bugv34e：联机用**房间设置**（血量上限 / 魔力植物 / 黑夜），
    // 也就是服务端裁决用的那一份 —— 两端必须完全一致，否则第一步指纹就漂移。
    // 缺省（老服务端 / 旧消息）退回引擎默认值。
    const roomSettings = info.settings ?? online.room?.settings ?? null
    prepareOnlineEngine(roomSettings)
    onlineEngineFor = info.matchId
    stepLog = []
    pendingMatch = false
    matchStartedAt = Date.now()
    ui.mode = 'online'
    ui.screen = 'setup'
    ui.phase = UI_PHASE.rolling
    ui.result = null
    ui.showResult = false
    ui.showReplay = false
    ui.showSettings = false
    ui.showGameMenu = false
    ui.attack = null
    ui.attackPanelOpen = false
    ui.highlights = []
    ui.highlightWeights = []
    ui.lastMove = null
    lastPlacement = null
    // bugv29 #4：新一局要把上一局的全屏演出收干净
    clearFireScreen()
    clearSpeedLine()
    ui.shieldFlash = [0, 0]
    ui.armorBreak = [0, 0]
    // bugv34：新一局把黑夜 / 天气状态收干净
    ui.nightPhase = 'none'
    ui.nightCountdown = 0
    ui.weather = null
    scene.value?.setNight(false)
    ui.dice = null
    ui.rolling = true
    ui.diceVisible = true
    ui.busy = true
    ui.tally = [0, 0]
    players[0].isAi = false
    players[1].isAi = false
    // 联机昵称由服务器下发，视为"自定义"，不再跟随角色名（bugv10 追加 #8）
    customNames[0] = true
    customNames[1] = true
    players[info.seat].name = online.name
    players[other(info.seat)].name = info.opponent
    resetExpressions()
    resetSkillFlash()
    syncSceneFromEngine()
    syncUi()

    // 直接用服务端掷出的点数开局（两端必须一致，不能各自重掷）
    engine.value.setFirstPlayer(info.dice.first, info.dice.rolls)
    await runEvents(engine.value.takeEvents(), { rolling: true })
    if (ui.screen === 'setup') ui.screen = 'playing'
    syncUi()
    syncInteractive()
    if (diceTimer !== null) globalThis.clearTimeout(diceTimer)
    diceTimer = globalThis.setTimeout(hideDice, DICE_LINGER)
    unlockAudio()
  }

  /** 本地局面指纹（与服务端比对，用于发现漂移）。 */
  function localDigest(): string {
    const state = engine.value
    return stateDigest({
      board: state.board,
      hp: state.hp,
      phase: state.phase,
      current: state.current,
      firstPlayer: state.firstPlayer,
      highlightOwner: state.highlightOwner,
      highlights: state.highlights,
      magic: state.magic,
      magicGrowths: state.magicGrowths,
      magicCooldown: state.magicCooldown,
      // bugv10 #11：技能状态也必须参与比对，否则两端会各算各的
      shield: state.shield,
      bonusActions: state.bonusActions,
      actionsTaken: state.actionsTaken,
      skillReadyAt: state.skillReadyAt,
      turnNo: state.turnNo,
      immuneUntil: state.immuneUntil,
      powerUntil: state.powerUntil,
      flames: state.flames,
      overlay: state.overlay,
      // bugv11 #5/#6：双子星窗口与技能释放次数同样必须两端一致
      twinStar: state.twinStar,
      sabotage: state.sabotage,
      sabotageBonus: state.sabotageBonus,
      bloomCheaperNext: state.bloomCheaperNext,
      skillCasts: state.skillCasts,
      tempArmor: state.tempArmor,
      tempArmorUntil: state.tempArmorUntil,
      strikeBonus: state.strikeBonus,
      strikeUntil: state.strikeUntil,
      seedGrow: state.seedGrow,
      noPlantBonus: state.noPlantBonus,
      // bugv34m：Qwen 的两个技能状态（本地部署窗口/加伤 + 小千问待部署表）
      deploy: state.deploy,
      deployBonus: state.deployBonus,
      redeployPending: state.redeployPending,
      flameOwner: state.flameOwner,
      // bugv34：黑夜 / 天气 / 攻击棋子计数（两端必须一致，否则每一步都会重新 sync）
      nightPhase: state.nightPhase,
      nightCountdown: state.nightCountdown,
      nightTurns: state.nightTurns,
      turnsSinceNight: state.turnsSinceNight,
      weather: state.weather,
      attacksLaunched: state.attacksLaunched,
      nightAttackBase: state.nightAttackBase,
      nightFromStart: state.nightFromStart,
    })
  }

  /** 服务端确认一步：本地重放同样的规则并播动画（服务端权威）。 */
  async function applyOnlineMove(message: OnlineApplied): Promise<void> {
    const state = engine.value
    if (ui.mode !== 'online' || !online.matchId || message.matchId !== online.matchId) return
    if (message.seq !== online.seq + 1) {
      // 漏包 / 乱序：直接要一份完整局面
      onlineClient.requestSync()
      return
    }
    online.seq = message.seq
    if (message.seat === online.seat) pendingOnlineMove = null
    if (state.isOver) return
    if (state.current !== message.seat) {
      onlineClient.requestSync()
      return
    }
    let events: GameEvent[]
    try {
      if (message.kind === 'skill') {
        // bugv10 #11：技能也由服务端裁决，本地只是重跑同一份引擎
        events = state.useSkill(message.seat, message.slot ?? 0, message.cells ?? [], message.target ?? null)
      } else {
        events = message.kind === 'defend' ? state.defend(message.cell) : state.commit(message.cell)
      }
    } catch (error) {
      console.error('[connect4] 联机操作与本地状态不一致，重新同步', error)
      onlineClient.requestSync()
      return
    }
    await runEvents(events)
    if (localDigest() !== message.digest) {
      onlineClient.requestSync()
    }
  }

  /** 服务端下发完整局面：直接重建本地模型与场景（断线重连 / 漂移自愈）。 */
  async function applyOnlineState(message: OnlineStateMessage): Promise<void> {
    if (ui.mode !== 'online' || message.matchId !== online.matchId) return
    const state = engine.value
    // bugv34e：断线重连 / 整页刷新回来时，座位只能从 `state` 里拿（没有 `matched` 消息）
    online.seat = (message.seat === 1 ? 1 : 0) as PlayerIndex
    onlineClient.seat = online.seat
    const highlights = new Map<number, number>(message.highlights)
    const magic = message.magic ?? []
    // bugv10 #11：两端必须用同一套技能表（由座位上的角色决定）
    if (Array.isArray(message.characters)) {
      applyCharacter(0, findCharacter(message.characters[0]).id)
      applyCharacter(1, findCharacter(message.characters[1]).id)
    }
    state.loadScenario(message.board as Board, {
      hp: [message.hp[0], message.hp[1]],
      phase: message.phase as typeof state.phase,
      current: message.current,
      firstPlayer: message.firstPlayer ?? undefined,
      attacker: message.highlightOwner ?? undefined,
      highlights,
      lineLengthSum: message.attack?.lineLengthSum ?? 0,
      magic,
      magicGrowths: message.magicGrowths,
      magicCooldown: message.magicCooldown,
      magicLineSeen: message.magicLineSeen,
      shield: message.shield,
      bonusActions: message.bonusActions,
      actionsTaken: message.actionsTaken,
      skillReadyAt: message.skillReadyAt,
      lastPlacedBy: message.lastPlacedBy,
      turnNo: message.turnNo,
      immuneUntil: message.immuneUntil,
      powerUntil: message.powerUntil,
      flames: message.flames,
      overlay: message.overlay,
      powerBonus: message.powerBonus,
      sabotage: message.sabotage,
      sabotageBonus: message.sabotageBonus,
      twinStar: message.twinStar,
      bloomCheaperNext: message.bloomCheaperNext,
      skillCasts: message.skillCasts,
      tempArmor: message.tempArmor,
      tempArmorUntil: message.tempArmorUntil,
      strikeBonus: message.strikeBonus,
      strikeUntil: message.strikeUntil,
      seedGrow: message.seedGrow,
      noPlantBonus: message.noPlantBonus,
      // bugv34m：Qwen 的两个技能状态也要一起恢复
      deploy: message.deploy,
      deployBonus: message.deployBonus,
      redeployPending: message.redeployPending,
      flameOwner: message.flameOwner,
      // bugv34：黑夜 / 天气状态也要一起恢复
      nightPhase: message.nightPhase,
      nightCountdown: message.nightCountdown,
      nightTurns: message.nightTurns,
      turnsSinceNight: message.turnsSinceNight,
      weather: message.weather ?? null,
      attacksLaunched: message.attacksLaunched,
      nightAttackBase: message.nightAttackBase,
      nightFromStart: message.nightFromStart ?? false,
    })
    state.attack = message.attack
    state.result = message.result
    // bugv34：把 UI / 场景的黑夜状态对齐到刚恢复的局面
    ui.nightPhase = message.nightPhase ?? 'none'
    ui.nightCountdown = message.nightCountdown ?? 0
    ui.weather = message.weather ?? null
    scene.value?.setNight(ui.nightPhase === 'active')
    online.seq = message.seq
    pendingOnlineMove = null
    playToken += 1
    ui.busy = false
    scene.value?.resetTransient()
    syncSceneFromEngine()
    syncUi()
    syncInteractive()
    // bugv28 #2 / #4：重建后把"上一步"光环与倒计时一起对齐
    refreshLastMark()
    armOnlineDeadline()
  }

  /**
   * 拉取服务器上的回放（MongoDB 持久化，bugv6 #4 / #8）。
   *
   * bugv34k：登录后按**账号**拉 —— 同一账号换设备 / 换浏览器也看得到自己的对局。
   */
  async function refreshOnlineReplays(limit = 20): Promise<number> {
    online.loadingReplays = true
    try {
      const docs = await onlineClient.fetchReplays(limit, undefined, online.user?.username)
      online.replays = docs.map((doc: OnlineReplayDoc) => OnlineClient.toRecord(doc))
      const who = online.user ? `账号 ${online.user.username}` : '本机身份'
      online.message = online.replays.length > 0 ? `服务器上有 ${online.replays.length} 局回放（${who}）` : `服务器上还没有回放（${who}）`
      return online.replays.length
    } catch (error) {
      online.message = `拉取服务器回放失败：${error instanceof Error ? error.message : String(error)}`
      return 0
    } finally {
      online.loadingReplays = false
    }
  }

  /** 播放一条服务器回放。 */
  function openOnlineReplay(record: MatchRecord): void {
    openReplay(record, 'online')
  }

  /** 回到开始菜单。 */
  function backToMenu(): void {
    playToken += 1
    clearAttackPanelTimer()
    clearResultTimer()
    stopReplayTimer()
    // bugv28 #4：回主菜单不再计时
    clearOnlineDeadline()
    lastPlacement = null
    // bugv29 #4：全屏演出一起收掉
    clearFireScreen()
    clearSpeedLine()
    ui.shieldFlash = [0, 0]
    ui.armorBreak = [0, 0]
    // bugv34：新一局把黑夜 / 天气状态收干净
    ui.nightPhase = 'none'
    ui.nightCountdown = 0
    ui.weather = null
    scene.value?.setNight(false)
    ui.screen = 'menu'
    // bugv9 #8：返回主菜单时必须把菜单 / 设置浮层一起关掉，
    // 否则会出现"已经回到主菜单，但菜单还盖在上面"的情况
    ui.showGameMenu = false
    ui.showSettings = false
    ui.showResult = false
    ui.showReplay = false
    ui.attackPanelOpen = false
    ui.attack = null
    ui.busy = false
    ui.result = null
    // bugv10 追加 #4：回主菜单时立绘复位
    resetExpressions()
    resetSkillFlash()
    // bugv11 追加 #8：模式复位成"人机对战" —— 从联机大厅回来时菜单里的模式还停在
    // 「联机对战」，点开始游戏又会跑回大厅，容易让人以为没退出
    ui.mode = 'pve'
    players[0].isAi = false
    players[1].isAi = true
    ui.diceVisible = false
    replay.playing = false
    showMenuScene()
  }

  /**
   * 人类点击棋盘。
   *
   * 注意：这里**不**判断骰子浮层 —— 骰子期间棋盘已经通过 `syncInteractive()` 变成不可交互，
   * 真实点击在 3D 层就被拦掉了（bugv4 #2）；而程序化调用（测试 / 宿主）不受浮层影响。
   */
  async function handleCellPick(cell: number): Promise<void> {
    // 技能挑选阶段：点的是魔力植物 / 目标格，不是落子（bugv9 #13 / bugv10 #9）
    if (ui.skillSelect) {
      const select = ui.skillSelect
      if (select.stage === 'cell') {
        // 恶龙吐息：棋盘上任意位置都能当目标
        select.target = cell
        await castSkill()
        return
      }
      pickSkillPlant(cell)
      return
    }
    if (ui.screen !== 'playing' || ui.busy || engine.value.isOver) return
    // bugv10 #7：点棋盘就收起技能气泡
    ui.skillBubble = null

    // bugv10 #9 毒鸡蛋：当前回合可以下在敌方棋子上，但必须"下上去就能连珠"
    const state = engine.value
    if (state.board[cell] !== 0 && state.sabotage[state.current]) {
      if (!state.canStackAt(cell)) {
        ui.hint = '毒鸡蛋只能下在"下上去就能形成连珠"的敌方棋子上'
        return
      }
      if (!state.sabotageTargets(state.current).includes(cell)) {
        ui.hint = '这一格下上去无法形成连珠，只能换一个位置'
        return
      }
    }

    // 联机：只把落子意图发给服务端，等 `applied` 回来再动模型（服务端权威）
    if (ui.mode === 'online') {
      if (online.matchId === '' || ui.current !== online.seat) return
      if (!engine.value.canPlaceAt(cell)) return
      ui.busy = true
      pendingOnlineMove = cell
      // 发送失败要立刻告诉用户，不能静默卡住（bugv7 #1）
      if (!onlineClient.move(cell)) {
        pendingOnlineMove = null
        ui.busy = false
        online.message = onlineClient.connected
          ? '落子请求发送失败，请重试'
          : '与服务器的连接已断开，正在重连…'
        syncInteractive()
        return
      }
      // 服务端没回应时不要把棋盘锁死（例如连接已断）
      globalThis.setTimeout(() => {
        if (pendingOnlineMove !== cell) return
        pendingOnlineMove = null
        if (ui.mode === 'online' && !engine.value.isOver) {
          online.message = '服务器没有响应，请检查连接后重试'
          ui.busy = false
          syncInteractive()
        }
      }, 4000)
      return
    }

    if (engine.value.awaitingDefense) {
      if (!engine.value.canPlaceAt(cell)) return
      await runEvents(engine.value.defend(cell))
      return
    }
    if (!engine.value.awaitingPlacement) return
    if (isAiTurn.value) return
    if (!engine.value.canPlaceAt(cell)) return
    await runEvents(engine.value.commit(cell))
  }

  /** 状态稳定后：轮到 AI 就自动落子。 */
  function afterStateSettled(): void {
    // bugv28 #2：每回合稳定后刷新"上一步落子"光环
    refreshLastMark()
    const state = engine.value
    if (ui.screen !== 'playing') {
      // bugv28 #4：离开对局就不再计时
      clearOnlineDeadline()
      return
    }
    // bugv28 #4：联机时重新定"本回合结束的世界时间"
    armOnlineDeadline()
    if (state.isOver) return
    if (!shouldAiMove()) return
    // 使用 globalThis，保证在 SSR / 测试环境下同样可用
    globalThis.setTimeout(() => {
      void playAiMove()
    }, 260)
  }

  function shouldAiMove(): boolean {
    const state = engine.value
    if (state.isOver || ui.busy || ui.screen !== 'playing') return false
    // 骰子浮层还盖在棋盘上时谁都不能落子，AI 也一样（bugv4 #2）
    if (ui.diceVisible) return false
    if (state.phase === 'playing') {
      if (ui.mode === 'eve') return true
      if (ui.mode === 'pve' && players[state.current].isAi) return true
      return false
    }
    if (state.phase === 'awaitingDefense') {
      const defender = other(state.highlightOwner ?? 0)
      if (ui.mode === 'eve') return true
      if (ui.mode === 'pve' && players[defender].isAi) return true
      return false
    }
    return false
  }

  // -------------------------------------------------------------------------
  // 联机倒计时（bugv28 #4）
  // -------------------------------------------------------------------------

  /** 展示刷新用的 rAF 句柄（不是倒计时逻辑，只负责读时间差）。 */
  let deadlineRaf = 0

  /** 清掉倒计时（离开对局 / 对局结束 / 非法模式）。 */
  function clearOnlineDeadline(): void {
    online.deadline = 0
    online.deadlineTotal = 0
    online.deadlineKind = null
    online.remainingMs = 0
    if (deadlineRaf) {
      globalThis.cancelAnimationFrame?.(deadlineRaf)
      deadlineRaf = 0
    }
  }

  /**
   * 给当前回合定一个**结束的世界时间**（bugv28 #4）。
   *
   * 需求明确要求"不要用计时器"：这里只把 `Date.now() + 时限` 记下来，
   * 剩余时间一律由展示层反推，所以后台切页面、掉帧都不会让倒计时漂移。
   */
  function armOnlineDeadline(): void {
    if (ui.mode !== 'online' || !isOnlinePlaying.value || ui.screen !== 'playing' || engine.value.isOver) {
      clearOnlineDeadline()
      return
    }
    const defense = engine.value.phase === 'awaitingDefense'
    const total = (defense ? ONLINE_DEFENSE_SECONDS : ONLINE_PLACE_SECONDS) * 1000
    online.deadlineTotal = total
    online.deadlineKind = defense ? 'defense' : 'place'
    online.deadline = Date.now() + total
    online.remainingMs = total
    startDeadlineLoop()
  }

  /**
   * 展示刷新循环：只做"读时间差 → 写 `remainingMs`"。
   *
   * 用 rAF（与渲染同频）而不是 setInterval 自减，符合"不要用计时器"的要求。
   */
  function startDeadlineLoop(): void {
    if (deadlineRaf) return
    const raf = globalThis.requestAnimationFrame?.bind(globalThis)
    if (!raf) return
    const tick = (): void => {
      if (online.deadline <= 0) {
        deadlineRaf = 0
        return
      }
      const remaining = online.deadline - Date.now()
      online.remainingMs = remaining > 0 ? remaining : 0
      if (remaining <= 0) {
        deadlineRaf = 0
        onOnlineDeadlineExpired()
        return
      }
      deadlineRaf = raf(tick)
    }
    deadlineRaf = raf(tick)
  }

  /**
   * 倒计时归零：轮到自己时在**随机位置**自动落子，并响一声提示音（bugv28 #4）。
   *
   * 服务端权威 —— 只有"该我行动"时才托管；对手的超时由对手客户端自己触发，
   * 我们这边只负责显示，直到收到对方向服务端提交的 `applied`。
   */
  function onOnlineDeadlineExpired(): void {
    if (ui.mode !== 'online' || !isOnlinePlaying.value || engine.value.isOver) return
    if (ui.busy || pendingOnlineMove !== null) return
    const state = engine.value
    const myTurn = state.awaitingDefense ? humanDefense.value : isMyOnlineTurn.value
    if (!myTurn) return
    const cell = pickTimeoutCell()
    if (cell === null) return
    scene.value?.audio.play('timeout')
    ui.busy = true
    pendingOnlineMove = cell
    if (!onlineClient.move(cell)) {
      pendingOnlineMove = null
      ui.busy = false
      syncInteractive()
      return
    }
    globalThis.setTimeout(() => {
      if (pendingOnlineMove !== cell) return
      pendingOnlineMove = null
      if (ui.mode === 'online' && !engine.value.isOver) {
        ui.busy = false
        syncInteractive()
      }
    }, 4000)
  }

  /** 随机挑一个当前合法的落子格（超时托管用）。 */
  function pickTimeoutCell(): number | null {
    const state = engine.value
    const cells: number[] = []
    for (let i = 0; i < CELL_COUNT; i++) if (state.canPlaceAt(i)) cells.push(i)
    if (cells.length === 0) return null
    return cells[Math.floor(Math.random() * cells.length)]
  }

  /** 倒计时展示信息（状态条 / 立绘旁用）。 */
  const onlineCountdown = computed(() => {
    const active =
      ui.mode === 'online' &&
      online.deadline > 0 &&
      ui.screen === 'playing' &&
      isOnlinePlaying.value &&
      !engine.value.isOver
    const total = online.deadlineTotal
    const remaining = active ? online.remainingMs : 0
    const phaseDefense = engine.value.phase === 'awaitingDefense'
    return {
      active,
      /** 向上取整的剩余秒数。 */
      seconds: active ? Math.ceil(remaining / 1000) : 0,
      /** 剩余比例（画进度环）。 */
      ratio: active && total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0,
      kind: online.deadlineKind,
      /** 正在倒计时的那一方：防守阶段是防守方，否则是当前落子方。 */
      side: (phaseDefense ? other(engine.value.highlightOwner ?? 0) : engine.value.current) as PlayerIndex,
      /** 剩余 ≤5 秒时高亮提醒。 */
      urgent: active && remaining <= 5000,
    }
  })

  async function playAiMove(): Promise<void> {
    const state = engine.value
    if (state.isOver || ui.busy || !shouldAiMove()) return
    const expectedPhase = state.phase

    if (state.phase === 'awaitingDefense') {
      const defender = other(state.highlightOwner ?? 0)
      ui.busy = true
      // 放到 worker 里算：强档单步要几百毫秒，主线程要留给动画（bugv5 #4）
      const decision = await ai.decide({
        board: state.board,
        player: defender,
        selfHp: state.hp[defender],
        opponentHp: state.hp[other(defender)],
        mode: 'defend',
        highlightWeights: state.highlights,
        // bugv14：技能打出来的攻击（「最直接、最不绕弯子」）没有高光格，
        // 必须显式告诉 AI 攻击值，否则它会把来袭伤害算成 0。
        attackBaseDamage: state.attack?.baseDamage,
        // bugv17 #4：攻击方连珠上的植物加伤**在宣告攻击时就随棋子一起删掉了**，
        // 防守方按当前棋盘重算只会得到 0 → 会低估来袭伤害。这里把锁定的棵数传过去。
        attackPlants: state.attack?.attackerPlants,
        difficulty: aiDifficultyFor(),
        magic: aiMagicContext(state),
        // bugv13 #2：防守搜索同样要用技能产生的**状态**（护盾 / 增伤 / 无敌 / 烈焰 / 叠子）。
        // 之前这里只传了 magic，导致防守时把这些全按 0 算 → 误判来袭伤害。
        skills: aiSkillContext(state),
      })
      ui.busy = false
      if (engine.value !== state || state.isOver || state.phase !== expectedPhase) return
      if (decision.move < 0 || !state.canPlaceAt(decision.move)) return
      await runEvents(state.defend(decision.move))
      return
    }

    const player = state.current
    ui.busy = true
    const decision = await ai.decide({
      board: state.board,
      player,
      selfHp: state.hp[player],
      opponentHp: state.hp[other(player)],
      mode: 'attack',
      difficulty: aiDifficultyFor(),
      magic: aiMagicContext(state),
      skills: aiSkillContext(state),
    })
    ui.busy = false
    if (engine.value !== state || state.isOver || state.phase !== expectedPhase) return

    // 技能"用完不交回合"，所以先把技能按顺序放掉，再落子（bugv9 #13）
    let lastSkillUse: AiSkillUse | null = null
    for (const use of decision.skills ?? []) {
      if (engine.value !== state || state.isOver) return
      if (state.phase !== 'playing' || state.current !== player) break
      // ⚠️ bugv17 #9：必须用 `applyAiSkill` 的**返回值**。
      // `GameEngine.useSkill()` 结尾是 `return this.takeEvents()` —— 它取走事件时顺带清空了缓冲；
      // 以前这里丢掉返回值再 `takeEvents()` 拿到的是**空数组**，于是 AI 放的技能
      // （最明显的是 gtp「恶龙吐息」）状态改了、特效一个都不演：没有火球、没有火焰。
      const events = applyAiSkill(state, player, use)
      if (!events) break
      lastSkillUse = use
      await runEvents(events)
    }
    if (engine.value !== state || state.isOver) return
    if (state.phase !== 'playing' || state.current !== player) {
      /**
       * bugv25：技能用完后**不再落子**（典型「最不绕弯子」：用完直接进攻击阶段）。
       *
       * 这条路径以前**不产生任何回放步骤** ⇒ 回放里那次攻击凭空出现、
       * 悬浮"总攻击数"显示 0。这里补记一步（`cell = -1`），技能事件也就被保住了。
       */
      if (lastSkillUse) snapshotSkillStep(player, lastSkillUse)
      return
    }

    // 落点校验：技能没放成（或落点变得不合法）时退回一个合法落点，绝不卡住
    let move = decision.move
    if (move < 0 || !state.canPlaceAt(move)) {
      const legal = state.legalMoves().filter((cell) => state.canPlaceAt(cell))
      const safe = legal.find((cell) => !state.flames.has(cell))
      const pick = safe ?? legal[0]
      if (pick === undefined) return
      move = pick
    }
    await runEvents(state.commit(move))
  }

  /**
   * 把 AI 计划里的一个技能落到引擎上。
   *
   * 返回 `null` = 这个技能放不了（植物被挤掉 / 冷却变了 / 目标格非法…），
   * 调用方应停止后续技能并直接落子；否则返回这一步产生的事件（**必须**拿去播动画，
   * 见 bugv17 #9）。
   */
  function applyAiSkill(state: GameEngine, player: PlayerIndex, use: AiSkillUse): GameEvent[] | null {
    const skill = state.skillStateFor(player, use.slot)
    if (!skill || !skill.ready) return null
    // bugv14：可变消耗技能（「最直接、最不绕弯子」）的合法植物数是一个**区间**，
    // 不能再用 `=== skillCostNow()` 去卡 —— 那样多选的候选会被全部拒掉。
    // bugv31：首次免费的可变消耗技能（恶龙吐息）合法数量是 **0**，也不能按区间卡。
    const freeNow = state.isFirstFree(player, use.slot)
    const min = freeNow ? 0 : (skill.costMin ?? skill.costNow)
    const max = freeNow ? 0 : (skill.costMax ?? skill.costNow)
    const cells = (use.cells ?? []).filter((cell) => state.magic.get(cell)?.owner === player)
    if (cells.length < min || cells.length > max) return null
    if (skill.targetsCell) {
      const target = use.target
      if (target === undefined || target < 0 || target >= CELL_COUNT) return null
      return state.useSkill(player, use.slot, cells, target)
    }
    return state.useSkill(player, use.slot, cells)
  }

  // --- HUD 位置（用于棋子撞击血条） ---
  function refreshHudRects(): void {
    const controller = scene.value
    if (!controller) return
    const query = (player: PlayerIndex) =>
      document.querySelector<HTMLElement>(`[data-player-panel="${player}"]`)?.getBoundingClientRect()
    const rect0 = query(0)
    const rect1 = query(1)
    controller.setHudRects({ 0: rect0, 1: rect1 })
    // bugv10 #9：技能槽的位置（「小一哥」的额外攻击棋子从技能槽里飞出来）
    const skillBar = (player: PlayerIndex) =>
      document.querySelector<HTMLElement>(`[data-skill-bar="${player}"]`)?.getBoundingClientRect()
    const bar0 = skillBar(0)
    const bar1 = skillBar(1)
    controller.setSkillRects({ 0: bar0, 1: bar1 })

    // bugv26 #3：技能槽的 `top` 与结算面板的 `max-height` 都依赖**实测几何**。
    //
    // 以前 `--hud-reserve` 是纯 CSS 预算（立绘高度 + 固定内边距），一旦 HUD 里多出
    // 一行内容（比如立绘旁的"连续行动 / 伤害 +N"徽章）就估短了 ⇒ 技能槽被压在徽章上。
    // 现在直接用**实测的面板下沿**当预留高度，并且顺手算出"技能槽下沿"给结算面板封顶
    // （它是贴底绝对定位的，短窗口下会往上顶进技能槽）。
    const root = document.querySelector<HTMLElement>('.app-root')
    if (root) {
      const hudBottom = Math.max(rect0?.bottom ?? 0, rect1?.bottom ?? 0)
      if (hudBottom > 0) root.style.setProperty('--hud-reserve', `${Math.ceil(hudBottom)}px`)
      else root.style.removeProperty('--hud-reserve')

      const barBottom = Math.max(bar0?.bottom ?? 0, bar1?.bottom ?? 0)
      if (barBottom > 0) {
        const limit = Math.floor(window.innerHeight - barBottom - 26)
        root.style.setProperty('--attack-card-max-h', `${Math.max(140, limit)}px`)
      } else {
        root.style.removeProperty('--attack-card-max-h')
      }
    }
  }

  async function setMode(mode: GameMode): Promise<void> {
    if (mode === 'online') {
      openOnlineLobby()
      return
    }
    ui.mode = mode
    // AI 对战（观战）时两边都是 AI；双人 / 联机时两边都是人类
    players[0].isAi = mode === 'eve'
    players[1].isAi = mode === 'pve' || mode === 'eve'
    if (ui.screen === 'playing' || ui.screen === 'setup') {
      await restart()
    } else {
      showMenuScene()
    }
  }

  /**
   * 该用哪一档棋力（bugv4 #9）。
   *
   * AI 对战（观战）时固定用最强的一档，这样"看 AI 下棋"看到的是这个 bot 的上限。
   */
  function aiDifficultyFor(): AiDifficulty {
    return ui.mode === 'eve' ? 'expert' : ui.difficulty
  }

  /**
   * 传给 AI 的魔力植物上下文（阶段二）。
   *
   * 只给**棋盘上看得见的**植物。未来植物长在哪几格是确定性派生的，但玩家不知道，
   * AI 也不许"提前看到"（见 `AiMagicContext` 的公平性说明）。
   */
  function aiMagicContext(state: GameEngine): AiMagicContext {
    return {
      plants: [...state.magic.values()].map(
        (plant) => [plant.cell, plant.owner] as [number, PlayerIndex | null],
      ),
      damagePerPlant: state.magicConfig.damagePerPlant,
    }
  }

  /**
   * 传给 AI 的角色技能上下文（阶段三）。
   *
   * 技能表、冷却、护盾、增伤、无敌、烈焰、叠子……这些都是**界面上公开可见**的信息
   * （双方技能槽与状态都直接显示、棋盘上的火与叠子也看得见），所以可以原样交给 AI。
   * 唯一不给的是"对手下一步想干什么"—— 那不是信息，是读心。
   */
  function aiSkillContext(state: GameEngine): AiSkillContext {
    return {
      skills: state.skills,
      shield: [state.shield[0], state.shield[1]],
      bonusActions: [state.bonusActions[0], state.bonusActions[1]],
      actionsTaken: [state.actionsTaken[0], state.actionsTaken[1]],
      skillReadyAt: [state.skillReadyAt[0].slice(), state.skillReadyAt[1].slice()],
      skillCasts: [state.skillCasts[0].slice(), state.skillCasts[1].slice()],
      powerBonus: [state.powerBonus[0], state.powerBonus[1]],
      powerUntil: [state.powerUntil[0], state.powerUntil[1]],
      sabotage: [state.sabotage[0], state.sabotage[1]],
      sabotageBonus: [state.sabotageBonus[0], state.sabotageBonus[1]],
      twinStar: [state.twinStar[0], state.twinStar[1]],
      bloomCheaperNext: [state.bloomCheaperNext[0], state.bloomCheaperNext[1]],
      immuneUntil: [state.immuneUntil[0], state.immuneUntil[1]],
      // bugv14：临时护甲 / 深度思考 / 播种 / 烈焰归属 —— 这四项不传，
      // AI 会把对手的护甲与自己的烈焰行走能力全部按 0 算（就上轮那个透传坑）。
      tempArmor: [state.tempArmor[0], state.tempArmor[1]],
      tempArmorUntil: [state.tempArmorUntil[0], state.tempArmorUntil[1]],
      strikeBonus: [state.strikeBonus[0], state.strikeBonus[1]],
      strikeUntil: [state.strikeUntil[0], state.strikeUntil[1]],
      seedGrow: [state.seedGrow[0], state.seedGrow[1]],
      // bugv19：「杀鲸霸拳」低消耗档 → 本回合本方植物不加伤（不传 AI 会高估自己那一手）
      noPlantBonus: [state.noPlantBonus[0], state.noPlantBonus[1]],
      // bugv34m：Qwen 的两个技能状态（不传 AI 会漏掉「本地部署」的 +1 与待部署棋子）
      deploy: [state.deploy[0], state.deploy[1]],
      deployBonus: [state.deployBonus[0], state.deployBonus[1]],
      redeployPending: [state.redeployPending[0].slice(), state.redeployPending[1].slice()],
      turnNo: state.turnNo,
      flames: [...state.flames.entries()],
      flameOwner: [...state.flameOwner.entries()] as Array<[number, number]>,
      overlay: [...state.overlay.entries()] as Array<[number, number]>,
      // bugv34：血量上限跟随本局（非联机 = 设置值），AI 才能正确评估残血比例
      initialHp: matchHpCap.value,
    }
  }

  async function toggleMode(): Promise<void> {
    const order: GameMode[] = ['pve', 'pvp', 'eve']
    const next = order[(order.indexOf(ui.mode) + 1) % order.length]
    await setMode(next)
  }

  function setDifficulty(difficulty: AiDifficulty): void {
    ui.difficulty = difficulty
  }

  /** 运行中更新配色（设置面板；棋盘与舞台棋子一起更新）。 */
  function setPlayerColor(player: PlayerIndex, presetIndex: number): void {
    const preset = COLOR_PRESETS[presetIndex]
    if (!preset) return
    const current = players[player].palette
    // 棋子本体始终是黑白，这里只换特征色（bugv3 #8）
    players[player].palette = {
      color: preset.color,
      glow: preset.glow,
      deep: preset.deep,
      stone: current.stone,
    }
    scene.value?.setPalette(palette.value)
  }

  // -------------------------------------------------------------------------
  // 角色系统（bugv9 #13）
  // -------------------------------------------------------------------------

  /**
   * 给某一方换角色：特征色、立绘、技能表一起换（下一手立刻生效）。
   *
   * `'random'` 表示"随机角色"（bugv10 #8）：开始菜单里立刻抽一个展示，
   * 每次开始游戏（startMatch）再重新抽一次。
   */
  function setCharacter(player: PlayerIndex, id: CharacterId | 'random'): void {
    if (id === 'random') {
      ui.characterRandom[player] = true
      applyCharacter(player, pickRandomCharacter())
      return
    }
    ui.characterRandom[player] = false
    applyCharacter(player, id)
  }

  /** 随机抽一个角色 id。 */
  function pickRandomCharacter(): CharacterId {
    const pool = CHARACTERS
    return pool[Math.floor(Math.random() * pool.length)]?.id ?? DEFAULT_CHARACTERS[0]
  }

  /** 把角色真正应用到某一方（特征色 / 立绘 / 技能表）。 */
  function applyCharacter(player: PlayerIndex, id: CharacterId): void {
    const character = findCharacter(id)
    characters[player] = character.id
    players[player].character = character.id
    players[player].art = { ...character.art }
    // bugv10 追加 #8：昵称跟随角色名（玩家手动改过就保留）
    if (!customNames[player]) players[player].name = character.name
    applyCharacterPalette(player)
    scene.value?.setPalette(palette.value)
    // 引擎里的技能表同步替换（已经用掉 / 冷却中的技能保留当前冷却）
    const state = engine.value
    const next = engineSkills()
    state.skills = next
    state.skillReadyAt = [
      next[0].map((spec, slot) => state.skillReadyAt[0][slot] ?? spec.cooldown),
      next[1].map((spec, slot) => state.skillReadyAt[1][slot] ?? spec.cooldown),
    ]
    cancelSkillSelect()
    syncUi()
  }

  /** 立绘回到常态（bugv10 追加 #4：对局结束后要能复位，不能等下一颗子）。 */
  function resetExpressions(): void {
    ui.expression = ['idle', 'idle']
    attackPhaseActive = false
  }

  /** 清掉技能框的流光（重开一局 / 回菜单时，bugv11 #2）。 */
  function resetSkillFlash(): void {
    if (skillFlashTimer !== null) {
      globalThis.clearTimeout(skillFlashTimer)
      skillFlashTimer = null
    }
    ui.skillFlash = null
  }

  /** 关掉结算面板（"查看棋盘"）时把立绘恢复正常。 */
  function closeResult(): void {
    ui.showResult = false
    if (ui.result) resetExpressions()
  }

  /** 真正开始前给"随机"的两方各抽一个角色（bugv10 #8）。 */
  function rollRandomCharacters(): void {
    for (const player of [0, 1] as PlayerIndex[]) {
      if (ui.characterRandom[player]) applyCharacter(player, pickRandomCharacter())
    }
  }

  /** 自动把两个角色的特征色预热（图标生成要跑 canvas，提前做掉避免首帧闪）。 */
  function warmCharacterIcons(): void {
    for (const character of CHARACTERS) warmSkillIcons(character.skills, character.color, character.glow)
  }

  /** 开始为某个技能挑魔力植物（bugv9 #13 / bugv10 #11）。 */
  function beginSkill(player: PlayerIndex, slot: number): boolean {
    /**
     * bugv10 #7：点技能不再弹窗 —— 只是在技能旁边冒一个气泡显示详情 / 原因。
     */
    const bubble = (notice: string): false => {
      ui.skillBubble = { player, slot, notice }
      return false
    }
    if (ui.screen !== 'playing') return false
    if (players[player].isAi) {
      // 人机 / 观战模式下 AI 的角色不能被玩家代打
      return bubble('这是对手的角色，只能使用自己这一方的技能')
    }
    if (ui.mode === 'online' && (online.matchId === '' || player !== online.seat)) {
      return bubble('联机对局只能使用自己这一方的技能，并且要等轮到你')
    }
    const state = engine.value.skillStateFor(player, slot)
    if (!state) return false
    if (!state.ready) return bubble(state.reason ?? '暂时用不了')
    ui.skillBubble = { player, slot, notice: '' }
    // bugv11 #6：首次免费的技能（恶龙吐息）这一手一颗植物都不用挑，
    // 需要目标格的直接进入"点目标"，不需要目标格的当场释放。
    if (state.costNow <= 0) {
      if (state.targetsCell) {
        ui.skillSelect = {
          player,
          slot,
          need: 0,
          max: 0,
          picked: [],
          stage: 'cell',
          targetsCell: true,
          target: null,
        }
        ui.hint = `${state.name} 首次释放免费：再点棋盘上的任意位置作为火球目标`
        syncSkillSelectScene()
        return true
      }
      ui.skillSelect = { player, slot, need: 0, max: 0, picked: [], stage: 'plants', targetsCell: false, target: null }
      void castSkill()
      return true
    }
    // bugv14：可变消耗技能（「最直接、最不绕弯子」）可以自己决定交几棵
    const need = state.costMin ?? state.costNow
    const max = state.costMax ?? state.costNow
    ui.skillSelect = {
      player,
      slot,
      need,
      max,
      picked: [],
      stage: 'plants',
      targetsCell: state.targetsCell,
      target: null,
    }
    ui.hint =
      max > need
        ? state.effect === 'assault'
          ? `已选择 0/${need}~${max} 棵魔力植物（攻击值 = 消耗的植物数量，选满自动释放）`
            : state.minCostPenalty === 'noPlantBonus'
              ? `已选择 0/${need}~${max} 棵魔力植物（选 ${need} 棵会失去本回合的植物加伤）`
              : state.effect === 'fireball'
                ? `已选择 0/${need}~${max} 棵魔力植物（选 ${need} 棵只燃火、不碎子；选 ${max} 棵才直击碎子）`
                : `已选择 0/${need}~${max} 棵魔力植物`
        : `已选择 0/${need} 棵魔力植物`
    // 画面变暗 + 高亮我方魔力植物（需求原文，bugv10 #2 加强）
    syncSkillSelectScene()
    return true
  }

  /** 关掉技能气泡（点棋盘 / 点别处时调用，bugv10 #7）。 */
  function closeSkillBubble(): void {
    ui.skillBubble = null
  }

  /** 把"挑选魔力植物 / 选择目标格"的状态同步给 3D 层（bugv10 #2）。 */
  function syncSkillSelectScene(): void {
    const controller = scene.value
    if (!controller) return
    const select = ui.skillSelect
    if (!select) {
      controller.setSkillSelecting(null)
      controller.setTargeting(false)
      return
    }
    controller.setSkillSelecting(select.player, {
      picked: [...select.picked],
      stage: select.stage,
    })
    controller.setTargeting(select.stage === 'cell')
  }

  /** 取消挑选。 */
  function cancelSkillSelect(): void {
    ui.skillSelect = null
    ui.skillBubble = null
    ui.hint = ''
    scene.value?.setSkillSelecting(null)
    scene.value?.setTargeting(false)
  }

  /**
   * bugv32：火球两档的提示文案（gtp「恶龙吐息」）。
   *
   * 1 费档只燃火、不碎子；max 费档才直击碎子（bugv33 max 3→2）。两档都不结束回合。
   * 档位差别在**释放那一刻**体现，所以挑选过程中就要说清楚。
   */
  function fireballTierNote(player: PlayerIndex, slot: number, picked: number, need: number, max: number): string {
    const skillUi = ui.skills[player]?.[slot]
    if (skillUi?.effect !== 'fireball' || picked < need) return ''
    return picked >= max ? `（${max} 费：直击碎子 + 燃火）` : `（${need} 费：只燃火，不碎子）`
  }

  /**
   * 在棋盘上点了一棵魔力植物（挑选阶段）。
   *
   * 返回 true 表示这次点击已经消费掉了（不再当作落子）。
   */
  function pickSkillPlant(cell: number): boolean {
    const select = ui.skillSelect
    if (!select || select.stage !== 'plants') return false
    const plant = engine.value.magic.get(cell)
    if (!plant || plant.owner !== select.player) {
      ui.hint = '只能选择被我方棋子占用的魔力植物'
      return true
    }
    const index = select.picked.indexOf(cell)
    if (index >= 0) select.picked.splice(index, 1)
    else select.picked.push(cell)
    syncSkillSelectScene()
    // bugv14：可变消耗技能选满上限才自动释放；到下限之前不释放。
    // bugv27 #3：`select.max` 现在是**标称**上限（UI 恒显示 2~3 / 1~4），
    // 所以自动释放要取"标称上限"与"场上实际可选的棵数"的较小者。
    const ownedCount = engine.value.ownedPlants(select.player).length
    const auto = select.max > select.need ? Math.min(select.max, Math.max(select.need, ownedCount)) : select.need
    if (select.picked.length >= auto) {
      // bugv31：选到上限档位（不交回合的那种）时，也要把"还能继续行动"告诉玩家
      const note = fireballTierNote(select.player, select.slot, select.picked.length, select.need, select.max)
      if (select.targetsCell) {
        // 还要点一个目标位置（bugv10 #9 恶龙吐息）
        select.stage = 'cell'
        syncSkillSelectScene()
        ui.hint = `再点棋盘上的任意位置作为火球目标${note}`
      } else {
        void castSkill()
      }
      return true
    }
    // bugv32：火球两档的差别（1 费只燃火 / max 费碎子，bugv33 max 3→2）也要在选择过程中就告诉玩家
    const picked = select.picked.length
    const turnNote = fireballTierNote(select.player, select.slot, picked, select.need, select.max)
    ui.hint =
      select.max > select.need
        ? `已选择 ${picked}/${select.need}~${select.max} 棵魔力植物${
            turnNote || (picked >= select.need ? '（可以点「释放」了）' : '')
          }`
        : `已选择 ${picked}/${select.need} 棵魔力植物`
    return true
  }

  /**
   * 手动释放（bugv14）：可变消耗技能在 `need ~ max` 之间都可以放。
   *
   * 非可变消耗技能仍然走"选满自动释放"，这里只作为兜底。
   */
  async function confirmSkillSelect(): Promise<void> {
    const select = ui.skillSelect
    if (!select || select.stage !== 'plants') return
    if (select.picked.length < select.need) {
      ui.hint = `至少需要选择 ${select.need} 棵魔力植物`
      return
    }
    if (select.targetsCell) {
      select.stage = 'cell'
      syncSkillSelectScene()
      ui.hint = '再点棋盘上的任意位置作为火球目标'
      return
    }
    await castSkill()
  }

  /** 凑够植物（并且选好目标）了：真正释放技能。 */
  async function castSkill(): Promise<void> {
    const select = ui.skillSelect
    if (!select) return
    if (select.targetsCell && select.target === null) {
      ui.hint = '请先点一个目标位置'
      return
    }
    // 联机：只把技能意图发给服务端，等 `applied` 回来再动模型（服务端权威，bugv10 #11）
    if (ui.mode === 'online' && online.matchId !== '') {
      const { slot, picked, target } = select
      const seqBefore = online.seq
      cancelSkillSelect()
      ui.busy = true
      if (!onlineClient.skill(slot, picked, target)) {
        ui.busy = false
        online.message = onlineClient.connected
          ? '技能请求发送失败，请重试'
          : '与服务器的连接已断开，正在重连…'
        syncInteractive()
        return
      }
      // 服务端没回应时不要把棋盘锁死
      globalThis.setTimeout(() => {
        if (online.seq !== seqBefore || ui.mode !== 'online' || engine.value.isOver) return
        ui.busy = false
        online.message = '服务器没有响应，请检查连接后重试'
        syncInteractive()
      }, 4000)
      return
    }
    const state = engine.value
    let events: GameEvent[]
    try {
      events = state.useSkill(select.player, select.slot, select.picked, select.target)
    } catch (error) {
      showNotice({
        title: '技能释放失败',
        text: error instanceof Error ? error.message : String(error),
        action: '知道了',
        tone: 'warn',
      })
      cancelSkillSelect()
      return
    }
    cancelSkillSelect()
    const used = { slot: select.slot, cells: [...select.picked], target: select.target }
    await runEvents(events)
    /**
     * bugv25：人类用「最不绕弯子」这类**用完直接进攻击阶段**的技能时也不会再落子，
     * 同样要补记一步，否则回放里这一手凭空消失、攻击数显示 0。
     *
     * 通用兜底：用完技能后若回合已经交出去（`endsTurn` 技能 / 直接开打），
     * `phase` 变了或 `current` 换人了 —— 都补记一步技能快照。
     * （bugv32 起 gtp「恶龙吐息」不再结束回合，此兜底仍保留以备其它技能。）
     */
    if (
      recording &&
      engine.value === state &&
      !state.isOver &&
      (state.phase !== 'playing' || state.current !== select.player)
    ) {
      snapshotSkillStep(select.player, used)
    }
  }

  /** 技能槽的点击入口（正在挑选时再点一次 = 取消）。 */
  function toggleSkill(player: PlayerIndex, slot: number): void {
    const select = ui.skillSelect
    if (select && select.player === player && select.slot === slot) {
      cancelSkillSelect()
      return
    }
    beginSkill(player, slot)
  }

  function renamePlayer(player: PlayerIndex, name: string): void {
    const clean = name.slice(0, 8)
    // 清空 = 恢复跟随角色名（bugv10 追加 #8）
    if (!clean.trim()) {
      customNames[player] = false
      players[player].name = findCharacter(characters[player]).name
      return
    }
    customNames[player] = true
    players[player].name = clean
  }

  /** 跳过当前动画。 */
  function skipAnimations(): void {
    scene.value?.skipAnimations()
  }

  // -------------------------------------------------------------------------
  // 回放
  // -------------------------------------------------------------------------

  let replayTimer: ReturnType<typeof globalThis.setTimeout> | null = null

  function stopReplayTimer(): void {
    if (replayTimer !== null) {
      globalThis.clearTimeout(replayTimer)
      replayTimer = null
    }
  }

  /** 进入回放界面（默认回放最近一局）。 */
  function openReplay(record?: MatchRecord, returnTo: 'menu' | 'online' = 'menu'): void {
    const target = record ?? history[0]
    if (!target) return
    playToken += 1
    clearAttackPanelTimer()
    stopReplayTimer()
    ui.screen = 'replay'
    ui.showReplay = true
    ui.showResult = false
    ui.showSettings = false
    ui.busy = false
    ui.result = target.result
    ui.attack = null
    ui.attackPanelOpen = false
    ui.highlights = []
    ui.dark = false
    ui.diceVisible = false
    // bugv28 #2 / #4：回放不显示"上一步"光环，也不计倒计时
    lastPlacement = null
    clearOnlineDeadline()
    // bugv29 #4：回放不保留上一局的演出
    clearFireScreen()
    clearSpeedLine()
    ui.shieldFlash = [0, 0]
    ui.armorBreak = [0, 0]
    // bugv34：新一局把黑夜 / 天气状态收干净
    ui.nightPhase = 'none'
    ui.nightCountdown = 0
    ui.weather = null
    scene.value?.setNight(false)
    replay.returnTo = returnTo
    replay.record = target
    replay.playing = false
    replay.total = target.steps.length
    replay.codeMessage = ''
    // bugv10 #11：回放里也要用当时那套角色技能表
    if (Array.isArray(target.characters)) {
      applyCharacter(0, findCharacter(target.characters[0]).id)
      applyCharacter(1, findCharacter(target.characters[1]).id)
    } else {
      /**
       * bugv25 #1：**兜底** —— 老回放（以及早期导出的回放码）没存 `characters`，
       * 于是技能框会沿用"上一局"的角色（用户看到的就是"回放里技能不对"）。
       * 这里按玩家名反查角色（默认名就是角色名），查不到就保持原样。
       */
      const guess = (index: 0 | 1): CharacterId | null => {
        const name = target.playerNames?.[index]
        if (!name) return null
        const hit = CHARACTERS.find((character) => character.name === name)
        return hit ? hit.id : null
      }
      const left = guess(0)
      const right = guess(1)
      if (left) applyCharacter(0, left)
      if (right) applyCharacter(1, right)
    }
    scene.value?.setIdle(false)
    scene.value?.setInteractive(false)
    seekReplay(0)
    refreshHudRects()
  }

  /** 第 index 步之前那一步的事件（用来还原攻击阶段的高光 / 舞台）。 */
  function attackerHighlightsAt(record: MatchRecord, index: number): {
    owner: PlayerIndex
    cells: number[]
    weights: number[]
  } | null {
    // index 步本身是"防守方落子"时，攻击阶段是从上一步（攻击方成线）开始的
    const step = record.steps[index - 1]
    const next = record.steps[index]
    if (!step || !next) return null
    const isDefense = (next.events ?? []).some((event) => event.type === 'defenderPlaced')
    if (!isDefense) return null
    const shown = (step.events ?? []).find((event) => event.type === 'highlightShown')
    if (!shown || shown.type !== 'highlightShown') return null
    return { owner: shown.owner, cells: [...shown.cells], weights: [...shown.weights] }
  }

  /** 攻击阶段两侧的"总攻击数"（回放补舞台用）。 */
  function stageTally(): [number, number] {
    const snapshot = engine.value.attack
    if (!snapshot) return [0, 0]
    return [
      snapshot.attacker === 0 ? snapshot.finalAttack : snapshot.defenderAttack,
      snapshot.attacker === 1 ? snapshot.finalAttack : snapshot.defenderAttack,
    ]
  }

  /**
   * 把场景**瞬间**对齐到第 index 步（bugv9 #9）。
   *
   * 不做动画：先掐掉正在播的动画与特效，再按快照重建棋盘 / 魔力植物 / 血量 / 高光，
   * 因此快进快退时看到的就是"这一步的静态结果"，不会残留上一步的动画。
   */
  function seekReplay(index: number): void {
    const record = replay.record
    if (!record) return
    const clamped = Math.max(0, Math.min(index, record.steps.length))
    replay.index = clamped
    // 掐掉正在播的动画（含正在等待的 Promise，见 Animator.clear）
    playToken += 1
    const controller = scene.value
    controller?.skipAnimations()
    controller?.resetTransient()
    controller?.setIdle(false)
    controller?.setInteractive(false)
    ui.attackPanelOpen = false

    if (clamped === 0) {
      const empty = new Array<Cell>(BOARD_SIZE * BOARD_SIZE).fill(0)
      engine.value.loadScenario(empty, { hp: [INITIAL_HP, INITIAL_HP], current: 0, magic: [] })
      controller?.syncBoard(empty)
      controller?.syncMagic([])
      controller?.syncFlames([])
      controller?.syncOverlay(empty, [])
      // bugv34d：回到开局 = 白天（拖回开头时黑夜必须立刻退掉）
      controller?.setNight(false)
      ui.nightPhase = 'none'
      ui.nightCountdown = 0
      ui.weather = null
      ui.board = empty.slice()
      ui.hp = [INITIAL_HP, INITIAL_HP]
      ui.lastMove = null
      ui.current = record.steps[0]?.player ?? 0
      attackPhaseActive = false
      syncUi()
      return
    }

    const step = record.steps[clamped - 1]
    const magic = step.magic ?? []
    // 下一步是"防守方落子"时，本步停在攻击阶段：把高光与悬浮棋子都补出来，
    // 这样接着按播放就能看到完整的对撞 / 撞击血条动画（bugv9 #9）
    const highlights = attackerHighlightsAt(record, clamped)
    const highlightMap = new Map<number, number>(
      highlights ? highlights.cells.map((cell, i) => [cell, highlights.weights[i] ?? 1]) : [],
    )
    // bugv10 #9/#11：技能相关状态（护盾 / 连击 / 冷却 / 无敌 / 烈焰 / 叠子）也一起恢复
    const extra = step.extra
    /** bugv25：这一步的"真攻击快照"（详见下方注释）。 */
    const resolvedSnapshot = ((step.events ?? []).find((event) => event.type === 'attackResolved') as
      | Extract<GameEvent, { type: 'attackResolved' }>
      | undefined)?.snapshot
    /**
     * bugv25：这一步处于攻击阶段时，**用真快照**重建攻击上下文。
     *
     * 两个来源，缺一不可：
     * ① 防守步（`defense === true`）→ 用这一步自己的 `attackResolved.snapshot`
     *    （结算后的最终攻击值 / 反击值）。**旧回放里也有**，所以历史回放立刻修好；
     * ② 攻击宣告步 → 用存档里的 `extra.attackSnapshot`（新录制的回放才有）。
     */
    const attackSnapshot = extra?.attackSnapshot ?? resolvedSnapshot ?? null
    /** 是否要进入"攻击进行中"的舞台（防守步已结算，不再进）。 */
    const enterAttackStage = !step.defense && (highlights !== null || extra?.attackSnapshot !== undefined)
    const needAttackCtx = enterAttackStage || attackSnapshot !== null
    // bugv11 #7：跳步到这里时也把"是否处于攻击阶段"标出来，
    // 否则回放防守步时立绘会被防守方的连珠顶成 atk
    attackPhaseActive = enterAttackStage
    engine.value.loadScenario(step.board, {
      hp: step.hp,
      current: record.steps[clamped]?.player ?? step.player,
      magic,
      ...(extra
        ? {
            shield: extra.shield,
            bonusActions: extra.bonusActions,
            actionsTaken: extra.actionsTaken,
            skillReadyAt: extra.skillReadyAt,
            lastPlacedBy: extra.lastPlacedBy,
            turnNo: extra.turnNo,
            immuneUntil: extra.immuneUntil,
            powerUntil: extra.powerUntil,
            flames: extra.flames,
            overlay: extra.overlay,
            twinStar: extra.twinStar,
            sabotageBonus: extra.sabotageBonus,
            bloomCheaperNext: extra.bloomCheaperNext,
            skillCasts: extra.skillCasts,
            tempArmor: extra.tempArmor,
            tempArmorUntil: extra.tempArmorUntil,
            strikeBonus: extra.strikeBonus,
            strikeUntil: extra.strikeUntil,
            seedGrow: extra.seedGrow,
            noPlantBonus: extra.noPlantBonus,
            deploy: extra.deploy,
            deployBonus: extra.deployBonus,
            redeployPending: extra.redeployPending,
            flameOwner: extra.flameOwner,
            // bugv34d：黑夜 / 天气也要一起恢复 —— 否则拖到"黑夜已降临"的那一步时
            // 演出还是白天，继续播放的下一手也会按错误的黑夜状态推进。
            nightPhase: extra.nightPhase ?? 'none',
            nightCountdown: extra.nightCountdown ?? 0,
            nightTurns: extra.nightTurns ?? 0,
            turnsSinceNight: extra.turnsSinceNight ?? 999,
            weather: extra.weather ?? null,
            attacksLaunched: extra.attacksLaunched ?? [0, 0],
            nightAttackBase: extra.nightAttackBase ?? [0, 0],
            nightFromStart: extra.nightFromStart ?? false,
          }
        : {}),
      ...(needAttackCtx
        ? {
            phase: 'awaitingDefense' as const,
            attacker: highlights?.owner ?? attackSnapshot?.attacker ?? 0,
            highlights: highlightMap,
            ...(attackSnapshot ? { attackSnapshot } : {}),
          }
        : {}),
    })
    controller?.syncBoard(step.board)
    controller?.syncMagic(magic)
    controller?.syncFlames(extra?.flames ?? [])
    controller?.syncOverlay(step.board, extra?.overlay ?? [])
    // bugv34d：黑夜 / 天气的**表现**也要对齐。拖进度是"瞬间跳步"，不播事件动画，
    // 所以必须在这里手动把场地明暗、棋盘线色、天气 chip 一次性切过去。
    ui.nightPhase = extra?.nightPhase ?? 'none'
    ui.nightCountdown = extra?.nightCountdown ?? 0
    ui.weather = extra?.weather ?? null
    controller?.setNight(ui.nightPhase === 'active')
    if (enterAttackStage && highlights) {
      controller?.stageFromHighlights(highlights.owner, highlights.cells, highlights.weights, stageTally())
    } else if (enterAttackStage) {
      // 没有高光格（「最不绕弯子」）：直接按总攻击数把悬浮棋子摆出来
      void controller?.reconcileStage(stageTally())
    }
    // 结算面板：防守步之后仍要显示"这一手打了多少"（与实时对局一致）
    if (!enterAttackStage && attackSnapshot) ui.attack = attackSnapshot
    ui.board = step.board.slice()
    ui.hp = [step.hp[0], step.hp[1]]
    // bugv25：`cell < 0` = 这一步是"只用技能、没落子"
    ui.lastMove = step.cell >= 0 ? step.cell : null
    ui.current = record.steps[clamped]?.player ?? step.player
    syncUi()
  }

  /**
   * 播一步回放（bugv9 #9）：像真实对局一样把这一步的事件动画演出来，
   * 因此特效、攻击结算面板、逐颗撞击血条都会出现。
   */
  async function playReplayStep(index: number): Promise<void> {
    const record = replay.record
    if (!record || index <= 0 || index > record.steps.length) return
    const step = record.steps[index - 1]
    const events = step.events
    if ((!events || events.length === 0) && !step.skill) {
      // 老存档没有事件：退化为直接跳步
      seekReplay(index)
      return
    }
    // 先瞬间对齐到上一步，再用动画播这一步
    seekReplay(index - 1)
    replay.index = index
    /**
     * bugv25：把**本步结束时**的攻击快照先"预装"进引擎。
     *
     * 回放的事件是"只播动画、不重跑引擎"的，所以宣告攻击的那一步动画期间
     * `engine.attack` 一直是 null ⇒ 悬浮"总攻击数"显示 0（这正是用户看到的现象）。
     * 这里提前把真快照装好，攻击舞台一出现数字就是对的。
     */
    const snap =
      step.extra?.attackSnapshot ??
      ((step.events ?? []).find((event) => event.type === 'attackResolved') as
        | Extract<GameEvent, { type: 'attackResolved' }>
        | undefined)?.snapshot ??
      null
    if (snap) engine.value.attack = { ...snap }
    if (events && events.length > 0) {
      await runEvents(events, { replay: true })
    } else if (step.skill) {
      // 联机回放：服务端只给了动作，没有事件序列 —— 本地按同一份引擎重跑一遍
      const state = engine.value
      try {
        await runEvents(state.useSkill(step.player, step.skill.slot, step.skill.cells, step.skill.target), {
          replay: true,
        })
      } catch {
        seekReplay(index)
      }
    }
    if (replay.record !== record) return
    /**
     * bugv27 #1：**只在"本步没播过攻击结算动画"时才补舞台棋子**。
     *
     * 攻击结算步（事件里有 `attackResolved`）在动画结尾已经 `dismissStaged()` 把悬浮棋子
     * 逐个收走；以前这里无条件再 `reconcileStage()`，于是"攻击阶段结束后又凭空冒出
     * 双方的悬浮棋子"，一直留到下一步 `seekReplay` 才消失（用户反馈）。
     *
     * 保留原来的用途：没有高光格的技能攻击（「最不绕弯子」）靠它把攻击数摆出来。
     */
    const ranResolve = (step.events ?? []).some((event) => event.type === 'attackResolved')
    if (snap && !ranResolve) {
      await scene.value?.reconcileStage(stageTally())
      syncUi()
    }
    replay.index = index
  }

  /** 自动播放循环：每步播完停一小会儿再继续。 */
  async function replayTick(): Promise<void> {
    if (!replay.playing) return
    const record = replay.record
    if (!record) return
    if (replay.index >= record.steps.length) {
      replay.playing = false
      stopReplayTimer()
      return
    }
    await playReplayStep(replay.index + 1)
    if (!replay.playing) return
    replayTimer = globalThis.setTimeout(() => void replayTick(), REPLAY_STEP_PAUSE)
  }

  /** 回放：自动播放 / 暂停。 */
  function toggleReplay(): void {
    const record = replay.record
    if (!record) return
    if (replay.playing) {
      replay.playing = false
      stopReplayTimer()
      return
    }
    replay.playing = true
    if (replay.index >= record.steps.length) seekReplay(0)
    stopReplayTimer()
    void replayTick()
  }

  function setReplayCollapsed(collapsed: boolean): void {
    replay.collapsed = collapsed
  }

  // --- 回放代码导入 / 导出（bugv9 #9） ---------------------------------------

  /** 导出前缀：带版本号，方便以后改格式。 */
  const REPLAY_CODE_PREFIX = 'C4R1:'

  function toBase64(text: string): string {
    const bytes = new TextEncoder().encode(text)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }

  function fromBase64(code: string): string {
    const binary = atob(code)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  }

  /**
   * 导出回放代码：一串可以直接复制粘贴的文本。
   *
   * 棋盘压成 81 个字符（0/1/2），魔力植物压成 `cell:kind:owner` 列表，
   * 事件序列原样保留（回放要靠它重播特效）。
   */
  function exportReplayCode(record?: MatchRecord | null): string {
    const target = record ?? replay.record ?? history[0]
    if (!target) return ''
    const payload = {
      v: 1,
      mode: target.mode,
      names: target.playerNames,
      /**
       * bugv25 #1：**双方角色**也要导出。
       *
       * 以前不导出 `characters` ⇒ 导入的回放保持"当前"角色，于是回放里的
       * 技能框显示的是上一局的技能（甚至人物立绘也是错的）。
       */
      chars: target.characters,
      result: target.result,
      durationMs: target.durationMs,
      playedAt: target.playedAt,
      steps: target.steps.map((step) => ({
        p: step.player,
        c: step.cell,
        d: step.defense ? 1 : 0,
        m: step.match ? 1 : 0,
        b: step.board.join(''),
        h: step.hp,
        g: (step.magic ?? []).map((plant) => `${plant.cell}:${plant.kind}:${plant.owner ?? -1}`).join(','),
        e: step.events ?? [],
        /**
         * bugv25：技能相关状态（冷却 / 护盾 / 增伤 / 攻击快照 …）。
         *
         * 以前**不导出** `extra` ⇒ 导入的回放里技能框显示的是"开局冷却"、
         * 悬浮"总攻击数"也恢复不出真值。`s` 是 `skill`（联机回放的动作）。
         */
        x: step.extra ?? undefined,
        s: step.skill ?? undefined,
      })),
    }
    return REPLAY_CODE_PREFIX + toBase64(JSON.stringify(payload))
  }

  /** 把导出的文本还原成一条回放记录（非法输入返回 null）。 */
  function importReplayCode(code: string): MatchRecord | null {
    const text = code.trim()
    if (!text) {
      replay.codeMessage = '请先粘贴回放代码'
      return null
    }
    const body = text.startsWith(REPLAY_CODE_PREFIX) ? text.slice(REPLAY_CODE_PREFIX.length) : text
    try {
      const payload = JSON.parse(fromBase64(body)) as {
        v?: number
        mode?: GameMode
        names?: [string, string]
        /** bugv25 #1：双方角色（老代码没有这个键）。 */
        chars?: [string, string]
        result?: GameResult
        durationMs?: number
        playedAt?: string
        steps?: Array<{
          p: number
          c: number
          d: number
          m: number
          b: string
          h: [number, number]
          g?: string
          e?: GameEvent[]
          /** bugv25：技能状态快照（老代码没有这个键）。 */
          x?: ReplayExtra
          /** bugv25：联机回放的技能动作。 */
          s?: { slot: number; cells: number[]; target: number | null }
        }>
      }
      if (!payload.steps || !Array.isArray(payload.steps) || payload.steps.length === 0) {
        replay.codeMessage = '回放代码里没有可用的步骤'
        return null
      }
      const steps: ReplayStep[] = payload.steps.map((step) => ({
        player: (step.p === 1 ? 1 : 0) as PlayerIndex,
        cell: Number(step.c) || 0,
        defense: Boolean(step.d),
        match: Boolean(step.m),
        board: String(step.b)
          .split('')
          .map((char) => (char === '1' ? 1 : char === '2' ? 2 : 0) as Cell),
        hp: [Number(step.h?.[0] ?? INITIAL_HP), Number(step.h?.[1] ?? INITIAL_HP)],
        magic: (step.g ?? '')
          .split(',')
          .filter(Boolean)
          .map((entry) => {
            const [cell, kind, owner] = entry.split(':')
            return {
              cell: Number(cell) || 0,
              kind: (kind === 'grass' || kind === 'fern' ? kind : 'flower') as MagicPlant['kind'],
              owner: owner === '0' ? 0 : owner === '1' ? 1 : null,
            } as MagicPlant
          }),
        events: Array.isArray(step.e) && step.e.length > 0 ? (step.e as GameEvent[]) : undefined,
        // bugv25：把技能状态与攻击快照一起还原（否则技能框 / 总攻击数在回放里是错的）
        extra: step.x,
        skill: step.s,
      }))
      const record: MatchRecord = {
        id: `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        mode: payload.mode ?? 'pvp',
        playedAt: payload.playedAt ?? new Date().toLocaleString('zh-CN', { hour12: false }),
        playedAtMs: Date.now(),
        steps,
        result: payload.result ?? { winner: null, reason: 'boardFull', hp: [INITIAL_HP, INITIAL_HP] },
        durationMs: Number(payload.durationMs) || 0,
        playerNames: payload.names ?? ['先手方', '后手方'],
        // bugv25 #1：连同角色一起还原（否则技能框 / 立绘会用错角色）
        characters: Array.isArray(payload.chars) ? payload.chars : undefined,
      }
      replay.codeMessage = `已导入 ${steps.length} 手，正在播放`
      return record
    } catch {
      replay.codeMessage = '回放代码无法解析（可能复制不完整）'
      return null
    }
  }

  /** 面板按钮：导入并立刻播放。 */
  function playReplayCode(code?: string): boolean {
    const record = importReplayCode(code ?? replay.codeText)
    if (!record) return false
    openReplay(record, 'menu')
    return true
  }

  /** 面板按钮：把当前回放的代码填进文本框。 */
  function fillReplayCode(): string {
    const code = exportReplayCode()
    if (!code) {
      replay.codeMessage = '还没有可导出的对局'
      return ''
    }
    replay.codeText = code
    replay.codeMessage = `已生成回放代码（${(code.length / 1024).toFixed(1)} KB），可复制分享`
    return code
  }

  function closeReplay(): void {
    if (replay.returnTo === 'online') {
      openOnlineLobby()
      return
    }
    backToMenu()
  }

  const colorPresets = COLOR_PRESETS.map((preset) => ({
    ...preset,
    css: hexToCss(preset.color),
    glowCss: hexToCss(preset.glow),
  }))

  /** 可选背景音乐列表（bugv5 #5）。 */
  const bgmTracks = BGM_TRACKS.map((track) => ({ name: track.name, label: track.label }))

  /** 当前曲目（迷你播放器显示歌名，bugv9 #7）。 */
  const bgmCurrent = computed(() => BGM_TRACKS[bgmState.index] ?? DEFAULT_BGM ?? null)

  return {
    engine,
    scene,
    ui,
    players,
    palette,
    history,
    replay,
    /** 联机状态与操作（bugv6 #8）。 */
    online,
    /** 联机客户端（验证脚本 / 宿主调试用）。 */
    onlineClient,
    /** 本地局面指纹（与服务端比对用）。 */
    localDigest,
    /** 背景音乐播放器（宿主可自行接管音量 / 曲目）。 */
    bgm,
    /** AI 客户端（宿主可自行换成更强的引擎）。 */
    ai,
    statusText,
    currentSideColor,
    isAiTurn,
    isAiDefense,
    isMyOnlineTurn,
    isOnlinePlaying,
    humanDefense,
    /** 联机倒计时展示信息（bugv28 #4）。 */
    onlineCountdown,
    colorPresets,
    bgmTracks,
    /** 音效风格（bugv9 #10）。 */
    soundStyles,
    soundTriggers: SOUND_TRIGGER_OPTIONS,
    setSoundStyle,
    resetSoundStyles,
    /** 迷你播放器（bugv9 #7）。 */
    bgmState,
    bgmCurrent,
    bgmToggle,
    bgmStep,
    bgmSetVolume,
    bgmToggleMute,
    /** 魔力植物配置（bugv8 #4）。 */
    magicConfig,
    setMagicConfig,
    resetMagicConfig,
    showNotice,
    dismissNotice,
    initScene,
    showMenuScene,
    unlockAudio,
    setSound,
    /** 动画速度（bugv28 #3）。 */
    setAnimationSpeed,
    /** 血量上限设置（bugv34，仅非联机）。 */
    setHpLimit,
    /** 「黑夜开局」开关（bugv34 补充，仅非联机）。 */
    setNightConfig,
    resetNightConfig,
    /** 本局实际血量上限（联机固定 12，非联机跟随设置）—— 血条格数 / 结算面板用。 */
    matchHpCap,
    /** 血量上限可选项（8 / 12 / 16）。 */
    hpLimits: HP_LIMITS,
    setBgmTrack,
    hideDice,
    startTrail,
    stopTrail,
    dispose,
    startMatch,
    restart,
    backToMenu,
    setMode,
    toggleMode,
    setDifficulty,
    setPlayerColor,
    renamePlayer,
    /** 角色系统（bugv9 #13）。 */
    characters,
    setCharacter,
    warmCharacterIcons,
    toggleSkill,
    cancelSkillSelect,
    /** bugv14：可变消耗技能在 need~max 之间手动释放。 */
    confirmSkillSelect,
    closeSkillBubble,
    /** bugv10 追加 #4：立绘复位 / 关结算面板。 */
    resetExpressions,
    closeResult,
    /** bugv11 #2：技能框流光复位。 */
    resetSkillFlash,
    pickSkillPlant,
    refreshHudRects,
    skipAnimations,
    handleCellPick,
    syncUi,
    closeAttackPanel,
    openReplay,
    seekReplay,
    playReplayStep,
    toggleReplay,
    setReplayCollapsed,
    exportReplayCode,
    importReplayCode,
    playReplayCode,
    fillReplayCode,
    closeReplay,
    deleteReplay,
    clearHistory,
    resetRecording,
    // 联机（bugv6 #8）
    openOnlineLobby,
    closeOnlineLobby,
    connectOnline,
    disconnectOnline,
    setServerUrl,
    onlineQueue,
    onlineCancel,
    onlineCreateRoom,
    onlineJoinRoom,
    onlineRejoinRoom,
    onlineAuthSubmit,
    onlineLogin,
    onlineRegister,
    onlineLogout,
    setAuthMode,
    // 房间（bugv34e）
    setRoomSettings,
    pickRoomCharacter,
    sendRoomChat,
    toggleRoomChat,
    transferRoomHost,
    setRoomReady,
    leaveRoom,
    onlineResign,
    leaveOnlineMatch,
    refreshOnlineReplays,
    openOnlineReplay,
    hexToCss,
    cellIndex: cellId,
  }
}

/** 调试用：某局面下所有连珠。 */
export function previewLines(board: number[], player: PlayerIndex) {
  return findLines(board as Board, player)
}
