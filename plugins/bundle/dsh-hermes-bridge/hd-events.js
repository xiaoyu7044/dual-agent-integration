// @ts-nocheck — 独立插件，运行时由 tsx 解析（仓库 node_modules）
/**
 * hd-events — HD 会话事件驱动监控（优雅版，替代轮询盯梢）。
 * 监听真实活跃信号：~/.dsh/sessions/ 下所有 session.jsonl.zstd（HD 干活时持续写入）。
 * HD 活跃（文件更新）= 工作中；曾经活跃但 N 分钟无更新 = 停滞告警（HD_STALL_MIN 可配，默认 20）。
 * 事件 → POST Hermes webhook（X-Hub-Signature-256 HMAC 签名）→ 直推用户（零 LLM 成本）。
 *
 * v0.4.0 修复（2026-08-21）：
 *   - 监听源修复：原来 watch session_projcache.json（8/15 后不再更新）→ 全是假告警；
 *     改监听 ~/.dsh/sessions/ 目录（真实会话写入源，递归 watch + 兜底扫描双保险）
 *   - 空闲不误报：lastActive 初始=最近活跃 mtime（仅当 20 分钟内活跃过才计时）；
 *     纯空闲（从未活跃）永不报停滞——空闲 ≠ 卡住
 *   - 同进程双实例防护：globalThis 标记 + 文件锁（原来同进程加载两次会重复推送告警）
 *   - 停滞恢复通知：报过停滞后又活跃 → 推 hd_resumed（用户知道已恢复）
 */
