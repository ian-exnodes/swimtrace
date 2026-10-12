# SwimTrace — Multi-Agent Swimlane Monitor: Design

Date: 2026-10-12 · Status: approved in conversation, pending written-spec review
Repo: `git@github.com:ian-exnodes/swimtrace.git` · Target: Claude Code 2.1.296+

## 1. Goal

A reusable, globally installed, strictly observational monitor that shows Claude Code multi-agent
execution as swimlanes: which agents run, in which lane, in parallel or not, how long, and whether
they completed, failed, were interrupted, or are in an unknown state. It works in any project, never
alters execution, never edits `settings.json`, never calls a model, and fails open.

Users: the developer watching their own sessions (one machine, one or more concurrent sessions).
Success: during a fan-out, a glance answers "what is running, done, failed or stuck, per lane, and for
how long" — with no state, pool, progress or dependency shown that was not actually observed.

Decisions taken during brainstorming:

| Decision | Choice |
| --- | --- |
| UI location | Both: an in-session mod pane and a standalone `swimtrace` CLI, sharing one layout core |
| Default lanes | Layered rules (config → explicit tag → workflow run → agent type), each lane labelled with its source |
| Architecture | Approach A: mod collector → per-session snapshot files → pure shared layout core |
| CLI rendering | Plain ANSI + `node:readline` keypresses, no Ink/Blessed, zero runtime dependencies |

## 2. Research findings — Claude Code runtime

Source of truth: the engine's own API declaration for build 2.1.296 (`claude-code.d.ts`, written by
the bundled plugin-authoring skill; line numbers below refer to that file).

- **Native mods.** A mod is a plugin folder whose `hooks/hooks.json` names one TypeScript hooks
  module exporting `register(on, options)`. Hooks are `($, e, next)`, run in-process in an isolated
  environment (no Node, no DOM; everything via `$`). A hook that throws is skipped and the chain
  continues — fail-open is the engine's default. Installed with `/plugin install`, no settings edits.
- **Subagent spawn.** `agent.spawn` fires for every Agent-tool spawn, teammate, and workflow-script
  `agent()` (`:255-380`). Input: `description`, `subagentType`, `parentAgentId` (absent = main loop),
  `name`, `background`, `fork`, `workflow?: { runId, agentIndex }`. The agent id is **not** on the
  input; it is in the result of `next(e)` (`AgentSpawnResult.agentId`, `:392-414`).
- **Agent status.** `$.agent.list()` returns `AgentInfo { id, type, description, status, parentId,
  name }` with `status ∈ pending | running | waiting | idle | completed | failed | killed`
  (`:124-183`, `:545`). Workflow agents are **not** listed (`:3188-3194`).
- **Run end.** `turn.complete` carries `agentId` (absent = main), `durationMs`, `isAborted`,
  `reason ∈ answer | aborted | refusal | error` (`:13285-13340`).
- **Activity.** `tool.call` carries `tool` and `agentId` for every tool call in every loop.
- **Sessions.** `session.start`; `session.end { reason, sessionId }` — `/clear` ends a session and
  continues under a new id with no `session.start` (`:11057-11070`). A crash or SIGKILL fires nothing.
- **Tasks.** The `TaskCreate`/`TaskUpdate` tools carry `subject`, `status`, `addBlockedBy`,
  `addBlocks`, `metadata` (`:16707-16750`); classic `TaskCreated`/`TaskCompleted` hooks also exist.
- **Classic hooks** (`SubagentStart`/`SubagentStop` with `agent_id`, `agent_type`,
  `agent_transcript_path`) are reachable as `classic.*` events; not needed given the native events.
- **Panes.** `$.ui.open({ id, title })` + a `ui.render` hook on `Pane`. Opened unasked it docks only
  from 144 columns (110 once the user opened that id before); opened from a command it docks at any
  width (`:2490`). The engine draws it, so it cannot conflict with Claude Code's terminal rendering.
