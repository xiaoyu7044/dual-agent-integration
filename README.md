# Dual-Agent Integration — Hermes ↔ DeepSeek Harness

双 Agent 程序化互通方案：让 **Hermes Agent**（个人 AI 助手）与 **DeepSeek Harness**（DSH，Agent 框架）通过 **ACP 标准协议**双向调用、**共享长期记忆**（mem0 + qdrant）、**事件驱动监控**（webhook 直推）、**技能同步**，形成"你 · 我 · 它"三方可协作的完整闭环。

> 适用场景：一个主机上跑两个 AI Agent，想让它们互相调用、共享记忆、互相盯梢。

---

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
| `plugins/hermes-bridge.ts` | HD→Hermes 插件：注册 `call_hermes` 工具（HD 会话内直接调用 Hermes）。**v0.3.0 双会话路由**：默认一次性会话；传 `session=<名>` 用持久会话（同名单次调用共享上下文，长协作/连续诊断）；`reset_session=true` 清空上下文开新阶段 |
| `plugins/hd-events.ts` | 事件驱动监控插件：fs.watch 监听 DSH 会话文件，卡住/异常自动 POST webhook |
| `scripts/site-watch.sh` | 轻量兜底监控（主站/HD/qdrant 存活检查，异常才输出） |
| `skills/dual-agent-workflow.md` | 协作协议技能（接力/值班/知识闭环/踩坑） |

## 依赖

- **Hermes Agent**（含 python `acp` 库：`~/.hermes/hermes-agent/venv/`）
- **DeepSeek Harness**（`pnpm run demo:acp` 提供 ACP 服务器，需 `DEEPSEEK_API_KEY`）
- **mem0 + qdrant**（共享记忆，可选）

## 快速开始

### 安装 DSH 插件（已发布 npm）

```sh
dsh plugin --profile <名字> add dsh-hermes-bridge   # 一行安装（npm 已发布 @0.3.1，含双会话路由）
dsh --profile <名字> --dump-config                  # 验证层
```

### ACP 双向调用

```bash
# 1. 启动 HD 的 ACP 服务器（每次客户端调用时自动 spawn，无需常驻）
# 2. 调用 HD（ACP 标准协议）
<venv>/bin/python clients/acp-client.py "pnpm --dir <DSH_REPO> run demo:acp" "你的任务"

# 3. 调用 Hermes
<venv>/bin/python clients/acp-client.py "hermes acp" "你的任务"

# 4. HD 内调用 Hermes（插件）
#    挂载 plugins/hermes-bridge.ts 到 cordis.patch.yml，会话里用 call_hermes 工具
#    双会话路由（v0.3.0）：
#      call_hermes(task="...")                          → 一次性会话（独立短任务）
#      call_hermes(task="...", session="名称")           → 持久会话（多轮共享上下文）
#      call_hermes(task="...", session="名称", reset_session=true) → 清空会话开新阶段

# 5. 事件监控（插件）
#    挂载 plugins/hd-events.ts + 配置 Hermes webhook（hermes webhook subscribe hd-events ...）
```

## 双会话路由（call_hermes v0.3.0）

`call_hermes` 借鉴官方 `hermes peer` 的持久会话设计（按名称恢复对端会话、找不到才新建），提供两种会话模式：

| 模式 | 用法 | 适用 | 上下文 |
|---|---|---|---|
| 一次性（默认） | `call_hermes(task="...")` | 独立短任务 | 零残留，token 最低 |
| 持久会话 | `call_hermes(task="...", session="名称")` | 长协作/连续诊断（检查→修复→复验） | 同名单次调用共享上下文 |
| 重置 | `call_hermes(task="...", session="名称", reset_session=true)` | 同一会话名换新课题 | 先删旧会话再新建 |

**实现机制**：
- 持久会话 → `hermes chat --continue <名称> --create-if-missing`（按标题恢复，不存在则创建）
- 重置 → `hermes sessions list` 按标题查 ID → `hermes sessions delete <id> --yes` → 重建同名会话

**验证记录（2026-08-18 实测）**：
- 对照组：一次性会话问秘密值 → 「不知道」（证明不在 mem0，排除共享记忆干扰）
- 实验组：`session='bridge-clean'` 两次调用 → 第二次准确回忆 `XJ-778899-2026`（上下文延续铁证）
- 重置：存 ALPHA-111 → `reset_session=true` 存 BETA-222 → 再问 → 返回 BETA-222（旧上下文已清）

