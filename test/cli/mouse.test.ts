import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hitAt, takeMouse } from '../../cli/mouse.ts'
import type { Row } from '../../mod/core/layout.ts'

test('takeMouse: a left press becomes a 0-based click; its release is dropped; keys pass through', () => {
  const r = takeMouse('g\x1b[<0;12;5M\x1b[<0;12;5mq')
  assert.deepEqual(r.clicks, [{ col: 11, row: 4 }])
  assert.equal(r.rest, 'gq')
  assert.equal(r.pending, '')
})

test('takeMouse: wheel, drag, right button and modified clicks are dropped', () => {
  const r = takeMouse('\x1b[<64;3;3M\x1b[<65;3;3M\x1b[<32;3;3M\x1b[<2;3;3M\x1b[<4;3;3M')
  assert.deepEqual(r.clicks, [])
  assert.equal(r.rest, '')
})

test('takeMouse: a sequence cut across two chunks is held back and completed', () => {
  const a = takeMouse('x\x1b[<0;7')
  assert.deepEqual(a.clicks, [])
  assert.equal(a.rest, 'x')
  assert.equal(a.pending, '\x1b[<0;7')
  const b = takeMouse(a.pending + ';2M')
  assert.deepEqual(b.clicks, [{ col: 6, row: 1 }])
  assert.equal(b.rest, '')
})

test('takeMouse: arrow keys and other escapes are not mouse input', () => {
  const r = takeMouse('\x1b[A\x1b[B\x1b')
  assert.deepEqual(r.clicks, [])
  assert.equal(r.rest, '\x1b[A\x1b[B\x1b')
  assert.equal(r.pending, '')
})

test('hitAt: finds the target under a cell, counting wide characters as two cells', () => {
  const rows: Row[] = [
    [{ text: '│ ' }, { text: '漢字 ' }, { text: '[√ a1 3s]', hit: 'agent:a1' }, { text: ' │' }],
    [{ text: 'proj  1234abcd  live', hit: 'session:/x/s.json' }],
  ]
  assert.equal(hitAt(rows, 0, 0), undefined) // the border
  assert.equal(hitAt(rows, 6, 0), undefined) // the space after 漢字 (cells 2–5 are 漢字)
  assert.equal(hitAt(rows, 7, 0), 'agent:a1')
  assert.equal(hitAt(rows, 15, 0), 'agent:a1')
  assert.equal(hitAt(rows, 16, 0), undefined)
  assert.equal(hitAt(rows, 3, 1), 'session:/x/s.json')
  assert.equal(hitAt(rows, 3, 9), undefined) // past the last row
})
