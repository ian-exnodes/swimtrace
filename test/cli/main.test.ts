import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canClean, guard, main, safeToClean, sessionListRows } from '../../cli/main.ts'
import { swimtraceDir } from '../../cli/snapshots.ts'
import { emptySnapshot } from '../../mod/core/model.ts'
import { cellWidth, rowText } from '../../mod/core/layout.ts'

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

test('final fix 5: session list rows blank control characters and fit wide characters by cells', () => {
  const snap = emptySnapshot({ id: 'sess-abcdef12', project: '/w/\x1b[2J漢字漢字漢字/proj', startedAt: Date.now() })
  const rows = sessionListRows([{ path: '/x/sess.json', snap, stale: false, mtimeMs: 0 }], 0, 20)
  for (const row of rows) {
    const t = rowText(row)
    assert.ok(!t.includes('\x1b'), `escape in ${JSON.stringify(t)}`)
    assert.ok(cellWidth(t) <= 20, `too wide: ${JSON.stringify(t)}`)
  }
  assert.ok(rows.some(r => rowText(r).includes('漢')))
})

test('final fix 6: clean deletes only a swimtrace folder holding nothing but its own files', () => {
  const base = mkdtempSync(join(tmpdir(), 'swimtrace-clean-'))
  try {
    const root = join(base, 'swimtrace')
    assert.deepEqual(safeToClean(root), { ok: true, missing: true }) // nothing there: nothing to delete
    mkdirSync(join(root, 'sessions'), { recursive: true })
    writeFileSync(join(root, 'config.json'), '{}')
    assert.deepEqual(safeToClean(root), { ok: true, missing: false })
    writeFileSync(join(root, 'README.md'), '# a repo that happens to share the name')
    const r = safeToClean(root)
    assert.equal(r.ok, false)
    assert.match(r.ok ? '' : r.why, /README\.md/)
    assert.equal(safeToClean(join(base, 'other')).ok, false)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('flow: --help names the flow/pools toggle and no zoom', async () => {
  const log = console.log
  let out = ''
  console.log = (x: unknown) => { out += String(x) }
  try { assert.equal(await main(['--help']), 0) } finally { console.log = log }
  assert.match(out, /g flow\/pools/)
  assert.doesNotMatch(out, /zoom|\+\/-/)
})
