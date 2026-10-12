# 联机协议（bugv6 #8；bugv34e 起含房间/大厅；bugv34i 起需要登录）

前后端共用的唯一契约。**服务端与客户端跑同一份纯逻辑引擎**（`src/core` → `back/src/core`），
因此协议里只传「谁在哪个格子落子」，事件序列与动画由两端各自本地生成。

- 传输：WebSocket，路径 **`/ws`**（同源部署时前端直接连 `ws(s)://<host>/ws`）。
- 编码：JSON 文本帧；字段 `t` 表示消息类型。
- 版本：`PROTOCOL_VERSION = 3`。
  v2（bugv34e）= 引入**房间/大厅**；v3（bugv34i）= **联机需要登录**，
  且开局改为**双方都点「准备」**（`roomReady` 取代 `startGame`）。握手时校验，不一致直接 `error`。
- 时间：毫秒时间戳；服务端每 30s 发一次 WS ping 保活。
- 座位：`seat` = 0（先手方 / 赤）/ 1（后手方 / 青），与前端 `PlayerIndex` 一致。

## 0. 客户端身份与登录（bugv34i）

客户端首次连接前把自己生成的 `playerId`（uuid v4，存 localStorage）放进 `hello`。

**联机需要登录**：`hello` 之后不带有效令牌就是「未登录」状态，此时
`queue` / `createRoom` / `joinRoom` / `rejoinRoom` 一律回 `error: notLoggedIn`。

- `login { username, password }` → 成功回 `loggedIn`；账号不存在回 `userNotFound`
  （前端据此切到「注册」）；密码错回 `wrongPassword`。
- `register { username, password, nickname? }` → 成功回 `loggedIn`；
  账号已存在回 `usernameTaken`。账号只允许 `[A-Za-z0-9_]`、3-20 位并**归一化为小写**；
  昵称可空（服务端按 `playerId` 兜底）。
- 登录成功签发**长期令牌**（`loggedIn.token`）：客户端存进 localStorage，
  下次 `hello` 带上它即可自动恢复登录态 ——「不退出登录就一直保持登录」。
- `logout` → 作废令牌并回 `loggedOut`。
- 口令用 `scrypt` + 每用户随机盐散列存库（`users` 集合），**永不存明文**。
- **客户端交互（bugv34k）**：界面**不在「登录 / 注册」之间切换** ——
  填账号 + 密码点「登录」，服务端回 `userNotFound` 时前端**自动进入注册流程**
  （多出一个昵称输入框），再点一次即以这组账号密码注册并登录。
  也就是说 `userNotFound` 是**正常分支**，不该被当成错误提示。

## 1. 客户端 → 服务端

| `t` | 字段 | 说明 |
| --- | --- | --- |
| `hello` | `playerId`, `name`, `version`, `token?` | 必须在其它消息之前发送；带 `token` 会**自动恢复登录态** |
| `login` | `username`, `password` | 登录（bugv34i；账号不存在 → `userNotFound`） |
| `register` | `username`, `password`, `nickname?` | 注册（bugv34i；这里的昵称取代了旧的「联机昵称」） |
| `logout` | — | 退出登录并作废令牌 |
| `queue` | `name`, `character?` | 进入在线匹配队列（**需登录**） |
| `cancelQueue` | — | 退出队列 |
| `createRoom` | `name`, `character?` | 建房（自己是房主），服务端回 `roomState`（**需登录**） |
| `joinRoom` | `code`, `name`, `character?` | 用房间号加入（已在房里则等同"回到房间"） |
| `rejoinRoom` | `code`, `name`, `character?` | 断线 / 刷新后凭房间号回到房间（bugv34e） |
| `roomSettings` | `settings` | 改房间设置（**仅房主**、且房间不在对局中） |
| `roomCharacter` | `character` | 在房间里改自己的角色 |
| `chat` | `text` | 在房间里发一条聊天（≤120 字） |
| `transferHost` | `to` | 转让房主（**仅房主**） |
| `roomReady` | `ready` | 点「准备」/ 取消准备（bugv34i：**双方都准备 → 服务端自动开局**） |
| `move` | `matchId`, `cell` | 请求落子（普通落子与抵消落子共用，服务端按当前阶段判定） |
| `skill` | `matchId`, `slot`, `cells`, `target?` | 请求使用角色技能（bugv10 #11，见第 4 节） |
| `sync` | `matchId` | 请求完整局面（漂移自愈 / 断线重连） |
| `resign` | `matchId` | 认输 |
| `leave` | `matchId?` | 离开房间 / 队列 |
| `ping` | — | 应用层心跳，回 `pong` |

