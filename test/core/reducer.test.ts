import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptySnapshot, MAX_FINISHED, MAX_TOOLS, MAX_TURNS, type Snapshot } from '../../mod/core/model.ts'
import { reduce, reduceAll } from '../../mod/core/reducer.ts'

const S = () => emptySnapshot({ id: 's1', project: '/p', startedAt: 0 })
const spawn = (id: string, at: number, extra: object = {}) =>
  ({ kind: 'spawn', at, id, type: 'Explore', description: `do ${id}`, ...extra })
const agent = (s: ReturnType<typeof S>, id: string) => s.agents.find(a => a.id === id)

test('case 1: single agent runs then completes', () => {
  const s = reduceAll(S(), [spawn('a1', 10), { kind: 'runEnd', at: 50, agentId: 'a1', reason: 'answer' }])
  const a = agent(s, 'a1')!
  assert.equal(a.status, 'completed')
  assert.equal(a.startedAt, 10)
  assert.equal(a.endedAt, 50)
  assert.equal(a.endReason, 'answer')
})

test('case 2: concurrent agents are all running', () => {
  const s = reduceAll(S(), [spawn('a1', 10), spawn('a2', 11), spawn('a3', 12, { parentId: 'a1' })])
  assert.deepEqual(s.agents.filter(a => a.status === 'running').map(a => a.id), ['a1', 'a2', 'a3'])
  assert.equal(agent(s, 'a3')!.parentId, 'a1')
})

test('case 4: error and refusal fail, aborted interrupts, killed via list', () => {
  const s = reduceAll(S(), [
    spawn('e', 1), spawn('r', 1), spawn('x', 1), spawn('k', 1),
    { kind: 'runEnd', at: 5, agentId: 'e', reason: 'error' },
    { kind: 'runEnd', at: 5, agentId: 'r', reason: 'refusal' },
    { kind: 'runEnd', at: 5, agentId: 'x', reason: 'aborted' },
    { kind: 'listStatus', at: 6, agentId: 'k', status: 'killed', type: 'Explore', description: 'do k' },
  ])
  assert.equal(agent(s, 'e')!.status, 'failed')
  assert.equal(agent(s, 'r')!.status, 'failed')
  assert.equal(agent(s, 'x')!.status, 'interrupted')
  assert.equal(agent(s, 'k')!.status, 'killed')
  assert.equal(agent(s, 'k')!.endedAt, 6)
})

test('a finished agent stays finished whatever the list says later', () => {
  const s = reduceAll(S(), [spawn('a', 1), { kind: 'runEnd', at: 2, agentId: 'a', reason: 'answer' },
    { kind: 'listStatus', at: 3, agentId: 'a', status: 'running', type: 'Explore', description: 'do a' }])
  assert.equal(agent(s, 'a')!.status, 'completed')
})

test('list status maps waiting/idle to waiting and completes an agent whose end was missed', () => {
  const s = reduceAll(S(), [spawn('w', 1), spawn('c', 1),
    { kind: 'listStatus', at: 2, agentId: 'w', status: 'idle', type: 'Explore', description: 'do w' },
    { kind: 'listStatus', at: 2, agentId: 'c', status: 'completed', type: 'Explore', description: 'do c' }])
  assert.equal(agent(s, 'w')!.status, 'waiting')
  assert.equal(agent(s, 'c')!.status, 'completed')
  assert.equal(agent(s, 'c')!.endReason, undefined) // the reason was not observed
})

test('review focus 2: an agent first seen in the list appears with its metadata', () => {
  const s = reduce(S(), { kind: 'listStatus', at: 7, agentId: 'late', status: 'running', type: 'Plan', description: 'plan it', parentId: 'p0', name: 'planner' })
  const a = agent(s, 'late')!
  assert.equal(a.status, 'running')
  assert.equal(a.type, 'Plan')
  assert.equal(a.parentId, 'p0')
  assert.equal(a.startedAt, 7)
})

test('tool calls set current tool by name and refresh lastSeenAt; unknown ids are ignored', () => {
  const s = reduceAll(S(), [spawn('a', 1), { kind: 'toolCall', at: 9, agentId: 'a', tool: 'Grep' },
    { kind: 'toolCall', at: 9, agentId: 'ghost', tool: 'Read' }])
  assert.equal(agent(s, 'a')!.currentTool, 'Grep')
  assert.equal(agent(s, 'a')!.lastSeenAt, 9)
  assert.equal(agent(s, 'ghost'), undefined)
})

