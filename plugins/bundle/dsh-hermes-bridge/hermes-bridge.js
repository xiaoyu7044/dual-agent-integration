// @ts-nocheck — 独立插件，运行时由 tsx 解析（仓库 node_modules）
/**
 * hermes-bridge — 让 HD（DeepSeek Harness）能调用本机 Hermes Agent。
 * 注册 call_hermes 工具：执行 `hermes chat`（one-shot 或持久会话），返回结果。
 * 双 agent 协作：HD 干活时可以把任务交给 Hermes（网站部署/服务器运维/mem0/SSH/MC 等）。
 * 安全：execFile 传参数组（无 shell 解释，防命令注入）。
 *
 * v0.3.0 双会话路由（借鉴官方 `hermes peer` 的持久会话设计）：
 *   - 默认（无 session 参数）：`hermes chat -q` 一次性会话，零上下文残留
 *   - 传 session=<名称>：`hermes chat --continue <名称> --create-if-missing` 持久会话，
 *     同一名称的多次调用共享上下文（长协作/连续诊断用），
 *     reset_session=true 参数可清空该会话的上下文（开启新阶段）。
 * 超时可配（HERMES_TIMEOUT）、并发串行队列、截断提示。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { execFile } from 'node:child_process';
export const name = 'hermes-bridge';
export const inject = ['tools'];
export function apply(ctx) {
    // 并发控制：串行队列（一次只跑一个 call_hermes，避免多任务挤爆 Hermes）
    let queue = Promise.resolve();
    /** 按标题查持久会话的 session ID（不存在返回 null） */
    function findSessionId(name) {
        return new Promise((resolve) => {
            execFile((process.env.HERMES_BIN || 'hermes'), ['sessions', 'list'], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (_err, stdout) => {
                // 输出表格：Title ... ID（ID 在行尾）
                for (const line of String(stdout).split('\n')) {
                    if (line.trim().startsWith(name + ' ')) {
                        const id = line.trim().split(/\s+/).pop();
                        if (id)
                            return resolve(id);
                    }
                }
                resolve(null);
            });
        });
    }
    /** 执行 hermes chat（one-shot 或持久会话） */
    function runHermes(args, timeoutMs) {
        return new Promise((resolve, reject) => {
            execFile((process.env.HERMES_BIN || 'hermes'), args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env } }, (err, stdout, stderr) => (err ? reject(new Error(String(err.message) + ' | ' + String(stderr).slice(0, 300))) : resolve(stdout)));
        });
    }
    ctx.tools.register(defineTool({
        name: 'call_hermes',
        description: '调用本机 Hermes Agent（另一 AI agent）执行任务，实现双 agent 协作。'
            + '任务描述必须自包含（Hermes 是独立会话，无本会话上下文）。'
            + 'Hermes 会用它的工具/技能/持久记忆执行并返回结果文本。'
            + '适合需要 Hermes 特有能力（mc.mcgg.cc 网站、服务器 SSH 运维、mem0 记忆、MC 服务器、'
            + 'GeniE 脚本、文件操作等）或耗时较长的任务。'
            + '注意：调用可能耗时（30 秒~10 分钟，可用 HERMES_TIMEOUT 环境变量调整），超时则返回已输出部分；'
            + '结果最多返回 8000 字符，超出会提示截断。'
            + '\n\n【双会话路由 v0.3.0】'
            + '不传 session：一次性会话（默认，适合独立短任务）。'
            + '传 session=<名称>：持久会话——同一名称的后续调用会带上之前的对话上下文，'
            + '适合长协作/连续诊断（如"检查服务器→修复→复验"分步推进）。'
            + '传 reset_session=true：清空该持久会话的上下文，开启全新阶段。',
        parameters: {
            task: {
                type: 'string',
                required: true,
                description: '要 Hermes 执行的任务（自包含、明确、含所有必要信息）',
            },
            session: {
                type: 'string',
                description: '持久会话名称（可选）。不传=一次性会话；传了=同一名称共享上下文',
            },
            reset_session: {
                type: 'boolean',
                description: '为 true 时先删除该持久会话再执行（开启全新阶段），仅在传了 session 时有效',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{
                    type: 'text',
                    text: String(value),
                }],
        },
        async execute({ task, session, reset_session }) {
            const timeoutMs = Number(process.env.HERMES_TIMEOUT) || 600000;
            const args = ['chat', '-q', String(task)];
            if (session) {
                if (reset_session) {
                    // 重置：先按标题找到旧会话 ID 删除，再新建同名会话
                    try {
                        const sid = await findSessionId(String(session));
                        if (sid)
                            await runHermes(['sessions', 'delete', sid, '--yes'], 30000);
                    }
                    catch { /* 删除失败不阻塞：--create-if-missing 会用新会话兜底 */ }
                }
                args.push('--continue', String(session), '--create-if-missing');
            }
            // 串行化：排队执行，前一个完成后才开始下一个
            const run = queue.then(() => runHermes(args, timeoutMs));
            queue = run.catch(() => { });
            try {
                const out = (await run || '').trim();
                if (out.length > 8000) {
                    return out.slice(-8000) + '\n…(结果超长，已截断保留末尾 8000 字符)';
                }
                return out || '(空输出)';
            }
            catch (e) {
                return `调用 Hermes 失败: ${String(e?.message || e).slice(0, 600)}`;
            }
        },
    }));
}