`cell` 为 0..80 的棋盘下标（`row * 9 + col`）。

- `character`（bugv10 #11）：`'deepseek' | 'gemini' | 'gtp' | 'glm'`，由 `src/core/characters.ts`
  的 `CHARACTER_SPECS` 定义，服务端用 `isCharacterId()` 校验。非法 / 缺省时按**座位**退回
  默认角色（座位 0 → `DEFAULT_CHARACTERS[0]`，座位 1 → `DEFAULT_CHARACTERS[1]`），
  不会因此报错。角色决定这一局双方的技能表（`skillsOfCharacter()`）。
- `cells`（`skill`）：要消耗的魔力植物格子，必须正好是该技能 `cost` 格、且都被自己的棋子占着。
- `target`（`skill`）：需要点选目标格的技能（gtp「恶龙吐息」）的棋盘下标；
  其它技能省略或传 `null`。

## 2. 服务端 → 客户端

| `t` | 字段 | 说明 |
| --- | --- | --- |
| `welcome` | `playerId`, `serverTime`, `version`, `authenticated`, `username?`, `nickname?` | 握手成功；`authenticated=true` 表示已用令牌自动登录 |
| `loggedIn` | `playerId`, `username`, `nickname`, `token`, `serverTime` | 登录 / 注册成功 |
| `loggedOut` | — | 已退出登录 |
| `queued` | `position` | 已进入匹配队列（position 从 1 开始） |
| `queueCanceled` | — | 已退出队列 |
| `roomState` | `code`, `you`, `members`, `settings`, `phase`, `matchId`, `chat`, `canStart` | 房间全量状态（任何变化都广播给房内**在线**成员）；`members[]` 含 `ready` |
| `roomChat` | `entry` | 收到一条新聊天（广播给房内所有在线成员，含发送者自己） |
| `roomClosed` | `reason` | 房间被销毁（自己退出了 / 房间没人了） |
| `matched` | `matchId`, `seat`, `code`, `opponent`, `dice`, `characters`, `settings` | **双方都点「准备」**后下发：座位、对手昵称、骰子、双方角色、本局房间设置 |
| `applied` | `matchId`, `seq`, `seat`, `kind`, `cell`, `hp`, `current`, `phase`, `digest`, `result`（技能步另带 `slot`, `cells`, `target`） | 一步生效（**双方都会收到**，含自己那一步） |
| `state` | `matchId`, `seq`, `seat`, `board`, `hp`, `current`, `phase`, `firstPlayer`, `highlightOwner`, `highlights`, `attack`, `digest`, `result`, `magic`, `magicGrowths`, `magicCooldown`, `magicLineSeen`, `characters`, `shield`, `bonusActions`, `actionsTaken`, `skillReadyAt`, `lastPlacedBy`, `turnNo`, `immuneUntil`, `flames`, `overlay`, `powerBonus`, `sabotage`, `twinStar`, `skillCasts`, `powerUntil`, `sabotageBonus`, `bloomCheaperNext`, `tempArmor`, `tempArmorUntil`, `strikeBonus`, `strikeUntil`, `seedGrow`, `noPlantBonus`, `flameOwner` | 完整局面（`sync` 或重连时） |
| `gameOver` | `matchId`, `result`, `replayId` | 对局结束，`replayId` 可用于拉取回放 |
| `opponentLeft` | `matchId`, `reason` | 对手掉线 / 主动离开（对局作废） |
| `error` | `code`, `message`, `reqType?` | 出错 |
| `pong` | `time` | 心跳应答 |