test('flow: the spawn result\'s model is stored; tools are distinct names in first-use order, capped', () => {
  let s = reduceAll(S(), [spawn('a', 1, { model: 'claude-sonnet-4-5' }), spawn('b', 1)])
  assert.equal(agent(s, 'a')!.model, 'claude-sonnet-4-5')
  assert.equal(agent(s, 'b')!.model, undefined)
  for (const t of ['Grep', 'Read', 'Grep', 'Bash']) s = reduce(s, { kind: 'toolCall', at: 2, agentId: 'a', tool: t })
  assert.deepEqual(agent(s, 'a')!.tools, ['Grep', 'Read', 'Bash'])
  assert.equal(agent(s, 'a')!.currentTool, 'Bash')
  for (let i = 0; i < MAX_TOOLS + 5; i++) s = reduce(s, { kind: 'toolCall', at: 3, agentId: 'b', tool: `T${i}` })
  assert.equal(agent(s, 'b')!.tools!.length, MAX_TOOLS)
  assert.equal(agent(s, 'b')!.tools!.at(-1), `T${MAX_TOOLS - 1}`)
  assert.equal(agent(s, 'b')!.currentTool, `T${MAX_TOOLS + 4}`) // the current tool still moves past the cap
})

test('flow: a stale-unknown workflow agent that revives records its tool', () => {
  const stale = reduceAll(S(), [spawn('w', 0, { workflowRunId: 'wf_1' }), { kind: 'tick', at: 700_000, staleWorkflowMs: 600_000 }])
  assert.deepEqual(agent(reduce(stale, { kind: 'toolCall', at: 710_000, agentId: 'w', tool: 'Read' }), 'w')!.tools, ['Read'])
})

test('flow: a spawn with a model that is not a string is rejected', () => {
  const s0 = S()
  for (const model of [42, null, {}, ['m']]) assert.equal(reduce(s0, spawn('a', 1, { model })), s0)
})

test('runEnd for an unknown id is ignored (engine forks)', () => {
  const s = reduce(S(), { kind: 'runEnd', at: 3, agentId: 'fork-1', reason: 'answer' })
  assert.equal(s.agents.length, 1)
})

test('main is running during a turn and waiting between turns', () => {
  let s = reduce(S(), { kind: 'mainTurn', at: 1, phase: 'start' })
  assert.equal(agent(s, 'main')!.status, 'running')
  s = reduce(s, { kind: 'mainTurn', at: 2, phase: 'end' })
  assert.equal(agent(s, 'main')!.status, 'waiting')
  assert.equal(agent(s, 'main')!.endedAt, undefined)
})

test('case 7: session end marks live agents unknown and main completed', () => {
  const s = reduceAll(S(), [spawn('a', 1), { kind: 'sessionEnd', at: 20, reason: 'other' }])
  assert.equal(s.session.endedAt, 20)
  assert.equal(agent(s, 'a')!.status, 'unknown')
  assert.equal(agent(s, 'a')!.endReason, 'session-end')
  assert.equal(agent(s, 'main')!.status, 'completed')
})

test('tick turns a silent workflow agent unknown, never completed', () => {
  const s = reduceAll(S(), [spawn('w', 0, { workflowRunId: 'wf_1' }), spawn('n', 0),
    { kind: 'tick', at: 700_000, staleWorkflowMs: 600_000 }])
  assert.equal(agent(s, 'w')!.status, 'unknown')
  assert.equal(agent(s, 'w')!.endReason, 'stale')
  assert.equal(agent(s, 'w')!.endedAt, 0)
  assert.equal(agent(s, 'n')!.status, 'running') // non-workflow agents are healed by the list, not by tick
})

test('events that change nothing return the same snapshot object (no idle writes)', () => {
  const s = reduceAll(S(), [spawn('a', 1), spawn('w', 1, { workflowRunId: 'wf' }), { kind: 'listStatus', at: 2, agentId: 'a', status: 'running', type: 'Explore', description: 'do a' }])
  assert.equal(reduce(s, { kind: 'tick', at: 3, staleWorkflowMs: 600_000 }), s)
  assert.equal(reduce(s, { kind: 'listStatus', at: 4, agentId: 'a', status: 'running', type: 'Explore', description: 'do a' }), s)
  assert.equal(reduce(s, { kind: 'mainTurn', at: 5, phase: 'end' }), s) // main already waiting
  const done = reduce(s, { kind: 'runEnd', at: 6, agentId: 'a', reason: 'answer' })
  assert.equal(reduce(done, { kind: 'listStatus', at: 7, agentId: 'a', status: 'completed', type: 'Explore', description: 'do a' }), done)
})

