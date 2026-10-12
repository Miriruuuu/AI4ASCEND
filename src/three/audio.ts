/**
 * 音效：**完全程序化生成**（Web Audio 实时合成），不依赖任何音频文件。
 *
 * 这样做的原因：
 * - 并入宿主工程时不需要额外的静态资源与打包配置；
 * - 音量、音色可随对局状态微调（例如连珠长度越大音高越高）。
 *
 * bugv9 #10：把音效数据化 —— 每个**扳机**（trigger：落子 / 连珠 / 对撞 …）
 * 都有若干套风格（木质、水滴、电子、铃…），设置面板里可以逐个扳机自由选择，
 * 选择时立即试听。所有风格都只是"振荡器音 + 滤波噪声"的声明式配方，
 * 因此依然是零音频资源。
 *
 * 所有音效都在用户首次交互后才会创建 AudioContext（浏览器自动播放策略）。
 */

export type SoundName =
  /** 落子 */
  | 'place'
  /** 形成连珠 */
  | 'match'
  /** 防守方成线（对撞前的反击） */
  | 'counter'
  /** 棋子对撞抵消 */
  | 'clash'
  /** 攻击棋子撞击血条 */
  | 'impact'
  /** 呼出菜单 / 点击 */
  | 'ui'
  /** 魔力植物长出（bugv8 #4） */
  | 'magic'
  /** 魔力植物被抢走（bugv8 #4） */
  | 'magicSteal'
  /** 门铃：对手加入房间 / 匹配成功（bugv8 #2） */
  | 'doorbell'
  /** 棋子落在烈焰上碎裂（bugv10 #9） */
  | 'shatter'
  /** 火球飞行 / 烈焰燃烧（bugv10 #9） */
  | 'fire'
  /** 联机倒计时超时托管（bugv28 #4） */
  | 'timeout'

export interface SoundEngineOptions {
  enabled?: boolean
  masterVolume?: number
}

interface ToneOptions {
  type?: OscillatorType
  from: number
  to?: number
  duration: number
  gain?: number
  delay?: number
  attack?: number
}

interface NoiseOptions {
  duration: number
  gain?: number
  delay?: number
  type?: BiquadFilterType
  frequency: number
  frequencyTo?: number
  q?: number
  attack?: number
}

/** 一套音效的声明式配方（bugv9 #10）。 */
export interface SfxRecipe {
  tones?: readonly ToneOptions[]
  noises?: readonly NoiseOptions[]
}

/** 配方生成器：`variant` 用于让连续触发的音效不呆板（连珠长度 / 对撞序号等）。 */
export type SfxBuilder = (variant: number) => SfxRecipe

export interface SoundStyle {
  readonly id: string
  readonly label: string
  readonly build: SfxBuilder
}

export interface SoundTrigger {
  readonly name: SoundName
  readonly label: string
  readonly styles: readonly SoundStyle[]
}

// ---------------------------------------------------------------------------
// 配方小工具
// ---------------------------------------------------------------------------

/** 一串按比例上行的音（琶音）。 */
function arpeggio(base: number, ratios: readonly number[], options: { type?: OscillatorType; duration: number; gain: number; step: number }): ToneOptions[] {
  return ratios.map((ratio, index) => ({
    type: options.type ?? 'triangle',
    from: base * ratio,
    duration: options.duration,
    gain: options.gain * (1 - index * 0.08),
    delay: index * options.step,
  }))
}

/** 一串按比例下行的音。 */
function cascade(base: number, ratios: readonly number[], options: { type?: OscillatorType; duration: number; gain: number; step: number }): ToneOptions[] {
  return arpeggio(base, ratios, options)
}

// ---------------------------------------------------------------------------
// 扳机与风格（bugv9 #10）
// ---------------------------------------------------------------------------

