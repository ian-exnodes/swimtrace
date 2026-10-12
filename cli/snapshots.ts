import { readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Snapshot } from '../mod/core/model.ts'
import { isStale } from '../mod/core/layout.ts'

export function swimtraceDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(env.HOME || '', '.claude'), 'swimtrace')
}

export function readSnapshot(path: string, lastGood?: Snapshot): { snap?: Snapshot; error?: string } {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch (err) {
    return { snap: lastGood, error: `${path}: not readable JSON (${(err as Error).message})` }
  }
  const malformed = { snap: lastGood, error: `${path}: malformed snapshot` }
  if (typeof raw !== 'object' || raw === null) return malformed
  const s = raw as Partial<Snapshot>
  if (typeof s.v !== 'number') return malformed
  if (s.v !== 1) return { snap: undefined, error: `${path}: unknown snapshot version ${s.v}` }
  if (typeof s.session?.id !== 'string' || !Array.isArray(s.agents) || typeof s.writtenAt !== 'number') return malformed
  return { snap: s as Snapshot }
}

export interface SessionEntry { path: string; snap: Snapshot; stale: boolean; mtimeMs: number }

export function listSessions(dir: string, now: number, cache = new Map<string, Snapshot>()): SessionEntry[] {
  let names: string[]
  try { names = readdirSync(dir).filter(n => n.endsWith('.json')) } catch { return [] }
  const out: SessionEntry[] = []
  for (const n of names) {
    const path = join(dir, n)
    const { snap } = readSnapshot(path, cache.get(path))
    if (snap === undefined) continue
    cache.set(path, snap)
    let mtimeMs = 0
    try { mtimeMs = statSync(path).mtimeMs } catch { /* raced a delete */ }
    out.push({ path, snap, stale: isStale(snap, now), mtimeMs })
  }
  return out.sort((a, b) => b.snap.writtenAt - a.snap.writtenAt)
}

export function pruneOld(dir: string, now: number, maxAgeMs = 7 * 86_400_000): number {
  let n = 0
  let names: string[] = []
  try { names = readdirSync(dir).filter(x => x.endsWith('.json')) } catch { return 0 }
  for (const name of names) {
    const p = join(dir, name)
    try { if (now - statSync(p).mtimeMs > maxAgeMs) { rmSync(p); n++ } } catch { /* ignore */ }
  }
  return n
}

export function pickSession(entries: SessionEntry[], cwd: string): SessionEntry | undefined {
  const live = (e: SessionEntry) => e.snap.session.endedAt === undefined && !e.stale
  return entries.find(e => e.snap.session.project === cwd && live(e)) ?? entries.find(e => e.snap.session.project === cwd) ?? entries[0]
}
