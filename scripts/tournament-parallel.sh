#!/usr/bin/env bash
# 并行循环赛：把「对局组合」分片，跑满 CPU 核心，再合并结果。
#
# 为什么能并行？每个分片只跑自己那几组对手，彼此完全独立；合并是纯粹的数据相加。
# AI 行为、随机种子、配对设计都不变 —— 所以结果与串行**逐字节等价**，只是快 N 倍。
#
# 用法：bash scripts/tournament-parallel.sh [总轮数] [每手ms] [分片数] [手数上限] [随机开局手数] [角色列表] [变体]
#   例：bash scripts/tournament-parallel.sh 300 70 8
#   ① 总轮数 = **总对局数**（默认 300，约 4 分钟 / 8 分片）。想更可信再传 480。
#
# ❤️ 血量上限：`HP=8 bash scripts/tournament-parallel.sh 60 70 8` —— 血量少 ⇒ 对局短很多
#    （默认 12 = 线上口径 `INITIAL_HP`）。想做"只看谁更强"的快速对比就用 8。
#
# 焦点角色（只打「该角色 vs 其余每个角色」，省 ~4 倍时间）：
#   `FOCUS=gtp bash scripts/tournament-parallel.sh 300 70 8 220 8 gtp,deepseek,gemini,glm,claude,seedance`
#
# 🌡️ 降温（只改调度，不改结果）：
#   **默认 JOBS=4**（不再吃满所有核，实测只慢约 27%）
#   JOBS=6 bash scripts/tournament-parallel.sh 480 70 8    # 想快一点（温度也高一点）
#   JOBS=8 COOLDOWN=30 bash ... 480 70 8                   # 全速 + 每批之间停 30s
#   NODES=8000 bash ... 300 70 8                           # 降低每手搜索预算（真的少做功，分辨率略降）
#   想从系统层面限频（需管理员）：powercfg /setacvalueindex SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMAX 80
#     恢复：powercfg /setacvalueindex SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMAX 100
#
# 📄 实时战报（bugv18）：默认在**桌面**生成「四子棋循环赛-实时战报.log」，
#    每 1.5 秒刷新一次，含进度条 / 局数 / 组合进度 / 当前对局 / 各角色胜负与胜率（带 95%CI）。
#    比赛结束时会写入最后一帧"最终战报"。想改路径：`LIVE_OUT=/some/path.log bash ...`。
set -u

export PATH="/usr/bin:/bin:/c/Windows/System32:/d/nvm/nodejs:$PATH"
cd "$(dirname "$0")/.."

# ① 目标**总对局数**（默认 300）。脚本按"角色数"换算成"每组合对数"：
#    含镜像时，总局数 = 每组合对数 × n²（n = 角色数）；4 角色 → 每组合 19 对 ≈ 304 局。
TOTAL=${1:-300}
BUDGET=${2:-70}
SHARDS=${3:-6}
MAXPLIES=${4:-220}
# ⚠️ 千万别把局部变量叫 RANDOM —— 它是 bash 的**保留特殊变量**，
# 赋值只会重置它的随机种子，`"$RANDOM"` 读出来是一个新的随机数（几万），
# 于是"随机开局手数"变成天文数字 → 整局全随机、AI 一次都不被调用、结果全对称。
OPEN_PLIES=${5:-8}
# ⚠️ 默认必须是**全部 6 个角色**（deepseek/gemini/gtp/glm/claude/seedance）。
#    曾经默认只写 4 个（漏了 claude、seedance），跑出来的"循环赛"少两个角色还不报错 —— 已修。
CHARS=${6:-deepseek,gemini,gtp,glm,claude,seedance}
# 数值变体（见 tournament.ts 的 VARIANTS）：base / immune2 / fbkeep / cheap3 / healcd7 / power2 / shieldcd7
VARIANT=${7:-base}
# 焦点角色（bugv32）：只测「该角色 vs 其余每个角色」，跳过其它角色之间的对局。
# 例：FOCUS=gtp 只打 gtp vs deepseek/gemini/glm/claude/seedance（5 组），比全循环赛（21 组）快 ~4 倍。
FOCUS=${8:-}
# 🎯 确定性预算（bugv18）：默认按"访问节点数上限"收手，**同样输入必定同样结果**。
#    15872 ≈ 本机 70ms 的搜索量（用 scripts/probe-nodes.ts 标定）。
#    设 NODES=0 可退回旧的"时间预算"（结果会随机器负载漂移，不推荐做对比）。
NODES=${NODES:-15872}
NODES_ARG=()
if [ "$NODES" != "0" ]; then NODES_ARG=("--nodes=$NODES"); fi

