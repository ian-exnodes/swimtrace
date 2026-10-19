import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ThemeKey, Timer } from 'claude-code'
import { DEFAULT_STALE_WORKFLOW_MS, emptySnapshot, type Snapshot } from '../core/model.ts'
import { reduceAll, type Event } from '../core/reducer.ts'
import { compileRules, DEFAULT_CONFIG, parseConfig } from '../core/pools.ts'
import { cellWidth, layout, safeRows, selectableIds, wantSafe, type Fg, type Row } from '../core/layout.ts'
import type { SwimtraceUi } from '../types'
import { listEvents, spawnEvent, toolCallEvent, toolResultEvents, turnEndEvent } from './events.ts'

// The $.state contract (../types/index.d.ts) holds copies of the core's types; test/contract-sync.ts keeps them identical.

// The band uses Claude Code's theme colors so it stays readable on light and dark themes; the CLI keeps ANSI.
const THEME: Record<Fg, ThemeKey> = { green: 'success', red: 'error', yellow: 'warning', cyan: 'suggestion', magenta: 'merged', gray: 'inactive' }
const snap = atom({ plugin: 'swimtrace', key: 'snap' } as const, undefined as Snapshot | undefined)
const config = atom({ plugin: 'swimtrace', key: 'config' } as const, DEFAULT_CONFIG)
const ui = atom({ plugin: 'swimtrace', key: 'ui' } as const, { view: 'agent', runningOnly: false, expanded: false } as SwimtraceUi)

// ponytail: module variables reset on hot reload; the next timer tick rewrites the file anyway
let dirty = true
let lastWrite = 0
let timers: Timer[] = []

