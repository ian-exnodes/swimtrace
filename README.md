# SwimTrace

A live flow of Claude Code subagents (who started whom, what each is doing, how it ended) in the band above the
prompt inside Claude Code and in a `swimtrace` terminal viewer.
Strictly observational: it never changes, blocks or slows what Claude Code does, never edits `settings.json`,
and never calls a model.

## Install

In a Claude Code terminal session:

```
/plugin install swimtrace --marketplace ian-exnodes/swimtrace
```

Answer `y` to add the marketplace and pick the user scope (every project). Then the viewer:

```
npm i -g swimtrace        # or, from a clone: npm i -g .
```

## Use

- The band in Claude Code and the `swimtrace` viewer both draw the agents as a flow, left to right, one line per node,
  through the stages of the main conversation's latest turn that dispatched agents:

  ```
  SWIMTRACE  proj  session e57186f5   5 agents

  [✓ request]─▶[✓ classify: complex 8s]─▶[⑂ route]─┬─ Explore ───▶[✓ [T1] list files 13s]
                                                   ├─ Explore ───▶[✓ [T2] count tests 10s]
                                                   └─ workflow ──▶[◆ review-wf]─┬─▶[✓ review:bugs 41s]─ ─▶[● verify:bugs · Grep 12s]
                                                                                └─▶[✗ review:perf 42s]
  Progress  tasks 3/5 done · 1 running · 3 done · 1 failed
  ```

  - **request** is the main conversation's turn: `[● request · Bash]` while it runs (with its current tool),
    `[✓ request]` once the turn is over. It stands for main: select it to see main's details. While main is still
    planning (no agent dispatched yet in this turn) the flow shows `[● request · Read]─▶[● plan 3s]`, with no route.
    A turn that ends without dispatching anything is not drawn.
  - **plan / classify** is the planning phase, from the start of the turn to its first dispatch: `[✓ plan 8s]`. If an
    Agent call's description carries a `[class:<word>]` tag (say `[T1] list files [class:complex]`), the node reads
    `classify: <word>` instead. The tag is the only classification SwimTrace shows, and it is never part of a label.
    Before any turn was seen (the mod was installed mid-session) the node has no time.
  - **route** branches once per dispatched agent (or workflow run), in start order. The label on each branch is the
    agent type chosen (`Explore`, `general-purpose`, `workflow`), so an agent's label drops a leading `<type> — `
    there (`[T1] Explore — list files` shows as `[T1] list files`). Why that type was chosen cannot be seen. When the
    flow is too wide for one row, the branches hang below the stages, from the left edge.
  - **Progress**, right under the flow, counts every agent of the session: tasks done (when Task tools are used),
    then running, done, failed (and waiting, stopped, unknown when any). The header keeps only the number of agents.
  - Earlier turns that dispatched agents are one dim line each under Progress, newest first:
    `◉ request #1 · 5 agents ✗ 1 failed 14s` (at most three, then `… 4 earlier turns`). Their agents are not drawn or
    selectable. `≤14s` means the turn's end was missed and the next turn's start bounds it. An earlier turn with an
    agent still running is drawn in full instead, so that agent stays in sight.

  An agent node is `[status label · current tool duration]`. A solid arrow means who started whom. `◆` is a workflow
  run: its agents hang off it. A dashed arrow (`─ ─▶`) is step order that SwimTrace infers from workflow labels shaped
  `<step>:<key>` (`verify:bugs` comes after `review:bugs`). It is a guess from the labels, not something Claude Code
  reports, and the details line says so. What one agent handed another (data flow) cannot be seen. Below 60 columns
  the flow becomes an indented tree (request, then plan, then route, then `Explore ▶ [agent]`). `g` switches to the
  pools view (lanes, see below) and back.
- In Claude Code the flow appears above the prompt once a subagent runs; `/swimtrace` hides or shows it, and
  ctrl+x ctrl+a collapses it. Keys (button hotkeys, after a click on the band or ctrl+x tab): `g` flow/pools,
  `r` running only, `j`/`k` select, `d` details (model and tools used, too), `n` other sessions.