- `dice = { rolls: [a, b], first: 0 | 1 }`：服务端掷一次，两端**必须沿用**这个结果。
- `settings = { hpLimit, magic, night }`（bugv34e）：**本局的房间设置**，
  由房主在房间里决定。客户端必须拿它去建自己的镜像引擎（血量上限 / 魔力植物 / 黑夜），
  否则第一步指纹就会漂移。
- `characters = [CharacterId, CharacterId]`：按**座位**索引（0 = 先手方）的双方角色，
  `matched` 与 `state` 都带（bugv10 #11）。
- `kind` = `'place'`（普通落子）| `'defend'`（攻击阶段防守落子）| `'skill'`（角色技能，bugv10 #11）。
  `'skill'` 时额外带 `slot`（技能槽位）、`cells`（消耗的魔力植物格子）、
  `target`（目标格，不需要目标的技能为 `null`）；此时 `cell = target ?? -1`。
- `phase` 取值与 `src/core/types.ts` 的 `MatchPhase` 完全一致
  （`playing` / `awaitingDefense` / `gameOver`）。
- `result = { winner: 0 | 1 | null, reason: 'hp' | 'boardFull', hp: [a, b] }`，未结束时为 `null`。
- `highlights` 为 `[cell, weight][]`，`attack` 为 `AttackSnapshot`
  （含 `attackerPlants` / `defenderPlants` / `stolenPlants`）。
- `digest` 由 `src/core/digest.ts` 的 `stateDigest()` 计算，两端必须一致。
- **魔力植物（bugv8 #4）**：`state` 会带上 `magic: [{cell, kind, owner}]` 与
  `magicGrowths / magicCooldown / magicLineSeen`。`applied` **不带**生长结果 ——
  长在哪几格、长成哪一种由两端各自按同一份确定性算法（局面文本 + 生长序号 派生 PRNG）
  算出来，指纹负责兜底；所以两端必须跑**同一份** `src/core`，且联机固定用默认配置。
  重连时 `magicCooldown` 也一定要恢复，否则之后的生长节奏会和服务端错开。