export const SOUND_TRIGGERS: readonly SoundTrigger[] = [
  {
    name: 'place',
    label: '落子',
    styles: [
      {
        id: 'wood',
        label: '木质（默认）',
        build: (variant) => {
          const base = 420 - Math.min(variant, 4) * 18
          return {
            tones: [
              { type: 'sine', from: base, to: base * 0.55, duration: 0.09, gain: 0.3 },
              { type: 'triangle', from: base * 0.5, to: base * 0.3, duration: 0.13, gain: 0.12 },
            ],
            noises: [{ duration: 0.055, gain: 0.22, frequency: 2400, frequencyTo: 800, q: 0.9 }],
          }
        },
      },
      {
        id: 'drop',
        label: '水滴',
        build: () => ({
          tones: [
            { type: 'sine', from: 900, to: 260, duration: 0.16, gain: 0.26 },
            { type: 'sine', from: 1800, to: 700, duration: 0.09, gain: 0.08 },
          ],
          noises: [{ duration: 0.05, gain: 0.1, type: 'highpass', frequency: 2600, q: 0.7 }],
        }),
      },
      {
        id: 'blip',
        label: '电子',
        build: () => ({
          tones: [
            { type: 'square', from: 620, to: 900, duration: 0.06, gain: 0.14 },
            { type: 'square', from: 310, duration: 0.05, gain: 0.08, delay: 0.02 },
          ],
        }),
      },
      {
        id: 'stone',
        label: '石子',
        build: () => ({
          tones: [{ type: 'triangle', from: 260, to: 150, duration: 0.11, gain: 0.2 }],
          noises: [
            { duration: 0.07, gain: 0.28, frequency: 1500, frequencyTo: 420, q: 0.6 },
            { duration: 0.04, gain: 0.1, type: 'highpass', frequency: 4200, q: 0.8 },
          ],
        }),
      },
    ],
  },
  {
    name: 'match',
    label: '形成连珠',
    styles: [
      {
        id: 'shine',
        label: '上行三音（默认）',
        build: (variant) => {
          const base = 520 + Math.min(variant, 6) * 26
          return {
            tones: [
              ...arpeggio(base, [1, 1.25, 1.5, 2], { duration: 0.5, gain: 0.2, step: 0.075 }),
              { type: 'sine', from: base * 2, duration: 0.7, gain: 0.1, delay: 0.05 },
            ],
            noises: [{ duration: 0.3, gain: 0.12, type: 'highpass', frequency: 3200, q: 0.7 }],
          }
        },
      },
      {
        id: 'chime',
        label: '钟琴',
        build: (variant) => ({
          tones: [
            { type: 'sine', from: 1046 + Math.min(variant, 5) * 40, duration: 1.1, gain: 0.2, attack: 0.01 },
            { type: 'sine', from: 1568, duration: 0.9, gain: 0.12, delay: 0.09, attack: 0.01 },
            { type: 'sine', from: 2093, duration: 0.7, gain: 0.07, delay: 0.18, attack: 0.01 },
          ],
        }),
      },
      {
        id: 'power',
        label: '力量感',
        build: () => ({
          tones: [
            { type: 'sawtooth', from: 180, to: 420, duration: 0.42, gain: 0.16 },
            { type: 'triangle', from: 540, to: 1080, duration: 0.36, gain: 0.14, delay: 0.06 },
          ],
          noises: [
            { duration: 0.34, gain: 0.16, type: 'bandpass', frequency: 900, frequencyTo: 2600, q: 0.9 },
            { duration: 0.5, gain: 0.08, type: 'lowpass', frequency: 300, q: 0.6 },
          ],
        }),
      },
    ],
  },
  {
    name: 'counter',
    label: '防守方成线',
    styles: [
      {
        id: 'down',
        label: '下行三音（默认）',
        build: () => ({
          tones: cascade(640, [1, 0.84, 0.7], { duration: 0.34, gain: 0.18, step: 0.07 }),
          noises: [{ duration: 0.24, gain: 0.14, frequency: 900, frequencyTo: 260, q: 1.1 }],
        }),
      },
      {
        id: 'shield',
        label: '盾牌',
        build: () => ({
          tones: [
            { type: 'square', from: 300, to: 200, duration: 0.2, gain: 0.14 },
            { type: 'sine', from: 620, to: 420, duration: 0.4, gain: 0.16, delay: 0.04 },
          ],
          noises: [{ duration: 0.3, gain: 0.2, type: 'lowpass', frequency: 700, frequencyTo: 200, q: 0.7 }],
        }),
      },
    ],
  },
  {
    name: 'clash',
    label: '棋子对撞',
    styles: [
      {
        id: 'impact',
        label: '爆裂（默认）',
        build: (variant) => {
          const shift = Math.min(variant, 6) * 12
          return {
            tones: [
              { type: 'sine', from: 170 - shift, to: 52, duration: 0.34, gain: 0.4 },
              { type: 'square', from: 1400 + shift * 2, to: 700, duration: 0.09, gain: 0.09 },
            ],
            noises: [
              { duration: 0.24, gain: 0.42, type: 'bandpass', frequency: 1900 + shift, frequencyTo: 320, q: 0.8 },
              { duration: 0.5, gain: 0.1, type: 'lowpass', frequency: 420, q: 0.6, delay: 0.02 },
            ],
          }
        },
      },
      {
        id: 'metal',
        label: '金属',
        build: (variant) => ({
          tones: [
            { type: 'triangle', from: 2400 + Math.min(variant, 6) * 60, to: 1200, duration: 0.3, gain: 0.18 },
            { type: 'sine', from: 3400, duration: 0.24, gain: 0.08, delay: 0.02 },
            { type: 'sine', from: 96, to: 48, duration: 0.36, gain: 0.3, delay: 0.01 },
          ],
          noises: [{ duration: 0.18, gain: 0.2, type: 'bandpass', frequency: 5200, frequencyTo: 2400, q: 1.6 }],
        }),
      },
      {
        id: 'thunder',
        label: '雷电',
        build: () => ({
          tones: [{ type: 'sawtooth', from: 120, to: 40, duration: 0.5, gain: 0.3 }],
          noises: [
            { duration: 0.4, gain: 0.4, type: 'lowpass', frequency: 1400, frequencyTo: 120, q: 0.5 },
            { duration: 0.12, gain: 0.24, type: 'highpass', frequency: 3600, q: 0.8 },
          ],
        }),
      },
    ],
  },
  {
    name: 'impact',
    label: '撞击血条',
    styles: [
      {
        id: 'punch',
        label: '重击（默认）',
        build: (variant) => {
          const shift = Math.min(variant, 5) * 16
          return {
            tones: [
              { type: 'sine', from: 240 - shift, to: 66, duration: 0.26, gain: 0.42 },
              { type: 'triangle', from: 460 - shift, to: 180, duration: 0.14, gain: 0.14 },
            ],
            noises: [{ duration: 0.17, gain: 0.34, type: 'bandpass', frequency: 1200, frequencyTo: 300, q: 0.8 }],
          }
        },
      },
      {
        id: 'alarm',
        label: '警报',
        build: () => ({
          tones: [
            { type: 'square', from: 880, to: 440, duration: 0.18, gain: 0.12 },
            { type: 'square', from: 660, to: 330, duration: 0.24, gain: 0.12, delay: 0.14 },
          ],
          noises: [{ duration: 0.3, gain: 0.14, type: 'bandpass', frequency: 1600, q: 1.2 }],
        }),
      },
      {
        id: 'glass',
        label: '玻璃碎',
        build: () => ({
          tones: [
            { type: 'triangle', from: 4200, to: 1800, duration: 0.16, gain: 0.12 },
            { type: 'sine', from: 2600, to: 900, duration: 0.3, gain: 0.09, delay: 0.03 },
          ],
          noises: [{ duration: 0.26, gain: 0.26, type: 'highpass', frequency: 3800, q: 0.8 }],
        }),
      },
    ],
  },
  {
    name: 'ui',
    label: '界面点击',
    styles: [
      {
        id: 'soft',
        label: '轻点（默认）',
        build: () => ({ tones: [{ type: 'triangle', from: 880, to: 1320, duration: 0.07, gain: 0.12 }] }),
      },
      {
        id: 'click',
        label: '开关',
        build: () => ({
          tones: [{ type: 'square', from: 1200, duration: 0.03, gain: 0.09 }],
          noises: [{ duration: 0.02, gain: 0.1, type: 'highpass', frequency: 5000, q: 0.8 }],
        }),
      },
      {
        id: 'bubble',
        label: '气泡',
        build: () => ({ tones: [{ type: 'sine', from: 420, to: 1200, duration: 0.12, gain: 0.14 }] }),
      },
    ],
  },
  {
    name: 'magic',
    label: '魔力植物长出',
    styles: [
      {
        id: 'bell',
        label: '铃铛（默认）',
        build: (variant) => {
          const notes = Math.max(1, Math.min(variant, 4))
          return {
            tones: Array.from({ length: notes }, (_, i) => ({
              type: 'sine' as OscillatorType,
              from: 1180 + i * 150,
              to: (1180 + i * 150) * 1.18,
              duration: 0.42,
              gain: 0.12 - i * 0.012,
              delay: i * 0.07,
              attack: 0.012,
            })),
            noises: [{ duration: 0.22, gain: 0.06, type: 'highpass', frequency: 5200, q: 0.6 }],
          }
        },
      },
      {
        id: 'grow',
        label: '生长',
        build: () => ({
          tones: [{ type: 'triangle', from: 220, to: 660, duration: 0.5, gain: 0.14 }],
          noises: [{ duration: 0.44, gain: 0.1, type: 'bandpass', frequency: 600, frequencyTo: 2600, q: 1.1 }],
        }),
      },
      {
        id: 'sparkle',
        label: '星尘',
        build: (variant) => ({
          tones: Array.from({ length: Math.max(2, Math.min(variant + 1, 5)) }, (_, i) => ({
            type: 'sine' as OscillatorType,
            from: 1600 + i * 120,
            to: 2400 + i * 260,
            duration: 0.3,
            gain: 0.09,
            delay: i * 0.05,
            attack: 0.01,
          })),
        }),
      },
    ],
  },
  {
    name: 'magicSteal',
    label: '魔力植物被抢',
    styles: [
      {
        id: 'steal',
        label: '叮咚（默认）',
        build: () => ({
          tones: [
            { type: 'triangle', from: 1320, to: 660, duration: 0.22, gain: 0.16 },
            { type: 'sine', from: 880, to: 440, duration: 0.3, gain: 0.12, delay: 0.06 },
          ],
          noises: [{ duration: 0.18, gain: 0.08, type: 'bandpass', frequency: 3000, frequencyTo: 1200, q: 1.2 }],
        }),
      },
      {
        id: 'snatch',
        label: '夺走',
        build: () => ({
          tones: [
            { type: 'sawtooth', from: 900, to: 200, duration: 0.28, gain: 0.14 },
            { type: 'square', from: 1400, to: 500, duration: 0.14, gain: 0.08, delay: 0.03 },
          ],
          noises: [{ duration: 0.22, gain: 0.16, type: 'bandpass', frequency: 2200, frequencyTo: 600, q: 1.4 }],
        }),
      },
      {
        id: 'wilt',
        label: '枯萎',
        build: () => ({
          tones: [{ type: 'sine', from: 520, to: 130, duration: 0.6, gain: 0.16 }],
          noises: [{ duration: 0.5, gain: 0.08, type: 'lowpass', frequency: 900, frequencyTo: 200, q: 0.7 }],
        }),
      },
    ],
  },
  {
    name: 'doorbell',
    label: '对手进房 / 匹配成功',
    styles: [
      {
        id: 'dingdong',
        label: '门铃（默认）',
        build: () => ({
          tones: [
            { type: 'sine', from: 1318, duration: 0.95, gain: 0.3, attack: 0.004 },
            { type: 'sine', from: 2637, duration: 0.7, gain: 0.08, attack: 0.004 },
            { type: 'sine', from: 1046, duration: 1.35, gain: 0.32, delay: 0.34, attack: 0.004 },
            { type: 'sine', from: 2093, duration: 0.9, gain: 0.08, delay: 0.34, attack: 0.004 },
          ],
          noises: [
            { duration: 0.05, gain: 0.1, type: 'bandpass', frequency: 4200, q: 1.4 },
            { duration: 0.05, gain: 0.09, type: 'bandpass', frequency: 3400, q: 1.4, delay: 0.34 },
          ],
        }),
      },
      {
        id: 'marimba',
        label: '马林巴',
        build: () => ({
          tones: [
            { type: 'triangle', from: 784, duration: 0.5, gain: 0.24 },
            { type: 'triangle', from: 1175, duration: 0.55, gain: 0.2, delay: 0.12 },
            { type: 'triangle', from: 1568, duration: 0.7, gain: 0.16, delay: 0.24 },
          ],
        }),
      },
      {
        id: 'alert',
        label: '提示音',
        build: () => ({
          tones: [
            { type: 'sine', from: 1568, duration: 0.2, gain: 0.22 },
            { type: 'sine', from: 1568, duration: 0.24, gain: 0.22, delay: 0.24 },
          ],
        }),
      },
    ],
  },
  {
    name: 'shatter',
    label: '棋子碎裂（烈焰）',
    styles: [
      {
        id: 'glass',
        label: '玻璃碎裂（默认）',
        build: (variant) => ({
          tones: [
            { type: 'square', from: 2600 - Math.min(variant, 5) * 120, to: 900, duration: 0.07, gain: 0.14 },
            { type: 'triangle', from: 1400, to: 420, duration: 0.22, gain: 0.12 },
          ],
          noises: [
            { duration: 0.16, gain: 0.3, type: 'highpass', frequency: 3200, frequencyTo: 1400, q: 0.8 },
            { duration: 0.3, gain: 0.16, type: 'bandpass', frequency: 1800, frequencyTo: 500, q: 0.6, delay: 0.04 },
          ],
        }),
      },
      {
        id: 'crack',
        label: '干脆开裂',
        build: () => ({
          tones: [{ type: 'sawtooth', from: 520, to: 160, duration: 0.14, gain: 0.16 }],
          noises: [{ duration: 0.1, gain: 0.34, frequency: 2200, frequencyTo: 300, q: 0.5 }],
        }),
      },
    ],
  },
  {
    name: 'fire',
    label: '火球 / 烈焰',
    styles: [
      {
        id: 'whoosh',
        label: '呼啸火球（默认）',
        build: () => ({
          tones: [
            { type: 'sawtooth', from: 90, to: 320, duration: 0.6, gain: 0.2 },
            { type: 'sine', from: 60, to: 30, duration: 0.9, gain: 0.24, delay: 0.45 },
          ],
          noises: [
            { duration: 0.6, gain: 0.26, type: 'lowpass', frequency: 400, frequencyTo: 2400, q: 0.7 },
            { duration: 0.85, gain: 0.3, type: 'bandpass', frequency: 900, frequencyTo: 160, q: 0.5, delay: 0.45 },
            { duration: 0.5, gain: 0.14, type: 'highpass', frequency: 3400, frequencyTo: 900, q: 0.8, delay: 0.4 },
          ],
        }),
      },
      {
        id: 'boom',
        label: '沉闷轰鸣',
        build: () => ({
          tones: [{ type: 'sine', from: 120, to: 34, duration: 1.1, gain: 0.32 }],
          noises: [{ duration: 0.7, gain: 0.24, type: 'lowpass', frequency: 260, frequencyTo: 90, q: 0.9 }],
        }),
      },
    ],
  },
  {
    name: 'timeout',
    label: '超时托管',
    styles: [
      {
        id: 'chime',
        label: '提示钟（默认）',
        build: () => ({
          tones: [
            { type: 'sine', from: 1568, duration: 0.22, gain: 0.24, attack: 0.005 },
            { type: 'sine', from: 1568, duration: 0.26, gain: 0.22, delay: 0.26, attack: 0.005 },
            { type: 'sine', from: 2093, duration: 0.4, gain: 0.12, delay: 0.52, attack: 0.005 },
          ],
        }),
      },
      {
        id: 'buzz',
        label: '低鸣提醒',
        build: () => ({
          tones: [
            { type: 'square', from: 440, to: 300, duration: 0.18, gain: 0.14 },
            { type: 'square', from: 440, to: 300, duration: 0.22, gain: 0.14, delay: 0.24 },
          ],
          noises: [{ duration: 0.3, gain: 0.12, type: 'bandpass', frequency: 900, q: 1.1 }],
        }),
      },
    ],
  },
]

