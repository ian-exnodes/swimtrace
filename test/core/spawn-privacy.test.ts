import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnEvent } from '../../mod/hooks/events.ts'

const wf = { runId: 'wf_1', agentIndex: 2 }
const desc = (ev: unknown) => (ev as { description: string }).description

test('workflow spawn whose description is the prompt becomes "agent <index>"', () => {
  const prompt = 'Count the .ts files in test/core. BADGERWORD'
  const ev = spawnEvent({ description: prompt, prompt, subagentType: 'general-purpose', workflow: wf }, 'a1', 5)
  assert.equal(desc(ev), 'agent 2')
  assert.ok(!JSON.stringify(ev).includes('BADGERWORD'))
})

test('workflow spawn with a prompt prefix and an ellipsis becomes "agent <index>"', () => {
  const prompt = 'Count the .ts files in test/core. BADGERWORD and more'
  for (const tail of ['…', '...']) {
    const ev = spawnEvent({ description: 'Count the .ts files in test/core.' + tail, prompt, subagentType: 'general-purpose', workflow: wf }, 'a1', 5)
    assert.equal(desc(ev), 'agent 2')
  }
})

test('a workflow label is kept', () => {
  const ev = spawnEvent({ description: 'S2-LABELLED', prompt: 'Count … HERONWORD', subagentType: 'general-purpose', workflow: wf }, 'a1', 5)
  assert.equal(desc(ev), 'S2-LABELLED')
})

test('non-workflow spawn whose description is the prompt shows the agent type', () => {
  const prompt = 'Find every SECRETWORD in the repo'
  assert.equal(desc(spawnEvent({ description: prompt, prompt, subagentType: 'Explore' }, 'a1', 5)), 'Explore')
})

test('an ordinary Agent-tool description is unchanged', () => {
  const d = '[T1] Explore — list mod/core files'
  assert.equal(desc(spawnEvent({ description: d, prompt: 'List the files under mod/core and report.', subagentType: 'Explore' }, 'a1', 5)), d)
})
