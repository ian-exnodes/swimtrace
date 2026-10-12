import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptySnapshot } from '../../mod/core/model.ts'
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