- **Storage.** `$.state` (session values that survive hot reload, subscribed by renders),
  `$.store` (per-plugin JSON, 4 MiB), `$.fs.write(path, text)` (whole-file, no append, `:3256`),
  `$.env.get("HOME")` (`:3603`), `$.clock.every`.

## 3. Research findings — reference scaffold (`En-Nam/ennam-agents-scaffold`)

Read-only clone; nothing installed or modified. The monitor does not depend on it.

- Delegation: `.claude/agents/*.md` roles (`orchestrator` → `implementer` → `reviewer` via the
  Task tool) and workflow scripts (`review-changes.js`, `judge-panel.js`, `fix-loop.js`) calling
  `agent(prompt, { label, phase, agentType })` inside `pipeline()`/`parallel()`.
- Stages: machine-readable only inside workflow scripts (`meta.phases`, per-call `phase:`); markdown
  phase presets elsewhere.
- Pools: **not found.** Nearest groupings are workflow `phase`/`label` strings and agent types.
- Task dependencies: **not declared**; implied by script control flow and prose.
- Instrumentation: one `SubagentStop` command hook appending `<timestamp> SubagentStop <role>` to a
  markdown log; no start event, no JSONL.
- Consequence: pools must come from configurable rules and opt-in tags; nothing may be assumed.

## 4. Observability capability matrix

| Feature | Directly observable | Inferable | Needs opt-in instrumentation | Not reliably observable |
| --- | --- | --- | --- | --- |
| Agent started (id, type, description, parent) | ✓ `agent.spawn` + `next` result | | | |
| Agent completed / failed / interrupted | ✓ `turn.complete.reason` | | | |
| Agent killed | ✓ `$.agent.list()` status (non-workflow) | | | |
| Agent waiting / idle | ✓ `$.agent.list()` status (non-workflow) | | | |
| Workflow agent end | ✓ `turn.complete` with its id | | | |
| Workflow agent stuck/killed | | staleness → `unknown` | | exact state |
| Parent–child relationship | ✓ `parentAgentId` | | | |
| Current activity (tool name per agent, the one in progress) | ✓ `tool.call` | | | |
| Execution duration | ✓ spawn time → `turn.complete` | | | |
| Session start / end | ✓ `session.start` / `session.end` | | | |
| Session crashed / killed | | heartbeat staleness → `stale` | | cause |
| Workflow run grouping | ✓ `workflow.runId` | | | |
| Workflow `phase` / `label` per agent | | spike: does `description` carry `label`? | | otherwise not observable |
| Explicit pool membership | | | `[pool:Name]` description prefix | |
| Logical pool (rules) | | ✓ config rules on type/description/name/project | | |
| Task list and dependencies | ✓ when `TaskCreate`/`TaskUpdate` are used | | | |
| Task dependencies without Task tools | | | | ✗ |
| Agents not yet spawned ("pending" lanes) | | | via Task tools (pending tasks) | ✗ otherwise |
| Progress percentage | | | | ✗ never shown |
| Multiple concurrent sessions | ✓ one snapshot file per session | | | |

## 5. Architecture

```
Claude Code session(s)                         filesystem                      viewers
┌───────────────────────────────┐   write ≤4/s   ~/.claude/swimtrace/     ┌──────────────────┐
│ swimtrace mod                 │   + heartbeat  ├─ config.json  ───────► │ in-session pane  │
│  collector hooks ─► reducer ─►│ ─────────────► ├─ sessions/<id>.json ─► │ swimtrace CLI    │
│  $.state (live) ─► layout ─► Pane              └─ sim/<id>.json ──────► │ (fs.watch, ANSI) │
└───────────────────────────────┘                                         └──────────────────┘
```

Repository layout:

```
swimtrace/
  .claude-plugin/marketplace.json     # makes the repo a marketplace: source "./mod"
  mod/                                # the Claude Code mod
    .claude-plugin/plugin.json
    types/index.d.ts                  # $.state contract
    hooks/hooks.json, register.tsx    # collector, snapshot writer, pane, /swimtrace command
    core/                             # pure TS: no node:*, no $ — shared with the CLI
      model.ts  reducer.ts  pools.ts  layout.ts
    test/*.test.ts                    # claude plugin test
  cli/                                # Node CLI, imports ../mod/core
    main.ts  snapshots.ts  term.ts  sim.ts
    test/*.test.ts                    # node:test
  package.json, tsconfig.json         # tsc build → dist/ for the npm bin
```

`core/` lives under the mod because a mod may only statically import files inside its own folder.
The CLI imports from `mod/core`; never the reverse. The CLI is compiled with `tsc` because Node does
not strip types under `node_modules` (global install).

### 5.1 Data model (`core/model.ts`)

```ts
type Status = 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'killed' | 'unknown'
type PoolSource = 'config' | 'explicit' | 'workflow' | 'type' | 'main'

interface Agent {
  id: string                // 'main' for the main loop
  parentId?: string
  type: string
  description: string       // the Agent call's short description (a few words)
  name?: string
  workflowRunId?: string
  status: Status
  startedAt: number         // ms epoch
  endedAt?: number
  endReason?: 'answer' | 'aborted' | 'refusal' | 'error' | 'killed' | 'stale' | 'session-end'
  currentTool?: string      // tool NAME only: the tool in progress (set as it starts, kept until the next one or the run's end)
  lastSeenAt: number
}

interface Task { id: string; subject: string; status: 'pending' | 'in_progress' | 'completed'; blockedBy: string[] }

interface Snapshot {
  v: 1
  simulated: boolean
  session: { id: string; project: string; startedAt: number; endedAt?: number; endReason?: string }
  writtenAt: number
  agents: Agent[]           // at most 200 finished + all live
  tasks: Task[]
  workflows: Record<string, string>   // runId → workflow meta.name
  folded: { completed: number; failed: number; interrupted: number; killed: number; unknown: number }
}
```

Pools are not stored on `Agent`: they resolve at render time via `resolvePool` with the current config.

**Privacy rule (data model, not renderer):** a snapshot never contains prompt text, tool input, tool
output, or answer text. `description` is the Agent call's short task label, which the user already
sees in Claude Code's own UI. The one piece of tool input kept is a task's `subject` (from
`TaskCreate`/`TaskUpdate`), plus tool names and a workflow's `meta.name`. Rendered text has control characters stripped, and rows are clipped by
terminal cells.

### 5.2 Reducer (`core/reducer.ts`)

`reduce(snapshot, event, config): Snapshot` — pure. Events are a small internal union produced by
the collector (or the simulator):

`spawn | toolCall | runEnd | mainTurn | listStatus | taskCreate | taskUpdate | workflowName | sessionEnd | tick`

Rules:
- Events missing required fields are dropped. Duplicate `spawn` for a known id is ignored; a
  `runEnd` for an unknown id is ignored (the agent list heals missed spawns).
- `runEnd.reason`: `answer` → `completed`; `error`/`refusal` → `failed`; `aborted` → `interrupted`.
- `listStatus` (from `$.agent.list()`): `killed` → `killed`; `failed`/`completed` → set when no
  `runEnd` was seen; `waiting`/`idle` → `waiting`; `running`/`pending` → `running`.
- `mainTurn`: `start` → `main` running; `end` → `main` waiting (never completed; `main` ends with the session).
- `tick(now)`: a workflow-run agent still `running` with `lastSeenAt` older than 10 minutes becomes
  `unknown` with `endReason: 'stale'` (never `completed`). Such an agent is only presumed gone: its own
  later `toolCall` revives it to `running`, and its `runEnd` sets the real end. An ended session marks its
  remaining live agents `unknown` with `endReason: 'session-end'` (main: `completed`), and that is final.
