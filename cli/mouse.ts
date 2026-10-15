import { cellWidth, type Row } from '../mod/core/layout.ts'

/** SGR mouse reporting (button presses and releases, as `\x1b[<b;col;rowM|m`). */
export const MOUSE_ON = '\x1b[?1000h\x1b[?1006h'
export const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l'

const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
const PARTIAL = /\x1b\[<[\d;]*$/

/**
 * Pull SGR mouse reports out of a stdin chunk. Only a plain left press counts (button 0, `M`); releases, wheel, drag,
 * other buttons and modified clicks are dropped. `rest` is everything else, for the keypress parser; `pending` is a
 * report cut off at the end of the chunk, to prepend to the next one. Cells are 0-based.
 */
export function takeMouse(chunk: string): { clicks: { col: number; row: number }[]; rest: string; pending: string } {
  const cut = PARTIAL.exec(chunk)
  const pending = cut ? cut[0] : ''
  const body = cut ? chunk.slice(0, cut.index) : chunk
  const clicks: { col: number; row: number }[] = []
  const rest = body.replace(SGR, (_m, b: string, col: string, row: string, kind: string) => {
    if (b === '0' && kind === 'M') clicks.push({ col: Number(col) - 1, row: Number(row) - 1 })
    return ''
  })
  return { clicks, rest, pending }
}

/** The `hit` of the text drawn at 0-based cell (`col`, `row`) of a frame, if any. */
export function hitAt(rows: Row[], col: number, row: number): string | undefined {
  let x = 0
  for (const g of rows[row] ?? []) {
    const w = cellWidth(g.text)
    if (col < x + w) return g.hit
    x += w
  }
  return undefined
}