## 踩坑记录（重要）

- **ACP 方法**：`initialize`(protocolVersion=1) → `session/new`(cwd, mcpServers:[]) → `session/prompt`(sessionId, prompt:[{type:'text',text:...}])；`PromptResponse` 无 message 字段
- **回复文本**：在 `session/update` 通知里（content 是 dict/pydantic 模型，不是列表）
- **Hermes webhook 签名**：`X-Hub-Signature-256: sha256=<hmac>`（GitHub 风格），HMAC 用**订阅专属 secret**
- **python 客户端**：必须用 Hermes venv 的解释器跑（默认 python3 与 pydantic_core 编译不匹配）
- **DSH 插件 defineTool schema**：`parameters` 必须 `type:'object'` + `properties` + `required:[...]` 数组（`required:true` 在字段里会导致 INVALID_REQUEST）
- **spawn 不走 shell**：命令用 `pnpm --dir <repo>`（不要 `cd &&`）

## Token 成本优化（协作分级）

协作 = 双 agent 消耗（约 +80~100%），因此**分级控制**：

| 任务类型 | 协作方式 | 成本 |
|---|---|---|
| 简单问答/单命令 | 不拉对方 | 正常 |
| 常规开发 | 单干为主，对方只复核关键点 | +30% |
| 大任务/重要诊断/方案设计 | 分工 + 双视角复核 | +80~100% |

**执行规则**：
1. 需要拉对方的任务**先报 token 成本**，由用户拍板
2. 能单干的不拉（避免重复消耗）
3. 对方只做它擅长的（独立复核/并行探索），最小上下文 prompt
4. Headless 短任务控制上下文，不读无关内容

## 许可

MIT

---

# English

# Dual-Agent Integration — Hermes ↔ DeepSeek Harness

A programmatic integration between **Hermes Agent** (personal AI assistant) and **DeepSeek Harness** (DSH, an agent framework) enabling: **bidirectional calls** via the **ACP standard protocol**, **shared long-term memory** (mem0 + qdrant), **event-driven monitoring** (webhook push), and **skill synchronization** — a complete collaboration loop between two AI agents.

> Use case: two AI agents running on one host, able to call each other, share memory, and watch each other.

## Architecture

```
┌─ Hermes Agent ─────────────┐        ┌─ DeepSeek Harness (HD) ─────┐
│  hermes acp (ACP server)   │        │  pnpm run demo:acp (ACP server) │
│  ──────────────────────    │        │  ─────────────────────────   │
│  Full skills/memory/tools  │        │  Cordis plugin system        │
└──────────┬─────────────────┘        └──────────────┬──────────────┘
           │  ACP (JSON-RPC stdio) bidirectional      │
           └──────────────────┬───────────────────────┘
                              ▼
   ┌──────────────────────────────────────────────┐
   │ Shared layer: mem0 (qdrant 6333) memory      │
   │               Skill sync (Hermes → DSH)      │
   │               webhook (8644) event push      │
   └──────────────────────────────────────────────┘
```

## Components

| Path | Description |
|---|---|
| `clients/acp-client.py` | **ACP standard client** (python) — bidirectional, runs tasks and collects replies |
| `clients/acp-client.js` | Node fallback client |
| `plugins/hermes-bridge.ts` | HD→Hermes plugin: registers `call_hermes` tool (call Hermes from inside an HD session). **v0.3.0 dual-session routing**: default one-shot; `session=<name>` persistent session (shared context across calls); `reset_session=true` clears context for a new phase |
| `plugins/hd-events.ts` | Event-driven monitoring: fs.watch on DSH session files, posts webhook on stall/anomaly |
| `scripts/site-watch.sh` | Lightweight fallback monitor (site/HD/qdrant liveness, output only on anomaly) |
| `skills/dual-agent-workflow.md` | Collaboration protocol skill (relay/duty/knowledge loop/pitfalls) |

## Dependencies

