import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'
import { DEFAULT_STALE_WORKFLOW_MS, emptySnapshot, type Snapshot } from '../core/model.ts'
import { reduceAll, type Event } from '../core/reducer.ts'
import { compileRules, DEFAULT_CONFIG, parseConfig } from '../core/pools.ts'
import { layout, selectableIds, type Row } from '../core/layout.ts'
import type { SwimtraceUi } from '../types'
import { listEvents, spawnEvent, toolEvents, turnEndEvent } from './events.ts'

// The $.state contract (../types/index.d.ts) holds copies of the core's types; test/contract-sync.ts keeps them identical.

export const PANE = 'swimtrace'
const snap = atom({ plugin: 'swimtrace', key: 'snap' } as const, undefined as Snapshot | undefined)
const config = atom({ plugin: 'swimtrace', key: 'config' } as const, DEFAULT_CONFIG)
const ui = atom({ plugin: 'swimtrace', key: 'ui' } as const, { view: 'pool', runningOnly: false, expanded: false } as SwimtraceUi)

// ponytail: module variables reset on hot reload; the next timer tick rewrites the file anyway
let dirty = true
let lastWrite = 0
let timers: Timer[] = []

export async function swimtraceDir($: EngineInterface): Promise<string> {
  const base = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
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

// Fail open: bookkeeping never throws into the engine. Hooks await it (in-memory only, after next(e) settled);
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
  return ok ? s : undefined
}

// The snapshot the pane shows: this session's, or the file `pick` names (this session's again if it is gone).
async function viewed($: EngineInterface, pick: string | undefined): Promise<Snapshot | undefined> {
  const own = await read($, snap)
  return pick === undefined ? own : ((await loadSnapshot($, pick)) ?? own)
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
    await safe(async () => { await $.command.register({ name: 'swimtrace', description: 'Show the SwimTrace swimlane pane' }) })
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
        // Durations move with no event arriving: redraw while the pane is on show, whether or not the poll above failed.
        await safe(async () => {
          if ((await $.ui.panes()).some(p => p.id === PANE && p.isShown)) $.ui.invalidate('ui.render')
        })
      })()),
    ]
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    await safe(async () => {
      if (r.agentId) await apply($, [spawnEvent(e, r.agentId, await $.clock.now())])
    })
    return r
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    await safe(async () => apply($, toolEvents(e as never, ran as never, await $.clock.now())))
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
    const opened = await $.ui.open({ id: PANE, title: 'SwimTrace' })
    const notes = [
      ...(opened.isPlaced ? [] : [`not shown yet: ${opened.reason}`]),
      ...(parsed.warnings.length > 0 ? [`config: ${parsed.warnings.join('; ')}`] : []),
    ]
    return { text: notes.length > 0 ? `SwimTrace opened (${notes.join('; ')}).` : 'SwimTrace opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const u = await read($, ui)
    const s = await viewed($, u.pick)
    if (s === undefined) return <Text dimColor>SwimTrace: no session yet.</Text>
    const { rules } = compileRules((await read($, config)).rules)
    const now = await $.clock.now()
    const room = e.props.scroll?.bodyRows ?? (e.viewport?.rows ?? 30) - 4
    const rows: Row[] = layout(s, {
      width: e.props.bodyColumns, height: Math.max(8, room - 1), now, view: u.view, runningOnly: u.runningOnly,
      selectedId: u.selectedId, expanded: u.expanded, rules,
    })

    // Handlers read the state as it stands at the press, never what this drawing captured.
    const move = async (d: 1 | -1) => {
      const cur = await viewed($, (await read($, ui)).pick)
      if (cur === undefined) return
      const { rules: live } = compileRules((await read($, config)).rules)
      await update($, ui, x => {
        const ids = selectableIds(cur, { view: x.view, runningOnly: x.runningOnly, rules: live })
        const i = ids.indexOf(x.selectedId ?? '')
        const at = i < 0 ? (d > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, i + d))
        return { ...x, selectedId: ids[at] }
      })
    }
    const cycle = async () => {
      const files = await otherSessions($, (await read($, snap))?.session.id)
      const from = (await read($, ui)).pick
      let next: string | undefined
      for (const f of files.slice(from === undefined ? 0 : files.indexOf(from) + 1)) {
        if ((await loadSnapshot($, f)) !== undefined) { next = f; break }
      }
      await update($, ui, x => (x.pick === from ? { ...x, pick: next, selectedId: undefined } : x))
    }

    return (
      <Box flexDirection="column">
        {rows.map(r => (
          <Box flexDirection="row">
            {r.length === 0 ? <Text> </Text> : r.filter(g => g.text !== '').map(g => (
              <Text color={g.fg} bold={g.bold} dimColor={g.dim} inverse={g.inverse}>{g.text}</Text>
            ))}
          </Box>
        ))}
        <Box flexDirection="row" gap={2}>
          <Button key="view" hotkey="g" plain onPress={() => update($, ui, (x): SwimtraceUi => ({ ...x, view: x.view === 'pool' ? 'agent' : 'pool' }))}>{u.view === 'pool' ? 'agents' : 'pools'}</Button>
          <Button key="running" hotkey="r" plain onPress={() => update($, ui, x => ({ ...x, runningOnly: !x.runningOnly }))}>{u.runningOnly ? 'all' : 'running'}</Button>
          <Button key="next" hotkey="j" plain onPress={() => move(1)}>next</Button>
          <Button key="prev" hotkey="k" plain onPress={() => move(-1)}>prev</Button>
          <Button key="details" hotkey="d" plain onPress={() => update($, ui, x => ({ ...x, expanded: !x.expanded }))}>details</Button>
          <Button key="session" hotkey="n" plain onPress={() => cycle()}>{u.pick === undefined ? 'this session' : 'other session'}</Button>
        </Box>
      </Box>
    )
  })
}