- When finished agents exceed 200, the oldest fold into `folded` counters.

### 5.3 Collector (`mod/hooks/register.tsx`)

Every hook is observation-only: it returns `next(e)`'s result unchanged and does its bookkeeping inside
`try/catch`, after `next(e)` settled. One exception: `tool.call` starts recording the tool's name beside
`next(e)` (never awaited before it, so the call is not held up) and awaits that once `next(e)` settled, so
an agent's current tool is the one in progress; what the result adds is recorded after.

| Hook | Records |
| --- | --- |
| `session.start` | session id, project (`$.session.cwd()`), reads `config.json` (the one disk read in a hook), registers `/swimtrace`, starts timers |
| `agent.spawn` | after `next(e)` resolves with `agentId`: `spawn` with `parentAgentId`, `subagentType`, `description`, `name`, `workflow?.runId` |
| `tool.call` | as the tool starts: `toolCall { agentId ?? 'main', tool }`; once it settled (not refused, not an error): for `TaskCreate`/`TaskUpdate`, `taskCreate`/`taskUpdate` from input + result; for `Workflow`, `workflowName` from its result |
| `turn.start` | main loop only: `main` → `running` |
| `turn.complete` | subagent: `runEnd { agentId, reason, durationMs }`; main loop: `main` → `waiting` (idle between turns), never `completed` — `main` ends only with the session |
| `session.end` | `sessionEnd`; force-writes the final snapshot (the one disk write inside a hook, so `endedAt` survives exit); a `/clear` makes the next event open a new snapshot under the new id |
| `$.clock.every(1000)` | `$.agent.list()` → `listStatus` per agent; `tick(now)` |

`toolCall` and `runEnd` for never-seen ids are ignored; a missed spawn heals via the agent list.

State lives in `$.state` (`swimtrace.snapshot`) so the pane re-renders on change and a hot reload
keeps it.

### 5.4 Snapshot writer

- Path: `${CLAUDE_CONFIG_DIR ?? HOME + '/.claude'}/swimtrace/sessions/<sessionId>.json`, resolved
  via `$.env.get`.
- Written from a timer, never inside a hook, with one exception: `session.end` forces a final write
  (§5.3), since the process may exit right after it. Otherwise at most every 250 ms when state changed,
  and a heartbeat (refresh `writtenAt`) every 5 s regardless.
- Readers treat `writtenAt` older than 15 s on a session without `endedAt` as `stale`, and draw its
  live agents (main included) as `unknown`, their durations ending at `writtenAt`. This happens when
  drawing (`layout`); the snapshot itself is not changed.

## 6. Pool resolution (`core/pools.ts`)

First match wins; the lane records its source:

1. **config** — rules from `~/.claude/swimtrace/config.json`, in order:
   ```json
   { "rules": [
       { "match": { "type": "^(reviewer|code-reviewer)$" }, "pool": "Review" },
       { "match": { "description": "^\\[T\\d+\\] (\\S+)" }, "pool": "$1" },
       { "match": { "project": "c4k", "type": "frontend" }, "pool": "Frontend" } ],
     "staleWorkflowAgentMinutes": 10 }
   ```
   `match` keys (`type`, `description`, `name`, `project`) are regexes, all must match; `pool` may
   use capture groups. Invalid regexes are skipped with a one-time warning; a missing or invalid
   file means no rules.
2. **explicit** — a `[pool:Name]` prefix in the Agent call's `description` (opt-in convention any
   orchestrator can adopt without code changes).
3. **workflow** — the workflow run, named by its `meta.name` (from the `Workflow` tool result),
   falling back to the run id.
4. **type** — the agent type.
5. **main** — the main loop always has its own lane.

Lane headers show the source (`REVIEW · config`, `Explore · type`). The agent view ignores pools
and shows one row per agent, indented under its parent.

## 7. Terminal swimlane UI

