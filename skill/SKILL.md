---
name: connect4-3d
description: 把 3D 四子棋（9×9 连珠对战）模块并入既有 Vue 3 + TypeScript 工程时所需的依赖、改动与集成步骤。当任务涉及该游戏的移植/集成/依赖确认时使用。
---

# 引入 3D 四子棋模块（skill: connect4-3d）

本 skill 说明：把本仓库（`connect4-attack`）作为一个**前端游戏模块**并入既有
Vue 3 + TypeScript 工程时，需要补哪些依赖、动哪些文件、按什么顺序切进去。

---

## 1. 依赖清单

### 1.1 必须新增（运行时）

| 包 | 版本 | 用途 | 备注 |
| --- | --- | --- | --- |
| `three` | `^0.180.0` | 3D 渲染引擎（WebGL2）：棋盘、棋子、特效、粒子 | **唯一**硬依赖；约 488 kB（gzip 122 kB） |

> `three` 自带 TS 类型（0.180 起）。若宿主工程使用更早的 three 版本，需要
> `@types/three` 作为 devDependency 并确保版本一致，否则 `three/addons/*` 类型会缺失。
>
> 曾经用过 `cursor-effects` 做鼠标拖尾，但它的效果不像"尾巴"（`trailingCursor`
> 在匀速移动时会收敛成一个点、粒子效果像放烟花），bugv7 #2 起改成自绘 canvas
> 彗星尾迹（`src/app/cursor-trail.ts`，约 200 行、零依赖），因此**不再需要任何第三方 UI 库**。

### 1.1.1 静态资源（无需额外依赖）

| 资源 | 位置 | 说明 |
| --- | --- | --- |
| 背景音乐曲库 | `src/assets/bgm/*.mp3` | 代码用 `import.meta.glob('../assets/bgm/*.mp3', { eager: true, query: '?url', import: 'default' })` 自动列出**文件夹里所有** mp3，默认用 `let me go.mp3`（找不到就用第一首）；把新曲子丢进去就会出现在设置面板的下拉框与右下角微型播放器里。若宿主的构建器不支持 `import.meta.glob`，改成显式导入：`new BgmPlayer('/audio/let me go.mp3')` 并自行提供曲目列表 |
| 角色立绘 | `src/assets/img/*.png`（bugv9 #13，bugv10 #9 扩到 4 个角色） | 命名约定 `<角色>.png` = 基础立绘，`<角色>-atk/-hit/-win/-lose.png` = 表情差分（当前是 `deepseek*` / `gemini*` / `gtp*` / `glm*` 共 20 张，约 14.4 MB，都是正方形带白底）。同样用 `import.meta.glob('../assets/img/*.png', { query: '?url' })` 扫描，缺哪个表情会自动回退到基础立绘；不想用角色系统时把文件夹清空也不会报错（`characters.ts` 会返回空 URL，UI 退化成首字母色块） |

音效**不需要任何音频文件**：`src/three/audio.ts` 用 Web Audio 实时合成 11 个扳机 ×
2~4 套风格（落子 / 连珠 / 防守成线 / 对撞 / 撞击血条 / 界面 / 植物长出 / 植物被抢 / 门铃 /
棋子碎裂 / 火球烈焰），设置面板里可逐个扳机挑选并试听，也可以用 `setSound(false)` 整体静音。
技能图标同样是**程序化生成**的（`src/three/skill-icons.ts`，8 种图标，canvas → data URL），不需要图标资源。

> 两者都必须由**构建器**处理（Vite 会输出成带 hash 的资源 URL）。如果宿主是 webpack 或
> 纯静态目录，把 `import.meta.glob` 换成自己的资源映射即可 —— 这两个文件是唯一需要改的地方。

### 1.1.2 可选：联机后端（`back/`）

想开联机（bugv6 #8）时，把 `back/` 整个目录一起部署即可（Node 20+ 与 MongoDB）。
前端只有在使用「联机对战」模式时才会去连它，**单机玩法完全不依赖**：

| 后端依赖 | 用途 |
| --- | --- |
| `express` / `ws` / `mongodb` / `dotenv` | HTTP + WebSocket 网关、回放落库、配置 |
| `back/src/core/*` | 服务端权威裁决用的**同一份**纯逻辑引擎，由根目录 `pnpm sync:core` 从 `src/core` 复制 |

