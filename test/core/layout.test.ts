import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptySnapshot } from '../../mod/core/model.ts'
import { reduceAll } from '../../mod/core/reducer.ts'
import { compileRules } from '../../mod/core/pools.ts'
import { cellWidth, fmtDuration, isStale, lanes, layout, rowText, selectableIds, type LayoutOpts } from '../../mod/core/layout.ts'

// Written at the default `now` (100 s), so the session is live, not stale, unless a test says otherwise.
const snap = (evs: object[], simulated = false) =>
  ({ ...reduceAll(emptySnapshot({ id: 'sess-123456789', project: '/w/c4k-mobile', startedAt: 0 }, simulated), evs), writtenAt: 100_000 })
const spawn = (id: string, at: number, extra: object = {}) => ({ kind: 'spawn', at, id, type: 'Explore', description: id, ...extra })
const opts = (o: Partial<LayoutOpts> = {}): LayoutOpts =>
  ({ width: 100, height: 40, now: 100_000, view: 'agent', runningOnly: false, expanded: false, rules: [], ...o })
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

test('case 2 and 9: the pools view lists each lane\'s agents one per line, no time axis', () => {
  const s = snap([spawn('a1', 10_000), spawn('a2', 12_000)])
  const t = text(layout(s, opts({ view: 'pool' })))
  const laneAt = t.findIndex(l => l.startsWith('Explore · type'))
  assert.ok(laneAt > 0)
  assert.equal(t[laneAt + 1], '  ● a1 1m30s')
  assert.equal(t[laneAt + 2], '  ● a2 1m28s')
  assert.ok(!t.some(l => /now|─/.test(l)), 'no timeline')
})

test('case 9: every row fits at any width, in both views', () => {
  const s = snap([spawn('a1', 10_000)])
  for (const view of ['pool', 'agent'] as const) {
    for (const width of [40, 59, 80, 200]) assert.ok(text(layout(s, opts({ width, view }))).every(l => l.length <= width), `row too wide at ${width}`)
  }
  assert.ok(text(layout(s, opts({ width: 40, view: 'pool' }))).some(l => /^\s+● a1 1m30s/.test(l)))
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
  assert.ok(text(layout(s, opts({ rules: r, view: 'pool' }))).some(l => l.startsWith('REVIEW · config')))
})

test('runningOnly hides finished agents; selectableIds follows display order', () => {
  const s = snap([spawn('a', 1), spawn('b', 2), { kind: 'runEnd', at: 3, agentId: 'a', reason: 'answer' }])
  assert.deepEqual(selectableIds(s, { view: 'pool', runningOnly: true, rules: [] }), ['b']) // main is waiting, so hidden too
  assert.deepEqual(selectableIds(s, { view: 'pool', runningOnly: false, rules: [] }), ['main', 'a', 'b'])
})

test('flow view draws a child to the right of its parent, joined by an arrow', () => {
  const s = snap([spawn('p', 1), spawn('c', 2, { parentId: 'p' })])
  const t = text(layout(s, opts()))
  assert.equal(t[2], '[◉ request]─▶[✓ plan]─▶[⑂ route]─── Explore ──▶[● p 1m39s]───▶[● c 1m39s]')
})

// The approved mockup: main runs Bash; a workflow run (review:bugs → verify:bugs chained by label, review:perf failed)
// and two plain agents. Durations: bugs 41s, perf 42s, list 13s, count 10s, verify 12s and running.
const mockup = () => {
  const s = snap([
    { kind: 'mainTurn', at: 500, phase: 'start' }, { kind: 'toolCall', at: 600, agentId: 'main', tool: 'Bash' },
    { kind: 'workflowName', runId: 'wf_1', name: 'review-wf' },
    spawn('b', 1_000, { description: 'review:bugs', workflowRunId: 'wf_1', model: 'claude-sonnet-4-5' }),
    spawn('p', 2_000, { description: 'review:perf', workflowRunId: 'wf_1' }),
    spawn('l', 3_000, { description: 'list files in src' }),
    spawn('c', 4_000, { description: 'count test files' }),
    { kind: 'toolCall', at: 5_000, agentId: 'b', tool: 'Read' }, { kind: 'toolCall', at: 6_000, agentId: 'b', tool: 'Grep' },
    { kind: 'runEnd', at: 14_000, agentId: 'c', reason: 'answer' },
    { kind: 'runEnd', at: 16_000, agentId: 'l', reason: 'answer' },
    { kind: 'runEnd', at: 42_000, agentId: 'b', reason: 'answer' },
    { kind: 'runEnd', at: 44_000, agentId: 'p', reason: 'error' },
    spawn('v', 88_000, { description: 'verify:bugs', workflowRunId: 'wf_1' }), { kind: 'toolCall', at: 90_000, agentId: 'v', tool: 'Grep' },
  ])
  return { ...s, session: { ...s.session, id: 'e57186f5-0000-4000-8000-000000000000', project: '/w/proj' } }
}
const MOCKUP_BODY = [
  '[● request · Bash]─▶[✓ plan 0s]─▶[⑂ route]─┬─ workflow ──▶[◆ review-wf]─┬─▶[✓ review:bugs 41s]─ ─▶[● verify:bugs · Grep 12s]',
  '                                           │                            └─▶[✗ review:perf 42s]',
  '                                           ├─ Explore ───▶[✓ list files in src 13s]',
  '                                           └─ Explore ───▶[✓ count test files 10s]',
]

