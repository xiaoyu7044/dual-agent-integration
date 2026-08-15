---
name: dual-agent-workflow
description: 双 Agent 协作（Hermes↔HD）：任务接力/双向调用/值班/知识闭环协议。触发：派任务给对方、HD 相关集成。
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [dual-agent, hd, deepseek-harness, collaboration, workflow]
    related_skills: [hermes-agent, hermes-mem0-local]
---

# 双 Agent 协作宪法（Hermes ↔ HD）

> HD = DeepSeek Harness（用户称呼，严格大写 HD）。本技能定义两个 agent 如何协作。

## 角色与通路

| 方向 | 方式 | 命令/工具 |
|---|---|---|
| Hermes → HD | headless CLI | `cd /home/li/deepseek-harness && pnpm dsh --profile headless "任务"`（新会话，任务须自包含） |
| HD → Hermes | `call_hermes` 工具 | HD 会话里调用（hermes-bridge 插件注册，`/home/li/deepseek-harness/examples/hermes-bridge/index.ts`，execFile 调 `/home/li/.local/bin/hermes chat -q`） |
| 记忆共享 | mem0（qdrant server 6333） | 双向读写同一集合 `hermes_mem0_lijiachuan`（123+ 条）；HD 侧 mem0 工具经 dai-mem0 预设（默认） |

**服务**：HD = `dsh-web.service`（systemd 用户服务，3080，开机自启）；qdrant = `qdrant-server.service`（6333）。

## 任务接力规范（#3）

交接格式（任务描述必须自包含——对方无你的上下文）：
```
任务：<一句话目标>
背景：<必要上下文/文件路径/约束>
验收：<可检查的结果标准>
返回：<期望的返回形式>
```

接力规则：
- 我改 → HD 测/审：`pnpm dsh --profile headless "按交接格式：..."`
- HD 发现问题 → 派回我修：HD 用 `call_hermes` 把问题+上下文给我
- 大项目：先写交接文档（/tmp/relay-<project>.md），两边按文档接力，避免口头传递丢信息

## 统一入口模式（#6）

- **HD 当入口**（浏览器 3080）：用户在 HD 问网站/服务器/任何需要我执行的事 → HD 用 `call_hermes` 调我 → 我执行返回 → HD 整合给用户
- **Hermes 当入口**（WeCom/本会话）：用户说"叫 HD 做 X" → 我 `pnpm dsh --profile headless` 派任务 → 取结果汇报
- **注意**：`hermes chat -q` 每次是独立新会话（无记忆），任务必须自包含；调用耗时 30s~10min，超时返回部分结果

## 值班分工（#5）

HD 是会话式（无定时机制），**不能独立巡更**——值班 = 我的监控 + HD 按需诊断：
- **我的 watchdog**（cron）：MC 服务器（mc-server-watchdog）、HD 服务（hd-watch.sh 每 5 分钟）、mem0 健康（每日）
- **网站监控**：mc.mcgg.cc uptime 检查（异常推送）
- **异常时双视角诊断**：我先查 → 派 HD 独立分析（headless："这是异常信息，独立诊断原因"）→ 合并判断（防单 agent 盲区）

## 知识闭环（#4）

- **HD 经验 → 我的技能**：HD 踩的坑/发现的方案（如 mem0 embedder 坑、Cordis 插件写法）及时 patch 进相关技能（hermes-mem0-local 已含共享章节）
- **我的经验 → HD**：`~/.hermes/scripts/dsh-skill-sync.sh`（每日 6:00 cron `077c0b3d10ab` 自动拍平同步技能+记忆到 `~/.dsh/skills/`）——改技能后跑 `bash ~/.hermes/scripts/dsh-skill-sync.sh` 可立即同步
- **HD 插件维护**：hermes-bridge（call_hermes）在 `deepseek-harness/examples/hermes-bridge/`，挂载在 `~/.dsh/profiles/{web,headless}/cordis.patch.yml`（insert 语法：`- insert:\n    - name: '<绝对路径>'`）；patch 修改后 `systemctl --user restart dsh-web` 生效

