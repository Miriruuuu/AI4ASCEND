#!/usr/bin/env sh
# ===========================================================================
#  Connect4 联机后端一键启动（Linux / 宝塔）
#  用法：chmod +x start.sh && ./start.sh
# ===========================================================================
set -e
cd "$(dirname "$0")"

if [ ! -f .env ] && [ -f .env.example ]; then
  echo "[start] 未找到 .env，已从 .env.example 复制一份，请按需修改"
  cp .env.example .env
fi

if [ ! -d node_modules ]; then
  echo "[start] 安装依赖（pnpm install）..."
  pnpm install
fi

if [ ! -f dist/index.js ]; then
  echo "[start] 编译 TypeScript（pnpm run build）..."
  pnpm run build
fi

echo "[start] 启动服务..."
exec node dist/index.js
