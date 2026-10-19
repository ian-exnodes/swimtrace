import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findRoot, newer, newerPlugin, runUpdate } from '../../cli/update.ts'
import { emptySnapshot, VERSION } from '../../mod/core/model.ts'
import type { SessionEntry } from '../../cli/snapshots.ts'

test('VERSION matches package.json and the plugin manifest', () => {
  for (const f of ['package.json', 'mod/.claude-plugin/plugin.json']) assert.equal(JSON.parse(readFileSync(f, 'utf8')).version, VERSION, f)
})

test('newer compares major.minor.patch as numbers', () => {
  assert.equal(newer('0.1.10', '0.1.9'), true)
  assert.equal(newer('0.2.0', '0.1.9'), true)
  assert.equal(newer('0.1.4', '0.1.4'), false)
  assert.equal(newer('0.1.3', '0.1.4'), false)
  assert.equal(newer('junk', '0.1.4'), false)
})

test('newerPlugin: the newest writer above this viewer, ignoring older and unstamped files', () => {
  const e = (by?: string): SessionEntry => ({ path: `/x/${by}.json`, snap: { ...emptySnapshot({ id: `s${by}`, project: '/p', startedAt: 0 }), by }, stale: false, mtimeMs: 0 })
  assert.equal(newerPlugin([e(), e('0.1.3')], '0.1.4'), undefined)
  assert.equal(newerPlugin([e('0.1.5'), e(), e('0.1.6'), e('0.1.4')], '0.1.4'), '0.1.6')
})

test('findRoot finds this checkout from cli/; update refuses a folder that is not a git clone', () => {
  assert.equal(findRoot(join(process.cwd(), 'cli')), process.cwd())
  const dir = mkdtempSync(join(tmpdir(), 'swt-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'swimtrace' }))
  const err = console.error; console.error = () => {}
  try { assert.equal(runUpdate(dir), 1) } finally { console.error = err }
})
