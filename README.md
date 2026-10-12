# 四子棋 · 9×9 连珠对战（3D）

一个可直接并入既有 **Vue 3 + TypeScript** 工程的前端游戏模块。规则严格对照 [`rule.md`](./rule.md) 实现，
表现层使用 **three.js**（WebGL2）渲染，逻辑层为纯 TypeScript、零渲染依赖。

- 开始菜单：开始游戏 / 查看回放 / 更改设置 + **横向角色轮播**（4 个角色：DeepSeek / Gemini / GTP / GLM，
  一行 2 个、左右箭头翻页，第一个位置是「随机」；点角色后右侧显示它的技能详情，双方可同角色）；
  对局中左上、右上只显示**角色立绘（5 个表情差分）+ 血条**（血条在立绘上方并与立绘等宽，不显示数字），
  左右侧中间是**技能槽**（点技能在弹出的**气泡**里看详情与不可用原因），右下角是**微型播放器 + 设置按钮**
- 棋盘：**无边界深色实线** 9×9 网格，棋子落在**交叉点**上；
  攻击阶段整片网格在**双方特征色之间每 0.5 秒循环切换**（带过渡），结束后回到黑色
- 画布：**完全透明、铺满屏幕**，没有任何边界、底板或背景圆盘；页面默认是亮的（白色环境光），
  攻击阶段整体压暗
- 棋子：凸起的**黑白实体棋子**（红蓝只作为高光 / 特效 / 悬浮附着层的**特征色**）；
  「毒鸡蛋」可以在**敌方棋子上再叠一颗**（原棋子不被顶替）
- 3D：棋盘随鼠标移动做细微位移与旋转（视差），落子后还会按落点方位**短暂倾斜**再回正
- 特效：频谱状锯齿涟漪（**每次朝向随机**）、连珠针状光带、只差一颗时的**长提示针**（渐隐渐细，
  「2+1 中间空一格」也会提示并圈出缺的那一格）、悬浮棋子的旋转**魔法阵**（颜色 = 该方特征色，
  四个角完整）、入位 → 逐颗对撞（撞击点**随机浮动**、棋子沿**弧线**飞行）、**太阳式爆发**
  （光束长度 / 形状 / 角度各不相同）+ 瞬时点光 + 棋子炸成碎片（碎片取双方特征色、初速更快）、
  撞击血条并震屏、**硕大火球 + 整行整列烈焰**（烈焰上落子会碎裂）、**对局结束时棋盘上的棋子全部高速炸飞**
- 玩法：除规则外还有**魔力植物**（银白 / 褐 / 黄 / 绿**四色相间**、主干随机弯曲、蕨叶长在枝条上、
  随风摆动、萤火虫荧光、形状随机化，会被爆风吹歪；连珠上每有一棵 +1 伤害，防守方可以把它抢过去）
  与**角色技能**（8 种效果：护盾 / 回血 / 同回合连下两颗 / 生长 / 无敌 / 火球 / 增伤 / 叠子；
  消耗场上被己方棋子占用的魔力植物，冷却按"自己的行动次数"计算，**联机同样可用**）
- 音效：**程序化合成**（11 个扳机 × 2~4 套风格，含棋子碎裂与火球，可在设置里逐个扳机挑选并试听）+
  下拉框 / 微型播放器可切换的背景音乐曲库（默认 `let me go.mp3`）
- 回放：**事件级重播**（落子 / 连珠 / 对撞 / 撞击血条的特效与血条都会重演），
  跳步会先掐掉正在播的动画；面板在右下角可折叠；支持**导出 / 导入回放代码**（复制粘贴即可播放）
- UI：亮色简约风格，骰子 / 攻击结算卡（左下角）/ 结算弹窗 / **左分节右内容的设置面板** /
  对局回放（**本地持久化 + 服务器回放**）/ **蓝色彗星式鼠标拖尾**（自绘 canvas，零第三方依赖）
- 模式：人机对战 / 双人对战 / **AI 对战**（观战）/ **联机对战**（在线匹配或匹配码，WebSocket + MongoDB）
- 对手：跑在 worker 里的 alpha-beta bot（`expert` 最强）
- 后端：[`back/`](./back/README.md) 是一个可独立部署的 Node + MongoDB 联机服务，
  服务端跑**同一份纯逻辑引擎**做权威裁决，并把联机对局写成回放存进 MongoDB

---

## 快速开始

### 一键启动（Windows）

双击根目录的 **`start.bat`**：自动检查依赖 → 构建 → 启动预览服务 → 打开浏览器。
服务期间窗口保持打开，**关闭窗口即停止服务**。

```bat
start.bat                 :: 构建 + 启动 + 打开浏览器（默认 http://localhost:4173）
start.bat -Port 5200      :: 换端口
start.bat -NoBuild        :: 跳过构建，直接用已有 dist 启动（快）
start.bat -NoBrowser      :: 不自动打开浏览器
start.bat -Stop           :: 停止端口上的预览服务
start.bat -Online         :: 联机改连**线上**后端（默认连本机 localhost:8787）
```

参数会原样透传给 `scripts\start.ps1`（同时兼容 Windows PowerShell 5.1 与 PowerShell 7+）。

> 这个入口是**本机自用**的：它会把前端编成「联机连本机后端」（`VITE_SERVER_URL=http://localhost:8787`），
> 所以本机自测要另外把后端也开起来（双击 `back\start.bat`）。
> 要产出「连线上」的前端产物，用 `switch-online.bat`（或 `pnpm build`）。

### 切本地 / 切线上（`switch-local.bat` / `switch-online.bat`）

`back\`（后端）与 `dist\`（前端）是**分别部署**的两份产物；这两个脚本各跑一次就能
把两边都刷成最新、并指向同一台后端，适合"本地开发 ↔ 部署上线"来回切：

| 脚本 | 前端内嵌的后端 | 之后做什么 |
| --- | --- | --- |
| `switch-local.bat` | `http://localhost:8787` | 双击 `back\start.bat` + `start.bat`，本地联机自测 |
| `switch-online.bat` | `http://113.45.13.149:8787` | 把 `back\` 和 `dist\` 分别拷到宝塔，重启后端进程 |

两个脚本都会：`pnpm sync:core` → 编译后端 → 构建前端 → 校验产物内嵌地址 → 探测目标后端协议版本。
详见「联机（可选）」一节。

### 手动命令

```bash
pnpm install
pnpm dev            # 本地开发（默认 http://localhost:5173）
pnpm test           # 规则 + 技能 + AI + 编排单测（60 个用例）
pnpm typecheck      # vue-tsc 全量类型检查（应用 + 构建脚本）
pnpm build          # 生产构建
pnpm preview        # 预览构建产物（默认 http://localhost:4173）
pnpm sync:core      # 把 src/core 的纯逻辑内核同步到 back/src/core（联机服务端用）
```

浏览器端到端验证（在真实 WebGL2 下驱动整局，需要本机 Chrome，截图输出到 `.shots/`）：

```bash
pnpm preview --port 5199 --strictPort   # 终端 A
pnpm test:browser                        # 终端 B（默认访问 http://localhost:5199/）
pnpm verify:bugv3                        # 逐条回归 bugv3 的 8 项（19 项断言）
pnpm verify:bugv4                        # 逐条回归 bugv4 的 9 项（12 项断言）
pnpm verify:bugv5                        # 逐条回归 bugv5 的 10 项（12 项断言）
pnpm verify:bugv6                        # 逐条回归 bugv6 的 1~7 项（13 项断言）
pnpm verify:bugv7                        # 逐条回归 bugv7（真实鼠标点击联机 + 拖尾形状，7 项断言）
pnpm verify:bugv8                        # 逐条回归 bugv8（拖尾/门铃/掉线提示/魔力植物/魔法阵/字号/碎片，15 项断言）
pnpm verify:bugv9                        # 逐条回归 bugv9（对撞随机弧线/植物/预判线/棋盘配色/太阳/棋子数/播放器/回放/音效/炸飞/魔法阵/角色技能，47 项断言）
pnpm verify:bugv10                       # 逐条回归 bugv10（魔法阵残留/技能挑选高亮/平衡性/连下两颗/植物消失/立绘血条/技能气泡/角色轮播/新角色技能/返回主菜单/植物四色，27 项断言）
pnpm verify:online                       # 联机端到端（需先起 back/ 与 preview，见下节）
pnpm selfplay                            # AI 自对弈强度抽查（强档 vs 弱档，默认 8 局）
```

### 联机（可选）

联机服务在 [`back/`](./back/README.md)，默认监听 `8787`：

```bash
cd back
pnpm install
pnpm dev            # 需要 back/.env 里的 MongoDB；调试可用 DB_MODE=memory pnpm dev
```

**前端已经内置了联机后端**（bugv11 追加 #7）：进入「联机对战」会**自动连接**，
玩家界面上不出现服务器地址 / 连接 / 断开这些东西。

**联机需要登录**（bugv34i）：未登录时「联机对战」面板是**账号 + 密码**表单 ——
账号不存在会自动切到「注册」（多一个**昵称**输入框，取代了以前设置里的"联机昵称"），
点「注册」才完成注册。登录成功后令牌存在浏览器本地，**不退出登录就一直保持登录态**
（大厅底部有「退出登录」）。服务端侧只有一张最简的 `users` 表：账号 + 口令（`scrypt` 散列 + 盐）+
昵称 + 长期令牌，口令**不存明文**。

联机流程：**登录 → 匹配 / 建房 / 加入 → 进房间 → 双方都点「准备」→ 自动开局**。
房间里只有三个按钮（**准备 / 房间设置 / 退出**）；「房间设置」**谁都能点开看**，非房主只读；
房间内选角色与单机同一套界面（左侧轮播 + **右侧技能详情**）。

**登录面板只有一条路径**（bugv34k）：填账号 + 密码点「登录」——
账号存在就直接进去；不存在则**自动展开一个昵称输入框**（注册流程），再点一次即注册并登录。
底部并排「登录 / 返回主菜单」两个按钮。

**服务器回放跟随账号**（bugv34k）：回放按**登录账号**归档（`accounts`），
所以同一账号换设备 / 换浏览器也看得到自己的对局；未登录时退回按本机身份查。

连哪一台由**构建模式**决定（bugv34f），配置文件在仓库根 `.env.development` / `.env.production`
（`vite` 按 mode 自动加载），`src/app/online.ts` 里还有一份按模式兜底的常量：

| 命令 | 加载的 env | 连的后端 |
| --- | --- | --- |
| `pnpm dev`（开发） | `.env.development` | **本地** `http://localhost:8787`（`cd back && pnpm dev`） |
| `pnpm build`（生产） | `.env.production` | **线上** `http://113.45.13.149:8787`（宝塔那台） |
| `start.bat`（本机一键） | 由脚本注入 | **本地**（`scripts\start.ps1` 默认，可用 `-Online` 切成线上） |
| `switch-local.bat` / `switch-online.bat` | 由脚本注入 | 见下节 |

要换成自己的后端，构建/启动时显式给环境变量即可（优先级高于 `.env.*` 文件）：
`VITE_SERVER_URL=http://your-host:8787 pnpm build`。

### 本地 / 线上 一键切换（bugv34h）

