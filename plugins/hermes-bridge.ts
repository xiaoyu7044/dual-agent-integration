// @ts-nocheck — 独立插件，运行时由 tsx 解析（仓库 node_modules）
/**
 * hermes-bridge — 让 HD（DeepSeek Harness）能调用本机 Hermes Agent。
 * 注册 call_hermes 工具：执行 `hermes chat -q <task>`（one-shot 模式），返回结果。
 * 双 agent 协作：HD 干活时可以把任务交给 Hermes（网站部署/服务器运维/mem0/SSH/MC 等）。
 * 安全：execFile 传参数组（无 shell 解释，防命令注入）。
 * 优化（0.2.0）：超时可配（HERMES_TIMEOUT）、并发串行队列、截断提示。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { execFile } from 'node:child_process'

export const name = 'hermes-bridge'
export const inject = ['tools']

export function apply(ctx: any): void {
  // 并发控制：串行队列（一次只跑一个 call_hermes，避免多任务挤爆 Hermes）
  let queue: Promise<unknown> = Promise.resolve()

  ctx.tools.register(defineTool({
    name: 'call_hermes',
    description: '调用本机 Hermes Agent（另一 AI agent）执行任务，实现双 agent 协作。'
      + '任务描述必须自包含（Hermes 是独立新会话，无本会话上下文）。'
      + 'Hermes 会用它的工具/技能/持久记忆执行并返回结果文本。'
      + '适合需要 Hermes 特有能力（mc.mcgg.cc 网站、服务器 SSH 运维、mem0 记忆、MC 服务器、'
      + 'GeniE 脚本、文件操作等）或耗时较长的任务。'
      + '注意：调用可能耗时（30 秒~10 分钟，可用 HERMES_TIMEOUT 环境变量调整），超时则返回已输出部分；'
      + '结果最多返回 8000 字符，超出会提示截断。',
    parameters: {
      task: {
        type: 'string',
        required: true,
        description: '要 Hermes 执行的任务（自包含、明确、含所有必要信息）',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: any, value: any) => [{
        type: 'text',
        text: String(value),
      }],
    },
    async execute({ task }: { task: string }) {
      const timeoutMs = Number(process.env.HERMES_TIMEOUT) || 600000
      // 串行化：排队执行，前一个完成后才开始下一个
      const run = queue.then(
        () => new Promise<string>((resolve, reject) => {
          execFile(
            (process.env.HERMES_BIN || 'hermes'),
            ['chat', '-q', String(task)],
            { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env } },
            (err, stdout, stderr) => (err ? reject(new Error(String(err.message) + ' | ' + String(stderr).slice(0, 300))) : resolve(stdout)),
          )
        }),
      )
      queue = run.catch(() => {})
      try {
        const out = (await run || '').trim()
        if (out.length > 8000) {
          return out.slice(-8000) + '\n…(结果超长，已截断保留末尾 8000 字符)'
        }
        return out || '(空输出)'
      } catch (e: any) {
        return `调用 Hermes 失败: ${String(e?.message || e).slice(0, 600)}`
      }
    },
  }))
}
