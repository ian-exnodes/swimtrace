import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptySnapshot, type Snapshot } from '../../mod/core/model.ts'
import { listSessions, pickSession, pruneOld, readSnapshot, swimtraceDir } from '../../cli/snapshots.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'swt-'))
const snap = (id: string, project: string, writtenAt: number, endedAt?: number): Snapshot =>
  ({ ...emptySnapshot({ id, project, startedAt: 0, endedAt }), writtenAt })

test('swimtraceDir honours CLAUDE_CONFIG_DIR', () => {
  assert.equal(swimtraceDir({ CLAUDE_CONFIG_DIR: '/c', HOME: '/h' }), '/c/swimtrace')
  assert.equal(swimtraceDir({ HOME: '/h' }), '/h/.claude/swimtrace')
})

test('review focus 3 / case 8: a half-written file keeps the last good snapshot', () => {
  const d = dir()
  const p = join(d, 's.json')
  writeFileSync(p, JSON.stringify(snap('s', '/p', 1)))
  const good = readSnapshot(p).snap!
  writeFileSync(p, '{"v":1,"sess')
  const r = readSnapshot(p, good)
  assert.equal(r.snap, good)
  assert.match(r.error!, /JSON/)
})

test('unknown snapshot versions are skipped with an error', () => {
  const d = dir()
  const p = join(d, 's.json')
  writeFileSync(p, JSON.stringify({ ...snap('s', '/p', 1), v: 2 }))
  const r = readSnapshot(p)
  assert.equal(r.snap, undefined)
  assert.match(r.error!, /version/)
})

test('case 6: several sessions listed newest first, stale flagged', () => {
  const d = dir()
  writeFileSync(join(d, 'a.json'), JSON.stringify(snap('a', '/p1', 100_000)))
  writeFileSync(join(d, 'b.json'), JSON.stringify(snap('b', '/p2', 1_000)))
  writeFileSync(join(d, 'junk.txt'), 'x')
  utimesSync(join(d, 'b.json'), 1, 1)
  const list = listSessions(d, 110_000)
  assert.deepEqual(list.map(e => e.snap.session.id), ['a', 'b'])
  assert.equal(list[0]!.stale, false)
  assert.equal(list[1]!.stale, true)
})

test('pickSession prefers a live session of the current project', () => {
  const e = (id: string, project: string, endedAt?: number) => ({ path: id, snap: snap(id, project, 0, endedAt), stale: false, mtimeMs: 0 })
  assert.equal(pickSession([e('x', '/other'), e('y', '/me', 5), e('z', '/me')], '/me')!.snap.session.id, 'z')
  assert.equal(pickSession([e('x', '/other')], '/me')!.snap.session.id, 'x')
  assert.equal(pickSession([], '/me'), undefined)
})

test('case 10: a restarted CLI rebuilds from files alone', () => {
  const d = dir()
  writeFileSync(join(d, 'a.json'), JSON.stringify(snap('a', '/p', 5)))
  assert.equal(listSessions(d, 6).length, 1) // no prior cache needed
})

test('pruneOld deletes snapshots older than 7 days only', () => {
  const d = dir()
  writeFileSync(join(d, 'old.json'), '{}')
  writeFileSync(join(d, 'new.json'), '{}')
  const now = Date.now()
  utimesSync(join(d, 'old.json'), (now - 8 * 86_400_000) / 1000, (now - 8 * 86_400_000) / 1000)
  assert.equal(pruneOld(d, now), 1)
  assert.equal(existsSync(join(d, 'old.json')), false)
  assert.equal(existsSync(join(d, 'new.json')), true)
})

test('a missing directory lists nothing', () => {
  assert.deepEqual(listSessions('/nope/never', 0), [])
})

test('wrong-shaped valid JSON keeps the last good snapshot', () => {
  const d = dir()
  const p = join(d, 's.json')
  writeFileSync(p, JSON.stringify(snap('s', '/p', 1)))
  const good = readSnapshot(p).snap!
  for (const body of ['null', '{}', '{"v":1,"session":{"id":"s"},"agents":[]}']) {
    writeFileSync(p, body)
    const r = readSnapshot(p, good)
    assert.equal(r.snap, good, body)
    assert.match(r.error!, /malformed/, body)
  }
})

test('listSessions keeps a session whose file was overwritten with a wrong shape', () => {
  const d = dir()
  const p = join(d, 'a.json')
  writeFileSync(p, JSON.stringify(snap('a', '/p', 5)))
  const cache = new Map<string, Snapshot>()
  assert.equal(listSessions(d, 6, cache).length, 1)
  writeFileSync(p, '{}')
  const list = listSessions(d, 6, cache)
  assert.equal(list.length, 1)
  assert.equal(list[0]!.snap.session.id, 'a')
})