部署形态是**前后端分离**的两份产物：`back\` 整个是后端，`dist\` 是前端。
根目录两个脚本把两边**一起刷到最新**并指向同一台后端：

```bat
switch-local.bat    :: 前端连本机 → dist\ 内嵌 http://localhost:8787
switch-online.bat   :: 前端连线上 → dist\ 内嵌 http://113.45.13.149:8787
```

每个脚本都会：`pnpm sync:core` → 编译后端 `back\dist` → 构建前端 `dist\`
→ 校验产物内嵌地址 + 探测目标后端协议版本（不一致会提示）。

**部署（切到 `switch-online` 之后）**：

1. 把 **`back\` 里所有文件**复制到宝塔后端目录，重启进程
   （`cd /www/wwwroot/connect4/back && pm2 restart connect4-backend`）；
2. 把 **`dist\` 里所有文件**复制到宝塔前端目录。

> ⚠️ 两份产物必须由**同一次切换**产出 —— 前端的内嵌地址是**构建期写死**的，
> 且前后端协议版本必须一致，否则联机握手会报 `versionMismatch`。

> ⚠️ **本机自测两边都要开**：`back\start.bat`（后端，每次启动重新编译 + `sync:core`）
> + 根目录 `start.bat`（前端预览）。快速自查：
> ```bash
> pnpm verify:online-backend     # 产物内嵌的后端是哪个 + 真实握手协议版本（默认查本机）
> pnpm verify:online-live        # 真浏览器：点「联机对战」后是否连上、有没有报版本不一致
> ```

端到端自测（真后端 + 两个浏览器上下文，自动打完整局并核对两端一致性）：

```bash
cd back && PORT=8899 DB_MODE=memory SERVE_FRONTEND=false pnpm exec tsx src/index.ts   # 终端 A
pnpm preview --port 5199 --strictPort                                                 # 终端 B
ONLINE_SERVER=127.0.0.1:8899 pnpm verify:online                                       # 终端 C
# 直接打宝塔上那台：ONLINE_SERVER=113.45.13.149:8787 pnpm verify:online
```

---

## 目录结构

```
start.bat                 # 一键启动入口（双击即可）
switch-local.bat          # 切到本地模式：两端都重建，前端内嵌 localhost:8787
switch-online.bat         # 切到线上模式：两端都重建，前端内嵌线上地址（待部署）
scripts/start.ps1         # 启动逻辑：依赖检查 → 构建 → 预览 → 打开浏览器
scripts/switch-mode.ps1   # 切换逻辑：sync:core → 编译后端 → 构建前端 → 自检
scripts/verify-bugv3.ts   # bugv3 逐条浏览器回归脚本（可选，需先起 preview）
scripts/verify-bugv4.ts   # bugv4 逐条浏览器回归脚本（可选，需先起 preview）
scripts/verify-bugv5.ts   # bugv5 逐条浏览器回归脚本（可选，需先起 preview）
scripts/verify-bugv6.ts   # bugv6 逐条浏览器回归脚本（可选，需先起 preview）
scripts/verify-bugv7.ts   # bugv7 逐条浏览器回归脚本（可选，需先起 preview + back）
scripts/verify-bugv8.ts   # bugv8 逐条浏览器回归脚本（可选，需先起 preview）
scripts/verify-bugv9.ts   # bugv9 逐条浏览器回归脚本（可选，需先起 preview）
scripts/verify-bugv10.ts  # bugv10 逐条浏览器回归脚本（可选，需先起 preview）
scripts/verify-online.ts  # 联机端到端（需先起 preview + back）
scripts/sync-core.mjs     # 把 src/core 的内核逐字节复制到 back/src/core（pnpm sync:core）
scripts/selfplay.ts       # AI 自对弈强度抽查（可选）
back/                     # 联机后端（Node + Express + ws + MongoDB），可独立部署，见 back/README.md
├─ PROTOCOL.md            #   前后端协议契约（唯一真源）
├─ src/core/              #   ⚠️ 由 pnpm sync:core 从 src/core 复制，不要手改
├─ src/                   #   index / http / ws / match / matching / db / config / protocol / logger
├─ tests/                 #   服务端裁决 / 匹配 / 双客户端 WebSocket 端到端
└─ scripts/smoke.ts       #   内存模式跑完整一局 + 校验回放落库
src/
├─ assets/
│  ├─ bgm/               # 背景音乐曲库：let me go.mp3（默认）+ piano.mp3
│  │                     # 往这个文件夹里丢 mp3 就会自动出现在设置面板 / 播放器
│  └─ img/               # 角色立绘与表情差分：deepseek[-atk|-hit|-win|-lose].png
│                        #                    gemini / gtp / glm[-atk|-hit|-win|-lose].png
├─ core/                  # ① 纯逻辑：无框架、无渲染依赖，可单独复用
│  ├─ types.ts            #    类型 / 常量 / 事件定义 / 魔力植物配置 / 技能定义（8 种效果）
│  ├─ lines.ts            #    连珠检测、攻击值 / 削弱 / 抵消计算、预判线（含 2+1 空格）、叠子感知
│  ├─ magic.ts            #    魔力植物：确定性生长（局面文本 + 生长序号 派生 PRNG）+ 九宫格 / 定点开花工具
│  ├─ engine.ts           #    对局状态机（commit / defend / useSkill → GameEvent[]）
│  ├─ characters.ts       #    角色目录（纯数据：特征色 + 两个技能；前后端共用）
│  ├─ digest.ts           #    局面指纹（联机两端比对，含魔力植物 / 技能状态 / 烈焰 / 叠子）
│  └─ random.ts           #    可复现随机数（掷骰子）
├─ ai/
│  ├─ baseline.ts         # ② AI：对外入口（decideMove + 兼容工具）+ 再导出下面各模块
│  ├─ types.ts            #    AI 输入 / 输出契约（AiRequest / AiDecision / AiMagicContext / AiSkillContext）
│  ├─ policy.ts           #    可调参数与常量（评价权重 / 着法优先级 / AI_POLICY / DIFFICULTY / Zobrist 表）
│  ├─ search.ts           #    搜索核心：迷你引擎（复刻 core 规则）+ 迭代加深 + alpha-beta + 置换表
│  ├─ debug.ts            #    仅供测试 / 对拍的 debug* 钩子（verify-ai-* 靠它比对状态）
│  ├─ worker.ts           #    把决策放进 worker，避免强档卡住动画
│  └─ client.ts           #    worker 客户端（无 Worker 环境自动回退同步计算）
├─ three/                 # ③ 3D 表现层：只消费 GameEvent
│  ├─ scene-controller.ts #    场景总控 + 事件动画编排（playEvents）
│  ├─ board-view.ts       #    无边界深色实线棋盘（交叉点落子）/ 高光 / 悬停 / 攻击转红
│  ├─ pieces-view.ts      #    黑白棋子：凸面几何、特征色附着层、接地阴影、碎片、对象池
│  ├─ magic-view.ts       #    魔力植物：四色相间几何 + 弯曲主干 + 蕨叶挂枝 + 爆风 + 归属魔法阵
│  ├─ magic-texture.ts    #    双正方形魔法阵贴图（悬浮棋子与魔力植物共用）
│  ├─ flame-view.ts       #    烈焰 + 火球（恶龙吐息）：分格火焰、彗尾火球、爆炸
│  ├─ skill-icons.ts      #    技能图标：程序化 canvas 绘制（护盾 / 连击 / 回血 / 绽放 / 无敌 / 火球 / 增伤 / 叠子）
│  ├─ effects-view.ts     #    冲击波 / 发光带 / 光晕 / 太阳爆发 / 魔法阵 / 环境光与暗场
│  ├─ particles.ts        #    GPU 粒子
│  ├─ ripple.ts           #    全屏波纹 + 全屏闪光（贴摄像机的加色平面）
│  ├─ camera-rig.ts       #    机位、鼠标视差、震屏、按宽高比自动取景
│  ├─ audio.ts            #    程序化音效库（11 个扳机 × 2~4 套风格，声明式配方，无音频文件）
│  ├─ bgm.ts              #    背景音乐循环播放 + 换曲 / 播放暂停 / 音量 / 静音 + 大特效闪避（duck）
│  ├─ palette.ts          #    配色令牌（黑白色 + 可改特征色）
│  └─ anim.ts             #    墙上时钟补间调度 + 缓动 + smoothstep
└─ app/                   # ④ Vue 3 UI
   ├─ useConnectGame.ts   #    组合式 store：core ↔ three ↔ UI 编排 + 界面阶段 + 回放 + 联机 + 角色技能
   ├─ characters.ts       #    角色定义（立绘差分 + 特征色 + 两个技能，数值来自 core/characters.ts）
   ├─ online.ts           #    联机客户端（WebSocket 协议 + REST 拉取回放 + 断线重连）
   ├─ replay-store.ts     #    回放 localStorage 存档（最多 30 局）
   ├─ cursor-trail.ts     #    鼠标拖尾：自绘 canvas 彗星尾迹（零第三方依赖）
   ├─ App.vue
   ├─ styles.css
   └─ components/         #    GameBoard / PlayerPanel（立绘+血条）/ SkillBar / CharacterPicker
                         #    DiceOverlay / AttackPanel / StartMenu / GameMenu / MiniPlayer
                         #    ReplayPanel / ResultModal / SettingsPanel / OnlineLobby / NoticeModal
```

三条硬边界：**core 不认识 three、three 不认识 Vue、Vue 只通过 store 驱动两者**。

---

## 架构：事件驱动的动画编排

规则的所有状态变更都在 `GameEngine.commit()/defend()` 中**同步**完成，并返回一串语义事件：

```ts
type GameEvent =
  | { type: 'stonePlaced'; player; cell; stacked? }    // stacked = 叠在敌方棋子上（bugv10 #9）
  | { type: 'matchFormed'; match }
  | { type: 'stonesRemoved'; player; cells; highlight; kept? }
  | { type: 'highlightShown'; owner; cells; weights }
  | { type: 'defenderPlaced'; player; cell; weakened; finalAttack?; defenderAttack?; shattered? }
  | { type: 'magicGrown'; plants; growth }
  | { type: 'magicClaimed'; cell; kind; player; stolen }
  | { type: 'magicRemoved'; cells; reason }
  | { type: 'magicConsumed'; player; cells }          // 技能消耗植物（bugv9 #13）
  | { type: 'skillUsed'; player; slot; skillId; skillName; effect; cells; target? }
  | { type: 'shieldChanged'; player; from; to }
  | { type: 'bonusActionsChanged'; player; to }
  | { type: 'stoneShattered'; player; cell; reason }  // 落在烈焰上碎裂（bugv10 #9）
  | { type: 'flamesIgnited'; cells; turns }
  | { type: 'flamesChanged'; cells; remaining }
  | { type: 'flamesCleared'; cells }
  | { type: 'immuneChanged'; player; active; until }  // 精密计算
  | { type: 'powerChanged'; player; to }              // 小一哥
  | { type: 'sabotageChanged'; player; active }       // 毒鸡蛋
  | { type: 'attackResolved'; snapshot; clashCount; damage }
  | { type: 'hpChanged'; player; from; to; hits }
  | { type: 'highlightsCleared' }
  | { type: 'turnStarted'; player }
  | { type: 'diceRolled'; first; rolls }
  | { type: 'gameOver'; result }
