# SwimTrace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build SwimTrace — a Claude Code mod that observes multi-agent execution and writes per-session snapshots, plus a `swimtrace` CLI — both rendering the same swimlane layout.

**Architecture:** A pure TypeScript core (`mod/core/`: model, reducer, pools, layout) is shared. The mod's hooks turn engine events into core `Event`s, fold them into a `Snapshot` held in `$.state`, draw it in a pane, and write it to `~/.claude/swimtrace/sessions/<id>.json` on a timer. The CLI reads those files and draws the same `layout()` rows with ANSI.

**Tech Stack:** TypeScript 5.8+, Claude Code 2.1.296 mod API (`claude-code`, `claude-code/testing`), Node 24 (`node:test`, `node:fs`, `node:readline`), no runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-12-swimtrace-design.md`

**Mod API reference (this build):** `/private/tmp/claude-501/bundled-skills/2.1.296/d149e208a88ccb19d3dfb079d6835f9c/plugin-authoring/types/claude-code.d.ts` (grep it for any name used below), examples beside it in `../examples/`. After the mod is first loaded, the same types are laid at `mod/.claude-plugin/types/`.

## Spec clarifications (decided while planning; spec §5.1, §5.3 amended by Task 11)

1. **Pools resolve at render time, not at spawn.** `Agent` has no stored `pool`; `layout()` calls `resolvePool()` with the current config. Config edits then apply live, and a workflow's name that arrives after its agents still labels their lane.
2. **The CLI prunes snapshots older than 7 days**, not the mod: the mod API has `$.fs.write/read/list/stat` but no delete.
3. **A `runEnd` or `toolCall` for an agent id never seen is ignored.** Engine-internal forks (compaction, memory) carry ids no list names and would otherwise appear as noise rows. A missed spawn is healed instead by `listStatus`, which carries the agent's type, description and parent from `$.agent.list()`.
4. **The pane's keys are button hotkeys** (`g` view, `r` running only, `j`/`k` select, `d` details, `n` next session), because a pane hotkey must be one digit or lowercase letter. Arrow keys and Tab walk the buttons. Zoom (`+`/`-`) and `q` are CLI-only.
5. **Counters exclude `main`.** The footer counts delegated agents only.

## Global Constraints

- Strictly observational: every mod hook awaits `next(e)` and returns its result unchanged; bookkeeping runs after, inside `try/catch`.
- Never store prompt text, tool input, tool output or answer text in a `Snapshot`. Tool **names** only.
- Never read or write `settings.json`, project files or existing hooks.
- No model calls, no network calls, no runtime npm dependencies (devDependencies: `typescript`, `@types/node`).
- `mod/core/**` imports nothing from `node:*` and nothing from `claude-code`; relative imports carry the `.ts` extension.
- Only erasable TypeScript syntax (no `enum`, no parameter properties, no `namespace`) so Node 24 can run tests and the CLI from source.
- Snapshot location: `${CLAUDE_CONFIG_DIR ?? $HOME/.claude}/swimtrace/sessions/<sessionId>.json`; simulated: `.../swimtrace/sim/`; config: `.../swimtrace/config.json`.
- Snapshot write ≤ every 250 ms when changed; heartbeat every 5 s; a live session whose `writtenAt` is older than 15 s is `stale`.
- At most 200 finished agents per snapshot; older ones fold into counters.
- Workflow agents with no event for `staleWorkflowAgentMinutes` (default 10) become `unknown`.
- Compact list layout below 60 columns.
- Status glyphs: ● running, ◌ waiting, ✓ completed, ✗ failed, ■ interrupted/killed, ? unknown.
- No progress percentages anywhere.

## Review Focus

1. **A session that `/clear`s mid-run** — the old snapshot must end and the next event must open a new file under the new session id, not keep writing the old one. Test in Task 6.
2. **An agent spawned before the mod loaded (or a hot reload mid fan-out)** — it must appear (via `listStatus`) rather than be silently missing. Test in Task 2.
3. **A half-written snapshot file read by the CLI** — keep the last good one, never crash or blank the screen. Test in Task 8.
4. **A config regex that is invalid or catastrophic-looking** — skipped with a warning; all other rules still apply. Test in Task 4.
5. **A very long agent description / name in a narrow terminal** — every row is clipped to the width; nothing wraps or breaks the layout. Test in Task 5.

---

## File map

```
package.json                     # scripts, bin, devDeps
tsconfig.json                    # typecheck core + cli + tests (noEmit)
tsconfig.build.json              # emit cli + core to dist/
.gitignore
.claude-plugin/marketplace.json  # the repo as a marketplace → ./mod
mod/
  .claude-plugin/plugin.json
  types/index.d.ts               # $.state contract
  hooks/hooks.json
  hooks/register.tsx             # collector + writer + pane + command
  hooks/events.ts                # engine input → core Event mapping (pure)
  core/model.ts                  # types, constants, emptySnapshot
  core/reducer.ts                # isEvent, reduce, reduceAll
  core/pools.ts                  # parseConfig, compileRules, resolvePool
  core/layout.ts                 # lanes, selectableIds, layout, fmtDuration
  test/collector.test.ts         # claude plugin test
  test/pane.test.tsx             # claude plugin test
cli/
  main.ts                        # argv, loop, keys
  snapshots.ts                   # dirs, read, list, stale, prune
  term.ts                        # ANSI, Screen diff painter
  sim.ts                         # scenarios + player
test/
  core/reducer.test.ts  core/pools.test.ts  core/layout.test.ts
  cli/snapshots.test.ts  cli/term.test.ts  cli/sim.test.ts
README.md
```

---

### Task 1: Repo scaffold + spikes S1/S2

Spikes are throwaway. Their only output is the two answers, recorded in the spec.

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `.gitignore`
- Create (throwaway, outside the repo): `/Users/vyhocgioi/.claude/dev-mods/<session-id>/swimtrace-spike/` (the session's mods folder, as the plugin-authoring skill names it)
- Modify: `docs/superpowers/specs/2026-10-12-swimtrace-design.md` §13 (record results)

**Interfaces:**
- Produces: `npm test` (runs `node --test` over `test/**/*.test.ts`), `npm run typecheck`, `npm run build`, `npm run test:mod`.

- [ ] **Step 1: Write the scaffold files**

`package.json`:
```json
{
  "name": "swimtrace",
  "version": "0.1.0",
  "description": "Swimlane monitor for Claude Code multi-agent runs",
  "type": "module",
  "bin": { "swimtrace": "dist/cli/main.js" },
  "files": ["dist"],
  "engines": { "node": ">=22.6" },
  "scripts": {
    "test": "node --test \"test/**/*.test.ts\"",
    "test:mod": "claude plugin test mod",
    "validate": "claude plugin validate mod && claude plugin validate .",
    "typecheck": "tsc -p tsconfig.json",
    "build": "tsc -p tsconfig.build.json && chmod +x dist/cli/main.js",
    "prepare": "npm run build"
  },
  "devDependencies": { "typescript": "^5.8.0", "@types/node": "^24.0.0" },
  "license": "MIT"
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noEmit": true, "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true, "verbatimModuleSyntax": true, "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["mod/core/**/*.ts", "cli/**/*.ts", "test/**/*.ts"]
}
```

`tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false, "outDir": "dist", "rootDir": ".",
    "allowImportingTsExtensions": false, "rewriteRelativeImportExtensions": true
  },
  "include": ["mod/core/**/*.ts", "cli/**/*.ts"]
}
```

`.gitignore`:
```
node_modules/
dist/
mod/.claude-plugin/types/
```

- [ ] **Step 2: Install dev dependencies**

Run: `npm install --ignore-scripts`
Expected: `node_modules/typescript` exists; no errors.

- [ ] **Step 3: Write the spike mod (throwaway, in the session mods folder)**

`swimtrace-spike/.claude-plugin/plugin.json`:
```json
{ "name": "swimtrace-spike", "version": "0.0.1", "description": "throwaway: S1/S2" }
```
`swimtrace-spike/hooks/hooks.json`:
```json
{ "modules": ["./register.ts"] }
```
`swimtrace-spike/hooks/register.ts`:
```ts
import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const home = await $.env.get('HOME')
    try {
      await $.fs.write(`${home}/.claude/swimtrace/spike/s1.json`, JSON.stringify({ ok: true, at: await $.clock.now() }))
      $.ui.toast('S1: write OK')
    } catch (err) {
      $.ui.toast(`S1: write FAILED ${String(err)}`)
    }
    return r
  })
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    $.ui.log(`S2 spawn: description=${JSON.stringify(e.description)} type=${e.subagentType} wf=${JSON.stringify(e.workflow)} id=${r.agentId}`)
    return r
  })
}
```

- [ ] **Step 4: Ask the person to enable hot reloading, then run the spikes**

The engine asks "Enable hot reloading for this session?" after the first write. After it loads:
- S1: check the toast and run `cat ~/.claude/swimtrace/spike/s1.json`. Expected: `{"ok":true,...}`, no permission prompt.
- S2 (costs a few tokens; ask the person first): run a one-agent workflow whose `agent()` call sets `label: 'review:probe'` and `phase: 'Probe'`, then read the logged `description`.

- [ ] **Step 5: Record results and remove the spike**

Edit spec §13: replace each spike's text with `Result (2026-10-12): …`. If S1 failed, stop and tell the person (the fallback changes Task 6). If S2 shows the label in `description`, add to `README.md` later (Task 11) a sample config rule `{ "match": { "description": "^(\\w+):" }, "pool": "$1" }`.
Run: `rm -rf ~/.claude/swimtrace/spike` and delete the `swimtrace-spike` folder.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json .gitignore docs/superpowers/specs/2026-10-12-swimtrace-design.md
git commit -m "chore: scaffold swimtrace; record spike results"
```

---

### Task 2: Core model + agent lifecycle reducer

**Files:**
- Create: `mod/core/model.ts`, `mod/core/reducer.ts`
- Test: `test/core/reducer.test.ts`

**Interfaces:**
- Produces (model.ts):
  - `type Status = 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'killed' | 'unknown'`
  - `type EndReason = 'answer' | 'aborted' | 'refusal' | 'error' | 'killed' | 'stale' | 'session-end'`
  - `type PoolSource = 'config' | 'explicit' | 'workflow' | 'type' | 'main'`
  - `type ListStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'`
  - `type TaskStatus = 'pending' | 'in_progress' | 'completed'`
  - `interface Agent`, `interface Task`, `interface Session`, `interface Snapshot` (below)
  - `const MAX_FINISHED = 200`, `const STALE_SESSION_MS = 15_000`, `const DEFAULT_STALE_WORKFLOW_MS = 600_000`
  - `function emptySnapshot(session: Session, simulated?: boolean): Snapshot`
  - `function isLive(s: Status): boolean`
- Produces (reducer.ts):
  - `type Event` (union below)
  - `function isEvent(x: unknown): x is Event`
  - `function reduce(s: Snapshot, ev: unknown): Snapshot` — invalid events return `s` unchanged
  - `function reduceAll(s: Snapshot, evs: readonly unknown[]): Snapshot`

- [ ] **Step 1: Write `mod/core/model.ts`** (types only + two tiny helpers; no test of its own)

```ts
export type Status = 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'killed' | 'unknown'
export type EndReason = 'answer' | 'aborted' | 'refusal' | 'error' | 'killed' | 'stale' | 'session-end'
export type PoolSource = 'config' | 'explicit' | 'workflow' | 'type' | 'main'
export type ListStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'
export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export interface Agent {
  id: string // 'main' for the main loop
  parentId?: string
  type: string
  description: string // the Agent call's short label; never the prompt
  name?: string
  workflowRunId?: string
  status: Status
  startedAt: number
  endedAt?: number
  endReason?: EndReason
  currentTool?: string // tool NAME only
  lastSeenAt: number
}

export interface Task { id: string; subject: string; status: TaskStatus; blockedBy: string[] }

export interface Session { id: string; project: string; startedAt: number; endedAt?: number; endReason?: string }

export interface Folded { completed: number; failed: number; interrupted: number; killed: number; unknown: number }

export interface Snapshot {
  v: 1
  simulated: boolean
  session: Session
  writtenAt: number
  agents: Agent[]
  tasks: Task[]
  workflows: Record<string, string> // runId → workflow meta.name
  folded: Folded
}

export const MAX_FINISHED = 200
export const STALE_SESSION_MS = 15_000
export const DEFAULT_STALE_WORKFLOW_MS = 600_000

export const isLive = (s: Status): boolean => s === 'running' || s === 'waiting'

export function emptySnapshot(session: Session, simulated = false): Snapshot {
  const main: Agent = {
    id: 'main', type: 'main', description: 'main', status: 'waiting',
    startedAt: session.startedAt, lastSeenAt: session.startedAt,
  }
  return {
    v: 1, simulated, session, writtenAt: session.startedAt, agents: [main], tasks: [], workflows: {},
    folded: { completed: 0, failed: 0, interrupted: 0, killed: 0, unknown: 0 },
  }
}
```

- [ ] **Step 2: Write the failing lifecycle tests**

