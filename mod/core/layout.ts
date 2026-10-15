import type { Agent, Snapshot, Status, Turn } from './model.ts'
import { STALE_SESSION_MS, isLive } from './model.ts'
import type { CompiledRule, Pool } from './pools.ts'
import { resolvePool } from './pools.ts'

export type Fg = 'green' | 'red' | 'yellow' | 'cyan' | 'gray' | 'magenta'
/** `hit`: what a click on this text selects in the CLI (`agent:<id>`, `session:<path>`); the band ignores it. */
export interface Seg { text: string; fg?: Fg; bold?: boolean; dim?: boolean; inverse?: boolean; hit?: string }
export type Row = Seg[]
/** `agent` is the flow view (nodes joined by arrows, left to right), the default; `pool` lists the lanes. */
export type View = 'pool' | 'agent'
export interface LayoutOpts {
  width: number; height: number; now: number; view: View; runningOnly: boolean
  selectedId?: string; expanded: boolean; rules: readonly CompiledRule[]
  /** The request node without main's current tool, so the stages row keeps its width (the CLI panes; Details shows the tool). */
  hideMainTool?: boolean
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
interface FNode { a?: Agent; runId?: string; kids: FNode[]; chain?: FNode; edge?: string }
/** `top` are main's children (the dispatches), whether or not main itself is visible. */
interface Flow { main?: Agent; top: FNode[]; after: Map<string, Agent> }

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
  const top = group(kids.get('main') ?? [])
  // Agents no path from main reaches (a parentId cycle in a malformed file) still show, as main's children.
  const stray = group(agents.filter(a => a.id !== 'main' && !seen.has(a)).sort((x, y) => x.startedAt - y.startedAt))
  return { main: agents.find(a => a.id === 'main'), top: [...top, ...stray], after }
}

/** A node's agents in drawn order: the node, then what is chained after it, then its children (row by row, left to right). */
const agentsOf = (n: FNode): Agent[] => [...(n.a ? [n.a] : []), ...(n.chain ? agentsOf(n.chain) : []), ...n.kids.flatMap(agentsOf)]
const firstStart = (n: FNode): number => n.a?.startedAt ?? Math.min(...n.kids.map(firstStart))

/**
 * A drawn turn: one of main's turns (or the dispatches seen before any recorded turn) and what it dispatched.
 * `end` bounds it (`bounded`: its end was missed, so the next turn's start); `current` is main's newest turn;
 * `plan` is the classify text, undefined while the turn has dispatched nothing yet.
 */
interface DrawnTurn { n: number; startedAt: number; end?: number; bounded: boolean; current: boolean; nodes: FNode[]; plan?: string }
/** The flow view's stages: the latest turn drawn in full, the earlier ones newest first. `over`: main's newest turn ended. */
interface Stages { graph: Flow; mainShown: boolean; latest?: DrawnTurn; earlier: DrawnTurn[]; over: boolean }

const CLASS = /\[class:([\w-]+)\]/
const BRANCH_CELLS = 16
const EARLIER_LINES = 3

/**
 * Each dispatch (a child of main, ◆ nodes included) belongs to the turn with the latest start no later than its own.
 * Turns with a dispatch are drawn, and main's newest turn while main runs in it (still planning, maybe). Classify is the
 * planning phase, turn start to first dispatch, plus a `[class:<word>]` tag when a dispatch carries one: timing and
 * the tag only, nothing inferred. Computed from every dispatch, so runningOnly does not change it.
 */
