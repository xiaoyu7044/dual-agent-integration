# dsh-hermes-bridge

DeepSeek Harness ↔ Hermes Agent 互通插件包（DSH bundle）。

## 包含插件

| 插件 id | 功能 |
|---|---|
| `hermes-bridge` | 注册 `call_hermes` 工具——HD 会话内直接调用 Hermes Agent（`hermes chat -q`） |
| `hd-events` | 事件驱动监控——fs.watch 监听 DSH 会话缓存，会话停滞/异常自动 HMAC 签名 POST Hermes webhook（直推用户） |

## 依赖

- 主机已安装 **Hermes Agent**（`hermes` CLI 在 PATH，或设 `HERMES_BIN`）
- HD 侧 webhook 订阅（`hd-events`）：`hermes webhook subscribe hd-events ...`（平台端口 8644，订阅专属 secret）
- 可选环境变量：`DSH_HOME`（默认 `~/.dsh`）、`HERMES_HOME`（默认 `~/.hermes`）

## 安装（DSH profile）

```sh
# 本地路径安装（开发/验证）
dsh plugin --profile myprofile add ./dsh-hermes-bridge

# 或从 GitHub 安装
dsh plugin --profile myprofile add git+https://github.com/xiaoyu7044/dual-agent-integration.git#plugins/bundle/dsh-hermes-bridge

# 验证层
dsh --profile myprofile --dump-config   # 应看到 "# == dsh-hermes-bridge" 层
dsh --profile myprofile
```

## Token 成本优化

协作 = 双 agent 消耗（约 +80~100%），分级控制：
- 简单问答/单命令：不拉对方
- 常规开发：单干为主，对方只复核关键点
- 大任务/重要诊断：分工 + 双视角，**先报 token 成本由用户拍板**

## 许可

MIT
