#!/bin/bash
# 服务存活监控（每 30 分钟）——仅异常推送（正常静默）
# 检查：ACP 服务器宿主服务（示例：3080）与共享记忆后端（qdrant 6333）
# 用法：按需修改端口/地址，或改用环境变量
TS=$(date +%H:%M:%S)
FAIL=""

# 1. 主服务（示例端口 3080——DeepSeek Harness Web）
SVC_PORT="${SVC_PORT:-3080}"
CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 8 "http://127.0.0.1:${SVC_PORT}/" 2>/dev/null)
[ "$CODE" != "200" ] && FAIL="$FAIL 主服务(3080) HTTP=$CODE"

# 2. qdrant（6333——共享记忆后端）
Q=$(curl -s --connect-timeout 4 --max-time 6 http://127.0.0.1:6333/collections 2>/dev/null | head -c 40)
[ -z "$Q" ] && FAIL="$FAIL qdrant(6333) 无响应"

if [ -n "$FAIL" ]; then
  echo "🔴 服务异常（$TS）：$FAIL"
fi
exit 0