- **角色技能（bugv10 #11）**：`state` 会带上技能相关的全部状态，
  并按座位给出 `characters`：

  | 字段 | 说明 |
  | --- | --- |
  | `shield` | `[a, b]` 护盾，先于血量承伤（bugv9 #13） |
  | `bonusActions` | `[a, b]` 剩余"连续行动"次数（杀鲸霸拳） |
  | `actionsTaken` | `[a, b]` 各方已行动次数（技能冷却基准） |
  | `skillReadyAt` | `[[…], […]]` 各技能"可以再次使用"的行动次数门槛 |
  | `lastPlacedBy` | `[a \| null, b \| null]` 各方最近一颗棋子的位置（双子星围绕它生长） |
  | `turnNo` | 回合序号（每次换手 +1） |
  | `immuneUntil` | `[a, b]` 无敌持续到第几回合（精密计算） |
  | `flames` | `[cell, 还能烧几个**半回合**][]` 烈焰（恶龙吐息；每次换手 -1，12 = 双方各走 6 步） |
  | `overlay` | `[cell, 叠子的一方][]` 叠在敌方棋子上的额外棋子（毒鸡蛋） |
  | `powerBonus` | `[a, b]` 本回合伤害加成（小一哥；不参与指纹） |
  | `sabotage` | `[a, b]` 本回合是否可下在敌方棋子上（毒鸡蛋；不参与指纹） |
  | `twinStar` | `[a, b]` 「双子星」的爆发窗口：本回合两连即可攻击 + 免疫反击（bugv11 #5，**参与指纹**） |
  | `skillCasts` | `[[…], […]]` 各技能已经释放过几次（bugv11 #6：`freeFirst` 的技能只有首次免费，**参与指纹**） |
  | `powerUntil` | `[a, b]` 「小一哥」增伤持续到第几回合（bugv27 #4，**参与指纹**） |
  | `sabotageBonus` | `[a, b]` 本回合毒鸡蛋的额外伤害（**参与指纹**） |
  | `bloomCheaperNext` | `[a, b]` 下次「双子星」是否消耗 -1（**参与指纹**） |
  | `tempArmor` / `tempArmorUntil` | 临时护甲值与到期回合（精密计算，**参与指纹**） |
  | `strikeBonus` / `strikeUntil` | 「力大砖飞」的额外攻击值与到期回合（**参与指纹**） |
  | `seedGrow` | `[a, b]` 「布局」窗口（**参与指纹**） |
  | `noPlantBonus` | `[a, b]` 低消耗档「杀鲸霸拳」：本回合本方植物不加伤（**参与指纹**） |
  | `flameOwner` | `[cell, 主人][]` 烈焰归属（恶龙吐息走火判定，**参与指纹**） |

  这些字段全部由服务端的 `digestOfEngine()` 纳入指纹（`powerBonus` / `sabotage` 除外，
  与 `core/digest.ts` 的 `DigestInput` 一致），所以重连必须把上面的字段**全部**恢复，
  否则两端指纹会永远对不上、无限 `sync`。

  > ⚠️ bugv27 #4 的教训：`digestOfEngine()` 与前端 `localDigest()` **各写了一遍字段清单**。
  > 只要是角色技能引入的新状态（上面那一批），服务端漏传一项就会让同一局面两端算出
  > **不同指纹** ⇒ 客户端每一步都判"漂移"、反复 `sync`。现在由
  > `back/tests/digest-parity.spec.ts` 做契约测试守着（照抄客户端的字段清单比对），
  > 任一侧新增字段而另一侧没跟上就会变红。

### `applied` 的客户端处理

1. 校验 `matchId` 与本地一致、`seq === 本地 seq + 1`、`seat === 本地 engine.current`（防守时是防守方）。
2. 按 `kind` 调 `engine.commit(cell)` / `engine.defend(cell)` / `engine.useSkill(seat, slot, cells, target)`，
   把返回的事件交给 `SceneController.playEvents()` 播放。
3. 比对 `stateDigest(engine)` 与消息里的 `digest`；不一致就发 `sync` 用 `state` 重建。

## 3. 房间（大厅）（bugv34e）

联机流程是「**先登录 → 进房间 → 双方都准备才开局**」：

```
queue(在线匹配) / createRoom(建房) / joinRoom(加入)  →  进入房间（roomState, phase='lobby'）
   ├─ 所有人：roomCharacter 选角色、chat 聊天、transferHost 转让房主（房主）
   ├─ 房主：roomSettings 改设置
   └─ 所有人：roomReady{ ready: true }
        └─ 双方都 ready → 服务端**自动开局** → 双方收到 matched + roomState(playing)
对局结束（gameOver / opponentLeft）  →  回到房间（phase='lobby'，比分累计，ready 清空）
```

登录接在上面之前：

```
login / register（账号 + 密码；注册时多填昵称） → loggedIn{ token }（存本地，下次 hello 自动登录）
```

- **在线匹配**：`queue` 后进入先进先出队列，凑够 2 人**不直接开局**，而是把两人放进
  同一个房间（`createWith`），**随机一方成为房主**。
- **房间号**：6 位大写字母数字（去掉易混淆的 `0/O/1/I`）。
- **房间设置**（`settings = { hpLimit, magic, night }`）：只作用于**这一间房**，
  开局时随 `matched.settings` 下发给两端，服务端裁决用的就是它。
  `hpLimit ∈ {8, 12, 16}`；`magic` / `night` 与单机「设置」同口径（服务端用
  `resolveMagicConfig` / `resolveNightConfig` 归一化）。
  「黑夜开局」（`startInNight`）是单机专属，联机固定 `false`。
