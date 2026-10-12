/**
 * 角色系统（bugv9 #13 引入，bugv10 #9 扩充）。
 *
 * 数值与技能表放在 `src/core/characters.ts`（纯数据，服务端也用同一份）；
 * 这里只负责把它补成"能显示的角色"：立绘（5 个表情差分）、技能图标与文案。
 *
 * 立绘用 `import.meta.glob` 扫描 `src/assets/img/`：把 `deepseek.png`、
 * `deepseek-atk.png`、`deepseek-hit.png`、`deepseek-win.png`、`deepseek-lose.png`
 * 这样的文件丢进去就会被自动识别；缺哪个表情就退回基础立绘。
 */
import {
  CHARACTER_SPECS,
  DEFAULT_CHARACTERS,
  findCharacterSpec,
  isCharacterId,
  skillsOfCharacter,
  type CharacterId,
  type CharacterSpec,
} from '../core/characters'
import type { PlayerIndex, SkillEffect, SkillSpec } from '../core/types'

export { DEFAULT_CHARACTERS, isCharacterId, skillsOfCharacter }
export type { CharacterId, CharacterSpec }

/** 表情差分（bugv9 #13：idle / atk / hit / win / lose）。 */
export type Expression = 'idle' | 'atk' | 'hit' | 'win' | 'lose'

export interface CharacterDef extends CharacterSpec {
  /** 各表情的立绘地址。 */
  readonly art: Readonly<Record<Expression, string>>
}

/** 立绘资源（Vite 会把它们输出成资源 URL）。 */
const ART_MODULES = import.meta.glob('../assets/img/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

/** 文件名（不含扩展名）-> URL。 */
const ART_BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(ART_MODULES).map(([path, url]) => [path.split('/').pop()?.replace(/\.png$/i, '') ?? path, url]),
)

function artOf(id: string, expression: Expression): string {
  const key = expression === 'idle' ? id : `${id}-${expression}`
  return ART_BY_NAME[key] ?? ART_BY_NAME[id] ?? ''
}

/** 把 5 个表情一次性解析好（避免运行时反复查表）。 */
function artSet(id: CharacterId): Record<Expression, string> {
  const pick = (expression: Expression) => artOf(id, expression)
  return {
    idle: pick('idle'),
    atk: pick('atk'),
    hit: pick('hit'),
    win: pick('win'),
    lose: pick('lose'),
  }
}

/** 前端角色表 = core 数值 + 立绘。 */
export const CHARACTERS: readonly CharacterDef[] = CHARACTER_SPECS.map((spec) => ({
  ...spec,
  art: artSet(spec.id),
}))

export function findCharacter(id: CharacterId | string | null | undefined): CharacterDef {
  const spec = findCharacterSpec(id)
  return CHARACTERS.find((character) => character.id === spec.id) ?? CHARACTERS[0]
}

/** 某个角色的技能表（引擎只认数值）。 */
export function skillsOf(id: CharacterId | string): readonly SkillSpec[] {
  return findCharacter(id).skills
}

/** 技能效果的中文说明（UI / 规则面板）。 */
export function skillEffectText(spec: SkillSpec): string {
  if (spec.desc) return spec.desc
  switch (spec.effect) {
    case 'shield':
      return `获得 ${spec.amount} 点护盾（护盾先于血量承伤，可以叠加，但最多不超过血量上限）`
    case 'heal':
      return `恢复 ${spec.amount} 点血量（不超过初始血量）；受到伤害后冷却立即刷新`
    case 'double':
      return `本回合可以连续行动 ${spec.amount + 1} 次`
    case 'bloom':
      return `本回合落下的这颗子两连即可发起攻击（并且免疫对手的反击伤害）；若本回合成线攻击且对手没能成线反击，则恢复 ${spec.amount} 点血量`
    case 'immune':
      return `无敌 ${spec.amount} 回合：这段时间自己受到的伤害全部无效（能扛住对手一整回合的进攻，也能抵消反击）`
    case 'tempArmor':
      return (
        `直到自己的下个回合结束前获得 ${
          spec.amountFromMaxHp ? '等同于生命上限的' : `${spec.amount} 点`
        }临时护甲（先于护盾与血量承伤）；到期后未用完的部分作废`
      )
    case 'firstStrike':
      return `直到自己的下个回合结束前：**首个连珠攻击**伤害 +${spec.amount}；若成功造成伤害，伤害结算后移除其护盾；技能生效期间不能重复释放`
    case 'seedGrow':
      return `本回合落子若未形成连珠：落点以及它周围 ${spec.amount} 格的所有位置（空位与棋子，无论敌我）都长出魔力植物`
    case 'guardShare':
      return `自己获得 ${spec.amount} 点护盾，对手也获得 ${spec.shareToFoe ?? 0} 点护盾`
    case 'assault': {
      const v = spec.variableCost
      const range = v ? `${v.min}~${v.max}` : `${spec.cost}`
      return `消耗 ${range} 棵魔力植物直接进入攻击阶段，攻击值 = 消耗的植物数量；冷却 = ${
        v ? `${v.min * v.cooldownPerUnit}~${v.max * v.cooldownPerUnit}` : spec.cooldown
      } 回合`
    }
    case 'fireball':
      return `向目标位置投射火球：直击的棋子碎裂（该格植物一并消失），横竖空位燃烧 ${spec.amount} 回合（空位上的植物也被烧掉；开局可用、首次释放免费）`
    case 'power':
      return `伤害 +${spec.amount} 持续 ${spec.duration ?? 1} 回合；每次形成连珠后持续时间减少 2 回合，生效期间不能重复释放`
    case 'sabotage':
      return '本回合可以下在敌方棋子上（不顶替原棋子），并把这一格的魔力植物抢过来'
    case 'localDeploy':
      return (
        '本回合落子若未形成连珠：在落点长出一棵魔力植物（该格已有植物则跳过）；' +
        '若形成连珠：这一击伤害 +1'
      )
    case 'redeploy': {
      const v = spec.variableCost
      const range = v ? `${v.min}~${v.max}` : `${spec.cost}`
      return (
        `消耗 ${range} 棵魔力植物并移除压在上面的棋子；本回合落子若未形成连珠，` +
        `等量把棋子重新下到空位（优先吃下有无主魔力植物的空位，其次离落点最近的一圈，` +
        `不会下在会形成连珠的位置）；` +
        '放不下的棋子回原位并返还植物'
      )
    }
    default:
      return ''
  }
}

