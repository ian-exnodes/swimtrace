import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { VERSION } from '../mod/core/model.ts'
import type { SessionEntry } from './snapshots.ts'

/** True when version `a` is newer than `b` (`major.minor.patch`; anything unparsable is never newer). */
export function newer(a: string, b: string): boolean {
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

/** The newest plugin version that wrote one of these files, when it is newer than this viewer. */
export function newerPlugin(entries: readonly SessionEntry[], mine = VERSION): string | undefined {
  let best: string | undefined
  for (const e of entries) {
    const by = e.snap.by
    if (typeof by === 'string' && newer(by, mine) && (best === undefined || newer(by, best))) best = by
  }
  return best
}

export const updateNote = (plugin: string): string => `swimtrace ${VERSION} is older than the plugin (${plugin}): run swimtrace update`

/** The swimtrace checkout this file runs from (cli/ or dist/cli/), found by its package.json. */
export function findRoot(from: string): string | undefined {
  for (let dir = from, i = 0; i < 4; i++, dir = dirname(dir)) {
    try { if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === 'swimtrace') return dir } catch { /* keep looking */ }
  }
  return undefined
}

/** `git pull` then `npm install` (which rebuilds) in the viewer's own clone; the global link points there already. */
export function runUpdate(from: string): number {
  const root = findRoot(from)
  if (root === undefined || !existsSync(join(root, '.git'))) {
    console.error('swimtrace update works on a git clone; this install is not one. Reinstall: see the README, Install.')
    return 1
  }
  const win = process.platform === 'win32' // npm is npm.cmd there, which needs a shell
  for (const [cmd, args] of [['git', ['pull', '--ff-only']], ['npm', ['install']]] as const) {
    console.log(`> ${cmd} ${args.join(' ')}   (in ${root})`)
    const r = spawnSync(cmd, [...args], { cwd: root, stdio: 'inherit', shell: win })
    if (r.status !== 0) { console.error(`${cmd} failed${r.error ? `: ${r.error.message}` : ''}`); return r.status ?? 1 }
  }
  console.log('Updated. Restart swimtrace to use the new version.')
  return 0
}
