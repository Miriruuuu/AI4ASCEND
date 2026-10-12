/**
 * 局面指纹（bugv6 #8 联机用）。
 *
 * 联机对局由服务端裁决，但两端各自跑一份**完全相同的纯逻辑引擎**，
 * 因此每一步之后只需要比较一个短指纹就能发现状态漂移：
 * 不一致时客户端重新 `sync` 一次完整局面即可自愈。
 *
 * 该文件必须与 `back/src/core/digest.ts` **逐字节一致**，
 * 修改后由根目录 `pnpm sync:core` 同步到后端。
 */
import type { MatchPhase, PlayerIndex } from './types'

/** FNV-1a 32 位散列（纯字符串运算，前后端结果一致）。 */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export interface DigestInput {
  readonly board: readonly number[]
  readonly hp: readonly [number, number]
  readonly phase: MatchPhase | string
  readonly current: number
  readonly firstPlayer?: PlayerIndex | null
  readonly highlightOwner?: PlayerIndex | null
  /** 高光位置 -> 属于几条连珠。 */
  readonly highlights?: ReadonlyMap<number, number> | ReadonlyArray<readonly [number, number]>
  /** 棋盘上的魔力植物（bugv8 #4）：联机对局里它必须一起参与比对。 */
  readonly magic?: ReadonlyMap<number, { kind: string; owner: number | null }> | ReadonlyArray<{ cell: number; kind: string; owner: number | null }>
  /** 生长次数 / 冷却（影响后续生长，必须一起比对）。 */
  readonly magicGrowths?: number
  readonly magicCooldown?: number
  /** 角色技能状态（bugv10 #11：技能联机后必须一起比对）。 */
  readonly shield?: readonly [number, number]
  readonly bonusActions?: readonly [number, number]
  readonly actionsTaken?: readonly [number, number]
  readonly skillReadyAt?: readonly [readonly number[], readonly number[]]
  /** 回合序号 / 无敌到期回合（bugv10 #9）。 */
  readonly turnNo?: number
  readonly immuneUntil?: readonly [number, number]
  /** 伤害加成到期回合（bugv12：小一哥持续 2 回合）。 */
  readonly powerUntil?: readonly [number, number]
  /** 棋盘上的烈焰（bugv10 #9 恶龙吐息）。 */
  readonly flames?: ReadonlyMap<number, number> | ReadonlyArray<readonly [number, number]>
  /** 叠在敌方棋子上的额外棋子（bugv10 #9 毒鸡蛋）。 */
  readonly overlay?: ReadonlyMap<number, number> | ReadonlyArray<readonly [number, number]>
  /** 本回合是否可以在敌方棋子上落子。 */
  readonly sabotage?: readonly [boolean, boolean]
  /** 本回合毒鸡蛋的额外伤害（bugv12 #3）。 */
  readonly sabotageBonus?: readonly [number, number]
  /** 「双子星」的爆发窗口（bugv11 #5：两连即可攻击 + 免反击）。 */
  readonly twinStar?: readonly [boolean, boolean]
  /** 下次双子星是否**消耗 -1**（bugv12 #3 / bugv14）。 */
  readonly bloomCheaperNext?: readonly [boolean, boolean]
  /** 临时护甲与到期回合（bugv14 精密计算）。 */
  readonly tempArmor?: readonly [number, number]
  readonly tempArmorUntil?: readonly [number, number]
  /** 「深度思考」的额外攻击值与到期回合（bugv14）。 */
  readonly strikeBonus?: readonly [number, number]
  readonly strikeUntil?: readonly [number, number]
  /** 「播种」窗口（bugv14）。 */
  readonly seedGrow?: readonly [boolean, boolean]
  /** bugv19：低消耗档「杀鲸霸拳」——本回合植物不加伤。 */
  readonly noPlantBonus?: readonly [boolean, boolean]
  /** bugv34m：Qwen「本地部署」的窗口与本回合的伤害加成。 */
  readonly deploy?: readonly [boolean, boolean]
  readonly deployBonus?: readonly [number, number]
  /** bugv34m：Qwen「小千问」待重新部署的棋子（编码值：原格 * 2 + 叠子位）。 */
  readonly redeployPending?: readonly [readonly number[], readonly number[]]
  /** 烈焰归属（bugv14）：格子 -> 主人。 */
  readonly flameOwner?: ReadonlyMap<number, number> | ReadonlyArray<readonly [number, number]>
  /** 各技能已经释放过几次（bugv11 #6：首次免费）。 */
  readonly skillCasts?: readonly [readonly number[], readonly number[]]
  /** 黑夜阶段 / 预告剩余 / 持续回合 / 距上次结束（bugv34）。 */
  readonly nightPhase?: string
  readonly nightCountdown?: number
  readonly nightTurns?: number
  readonly turnsSinceNight?: number
  /** 当前天气（bugv34）。 */
  readonly weather?: string | null
  /** 双方发起过的攻击棋子数 + 本次黑夜起点（bugv34）。 */
  readonly attacksLaunched?: readonly [number, number]
  readonly nightAttackBase?: readonly [number, number]
  /** 本次黑夜是否由「黑夜开局」触发（bugv34d：影响退出条件，必须一起比对）。 */
  readonly nightFromStart?: boolean
}

function pairMapText(
  input: ReadonlyMap<number, number> | ReadonlyArray<readonly [number, number]> | undefined,
): string {
  if (!input) return ''
  const entries: Array<readonly [number, number]> =
    input instanceof Map ? [...(input as ReadonlyMap<number, number>).entries()] : [...input]
  return entries
    .map(([key, value]) => `${key}:${value}`)
    .sort()
    .join(',')
}