- **准备（bugv34i）**：`canStart` = 两名成员都在线**且都已准备**；满足即自动开局
  （房间里没有「开始游戏」按钮）。断线会**自动取消准备**；一局结束后所有人的准备状态清空，
  要开下一局得重新准备。
- **玩家只有主动 `leave` 才移出房间**；断线只把成员标记为 `connected: false`（房间保留，
  可凭房间号回来）。房间只要还有成员，就保留**比分与聊天记录**；
  **所有成员都离开后房间数据（比分 / 聊天）完全销毁**。
- 全部成员都离线超过 **10 分钟**的房间会被定时回收（同样销毁数据）。
- 房间**满 2 人**后第三人 `joinRoom` 得到 `roomFull`；对局进行中 `joinRoom` 得到 `roomPlaying`；
  已经是该房间成员再 `joinRoom` 视为"回到房间"（不会 `roomFull`）。
- 对局中一方断开，另一方仍收到 `opponentLeft`（对局作废），但**房间不销毁**，双方会收到
  一份新的 `roomState`（`phase` 回到 `lobby`，对手标记离线）。
- `matched.matchId` 之后所有对局消息都必须带同一个 `matchId`。

### 3.0 断线重连 / 回到房间

`hello` 之后，服务端会按 `playerId` 自动把身份放回它所在的房间并下发 `roomState`：

- `phase='lobby'` → 直接回房间大厅；
- `phase='playing'` → `roomState.matchId` 就是当前对局，客户端用它发 `sync` 接回局面
  （⚠️ 客户端必须**先用 `roomState.settings` 建好镜像引擎**再 `sync`，否则配置不一致会漂移）。

也可以在任何时候用 `rejoinRoom { code }` 主动回到某个房间。

### 3.1 消息顺序（bugv7 #1）

`queue` 这一条消息**可能立即配对成功**，此时 `matched` 在 `enqueue()` 内部就发出去了。
因此服务端**不会**在 `matched` 之后再补一条 `queued`
（只在确实还留在队列里时才回 `queued`），保证客户端看到的顺序永远是
`queued → matched` 或只有 `matched`。客户端也应当把大厅状态视为**不可覆盖对局状态**：
只要手上有 `matchId`，`queued` / `idle` / `room` 都不应该把 `playing` 改回去。

### 3.2 同一身份重复登录（bugv7 #1）

同一个 `playerId` 再连上来（刷新页面、多标签页）时：

1. 新连接**接管**，旧连接收到 `error: duplicateLogin` 并被服务端关闭（4001）；
2. 正在进行的那局**不作废**，旧连接的断开不会给对手发 `opponentLeft`；
3. 服务端把这一局里的**广播目标重绑到新连接**（`MatchRoom.rebind`），
   所以刷新之后 `sync` 拿回局面，对手后续的每一步也照样能收到；
4. 想同时开两个"玩家"，用无痕窗口。

> 若旧连接的断开早于新连接注册（不可能，握手顺序保证），或玩家是**真掉线**，
> 才会走原来的 `opponentLeft` 逻辑。

### 3.3 同一账号重复登录 = 顶号（bugv34l）

上面那条按 `playerId`（同浏览器多标签共用 localStorage）判定；**同一账号在别的设备 /
别的浏览器登录**时 `playerId` 不同，走的是账号级规则：

1. 新连接登录成功（或 `hello.token` 恢复登录态）后，服务端找出**其他 `account` 相同**的连接，
   给它们发 `error: sessionExpired` 并关闭（4002）；
2. 被顶的一方应当**清掉本地登录态**（账号 / 令牌 / localStorage）并回到登录面板，
   再连上来时要重新输入账号密码；
3. `hello` 带了令牌但服务端认不出来（令牌已在别处被换掉 / 已退出登录）时，
   也回一条 `error: sessionExpired`（**不断开**，握手照常完成），客户端同样清掉本地登录态。

