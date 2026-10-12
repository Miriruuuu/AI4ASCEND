<script setup lang="ts">
/**
 * 联机房间（大厅）（bugv34e；bugv34i 改版）。
 *
 * 匹配成功 / 建房 / 加入房间之后都会落到这里（**不再直接开局**）：
 * - **上下排版**：房间号、两名成员、我的角色、底部三个按钮，全部竖着排；
 * - 底部三按钮并排：**准备 / 房间设置 / 退出**（原来的「设置」「返回主菜单」已去掉）；
 * - **双方都点「准备」** 才自动开局（没有单独的「开始游戏」按钮）；
 * - 「房间设置」**谁都能点开看**，只是非房主只能看不能改；
 * - 选角色用与单机**同一套** `CharacterPicker`。
 */
import { computed, ref } from 'vue'
import { CHARACTERS, findCharacter, type CharacterId, type CharacterDef } from '../characters'
import type { OnlineRoomMember, OnlineRoomState } from '../online'
import CharacterDetail from './CharacterDetail.vue'
import CharacterPicker from './CharacterPicker.vue'

const props = defineProps<{
  room: OnlineRoomState
  connected: boolean
  message: string
}>()

const emit = defineEmits<{
  (event: 'leave'): void
  (event: 'ready', ready: boolean): void
  (event: 'settings-panel'): void
  (event: 'transfer', playerId: string): void
  (event: 'character', characterId: string): void
}>()

const copied = ref(false)

/** 我自己（房间视图里 `you` 就是自己的 playerId）。 */
const me = computed<OnlineRoomMember | null>(
  () => props.room.members.find((member) => member.playerId === props.room.you) ?? null,
)
/** 对手（两人才会开局）。 */
const rival = computed<OnlineRoomMember | null>(
  () => props.room.members.find((member) => member.playerId !== props.room.you) ?? null,
)
const isHost = computed(() => me.value?.host === true)
const playing = computed(() => props.room.phase === 'playing')
const bothReady = computed(() => props.room.canStart)
const myReady = computed(() => me.value?.ready === true)

/** 房间号里每一位单独渲染，便于阅读。 */
const codeChars = computed(() => props.room.code.split(''))

/** 我在角色选择器里用的值（房间只有"我"这一侧）。 */
const myCharacter = computed<CharacterId>(() => findCharacter(me.value?.character ?? '').id)

/** 我选中的角色定义（右栏技能详情用 —— 与单机同一套）. */
const myCharacterDef = computed<CharacterDef>(() => findCharacter(myCharacter.value))

function characterOf(member: OnlineRoomMember | null): string {
  if (!member) return '—'
  return findCharacter(member.character).name
}

function portraitOf(member: OnlineRoomMember | null): string {
  if (!member) return ''
  return findCharacter(member.character).art.idle
}

async function copyCode(): Promise<void> {
  try {
    await navigator.clipboard?.writeText(props.room.code)
  } catch {
    /* 剪贴板不可用时忽略，用户还能手动抄 */
  }
  copied.value = true
  globalThis.setTimeout(() => {
    copied.value = false
  }, 1600)
}

/** 选角色（与单机同一个组件）：随机卡在这里就地抽一个角色。 */
function pickCharacter(id: CharacterId | 'random'): void {
  if (id === 'random') {
    emit('character', CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)].id)
    return
  }
  emit('character', id)
}
</script>