`test/core/reducer.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptySnapshot } from '../../mod/core/model.ts'
import { reduce, reduceAll } from '../../mod/core/reducer.ts'

const S = () => emptySnapshot({ id: 's1', project: '/p', startedAt: 0 })
const spawn = (id: string, at: number, extra: object = {}) =>
  ({ kind: 'spawn', at, id, type: 'Explore', description: `do ${id}`, ...extra })
const agent = (s: ReturnType<typeof S>, id: string) => s.agents.find(a => a.id === id)

test('case 1: single agent runs then completes', () => {
  const s = reduceAll(S(), [spawn('a1', 10), { kind: 'runEnd', at: 50, agentId: 'a1', reason: 'answer' }])
  const a = agent(s, 'a1')!
  assert.equal(a.status, 'completed')
  assert.equal(a.startedAt, 10)
  assert.equal(a.endedAt, 50)
  assert.equal(a.endReason, 'answer')
})

test('case 2: concurrent agents are all running', () => {
  const s = reduceAll(S(), [spawn('a1', 10), spawn('a2', 11), spawn('a3', 12, { parentId: 'a1' })])
  assert.deepEqual(s.agents.filter(a => a.status === 'running').map(a => a.id), ['a1', 'a2', 'a3'])
  assert.equal(agent(s, 'a3')!.parentId, 'a1')
})

test('case 4: error and refusal fail, aborted interrupts, killed via list', () => {
  const s = reduceAll(S(), [
    spawn('e', 1), spawn('r', 1), spawn('x', 1), spawn('k', 1),
    { kind: 'runEnd', at: 5, agentId: 'e', reason: 'error' },
    { kind: 'runEnd', at: 5, agentId: 'r', reason: 'refusal' },
    { kind: 'runEnd', at: 5, agentId: 'x', reason: 'aborted' },
    { kind: 'listStatus', at: 6, agentId: 'k', status: 'killed', type: 'Explore', description: 'do k' },
  ])
  assert.equal(agent(s, 'e')!.status, 'failed')
  assert.equal(agent(s, 'r')!.status, 'failed')
  assert.equal(agent(s, 'x')!.status, 'interrupted')
  assert.equal(agent(s, 'k')!.status, 'killed')
  assert.equal(agent(s, 'k')!.endedAt, 6)
})

test('a finished agent stays finished whatever the list says later', () => {
  const s = reduceAll(S(), [spawn('a', 1), { kind: 'runEnd', at: 2, agentId: 'a', reason: 'answer' },
    { kind: 'listStatus', at: 3, agentId: 'a', status: 'running', type: 'Explore', description: 'do a' }])
  assert.equal(agent(s, 'a')!.status, 'completed')
})

test('list status maps waiting/idle to waiting and completes an agent whose end was missed', () => {
  const s = reduceAll(S(), [spawn('w', 1), spawn('c', 1),
    { kind: 'listStatus', at: 2, agentId: 'w', status: 'idle', type: 'Explore', description: 'do w' },
    { kind: 'listStatus', at: 2, agentId: 'c', status: 'completed', type: 'Explore', description: 'do c' }])
  assert.equal(agent(s, 'w')!.status, 'waiting')
  assert.equal(agent(s, 'c')!.status, 'completed')
  assert.equal(agent(s, 'c')!.endReason, undefined) // the reason was not observed
})

test('review focus 2: an agent first seen in the list appears with its metadata', () => {
  const s = reduce(S(), { kind: 'listStatus', at: 7, agentId: 'late', status: 'running', type: 'Plan', description: 'plan it', parentId: 'p0', name: 'planner' })
  const a = agent(s, 'late')!
  assert.equal(a.status, 'running')
  assert.equal(a.type, 'Plan')
  assert.equal(a.parentId, 'p0')
  assert.equal(a.startedAt, 7)
})

test('tool calls set current tool by name and refresh lastSeenAt; unknown ids are ignored', () => {
  const s = reduceAll(S(), [spawn('a', 1), { kind: 'toolCall', at: 9, agentId: 'a', tool: 'Grep' },
    { kind: 'toolCall', at: 9, agentId: 'ghost', tool: 'Read' }])
  assert.equal(agent(s, 'a')!.currentTool, 'Grep')
  assert.equal(agent(s, 'a')!.lastSeenAt, 9)
  assert.equal(agent(s, 'ghost'), undefined)
})

test('runEnd for an unknown id is ignored (engine forks)', () => {
  const s = reduce(S(), { kind: 'runEnd', at: 3, agentId: 'fork-1', reason: 'answer' })
  assert.equal(s.agents.length, 1)
})

test('main is running during a turn and waiting between turns', () => {
  let s = reduce(S(), { kind: 'mainTurn', at: 1, phase: 'start' })
  assert.equal(agent(s, 'main')!.status, 'running')
  s = reduce(s, { kind: 'mainTurn', at: 2, phase: 'end' })
  assert.equal(agent(s, 'main')!.status, 'waiting')
  assert.equal(agent(s, 'main')!.endedAt, undefined)
})

test('case 7: session end marks live agents unknown and main completed', () => {
  const s = reduceAll(S(), [spawn('a', 1), { kind: 'sessionEnd', at: 20, reason: 'other' }])
  assert.equal(s.session.endedAt, 20)
  assert.equal(agent(s, 'a')!.status, 'unknown')
  assert.equal(agent(s, 'a')!.endReason, 'session-end')
  assert.equal(agent(s, 'main')!.status, 'completed')
})

test('tick turns a silent workflow agent unknown, never completed', () => {
  const s = reduceAll(S(), [spawn('w', 0, { workflowRunId: 'wf_1' }), spawn('n', 0),
    { kind: 'tick', at: 700_000, staleWorkflowMs: 600_000 }])
  assert.equal(agent(s, 'w')!.status, 'unknown')
  assert.equal(agent(s, 'w')!.endReason, 'stale')
  assert.equal(agent(s, 'w')!.endedAt, 0)
  assert.equal(agent(s, 'n')!.status, 'running') // non-workflow agents are healed by the list, not by tick
})

test('events that change nothing return the same snapshot object (no idle writes)', () => {
  const s = reduceAll(S(), [spawn('a', 1), spawn('w', 1, { workflowRunId: 'wf' }), { kind: 'listStatus', at: 2, agentId: 'a', status: 'running', type: 'Explore', description: 'do a' }])
  assert.equal(reduce(s, { kind: 'tick', at: 3, staleWorkflowMs: 600_000 }), s)
  assert.equal(reduce(s, { kind: 'listStatus', at: 4, agentId: 'a', status: 'running', type: 'Explore', description: 'do a' }), s)
  assert.equal(reduce(s, { kind: 'mainTurn', at: 5, phase: 'end' }), s) // main already waiting
  const done = reduce(s, { kind: 'runEnd', at: 6, agentId: 'a', reason: 'answer' })
  assert.equal(reduce(done, { kind: 'listStatus', at: 7, agentId: 'a', status: 'completed', type: 'Explore', description: 'do a' }), done)
})

test('reduce does not mutate its input', () => {
  const s0 = S()
  const before = JSON.stringify(s0)
  reduce(s0, spawn('a', 1))
  assert.equal(JSON.stringify(s0), before)
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../mod/core/reducer.ts'`.

- [ ] **Step 4: Write `mod/core/reducer.ts` (lifecycle part)**

