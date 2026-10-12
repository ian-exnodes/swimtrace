import { test, expect, mock } from 'claude-code/testing'

// What the surface hands a Pane render hook: every field of the Pane props, the body 100 cells wide.
const PANE = {
  component: 'Pane',
  requestId: 'swimtrace',
  props: { title: 'SwimTrace', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const SPAWN = { tool_use_id: 'tu-1', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm', background: false, fork: false } as const

// The test's hooks stand for the engine; the kit takes them only before its first call on `$`.
async function boot($: any, on: any, surface: 'terminal' | 'desktop', hooks: () => void = () => {}, files: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: 10_000 })
  mock.env(on, { HOME: '/h' })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', ($: any, e: any) => (e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }))
  on('session.id', () => ({ value: 's' }))
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }))
  hooks()
  await $.session.start({ cwd: '/w/proj', surface, isInteractive: true })
  await $.agent.spawn({ ...SPAWN, prompt: 'p', description: 'scan repo', subagentType: 'Explore' })
  return { clock }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane draws lanes and toggles the agent view on ${surface}`, async ($, on) => {
    await boot($, on, surface)
    const ui = await $.ui.mount({ plugin: 'swimtrace', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /SWIMTRACE/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Explore · type/ })).toBeDefined()
    await ui.press({ key: 'view' })
    expect(await ui.find({ type: 'Text', text: /Explore · type/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /scan repo/ })).toBeDefined()
    await ui.unmount()
  })
}

test('/swimtrace registers on session start, and only running it opens the pane', async ($, on) => {
  const opened: string[] = []
  const registered: string[] = []
  await boot($, on, 'terminal', () => {
    on('command.register', ($: any, e: any) => { registered.push(e.name); return { value: { command: e.name } } })
    on('ui.open', ($: any, e: any) => { opened.push(e.id); return { value: { isPlaced: true } } })
  })
  expect(registered).toEqual(['swimtrace'])
  expect(opened).toEqual([]) // never opened unasked
  const r = await $.command.run({ command: 'swimtrace', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(opened).toEqual(['swimtrace'])
  expect(r.text).toBe('SwimTrace opened.')
})

test('j and k walk the selection in lane order; d shows the selected agent', async ($, on) => {
  await boot($, on, 'terminal')
  const ui = await $.ui.mount({ plugin: 'swimtrace', surface: 'terminal', ...PANE })
  const detail = async () => (await ui.find({ type: 'Text', text: /^id \S+ / }))?.text.split(' ')[1]
  await ui.press({ key: 'details' })
  expect(await detail()).toBeUndefined() // nothing selected yet
  await ui.press({ key: 'next' })
  expect(await detail()).toBe('main') // MAIN lane first
  await ui.press({ key: 'next' })
  expect(await detail()).toBe('a1')
  await ui.press({ key: 'next' }) // at the end: stays
  expect(await detail()).toBe('a1')
  await ui.press({ key: 'prev' })
  expect(await detail()).toBe('main')
  await ui.unmount()
})

test('the 1 s tick redraws only while the pane is on show', async ($, on) => {
  const shown = { current: false }
  let redraws = 0
  const { clock } = await boot($, on, 'terminal', () => {
    on('ui.panes', () => ({ value: shown.current ? [{ id: 'swimtrace', title: 'SwimTrace', isShown: true, isFocused: false, isPlaced: true, plugin: 'swimtrace' }] : [] }))
    on('ui.invalidate', ($: any, e: any) => { if (e === 'ui.render' || e?.event === 'ui.render') redraws++; return { value: undefined } })
  })
  await clock.advance(1_000)
  expect(redraws).toBe(0)
  shown.current = true
  await clock.advance(1_000)
  expect(redraws).toBeGreaterThan(0)
})

test('n cycles through other sessions\' files, newest first, then back to this one', async ($, on) => {
  const dir = '/h/.claude/swimtrace/sessions'
  const other = (id: string, project: string) => JSON.stringify({
    v: 1, simulated: false, session: { id, project, startedAt: 1_000 }, writtenAt: 9_000, agents: [], tasks: [], workflows: {},
    folded: { completed: 0, failed: 0, interrupted: 0, killed: 0, unknown: 0 },
  })
  const entry = (name: string, mtimeMs: number) => ({ name, kind: 'file' as const, size: 1, mtimeMs, isLink: false })
  await boot($, on, 'terminal', () => {
    on('fs.list', () => ({ value: [entry('s.json', 9_500), entry('old.json', 5_000), entry('new.json', 8_000), entry('junk.json', 7_000)] }))
  }, { [`${dir}/old.json`]: other('old-sess', '/w/older'), [`${dir}/new.json`]: other('new-sess', '/w/newer'), [`${dir}/junk.json`]: '{"v":2}' })
  const ui = await $.ui.mount({ plugin: 'swimtrace', surface: 'terminal', ...PANE })
  const header = async () => (await ui.find({ type: 'Text', text: /session / }))?.text
  expect(await header()).toContain('proj  session s')
  await ui.press({ key: 'session' })
  expect(await header()).toContain('newer  session new-sess')
  await ui.press({ key: 'session' }) // junk.json is no snapshot: skipped
  expect(await header()).toContain('older  session old-sess')
  await ui.press({ key: 'session' })
  expect(await header()).toContain('proj  session s')
  await ui.unmount()
})
