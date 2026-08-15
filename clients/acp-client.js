#!/usr/bin/env node
/**
 * acp-client.js — 通用 ACP (Agent Client Protocol) 客户端
 * 用法: node acp-client.js "<spawn命令>" "<任务描述>"
 * 例:   node acp-client.js "hermes acp" "用一句话回复你好"
 *       node acp-client.js "pnpm --dir <DSH_REPO> run demo:acp" "任务..."
 * 协议: JSON-RPC 2.0 over stdio（ACP 标准）
 */
import { spawn } from 'node:child_process'
import os from 'node:os'

const [,, cmdStr, task] = process.argv
if (!cmdStr || !task) { console.error('用法: node acp-client.js "<命令>" "<任务>"'); process.exit(1) }

const parts = cmdStr.split(/\s+/)
const proc = spawn(parts[0], parts.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] })
let buf = ''
let reqId = 0
const pending = new Map()

function send(method, params = {}) {
  const id = ++reqId
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

proc.stdout.on('data', (d) => {
  buf += d.toString()
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx); buf = buf.slice(idx + 1)
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id)
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
      } else if (msg.method) {
        // 服务器通知：session/update 携带消息流（回复内容在这）
        if (msg.method === 'session/update' && msg.params?.updates?.length) {
          for (const u of msg.params.updates) {
            console.log('ℹ update 原始:', JSON.stringify(u).slice(0, 400))
            // 消息文本在 chunk 的 content（原始 JSON 直取）
            const blocks = u?.content
            const t = Array.isArray(blocks)
              ? blocks.map((b) => b?.text || '').join('')
              : (typeof u?.text === 'string' ? u.text : '')
            if (t) console.log('ℹ 回复流:', t.slice(0, 800))
          }
        }
        // 服务器请求：回确认
        if (msg.id !== undefined) {
          proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n')
        }
      }
    } catch { /* 忽略非 JSON 行 */ }
  }
})

const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), ms))])

try {
  const init = await timeout(send('initialize', { protocolVersion: 1, clientCapabilities: {} }), 30000)
  console.log('✓ initialize:', JSON.stringify(init).slice(0, 200))
  const sess = await timeout(send('session/new', { cwd: os.homedir(), mcpServers: [] }), 30000)
  const sessionId = sess.sessionId
  console.log('✓ session/new:', sessionId)
  const result = await timeout(send('session/prompt', { sessionId: sessionId, prompt: [{ type: 'text', text: task }] }), 300000)
  const msg = result?.message
  const reply = msg?.content ? msg.content.map((b) => b.text || '').join('') : JSON.stringify(result)
  console.log('✓ 任务结果:', reply.slice(0, 2500))
  proc.kill()
} catch (e) {
  console.error('✗ 失败:', e.message)
  proc.kill()
  process.exit(1)
}
