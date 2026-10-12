/**
 * 背景音乐（bugv3 #7）。
 *
 * 用单独一个 `<audio>` 元素循环播放打包后的音频资源，而不是把整首曲子
 * 解码进 Web Audio：并入宿主工程时只需要一个静态资源，也不需要额外的
 * 打包配置（Vite 会直接把 `bgm.mp3` 输出成资源 URL）。
 *
 * 几个必须处理的点：
 * - 浏览器自动播放策略：`play()` 必须在一次用户手势里调用（首次点击 / 按键）；
 * - 环境可能不支持（例如 jsdom、无音频设备的构建环境）：用 `canPlayType` 判断，
 *   不支持时整个模块静默降级；
 * - 大特效（对撞 / 撞击血条）时短暂压低音量（duck），让音效更清楚。
 */

export interface BgmOptions {
  enabled?: boolean
  volume?: number
}

/** 音频资源的 MIME 类型（用于能力探测）。 */
const AUDIO_MIME = 'audio/mpeg'

export class BgmPlayer {
  private source: string
  private element: HTMLAudioElement | null = null
  private enabled: boolean
  private muteFlag = false
  private baseVolume: number
  private started = false
  private duckTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  /** 播放状态变化回调（迷你播放器用它刷新按钮）。 */
  onChange: (() => void) | null = null

  constructor(source: string, options: BgmOptions = {}) {
    this.source = source
    this.enabled = options.enabled ?? true
    this.baseVolume = options.volume ?? 0.32
  }

  private ensure(): HTMLAudioElement | null {
    if (this.element) return this.element
    if (typeof Audio === 'undefined') return null
    let element: HTMLAudioElement
    try {
      element = new Audio(this.source)
    } catch {
      return null
    }
    // 环境不支持该音频格式（jsdom 返回空串）时直接放弃
    if (!element.canPlayType || element.canPlayType(AUDIO_MIME) === '') return null
    element.loop = true
    element.preload = 'auto'
    element.volume = this.effectiveVolume()
    // 播放器自带的事件也同步给界面（bugv9 #7）
    element.addEventListener('play', () => {
      this.started = true
      this.onChange?.()
    })
    element.addEventListener('pause', () => {
      this.started = false
      this.onChange?.()
    })
    this.element = element
    return element
  }

  /** 计入静音 / 开关之后的实际音量。 */
  private effectiveVolume(): number {
    if (!this.enabled || this.muteFlag) return 0
    return this.baseVolume
  }

  /** 由一次用户手势调用（重复调用无副作用）。 */
  play(): void {
    const element = this.ensure()
    if (!element || this.muteFlag) return
    if (!this.enabled) return
    element.volume = this.effectiveVolume()
    try {
      const started = element.play()
      if (started && typeof started.then === 'function') {
        void started.then(
          () => {
            this.started = true
            this.onChange?.()
          },
          () => {
            this.started = false
            this.onChange?.()
          },
        )
      } else {
        this.started = true
        this.onChange?.()
      }
    } catch {
      this.started = false
      this.onChange?.()
    }
  }

  /** 暂停（迷你播放器，bugv9 #7）。 */
  pause(): void {
    const element = this.element
    this.started = false
    if (!element) {
      this.onChange?.()
      return
    }
    try {
      element.pause()
    } catch {
      /* 忽略 */
    }
    this.onChange?.()
  }

  /** 播放 / 暂停切换。 */
  toggle(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  /** 当前是否正在播放（以 audio 元素为准）。 */
  get playing(): boolean {
    const element = this.element
    if (element) return !element.paused && !element.ended && element.volume > 0
    return false
  }

  /** 曲目时长与当前进度（秒，迷你播放器展示用）。 */
  get progress(): { current: number; duration: number } {
    const element = this.element
    if (!element) return { current: 0, duration: 0 }
    return {
      current: Number.isFinite(element.currentTime) ? element.currentTime : 0,
      duration: Number.isFinite(element.duration) ? element.duration : 0,
    }
  }

  /** 设置音量（0..1）。 */
  setVolume(volume: number): void {
    this.baseVolume = Math.max(0, Math.min(1, volume))
    if (this.baseVolume > 0) this.muteFlag = false
    const element = this.element
    if (element) element.volume = this.effectiveVolume()
    this.onChange?.()
  }

  get volume(): number {
    return this.baseVolume
  }

  /** 静音开关。 */
  setMuted(muted: boolean): void {
    this.muteFlag = muted
    const element = this.element
    if (element) element.volume = this.effectiveVolume()
    this.onChange?.()
  }

  toggleMute(): boolean {
    this.setMuted(!this.muteFlag)
    return this.muteFlag
  }

  get muted(): boolean {
    return this.muteFlag
  }

  /**
   * 换一首曲子（bugv5 #5：设置面板里可以切换 BGM）。
   *
   * 保持“当前是否正在播放”的状态：原本在放就接着放新曲，原本没放就只记下来。
   */
  setSource(source: string): void {
    if (source === this.source) return
    const wasPlaying = this.started
    const element = this.element
    if (element) {
      element.pause()
      element.removeAttribute('src')
      this.element = null
    }
    this.source = source
    this.started = false
    if (wasPlaying) this.play()
    this.onChange?.()
  }

  /** 当前曲目地址。 */
  get currentSource(): string {
    return this.source
  }

  /** 开关背景音乐（与音效共用一个开关）。 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    const element = this.element
    if (!element) {
      this.onChange?.()
      return
    }
    if (!enabled) {
      element.volume = 0
      element.pause()
      this.onChange?.()
      return
    }
    element.volume = this.effectiveVolume()
    if (this.started) {
      try {
        void element.play()?.catch(() => undefined)
      } catch {
        /* 忽略：需要用户手势才能恢复播放 */
      }
    } else {
      this.play()
    }
    this.onChange?.()
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  /** 大特效时压低背景音乐。 */
  duck(level = 0.5, seconds = 0.45): void {
    const element = this.element
    if (!element || !this.enabled || !this.started) return
    element.volume = Math.max(0, Math.min(1, this.baseVolume * level))
    if (this.duckTimer !== null) globalThis.clearTimeout(this.duckTimer)
    this.duckTimer = globalThis.setTimeout(() => {
      this.duckTimer = null
      if (this.element && this.enabled) this.element.volume = this.effectiveVolume()
    }, Math.max(0.05, seconds) * 1000)
  }

  dispose(): void {
    if (this.duckTimer !== null) globalThis.clearTimeout(this.duckTimer)
    this.duckTimer = null
    const element = this.element
    if (element) {
      element.pause()
      element.removeAttribute('src')
    }
    this.element = null
    this.started = false
  }
}
