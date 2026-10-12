import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'
import { DEFAULT_STALE_WORKFLOW_MS, emptySnapshot, type Snapshot } from '../core/model.ts'
import { reduceAll, type Event } from '../core/reducer.ts'
import { DEFAULT_CONFIG, parseConfig, type ConfigJson } from '../core/pools.ts'
import type { SwimtraceConfig, SwimtraceSnapshot } from '../types'
import { listEvents, spawnEvent, toolEvents, turnEndEvent } from './events.ts'

// The $.state contract cannot import the core, so it holds copies of its types: keep them identical.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _snapshotInSync: Same<Snapshot, SwimtraceSnapshot> = true
const _configInSync: Same<ConfigJson, SwimtraceConfig> = true
void _snapshotInSync
void _configInSync

export const PANE = 'swimtrace'
const snap = atom({ plugin: 'swimtrace', key: 'snap' } as const, undefined as Snapshot | undefined)
const config = atom({ plugin: 'swimtrace', key: 'config' } as const, DEFAULT_CONFIG)

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
  if (cur === undefined || cur.session.endedAt !== undefined) {
    // first event of the session, or the first after a /clear: open a new snapshot
    const id = await $.session.id()
    if (cur === undefined || cur.session.id !== id) {
      const project = cur?.session.project ?? (await $.session.cwd())
      const fresh = emptySnapshot({ id, project, startedAt: now })
      await update($, snap, () => reduceAll(fresh, evs))
      dirty = true
      return
    }
  }
  await update($, snap, s => {
    if (s === undefined) return s
    const n = reduceAll(s, evs)
    if (n !== s) dirty = true // reduce returns the same object when nothing changed, so idle ticks write nothing
    return n
  })
}

// Fail open: bookkeeping never throws into the engine. Hooks await it (in-memory only, after next(e) settled);
// disk I/O stays on the 250 ms timer, so no hook waits on the file system (session.end's last write aside).
const safe = async (fn: () => Promise<void>): Promise<void> => {
  try { await fn() } catch { /* observational: ignore */ }
}

async function writeSnapshot($: EngineInterface, force: boolean): Promise<void> {
  const now = await $.clock.now()
  if (!dirty && !force) return
  const s = await read($, snap)
  if (s === undefined) return
  dirty = false
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
    // Timers outlive the dispatch. A reload drops them and fires session.start again in a fresh copy;
    // a second session.start in the same copy replaces them rather than doubling the writers.
    for (const t of timers) t.cancel()
    timers = [
      $.clock.every(250, () => void safe(async () => {
        const now = await $.clock.now()
        await writeSnapshot($, now - lastWrite >= 5_000)
      })),
      $.clock.every(1_000, () => void safe(async () => {
        const now = await $.clock.now()
        const cfg = await read($, config)
        const list = await $.agent.list()
        const staleWorkflowMs = cfg.staleWorkflowAgentMinutes * 60_000 || DEFAULT_STALE_WORKFLOW_MS
        await apply($, [...listEvents(list, now), { kind: 'tick', at: now, staleWorkflowMs }])
      })),
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
}
