/**
 * 匹配服务单测（bugv34e 起只管排队）+ **房间（大厅）单测**（`RoomManager`）。
 *
 * 房间相关的用例从原来的匹配码房间迁到这里，并覆盖新语义：
 * 加入不再直接开局、断线只标记离线、显式退出才移除成员、全部退出才销毁房间（比分 / 聊天）。
 */
import { describe, expect, it } from 'vitest'
import { CODE_ALPHABET, MatchingService, generateCode, normalizeCode, type Participant } from '../src/matching'
import { DEFAULT_ROOM_SETTINGS, ROOM_HP_LIMITS, RoomManager, sanitizeChat, type Room } from '../src/room'
import { DEFAULT_MAGIC_CONFIG, DEFAULT_NIGHT_CONFIG, resolveMagicConfig, resolveNightConfig } from '../src/core/types'
import type { ServerMessage } from '../src/protocol'

class FakePlayer implements Participant {
  readonly inbox: ServerMessage[] = []
  character?: Participant['character']

  constructor(
    readonly playerId: string,
    public name = playerId,
  ) {}

  send(message: ServerMessage): void {
    this.inbox.push(message)
  }
}

/**
 * bugv34i：`canStart` 现在要求**双方都已点「准备」**，这里一键把房间里的人全部准备。
 */
function readyAll(room: Room, ...playerIds: string[]): void {
  for (const id of playerIds) room.setReady(id, true, 0)
}

function makeService(): { service: MatchingService; matched: Array<{ host: string; guest: string }> } {
  const matched: Array<{ host: string; guest: string }> = []
  const service = new MatchingService({
    onMatch: (host, guest) => matched.push({ host: host.playerId, guest: guest.playerId }),
  })
  return { service, matched }
}

describe('匹配码生成', () => {
  it('恒为 6 位大写，且不含易混淆的 0 / O / 1 / I', () => {
    for (let i = 0; i < 500; i += 1) {
      const code = generateCode()
      expect(code).toHaveLength(6)
      for (const char of code) expect(CODE_ALPHABET.includes(char)).toBe(true)
    }
    expect(CODE_ALPHABET).not.toMatch(/[01OI]/)
    expect(normalizeCode(' abC234 ')).toBe('ABC234')
  })
})

describe('MatchingService（bugv34e：只排队，不再开局）', () => {
  it('在线匹配是 FIFO：第 2 个人入队即回调 onMatch（由上层放进同一个房间）', () => {
    const { service, matched } = makeService()
    const a = new FakePlayer('a')
    const b = new FakePlayer('b')

    expect(service.enqueue(a)).toBe(1)
    expect(service.queueSize).toBe(1)
    expect(service.positionOf('a')).toBe(1)
    expect(service.enqueue(b)).toBe(2)
    expect(matched).toEqual([{ host: 'a', guest: 'b' }])
    expect(service.queueSize).toBe(0)
    expect(service.positionOf('a')).toBeNull()
  })

  it('重复入队幂等，cancel / removePlayer 生效', () => {
    const { service } = makeService()
    const a = new FakePlayer('a')
    expect(service.enqueue(a)).toBe(1)
    expect(service.enqueue(a)).toBe(1)
    expect(service.queueSize).toBe(1)
    expect(service.cancel('a')).toBe(true)
    expect(service.cancel('a')).toBe(false)
    service.enqueue(a)
    service.removePlayer('a')
    expect(service.queueSize).toBe(0)
  })

  it('dispose 清空队列', () => {
    const { service } = makeService()
    service.enqueue(new FakePlayer('a'))
    service.dispose()
    expect(service.queueSize).toBe(0)
  })
})

