import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SCENARIOS, playInstant } from '../../cli/sim.ts'
import { layout, rowText } from '../../mod/core/layout.ts'

test('every scenario produces simulated snapshots only', () => {
  for (const name of Object.keys(SCENARIOS)) {
    const snaps = playInstant(name, 1_000_000)
    assert.ok(snaps.length >= 1, name)
    assert.ok(snaps.every(s => s.simulated === true), name)
  }
})

test('fanout ends with parallel agents done and a running reviewer', () => {
  const [s] = playInstant('fanout', 0)
  assert.equal(s!.agents.filter(a => a.type === 'Explore' && a.status === 'completed').length, 3)
  assert.ok(s!.agents.some(a => a.type === 'reviewer' && a.status === 'running'))
})

test('failure covers failed, interrupted and killed', () => {
  const [s] = playInstant('failure', 0)
  const st = new Set(s!.agents.map(a => a.status))
  for (const x of ['failed', 'interrupted', 'killed']) assert.ok(st.has(x as never), x)
})

test('multi-session yields two sessions in different projects', () => {
  const snaps = playInstant('multi-session', 0)
  assert.equal(snaps.length, 2)
  assert.notEqual(snaps[0]!.session.project, snaps[1]!.session.project)
})

test('workflow agents carry the run id and the workflow name is known', () => {
  const [s] = playInstant('workflow', 0)
  assert.equal(s!.workflows.wf_sim, 'review-changes')
  assert.ok(s!.agents.filter(a => a.workflowRunId === 'wf_sim').length >= 4)
})

test('flow: the workflow scenario draws one ◆ node with each verify step chained after its review', () => {
  const [s] = playInstant('workflow', 0)
  assert.equal(s!.agents.find(a => a.id === 'w3')!.model, 'claude-haiku-4-5')
  const t = layout(s!, { width: 160, height: 40, now: s!.writtenAt, view: 'agent', runningOnly: false, expanded: false, rules: [] }).map(rowText)
  assert.equal(t.filter(l => l.includes('[◆ review-changes]')).length, 1)
  assert.ok(t.some(l => /\[✓ review:correctness [^\]]+\]─ ─▶\[✓ verify:correctness/.test(l)))
  assert.ok(t.some(l => /\[✓ review:security [^\]]+\]─ ─▶\[● verify:security/.test(l)))
})