协议契约见 `back/PROTOCOL.md`，部署步骤见 `back/README.md`（含宝塔 + pm2 + Nginx 反代 WebSocket）。
前端侧只需要知道 `src/app/online.ts` 这个客户端封装：进联机大厅**自动连接**，
玩家界面上没有服务器地址 / 连接按钮。
连哪台由**构建模式**决定（bugv34f）：根目录 `.env.development`（`pnpm dev` → 本地
`http://localhost:8787`）/ `.env.production`（`pnpm build` → 宝塔那台
`http://113.45.13.149:8787`），`src/app/online.ts` 里有一份按模式兜底的常量；
自定义后端在构建时设 `VITE_SERVER_URL`（优先级最高）。

### 1.2 宿主已有的（本模块声明为 peerDependency，不要重复安装）

| 包 | 版本 | 说明 |
| --- | --- | --- |
| `vue` | `^3.5.0` | 本模块的 UI 层使用 `<script setup>` + 组合式 API |
| `typescript` | `>=5.4` | 用到 `satisfies`、模板字面量类型等 |

### 1.3 仅构建/测试需要（devDependencies）

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `vite` | `^7.1.0` | 构建（宿主若已是 vite 4/5，无需升级：本模块不依赖 vite 特性） |
| `@vitejs/plugin-vue` | `^6.0.0` | 编译 `.vue` |
| `vue-tsc` | `^3.1.0` | 类型检查 |
| `vitest` | `^3.2.0` | 规则 / AI / 编排单测 |
| `jsdom` | `^25.0.1` | store 编排测试的 DOM 环境 |
| `playwright-core` | `^1.63.0` | 浏览器端到端烟雾测试（复用本机 Chrome，无需下载浏览器） |
| `tsx` | `^4.20.0` | 运行 `scripts/verify-bugv*.ts` / `scripts/selfplay.ts` 这类一次性脚本（可选） |

### 1.4 明确**不需要**的依赖

| 不需要 | 原因 |
| --- | --- |
| `pixi.js` / `babylon.js` / `playcanvas` | 已选定 three.js；3D 透视 + 环境反射 + 泛光链路用 three 最直接 |
| `@vueuse/core` | 未使用；鼠标/尺寸监听已用原生 API 与 `ResizeObserver` 实现 |
| `@tweenjs/tween.js` / `gsap` | 自实现 `src/three/anim.ts`（约 120 行），避免为几十个补间引入动画库 |
| `cannon` / `rapier` 等物理引擎 | 特效为手工关键帧 + 程序化粒子，无需物理 |
| `pinia` / `vuex` | 单一组合式 store（`useConnectGame()`）已足够，且更易嵌入 |
| `postprocessing`（pmndrs） | 泛光使用 three 官方 `three/addons/postprocessing/*` |
| 任何 CSS 框架 | 样式为原生 CSS + CSS 变量（`src/app/styles.css`），不污染全局命名 |

### 1.5 three 子路径导入（无需额外依赖）

```ts
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
```

若宿主的构建器不支持 exports 子路径（老 webpack4 / 老 vue-cli），改用
`three/examples/jsm/...` 等价路径。

---

## 2. 需要改动的宿主文件

集成只要求**新增**，不改动既有业务代码。需要动的文件如下：

| 宿主文件 | 改动 | 必需 |
| --- | --- | --- |
| `package.json` | 增加 `three` 依赖（+ 上表 devDependencies） | ✅ |
| 路由文件（如 `router/index.ts`） | 增加一条指向游戏页的路由，例如 `/game/connect4` | ✅ |
| 游戏页组件（如 `views/Connect4View.vue`） | 挂载 `App.vue` 或直接使用 `useConnectGame()` | ✅ |
| `src/main.ts` | 仅当整页嵌入时：引入游戏样式 | 可选 |
| 全局样式 / 主题 | 若宿主有暗色主题变量，可把 `styles.css` 的 `:root` 令牌映射为宿主变量 | 可选 |
| 状态持久化 | 若需要跨页面保留对局，序列化 `engine.board / hp / phase / current` 后调用 `loadScenario()` | 可选 |

落点建议（可整目录复制）：

```
src/game/connect4/
├─ core/    ai/    three/
└─ ui/      ← 本仓库 src/app/ 改名为 ui，styles.css 改为非全局（见下）
```

---

## 3. 三种集成粒度

### 3.1 整页嵌入（最省事）

```vue
<!-- src/views/Connect4View.vue -->
<script setup lang="ts">
import GameApp from '@/game/connect4/ui/App.vue'
</script>

<template>
  <GameApp />
</template>
```