function stages(s: Snapshot, vis: Agent[]): Stages {
  const graph = flow(vis)
  const ts: Turn[] = (Array.isArray(s.turns) ? s.turns : []).filter(t => Number.isFinite(t?.startedAt)).sort((x, y) => x.startedAt - y.startedAt)
  const turnAt = (t: number) => ts.findLastIndex(x => x.startedAt <= t)
  const ids = new Set(s.agents.map(a => a.id))
  const sent = s.agents.filter(a => a.id !== 'main' && (a.parentId === undefined || a.parentId === 'main' || a.parentId === a.id || !ids.has(a.parentId)))
    .sort((x, y) => x.startedAt - y.startedAt)
  const byTurn = new Map<number, FNode[]>()
  for (const n of graph.top) {
    const i = turnAt(firstStart(n))
    byTurn.set(i, [...(byTurn.get(i) ?? []), n])
    n.edge = n.a?.type ?? 'workflow' // the route's branch: the agent type chosen (why it was chosen is not observable)
  }
  const live = s.agents.find(a => a.id === 'main')?.status === 'running' && ts.length > 0 ? [ts.length - 1] : []
  const synthetic = Math.min(...sent.filter(a => turnAt(a.startedAt) < 0).map(a => a.startedAt), ...(byTurn.get(-1) ?? []).map(firstStart))
  const drawn = [...new Set([...byTurn.keys(), ...live])].sort((x, y) => x - y).map((i, k): DrawnTurn => {
    const nodes = byTurn.get(i) ?? []
    const startedAt = i < 0 ? synthetic : ts[i]!.startedAt
    const mine = sent.filter(a => turnAt(a.startedAt) === i)
    const first = Math.min(...mine.map(a => a.startedAt), ...nodes.map(firstStart))
    const tag = mine.map(a => CLASS.exec(a.description)?.[1]).find(x => x !== undefined)
    const time = i < 0 ? '' : ` ${fmtDuration(first - startedAt)}` // before any recorded turn its start is unknown
    const ended = i < 0 ? undefined : ts[i]!.endedAt
    // A turn whose end was missed is over by the next one's start at the latest.
    const end = ended ?? (i < 0 ? ts[0]?.startedAt : ts[i + 1]?.startedAt)
    const plan = mine.length + nodes.length === 0 ? undefined : `${tag === undefined ? 'plan' : `classify: ${tag}`}${time}`
    return { n: k + 1, startedAt, end, bounded: ended === undefined && end !== undefined, current: i === ts.length - 1, nodes, plan }
  })
  return { graph, mainShown: graph.main !== undefined, latest: drawn.at(-1), earlier: drawn.slice(0, -1).reverse(), over: ts.at(-1)?.endedAt !== undefined }
}

// An earlier turn with an agent still running is drawn in full, so that agent stays in sight and selectable.
const inFull = (t: DrawnTurn) => t.nodes.flatMap(agentsOf).some(a => a.status === 'running')
/** The flow's selectable agents in drawn order: main (the latest request node), the latest turn's, then earlier full turns'. */
const flowIds = (st: Stages): string[] =>
  [...(st.mainShown ? ['main'] : []), ...[st.latest, ...st.earlier.filter(inFull)].flatMap(t => t?.nodes ?? []).flatMap(agentsOf).map(a => a.id)]

export function selectableIds(s: Snapshot, o: LaneOpts): string[] {
  if (o.view !== 'agent') return lanes(s, o).flatMap(l => l.agents.map(a => a.id))
  return flowIds(stages(o.now === undefined ? s : asDrawn(s, o.now), visible(s, o)))
}

// A `[class:<word>]` tag (and one space after it) is instrumentation, never part of the label.
const CLASS_TAGS = /\[class:[\w-]+\] ?/g
const untag = (t: string) => {
  const u = t.replace(CLASS_TAGS, '')
  return u === t ? t : u.trim()
}
const label = (a: Agent) => untag(a.name ?? (a.id === 'main' ? 'main' : a.type === a.description ? a.type : a.description || a.type)) || a.type
// On a route branch the edge already names the type: `[T1] Explore — list files` → `[T1] list files`.
const branchLabel = (a: Agent) => {
  const l = label(a)
  const m = /^(\[T\d+\] )?([^]*)$/.exec(l)!
  const head = `${a.type} — `
  const rest = m[2]!.startsWith(head) ? m[2]!.slice(head.length) : ''
  return rest.trim() === '' ? l : `${m[1] ?? ''}${rest}`
}
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
    { text: `${GLYPH[a.status]} ${label(a)} ${dur(a, now)}`, fg: COLOR[a.status], inverse: selected, hit: `agent:${a.id}` },
    { text: tool, dim: true },
  ]
}

// Node text stays short so a flow fits across: labels and workflow names to 28 cells, tools to 14 (details keep the label whole).
const LABEL_CELLS = 28
const TOOL_CELLS = 14
const cap = (text: string, cells: number) => (cellWidth(text) <= cells ? text : `${cut(text, cells - 1)}…`)
// `mcp__<server>__<tool>` → `<tool>`
const toolName = (t: string) => t.replace(/^mcp__.*__(?=.)/, '')