/** 默认风格：每个扳机的第一套（与 bugv8 及之前的手感一致）。 */
export const DEFAULT_SOUND_STYLES: Readonly<Record<SoundName, string>> = SOUND_TRIGGERS.reduce(
  (map, trigger) => {
    map[trigger.name] = trigger.styles[0].id
    return map
  },
  {} as Record<SoundName, string>,
)

/** 供 UI 展示的扳机列表（去掉配方，避免 Vue 深层响应式包住函数）。 */
export const SOUND_TRIGGER_OPTIONS = SOUND_TRIGGERS.map((trigger) => ({
  name: trigger.name,
  label: trigger.label,
  styles: trigger.styles.map((style) => ({ id: style.id, label: style.label })),
}))

function findStyle(name: SoundName, styleId: string): SoundStyle | null {
  const trigger = SOUND_TRIGGERS.find((item) => item.name === name)
  if (!trigger) return null
  return trigger.styles.find((style) => style.id === styleId) ?? trigger.styles[0] ?? null
}

export class SoundEngine {
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private noiseBuffer: AudioBuffer | null = null
  enabled: boolean
  volume: number
  /** 每个扳机当前选用的风格（bugv9 #10）。 */
  private styles: Record<string, string> = { ...DEFAULT_SOUND_STYLES }

