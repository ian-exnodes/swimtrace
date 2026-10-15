import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyHit, screen, sessionPaneRows, usePanes, type ViewState } from '../../cli/main.ts'
import { hitAt } from '../../cli/mouse.ts'
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

test('below 100×20 the screen is today\'s single column, row for row', () => {
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

test('the Sessions window keeps the current session in view', () => {
  const es = Array.from({ length: 10 }, (_, i) => entry(emptySnapshot({ id: `sess-${i}-xxxxxx`, project: `/w/p${i}`, startedAt: 0 })))
  const rows = sessionPaneRows(es, es[9]!.path, 30, 3)
  assert.equal(rows.length, 3)
  assert.match(rowText(rows[2]!), /^p9  sess-9-x/)
  assert.equal(rows[2]![0]!.inverse, true)
  assert.match(rowText(sessionPaneRows(es, es[0]!.path, 30, 3)[0]!), /^p0 /)
})

test('wide project names, long labels, a session with only main', () => {
  const wide = { ...emptySnapshot({ id: 'sess-wide0000', project: `/w/${'漢字'.repeat(40)}`, startedAt: 0 }), writtenAt: 1_000 }
  const st = state({ entries: [entry(wide)], current: '/x/sess-wide0000.json', now: 1_000 })
  for (const [W, H] of [[100, 20], [137, 33]] as const) exact(screen(st, W, H), W, H)
  assert.ok(texts(screen(st, 120, 30)).some(t => t.includes('type    main')))
})

test('panes: a long project name is shortened, not the status markers or the agent count', () => {
  const long = { ...orch!, simulated: true, session: { ...orch!.session, project: '/w/my-rather-long-project-name-here', endedAt: undefined }, writtenAt: 0 }
  const n = orch!.agents.filter(a => a.id !== 'main').length
  for (const view of ['agent', 'pool'] as const) {
    const st = state({ entries: [entry(long)], current: `/x/${long.session.id}.json`, now: 20_000, view })
    const rows = screen(st, 100, 20)
    exact(rows, 100, 20)
    const top = rowText(rows[0]!)
    assert.match(top, /SWIMTRACE/)
    assert.ok(top.includes('[SIMULATED]') && top.includes('[STALE]'), top)
    assert.ok(top.includes(`${n} agent${n === 1 ? '' : 's'}`), top)
    assert.ok(top.includes('…'), top)
    if (view === 'pool') assert.ok(top.includes(' · pools'), top)
  }
})

/** The first cell (col, row) of the frame whose text carries `hit`. */
const cellOf = (rows: Row[], hit: string) => {
  for (let row = 0; row < rows.length; row++) {
    let col = 0
    for (const g of rows[row]!) { if (g.hit === hit) return { col, row }; col += cellWidth(g.text) }
  }
  return undefined
}

test('click: a flow node in the panes selects that agent and Details follows', () => {
  const id = selectableIds(orch!, { view: 'agent', runningOnly: false, rules: [], now: orch!.writtenAt }).find(i => i !== 'main')!
  const a = orch!.agents.find(x => x.id === id)!
  const st = state()
  const at = cellOf(screen(st, 120, 30), `agent:${id}`)!
  assert.ok(at, 'node on screen')
  const hit = hitAt(screen(st, 120, 30), at.col + 1, at.row)!
  const next = { ...st, ...applyHit(hit, st) }
  assert.equal(next.selectedId, id)
  assert.ok(texts(screen(next, 120, 30)).some(t => t.includes(`type    ${a.type}`)))
  const req = cellOf(screen(next, 120, 30), 'agent:main')
  assert.ok(req, 'the request node is clickable')
  assert.equal(applyHit(hitAt(screen(next, 120, 30), req.col, req.row)!, next).selectedId, 'main')
})

test('click: a Sessions row switches session and resets the selection', () => {
  const [a, b] = playInstant('multi-session', 0)
  const pa = `/x/${a!.session.id}.json`, pb = `/x/${b!.session.id}.json`
  const st = state({ entries: [entry(a!), entry(b!)], current: pa, selectedId: 'x', now: b!.writtenAt })
  const at = cellOf(screen(st, 120, 30), `session:${pb}`)!
  assert.ok(at, 'session row on screen')
  assert.deepEqual(applyHit(hitAt(screen(st, 120, 30), at.col, at.row)!, st), { current: pb, listMode: false, selectedId: undefined })
})

test('click: the full-screen list opens a session; the single column selects nodes too', () => {
  const st = state({ listMode: true })
  const path = `/x/${orch!.session.id}.json`
  assert.ok(cellOf(screen(st, 120, 30), `session:${path}`), 'list row is clickable')
  const id = selectableIds(orch!, { view: 'agent', runningOnly: false, rules: [], now: orch!.writtenAt }).find(i => i !== 'main')!
  assert.ok(cellOf(screen(state(), 80, 24), `agent:${id}`), 'single column node is clickable')
})

test('click: an unknown or missing target changes nothing', () => {
  assert.deepEqual(applyHit('other:1', state()), {})
  assert.equal(hitAt(screen(state(), 120, 30), 0, 0), undefined) // the frame corner
})

test('panes: the Flow pane draws the request node without the tool of main; Details keeps it', () => {
  const [s] = playInstant('orchestrated', 0, 1000) // main is calling Agent
  const st = state({ entries: [entry(s!)], current: `/x/${s!.session.id}.json`, now: s!.writtenAt })
  const rows = texts(screen(st, 120, 30))
  assert.ok(rows.some(t => t.includes('[● request]')), 'request node without tool')
  assert.ok(!rows.some(t => t.includes('request · ')))
  assert.ok(rows.some(t => t.includes('tool    Agent')), 'Details shows main\'s tool')
  assert.ok(texts(screen(st, 99, 30)).some(t => t.includes('request · Agent')), 'single column unchanged')
})