```

表现层 `SceneController.playEvents(events)` 逐个播放动画，**每个事件动画结束时**回调
`onApply(event)`，由 store 推进模型状态。因此“看到的”和“算出来的”始终一致，
同时单测可以完全绕过渲染层直接验证规则。

---

## 规则实现要点（对照 rule.md）

| 规则 | 实现 |
| --- | --- |
| 2.1 连珠 | 横 / 竖 / 两条斜线，极大连续段长度 ≥ 4（`findLines`） |
| 2.2 连珠总长 | `totalLineLength(lines)` |
| 2.3 攻击棋子数 | 参与连珠的**实体棋子去重**数量（`uniquePieceCount`） |
| 2.4 占位削弱 | 防守方落点属于 k 条攻击方连珠则 -k（`lineWeightAt`） |
| 2.5 最终攻击值 | `max(1, 攻击棋子数 - 削弱)` |
| 2.6 防守方攻击值 | 防守方连珠的实体棋子去重数量 |
| 4.1 攻击方连珠处理 | 去重移除 → 飞向攻击方一侧 → 原位置留攻击方色高光 → 屏幕变暗 |
| 4.2 防守方落子 | 任意空位；高光位削弱，非高光位不削弱 |
| 6.3 抵消 | 对撞 `min(攻, 防)` 次，差值 D 飞向劣势方血条，每颗扣 1 |
| 7 血量 | 可扣到负数，播完全部撞击动画后再弹结算 |
| 8 胜负 | 血量 ≤0 判负；棋盘下满比血量，相同即平局 |
| 11.2/11.3 连续攻击 | 攻击阶段结束后由**原攻击方**继续，可连续发起攻击 |

---

## AI

`decideMove(request)` 支持 `easy / normal / hard / expert` 四档（深度 1 / 3 / 5 / 7，
时间预算 40 / 180 / 500 / 1200 ms）：

- **普通回合**：迭代加深 + alpha-beta + 置换表（**根视角 minimax**，见下），
  着法排序 = 置换表着法 → 直接成线 → 对手威胁 → killer/history → 中心控制。
- **防守回合**（攻击阶段落子）：按"先活下来 → 再打死对手 → 再比净伤害 → 再看削弱权重"择优。
- 评估函数围绕本作的真实货币：连续段长度 + 活端数（活三 = 两步杀，权重最高）+ 血量差。
- **AI 对战（观战）模式固定用 `expert`**，看到的就是这个 bot 的上限。

替换为更强的 bot 只需保持签名：

```ts
import type { AiRequest, AiDecision } from './ai/baseline'
// 在 useConnectGame.playAiMove() 中把 decideMove 换成你的实现即可
```

强度抽查（自对弈，可改局数 / 预算）：

```bash
GAMES=8 BUDGET=80 pnpm selfplay        # expert vs easy
```

---

## 表现层要点（含 bugv1 ~ bugv11 修复记录）

### bugv11 追加（第三轮：技能手感与立绘）

| 需求 | 实现 |
| --- | --- |
| 1. 恶龙吐息的烈焰在 6 回合后（甚至更久）也不会消失 | **根因在客户端**：`applyEvent` 把 `flamesIgnited.turns`（回合数）与 `flamesChanged.remaining * 2` 写回了模型，而引擎内部按**半回合**存（回合数 ×2）。两个写入互相咬合 —— 点燃写 6（本该 12）、每换手 `remaining` 又按"最旺那一处 ×2"把**所有**格子顶回 6 —— 于是烈焰永远停在 6 → 5 → 6 的循环里。现在这两条事件**不再回写模型**（引擎的 `flames` 在事件产生时已是最终值），`remaining` 只在 `types.ts` 里标明"仅供展示" |
| 2. 使用技能后技能框要高亮 + 流光一段时间，提醒对手用了技能 | store 新增 `ui.skillFlash = { player, slot, key }`（`skillUsed` 事件触发，`SKILL_FLASH_MS = 2600` 后自动清掉，`key` 每次 +1 保证连用同一技能动画也会重播）；`SkillBar.vue` 给该槽位加 `is-flash` 与一层 `.skill-slot__flash` —— CSS `@keyframes skillSlotPulse`（金色描边 + 呼吸放大）+ `@keyframes skillSlotSweep`（115° 渐变扫过，`mix-blend-mode: screen`），两套动画各播 2 次 |
| 3. 技能详情的泡泡要能"点泡泡外面"关闭 | `App.vue` 在 `window` 上挂**捕获阶段**的 `mousedown` 监听：`event.target.closest('.skill-slot, .skill-bubble')` 都不命中时 `closeSkillBubble()`。因此点棋盘、点画面空白、点设置面板都会收起，点泡泡里面不会 |
| 4. 魔力植物颜色组成还是怪 → 退回"每个部位一种颜色"，四色自行分配 | `magic-view.ts` 去掉 4 层"千层饼"，改成**按部位烘焙**：零件建的时候就写 `mesh.userData.part`，`bakePart()` 按部位把所有零件合成**一块纯色几何**（不透明、`depthWrite`）。分配：**枝干 / 叶轴 / 小柄 / 根座 = 褐**，**叶片 / 蕨叶 / 草叶 = 绿**，**花心 / 草穗 = 黄**，**花瓣 = 银白**；整株仍然 ≤ 4 个 draw call，但不再有半透明叠层，也就没有一段一段的分节 |
| 5. gemini 二技能「双子星」：本回合形成**两连**即可发起攻击，且免疫敌方反击伤害 | 引擎新增 `twinStar: [boolean, boolean]`（进指纹、`state`、回放 `extra`）。`useSkill('bloom')` 点亮爆发窗口（发 `twinStarChanged`）；`commit()` 在正常连珠判定之后加 `twinStarSummary()` —— 用 `summarizeMatch(board, player, overlay, 2)` 取"门槛 = 2"的连珠，再**只保留包含这一格的**，所以随便下一手不会白打；`resolveAttack()` 的免伤判定从 `isImmune()` 换成 `isDamageImmune()`（精密计算的无敌 **或** 双子星窗口），受击方是自己时直接 `mode: 'immune'`、伤害 0；窗口在 `clearTurnEffects()` 里随"仅本回合"效果一起关掉 |
| 6. gtp 二技能「恶龙吐息」开局不进入冷却 + 首次释放无需消耗 | `SkillSpec` 新增 `startReady?`（开局 `readyAt = 0`）与 `freeFirst?`；引擎新增 `skillCasts[player][slot]` 计数与 `skillCostNow()` / `isFirstFree()`，`SkillState` 增加 `costNow` / `freeNow`。收费判定与"挑几棵植物"都用 `costNow`（首次为 0，直接跳到选目标格、一颗植物都不交）；`skillCasts` 同样进指纹 / `state` / 回放 extra。技能槽显示「首次免费」，气泡显示「首次释放免费」 |
| 7. 立绘差分：攻击阶段要保持 atk，敌方下子不能把攻击方顶回默认；攻击结束回默认 | 两个根因：① `matchFormed` 对**双方**都无条件写表情，防守方成线（对撞）时把攻击方写成 `idle`、自己写成 `atk`；现在 store 用 `attackPhaseActive`（`highlightShown` 打开、`attackResolved` / `highlightsCleared` 关闭）判断 —— 攻击阶段内只保证**攻击方**是 `atk`，防守方成线时不动表情；② 对撞打平时 `attackResolved` 原本写 `['atk','atk']`（"攻击阶段结束后又切回 atk"），现在按需求回到 `['idle','idle']` |
| 8. 回归只跑这一轮 | 新增 `pnpm verify:bugv11`（`scripts/verify-bugv11.ts`）：只针对上面 7 条的 14 项浏览器检查，旧脚本原样保留但不再执行 |
| 追加 1. 局内 lose 表情有一层灰色蒙版 → 去掉 | `.player-panel.is-lose .portrait` 原来带 `filter: saturate(0.45) brightness(0.92)`（整张立绘被降饱和 + 压暗）。现在**不再加任何滤镜**，只留一圈中性灰描边，输赢完全靠差分图本身区分 |
| 追加 2. 双子星去掉"长魔力植物"的效果 | 引擎删掉 `bloomPending` 字段、`bloomAround()`、`commit()` 里的绽放分支与 `bloomArmed` 事件；`SkillSpec.desc` / 技能气泡文案同步改成"两连即可攻击 + 免反击"。指纹、`state`、回放 `extra`、联机协议里的对应字段一并移除（`magic.ts` 的 `ringCells` / `bloomPlants` 作为通用工具保留） |
| 追加 3. 技能图标加大 100%；局内立绘增大 25%（不能和技能栏重叠） | 技能槽改成 CSS 变量驱动（`--skill-slot-w: 100px` / `--skill-icon: 80px`，glyph 字号跟着图标走）；立绘 `--portrait-w` 从 `clamp(120px, min(21vh, 22vw), 200px)` → `clamp(150px, min(26vh, 27vw), 250px)`。为了保证底边不压到竖直居中的技能栏，新增 `max-height: 880px` 立绘档与 `max-height: 800px` 技能槽档，`max-height: 720px` / `max-width: 900px` 再各收一档（1440×900 下立绘底 ≈288px、技能栏顶 ≈318px） |
| 追加 4. 火球砸到棋盘后要**立即**消失；火焰从内到外带时差扩散 | `flame-view.ts`：火球本体（熔岩球）命中瞬间 `visible = false`，光晕 / 白炽核心的让位时间 0.18s → **0.08s**，彗尾 0.22s 内淡出（以前 12 段拖尾会在棋盘上定格到爆炸结束 —— 那 0.9 秒就是"火球还在"的观感）；**火球的 Promise 改成命中瞬间兑现**（以前要等 0.9s 爆炸播完），后续的"烈焰点燃"事件才不会被拖到 1 秒之后；`scene-controller.ts`：记下火球落点，`animateFlamesIgnited()` 按**离落点几圈**分组、由内到外逐圈点燃（每圈 45ms 时差 + 各自的冲击环与火星），而不是整行整列同时亮 |
| 追加 5. GTP 的两个技能释放后应当**还能落子**（之前会把回合交出去） | `gt-immune` / `gt-fireball` 去掉 `endsTurn`。免疫的到期判定本来就是按回合序号算的（`immuneUntil = turnNo + 2`），所以"直到对手下个回合结束"的语义不变；恶龙吐息放完可以直接接着落子（这时也会踩到自己刚点的火，需要自己判断） |
| 追加 6. 魔力植物细节：草的尖头像导弹发射器 / 小花花瓣悬空不连中心 / 小花与蕨类主干像竹竿 | ① 草穗不再是"一根粗圆锥"，改成 3 节细长麦穗（锥台串成、半径 0.0075、随叶尖方向弯），尖头收细；② 花瓣根部半径 0.04~0.064 → **0.008~0.016**（插进花心球里），花瓣一律从花心长出来，不再悬浮；③ `buildStemChain()` 新增 `curve` 参数：把**总弯曲弧度**按 `sin` 形状分配到各节（`Σ每节 ≈ curve`），逐节累加就是平滑弧线，而不是每节独立随机造成的白噪声折线（小花 0.55~0.95、蕨类叶轴 0.7~1.15、矮茎 0.3~0.55、草叶 0.9~1.45；节数 8~10、每节只留 0.03 噪声）。实测 `parts.bend`：草 0.19 → **0.35**、蕨 0.04 → **0.17** |
| 追加 7. 小花花瓣还是叠在一起（要绕花蕊一圈）；联机模式不要连接配置、默认直连后端 | ① **根因是 Euler 旋转顺序**：three.js 默认 `'XYZ'` 是"先 Z、再 Y、最后 X"，所以 `rotation.y = 方位角` 会被后面的 X 旋转吃掉，**所有花瓣都朝同一个方向**叠成一坨。现在花瓣组设 `rotation.order = 'YXZ'`（先平铺 6~16°，再绕 Y 转到自己的方位角），方位角均匀分布（抖动 ±0.05rad）、根部落在花心表面内侧 0.85×coreRadius；花瓣厚度同时压到 `width*0.13`；② `DEFAULT_SERVER_URL = http://113.45.13.149:8787`（`VITE_SERVER_URL` 优先），不再读 localStorage 里的旧地址；`openOnlineLobby()` 进大厅即自动连接；联机大厅与设置面板删掉服务器地址输入 + 连接/断开按钮（设置里只留昵称），大厅状态改成"正在连接服务器… / 已就绪" |
| 追加 8. 宽屏下点「联机对战」后那块面板变成左右两栏、左边一大片空白；返回主菜单后模式还停在「联机对战」 | ① **原因**：大厅复用开始菜单的面板类 `.start-menu__inner`，而宽屏（> 1000px）下它是**两栏网格** `minmax(0,1fr) minmax(286px,340px)`；原来的 `.online-lobby { width: … }` 特异性相同、位置又更靠前，被后者的 `width: min(960px,94vw)` + 两栏模板盖掉 → 大厅被拆成两栏（标题 / 提示在左那一大栏、按钮在右），左侧自然出现大片空白；窄屏因为媒体查询强制单栏所以看不出来。现在改成复合选择器 `.start-menu__inner.online-lobby`（特异性 0,2,0）强制 `grid-template-columns: minmax(0,1fr)` + `width: min(420px,92vw)`；② `backToMenu()` 里把 `ui.mode` 复位成 `'pve'` 并同步双方 `isAi`（人机对战），从大厅 / 联机对局回主菜单时模式芯片不再停在「联机对战」，点开始游戏也是打人机而不是又进大厅 |

### bugv10 追加（第二轮：手感与显示）

| 需求 | 实现 |
| --- | --- |
| 1. 结算菜单按钮被挤扁 → 放宽弹窗 / 按钮两行 | `.modal` 从 420px 放宽到 **560px**，`.modal__actions` 改成 **2×2 网格**（窄屏 <460px 回落单列），每个按钮 `min-height: 42px`、不换行 |
| 2. 技能图标被换成字形 → 用回程序化生成的图标 | 开始菜单右侧技能详情里的「盾 / 双 / 焰」字形占位换成 `skillIconUrl()` 生成的 PNG（与对局技能槽同一套图标，8 种效果各有专属绘制） |
| 3. 魔力植物"一段一段分节"更难看 → 改成**千层饼**（最里层褐、一层套一层、最外层绿） | `magic-view.ts` 重写几何管线：零件照旧随机拼装 → **烘焙成 4 层**（`base 褐 → inner 黄 → outer 银白 → green 绿`，逐层放大 1 / 1.12 / 1.26 / 1.42、外层半透明），用 `mergeGeometries` 把每层合成**一个** BufferGeometry。于是颜色是"一层套一层"叠出来的（混色），不再沿枝条分节；顺带把整株从 ~25 个 draw call 降到 **4 个** |
| 4. 对局结束后立绘没有复位（要下子才复位） | 新增 `resetExpressions()`，在 `backToMenu()` / `startMatch()` / 进联机大厅 / 关结算面板（查看棋盘、回放本局）时都调用；结算弹窗还在时保留 win / lose |
| 5. 左侧立绘要左右镜像；立绘层级要在悬浮棋子下方、不能阻挡 | 画布 `z-index` 1 → **3**、`.hud` → **2**（压暗层 0 < HUD 2 < 画布 3），所以悬浮攻击棋子画在立绘之上；`.hud > *` 设 `pointer-events: none` 让点击/拖尾穿透；`[data-player-panel='0'] .portrait__art { transform: scaleX(-1) }` 做镜像 |
| 6. gemini 二技能「双子星」应在**下一颗棋子落下时**触发，让这一格与周围所有棋子 / 空格都长出植物（**bugv11 追加 #2 已按要求去掉**） | 当时引擎新增 `bloomPending`：`useSkill()` 只挂标记（发 `bloomArmed` 事件 + 一圈提示光效），`commit()` 里落子后调用 `bloomAround()` —— `ringCells(center, board, radius, true)` 取**九宫格**（含这一格本身、含已有棋子），有棋子的格子归属那颗棋子的主人、空位归属为空；`bloomPending` 纳入指纹与 `state`。→ **现在这套已经整段删除**（字段 / 事件 / `bloomAround()` / 指纹项 / 协议字段），`magic.ts` 里的 `ringCells` / `bloomPlants` 作为通用工具保留 |
| 7. 恶龙吐息火焰不明显；持续回合改成**双方各走一步算 1 回合**、共 6 回合 | `flame-view.ts`：火焰整体放大 0.85 → **1.35**、亮度下限 0.45 → **0.66**、地面余烬光斑放大；引擎里烈焰按**半回合**存（`turns * 2`），每次换手 -1，所以"6 回合"= 双方各走 6 步；对外（`flamesChanged` / UI）仍报向上取整的回合数；角色数值 `amount: 5 → 6` |
| 8. 设置里删掉「外观」项；赤方 / 青方等显示改成角色名；特征色跟随角色 | 设置面板删掉 `look` 分节（特征色选择器一并移除，特征色固定跟随角色），昵称输入并进「角色」分节（**留空 = 跟随角色名**）；`SIDE_META` 的默认昵称改成角色名，`applyCharacter()` 会同步昵称（玩家手动改过则保留，联机昵称视为自定义） |

