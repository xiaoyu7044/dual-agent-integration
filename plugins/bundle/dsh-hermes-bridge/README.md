# dsh-hermes-bridge

<p align="center">
  <a href="README.en.md">🌐 English</a> · <b>中文</b>
</p>

DeepSeek Harness ↔ Hermes Agent 互通插件包（DSH bundle）。

让 **HD（DeepSeek Harness）** 会话内直接调用 **Hermes Agent**（另一个 AI agent），实现双 agent 协作：HD 可以把需要 Hermes 特有能力（网站部署、SSH 运维、mem0 记忆、MC 服务器、GeniE 脚本等）的任务直接交给 Hermes 执行并取回结果。

## 包含插件

| 插件 id | 功能 |
|---|---|
| `hermes-bridge` | 注册 `call_hermes` 工具——HD 会话内直接调用 Hermes Agent，**双会话路由**（一次性/持久会话）。v0.4.0：会话匹配容错、调用日志、超长结果头尾保留 |
| `hd-events` | 事件驱动监控——监听 `~/.dsh/sessions/` 真实会话文件（fs.watch 递归 + 30s 扫描兜底），会话停滞/恢复自动 HMAC 签名 POST Hermes webhook（直推用户，零 LLM 成本）。v0.4.0：修复监听死文件导致的假告警、空闲不误报、双实例幂等保护 |

## 安装（DSH profile）

```sh
# 从 npm 安装（推荐）
dsh plugin --profile myprofile add dsh-hermes-bridge

# 本地路径安装（开发/验证）
dsh plugin --profile myprofile add ./dsh-hermes-bridge

# 或从 GitHub 安装
dsh plugin --profile myprofile add git+https://github.com/xiaoyu7044/dual-agent-integration.git#plugins/bundle/dsh-hermes-bridge

# 验证层
dsh --profile myprofile --dump-config   # 应看到 "# == dsh-hermes-bridge" 层
dsh --profile myprofile
```

## call_hermes 工具：双会话路由

`call_hermes` 支持两种会话模式，按任务类型选择：

### ① 一次性会话（默认）— 独立短任务

不传 `session` 参数。每次调用是全新会话，零上下文残留：

```
call_hermes(task: "查询 mc.mcgg.cc 首页 HTTP 状态码")
```

适合：单次查询、独立计算、无状态任务。**token 成本最低**（无历史上下文回放）。

### ② 持久会话 — 长协作 / 连续诊断

传 `session=<名称>`。同一名称的多次调用**共享上下文**——Hermes 会记住之前轮次的内容，不用每次自包含任务描述：

```
call_hermes(task: "检查服务器磁盘并记住初步结论", session: "server-triage")
call_hermes(task: "继续：基于上一步结论给出清理方案", session: "server-triage")
call_hermes(task: "继续：执行清理并复验", session: "server-triage")
```

适合：多步流程（检查→分析→执行→复验）、需要跨调用记忆的长任务。

实现机制：`hermes chat --continue <名称> --create-if-missing`——按名称恢复持久会话（不存在则创建），Hermes 侧即为「Bot Chat」式连续会话。

### ③ 重置会话 — 开启全新阶段

传 `reset_session=true`（需配合 `session`）：先删除该名称的旧会话再新建，上下文清空：

```
call_hermes(task: "开始新一轮诊断，重新检查", session: "server-triage", reset_session: true)
```

适合：同一会话名换新课题、防止旧上下文污染新任务。

实现机制：`hermes sessions list` 按标题查 ID → `hermes sessions delete <id> --yes` → 重建同名会话。

### 参数说明

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `task` | string | ✅ | 要 Hermes 执行的任务（自包含、明确） |
| `session` | string | — | 持久会话名称；不传 = 一次性会话 |
| `reset_session` | boolean | — | 配合 session 使用；true = 删除旧会话重建 |

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HERMES_BIN` | `hermes` | Hermes CLI 路径 |
| `HERMES_TIMEOUT` | `600000` (10min) | 单次调用超时毫秒数 |

### 安全

- `execFile` 参数数组调用（无 shell 解释），防命令注入
- 结果截断保护：超过 8000 字符只返回末尾并提示
- 串行队列：并发调用排队执行，避免挤爆 Hermes

## 验证记录（2026-08-18）

| 场景 | 方法 | 结果 |
|---|---|---|
| 一次性会话 | `call_hermes` 无 session | ✅ 返回结果，零上下文残留 |
| 持久会话写入 | `session='bridge-clean'` 记住 `XJ-778899-2026` | ✅ |
| 对照组（一次性） | 不带 session 问同一值 | ✅ 「不知道」（证明不在 mem0，排除记忆干扰） |
| 实验组（持久） | 同 session 问同一值 | ✅ 返回 `XJ-778899-2026`（上下文延续铁证） |
| 重置会话 | 存 ALPHA-111 → `reset_session=true` 存 BETA-222 → 再问 | ✅ 返回 BETA-222（旧上下文已清） |

## 依赖

- 主机已安装 **Hermes Agent**（`hermes` CLI 在 PATH，或设 `HERMES_BIN`）
- HD 侧 webhook 订阅（`hd-events`）：`hermes webhook subscribe hd-events ...`（平台端口 8644，订阅专属 secret）
- 可选环境变量：`DSH_HOME`（默认 `~/.dsh`）、`HERMES_HOME`（默认 `~/.hermes`）

## Token 成本优化

协作 = 双 agent 消耗（约 +80~100%），分级控制：
- 简单问答/单命令：不拉对方
- 常规开发：单干为主，对方只复核关键点
- 大任务/重要诊断：分工 + 双视角，**先报 token 成本由用户拍板**
- 持久会话会回放历史上下文，token 略高于一次性——长任务才值得用

## 许可

MIT
