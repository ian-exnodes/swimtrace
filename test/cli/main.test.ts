import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canClean, guard } from '../../cli/main.ts'
import { swimtraceDir } from '../../cli/snapshots.ts'

test('guard reports a throw exactly once and passes args through', () => {
  const errs: unknown[] = []
  const seen: number[] = []
  const boom = new Error('boom')
  guard((n: number) => { seen.push(n); throw boom }, e => { errs.push(e) })(7)
  assert.equal(errs.length, 1); assert.equal(errs[0], boom)
  assert.deepEqual(seen, [7])
  guard(() => {}, e => { errs.push(e) })()
  assert.equal(errs.length, 1)
})

test('empty CLAUDE_CONFIG_DIR / HOME are treated as unset; clean refuses non-absolute roots', () => {
  assert.equal(swimtraceDir({ CLAUDE_CONFIG_DIR: '', HOME: '/h' }), '/h/.claude/swimtrace')
  const bad = swimtraceDir({ CLAUDE_CONFIG_DIR: '', HOME: '' })
  assert.equal(bad, '.claude/swimtrace')
  assert.equal(canClean(bad), false)
  assert.equal(canClean('/x/other'), false)
  assert.equal(canClean('/x/.claude/swimtrace'), true)
})
