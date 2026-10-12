# 四子棋（9×9 连珠对战）联机后端

Node 20+ / TypeScript（严格模式）/ ESM 的联机服务端：**Express（REST + 静态托管） + ws（WebSocket 对局） + MongoDB（回放落库）**。

- 权威裁决：服务端与前端跑**同一份纯逻辑引擎**（`src/core`），协议里只传「谁在哪个格子落子」；
- 房间（大厅）：匹配成功 / 建房 / 加入后先进房间，**房主点「开始游戏」才开局**；
  房主可设房间设置（血量上限 / 魔力植物 / 黑夜）、选角色、聊天、转让房主；
  断线只标记离线（可凭房间号回来），**全员退出才销毁房间数据**（bugv34e）；
- 回放：每一步都落一条与前端 `ReplayStep` 同构的快照，`replays._id = matchId`（天然幂等）；
- 部署：`tsc` 编译到 `dist/`，可直接上宝塔（`pm2 start ecosystem.config.cjs`）。

> 前后端唯一的契约是 [`PROTOCOL.md`](./PROTOCOL.md)（协议版本 `2`），本目录的实现逐条对齐它。
>
> 部署形态是**前后端分离**：本目录（`back/`）整体就是后端，前端产物（仓库根 `dist/`）另外放。
> 想一个进程同时托管前端也可以：把前端产物放到 `FRONTEND_DIR`（默认 `../dist`）并保持
> `SERVE_FRONTEND=true` 即可；分离部署时该目录不存在只会打一条警告，不影响联机。

## 0. 部署 / 升级 checklist

在**仓库根**跑一次根目录的 `switch-online.bat`，它会一次性完成：
`pnpm sync:core` → 编译本目录到 `dist/` → 构建前端（内嵌线上后端地址）→ 自检内嵌地址 + 线上协议版本。

然后：

1. 把 **`back/` 里所有文件**复制到服务器后端目录（覆盖 `dist/` / `package.json` /
   `ecosystem.config.cjs`；`node_modules` 无新增依赖时可不动，或服务器上 `pnpm install --prod`）；
2. 把 **`dist/` 里所有文件**复制到前端目录；
3. **重启进程**：`pm2 restart connect4-backend`。
   ⚠️ `dist/` 换了但不重启 = 跑的还是旧代码 —— 这是 `versionMismatch` 最常见的原因；
4. 自查：
   ```bash
   pm2 logs connect4-backend --lines 30
   # 仓库根：ONLINE_SERVER=113.45.13.149:8787 pnpm verify:online-backend
   ```
   它会打印「前端产物内嵌的后端地址」与「真实握手拿到的协议版本」，一眼看出是哪一侧旧了。

> ⚠️ 前端与后端的协议版本**必须同时升级**，否则客户端握手时直接收到
> `error { code: 'versionMismatch', message: '协议版本不一致：服务端 X，客户端 Y' }`。
> 只换前端不重启后端（或反之）都一定会撞上。两份产物由**同一次** `switch-online.bat` 产出最稳。

---

## 1. 目录结构

```
back/
├── package.json            # 依赖与脚本（dev / build / start / typecheck / test / smoke）
├── tsconfig.json           # 编译配置（ESM，src -> dist）
├── tsconfig.typecheck.json # 额外把 tests / scripts 也纳入类型检查
├── pnpm-workspace.yaml     # 让 back/ 成为可独立安装的 pnpm 工作区根（并允许 esbuild 构建脚本）
├── .env.example            # 配置示例（含中文注释）
├── .env                    # 实际配置（已 gitignore）
├── .gitignore
├── ecosystem.config.cjs    # pm2 部署配置（单实例 fork）
├── start.bat / start.sh    # 一键启动（Windows 批处理为纯 ASCII）
├── README.md
├── PROTOCOL.md             # 前后端协议契约
├── src/
│   ├── index.ts            # 启动：建 DB -> 建 HTTP -> 挂 WS -> 优雅退出（导出 startServer 供测试/冒烟复用）
│   ├── config.ts           # env 解析（PORT / MONGODB_* / DB_MODE / CORS / SERVE_FRONTEND / TTL ...）
│   ├── logger.ts           # 极简分级日志（时间戳 + LOG_LEVEL）
│   ├── db.ts               # Repository 接口 + MongoRepository + MemoryRepository + 索引
│   ├── digest.ts           # 局面指纹（转出 src/core/digest.ts，供服务端下发 digest）
│   ├── matching.ts         # 匹配队列 + 6 位匹配码房间（TTL 回收）
│   ├── match.ts            # MatchRoom / MatchManager：服务端权威对局、steps 记录、回放文档
│   ├── http.ts             # REST：/api/health /api/replays /api/replays/:id /api/stats + CORS + 静态托管
│   ├── ws.ts               # WebSocket 网关：握手、队列、房间、落子裁决、sync、resign、leave、心跳
│   ├── protocol.ts         # 所有消息的 TS 类型 + PROTOCOL_VERSION = 1
│   └── core/               # ★ 纯逻辑内核镜像（见下方"内核同步"）
├── tests/
│   ├── match.spec.ts       # 服务端裁决与 steps 记录（不联网）
│   ├── matching.spec.ts    # 匹配队列 / 匹配码 / TTL 回收
│   ├── config.spec.ts      # 配置解析与 Mongo 连接串拼接（含特殊字符编码）
│   └── ws.spec.ts          # 两个真实 ws 客户端：匹配 -> 打到 gameOver -> 回放 REST 校验
└── scripts/
    ├── smoke.ts            # 端到端冒烟（内存模式起真服务，跑完一整局并校验回放）
    └── fix-esm.mjs         # 构建后给 dist 的相对 import 补 .js（见"构建说明"）
```