import { watch, readFileSync, writeFileSync, existsSync, unlinkSync, statSync, readdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const name = 'hd-events';
const DSH_HOME = process.env.DSH_HOME || homedir() + '/.dsh';
const SESSIONS_ROOT = DSH_HOME + '/sessions'; // 真实活跃信号源
const STALL_MIN = Number(process.env.HD_STALL_MIN) || 20;
const LOCK = '/tmp/hd-events.lock';
// 单实例锁：同进程（globalThis 标记）+ 跨进程（pid 文件）双保险，防重复告警
const acquired = (() => {
    if (globalThis.__hdEventsActive)
        return false;
    try {
        if (existsSync(LOCK)) {
            const pid = Number(readFileSync(LOCK, 'utf8'));
            if (pid > 0) {
                try {
                    process.kill(pid, 0);
                    return false;
                }
                catch { /* 旧实例已死，可接管 */ }
            }
        }
        writeFileSync(LOCK, String(process.pid));
        globalThis.__hdEventsActive = true;
        return true;
    }
    catch {
        return true;
    } // 锁失败不阻塞（保守：继续运行）
})();
// 从 Hermes webhook 订阅配置自动发现 URL/secret（订阅专属 HMAC）
const SUB = (() => {
    try {
        const j = JSON.parse(readFileSync(process.env.HERMES_HOME || homedir() + '/.hermes/webhook_subscriptions.json', 'utf8'));
        const arr = Array.isArray(j) ? j : (j.subscriptions || []);
        const sub = arr.find((s) => s.name === 'hd-events');
        if (sub)
            return { url: sub.url || sub.webhook_url || '', secret: sub.secret || '' };
    }
    catch { /* ignore */ }
    return { url: process.env.HD_EVENT_URL || '', secret: process.env.HD_EVENT_SECRET || '' };
})();
const WH_URL = SUB.url || 'http://127.0.0.1:8644/webhooks/hd-events';
const WH_SECRET = SUB.secret || '';
/** 递归扫描 sessions 根，返回所有 session.jsonl.zstd 的最大 mtime（无则 0） */
function scanLatestMtime(dir, depth = 0) {
    if (depth > 4)
        return 0;
    let latest = 0;
    try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, entry.name);
            try {
                if (entry.isDirectory()) {
                    latest = Math.max(latest, scanLatestMtime(p, depth + 1));
                }
                else if (entry.name.endsWith('.zstd') || entry.name.endsWith('.jsonl')) {
                    latest = Math.max(latest, statSync(p).mtimeMs);
                }
            }
            catch { /* 单文件 stat 失败跳过 */ }
        }
    }
    catch { /* 目录不存在/无权限 */ }
    return latest;
}
export function apply(ctx) {
    if (!acquired || globalThis.__hdEventsApplied) {
        console.log('[hd-events] 已有实例在运行（单实例锁/幂等保护），跳过');
        return;
    }
    ;
    globalThis.__hdEventsApplied = true;
    // 初始活跃基线：仅当最近 STALL_MIN 内有会话写入才计时（正在干活）；
    // 纯空闲（最后活跃在阈值外）→ lastActive=0，永不报停滞（空闲≠卡住）
    let lastActive = 0;
    const latest = scanLatestMtime(SESSIONS_ROOT);
    if (latest > 0 && Date.now() - latest < STALL_MIN * 60000) {
        lastActive = latest;
    }
    let stalledNotified = false;
    let resumedNotified = false;
    // notify 重试：最多 tries 次（网络抖动兜底），并校验 HTTP 状态（非 2xx 也重试）
    const post = (url, body, sig, event, tries) => fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Hub-Signature-256': sig,
            'X-GitHub-Event': event,
        },
        body,
    }).then((r) => {
        if (!r.ok && tries > 0)
            return post(url, body, sig, event, tries - 1);
    }).catch(() => (tries > 0 ? post(url, body, sig, event, tries - 1) : undefined));
    const notify = (event, detail) => {
        const body = JSON.stringify({ event, detail, ts: Date.now() });
        const sig = 'sha256=' + createHmac('sha256', WH_SECRET).update(body).digest('hex');
        post(WH_URL, body, sig, event, 2).catch(() => { });
        console.log(`[hd-events] ${event}: ${detail}`);
    };
    const markActive = (why) => {
        if (stalledNotified && !resumedNotified) {
            // 报过停滞后恢复 → 通知已恢复（只推一次，直到再次停滞）
            resumedNotified = true;
            notify('hd_resumed', 'HD 会话恢复活跃（监控继续）');
        }
        lastActive = Date.now();
        stalledNotified = false;
        resumedNotified = false;
    };
    try {
        // a. 事件驱动主通道：递归 watch sessions 目录（HD 写 session.jsonl.zstd 会触发）
        let w = null;
        try {
            w = watch(SESSIONS_ROOT, { recursive: true }, () => markActive('watch'));
            w.on('error', (e) => {
                console.log('[hd-events] watch 错误（降级为扫描模式）:', String(e).slice(0, 200));
                notify('hd_watch_error', 'HD 会话监控 watch 失效，已降级为 60s 扫描模式（功能不受影响）');
            });
        }
        catch (e) {
            console.log('[hd-events] recursive watch 不可用（降级为扫描模式）:', String(e).slice(0, 200));
        }
        // b. 兜底扫描：每 30s 扫一次真实 mtime（watch 漏事件/降级时保底）
        const scanTimer = setInterval(() => {
            const l = scanLatestMtime(SESSIONS_ROOT);
            if (l > lastActive)
                markActive('scan');
        }, 30000);
        // c. 停滞检测：每秒检查；仅对「曾活跃」的会话计时
        const timer = setInterval(() => {
            if (lastActive > 0 && !stalledNotified) {
                const mins = Math.round((Date.now() - lastActive) / 60000);
                if (mins > STALL_MIN) {
                    notify('hd_stall', `HD 会话 ${mins} 分钟无更新（疑似卡住/任务停滞，阈值 ${STALL_MIN} 分钟）`);
                    stalledNotified = true;
                    resumedNotified = false;
                }
            }
        }, 60000);
        console.log(`[hd-events] 已启动：watch ${SESSIONS_ROOT}，停滞阈值 ${STALL_MIN} 分钟（pid ${process.pid}）`);
        // 清理：进程退出时释放锁
        const cleanup = () => {
            try {
                unlinkSync(LOCK);
                globalThis.__hdEventsActive = false;
            }
            catch { /* ignore */ }
            clearInterval(timer);
            clearInterval(scanTimer);
            try {
                w?.close?.();
            }
            catch { /* ignore */ }
            process.exit(0);
        };
        process.on('SIGTERM', cleanup);
        process.on('SIGINT', cleanup);
        ctx.on?.('dispose', cleanup);
    }
    catch (e) {
        console.log('[hd-events] 启动失败:', String(e).slice(0, 200));
    }
}
