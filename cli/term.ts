import type { Fg, Row } from '../mod/core/layout.ts'

const FG: Record<Fg, number> = { red: 31, green: 32, yellow: 33, magenta: 35, cyan: 36, gray: 90 }
export const ALT_ON = '\x1b[?1049h'
export const ALT_OFF = '\x1b[?1049l'
export const HIDE_CURSOR = '\x1b[?25l'
export const SHOW_CURSOR = '\x1b[?25h'

export function toAnsi(row: Row): string {
  return row.map(g => {
    const codes = [g.bold && 1, g.dim && 2, g.inverse && 7, g.fg && FG[g.fg]].filter(Boolean)
    return codes.length ? `\x1b[${codes.join(';')}m${g.text}\x1b[0m` : g.text
  }).join('')
}

export function diffFrame(prev: string[], next: string[]): string {
  let out = ''
  const n = Math.max(prev.length, next.length)
  for (let i = 0; i < n; i++) {
    if (prev[i] === next[i]) continue
    out += `\x1b[${i + 1};1H\x1b[2K${next[i] ?? ''}`
  }
  return out
}