### bugv10

| 需求 | 实现 |
| --- | --- |
| 1. 棋子在魔力植物上显示的魔法阵在游戏结束后没有消失 | 结束动画（`animateGameOver`）原来只把棋子炸飞，植物与它脚下的魔法阵留在棋盘上。现在这里同时 `magic.remove(所有植物)` + `magic.clear()` + `flames.reset()`，植物与魔法阵跟着棋子一起消失 |
| 2. 技能挑选阶段：只有我方在魔力植物上的棋子与该植物高亮，其他棋子 / 植物变暗；悬停到该棋子要有高亮标识；多选技能勾选后也要有高光标识 | ① `MagicView.setSelecting(player, picked)` 把**非我方的植物整体调暗**（四色材质 ×0.34、萤火虫熄灭、归属层隐藏），被勾选的植物额外挂一圈旋转的**高光圆环**并放大到 1.3×；② `PiecesView.setSelectSpotlight(cells)` 把**不在我方植物上的棋子**透明到 0.16，选中的那些加自发光 + 一枚特征色**圆环标识**；③ `SceneController.handlePointerMove` 每帧调用 `pieces.setSelectHover(cell)`，悬停到可选棋子时标识放大到 1.32×、自发光提到 0.85；④ 棋盘网格同步压暗（`BoardView.setSkillDim`） |
| 3. 平衡性调整与改名 | ① DeepSeek 2 技能「杀鲸霸拳」消耗 5 → **3** 棵、冷却 10 回合；② Gemini 2 技能「双子星」消耗 3 → **2** 棵、冷却 15 → **10** 回合；③ DeepSeek 1/2 技能改名「大胃袋」「杀鲸霸拳」；④ Gemini 1/2 技能改名「猫的憩息」「双子星」。角色数值统一挪到 `src/core/characters.ts`（纯数据，前后端共用） |
| 4. DeepSeek 2 技能"连续行动 2 回合"没有体现：改为**当前回合可下两颗子，下完两颗再进入攻击阶段**（下完第一颗时防守方还不能反击） | `commit()` 里把"是否还有连击额度"的判断提到**攻击判定之前**：只要 `bonusActions[player] > 0` 就先扣一次额度、`beginTurn(player)` 继续同一个回合并 **return**（即使这一颗已经成线也不 `declareAttack`）；额度用完的那一颗才按最终局面 `summarizeMatch` → 成线则进入攻击阶段。因此第一颗成线时不会出现攻击阶段、防守方也无从反击 |
| 5. 使用技能后魔力植物与它上面的魔法阵没有消失 | `SceneController.playEvent()` 缺了 `magicConsumed` 分支（引擎早已发事件、模型也已删掉植物），所以视觉上植物永远留着。现在补上：走 `animateMagicRemoved(cells)`（银色碎光 + 缩小淡出）并播放植物音效 |
| 6. 左上 / 右上立绘长宽 +200%；不用显示 6HP，只显示立绘与血条；血条放在立绘上方且与立绘等宽 | `PlayerPanel.vue` 重排：立绘用 `clamp()` 放大到 200px+（原来约 72px），血条挪到立绘**上方**并用同一组左右边距（等宽），所有可见的 HP 数字 / `HP` 标签 / 护盾数字都移除（保留一个视觉隐藏的 `.hp-value` 供无障碍与自动化读取） |
| 7. 点敌方或我方的技能时不要弹窗，改在技能附近用泡泡显示详情 | store 的 `beginSkill()` 不再 `showNotice`，而是写 `ui.skillBubble = { player, slot, notice }`；`SkillBar.vue` 在该槽位里渲染一个带小三角的**气泡**（名称 / 消耗 / 冷却状态 / 效果说明 / 原因），两侧各自朝屏幕内侧展开，切换有过渡动画 |
| 8. 开始菜单角色选择改成横向轮播（2 个一行、左右箭头翻页、只显示立绘与名称、立绘更大）；菜单高度紧张可左右排列；点角色后右侧显示技能详情；第一个角色前加「随机」选项，进入游戏随机选角色 | `CharacterPicker.vue` 重写成 `.character-carousel`（每页 2 张、`data-carousel="prev/next"` 箭头循环翻页、「随机」卡固定在第一页首位、卡片只有立绘 + 名称）；`StartMenu.vue` 改成**左右两栏**（左：品牌 / 模式 / 轮播 / 按钮；右：选中角色的两个技能详情），窄屏自动回落单列；`ui.characterRandom[side]` 记录"随机"，`startMatch()` 时才真正抽签（`rollRandomCharacters()`） |
| 9. 新增角色 GTP 与 GLM（特征色 `#c7bef0` / `#27314a`）及其两套技能 | ① **GTP 精密计算**（1 棵 / 冷却 10）：`immuneUntil[player] = turnNo + 2`，`applyDamage` 之前先判 `isImmune()` → 结算模式 `'immune'`、伤害 0，表现是攻击方棋子撞上血条前的**结界**被弹开化掉；到期由 `expireImmunity()` 在回合推进时清掉。② **GTP 恶龙吐息**（3 棵 / 冷却 12，先用植物再点**任意目标格**）：`FlameView.fireball()` 投出硕大火球（熔岩球 + 光晕外壳 + 白热核心 + 双环 + 12 段彗尾），命中瞬间叠加**一整套对撞级特效**（太阳爆发 ×2 + 全屏波纹 + 粒子 + 震屏 + 对撞音效），随后 `castFireball()` 把目标格**整行整列的空位**点燃（`flames` 每格记剩余回合，每换手 -1，共 5 回合）；棋子落在烈焰上会 `stoneShattered`（碎裂音效 + 碎片 + 行动作废）。③ **GLM 小一哥**（1 棵 / 冷却 5）：`powerBonus[player] += 1`，攻击值 +1，结算前这几颗额外棋子从**技能槽**沿弧线飞进悬浮棋子堆（`setSkillRects` 提供屏幕位置）。④ **GLM 毒鸡蛋**（3 棵 / 冷却 10）：本回合 `sabotage` 生效，`canStackAt()` 允许下在**敌方棋子**上，`overlay` 记录叠子（原棋子**不被顶替**、双方都能连珠），`declareAttack` 只让叠子飞走（事件带 `kept`）；不能连珠的敌方棋子会被 UI 拒绝并提示 |
| 10. 结算菜单新增「返回主菜单」按钮 | `ResultModal.vue` 增加第三个 ghost 按钮，`App.vue` 的 `backToMenuFromResult()` 关掉结算 / 菜单浮层后调用 `backToMenu()` |
| 11. 角色技能要支持联机 | 见下方「联机技能（bugv10 #11）」一节 |
| 12. 魔力植物优化：三色相间（不是三个不同颜色的部位）+ 加绿色；主干要随机角度弯曲；蕨类叶子要长在枝条上（不要虚空漂浮） | `magic-view.ts` 重写几何：① 颜色改成**四色轮转** `COLOR_CYCLE = [银白, 褐, 黄, 绿]`，任何**单个元素**都由多小节拼成并循环取色（花瓣内外两半、蕨叶小柄 + 叶片、草穗与基座），所以整株是"相间"而不是"三块不同颜色"；② 主干用 `buildStemChain()`：5~7 节首尾相接、每节叠几度随机偏转**累积成弧线**（不再是竹竿），枝尖返回带完整朝向的 `tip` 挂点；③ 蕨叶用 `socketOnStem()` 把每片叶的**小柄内端锚在叶轴的对应节坐标系**上（实测内端到叶轴折线间隙 0.0000），两侧交错、随机长度与张角 |

### bugv9

| 需求 | 实现 |
| --- | --- |
| 1. 对撞位置不要固定，要上下左右随机浮动（在屏幕内）；轨道不要直线，可绕随机弧线 | `SceneController.clashPointFor()`：撞击点改用 **NDC** 描述（左右 ±0.26、上下围绕原高度 ±0.2），因此任何画幅都在屏幕内且每次不同；`runClash()` 的飞行改成**二次贝塞尔**，控制点在"水平面内的垂直方向"上随机偏移（±1.15）并叠一个随机抬升（0.5~1.8），两条轨迹各自成弧、互不相同，飞行中还会翻滚。实测 12 次对撞的 NDC x 跨度 0.44 / y 跨度 0.38，11 条轨迹的中点全部偏离直线（0.34~0.90） |
| 2. 魔力植物优化（更大 / 白黄褐三色 / 特征色外覆 / 萤火虫 / 形状随机 / 落子后立刻消失 / 爆风吹动 / 魔法阵） | 见下方「魔力植物（bugv9 #2）」一节 |
| 3. 「2+1 中间空一格」也要显示预判线 | `lines.ts` 新增 `threatHints()`：在落点的每个方向上检查所有**包含落点的 4 连窗口**，窗口里正好 3 颗己方 + 1 个空位就提示，并返回那个空位（`gap`）。既覆盖原来的"连续 3 颗 + 一端空位"，也覆盖 `X X _ X`。表现层在空位上再点一圈双环 + 短针，明确指出补哪里 |
| 4. 攻击阶段棋盘由黑色改为双方特征色每 0.5 秒循环切换（要有过渡） | `BoardView`：攻击阶段用 `attackCycle` 在 `sides[0].color` 与 `sides[1].color` 之间来回插值（半周期 0.5s，`smoothstep` 过渡），再用 `attackMix` 与黑色混合，退出攻击阶段后相位归零、回到黑色。**顺带修掉一个真实 bug**：实战路径里从来没有人调用 `setAttackMode(true)`（只有重连 / 回放重建场景时会置位），所以之前攻击阶段棋盘一直是黑的，现在在 `highlightShown` 事件里打开 |
| 5. 太阳特效的光束长度 / 形状 / 角度要不一 | `createSunTexture()` 重写：光束数量 26~38 随机，每根的长度在 0.34~1.0 连续随机、角度带随机抖动；一半是**带弧度侧边的尖头光锥**，另一半是**二次曲线描边的弧形细光束**（粗芯 + 细亮芯两层）。实测 72 个角度扇区里最长 / 最短 = 2.1 倍、取值 22 档 |
| 6. 悬浮棋子数量与总攻击数不一致（削弱后多出一颗飞不出去；有植物时少一颗） | `SceneController.reconcileStage(tally)`：按**总攻击数**多退少补 —— 多出来的当场炸成碎片 + 冲击波（视觉上"被抵消掉"），不够的补生成悬浮棋子。由 store 在 `defenderPlaced`（只对齐攻击方，避免防守方棋子还没飞上来）与 `stonesRemoved`（两侧一起）时调用；`animateAttackResolved()` 结算前再兜一次底（回放跳步也适用）。实测：4 连 + 1 植物 → 总攻击 5、悬浮 5；被削弱 1 → 悬浮立刻变 4；无植物被削弱 1 → 悬浮 3 且正好扣 3 点血 |
| 7. 右下角新增微型播放器（箭头弹出 / 收回，含歌名、播放暂停、上下首、音量静音；默认 `let me go.mp3`） | 新增 `MiniPlayer.vue` + `BgmPlayer` 的播放控制（`toggle / pause / setVolume / setMuted / playing / progress`）。收起时只是右侧一个音符小按钮（播放中带绿色脉冲点），点箭头整体弹出，再点收回；曲目默认取 `let me go.mp3`（找不到才用第一首） |
| 8. 菜单「返回主菜单」点了菜单没关 | `backToMenu()` 现在把 `showGameMenu / showSettings / showResult / showReplay` 一起清掉（之前只改了 `screen`，浮层还挂在屏幕上） |
| 9. 回放优化：面板挪到右下角不挡棋盘；要和真实对局一样有特效与血条；快进快退关掉当前动画；可导出代码 | ① 面板改为右下角 330px 宽 + **可折叠**（`rail` 头一直可见），`max-height` 74vh 内部滚动；② `ReplayStep.events` 记录每步的完整事件序列，`playReplayStep()` 用 `runEvents(..., { replay: true })` **重播特效**（连珠针 / 冲击波 / 碎片 / 攻击结算卡），HUD（立绘 + 血条）在回放时也显示；③ `seekReplay()` 先 `skipAnimations()` + `resetTransient()` 再瞬间落步，`Animator.clear()` 也改成唤醒所有等待者（否则回放链会挂死）；④ `exportReplayCode()` / `importReplayCode()`：`C4R1:` + base64（棋盘压成 81 字符、植物压成 `cell:kind:owner`），面板里可复制 / 粘贴后直接播放（实测 4 手 2.3KB） |
| 10. 更多程序化音效，可按扳机自选，选择时试听 | `audio.ts` 重构成**声明式配方**：9 个扳机（落子 / 连珠 / 防守成线 / 对撞 / 撞击血条 / 界面 / 植物长出 / 植物被抢 / 门铃）× 2~4 套风格（木质 / 水滴 / 电子 / 石子 / 钟琴 / 力量 / 盾牌 / 金属 / 雷电 / ……）共 27 套，全是振荡器 + 滤波噪声的配方。设置面板「音频」分节里每个扳机一排 chip，点击即 `preview()` 试听并写进 localStorage |
| 11. 结束后新增动画：棋子高速炸飞、xy 随机偏移、整体往玩家方向、由高速逐渐减速直至离开屏幕 | `pieces-view.launchAll()` + 每帧 `updateFlyers()`：初速 ≈16~26（+z 为主，xy 随机、略微上抛），指数衰减（`exp(-1.02·dt)`），同时缩放做出冲出画面的透视感，`z > 12` 或飞满 2.6s 回收。由 `gameOver` 事件的动画阶段播放（1.35s），播完才切表情 / 弹结算 |
| 12. 悬浮棋子的魔法阵颜色改为由特征色决定 | 颜色本来就取 `palette.sides[owner].color`，但 `SceneController.setPalette()` 从没把新配色同步给 `EffectsView`，所以换色 / 换角色后魔法阵还是旧的。现在 `setPalette()` 会同步 board / pieces / effects / magic 并对**已在舞台上的棋子**重新着色；透明度的底图也提到 0.62 让颜色更实 |
| 13. 角色系统（立绘 / 4 个表情差分 / 角色选择 / 特征色 / 技能 / 图标） | 见下方「角色系统（bugv9 #13）」一节 |

