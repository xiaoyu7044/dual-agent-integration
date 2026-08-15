#!/bin/bash
# 网站+HD+qdrant 监控（瘦身版，每 30 分钟）——仅异常推送
# 说明：HD 会话停滞检测已由 hd-events 插件（事件驱动 webhook）替代，此脚本只兜底服务挂机
TS=$(date +%H:%M:%S)
FAIL=""

# 1. mc.mcgg.cc 主站
CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 8 --max-time 15 https://mc.mcgg.cc/ 2>/dev/null)
[ "$CODE" != "200" ] && FAIL="$FAIL 主站mc.mcgg.cc HTTP=$CODE"

# 2. HD（3080）
CODE2=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 8 http://127.0.0.1:3080/ 2>/dev/null)
[ "$CODE2" != "200" ] && FAIL="$FAIL HD(3080) HTTP=$CODE2"

# 3. qdrant（6333——mem0 共享后端）
Q=$(curl -s --connect-timeout 4 --max-time 6 http://127.0.0.1:6333/collections 2>/dev/null | head -c 40)
[ -z "$Q" ] && FAIL="$FAIL qdrant(6333) 无响应"

if [ -n "$FAIL" ]; then
  echo "🔴 服务异常（$TS）：$FAIL"
fi
exit 0