test('reduce does not mutate its input', () => {
  const s0 = S()
  const before = JSON.stringify(s0)
  reduce(s0, spawn('a', 1))
  assert.equal(JSON.stringify(s0), before)
})

test('a finished agent ignores late tool calls (identity preserved, no current tool)', () => {
  const ended = reduceAll(S(), [spawn('a', 1), { kind: 'runEnd', at: 2, agentId: 'a', reason: 'answer' }])
  const after = reduce(ended, { kind: 'toolCall', at: 3, agentId: 'a', tool: 'Grep' })
  assert.equal(after, ended)
  assert.equal(agent(after, 'a')!.currentTool, undefined)
})

test('isEvent rejects unknown kinds and out-of-range enum values', () => {
  const s = S()
  const bad: unknown[] = [
    { kind: 'constructor' },
    { kind: 'runEnd', at: 1, agentId: 'a', reason: 'constructor' },
    { kind: 'mainTurn', at: 1, phase: 'middle' },
    { kind: 'listStatus', at: 1, agentId: 'x', status: 'bogus', type: 'T', description: 'd' },
  ]
  for (const ev of bad) assert.equal(reduce(s, ev), s)
})

test('tasks: create, update status, add blockers, delete', () => {
  let s = reduceAll(S(), [
    { kind: 'taskCreate', id: '1', subject: 'Plan' },
    { kind: 'taskCreate', id: '2', subject: 'Build' },
    { kind: 'taskUpdate', id: '2', status: 'in_progress', addBlockedBy: ['1'] },
    { kind: 'taskUpdate', id: '2', addBlockedBy: ['1', '3'] },
  ])
  assert.deepEqual(s.tasks.find(t => t.id === '2'), { id: '2', subject: 'Build', status: 'in_progress', blockedBy: ['1', '3'] })
  s = reduce(s, { kind: 'taskUpdate', id: '1', status: 'deleted' })
  assert.deepEqual(s.tasks.map(t => t.id), ['2'])
})

test('taskUpdate for an unseen task creates it', () => {
  const s = reduce(S(), { kind: 'taskUpdate', id: '9', status: 'completed' })
  assert.deepEqual(s.tasks, [{ id: '9', subject: '9', status: 'completed', blockedBy: [] }])
})

test('workflow names are recorded by run id', () => {
  const s = reduce(S(), { kind: 'workflowName', runId: 'wf_1', name: 'review-changes' })
  assert.equal(s.workflows.wf_1, 'review-changes')
})

test('case 8: malformed events are dropped, duplicates ignored', () => {
  const s0 = reduce(S(), spawn('a', 1))
  for (const bad of [null, 42, 'x', {}, { kind: 'nope' }, { kind: 'spawn', id: 'b' }, { kind: 'runEnd', at: NaN, agentId: 'a', reason: 'answer' }, { kind: 'runEnd', at: 1, agentId: 'a', reason: 'weird' }]) {
    assert.equal(reduce(s0, bad), s0)
  }
  const dup = reduce(s0, spawn('a', 99, { type: 'Other' }))
  assert.equal(dup.agents.find(a => a.id === 'a')!.type, 'Explore')
})

test('more than MAX_FINISHED finished agents fold the oldest into counters', () => {
  const evs: object[] = []
  for (let i = 0; i < MAX_FINISHED + 5; i++) {
    evs.push(spawn(`a${i}`, i), { kind: 'runEnd', at: i + 1, agentId: `a${i}`, reason: i % 2 ? 'error' : 'answer' })
  }
  evs.push(spawn('live', 1000))
  const s = reduceAll(S(), evs)
  const finished = s.agents.filter(a => a.status !== 'running' && a.status !== 'waiting')
  assert.equal(finished.length, MAX_FINISHED)
  assert.equal(s.folded.completed + s.folded.failed, 5)
  assert.ok(s.agents.some(a => a.id === 'live'))
  assert.ok(!s.agents.some(a => a.id === 'a0'))
})

test('final fix 3: a stale-unknown workflow agent revives on its own tool call', () => {
  const stale = reduceAll(S(), [spawn('w', 0, { workflowRunId: 'wf_1' }), { kind: 'tick', at: 700_000, staleWorkflowMs: 600_000 }])
  assert.equal(agent(stale, 'w')!.status, 'unknown')
  const s = reduce(stale, { kind: 'toolCall', at: 710_000, agentId: 'w', tool: 'Read' })
  const a = agent(s, 'w')!
  assert.equal(a.status, 'running')
  assert.equal(a.currentTool, 'Read')
  assert.equal(a.lastSeenAt, 710_000)
  assert.equal(a.endedAt, undefined)
  assert.equal(a.endReason, undefined)
})

