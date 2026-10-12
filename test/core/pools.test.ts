import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '../../mod/core/model.ts'
import { compileRules, parseConfig, resolvePool, DEFAULT_CONFIG } from '../../mod/core/pools.ts'

const A = (o: Partial<Agent> = {}): Agent => ({ id: 'a', type: 'Explore', description: 'look around', status: 'running', startedAt: 0, lastSeenAt: 0, ...o })
const rules = (json: unknown[]) => compileRules(json as never).rules

test('case 5: no metadata falls back to the agent type', () => {
  assert.deepEqual(resolvePool(A(), '/p', {}, []), { name: 'Explore', source: 'type' })
})

test('main always gets the main lane', () => {
  assert.deepEqual(resolvePool(A({ id: 'main', type: 'main' }), '/p', {}, rules([{ match: { type: '.*' }, pool: 'X' }])), { name: 'MAIN', source: 'main' })
})

test('workflow run lane uses the workflow name, else the run id', () => {
  assert.deepEqual(resolvePool(A({ workflowRunId: 'wf_1' }), '/p', { wf_1: 'review-changes' }, []), { name: 'review-changes', source: 'workflow' })
  assert.deepEqual(resolvePool(A({ workflowRunId: 'wf_2' }), '/p', {}, []), { name: 'wf_2', source: 'workflow' })
})

test('explicit [pool:Name] tag beats workflow and type', () => {
  assert.deepEqual(resolvePool(A({ description: '[pool:Backend] build api', workflowRunId: 'wf_1' }), '/p', {}, []), { name: 'Backend', source: 'explicit' })
})

test('config rules beat everything except main; all keys must match; captures substitute', () => {
  const r = rules([
    { match: { type: '^reviewer$', project: 'c4k' }, pool: 'Review' },
    { match: { description: '^\\[T\\d+\\] (\\S+)' }, pool: '$1' },
  ])
  assert.deepEqual(resolvePool(A({ type: 'reviewer' }), '/work/c4k-mobile', {}, r), { name: 'Review', source: 'config' })
  assert.deepEqual(resolvePool(A({ type: 'reviewer' }), '/work/other', {}, r), { name: 'reviewer', source: 'type' })
  assert.deepEqual(resolvePool(A({ description: '[T3] business-analyst — refine', workflowRunId: 'wf' }), '/p', {}, r), { name: 'business-analyst', source: 'config' })
})

test('review focus 4: invalid regex rules are skipped with a warning, others still apply', () => {
  const { rules: r, warnings } = compileRules([{ match: { type: '(' }, pool: 'Bad' }, { match: { type: 'Explore' }, pool: 'Good' }] as never)
  assert.equal(r.length, 1)
  assert.equal(warnings.length, 1)
  assert.equal(resolvePool(A(), '/p', {}, r).name, 'Good')
})

test('parseConfig: missing, invalid JSON and wrong shapes give defaults plus warnings', () => {
  assert.deepEqual(parseConfig(undefined), { config: DEFAULT_CONFIG, warnings: [] })
  assert.equal(parseConfig('{nope').warnings.length, 1)
  const odd = parseConfig(JSON.stringify({ rules: [{ match: {}, pool: 'x' }, { pool: 3 }, 'z'], staleWorkflowAgentMinutes: -1 }))
  assert.deepEqual(odd.config, DEFAULT_CONFIG)
  assert.equal(odd.warnings.length, 4)
  const ok = parseConfig(JSON.stringify({ rules: [{ match: { name: 'x' }, pool: 'X' }], staleWorkflowAgentMinutes: 3 }))
  assert.deepEqual(ok.config, { rules: [{ match: { name: 'x' }, pool: 'X' }], staleWorkflowAgentMinutes: 3 })
})
