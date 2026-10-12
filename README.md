# SwimTrace

Live swimlanes of Claude Code subagents — in a pane inside Claude Code and in a `swimtrace` terminal viewer.
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

- `/swimtrace` in Claude Code opens the pane. Keys (button hotkeys, while the pane has focus): `g` pools/agents,
  `r` running only, `j`/`k` select, `d` details, `n` other sessions.
- `swimtrace` in another terminal (a tmux split works well) follows the newest live session of the current directory.
  `swimtrace --all` starts at the session list. Keys: ↑/↓, Enter, `g`, `r`, `+`/`-` zoom, `l` list, Tab, `q`.
  Zoom and `q` exist only in the CLI.
- The pane uses Claude Code's theme colors, so it is readable on light and dark themes; the terminal viewer uses your terminal's ANSI palette.
- `swimtrace sim fanout|failure|workflow|multi-session|crash [--speed N]` plays synthetic events (no tokens),
  marked `SIMULATED`. `N` must be a number greater than 0.

## Lanes

First match wins, and every lane header says where it came from:

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
so editing the config re-sorts existing agents. A workflow `agent()` label becomes its description, so labels
shaped `<step>:<key>` can be pooled by the last rule above; unlabelled workflow agents show as `agent <n>`.

## What it can and cannot see

| Shown | From |
| --- | --- |
| start, end, duration, parent of every subagent | Claude Code's own agent events |
| completed / failed / interrupted | how each agent's run ended |
| killed, waiting | Claude Code's agent list (not for workflow agents) |
| current tool: the one in progress (name only) | tool-call events |
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

Claude Code 2.1.296 or newer (the mod API is early access and may change), Node 22.6+. The pane docks beside the
transcript when opened with `/swimtrace`. Remote (cloud) agents have no local events. Local machine only.
The viewer restores your terminal if it hits an error. If another session's file in the pane is malformed, the
pane falls back to the current session and says "unreadable".
