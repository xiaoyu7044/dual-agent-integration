// @ts-nocheck — 独立插件，运行时由 tsx 解析（仓库 node_modules）
/**
 * hd-events — HD 会话事件驱动监控（优雅版，替代轮询盯梢）。
 * fs.watch 监听会话缓存文件：HD 干活时文件更新=活跃；20 分钟无更新=卡住。
 * 事件 → POST Hermes webhook（X-Hermes-Signature-256 HMAC 签名）→ 直推用户（零 LLM 成本）。
 */
import { watch } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { homedir } from 'node:os';
export const name = 'hd-events';
const DSH_HOME = process.env.DSH_HOME || homedir() + '/.dsh';
const CACHE = DSH_HOME + '/storages/session_projcache.json';
// 从 Hermes webhook 订阅配置自动发现 URL/secret（订阅专属 HMAC）
const SUB = (() => {
    try {
        const j = JSON.parse(readFileSync(process.env.HERMES_HOME || homedir() + '/.hermes/webhook_subscriptions.json', 'utf8'));
        const arr = Array.isArray(j) ? j : (j.subscriptions || []);
        const sub = arr.find((s) => s.name === 'hd-events') || arr.find((s) => s.name === 'hd-events');
        if (sub)
            return { url: sub.url || sub.webhook_url || '', secret: sub.secret || '' };
    }
    catch { /* ignore */ }
    return { url: process.env.HD_EVENT_URL || '', secret: process.env.HD_EVENT_SECRET || '' };
})();
const WH_URL = SUB.url || 'http://127.0.0.1:8644/webhooks/hd-events';
const WH_SECRET = SUB.secret || '';
const STALL_MIN = 20;
export function apply(ctx) {
    let lastActive = 0;
    let stalledNotified = false;
    const notify = (event, detail) => {
        const body = JSON.stringify({ event, detail, ts: Date.now() });
        const sig = 'sha256=' + createHmac('sha256', WH_SECRET).update(body).digest('hex');
        try {
            fetch(WH_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Hub-Signature-256': sig,
                    'X-GitHub-Event': event,
                },
                body,
            }).catch(() => { });
            console.log(`[hd-events] ${event}: ${detail}`);
        }
        catch (e) {
            console.log('[hd-events] notify 失败:', String(e).slice(0, 200));
        }
    };
    try {
        const w = watch(CACHE, () => {
            lastActive = Date.now();
            stalledNotified = false;
        });
        setInterval(() => {
            if (lastActive > 0 && !stalledNotified) {
                const mins = Math.round((Date.now() - lastActive) / 60000);
                if (mins > STALL_MIN) {
                    notify('hd_stall', `HD 会话 ${mins} 分钟无更新（疑似卡住/任务停滞）`);
                    stalledNotified = true;
                }
            }
        }, 60000);
        console.log('[hd-events] 已启动：watch 会话缓存，停滞阈值 ' + STALL_MIN + ' 分钟');
    }
    catch (e) {
        console.log('[hd-events] 启动失败:', String(e).slice(0, 200));
    }
}