  constructor(options: SoundEngineOptions = {}) {
    this.enabled = options.enabled ?? true
    this.volume = options.masterVolume ?? 0.5
  }

  /** 由任意一次用户手势调用（点击 / 按键），用于解锁音频上下文。 */
  unlock(): void {
    const context = this.ensureContext()
    if (!context) return
    if (context.state === 'suspended') void context.resume()
  }

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context
    const Ctor =
      typeof window !== 'undefined'
        ? window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined
    if (!Ctor) return null
    try {
      const context = new Ctor()
      const master = context.createGain()
      master.gain.value = this.volume
      master.connect(context.destination)
      this.context = context
      this.master = master
      return context
    } catch {
      return null
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(enabled ? this.volume : 0, this.context.currentTime, 0.02)
    }
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(this.enabled ? this.volume : 0, this.context.currentTime, 0.02)
    }
  }

  // -------------------------------------------------------------------------
  // 风格选择（bugv9 #10）
  // -------------------------------------------------------------------------

  /** 批量设置扳机风格（设置面板 / localStorage 恢复）。 */
  setStyles(styles: Partial<Record<SoundName, string>>): void {
    for (const [name, styleId] of Object.entries(styles)) {
      if (!styleId) continue
      if (findStyle(name as SoundName, styleId)) this.styles[name] = styleId
    }
  }

  /** 某个扳机当前选用的风格 id。 */
  styleFor(name: SoundName): string {
    return this.styles[name] ?? DEFAULT_SOUND_STYLES[name]
  }

  /** 全部扳机的当前风格（持久化用）。 */
  get styleMap(): Record<string, string> {
    return { ...this.styles }
  }

  // -------------------------------------------------------------------------
  // 基础发声单元
  // -------------------------------------------------------------------------

  /** 一个带包络的振荡器音。 */
  private tone(options: ToneOptions): void {
    if (!this.enabled) return
    const context = this.ensureContext()
    const master = this.master
    if (!context || !master) return

    const start = context.currentTime + (options.delay ?? 0)
    const duration = Math.max(options.duration, 0.01)
    const oscillator = context.createOscillator()
    const gain = context.createGain()

    oscillator.type = options.type ?? 'sine'
    oscillator.frequency.setValueAtTime(Math.max(options.from, 1), start)
    if (options.to !== undefined) {
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(options.to, 1), start + duration)
    }

    const peak = options.gain ?? 0.2
    const attack = Math.max(options.attack ?? 0.006, 0.001)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.linearRampToValueAtTime(peak, start + attack)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)

    oscillator.connect(gain)
    gain.connect(master)
    oscillator.start(start)
    oscillator.stop(start + duration + 0.03)
  }

  /** 白噪声缓冲（惰性生成，重复使用）。 */
  private noise(): AudioBuffer | null {
    const context = this.ensureContext()
    if (!context) return null
    if (this.noiseBuffer) return this.noiseBuffer
    const length = Math.floor(context.sampleRate * 0.6)
    const buffer = context.createBuffer(1, length, context.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
    this.noiseBuffer = buffer
    return buffer
  }

  /** 噪声 + 滤波 + 包络，用于“咔哒 / 撞击 / 嗡鸣”。 */
  private filteredNoise(options: NoiseOptions): void {
    if (!this.enabled) return
    const context = this.ensureContext()
    const master = this.master
    const buffer = this.noise()
    if (!context || !master || !buffer) return

    const start = context.currentTime + (options.delay ?? 0)
    const duration = Math.max(options.duration, 0.01)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.loop = true

    const filter = context.createBiquadFilter()
    filter.type = options.type ?? 'bandpass'
    filter.frequency.setValueAtTime(Math.max(options.frequency, 10), start)
    if (options.frequencyTo !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(options.frequencyTo, 10), start + duration)
    }
    filter.Q.value = options.q ?? 1

    const gain = context.createGain()
    const peak = options.gain ?? 0.2
    const attack = Math.max(options.attack ?? 0.004, 0.001)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.linearRampToValueAtTime(peak, start + attack)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)

    source.connect(filter)
    filter.connect(gain)
    gain.connect(master)
    source.start(start)
    source.stop(start + duration + 0.03)
  }

  /** 按配方发声。 */
  private render(recipe: SfxRecipe): void {
    for (const tone of recipe.tones ?? []) this.tone(tone)
    for (const noise of recipe.noises ?? []) this.filteredNoise(noise)
  }

  // -------------------------------------------------------------------------
  // 具体音效
  // -------------------------------------------------------------------------

  /**
   * 播放某个扳机的音效（用它当前选中的风格）。
   *
   * @param name 扳机名（落子 / 连珠 / 对撞 …）
   * @param variant 变化参数（例如连珠长度、对撞序号），用于让连续音效不呆板
   */
  play(name: SoundName, variant = 0): void {
    if (!this.enabled) return
    const style = findStyle(name, this.styleFor(name))
    if (!style) return
    this.render(style.build(variant))
  }

  /** 试听某个扳机的指定风格（设置面板里选择时调用，bugv9 #10）。 */
  preview(name: SoundName, styleId: string, variant = 0): void {
    const style = findStyle(name, styleId)
    if (!style) return
    this.unlock()
    this.render(style.build(variant))
  }

  dispose(): void {
    if (this.context) void this.context.close()
    this.context = null
    this.master = null
    this.noiseBuffer = null
  }
}