### 魔力植物（bugv9 #2 大改）

在 bugv8 的机制之上，表现与手感全面重做（`src/three/magic-view.ts`）：

- **更大 + 摆动更大**：整体缩放 1.45 → **2.05**（每株还有 ±13% 高矮差异），摆动幅度 0.05 → **0.12**（10 秒 1.35 弧度，另加扭转）。
- **按部位分色**（bugv11 #4 定稿）：由**褐 / 绿 / 黄 / 银白**四色按**部位**固定分配 ——
  枝干 / 叶轴 / 小柄 / 根座 = 褐，叶片 / 蕨叶 / 草叶 = 绿，花心 / 草穗 = 黄，花瓣 = 银白。
  零件建的时候就写 `mesh.userData.part`，烘焙时按部位把所有零件合成**一块纯色、不透明**的几何
  （`bakePart()`），所以既没有"一段一段的分节"，也没有"半透明叠层"的混色，
  同时整株植物仍然只有 ≤ 4 个 draw call。
  （历史：bugv10 #12 试过"沿枝条逐节换色"，bugv10 追加 #3 试过"一株 4 层千层饼"，都因为看起来更怪被推翻。）
- **主干随机弯曲**（bugv10 #12）：`buildStemChain()` 把主干拆成 5~7 节首尾相接的锥台，
  每节叠几度随机偏转（x/y/z），逐节**累积**成自然弧线；枝尖返回带完整朝向的 `tip`，
  花头 / 草穗 / 叶轴都挂在它上面，因此一定长在枝尖并顺着弯折方向。
- **蕨叶长在枝条上**（bugv10 #12）：`socketOnStem()` 在叶轴的对应节坐标系里取挂点，
  蕨叶的小柄内端锚在挂点上（实测内端到叶轴折线的间隙 0.0000），再朝枝外偏上展开，不再虚空漂浮。
- **特征色外覆**：被棋子占住时，整株再套一层略大（×1.14）的同形外壳，颜色 = 该方特征色（加色混合、随角色变化）；
  技能挑选时非我方的植物整体压暗（材质 ×0.34、萤火虫熄灭），被勾选的植物挂一圈旋转高光环。
- **萤火虫荧光**：每株 3~5 颗荧光点绕着植物公转 + 上下浮动 + 呼吸闪烁，被爆风后会短暂变亮。
- **形状随机化**：小花 5~8 片花瓣、随机半径与角度、枝条随机弯折；草 3~5 根、随机朝向与弯曲；蕨每侧 4~6 片叶、随机排布与朝向。随机数由「格子 + 种类」派生，因此同一株长相在联机两端与回放里完全一致。
- **立刻消失**：防守方一落子（`defend()` 里算完伤害后立刻 `clearMagicAt`），参与本次连珠的植物马上消失，不再等攻击阶段结束。
- **爆风**：`MagicView.blast(position, strength)` 在每次 `playBlast()`（对撞 / 撞击血条）时调用，半径 3.4 格内按距离衰减把植物吹歪，之后指数衰减 + 余弦回弹晃两下再立起来。
- **归属标识换成魔法阵**：原来是一圈特征色光环，现在是与悬浮攻击棋子同一张贴图的**旋转双正方形魔法阵**（`magic-texture.ts` 两处共用），颜色 = 该方特征色。

### 角色系统（bugv9 #13）

- **角色**：数值与技能表在 `src/core/characters.ts`（纯数据，**服务端共用同一份**），
  立绘在 `src/app/characters.ts` 用 `import.meta.glob('../assets/img/*.png')` 扫描，文件名约定
  `<角色>.png` / `<角色>-atk|hit|win|lose.png`（缺哪个表情就回退到基础立绘）。
  目前 4 个角色：DeepSeek `#3964fe` / Gemini `#d45fb9` / GTP `#c7bef0` / GLM `#27314a`，
  四个特征色都在特征色预设列表里。
- **选择**：开始菜单用**横向轮播**（每页 2 个 + 左右箭头翻页 + 「随机」选项 + 右侧技能详情），
  设置面板用紧凑轮播，都能为**先手方 / 后手方**分别选角色，双方可以选同一个；
  换角色会一起换掉特征色、立绘与技能表（技能表是引擎的输入，下一手立刻生效）。
- **HUD**：左右上角**只保留立绘 + 血条**（移除了头像圆牌、昵称、先手/后手标签）；
  血条在立绘**上方**且与立绘等宽、**不显示血量数字**；
  护盾画成**金属质感的银色段**，压在血条最左侧（也就是最先被打掉的位置），无上限、可叠加。
- **表情差分**（严格按需求文字推导）：

  | 时机 | 差分 |
  | --- | --- |
  | 一方完成连珠（`matchFormed`） | 该方 `atk` |
  | 防守方**没成线**（`clashCount === 0`） | 攻击方 `win`、防守方 `lose` |
  | 防守方成线且吃了差值伤害（`damaged`） | 受击方 `hit`、另一方 `win` |
  | 防守方成线但打平 | 双方 `atk` |
  | 对局结束 | 胜方 `win`、负方 `lose`，**等 1 秒**再弹结算 |

  表情只在**新的落子**时重置 —— 之前挂在 `turnStarted` 上会被"防守回合的最后一个 turnStarted"顶掉。
- **技能槽**：画面左右侧中间各一组，两个技能。需要消耗**场上被我方棋子占用的魔力植物**；
  冷却按"自己的行动次数"计算（`skillReadyAt - actionsTaken`），**开局全部处于冷却**。
  点技能不再弹窗：槽位旁冒一个**气泡**（名称 / 消耗 / 冷却状态 / 效果说明 / 不可用原因）；
  可用时进入挑选：画面与棋盘变暗、场上我方植物放大并加高光圆环（勾选过的再加转动的高光环），
  站在植物上的我方棋子高亮、鼠标悬停时标识更强；需要的植物点够就释放
  （`targetsCell` 的技能此时再点一个目标格；再点一次技能 = 取消）。
- **八个技能**：

  | 角色 | 技能 | 消耗 | 冷却 | 效果 |
  | --- | --- | --- | --- | --- |
  | DeepSeek | 大胃袋 | 1 | 5 | 获得 1 点护盾（先于血量承伤、可叠加、无上限） |
  | DeepSeek | 杀鲸霸拳 | 3 | 10 | 当前回合连下两颗子，**两颗都下完才进入攻击阶段** |
  | Gemini | 猫的憩息 | 1 | 5 | 恢复 1 点血量（不超过初始血量） |
  | Gemini | 双子星 | 2 | 10 | 本回合落下的这颗子**两连即可发起攻击**，并且这一击**免疫对手的反击伤害** |
  | GTP | 精密计算 | 1 | 10 | 直到对手的下个回合结束前**无敌**（释放后本回合仍可落子） |
  | GTP | 恶龙吐息 | 3 | 12 | 向点选的位置投出硕大火球，该位置**整行整列的空位**燃起烈焰 **6 回合**（双方各走一步算 1 回合）；**开局不在冷却、首次释放免费**，释放后本回合仍可落子 |
  | GLM | 小一哥 | 1 | 5 | 本回合伤害 +1，攻击时额外从技能槽飞出一颗棋子 |
  | GLM | 毒鸡蛋 | 3 | 10 | 本回合可在**敌方棋子上**落子（必须能连珠，且不顶替原棋子） |

  > 双子星的爆发窗口只持续**当前回合**（`twinStar`）：窗口内两连即可开打、且这一击不吃反击伤害，
  > 换手即失效（原本"下一颗棋子落下时长满魔力植物"的效果已按需求去掉）；
  > 烈焰上的棋子会在成形前碎裂、行动作废；烈焰按"半回合"计时（双方各走一步 = 1 回合）；
  > 无敌期间受到的伤害整体结算为 `mode: 'immune'`（不透支血条）。
- **图标**：`src/three/skill-icons.ts` 用 canvas 2D 程序化绘制 8 种图标
  （护盾 / 连击箭头 / 心形十字 / 环绕嫩芽 / 六边形护壁 / 双层火焰 / 上升箭头 / 裂开的毒蛋），
  渐变底盘 + 细描边，输出 PNG data URL（无图标资源）。

### 联机技能（bugv10 #11）

联机对局**支持角色技能**：客户端不再本地改状态，而是把意图发给服务端裁决。

- 协议（详见 [`back/PROTOCOL.md`](./back/PROTOCOL.md)）：`queue / createRoom / joinRoom` 带上 `character`，
  `matched` 回 `characters: [id0, id1]`（按座位）；新增客户端消息
  `{ t: 'skill', matchId, slot, cells, target? }`，服务端 `engine.useSkill()` 成功后才广播
  `applied`（`kind: 'skill'`，带 `slot / cells / target`），失败一律 `illegalMove` / `notYourTurn` 且不广播。
- 两端跑**同一份** `src/core`（`pnpm sync:core` 逐字节同步到 `back/src/core`），
  服务端用 `skillsOfCharacter(characters[seat])` 构造引擎，因此技能表与客户端完全一致。
- 指纹（`src/core/digest.ts`）新增 `shield / bonusActions / actionsTaken / skillReadyAt / turnNo /
  immuneUntil / flames / overlay`，`state` 还会带上 `powerBonus / sabotage` 用于技能回合中重连；
  任一端漂移都会立刻 `sync` 自愈。
- 客户端 UI：`disabled` 只对**对手那一方**（以及本地 AI 那方）置灰；点自己的技能照常冒气泡，
  发送后等 `applied` 回来才播动画（4 秒无响应会解锁棋盘并提示）。

### bugv8

