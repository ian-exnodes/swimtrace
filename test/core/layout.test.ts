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
  assert.equal(t[2], '[◌ main]───▶[● p 1m39s]───▶[● c 1m39s]')
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
  '[● main · Bash]─┬─▶[◆ review-wf]─┬─▶[✓ review:bugs 41s]─ ─▶[● verify:bugs · Grep 12s]',
  '                │                └─▶[✗ review:perf 42s]',
  '                ├─▶[✓ list files in src 13s]',
  '                └─▶[✓ count test files 10s]',
]

test('flow (a): the mockup scenario draws the approved rows', () => {
  const t = text(layout(mockup(), opts()))
  // The mockup's header said "2 running · 2 done", which its own nodes contradict (one ●, three ✓): counted from the data.
  assert.deepEqual(t, ['SWIMTRACE  proj  session e57186f5   5 agents · 1 running · 3 done · 1 failed', '', ...MOCKUP_BODY])
  const rows = layout(mockup(), opts({ selectedId: 'v' }))
  const node = (re: RegExp) => rows.flat().find(g => re.test(g.text))!
  assert.equal(node(/^\[◆ review-wf\]$/).bold, true)
  assert.equal(node(/^\[✗ review:perf/).fg, 'red')
  assert.equal(node(/^\[● verify:bugs/).inverse, true)
  assert.equal(node(/^\[● main/).inverse, undefined)
  assert.equal(rows[0]!.at(-1)!.dim, true) // the summary is dim
})

test('flow (b): agents of one workflow run share a single ◆ node, at its earliest agent\'s place', () => {
  const s = snap([spawn('x', 1), spawn('w1', 2, { workflowRunId: 'wf_9', description: 'agent 1' }), spawn('y', 3), spawn('w2', 4, { workflowRunId: 'wf_9', description: 'agent 2' })])
  const t = text(layout(s, opts()))
  assert.equal(t.filter(l => l.includes('◆')).length, 1)
  assert.equal(t.join('\n').match(/◆ wf_9/g)!.length, 1) // no workflow name known: the run id
  assert.deepEqual(t.slice(2), [
    '[◌ main]─┬─▶[● x 1m39s]',
    '         ├─▶[◆ wf_9]─┬─▶[● agent 1 1m39s]',
    '         │           └─▶[● agent 2 1m39s]',
    '         └─▶[● y 1m39s]',
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
  assert.deepEqual(t.slice(2), [
    '[◌ main]─┬─▶[◆ wf]─┬─▶[● review:a 1m39s]─ ─▶[● verify:a 1m39s]',
    '         │         ├─▶[● verify:b 1m39s]',
    '         │         └─▶[● review:b 1m39s]',
    '         └─▶[● plain:a 1m39s]',
  ])
})

test('flow: a chained node that also has children draws them below it, connector under the node', () => {
  const s = snap([
    spawn('r', 1, { workflowRunId: 'wf', description: 'review:a' }),
    spawn('k', 2, { parentId: 'r', description: 'kid' }),
    spawn('v', 3, { workflowRunId: 'wf', description: 'verify:a' }),
  ])
  assert.deepEqual(text(layout(s, opts())).slice(2), [
    '[◌ main]───▶[◆ wf]───▶[● review:a 1m39s]─ ─▶[● verify:a 1m39s]',
    '                       └─▶[● kid 1m39s]',
  ])
})

test('flow (d): below 60 columns the flow is an indented tree, one node per line', () => {
  const t = text(layout(mockup(), opts({ width: 59 })))
  assert.deepEqual(t.slice(1), [
    '',
    '[● main · Bash]',
    '  ├▶ [◆ review-wf]',
    '    ├▶ [✓ review:bugs 41s]',
    '      ┄▶ [● verify:bugs · Grep 12s]',
    '    └▶ [✗ review:perf 42s]',
    '  ├▶ [✓ list files in src 13s]',
    '  └▶ [✓ count test files 10s]',
  ])
  assert.ok(t.every(l => cellWidth(l) <= 59))
})

test('flow (e): selectableIds is the drawn order, row by row and left to right, workflow nodes skipped', () => {
  const s = mockup()
  const o = { view: 'agent' as const, runningOnly: false, rules: [], now: 100_000 }
  assert.deepEqual(selectableIds(s, o), ['main', 'b', 'v', 'p', 'l', 'c'])
  // the same order the narrow tree draws, line by line
  const drawn = (width: number) => text(layout(s, opts({ width }))).slice(2).flatMap(l => [...l.matchAll(/\[[●✓✗] ([^·\]]+?)(?: ·| \d|\])/g)].map(m => m[1]))
  const names: Record<string, string> = { main: 'main', b: 'review:bugs', v: 'verify:bugs', p: 'review:perf', l: 'list files in src', c: 'count test files' }
  for (const width of [100, 40]) assert.deepEqual(drawn(width), selectableIds(s, o).map(id => names[id]))
})

test('flow (f): header counts are subagents only, include folded, and hide zero waiting/stopped/unknown', () => {
  const s = snap([spawn('a', 1), spawn('b', 1), { kind: 'runEnd', at: 2, agentId: 'b', reason: 'error' }])
  s.folded.completed = 3
  const head = (x: typeof s) => text(layout(x, opts({ width: 140 })))[0]!
  assert.match(head(s), /session sess-123 {3}5 agents · 1 running · 3 done · 1 failed$/)
  const more = snap([spawn('a', 1), spawn('i', 1), spawn('w', 1), { kind: 'runEnd', at: 2, agentId: 'i', reason: 'aborted' },
    { kind: 'listStatus', at: 2, agentId: 'w', status: 'idle', type: 'Explore', description: 'w' }])
  more.folded.killed = 1
  more.folded.unknown = 2
  assert.match(head(more), /6 agents · 1 running · 0 done · 0 failed · 1 waiting · 2 stopped · 2 unknown$/)
  assert.match(head(snap([spawn('a', 1)])), /1 agent · 1 running · 0 done · 0 failed$/)
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
  assert.deepEqual(t.slice(2), [
    '[● b 1m39s]',
    '[◆ wf]───▶[● review:x 1m39s]─ ─▶[● verify:x 1m39s]',
    '[● c 1m39s]',
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
  assert.equal(t[2], '[● main · Bash]─┬─▶[◆ review-wf]─┬─▶[✓ review:bugs 41s]─ ─▶[● verify:…')
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
    assert.ok(!t.some(l => /● main/.test(l)), 'main is not shown running')
    assert.ok(t.some(l => /\? main/.test(l)), 'main shows unknown')
    assert.ok(t.some(l => /status unknown/.test(l)))
    assert.match(t[0]!, /1 agent · 0 running · 0 done · 0 failed · 1 unknown$/)
  }
  assert.equal(JSON.stringify(s), before) // the snapshot is not mutated
  assert.deepEqual(selectableIds(s, { view: 'pool', runningOnly: true, rules: [], now: 100_000 }), [])
  assert.deepEqual(selectableIds(s, { view: 'pool', runningOnly: true, rules: [] }), ['main', 'a1']) // without now: as stored
  assert.match(text(layout(s, opts({ now: 55_000 }))).find(l => /a1/.test(l))!, /\[● a1 · Grep 45s\]/) // not stale yet: still running
})