test('final fix 3: a stale-unknown workflow agent takes its real end from runEnd', () => {
  const stale = reduceAll(S(), [spawn('w', 0, { workflowRunId: 'wf_1' }), { kind: 'tick', at: 700_000, staleWorkflowMs: 600_000 }])
  const s = reduce(stale, { kind: 'runEnd', at: 720_000, agentId: 'w', reason: 'answer' })
  const a = agent(s, 'w')!
  assert.equal(a.status, 'completed')
  assert.equal(a.endReason, 'answer')
  assert.equal(a.endedAt, 720_000)
})

test('final fix 3: unknown after session end stays final', () => {
  const ended = reduceAll(S(), [spawn('a', 1, { workflowRunId: 'wf_1' }), { kind: 'sessionEnd', at: 20, reason: 'other' }])
  assert.equal(agent(ended, 'a')!.endReason, 'session-end')
  assert.equal(reduce(ended, { kind: 'toolCall', at: 30, agentId: 'a', tool: 'Grep' }), ended)
  assert.equal(reduce(ended, { kind: 'runEnd', at: 31, agentId: 'a', reason: 'answer' }), ended)
})

// Stages: main's turns (timestamps only)
const turn = (phase: 'start' | 'end', at: number) => ({ kind: 'mainTurn', at, phase })

test('stages: a main turn start pushes a turn, its end closes it; session end closes an open one', () => {
  assert.deepEqual(S().turns, [])
  let s = reduceAll(S(), [turn('start', 10), turn('end', 20), turn('start', 30)])
  assert.deepEqual(s.turns, [{ startedAt: 10, endedAt: 20 }, { startedAt: 30 }])
  s = reduce(s, { kind: 'sessionEnd', at: 40, reason: 'other' })
  assert.deepEqual(s.turns, [{ startedAt: 10, endedAt: 20 }, { startedAt: 30, endedAt: 40 }])
  // a start while a turn is open (its end was missed) opens a new one and leaves the old end unknown
  assert.deepEqual(reduceAll(S(), [turn('start', 1), turn('start', 2)]).turns, [{ startedAt: 1 }, { startedAt: 2 }])
})

test('stages: only the last MAX_TURNS turns are kept, oldest first', () => {
  const evs: object[] = []
  for (let i = 0; i < MAX_TURNS + 5; i++) evs.push(turn('start', i * 10), turn('end', i * 10 + 5))
  const s = reduceAll(S(), evs)
  assert.equal(s.turns.length, MAX_TURNS)
  assert.equal(s.turns[0]!.startedAt, 50)
  assert.equal(s.turns.at(-1)!.endedAt, (MAX_TURNS + 4) * 10 + 5)
})

test('stages: an end with no open turn, main already waiting, returns the same object', () => {
  const s = reduceAll(S(), [turn('start', 1), turn('end', 2)])
  assert.equal(reduce(s, turn('end', 3)), s)
  assert.equal(reduce(s, { kind: 'tick', at: 4, staleWorkflowMs: 600_000 }), s)
  const ended = reduce(s, { kind: 'sessionEnd', at: 5, reason: 'other' })
  assert.deepEqual(ended.turns, s.turns) // nothing open to close
})

test('stages: a snapshot written before turns existed reduces fine', () => {
  const { turns: _t, ...old } = S()
  const s = reduceAll(old as Snapshot, [spawn('a', 1), turn('start', 2), turn('end', 3)])
  assert.deepEqual(s.turns, [{ startedAt: 2, endedAt: 3 }])
  const s2 = reduce({ ...(old as Snapshot), turns: 'junk' as never }, turn('end', 9))
  assert.equal(s2.agents.find(a => a.id === 'main')!.status, 'waiting')
  assert.ok(reduce(old as Snapshot, { kind: 'sessionEnd', at: 5, reason: 'other' }).session.endedAt === 5)
})

test('fix 7: a snapshot without turns gains [] on any reduce, so the next write carries it', () => {
  const { turns: _t, ...old } = S()
  for (const ev of [{ kind: 'tick', at: 1, staleWorkflowMs: 600_000 }, { kind: 'nope' }, { kind: 'mainTurn', at: 2, phase: 'end' }]) {
    assert.deepEqual(reduce(old as Snapshot, ev).turns, [])
  }
  const s = S()
  assert.equal(reduce(s, { kind: 'tick', at: 1, staleWorkflowMs: 600_000 }), s) // one that has them: same object still
})