- `swimtrace` in another terminal (a tmux split works well) follows the newest live session of the current directory.
  `swimtrace --all` starts at the session list. Keys: ↑/↓, Enter, `g`, `r`, `l` list, Tab, `q`.
  `q` exists only in the CLI.
- The band uses Claude Code's theme colors, so it is readable on light and dark themes; the terminal viewer uses your terminal's ANSI palette.
- `swimtrace sim fanout|failure|workflow|orchestrated|multi-session|crash [--speed N]` plays synthetic events (no
  tokens), marked `SIMULATED`. `N` must be a number greater than 0. `orchestrated` walks through the stages: a tagged
  dispatch, a workflow run with a failure, five tasks, then a second turn.

## Pools

The pools view (`g`) groups agents into lanes, one agent per line. First match wins, and every lane header says
where it came from:

1. `config` — rules in `~/.claude/swimtrace/config.json`
2. `explicit` — a `[pool:Name]` prefix in the Agent call's description
3. `workflow` — one lane per workflow run
4. `type` — the agent type
5. `main` — the main conversation

```json
{
  "rules": [
    { "match": { "type": "^(reviewer|code-reviewer)$" }, "pool": "Review" },
    { "match": { "description": "^\\[T\\d+\\] (\\S+)" }, "pool": "$1" },
    { "match": { "description": "^(\\w+):" }, "pool": "$1" }
  ],
  "staleWorkflowAgentMinutes": 10
}
```

`match` keys: `type`, `name`, `description`, `project` (regexes; all must match). `$1`… use the capture groups of
the first key (in that order) that has groups. Lanes are resolved when drawn, from the config at that moment,
so editing the config re-sorts existing agents. A workflow `agent()` label becomes its description; the last rule
above gives each `<step>` of a workflow its own lane in the pools view (the flow view chains the steps instead).
Unlabelled workflow agents show as `agent <n>`.

## What it can and cannot see

| Shown | From |
| --- | --- |
| start, end, duration, parent of every subagent | Claude Code's own agent events |
| completed / failed / interrupted | how each agent's run ended |
| killed, waiting | Claude Code's agent list (not for workflow agents) |
| current tool: the one in progress (name only); tools used (names, first 20) | tool-call events |
| model | the agent's spawn result |
| step order inside a workflow (dashed arrows) | inferred from `<step>:<key>` labels, never observed |
| main's turns (start, end; never the prompt) | Claude Code's turn events |
| plan / classify | timing (turn start to first dispatch), plus your optional `[class:<word>]` tag |
| route branches | the agent type each dispatch used; the reason for the choice is not observable |
| tasks: subject, status, blockers | only when the TaskCreate/TaskUpdate tools are used |

Shown as text: each Agent call's short description and each task's subject (from TaskCreate/TaskUpdate). Never
shown: progress percentages, prompts, other tool inputs, tool outputs, answers. A workflow agent silent for
`staleWorkflowAgentMinutes` shows `?` (unknown), never "done", and comes back if it calls a tool or finishes.
A session whose heartbeat stops (Claude Code crashed or was killed) shows `STALE`, and its agents show `?`
from then on, their durations ending at the last heartbeat.

## Data and uninstall

Snapshots: `~/.claude/swimtrace/sessions/<session>.json` (honours `CLAUDE_CONFIG_DIR`; an empty value counts as
unset). The `swimtrace` viewer prunes snapshots older than 7 days when it starts; the mod does not.

```
/plugin uninstall swimtrace
npm rm -g swimtrace
swimtrace clean           # run before uninstalling the CLI to delete ~/.claude/swimtrace
```

`swimtrace clean` refuses to delete anything unless the target is an absolute path ending in `swimtrace` that holds
only `sessions/`, `sim/` and `config.json`; anything else in it (say, a folder of your own that shares the name)
makes it refuse and name what it found.

## Requirements and limits

Claude Code 2.1.296 or newer (the mod API is early access and may change), Node 22.6+. The band takes at most half the
terminal's height and scrolls past that. Remote (cloud) agents have no local events. Local machine only.
The viewer restores your terminal if it hits an error. If another session's file in the band is malformed, the
band falls back to the current session and says "unreadable".