`layout(snapshot, view, { width, height, selection, now, zoom }): Row[]` — pure; a `Row` is a list
of `{ text, fg?, bold?, dim?, inverse? }` segments. The pane maps segments to `Box`/`Text`; the CLI
maps them to ANSI.

```
SWIMTRACE  project: c4k-mobile  session: 3f2a…  [SIMULATED]
time 0s ─────────────── 1m ─────────────── 2m ──────────────▶ now
MAIN · main
  [main ● Agent]────────────────────────────────────────────
REVIEW · config
          [code-reviewer ✓ 48s]
          [security-review ● 1m02s]
Explore · type
                     [Explore ✗ 12s]
Tasks: T1 ✓ Plan · T2 ● Implement (blocks T3) · T3 ◌ Review (blocked by T2)
Running 2 · Waiting 1 · Done 1 · Failed 1 · Unknown 0
```

- Time axis fits earliest visible start → now; `+`/`-` set a fixed window.
- Concurrent agents in one lane pack onto separate rows (interval packing) — parallelism is visible.
- Status is glyph and colour: ● running, ◌ waiting, ✓ completed, ✗ failed, ■ interrupted/killed,
  ? unknown.
- Below 60 columns: compact list (lane → agent, status, duration), no timeline.
- Tasks strip only when Task tools were used; "pending" appears only there.
- Keys: ↑/↓ select · Enter details (id, parent, type, pool + source, current tool, start/end, end
  reason) · `g` pool/agent view · `r` running only · `+`/`-` zoom · Tab next session (CLI) · `q`
  quit (CLI). In the pane the keys are button hotkeys: `g` pools/agents, `r` running only, `j`/`k` select,
  `d` details, `n` other sessions. Zoom and `q` are CLI-only.

**Pane:** `/swimtrace` opens it (docks at any width); a session switcher reads other snapshot files
with `$.fs`. Not opened unasked.

**CLI:** `swimtrace` follows the newest live session whose project is the current directory;
`swimtrace --all` starts at a session list; `swimtrace sim <scenario>` (§8); `swimtrace clean`
deletes `~/.claude/swimtrace/`. Alternate screen, line-diff repaint, redraw on `SIGWINCH`,
`fs.watch` on the sessions folder with a 1 s poll fallback, last-good-snapshot on parse errors,
unknown `v` skipped with a notice.

## 8. Simulation mode

`swimtrace sim [fanout | failure | workflow | multi-session | crash]` feeds scripted events through
the real `core/reducer.ts`, writes snapshots with `simulated: true` to `~/.claude/swimtrace/sim/`,
and opens the viewer on them with a `SIMULATED` badge. Simulated snapshots never live in
`sessions/` and are never shown with real sessions. No tokens are spent.

## 9. Installation and uninstallation

| | Mod | CLI |
| --- | --- | --- |
| Install | `/plugin install swimtrace --marketplace ian-exnodes/swimtrace` (user scope → every project) | `npm i -g swimtrace` or `npm i -g .` from the repo |
| Uninstall | `/plugin uninstall swimtrace` | `npm rm -g swimtrace` |
| Data | `swimtrace clean` removes `~/.claude/swimtrace/` | |

Snapshots older than 7 days are pruned by the CLI viewer at start. `swimtrace clean` refuses to delete
unless the target is an absolute path ending in `swimtrace` that holds nothing but `sessions/`, `sim/`
and `config.json` (on a case-insensitive disk `~/swimtrace` is also an unrelated `~/SwimTrace`); a missing
folder is nothing to delete.

No step reads or writes `settings.json`, project files, or existing hooks.

## 10. Error handling and fail-open

- Collector hooks never change or refuse what they observe; bookkeeping errors are caught; disk I/O
  is off the hook path, but for `session.start` reading `config.json` and `session.end`'s final write
  (§5.3, §5.4). If the mod itself fails, the engine skips its hooks.
