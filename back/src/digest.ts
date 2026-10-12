/**
 * 局面指纹：直接复用纯逻辑内核 `src/core/digest.ts`（与前端逐字节一致）。
 *
 * 这里只做转出，避免在服务端重复实现一份"看起来一样"的散列。
 */
export { fnv1a, digestText, stateDigest } from './core/digest'
export type { DigestInput } from './core/digest'

import type { GameEngine } from './core/engine'
import { stateDigest } from './core/digest'

/** 取当前引擎局面的指纹（服务端下发的 `digest` 就是它）。 */
export function digestOfEngine(engine: GameEngine): string {
  return stateDigest({
    board: engine.board,
    hp: engine.hp,
    phase: engine.phase,
    current: engine.current,
    firstPlayer: engine.firstPlayer,
    highlightOwner: engine.highlightOwner,
    highlights: engine.highlights,
    // 魔力植物参与指纹（bugv8 #4）：两端长出的位置必须一致
    magic: engine.magic,
    magicGrowths: engine.magicGrowths,
    magicCooldown: engine.magicCooldown,
    // 技能状态参与指纹（bugv10 #11）：少一项两端就会永远对不上、无限 sync
    shield: engine.shield,
    bonusActions: engine.bonusActions,
    actionsTaken: engine.actionsTaken,
    skillReadyAt: engine.skillReadyAt,
    turnNo: engine.turnNo,
    immuneUntil: engine.immuneUntil,
    /**
     * bugv27 #4：**这里必须与前端 `localDigest()` 传的字段集合完全一致**。
     *
     * 客户端把下面这些也塞进了指纹文本；服务端少传一项，同一局面就会算出**两个不同的
     * 指纹** ⇒ 客户端每一步都判定"漂移"、疯狂 `sync`（gtp / glm / claude / deepseek
     * 只要有技能生效就会触发）。这是"新角色联机不正常"的根因。
     */
    powerUntil: engine.powerUntil,
    flames: engine.flames,
    overlay: engine.overlay,
    // bugv11 #5/#6：双子星爆发窗口 + 各技能释放次数（首次免费靠它判定）
    twinStar: engine.twinStar,
    sabotage: engine.sabotage,
    sabotageBonus: engine.sabotageBonus,
    bloomCheaperNext: engine.bloomCheaperNext,
    // bugv14：临时护甲（值 + 到期）、力大砖飞（值 + 到期）、布局窗口、烈焰归属
    tempArmor: engine.tempArmor,
    tempArmorUntil: engine.tempArmorUntil,
    strikeBonus: engine.strikeBonus,
    strikeUntil: engine.strikeUntil,
    seedGrow: engine.seedGrow,
    // bugv19：杀鲸霸拳低消耗档（会影响伤害）
    noPlantBonus: engine.noPlantBonus,
    flameOwner: engine.flameOwner,
    skillCasts: engine.skillCasts,
    // bugv34：黑夜 / 天气 / 攻击棋子计数（必须与前端 localDigest 完全一致）
    nightPhase: engine.nightPhase,
    nightCountdown: engine.nightCountdown,
    nightTurns: engine.nightTurns,
    turnsSinceNight: engine.turnsSinceNight,
    weather: engine.weather,
    attacksLaunched: engine.attacksLaunched,
    nightAttackBase: engine.nightAttackBase,
    // bugv34d：黑夜开局标记（影响"无主植物"是否参与强制退出判定）
    nightFromStart: engine.nightFromStart,
    // bugv34m：Qwen「本地部署」的窗口 / 加伤与「小千问」的待部署表
    deploy: engine.deploy,
    deployBonus: engine.deployBonus,
    redeployPending: engine.redeployPending,
  })
}