describe('RoomManager（房间 / 大厅）', () => {
  function makeRooms(): { rooms: RoomManager; clock: { now: number } } {
    const clock = { now: 1_000_000 }
    let seq = 0
    const rooms = new RoomManager({
      now: () => clock.now,
      codeGenerator: () => `ROOM${String(++seq).padStart(2, '0')}`,
    })
    return { rooms, clock }
  }

  it('建房：房主是自己，房间号 6 位，设置是默认值', () => {
    const { rooms } = makeRooms()
    const host = new FakePlayer('host')
    const room = rooms.create(host)
    expect(room.code).toHaveLength(6)
    expect(room.isHost('host')).toBe(true)
    expect(room.size).toBe(1)
    expect(room.phase).toBe('lobby')
    expect(room.canStart).toBe(false)
    expect(room.settings).toEqual(DEFAULT_ROOM_SETTINGS)
    expect(rooms.roomOfPlayer('host')?.code).toBe(room.code)
  })

  it('加入：第二个人进房后 canStart；第三个人 roomFull；自己加自己视为"回到房间"', () => {
    const { rooms } = makeRooms()
    const host = new FakePlayer('host')
    const guest = new FakePlayer('guest')
    const third = new FakePlayer('third')
    const room = rooms.create(host)

    expect(rooms.join(room.code.toLowerCase(), guest).ok).toBe(true)
    // bugv34i：两人都在也还不能开局 —— 要双方都点「准备」
    expect(room.canStart).toBe(false)
    readyAll(room, 'host', 'guest')
    expect(room.canStart).toBe(true)

    const full = rooms.join(room.code, third)
    expect(full.ok).toBe(false)
    expect(full.code).toBe('roomFull')

    // 已经是成员 → 不算 roomFull（这就是"回到房间"）
    const back = rooms.join(room.code, host)
    expect(back.ok).toBe(true)
  })

  it('不存在 / 已销毁的房间号 → roomNotFound', () => {
    const { rooms } = makeRooms()
    expect(rooms.join('ZZZZZZ', new FakePlayer('x')).code).toBe('roomNotFound')
    const room = rooms.create(new FakePlayer('host'))
    rooms.destroy(room.code)
    expect(rooms.join(room.code, new FakePlayer('y')).code).toBe('roomNotFound')
  })

  it('房间设置：血量上限只接受 8/12/16；魔力植物与黑夜按 resolve 合并', () => {
    const { rooms } = makeRooms()
    const room = rooms.create(new FakePlayer('host'))
    room.patchSettings({ hpLimit: 16 }, resolveMagicConfig, resolveNightConfig, 0)
    expect(room.settings.hpLimit).toBe(16)
    // 非法值被忽略
    room.patchSettings({ hpLimit: 99 }, resolveMagicConfig, resolveNightConfig, 0)
    expect(room.settings.hpLimit).toBe(16)
    expect(ROOM_HP_LIMITS).toEqual([8, 12, 16])

    room.patchSettings({ magic: { maxCount: 3 }, night: { warnTurns: 5 } }, resolveMagicConfig, resolveNightConfig, 0)
    expect(room.settings.magic.maxCount).toBe(3)
    // 其它字段保持默认
    expect(room.settings.magic.cooldownTurns).toBe(DEFAULT_MAGIC_CONFIG.cooldownTurns)
    expect(room.settings.night.warnTurns).toBe(5)
    expect(room.settings.night.minGap).toBe(DEFAULT_NIGHT_CONFIG.minGap)
  })

  it('断线只标记离线（房间保留）；重连 markOnline 后 canStart 恢复', () => {
    const { rooms, clock } = makeRooms()
    const host = new FakePlayer('host')
    const guest = new FakePlayer('guest')
    const room = rooms.create(host)
    rooms.join(room.code, guest)
    readyAll(room, 'host', 'guest')
    expect(room.canStart).toBe(true)

    clock.now += 1000
    const offline = rooms.markOffline('guest')
    expect(offline?.code).toBe(room.code)
    expect(room.size).toBe(2)
    // 离线即取消准备
    expect(room.canStart).toBe(false)
    expect(room.isReady('guest')).toBe(false)

    // 凭房间号回来（回来之后要重新点准备）
    expect(rooms.join(room.code, guest).ok).toBe(true)
    expect(room.canStart).toBe(false)
    readyAll(room, 'guest')
    expect(room.canStart).toBe(true)
  })

  it('显式退出才移除成员；全部退出后房间数据（比分 / 聊天）销毁', () => {
    const { rooms } = makeRooms()
    const host = new FakePlayer('host')
    const guest = new FakePlayer('guest')
    const room = rooms.create(host)
    rooms.join(room.code, guest)
    room.pushChat({ playerId: 'host', name: 'host' }, 'hello', 0)
    room.endMatch('host', 0)
    expect(room.member('host')?.wins).toBe(1)

    expect(rooms.leave('guest')).toBe(false) // 还有人在 → 不销毁
    expect(room.size).toBe(1)
    expect(rooms.roomOfPlayer('guest')).toBeNull()

    expect(rooms.leave('host')).toBe(true) // 最后一人 → 销毁
    expect(rooms.size).toBe(0)
    expect(rooms.get(room.code)).toBeNull()
  })

  it('房主退出 → 房主自动交给最早加入的剩下成员', () => {
    const { rooms, clock } = makeRooms()
    const host = new FakePlayer('host')
    const guest = new FakePlayer('guest')
    const room = rooms.create(host)
    clock.now += 10
    rooms.join(room.code, guest)
    clock.now += 10
    rooms.leave('host')
    expect(room.host).toBe('guest')
  })

  it('转让房主：目标必须是成员', () => {
    const { rooms } = makeRooms()
    const host = new FakePlayer('host')
    const guest = new FakePlayer('guest')
    const room = rooms.create(host)
    rooms.join(room.code, guest)
    expect(room.transferHost('nobody', 0)).toBe(false)
    expect(room.transferHost('guest', 0)).toBe(true)
    expect(room.isHost('guest')).toBe(true)
    expect(room.isHost('host')).toBe(false)
  })

  it('对局中：不能加入（roomPlaying），对局结束后回到 lobby 且比分累计', () => {
    const { rooms } = makeRooms()
    const host = new FakePlayer('host')
    const guest = new FakePlayer('guest')
    const room = rooms.create(host)
    rooms.join(room.code, guest)

    room.beginMatch('m1', 0)
    expect(room.phase).toBe('playing')
    expect(room.matchId).toBe('m1')
    expect(rooms.join(room.code, new FakePlayer('third')).code).toBe('roomPlaying')

    rooms.finishMatch(room, 'guest')
    expect(room.phase).toBe('lobby')
    expect(room.matchId).toBeNull()
    expect(room.member('guest')?.wins).toBe(1)
    // bugv34i：一局结束后准备状态被清空（要重新准备才开下一局）
    expect(room.isReady('host')).toBe(false)
    expect(room.canStart).toBe(false)
    readyAll(room, 'host', 'guest')
    expect(room.canStart).toBe(true)
  })

  it('聊天：清洗空白 / 控制字符、限长；空文本不入库', () => {
    const { rooms } = makeRooms()
    const room = rooms.create(new FakePlayer('host'))
    expect(room.pushChat({ playerId: 'host', name: 'host' }, '   ', 0)).toBeNull()
    expect(sanitizeChat('a\u0000b\n  c')).toBe('ab c')
    expect(sanitizeChat('x'.repeat(500)).length).toBeLessThanOrEqual(120)
    const entry = room.pushChat({ playerId: 'host', name: 'host' }, ' 你好 ', 0)
    expect(entry?.text).toBe('你好')
    expect(room.chat).toHaveLength(1)
  })

  it('全员离线的房间才会被 sweep 回收（有人在线则无限保留）', () => {
    const { rooms, clock } = makeRooms()
    const host = new FakePlayer('host')
    const guest = new FakePlayer('guest')
    const room = rooms.create(host)
    rooms.join(room.code, guest)
    rooms.markOffline('host')
    rooms.markOffline('guest')

    clock.now += 60_000
    expect(rooms.sweep(120_000)).toBe(0)

    clock.now += 120_001
    expect(rooms.sweep(120_000)).toBe(1)
    expect(rooms.get(room.code)).toBeNull()
  })

  it('createWith：匹配双方进同一个房间（房主是传入的 host）', () => {
    const { rooms } = makeRooms()
    const host = new FakePlayer('host')
    const guest = new FakePlayer('guest')
    const room = rooms.createWith(host, guest)
    expect(room.size).toBe(2)
    expect(room.isHost('host')).toBe(true)
    expect(room.canStart).toBe(false)
    readyAll(room, 'host', 'guest')
    expect(room.canStart).toBe(true)
    expect(rooms.roomOfPlayer('guest')?.code).toBe(room.code)
  })

  it('snapshot()：视图包含 you / 房主标记 / 比分 / 聊天 / canStart', () => {
    const { rooms } = makeRooms()
    const host = new FakePlayer('host')
    const guest = new FakePlayer('guest')
    const room = rooms.create(host)
    rooms.join(room.code, guest)
    room.endMatch('guest', 0)
    readyAll(room, 'host')
    room.beginMatch('m1', 0)
    room.pushChat({ playerId: 'host', name: 'host' }, 'hi', 0)

    const view = room.snapshot('guest')
    expect(view.you).toBe('guest')
    expect(view.code).toBe(room.code)
    expect(view.phase).toBe('playing')
    expect(view.matchId).toBe('m1')
    expect(view.members.map((m) => m.playerId)).toEqual(['host', 'guest'])
    expect(view.members.find((m) => m.playerId === 'host')?.host).toBe(true)
    expect(view.members.find((m) => m.playerId === 'guest')?.wins).toBe(1)
    // 准备状态也要一并出现在视图里（客户端用它渲染「准备」按钮）
    expect(view.members.find((m) => m.playerId === 'host')?.ready).toBe(true)
    expect(view.members.find((m) => m.playerId === 'guest')?.ready).toBe(false)
    expect(view.canStart).toBe(false)
    expect(view.chat).toHaveLength(1)
  })
})