当前 `pnpm test` 共 **36 个用例**（`vitest run`，全部通过）。

### 内核同步（不要手改 `src/core/`）

`back/src/core/{types,lines,random,engine,digest}.ts` 是仓库根目录 `src/core/` 的**逐字节镜像**，
由根目录脚本 `pnpm sync:core` 覆盖式同步：

```bash
# 在仓库根目录执行
pnpm sync:core          # = node scripts/sync-core.mjs，逐字节复制并打印每个文件的状态
# 等价于： cp -f src/core/*.ts back/src/core/
```

**任何情况下都不要手动修改 `back/src/core/` 里的文件**（会被下次同步覆盖）；要改规则请改 `src/core/`，
再重新同步并跑一遍 `pnpm test` —— 服务端与前端必须保持同一份引擎，否则 `digest` 会漂移。

---

## 2. 协议摘要

完整定义见 [`PROTOCOL.md`](./PROTOCOL.md)。要点：

| 方向 | 消息 |
| --- | --- |
| C → S | `hello`（必须在最前）`queue` `cancelQueue` `createRoom` `joinRoom` `move` `skill` `sync` `resign` `leave` `ping` |
| S → C | `welcome` `queued` `queueCanceled` `roomCreated` `matched` `applied` `state` `gameOver` `opponentLeft` `error` `pong` |

- 传输：WebSocket，路径 **`/ws`**，JSON 文本帧，字段 `t` 表示类型；版本 `PROTOCOL_VERSION = 1`。
- 座位：`seat = 0`（赤/先手方）/ `seat = 1`（青/后手方）。
- 开局：服务端 `new GameEngine({ seed, skills })` **掷一次骰子**，把 `dice = { rolls, first }`
  放进 `matched`，两端必须沿用；`queue` / `createRoom` / `joinRoom` 可带 `character`
  （bugv10 #11），成局后按座位放在 `matched.characters`。
- `move`：校验 `matchId` → `seat === engine.current`（否则 `notYourTurn`）→ 空格（否则 `illegalMove`）→
  调 `engine.commit()` / `engine.defend()`（抛错转 `illegalMove`）→ `seq += 1` → 向房内两人广播 `applied`。
- `skill`：同样的链路，改调 `engine.useSkill(seat, slot, cells, target)`，成功后广播
  `applied(kind: 'skill', slot, cells, target)`（bugv10 #11）。
- 结束：`applied` 里带 `result` → 广播 `gameOver`（带 `replayId`）→ 回放写入 `replays`。
- `sync` → `state`：`board` / `hp` / `current` / `phase` / `firstPlayer` / `highlightOwner` /
  `highlights: [cell, weight][]` / `attack` / `digest` / `result` / `seq` / `seat` /
  `characters` / `shield` / `bonusActions` / `actionsTaken` / `skillReadyAt` / `lastPlacedBy` /
  `turnNo` / `immuneUntil` / `flames` / `overlay`（后十项为 bugv10 #11 技能状态）。
- 心跳：服务端每 **30s** 发一次 WS ping，两个周期（**60s**）没有 pong 就断开。
- 断线：对局中一方断开 → 另一方收 `opponentLeft`，房间作废，**5 分钟**后回收；队列 / 未开局房间里直接移除。

