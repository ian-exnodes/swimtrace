# SwimTrace

A live flow of Claude Code subagents (who started whom, what each is doing, how it ended) in the band above the
prompt inside Claude Code and in a `swimtrace` terminal viewer.
Strictly observational: it never changes, blocks or slows what Claude Code does, never edits `settings.json`,
and never calls a model.

## Install

SwimTrace has two parts. The **plugin** draws the flow above the prompt inside Claude Code. The **`swimtrace` CLI**
(optional) draws the same flow in another terminal. Needs Claude Code 2.1.296+ and Node 22.6+.

1. The plugin, in a Claude Code terminal session:

   ```
   /plugin install swimtrace --marketplace ian-exnodes/swimtrace
   ```

   Answer `y` to add the marketplace and pick the user scope (every project). It is active right away.

2. The viewer (optional), from your shell:

   ```
   git clone https://github.com/ian-exnodes/swimtrace.git
   cd swimtrace && npm i && npm i -g .
   ```

   `npm i` builds the CLI. `npm i -g .` links that folder as the global `swimtrace` command, so keep the clone.
   It is not on the npm registry yet, and `npm i -g github:ian-exnodes/swimtrace` fails (npm skips the build tools
   when it prepares a git dependency globally).

3. Try it without spending tokens:

   ```
   swimtrace sim orchestrated
   ```

   Then try the sample prompts below in Claude Code and watch the band fill in.

## Sample prompts

Paste these into Claude Code in any repository. They go from cheapest to biggest, and each shows a different part
of the flow. Run `swimtrace` in a second terminal (a tmux split works well) to watch the same flow there.

**1. Fan-out (about 1 minute)**

```
Use 3 Explore agents in parallel: one lists the top-level folders and what each is for, one finds the test setup and how to run tests, one finds the main entry point. Then give me a 5-line summary.
```

The band shows `request`, then `plan`, then `route` branching into three Explore agents.

**2. Classify tag and pools (1–2 minutes)**

```
Dispatch 3 agents in parallel. Put these exact strings in each Agent description:
"[pool:Docs] [T1] Explore — summarise the README [class:simple]",
"[pool:Code] [T2] Explore — find the 3 largest source files [class:simple]",
"[pool:Code] [T3] general-purpose — list TODO comments with file:line [class:simple]".
```

The plan stage reads `classify: simple`. Press `g` for the pools view, where the agents are grouped into the Docs
and Code lanes.

**3. Task progress (2–3 minutes)**

```
Create 4 tasks with TaskCreate: map folders, find tests, find config files, write summary. Run the first 3 as parallel Explore agents and mark each task done as it finishes, then do the summary yourself and mark it done.
```

`Progress` counts up to `tasks 4/4 done`.

**4. Workflow with step order (about 5 minutes, the most tokens)**

```
Use a workflow: review this repo in two dimensions, bugs and readability. Label the agents review:bugs, review:readability, then verify:bugs, verify:readability to double-check each review's findings.
```

A `◆` workflow node fans out its agents, and dashed arrows run from each `review:<key>` to its `verify:<key>`.
Claude Code runs a workflow only when you ask for one in your own words, which is why the prompt says
"use a workflow".

### Testing the panes viewer

These prompts exercise the multi-pane `swimtrace` viewer. Keep it open in a terminal of at least 100×20.

**5. Many agents (about 2 minutes)**

```
Dispatch 8 Explore agents in parallel, each with a short description: list folders, find tests, find config, find the entry point, count files per extension, find the largest file, list dependencies, find the README headings. Then give me one line from each.
```

The flow is taller than its pane and is cut at the bottom, and the frame stays whole. A click on a node near the bottom
selects it and Details follows; ↑/↓ step through the same agents.

**6. Model and tools in Details (about 1 minute)**

```
Run 2 agents in parallel: an Explore agent with model haiku that lists the top-level folders, and a general-purpose agent with model sonnet that reads package.json and lists the scripts. Then summarize.
```

Click each node. Details shows a different `model` for each agent, and fills `tools` as they work; while one runs,
`tool` shows its current tool.

**7. An interrupted agent (about 1 minute, you press Esc)**

```
Use one general-purpose agent to read every source file in this repo one by one and describe each in detail.
```

Press Esc after about 10 seconds. The node should turn `■` (stopped), with `reason aborted` in Details. `r` (running
only) hides it, and Details goes back to main.

**8. Long labels and wide characters (about 1 minute)**

```
Dispatch 2 Explore agents in parallel with these exact descriptions: "[T1] Explore — find every place where configuration is loaded, parsed, validated and merged with defaults across the whole codebase" and "[T2] Explore — tìm các tệp kiểm thử 測試ファイル".
```

Long labels are cut with `…` and never push the right column. The borders stay aligned around Vietnamese and CJK text,
and a click on a wide character still selects the right node.

**9. Two sessions**

Start Claude Code in a second repository and run prompt 1 there while the first session is live. Sessions lists both
and highlights the current one. A click on the other row switches the flow and resets the selection to main; `l` opens
the full list, where a click opens a session too.

**10. Several turns (about 2 minutes)**

Send prompt 1, wait for it to finish, then send:

```
Now use 2 Explore agents: one finds TODO comments, one finds the longest function.
```

The first turn shrinks to one dim `◉ request #1 · 3 agents` line; only the new turn's agents can be clicked.

**Without tokens:** `swimtrace sim failure` shows a failed node and its `reason`, `swimtrace sim multi-session` fills
Sessions, `swimtrace sim crash` checks that the screen and mouse mode are restored, and
`swimtrace sim orchestrated --speed 0.3` is slow enough to see that the flow holds still while main works.

**Resizing:** below 100 columns or 20 rows the viewer drops to the single column, and returns to panes when the window
grows back. From about 140 columns the flow fits on one row. With `--no-mouse`, plain drag selects text again.

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
  `q` exists only in the CLI. On a terminal of at least 100×20 the viewer splits into panes: the flow on the left,
  Details (the selected agent, or main) and Sessions on the right, the keys along the bottom; Enter does nothing
  there, since Details is always shown. Smaller, it is the single column above.
  Click an agent to select it, or a session (in Sessions or the `l` list) to open it. While the viewer runs,
  the terminal's own text selection needs Shift-drag (Option-drag in iTerm2); `swimtrace --no-mouse` turns clicks off.
- The band uses Claude Code's theme colors, so it is readable on light and dark themes; the terminal viewer uses your terminal's ANSI palette.
- `swimtrace sim fanout|failure|workflow|orchestrated|multi-session|crash [--speed N]` plays synthetic events (no
  tokens), marked `SIMULATED`. `N` must be a number greater than 0. `orchestrated` walks through the stages: a short
  first request (it folds to one line), then a tagged dispatch, a workflow run with a failure and five tasks, ending
  on the full route fan-out.

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
swimtrace clean           # run first: deletes ~/.claude/swimtrace
npm rm -g swimtrace
```

`swimtrace clean` refuses to delete anything unless the target is an absolute path ending in `swimtrace` that holds
only `sessions/`, `sim/` and `config.json`; anything else in it (say, a folder of your own that shares the name)
makes it refuse and name what it found.

## Requirements and limits

Claude Code 2.1.296 or newer (the mod API is early access and may change), Node 22.6+. The band takes at most half the
terminal's height and scrolls past that. Remote (cloud) agents have no local events. Local machine only.
The viewer restores your terminal if it hits an error. If another session's file in the band is malformed, the
band falls back to the current session and says "unreadable".