## 事件驱动监控（方案 A——2026-08-15 落地，替代轮询盯梢）

- **hd-events 插件**（`deepseek-harness/examples/hermes-bridge/hd-events.ts`）：fs.watch 监听 `~/.dsh/storages/session_projcache.json`——HD 干活时文件更新=活跃；20 分钟无更新 → POST Hermes webhook → deliver-only 直推 WeCom（零 LLM 成本）
- **webhook 平台**：`platforms.webhook`（8644 端口 + 全局 secret `~/.hermes/webhook_secret`）；订阅 `hd-events`（`hermes webhook list` 查看，订阅专属 secret 在 `~/.hermes/webhook_subscriptions.json`）
- **⚠️ 签名坑**：Hermes webhook 验证用 **`X-Hub-Signature-256: sha256=<hmac>`**（GitHub 风格，不是 X-Hermes-*）——HMAC 用**订阅 secret**（`subs['hd-events']['secret']`），事件类型头 `X-GitHub-Event`；测试 POST：`{"status":"delivered"}`=成功
- **兜底**：`site-hd-watch.sh`（每 10 分钟 cron 查 主站/3080/6333/停滞）仍保留（webhook 失效时兜底）

## ACP 程序化 API（方案 B——2026-08-15 落地，标准协议双向互通）

- **HD 侧服务器**：`cd /home/li/deepseek-harness && pnpm run demo:acp`（JSON-RPC stdio，needs key，无客户端连会自动退出）
- **Hermes 侧服务器**：`hermes acp`（ACP 模式，`--check` 验证依赖）
- **客户端**（双向通用）：`python3 /home/li/acp-py-client.py "<服务器命令>" "<任务>"`——例：
  - 调 HD：`python3 acp-py-client.py "/home/li/.npm-global/bin/pnpm --dir /home/li/deepseek-harness run demo:acp" "任务"`
  - 调 Hermes：`python3 acp-py-client.py "hermes acp" "任务"`
  - Node 版备用：`/home/li/acp-client.js`
- **协议要点**：ACP v0.11（python 库 `acp` 在 Hermes venv）；方法 `initialize`(protocolVersion=1) → `session/new`(cwd, mcpServers:[]) → `session/prompt`(sessionId, prompt:[{type:'text',text:...}])；**回复文本在 `session/update` 通知**（content 是 dict 或 pydantic 模型，非列表）；**PromptResponse 无 message 字段**
- **坑**：spawn 不走 shell（`cd &&` 不行，用 `pnpm --dir`）；客户端需在 prompt 后 sleep 3s 收异步通知；`@anthropic-ai/acp-sdk` npm 镜像无此包（用 python acp 库或手写 Node）；**acp-py-client.py 必须用 venv 解释器跑**（`/home/li/.hermes/hermes-agent/venv/bin/python`——默认 python3 与 pydantic_core 编译不匹配报错）；**mem0 插件（HD 写的）defineTool schema 坑**：parameters 必须 `type:'object'` + `properties` + `required:[...]` 数组（HD 原来 `required:true` 在字段里 → INVALID_REQUEST 本轮失败，已修 `~/.dsh/.agent-presets/dai-mem0/mem0-plugin.mjs`）

## 踩坑记录

- **cordis.yml 是 DSH 自动生成的**（启动重写）——加插件必须改 `cordis.patch.yml`（insert 语法），改 cordis.yml 会被冲掉
- **DSH defineTool 必须带 `output.render`**（缺了报 `Cannot read properties of undefined (reading 'render')`）
- **插件 import 依赖**：插件文件要能解析 `@deepseek-ai/dsh-tools`（放仓库内或建 node_modules 链接）
- **headless 无 --preset CLI 选项**：预设选择走 settings.yaml（`agent-presets.default`）或 UI
- **HD 会话消息不落盘**：看 HD 在干什么用浏览器开 3080（能看到完整会话消息流）