- **Hermes Agent** (with python `acp` lib: `~/.hermes/hermes-agent/venv/`)
- **DeepSeek Harness** (`pnpm run demo:acp` provides the ACP server, requires `DEEPSEEK_API_KEY`)
- **mem0 + qdrant** (shared memory, optional)

## Quick Start

### Install the DSH plugin (published on npm)

```sh
dsh plugin --profile <name> add dsh-hermes-bridge   # one-line install (npm @0.3.1, with dual-session routing)
dsh --profile <name> --dump-config                  # verify layer
```

### Bidirectional ACP calls

```bash
# 1. Start HD's ACP server (auto-spawned per client call, no daemon needed)
# 2. Call HD (ACP standard protocol)
<venv>/bin/python clients/acp-client.py "pnpm --dir <DSH_REPO> run demo:acp" "your task"

# 3. Call Hermes
<venv>/bin/python clients/acp-client.py "hermes acp" "your task"

# 4. Call Hermes from inside HD (plugin)
#    Mount plugins/hermes-bridge.ts into cordis.patch.yml, use the call_hermes tool
#    Dual-session routing (v0.3.0):
#      call_hermes(task="...")                          → one-shot session (standalone short tasks)
#      call_hermes(task="...", session="name")           → persistent session (shared context)
#      call_hermes(task="...", session="name", reset_session=true) → clear session, new phase

# 5. Event monitoring (plugin)
#    Mount plugins/hd-events.ts + configure Hermes webhook (hermes webhook subscribe hd-events ...)
```

## Dual-Session Routing (call_hermes v0.3.0)

`call_hermes` borrows the persistent-session design of the official `hermes peer` (resume a peer's session by name, create if missing):

| Mode | Usage | Best for | Context |
|---|---|---|---|
| One-shot (default) | `call_hermes(task="...")` | Standalone short tasks | Zero residue, lowest tokens |
| Persistent | `call_hermes(task="...", session="name")` | Long collaboration / continuous diagnosis (check→fix→verify) | Shared context across calls with the same name |
| Reset | `call_hermes(task="...", session="name", reset_session=true)` | Same session name for a new topic | Deletes old session, creates a fresh one |

**Mechanics**:
- Persistent → `hermes chat --continue <name> --create-if-missing` (resume by title, create when missing)
- Reset → `hermes sessions list` to find ID by title → `hermes sessions delete <id> --yes` → recreate

**Verification (2026-08-18, real runs)**:
- Control: one-shot session asked the secret value → "don't know" (proves not in mem0, rules out shared-memory interference)
- Experimental: `session='bridge-clean'` twice → second call accurately recalled `XJ-778899-2026` (context-continuation proof)
- Reset: stored ALPHA-111 → `reset_session=true` stored BETA-222 → asked again → returned BETA-222 (old context cleared)

## Pitfalls (Important)

- **ACP flow**: `initialize`(protocolVersion=1) → `session/new`(cwd, mcpServers:[]) → `session/prompt`(sessionId, prompt:[{type:'text',text:...}]); `PromptResponse` has no message field
- **Reply text**: lives in `session/update` notifications (content is a dict/pydantic model, not a list)
- **Hermes webhook signing**: `X-Hub-Signature-256: sha256=<hmac>` (GitHub style), HMAC uses the **subscription-specific secret**
- **Python client**: must run with Hermes venv's interpreter (system python3 mismatches pydantic_core builds)
- **DSH plugin defineTool schema**: `parameters` must be `type:'object'` + `properties` + `required:[...]` array (`required:true` inside a field causes INVALID_REQUEST)
- **spawn doesn't use a shell**: use `pnpm --dir <repo>` (not `cd &&`)

## Token Cost Optimization (Tiered Collaboration)

Collaboration costs ~+80–100% (two agents), so it is **tiered**:

| Task type | Collaboration | Cost |
|---|---|---|
| Simple Q&A / single command | Don't involve the other | Normal |
| Routine dev | Solo-first, peer reviews key points | +30% |
| Big tasks / important diagnostics / design | Split + dual-view review | +80–100% |

**Rules**:
1. Tasks that need the peer **report token cost first**, user decides
2. What can be done solo stays solo (avoid duplicate spend)
3. Peer does only what it's good at (independent review / parallel exploration), minimal-context prompts
4. Headless short tasks keep context tight; don't read irrelevant content

## License

MIT