```ts
import type { Agent, ListStatus, Snapshot, Status, TaskStatus } from './model.ts'
import { MAX_FINISHED, isLive } from './model.ts'

export type Event =
  | { kind: 'spawn'; at: number; id: string; type: string; description: string; parentId?: string; name?: string; workflowRunId?: string }
  | { kind: 'toolCall'; at: number; agentId: string; tool: string }
  | { kind: 'runEnd'; at: number; agentId: string; reason: 'answer' | 'aborted' | 'refusal' | 'error' }
  | { kind: 'mainTurn'; at: number; phase: 'start' | 'end' }
  | { kind: 'listStatus'; at: number; agentId: string; status: ListStatus; type: string; description: string; parentId?: string; name?: string }
  | { kind: 'taskCreate'; id: string; subject: string }
  | { kind: 'taskUpdate'; id: string; subject?: string; status?: TaskStatus | 'deleted'; addBlockedBy?: string[] }
  | { kind: 'workflowName'; runId: string; name: string }
  | { kind: 'sessionEnd'; at: number; reason: string }
  | { kind: 'tick'; at: number; staleWorkflowMs: number }

const REQUIRED: Record<Event['kind'], Record<string, 'string' | 'number'>> = {
  spawn: { at: 'number', id: 'string', type: 'string', description: 'string' },
  toolCall: { at: 'number', agentId: 'string', tool: 'string' },
  runEnd: { at: 'number', agentId: 'string', reason: 'string' },
  mainTurn: { at: 'number', phase: 'string' },
  listStatus: { at: 'number', agentId: 'string', status: 'string', type: 'string', description: 'string' },
  taskCreate: { id: 'string', subject: 'string' },
  taskUpdate: { id: 'string' },
  workflowName: { runId: 'string', name: 'string' },
  sessionEnd: { at: 'number', reason: 'string' },
  tick: { at: 'number', staleWorkflowMs: 'number' },
}

export function isEvent(x: unknown): x is Event {
  if (typeof x !== 'object' || x === null) return false
  const ev = x as Record<string, unknown>
  const need = REQUIRED[ev.kind as Event['kind']]
  if (need === undefined) return false
  return Object.entries(need).every(([k, t]) => typeof ev[k] === t && (t !== 'number' || Number.isFinite(ev[k])))
}

const END_STATUS: Record<'answer' | 'aborted' | 'refusal' | 'error', Status> = {
  answer: 'completed', aborted: 'interrupted', refusal: 'failed', error: 'failed',
}

// Returns `s` itself when `fn` changed nothing: the collector relies on that to skip idle writes.
function mapAgent(s: Snapshot, id: string, fn: (a: Agent) => Agent): Snapshot {
  let changed = false
  const agents = s.agents.map(a => {
    if (a.id !== id) return a
    const n = fn(a)
    if (n !== a) changed = true
    return n
  })
  return changed ? { ...s, agents } : s
}

function apply(s: Snapshot, ev: Event): Snapshot {
  const known = (id: string) => s.agents.some(a => a.id === id)
  switch (ev.kind) {
    case 'spawn': {
      if (known(ev.id)) return s // dedupe
      const a: Agent = {
        id: ev.id, parentId: ev.parentId, type: ev.type, description: ev.description, name: ev.name,
        workflowRunId: ev.workflowRunId, status: 'running', startedAt: ev.at, lastSeenAt: ev.at,
      }
      return { ...s, agents: [...s.agents, a] }
    }
    case 'toolCall':
      if (!known(ev.agentId)) return s
      return mapAgent(s, ev.agentId, a => ({ ...a, currentTool: ev.tool, lastSeenAt: ev.at }))
    case 'runEnd': {
      const status = END_STATUS[ev.reason]
      if (status === undefined || !known(ev.agentId) || ev.agentId === 'main') return s
      return mapAgent(s, ev.agentId, a => (isLive(a.status)
        ? { ...a, status, endedAt: ev.at, endReason: ev.reason, currentTool: undefined, lastSeenAt: ev.at }
        : a))
    }
    case 'mainTurn':
      return mapAgent(s, 'main', a => {
        const status: Status = ev.phase === 'start' ? 'running' : 'waiting'
        if (a.status === status && (ev.phase === 'start' || a.currentTool === undefined)) return a
        return { ...a, status, lastSeenAt: ev.at, currentTool: ev.phase === 'end' ? undefined : a.currentTool }
      })
    case 'listStatus': {
      if (!known(ev.agentId)) {
        const live = ev.status === 'running' || ev.status === 'pending' || ev.status === 'waiting' || ev.status === 'idle'
        const a: Agent = {
          id: ev.agentId, parentId: ev.parentId, type: ev.type, description: ev.description, name: ev.name,
          status: live ? (ev.status === 'waiting' || ev.status === 'idle' ? 'waiting' : 'running') : listEnd(ev.status),
          startedAt: ev.at, lastSeenAt: ev.at, endedAt: live ? undefined : ev.at,
          endReason: ev.status === 'killed' ? 'killed' : undefined,
        }
        return { ...s, agents: [...s.agents, a] }
      }
      return mapAgent(s, ev.agentId, a => {
        if (!isLive(a.status)) return a // finished is final
        switch (ev.status) {
          case 'killed': return { ...a, status: 'killed', endedAt: ev.at, endReason: 'killed', currentTool: undefined }
          case 'completed': case 'failed': return { ...a, status: ev.status, endedAt: ev.at, currentTool: undefined }
          case 'waiting': case 'idle': return a.status === 'waiting' ? a : { ...a, status: 'waiting' }
          default: return a.status === 'running' ? a : { ...a, status: 'running' }
        }
      })
    }
    case 'sessionEnd':
      return {
        ...s,
        session: { ...s.session, endedAt: ev.at, endReason: ev.reason },
        agents: s.agents.map(a => {
          if (!isLive(a.status)) return a
          if (a.id === 'main') return { ...a, status: 'completed', endedAt: ev.at, endReason: 'session-end', currentTool: undefined }
          return { ...a, status: 'unknown', endedAt: ev.at, endReason: 'session-end', currentTool: undefined }
        }),
      }
    case 'tick': {
      const isStale = (a: Agent) => a.workflowRunId !== undefined && isLive(a.status) && ev.at - a.lastSeenAt > ev.staleWorkflowMs
      if (!s.agents.some(isStale)) return s
      return {
        ...s,
        agents: s.agents.map(a => (isStale(a) ? { ...a, status: 'unknown', endedAt: a.lastSeenAt, endReason: 'stale', currentTool: undefined } : a)),
      }
    }
    default:
      return s
  }
}

const listEnd = (st: ListStatus): Status => (st === 'killed' ? 'killed' : st === 'failed' ? 'failed' : 'completed')

export function reduce(s: Snapshot, ev: unknown): Snapshot {
  if (!isEvent(ev)) return s
  return apply(s, ev)
}

export function reduceAll(s: Snapshot, evs: readonly unknown[]): Snapshot {
  return evs.reduce<Snapshot>(reduce, s)
}
```
(`MAX_FINISHED` is used in Task 3; leave the import.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all reducer tests PASS. Then `npm run typecheck` → no errors.

- [ ] **Step 6: Commit**

```bash
git add mod/core/model.ts mod/core/reducer.ts test/core/reducer.test.ts
git commit -m "feat(core): snapshot model and agent lifecycle reducer"
```

---

### Task 3: Reducer — tasks, workflows, folding, malformed events

**Files:**
- Modify: `mod/core/reducer.ts`
- Test: `test/core/reducer.test.ts` (append)

**Interfaces:**
- Consumes: `reduce`, `reduceAll`, `Event` from Task 2.
- Produces: same signatures; `taskCreate`, `taskUpdate`, `workflowName` handled; folding applied after every event.

- [ ] **Step 1: Append failing tests**

```ts
import { MAX_FINISHED } from '../../mod/core/model.ts'

test('tasks: create, update status, add blockers, delete', () => {
  let s = reduceAll(S(), [
    { kind: 'taskCreate', id: '1', subject: 'Plan' },
    { kind: 'taskCreate', id: '2', subject: 'Build' },
    { kind: 'taskUpdate', id: '2', status: 'in_progress', addBlockedBy: ['1'] },
    { kind: 'taskUpdate', id: '2', addBlockedBy: ['1', '3'] },
  ])
  assert.deepEqual(s.tasks.find(t => t.id === '2'), { id: '2', subject: 'Build', status: 'in_progress', blockedBy: ['1', '3'] })
  s = reduce(s, { kind: 'taskUpdate', id: '1', status: 'deleted' })
  assert.deepEqual(s.tasks.map(t => t.id), ['2'])
})

test('taskUpdate for an unseen task creates it', () => {
  const s = reduce(S(), { kind: 'taskUpdate', id: '9', status: 'completed' })
  assert.deepEqual(s.tasks, [{ id: '9', subject: '9', status: 'completed', blockedBy: [] }])
})

test('workflow names are recorded by run id', () => {
  const s = reduce(S(), { kind: 'workflowName', runId: 'wf_1', name: 'review-changes' })
  assert.equal(s.workflows.wf_1, 'review-changes')
})

test('case 8: malformed events are dropped, duplicates ignored', () => {
  const s0 = reduce(S(), spawn('a', 1))
  for (const bad of [null, 42, 'x', {}, { kind: 'nope' }, { kind: 'spawn', id: 'b' }, { kind: 'runEnd', at: NaN, agentId: 'a', reason: 'answer' }, { kind: 'runEnd', at: 1, agentId: 'a', reason: 'weird' }]) {
    assert.equal(reduce(s0, bad), s0)
  }
  const dup = reduce(s0, spawn('a', 99, { type: 'Other' }))
  assert.equal(dup.agents.find(a => a.id === 'a')!.type, 'Explore')
})

test('more than MAX_FINISHED finished agents fold the oldest into counters', () => {
  const evs: object[] = []
  for (let i = 0; i < MAX_FINISHED + 5; i++) {
    evs.push(spawn(`a${i}`, i), { kind: 'runEnd', at: i + 1, agentId: `a${i}`, reason: i % 2 ? 'error' : 'answer' })
  }
  evs.push(spawn('live', 1000))
  const s = reduceAll(S(), evs)
  const finished = s.agents.filter(a => a.status !== 'running' && a.status !== 'waiting')
  assert.equal(finished.length, MAX_FINISHED)
  assert.equal(s.folded.completed + s.folded.failed, 5)
  assert.ok(s.agents.some(a => a.id === 'live'))
  assert.ok(!s.agents.some(a => a.id === 'a0'))
})
```

- [ ] **Step 2: Run to verify failures**

Run: `npm test`
Expected: FAIL on tasks/workflows/fold tests (malformed test may already pass).

- [ ] **Step 3: Implement** — add these cases to `apply`'s switch (before `default`) and wrap `reduce` with folding:

```ts
    case 'taskCreate':
      if (s.tasks.some(t => t.id === ev.id)) return s
      return { ...s, tasks: [...s.tasks, { id: ev.id, subject: ev.subject, status: 'pending', blockedBy: [] }] }
    case 'taskUpdate': {
      if (ev.status === 'deleted') return { ...s, tasks: s.tasks.filter(t => t.id !== ev.id) }
      const base = s.tasks.find(t => t.id === ev.id) ?? { id: ev.id, subject: ev.id, status: 'pending' as TaskStatus, blockedBy: [] }
      const next = {
        ...base,
        subject: ev.subject ?? base.subject,
        status: ev.status ?? base.status,
        blockedBy: [...new Set([...base.blockedBy, ...(ev.addBlockedBy ?? [])])],
      }
      return { ...s, tasks: s.tasks.some(t => t.id === ev.id) ? s.tasks.map(t => (t.id === ev.id ? next : t)) : [...s.tasks, next] }
    }
    case 'workflowName':
      return { ...s, workflows: { ...s.workflows, [ev.runId]: ev.name } }
```

Replace `reduce` with:
```ts
function fold(s: Snapshot): Snapshot {
  const finished = s.agents.filter(a => !isLive(a.status))
  const extra = finished.length - MAX_FINISHED
  if (extra <= 0) return s
  const drop = new Set(finished.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0)).slice(0, extra).map(a => a.id))
  const folded = { ...s.folded }
  for (const a of s.agents) if (drop.has(a.id)) folded[a.status as keyof typeof folded] += 1
  return { ...s, agents: s.agents.filter(a => !drop.has(a.id)), folded }
}

export function reduce(s: Snapshot, ev: unknown): Snapshot {
  if (!isEvent(ev)) return s
  const next = apply(s, ev)
  return next === s ? s : fold(next)
}
```
Also add validation of `taskUpdate.status` values and `addBlockedBy` arrays inside `isEvent`: after the `every(...)` check, `if (ev.kind === 'taskUpdate' && ev.addBlockedBy !== undefined && !(Array.isArray(ev.addBlockedBy) && ev.addBlockedBy.every(x => typeof x === 'string'))) return false`.

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add mod/core/reducer.ts test/core/reducer.test.ts
git commit -m "feat(core): tasks, workflow names, folding, malformed-event guards"
```

---

### Task 4: Pool resolver + config

**Files:**
- Create: `mod/core/pools.ts`
- Test: `test/core/pools.test.ts`

**Interfaces:**
- Consumes: `Agent`, `PoolSource`, `DEFAULT_STALE_WORKFLOW_MS` from `model.ts`.
- Produces:
  - `interface RuleJson { match: { type?: string; description?: string; name?: string; project?: string }; pool: string }`
  - `interface ConfigJson { rules: RuleJson[]; staleWorkflowAgentMinutes: number }`
  - `const DEFAULT_CONFIG: ConfigJson`
  - `function parseConfig(text: string | undefined): { config: ConfigJson; warnings: string[] }`
  - `interface CompiledRule { match: Partial<Record<MatchKey, RegExp>>; pool: string }` with `type MatchKey = 'type' | 'name' | 'description' | 'project'`
  - `function compileRules(rules: readonly RuleJson[]): { rules: CompiledRule[]; warnings: string[] }`
  - `interface Pool { name: string; source: PoolSource }`
  - `function resolvePool(a: Agent, project: string, workflows: Record<string, string>, rules: readonly CompiledRule[]): Pool`

- [ ] **Step 1: Write failing tests** — `test/core/pools.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '../../mod/core/model.ts'
import { compileRules, parseConfig, resolvePool, DEFAULT_CONFIG } from '../../mod/core/pools.ts'

const A = (o: Partial<Agent> = {}): Agent => ({ id: 'a', type: 'Explore', description: 'look around', status: 'running', startedAt: 0, lastSeenAt: 0, ...o })
const rules = (json: unknown[]) => compileRules(json as never).rules

test('case 5: no metadata falls back to the agent type', () => {
  assert.deepEqual(resolvePool(A(), '/p', {}, []), { name: 'Explore', source: 'type' })
})

test('main always gets the main lane', () => {
  assert.deepEqual(resolvePool(A({ id: 'main', type: 'main' }), '/p', {}, rules([{ match: { type: '.*' }, pool: 'X' }])), { name: 'MAIN', source: 'main' })
})

test('workflow run lane uses the workflow name, else the run id', () => {
  assert.deepEqual(resolvePool(A({ workflowRunId: 'wf_1' }), '/p', { wf_1: 'review-changes' }, []), { name: 'review-changes', source: 'workflow' })
  assert.deepEqual(resolvePool(A({ workflowRunId: 'wf_2' }), '/p', {}, []), { name: 'wf_2', source: 'workflow' })
})

test('explicit [pool:Name] tag beats workflow and type', () => {
  assert.deepEqual(resolvePool(A({ description: '[pool:Backend] build api', workflowRunId: 'wf_1' }), '/p', {}, []), { name: 'Backend', source: 'explicit' })
})

test('config rules beat everything except main; all keys must match; captures substitute', () => {
  const r = rules([
    { match: { type: '^reviewer$', project: 'c4k' }, pool: 'Review' },
    { match: { description: '^\\[T\\d+\\] (\\S+)' }, pool: '$1' },
  ])
  assert.deepEqual(resolvePool(A({ type: 'reviewer' }), '/work/c4k-mobile', {}, r), { name: 'Review', source: 'config' })
  assert.deepEqual(resolvePool(A({ type: 'reviewer' }), '/work/other', {}, r), { name: 'reviewer', source: 'type' })
  assert.deepEqual(resolvePool(A({ description: '[T3] business-analyst — refine', workflowRunId: 'wf' }), '/p', {}, r), { name: 'business-analyst', source: 'config' })
})

test('review focus 4: invalid regex rules are skipped with a warning, others still apply', () => {
  const { rules: r, warnings } = compileRules([{ match: { type: '(' }, pool: 'Bad' }, { match: { type: 'Explore' }, pool: 'Good' }] as never)
  assert.equal(r.length, 1)
  assert.equal(warnings.length, 1)
  assert.equal(resolvePool(A(), '/p', {}, r).name, 'Good')
})

test('parseConfig: missing, invalid JSON and wrong shapes give defaults plus warnings', () => {
  assert.deepEqual(parseConfig(undefined), { config: DEFAULT_CONFIG, warnings: [] })
  assert.equal(parseConfig('{nope').warnings.length, 1)
  const odd = parseConfig(JSON.stringify({ rules: [{ match: {}, pool: 'x' }, { pool: 3 }, 'z'], staleWorkflowAgentMinutes: -1 }))
  assert.deepEqual(odd.config, DEFAULT_CONFIG)
  assert.equal(odd.warnings.length, 4)
  const ok = parseConfig(JSON.stringify({ rules: [{ match: { name: 'x' }, pool: 'X' }], staleWorkflowAgentMinutes: 3 }))
  assert.deepEqual(ok.config, { rules: [{ match: { name: 'x' }, pool: 'X' }], staleWorkflowAgentMinutes: 3 })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — cannot find `pools.ts`.

- [ ] **Step 3: Implement `mod/core/pools.ts`**

```ts
import type { Agent, PoolSource } from './model.ts'
import { DEFAULT_STALE_WORKFLOW_MS } from './model.ts'

export type MatchKey = 'type' | 'name' | 'description' | 'project'
const KEYS: readonly MatchKey[] = ['type', 'name', 'description', 'project']

export interface RuleJson { match: Partial<Record<MatchKey, string>>; pool: string }
export interface ConfigJson { rules: RuleJson[]; staleWorkflowAgentMinutes: number }
export interface CompiledRule { match: Partial<Record<MatchKey, RegExp>>; pool: string }
export interface Pool { name: string; source: PoolSource }

export const DEFAULT_CONFIG: ConfigJson = { rules: [], staleWorkflowAgentMinutes: DEFAULT_STALE_WORKFLOW_MS / 60_000 }

export function parseConfig(text: string | undefined): { config: ConfigJson; warnings: string[] } {
  if (text === undefined) return { config: DEFAULT_CONFIG, warnings: [] }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { config: DEFAULT_CONFIG, warnings: ['config.json is not valid JSON; using defaults'] } }
  const warnings: string[] = []
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const rules: RuleJson[] = []
  for (const [i, r] of (Array.isArray(obj.rules) ? obj.rules : []).entries()) {
    const rule = r as Record<string, unknown> | null
    const match = rule?.match as Record<string, unknown> | undefined
    const keys = match && typeof match === 'object' ? KEYS.filter(k => typeof match[k] === 'string') : []
    if (typeof rule?.pool !== 'string' || keys.length === 0) { warnings.push(`rule ${i}: needs a string "pool" and at least one string match key`); continue }
    rules.push({ match: Object.fromEntries(keys.map(k => [k, match![k]])) as RuleJson['match'], pool: rule.pool })
  }
  const m = obj.staleWorkflowAgentMinutes
  const minutes = typeof m === 'number' && m > 0 ? m : DEFAULT_CONFIG.staleWorkflowAgentMinutes
  if (m !== undefined && minutes !== m) warnings.push('staleWorkflowAgentMinutes must be a positive number; using default')
  return { config: { rules, staleWorkflowAgentMinutes: minutes }, warnings }
}

export function compileRules(rules: readonly RuleJson[]): { rules: CompiledRule[]; warnings: string[] } {
  const out: CompiledRule[] = []
  const warnings: string[] = []
  for (const [i, r] of rules.entries()) {
    try {
      const match: CompiledRule['match'] = {}
      for (const k of KEYS) if (r.match[k] !== undefined) match[k] = new RegExp(r.match[k]!)
      out.push({ match, pool: r.pool })
    } catch (err) {
      warnings.push(`rule ${i}: invalid regex (${(err as Error).message}); skipped`)
    }
  }
  return { rules: out, warnings }
}

const EXPLICIT = /^\[pool:([^\]]+)\]/

export function resolvePool(a: Agent, project: string, workflows: Record<string, string>, rules: readonly CompiledRule[]): Pool {
  if (a.id === 'main') return { name: 'MAIN', source: 'main' }
  const fields: Record<MatchKey, string> = { type: a.type, name: a.name ?? '', description: a.description, project }
  for (const r of rules) {
    let groups: RegExpExecArray | null = null
    let ok = true
    for (const k of KEYS) {
      const re = r.match[k]
      if (re === undefined) continue
      const m = re.exec(fields[k])
      if (m === null) { ok = false; break }
      if (groups === null && m.length > 1) groups = m // captures come from the first key, in KEYS order, that has groups
    }
    if (ok) return { name: r.pool.replace(/\$(\d)/g, (_, d: string) => groups?.[Number(d)] ?? ''), source: 'config' }
  }
  const tag = EXPLICIT.exec(a.description)
  if (tag) return { name: tag[1]!.trim(), source: 'explicit' }
  if (a.workflowRunId !== undefined) return { name: workflows[a.workflowRunId] ?? a.workflowRunId, source: 'workflow' }
  return { name: a.type, source: 'type' }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mod/core/pools.ts test/core/pools.test.ts
git commit -m "feat(core): layered pool resolver and config parsing"
```

---

### Task 5: Swimlane layout

**Files:**
- Create: `mod/core/layout.ts`
- Test: `test/core/layout.test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `Agent`, `Status`, `STALE_SESSION_MS` (model); `CompiledRule`, `resolvePool`, `Pool` (pools).
- Produces:
  - `type Fg = 'green' | 'red' | 'yellow' | 'cyan' | 'gray' | 'magenta'`
  - `interface Seg { text: string; fg?: Fg; bold?: boolean; dim?: boolean; inverse?: boolean }`, `type Row = Seg[]`
  - `type View = 'pool' | 'agent'`
  - `interface LayoutOpts { width: number; height: number; now: number; view: View; runningOnly: boolean; selectedId?: string; expanded: boolean; zoomMs?: number; rules: readonly CompiledRule[] }`
  - `interface Lane { pool: Pool; agents: Agent[] }`
  - `const COMPACT_BELOW = 60`, `const GLYPH: Record<Status, string>`
  - `function fmtDuration(ms: number): string`
  - `function isStale(s: Snapshot, now: number): boolean`
  - `function lanes(s: Snapshot, opts: Pick<LayoutOpts, 'view' | 'runningOnly' | 'rules'>): Lane[]`
  - `function selectableIds(s: Snapshot, opts: Pick<LayoutOpts, 'view' | 'runningOnly' | 'rules'>): string[]`
  - `function layout(s: Snapshot, opts: LayoutOpts): Row[]`
  - `function rowText(r: Row): string`

- [ ] **Step 1: Write failing tests** — `test/core/layout.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptySnapshot } from '../../mod/core/model.ts'
import { reduceAll } from '../../mod/core/reducer.ts'
import { compileRules } from '../../mod/core/pools.ts'
import { fmtDuration, isStale, lanes, layout, rowText, selectableIds, type LayoutOpts } from '../../mod/core/layout.ts'

const snap = (evs: object[], simulated = false) =>
  reduceAll(emptySnapshot({ id: 'sess-123456789', project: '/w/c4k-mobile', startedAt: 0 }, simulated), evs)
const spawn = (id: string, at: number, extra: object = {}) => ({ kind: 'spawn', at, id, type: 'Explore', description: id, ...extra })
const opts = (o: Partial<LayoutOpts> = {}): LayoutOpts =>
  ({ width: 100, height: 40, now: 100_000, view: 'pool', runningOnly: false, expanded: false, rules: [], ...o })
const text = (rows: ReturnType<typeof layout>) => rows.map(rowText)

test('fmtDuration', () => {
  assert.equal(fmtDuration(12_400), '12s')
  assert.equal(fmtDuration(62_000), '1m02s')
  assert.equal(fmtDuration(3_900_000), '1h05m')
})

test('header shows project basename, short session id, and SIMULATED badge', () => {
  const t = text(layout(snap([], true), opts()))
  assert.match(t[0]!, /SWIMTRACE/)
  assert.match(t[0]!, /c4k-mobile/)
  assert.match(t[0]!, /sess-123/)
  assert.match(t[0]!, /SIMULATED/)
})

test('case 2 and 9: concurrent agents in one lane stack on separate rows (timeline)', () => {
  const s = snap([spawn('a1', 10_000), spawn('a2', 12_000)])
  const t = text(layout(s, opts()))
  const laneAt = t.findIndex(l => l.startsWith('Explore · type'))
  assert.ok(laneAt > 0)
  assert.match(t[laneAt + 1]!, /a1 ●/)
  assert.match(t[laneAt + 2]!, /a2 ●/)
})

test('sequential agents in one lane share a row', () => {
  const s = snap([spawn('a1', 0), { kind: 'runEnd', at: 5_000, agentId: 'a1', reason: 'answer' }, spawn('a2', 90_000)])
  const t = text(layout(s, opts({ width: 120 })))
  const laneAt = t.findIndex(l => l.startsWith('Explore · type'))
  assert.match(t[laneAt + 1]!, /a1 ✓.*a2 ●/)
})

test('case 9: below 60 columns the compact list is used and every row fits', () => {
  const s = snap([spawn('a1', 10_000)])
  for (const width of [40, 59]) {
    const t = text(layout(s, opts({ width })))
    assert.ok(t.every(l => l.length <= width), `row too wide at ${width}`)
    assert.ok(t.some(l => /^\s+● a1 1m30s/.test(l)))
  }
  for (const width of [80, 200]) assert.ok(text(layout(s, opts({ width }))).every(l => l.length <= width))
})

test('review focus 5: a very long description is clipped to the width', () => {
  const s = snap([spawn('x', 0, { description: 'y'.repeat(500), name: 'n'.repeat(300) })])
  for (const width of [30, 60, 100]) assert.ok(text(layout(s, opts({ width }))).every(l => l.length <= width))
})

test('lanes: main first, then in order of first start; lane header shows source', () => {
  const r = compileRules([{ match: { type: '^reviewer$' }, pool: 'REVIEW' }]).rules
  const s = snap([spawn('r1', 5, { type: 'reviewer' }), spawn('e1', 1)])
  assert.deepEqual(lanes(s, { view: 'pool', runningOnly: false, rules: r }).map(l => `${l.pool.name}/${l.pool.source}`),
    ['MAIN/main', 'Explore/type', 'REVIEW/config'])
  assert.ok(text(layout(s, opts({ rules: r }))).some(l => l.startsWith('REVIEW · config')))
})

test('runningOnly hides finished agents; selectableIds follows display order', () => {
  const s = snap([spawn('a', 1), spawn('b', 2), { kind: 'runEnd', at: 3, agentId: 'a', reason: 'answer' }])
  assert.deepEqual(selectableIds(s, { view: 'pool', runningOnly: true, rules: [] }), ['b']) // main is waiting, so hidden too
  assert.deepEqual(selectableIds(s, { view: 'pool', runningOnly: false, rules: [] }), ['main', 'a', 'b'])
})

test('agent view indents children under parents', () => {
  const s = snap([spawn('p', 1), spawn('c', 2, { parentId: 'p' })])
  const t = text(layout(s, opts({ view: 'agent' })))
  const p = t.find(l => /● p /.test(l))!
  const c = t.find(l => /● c /.test(l))!
  assert.ok(c.indexOf('●') > p.indexOf('●'))
})

test('footer counts exclude main and include folded counters', () => {
  const s = snap([spawn('a', 1), spawn('b', 1), { kind: 'runEnd', at: 2, agentId: 'b', reason: 'error' }])
  s.folded.completed = 3
  const t = text(layout(s, opts()))
  assert.match(t.at(-1)!, /Running 1 · Waiting 0 · Done 3 · Failed 1 · Stopped 0 · Unknown 0/)
})

test('details for the selected agent when expanded; no tool input anywhere', () => {
  const s = snap([spawn('a', 1, { parentId: 'main' }), { kind: 'toolCall', at: 2, agentId: 'a', tool: 'Grep' }])
  const t = text(layout(s, opts({ selectedId: 'a', expanded: true })))
  assert.ok(t.some(l => /id a .*parent main .*type Explore/.test(l)))
  assert.ok(t.some(l => /tool Grep/.test(l)))
})

test('tasks strip shows blockers; absent when no tasks', () => {
  assert.ok(!text(layout(snap([]), opts())).some(l => l.startsWith('Tasks')))
  const s = snap([{ kind: 'taskCreate', id: '1', subject: 'Plan' }, { kind: 'taskUpdate', id: '2', subject: 'Build', addBlockedBy: ['1'] }])
  const t = text(layout(s, opts()))
  assert.ok(t.some(l => /#2 ◌ Build \(blocked by 1\)/.test(l)))
})

test('stale and ended sessions are flagged in the header', () => {
  const live = snap([])
  live.writtenAt = 0
  assert.equal(isStale(live, 20_000), true)
  assert.match(text(layout(live, opts({ now: 20_000 })))[0]!, /STALE/)
  const ended = snap([{ kind: 'sessionEnd', at: 5, reason: 'other' }])
  assert.equal(isStale(ended, 20_000), false)
  assert.match(text(layout(ended, opts()))[0]!, /ENDED/)
})

test('height limit keeps header and footer and says how many rows were cut', () => {
  const evs = Array.from({ length: 30 }, (_, i) => spawn(`a${i}`, i * 10))
  const t = text(layout(snap(evs), opts({ height: 10 })))
  assert.equal(t.length, 10)
  assert.match(t[0]!, /SWIMTRACE/)
  assert.match(t.at(-2)!, /… \d+ more rows/)
  assert.match(t.at(-1)!, /Running/)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — cannot find `layout.ts`.

- [ ] **Step 3: Implement `mod/core/layout.ts`**

```ts
import type { Agent, Snapshot, Status } from './model.ts'
import { STALE_SESSION_MS } from './model.ts'
import type { CompiledRule, Pool } from './pools.ts'
import { resolvePool } from './pools.ts'

export type Fg = 'green' | 'red' | 'yellow' | 'cyan' | 'gray' | 'magenta'
export interface Seg { text: string; fg?: Fg; bold?: boolean; dim?: boolean; inverse?: boolean }
export type Row = Seg[]
export type View = 'pool' | 'agent'
export interface LayoutOpts {
  width: number; height: number; now: number; view: View; runningOnly: boolean
  selectedId?: string; expanded: boolean; zoomMs?: number; rules: readonly CompiledRule[]
}
export interface Lane { pool: Pool; agents: Agent[] }
type LaneOpts = Pick<LayoutOpts, 'view' | 'runningOnly' | 'rules'>

export const COMPACT_BELOW = 60
export const GLYPH: Record<Status, string> = {
  running: '●', waiting: '◌', completed: '✓', failed: '✗', interrupted: '■', killed: '■', unknown: '?',
}
const COLOR: Record<Status, Fg> = {
  running: 'cyan', waiting: 'yellow', completed: 'green', failed: 'red', interrupted: 'magenta', killed: 'magenta', unknown: 'gray',
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

export const isStale = (s: Snapshot, now: number): boolean =>
  s.session.endedAt === undefined && now - s.writtenAt > STALE_SESSION_MS

export const rowText = (r: Row): string => r.map(g => g.text).join('')

const visible = (s: Snapshot, o: LaneOpts) => (o.runningOnly ? s.agents.filter(a => a.status === 'running') : s.agents)

export function lanes(s: Snapshot, o: LaneOpts): Lane[] {
  const byName = new Map<string, Lane>()
  const sorted = [...visible(s, o)].sort((a, b) => (a.id === 'main' ? -1 : b.id === 'main' ? 1 : a.startedAt - b.startedAt))
  for (const a of sorted) {
    const pool = resolvePool(a, s.session.project, s.workflows, o.rules)
    const key = `${pool.source}:${pool.name}`
    const lane = byName.get(key) ?? { pool, agents: [] }
    lane.agents.push(a)
    byName.set(key, lane)
  }
  return [...byName.values()]
}

function treeOrder(agents: Agent[]): { a: Agent; depth: number }[] {
  const ids = new Set(agents.map(a => a.id))
  const kids = new Map<string, Agent[]>()
  for (const a of agents) {
    const p = a.id === 'main' ? '' : a.parentId !== undefined && ids.has(a.parentId) ? a.parentId : 'main'
    kids.set(p, [...(kids.get(p) ?? []), a])
  }
  const out: { a: Agent; depth: number }[] = []
  const walk = (p: string, depth: number) => {
    for (const a of (kids.get(p) ?? []).sort((x, y) => x.startedAt - y.startedAt)) {
      if (a.id !== p) { out.push({ a, depth }); walk(a.id, depth + 1) }
    }
  }
  walk('', 0)
  if (!ids.has('main')) walk('main', 0) // runningOnly may hide main; its children still show at depth 0
  return out
}

export function selectableIds(s: Snapshot, o: LaneOpts): string[] {
  if (o.view === 'agent') return treeOrder(visible(s, o)).map(x => x.a.id)
  return lanes(s, o).flatMap(l => l.agents.map(a => a.id))
}

const label = (a: Agent) => a.name ?? (a.id === 'main' ? 'main' : a.type === a.description ? a.type : a.description || a.type)
const dur = (a: Agent, now: number) => fmtDuration((a.endedAt ?? now) - a.startedAt)

function clip(row: Row, width: number): Row {
  const out: Row = []
  let left = width
  for (const g of row) {
    if (left <= 0) break
    const t = g.text.length > left ? g.text.slice(0, left) : g.text
    out.push({ ...g, text: t })
    left -= t.length
  }
  return out
}

function listLine(a: Agent, depth: number, now: number, selected: boolean): Row {
  const tool = a.status === 'running' && a.currentTool ? ` ${a.currentTool}` : ''
  return [
    { text: '  '.repeat(depth + 1) },
    { text: `${GLYPH[a.status]} ${label(a)} ${dur(a, now)}`, fg: COLOR[a.status], inverse: selected },
    { text: tool, dim: true },
  ]
}

function timelineRows(lane: Lane, o: LayoutOpts, t0: number, span: number): Row[] {
  const w = o.width - 2
  const x = (t: number) => Math.max(0, Math.min(w - 1, Math.floor(((t - t0) / span) * (w - 1))))
  const tracks: { until: number; items: { col: number; segs: Seg[] }[] }[] = []
  for (const a of lane.agents) {
    const bar = `[${label(a)} ${GLYPH[a.status]} ${dur(a, o.now)}]`.slice(0, w)
    const col = Math.min(x(Math.max(a.startedAt, t0)), w - bar.length)
    const endCol = Math.max(col + bar.length, x(a.endedAt ?? o.now) + 1)
    const tail = '─'.repeat(Math.max(0, endCol - col - bar.length))
    const segs: Seg[] = [{ text: bar, fg: COLOR[a.status], inverse: a.id === o.selectedId }, { text: tail, fg: COLOR[a.status], dim: true }]
    let track = tracks.find(tr => tr.until < col)
    if (!track) { track = { until: -1, items: [] }; tracks.push(track) }
    track.items.push({ col, segs })
    track.until = endCol
  }
  return tracks.map(tr => {
    const row: Row = [{ text: '  ' }]
    let at = 0
    for (const it of tr.items) {
      if (it.col > at) row.push({ text: ' '.repeat(it.col - at) })
      row.push(...it.segs)
      at = it.col + it.segs.reduce((n, g) => n + g.text.length, 0)
    }
    return row
  })
}

function details(a: Agent, s: Snapshot, o: LayoutOpts): Row[] {
  const pool = resolvePool(a, s.session.project, s.workflows, o.rules)
  const time = (t?: number) => (t === undefined ? '—' : new Date(t).toISOString().slice(11, 19))
  return [
    [{ text: `id ${a.id}  parent ${a.parentId ?? (a.id === 'main' ? '—' : 'main')}  type ${a.type}  pool ${pool.name} (${pool.source})`, dim: true }],
    [{ text: `status ${a.status}  tool ${a.currentTool ?? '—'}  start ${time(a.startedAt)}  end ${time(a.endedAt)}  reason ${a.endReason ?? '—'}`, dim: true }],
  ]
}

export function layout(s: Snapshot, o: LayoutOpts): Row[] {
  const header: Row = [
    { text: 'SWIMTRACE', bold: true },
    { text: `  ${s.session.project.split('/').filter(Boolean).at(-1) ?? s.session.project}  session ${s.session.id.slice(0, 8)}` },
  ]
  if (s.simulated) header.push({ text: ' [SIMULATED]', fg: 'red', bold: true })
  if (isStale(s, o.now)) header.push({ text: ' [STALE]', fg: 'yellow', bold: true })
  if (s.session.endedAt !== undefined) header.push({ text: ' [ENDED]', fg: 'gray', bold: true })

  const body: Row[] = []
  if (o.view === 'agent') {
    for (const { a, depth } of treeOrder(visible(s, o))) body.push(listLine(a, depth, o.now, a.id === o.selectedId))
  } else {
    const ls = lanes(s, o)
    const compact = o.width < COMPACT_BELOW
    const starts = ls.flatMap(l => l.agents.map(a => a.startedAt))
    const t0 = o.zoomMs !== undefined ? o.now - o.zoomMs : Math.min(o.now, ...starts)
    const span = Math.max(1000, o.now - t0)
    if (!compact) body.push([{ text: `  -${fmtDuration(span)} `, dim: true }, { text: '─'.repeat(Math.max(0, o.width - 16)), dim: true }, { text: '▶ now', dim: true }])
    for (const l of ls) {
      body.push([{ text: `${l.pool.name} · ${l.pool.source}`, bold: true }])
      if (compact) for (const a of l.agents) body.push(listLine(a, 0, o.now, a.id === o.selectedId))
      else body.push(...timelineRows(l, o, t0, span))
    }
  }
  const sel = o.expanded ? s.agents.find(a => a.id === o.selectedId) : undefined
  if (sel) body.push(...details(sel, s, o))
  if (s.tasks.length > 0) {
    body.push([{ text: 'Tasks', bold: true }])
    for (const t of s.tasks) {
      const g = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '◌'
      const blocked = t.blockedBy.length > 0 ? ` (blocked by ${t.blockedBy.join(', ')})` : ''
      body.push([{ text: `  #${t.id} ${g} ${t.subject}${blocked}` }])
    }
  }

  const n = (st: Status) => s.agents.filter(a => a.id !== 'main' && a.status === st).length
  const f = s.folded
  const footer: Row = [{
    text: `Running ${n('running')} · Waiting ${n('waiting')} · Done ${n('completed') + f.completed} · Failed ${n('failed') + f.failed} · ` +
      `Stopped ${n('interrupted') + n('killed') + f.interrupted + f.killed} · Unknown ${n('unknown') + f.unknown}`,
    dim: true,
  }]

  const room = Math.max(0, o.height - 2)
  const shown = body.length <= room ? body : [...body.slice(0, Math.max(0, room - 1)), [{ text: `… ${body.length - room + 1} more rows`, dim: true }]]
  return [header, ...shown, footer].map(r => clip(r, o.width))
}
```


- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS. If the "sequential agents share a row" test fails because the tail of `a1` reaches `a2`'s column, check `x()` math at width 120 (a1 ends at 5 s of a 100 s span → col ≈ 5, a2 starts ≈ col 105) before changing anything.

- [ ] **Step 5: Commit**

```bash
git add mod/core/layout.ts test/core/layout.test.ts
git commit -m "feat(core): swimlane layout with compact mode, details, tasks and footer"
```

---

### Task 6: Mod collector + `$.state` contract + snapshot writer

**Files:**
- Create: `mod/.claude-plugin/plugin.json`, `mod/hooks/hooks.json`, `mod/types/index.d.ts`, `mod/hooks/events.ts`, `mod/hooks/register.tsx`
- Test: `mod/test/collector.test.ts`

**Interfaces:**
- Consumes: `emptySnapshot`, `Snapshot`, `DEFAULT_STALE_WORKFLOW_MS` (model); `reduce`, `reduceAll`, `Event` (reducer); `parseConfig`, `ConfigJson` (pools).
- Produces:
  - `$.state` values under plugin `swimtrace`: `snap: Snapshot | undefined`, `config: ConfigJson`, `ui: UiState` with `UiState = { view: 'pool' | 'agent'; runningOnly: boolean; selectedId?: string; expanded: boolean; pick?: string }`
  - `events.ts`: `spawnEvent(e, agentId, at)`, `toolEvents(e, ran, at)`, `turnEndEvent(e, at)`, `listEvents(list, at)` — each returns `Event | Event[] | undefined`
  - `register.tsx` exports `register`; constants `PANE = 'swimtrace'`, `swimtraceDir($)`.

- [ ] **Step 1: Manifest, hooks.json, state contract**

`mod/.claude-plugin/plugin.json`:
```json
{
  "name": "swimtrace",
  "version": "0.1.0",
  "description": "Live swimlanes of Claude Code subagents; observational only",
  "types": "./types/index.d.ts"
}
```
`mod/hooks/hooks.json`:
```json
{ "modules": ["./register.tsx"] }
```
`mod/types/index.d.ts`:
```ts
import type { Snapshot } from '../core/model.ts'
import type { ConfigJson } from '../core/pools.ts'

export type SwimtraceUi = { view: 'pool' | 'agent'; runningOnly: boolean; selectedId?: string; expanded: boolean; pick?: string }

declare module 'claude-code' {
  interface PluginState {
    swimtrace: { snap: Snapshot | undefined; config: ConfigJson; ui: SwimtraceUi }
  }
}
```
(If `claude plugin validate mod` rejects imports in the contract — the reference says a contract is "self-contained … with no import or reference" for **nouns**; state contracts in the examples import nothing either — inline copies of `Snapshot`/`ConfigJson` types there instead and keep them in sync by a type-level assertion in `register.tsx`: `const _check: Snapshot = undefined as unknown as import('../types').SnapshotState`. Try the import first.)

- [ ] **Step 2: Write `mod/hooks/events.ts`** (pure mapping from engine shapes to core events; easy to read and to test through the hooks)

```ts
import type { Event } from '../core/reducer.ts'
import type { ListStatus } from '../core/model.ts'

type SpawnIn = { description: string; subagentType: string; parentAgentId?: string; name?: string; workflow?: { runId: string } }
export const spawnEvent = (e: SpawnIn, agentId: string, at: number): Event => ({
  kind: 'spawn', at, id: agentId, type: e.subagentType, description: e.description,
  parentId: e.parentAgentId, name: e.name, workflowRunId: e.workflow?.runId || undefined,
})

type ToolIn = { tool: string; agentId?: string } & Record<string, unknown>
type ToolOut = { deny?: string; result?: unknown; isError?: boolean }
export function toolEvents(e: ToolIn, ran: ToolOut, at: number): Event[] {
  const out: Event[] = []
  if (e.agentId !== undefined) out.push({ kind: 'toolCall', at, agentId: e.agentId, tool: e.tool })
  else out.push({ kind: 'toolCall', at, agentId: 'main', tool: e.tool })
  if (ran.deny !== undefined || ran.isError === true) return out
  const r = ran.result as Record<string, any> | undefined
  if (e.tool === 'TaskCreate' && typeof r?.task?.id === 'string') out.push({ kind: 'taskCreate', id: r.task.id, subject: String(e.subject ?? r.task.subject) })
  if (e.tool === 'TaskUpdate' && typeof e.taskId === 'string') {
    out.push({ kind: 'taskUpdate', id: e.taskId, subject: typeof e.subject === 'string' ? e.subject : undefined,
      status: typeof e.status === 'string' ? (e.status as never) : undefined,
      addBlockedBy: Array.isArray(e.addBlockedBy) ? (e.addBlockedBy as string[]) : undefined })
  }
  if (e.tool === 'Workflow' && typeof r?.runId === 'string' && typeof r?.workflowName === 'string') out.push({ kind: 'workflowName', runId: r.runId, name: r.workflowName })
  return out
}

type TurnIn = { agentId?: string; reason: 'answer' | 'aborted' | 'refusal' | 'error' }
export const turnEndEvent = (e: TurnIn, at: number): Event =>
  e.agentId === undefined ? { kind: 'mainTurn', at, phase: 'end' } : { kind: 'runEnd', at, agentId: e.agentId, reason: e.reason }

type Info = { id: string; type: string; description: string; status: ListStatus; parentId?: string; name?: string }
export const listEvents = (list: readonly Info[], at: number): Event[] =>
  list.map(a => ({ kind: 'listStatus', at, agentId: a.id, status: a.status, type: a.type, description: a.description, parentId: a.parentId, name: a.name }))
```
Note the privacy rule: only `subject` (the task's short title) and tool **names** leave `events.ts`; never `e.prompt`, `e.command`, file contents or results beyond ids.

- [ ] **Step 3: Write the failing plugin tests** — `mod/test/collector.test.ts`:

```ts
import { test, expect, mock } from 'claude-code/testing'

const snapRef = { plugin: 'swimtrace', key: 'snap' } as const
const getSnap = async ($: any) => (await $.state.get(snapRef)).value

async function boot($: any, on: any) {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, { HOME: '/home/t' })
  const writes: Record<string, string> = {}
  const ids = { current: 'sess-1' }
  on('fs.write', ($: any, e: any) => { writes[e.path] = e.text; return {} })
  on('fs.read', () => { throw new Error('ENOENT') })
  on('session.id', () => ids.current)
  on('agent.list', () => [])
  await $.session.start({ cwd: '/w/proj', surface: 'terminal', isInteractive: true })
  return { clock, writes, ids }
}

test('spawn → tool call → end of run is recorded; results pass through unchanged', async ($, on) => {
  await boot($, on)
  on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }))
  const spawned = await $.agent.spawn({ prompt: 'SECRET PROMPT', description: 'look', subagentType: 'Explore' })
  expect(spawned.agentId).toBe('a1')

  on('tool.call', { tool: 'Grep' }, () => ({ result: { matches: 1 } }))
  const ran = await $.tool.call({ tool: 'Grep', pattern: 'SECRET INPUT', agentId: 'a1' } as never)
  expect((ran as any).result).toEqual({ matches: 1 })

  await $.turn.complete({ answer: 'SECRET ANSWER', durationMs: 5, isAborted: false, turnId: 't', agentId: 'a1', reason: 'answer' })
  const s = await getSnap($)
  const a = s.agents.find((x: any) => x.id === 'a1')
  expect(a.status).toBe('completed')
  expect(a.description).toBe('look')
  expect(JSON.stringify(s)).not.toContain('SECRET')
})

