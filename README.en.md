# Dual-Agent Integration — Hermes ↔ DeepSeek Harness

<p align="center">
  <b>English</b> · <a href="README.md">中文</a>
</p>

A programmatic integration between **Hermes Agent** (personal AI assistant) and **DeepSeek Harness** (DSH, an agent framework) enabling: **bidirectional calls** via the **ACP standard protocol**, **shared long-term memory** (mem0 + qdrant), **event-driven monitoring** (webhook push), and **skill synchronization** — a complete collaboration loop between two AI agents.

> Use case: two AI agents running on one host, able to call each other, share memory, and watch each other.

## Architecture

```
┌─ Hermes Agent ─────────────┐        ┌─ DeepSeek Harness (HD) ─────┐
│  hermes acp (ACP server)   │        │  pnpm run demo:acp (ACP server) │
│  ──────────────────────    │        │  ─────────────────────────   │
│  Full skills/memory/tools  │        │  Cordis plugin system        │
└──────────┬─────────────────┘        └──────────────┬──────────────┘
           │  ACP (JSON-RPC stdio) bidirectional      │
           └──────────────────┬───────────────────────┘
                              ▼
   ┌──────────────────────────────────────────────┐
   │ Shared layer: mem0 (qdrant 6333) memory      │
   │               Skill sync (Hermes → DSH)      │
   │               webhook (8644) event push      │
   └──────────────────────────────────────────────┘
```

## Components

| Path | Description |
|---|---|
| `clients/acp-client.py` | **ACP standard client** (python) — bidirectional, runs tasks and collects replies |
| `clients/acp-client.js` | Node fallback client |
| `plugins/hermes-bridge.ts` | HD→Hermes plugin: registers the `call_hermes` tool (call Hermes directly from HD sessions). **Dual-session routing**: one-shot by default; pass `session=<name>` for persistent sessions (shared context across calls for long collaboration/continuous diagnosis); `reset_session=true` clears context for a fresh phase. **v0.4.0**: session-matching tolerance (truncated titles / titles with spaces), per-call logging (`~/.hermes/logs/call-hermes.log`), long results keep head+tail 4000 chars each |
| `plugins/hd-events.ts` | Event-driven monitoring plugin: watches the real session store `~/.dsh/sessions/` (recursive fs.watch + 30s scan fallback), posts webhooks on stall/resume. **v0.4.0**: fixed false alarms from watching a dead file, no false stall when idle, in-process idempotency guard against duplicate instances |
| `scripts/site-watch.sh` | Lightweight fallback monitor (site/HD/qdrant liveness, output only on anomaly) |
| `skills/dual-agent-workflow.md` | Collaboration protocol skill (relay/duty/knowledge loop/pitfalls) |

## Dependencies

- **Hermes Agent** (with python `acp` lib: `~/.hermes/hermes-agent/venv/`)
- **DeepSeek Harness** (`pnpm run demo:acp` provides the ACP server, requires `DEEPSEEK_API_KEY`)
- **mem0 + qdrant** (shared memory, optional)

## Quick Start

### Install the DSH plugin (published on npm)

```sh
dsh plugin --profile <name> add dsh-hermes-bridge   # one-line install
dsh --profile <name> --dump-config                  # verify layer
```

### Bidirectional ACP calls

```bash
# 1. Start HD's ACP server (auto-spawned per client call, no daemon needed)
# 2. Call HD (ACP standard protocol)
<venv>/bin/python clients/acp-client.py "pnpm --dir <DSH_REPO> run demo:acp" "your task"

# 3. Call Hermes
<venv>/bin/python clients/acp-client.py "hermes acp" "your task"

# 4. Call Hermes from inside HD (plugin)
#    Mount plugins/hermes-bridge.ts into cordis.patch.yml, use the call_hermes tool
#    Dual-session routing:
#      call_hermes(task="...")                          → one-shot session (standalone short tasks)
#      call_hermes(task="...", session="name")           → persistent session (shared context)
#      call_hermes(task="...", session="name", reset_session=true) → clear session, new phase

# 5. Event monitoring (plugin)
#    Mount plugins/hd-events.ts + configure Hermes webhook (hermes webhook subscribe hd-events ...)
```

## Dual-Session Routing (call_hermes)

`call_hermes` borrows the persistent-session design of the official `hermes peer` (resume a peer's session by name, create if missing):

| Mode | Usage | Best for | Context |
|---|---|---|---|
| One-shot (default) | `call_hermes(task="...")` | Standalone short tasks | Zero residue, lowest tokens |
| Persistent | `call_hermes(task="...", session="name")` | Long collaboration / continuous diagnosis (check→fix→verify) | Shared context across calls with the same name |
| Reset | `call_hermes(task="...", session="name", reset_session=true)` | Same session name for a new topic | Deletes old session, creates a fresh one |

**Mechanics**:
- Persistent → `hermes chat --continue <name> --create-if-missing` (resume by title, create when missing)
- Reset → `hermes sessions list` to find ID by title → `hermes sessions delete <id> --yes` → recreate

**Verification (2026-08-18, real runs)**:
- Control: one-shot session asked the secret value → "don't know" (proves not in mem0, rules out shared-memory interference)
- Experimental: `session='bridge-clean'` twice → second call accurately recalled `XJ-778899-2026` (context-continuation proof)
- Reset: stored ALPHA-111 → `reset_session=true` stored BETA-222 → asked again → returned BETA-222 (old context cleared)

## Pitfalls (Important)

- **ACP flow**: `initialize`(protocolVersion=1) → `session/new`(cwd, mcpServers:[]) → `session/prompt`(sessionId, prompt:[{type:'text',text:...}]); `PromptResponse` has no message field
- **Reply text**: lives in `session/update` notifications (content is a dict/pydantic model, not a list)
- **Hermes webhook signing**: `X-Hub-Signature-256: sha256=<hmac>` (GitHub style), HMAC uses the **subscription-specific secret**
- **Python client**: must run with Hermes venv's interpreter (system python3 mismatches pydantic_core builds)
- **DSH plugin defineTool schema**: `parameters` must be `type:'object'` + `properties` + `required:[...]` array (`required:true` inside a field causes INVALID_REQUEST)
- **spawn doesn't use a shell**: use `pnpm --dir <repo>` (not `cd &&`)

## Token Cost Optimization (Tiered Collaboration)

Collaboration costs ~+80–100% (two agents), so it is **tiered**:

| Task type | Collaboration | Cost |
|---|---|---|
| Simple Q&A / single command | Don't involve the other | Normal |
| Routine dev | Solo-first, peer reviews key points | +30% |
| Big tasks / important diagnostics / design | Split + dual-view review | +80–100% |

**Rules**:
1. Tasks that need the peer **report token cost first**, user decides
2. What can be done solo stays solo (avoid duplicate spend)
3. Peer does only what it's good at (independent review / parallel exploration), minimal-context prompts
4. Headless short tasks keep context tight; don't read irrelevant content

## License

MIT
