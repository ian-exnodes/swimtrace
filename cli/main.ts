#!/usr/bin/env node
import { readFileSync, realpathSync, watch, rmSync, type FSWatcher } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emitKeypressEvents } from 'node:readline'
import { compileRules, parseConfig } from '../mod/core/pools.ts'
import { fmtDuration, layout, selectableIds, type Row, type View } from '../mod/core/layout.ts'
import { listSessions, pickSession, pruneOld, swimtraceDir, type SessionEntry } from './snapshots.ts'
import { ALT_OFF, ALT_ON, HIDE_CURSOR, SHOW_CURSOR, diffFrame, toAnsi } from './term.ts'

const HELP = `swimtrace — swimlanes for Claude Code subagents

  swimtrace            follow the newest live session of this directory
  swimtrace --all      start at the list of all sessions
  swimtrace sim <fanout|failure|workflow|multi-session|crash> [--speed N]
  swimtrace clean      delete ~/.claude/swimtrace (snapshots, sim data, config)

keys: ↑/↓ select · Enter details · g pools/agents · r running only · +/- zoom · l session list · Tab next session · q quit`

export function sessionListRows(entries: SessionEntry[], selected: number, width: number): Row[] {
  const rows: Row[] = [[{ text: 'SWIMTRACE — sessions', bold: true }]]
  entries.forEach((e, i) => {
    const s = e.snap
    const state = s.session.endedAt !== undefined ? 'ended' : e.stale ? 'stale' : 'live'
    const running = s.agents.filter(a => a.status === 'running' && a.id !== 'main').length
    const text = `  ${s.session.project}  ${s.session.id.slice(0, 8)}  ${state}  running ${running}  age ${fmtDuration(Date.now() - s.session.startedAt)}`
    rows.push([{ text: text.slice(0, width), inverse: i === selected, fg: state === 'live' ? 'cyan' : 'gray' }])
  })
  if (entries.length === 0) rows.push([{ text: '  No sessions yet. Is the swimtrace mod installed?', dim: true }])
  return rows
}

/** Wrap a callback so a throw is reported once to onError instead of escaping as uncaught. */
export function guard<A extends unknown[]>(fn: (...a: A) => void, onError: (e: unknown) => void): (...a: A) => void {
  return (...a: A) => { try { fn(...a) } catch (e) { onError(e) } }
}

export function canClean(root: string): boolean {
  return isAbsolute(root) && basename(root) === 'swimtrace'
}

