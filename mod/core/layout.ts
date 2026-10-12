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
