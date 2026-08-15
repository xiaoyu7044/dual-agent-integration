# Dual-Agent Integration — Hermes ↔ DeepSeek Harness

双 Agent 程序化互通方案：让 **Hermes Agent**（个人 AI 助手）与 **DeepSeek Harness**（DSH，Agent 框架）通过 **ACP 标准协议**双向调用、**共享长期记忆**（mem0 + qdrant）、**事件驱动监控**（webhook 直推）、**技能同步**，形成"你 · 我 · 它"三方可协作的完整闭环。

> 适用场景：一个主机上跑两个 AI Agent，想让它们互相调用、共享记忆、互相盯梢。

## 架构

```
┌─ Hermes Agent ─────────────┐        ┌─ DeepSeek Harness (HD) ─────┐
│  hermes acp（ACP 服务器）   │        │  pnpm run demo:acp（ACP 服务器）│
│  ──────────────────────    │        │  ─────────────────────────   │
│  技能/记忆/工具全能力       │        │  Cordis 插件体系              │
└──────────┬─────────────────┘        └──────────────┬──────────────┘
           │  ACP (JSON-RPC stdio) 双向               │
           └──────────────────┬───────────────────────┘
                              ▼
   ┌──────────────────────────────────────────────┐
   │ 共享层：mem0 (qdrant 6333) 长期记忆           │
   │         技能同步（Hermes → DSH）              │
   │         webhook（8644）事件推送               │
   └──────────────────────────────────────────────┘
```

## 组件

| 路径 | 说明 |
|---|---|
| `clients/acp-client.py` | **ACP 标准客户端**（python）——双向通用，跑任务并收回复 |
| `clients/acp-client.js` | Node 备用客户端 |
| `plugins/hermes-bridge.ts` | HD→Hermes 插件：注册 `call_hermes` 工具（HD 会话内直接调用 Hermes） |
| `plugins/hd-events.ts` | 事件驱动监控插件：fs.watch 监听 DSH 会话文件，卡住/异常自动 POST webhook |
| `scripts/site-watch.sh` | 轻量兜底监控（主站/HD/qdrant 存活检查，异常才输出） |
| `skills/dual-agent-workflow.md` | 协作协议技能（接力/值班/知识闭环/踩坑） |

## 依赖

- **Hermes Agent**（含 python `acp` 库：`~/.hermes/hermes-agent/venv/`）
- **DeepSeek Harness**（`pnpm run demo:acp` 提供 ACP 服务器，需 `DEEPSEEK_API_KEY`）
- **mem0 + qdrant**（共享记忆，可选）

## 快速开始

```bash
# 1. 启动 HD 的 ACP 服务器（每次客户端调用时自动 spawn，无需常驻）
# 2. 调用 HD（ACP 标准协议）
<venv>/bin/python clients/acp-client.py "pnpm --dir <DSH_REPO> run demo:acp" "你的任务"

# 3. 调用 Hermes
<venv>/bin/python clients/acp-client.py "hermes acp" "你的任务"

# 4. HD 内调用 Hermes（插件）
#    挂载 plugins/hermes-bridge.ts 到 cordis.patch.yml，会话里用 call_hermes 工具

# 5. 事件监控（插件）
#    挂载 plugins/hd-events.ts + 配置 Hermes webhook（hermes webhook subscribe hd-events ...）
```

## 踩坑记录（重要）

- **ACP 方法**：`initialize`(protocolVersion=1) → `session/new`(cwd, mcpServers:[]) → `session/prompt`(sessionId, prompt:[{type:'text',text:...}])；`PromptResponse` 无 message 字段
- **回复文本**：在 `session/update` 通知里（content 是 dict/pydantic 模型，不是列表）
- **Hermes webhook 签名**：`X-Hub-Signature-256: sha256=<hmac>`（GitHub 风格），HMAC 用**订阅专属 secret**
- **python 客户端**：必须用 Hermes venv 的解释器跑（默认 python3 与 pydantic_core 编译不匹配）
- **DSH 插件 defineTool schema**：`parameters` 必须 `type:'object'` + `properties` + `required:[...]` 数组（`required:true` 在字段里会导致 INVALID_REQUEST）
- **spawn 不走 shell**：命令用 `pnpm --dir <repo>`（不要 `cd &&`）

## 许可

MIT