export async function viewer(dir: string, startInList: boolean): Promise<number> {
  const out = process.stdout
  const cache = new Map()
  const cfgText = (() => { try { return readFileSync(join(swimtraceDir(), 'config.json'), 'utf8') } catch { return undefined } })()
  const parsed = parseConfig(cfgText)
  const { rules, warnings } = compileRules(parsed.config.rules)
  let entries: SessionEntry[] = []
  let current: string | undefined
  let listMode = startInList
  let listSel = 0
  let view: View = 'pool'
  let runningOnly = false
  let expanded = false
  let selectedId: string | undefined
  let zoomMs: number | undefined
  let prev: string[] = []
  const notes = [...parsed.warnings, ...warnings]

  const refresh = () => {
    entries = listSessions(dir, Date.now(), cache)
    if (current === undefined || !entries.some(e => e.path === current)) current = pickSession(entries, process.cwd())?.path
  }
  const draw = () => {
    const width = out.columns || 80
    const height = out.rows || 24
    const cur = entries.find(e => e.path === current)
    let rows: Row[]
    if (listMode || cur === undefined) rows = sessionListRows(entries, listSel, width)
    else rows = layout(cur.snap, { width, height, now: Date.now(), view, runningOnly, selectedId, expanded, zoomMs, rules })
    if (notes.length) rows = [...rows.slice(0, height - 1), [{ text: `config: ${notes[0]}`.slice(0, width), fg: 'yellow' }]]
    const next = rows.slice(0, height).map(toAnsi)
    out.write(diffFrame(prev, next))
    prev = next
  }
  const redrawAll = () => { prev = []; out.write('\x1b[2J'); draw() }

  let watcher: FSWatcher | undefined
  let poll: NodeJS.Timeout | undefined
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    if (poll) clearInterval(poll)
    try { watcher?.close() } catch { /* already closed */ }
    try { process.stdin.setRawMode?.(false); process.stdin.pause() } catch { /* stdin gone */ }
    out.write(SHOW_CURSOR + ALT_OFF)
  }

  return await new Promise<number>(resolve => {
    const quit = () => { restore(); resolve(0) }
    const fail = (e: unknown) => { restore(); console.error(e); resolve(1) }
    const tick = guard(() => { refresh(); draw() }, fail)
    out.write(ALT_ON + HIDE_CURSOR)
    guard(() => { refresh(); redrawAll() }, fail)()
    if (restored) return
    try { watcher = watch(dir, tick) } catch { /* dir may not exist yet; the poll covers it */ }
    poll = setInterval(tick, 1000)
    out.on('resize', guard(redrawAll, fail))
    process.on('SIGINT', quit)
    process.on('SIGTERM', quit)
    emitKeypressEvents(process.stdin)
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    process.stdin.on('keypress', guard((_str: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      const cur = entries.find(e => e.path === current)
      const ids = cur ? selectableIds(cur.snap, { view, runningOnly, rules }) : []
      const moveSel = (d: number) => {
        if (listMode) listSel = Math.max(0, Math.min(entries.length - 1, listSel + d))
        else { const i = ids.indexOf(selectedId ?? ''); selectedId = ids[Math.max(0, Math.min(ids.length - 1, i + d))] }
      }
      switch (key.ctrl && key.name === 'c' ? 'q' : key.name ?? key.sequence) {
        case 'q': return quit()
        case 'up': moveSel(-1); break
        case 'down': moveSel(1); break
        case 'return':
          if (listMode && entries[listSel]) { current = entries[listSel]!.path; listMode = false; selectedId = undefined }
          else expanded = !expanded
          break
        case 'g': view = view === 'pool' ? 'agent' : 'pool'; break
        case 'r': runningOnly = !runningOnly; break
        case 'l': listMode = !listMode; break
        case 'tab': {
          const i = entries.findIndex(e => e.path === current)
          current = entries[(i + 1) % Math.max(1, entries.length)]?.path; selectedId = undefined
          break
        }
        case '+': case '=': zoomMs = Math.max(10_000, Math.floor((zoomMs ?? 600_000) / 2)); break
        case '-': zoomMs = zoomMs === undefined ? undefined : zoomMs * 2 > 86_400_000 ? undefined : zoomMs * 2; break
        default: return
      }
      draw()
    }, fail))
  })
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv
  const root = swimtraceDir()
  if (cmd === '--help' || cmd === '-h') { console.log(HELP); return 0 }
  if (cmd === 'clean') {
    if (!canClean(root)) { console.error(`refusing to delete "${root}": not an absolute path ending in swimtrace`); return 1 }
    rmSync(root, { recursive: true, force: true }); console.log(`removed ${root}`); return 0 }
  if (cmd === 'sim') {
    const speedAt = argv.indexOf('--speed')
    const speed = speedAt > 0 ? Number(argv[speedAt + 1]) : 1
    if (!Number.isFinite(speed) || speed <= 0) { console.error('--speed must be a number greater than 0'); return 1 }
    const { runSim } = await import('./sim.ts')
    return runSim(arg ?? 'fanout', join(root, 'sim'), speed, d => viewer(d, false))
  }
  if (!process.stdout.isTTY) { console.error('swimtrace needs a terminal (TTY).'); return 1 }
  pruneOld(join(root, 'sessions'), Date.now())
  return viewer(join(root, 'sessions'), cmd === '--all')
}

function isEntry(): boolean {
  try { return realpathSync(process.argv[1]!) === fileURLToPath(import.meta.url) } catch { return false }
}

// argv[1] is the npm bin symlink after a global install; compare real paths
if (isEntry()) {
  main(process.argv.slice(2)).then(code => process.exit(code), err => { process.stdout.write(SHOW_CURSOR + ALT_OFF); console.error(err); process.exit(1) })
}