- The CLI is read-only on Claude Code's side; its own crash affects nothing else.
- Malformed events dropped; malformed snapshot → keep last good; unknown version → skip.
- Unexpected termination → heartbeat staleness → session `stale`, its running agents drawn `unknown`
  (render time, §5.4).
- Restart → the CLI rebuilds from snapshots; a mod hot reload keeps `$.state`.

## 11. Testing

| # | Case | Test |
| --- | --- | --- |
| 1 | Single agent | reducer unit test (`node:test`) |
| 2 | Concurrent subagents | reducer test + layout packs rows in one lane |
| 3 | Completion | reducer test |
| 4 | Failure / interruption | `runEnd` error → failed, aborted → interrupted; `listStatus` killed |
| 5 | Missing pool metadata | resolver tests per layer and the type fallback |
| 6 | Multiple sessions | CLI snapshot aggregation test |
| 7 | Unexpected termination | staleness test with injected `now` |
| 8 | Malformed events / snapshots | reducer drop/dedupe tests; CLI parse tests |
| 9 | Terminal resize | layout at 40 / 80 / 200 columns (compact vs timeline) |
| 10 | Monitor restart | CLI rebuild from files; `claude plugin test` state survives reload |

Mod tests (`claude plugin test`): spawn → tool.call → turn.complete through the hooks; pane mounts
on the `terminal` surface; fail-open — with `$.fs.write` throwing, a tool call's result is returned
unchanged. One real validation run (two parallel Explore agents), run only with the user's OK.

## 12. Known limitations and risks

- **API maturity:** the mod API is early access and changes between releases; pin the tested build
  in `plugin.json` docs and re-run `claude plugin validate` on upgrades.
- **Workflow agents** are absent from `$.agent.list()`; their killed/stuck state is only inferable
  (→ `unknown` after 10 min idle).
- **Per-agent workflow phase/label** may not be observable (spike S2).
- **CLI freshness** is bounded by the 250 ms write interval; the pane is live.
- **Pane width:** docks unasked only at ≥144 columns; we never open it unasked.
- **Remote/cloud agents** (`isolation: 'remote'`) have no local loop events; shown at most as spawned.
- **Single machine:** snapshots are local files; no cross-machine view.

## 13. Spikes (first plan tasks, before dependent work)

- **S1** — `$.fs.write` to an absolute path under `~/.claude/swimtrace/` from a mod: no prompt, no
  refusal. Fallback if refused: per-session keys in `$.store` (4 MiB cap; concurrent sessions may
  overwrite each other — degraded mode, documented).
  Result (2026-10-12): PASS. A headless run (`claude -p --plugin-dir <spike>`) fired `session.start`;
  `$.fs.write` created `~/.claude/swimtrace/spike/s1.json` (`{"ok":true,...}`) with no prompt and no
  refusal. No fallback needed.
- **S2** — whether a workflow agent's `description` in `agent.spawn` carries the script's `label`.
  If yes, a built-in rule can expose it; if no, matrix row stays "not observable".
  Result: pending — deferred to the real validation run (plan Task 12).

## 14. Implementation outline (detailed plan follows via writing-plans)

1. Spikes S1, S2: S1 ran via a headless `--plugin-dir` run; S2 is deferred to the real validation run.
2. `core/model.ts` + `core/reducer.ts` with tests (cases 1–4, 7, 8).
3. `core/pools.ts` with tests (case 5).
4. `core/layout.ts` with tests (cases 2, 9).
5. Mod: collector, `$.state` contract, snapshot writer, plugin tests (fail-open, case 10).
6. Mod: pane + `/swimtrace` command.
7. CLI: snapshot reader/watcher, ANSI renderer, keys, session switching (cases 6, 10).
8. CLI: `sim` scenarios and `clean`.
9. Packaging: marketplace.json, npm bin, README (install, config, privacy, limitations).
10. Real validation run (with user OK).