| 需求 | 实现 |
| --- | --- |
| 1. 拖尾太明显，要更短更细 | `cursor-trail.ts`：轨迹寿命 0.55s → **0.3s**，最大宽度 9px → **3.4px**，外发光与头部彗核同步缩小、透明度整体下调。实测沿 600px 轨迹：尾迹长 124px、最大横向厚度 10px（含柔光边，原来约 20px） |
| 2. 对手加入房间要有一声门铃 | `audio.ts` 新增 `doorbell`：正弦双音「叮（E6）—咚（C6）」+ 两次敲击噪声，尾音拖长。在联机客户端 `matched` 回调里播放（在线匹配与匹配码都算），**两端都会响** |
| 3. 一方断开连接，另一方要有提示 | 新增 `NoticeModal.vue` + `ui.notice`：对手掉线（`opponentLeft`）或身份被顶替（`duplicateLogin`）时，棋盘上方弹出提示（标题 + 原因 + 「返回大厅」按钮），点确认直接回大厅；同时锁定棋盘、状态标记为已结束 |
| 4. 新增魔力植物机制（联机也有） | 见下方「魔力植物」一节 |
| 5. 魔法阵被截断（角没显示）+ 边更宽 | 根因：`createMagicTexture` 里正方形画到 `0.4×size`，旋转 45° 后对角线到 `0.566×size`，**超出画布被裁掉**。收到 `0.33×size`（对角线 0.467，四周留 3px 边距），线宽 0.018 → **0.03**，同时把贴图平面从棋子半径 2.35 倍放大到 2.9 倍保持视觉大小 |
| 5b. 悬浮棋子排成一条线，要随机散布 | `stageAnchor()` 叠加**确定性抖动**（按 owner+index 派生，逐帧稳定，不会自己抖）：NDC x ±0.055、y ±0.085、深度 ±0.12，四颗棋子的 x/y 各不相同且仍留在己方一侧 |
| 6. 总攻击数字要更大、更细长 | 字号 30px → **46px**（随攻击数放大到约 59px）、字重 800 → **200**，数字包一层 `.tally__glyph` 做 `scale: 0.88 1.22`（纵向拉长、横向收窄）。用独立子元素缩放是因为外层 `transform` 被 3D 层每帧写位置 |
| 7. 碎片初速度要更快、更有冲击力 | `SHARD_SPEED` 2.6~6.8 → **7.5~15**，并叠加一个"从爆心向外"的径向偏置；自旋 ±7 → ±13，重力 -11 → -17，寿命收到 0.42~0.78s。实测同屏 26 块碎片、最大初速 14.2 |

### 魔力植物（bugv8 #4）

**规则**（`src/core/magic.ts` + `engine.ts`，纯逻辑、可单测）：

- 三种植物：**银白小花 / 三根岔开的草 / 银蕨**（程序化几何，无贴图资源），长在**空位**上，可以被棋子直接压住。
- **伤害**：连珠上每有一棵植物，最终伤害 `+1`（`finalAttack = 基础 + 植物 - 削弱`）。
- **可被抢**：防守方落在带植物的格子上（高光位）就把它抢过来 —— 攻击方少 +1、防守方多 +1。
  需求里的例子已写成单测：赤方 4 连 + 1 植物 = 5；青方在被抢的格子上也成 4 连 → 青方 4+1=5、
  赤方 4+1-1(被抢)-1(占位削弱)=**3**，差值 2 点伤害由赤方承担。
- **消失**：连珠结算后，参与连珠的格子上的植物随棋子一起消失。
- **生长**：冷却（默认 10 回合）走完就在空位长一批；**任意一方连珠会把冷却一次砍掉 8 回合**；
  默认还必须"先出现过连珠"才开始计时。每批数量 `2 + ⌊生长次数 / 3⌋`，上限 4。
- **配置**：全部参数在 `DEFAULT_MAGIC_CONFIG`，设置面板「魔力植物」分节可改并写进 localStorage；
  **联机固定用默认值**（两端引擎必须一致，否则局面指纹会漂移）。
- **确定性**：长在哪几格、长成哪一种都用「局面文本 + 生长序号」派生的 PRNG 算出来，
  不消耗引擎随机种子 —— 因此协议里**不需要**传生长结果，联机两端自然一致（`digest` 兜底校验）。
- **回放**：每步快照里带上植物（`ReplayStep.magic`），服务端回放同样落库，回放时能原样重现。

### bugv7

| 需求 | 实现 |
| --- | --- |
| 1. 联机时一方落子后另一方点不动（WS 正常、对方消息也收到了） | 三个叠加的原因，全部修掉：<br>① **消息顺序**：`matching.enqueue()` 内部可能立刻配对，此时 `matched` 已经发出，服务端却还补了一条 `queued`；客户端收到"先 matched 后 queued"就把状态从 `playing` 覆盖成 `queued`，于是那一方永久锁死。服务端现在只在**确实还在队列里**时才回 `queued`；客户端同时加了"有 matchId 时大厅状态不许覆盖对局状态"的保险。<br>② **Vue 响应式陷阱**（真正的元凶）：`engine` 是 `shallowRef`，引擎内部 `current` 的变化**不会**触发 computed 重算，于是"轮到我了吗"被永久缓存在开局掷骰子的那一刻 —— 一侧永远是 `true`、另一侧永远是 `false`。改用响应式的 `ui.current`（并顺手修掉 `statusText` 里同样的读法）。<br>③ 发送失败不再静默：`move()` 返回 false 时立刻解锁并提示"连接已断开，正在重连"；客户端连接状态机也重写（socket 回调绑定到自己的连接、`connect()` 幂等、断线自动重连后 `sync` 接回局面）。<br>另外：同一身份重复登录时服务端会把**旧连接踢掉**（`duplicateLogin`），并把对局里的广播目标**重绑到新连接**——否则刷新页面后 `sync` 能拿回局面，但对手后续每一步都发往那条已经断掉的旧连接。 |
| 2. 拖尾太花里胡哨（像放烟花），要的是"拖尾" | 换掉粒子式实现，改成自绘的**彗星式尾迹**（`src/app/cursor-trail.ts`，零第三方依赖）：记录光标最近 0.55s 的轨迹点，每帧用两遍多段线描出来（宽而淡的外发光 + 细而实的芯），越靠尾端越细越淡、头部留一颗亮点；相邻采样点**直接连线**，所以鼠标再快也不会断成一颗颗。实测沿 600px 轨迹覆盖率 **100%**、最大断口 0px、横向不超过 6px。顺手移除了 `cursor-effects` 依赖（它的 `trailingCursor` 在匀速移动时会收敛成一个点、粒子效果又像烟花）。 |

### bugv6

| 需求 | 实现 |
| --- | --- |
| 1. 设置弹窗太长，改成「左分节 + 右内容」 | `SettingsPanel.vue` 重写为 `.settings-dialog`：左侧 6 个分节（对局 / 棋力 / 外观 / 音频 / 联机 / 规则），右侧只渲染当前分节（`tab` 切换 + `paneIn` 过渡），弹窗 760×504 固定高度不再滚动到底；窄屏自动把分节折成顶部横向滚动条 |
| 2. 背景音乐选择改下拉框 | 音频分节里换成原生 `<select>`（`.select` + 自绘箭头），选项由 `import.meta.glob('../assets/bgm/*.mp3')` 自动生成，丢文件进去就出现 |
| 3. 拖尾太丑 + 要蓝色 | **bugv6 当时**换成轻量第三方库 `cursor-effects`（`characterCursor`）：单个 canvas 覆盖层，蓝色光点/星点带随机漂移。**但它在 bugv7 #2 被判定"像放烟花"**，现已改为自绘的彗星式尾迹（见 bugv7 表），`cursor-effects` 依赖已移除 |
| 4. 新增回放：结束后保存、可查看之前的对局 | 新增 `src/app/replay-store.ts`：每局结束（`gameOver` 事件）把 `MatchRecord`（含每步棋盘 / 血量快照）写进 `localStorage`（key `connect4.replays.v2`，最多 30 局，损坏数据自动丢弃）。回放面板改成两个来源页签：**本地存档**（可单条删除 / 清空）与**服务器**（联机对局，从 `GET /api/replays` 按需拉取）；结算面板新增「回放本局」 |
| 5. 波纹朝向都一致，要随机 | 全屏波纹 shader 增加 `uPhase`，每次 `fire()` 取 `random()*2π` 作为谱线起始角；落点冲击波圆环按 Euler `XYZ` 顺序在**环平面内**随机旋转（先 `rotateZ` 再躺平），所以每个涟漪的锯齿朝向都不同 |
| 6. 对撞碎片颜色必须用两种棋子的特征色 | `PiecesView.shatter(mesh, owner, origin, other?)`：碎片基色直接取 `palette.sides[owner].color`，并按 `i % 4` 分配 **本方色 / 对手色 / 两者中值**（对撞时传入对手 owner），自发光再朝白色提亮 18%。全程没有任何写死的色值（实测出现 `#e0273c`、`#1668d6` 与中值 `#a550a1`） |
| 7. 提示针消失要有过渡 | `EffectsView` 的 beam 不再用线性淡出：改为 `smoothstep` 淡入（前 10%）+ `smoothstep` 淡出（后 50% / 68%），同时半径从 1 收到 0.34 倍，针会**边变细边消失**，不再是到点直接消失；`anim.ts` 新增通用 `smoothstep()` |
| 8. 在 `D:\SOLO\game\back` 建一个 MongoDB 后端做双人联机 | 见下方「联机后端」一节与 [`back/README.md`](./back/README.md) |

### 联机后端（bugv6 #8）

`back/` 是一个**可独立部署**的 Node + Express + ws + MongoDB 工程，协议契约写在
[`back/PROTOCOL.md`](./back/PROTOCOL.md)：

- **服务端权威**：服务端跑同一份纯逻辑引擎（`back/src/core` ← `pnpm sync:core` 从 `src/core` 复制），
  只接受「轮到你的那一方」的 `move`，非法落点 / 抢手一律转成 `error`；
  每一步下发 `applied`（含 `seq`、`hp`、`current`、`phase` 与**局面指纹** `digest`）。
- **客户端本地重演**：前端收到 `applied` 后按同一份引擎本地 `commit()/defend()`，
  于是动画与事件序列和单机完全一致；指纹不一致就发 `sync` 用完整局面重建
  （`loadScenario` 新增 `highlights` 参数，断线重连也能恢复攻击阶段的高光与削弱权重）。
- **匹配**：`queue` 先进先出在线匹配；`createRoom` 生成 6 位匹配码（去掉易混淆字符、10 分钟有效），
  对方 `joinRoom` 即成局。骰子由服务端掷一次、两端沿用。
- **回放**：每局落库到 MongoDB `replays` 集合（`_id = matchId`，含与前端同构的 `steps` 快照），
  `GET /api/replays?playerId=&limit=` 可查历史；前端回放面板直接播放服务端回放。
- **部署**：`SERVE_FRONTEND=true` 时同一个 Node 进程顺带托管前端 `dist`，一份服务搞定；
  也能只当后端 —— 前端默认就指向内置的那台后端（bugv11 追加 #7），换地址用 `VITE_SERVER_URL`。

### bugv5

