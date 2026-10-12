#!/usr/bin/env bash
# 并行的「同角色镜像对撞」：把配对分片，跑完再合并。
#
# 为什么能并行？每片只跑自己那几对，彼此独立；合并是纯数据相加。
# 分片只影响"跑哪几对"，结果与串行**逐字节等价**（配合 `--nodes=` 确定性预算）。
#
# 用法：
#   bash scripts/duel-parallel.sh <角色> <变体A> <变体B> [对数/片=160] [每手ms=70] [分片数=8] \
#                                 [手数上限=220] [随机开局手数=8] [政策A=default] [政策B=default]
#   例：bash scripts/duel-parallel.sh deepseek base ds-nopenalty 160 70 8
#   例：bash scripts/duel-parallel.sh gtp base base 160 70 8 220 8 armor-strict armor-threat
#
# 🌡️ 降温（只改调度，不改结果）：
#   **默认 JOBS=4**（不再吃满所有核，实测只慢约 27%）
#   JOBS=8 bash scripts/duel-parallel.sh ...                # 全速
#   JOBS=4 COOLDOWN=30 bash scripts/duel-parallel.sh ...    # 每批之间停 30s
#   NODES=8000 bash scripts/duel-parallel.sh ...            # 降低每手搜索预算（真的少做功）
#   系统级限频（需管理员）：powercfg /setacvalueindex SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMAX 80
#     恢复：powercfg /setacvalueindex SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMAX 100
set -u

export PATH="/usr/bin:/bin:/c/Windows/System32:/d/nvm/nodejs:$PATH"
cd "$(dirname "$0")/.."

CHAR=${1:-gtp}
VAR_A=${2:-base}
VAR_B=${3:-base}
PAIRS=${4:-160}
BUDGET=${5:-70}
SHARDS=${6:-8}
MAXPLIES=${7:-220}
OPEN_PLIES=${8:-8}
POLICY_A=${9:-default}
POLICY_B=${10:-default}

# 🎯 确定性预算：15872 ≈ 本机 70ms 的搜索量。NODES=0 退回时间预算（**有抖动，不推荐**）。
NODES=${NODES:-15872}
NODES_ARG=()
if [ "$NODES" != "0" ]; then NODES_ARG=("--nodes=$NODES"); fi

# 🌡️ 默认并发 4（**不再"吃满所有核"**）：实测 8→4 只慢约 27%，核心占用减半 ⇒ 温度明显回落。
#    想全速：JOBS=$SHARDS。
JOBS=${JOBS:-4}
if [ "$JOBS" -gt "$SHARDS" ]; then JOBS=$SHARDS; fi
if [ "$JOBS" -lt 1 ]; then JOBS=1; fi
COOLDOWN=${COOLDOWN:-0}

# ⚠️ 必须用**相对路径**：bash 的 /tmp 是 `C:\Users\...\Temp`，node 会把它解析成 `D:\tmp`。
# 相对路径由 node 按 cwd 解析，才正确。
TMP=".duel-tmp"
rm -rf "$TMP"
mkdir -p "$TMP"

echo "同角色对撞：${CHAR} [A=${VAR_A} · ${POLICY_A}] vs [B=${VAR_B} · ${POLICY_B}]"
# ⚠️ `PAIRS` 是**总对数**（按分片均分），不是"每片对数"—— 总对局数 = PAIRS × 2
# （同种子 A/B 各先手一次）。别写成 PAIRS×SHARDS×2，那是把样本量高估了 SHARDS 倍。
echo "  ${PAIRS} 对 × 2 局（先/后手）⇒ 共 $((PAIRS * 2)) 局 · ${SHARDS} 片并发 ${JOBS} · 手数上限 ${MAXPLIES} · 随机开局 ${OPEN_PLIES} 手"
if [ "$NODES" != "0" ]; then
  echo "  🎯 确定性预算：每手 ≤ ${NODES} 节点（≈ ${BUDGET}ms）→ 同输入必定同结果"
else
  echo "  ⚠️ 时间预算 ${BUDGET}ms（NODES=0）：结果会随机器负载抖动，不推荐用于对比"
fi
START=$(date +%s)

# 按 JOBS 分组：组内并行、组间等齐（只影响调度，结果与全并行逐字节等价）
for ((base = 0; base < SHARDS; base += JOBS)); do
  PIDS=()
  for ((k = base; k < base + JOBS && k < SHARDS; k++)); do
    pnpm exec tsx scripts/duel.ts "$CHAR" "$VAR_A" "$VAR_B" "$PAIRS" "$BUDGET" "$MAXPLIES" "$OPEN_PLIES" \
      "--policy-a=$POLICY_A" "--policy-b=$POLICY_B" \
      "--shard=$k/$SHARDS" --json "${NODES_ARG[@]}" >"$TMP/s$k.json" 2>"$TMP/s$k.err" &
    PIDS+=($!)
  done
  for p in "${PIDS[@]}"; do
    wait "$p" || true
  done
  DONE=$((base + JOBS))
  if [ "$DONE" -gt "$SHARDS" ]; then DONE=$SHARDS; fi
  if [ "$COOLDOWN" -gt 0 ] && [ "$DONE" -lt "$SHARDS" ]; then
    echo "  🌡️ 降温：暂停 ${COOLDOWN}s（已跑 ${DONE}/${SHARDS} 片）"
    sleep "$COOLDOWN"
  fi
done

FAIL=0
for ((k = 0; k < SHARDS; k++)); do
  if [ ! -s "$TMP/s$k.json" ]; then
    echo "❌ 分片 $k 没有产出，日志：$TMP/s$k.err"
    sed 's/^/    /' "$TMP/s$k.err" 2>/dev/null | tail -5
    FAIL=1
  fi
done
if [ "$FAIL" = "1" ]; then
  exit 1
fi

FILES=()
for ((k = 0; k < SHARDS; k++)); do FILES+=("$TMP/s$k.json"); done

pnpm exec tsx scripts/duel.ts "$CHAR" --merge "${FILES[@]}"

END=$(date +%s)
echo ""
echo "墙钟总耗时：$((END - START))s（${SHARDS} 分片 · 并发 ${JOBS}）"
if [ "${KEEP:-0}" = "1" ]; then
  echo "保留临时目录：$TMP"
else
  for f in "$TMP"/*; do rm -f "$f" 2>/dev/null || true; done
  rmdir "$TMP" 2>/dev/null || rm -rf "$TMP" 2>/dev/null || true
fi
