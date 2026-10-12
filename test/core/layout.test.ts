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