export async function swimtraceDir($: EngineInterface): Promise<string> {
  const base = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''}/.claude`
  return `${base}/swimtrace`
}

async function apply($: EngineInterface, evs: Event[]): Promise<void> {
  if (evs.length === 0) return
  const now = await $.clock.now()
  const cur = await read($, snap)
  // A fresh snapshot is due only with none yet, or the first event after a /clear (the current one ended and the
  // session id moved on). The id is read up front; the decision itself is made inside update, from the value
  // standing at write time, so two applies racing at the /clear boundary never both start from empty.
  const mayOpen = cur === undefined || cur.session.endedAt !== undefined
  const id = mayOpen ? await $.session.id() : undefined
  const project = mayOpen ? (cur?.session.project ?? (await $.session.cwd())) : undefined
  await update($, snap, s => {
    const open = id !== undefined && (s === undefined || (s.session.endedAt !== undefined && s.session.id !== id))
    const base = open ? emptySnapshot({ id, project: s?.session.project ?? project ?? '', startedAt: now }) : s
    if (base === undefined) return s
    const n = reduceAll(base, evs)
    if (open || n !== s) dirty = true // reduce returns the same object when nothing changed, so idle ticks write nothing
    return n
  })
}

// Fail open: bookkeeping never throws into the engine. Hooks await it (in-memory only; after next(e) settled, but
// for tool.call's start, which runs beside next(e) and is awaited once next(e) settled);
// disk I/O stays on the 250 ms timer, so no hook waits on the file system (session.end's last write aside).
const safe = async (fn: () => Promise<void>): Promise<void> => {
  try { await fn() } catch { /* observational: ignore */ }
}

// Other sessions' snapshot files, newest first; this session's own is drawn from $.state instead.
async function otherSessions($: EngineInterface, ownId: string | undefined): Promise<string[]> {
  const dir = `${await swimtraceDir($)}/sessions`
  const entries = await $.fs.list(dir).catch(() => [])
  return entries
    .filter(x => x.kind === 'file' && x.name.endsWith('.json') && x.name !== `${ownId}.json`)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(x => `${dir}/${x.name}`)
}

// A snapshot file another session wrote, or undefined when it is missing or does not read as one.
async function loadSnapshot($: EngineInterface, path: string): Promise<Snapshot | undefined> {
  const s = await $.fs.read(path).then(t => JSON.parse(t as string) as Snapshot, () => undefined)
  const ok = s?.v === 1 && typeof s.session?.id === 'string' && Array.isArray(s.agents) && Array.isArray(s.tasks) && typeof s.folded === 'object'
  if (!ok) return undefined
  return Array.isArray(s.turns) ? s : { ...s, turns: [] } // files written before turns existed have none
}

// The band takes the space above the prompt only once a session has subagents to show (main alone is not worth a band).
const hasAgents = (s: Snapshot | undefined): boolean =>
  s !== undefined && (s.agents.some(a => a.id !== 'main') || Object.values(s.folded).some(n => n > 0))

// This session's snapshot as of now. writtenAt is stamped only into the file, never into $.state, and this process is
// the writer, so its own session is never stale: without the stamp it would be drawn stale 15 s after it started.
async function ownNow($: EngineInterface): Promise<Snapshot | undefined> {
  const own = await read($, snap)
  return own === undefined ? undefined : { ...own, writtenAt: await $.clock.now() }
}

// The snapshot the band's handlers act on: this session's, or the file `pick` names (this session's again if it is gone).
async function viewed($: EngineInterface, pick: string | undefined): Promise<Snapshot | undefined> {
  return (pick === undefined ? undefined : await loadSnapshot($, pick)) ?? (await ownNow($))
}

// selectableIds over a snapshot from another session's file, which may hold malformed entries: this session's instead.
async function idsOf($: EngineInterface, s: Snapshot, o: Parameters<typeof selectableIds>[1]): Promise<string[]> {
  try { return selectableIds(s, o) } catch {
    const own = await ownNow($)
    return own === undefined || own.session.id === s.session.id ? [] : selectableIds(own, o)
  }
}

// One line of text for the band, as layout's own rows are: control characters blanked, clipped to `width` cells.
function fit(text: string, width: number): string {
  let out = ''
  for (const ch of text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')) {
    if (cellWidth(out + ch) > width) break
    out += ch
  }
  return out
}

async function writeSnapshot($: EngineInterface, force: boolean): Promise<void> {
  const now = await $.clock.now()
  if (!dirty && !force) return
  dirty = false // before the read: an apply landing during it marks the snapshot dirty again
  const s = await read($, snap)
  if (s === undefined) return
  lastWrite = now
  await $.fs.write(`${await swimtraceDir($)}/sessions/${s.session.id}.json`, JSON.stringify({ ...s, writtenAt: now }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await safe(async () => {
      const dir = await swimtraceDir($)
      const text = await $.fs.read(`${dir}/config.json`).then(t => (typeof t === 'string' ? t : undefined), () => undefined)
      await update($, config, () => parseConfig(text).config)
      if ((await read($, snap)) === undefined) {
        const now = await $.clock.now()
        const id = await $.session.id()
        await update($, snap, cur => cur ?? emptySnapshot({ id, project: e.cwd, startedAt: now }))
        dirty = true
      }
    })
    await safe(async () => { await $.command.register({ name: 'swimtrace', description: 'Show or hide the SwimTrace agent flow above the prompt' }) })
    // Timers outlive the dispatch. A reload drops them and fires session.start again in a fresh copy;
    // a second session.start in the same copy replaces them rather than doubling the writers.
    for (const t of timers) t.cancel()
    timers = [
      $.clock.every(250, () => void safe(async () => {
        const now = await $.clock.now()
        await writeSnapshot($, now - lastWrite >= 5_000)
      })),
      $.clock.every(1_000, () => void (async () => {
        await safe(async () => {
          const now = await $.clock.now()
          const cfg = await read($, config)
          const list = await $.agent.list()
          const staleWorkflowMs = cfg.staleWorkflowAgentMinutes * 60_000 || DEFAULT_STALE_WORKFLOW_MS
          await apply($, [...listEvents(list, now), { kind: 'tick', at: now, staleWorkflowMs }])
        })
        // Durations move with no event arriving: redraw while the band is on show, whether or not the poll above failed.
        await safe(async () => {
          const u = await read($, ui)
          if (!u.hidden && (u.pick !== undefined || hasAgents(await read($, snap)))) $.ui.invalidate('ui.render')
        })
      })()),
    ]
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    await safe(async () => {
      if (r.agentId) await apply($, [spawnEvent(e, r.agentId, await $.clock.now(), r.model)])
    })
    return r
  })

  on('tool.call', async ($, e, next) => {
    // The tool's name is recorded as it starts (not awaited before next, so the call is never held up);
    // what its result adds is recorded once it settled, after the name.
    const pre = safe(async () => apply($, [toolCallEvent(e as never, await $.clock.now())]))
    const ran = await next(e)
    await pre
    await safe(async () => apply($, toolResultEvents(e as never, ran as never)))
    return ran
  })

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    await safe(async () => apply($, [{ kind: 'mainTurn', at: await $.clock.now(), phase: 'start' }]))
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    await safe(async () => apply($, [turnEndEvent(e, await $.clock.now())]))
    return r
  })

  on('session.end', async ($, e, next) => {
    const r = await next(e)
    await safe(async () => {
      await apply($, [{ kind: 'sessionEnd', at: await $.clock.now(), reason: e.reason }])
      await writeSnapshot($, true) // the process may exit after this hook: the one write outside the timer
    })
    return r
  })

  on('command.run', { command: 'swimtrace' }, async $ => {
    const text = await $.fs.read(`${await swimtraceDir($)}/config.json`).then(t => (typeof t === 'string' ? t : undefined), () => undefined)
    const parsed = parseConfig(text)
    await update($, config, () => parsed.config)
    // A toggle; showing again starts at this session.
    const shown = !(await read($, ui)).hidden
    await update($, ui, x => (shown ? { ...x, hidden: true } : { ...x, hidden: false, pick: undefined, selectedId: undefined }))
    const notes = [
      ...(!shown && !hasAgents(await read($, snap)) ? ['it appears once agents run'] : []),
      ...(parsed.warnings.length > 0 ? [`config: ${parsed.warnings.join('; ')}`] : []),
    ]
    const head = shown ? 'SwimTrace hidden.' : 'SwimTrace shown above the prompt'
    return { text: shown ? head : notes.length > 0 ? `${head} (${notes.join('; ')}).` : `${head}.` }
  })

  // The flow draws in the band above the prompt, inside the session's own view; it passes when there is nothing to show.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // Fail open: this hook draws the session's own input area, so any throw below hands the band back to the engine.
    let tree: Awaited<ReturnType<typeof band>>
    try { tree = await band() } catch { tree = undefined }
    return tree ?? next(e)

    async function band() {
      const u = await read($, ui)
      if (u.hidden) return undefined
      const own = await ownNow($)
      if (u.pick === undefined && !hasAgents(own)) return undefined
      const { Box, Text, Button } = $.ui.resolve(e)
      const picked = u.pick === undefined ? undefined : await loadSnapshot($, u.pick)
      const { rules } = compileRules((await read($, config)).rules)
      const now = await $.clock.now()
      // Outside fullscreen maxRows is the whole terminal: hold the band to half of it, as fullscreen's slot already is.
      const room = Math.min(e.props.maxRows, Math.floor((e.viewport?.rows ?? 40) / 2))
      // The buttons draw first, so their hotkeys stay armed however the band scrolls; they wrap to two rows below
      // about 80 columns. ponytail: estimated from the labels' width, measure them if the labels change much.
      const buttonRows = e.props.bodyColumns < 80 ? 2 : 1
      const opts = (height: number) => ({
        width: e.props.bodyColumns, height, now, view: u.view, runningOnly: u.runningOnly,
        selectedId: u.selectedId, expanded: u.expanded, rules,
      })
      // A file another session wrote may be malformed past loadSnapshot's shape check; a throw would hand the whole band
      // back to the engine, so a bad file draws this session's snapshot under a note instead.
      let rows: Row[] | undefined
      let note: Row | undefined
      if (picked !== undefined) {
        try { rows = layout(picked, opts(Math.max(4, room - buttonRows))) } catch { rows = undefined }
      }
      if (rows === undefined) {
        if (u.pick !== undefined) note = [{ text: fit(`swimtrace: other session unreadable (${u.pick.split(/[\\/]/).at(-1) ?? u.pick})`, e.props.bodyColumns), dim: true }]
        if (own === undefined) return <Text dimColor>SwimTrace: no session yet.</Text>
        rows = layout(own, opts(Math.max(4, room - buttonRows - (note ? 1 : 0))))
      }
      if (note) rows = [note, ...rows]
      if (wantSafe(await $.env.get('SWIMTRACE_SYMBOLS'), await $.env.get('OS'))) rows = safeRows(rows)

      // Handlers read the state as it stands at the press, never what this drawing captured.
      const move = async (d: 1 | -1) => {
        const at = await read($, ui)
        const cur = await viewed($, at.pick)
        if (cur === undefined) return
        const { rules: live } = compileRules((await read($, config)).rules)
        const ids = await idsOf($, cur, { view: at.view, runningOnly: at.runningOnly, rules: live, now: await $.clock.now() })
        await update($, ui, x => {
          if (x.view !== at.view || x.runningOnly !== at.runningOnly || x.pick !== at.pick) return x // the list changed since the press
          const i = ids.indexOf(x.selectedId ?? '')
          const to = i < 0 ? (d > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, i + d))
          return { ...x, selectedId: ids[to] }
        })
      }
      const cycle = async () => {
        const files = await otherSessions($, (await read($, snap))?.session.id)
        const from = (await read($, ui)).pick
        let to: string | undefined
        for (const f of files.slice(from === undefined ? 0 : files.indexOf(from) + 1)) {
          if ((await loadSnapshot($, f)) !== undefined) { to = f; break }
        }
        await update($, ui, x => (x.pick === from ? { ...x, pick: to, selectedId: undefined } : x))
      }

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Button key="view" hotkey="g" plain onPress={() => update($, ui, (x): SwimtraceUi => ({ ...x, view: x.view === 'agent' ? 'pool' : 'agent' }))}>{u.view === 'agent' ? 'pools' : 'flow'}</Button>
            <Button key="running" hotkey="r" plain onPress={() => update($, ui, x => ({ ...x, runningOnly: !x.runningOnly }))}>{u.runningOnly ? 'all' : 'running'}</Button>
            <Button key="next" hotkey="j" plain onPress={() => move(1)}>next</Button>
            <Button key="prev" hotkey="k" plain onPress={() => move(-1)}>prev</Button>
            <Button key="details" hotkey="d" plain onPress={() => update($, ui, x => ({ ...x, expanded: !x.expanded }))}>details</Button>
            <Button key="session" hotkey="n" plain onPress={() => cycle()}>{u.pick === undefined ? 'this session' : 'other session'}</Button>
          </Box>
          {rows.map(r => (
            <Box flexDirection="row">
              {r.length === 0 ? <Text> </Text> : r.filter(g => g.text !== '').map(g => (
                <Text color={g.fg === undefined ? undefined : THEME[g.fg]} bold={g.bold} dimColor={g.dim} inverse={g.inverse}>{g.text}</Text>
              ))}
            </Box>
          ))}
        </Box>
      )
    }
  })
}
