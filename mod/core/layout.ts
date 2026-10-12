import type { Agent, Snapshot, Status } from './model.ts'
import { STALE_SESSION_MS, isLive } from './model.ts'
import type { CompiledRule, Pool } from './pools.ts'
import { resolvePool } from './pools.ts'

export type Fg = 'green' | 'red' | 'yellow' | 'cyan' | 'gray' | 'magenta'
export interface Seg { text: string; fg?: Fg; bold?: boolean; dim?: boolean; inverse?: boolean }
export type Row = Seg[]
/** `agent` is the flow view (nodes joined by arrows, left to right), the default; `pool` lists the lanes. */
export type View = 'pool' | 'agent'
export interface LayoutOpts {
  width: number; height: number; now: number; view: View; runningOnly: boolean
  selectedId?: string; expanded: boolean; rules: readonly CompiledRule[]
}
export interface Lane { pool: Pool; agents: Agent[] }
/** `now`, when given, lets a stale session's agents be listed as layout draws them (see `asDrawn`). */
type LaneOpts = Pick<LayoutOpts, 'view' | 'runningOnly' | 'rules'> & { now?: number }

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

/**
 * The snapshot as drawn at `now`: in a stale session (the writer stopped without ending it) nothing is known to be
 * running any more, so every live agent, main included, shows `unknown`, its duration ending at the last write.
 * A copy; the snapshot itself is left as read.
 */
export function asDrawn(s: Snapshot, now: number): Snapshot {
  if (!isStale(s, now) || !s.agents.some(a => isLive(a.status))) return s
  return {
    ...s,
    agents: s.agents.map(a => (isLive(a.status) ? { ...a, status: 'unknown', endedAt: s.writtenAt, endReason: 'stale', currentTool: undefined } : a)),
  }
}

const visible = (s: Snapshot, o: LaneOpts) => {
  const v = o.now === undefined ? s : asDrawn(s, o.now)
  return o.runningOnly ? v.agents.filter(a => a.status === 'running') : v.agents
}

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

/**
 * A flow node: an agent, or a synthetic workflow node (`runId`) standing for the agents of one run that share a parent.
 * `chain` is the agent drawn after it on the same row: step order inferred from workflow labels, never observed.
 */
interface FNode { a?: Agent; runId?: string; kids: FNode[]; chain?: FNode }
interface Flow { roots: FNode[]; after: Map<string, Agent> }

const STEP = /^([\w-]+):(.+)$/

function flow(agents: Agent[]): Flow {
  const ids = new Set(agents.map(a => a.id))
  const kids = new Map<string, Agent[]>()
  for (const a of [...agents].sort((x, y) => x.startedAt - y.startedAt)) {
    if (a.id === 'main') continue
    const p = a.parentId !== undefined && a.parentId !== a.id && ids.has(a.parentId) ? a.parentId : 'main'
    kids.set(p, [...(kids.get(p) ?? []), a])
  }
  const after = new Map<string, Agent>()
  const seen = new Set<Agent>() // each agent drawn once: a malformed file's repeated ids cannot loop
  const node = (a: Agent): FNode => ({ a, kids: group(kids.get(a.id) ?? []) })
  // Children in start order; agents of one workflow run become one node where its earliest agent would be.
  function group(list: Agent[]): FNode[] {
    const out: FNode[] = []
    const runs = new Map<string, Agent[]>()
    for (const a of list) {
      if (seen.has(a)) continue
      seen.add(a)
      const r = a.workflowRunId
      if (r === undefined) { out.push(node(a)); continue }
      if (!runs.has(r)) { runs.set(r, []); out.push({ runId: r, kids: [] }) }
      runs.get(r)!.push(a)
    }
    for (const n of out) if (n.runId !== undefined) n.kids = chained(runs.get(n.runId)!)
    return out
  }
  // `<step>:<key>` labels: steps ordered by first start; an agent follows the earliest unchained agent of the step
  // before with its key that started no later than it. Anything else is a plain child of the workflow node.
  function chained(members: Agent[]): FNode[] {
    const steps: string[] = []
    const xs = members.map(a => {
      const m = STEP.exec(label(a))
      if (m && !steps.includes(m[1]!)) steps.push(m[1]!)
      return { n: node(a), step: m?.[1], key: m?.[2] }
    })
    const top: FNode[] = []
    xs.forEach((x, i) => {
      const at = x.step === undefined ? -1 : steps.indexOf(x.step)
      const prev = at > 0 ? xs.slice(0, i).find(y => y.step === steps[at - 1] && y.key === x.key && y.n.chain === undefined) : undefined
      if (prev) { prev.n.chain = x.n; after.set(x.n.a!.id, prev.n.a!) } else top.push(x.n)
    })
    return top
  }
  const main = agents.find(a => a.id === 'main')
  const top = group(kids.get('main') ?? [])
  // Agents no path from main reaches (a parentId cycle in a malformed file) still show, as main's children.
  const stray = group(agents.filter(a => a.id !== 'main' && !seen.has(a)).sort((x, y) => x.startedAt - y.startedAt))
  // runningOnly may hide main; its children are then drawn as roots
  return { roots: main ? [{ a: main, kids: [...top, ...stray] }] : [...top, ...stray], after }
}

