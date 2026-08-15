#!/usr/bin/env python3
"""ACP 客户端（标准 python 库）——连任意 ACP 服务器跑任务并收回复。
用法: python3 acp-py-client.py "<spawn命令>" "<任务>"
"""
import asyncio, sys, json, os

# venv 路径参数化：默认自动探测 Hermes 的 python site-packages（或环境变量覆盖）
VENV_SITE = os.environ.get('ACP_PYTHON_PATH') or os.path.expanduser('~/.hermes/hermes-agent/venv/lib/python3.11/site-packages')
sys.path.insert(0, VENV_SITE)
from acp.client import ClientSideConnection
from acp.interfaces import Client

class MyClient(Client):
    def __init__(self):
        self.replies = []
    async def session_update(self, session_id, update, **kwargs):
        # 诊断：打印所有通知类型
        utype = getattr(update, 'session_update', type(update).__name__)
        content = getattr(update, 'content', None)
        text = ''
        if isinstance(content, dict):
            text = content.get('text') or ''
        elif isinstance(content, list):
            text = ''.join(
                (getattr(b, 'text', '') or '') if not isinstance(b, dict) else (b.get('text') or '')
                for b in content
            )
        else:
            text = getattr(content, 'text', '') or ''
        if text.strip():
            self.replies.append(text.strip())
        elif utype in ('agent_message_chunk', 'agent_thought_chunk'):
            pass  # 无文本块（忽略）
    async def request_permission(self, **kw): return None
    async def write_text_file(self, **kw): return None
    async def read_text_file(self, **kw): return None
    async def create_terminal(self, **kw): return None
    async def terminal_output(self, **kw): return None
    async def release_terminal(self, **kw): return None
    async def terminal_wait_for_exit(self, **kw): return None

async def main():
    cmd, task = sys.argv[1], sys.argv[2]
    parts = cmd.split()
    proc = await asyncio.create_subprocess_exec(
        *parts, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL)
    client = MyClient()
    conn = ClientSideConnection(client, proc.stdin, proc.stdout)
    await conn.initialize(protocol_version=1)
    print('✓ initialize OK', flush=True)
    sess = await conn.new_session(cwd=os.path.expanduser('~'), mcp_servers=[])
    print('✓ session/new:', sess.session_id, flush=True)
    from acp.schema import TextContentBlock
    resp = await conn.prompt(session_id=sess.session_id, prompt=[TextContentBlock(type='text', text=task)])
    print('✓ 任务完成 (stopReason:', resp.stop_reason, ')', flush=True)
    # 等异步 session/update 通知到达
    await asyncio.sleep(3)
    print('--- 回复内容 ---', flush=True)
    if client.replies:
        print(''.join(client.replies).strip()[:3000], flush=True)
    else:
        print('(无回复流——检查 session/update 或响应)', flush=True)
    proc.kill()

asyncio.run(main())