需要把 `src/app/styles.css` 从 `main.ts` 的全局引入改为在 `App.vue` 顶部
`<style src="./styles.css">`，或包一层作用域容器（`.app-shell` 已是根类，前缀足够隔离）。

### 3.2 局部嵌入（游戏作为页面中的一块）

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { SceneController } from '@/game/connect4/three/scene-controller'
import { GameEngine } from '@/game/connect4/core/engine'

const canvas = ref<HTMLCanvasElement>()
const holder = ref<HTMLElement>()
let controller: SceneController | null = null

onMounted(() => {
  if (!canvas.value || !holder.value) return
  const engine = new GameEngine({ initialHp: 6 })
  controller = new SceneController({
    canvas: canvas.value,
    container: holder.value,
    onApply: (event) => {/* 同步到你自己的响应式状态 */},
    onCellPick: (cell) => { void engine.commit(cell) },
  })
  controller.start()
  void controller.playEvents(engine.takeEvents())
})
</script>

<template>
  <div ref="holder" style="position: relative; height: 520px">
    <canvas ref="canvas" style="width: 100%; height: 100%" />
  </div>
</template>
```

注意：`SceneController` 需要容器有**确定的宽高**（用 `ResizeObserver` 或 `resize()` 同步）。

### 3.3 只用规则引擎（无 3D，纯逻辑 / 服务端校验）

只需 `src/core`（约 20 kB，零依赖）：

```ts
import { GameEngine } from '@/game/connect4/core/engine'
import { decideMove } from '@/game/connect4/ai/baseline'