/** Agents in drawn order: a node, then what is chained after it, then its children (row by row, left to right). */
const flowOrder = (n: FNode): string[] => [...(n.a ? [n.a.id] : []), ...(n.chain ? flowOrder(n.chain) : []), ...n.kids.flatMap(flowOrder)]

export function selectableIds(s: Snapshot, o: LaneOpts): string[] {
  if (o.view === 'agent') return flow(visible(s, o)).roots.flatMap(flowOrder)
  return lanes(s, o).flatMap(l => l.agents.map(a => a.id))
}

const label = (a: Agent) => a.name ?? (a.id === 'main' ? 'main' : a.type === a.description ? a.type : a.description || a.type)
const dur = (a: Agent, now: number) => fmtDuration((a.endedAt ?? now) - a.startedAt)

const RANGES_ZERO: [number, number][] = [[0x300, 0x36f], [0x200b, 0x200f], [0xfe00, 0xfe0f], [0x20d0, 0x20ff]]
const RANGES_WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1faff], [0x20000, 0x3fffd],
  // Emoji-presentation symbols below U+1F300 (✅ ⚡ ❌ ⭐ …). Code points only, not blocks: ✓ ✗ ● ◆ and the box drawing stay 1.
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
]
const inRanges = (c: number, rs: [number, number][]) => rs.some(([a, b]) => c >= a && c <= b)
const charWidth = (ch: string): number => {
  const c = ch.codePointAt(0)!
  return inRanges(c, RANGES_ZERO) ? 0 : inRanges(c, RANGES_WIDE) ? 2 : 1
}
export function cellWidth(text: string): number {
  let n = 0
  for (const ch of text) n += charWidth(ch)
  return n
}
/** Longest prefix of `text` that fits in `cells` terminal cells, cut on whole code points. */
function cut(text: string, cells: number): string {
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = charWidth(ch)
    if (used + w > cells) break
    out += ch
    used += w
  }
  return out
}

/** `row` with control characters blanked, cut to `width` terminal cells. */
export function clip(row: Row, width: number): Row {
  const out: Row = []
  let left = width
  for (const g of row) {
    if (left <= 0) break
    const clean = g.text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    const t = cellWidth(clean) > left ? cut(clean, left) : clean
    out.push({ ...g, text: t })
    left -= cellWidth(t)
  }
  return out
}

function listLine(a: Agent, now: number, selected: boolean): Row {
  const tool = a.status === 'running' && a.currentTool ? ` ${a.currentTool}` : ''
  return [
    { text: '  ' },
    { text: `${GLYPH[a.status]} ${label(a)} ${dur(a, now)}`, fg: COLOR[a.status], inverse: selected },
    { text: tool, dim: true },
  ]
}

// Node text stays short so a flow fits across: labels and workflow names to 28 cells, tools to 14 (details keep the label whole).
const LABEL_CELLS = 28
const TOOL_CELLS = 14
const cap = (text: string, cells: number) => (cellWidth(text) <= cells ? text : `${cut(text, cells - 1)}…`)
// `mcp__<server>__<tool>` → `<tool>`
const toolName = (t: string) => t.replace(/^mcp__.*__(?=.)/, '')

