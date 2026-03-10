#!/bin/bash
# NeoMe E2E 测试运行脚本
# 用法: ./e2e/run-e2e.sh [test-name]
# 示例:
#   ./e2e/run-e2e.sh              # 运行所有测试
#   ./e2e/run-e2e.sh app-launch   # 只运行 app-launch 测试

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
E2E_DIR="$PROJECT_DIR/e2e"
MOCK_SERVER_PID=""
MAESTRO_BIN="$HOME/.maestro/bin/maestro"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

cleanup() {
  echo -e "\n${YELLOW}Cleaning up...${NC}"
  if [ -n "$MOCK_SERVER_PID" ] && kill -0 "$MOCK_SERVER_PID" 2>/dev/null; then
    kill "$MOCK_SERVER_PID" 2>/dev/null || true
    echo "Stopped mock server (PID: $MOCK_SERVER_PID)"
  fi
  # 清理占用端口
  lsof -ti:9527 | xargs kill -9 2>/dev/null || true
  lsof -ti:9530 | xargs kill -9 2>/dev/null || true
}

trap cleanup EXIT

# 检查 maestro
if [ -x "$MAESTRO_BIN" ]; then
  MAESTRO="$MAESTRO_BIN"
elif command -v maestro &>/dev/null; then
  MAESTRO="maestro"
else
  echo -e "${RED}Error: maestro is not installed${NC}"
  echo "Install: curl -Ls 'https://get.maestro.mobile.dev' | bash"
  exit 1
fi

echo -e "${GREEN}=== NeoMe E2E Tests ===${NC}"

# 清理占用端口
lsof -ti:9527 | xargs kill -9 2>/dev/null || true
lsof -ti:9530 | xargs kill -9 2>/dev/null || true
sleep 1

# 备份并设置 .env，模拟器通过 127.0.0.1 访问宿主机
ENV_FILE="$PROJECT_DIR/.env"
ORIG_HOST=$(grep '^EXPO_PUBLIC_SERVER_HOST=' "$ENV_FILE" | cut -d= -f2)
sed -i '' 's/^EXPO_PUBLIC_SERVER_HOST=.*/EXPO_PUBLIC_SERVER_HOST=127.0.0.1/' "$ENV_FILE"
echo -e "${YELLOW}Set EXPO_PUBLIC_SERVER_HOST=127.0.0.1 for simulator${NC}"

restore_env() {
  if [ -n "$ORIG_HOST" ]; then
    sed -i '' "s/^EXPO_PUBLIC_SERVER_HOST=.*/EXPO_PUBLIC_SERVER_HOST=$ORIG_HOST/" "$ENV_FILE"
    echo "Restored EXPO_PUBLIC_SERVER_HOST=$ORIG_HOST"
  fi
}
trap 'cleanup; restore_env' EXIT

# 启动 mock 服务器
echo -e "\n${YELLOW}Starting E2E mock server...${NC}"
cd "$PROJECT_DIR/src/server"
npx tsx "$PROJECT_DIR/src/server/e2e-mock-server.ts" &
MOCK_SERVER_PID=$!
cd "$PROJECT_DIR"

# 等待服务器启动
echo "Waiting for mock server..."
for i in $(seq 1 30); do
  if curl -s http://localhost:9527/health | grep -q '"ok"' 2>/dev/null; then
    echo -e "${GREEN}Mock server ready (port 9527 + mock Doubao on 9530)${NC}"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo -e "${RED}Mock server failed to start${NC}"
    exit 1
  fi
  sleep 1
done

# 定义测试文件
if [ -n "$1" ]; then
  TESTS=("$E2E_DIR/$1.yaml")
  if [ ! -f "${TESTS[0]}" ]; then
    echo -e "${RED}Test file not found: ${TESTS[0]}${NC}"
    exit 1
  fi
else
  TESTS=(
    "$E2E_DIR/app-launch.yaml"
    "$E2E_DIR/server-connection.yaml"
    "$E2E_DIR/reset-session.yaml"
    "$E2E_DIR/full-conversation.yaml"
    "$E2E_DIR/stability.yaml"
  )
fi

# 运行测试
PASSED=0
FAILED=0
FAILED_TESTS=()

for test_file in "${TESTS[@]}"; do
  test_name=$(basename "$test_file" .yaml)
  echo -e "\n${YELLOW}Running: $test_name${NC}"

  if $MAESTRO test "$test_file"; then
    echo -e "${GREEN}PASSED: $test_name${NC}"
    ((PASSED++))
  else
    echo -e "${RED}FAILED: $test_name${NC}"
    ((FAILED++))
    FAILED_TESTS+=("$test_name")
  fi
done

# 汇总
echo -e "\n${GREEN}=== Results ===${NC}"
echo "Total: $((PASSED + FAILED))"
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"

if [ ${#FAILED_TESTS[@]} -gt 0 ]; then
  echo -e "\n${RED}Failed tests:${NC}"
  for t in "${FAILED_TESTS[@]}"; do
    echo "  - $t"
  done
  exit 1
fi

echo -e "\n${GREEN}All tests passed!${NC}"
