import { test, expect, mock } from 'claude-code/testing'
import { VERSION } from '../core/model.ts'

const snapRef = { plugin: 'swimtrace', key: 'snap' } as const

// What an engine call site passes to agent.spawn beside the fields the test cares about.
const SPAWN = { tool_use_id: 'tu-1', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm', background: false, fork: false } as const

// The test's hooks stand for the engine: the lifecycle events need a bottom, and a call on `$` answers { value } or { deny }.
function engine(on: any) {
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
}

// The kit takes the test's hooks only before its first call on `$`: `hooks` registers the test's own bottoms first.
async function boot($: any, on: any, hooks: () => void = () => {}) {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, { HOME: '/home/t' })
  engine(on)
  const writes: Record<string, string> = {}
  const ids = { current: 'sess-1' }
  on('fs.write', ($: any, e: any) => { writes[e.path] = e.text; return { value: undefined } })
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('session.id', () => ({ value: ids.current }))
  on('agent.list', () => ({ value: [] }))
  // The test's `$` has no state noun: read $.state as the kit stores it, from beneath the plugin's writes.
  const state = { snap: undefined as any }
  on('state.set', snapRef, async ($: any, e: any, next: any) => {
    const r = await next(e)
    if (r.value?.isSet === true) state.snap = e.value
    return r
  })
  hooks()
  await $.session.start({ cwd: '/w/proj', surface: 'terminal', isInteractive: true })
  return { clock, writes, ids, getSnap: () => state.snap }
}

test('spawn → tool call → end of run is recorded; results pass through unchanged', async ($, on) => {
  const { getSnap } = await boot($, on, () => {
    on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }))
    on('tool.call', { tool: /^Grep$/ }, () => ({ result: { matches: 1 } })) // Grep is not in this build's tool table: match by pattern
  })
  const spawned = await $.agent.spawn({ ...SPAWN, prompt: 'SECRET PROMPT', description: 'look', subagentType: 'Explore' })
  expect(spawned.agentId).toBe('a1')

  const ran = await $.tool.call({ tool: 'Grep', pattern: 'SECRET INPUT', agentId: 'a1' } as never)
  expect((ran as any).result).toEqual({ matches: 1 })

  await $.turn.complete({ answer: 'SECRET ANSWER', durationMs: 5, isAborted: false, turnId: 't', agentId: 'a1', reason: 'answer' })
  const s = getSnap()
  const a = s.agents.find((x: any) => x.id === 'a1')
  expect(a.status).toBe('completed')
  expect(a.description).toBe('look')
  expect(a.model).toBe('m') // the spawn result's model
  expect(a.tools).toEqual(['Grep']) // tool names only
  expect(JSON.stringify(s)).not.toContain('SECRET')
})

test('snapshot is written under ~/.claude/swimtrace/sessions on the timer, with a heartbeat', async ($, on) => {
  const { clock, writes } = await boot($, on)
  await clock.advance(300)
  const path = '/home/t/.claude/swimtrace/sessions/sess-1.json'
  expect(writes[path]).toBeDefined()
  const first = JSON.parse(writes[path]!).writtenAt
  expect(JSON.parse(writes[path]!).by).toBe(VERSION) // the viewer compares it with its own
  await clock.advance(2_000)
  expect(JSON.parse(writes[path]!).writtenAt).toBe(first) // idle: no rewrite before the heartbeat
  await clock.advance(3_500)
  expect(JSON.parse(writes[path]!).writtenAt).toBeGreaterThan(first)
})