test('snapshot is written under ~/.claude/swimtrace/sessions on the timer, with a heartbeat', async ($, on) => {
  const { clock, writes } = await boot($, on)
  await clock.advance(300)
  const path = '/home/t/.claude/swimtrace/sessions/sess-1.json'
  expect(writes[path]).toBeDefined()
  const first = JSON.parse(writes[path]!).writtenAt
  await clock.advance(2_000)
  expect(JSON.parse(writes[path]!).writtenAt).toBe(first) // idle: no rewrite before the heartbeat
  await clock.advance(3_500)
  expect(JSON.parse(writes[path]!).writtenAt).toBeGreaterThan(first)
})

test('fail-open: a throwing fs.write never breaks a tool call', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, { HOME: '/home/t' })
  on('fs.write', () => { throw new Error('disk full') })
  on('fs.read', () => { throw new Error('ENOENT') })
  on('session.id', () => 'sess-2')
  on('agent.list', () => [])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.advance(1_000)
  on('tool.call', { tool: 'Read' }, () => ({ result: 'ok' }))
  const ran = await $.tool.call({ tool: 'Read', file_path: '/x' } as never)
  expect((ran as any).result).toBe('ok')
})

test('review focus 1: /clear ends the old snapshot; the next event opens one under the new id', async ($, on) => {
  const { clock, writes, ids } = await boot($, on)
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: {} as never })
  await clock.settle()
  await clock.advance(300)
  expect(JSON.parse(writes['/home/t/.claude/swimtrace/sessions/sess-1.json']!).session.endedAt).toBeDefined()
  ids.current = 'sess-new' // what $.session.id() answers after the /clear
  on('tool.call', { tool: 'Read' }, () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Read', file_path: '/x' } as never)
  await clock.advance(300)
  const fresh = JSON.parse(writes['/home/t/.claude/swimtrace/sessions/sess-new.json']!)
  expect(fresh.session.endedAt).toBeUndefined()
})

