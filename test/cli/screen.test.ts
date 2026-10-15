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
