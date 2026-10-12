import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffFrame, toAnsi } from '../../cli/term.ts'

test('toAnsi colours, bolds, dims and resets every segment', () => {
  assert.equal(toAnsi([{ text: 'a' }, { text: 'b', fg: 'red', bold: true }]), 'a\x1b[1;31mb\x1b[0m')
  assert.equal(toAnsi([{ text: 'c', dim: true, inverse: true }]), '\x1b[2;7mc\x1b[0m')
})

test('diffFrame rewrites only changed lines and clears removed ones', () => {
  const out = diffFrame(['a', 'b', 'c'], ['a', 'X', ''])
  assert.ok(!out.includes('\x1b[1;1H')) // line 1 unchanged
  assert.ok(out.includes('\x1b[2;1H\x1b[2KX'))
  assert.ok(out.includes('\x1b[3;1H\x1b[2K'))
  assert.equal(diffFrame(['a'], ['a']), '')
  assert.ok(diffFrame(['a', 'b'], ['a']).includes('\x1b[2;1H\x1b[2K')) // shrink clears leftover
})
