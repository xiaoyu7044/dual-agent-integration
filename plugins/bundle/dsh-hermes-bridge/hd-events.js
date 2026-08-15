// @ts-nocheck — 独立插件，运行时由 tsx 解析（仓库 node_modules）
/**
 * hd-events — HD 会话事件驱动监控（优雅版，替代轮询盯梢）。
 * fs.watch 监听会话缓存文件：HD 干活时文件更新=活跃；N 分钟无更新=卡住（HD_STALL_MIN 可配，默认 20）。
 * 事件 → POST Hermes webhook（X-Hub-Signature-256 HMAC 签名）→ 直推用户（零 LLM 成本）。
 * 优化（0.2.0）：修复重复 find、阈值参数化、notify 重试（3 次）、单实例锁（web+headless 防重复告警）。
 */
import { watch, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { homedir } from 'node:os';
export const name = 'hd-events';
const DSH_HOME = process.env.DSH_HOME || homedir() + '/.dsh';
const CACHE = DSH_HOME + '/storages/session_projcache.json';
const STALL_MIN = Number(process.env.HD_STALL_MIN) || 20;
const LOCK = '/tmp/hd-events.lock';
// 单实例锁：web+headless 双挂载时只有第一个实例 watch，防重复告警
const lock = (() => {
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
export function apply(ctx) {
    if (!lock) {
        console.log('[hd-events] 已有实例在运行（单实例锁），跳过');
        return;
    }
    let lastActive = 0;
    let stalledNotified = false;
    // notify 重试：最多 tries 次（失败重发，网络抖动兜底）
    const post = (url, body, sig, event, tries) => fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Hub-Signature-256': sig,
            'X-GitHub-Event': event,
        },
        body,
    }).catch(() => (tries > 0 ? post(url, body, sig, event, tries - 1) : undefined));
    const notify = (event, detail) => {
        const body = JSON.stringify({ event, detail, ts: Date.now() });
        const sig = 'sha256=' + createHmac('sha256', WH_SECRET).update(body).digest('hex');
        post(WH_URL, body, sig, event, 2).catch(() => { });
        console.log(`[hd-events] ${event}: ${detail}`);
    };
    try {
        const w = watch(CACHE, () => {
            lastActive = Date.now();
            stalledNotified = false;
        });
        const timer = setInterval(() => {
            if (lastActive > 0 && !stalledNotified) {
                const mins = Math.round((Date.now() - lastActive) / 60000);
                if (mins > STALL_MIN) {
                    notify('hd_stall', `HD 会话 ${mins} 分钟无更新（疑似卡住/任务停滞，阈值 ${STALL_MIN} 分钟）`);
                    stalledNotified = true;
                }
            }
        }, 60000);
        console.log(`[hd-events] 已启动：watch 会话缓存，停滞阈值 ${STALL_MIN} 分钟（pid ${process.pid}）`);
        // 清理：进程退出时释放锁
        const cleanup = () => { try {
            unlinkSync(LOCK);
        }
        catch { /* ignore */ } process.exit(0); };
        process.on('SIGTERM', cleanup);
        process.on('SIGINT', cleanup);
        ctx.on?.('dispose', cleanup);
    }
    catch (e) {
        console.log('[hd-events] 启动失败:', String(e).slice(0, 200));
    }
}