test('case 10: a reload keeps $.state; session.start does not reset an existing snapshot', async ($, on) => {
  await boot($, on)
  on('agent.spawn', () => ({ model: 'm', agentId: 'keep' }))
  await $.agent.spawn({ prompt: 'p', description: 'd', subagentType: 'Explore' })
  await $.session.start({ cwd: '/w/proj', surface: 'terminal', isInteractive: true }) // what a reload fires
  expect((await getSnap($)).agents.some((a: any) => a.id === 'keep')).toBe(true)
})
```
**Before running:** grep the API file for the exact event names the test hooks stand on for `$.fs.write`, `$.fs.read`, `$.session.id`, `$.agent.list` (`'fs.write'`, `'session.id'`, … in `EventCalls`/`OpEventOf`) and the exact `SessionEndInput.resume` shape; adjust the test's hook names/inputs to match. Each call on `$` is an event hookable by the same name per the reference.

- [ ] **Step 4: Run to verify failure**

Run: `claude plugin test mod`
Expected: FAIL — module `./register.tsx` missing.

- [ ] **Step 5: Implement `mod/hooks/register.tsx` (collector + writer; pane comes in Task 7)**

```tsx
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import { DEFAULT_STALE_WORKFLOW_MS, emptySnapshot, type Snapshot } from '../core/model.ts'
import { reduceAll, type Event } from '../core/reducer.ts'
import { DEFAULT_CONFIG, parseConfig } from '../core/pools.ts'
import { listEvents, spawnEvent, toolEvents, turnEndEvent } from './events.ts'

export const PANE = 'swimtrace'
const snap = atom({ plugin: 'swimtrace', key: 'snap' } as const, undefined as Snapshot | undefined)
const config = atom({ plugin: 'swimtrace', key: 'config' } as const, DEFAULT_CONFIG)

// ponytail: module variables reset on hot reload; the next timer tick rewrites the file anyway
let dirty = true
let lastWrite = 0

export async function swimtraceDir($: EngineInterface): Promise<string> {
  const base = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  return `${base}/swimtrace`
}

async function apply($: EngineInterface, evs: Event[]): Promise<void> {
  if (evs.length === 0) return
  const now = await $.clock.now()
  const cur = await read($, snap)
  if (cur === undefined || cur.session.endedAt !== undefined) {
    // first event of the session, or the first after a /clear: open a new snapshot
    const id = await $.session.id()
    if (cur === undefined || cur.session.id !== id) {
      const fresh = emptySnapshot({ id, project: await $.session.cwd(), startedAt: now })
      await update($, snap, () => reduceAll(fresh, evs))
      dirty = true
      return
    }
  }
  await update($, snap, s => {
    if (s === undefined) return s
    const n = reduceAll(s, evs)
    if (n !== s) dirty = true // reduce returns the same object when nothing changed, so idle ticks write nothing
    return n
  })
}

// Fail open: bookkeeping never throws into the engine. Hooks await it (in-memory only, after next(e) settled);
// disk I/O stays on the 250 ms timer, so no hook waits on the file system.
const safe = async (fn: () => Promise<void>): Promise<void> => { try { await fn() } catch { /* observational: ignore */ } }