test('fail-open: a failing fs.write never breaks a tool call', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, { HOME: '/home/t' })
  engine(on)
  on('fs.write', () => ({ deny: 'disk full' }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('session.id', () => ({ value: 'sess-2' }))
  on('agent.list', () => ({ value: [] }))
  on('tool.call', { tool: 'Read' }, () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.advance(1_000)
  const ran = await $.tool.call({ tool: 'Read', file_path: '/x' } as never)
  expect((ran as any).result).toBe('ok')
})

test('review focus 1: /clear ends the old snapshot; the next event opens one under the new id', async ($, on) => {
  const { clock, writes, ids } = await boot($, on, () => on('tool.call', { tool: 'Read' }, () => ({ result: 'ok' })))
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  await clock.settle()
  await clock.advance(300)
  expect(JSON.parse(writes['/home/t/.claude/swimtrace/sessions/sess-1.json']!).session.endedAt).toBeDefined()
  ids.current = 'sess-new' // what $.session.id() answers after the /clear
  await $.tool.call({ tool: 'Read', file_path: '/x' } as never)
  await clock.advance(300)
  const fresh = JSON.parse(writes['/home/t/.claude/swimtrace/sessions/sess-new.json']!)
  expect(fresh.session.endedAt).toBeUndefined()
})

test('case 10: a reload keeps $.state; session.start does not reset an existing snapshot', async ($, on) => {
  const { getSnap } = await boot($, on, () => on('agent.spawn', () => ({ model: 'm', agentId: 'keep' })))
  await $.agent.spawn({ ...SPAWN, prompt: 'p', description: 'd', subagentType: 'Explore' })
  await $.session.start({ cwd: '/w/proj', surface: 'terminal', isInteractive: true }) // what a reload fires
  expect(getSnap().agents.some((a: any) => a.id === 'keep')).toBe(true)
})

test('review fix 2: two events racing at the /clear boundary both land in the new snapshot', async ($, on) => {
  let n = 0
  const { clock, ids, getSnap } = await boot($, on, () => on('agent.spawn', () => ({ model: 'm', agentId: `w${++n}` })))
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  await clock.settle()
  ids.current = 'sess-new'
  await Promise.all([
    $.agent.spawn({ ...SPAWN, prompt: 'p', description: 'one', subagentType: 'Explore' }),
    $.agent.spawn({ ...SPAWN, prompt: 'p', description: 'two', subagentType: 'Explore' }),
  ])
  const s = getSnap()
  expect(s.session.id).toBe('sess-new')
  expect(s.agents.map((a: any) => a.id).sort()).toEqual(['main', 'w1', 'w2'])
})

test('review fix 4: task fields from tool input are type-checked before they reach the snapshot', async ($, on) => {
  const { getSnap } = await boot($, on, () => on('tool.call', { tool: /^Task(Create|Update)$/ }, ($: any, e: any) =>
    e.tool === 'TaskCreate' ? { result: { task: { id: 't1', subject: 'Real subject' } } } : { result: { success: true, taskId: e.taskId, updatedFields: [] } }))
  await $.tool.call({ tool: 'TaskCreate', subject: 42, description: 'd' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: 't1', addBlockedBy: ['t0', 7, { x: 1 }] } as never)
  expect(getSnap().tasks).toEqual([{ id: 't1', subject: 'Real subject', status: 'pending', blockedBy: ['t0'] }])
})

test('final fix 1: while a tool runs, the calling agent already shows it as its current tool', async ($, on) => {
  let duringCall: string | undefined
  const { getSnap } = await boot($, on, () => {
    on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }))
    on('tool.call', { tool: /^Grep$/ }, async () => {
      // The engine's tool is running here: give the plugin's start-of-call bookkeeping a few turns to land.
      const tool = () => getSnap()?.agents.find((x: any) => x.id === 'a1')?.currentTool
      for (let i = 0; i < 1_000 && tool() !== 'Grep'; i++) await Promise.resolve()
      duringCall = tool()
      return { result: { matches: 2 } }
    })
  })
  await $.agent.spawn({ ...SPAWN, prompt: 'p', description: 'look', subagentType: 'Explore' })
  const ran = await $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'a1' } as never)
  expect(duringCall).toBe('Grep')
  expect((ran as any).result).toEqual({ matches: 2 })
})

test('stages: main\'s turns are recorded as timestamps only', async ($, on) => {
  const { clock, getSnap } = await boot($, on)
  await $.turn.start({ text: 'SECRET PROMPT', turnId: 't1' })
  await clock.advance(2_000)
  await $.turn.complete({ answer: 'SECRET ANSWER', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await $.turn.start({ text: 'again', turnId: 't2' })
  const s = getSnap()
  expect(s.turns.length).toBe(2)
  expect(s.turns[0].endedAt - s.turns[0].startedAt).toBe(2_000)
  expect(s.turns[1].endedAt).toBeUndefined()
  expect(JSON.stringify(s)).not.toContain('SECRET')
})