<template>
  <div class="start-menu">
    <div class="start-menu__inner room-view">
      <header class="start-menu__brand">
        <h1>房间</h1>
        <p>{{ bothReady ? '双方已准备，正在开局…' : 'ROOM · 双方都点「准备」后自动开始' }}</p>
      </header>

      <!-- 房间号 -->
      <div class="room-view__code">
        <span class="room-view__code-label">房间号</span>
        <span class="room-view__code-chars">
          <b v-for="(char, index) in codeChars" :key="index">{{ char }}</b>
        </span>
        <button class="ghost-btn" type="button" @click="copyCode">{{ copied ? '已复制' : '复制' }}</button>
        <span class="room-view__code-tip">断线后凭这个号可以回到房间</span>
      </div>

      <!-- 成员（上下排版） -->
      <div class="room-members">
        <article
          v-for="slot in [me, rival]"
          :key="slot ? slot.playerId : 'empty'"
          class="room-member"
          :class="{
            'is-me': slot && me && slot.playerId === me.playerId,
            'is-offline': slot && !slot.connected,
            'is-ready': slot?.ready === true,
          }"
        >
          <template v-if="slot">
            <img v-if="portraitOf(slot)" class="room-member__art" :src="portraitOf(slot)" :alt="slot.name" />
            <div class="room-member__body">
              <div class="room-member__name">
                {{ slot.name }}
                <span v-if="slot.host" class="room-member__badge is-host">房主</span>
                <span v-if="me && slot.playerId === me.playerId" class="room-member__badge">你</span>
                <span v-if="!slot.connected" class="room-member__badge is-offline">已离线</span>
                <span v-if="slot.ready" class="room-member__badge is-ready">已准备</span>
              </div>
              <div class="room-member__meta">
                角色 · {{ characterOf(slot) }}
                <span class="room-member__wins">{{ slot.wins }} 胜</span>
              </div>
            </div>
            <button
              v-if="isHost && me && slot.playerId !== me.playerId"
              class="link-btn room-member__transfer"
              type="button"
              :disabled="playing"
              @click="emit('transfer', slot.playerId)"
            >
              把房主交给 TA
            </button>
          </template>
          <template v-else>
            <div class="room-member__empty">
              <p>等待另一位玩家…</p>
              <p class="room-member__empty-tip">把房间号发给 TA，或在主菜单用「在线匹配」</p>
            </div>
          </template>
        </article>
      </div>

      <!--
        我的角色（与单机同一套选择器 + **同一套技能详情**，bugv34k）。
        bugv34l 版式：**左栏 = 角色选择器 + 底部三按钮**，**右栏 = 技能详情**。
        以前是"选择器 / 技能详情"左右并排、按钮在最下面通栏：
        轮播矮、技能详情高，两者高度差会在选择器下方留一大块空白；
        把按钮塞进左栏正好把左列撑满，空白没了，按钮也更靠近选角色的位置。
      -->
      <div class="room-deck-layout">
        <div class="room-deck-main">
          <div class="room-field">
            <div class="room-field__label">我的角色</div>
            <CharacterPicker
              :characters="CHARACTERS"
              :value="[myCharacter, myCharacter]"
              :only="0"
              :compact="false"
              @pick="(_side, id) => pickCharacter(id)"
            />
          </div>

          <p v-if="message" class="online-lobby__message">{{ message }}</p>

          <!--
            左栏底部按钮（bugv34m）：**去掉描述文案**，「准备」独占一行、另外两个并排一行。
            （原来三个按钮挤在一行、每个都带两行文案，窄栏里文字被截断得很难看。）
          -->
          <nav class="room-actions">
            <button
              class="menu-btn room-actions__btn room-actions__btn--wide"
              :class="{ 'menu-btn--primary': !myReady }"
              type="button"
              :disabled="playing || !connected"
              @click="emit('ready', !myReady)"
            >
              <span class="menu-btn__label">{{ myReady ? '取消准备' : '准备' }}</span>
            </button>

            <button class="menu-btn room-actions__btn" type="button" @click="emit('settings-panel')">
              <span class="menu-btn__label">房间设置</span>
            </button>

            <button class="menu-btn room-actions__btn is-danger" type="button" @click="emit('leave')">
              <span class="menu-btn__label">退出房间</span>
            </button>
          </nav>
        </div>

        <!-- 右栏：技能信息（与单机开始菜单的右栏同一个组件） -->
        <CharacterDetail
          class="room-deck-detail"
          :character="myCharacterDef"
          :side="0"
          side-label="我的角色"
        />
      </div>
    </div>
  </div>
</template>