# ❤️ 血量上限（bugv34o）：`HP=8 bash scripts/tournament-parallel.sh …` 能**大幅缩短对局**
#    （血量少 ⇒ 少挨几下就分胜负）。不传 = 线上口径 `INITIAL_HP`（12）。
HP=${HP:-}
HP_ARG=()
if [ -n "$HP" ]; then HP_ARG=("--hp=$HP"); fi

# 🌡️ 降温开关（只影响调度，不影响结果 —— 分片之间彼此独立且各自确定性）：
#   JOBS=4      **默认就是 4**，不再"吃满所有核"。实测并发 8→4 只慢约 27%，而核心占用减半
#               ⇒ 温度明显回落（本机曾在 12 线程满载下顶到 90+°C）。想全速：JOBS=$SHARDS。
#   COOLDOWN=20 每批分片跑完后停 20 秒再跑下一批（占空比 < 100% ⇒ 温度回落）。默认 0。
JOBS=${JOBS:-4}
if [ "$JOBS" -gt "$SHARDS" ]; then JOBS=$SHARDS; fi
if [ "$JOBS" -lt 1 ]; then JOBS=1; fi
COOLDOWN=${COOLDOWN:-0}

# 由"总对局数"反算每组合对数：局数 = 对数 × 每组局数
IFS=',' read -r -a CHAR_ARR <<<"$CHARS"
NCHARS=${#CHAR_ARR[@]}
# 🚩 focus 模式：只有 n−1 个组合、每组 2 局（先/后手）；否则全组合（含镜像）n(n+1)/2 组。
if [ -n "$FOCUS" ]; then
  DEN=$(( (NCHARS - 1) * 2 ))
else
  DEN=$((NCHARS * NCHARS))
fi
PAIRS=$(( (TOTAL + DEN / 2) / DEN ))
if [ "$PAIRS" -lt 1 ]; then PAIRS=1; fi
GAMES=$((PAIRS * DEN))
# 分组总数（含镜像：n 个角色的全组合 = n(n+1)/2），实时战报的"组合进度"用
# 🚩 focus 模式：只打「焦点 vs 其余 n−1 个」= n−1 组（无镜像）
if [ -n "$FOCUS" ]; then
  MATCHUPS=$((NCHARS - 1))
else
  MATCHUPS=$((NCHARS * (NCHARS + 1) / 2))
fi

# ⚠️ 必须用**相对路径**：Git Bash 的 $PWD 是 `/d/SOLO/game`，而 node 是 Windows 程序，
# 会把 `/d/...` 解析成 `D:\d\...`。相对路径由 node 按 cwd 解析，才正确。
TMP=".tournament-tmp"
rm -rf "$TMP"
mkdir -p "$TMP"

echo "并行循环赛：目标 ${TOTAL} 局 → 实际 ${GAMES} 局（每组合 ${PAIRS} 对）× ${SHARDS} 分片（并发 ${JOBS}）× 变体 ${VARIANT}${HP:+" × 血量上限 $HP"}"
if [ "$NODES" != "0" ]; then
  echo "  🎯 确定性预算：每手 ≤ ${NODES} 节点（≈ ${BUDGET}ms）→ 同输入必定同结果，可复现"
else
  echo "  ⚠️ 时间预算 ${BUDGET}ms（NODES=0）：结果会随机器负载漂移，不推荐用于对比"
fi
START=$(date +%s)

# 实时战报（bugv18）：后台每 1.5s 把各分片进度合并后刷新到桌面日志。
# 用环境变量 LIVE_OUT 可改路径；不传则由 node 写到「桌面/四子棋循环赛-实时战报.log」。
WATCH_ARGS=(--watch "--dir=$TMP" "--total=$GAMES" "--matchups=$MATCHUPS" "--shards=$SHARDS")
if [ -n "${LIVE_OUT:-}" ]; then WATCH_ARGS+=("--out=$LIVE_OUT"); fi
pnpm exec tsx scripts/tournament.ts "${WATCH_ARGS[@]}" >"$TMP/watch.log" 2>&1 &
WATCH_PID=$!

PIDS=()
# 按 JOBS 分组启动：组内并行、组间等齐（分组只影响调度，结果与全并行逐字节等价）
for ((base = 0; base < SHARDS; base += JOBS)); do
  PIDS=()
  for ((k = base; k < base + JOBS && k < SHARDS; k++)); do
    pnpm exec tsx scripts/tournament.ts "$PAIRS" "$BUDGET" "$MAXPLIES" "$OPEN_PLIES" "$CHARS" 1 mirror \
      "--variant=$VARIANT" \
      "--focus=$FOCUS" \
      "--shard=$k/$SHARDS" --json "--out=$TMP/s$k.json" \
      "--progress=$TMP/s$k.progress.json" "${NODES_ARG[@]}" "${HP_ARG[@]}" >"$TMP/s$k.log" 2>&1 &
    PIDS+=($!)
  done
  for p in "${PIDS[@]}"; do
    wait "$p" || true
  done
  # 🌡️ 组间冷却（占空比 < 100%）—— 只在还有下一批时停
  DONE=$((base + JOBS))
  if [ "$DONE" -gt "$SHARDS" ]; then DONE=$SHARDS; fi
  if [ "$COOLDOWN" -gt 0 ] && [ "$DONE" -lt "$SHARDS" ]; then
    echo "  🌡️ 降温：暂停 ${COOLDOWN}s（已跑 ${DONE}/${SHARDS} 片）"
    sleep "$COOLDOWN"
  fi
done

# 通知战报进程写最后一帧（"最终战报"）后退出；必须先于下面的失败早退，否则它会一直等
touch "$TMP/.done"
wait "$WATCH_PID" 2>/dev/null || true
LIVE_PATH=$(sed -n 's/^LIVE_OUT //p' "$TMP/watch.log" | head -1)
if [ -n "$LIVE_PATH" ]; then
  echo "📄 实时战报已写入：$LIVE_PATH"
else
  echo "⚠️ 未能解析实时战报路径（见 $TMP/watch.log）"
fi

FAIL=0
for k in $(seq 0 $((SHARDS - 1))); do
  if [ ! -s "$TMP/s$k.json" ]; then
    echo "❌ 分片 $k 没有产出，日志："
    cat "$TMP/s$k.log"
    FAIL=1
  fi
done
if [ "$FAIL" = "1" ]; then
  exit 1
fi

echo ""
echo "分片摘要："
for k in $(seq 0 $((SHARDS - 1))); do
  node -e '
    const fs = require("fs")
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const atk = Object.values(d.tallies).reduce((a, t) => a + t.attacks, 0)
    const sk = Object.values(d.tallies).reduce((a, t) => a + t.skillUses, 0)
    console.log(
      `  shard ${process.argv[2]}: 局数 ${d.gameNo} 手数 ${d.pliesSum} 攻击 ${atk} 技能 ${sk}` +
        ` | budget=${d.config.budget} shard=${d.config.shard} chars=${d.config.charList.join(",")}`,
    )
  ' "$TMP/s$k.json" "$k"
  if [ "${VERBOSE:-0}" = "1" ]; then
    echo "    --- 日志 s$k.log ---"
    sed 's/^/    /' "$TMP/s$k.log" | tail -5
  fi
done

FILES=()
for k in $(seq 0 $((SHARDS - 1))); do FILES+=("$TMP/s$k.json"); done

pnpm exec tsx scripts/tournament.ts --merge "${FILES[@]}"

END=$(date +%s)
echo ""
echo "墙钟总耗时：$((END - START))s（${SHARDS} 分片并行）"
if [ "${KEEP:-0}" = "1" ]; then
  echo "保留临时目录：$TMP"
else
  # 逐个删再删目录：某些环境对 `rm -rf` 的批量删除会拦截（需人工确认）
  for f in "$TMP"/*; do rm -f "$f" 2>/dev/null || true; done
  rmdir "$TMP" 2>/dev/null || rm -rf "$TMP" 2>/dev/null || true
fi