### REST

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | `{ ok, db: 'mongo'\|'memory', uptime, matches, version }` |
| GET | `/api/replays?playerId=&limit=20` | 该玩家参与过的对局，按 `createdAt` 倒序（默认 20，上限 50）；`{ ok, count, limit, playerId, items }` |
| GET | `/api/replays/:id` | 单局回放 `{ ok, replay }`，不存在返回 404 |
| GET | `/api/stats` | 简易统计 `{ ok, db, uptime, version, matches, replays }` |

不带 `playerId` 时返回最近的对局，便于调试。回放文档结构见 `PROTOCOL.md` 第 5 节；
`steps[].board` 是**该步结算完毕后**的 81 格棋盘快照，可直接喂给前端 `ReplayPanel` 播放。

---

## 3. 配置（`.env`）

复制 `.env.example` 为 `.env` 后按需修改；**`.env` 已被 `.gitignore` 忽略**。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | HTTP / WebSocket 端口 |
| `MONGODB_URI` | `mongodb://190.92.233.254:27017` | Mongo 地址（不含账号） |
| `MONGODB_USER` | `miriru` | Mongo 账号；与密码都为空时直接使用 `MONGODB_URI` |
| `MONGODB_PASSWORD` | `lin162636` | Mongo 密码（含特殊字符会自动 URL 编码） |
| `MONGODB_AUTH_SOURCE` | `admin` | 鉴权库，宝塔常见为 `admin` |
| `DB_NAME` | `miriru` | 数据库名（回放集合 `replays`） |
| `DB_MODE` | `mongo` | `mongo`：连不上重试 3 次后退出；`memory`：纯内存（重启丢数据，仅调试） |
| `SERVE_FRONTEND` | `true` | 是否由本服务托管前端构建产物 |
| `FRONTEND_DIR` | `../dist` | 前端产物目录（相对 `back/`），即仓库根的 vite 构建产物 |
| `CORS_ORIGINS` | `*` | 允许的跨域来源，逗号分隔；`*` 为不限制 |
| `MATCH_TTL_MS` | `1800000` | 对局（含已结束）在内存中的保留时长，30 分钟 |
| `ROOM_TTL_MS` | `600000` | 匹配码房间有效期，10 分钟 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `MONGODB_URI` + 账号 | — | `MONGODB_USER`/`MONGODB_PASSWORD` 非空时拼成 `mongodb://user:pass@host:port/db?authSource=admin` |

### `SERVE_FRONTEND=true` 是什么用法

前端 `vite build` 产出的 `dist/index.html + assets/*` 会被本服务直接托管：

- `GET /`、`/assets/xxx.js` 等由 Express 静态中间件返回；
- 非 `/api`、非 `/ws` 的 GET 请求（如 `/room/ABC123`）回退到 `index.html`（单页应用路由）；
- 前端连 WebSocket 时直接连**同源的** `ws(s)://<host>/ws`，**不需要再开端口、也不会有跨域问题**；
- 找不到 `FRONTEND_DIR/index.html` 时只会打一条 warn 并跳过静态托管，`/api` 与 `/ws` 照常工作。

也就是说，部署有两种形态，按需选：

| 形态 | 怎么放 | 前端连哪台 |
| --- | --- | --- |
| **前后端分离**（本项目当前采用） | `back/` 与前端产物**分别**放；`SERVE_FRONTEND` 实际用不上（缺目录只打一条 warn） | 前端自己内嵌的地址（由 `switch-*.bat` 决定） |
| 单进程托管 | 前端 `dist/` 放到 `back/` 的 `../dist`（或改 `FRONTEND_DIR`），`SERVE_FRONTEND=true` | 同源 `ws(s)://<host>/ws`，不用额外开端口、无跨域 |

---

## 4. 本地启动

环境：Node 20+（本仓库开发用 v22.19.0）、pnpm（本机为全局安装的 `pnpm`）。

```bash
cd back
pnpm install          # 安装依赖（express / ws / mongodb / dotenv + 开发依赖）
cp .env.example .env  # 首次：生成配置（Windows 可用 copy .env.example .env）
pnpm dev              # tsx watch src/index.ts，改代码自动重启
```

生产 / 验证用：

```bash
pnpm typecheck        # tsc 严格模式类型检查（含 src + tests + scripts）
pnpm test             # vitest run（内存模式起真服务跑 WebSocket 端到端）
pnpm build            # tsc -> dist/（并补 ESM 扩展名）
pnpm start            # node dist/index.js
pnpm smoke            # 端到端冒烟：内存模式打完一整局并校验回放 REST
```

