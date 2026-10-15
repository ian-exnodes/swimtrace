# SwimTrace — Multi-Pane Terminal Viewer: Design

Date: 2026-10-15 · Status: approved in conversation, pending written-spec review
Builds on: `2026-10-12-swimtrace-design.md` (§7 Terminal UI)

## 1. Goal

Turn the `swimtrace` terminal viewer into a multi-pane TUI: the flow on the left, details of the selected agent and the
session list on the right, a key bar at the bottom. The details and the other sessions are on screen at all times
instead of behind Enter and `l`.

Success: on a terminal of 100×20 or more, a glance shows the flow, everything SwimTrace knows about the selected agent,
and which sessions exist, without pressing a key. Below that size, and inside Claude Code, nothing changes.

Decisions taken during brainstorming:

| Decision | Choice |
| --- | --- |
| Direction | Richer viewer layout (not a framework rewrite, not mouse/scroll, not a TUI elsewhere) |
| Scope | The `swimtrace` CLI viewer only; the band in Claude Code is unchanged |
| Approach | Wrap the existing `layout()` in panes drawn by a small `cli/panes.ts`; no new runtime dependency |
| Rejected | Splitting `layout()` into per-section builders (refactors the core the band shares); Ink (adds ink + react, discards the working diff renderer and terminal restore) |

Out of scope: mouse, scrolling the flow, a `?` help overlay, any change to the snapshot format, the mod or what is
observed.

## 2. Pane geometry

Panes are used when the terminal is **at least 100 columns and 20 rows**. Otherwise the viewer draws today's single
column (§4).

```
┌ SWIMTRACE ─ proj ─ session e57186f5 ─ 5 agents ─────────┬ Details ─────────────────────┐
│                                                          │ [T2] count tests             │
│ [✓ request]─▶[✓ classify: complex 8s]─▶[⑂ route]─┬─ …   │ status  ✓ completed 10s      │
│   ├─ Explore ──▶[✓ [T1] list files 13s]                  │ type    Explore              │
│   ├─ Explore ──▶[✓ [T2] count tests 10s]                 │ pool    Code (explicit)      │
│   └─ workflow ─▶[◆ review-wf]─┬─▶[✓ review:bugs 41s]     │ parent  main                 │
│                               └─▶[✗ review:perf 42s]     │ model   haiku                │
│ Progress  tasks 3/5 done · 1 running · 3 done · 1 failed │ tools   Read, Grep, Glob     │
│ ◉ request #1 · 5 agents ✗ 1 failed 14s                   ├ Sessions ────────────────────┤
│                                                          │ proj  e57186f5  live         │
│                                                          │ api   9c01aa2e  ended        │
└──────────────────────────────────────────────────────────┴──────────────────────────────┘
 ↑↓ select  g pools  r running  Tab session  l sessions  q quit
```

- **Key bar**: the last row, no border, dim.
- **Right column** width: `clamp(round(W / 3), 32, 36)` columns, borders included (36 since 2026-10-15: more room for the flow). The Flow pane takes the rest; it draws the request node without main's current tool, so the flow holds still while main works (Details shows the tool).
- **Flow pane** (left, full height above the key bar). Its title is the header row `layout()` already draws
  (`SWIMTRACE proj session … [STALE] N agents`), with its colors, so the header costs no extra row. Its content is
  `layout(snapshot, { …opts, width: innerW, height: innerH + 1, expanded: false })` without that first row: the
  flow or pools view, Progress, earlier turns and Tasks, exactly as the band draws them. `layout()` handles overflow
  (`… N more rows`) at the pane's height.
- **Details pane** (right, top): the selected agent, or main when none is selected (§3), one field per line, each value
  cut with `…` at the pane's width:

  ```
  <label>
  status  <glyph> <status> <duration>
  type    <type>
  pool    <name> (<source>)
  parent  <parent id or —>
  model   <model or —>
  tool    <current tool or —>
  tools   <tools used, comma separated, or —>
  start   <hh:mm:ss>   end <hh:mm:ss or —>
  reason  <end reason or —>
  after   <predecessor label> (inferred)        ← only when step order was inferred
  ```

  Rows that do not fit are dropped from the bottom.
- **Sessions pane** (right, bottom): one line per session (`project  id8  live|stale|ended`), the current one in
  inverse. Its height is the number of sessions plus its border, at most a third of the column's height, at least 3
  rows. A longer list is windowed so the current session stays visible.
