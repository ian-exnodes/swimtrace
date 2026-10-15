# Multi-Pane Terminal Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a terminal of at least 100×20, the `swimtrace` viewer draws the flow, the selected agent's details, and the session list in bordered panes, with a key bar at the bottom; smaller terminals and the band in Claude Code stay exactly as they are.

**Architecture:** A pure `screen(state, width, height): Row[]` in `cli/main.ts` picks the single column (today's output) or the panes. The panes come from a new `cli/panes.ts` (`box`, `panes`) that frames rows produced by the existing `layout()`, a new `detailLines()` in `mod/core/layout.ts`, and a new `sessionPaneRows()`. Output still goes through `toAnsi` + `diffFrame`.

**Tech Stack:** TypeScript run directly by Node (≥22.6, type stripping), `node:test`, raw ANSI. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-15-swimtrace-tui-panes-design.md`

## Global Constraints

- Node `>=22.6`; tests run with `node --test` on `.ts` files; type check with `npm run typecheck`.
- Zero runtime dependencies: do not add anything to `package.json`.
- Panes only when the terminal is **at least 100 columns and 20 rows**; otherwise the single column, byte for byte as today.
- Right column width: `clamp(round(W / 3), 32, 44)` columns, borders included; the Flow pane takes the rest.
- Sessions pane height: sessions + 2 (its border), at most `floor((H - 1) / 3)`, at least 3.
- The band in Claude Code is unchanged: `layout()` and `details()` in `mod/core/layout.ts` keep their behavior; changes there are additive.
- Every pane row is cut and padded by terminal cells (`clip`, `cellWidth`), so every screen row is exactly `W` cells.
- Key bar: `' ↑↓ select  g flow/pools  r running  Tab session  l sessions  q quit'`, dim; a config warning replaces it (yellow).
- Enter does nothing while panes are on screen; `l` keeps opening the full-screen session list.

## Review Focus

1. **Resizing across the cutoff while running** — 99/100 columns and 19/20 rows must flip between the single column and the panes with no stale frame; pinned by boundary tests in Task 3.
2. **More sessions than the Sessions pane holds** — the current session must stay visible; pinned by the windowing test in Task 3.
3. **Wide characters and very long text in titles and details** (CJK project names, long agent labels) — every row stays exactly `W` cells and borders stay straight; pinned in Task 2 (`box`) and Task 3 (`screen`).
4. **A session with only main** (no agent dispatched yet) — panes still draw and Details shows main; pinned in Task 3.
5. **A very wide terminal** (300 columns) — the right column caps at 44 and rows are still exactly `W`; pinned in Task 2.

---

## File map

| File | Change | Responsibility |
| --- | --- | --- |
| `mod/core/layout.ts` | modify (additive) | `detailLines()`: the Details pane's rows |
| `test/core/layout.test.ts` | modify | tests for `detailLines()` |
| `cli/panes.ts` | create | `fit`, `box`, `panes`: framing and geometry, nothing else |
| `test/cli/panes.test.ts` | create | tests for `box` and `panes` |
| `cli/main.ts` | modify | `ViewState`, `screen()`, `usePanes()`, `sessionPaneRows()`; `viewer()` draws through `screen()` |
| `test/cli/screen.test.ts` | create | tests for `screen()` and `sessionPaneRows()` |
| `README.md` | modify | the panes in the `Use` section |

---

### Task 1: `detailLines()` — the Details pane's rows

**Files:**
- Modify: `mod/core/layout.ts` (add after `details()`, around line 431)
- Test: `test/core/layout.test.ts` (append)

**Interfaces:**
- Consumes: existing internals of `layout.ts`: `asDrawn`, `stages`, `visible`, `selectableIds`, `label`, `dur`, `clipMore`, `GLYPH`, `COLOR`, `resolvePool`.
- Produces: `export function detailLines(snapshot: Snapshot, o: LayoutOpts): Row[]` — rows for `o.selectedId`'s agent when it is on show (per `selectableIds`), else main; one field per line; each row cut to `o.width` with `…`. `o.height` and `o.expanded` are ignored.

- [ ] **Step 1: Write the failing tests**

Append to `test/core/layout.test.ts` (it already defines `snap`, `spawn`, `opts`, `text`); add `detailLines` to the existing import from `'../../mod/core/layout.ts'`:

```ts
test('detailLines: main when nothing is selected, one field per line, — for missing values', () => {
  const s = snap([spawn('a1', 10_000)])
  const t = text(detailLines(s, opts({ width: 40 })))
  assert.equal(t[0], 'main')
  assert.ok(t.includes('type    main'))
  assert.ok(t.includes('parent  —'))
  assert.ok(t.includes('model   —'))
  assert.ok(t.includes('reason  —'))
  assert.ok(t.some(l => /^start   \d\d:\d\d:\d\d  end —$/.test(l)))
})

test('detailLines: the selected agent, its pool and status; back to main when it is filtered out', () => {
  const s = snap([spawn('a1', 10_000, { model: 'claude-haiku-4-5' })])
  const t = text(detailLines(s, opts({ width: 60, selectedId: 'a1' })))
  assert.equal(t[0], 'a1')
  assert.ok(t.includes('status  ● running 1m30s'))
  assert.ok(t.includes('type    Explore'))
  assert.ok(t.includes('pool    Explore (type)'))
  assert.ok(t.includes('parent  main'))
  assert.ok(t.includes('model   claude-haiku-4-5'))
  const done = snap([spawn('a1', 10_000), { kind: 'runEnd', at: 20_000, agentId: 'a1', reason: 'answer' }])
  assert.equal(text(detailLines(done, opts({ selectedId: 'a1', runningOnly: true })))[0], 'main')
})

test('detailLines: the inferred step order line, and every row fits the width', () => {
  const wf = { workflowRunId: 'wf1' }
  const s = snap([
    spawn('r', 10_000, { ...wf, description: 'review:bugs' }),
    { kind: 'runEnd', at: 20_000, agentId: 'r', reason: 'answer' },
    spawn('v', 21_000, { ...wf, description: 'verify:bugs' }),
  ])
  const t = text(detailLines(s, opts({ width: 40, selectedId: 'v' })))
  assert.ok(t.includes('after   review:bugs (inferred)'), JSON.stringify(t))
  const long = snap([spawn('x', 0, { description: '漢'.repeat(80) })])
  for (const l of text(detailLines(long, opts({ width: 30, selectedId: 'x' })))) assert.ok(cellWidth(l) <= 30, l)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/core/layout.test.ts`
Expected: FAIL — `detailLines` is not exported (SyntaxError on the import).

- [ ] **Step 3: Implement `detailLines()`**

In `mod/core/layout.ts`, directly after the existing `details()` function, add:

```ts
const clock = (t?: number) => (t === undefined ? '—' : new Date(t).toISOString().slice(11, 19))

/**
 * The CLI's Details pane: the selected agent when it is on show, else main; one field per line, each cut to `o.width`.
 * The band keeps `details()` (one dense block under the flow).
 */
export function detailLines(snapshot: Snapshot, o: LayoutOpts): Row[] {
  const s = asDrawn(snapshot, o.now)
  const shown = selectableIds(snapshot, o).includes(o.selectedId ?? '')
  const a = s.agents.find(x => x.id === (shown ? o.selectedId : 'main')) ?? s.agents[0]
  if (a === undefined) return []
  const prev = stages(s, visible(s, o)).graph.after.get(a.id)
  const pool = resolvePool(a, s.session.project, s.workflows, o.rules)
  const tools = Array.isArray(a.tools) && a.tools.length > 0 ? a.tools.join(', ') : '—'
  const f = (k: string, v: string, fg?: Fg): Row => [{ text: k.padEnd(8), dim: true }, { text: v, fg }]
  const rows: Row[] = [
    [{ text: label(a), bold: true }],
    f('status', `${GLYPH[a.status]} ${a.status} ${dur(a, o.now)}`, COLOR[a.status]),
    f('type', a.type),
    f('pool', `${pool.name} (${pool.source})`),
    f('parent', a.parentId ?? (a.id === 'main' ? '—' : 'main')),
    f('model', a.model ?? '—'),
    f('tool', a.currentTool ?? '—'),
    f('tools', tools),
    f('start', `${clock(a.startedAt)}  end ${clock(a.endedAt)}`),
    f('reason', a.endReason ?? '—'),
    ...(prev ? [f('after', `${label(prev)} (inferred)`)] : []),
  ]
  return rows.map(r => clipMore(r, o.width))
}
```

Note: `{ text: v, fg: undefined }` renders like `{ text: v }` (`toAnsi` filters falsy codes), so `f` needs no branch.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/core/layout.test.ts && npm run typecheck`
Expected: all tests PASS (old and new); typecheck exits 0.

If the `after` assertion fails, print `text(detailLines(...))` and check the label of `r` — the step order is inferred only between agents of the same workflow run whose labels are `<step>:<key>`; adjust the fixture, not `detailLines`.

- [ ] **Step 5: Run the whole suite (band and layout unchanged)**

Run: `npm test`
Expected: PASS, same count as before plus 3.

- [ ] **Step 6: Commit**

```bash
git add mod/core/layout.ts test/core/layout.test.ts
git commit -m "feat(core): detailLines for the viewer's Details pane"
```

---

### Task 2: `cli/panes.ts` — frames and geometry

**Files:**
- Create: `cli/panes.ts`
- Test: `test/cli/panes.test.ts`

**Interfaces:**
- Consumes: `cellWidth`, `clip`, `rowText`, `type Row` from `mod/core/layout.ts`.
- Produces:
  - `export function fit(row: Row, w: number): Row` — cut to `w` cells, padded with spaces to exactly `w`.
  - `export function box(title: Row, body: Row[], w: number, h: number, corners?: string, right?: boolean): Row[]` — exactly `h` rows of exactly `w` cells. `corners` is 4 characters: top-left, top-right, bottom-left, bottom-right (default `'┌┐└┘'`). `right = false` drops the right edge (its corners are ignored). Body rows sit after `'│ '`; body text width is `w - 3` (`w - 2` without the right edge); rows past `h - 2` are dropped.
  - `export interface PaneContent { flow: (w: number, h: number) => { title: Row; body: Row[] }; details: (w: number) => Row[]; sessions: (w: number, h: number) => Row[]; sessionCount: number; bottom: Row }`
  - `export function rightWidth(W: number): number` — `clamp(round(W / 3), 32, 44)`.
  - `export function panes(c: PaneContent, W: number, H: number): Row[]` — exactly `H` rows of exactly `W` cells: Flow on the left (no right edge), Details over Sessions on the right sharing edges (`┬ ├ ┤ ┴`), `c.bottom` as the last row. Callbacks get the body text size of their pane.

Geometry (W×H, R = `rightWidth(W)`, L = W − R):
- Left: `box(flow.title, flow.body, L, H - 1, '┌ └ ', false)`; flow body size `(L - 2) × (H - 3)`.
- `sh = clamp(sessionCount + 2, 3, floor((H - 1) / 3))`; `dh = H - sh`.
- Details: `box(Details, details(R - 3), R, dh, '┬┐├┤').slice(0, -1)` (its bottom row is the Sessions title row); body `(R - 3) × (dh - 2)`.
- Sessions: `box(Sessions, sessions(R - 3, sh - 2), R, sh, '├┤┴┘')`.
- Rows `0 … H-2`: left row + right row; row `H-1`: `fit(bottom, W)`.

- [ ] **Step 1: Write the failing tests**

Create `test/cli/panes.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { box, fit, panes, rightWidth, type PaneContent } from '../../cli/panes.ts'
import { cellWidth, rowText, type Row } from '../../mod/core/layout.ts'

const t = (s: string): Row => [{ text: s }]
const widths = (rows: Row[]) => rows.map(r => cellWidth(rowText(r)))
const chars = (r: Row) => [...rowText(r)]

test('fit cuts and pads by cells, never splitting a wide character', () => {
  assert.equal(rowText(fit(t('ab漢'), 3)), 'ab ')
  assert.equal(rowText(fit(t('ab'), 5)), 'ab   ')
  assert.equal(cellWidth(rowText(fit(t('漢字漢字'), 5))), 5)
})

test('box: exact size, title in the top border, padded and cut body, wide characters', () => {
  const rows = box(t('Title'), [t('漢字abc'), t('x'.repeat(50))], 20, 5)
  assert.equal(rows.length, 5)
  assert.deepEqual(widths(rows), [20, 20, 20, 20, 20])
  assert.match(rowText(rows[0]!), /^┌─ Title ─+┐$/)
  assert.equal(rowText(rows[1]!), '│ 漢字abc' + ' '.repeat(10) + '│')
  assert.equal(rowText(rows[2]!), '│ ' + 'x'.repeat(17) + '│')
  assert.equal(rowText(rows[3]!), '│' + ' '.repeat(18) + '│')
  assert.equal(rowText(rows[4]!), '└' + '─'.repeat(18) + '┘')
})

test('box without the right edge, custom corners, a body taller than the box', () => {
  const rows = box(t('L'), Array.from({ length: 10 }, (_, i) => t(`row ${i}`)), 12, 4, '┬┐├┤', false)
  assert.deepEqual(widths(rows), [12, 12, 12, 12])
  assert.equal(chars(rows[0]!)[0], '┬')
  assert.equal(rowText(rows[1]!), '│ row 0     ')
  assert.equal(rowText(rows[2]!), '│ row 1     ')
  assert.equal(rowText(rows[3]!), '├' + '─'.repeat(11))
  const long = box(t('漢'.repeat(40)), [], 20, 3)
  assert.deepEqual(widths(long), [20, 20, 20])
  assert.equal(chars(long[0]!).at(-1), '┐')
})

const content = (seen: Record<string, number[]> = {}, sessionCount = 2): PaneContent => ({
  flow: (w, h) => { seen.flow = [w, h]; return { title: t('SWIMTRACE proj'), body: [t('[✓ request]─▶[✓ plan 8s]')] } },
  details: w => { seen.details = [w]; return [t('main'), t('type    main')] },
  sessions: (w, h) => { seen.sessions = [w, h]; return [t('proj  e57186f5  live')] },
  sessionCount,
  bottom: t(' keys'),
})

test('rightWidth clamps a third of the width to 32…44', () => {
  assert.equal(rightWidth(100), 33)
  assert.equal(rightWidth(90), 32)
  assert.equal(rightWidth(120), 40)
  assert.equal(rightWidth(300), 44)
})

test('panes: exact size, shared junctions, bottom row, callback sizes', () => {
  const seen: Record<string, number[]> = {}
  const rows = panes(content(seen), 120, 30)
  assert.equal(rows.length, 30)
  assert.deepEqual(new Set(widths(rows)), new Set([120]))
  const L = 120 - 40
  assert.equal(chars(rows[0]!)[0], '┌')
  assert.equal(chars(rows[0]!)[L], '┬')
  assert.equal(chars(rows[0]!).at(-1), '┐')
  assert.equal(chars(rows[28]!)[0], '└')
  assert.equal(chars(rows[28]!)[L], '┴')
  assert.equal(chars(rows[28]!).at(-1), '┘')
  const split = rows.findIndex(r => chars(r)[L] === '├')
  assert.ok(split > 0 && split < 28)
  assert.equal(chars(rows[split]!).at(-1), '┤')
  assert.match(rowText(rows[split]!), /├─ Sessions /)
  assert.match(rowText(rows[0]!), /┬─ Details /)
  assert.match(rowText(rows[0]!), /^┌─ SWIMTRACE proj /)
  assert.equal(rowText(rows[29]!).trimEnd(), ' keys')
  // sessions: 2 + 2 = 4 rows, so details holds 30 - 4 = 26 rows with its bottom shared
  assert.deepEqual(seen.flow, [L - 2, 27])
  assert.deepEqual(seen.details, [37])
  assert.deepEqual(seen.sessions, [37, 2])
  assert.equal(28 - split + 1, 4)
})

test('panes: sessions pane height is clamped to 3 rows minimum and a third of the column maximum', () => {
  const few = panes(content({}, 0), 100, 20)
  const fewSplit = few.findIndex(r => chars(r)[100 - 33] === '├')
  assert.equal(19 - fewSplit, 3)
  const many = panes(content({}, 50), 100, 20)
  const manySplit = many.findIndex(r => chars(r)[100 - 33] === '├')
  assert.equal(19 - manySplit, 6) // floor(19 / 3)
})

test('review focus 5: a 300-column terminal caps the right column at 44', () => {
  const rows = panes(content(), 300, 40)
  assert.deepEqual(new Set(widths(rows)), new Set([300]))
  assert.equal(chars(rows[0]!)[300 - 44], '┬')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/cli/panes.test.ts`
Expected: FAIL — cannot find module `cli/panes.ts`.

- [ ] **Step 3: Implement `cli/panes.ts`**

```ts
import { cellWidth, clip, rowText, type Row } from '../mod/core/layout.ts'

const FRAME = { dim: true } as const

/** `row` cut to `w` terminal cells, then padded with spaces to exactly `w`. */
export function fit(row: Row, w: number): Row {
  const c = clip(row, w)
  const pad = w - cellWidth(rowText(c))
  return pad > 0 ? [...c, { text: ' '.repeat(pad) }] : c
}

/**
 * A framed pane of exactly `h` rows of `w` cells: `title` in the top border, `body` after `│ `.
 * `corners`: top-left, top-right, bottom-left, bottom-right; `right = false` leaves the right edge to a neighbour.
 */
export function box(title: Row, body: Row[], w: number, h: number, corners = '┌┐└┘', right = true): Row[] {
  const [tl, tr, bl, br] = [...corners]
  const inner = w - 1 - (right ? 1 : 0) // cells between the edges
  const edge = right ? [{ text: '│', ...FRAME }] : []
  const t = clip(title, Math.max(0, inner - 3))
  const fill = inner - 3 - cellWidth(rowText(t))
  const top: Row = [{ text: `${tl}─ `, ...FRAME }, ...t, { text: ` ${'─'.repeat(fill)}${right ? tr : ''}`, ...FRAME }]
  const rows: Row[] = [top]
  for (let i = 0; i < h - 2; i++) rows.push([{ text: '│ ', ...FRAME }, ...fit(body[i] ?? [], inner - 1), ...edge])
  rows.push([{ text: `${bl}${'─'.repeat(inner)}${right ? br : ''}`, ...FRAME }])
  return rows
}

export interface PaneContent {
  /** The Flow pane's title (the header row) and body, drawn at `w`×`h` cells. */
  flow: (w: number, h: number) => { title: Row; body: Row[] }
  details: (w: number) => Row[]
  sessions: (w: number, h: number) => Row[]
  sessionCount: number
  /** The last row: the key bar, or a config warning. */
  bottom: Row
}

export const rightWidth = (W: number): number => Math.min(44, Math.max(32, Math.round(W / 3)))

/** Flow on the left; Details over Sessions on the right, sharing edges; `bottom` last. Exactly `H` rows of `W` cells. */
export function panes(c: PaneContent, W: number, H: number): Row[] {
  const R = rightWidth(W)
  const L = W - R
  const flow = c.flow(L - 2, H - 3)
  const left = box(flow.title, flow.body, L, H - 1, '┌ └ ', false)
  const sh = Math.min(Math.floor((H - 1) / 3), Math.max(3, c.sessionCount + 2))
  const dh = H - sh
  const bold = (s: string): Row => [{ text: s, bold: true }]
  const right = [
    ...box(bold('Details'), c.details(R - 3), R, dh, '┬┐├┤').slice(0, -1),
    ...box(bold('Sessions'), c.sessions(R - 3, sh - 2), R, sh, '├┤┴┘'),
  ]
  return [...left.map((r, i) => [...r, ...right[i]!]), fit(c.bottom, W)]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/cli/panes.test.ts && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add cli/panes.ts test/cli/panes.test.ts
git commit -m "feat(cli): pane frames and geometry"
```

---

### Task 3: `screen()` — the viewer draws panes when it has room

**Files:**
- Modify: `cli/main.ts` (imports; `sessionListRows` at lines 19–29; `viewer()` lines 61–163)
- Create: `test/cli/screen.test.ts`
- Modify: `README.md` (`Use` section, the bullet starting "`swimtrace` in another terminal")

**Interfaces:**
- Consumes: `panes`, `type PaneContent` from `cli/panes.ts` (Task 2); `detailLines` from `mod/core/layout.ts` (Task 1); existing `layout`, `clip`, `rowText`, `selectableIds`, `type View`, `type Row`; `type CompiledRule` from `mod/core/pools.ts`; `type SessionEntry` from `cli/snapshots.ts`.
- Produces (all exported from `cli/main.ts`):
  - `interface ViewState { entries: SessionEntry[]; current?: string; listMode: boolean; listSel: number; view: View; runningOnly: boolean; expanded: boolean; selectedId?: string; rules: readonly CompiledRule[]; notes: string[]; now: number }`
  - `usePanes(width: number, height: number): boolean` — `width >= 100 && height >= 20`.
  - `sessionPaneRows(entries: SessionEntry[], current: string | undefined, width: number, height: number): Row[]` — at most `height` rows `project-basename  id8  state`, the current one inverse, windowed so the current one is shown.
  - `screen(st: ViewState, width: number, height: number): Row[]`.

- [ ] **Step 1: Write the failing tests**

Create `test/cli/screen.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { screen, sessionPaneRows, usePanes, type ViewState } from '../../cli/main.ts'
import { playInstant } from '../../cli/sim.ts'
import type { SessionEntry } from '../../cli/snapshots.ts'
import { emptySnapshot, type Snapshot } from '../../mod/core/model.ts'
import { cellWidth, layout, rowText, selectableIds, type Row } from '../../mod/core/layout.ts'

const entry = (snap: Snapshot, path = `/x/${snap.session.id}.json`): SessionEntry => ({ path, snap, stale: false, mtimeMs: 0 })
const [orch] = playInstant('orchestrated', 0)
const state = (o: Partial<ViewState> = {}): ViewState => ({
  entries: [entry(orch!)], current: `/x/${orch!.session.id}.json`, listMode: false, listSel: 0, view: 'agent',
  runningOnly: false, expanded: false, rules: [], notes: [], now: orch!.writtenAt, ...o,
})
const texts = (rows: Row[]) => rows.map(rowText)
const exact = (rows: Row[], W: number, H: number) => {
  assert.equal(rows.length, H)
  for (const r of rows) assert.equal(cellWidth(rowText(r)), W, JSON.stringify(rowText(r)))
}

test('usePanes: 100×20 and up', () => {
  assert.equal(usePanes(100, 20), true)
  assert.equal(usePanes(99, 20), false)
  assert.equal(usePanes(100, 19), false)
})

test('review focus 1: below 100×20 the screen is today\'s single column, row for row', () => {
  for (const [W, H] of [[99, 30], [120, 19], [80, 24]] as const) {
    const st = state()
    const today = layout(orch!, { width: W, height: H, now: st.now, view: 'agent', runningOnly: false, expanded: false, rules: [] }).slice(0, H)
    assert.deepEqual(screen(st, W, H), today, `${W}×${H}`)
  }
  const exp = state({ expanded: true, selectedId: 'main' })
  assert.deepEqual(screen(exp, 80, 24), layout(orch!, { width: 80, height: 24, now: exp.now, view: 'agent', runningOnly: false, expanded: true, selectedId: 'main', rules: [] }).slice(0, 24))
})

test('panes at 120×30: exact size, key bar last, Details shows main then the selected agent', () => {
  const rows = screen(state(), 120, 30)
  exact(rows, 120, 30)
  assert.match(rowText(rows[29]!), /↑↓ select .* q quit/)
  assert.match(rowText(rows[0]!), /SWIMTRACE/)
  assert.ok(texts(rows).some(t => t.includes('type    main')))
  const id = selectableIds(orch!, { view: 'agent', runningOnly: false, rules: [], now: orch!.writtenAt }).find(i => i !== 'main')!
  const a = orch!.agents.find(x => x.id === id)!
  const sel = texts(screen(state({ selectedId: id }), 120, 30))
  assert.ok(sel.some(t => t.includes(`type    ${a.type}`)))
  assert.ok(!sel.some(t => t.includes('type    main')))
})

test('panes: the pools view says so in the Flow title', () => {
  assert.match(rowText(screen(state({ view: 'pool' }), 120, 30)[0]!), /· pools/)
})

test('panes: a selected agent filtered out by running only sends Details back to main', () => {
  const done = orch!.agents.find(a => a.id !== 'main' && a.status === 'completed')!
  const rows = texts(screen(state({ selectedId: done.id, runningOnly: true }), 120, 30))
  assert.ok(rows.some(t => t.includes('type    main')))
})

test('panes: a config warning replaces the key bar', () => {
  const rows = screen(state({ notes: ['rule 1: bad regex'] }), 120, 30)
  exact(rows, 120, 30)
  assert.match(rowText(rows[29]!), /^config: rule 1: bad regex/)
  assert.equal(rows[29]![0]!.fg, 'yellow')
})

test('panes: the list mode and a missing session keep the full-screen session list', () => {
  const st = state({ listMode: true })
  assert.match(rowText(screen(st, 120, 30)[0]!), /^SWIMTRACE — sessions/)
  assert.match(rowText(screen(state({ current: undefined, entries: [] }), 120, 30)[0]!), /^SWIMTRACE — sessions/)
})

test('panes: Sessions highlights the current session', () => {
  const [a, b] = playInstant('multi-session', 0)
  const rows = screen(state({ entries: [entry(a!), entry(b!)], current: `/x/${b!.session.id}.json`, now: b!.writtenAt }), 120, 30)
  const hit = rows.flat().find(g => g.inverse && g.text.includes(b!.session.id.slice(0, 8)))
  assert.ok(hit, 'current session in inverse')
})

test('review focus 2: the Sessions window keeps the current session in view', () => {
  const es = Array.from({ length: 10 }, (_, i) => entry(emptySnapshot({ id: `sess-${i}-xxxxxx`, project: `/w/p${i}`, startedAt: 0 })))
  const rows = sessionPaneRows(es, es[9]!.path, 30, 3)
  assert.equal(rows.length, 3)
  assert.match(rowText(rows[2]!), /^p9  sess-9-x/)
  assert.equal(rows[2]![0]!.inverse, true)
  assert.match(rowText(sessionPaneRows(es, es[0]!.path, 30, 3)[0]!), /^p0 /)
})

test('review focus 3 and 4: wide project names, long labels, a session with only main', () => {
  const wide = { ...emptySnapshot({ id: 'sess-wide0000', project: `/w/${'漢字'.repeat(40)}`, startedAt: 0 }), writtenAt: 1_000 }
  const st = state({ entries: [entry(wide)], current: '/x/sess-wide0000.json', now: 1_000 })
  for (const [W, H] of [[100, 20], [137, 33]] as const) exact(screen(st, W, H), W, H)
  assert.ok(texts(screen(st, 120, 30)).some(t => t.includes('type    main')))
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/cli/screen.test.ts`
Expected: FAIL — `screen` / `sessionPaneRows` / `usePanes` are not exported.

- [ ] **Step 3: Add `sessionPaneRows`, `ViewState`, `usePanes`, `screen` to `cli/main.ts`**

Change the imports at the top of `cli/main.ts`:

```ts
import { compileRules, parseConfig, type CompiledRule } from '../mod/core/pools.ts'
import { clip, detailLines, fmtDuration, layout, selectableIds, type Row, type View } from '../mod/core/layout.ts'
import { listSessions, pickSession, pruneOld, swimtraceDir, type SessionEntry } from './snapshots.ts'
import { panes } from './panes.ts'
import { ALT_OFF, ALT_ON, HIDE_CURSOR, SHOW_CURSOR, diffFrame, toAnsi } from './term.ts'
```

Replace `sessionListRows` (lines 19–29) with these, so the list and the pane share one notion of state:

```ts
const sessionState = (e: SessionEntry) => (e.snap.session.endedAt !== undefined ? 'ended' : e.stale ? 'stale' : 'live')

export function sessionListRows(entries: SessionEntry[], selected: number, width: number): Row[] {
  const rows: Row[] = [[{ text: 'SWIMTRACE — sessions', bold: true }]]
  entries.forEach((e, i) => {
    const s = e.snap
    const state = sessionState(e)
    const running = s.agents.filter(a => a.status === 'running' && a.id !== 'main').length
    const text = `  ${s.session.project}  ${s.session.id.slice(0, 8)}  ${state}  running ${running}  age ${fmtDuration(Date.now() - s.session.startedAt)}`
    rows.push([{ text, inverse: i === selected, fg: state === 'live' ? 'cyan' : 'gray' }])
  })
  if (entries.length === 0) rows.push([{ text: '  No sessions yet. Is the swimtrace mod installed?', dim: true }])
  return rows.map(r => clip(r, width)) // a folder name may hold control characters or wide characters
}

/** The Sessions pane: `project  id8  state`, the current one inverse; at most `height` rows, windowed to keep it shown. */
export function sessionPaneRows(entries: SessionEntry[], current: string | undefined, width: number, height: number): Row[] {
  const at = Math.max(0, entries.findIndex(e => e.path === current))
  const start = Math.max(0, at - height + 1)
  return entries.slice(start, start + height).map(e => {
    const state = sessionState(e)
    const name = e.snap.session.project.split('/').filter(Boolean).at(-1) ?? e.snap.session.project
    return clip([{ text: `${name}  ${e.snap.session.id.slice(0, 8)}  ${state}`, inverse: e.path === current, fg: state === 'live' ? 'cyan' : 'gray' }], width)
  })
}

export interface ViewState {
  entries: SessionEntry[]; current?: string; listMode: boolean; listSel: number
  view: View; runningOnly: boolean; expanded: boolean; selectedId?: string
  rules: readonly CompiledRule[]; notes: string[]; now: number
}

export const usePanes = (width: number, height: number): boolean => width >= 100 && height >= 20

const KEYS = ' ↑↓ select  g flow/pools  r running  Tab session  l sessions  q quit'

/** One frame: the session list, the single column (as the band draws it), or the panes when the terminal has room. */
export function screen(st: ViewState, width: number, height: number): Row[] {
  const cur = st.entries.find(e => e.path === st.current)
  const warn = st.notes.length ? clip([{ text: `config: ${st.notes[0]}`, fg: 'yellow' }], width) : undefined
  const o = { now: st.now, view: st.view, runningOnly: st.runningOnly, selectedId: st.selectedId, rules: st.rules }
  if (!st.listMode && cur !== undefined && usePanes(width, height)) {
    return panes({
      flow: (w, h) => {
        const rows = layout(cur.snap, { ...o, width: w, height: h + 1, expanded: false })
        const title = st.view === 'pool' ? [...rows[0]!, { text: ' · pools', dim: true }] : rows[0]!
        return { title, body: rows.slice(1) }
      },
      details: w => detailLines(cur.snap, { ...o, width: w, height, expanded: false }),
      sessions: (w, h) => sessionPaneRows(st.entries, st.current, w, h),
      sessionCount: st.entries.length,
      bottom: warn ?? [{ text: KEYS, dim: true }],
    }, width, height)
  }
  let rows = st.listMode || cur === undefined
    ? sessionListRows(st.entries, st.listSel, width)
    : layout(cur.snap, { ...o, width, height, expanded: st.expanded })
  if (warn) rows = [...rows.slice(0, height - 1), warn]
  return rows.slice(0, height)
}
```

Note: the single-column branch is today's `draw()` body moved here unchanged (same list/layout choice, same warning on the last row, same `slice(0, height)`), which is what the row-for-row test pins.

- [ ] **Step 4: Make `viewer()` draw through `screen()` and ignore Enter with panes**

In `viewer()`, replace the body of `draw` (currently lines 77–88) with:

```ts
  const draw = () => {
    const width = out.columns || 80
    const height = out.rows || 24
    const st: ViewState = { entries, current, listMode, listSel, view, runningOnly, expanded, selectedId, rules, notes, now: Date.now() }
    const next = screen(st, width, height).map(toAnsi)
    out.write(diffFrame(prev, next))
    prev = next
  }
```

and in the keypress `switch`, replace the `'return'` case with:

```ts
        case 'return':
          if (listMode && entries[listSel]) { current = entries[listSel]!.path; listMode = false; selectedId = undefined }
          else if (!usePanes(out.columns || 80, out.rows || 24)) expanded = !expanded // with panes, Details is always shown
          break
```

`layout`, `clip` and `Row` stay imported (used by `screen` and `sessionListRows`). Remove nothing else.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/cli/screen.test.ts && npm test && npm run typecheck`
Expected: all PASS, including the untouched `test/cli/main.test.ts` (`sessionListRows` behaves as before); typecheck exits 0.

If `review focus 1` fails, diff the two arrays: the single-column branch must call `layout()` with exactly `{ width, height, now, view, runningOnly, selectedId, expanded, rules }` and apply the warning and `slice` in the same order as before.

- [ ] **Step 6: Update the README**

In `README.md`, in the `Use` section, replace the bullet that starts "- `swimtrace` in another terminal" with:

```markdown
- `swimtrace` in another terminal (a tmux split works well) follows the newest live session of the current directory.
  `swimtrace --all` starts at the session list. Keys: ↑/↓, Enter, `g`, `r`, `l` list, Tab, `q`.
  `q` exists only in the CLI. On a terminal of at least 100×20 the viewer splits into panes: the flow on the left,
  Details (the selected agent, or main) and Sessions on the right, the keys along the bottom; Enter does nothing
  there, since Details is always shown. Smaller, it is the single column above.
```

- [ ] **Step 7: Manual check in a real terminal**

Run: `npm run build && node dist/cli/main.js sim orchestrated`
Check, with the terminal at least 120×30:
- the Flow, Details and Sessions boxes have straight right edges and `┬ ├ ┤ ┴` joins;
- ↑/↓ moves the highlight in the flow and Details follows; Tab resets Details to main; `g` adds `· pools` to the Flow title;
- shrink the window below 100 columns while it plays: the single column appears; widen it again: the panes come back;
- `q` restores the terminal (prompt and cursor back).
Repeat once inside a tmux split. Note anything off in the commit message body or as a follow-up; do not change the spec's behavior to fit.

- [ ] **Step 8: Commit**

```bash
git add cli/main.ts test/cli/screen.test.ts README.md
git commit -m "feat(cli): multi-pane viewer when the terminal is at least 100x20"
```