> 账号的长期令牌是**单枚**的：每次登录都会签发新的并把旧的作废，所以"仅一枚令牌有效"
> 天然提供了顶号所需的判断依据。

## 4. 服务端裁决

1. 只接受「轮到你的那一方」发来的 `move` / `skill`（`seat === engine.current`），否则 `error: notYourTurn`。
2. 落点必须为空格，否则 `error: illegalMove`。
3. `engine.commit()` / `engine.defend()` / `engine.useSkill()` 抛错一律转成 `error: illegalMove`。
4. 每一步之后把服务端 `digest` 一起下发。
5. 对局结束（`engine.isOver`）时把整局回放写入 MongoDB，并回 `gameOver`。

### 4.1 角色技能联机（bugv10 #11）

技能与落子走**完全相同的裁决链路**，服务端是唯一权威：

1. 客户端发 `{ t: 'skill', matchId, slot, cells, target? }`；
2. 服务端先卡回合（`seat === engine.current`，否则 `error: notYourTurn`；
   `matchId` 不在自己的对局里则 `error: notInMatch`）；
3. 再调 `engine.useSkill(seat, slot, cells, target ?? null)` —— 冷却没好、魔力植物不够 /
   不是自己的、目标格非法等都会抛错，一律回 `error: illegalMove` 且**不广播、不推进 `seq`、不写回放**；
4. 成功则 `seq += 1`，向**双方**广播 `applied`（`kind: 'skill'`，另带 `slot` / `cells` / `target`，
   `cell = target ?? -1`），对局因此结束时再补一条 `gameOver` 并落库回放。

两端各自用同一份 `src/core` 重跑 `engine.useSkill()`，再比对 `digest`；
因此**角色必须两端一致**（`matched.characters` 按座位给出），技能表由
`skillsOfCharacter(characters[seat])` 派生。技能状态（护盾 / 连击 / 冷却 / 无敌 / 烈焰 / 叠子 /
增伤到期 / 临时护甲 / 播种窗口 / 烈焰归属 / 不加伤档）**全部**纳入指纹，
见第 2 节的 `state` 字段表。

> 角色本身不影响规则数值以外的任何东西：相同角色可以两边都选，
> 老客户端不发 `character` 时按座位退回 `DEFAULT_CHARACTERS`。

## 5. 回放（REST）

> **回放挂在账号上（bugv34k）**：回放文档新增 `accounts: string[]`（本局双方的登录账号）。
> `GET /api/replays` 支持 **`?account=<账号>`** 并**优先按它过滤** —— 同一账号换设备 / 换浏览器
> 也看得到自己的对局；不传 `account` 时才退回 `?playerId=`（老数据 / 未登录调用）。
> 两个字段都可在同一条查询里给，此时以 `account` 为准。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | `{ ok, db: 'mongo' \| 'memory', uptime, matches, version }` |
| `GET` | `/api/replays?playerId=&limit=20` | `{ ok, count, limit, playerId, items: Replay[] }`，按 `createdAt` 倒序，默认 20、上限 50 |
| `GET` | `/api/replays/:id` | `{ ok, replay }`；不存在返回 404 |
| `GET` | `/api/stats` | `{ ok, db, uptime, version, matches, replays }` |

客户端只依赖 `items`（`src/app/online.ts` 同时兼容 `replays` 与裸数组，便于替换实现）。

回放文档结构（`replays` 集合）：