| 需求 | 实现 |
| --- | --- |
| 1. 入位动画有时会让双方交换位置 | 根因：`gatherForClash` 把"攻击方"固定放在左边、"防守方"放在右边，于是**后手方发起攻击时两边就跑到对面去了**。现在去哪一侧只由**棋子属于哪一方**决定（player 0 = 左、player 1 = 右），与谁是攻击方无关 |
| 2. 下子时去掉全屏大波纹 | `animatePlacement` 不再触发全屏波纹（`ripple.fire`），只保留落点的两层扩散环 + 光晕 + 粒子 |
| 3. 所有波纹改成频谱状锯齿 | 冲击波圆环从 `MeshBasicMaterial` 换成自定义 `ShaderMaterial`：顶点按角度做三组正弦叠加的径向起伏（随时间跳动），片元再沿圆周做一亮一暗的谱线；全屏波纹 shader 同样加了角度抖动与谱线 |
| 4. 高 AI 等级会卡住动画 | 决策挪进 **Web Worker**（`src/ai/worker.ts` + `src/ai/client.ts`）：主线程只管渲染，实测 expert 思考期间仍有 **115fps**；没有 Worker 的环境（jsdom / 老浏览器）自动回退同步计算，功能与单测都不受影响 |
| 5. BGM 文件夹 + 设置里可切换 | 新增 `src/assets/bgm/`，原有曲子作为默认 `bgm.mp3`，另外用 ffmpeg 合成了 `calm.mp3` / `tense.mp3` 两首环境 loop；用 `import.meta.glob('../assets/bgm/*.mp3')` 自动列出文件夹里**所有** mp3，设置面板新增「背景音乐」分组，**往文件夹里丢新曲子就会自动出现在列表里** |
| 6. 连珠提示线改细 + 两端细的针状 | `matchBeam` 从等粗 `CylinderGeometry` 换成 `LatheGeometry` 旋成的**梭形**（半径按 `sin` 从两端 0 涨到中间），半径也从 `0.075` 收到 `0.042` 格 |
| 7. 只差一颗即可连珠时显示长提示针 | 新增纯逻辑 `nearLineDirections(board, player, cell)`（core/lines.ts）：落点所在连续段恰为 3 且至少一端是空位 → 返回该方向。store 在落子动画**开始前**算出方向并调用 `showThreatHints()`，沿方向拉出 13 格长的针状线（先亮起再淡出）并在落点叠一圈频谱光环 |
| 8. 要"太阳"式爆发 + 碎片（不只是涟漪） | 新增 `EffectsView.sunburst()`：程序化生成的 512² 贴图（白热核心 + 日冕 + 36 道长短短长光芒 + 两圈镜头光晕），中心颜色朝白色提亮，膨胀到 3.4 倍；**同时点亮一盏瞬时点光**（峰值 30，0.36s 衰减）把周围棋子照亮。碎片则是**真的把棋子炸开**：`PiecesView.shatter()` 用棋子自己的旋转体几何生成 13 块碎片，带初速、重力、三轴自旋与缩小消失（对撞两颗各炸一次，实测同屏 65 块碎片） |
| 9. 鼠标拖尾 | 纯 CSS 实现（`App.vue` + 内联样式）：11 个点共享一个 `--mx/--my` 变量，每个点的 `transition-duration` 递增（0.1s → 0.4s）自然形成拖尾，**每次 pointermove 只写一次样式、零逐帧 JS、无第三方依赖**；颜色跟随当前回合的特征色，触摸设备与 `prefers-reduced-motion` 下自动关闭 |
| 10. 悬浮棋子的魔法阵 | 程序化贴图：两个交错正方形 + 内外圈 + 12 道刻度，加色混合、特征色、尺寸约为棋子的 2.35 倍；因为它不跟随棋子自转（挂在 scene 上），每帧只同步位置 + 面向相机 + 持续旋转，所以看起来是稳定的法阵 |

### bugv4

| 需求 | 实现 |
| --- | --- |
| 1. 黑棋看着像"黑红"，场上棋子颜色不受特征色影响 | 棋盘棋子的材质 `emissive` 恒为 **0**，本体就是纯黑 `#0b0c10` / 纯白 `#f6f7f9`；连珠高光改成**只提亮度**的白色自发光（黑子 0.42 / 白子 0.1），不再给棋子染特征色。特征色只保留在高光点、特效与**悬浮攻击棋子**的附着层上（bugv3 #8 仍然成立） |
| 2. 骰子还没消失就能下子 | 新增 `ui.diceVisible` + `syncInteractive()`：棋盘的可交互性统一由"在局中 + 不忙 + 骰子已消失 + 未结束"决定。骰子浮层淡出后 `hideDice()` 才解锁，并且**AI 也不能抢手**（`shouldAiMove()` 同样受骰子约束，解锁后再触发 AI 起手）；另加 1.9s 兜底计时器，宿主没挂骰子组件也不会一直锁着 |
| 3. 结算面板挡住对方攻击棋子 | `.attack-card` 从右上移到**左下角**（`left + bottom`），入场动画改为从下方浮入；悬浮棋子在两侧上方、血条在顶部，互不遮挡 |
| 4. 落子后棋盘按落点方位短暂倾斜 | `tiltBoardTowards(cell)`：按落点相对棋盘中心的行 / 列算出俯仰与侧倾（离中心越远角度越大，峰值约 4.9°），用 `sin` 包络在 0.85s 内压过去再自行回正；倾斜叠加在鼠标视差之上，不影响操作 |
| 5. 取消下落，改为直接出现；落点涟漪更慢更大 | `animatePlacement` 不再从高空落下：棋子立刻落在交点上（只有很短的"弹一下"），涟漪改为两层扩散环（`to: 2.7 / 3.9`，`life: 1.05 / 1.4`，原来只有 1.05 / 0.42）+ 落点光晕 + 粒子 + 低强度全屏波纹（1.2s） |
| 6. 抵消 / 撞血条要光芒炸裂 + 粒子爆发 | `EffectsView.starburst()`：程序化生成的放射光芒贴图（中心光晕 + 20 道长短相间的光条），面向相机、加色混合，0.52s 内炸开到 3.6 倍；`playBlast()` 里叠两道（特征色 + 白色），粒子爆发从 3 组加到 3 组更猛（46 / 30 / 30 颗 + 高速碎光），并真正接上了全屏闪光 |
| 7. 抵消 / 撞血条减速 30%，悬浮翻转再 +50% | 时长统一乘 `ACTION_SCALE = (1 / 1.5) / 0.7`（bugv3 的 +50% 与本次的 -30% 合并）：对撞 0.24→0.2286、消散 0.2→0.1905、撞血条 0.42→0.4；`SPIN_UP = 1.5 × 1.5`（累计 +125%） |
| 8. 抵消前插入"入位"动画 | 防守方也成线时，先播 `gatherForClash()`：双方棋子用 1.5s 缓入缓出地移到 **棋盘的左右两侧**（世界 x = ±4.9，紧贴棋盘；而悬浮时是贴屏幕边缘的 ±5.4），然后再开始逐对对撞 |
| 9. AI 对战 + 更强的 bot | 首页直接加了 人机 / 双人 / **AI 对战** 三个模式（观战固定用最强棋力），两边都是 AI 时全自动落子；bot 这轮的加强见下节 |

### AI 加强（bugv4 #9）

| 改动 | 说明 |
| --- | --- |
| **修掉搜索的符号 bug** | 本作攻击阶段结束后由**原攻击方**继续（规则 11.2），一步棋之后轮次可能不变；原来的 negamax 假设"每层视角交替"，遇到不换手就把分数符号搞反（**成线反而被算成亏**）。现在改为**根视角 minimax**：轮到根玩家取最大、轮到对手取最小 |
| 迭代加深 + 置换表 | Zobrist 哈希局面（含血量与轮次），同局面只算一次；由浅到深逐层搜，浅层结果给下一层排序，超时丢弃未完成的一层 |
| 着法排序 | 置换表着法 → 直接成线（按攻击值，能一击致死再加权）→ 对手威胁 → killer / history → 中心控制 |
| 评估更贴合本作 | 围绕真实货币"攻击值 + 血量差"：活三（两步杀）权重 220、成线 900/端、血量 70/点 |
| 防守不再自杀 | `chooseDefense` 的字典序里 `lethalForUs` 原来被当成"越大越好"，实际上**会优先选择把自己打死的落点**；现在改成"先活下来 → 再打死对手 → 再比净伤害" |
| 新档位 | `expert`（深度 7 / 1200ms），`hard` 提到深度 5 / 500ms；`timeLimitMs` 现在是真正的**上限**而不是下限 |
| 战术优先 | 打分接近（30 分内）时优先直接成线——浅层搜索下"能连珠却因评估噪声错过"是最亏的失误 |

自对弈抽查（`pnpm exec tsx scripts/selfplay.ts`，每步 80ms 预算）：expert vs easy **7 胜 1 负**。

### bugv3

| 需求 | 实现 |
| --- | --- |
| 1. 攻击棋子要始终停留在**自己那一侧** | 舞台锚点不再用固定的世界坐标，而是由**屏幕 NDC** 换算（`CameraRig.ndcPoint`）：player 0 永远在屏幕左侧、player 1 在右侧，与顶部血条左右一致；并去掉“双方先聚到中央”的步骤，只有参与对撞的那一对从己侧冲向中央 |
| 2. 暗场只应压暗场地，不该压暗棋子 / 血条 / 对撞特效 | 页面压暗层移到**画布之下**（`z-index: 0 < 画布 1`），画布内容与血条不再被压暗；`.is-dimmed` 时血条面板转为不透明并加辉光；悬浮棋子 / 附着层在暗场里反而被**提亮**（自发光 0.14→0.85，aura 0.26→0.5）；对撞特效本身就是不受光照影响的加色材质，并接上了真正生效的全屏闪光（`ScreenFlash`，此前 `flashAmount` 无人消费） |
| 3. 对撞与撞击血条提速 50% | 统一由 `SPEED_UP = 1.5` 控制：对撞飞行 `0.24→0.16`、消散 `0.2→0.133`、撞血条 `0.42→0.28` |
| 4. 悬浮位置要贴画面边缘；翻转快 50% | 舞台 NDC 锚点为 `±0.88`，悬浮列按 `STAGE_NDC_Y_STEP` 排布；翻转速度 `×SPIN_UP (1.5)` |
| 5. 防守方在**高光位**落子并成线后，棋子应消失 | 根因：`stagedByCell` 用**格子**做键，而防守方落点恰好是攻击方留下的高光格（原棋子已在舞台上），旧的 `has(cell)` 判断把**新棋子**当成“已处理”跳过了。现在只在“该格确实没有棋子”时才跳过，新棋子照常离场 |
| 6. 悬浮棋子旁显示总攻击数（发光字、数字越大越大） | `SceneController` 每帧把两个 `.tally` 元素的 `transform` 写到舞台旁（宿主只给文本与样式）；数字用 `--tally-scale` 随攻击数放大（0.9 + n×0.11），多层 `text-shadow` 做辉光，`--tally-weight` 控制光晕半径 |
| 7. 把 `bgm.mp3` 作为背景音乐放进资源目录 | 移到 `src/assets/bgm.mp3`，新增 `three/bgm.ts`（`BgmPlayer`：循环、首次手势起播、`canPlayType` 能力探测、大特效时 `duck`）；与音效共用设置面板的开关 |
| 8. 场上棋子改为黑白棋子，保留特征色 | `SidePalette` 增加 `stone`：赤方黑子 `#1a1d24`、青方白子 `#f2f4f8`；特征色保留在连珠自发光、高光点、落子/对撞特效与**悬浮棋子的附着层**（`aura` 加色外壳）上；白子靠接地阴影在浅底上保持轮廓 |

### bugv2

| 需求 | 实现 |
| --- | --- |
| 1. 撞击血条要“撞击一次扣一次血” | 引擎在 `commit()/defend()` 里就把血量算到最终值，因此 store 在播放前**锁住界面血量**（`damagePending`），由 `onImpact` 回调逐颗 -1，播完再落到模型最终值；`hpChanged` 只更新模型不覆盖界面 |
| 2. 棋子应是凸起的实体棋子 | `LatheGeometry` 旋转一条“中凸 + 倒角”的剖面线（底面 → 侧壁倒角 → 凸起顶面），替换掉原来的圆柱 + 顶面内圈 |
| 3. 棋盘超出线段过长 | `GRID_OVERHANG` 从 `1.4` 收到 `0.34`（约三分之一格） |
| 4. 防守方下子后高光应立刻消失 | `stonesRemoved`（防守方连珠）时立即 `clearHighlights()`，不再等攻击阶段结束 |
| 5. 攻击阶段不应立刻变暗 | 拆成两个开关：宣告攻击只让网格转红；`attackResolved`（防守方已落子）才 `setDarkMode(true)`，页面压暗也改为由 3D 暗场回调驱动 |
| 6. 对撞距离过近 / 特效单薄 | 聚拢距离从 `±1.35` 拉到 `±1.85` 并错开 z；对撞与撞击血条共用 `playBlast()`：**全屏波纹**（`ripple.ts` 着色器满屏平面）+ 双向粒子 + 光晕 + 闪光 + 震屏 |
| 7. 游戏音效 | `three/audio.ts` 用 Web Audio **实时合成**（无需音频文件）：落子 / 连珠 / 反击 / 对撞 / 撞击血条 / UI，设置面板可开关；**bugv9 #10 起扩展成 27 套风格、按扳机选择并试听** |

### bugv1