test('flow (a): the flow mockup scenario: a workflow run is one ◆ branch of the route, its steps chained', () => {
  const t = text(layout(mockup(), opts({ width: 140 })))
  assert.deepEqual(t, ['SWIMTRACE  proj  session e57186f5   5 agents', '', ...MOCKUP_BODY, 'Progress  1 running · 3 done · 1 failed'])
  const rows = layout(mockup(), opts({ width: 140, selectedId: 'v' }))
  const node = (re: RegExp) => rows.flat().find(g => re.test(g.text))!
  assert.equal(node(/^\[◆ review-wf\]$/).bold, true)
  assert.equal(node(/^\[✗ review:perf/).fg, 'red')
  assert.equal(node(/^\[● verify:bugs/).inverse, true)
  assert.equal(node(/^\[● request/).inverse, undefined)
  assert.equal(rows[0]!.at(-1)!.dim, true) // the agent count is dim
})

test('flow (b): agents of one workflow run share a single ◆ node, at its earliest agent\'s place', () => {
  const s = snap([spawn('x', 1), spawn('w1', 2, { workflowRunId: 'wf_9', description: 'agent 1' }), spawn('y', 3), spawn('w2', 4, { workflowRunId: 'wf_9', description: 'agent 2' })])
  const t = text(layout(s, opts()))
  assert.equal(t.filter(l => l.includes('◆')).length, 1)
  assert.equal(t.join('\n').match(/◆ wf_9/g)!.length, 1) // no workflow name known: the run id
  assert.deepEqual(t.slice(2, -1), [
    '[◉ request]─▶[✓ plan]─▶[⑂ route]─┬─ Explore ───▶[● x 1m39s]',
    '                                 ├─ workflow ──▶[◆ wf_9]─┬─▶[● agent 1 1m39s]',
    '                                 │                       └─▶[● agent 2 1m39s]',
    '                                 └─ Explore ───▶[● y 1m39s]',
  ])
})

test('flow (c): a step agent whose key matches no earlier step is a child of the ◆ node, not chained', () => {
  const s = snap([
    spawn('r1', 1, { workflowRunId: 'wf', description: 'review:a' }),
    spawn('v1', 2, { workflowRunId: 'wf', description: 'verify:b' }),
    spawn('v2', 3, { workflowRunId: 'wf', description: 'verify:a' }),
    spawn('r2', 4, { workflowRunId: 'wf', description: 'review:b' }), // started after verify:b: verify:b is not "after" it
    spawn('n', 5, { description: 'plain:a' }), // not a workflow agent: never chained
  ])
  const t = text(layout(s, opts()))
  assert.deepEqual(t.slice(2, -1), [
    '[◉ request]─▶[✓ plan]─▶[⑂ route]─┬─ workflow ──▶[◆ wf]─┬─▶[● review:a 1m39s]─ ─▶[● verify:a 1m39s]',
    '                                 │                     ├─▶[● verify:b 1m39s]',
    '                                 │                     └─▶[● review:b 1m39s]',
    '                                 └─ Explore ───▶[● plain:a 1m39s]',
  ])
})

test('flow: a chained node that also has children draws them below it, connector under the node', () => {
  const s = snap([
    spawn('r', 1, { workflowRunId: 'wf', description: 'review:a' }),
    spawn('k', 2, { parentId: 'r', description: 'kid' }),
    spawn('v', 3, { workflowRunId: 'wf', description: 'verify:a' }),
  ])
  assert.deepEqual(text(layout(s, opts())).slice(2, -1), [
    '[◉ request]─▶[✓ plan]─▶[⑂ route]─── workflow ──▶[◆ wf]───▶[● review:a 1m39s]─ ─▶[● verify:a 1m39s]',
    '                                                           └─▶[● kid 1m39s]',
  ])
})

test('flow (d): below 60 columns the flow is an indented tree, one node per line', () => {
  const t = text(layout(mockup(), opts({ width: 59 })))
  assert.deepEqual(t.slice(1), [
    '',
    '[● request · Bash]',
    '  └▶ [✓ plan 0s]',
    '    └▶ [⑂ route]',
    '      ├▶ workflow ▶ [◆ review-wf]',
    '        ├▶ [✓ review:bugs 41s]',
    '          ┄▶ [● verify:bugs · Grep 12s]',
    '        └▶ [✗ review:perf 42s]',
    '      ├▶ Explore ▶ [✓ list files in src 13s]',
    '      └▶ Explore ▶ [✓ count test files 10s]',
    'Progress  1 running · 3 done · 1 failed',
  ])
  assert.ok(t.every(l => cellWidth(l) <= 59))
})

test('flow (e): selectableIds is the drawn order, row by row and left to right, workflow nodes skipped', () => {
  const s = mockup()
  const o = { view: 'agent' as const, runningOnly: false, rules: [], now: 100_000 }
  assert.deepEqual(selectableIds(s, o), ['main', 'b', 'v', 'p', 'l', 'c'])
  // the same order the narrow tree draws, line by line (the plan node is no agent)
  const drawn = (width: number) => text(layout(s, opts({ width }))).slice(2)
    .flatMap(l => [...l.matchAll(/\[[●✓✗] ([^·\]]+?)(?: ·| \d|\])/g)].map(m => m[1])).filter(x => x !== 'plan')
  const names: Record<string, string> = { main: 'request', b: 'review:bugs', v: 'verify:bugs', p: 'review:perf', l: 'list files in src', c: 'count test files' }
  for (const width of [140, 59]) assert.deepEqual(drawn(width), selectableIds(s, o).map(id => names[id]))
})

test('flow (f): the header counts agents, Progress their states: subagents only, folded included, zero waiting/stopped/unknown hidden', () => {
  const s = snap([spawn('a', 1), spawn('b', 1), { kind: 'runEnd', at: 2, agentId: 'b', reason: 'error' }])
  s.folded.completed = 3
  const head = (x: typeof s) => text(layout(x, opts({ width: 140 })))[0]!
  const prog = (x: typeof s, view: 'agent' | 'pool' = 'agent') => text(layout(x, opts({ width: 140, view }))).find(l => l.startsWith('Progress'))!
  assert.match(head(s), /session sess-123 {3}5 agents$/)
  assert.equal(prog(s), 'Progress  1 running · 3 done · 1 failed')
  assert.equal(prog(s, 'pool'), 'Progress  1 running · 3 done · 1 failed') // the pools view keeps the counts too
  const more = snap([spawn('a', 1), spawn('i', 1), spawn('w', 1), { kind: 'runEnd', at: 2, agentId: 'i', reason: 'aborted' },
    { kind: 'listStatus', at: 2, agentId: 'w', status: 'idle', type: 'Explore', description: 'w' }])
  more.folded.killed = 1
  more.folded.unknown = 2
  assert.match(head(more), /6 agents$/)
  assert.equal(prog(more), 'Progress  1 running · 0 done · 0 failed · 1 waiting · 2 stopped · 2 unknown')
  assert.match(head(snap([spawn('a', 1)])), /1 agent$/)
  // tasks: completed of all (deleted ones are gone)
  const tasks = snap([spawn('a', 1), { kind: 'taskCreate', id: '1', subject: 'x' }, { kind: 'taskCreate', id: '2', subject: 'y' },
    { kind: 'taskCreate', id: '3', subject: 'z' }, { kind: 'taskUpdate', id: '1', status: 'completed' }, { kind: 'taskUpdate', id: '3', status: 'deleted' }])
  const t = text(layout(tasks, opts()))
  assert.equal(t.find(l => l.startsWith('Progress')), 'Progress  tasks 1/2 done · 1 running · 0 done · 0 failed')
  assert.equal(t.findIndex(l => l === 'Tasks'), t.findIndex(l => l.startsWith('Progress')) + 1) // above the tasks strip
})

test('flow (g): details show model, tools and the inferred step order; no tool input anywhere', () => {
  const s = mockup()
  const t = text(layout(s, opts({ selectedId: 'b', expanded: true })))
  assert.ok(t.some(l => /id b .*parent main .*type Explore/.test(l)))
  assert.ok(t.includes('model claude-sonnet-4-5  tools Read, Grep'))
  assert.ok(!t.some(l => /^after/.test(l)))
  const v = text(layout(s, opts({ selectedId: 'v', expanded: true })))
  assert.ok(v.includes('model —  tools Grep'))
  assert.ok(v.some(l => /tool Grep/.test(l)))
  assert.ok(v.includes('after review:bugs (step order inferred from labels)'))
  assert.ok(text(layout(s, opts({ selectedId: 'main', expanded: true }))).includes('model —  tools Bash'))
})

test('flow (h): runningOnly hides main; its running children are still drawn, grouped', () => {
  const s = snap([spawn('a', 1), spawn('b', 2), { kind: 'runEnd', at: 3, agentId: 'a', reason: 'answer' },
    spawn('w1', 4, { workflowRunId: 'wf', description: 'review:x' }), spawn('w2', 5, { workflowRunId: 'wf', description: 'verify:x' }),
    spawn('c', 6, { parentId: 'a' })]) // its parent is hidden: drawn as main's child would be
  const t = text(layout(s, opts({ runningOnly: true })))
  assert.deepEqual(t.slice(2, -1), [ // main hidden: its request node still draws, not selectable
    '[◉ request]─▶[✓ plan]─▶[⑂ route]─┬─ Explore ───▶[● b 1m39s]',
    '                                 ├─ workflow ──▶[◆ wf]───▶[● review:x 1m39s]─ ─▶[● verify:x 1m39s]',
    '                                 └─ Explore ───▶[● c 1m39s]',
  ])
  assert.deepEqual(selectableIds(s, { view: 'agent', runningOnly: true, rules: [] }), ['b', 'w1', 'w2', 'c'])
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

test('height limit keeps the header and says how many rows were cut', () => {
  const evs = Array.from({ length: 30 }, (_, i) => spawn(`a${i}`, i * 10))
  for (const view of ['pool', 'agent'] as const) {
    const t = text(layout(snap(evs), opts({ height: 10, view })))
    assert.equal(t.length, 10)
    assert.match(t[0]!, /SWIMTRACE/)
    assert.match(t.at(-1)!, /… \d+ more rows/)
  }
})

test('flow: a row wider than the screen is cut with a trailing …', () => {
  const t = text(layout(mockup(), opts({ width: 70 })))
  assert.equal(t[2], '[● request · Bash]─▶[✓ plan 0s]─▶[⑂ route]─┬─ workflow ──▶[◆ review-w…')
  assert.ok(t.every(l => cellWidth(l) <= 70))
})

test('cellWidth counts terminal cells', () => {
  assert.equal(cellWidth('ab'), 2)
  assert.equal(cellWidth('漢字'), 4)
  assert.equal(cellWidth('é'), 1)
  assert.equal(cellWidth('🚀'), 2)
})

test('wide characters are clipped by cells without splitting surrogate pairs', () => {
  const s = snap([spawn('w', 0, { description: '漢'.repeat(200) + '🚀' })])
  for (const width of [30, 60, 100]) {
    for (const r of layout(s, opts({ width }))) {
      const tx = rowText(r)
      assert.ok(cellWidth(tx) <= width, `row too wide at ${width}`)
      assert.equal([...tx].join(''), tx)
      assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(tx))
    }
  }
})

test('control characters are stripped from every row', () => {
  const mk = (d: string, subj: string) => snap([spawn('e', 0, { description: d }), { kind: 'taskCreate', id: '1', subject: subj }])
  const dirty = text(layout(mk('evil\n\x1b[2Jline', 'a\tb'), opts()))
  const clean = text(layout(mk('evil line', 'a b'), opts()))
  assert.equal(dirty.length, clean.length)
  for (const l of dirty) assert.ok(!/[\n\x1b\t]/.test(l))
})

test('final fix 2: a stale session shows its running agents as unknown, frozen at the last write', () => {
  const s = snap([{ kind: 'mainTurn', at: 5_000, phase: 'start' }, spawn('a1', 10_000), { kind: 'toolCall', at: 20_000, agentId: 'a1', tool: 'Grep' }])
  s.writtenAt = 50_000
  const before = JSON.stringify(s)
  for (const view of ['pool', 'agent'] as const) {
    const t = text(layout(s, opts({ now: 100_000, view, selectedId: 'a1', expanded: true, width: 140 })))
    assert.match(t[0]!, /STALE/)
    const row = t.find(l => / a1 /.test(l))!
    assert.match(row, view === 'agent' ? /\[\? a1 40s\]/ : /\? a1 40s/)
    assert.doesNotMatch(row, /●/)
    assert.ok(!t.some(l => /● (main|request)/.test(l)), 'main is not shown running')
    assert.ok(t.some(l => (view === 'agent' ? /\[\? request\]/ : /\? main/).test(l)), 'main shows unknown')
    assert.ok(t.some(l => /status unknown/.test(l)))
    assert.match(t[0]!, /1 agent$/)
    assert.ok(t.includes('Progress  0 running · 0 done · 0 failed · 1 unknown'))
  }
  assert.equal(JSON.stringify(s), before) // the snapshot is not mutated
  assert.deepEqual(selectableIds(s, { view: 'pool', runningOnly: true, rules: [], now: 100_000 }), [])
  assert.deepEqual(selectableIds(s, { view: 'pool', runningOnly: true, rules: [] }), ['main', 'a1']) // without now: as stored
  assert.match(text(layout(s, opts({ now: 55_000 }))).find(l => /a1/.test(l))!, /\[● a1 · Grep 45s\]/) // not stale yet: still running
})

// Fix round 1
test('fix 1: long labels and MCP tool names are capped in the node, at both widths; details keep the full label', () => {
  const long = 'L'.repeat(30) + 'M'.repeat(30) // 60 cells
  const s = snap([
    { kind: 'mainTurn', at: 500, phase: 'start' }, { kind: 'toolCall', at: 600, agentId: 'main', tool: 'Bash' },
    { kind: 'workflowName', runId: 'wf_1', name: 'review-wf' },
    spawn('x', 1_000, { description: long, workflowRunId: 'wf_1' }),
    { kind: 'toolCall', at: 2_000, agentId: 'x', tool: 'mcp__plugin_serena_serena__find_referencing_symbols' },
  ])
  const node = `[● ${'L'.repeat(27)}… · find_referenc… 1m39s]`
  const wide = text(layout(s, opts({ width: 140 })))
  assert.equal(wide[2], `[● request · Bash]─▶[✓ plan 0s]─▶[⑂ route]─── workflow ──▶[◆ review-wf]───▶${node}`) // 126 cells, uncut
  assert.ok(cellWidth(wide[2]!) <= 140 && !wide[2]!.endsWith('…]…'))
  const narrow = text(layout(s, opts({ width: 59 }))).find(l => l.startsWith('        └▶ '))!
  assert.equal(narrow, `        └▶ ${node}`.slice(0, 58) + '…') // capped in the tree too, then cut to the width
  const d = text(layout(s, opts({ selectedId: 'x', expanded: true, width: 200 })))
  assert.ok(d.some(l => l.startsWith(`id x  label ${long}  parent main`)))
  // a short MCP name is only unprefixed; a plain tool name is untouched
  const t = (tool: string) => text(layout(snap([spawn('y', 1), { kind: 'toolCall', at: 2, agentId: 'y', tool }]), opts()))[2]!
  assert.match(t('mcp__github__get_issue'), /\[● y · get_issue 1m39s\]/)
  assert.match(t('Grep'), /\[● y · Grep 1m39s\]/)
})

test('fix 2: below 8 rows the blank row under the header is dropped', () => {
  const s = snap([spawn('a', 1)])
  assert.equal(text(layout(s, opts({ height: 8 })))[1], '')
  assert.deepEqual(text(layout(s, opts({ height: 7 }))).slice(1, 2), ['[◉ request]─▶[✓ plan]─▶[⑂ route]─── Explore ──▶[● a 1m39s]'])
  assert.deepEqual(text(layout(s, opts({ height: 7, view: 'pool' }))).slice(1, 2), ['MAIN · main'])
})

test('fix 3: emoji-presentation symbols take two cells; the layout\'s own glyphs take one', () => {
  for (const e of ['✅', '⚡', '⭐', '❌', '☕', '✨', '❓', '⬛', '⌛']) assert.equal(cellWidth(e), 2, e)
  for (const g of ['●', '◌', '◉', '⑂', '✓', '✗', '■', '◆', '▶', '─', '│', '├', '└', '┬', '┄', '…', '·', '?']) assert.equal(cellWidth(g), 1, g)
  const s = snap([spawn('p', 1, { description: '✅ p' }), spawn('a', 2, { parentId: 'p' }), spawn('b', 3, { parentId: 'p' })])
  assert.deepEqual(text(layout(s, opts())).slice(2, -1), [
    '[◉ request]─▶[✓ plan]─▶[⑂ route]─── Explore ──▶[● ✅ p 1m39s]─┬─▶[● a 1m39s]',
    `${' '.repeat(62)}└─▶[● b 1m39s]`, // node at 47, 14 cells wide (✅ is 2): the bar at 47 + 14 + 1
  ])
})

test('fix 4: agents in a parentId cycle are still drawn, under main, and selectable', () => {
  const s = snap([spawn('a', 1, { parentId: 'b' }), spawn('b', 2, { parentId: 'a' }), spawn('c', 3)])
  assert.deepEqual(text(layout(s, opts())).slice(2, -1), [
    '[◉ request]─▶[✓ plan]─▶[⑂ route]─┬─ Explore ──▶[● c 1m39s]',
    '                                 └─ Explore ──▶[● a 1m39s]───▶[● b 1m39s]',
  ])
  assert.deepEqual(selectableIds(s, { view: 'agent', runningOnly: false, rules: [] }), ['main', 'c', 'a', 'b'])
})

// Stages: request → plan/classify → route → one branch per dispatch, and a Progress row.
// The stages mockup: a turn from 500 ms; [T1] (tagged) dispatched 8 s in, [T2], then a workflow run; five tasks.
const stagesMockup = (extra: object[] = []) => {
  const s = snap([
    { kind: 'mainTurn', at: 500, phase: 'start' }, { kind: 'toolCall', at: 600, agentId: 'main', tool: 'Bash' },
    { kind: 'workflowName', runId: 'wf_1', name: 'review-wf' },
    spawn('t1', 8_500, { description: '[T1] list files [class:complex]' }),
    spawn('t2', 9_000, { description: '[T2] count tests' }),
    spawn('b', 10_000, { type: 'general-purpose', description: 'review:bugs', workflowRunId: 'wf_1' }),
    spawn('p', 11_000, { type: 'general-purpose', description: 'review:perf', workflowRunId: 'wf_1' }),
    { kind: 'runEnd', at: 19_000, agentId: 't2', reason: 'answer' },
    { kind: 'runEnd', at: 21_500, agentId: 't1', reason: 'answer' },
    { kind: 'runEnd', at: 51_000, agentId: 'b', reason: 'answer' },
    { kind: 'runEnd', at: 53_000, agentId: 'p', reason: 'error' },
    spawn('v', 88_000, { type: 'general-purpose', description: 'verify:bugs', workflowRunId: 'wf_1' }), { kind: 'toolCall', at: 90_000, agentId: 'v', tool: 'Grep' },
    ...['1', '2', '3', '4', '5'].map(id => ({ kind: 'taskCreate', id, subject: `task ${id}` })),
    ...['1', '2', '3'].map(id => ({ kind: 'taskUpdate', id, status: 'completed' })), { kind: 'taskUpdate', id: '4', status: 'in_progress' },
    ...extra,
  ])
  return { ...s, session: { ...s.session, id: 'e57186f5-0000-4000-8000-000000000000', project: '/w/proj' } }
}
// The approved mockup's rows, but for two things it cannot hold together (see the stages report):
// its `├`/`└` sit one column right of its own `┬`; here they hang under it, as everywhere else in the flow.
const STAGES_BODY = [
  '[✓ request]─▶[✓ classify: complex 8s]─▶[⑂ route]─┬─ Explore ───▶[✓ [T1] list files 13s]',
  '                                                 ├─ Explore ───▶[✓ [T2] count tests 10s]',
  '                                                 └─ workflow ──▶[◆ review-wf]─┬─▶[✓ review:bugs 41s]─ ─▶[● verify:bugs · Grep 12s]',
  '                                                                              └─▶[✗ review:perf 42s]',
]

test('stages: the mockup scenario draws request → classify → route with labelled branches and a Progress row', () => {
  // main's turn ended while the workflow runs on in the background: `✓ request`
  const t = text(layout(stagesMockup([{ kind: 'mainTurn', at: 95_000, phase: 'end' }]), opts({ width: 140 })))
  assert.deepEqual(t.slice(0, 7), [
    'SWIMTRACE  proj  session e57186f5   5 agents', '', ...STAGES_BODY,
    'Progress  tasks 3/5 done · 1 running · 3 done · 1 failed',
  ])
  assert.equal(t[7], 'Tasks')
  // while main runs, the request node shows it and its current tool
  const live = text(layout(stagesMockup(), opts({ width: 140 })))
  assert.equal(live[2], '[● request · Bash]─▶[✓ classify: complex 8s]─▶[⑂ route]─┬─ Explore ───▶[✓ [T1] list files 13s]')
  const rows = layout(stagesMockup(), opts({ width: 140, selectedId: 'main' }))
  const seg = (re: RegExp) => rows.flat().find(g => re.test(g.text))!
  assert.equal(seg(/^\[● request/).inverse, true)
  assert.equal(seg(/^\[● request/).fg, 'cyan')
  assert.equal(seg(/^\[✓ classify/).fg, 'green')
  assert.equal(seg(/^\[⑂ route\]$/).bold, true)
  assert.equal(seg(/Explore ───▶$/).dim, true) // the branch label is part of the dim edge
})

test('stages: no [class:…] tag gives `plan <duration>`; the tag is stripped from labels in every view and in details', () => {
  const s = snap([{ kind: 'mainTurn', at: 1_000, phase: 'start' }, spawn('a', 9_000, { description: 'scan [class:quick] repo' }), spawn('b', 9_500)])
  const t = text(layout(s, opts()))
  assert.match(t[2]!, /^\[● request\]─▶\[✓ classify: quick 8s\]─▶\[⑂ route\]─┬─ Explore ──▶\[● scan repo 1m31s\]$/)
  assert.ok(!t.join('\n').includes('[class:'))
  assert.ok(text(layout(s, opts({ view: 'pool' }))).includes('  ● scan repo 1m31s'))
  assert.ok(text(layout(s, opts({ selectedId: 'a', expanded: true }))).some(l => l.startsWith('id a  label scan repo  parent main')))
  const plain = snap([{ kind: 'mainTurn', at: 1_000, phase: 'start' }, spawn('a', 9_000)])
  assert.match(text(layout(plain, opts()))[2]!, /^\[● request\]─▶\[✓ plan 8s\]─▶\[⑂ route\]─── Explore ──▶\[● a 1m31s\]$/)
  // a description that is only the tag shows the agent type
  assert.match(text(layout(snap([spawn('x', 1, { description: '[class:x]' })]), opts()))[2]!, /\[● Explore 1m39s\]$/)
})

test('stages: an earlier turn is one dim line under the pipeline; its agents are not drawn or selectable', () => {
  const s = snap([
    { kind: 'mainTurn', at: 1_000, phase: 'start' }, spawn('a', 2_000), spawn('b', 3_000), spawn('k', 3_500, { parentId: 'b' }),
    { kind: 'runEnd', at: 5_000, agentId: 'a', reason: 'answer' }, { kind: 'runEnd', at: 6_000, agentId: 'b', reason: 'error' },
    { kind: 'mainTurn', at: 13_000, phase: 'end' },
    { kind: 'mainTurn', at: 20_000, phase: 'start' }, // no dispatch: not drawn
    { kind: 'mainTurn', at: 21_000, phase: 'end' },
    { kind: 'mainTurn', at: 30_000, phase: 'start' }, spawn('c', 31_000),
  ])
  const rows = layout(s, opts())
  const t = text(rows)
  assert.deepEqual(t.slice(2, 4), [
    '[● request]─▶[✓ plan 1s]─▶[⑂ route]─── Explore ──▶[● c 1m09s]',
    '◉ request #1 · 3 agents ✗ 1 failed ● 1 running 12s',
  ])
  assert.equal(rows[3]![0]!.dim, true)
  assert.deepEqual(selectableIds(s, { view: 'agent', runningOnly: false, rules: [] }), ['main', 'c'])
  // all done: ✓; turns are numbered from the oldest drawn one; newest first
  const more = snap([
    { kind: 'mainTurn', at: 1_000, phase: 'start' }, spawn('a', 2_000), { kind: 'runEnd', at: 3_000, agentId: 'a', reason: 'answer' },
    { kind: 'mainTurn', at: 4_000, phase: 'start' }, // the first turn's end was missed: it is bounded by this start
    spawn('b', 5_000), { kind: 'runEnd', at: 6_000, agentId: 'b', reason: 'answer' }, { kind: 'mainTurn', at: 7_000, phase: 'end' },
    { kind: 'mainTurn', at: 8_000, phase: 'start' }, spawn('c', 9_000),
  ])
  assert.deepEqual(text(layout(more, opts())).slice(3, 5), ['◉ request #2 · 1 agent ✓ 3s', '◉ request #1 · 1 agent ✓ 3s'])
})

test('stages: selectableIds is the drawn order, main first as the request node', () => {
  const s = stagesMockup()
  const o = { view: 'agent' as const, runningOnly: false, rules: [], now: 100_000 }
  assert.deepEqual(selectableIds(s, o), ['main', 't1', 't2', 'b', 'v', 'p'])
  const names: Record<string, string> = { main: 'request', t1: '[T1] list files', t2: '[T2] count tests', b: 'review:bugs', v: 'verify:bugs', p: 'review:perf' }
  const drawn = (width: number) => text(layout(s, opts({ width })))
    .slice(2).flatMap(l => [...l.matchAll(/\[[●✓✗] ((?:\[T\d\] )?[^·\][]+?)(?: ·| \d|\])/g)].map(m => m[1])).filter(x => !/^(plan|classify)/.test(x!))
  for (const width of [140, 59]) assert.deepEqual(drawn(width), selectableIds(s, o).map(id => names[id]))
})

test('stages: below 60 columns the stages are an indented tree, branch labels before each agent', () => {
  const t = text(layout(stagesMockup(), opts({ width: 59 })))
  assert.deepEqual(t.slice(1, 13), [
    '',
    '[● request · Bash]',
    '  └▶ [✓ classify: complex 8s]',
    '    └▶ [⑂ route]',
    '      ├▶ Explore ▶ [✓ [T1] list files 13s]',
    '      ├▶ Explore ▶ [✓ [T2] count tests 10s]',
    '      └▶ workflow ▶ [◆ review-wf]',
    '        ├▶ [✓ review:bugs 41s]',
    '          ┄▶ [● verify:bugs · Grep 12s]',
    '        └▶ [✗ review:perf 42s]',
    'Progress  tasks 3/5 done · 1 running · 3 done · 1 failed',
    'Tasks',
  ])
  assert.ok(t.every(l => cellWidth(l) <= 59))
})

test('stages: runningOnly keeps the latest drawn turn\'s stage nodes, drops turns with no running dispatch', () => {
  const s = snap([
    { kind: 'mainTurn', at: 1_000, phase: 'start' }, spawn('a', 2_000), { kind: 'runEnd', at: 3_000, agentId: 'a', reason: 'answer' },
    { kind: 'mainTurn', at: 4_000, phase: 'end' },
    { kind: 'mainTurn', at: 5_000, phase: 'start' }, spawn('b', 6_000), spawn('c', 7_000), { kind: 'runEnd', at: 8_000, agentId: 'c', reason: 'answer' },
    { kind: 'mainTurn', at: 9_000, phase: 'end' },
  ])
  const t = text(layout(s, opts({ runningOnly: true })))
  // main is waiting, so hidden: its request node still draws, not selectable; the plan phase runs to b, the first dispatch
  assert.deepEqual(t.slice(2), ['[✓ request]─▶[✓ plan 1s]─▶[⑂ route]─── Explore ──▶[● b 1m34s]', 'Progress  1 running · 2 done · 0 failed'])
  assert.deepEqual(selectableIds(s, { view: 'agent', runningOnly: true, rules: [] }), ['b'])
  // nothing running: no turn is drawn, main hidden: nothing but Progress
  const idle = snap([spawn('a', 1), { kind: 'runEnd', at: 2, agentId: 'a', reason: 'answer' }])
  assert.deepEqual(text(layout(idle, opts({ runningOnly: true }))).slice(2), ['Progress  0 running · 1 done · 0 failed'])
})

test('stages: dispatches before any recorded turn form a turn of their own, with no plan time', () => {
  const s = snap([spawn('a', 1_000), { kind: 'mainTurn', at: 5_000, phase: 'start' }, spawn('b', 6_000)])
  const t = text(layout(s, opts()))
  assert.deepEqual(t.slice(2, 4), ['[● request]─▶[✓ plan 1s]─▶[⑂ route]─── Explore ──▶[● b 1m34s]', '◉ request #1 · 1 agent ● 1 running 4s'])
  assert.match(text(layout(snap([spawn('a', 1_000)]), opts()))[2]!, /^\[◉ request\]─▶\[✓ plan\]─▶\[⑂ route\]/)
})

test('stages: main alone draws the request node alone; the header keeps only the agent count', () => {
  const t = text(layout(snap([{ kind: 'mainTurn', at: 1_000, phase: 'start' }, { kind: 'toolCall', at: 2_000, agentId: 'main', tool: 'Read' }]), opts()))
  assert.deepEqual(t, ['SWIMTRACE  c4k-mobile  session sess-123   0 agents', '', '[● request · Read]', 'Progress  0 running · 0 done · 0 failed'])
})