### 内存模式自测（不需要 Mongo）

```bash
# Windows PowerShell
$env:DB_MODE='memory'; pnpm dev
# Linux / macOS
DB_MODE=memory pnpm dev
```

内存模式下服务照常提供匹配、对局、回放接口（回放只在进程内存里），启动时会打醒目警告，且每 60s 再提醒一次。

### 构建说明（为什么有 `scripts/fix-esm.mjs`）

`src/core/*` 是从前端逐字节复制来的，里面的相对导入写作 `from './lines'`（前端用 bundler 解析，无扩展名没问题），
但 Node 的 ESM 解析器**要求显式扩展名**。因此 `pnpm build` = `tsc` + `fix-esm.mjs`（只给确实能落到真实 `.js`
文件的相对说明符补 `.js`）。**不要删掉这一步**，否则 `node dist/index.js` 会因为 `ERR_MODULE_NOT_FOUND` 起不来。

---

## 5. 宝塔部署（Linux + pm2 + Nginx）

### 5.1 上传并安装

1. 把 `back/` 整个目录传到服务器，例如 `/www/wwwroot/connect4/back`；
2. 前端在本地执行 `pnpm build`，把仓库根的 `dist/` 一起传上去，保持 `back/` 与 `dist/` 同级
   （即 `/www/wwwroot/connect4/dist`，对应默认的 `FRONTEND_DIR=../dist`）；
3. 服务器上：

```bash
cd /www/wwwroot/connect4/back
cp .env.example .env      # 按需修改端口 / Mongo / 是否托管前端
pnpm install --prod       # 只装运行依赖；要构建就先装全量
pnpm build                # 生成 dist/（也可以本地构建后把 dist/ 一起上传，服务器免装 devDependencies）
pnpm start                # 先手工跑一次，确认能起来（Ctrl+C 退出）
```

### 5.2 用 pm2 常驻

```bash
cd /www/wwwroot/connect4/back
pm2 start ecosystem.config.cjs
pm2 save                  # 保存进程列表
pm2 startup               # 按提示执行输出的命令，开机自启
pm2 logs connect4-backend # 看日志
pm2 restart connect4-backend
```

> `ecosystem.config.cjs` 固定**单实例 fork 模式**：对局状态在进程内存里，多实例会导致两名玩家被分到不同进程而匹配不上。
> 日志写在 `back/logs/{out,error}.log`。

### 5.3 放行端口

- 宝塔面板 →「安全」放行 `8787`（或你在 `.env` 里改的端口）；云服务器还要在**厂商安全组**放行同一端口；
- 如果只用 Nginx 反代（推荐），则**只需要放行 80/443**，`8787` 只监听 127.0.0.1 即可（见下一节）。

### 5.4 Nginx 反向代理（含 WebSocket 升级）

宝塔「网站 → 设置 → 配置文件」里加一个站点，反代到 `127.0.0.1:8787`：

```nginx
server {
    listen 80;
    server_name game.example.com;

    # 前端静态资源也可以交给 Nginx（此时可把 SERVE_FRONTEND 设为 false）
    # root /www/wwwroot/connect4/dist;
    # index index.html;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        # ★ WebSocket 升级必须的三行，漏了就会 502 / 一直 pending
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;

        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 长连接（对局可能很久没有数据，别让代理提前掐断）
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }

    location /ws {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

宝塔面板的「反向代理」图形界面里，记得打开 **「发送 WebSocket 支持」** 开关（等价于上面两行 `Upgrade/Connection`）。

HTTPS 站点把 `proxy_pass` 保持 `http://127.0.0.1:8787` 即可，前端用 `wss://game.example.com/ws` 自动跟着走。

### 5.5 宝塔 MongoDB 配置

1. **建库**：宝塔面板 →「数据库」→「添加数据库」：
   - 数据库名：`miriru`
   - 用户名：`miriru`（宝塔默认与数据库同名）
   - 密码：`lin162636`（建议改成更强密码，并同步修改 `back/.env` 的 `MONGODB_PASSWORD`）
   - 权限：`本地服务器`（本机访问）或按需指定 IP
   - **认证库**：宝塔/官方 MongoDB 默认把用户建在 `admin` 库，所以 `back/.env` 里保持 `MONGODB_AUTH_SOURCE=admin`。