| 需求 | 实现 |
| --- | --- |
| 开始菜单：开始游戏 / 查看回放 / 更改设置 | `StartMenu.vue` + store 的 `screen` 阶段（menu → setup → playing → replay） |
| 开局后左上 / 右上为头像与血条 | `App.vue` 的 `.hud` 顶部两栏（`PlayerPanel`），菜单中不渲染；**bugv9 #13 起改为角色立绘 + 血条** |
| 右下角设置按钮 / `Esc` 呼出菜单 | `.corner-btn` + `GameMenu.vue`（继续 / 重开 / 设置 / 返回主菜单） |
| 棋盘透明（不要底板） | 移除底板与底光，只保留网格线；`renderer.setClearColor(0x000000, 0)` + `alpha: true` |
| 棋子光照诡异 / 鼠标移动闪烁 | 去掉跟随棋子的两盏点光源与加法混合光晕，改为半球光 + 三盏方向光 |
| 不要画布边界与红色大圆盘 | 画布 `position: absolute; inset: 0`，去掉圆角 / 描边 / 径向底色 / 暗角层 |
| 棋子落在交叉点（9×9 线 → 9×9 交点） | 网格线改为 9 条横 + 9 条竖；`cellToWorld` 把行列映射到**交点** |
| 攻击阶段棋子凭空消失 | 舞台锚点曾在视锥外（NDC x ≈ -1.27）→ 收到 `±5`；并修正“视觉对账误回收舞台棋子”与逐帧浮动覆盖飞行位置的问题 |
| 攻击阶段结束后右侧面板不及时关闭 | `ui.attackPanelOpen` + `turnStarted` 后滞留 2.2s 自动关闭 |
| 默认白色环境光，攻击阶段暗下来 | 页面亮底 + `HemisphereLight` 白色环境光；攻击阶段页面级压暗 + 光照降至 `darkFactor` |

---

## 并入既有工程

见 [`skill/SKILL.md`](./skill/SKILL.md)：依赖清单（**只需新增 `three`**）、需要改动的宿主文件、
三种集成粒度（整页 / 局部 / 仅规则引擎）与常见问题排查。联机后端是可选件：
只做单机时不部署 `back/`，前端也完全不依赖它。

---

## 已验证

| 项目 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（strict 模式，无 `any` 逃逸） |
| `pnpm test` | 67 / 67 通过（连珠、预判线、削弱、抵消、血量、连续攻击、魔力植物、角色技能、bugv10 新技能：免疫 / 火球 / 增伤 / 叠子 / 连下两颗、bugv11：双子星两连攻击 + 免反击 / 恶龙吐息开局可用 + 首次免费 + 6 回合烧完 / 立绘保持 atk、AI、编排） |
| `pnpm build` | 通过（three 单独分包，gzip 约 120 kB；主包 gzip 约 70 kB；BGM 与 20 张角色立绘输出为独立资源，按需加载） |
| 浏览器端到端 | 真实 WebGL2 下跑通菜单 → 开局 → 攻击高光 → 4v4 对撞抵消 → 逐颗撞血条 → 致命结算 → 回放，无 console 报错 |
| 逐帧验证 | CDP 截屏流确认：双方各 4 颗进入舞台、逐对**从各自一侧**冲向中央相撞后消散（对撞瞬间有满屏波纹 + 闪光 + 粒子） |
| bugv2 回归 | 攻击宣告只转红不变暗 → 防守落子后高光 0.46s 内清空、1.7s 起变暗 → 血量 6→5→4→3→2 逐颗扣减 → 音效序列 place / match / clash×4 / impact×4 |
| bugv3 回归 | `pnpm verify:bugv3` **19 / 19 通过**：舞台 NDC x = ±0.88（贴边、只在己侧）、翻转 1.67~2.47、动画时长 0.16 / 0.1333 / 0.28、暗场中棋盘区亮度 240→71 而血条区 235→227、总攻击数「4 → 7」字号 40.2px→50.1px、高光位成线后棋子不再残留、BGM 循环推进 |
| bugv4 回归 | `pnpm verify:bugv4` **12 / 12 通过**：黑/白棋材质 `#0b0c10`/`#f6f7f9` 且自发光为 0、骰子期间点击与 AI 都不落子（`moveCount` 保持 0，淡出后点击即落子）、结算面板在左下（left 35 / top 599）、落子倾斜 0.157 rad 后回正、落子瞬间 y 已在 0.065（无下落）、入位双方 8 颗停在 \|x\|≈4.9、对撞出现 starburst 且闪光 0.25、时长 0.2286 / 0.1905 / 0.4、悬浮翻转 2.2~3.7、AI 对战 9 秒内自动走 5~6 手 |
| AI 强度 | `pnpm selfplay`：expert vs easy **7 胜 1 负**（每步 80ms 预算，8 局 15.8s） |
| bugv5 回归 | `pnpm verify:bugv5` **12 / 12 通过**：落子无全屏波纹（0 次）且圆环是频谱 Shader、先后手两种情况下入位都在各自一侧、提示针 / 连珠针都出现、魔法阵 4/4 且持续旋转（颜色 = 当前角色特征色）、太阳爆发（suns 2 / 瞬时点光 26）+ 碎片 65 块、AI 思考期间 **115fps**、BGM 曲库列出 `assets/bgm` 里全部 mp3（默认 `let me go.mp3`）且可切换、拖尾为蓝色光点 canvas |
| bugv6 回归 | `pnpm verify:bugv6` **13 / 13 通过**：设置弹窗 760px 宽 + 8 个分节（对局/角色/棋力/魔力植物/外观/音频/联机/规则）、BGM 下拉框列出全部 mp3 且切换生效、拖尾 canvas 蓝色、全屏波纹 3 次朝向互不相同 + 圆环随机旋转、碎片同时出现双方特征色与中值、提示针有 5 帧渐隐渐细中间态、对局结束写入 localStorage 且刷新后仍在（可删除）、联机大厅三种入口齐备 |
| bugv7 回归 | `pnpm verify:bugv7` **7 / 7 通过**：真实鼠标点击下双方各走 5 步（不再是一方锁死）、WS 原始帧确认 `matched` 之后不再有 `queued`、把状态强行改回 `queued` 后棋盘依然可点；拖尾沿轨迹连续（自身覆盖率 100%、断口 0px）、停手后收干净 |
| bugv8 回归 | `pnpm verify:bugv8` **15 / 15 通过**：拖尾长 124px / 厚 10px、门铃两端都响、掉线弹提示且棋盘锁定、魔力植物按冷却长出并出现在 3D（一次 2 棵）、连珠 +1（4→5）、抢走后攻方 3 / 守方 5 且扣 2 点血、结算后植物消失、可在植物上落子并拿到归属光环、参数可改可持久化可恢复默认、魔法阵四角完整（贴图内容占 97.3%、离边 3px）且边宽 27px、悬浮四颗坐标互不相同、总攻击数 58.9px/字重 200/纵向 1.22×横向 0.88、碎片最大初速 14.2 |
| bugv9 回归 | `pnpm verify:bugv9` **47 / 47 通过**：12 次对撞的撞击点 NDC 跨度 0.44/0.38 且全部在屏幕内、11 条轨迹中点都偏离直线（0.34~0.90）；植物缩放 2.19 + 三色材质 + 5 颗萤火虫在飘 + 摆幅 0.13 + 叶子网格数随机（9/11/12）+ 归属特征色外覆 + 旋转魔法阵 + 防守方落子时植物立刻消失（动画还没播完）+ 爆风吹歪 0.20 rad；`X X _ X` 出现预判针并把缺口圈出；攻击阶段棋盘 26 种颜色、两方特征色都到达过（色差 ≤6）且结束后回到黑色；太阳光束最长/最短 2.1 倍、22 档长度；4 连 + 1 植物 → 总攻击 5 = 悬浮 5，削弱后立刻变 4 / 变 3 且正好扣 3 点血；播放器展开-切歌-调音量-静音-收回、默认 `let me go.mp3`；返回主菜单浮层消失；回放面板 330px 贴右下、HUD 与结算卡都在、跳步后无残留舞台棋子、逐步播放出现连珠针 + 13 块碎片 + 血量 −3、导出的代码清空存档后仍能播放；27 套音效分 9 个扳机、选择即试听并持久化；结束后 5 颗棋子初速 23 → 13.3、z 从 −1.8 飞到 12.0 后回收；魔法阵颜色 `#3964fe → #d45fb9` 跟着角色变；两个角色各 5 张差分立绘、可同角色、HUD 只剩立绘+血条、技能图标是 17KB 的 PNG data URL、护盾 1 点 + 银色血条、回血 4→5、绽放长出 8 棵植物、连续行动 2 回合、表情 atk → win/lose → hit → 胜负后等 1 秒弹结算 |
| bugv10 回归 | `pnpm verify:bugv10` **27 / 27 通过**：结束动画后植物层网格数 0；技能挑选时我方植物上的棋子不透明度 1 + 带高亮圆环、其它棋子 0.16、敌方植物被压暗且归属层隐藏、真实鼠标悬停后标识变强（自发光 0.85）、多选勾选后 `pickRing` 亮起；4 个角色的技能名 / 消耗 / 冷却全部对上（大胃袋 1/5、杀鲸霸拳 3/10、猫的憩息 1/5、双子星 2/10、精密计算 1/10、恶龙吐息 3/12、小一哥 1/5、毒鸡蛋 3/10）；杀鲸霸拳同一回合连下两颗（第一颗成线时 `phase=playing`、`highlights=0`、无攻击快照；第二颗之后 `awaitingDefense` + 高光 ≥4）；技能消耗后植物与魔法阵真的消失（2 棵 → 1 棵 → 归零，网格数 129 → 73 → 0）；立绘 189×212（≈2.95× 原尺寸）且血条在其上方、等宽（189px）、无 HP 文本；点技能不弹窗（`.modal` 数 0）且在按钮旁出现含原因的 `.skill-bubble`；菜单轮播 2 张卡 + 箭头翻页（random,deepseek → gemini,gtp）+ 「随机」在首位 + 右侧技能详情 + 左右两栏 + 溢出 0 + 6 次随机开局出现 4 种角色；精密计算挡下伤害（血不掉、`mode=immune`、对手回合后到期）；恶龙吐息的火球命中叠加 2 次太阳爆发、15 格横竖烈焰（行 + 列）+ 场景烈焰同步 + 落上去在该格碎裂（棋盘无子 + 碎片 + 换手）；小一哥 `finalAttack = 4 + 1`、悬浮棋子数 = 5、血条 6→1；毒鸡蛋叠在敌方棋子上成线且原棋子留、不能连珠的位置被拒绝并提示；结算面板有「返回主菜单」且点了真回菜单；植物四色（`f2f6fd/8a5a33/f0c247/4f9d5d`）换色率 96%/81%/79%、主干弯曲偏移 ≥0.014、蕨叶叶片内端到枝干 ≤0.0175 且 100% 朝枝外生长 |
| bugv11 回归 | `pnpm verify:bugv11` **14 / 14 通过**（按需求**只跑这一轮**，旧脚本保留但不再执行）：烈焰点燃后引擎 / 界面 / 3D 三层同为新点的 17 格，双方各走 6 步（第 12 个半回合）后三层同时归零；技能框在释放后出现 `is-flash` + `.skill-slot__flash`（`skillSlotPulse` / `skillSlotSweep`）、对手槽位不受影响、2.6 秒后自动收掉；点技能冒气泡 → 点棋盘空白关闭、点气泡内部不关、点画面其它位置关闭；三种植物的部位配色 = `枝干 #8a5a33 / 叶片 #4f9d5d / 花心 #f0c247 / 花瓣 #f2f6fd`（四色全部用到、全不透明、每株 ≥2 色）；双子星释放后 `twinStar` 亮起 → 两连（基础 2）直接进入攻击阶段 → 防守方 5 连反击也 `mode=immune`、伤害 0、血量不动 → 窗口自动关闭；恶龙吐息开局 `ready / remaining 0 / cost 3 / costNow 0 / freeNow`，0 棵植物即可释放并直接进入选目标阶段，之后 `costNow 3` + 冷却 12；攻击阶段攻击方 `data-expression=atk` 且整段防守动画的采样序列里**没有**"我方 idle + 对方 atk"，对撞打平后回到 `idle/idle`、双方血量不变 |
| 联机后端 | `back/` 的 `pnpm typecheck` / `pnpm test`（**50 / 50**，含"入队即配对不再补发 queued""重复身份踢旧连接""刷新页面不作废对局且新连接能收到广播""技能联机裁决 + 指纹一致 + 烈焰回放""恶龙吐息首次免费"）/ `pnpm build` / `pnpm smoke` 全部通过 |
| 联机端到端 | `pnpm verify:online` **11 / 11 通过**：两个独立浏览器上下文 + 真实后端，跑通 在线匹配（座位 0/1、同一 matchId）→ 服务端骰子两端一致 → 39 步打完整局且**两端棋盘与血量逐字节一致**（`seq` 同步、无漂移）→ 双端都写入本地回放 → `GET /api/replays` 取回 39 步快照 → 匹配码建房/加入成局 → **技能联机**：服务端按座位下发角色、释放技能后两端护盾同为 1 且指纹完全一致 |
| `pnpm sync:core` | 7 个内核文件逐字节一致（含新增的 `characters.ts`） |
| 性能 | 强档 AI（expert，1.2s 预算）移到 worker 后，思考期间主线程保持 100fps 以上 |
| 响应式 | 1440×900 / 900×700 / 420×860 均无横向溢出，棋盘按宽高比自动取景 |