function nodeSeg(n: FNode, o: LayoutOpts, workflows: Record<string, string>): Seg {
  if (n.a === undefined) return { text: `[◆ ${cap(workflows[n.runId!] ?? n.runId!, LABEL_CELLS)}]`, bold: true }
  const a = n.a
  const tool = a.status === 'running' && a.currentTool ? ` · ${cap(toolName(a.currentTool), TOOL_CELLS)}` : ''
  const time = a.id === 'main' ? '' : ` ${dur(a, o.now)}`
  return { text: `[${GLYPH[a.status]} ${cap(label(a), LABEL_CELLS)}${tool}${time}]`, fg: COLOR[a.status], inverse: a.id === o.selectedId || undefined }
}

const EDGE = { dim: true } as const

/** The flow left to right: children start 4 cells after their parent, a chained agent on the parent's own row. */
function flowRows(roots: FNode[], o: LayoutOpts, workflows: Record<string, string>): Row[] {
  const grid: { col: number; seg: Seg }[][] = []
  const put = (row: number, col: number, seg: Seg) => (grid[row] ??= []).push({ col, seg })
  // Draws `n` at (row, col); returns the rows it took.
  const draw = (n: FNode, row: number, col: number): number => {
    const seg = nodeSeg(n, o, workflows)
    const w = cellWidth(seg.text)
    put(row, col, seg)
    if (n.chain === undefined) return n.kids.length === 0 ? 1 : fan(n.kids, row, col + w + 1, true) - row
    put(row, col + w, { text: '─ ─▶', ...EDGE })
    const used = draw(n.chain, row, col + w + 4)
    if (n.kids.length === 0) return used
    // ponytail: rare (a chained agent with children of its own): they go below everything chained, connector under the node
    for (let r = row + 1; r < row + used; r++) put(r, col + 1, { text: '│', ...EDGE })
    return fan(n.kids, row + used, col + 1, false) - row
  }
  // Siblings hang off the bar at column x; the first shares its parent's row when `sameRow`. Returns the next free row.
  const fan = (kids: FNode[], first: number, x: number, sameRow: boolean): number => {
    let r = first
    kids.forEach((k, i) => {
      const last = i === kids.length - 1
      if (sameRow && i === 0) put(r, x - 1, { text: last ? '───▶' : '─┬─▶', ...EDGE })
      else put(r, x, { text: last ? '└─▶' : '├─▶', ...EDGE })
      const h = draw(k, r, x + 3)
      if (!last) for (let j = r + 1; j < r + h; j++) put(j, x, { text: '│', ...EDGE })
      r += h
    })
    return r
  }
  let row = 0
  for (const n of roots) row += draw(n, row, 0)
  return grid.map(cells => {
    const out: Row = []
    let at = 0
    for (const { col, seg } of (cells ?? []).sort((x, y) => x.col - y.col)) {
      if (col > at) out.push({ text: ' '.repeat(col - at) })
      out.push(seg)
      at = col + cellWidth(seg.text)
    }
    return out
  })
}

/** The flow below COMPACT_BELOW columns: one node per line, indented; a chained agent is its predecessor's `┄▶` child. */
function flowTree(roots: FNode[], o: LayoutOpts, workflows: Record<string, string>): Row[] {
  const out: Row[] = []
  const walk = (n: FNode, depth: number, conn: string) => {
    out.push([{ text: '  '.repeat(depth) + conn, ...EDGE }, nodeSeg(n, o, workflows)])
    const subs = [...(n.chain ? [{ k: n.chain, dashed: true }] : []), ...n.kids.map(k => ({ k, dashed: false }))]
    subs.forEach(({ k, dashed }, i) => walk(k, depth + 1, dashed ? '┄▶ ' : i === subs.length - 1 ? '└▶ ' : '├▶ '))
  }
  for (const n of roots) walk(n, 0, '')
  return out
}

/** clip, with a trailing … when the row was cut. */
function clipMore(row: Row, width: number): Row {
  return cellWidth(rowText(row)) <= width ? clip(row, width) : [...clip(row, width - 1), { text: '…', ...EDGE }]
}