const engine = new GameEngine({ seed: 42 })
engine.takeEvents()
engine.commit(40)              // 落子
engine.defend(0)               // 攻击阶段防守
engine.hp                      // [6, 3]
engine.result                  // { winner, reason, hp } | null
```

AI 也可以单独用（`src/ai/baseline.ts` 是入口；实现按职责拆在同目录
`types.ts` / `policy.ts` / `search.ts` / `debug.ts`，整体只依赖 `src/core`）：

```ts
// 四档：easy / normal / hard / expert（深度 1 / 3 / 5 / 7）
const decision = decideMove({
  board: engine.board,
  player: engine.current,
  selfHp: engine.hp[engine.current],
  opponentHp: engine.hp[other(engine.current)],
  mode: engine.awaitingDefense ? 'defend' : 'attack',
  highlightWeights: engine.highlights,   // 仅防守模式需要
  difficulty: 'expert',
  timeLimitMs: 1200,                     // 可选：思考时间**上限**
})
```

> AI 对战（两边都是 bot）只要让宿主循环调用 `decideMove` 即可；本仓库
> `useConnectGame()` 的 `mode: 'eve'` 就是这么做的（并且固定用最强档）。

---

## 4. 集成检查清单

1. `pnpm add three`（宿主已有 vue / ts 则无需再装；**不需要任何第三方 UI 库**）。
2. 复制 `src/{core,ai,three,app}` 到宿主目录，统一路径别名（`@/game/connect4/...`），
   并把 `src/assets/bgm/` 与 `src/assets/img/`（角色立绘）整个目录带上。
3. 确认 `tsconfig.json`：`"strict": true`、`"moduleResolution": "bundler"`（或 `"node16"`）、
   目标 `ES2020+`；本模块不使用 `any` 逃逸，严格模式可直接通过。
4. 确认构建器支持 `.vue` + 资源导入（`.mp3` / `.png`）+ `import.meta.glob` +
   `new Worker(new URL(...), { type: 'module' })` + `three/addons/*` 子路径导入
   （资源导入的类型声明由 `vite/client` 提供；AI worker 只依赖 `src/core`，不含 three）。
5. 处理 `src/app/styles.css` 的引入方式（全局或 scoped）。
6. 冒烟验证：页面能渲染出 9×9 网格、点击落子、形成 4 连后进入攻击阶段（网格在双方特征色之间循环）、
   防守方在高光位落子后棋子飞向血条并扣血；骰子浮层没消失前点不动棋盘。
7. 若使用 CSP，需要允许 `blob:`/内联 shader（three 的 ShaderMaterial 无需 eval，但
   粒子/材质编译会产生 `WebGL` 调用，不受 script-src 限制；光芒炸裂 / 魔法阵 / 技能图标
   都是运行时 canvas 生成的，data URL 需要 `img-src data:`）。
8. 联机（可选）：`cd back && pnpm install`，配好 `.env` 里的 MongoDB，再用根目录
   `pnpm sync:core` 把内核同步过去（`core/characters.ts` 也要一起带过去，服务端要用它校验角色）；
   前端默认后端按构建模式分流（`pnpm dev` 连本地、`pnpm build` 连线上，换后端用 `VITE_SERVER_URL`），
   进大厅自动连接。⚠️ **前端与后端的协议版本必须同时升级**：只更新一侧会
   `versionMismatch`（`PROTOCOL_VERSION` / `ONLINE_PROTOCOL_VERSION`）。
   ⚠️ 后端地址是**构建时写死进产物**的 ⇒ 换地址必须**重新构建**；
   本机自测用 `pnpm verify:online-backend`（查产物内嵌地址 + 真实握手版本）
   与 `pnpm verify:online-live`（真浏览器点进联机大厅看不报版本不一致）。
   角色技能已支持联机（`skill` 消息 + 服务端 `useSkill()` 裁决）。

## 5. 常见问题

| 现象 | 原因 / 解决 |
| --- | --- |
| 画面全黑 | 容器宽高为 0 → 给容器确定高度；或浏览器不支持 WebGL2（会显示降级提示） |
| 网格线看不见 | 棋盘线色被宿主主题压住：调 `palette.grid`（默认 `0x1b1e26`）与 `.app-root` 的背景色对比 |
| 棋子撞击血条位置不对 | 调用 `controller.setHudRects({ 0: el0.getBoundingClientRect(), 1: el1.getBoundingClientRect() })` |
| 攻击阶段没有“悬浮棋子” | 舞台位置由屏幕 NDC（`STAGE_NDC_*`）换算，需要容器有正确宽高；宽高为 0 时锚点会算到相机原点上 |
| 总攻击数数字不出现 | 数字的**位置**由 3D 层每帧写入，DOM 元素要交给 `controller.setTallyElements({ 0: el0, 1: el1 })`，并带 `.tally` / `.is-visible` 样式 |
| 骰子没消失就能落子 | 棋盘可交互性只能由 `syncInteractive()`（store）统一决定：它同时看 `ui.diceVisible`，骰子浮层要回调 `game.hideDice()`；宿主若不用骰子组件，store 也有 1.9s 兜底解锁 |
| 结算面板挡住悬浮棋子 | `.attack-card` 固定在**左下角**（`left + bottom`），两侧上方留给悬浮棋子、顶部留给血条 |
| 背景音乐不播放 | 浏览器自动播放策略：`bgm.play()` 必须在一次用户手势里调用（本仓库在首次点击/按键与开始对局时调用 `unlockAudio()`）；另外 `setSound(false)` 会暂停它 |
| SSR 报 `window is not defined` | `useConnectGame()` 需在 `onMounted` 后使用；`SceneController` 只在浏览器实例化；`BgmPlayer` 在无 `Audio` 环境会静默降级 |
| 暗场把棋子也压暗了 | 页面压暗层必须放在**画布之下**（`.app-root::after { z-index: 0 }`，画布 `z-index: 1`），否则整块画布（含特效与悬浮棋子）都会被盖暗 |
| 棋子颜色被特征色染了 | 棋盘棋子的材质 `emissive` 必须恒为 `0x000000`（`palette.sides[i].stone` 才是本体色）；连珠高光只改 `emissiveIntensity` + 白色自发光。特征色只用于高光点 / 特效 / 悬浮棋子的 `aura` 外壳 |
| 高 AI 等级时动画卡死 | 决策必须走 `src/ai/client.ts`（worker），不要在主线程直接调 `decideMove`；宿主打包器若不支持 `new Worker(new URL(...), { type: 'module' })`，客户端会自动回退成同步计算（会卡） |
| 背景音乐列表是空的 | `import.meta.glob` 的路径要指向真实存在的文件夹；宿主构建器不支持 glob 时改用显式导入 + 自备列表 |
| 角色立绘不显示 / 是空白方块 | `src/assets/img/` 必须原样带上且文件名符合 `<角色>[-表情].png`；宿主构建器要能处理 `.png` 资源导入。缺文件不会报错，只会退化成首字母色块 |
| 技能槽点了没反应 | 原因会显示在技能旁的**气泡**里（不再弹窗）：不在自己回合、冷却未好（按行动次数计）、场上被自己棋子占用的魔力植物不够 `cost`、`sabotage` 时"没有能连珠的敌方棋子"。也可以直接看 `engine.skillStateFor(player, slot).reason` |
| 联机时技能按钮是灰的 | 只有**对手那一方**（以及本地 AI 那方）会置灰：技能已支持联机（bugv10 #11），点自己的技能会发 `{t:'skill',...}` 给服务端裁决，等 `applied` 回来才播动画。两端必须用**同一份** `src/core`，否则开局第一次 `digest` 比对就会失败 |
| 攻击阶段棋盘还是黑的 | 攻击配色由 `BoardView.setAttackMode(true)` 打开，必须在一个**攻击宣告**的时机调用（本模块挂在 `highlightShown` 事件上）；只调 `syncUi()` 是不够的 |
| 悬浮棋子数量与总攻击数对不上 | 用 `SceneController.reconcileStage([攻方总数, 守方总数])` 对齐（魔力植物 +1 要补棋子、削弱 -1 要炸掉一颗），`animateAttackResolved` 前它也会兜一次底 |
| 入位/对撞时两边棋子跑到对面 | 棋子在哪一侧只由 `owner`（player 0 = 左、player 1 = 右）决定，不能按"攻击方 / 防守方"分左右 |
| AI 在攻击阶段把自己打死了 | `chooseDefense` 的字典序要保证"不被自己打死"是**最大**项（早期版本的 `lethalForUs` 方向写反了） |
| 拖尾看不见 / 只有一个点 / 像放烟花 | 别用粒子式实现：要么自己按"轨迹点 + 多段线"画一条连续的彗星尾迹（本仓库 `cursor-trail.ts`），要么接受它的缺点。另外 canvas 的 `z-index` 必须高于弹窗（本仓库 30），且 `position` 要跟着容器（挂在 `.app-root` 内用 `absolute`） |
| 联机时一方落子后另一方点不动 | 三个坑（bugv7 #1 全踩过）：① 服务端在 `enqueue()` 内部就可能配对成功，**不能**在 `matched` 之后再补 `queued`，否则客户端状态被"降级"成排队中；② **别在 computed 里读 `engine.value.current`** —— `engine` 是 `shallowRef`，引擎内部字段变化不会触发重算，缓存下来的"轮到我了吗"会永远停在开局那一刻，要用响应式的 `ui.current`；③ 落子发送失败要立刻解锁并提示，不能静默卡住 |
| 刷新页面后对手的后续落子收不到 | 同身份重连时服务端要把对局里的**广播目标重绑到新连接**（`MatchRoom.rebind`），否则 `sync` 只能拿到一次快照，后续 `applied` 全发往已经断掉的旧连接 |
| 同浏览器开两个标签页无法对局 | 两个标签页共用 localStorage 里的 `playerId`，服务端视为同一个人（队列里也只会有一条）。自测请用无痕窗口；服务端对**重复 playerId** 的处理是"新连接接管、旧连接收到 `duplicateLogin` 被踢" |
| 同一账号在两台设备登录，旧设备还能继续玩 | 联机要登录之后才有意义：服务端按**账号**顶号（bugv34l）——新连接登录成功/凭令牌恢复登录态时，把其他 `account` 相同的连接全部发 `sessionExpired` 后关闭（4002）；客户端收到后清掉 localStorage 里的登录态并回登录面板。注意长期令牌是**单枚**的（每次登录覆盖旧的），这正是判断依据 |
| 落子后棋盘倾斜方向反了 | 倾斜由落点相对棋盘中心的行列算出（`tiltBoardTowards`），与相机俯仰方向绑在一起；改机位（`BASE_PITCH`）时要一起复核 |
| 回放列表刷新后空了 | 回放存在 `localStorage`（key `connect4.replays.v2`）：宿主若在无痕 / 禁用存储的环境跑，`replay-store.ts` 会退化为「只在内存里保留本局」，不会报错 |
| 联机对局两端不同步 | 服务端每一步都下发 `digest`（`src/core/digest.ts`）；不一致就 `sync` 重建。`back/src/core` 必须是 `src/core` 的副本（`pnpm sync:core`），两端引擎版本不一致一定会漂移 |
| 联机断线重连后高光/削弱丢了 | `GameEngine.loadScenario()` 要带上 `highlights`（攻击阶段连珠棋子已被移除，重新 `summarizeMatch` 算不出来），`lineLengthSum` 也一并恢复 |
| 规则实现 | `src/core/engine.ts` + `lines.ts` + `magic.ts`（纯逻辑、零依赖，可直接拿去服务端做权威裁决） |
| 包体积偏大 | `three` 走 manualChunks 单独分包（本仓库 `vite.config.ts` 已配置 `three` / `vue` 分包）；AI worker 是独立小包（约 8 kB）；背景音乐是独立资源，可按需增删 |

## 6. 魔力植物（bugv8 #4 引入，bugv9 #2 大改，bugv11 #4 按部位分色，可选玩法）

默认开启，规则都在 `src/core` 里，**后端镜像同一份代码**所以联机天然一致：

| 点 | 说明 |
| --- | --- |
| 生长 | 冷却（默认 10 回合）走完在空位长一批（默认 2 棵，每 3 次 +1，上限 4）；任意一方连珠把冷却砍 8 回合；默认需要"先出现过连珠" |
| 伤害 | 连珠上每有一棵 `+1`（`finalAttackValue(base, weakness, magicBonus)`） |
| 抢夺 | 防守方落在带植物的格子上即抢走：攻方 -1、守方 +1（`GameEngine.place()` 里转移归属） |
| 消失 | **防守方一落子就消失**（bugv9 #2：`defend()` 里算完伤害后立刻清），不再等攻击阶段结束 |
| 外观 | **按部位分色**（bugv11 #4 定稿）：零件建的时候写 `mesh.userData.part`，烘焙时按部位合成**一块纯色、不透明**的几何（整株 ≤ **4 个 draw call**，没有分节也没有半透明叠层）。分配：枝干 / 叶轴 / 小柄 / 根座 = 褐 `#8a5a33`，叶片 / 蕨叶 / 草叶 = 绿 `#4f9d5d`，花心 / 草穗 = 黄 `#f0c247`，花瓣 = 银白 `#f2f6fd`；主干由多节随机偏转**累积成弧线**，蕨叶的小柄锚在叶轴上；缩放 2.05、随风摆动 0.12 rad；被占住时外层套一层该方特征色 + 脚下一圈旋转的双正方形魔法阵，周围有 3~5 颗萤火虫荧光；形状（花瓣数 / 草叶数 / 蕨叶排布）由「格子 + 种类」派生随机，联机两端与回放里完全一致 |
| 爆风 | 对撞 / 撞击血条时 `MagicView.blast()` 会把附近（3.4 格内）的植物吹歪再回弹 |
| 配置 | `DEFAULT_MAGIC_CONFIG` + 设置面板；**联机固定默认值**（`new GameEngine({ magic: null })`） |
| 确定性 | 生长位置/种类由「局面文本 + 生长序号」派生 PRNG 决定，不占用引擎种子，所以协议里不用传 |
| 关掉它 | `resolveMagicConfig({ enabled: false })`，或设置面板里关；`enabled: false` 时引擎完全不产出相关事件 |

## 7. 角色与技能（bugv9 #13 引入，bugv10 #9/#11 扩充，可选玩法）

角色把「特征色 + 立绘 + 两个技能」打包在一起，引擎只认数值，不认角色。
**角色数值在 `src/core/characters.ts`（纯数据，前后端共用）**，立绘在 `src/app/characters.ts` 补齐：

```ts
import { CHARACTER_SPECS, findCharacterSpec, skillsOfCharacter } from './core/characters'
import { CHARACTERS, findCharacter, skillsOf } from './characters'   // 带立绘的前端版本

// 引擎构造时把技能表传进去（不传就是没有技能）
const engine = new GameEngine({
  initialHp: 6,
  magic: null,
  skills: [skillsOf('deepseek'), skillsOf('gemini')],   // [先手方, 后手方]
})

engine.skillStates()                            // 双方技能此刻能否使用（含原因文案）
engine.useSkill(player, slot, cells, target?)   // 消耗 cells（正好 cost 棵、被我方棋子占用）
```

当前 4 个角色、8 个技能（数值细节见 README 的「角色系统」一节）：

| 角色 | 技能 | effect | 说明 |
| --- | --- | --- | --- |
| DeepSeek | 大胃袋 | `shield` | 护盾先于血量承伤 |
| DeepSeek | 杀鲸霸拳 | `double` | 本回合连下两颗，**两颗下完才进入攻击阶段** |
| Gemini | 猫的憩息 | `heal` | 回血（不超过初始血量） |
| Gemini | 双子星 | `bloom` | 先挂标记（`bloomPending`），**下一颗棋子**落下时这一格与周围所有格子长出植物；同一回合（`twinStar`）**两连即可发起攻击**，且这一击免疫对手的反击伤害 |
| GTP | 精密计算 | `immune` | 直到对手下个回合结束前无敌（释放后本回合仍可落子） |
| GTP | 恶龙吐息 | `fireball` | 先挑植物再点**目标格**（`targetsCell`），横竖空位燃 6 回合（双方各走一步算 1 回合）；`startReady` + `freeFirst`：开局不在冷却中、**首次释放不消耗植物**；释放后本回合仍可落子 |
| GLM | 小一哥 | `power` | 本回合伤害 +1，额外棋子从技能槽飞出 |
| GLM | 毒鸡蛋 | `sabotage` | 本回合可下在敌方棋子上（不顶替原棋子） |

| 点 | 说明 |
| --- | --- |
| 技能数值 | `SkillSpec = { id, name, cost, cooldown, effect, amount, endsTurn?, targetsCell?, startReady?, freeFirst?, desc? }`；宿主可以自定义任意技能表（`amount` 决定强度：护盾点数 / 回血 / 连续行动次数 / 生长半径 / 燃烧回合 / 增伤点数） |
| 冷却 | 按"自己的行动次数"算：`skillReadyAt = actionsTaken + cooldown`，**开局默认全部处于冷却**；标了 `startReady` 的技能（恶龙吐息）开局 `readyAt = 0`，一上来就能用 |
| 消耗 | 只能消耗 `magic.get(cell).owner === player` 的植物；`skillCostNow()` / `SkillState.costNow` 给出**此刻**真正要交几棵（`freeFirst` 的技能首次为 0，`skillCasts` 计数进指纹）；UI 里点了技能后画面与棋盘变暗、我方植物放大并加高光圆环（勾选过的再加一圈），站在植物上的我方棋子高亮，逐棵点选 |
| 护盾 | `engine.shield`：先于血量承伤（`applyDamage` 里先扣盾再扣血），无上限；UI 画成金属质感的银色血条段 |
| 连下两颗 | `engine.bonusActions`：`>0` 时 `commit()` 先扣额度并**留在同一个回合**（即使成了线也不进攻击阶段），额度用尽的那一颗才结算 |
| 免疫 | `engine.immuneUntil[p] > engine.turnNo` 时无敌：伤害结算成 `mode: 'immune'`、`damage: 0`，`expireImmunity()` 在回合推进时清掉 |
| 烈焰 | `engine.flames`：`cell -> 还能烧几个**半回合**`（每次换手 -1，所以 12 = 双方各走 6 步）；`castFireball()` 点燃目标格整行整列的空位；落在烈焰上会发 `stoneShattered`（模型里不落子、行动作废） |
| 绽放 | `engine.bloomPending`：`useSkill()` 只挂标记（发 `bloomArmed`），玩家**下一颗棋子**落下时 `bloomAround()` 在九宫格（含这一格本身与已有棋子）长出植物 |
| 两连攻击 + 免反击 | `engine.twinStar`：`bloom` 技能点亮的"本回合爆发窗口"。窗口内 `commit()` 会用 `summarizeMatch(board, player, overlay, 2)`（门槛降到 2）并**只保留包含这一格的连珠**，命中就直接 `declareAttack`；免伤判定 `isDamageImmune()` = 无敌 **或** 双子星窗口，所以对方反击更强时受击方是自己也会结算成 `mode: 'immune'`；窗口在 `clearTurnEffects()` 里随"仅本回合"效果一起关闭 |
| 叠子 | `engine.overlay`：`cell -> player`，`canStackAt()` / `sabotageTargets()` 判定合法性（必须能连珠），连珠后只移除叠子（`stonesRemoved.kept`），原棋子留下 |
| 与 digest 的关系 | **联机已支持技能**（bugv10 #11 / bugv11）：`digest.ts` 纳入 `shield / bonusActions / actionsTaken / skillReadyAt / turnNo / immuneUntil / flames / overlay / bloomPending / twinStar / skillCasts`；协议加了 `skill` 消息与 `matched.characters`，服务端用 `skillsOfCharacter()` 构造同一份引擎 |
| 关掉它 | 不传 `skills`（或传 `[[], []]`）即可：`skillStateFor()` 返回 null，技能槽自然为空 |