2. **放行端口（务必收紧）**：MongoDB 端口 `27017` **不要对全网开放**。仅在宝塔「安全」+ 云厂商安全组里
   **只对可信 IP**（你的开发机出口 IP、后端服务器内网 IP）放行；如果后端与 Mongo 在同一台机器，
   直接把 `MONGODB_URI` 写成 `mongodb://127.0.0.1:27017` 并**完全不要放行 27017**，这是最安全的做法。
3. **自检连通性**（在服务器上执行）：

```bash
# 本机直连（同机部署）
mongosh "mongodb://miriru:lin162636@127.0.0.1:27017/miriru?authSource=admin" --eval "db.runCommand({ping:1})"

# 远程直连（在能连到 190.92.233.254 的机器上执行）
mongosh "mongodb://miriru:lin162636@190.92.233.254:27017/miriru?authSource=admin" --eval "db.replays.countDocuments()"

# 只测 TCP 通不通（不依赖 mongosh）
nc -vz 190.92.233.254 27017        # 或 telnet 190.92.233.254 27017
```

登录进 `mongosh` 后可以确认集合与索引：

```javascript
use miriru
db.replays.getIndexes()      // 应能看到 playerIds_createdAt 与 createdAt 两个索引
db.replays.findOne()         // 打完一局后应能查到回放文档
```

4. 启动后端时日志里会打印（密码已打码）实际使用的连接串，例如
   `mongodb://miriru:****@190.92.233.254:27017/miriru?authSource=admin`，
   连不上会重试 3 次并打印中文排查清单（IP / 端口 / 白名单 / 认证库）。

### 5.6 验证部署

```bash
curl http://127.0.0.1:8787/api/health
# {"ok":true,"db":"mongo","uptime":3,"matches":0,"version":1}
curl http://127.0.0.1:8787/api/stats
```

浏览器打开站点，两个窗口（或用两台设备）分别进入联机匹配即可开局。

---

## 6. 常见问题

**Q1：启动就退出，日志显示 `MongoDB 连续 3 次连接失败`**
按日志打印的清单排查：① 云安全组 / 宝塔防火墙是否放行 `27017` 且来源 IP 正确；
② `mongod.conf` 的 `net.bindIp` 是否为 `0.0.0.0`（改完要重启 mongod）；
③ 账号密码 / 认证库是否匹配（宝塔通常是 `MONGODB_AUTH_SOURCE=admin`）；
④ 用上面的 `mongosh` 命令直连验证。只想先跑通联机就设 `DB_MODE=memory`。

**Q2：WebSocket 连不上 / Nginx 502 / 一直 pending**
99% 是反代没转发升级头。确认 Nginx 配置里有 `proxy_http_version 1.1;`、
`proxy_set_header Upgrade $http_upgrade;`、`proxy_set_header Connection "upgrade";`
（宝塔反代界面勾选「发送 WebSocket 支持」）。另外确认前端连的是 `/ws` 路径，且没有被其它
`location` 抢先匹配；后端直连自测可用 `npx wscat -c ws://127.0.0.1:8787/ws`。

**Q3：浏览器控制台报跨域（CORS）**
REST 的 CORS 由 `CORS_ORIGINS` 控制：同源部署（`SERVE_FRONTEND=true`，前端和 API 同一个域名）时不会有跨域问题；
前后端分开部署时把它设成前端域名，例如 `CORS_ORIGINS=https://game.example.com,http://localhost:5173`，
多个用英文逗号分隔；`*` 表示不限制（会回 `Access-Control-Allow-Origin: *`）。
WebSocket **不受 CORS 限制**，但要注意 `ws://` 与 `wss://` 不能混用（HTTPS 页面必须连 `wss://`）。

**Q4：`digest` 不一致 / 客户端提示局面漂移**
两端必须跑同一份 `src/core`。若手改过 `back/src/core/`，请用根目录 `pnpm sync:core` 重新同步后再 `pnpm test`。

**Q5：`node dist/index.js` 报 `ERR_MODULE_NOT_FOUND: Cannot find module './xxx'`**
`pnpm build` 的最后一步 `scripts/fix-esm.mjs` 没跑（它负责给 `dist` 的相对导入补 `.js`）。
重新执行 `pnpm build`，不要只跑 `tsc`。

---

## 7. 实现补充说明（协议之外的口径）