/** 技能图标的标识（程序化绘制用）。 */
export type SkillIconId = SkillEffect

export function skillIcon(spec: SkillSpec): SkillIconId {
  return spec.effect
}

/**
 * 攻击阶段的表情推导（bugv9 #13，bugv20 调整）。
 *
 * - 一方完成连珠 → 该方 `atk`；
 * - 防守方成线（双方对撞）→ 受到差值伤害的那一方 `hit`；
 * - 防守方**没有**成线（要挨打）→ 攻击方 `win`、防守方 `hit`（bugv20：以前是 `lose`；
 *   现在 `lose` 只表示"被击倒"，见 `impactExpression`）；
 * - 对局结束 → 胜方 `win`、负方 `lose`；
 * - 其余情况回到 `idle`。
 */
export function expressionFor(input: {
  finished: boolean
  winner: 0 | 1 | null
  attacker: 0 | 1 | null
  /** 防守方最终没成线（攻击方直接命中）。 */
  defenderMissed: boolean
  /** 受到伤害的一方（对撞后差值由劣势方承担）。 */
  damaged: 0 | 1 | null
}): [Expression, Expression] {
  const idle: [Expression, Expression] = ['idle', 'idle']
  if (input.finished) {
    if (input.winner === null) return idle
    return input.winner === 0 ? ['win', 'lose'] : ['lose', 'win']
  }
  if (input.damaged !== null) {
    return input.damaged === 0 ? ['hit', 'idle'] : ['idle', 'hit']
  }
  if (input.attacker !== null) {
    if (input.defenderMissed) {
      // 防守方没挡住：攻击方赢下这一手，防守方受伤（bugv20：hit，不再是 lose）
      return input.attacker === 0 ? ['win', 'hit'] : ['hit', 'win']
    }
    return input.attacker === 0 ? ['atk', 'idle'] : ['idle', 'atk']
  }
  return idle
}

/** `player` 那一侧切成 `value`，另一侧保持 `current`（bugv20 立绘工具）。 */
function withSide(
  current: readonly [Expression, Expression],
  player: PlayerIndex,
  value: Expression,
): [Expression, Expression] {
  return player === 0 ? [value, current[1]] : [current[0], value]
}

/**
 * 连珠瞬间的立绘（bugv20 #2）。
 *
 * - **非**攻击阶段（常规落子成线）：只有成线方 `atk`，另一方回 `idle`；
 * - **攻击阶段**（防守方反击成线）：成线方 `atk`，另一方**保持现状**
 *   —— 攻击方这时本来就是 `atk`，于是两边同时 `atk`（用户要求与攻击方一致）。
 */
export function matchExpression(
  owner: PlayerIndex,
  current: readonly [Expression, Expression],
  attackPhase: boolean,
): [Expression, Expression] {
  if (!attackPhase) return owner === 0 ? ['atk', 'idle'] : ['idle', 'atk']
  return withSide(current, owner, 'atk')
}

/**
 * 血条被棋子撞中时的立绘（bugv20 #1）。
 *
 * 以前 `attackResolved` 要等**整套撞击动画播完**才切差分，于是"最后一颗棋子撞完
 * （血条已经归零）才切 hit"。现在改成：
 *
 * - **第一颗**棋子撞到血条的那一刻立刻切 `hit`；
 * - 血量被打到 **0 及以下** → 切 `lose` 并维持（不再被后续分支改回去）。
 */
export function impactExpression(
  player: PlayerIndex,
  current: readonly [Expression, Expression],
  hp: number,
  index: number,
): [Expression, Expression] {
  if (hp <= 0) return withSide(current, player, 'lose')
  if (index === 0) return withSide(current, player, 'hit')
  return [current[0], current[1]]
}