async function writeSnapshot($: EngineInterface, force: boolean): Promise<void> {
  const now = await $.clock.now()
  if (!dirty && !force) return
  const s = await read($, snap)
  if (s === undefined) return
  dirty = false
  lastWrite = now
  await $.fs.write(`${await swimtraceDir($)}/sessions/${s.session.id}.json`, JSON.stringify({ ...s, writtenAt: now }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await safe(async () => {
      const dir = await swimtraceDir($)
      const text = await $.fs.read(`${dir}/config.json`).then(t => t as string, () => undefined)
      await update($, config, () => parseConfig(text).config)
      if ((await read($, snap)) === undefined) {
        const now = await $.clock.now()
        const id = await $.session.id()
        await update($, snap, cur => cur ?? emptySnapshot({ id, project: e.cwd, startedAt: now }))
        dirty = true
      }
    })
    // timers outlive the dispatch; they restart on every reload (session.start fires again)
    $.clock.every(250, () => void safe(async () => {
      const now = await $.clock.now()
      await writeSnapshot($, now - lastWrite >= 5_000)
    }))
    $.clock.every(1_000, () => void safe(async () => {
      const now = await $.clock.now()
      const cfg = await read($, config)
      const list = await $.agent.list()
      await apply($, [...listEvents(list as never, now), { kind: 'tick', at: now, staleWorkflowMs: (cfg.staleWorkflowAgentMinutes * 60_000) || DEFAULT_STALE_WORKFLOW_MS }])
    }))
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    await safe(async () => { if (r.agentId) await apply($, [spawnEvent(e, r.agentId, await $.clock.now())]) })
    return r
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    await safe(async () => apply($, toolEvents(e as never, ran as never, await $.clock.now())))
    return ran
  })

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    await safe(async () => apply($, [{ kind: 'mainTurn', at: await $.clock.now(), phase: 'start' }]))
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    await safe(async () => apply($, [turnEndEvent(e, await $.clock.now())]))
    return r
  })

  on('session.end', async ($, e, next) => {
    const r = await next(e)
    await safe(async () => {
      await apply($, [{ kind: 'sessionEnd', at: await $.clock.now(), reason: e.reason }])
      await writeSnapshot($, true)
    })
    return r
  })
}
```

`session.start` creates the snapshot; `apply()` opens a new one only after a `/clear` (the current snapshot ended and `$.session.id()` now differs) or as a safety net when none exists.

Every hook awaits its bookkeeping after `next(e)` settled and before returning, so the result the engine sees is the one `next` gave, and tests can read state right after an event without racing.

- [ ] **Step 6: Run the plugin tests and validate**

Run: `claude plugin validate mod && claude plugin test mod`
Expected: validate lists hooks on `session.start`, `agent.spawn`, `tool.call`, `turn.start`, `turn.complete`, `session.end`; the `tool.call` hook is listed as a gating hook without `.catch` — that is intended (a failing observer is skipped, the call proceeds). All 5 tests PASS.
If a `tool.call` from the test carries no `agentId` field on the input type, cast as written (`as never`); the engine sets it per loop.

- [ ] **Step 7: Commit**

```bash
git add mod/.claude-plugin/plugin.json mod/hooks mod/types mod/test/collector.test.ts
git commit -m "feat(mod): observational collector and per-session snapshot writer"
```

---

### Task 7: Mod pane + `/swimtrace` command

**Files:**
- Modify: `mod/hooks/register.tsx`
- Test: `mod/test/pane.test.tsx`

**Interfaces:**
- Consumes: `layout`, `selectableIds`, `Row`, `Seg` (layout); `compileRules` (pools); `snap`, `config` atoms, `swimtraceDir`, `PANE` (Task 6).
- Produces: command `/swimtrace` (opens pane, reloads config); `ui` atom `{ plugin: 'swimtrace', key: 'ui' }`; buttons keyed `view`, `running`, `next`, `prev`, `details`, `session`.

- [ ] **Step 1: Write failing pane test** — `mod/test/pane.test.tsx`:

```tsx
import { test, expect, mock } from 'claude-code/testing'

const PANE = { component: 'Pane', requestId: 'swimtrace', props: { title: 'SwimTrace', isFocused: true, bodyColumns: 100 } } as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane draws lanes and toggles the agent view on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 10_000 })
    mock.env(on, { HOME: '/h' })
    on('fs.write', () => ({}))
    on('fs.read', () => { throw new Error('ENOENT') })
    on('session.id', () => 's')
    on('agent.list', () => [])
    await $.session.start({ cwd: '/w/proj', surface, isInteractive: true })
    on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }))
    await $.agent.spawn({ prompt: 'p', description: 'scan repo', subagentType: 'Explore' })

    const ui = await $.ui.mount({ plugin: 'swimtrace', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /SWIMTRACE/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Explore · type/ })).toBeDefined()
    await ui.press({ key: 'view' })
    expect(await ui.find({ type: 'Text', text: /Explore · type/ })).toBeUndefined()
    await ui.unmount()
  })
}
```
(Check `MountTarget` in the API file for the exact fields `mount` takes — `component`, `requestId`, `props` — and adjust.)

- [ ] **Step 2: Run to verify failure**

Run: `claude plugin test mod`
Expected: FAIL — no Pane render hook.

- [ ] **Step 3: Implement** — add to `register.tsx`:

```tsx
import { compileRules } from '../core/pools.ts'
import { layout, selectableIds, type Row } from '../core/layout.ts'
import type { SwimtraceUi } from '../types'

const ui = atom({ plugin: 'swimtrace', key: 'ui' } as const, { view: 'pool', runningOnly: false, expanded: false } as SwimtraceUi)

async function otherSessions($: EngineInterface): Promise<string[]> {
  const dir = `${await swimtraceDir($)}/sessions`
  const entries = await $.fs.list(dir).catch(() => [])
  return entries.filter(x => x.name.endsWith('.json')).sort((a, b) => b.mtimeMs - a.mtimeMs).map(x => `${dir}/${x.name}`)
}
```

Inside `register`, in the `session.start` hook (after timers):
```tsx
    await $.command.register({ name: 'swimtrace', description: 'Show the SwimTrace swimlane pane' })
```
and add the 1 s redraw while the pane is open (durations move even when no event arrives), inside the existing 1 s timer:
```tsx
      $.ui.invalidate('ui.render')
```

New hooks:
```tsx
  on('command.run', { command: 'swimtrace' }, async $ => {
    const text = await $.fs.read(`${await swimtraceDir($)}/config.json`).then(t => t as string, () => undefined)
    const parsed = parseConfig(text)
    await update($, config, () => parsed.config)
    await $.ui.open({ id: PANE, title: 'SwimTrace' })
    return { text: parsed.warnings.length ? `SwimTrace opened. Config: ${parsed.warnings.join('; ')}` : 'SwimTrace opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const u = await read($, ui)
    const cfg = await read($, config)
    const own = await read($, snap)
    const s = u.pick === undefined ? own : await $.fs.read(u.pick).then(t => JSON.parse(t as string), () => own)
    if (s === undefined) return <Text dimColor>SwimTrace: no session yet.</Text>
    const { rules } = compileRules(cfg.rules)
    const now = await $.clock.now()
    const width = e.props.bodyColumns
    const rows: Row[] = layout(s, { width, height: Math.max(8, (e.viewport?.rows ?? 30) - 4), now, view: u.view,
      runningOnly: u.runningOnly, selectedId: u.selectedId, expanded: u.expanded, rules })
    const ids = selectableIds(s, { view: u.view, runningOnly: u.runningOnly, rules })
    const move = (d: number) => update($, ui, x => {
      const i = ids.indexOf(x.selectedId ?? '')
      return { ...x, selectedId: ids[Math.max(0, Math.min(ids.length - 1, i + d))] }
    })
    const cycle = async () => {
      const files = await otherSessions($)
      update($, ui, x => {
        const i = x.pick === undefined ? -1 : files.indexOf(x.pick)
        return { ...x, pick: i + 1 < files.length ? files[i + 1] : undefined }
      })
    }
    return (
      <Box flexDirection="column">
        {rows.map(r => (
          <Text>{r.map(g => <Text color={g.fg} bold={g.bold} dimColor={g.dim} inverse={g.inverse}>{g.text}</Text>)}</Text>
        ))}
        <Box flexDirection="row">
          <Button key="view" hotkey="g" plain onPress={() => update($, ui, x => ({ ...x, view: x.view === 'pool' ? 'agent' : 'pool' }))}>{u.view === 'pool' ? 'agents' : 'pools'}</Button>
          <Button key="running" hotkey="r" plain onPress={() => update($, ui, x => ({ ...x, runningOnly: !x.runningOnly }))}>running</Button>
          <Button key="next" hotkey="j" plain onPress={() => move(1)}>next</Button>
          <Button key="prev" hotkey="k" plain onPress={() => move(-1)}>prev</Button>
          <Button key="details" hotkey="d" plain onPress={() => update($, ui, x => ({ ...x, expanded: !x.expanded }))}>details</Button>
          <Button key="session" hotkey="n" plain onPress={() => cycle()}>{u.pick === undefined ? 'this session' : 'other session'}</Button>
        </Box>
      </Box>
    )
  })
```
Buttons with `plain` and a `hotkey` draw as `g: agents` etc. If the surface refuses nested `Text` inside `Text`, the transcript line `swimtrace: ui.render (Pane) refused: <reason>` says so — then flatten each row to a `Box flexDirection="row"` of `Text` children.

- [ ] **Step 4: Run tests and validate**

Run: `claude plugin validate mod && claude plugin test mod`
Expected: all collector and pane tests PASS on both surfaces.

- [ ] **Step 5: Commit**

```bash
git add mod/hooks/register.tsx mod/test/pane.test.tsx
git commit -m "feat(mod): swimlane pane and /swimtrace command"
```

---

### Task 8: CLI snapshot reader

**Files:**
- Create: `cli/snapshots.ts`
- Test: `test/cli/snapshots.test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `STALE_SESSION_MS` (model); `isStale` (layout).
- Produces:
  - `function swimtraceDir(env?: NodeJS.ProcessEnv): string`
  - `function readSnapshot(path: string, lastGood?: Snapshot): { snap?: Snapshot; error?: string }`
  - `interface SessionEntry { path: string; snap: Snapshot; stale: boolean; mtimeMs: number }`
  - `function listSessions(dir: string, now: number, cache?: Map<string, Snapshot>): SessionEntry[]` — newest first; reads every `*.json`; uses `cache` as last-good per path and updates it
  - `function pruneOld(dir: string, now: number, maxAgeMs?: number): number` — deletes `*.json` older than 7 days, returns count
  - `function pickSession(entries: SessionEntry[], cwd: string): SessionEntry | undefined` — newest live entry whose project is `cwd`, else newest

- [ ] **Step 1: Write failing tests** — `test/cli/snapshots.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptySnapshot, type Snapshot } from '../../mod/core/model.ts'
import { listSessions, pickSession, pruneOld, readSnapshot, swimtraceDir } from '../../cli/snapshots.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'swt-'))
const snap = (id: string, project: string, writtenAt: number, endedAt?: number): Snapshot =>
  ({ ...emptySnapshot({ id, project, startedAt: 0, endedAt }), writtenAt })

test('swimtraceDir honours CLAUDE_CONFIG_DIR', () => {
  assert.equal(swimtraceDir({ CLAUDE_CONFIG_DIR: '/c', HOME: '/h' }), '/c/swimtrace')
  assert.equal(swimtraceDir({ HOME: '/h' }), '/h/.claude/swimtrace')
})

test('review focus 3 / case 8: a half-written file keeps the last good snapshot', () => {
  const d = dir()
  const p = join(d, 's.json')
  writeFileSync(p, JSON.stringify(snap('s', '/p', 1)))
  const good = readSnapshot(p).snap!
  writeFileSync(p, '{"v":1,"sess')
  const r = readSnapshot(p, good)
  assert.equal(r.snap, good)
  assert.match(r.error!, /JSON/)
})

test('unknown snapshot versions are skipped with an error', () => {
  const d = dir()
  const p = join(d, 's.json')
  writeFileSync(p, JSON.stringify({ ...snap('s', '/p', 1), v: 2 }))
  const r = readSnapshot(p)
  assert.equal(r.snap, undefined)
  assert.match(r.error!, /version/)
})

test('case 6: several sessions listed newest first, stale flagged', () => {
  const d = dir()
  writeFileSync(join(d, 'a.json'), JSON.stringify(snap('a', '/p1', 100_000)))
  writeFileSync(join(d, 'b.json'), JSON.stringify(snap('b', '/p2', 1_000)))
  writeFileSync(join(d, 'junk.txt'), 'x')
  utimesSync(join(d, 'b.json'), 1, 1)
  const list = listSessions(d, 110_000)
  assert.deepEqual(list.map(e => e.snap.session.id), ['a', 'b'])
  assert.equal(list[0]!.stale, false)
  assert.equal(list[1]!.stale, true)
})

test('pickSession prefers a live session of the current project', () => {
  const e = (id: string, project: string, endedAt?: number) => ({ path: id, snap: snap(id, project, 0, endedAt), stale: false, mtimeMs: 0 })
  assert.equal(pickSession([e('x', '/other'), e('y', '/me', 5), e('z', '/me')], '/me')!.snap.session.id, 'z')
  assert.equal(pickSession([e('x', '/other')], '/me')!.snap.session.id, 'x')
  assert.equal(pickSession([], '/me'), undefined)
})

test('case 10: a restarted CLI rebuilds from files alone', () => {
  const d = dir()
  writeFileSync(join(d, 'a.json'), JSON.stringify(snap('a', '/p', 5)))
  assert.equal(listSessions(d, 6).length, 1) // no prior cache needed
})

test('pruneOld deletes snapshots older than 7 days only', () => {
  const d = dir()
  writeFileSync(join(d, 'old.json'), '{}')
  writeFileSync(join(d, 'new.json'), '{}')
  const now = Date.now()
  utimesSync(join(d, 'old.json'), (now - 8 * 86_400_000) / 1000, (now - 8 * 86_400_000) / 1000)
  assert.equal(pruneOld(d, now), 1)
  assert.equal(existsSync(join(d, 'old.json')), false)
  assert.equal(existsSync(join(d, 'new.json')), true)
})

test('a missing directory lists nothing', () => {
  assert.deepEqual(listSessions('/nope/never', 0), [])
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — cannot find `cli/snapshots.ts`.

- [ ] **Step 3: Implement `cli/snapshots.ts`**

```ts
import { readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Snapshot } from '../mod/core/model.ts'
import { isStale } from '../mod/core/layout.ts'

export function swimtraceDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? '', '.claude'), 'swimtrace')
}

export function readSnapshot(path: string, lastGood?: Snapshot): { snap?: Snapshot; error?: string } {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch (err) {
    return { snap: lastGood, error: `${path}: not readable JSON (${(err as Error).message})` }
  }
  const s = raw as Partial<Snapshot> | null
  if (s?.v !== 1) return { snap: undefined, error: `${path}: unknown snapshot version ${String(s?.v)}` }
  if (typeof s.session?.id !== 'string' || !Array.isArray(s.agents)) return { snap: lastGood, error: `${path}: malformed snapshot` }
  return { snap: s as Snapshot }
}