- **魔力植物（bugv8 #4）**：规则全部在 `back/src/core`（与前端逐字节一致），
  服务端权威裁决天然包含它。两点要注意：
  1. `state` 会带上 `magic` / `magicGrowths` / `magicCooldown` / `magicLineSeen`，
     保证重连后的客户端后续生长节奏与服务端一致；
  2. `applied` **不带**生长结果（两端各自按确定性算法算），因此**必须**
     用 `pnpm sync:core` 保持两端同版本，并且联机固定使用默认配置。
  3. 回放 `steps[].magic` 会一起落库，老回放（没有该字段）也能正常读。
- **角色技能（bugv10 #11 起已联机）**：`queue` / `createRoom` / `joinRoom` 可以带
  `character`（`'deepseek' | 'gemini' | 'gtp' | 'glm'`，非法 / 缺省按座位退回
  `DEFAULT_CHARACTERS`），服务端据此用 `skillsOfCharacter()` 构造双方技能表，
  并在 `matched.characters` / `state.characters` 里按座位下发。
  技能走 `{ t: 'skill', matchId, slot, cells, target? }`，由服务端的
  `engine.useSkill()` 权威裁决（不是你的回合 → `notYourTurn`，其余抛错 → `illegalMove`，
  失败不广播），成功后双方都收到 `kind: 'skill'` 的 `applied`。
  技能状态（`shield` / `bonusActions` / `actionsTaken` / `skillReadyAt` / `turnNo` /
  `immuneUntil` / `flames` / `overlay`）已全部纳入 `state` 与 `digest`，
  所以断线重连、回放跳步都必须用 `steps[].extra` 一起恢复，否则两端指纹会对不上。
  详细的字段表见 `PROTOCOL.md` 第 2 / 4 节。
- **`matched` 与 `queued` 的顺序**（bugv7 #1 修正）：`queue` 这一条**可能立即配对成功**，
  此时服务端**不再补发** `queued`，所以客户端看到的顺序只会是 `queued → matched` 或只有 `matched`；
  反过来（`matched` 之后又来一条 `queued`）会让客户端把"对局中"覆盖成"排队中"，
  那一方就再也点不动棋盘。客户端也做了保险：手上有 `matchId` 时大厅状态不许覆盖对局状态。
- **同一 `playerId` 重复登录**（bugv7 #1 修正）：新连接接管，旧连接收到 `error: duplicateLogin`
  并被关闭（4001）；正在进行的对局**不作废**，对手不会收到 `opponentLeft`，
  服务端会把该局的广播目标**重绑到新连接**（`MatchRoom.rebind`）—— 因此刷新页面之后
  `sync` 能拿回局面，对手后续的每一步也照样收得到。
  浏览器多标签页共用 localStorage 里的 `playerId`，想同时开两个玩家请用无痕窗口。
- **同一 `account` 重复登录 = 顶号**（bugv34l）：新连接登录成功（或凭 `hello.token`
  恢复登录态）后，服务端把**其他 `account` 相同**的连接全部顶掉 —— 发
  `error: sessionExpired` 并关闭（4002）。被顶的一方会清掉本地登录态、回到登录面板。
  另外 `hello` 带了服务端认不出来的令牌时也回 `sessionExpired`（不断开），
  提醒客户端"登录已失效"。详见 `PROTOCOL.md` 第 3.3 节。
- **重复 `queue`**：幂等，会再回一条 `queued`（位置不变），并顺带把队列里的连接换成最新一条（便于重连）。
- **`queue` / `createRoom` / `joinRoom` 时已在别的对局中**：会先把旧对局按"主动离开"处理
  （对手收到 `opponentLeft`），再执行新的匹配请求。
- **`joinRoom` 的房间生命周期**：成局后房间保留到 TTL 过期（`guest` 已占位），
  因此第三个人拿同一个码进来会收到 `roomFull`；过期后是 `roomNotFound`。用自己建的码加入自己会得到 `roomFull`。
- **`resign`**：立即结束对局，双方收到 `gameOver`，`result = { winner: 对手, reason: 'hp', hp: [当前血量] }`，
  该局同样写入回放（`reason` 字段沿用协议里的 `hp`）。
- **`leave`**：带 `matchId` 时离开该对局（对手收 `opponentLeft`，房间作废、不写回放）；
  不带 `matchId` 时同时退出队列并离开当前对局 / 房间。
- **对局作废**：作废房间在内存里保留 **5 分钟**（`OPPONENT_LEFT` 后仍可用 `sync` 查看终局局面，
  但不再接受落子），之后被定时器回收。
- **回放落库时机**：`gameOver` 广播前后都会生成 `ReplayDoc`，写入用 `replaceOne(..., { upsert: true })`，
  `_id = matchId`，重复写不会产生重复记录。