function details(a: Agent, s: Snapshot, o: LayoutOpts, prev: Agent | undefined): Row[] {
  const pool = resolvePool(a, s.session.project, s.workflows, o.rules)
  const time = (t?: number) => (t === undefined ? '—' : new Date(t).toISOString().slice(11, 19))
  const tools = Array.isArray(a.tools) && a.tools.length > 0 ? a.tools.join(', ') : '—'
  return [
    [{ text: `id ${a.id}  label ${label(a)}  parent ${a.parentId ?? (a.id === 'main' ? '—' : 'main')}  type ${a.type}  pool ${pool.name} (${pool.source})`, dim: true }],
    [{ text: `status ${a.status}  tool ${a.currentTool ?? '—'}  start ${time(a.startedAt)}  end ${time(a.endedAt)}  reason ${a.endReason ?? '—'}`, dim: true }],
    [{ text: `model ${a.model ?? '—'}  tools ${tools}`, dim: true }],
    ...(prev ? [[{ text: `after ${label(prev)} (step order inferred from labels)`, dim: true }]] : []),
  ]
}

/** `   N agents · R running · D done · F failed`, then waiting, stopped and unknown when any: subagents only, folded included. */
function summary(s: Snapshot): string {
  const subs = s.agents.filter(a => a.id !== 'main')
  const n = (...st: Status[]) => subs.filter(a => st.includes(a.status)).length
  const f = s.folded
  const total = subs.length + f.completed + f.failed + f.interrupted + f.killed + f.unknown
  const parts = [`${total} agent${total === 1 ? '' : 's'}`, `${n('running')} running`, `${n('completed') + f.completed} done`, `${n('failed') + f.failed} failed`]
  const extra: [number, string][] = [[n('waiting'), 'waiting'], [n('interrupted', 'killed') + f.interrupted + f.killed, 'stopped'], [n('unknown') + f.unknown, 'unknown']]
  for (const [c, word] of extra) if (c > 0) parts.push(`${c} ${word}`)
  return `   ${parts.join(' · ')}`
}

export function layout(snapshot: Snapshot, o: LayoutOpts): Row[] {
  const s = asDrawn(snapshot, o.now)
  const header: Row = [
    { text: 'SWIMTRACE', bold: true },
    { text: `  ${s.session.project.split('/').filter(Boolean).at(-1) ?? s.session.project}  session ${s.session.id.slice(0, 8)}` },
  ]
  if (s.simulated) header.push({ text: ' [SIMULATED]', fg: 'red', bold: true })
  if (isStale(s, o.now)) header.push({ text: ' [STALE]', fg: 'yellow', bold: true })
  if (s.session.endedAt !== undefined) header.push({ text: ' [ENDED]', fg: 'gray', bold: true })
  header.push({ text: summary(s), dim: true })

  const body: Row[] = o.height < 8 ? [] : [[]] // a blank row under the header, when there is room for it
  const graph = flow(visible(s, o)) // pools view too: details name an agent's inferred predecessor
  if (o.view === 'agent') {
    if (o.width < COMPACT_BELOW) body.push(...flowTree(graph.roots, o, s.workflows))
    else body.push(...flowRows(graph.roots, o, s.workflows))
  } else {
    for (const l of lanes(s, o)) {
      body.push([{ text: `${l.pool.name} · ${l.pool.source}`, bold: true }])
      for (const a of l.agents) body.push(listLine(a, o.now, a.id === o.selectedId))
    }
  }
  const sel = o.expanded ? s.agents.find(a => a.id === o.selectedId) : undefined
  if (sel) body.push(...details(sel, s, o, graph.after.get(sel.id)))
  if (s.tasks.length > 0) {
    body.push([{ text: 'Tasks', bold: true }])
    for (const t of s.tasks) {
      const g = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '◌'
      const blocked = t.blockedBy.length > 0 ? ` (blocked by ${t.blockedBy.join(', ')})` : ''
      body.push([{ text: `  #${t.id} ${g} ${t.subject}${blocked}` }])
    }
  }

  const room = Math.max(0, o.height - 1)
  const shown = body.length <= room ? body : [...body.slice(0, Math.max(0, room - 1)), [{ text: `… ${body.length - room + 1} more rows`, dim: true }]]
  return [header, ...shown].map(r => clipMore(r, o.width))
}