export interface SessionEntry { path: string; snap: Snapshot; stale: boolean; mtimeMs: number }

export function listSessions(dir: string, now: number, cache = new Map<string, Snapshot>()): SessionEntry[] {
  let names: string[]
  try { names = readdirSync(dir).filter(n => n.endsWith('.json')) } catch { return [] }
  const out: SessionEntry[] = []
  for (const n of names) {
    const path = join(dir, n)
    const { snap } = readSnapshot(path, cache.get(path))
    if (snap === undefined) continue
    cache.set(path, snap)
    let mtimeMs = 0
    try { mtimeMs = statSync(path).mtimeMs } catch { /* raced a delete */ }
    out.push({ path, snap, stale: isStale(snap, now), mtimeMs })
  }
  return out.sort((a, b) => b.snap.writtenAt - a.snap.writtenAt)
}

export function pruneOld(dir: string, now: number, maxAgeMs = 7 * 86_400_000): number {
  let n = 0
  let names: string[] = []
  try { names = readdirSync(dir).filter(x => x.endsWith('.json')) } catch { return 0 }
  for (const name of names) {
    const p = join(dir, name)
    try { if (now - statSync(p).mtimeMs > maxAgeMs) { rmSync(p); n++ } } catch { /* ignore */ }
  }
  return n
}

export function pickSession(entries: SessionEntry[], cwd: string): SessionEntry | undefined {
  const live = (e: SessionEntry) => e.snap.session.endedAt === undefined && !e.stale
  return entries.find(e => e.snap.session.project === cwd && live(e)) ?? entries.find(e => e.snap.session.project === cwd) ?? entries[0]
}
```

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/snapshots.ts test/cli/snapshots.test.ts
git commit -m "feat(cli): snapshot reader with last-good, staleness, pruning"
```

---

### Task 9: CLI terminal renderer + interactive loop

**Files:**
- Create: `cli/term.ts`, `cli/main.ts`
- Test: `test/cli/term.test.ts`

**Interfaces:**
- Consumes: `layout`, `selectableIds`, `Row`, `LayoutOpts`, `View` (layout); `parseConfig`, `compileRules` (pools); everything from `snapshots.ts`.
- Produces:
  - `term.ts`: `function toAnsi(row: Row): string`; `function diffFrame(prev: string[], next: string[]): string` (escape sequence writing only changed lines, clearing leftovers); `const ALT_ON`, `ALT_OFF`, `HIDE_CURSOR`, `SHOW_CURSOR`
  - `main.ts`: `async function main(argv: string[]): Promise<number>` and the `#!/usr/bin/env node` entry; `function sessionListRows(entries, selected, width): Row[]`

- [ ] **Step 1: Write failing tests** — `test/cli/term.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffFrame, toAnsi } from '../../cli/term.ts'

test('toAnsi colours, bolds, dims and resets every segment', () => {
  assert.equal(toAnsi([{ text: 'a' }, { text: 'b', fg: 'red', bold: true }]), 'a\x1b[1;31mb\x1b[0m')
  assert.equal(toAnsi([{ text: 'c', dim: true, inverse: true }]), '\x1b[2;7mc\x1b[0m')
})

test('diffFrame rewrites only changed lines and clears removed ones', () => {
  const out = diffFrame(['a', 'b', 'c'], ['a', 'X', ''])
  assert.ok(!out.includes('\x1b[1;1H')) // line 1 unchanged
  assert.ok(out.includes('\x1b[2;1H\x1b[2KX'))
  assert.ok(out.includes('\x1b[3;1H\x1b[2K'))
  assert.equal(diffFrame(['a'], ['a']), '')
  assert.ok(diffFrame(['a', 'b'], ['a']).includes('\x1b[2;1H\x1b[2K')) // shrink clears leftover
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — cannot find `cli/term.ts`.

- [ ] **Step 3: Implement `cli/term.ts`**

```ts
import type { Fg, Row } from '../mod/core/layout.ts'

const FG: Record<Fg, number> = { red: 31, green: 32, yellow: 33, magenta: 35, cyan: 36, gray: 90 }
export const ALT_ON = '\x1b[?1049h'
export const ALT_OFF = '\x1b[?1049l'
export const HIDE_CURSOR = '\x1b[?25l'
export const SHOW_CURSOR = '\x1b[?25h'

export function toAnsi(row: Row): string {
  return row.map(g => {
    const codes = [g.bold && 1, g.dim && 2, g.inverse && 7, g.fg && FG[g.fg]].filter(Boolean)
    return codes.length ? `\x1b[${codes.join(';')}m${g.text}\x1b[0m` : g.text
  }).join('')
}

export function diffFrame(prev: string[], next: string[]): string {
  let out = ''
  const n = Math.max(prev.length, next.length)
  for (let i = 0; i < n; i++) {
    if (prev[i] === next[i]) continue
    out += `\x1b[${i + 1};1H\x1b[2K${next[i] ?? ''}`
  }
  return out
}
```

- [ ] **Step 4: Run term tests**

Run: `npm test`
Expected: term tests PASS.

- [ ] **Step 5: Implement `cli/main.ts`** (the interactive loop; exercised manually and by `sim` in Task 10)

```ts
#!/usr/bin/env node
import { readFileSync, realpathSync, watch, rmSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { emitKeypressEvents } from 'node:readline'
import { compileRules, parseConfig } from '../mod/core/pools.ts'
import { fmtDuration, layout, selectableIds, type Row, type View } from '../mod/core/layout.ts'
import { listSessions, pickSession, pruneOld, swimtraceDir, type SessionEntry } from './snapshots.ts'
import { ALT_OFF, ALT_ON, HIDE_CURSOR, SHOW_CURSOR, diffFrame, toAnsi } from './term.ts'

const HELP = `swimtrace — swimlanes for Claude Code subagents

  swimtrace            follow the newest live session of this directory
  swimtrace --all      start at the list of all sessions
  swimtrace sim <fanout|failure|workflow|multi-session|crash> [--speed N]
  swimtrace clean      delete ~/.claude/swimtrace (snapshots, sim data, config)

keys: ↑/↓ select · Enter details · g pools/agents · r running only · +/- zoom · l session list · Tab next session · q quit`

export function sessionListRows(entries: SessionEntry[], selected: number, width: number): Row[] {
  const rows: Row[] = [[{ text: 'SWIMTRACE — sessions', bold: true }]]
  entries.forEach((e, i) => {
    const s = e.snap
    const state = s.session.endedAt !== undefined ? 'ended' : e.stale ? 'stale' : 'live'
    const running = s.agents.filter(a => a.status === 'running' && a.id !== 'main').length
    const text = `  ${s.session.project}  ${s.session.id.slice(0, 8)}  ${state}  running ${running}  age ${fmtDuration(Date.now() - s.session.startedAt)}`
    rows.push([{ text: text.slice(0, width), inverse: i === selected, fg: state === 'live' ? 'cyan' : 'gray' }])
  })
  if (entries.length === 0) rows.push([{ text: '  No sessions yet. Is the swimtrace mod installed?', dim: true }])
  return rows
}

export async function viewer(dir: string, startInList: boolean): Promise<number> {
  const out = process.stdout
  const cache = new Map()
  const cfgText = (() => { try { return readFileSync(join(swimtraceDir(), 'config.json'), 'utf8') } catch { return undefined } })()
  const parsed = parseConfig(cfgText)
  const { rules, warnings } = compileRules(parsed.config.rules)
  let entries: SessionEntry[] = []
  let current: string | undefined
  let listMode = startInList
  let listSel = 0
  let view: View = 'pool'
  let runningOnly = false
  let expanded = false
  let selectedId: string | undefined
  let zoomMs: number | undefined
  let prev: string[] = []
  const notes = [...parsed.warnings, ...warnings]

  const refresh = () => {
    entries = listSessions(dir, Date.now(), cache)
    if (current === undefined || !entries.some(e => e.path === current)) current = pickSession(entries, process.cwd())?.path
  }
  const draw = () => {
    const width = out.columns ?? 80
    const height = out.rows ?? 24
    const cur = entries.find(e => e.path === current)
    let rows: Row[]
    if (listMode || cur === undefined) rows = sessionListRows(entries, listSel, width)
    else rows = layout(cur.snap, { width, height, now: Date.now(), view, runningOnly, selectedId, expanded, zoomMs, rules })
    if (notes.length) rows = [...rows.slice(0, height - 1), [{ text: `config: ${notes[0]}`.slice(0, width), fg: 'yellow' }]]
    const next = rows.slice(0, height).map(toAnsi)
    out.write(diffFrame(prev, next))
    prev = next
  }
  const redrawAll = () => { prev = []; out.write('\x1b[2J'); draw() }

  refresh()
  out.write(ALT_ON + HIDE_CURSOR)
  redrawAll()

  let watcher: FSWatcher | undefined
  try { watcher = watch(dir, () => { refresh(); draw() }) } catch { /* dir may not exist yet; the poll covers it */ }
  const poll = setInterval(() => { refresh(); draw() }, 1000)
  out.on('resize', redrawAll)

  return await new Promise<number>(resolve => {
    const quit = () => {
      clearInterval(poll); watcher?.close()
      process.stdin.setRawMode?.(false); process.stdin.pause()
      out.write(SHOW_CURSOR + ALT_OFF)
      resolve(0)
    }
    process.on('SIGINT', quit)
    process.on('SIGTERM', quit)
    emitKeypressEvents(process.stdin)
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    process.stdin.on('keypress', (_str: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      const cur = entries.find(e => e.path === current)
      const ids = cur ? selectableIds(cur.snap, { view, runningOnly, rules }) : []
      const moveSel = (d: number) => {
        if (listMode) listSel = Math.max(0, Math.min(entries.length - 1, listSel + d))
        else { const i = ids.indexOf(selectedId ?? ''); selectedId = ids[Math.max(0, Math.min(ids.length - 1, i + d))] }
      }
      switch (key.ctrl && key.name === 'c' ? 'q' : key.name ?? key.sequence) {
        case 'q': return quit()
        case 'up': moveSel(-1); break
        case 'down': moveSel(1); break
        case 'return':
          if (listMode && entries[listSel]) { current = entries[listSel]!.path; listMode = false; selectedId = undefined }
          else expanded = !expanded
          break
        case 'g': view = view === 'pool' ? 'agent' : 'pool'; break
        case 'r': runningOnly = !runningOnly; break
        case 'l': listMode = !listMode; break
        case 'tab': {
          const i = entries.findIndex(e => e.path === current)
          current = entries[(i + 1) % Math.max(1, entries.length)]?.path; selectedId = undefined
          break
        }
        case '+': case '=': zoomMs = Math.max(10_000, Math.floor((zoomMs ?? 600_000) / 2)); break
        case '-': zoomMs = zoomMs === undefined ? undefined : zoomMs * 2 > 86_400_000 ? undefined : zoomMs * 2; break
        default: return
      }
      draw()
    })
  })
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv
  const root = swimtraceDir()
  if (cmd === '--help' || cmd === '-h') { console.log(HELP); return 0 }
  if (cmd === 'clean') { rmSync(root, { recursive: true, force: true }); console.log(`removed ${root}`); return 0 }
  if (cmd === 'sim') {
    const { runSim } = await import('./sim.ts')
    const speedAt = argv.indexOf('--speed')
    const speed = speedAt > 0 ? Number(argv[speedAt + 1]) || 1 : 1
    return runSim(arg ?? 'fanout', join(root, 'sim'), speed, d => viewer(d, false))
  }
  if (!process.stdout.isTTY) { console.error('swimtrace needs a terminal (TTY).'); return 1 }
  pruneOld(join(root, 'sessions'), Date.now())
  return viewer(join(root, 'sessions'), cmd === '--all')
}

// argv[1] is the npm bin symlink after a global install; compare real paths
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(code => process.exit(code), err => { process.stdout.write(SHOW_CURSOR + ALT_OFF); console.error(err); process.exit(1) })
}
```
Note: `await import('./sim.ts')` is fine in the CLI (only the **mod** forbids `import()`); with `rewriteRelativeImportExtensions` the built file imports `./sim.js`.

- [ ] **Step 6: Manual check against a hand-written snapshot**

```bash
D=$(mktemp -d) && mkdir -p "$D/swimtrace/sessions"
node -e "
const n=Date.now(), s={v:1,simulated:true,session:{id:'demo1234',project:process.cwd(),startedAt:n-60000},writtenAt:n,
agents:[{id:'main',type:'main',description:'main',status:'running',startedAt:n-60000,lastSeenAt:n},
{id:'a',type:'Explore',description:'scan',status:'running',startedAt:n-30000,lastSeenAt:n,currentTool:'Grep'}],
tasks:[],workflows:{},folded:{completed:0,failed:0,interrupted:0,killed:0,unknown:0}};
require('fs').writeFileSync(process.argv[1]+'/swimtrace/sessions/demo.json',JSON.stringify(s))" "$D"
CLAUDE_CONFIG_DIR="$D" node cli/main.ts
```
(The snapshot's `writtenAt` is fixed, so the header turns `[STALE]` after 15 s — that is correct behaviour.)
Expected: header with `[SIMULATED]`, `MAIN · main` and `Explore · type` lanes, keys work, resizing the window redraws, `q` restores the terminal.

- [ ] **Step 7: Commit**

```bash
git add cli/term.ts cli/main.ts test/cli/term.test.ts
git commit -m "feat(cli): ANSI renderer and interactive swimlane viewer"
```

---

### Task 10: Simulation mode + clean

**Files:**
- Create: `cli/sim.ts`
- Test: `test/cli/sim.test.ts`

**Interfaces:**
- Consumes: `emptySnapshot`, `Snapshot` (model); `reduce`, `Event` (reducer).
- Produces:
  - `type Step = { after: number; ev: Event | ((now: number) => Event) }` — `after` is ms since the previous step
  - `const SCENARIOS: Record<string, { sessions: { id: string; project: string; steps: Step[] }[]; stopWritingAfterMs?: number }>`
  - `function playInstant(name: string, start: number): Snapshot[]` — applies all steps at once (for tests)
  - `async function runSim(name: string, dir: string, speed: number, view: (dir: string) => Promise<number>): Promise<number>`

- [ ] **Step 1: Write failing tests** — `test/cli/sim.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SCENARIOS, playInstant } from '../../cli/sim.ts'