- **Borders** are shared, with no double walls: `┬` where the two columns meet at the top, `├`/`┤` where Details
  meets Sessions, `┴` at the bottom. Titles are bold; the frame is dim.

## 3. Keys and selection

No pane takes focus; every key acts the same wherever the eye is.

| Key | With panes | Single column (unchanged) |
| --- | --- | --- |
| ↑ / ↓ | move the selection through the flow's nodes; Details follows | same |
| Enter | nothing (Details is always shown) | toggle details under the flow |
| `g` | Flow pane: flow ↔ pools | same |
| `r` | running only | same |
| Tab | next session; the Sessions highlight moves, the selection resets to main | same |
| `l` | full-screen session list as today; Enter picks one and returns to the panes | same |
| `q`, ctrl+c | quit | same |

- With no selection, Details shows **main** (the request: status, current tool, duration).
- When the selected agent is not on show (filtered by `r`, or folded into an earlier turn's line), Details shows main.
  `selectedId` is kept, so the agent is selected again if it comes back into view. This is how `layout()` already
  treats `selectedId`.
- The selected node keeps today's highlight (inverse) in the flow; no extra marker.

## 4. Single column, edge cases, errors

- **Mode** is chosen on every draw from the terminal's current size. A resize already redraws everything, so shrinking
  below 100×20 switches to the single column and widening switches back, without a restart.
- **Single column** (below 100×20) is today's viewer, byte for byte: header row, Enter for details, config warning on
  the last row, no key bar.
- **No session yet, or the `l` list open**: the full-screen session list, as today, without panes.
- **Config warning**: with panes it replaces the key bar row (yellow), never a box row.
- **Wide characters, emoji, control characters**: each pane line is cut to the pane's inner width in cells and padded
  to that width in cells (the existing `clip` / `cellWidth`), so the right-hand borders stay straight. `clip` already
  strips control characters.
- **STALE / ENDED / SIMULATED** show in the Flow pane's title (from the header row) and in the session's state in
  Sessions.
- **Errors**: drawing stays inside the existing `guard(…, fail)`; a throw restores the terminal (alternate screen off,
  cursor on) and prints the error, as today. The pane code only arranges rows; it reads no files.

## 5. Code changes

- **`cli/panes.ts`** (new): `box(title: Row, rows: Row[], w: number, h: number): Row[]` and the column join with
  shared junctions. Plain functions returning `Row[]`; output goes through the existing `toAnsi` and `diffFrame`.
- **`cli/main.ts`**: extract the frame building out of `draw()` into a pure
  `screen(state, width, height): Row[]` (session list, single column or panes, config warning). `draw()` keeps only
  `toAnsi` + `diffFrame`. Enter is ignored when panes are on screen. A sessions-pane variant of the session rows
  (no title row, windowed around the current one) next to `sessionListRows`.
- **`mod/core/layout.ts`**: export a field-per-line details builder (§2) next to the existing `details()`, sharing its
  pool and time helpers. The band keeps calling the existing `details()`; `layout()` is not changed.
- **README** `Use` section: the panes, the 100×20 cutoff, Enter being a no-op with panes.

## 6. Testing

`node --test` on the `.ts` files, as today; no new test dependency.

- **`test/cli/panes.test.ts`** (new)
  - `box`: every row exactly `w` cells, also with emoji/CJK and cut rows; the title in the top border; short content
    padded.
  - the column join: `┬ ├ ┤ ┴` in the right places.
  - `screen` at 120×30 on the `orchestrated` sim's final snapshot: every row exactly 120 cells; the last row is the
    key bar; Details shows main with no selection and the agent when one is selected; Sessions highlights the current
    session.
  - `screen` at 99×30 and at 120×19 equals today's single-column output row for row.
  - with a config warning, the last row is the warning, not the key bar.
  - a selected agent filtered out by running-only sends Details back to main.
- **`test/core/layout.test.ts`**: the field-per-line details: its fields, `—` for missing values, the
  `after … (inferred)` line.
- **Unchanged and passing**: the existing layout, band and `main.test.ts` tests. This shows the band and the single
  column did not move.
- **Manual**: `swimtrace sim orchestrated` at full width; while it plays, narrow the window below 100 columns and widen
  it again; once more inside a tmux split.
