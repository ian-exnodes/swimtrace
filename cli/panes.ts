import { cellWidth, clip, rowText, type Row } from '../mod/core/layout.ts'

const FRAME = { dim: true } as const

/** `row` cut to `w` terminal cells, then padded with spaces to exactly `w`. */
export function fit(row: Row, w: number): Row {
  const c = clip(row, w)
  const pad = w - cellWidth(rowText(c))
  return pad > 0 ? [...c, { text: ' '.repeat(pad) }] : c
}

/**
 * A framed pane of exactly `h` rows of `w` cells: `title` in the top border, `body` after `│ `.
 * `corners`: top-left, top-right, bottom-left, bottom-right; `right = false` leaves the right edge to a neighbour.
 */
export function box(title: Row, body: Row[], w: number, h: number, corners = '┌┐└┘', right = true): Row[] {
  const [tl, tr, bl, br] = [...corners]
  const inner = w - 1 - (right ? 1 : 0) // cells between the edges
  const edge = right ? [{ text: '│', ...FRAME }] : []
  const t = clip(title, Math.max(0, inner - 3))
  const fill = inner - 3 - cellWidth(rowText(t))
  const top: Row = [{ text: `${tl}─ `, ...FRAME }, ...t, { text: ` ${'─'.repeat(fill)}${right ? tr : ''}`, ...FRAME }]
  const rows: Row[] = [top]
  for (let i = 0; i < h - 2; i++) rows.push([{ text: '│ ', ...FRAME }, ...fit(body[i] ?? [], inner - 1), ...edge])
  rows.push([{ text: `${bl}${'─'.repeat(inner)}${right ? br : ''}`, ...FRAME }])
  return rows
}

export interface PaneContent {
  /** The Flow pane's title (the header row) and body, drawn at `w`×`h` cells. */
  flow: (w: number, h: number) => { title: Row; body: Row[] }
  details: (w: number) => Row[]
  sessions: (w: number, h: number) => Row[]
  sessionCount: number
  /** The last row: the key bar, or a config warning. */
  bottom: Row
}

export const rightWidth = (W: number): number => Math.min(44, Math.max(32, Math.round(W / 3)))

/** Flow on the left; Details over Sessions on the right, sharing edges; `bottom` last. Exactly `H` rows of `W` cells. */
export function panes(c: PaneContent, W: number, H: number): Row[] {
  const R = rightWidth(W)
  const L = W - R
  const flow = c.flow(L - 2, H - 3)
  const left = box(flow.title, flow.body, L, H - 1, '┌ └ ', false)
  const sh = Math.min(Math.floor((H - 1) / 3), Math.max(3, c.sessionCount + 2))
  const dh = H - sh
  const bold = (s: string): Row => [{ text: s, bold: true }]
  const right = [
    ...box(bold('Details'), c.details(R - 3), R, dh, '┬┐├┤').slice(0, -1),
    ...box(bold('Sessions'), c.sessions(R - 3, sh - 2), R, sh, '├┤┴┘'),
  ]
  return [...left.map((r, i) => [...r, ...right[i]!]), fit(c.bottom, W)]
}