test('every scenario produces simulated snapshots only', () => {
  for (const name of Object.keys(SCENARIOS)) {
    const snaps = playInstant(name, 1_000_000)
    assert.ok(snaps.length >= 1, name)
    assert.ok(snaps.every(s => s.simulated === true), name)
  }
})

test('fanout ends with parallel agents done and a running reviewer', () => {
  const [s] = playInstant('fanout', 0)
  assert.equal(s!.agents.filter(a => a.type === 'Explore' && a.status === 'completed').length, 3)
  assert.ok(s!.agents.some(a => a.type === 'reviewer' && a.status === 'running'))
})

test('failure covers failed, interrupted and killed', () => {
  const [s] = playInstant('failure', 0)
  const st = new Set(s!.agents.map(a => a.status))
  for (const x of ['failed', 'interrupted', 'killed']) assert.ok(st.has(x as never), x)
})

test('multi-session yields two sessions in different projects', () => {
  const snaps = playInstant('multi-session', 0)
  assert.equal(snaps.length, 2)
  assert.notEqual(snaps[0]!.session.project, snaps[1]!.session.project)
})

test('workflow agents carry the run id and the workflow name is known', () => {
  const [s] = playInstant('workflow', 0)
  assert.equal(s!.workflows.wf_sim, 'review-changes')
  assert.ok(s!.agents.filter(a => a.workflowRunId === 'wf_sim').length >= 4)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — cannot find `cli/sim.ts`.

- [ ] **Step 3: Implement `cli/sim.ts`**

```ts
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { emptySnapshot, type Snapshot } from '../mod/core/model.ts'
import { reduce, type Event } from '../mod/core/reducer.ts'

export type Step = { after: number; ev: Event | ((now: number) => Event) }
type Scenario = { sessions: { id: string; project: string; steps: Step[] }[]; stopWritingAfterMs?: number }

const sp = (id: string, type: string, description: string, extra: Partial<Extract<Event, { kind: 'spawn' }>> = {}) =>
  (now: number): Event => ({ kind: 'spawn', at: now, id, type, description, ...extra })
const end = (agentId: string, reason: 'answer' | 'error' | 'aborted' | 'refusal') =>
  (now: number): Event => ({ kind: 'runEnd', at: now, agentId, reason })
const tool = (agentId: string, t: string) => (now: number): Event => ({ kind: 'toolCall', at: now, agentId, tool: t })
const turn = (phase: 'start' | 'end') => (now: number): Event => ({ kind: 'mainTurn', at: now, phase })

const fanout: Step[] = [
  { after: 0, ev: turn('start') },
  { after: 500, ev: sp('e1', 'Explore', 'map auth module') },
  { after: 100, ev: sp('e2', 'Explore', 'map billing module') },
  { after: 100, ev: sp('e3', 'Explore', 'map api routes') },
  { after: 1500, ev: tool('e1', 'Grep') }, { after: 300, ev: tool('e2', 'Read') }, { after: 300, ev: tool('e3', 'Glob') },
  { after: 3000, ev: end('e2', 'answer') }, { after: 1500, ev: end('e1', 'answer') }, { after: 1000, ev: end('e3', 'answer') },
  { after: 800, ev: sp('rv', 'reviewer', '[pool:Review] review findings') },
  { after: 500, ev: tool('rv', 'Read') },
]

export const SCENARIOS: Record<string, Scenario> = {
  fanout: { sessions: [{ id: 'sim-fanout', project: '/sim/project-alpha', steps: fanout }] },
  failure: { sessions: [{ id: 'sim-failure', project: '/sim/project-beta', steps: [
    { after: 0, ev: turn('start') },
    { after: 300, ev: sp('ok', 'implementer', 'add endpoint') },
    { after: 100, ev: sp('bad', 'implementer', 'migrate db') },
    { after: 100, ev: sp('stop', 'Explore', 'long scan') },
    { after: 100, ev: sp('kill', 'Explore', 'stuck scan') },
    { after: 2000, ev: end('bad', 'error') },
    { after: 1000, ev: end('stop', 'aborted') },
    { after: 1000, ev: (now: number): Event => ({ kind: 'listStatus', at: now, agentId: 'kill', status: 'killed', type: 'Explore', description: 'stuck scan' }) },
    { after: 1000, ev: end('ok', 'answer') },
  ] }] },
  workflow: { sessions: [{ id: 'sim-workflow', project: '/sim/project-gamma', steps: [
    { after: 0, ev: turn('start') },
    { after: 200, ev: { kind: 'workflowName', runId: 'wf_sim', name: 'review-changes' } },
    { after: 200, ev: sp('w1', 'reviewer', 'review:correctness', { workflowRunId: 'wf_sim' }) },
    { after: 100, ev: sp('w2', 'reviewer', 'review:security', { workflowRunId: 'wf_sim' }) },
    { after: 2500, ev: end('w1', 'answer') },
    { after: 200, ev: sp('w3', 'general-purpose', 'verify:correctness', { workflowRunId: 'wf_sim' }) },
    { after: 1500, ev: end('w2', 'answer') },
    { after: 200, ev: sp('w4', 'general-purpose', 'verify:security', { workflowRunId: 'wf_sim' }) },
    { after: 2000, ev: end('w3', 'answer') },
  ] }] },
  'multi-session': { sessions: [
    { id: 'sim-multi-a', project: '/sim/project-alpha', steps: fanout },
    { id: 'sim-multi-b', project: '/sim/project-delta', steps: [
      { after: 0, ev: turn('start') }, { after: 700, ev: sp('p', 'Plan', 'plan refactor') }, { after: 4000, ev: end('p', 'answer') }, { after: 200, ev: turn('end') },
    ] },
  ] },
  crash: { stopWritingAfterMs: 3000, sessions: [{ id: 'sim-crash', project: '/sim/project-epsilon', steps: [
    { after: 0, ev: turn('start') }, { after: 500, ev: sp('c1', 'Explore', 'scan before crash') }, { after: 500, ev: tool('c1', 'Grep') },
  ] }] },
}

const resolve = (ev: Step['ev'], now: number): Event => (typeof ev === 'function' ? ev(now) : ev)

export function playInstant(name: string, start: number): Snapshot[] {
  const sc = SCENARIOS[name]
  if (!sc) throw new Error(`unknown scenario ${name}`)
  return sc.sessions.map(({ id, project, steps }) => {
    let now = start
    let s = emptySnapshot({ id, project, startedAt: start }, true)
    for (const st of steps) { now += st.after; s = reduce(s, resolve(st.ev, now)) }
    return { ...s, writtenAt: now }
  })
}

export async function runSim(name: string, dir: string, speed: number, view: (dir: string) => Promise<number>): Promise<number> {
  const sc = SCENARIOS[name]
  if (!sc) { console.error(`unknown scenario "${name}"; choose: ${Object.keys(SCENARIOS).join(', ')}`); return 1 }
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const t0 = Date.now()
  const timers: NodeJS.Timeout[] = []
  for (const { id, project, steps } of sc.sessions) {
    let s = emptySnapshot({ id, project, startedAt: t0 }, true)
    const path = join(dir, `${id}.json`)
    const write = () => {
      if (sc.stopWritingAfterMs !== undefined && Date.now() - t0 > sc.stopWritingAfterMs / speed) return // simulated crash: heartbeat stops
      writeFileSync(path, JSON.stringify({ ...s, writtenAt: Date.now() }))
    }
    let at = 0
    for (const st of steps) {
      at += st.after / speed
      timers.push(setTimeout(() => { s = reduce(s, resolve(st.ev, Date.now())); write() }, at))
    }
    timers.push(setInterval(write, 1000))
    write()
  }
  try { return await view(dir) } finally { timers.forEach(clearTimeout) }
}
```
(`clearTimeout` also clears intervals in Node.)

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Manual check of every scenario (case 9 resize, case 7 crash)**

Run each, resize the terminal while it plays, press `q`:
```bash
node cli/main.ts sim fanout
node cli/main.ts sim failure
node cli/main.ts sim workflow
node cli/main.ts sim multi-session   # Tab switches sessions, l opens the list
node cli/main.ts sim crash           # header shows [STALE] ~15 s after start
```
Expected: `[SIMULATED]` on every screen; nothing written under `~/.claude/swimtrace/sessions/`.
Then: `ls ~/.claude/swimtrace/sessions 2>/dev/null` shows no `sim-*` files.

- [ ] **Step 6: Commit**

```bash
git add cli/sim.ts test/cli/sim.test.ts
git commit -m "feat(cli): simulation scenarios"
```

---

### Task 11: Packaging, docs, spec amendments

**Files:**
- Create: `.claude-plugin/marketplace.json`, `README.md`
- Modify: `docs/superpowers/specs/2026-10-12-swimtrace-design.md` (§5.1 remove `pool` from `Agent`, note render-time resolution; §5.3 drop the 7-day prune from `session.start`; §7 pane keys = button hotkeys; §9 prune note)

**Interfaces:**
- Consumes: everything.
- Produces: `npm run build` → `dist/cli/main.js`; `claude plugin validate .` passes; README install lines.

- [ ] **Step 1: Marketplace file**

`.claude-plugin/marketplace.json`:
```json
{
  "name": "swimtrace",
  "owner": { "name": "ian-exnodes" },
  "plugins": [{ "name": "swimtrace", "source": "./mod", "description": "Live swimlanes of Claude Code subagents" }]
}
```

- [ ] **Step 2: README.md**

````markdown
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

- `/swimtrace` in Claude Code opens the pane. Keys (while the pane has focus): `g` pools/agents, `r` running only,
  `j`/`k` select, `d` details, `n` other sessions.
- `swimtrace` in another terminal (a tmux split works well) follows the newest live session of the current directory.
  `swimtrace --all` starts at the session list. Keys: ↑/↓, Enter, `g`, `r`, `+`/`-` zoom, `l` list, Tab, `q`.
- `swimtrace sim fanout|failure|workflow|multi-session|crash` plays synthetic events (no tokens), marked `SIMULATED`.

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
    { "match": { "description": "^\\[T\\d+\\] (\\S+)" }, "pool": "$1" }
  ],
  "staleWorkflowAgentMinutes": 10
}
```

`match` keys: `type`, `name`, `description`, `project` (regexes; all must match). `$1`… use the capture groups of
the first key (in that order) that has groups.

## What it can and cannot see

| Shown | From |
| --- | --- |
| start, end, duration, parent of every subagent | Claude Code's own agent events |
| completed / failed / interrupted | how each agent's run ended |
| killed, waiting | Claude Code's agent list (not for workflow agents) |
| current tool (name only) | tool-call events |
| tasks and their blockers | only when the TaskCreate/TaskUpdate tools are used |

Never shown: progress percentages, prompts, tool inputs or outputs, answers. A workflow agent silent for
`staleWorkflowAgentMinutes` shows `?` (unknown), never "done". A session whose heartbeat stops shows `STALE`.

## Data and uninstall

Snapshots: `~/.claude/swimtrace/sessions/<session>.json` (honours `CLAUDE_CONFIG_DIR`), pruned after 7 days by the viewer.

```
/plugin uninstall swimtrace
npm rm -g swimtrace
swimtrace clean           # run before uninstalling the CLI to delete ~/.claude/swimtrace
```

## Requirements and limits

Claude Code 2.1.296 or newer (the mod API is early access and may change), Node 22.6+. The pane docks beside the
transcript when opened with `/swimtrace`. Remote (cloud) agents have no local events. Local machine only.
````

- [ ] **Step 3: Build and validate**

Run: `npm run build && node dist/cli/main.js --help && claude plugin validate . && npm test && claude plugin test mod && npm run typecheck`
Expected: help text printed; validate reports the marketplace, manifest and hooks with no refusals; all tests PASS.

- [ ] **Step 4: Global install check (reversible)**

Run: `npm i -g . && swimtrace --help && npm rm -g swimtrace`
Expected: help printed from the global bin; uninstall leaves no `swimtrace` on PATH (`which swimtrace` → nothing).

- [ ] **Step 5: Amend the spec** per the "Spec clarifications" list at the top of this plan (sections named under **Files**).

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/marketplace.json README.md docs/superpowers/specs/2026-10-12-swimtrace-design.md
git commit -m "docs: README, marketplace entry, spec amendments"
```

---

### Task 12: Real validation run (only with the person's OK — costs tokens)

**Files:** none (results go in the final report).

- [ ] **Step 1: Load the mod from the repo in a fresh session**

Run in a new terminal: `claude --plugin-dir /Users/vyhocgioi/SwimTrace/mod`
In a second terminal: `swimtrace` (from the same project directory).

- [ ] **Step 2: Exercise it**

In the Claude session: `/swimtrace`, then ask: "Use two parallel Explore agents: one lists the files in mod/core, one lists the files in cli. Report one line each. In the first agent's prompt include the word PELICANWORD, in the second's the word OTTERWORD."

Then, for spike S2 and multi-run agents:

- Ask for a tiny Workflow run with two `agent()` calls: one with `label: 'S2-LABELLED'` and a prompt containing `HERONWORD`, one with no `label` and a prompt containing `BADGERWORD`. Afterwards read each spawned agent's `description` in the snapshot (`jq '.agents[] | select(.workflowRunId) | {id, description}' ~/.claude/swimtrace/sessions/<id>.json`). Record whether the labelled one carries `S2-LABELLED` (resolves S2) and whether either description carries prompt text (`HERONWORD`/`BADGERWORD`).
- Once the first Explore agent has finished, ask Claude to continue it with SendMessage ("send the first Explore agent one more question: how many files was that?"). Record what the snapshot and the CLI show for that agent: a revived bar, a second entry, or nothing (evidence for the parked multi-run-agent finding).

- [ ] **Step 3: Verify**

- Pane and CLI both show `MAIN · main` running, then an `Explore · type` lane with two stacked `●` bars, then `✓` with durations.
- For each planted word: `grep -l -e PELICANWORD -e OTTERWORD -e HERONWORD -e BADGERWORD ~/.claude/swimtrace/sessions/*.json` prints nothing, and `grep -c PELICANWORD <file>` (likewise each word) is `0` for every snapshot file; no file paths from the prompts appear in the snapshot.
- Press Esc during a run of a third agent → its bar shows `■` (interrupted).
- `/clear` → CLI shows the old session `[ENDED]`; Tab reaches a new one after the next prompt.
- Kill the Claude process with `kill -9` while a subagent is running → within ~15 s the CLI shows `[STALE]` AND that session's agents still marked running (main and any subagent) as `?`, not `●`, with durations no longer growing.
- Record the S2 result (labelled description) and the SendMessage observation in spec §13 / the report.

- [ ] **Step 4: Report** results (pass/fail per bullet, with any snapshot excerpt) to the person.
