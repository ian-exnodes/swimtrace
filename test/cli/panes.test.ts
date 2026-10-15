import { test } from 'node:test'
import assert from 'node:assert/strict'
import { box, fit, panes, rightWidth, type PaneContent } from '../../cli/panes.ts'
import { cellWidth, rowText, type Row } from '../../mod/core/layout.ts'

const t = (s: string): Row => [{ text: s }]
const widths = (rows: Row[]) => rows.map(r => cellWidth(rowText(r)))
const chars = (r: Row) => [...rowText(r)]

test('fit cuts and pads by cells, never splitting a wide character', () => {
  assert.equal(rowText(fit(t('ab漢'), 3)), 'ab ')
  assert.equal(rowText(fit(t('ab'), 5)), 'ab   ')
  assert.equal(cellWidth(rowText(fit(t('漢字漢字'), 5))), 5)
})

test('box: exact size, title in the top border, padded and cut body, wide characters', () => {
  const rows = box(t('Title'), [t('漢字abc'), t('x'.repeat(50))], 20, 5)
  assert.equal(rows.length, 5)
  assert.deepEqual(widths(rows), [20, 20, 20, 20, 20])
  assert.match(rowText(rows[0]!), /^┌─ Title ─+┐$/)
  assert.equal(rowText(rows[1]!), '│ 漢字abc' + ' '.repeat(10) + '│')
  assert.equal(rowText(rows[2]!), '│ ' + 'x'.repeat(17) + '│')
  assert.equal(rowText(rows[3]!), '│' + ' '.repeat(18) + '│')
  assert.equal(rowText(rows[4]!), '└' + '─'.repeat(18) + '┘')
})

test('box without the right edge, custom corners, a body taller than the box', () => {
  const rows = box(t('L'), Array.from({ length: 10 }, (_, i) => t(`row ${i}`)), 12, 4, '┬┐├┤', false)
  assert.deepEqual(widths(rows), [12, 12, 12, 12])
  assert.equal(chars(rows[0]!)[0], '┬')
  assert.equal(rowText(rows[1]!), '│ row 0     ')
  assert.equal(rowText(rows[2]!), '│ row 1     ')
  assert.equal(rowText(rows[3]!), '├' + '─'.repeat(11))
  const long = box(t('漢'.repeat(40)), [], 20, 3)
  assert.deepEqual(widths(long), [20, 20, 20])
  assert.equal(chars(long[0]!).at(-1), '┐')
})

const content = (seen: Record<string, number[]> = {}, sessionCount = 2): PaneContent => ({
  flow: (w, h) => { seen.flow = [w, h]; return { title: t('SWIMTRACE proj'), body: [t('[✓ request]─▶[✓ plan 8s]')] } },
  details: w => { seen.details = [w]; return [t('main'), t('type    main')] },
  sessions: (w, h) => { seen.sessions = [w, h]; return [t('proj  e57186f5  live')] },
  sessionCount,
  bottom: t(' keys'),
})

test('rightWidth clamps a third of the width to 32…44', () => {
  assert.equal(rightWidth(100), 33)
  assert.equal(rightWidth(90), 32)
  assert.equal(rightWidth(120), 40)
  assert.equal(rightWidth(300), 44)
})

test('panes: exact size, shared junctions, bottom row, callback sizes', () => {
  const seen: Record<string, number[]> = {}
  const rows = panes(content(seen), 120, 30)
  assert.equal(rows.length, 30)
  assert.deepEqual(new Set(widths(rows)), new Set([120]))
  const L = 120 - 40
  assert.equal(chars(rows[0]!)[0], '┌')
  assert.equal(chars(rows[0]!)[L], '┬')
  assert.equal(chars(rows[0]!).at(-1), '┐')
  assert.equal(chars(rows[28]!)[0], '└')
  assert.equal(chars(rows[28]!)[L], '┴')
  assert.equal(chars(rows[28]!).at(-1), '┘')
  const split = rows.findIndex(r => chars(r)[L] === '├')
  assert.ok(split > 0 && split < 28)
  assert.equal(chars(rows[split]!).at(-1), '┤')
  assert.match(rowText(rows[split]!), /├─ Sessions /)
  assert.match(rowText(rows[0]!), /┬─ Details /)
  assert.match(rowText(rows[0]!), /^┌─ SWIMTRACE proj /)
  assert.equal(rowText(rows[29]!).trimEnd(), ' keys')
  // sessions: 2 + 2 = 4 rows, so details holds 30 - 4 = 26 rows with its bottom shared
  assert.deepEqual(seen.flow, [L - 2, 27])
  assert.deepEqual(seen.details, [37])
  assert.deepEqual(seen.sessions, [37, 2])
  assert.equal(28 - split + 1, 4)
})

test('panes: sessions pane height is clamped to 3 rows minimum and a third of the column maximum', () => {
  const few = panes(content({}, 0), 100, 20)
  const fewSplit = few.findIndex(r => chars(r)[100 - 33] === '├')
  assert.equal(19 - fewSplit, 3)
  const many = panes(content({}, 50), 100, 20)
  const manySplit = many.findIndex(r => chars(r)[100 - 33] === '├')
  assert.equal(19 - manySplit, 6) // floor(19 / 3)
})

test('a 300-column terminal caps the right column at 44', () => {
  const rows = panes(content(), 300, 40)
  assert.deepEqual(new Set(widths(rows)), new Set([300]))
  assert.equal(chars(rows[0]!)[300 - 44], '┬')
})

test('box: a title wider than the box ends with a dim … before the frame fill', () => {
  const [top] = box(t('x'.repeat(40)), [], 20, 3)
  assert.equal(cellWidth(rowText(top!)), 20)
  const cs = chars(top!)
  assert.equal(cs[cs.length - 1], '┐')
  assert.equal(cs[cs.length - 3], '…')
  assert.equal(top!.find(g => g.text === '…')?.dim, true)
  const ok = box(t('short'), [], 20, 3)[0]!
  assert.ok(!rowText(ok).includes('…'))
})
