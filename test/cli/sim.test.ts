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

test('stages: the orchestrated scenario reduces cleanly into two turns, a tagged first dispatch and a workflow run', () => {
  const [s] = playInstant('orchestrated', 0)
  assert.equal(s!.simulated, true)
  assert.equal(s!.turns.length, 2)
  assert.ok(s!.turns.every(t => t.endedAt !== undefined))
  assert.ok(s!.agents.some(a => a.description.includes('[class:complex]') && a.type === 'Explore'))
  assert.equal(s!.agents.find(a => a.description === 'review:perf')!.status, 'failed')
  assert.equal(s!.workflows.wf_orch, 'review-changes')
  assert.equal(s!.tasks.length, 5)
  const total = SCENARIOS.orchestrated!.sessions[0]!.steps.reduce((n, st) => n + st.after, 0)
  assert.ok(total >= 15_000 && total <= 20_000, `${total} ms`)
})

test('stages: mid-run the orchestrated flow shows its stages; at the end the first turn is one line', () => {
  const draw = (until?: number) => {
    const [s] = playInstant('orchestrated', 0, until)
    return layout(s!, { width: 160, height: 40, now: s!.writtenAt, view: 'agent', runningOnly: false, expanded: false, rules: [] }).map(rowText)
  }
  const mid = draw(6_000)
  assert.match(mid[2]!, /^\[● request · \w+\]─▶\[✓ classify: complex 1s\]─▶\[⑂ route\]─┬─ Explore ───▶\[● \[T1\] list files in src · Read 4s\]$/)
  assert.ok(mid.some(l => /├─ Explore ───▶\[● \[T2\] count test files · Grep 4s\]$/.test(l)))
  assert.ok(mid.some(l => /└─ workflow ──▶\[◆ review-changes\]─┬─▶\[● review:bugs/.test(l)))
  assert.ok(!mid.some(l => /request #/.test(l)))
  assert.ok(mid.some(l => /^Progress {2}tasks 0\/5 done · 4 running/.test(l)))
  const end = draw()
  assert.match(end[2]!, /^\[✓ request\]─▶\[✓ plan 1s\]─▶\[⑂ route\]─── Explore ──▶\[✓ \[T6\] summarize the review 2s\]$/)
  assert.match(end[3]!, /^Progress /)
  assert.match(end[4]!, /^◉ request #1 · 5 agents ✗ 1 failed \d+s$/)
  assert.ok(end.includes('Progress  tasks 4/5 done · 0 running · 5 done · 1 failed'))
})
