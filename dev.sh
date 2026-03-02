#!/bin/bash
# NeoMe 一键启动开发服务
# 用法: ./dev.sh

SERVER_PORT=9527
EXPO_PORT=9528

echo "🔧 清理占用端口..."
lsof -ti:$SERVER_PORT | xargs kill -9 2>/dev/null
lsof -ti:$EXPO_PORT | xargs kill -9 2>/dev/null
sleep 1

echo "🚀 启动 Server (port $SERVER_PORT)..."
(cd src/server && PORT=$SERVER_PORT npx tsx index.ts) &
SERVER_PID=$!
sleep 2

# 检查 Server 是否成功启动
if curl -s "http://localhost:$SERVER_PORT/health" | grep -q '"ok"'; then
  echo "✅ Server 启动成功 (PID: $SERVER_PID)"
else
  echo "❌ Server 启动失败"
  kill $SERVER_PID 2>/dev/null
  exit 1
fi

echo "🚀 启动 Expo (port $EXPO_PORT)..."
npx expo start --port $EXPO_PORT &
EXPO_PID=$!

echo ""
echo "=================================="
echo "  NeoMe 开发服务已启动"
echo "  Server: http://0.0.0.0:$SERVER_PORT"
echo "  Expo:   http://localhost:$EXPO_PORT"
echo "=================================="
echo "  按 Ctrl+C 停止所有服务"
echo ""

# 捕获退出信号，清理子进程
cleanup() {
  echo ""
  echo "🛑 停止所有服务..."
  kill $SERVER_PID 2>/dev/null
  kill $EXPO_PID 2>/dev/null
  lsof -ti:$SERVER_PORT | xargs kill -9 2>/dev/null
  lsof -ti:$EXPO_PORT | xargs kill -9 2>/dev/null
  echo "👋 已退出"
  exit 0
}

trap cleanup SIGINT SIGTERM

# 等待任意子进程退出
wait