```jsonc
{
  "_id": "matchId",              // 与对局一一对应，天然幂等
  "matchId": "…",
  "mode": "online",
  "createdAt": 1730000000000,
  "finishedAt": 1730000600000,
  "durationMs": 600000,
  "players": [
    { "playerId": "…", "name": "赤方", "seat": 0 },
    { "playerId": "…", "name": "青方", "seat": 1 }
  ],
  "playerIds": ["…", "…"],       // 便于建索引查询
  "dice": { "rolls": [5, 2], "first": 0 },
  "characters": ["deepseek", "gtp"],   // bugv10 #11，按座位；老对局可缺省
  "steps": [                     // 与前端 MatchRecord.steps 同构，可直接喂给回放器
    { "player": 0, "cell": 40, "defense": false, "match": false,
      "board": [/* 81 */], "hp": [6, 6],
      "magic": [{ "cell": 12, "kind": "flower", "owner": 0 }],   // bugv8 #4，老回放可缺省
      "extra": {                   // bugv10 #11，每一步都有；老回放可缺省
        "shield": [1, 0], "bonusActions": [0, 0], "actionsTaken": [1, 0],
        "skillReadyAt": [[5, 10], [5, 10]], "turnNo": 1, "immuneUntil": [0, 0],
        "flames": [[40, 5]], "overlay": [[13, 1]], "lastPlacedBy": [40, null],
        // bugv11 #5/#6（老回放可缺省）
        "twinStar": [false, false], "skillCasts": [[0, 1], [0, 0]]
      } },
    { "player": 1, "cell": 41, "defense": false, "match": false,
      "board": [/* 81 */], "hp": [6, 6],
      "skill": { "slot": 1, "cells": [12, 13, 14], "target": 41 }   // 仅技能步
    }
  ],
  "result": { "winner": 0, "reason": "hp", "hp": [3, -1] },
  "playerNames": ["DeepSeek", "GTP"]
}
```

`steps[].board` 是**该步结算完毕后的棋盘快照**，与前端 `ReplayStep` 一致，
所以前端 `ReplayPanel` 可以直接播放服务端回放。

- `steps[].skill` 只出现在技能步上（`{ slot, cells, target }`），
  技能步的 `defense` / `match` 都是 `false`，`cell = target ?? -1`；
  `cells` 在"首次免费"的技能上是**空数组**（bugv11 #6）。
- `steps[].extra` **每一步都有**（bugv10 #11）：护盾 / 连击 / 行动次数 / 技能冷却门槛 /
  回合序号 / 无敌 / 烈焰 / 叠子 / 最近落点 / 待绽放 / 双子星窗口 / 技能释放次数。
  回放跳步时必须用它把这些字段一起恢复，否则从技能步之后开始播放会与真实对局错开。

## 6. 错误码

| code | 含义 |
| --- | --- |
| `badRequest` | 消息结构不合法 |
| `versionMismatch` | 协议版本不一致 |
| `notInMatch` | 不在对局中 / matchId 不匹配 |
| `notYourTurn` | 还没轮到你 |
| `illegalMove` | 落点非法或阶段不符 |
| `roomNotFound` | 房间号不存在或已销毁 |
| `roomFull` | 房间已有两人 |
| `roomPlaying` | 房间正在对局中，此时不能加入 / 改设置（bugv34e） |
| `roomNotReady` | 人数不足或有人不在线，不能开始（bugv34e） |
| `notInRoom` | 你不在任何房间里（bugv34e） |
| `notHost` | 只有房主可以进行该操作（bugv34e） |
| `notLoggedIn` | 未登录就做联机操作（bugv34i） |
| `userNotFound` | 登录时账号不存在（前端据此引导去注册） |
| `wrongPassword` | 登录时密码不正确 |
| `usernameTaken` | 注册时账号已被占用 |
| `badUsername` | 账号格式不合法（3-20 位字母 / 数字 / 下划线） |
| `badPassword` | 密码格式不合法（4-64 位） |
| `alreadyQueued` | 已在队列中 |
| `duplicateLogin` | 同一 playerId 已在新的连接上登录，当前连接被接管（bugv7 #1） |
| `sessionExpired` | 登录已失效：同一**账号**在别处登录（被顶号，连接随后被关闭 4002），或 `hello.token` 已被服务端作废（bugv34l） |
| `serverBusy` | 服务端内部错误 |