/** 把局面压成一个稳定的字符串（便于调试比对）。 */
export function digestText(input: DigestInput): string {
  const highlights: Array<readonly [number, number]> = input.highlights
    ? input.highlights instanceof Map
      ? [...(input.highlights as ReadonlyMap<number, number>).entries()]
      : [...(input.highlights as ReadonlyArray<readonly [number, number]>)]
    : []
  const highlightText = highlights
    .map(([cell, weight]) => `${cell}:${weight}`)
    .sort()
    .join(',')
  const magicList = input.magic
    ? input.magic instanceof Map
      ? [...(input.magic as ReadonlyMap<number, { kind: string; owner: number | null }>).entries()].map(
          ([cell, plant]) => ({ cell, kind: plant.kind, owner: plant.owner }),
        )
      : [...(input.magic as ReadonlyArray<{ cell: number; kind: string; owner: number | null }>)]
    : []
  const magicText = magicList
    .map((plant) => `${plant.cell}:${plant.kind}:${plant.owner ?? '-'}`)
    .sort()
    .join(',')
  const skillReadyText = input.skillReadyAt
    ? `${input.skillReadyAt[0].join('.')}/${input.skillReadyAt[1].join('.')}`
    : ''
  const skillCastsText = input.skillCasts
    ? `${input.skillCasts[0].join('.')}/${input.skillCasts[1].join('.')}`
    : ''
  const redeployText = input.redeployPending
    ? `${input.redeployPending[0].join('.')}/${input.redeployPending[1].join('.')}`
    : ''
  return [
    input.board.join(''),
    `${input.hp[0]},${input.hp[1]}`,
    input.phase,
    input.current,
    input.firstPlayer ?? '-',
    input.highlightOwner ?? '-',
    highlightText,
    magicText,
    `${input.magicGrowths ?? 0}/${input.magicCooldown ?? 0}`,
    // bugv10 #11：技能状态（护盾 / 连击 / 冷却 / 无敌 / 烈焰 / 叠子）
    `${input.shield?.[0] ?? 0},${input.shield?.[1] ?? 0}`,
    `${input.bonusActions?.[0] ?? 0},${input.bonusActions?.[1] ?? 0}`,
    `${input.actionsTaken?.[0] ?? 0},${input.actionsTaken?.[1] ?? 0}`,
    skillReadyText,
    `${input.turnNo ?? 0}`,
    `${input.immuneUntil?.[0] ?? 0},${input.immuneUntil?.[1] ?? 0}`,
    `${input.powerUntil?.[0] ?? 0},${input.powerUntil?.[1] ?? 0}`,
    pairMapText(input.flames),
    pairMapText(input.overlay),
    // bugv11 #5/#6：双子星爆发窗口 + 各技能释放次数（首次免费靠它判定）
    `${input.twinStar?.[0] ? 1 : 0}${input.twinStar?.[1] ? 1 : 0}`,
    `${input.sabotage?.[0] ? 1 : 0}${input.sabotage?.[1] ? 1 : 0}`,
    `${input.sabotageBonus?.[0] ?? 0},${input.sabotageBonus?.[1] ?? 0}`,
    `${input.bloomCheaperNext?.[0] ? 1 : 0}${input.bloomCheaperNext?.[1] ? 1 : 0}`,
    // bugv14：临时护甲（值 + 到期）、深度思考（值 + 到期）、播种窗口、烈焰归属
    `${input.tempArmor?.[0] ?? 0},${input.tempArmor?.[1] ?? 0}`,
    `${input.tempArmorUntil?.[0] ?? 0},${input.tempArmorUntil?.[1] ?? 0}`,
    `${input.strikeBonus?.[0] ?? 0},${input.strikeBonus?.[1] ?? 0}`,
    `${input.strikeUntil?.[0] ?? 0},${input.strikeUntil?.[1] ?? 0}`,
    `${input.seedGrow?.[0] ? 1 : 0}${input.seedGrow?.[1] ? 1 : 0}`,
    // bugv19：杀鲸霸拳低消耗档（会影响伤害，必须进指纹）
    `${input.noPlantBonus?.[0] ? 1 : 0}${input.noPlantBonus?.[1] ? 1 : 0}`,
    pairMapText(input.flameOwner),
    skillCastsText,
    // bugv34m：Qwen 的两个技能状态（本地部署窗口 / 伤害加成 / 小千问待部署表）
    `${input.deploy?.[0] ? 1 : 0}${input.deploy?.[1] ? 1 : 0}`,
    `${input.deployBonus?.[0] ?? 0},${input.deployBonus?.[1] ?? 0}`,
    redeployText,
    // bugv34：黑夜 / 天气 / 攻击棋子计数（联机两端必须一起比对）
    `${input.nightPhase ?? 'none'}`,
    `${input.nightCountdown ?? 0}`,
    `${input.nightTurns ?? 0}`,
    `${input.turnsSinceNight ?? 999}`,
    `${input.weather ?? '-'}`,
    `${input.attacksLaunched?.[0] ?? 0},${input.attacksLaunched?.[1] ?? 0}`,
    `${input.nightAttackBase?.[0] ?? 0},${input.nightAttackBase?.[1] ?? 0}`,
    // bugv34d：黑夜开局标记（影响"无主植物"是否参与强制退出判定）
    `${input.nightFromStart ? 1 : 0}`,
  ].join('|')
}

/** 局面指纹（8 位十六进制）。 */
export function stateDigest(input: DigestInput): string {
  return fnv1a(digestText(input)).toString(16).padStart(8, '0')
}
