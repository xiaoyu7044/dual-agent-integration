# dsh-hermes-bridge

<p align="center">
  <b>English</b> · <a href="README.md">中文</a>
</p>

DeepSeek Harness ↔ Hermes Agent integration plugin bundle (DSH bundle).

Lets **HD (DeepSeek Harness)** call **Hermes Agent** (another AI agent) from inside its sessions: HD can hand tasks that need Hermes-specific capabilities (website deployment, SSH ops, mem0 memory, Minecraft server, GeniE scripting, etc.) to Hermes and collect the result.

## Included plugins

| Plugin id | Function |
|---|---|
| `hermes-bridge` | Registers the `call_hermes` tool — call Hermes Agent from inside an HD session, with **dual-session routing** (one-shot / persistent) |
| `hd-events` | Event-driven monitoring — fs.watch on the DSH session cache; on stall/anomaly POSTs an HMAC-signed webhook to Hermes (pushes to the user, zero LLM cost) |

## Install (DSH profile)

```sh
# From npm (recommended)
dsh plugin --profile myprofile add dsh-hermes-bridge

# Local path (dev/verify)
dsh plugin --profile myprofile add ./dsh-hermes-bridge

# Or from GitHub
dsh plugin --profile myprofile add git+https://github.com/xiaoyu7044/dual-agent-integration.git#plugins/bundle/dsh-hermes-bridge

# Verify the layer
dsh --profile myprofile --dump-config   # should show "# == dsh-hermes-bridge"
dsh --profile myprofile
```

## call_hermes: Dual-Session Routing

Two session modes, pick by task type:

### ① One-shot session (default) — standalone short tasks

Omit `session`. Every call is a fresh session, zero context residue:

```
call_hermes(task: "Check the HTTP status of mc.mcgg.cc")
```

Best for: one-off queries, independent computations, stateless tasks. **Lowest token cost** (no history replay).

### ② Persistent session — long collaboration / continuous diagnosis

Pass `session=<name>`. Calls with the same name **share context** — Hermes remembers earlier turns, so tasks don't need to be self-contained every time:

```
call_hermes(task: "Check server disk and note the preliminary findings", session: "server-triage")
call_hermes(task: "Continue: propose a cleanup plan based on the previous step", session: "server-triage")
call_hermes(task: "Continue: execute the cleanup and re-verify", session: "server-triage")
```

Best for: multi-step flows (check→analyze→execute→verify), long tasks needing cross-call memory.

Mechanism: `hermes chat --continue <name> --create-if-missing` — resumes the persistent session by name (creates it if missing), the "Bot Chat"-style continuous session on the Hermes side.

### ③ Reset session — start a new phase

Pass `reset_session=true` (with `session`): deletes the old session first, then recreates — context cleared:

```
call_hermes(task: "Start a new diagnosis round, re-check everything", session: "server-triage", reset_session: true)
```

Best for: reusing a session name for a new topic, preventing old-context contamination.

Mechanism: `hermes sessions list` finds the ID by title → `hermes sessions delete <id> --yes` → recreate the same-name session.

### Parameters

| Param | Type | Required | Description |
|---|---|---|---|
| `task` | string | ✅ | The task for Hermes (self-contained, explicit) |
| `session` | string | — | Persistent session name; omit = one-shot |
| `reset_session` | boolean | — | With session; true = delete old session and recreate |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `HERMES_BIN` | `hermes` | Hermes CLI path |
| `HERMES_TIMEOUT` | `600000` (10 min) | Per-call timeout in ms |

### Security

- `execFile` with an argument array (no shell interpretation) — injection-safe
- Truncation guard: >8000 chars returns only the tail with a notice
- Serial queue: concurrent calls queue up, avoiding Hermes overload

## Verification (2026-08-18)

| Scenario | Method | Result |
|---|---|---|
| One-shot | `call_hermes` without session | ✅ returns result, zero context residue |
| Persistent write | `session='bridge-clean'`, store `XJ-778899-2026` | ✅ |
| Control (one-shot) | ask the same value without session | ✅ "don't know" (proves not in mem0, rules out memory interference) |
| Experimental (persistent) | ask the same value with the same session | ✅ returned `XJ-778899-2026` (context-continuation proof) |
| Reset | store ALPHA-111 → `reset_session=true` store BETA-222 → ask | ✅ returned BETA-222 (old context cleared) |

## Dependencies

- Host has **Hermes Agent** installed (`hermes` CLI in PATH, or set `HERMES_BIN`)
- HD-side webhook subscription (`hd-events`): `hermes webhook subscribe hd-events ...` (platform port 8644, subscription-specific secret)
- Optional env vars: `DSH_HOME` (default `~/.dsh`), `HERMES_HOME` (default `~/.hermes`)

## Token Cost Optimization

Collaboration = two agents (~+80–100% cost), tiered:
- Simple Q&A / single command: don't involve the peer
- Routine dev: solo-first, peer reviews only key points
- Big tasks / important diagnostics: split + dual-view, **report token cost and let the user decide**
- Persistent sessions replay history (slightly higher tokens) — worth it only for long tasks

## License

MIT