/** `bare`: without the current tool (to measure a flow that holds still while tools change). */
function nodeSeg(n: FNode, o: LayoutOpts, workflows: Record<string, string>, bare = false): Seg {
  if (n.a === undefined) return { text: `[◆ ${cap(workflows[n.runId!] ?? n.runId!, LABEL_CELLS)}]`, bold: true }
  const a = n.a
  const tool = !bare && a.status === 'running' && a.currentTool ? ` · ${cap(toolName(a.currentTool), TOOL_CELLS)}` : ''
  const time = a.id === 'main' ? '' : ` ${dur(a, o.now)}`
  const text = cap(n.edge === undefined ? label(a) : branchLabel(a), LABEL_CELLS)
  return { text: `[${GLYPH[a.status]} ${text}${tool}${time}]`, fg: COLOR[a.status], inverse: a.id === o.selectedId || undefined, hit: `agent:${a.id}` }
}

const EDGE = { dim: true } as const

/**
 * The flow left to right: the stage nodes joined by `─▶`, then the route's branches (`stacked`: from two rows down, at
 * column 2, a `┌──┘` row joining them to the route); children start 4 cells after their parent, a chained agent on the parent's own row.
 */
function flowRows(lead: Seg[], branches: FNode[], o: LayoutOpts, workflows: Record<string, string>, stacked = false, bare = false): Row[] {
  const grid: { col: number; seg: Seg }[][] = []
  const put = (row: number, col: number, seg: Seg) => (grid[row] ??= []).push({ col, seg })
  // Draws `n` at (row, col); returns the rows it took.
  const draw = (n: FNode, row: number, col: number): number => {
    const seg = nodeSeg(n, o, workflows, bare)
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
  // Labelled siblings (the route's branches) carry `─ <label> ──▶`, labels padded so the arrows line up.
  const fan = (kids: FNode[], first: number, x: number, sameRow: boolean): number => {
    const labels = kids.map(k => (k.edge === undefined ? undefined : cap(k.edge, BRANCH_CELLS)))
    const lw = Math.max(0, ...labels.map(l => cellWidth(l ?? '')))
    let r = first
    kids.forEach((k, i) => {
      const last = i === kids.length - 1
      const l = labels[i]
      const tail = l === undefined ? '─▶' : `─ ${l} ${'─'.repeat(lw - cellWidth(l) + 2)}▶`
      if (sameRow && i === 0) put(r, x - 1, { text: (last ? '──' : '─┬') + tail, ...EDGE })
      else put(r, x, { text: (last ? '└' : '├') + tail, ...EDGE })
      const h = draw(k, r, x + 1 + cellWidth(tail))
      if (!last) for (let j = r + 1; j < r + h; j++) put(j, x, { text: '│', ...EDGE })
      r += h
    })
    return r
  }
  let col = 0
  lead.forEach((seg, i) => {
    if (i > 0) { put(0, col, { text: '─▶', ...EDGE }); col += 2 }
    put(0, col, seg)
    col += cellWidth(seg.text)
  })
  if (branches.length > 0) {
    if (stacked) {
      // A connector from under the route's ⑂ back to column 2, so the branches below visibly hang off the route.
      const fork = col - cellWidth(lead.at(-1)!.text) + 1
      put(1, 2, { text: `┌${'─'.repeat(Math.max(0, fork - 3))}┘`, ...EDGE })
      fan(branches, 2, 2, false)
    } else fan(branches, 0, col + 1, true)
  }
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

/**
 * The flow below COMPACT_BELOW columns: one node per line, indented, each stage the only child of the one before;
 * a branch shows its label before the agent; a chained agent is its predecessor's `┄▶` child.
 */
function flowTree(lead: Seg[], branches: FNode[], o: LayoutOpts, workflows: Record<string, string>): Row[] {
  const out: Row[] = lead.map((seg, i) => [{ text: i === 0 ? '' : `${'  '.repeat(i)}└▶ `, ...EDGE }, seg])
  const walk = (n: FNode, depth: number, conn: string) => {
    const branch = n.edge === undefined ? '' : `${cap(n.edge, BRANCH_CELLS)} ▶ `
    out.push([{ text: '  '.repeat(depth) + conn + branch, ...EDGE }, nodeSeg(n, o, workflows)])
    const subs = [...(n.chain ? [{ k: n.chain, dashed: true }] : []), ...n.kids.map(k => ({ k, dashed: false }))]
    subs.forEach(({ k, dashed }, i) => walk(k, depth + 1, dashed ? '┄▶ ' : i === subs.length - 1 ? '└▶ ' : '├▶ '))
  }
  branches.forEach((k, i) => walk(k, lead.length, i === branches.length - 1 ? '└▶ ' : '├▶ '))
  return out
}

/**
 * A turn's stage nodes. Request: on the latest turn, main: running with its tool (only on main's newest turn: main's
 * live state is never drawn on an older turn), ? when stale, ✓ once the turn is over, ◉ otherwise; ✓ on any older turn.
 * Then `[● plan <so far>]` while the turn has dispatched nothing, else classify and route. None when main is hidden
 * and no turn is drawn. `bare`: without the current tool.
 */
function stageSegs(t: DrawnTurn | undefined, latest: boolean, st: Stages, o: LayoutOpts, bare = false): Seg[] {
  if (t === undefined && !st.mainShown) return []
  const m = st.graph.main
  const main = m?.status
  const current = latest && (t === undefined || t.current)
  const live = current && main === 'running'
  const stale = current && main === 'unknown'
  const done = !live && !stale && (!latest || main === 'completed' || (t === undefined ? st.over : t.end !== undefined))
  const glyph = live ? GLYPH.running : stale ? GLYPH.unknown : done ? GLYPH.completed : '◉'
  const tool = live && !bare && !o.hideMainTool && m!.currentTool ? ` · ${cap(toolName(m!.currentTool), TOOL_CELLS)}` : ''
  const req: Seg = {
    text: `[${glyph} request${tool}]`, fg: done ? COLOR.completed : live ? COLOR.running : stale ? COLOR.unknown : main && COLOR[main],
    inverse: (latest && st.mainShown && o.selectedId === 'main') || undefined,
    hit: latest && st.mainShown ? 'agent:main' : undefined,
  }
  if (t === undefined) return [req]
  if (t.plan === undefined) return [req, { text: `[${GLYPH.running} plan ${fmtDuration(o.now - t.startedAt)}]`, fg: COLOR.running }]
  return [req, { text: `[${GLYPH.completed} ${cap(t.plan, LABEL_CELLS)}]`, fg: COLOR.completed }, { text: '[⑂ route]', bold: true }]
}

/**
 * One full turn: its stage nodes then its branches. Wide, the stages go on a row of their own and the branches fan
 * from column 2 below them when one row would not fit (measured without current tools, so it does not flip as they change).
 */
function pipeline(t: DrawnTurn | undefined, latest: boolean, st: Stages, o: LayoutOpts, workflows: Record<string, string>): Row[] {
  const branches = t?.nodes ?? []
  const lead = stageSegs(t, latest, st, o)
  if (o.width < COMPACT_BELOW) return flowTree(lead, branches, o, workflows)
  const bare = flowRows(stageSegs(t, latest, st, o, true), branches, o, workflows, false, true)
  return flowRows(lead, branches, o, workflows, bare.some(r => cellWidth(rowText(r)) > o.width))
}

/** `◉ request #<n> · <k> agents <summary> <duration>`: an earlier turn, its agents counted, not drawn; `≤` when its end was missed. */
function turnLine(t: DrawnTurn, now: number): Row {
  const ags = t.nodes.flatMap(agentsOf)
  const n = (...st: Status[]) => ags.filter(a => st.includes(a.status)).length
  const parts: [number, string][] = [[n('failed'), '✗ # failed'], [n('running'), '● # running'], [n('waiting'), '◌ # waiting'],
    [n('interrupted', 'killed'), '■ # stopped'], [n('unknown'), '? # unknown']]
  const sum = n('completed') === ags.length ? '✓' : parts.filter(([c]) => c > 0).map(([c, w]) => w.replace('#', String(c))).join(' ')
  const time = `${t.bounded ? '≤' : ''}${fmtDuration((t.end ?? now) - t.startedAt)}`
  return [{ text: `◉ request #${t.n} · ${ags.length} agent${ags.length === 1 ? '' : 's'} ${sum} ${time}`, ...EDGE }]
}

/** clip, with a trailing … when the row was cut. */
function clipMore(row: Row, width: number): Row {
  return cellWidth(rowText(row)) <= width ? clip(row, width) : [...clip(row, width - 1), { text: '…', ...EDGE }]
}

const clock = (t?: number) => (t === undefined ? '—' : new Date(t).toISOString().slice(11, 19))
const toolList = (a: Agent) => (Array.isArray(a.tools) && a.tools.length > 0 ? a.tools.join(', ') : '—')

function details(a: Agent, s: Snapshot, o: LayoutOpts, prev: Agent | undefined): Row[] {
  const pool = resolvePool(a, s.session.project, s.workflows, o.rules)
  return [
    [{ text: `id ${a.id}  label ${label(a)}  parent ${a.parentId ?? (a.id === 'main' ? '—' : 'main')}  type ${a.type}  pool ${pool.name} (${pool.source})`, dim: true }],
    [{ text: `status ${a.status}  tool ${a.currentTool ?? '—'}  start ${clock(a.startedAt)}  end ${clock(a.endedAt)}  reason ${a.endReason ?? '—'}`, dim: true }],
    [{ text: `model ${a.model ?? '—'}  tools ${toolList(a)}`, dim: true }],
    ...(prev ? [[{ text: `after ${label(prev)} (step order inferred from labels)`, dim: true }]] : []),
  ]
}

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
  const f = (k: string, v: string, fg?: Fg): Row => [{ text: k.padEnd(8), dim: true }, { text: v, fg }]
  const rows: Row[] = [
    [{ text: label(a), bold: true }],
    f('status', `${GLYPH[a.status]} ${a.status} ${dur(a, o.now)}`, COLOR[a.status]),
    f('type', a.type),
    f('pool', `${pool.name} (${pool.source})`),
    f('parent', a.parentId ?? (a.id === 'main' ? '—' : 'main')),
    f('model', a.model ?? '—'),
    f('tool', a.currentTool ?? '—'),
    f('tools', toolList(a)),
    f('start', `${clock(a.startedAt)}  end ${clock(a.endedAt)}`),
    f('reason', a.endReason ?? '—'),
    ...(prev ? [f('after', `${label(prev)} (inferred)`)] : []),
  ]
  return rows.map(r => clipMore(r, o.width))
}

/** Subagents only, folded included: the header's `N agents` and Progress's `R running · D done · F failed` (+ waiting, stopped, unknown when any). */
function counts(s: Snapshot): { total: string; parts: string[] } {
  const subs = s.agents.filter(a => a.id !== 'main')
  const n = (...st: Status[]) => subs.filter(a => st.includes(a.status)).length
  const f = s.folded
  const total = subs.length + f.completed + f.failed + f.interrupted + f.killed + f.unknown
  const parts = [`${n('running')} running`, `${n('completed') + f.completed} done`, `${n('failed') + f.failed} failed`]
  const extra: [number, string][] = [[n('waiting'), 'waiting'], [n('interrupted', 'killed') + f.interrupted + f.killed, 'stopped'], [n('unknown') + f.unknown, 'unknown']]
  for (const [c, word] of extra) if (c > 0) parts.push(`${c} ${word}`)
  return { total: `${total} agent${total === 1 ? '' : 's'}`, parts }
}

/** `Progress  tasks D/T done · R running · D done · F failed`; the tasks part only when there are tasks. */
function progress(s: Snapshot): Row {
  const tasks = s.tasks.length === 0 ? '' : `tasks ${s.tasks.filter(t => t.status === 'completed').length}/${s.tasks.length} done · `
  return [{ text: 'Progress', bold: true }, { text: `  ${tasks}${counts(s).parts.join(' · ')}`, dim: true }]
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
  header.push({ text: `   ${counts(s).total}`, dim: true })

  const body: Row[] = o.height < 8 ? [] : [[]] // a blank row under the header, when there is room for it
  const st = stages(s, visible(s, o)) // pools view too: details name an agent's inferred predecessor
  let ids: string[]
  // Progress right under the latest turn (both views: the header keeps only the agent count), earlier turns below it
  if (o.view === 'agent') {
    ids = flowIds(st)
    body.push(...pipeline(st.latest, true, st, o, s.workflows), progress(s))
    let lines = 0
    let more = 0
    for (const t of st.earlier) {
      if (inFull(t)) body.push(...pipeline(t, false, st, o, s.workflows))
      else if (lines < EARLIER_LINES) { body.push(turnLine(t, o.now)); lines++ } else more++
    }
    if (more > 0) body.push([{ text: `… ${more} earlier turn${more === 1 ? '' : 's'}`, ...EDGE }])
  } else {
    const ls = lanes(s, o)
    ids = ls.flatMap(l => l.agents.map(a => a.id))
    for (const l of ls) {
      body.push([{ text: `${l.pool.name} · ${l.pool.source}`, bold: true }])
      for (const a of l.agents) body.push(listLine(a, o.now, a.id === o.selectedId))
    }
    body.push(progress(s))
  }
  // details only for an agent on show: not one folded into an earlier turn's line, or filtered out
  const sel = o.expanded && ids.includes(o.selectedId ?? '') ? s.agents.find(a => a.id === o.selectedId) : undefined
  if (sel) body.push(...details(sel, s, o, st.graph.after.get(sel.id)))
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
