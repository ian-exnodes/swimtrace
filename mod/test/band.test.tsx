import { test, expect, mock } from 'claude-code/testing'

// What the surface hands an AbovePrompt render hook: every field of the band's props, the body 100 cells wide.
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 100, scroll: { offset: 0, bodyRows: 39 }, view: {} },
} as const
const RUN = { command: 'swimtrace', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

const SPAWN = { tool_use_id: 'tu-1', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm', background: false, fork: false } as const

// The test's hooks stand for the engine; the kit takes them only before its first call on `$`.
async function boot($: any, on: any, surface: 'terminal' | 'desktop', hooks: () => void = () => {}, files: Record<string, string> = {}, spawn = true) {
  const clock = mock.clock(on, { now: 10_000 })
  mock.env(on, { HOME: '/h' })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', ($: any, e: any) => (e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }))
  on('session.id', () => ({ value: 's' }))
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }))
  on('ui.render', ($: any, e: any) => { const { Box } = $.ui.resolve(e); return <Box /> }) // the engine's own band when the mod passes: empty
  hooks()
  await $.session.start({ cwd: '/w/proj', surface, isInteractive: true })
  if (spawn) await $.agent.spawn({ ...SPAWN, prompt: 'p', description: 'scan repo', subagentType: 'Explore' })
  return { clock }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the band draws the flow and toggles the pools view on ${surface}`, async ($, on) => {
    await boot($, on, surface)
    const ui = await $.ui.mount({ plugin: 'swimtrace', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /SWIMTRACE/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 agent · 1 running/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\[● scan repo 0s\]$/ })).toBeDefined() // the flow is the default
    expect(await ui.find({ type: 'Text', text: /^───▶$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Explore · type/ })).toBeUndefined()
    expect((await ui.find({ type: 'Button', key: 'view' }))?.text).toBe('pools')
    await ui.press({ key: 'view' })
    expect(await ui.find({ type: 'Text', text: /Explore · type/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /scan repo/ })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'view' }))?.text).toBe('flow')
    await ui.press({ key: 'view' })
    expect(await ui.find({ type: 'Text', text: /Explore · type/ })).toBeUndefined()
    await ui.unmount()
  })
}

test('/swimtrace registers on session start and toggles the band; no pane is ever opened', async ($, on) => {
  const opened: string[] = []
  const registered: string[] = []
  await boot($, on, 'terminal', () => {
    on('command.register', ($: any, e: any) => { registered.push(e.name); return { value: { command: e.name } } })
    on('ui.open', ($: any, e: any) => { opened.push(e.id); return { value: { isPlaced: true } } })
  })
  expect(registered).toEqual(['swimtrace'])
  const ui = await $.ui.mount({ plugin: 'swimtrace', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /SWIMTRACE/ })).toBeDefined() // shown unasked once a subagent ran
  expect((await $.command.run(RUN)).text).toBe('SwimTrace hidden.')
  await ui.redraw(BAND.props)
  expect(await ui.find({ type: 'Text', text: /SWIMTRACE/ })).toBeUndefined()
  expect((await $.command.run(RUN)).text).toBe('SwimTrace shown above the prompt.')
  await ui.redraw(BAND.props)
  expect(await ui.find({ type: 'Text', text: /SWIMTRACE/ })).toBeDefined()
  expect(opened).toEqual([])
  await ui.unmount()
})

test('the band passes while there are no subagents, and while a survey holds it', async ($, on) => {
  await boot($, on, 'terminal', () => {}, {}, false)
  const ui = await $.ui.mount({ plugin: 'swimtrace', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /SWIMTRACE/ })).toBeUndefined() // main alone draws nothing
  expect((await $.command.run(RUN)).text).toBe('SwimTrace hidden.')
  expect((await $.command.run(RUN)).text).toBe('SwimTrace shown above the prompt (it appears once agents run).')
  await $.agent.spawn({ ...SPAWN, prompt: 'p', description: 'scan repo', subagentType: 'Explore' })
  await ui.redraw(BAND.props)
  expect(await ui.find({ type: 'Text', text: /SWIMTRACE/ })).toBeDefined()
  await ui.redraw({ ...BAND.props, hasSurvey: true })
  expect(await ui.find({ type: 'Text', text: /SWIMTRACE/ })).toBeUndefined()
  await ui.unmount()
})

test('band colors are theme keys, never raw ANSI names', async ($, on) => {
  await boot($, on, 'terminal')
  const ui = await $.ui.mount({ plugin: 'swimtrace', surface: 'terminal', ...BAND })
  const bar = await ui.find({ type: 'Text', text: /^\[● scan repo/ })
  expect(bar?.props.color).toBe('suggestion')
  const colors = (await ui.findAll({ type: 'Text' })).map(t => t.props.color).filter(c => c !== undefined)
  expect(colors.length).toBeGreaterThan(0)
  for (const raw of ['yellow', 'cyan', 'gray', 'green', 'red', 'magenta']) expect(colors).not.toContain(raw)
  await ui.unmount()
})

test('j and k walk the selection in drawn order; d shows the selected agent', async ($, on) => {
  await boot($, on, 'terminal')
  const ui = await $.ui.mount({ plugin: 'swimtrace', surface: 'terminal', ...BAND })
  const detail = async () => (await ui.find({ type: 'Text', text: /^id \S+ / }))?.text.split(' ')[1]
  await ui.press({ key: 'details' })
  expect(await detail()).toBeUndefined() // nothing selected yet
  await ui.press({ key: 'next' })
  expect(await detail()).toBe('main') // main is the flow's first node
  await ui.press({ key: 'next' })
  expect(await detail()).toBe('a1')
  await ui.press({ key: 'next' }) // at the end: stays
  expect(await detail()).toBe('a1')
  await ui.press({ key: 'prev' })
  expect(await detail()).toBe('main')
  await ui.unmount()
})

test('the 1 s tick redraws only while the band has agents to show', async ($, on) => {
  let redraws = 0
  const { clock } = await boot($, on, 'terminal', () => {
    on('ui.invalidate', ($: any, e: any) => { if (e === 'ui.render' || e?.event === 'ui.render') redraws++; return { value: undefined } })
  }, {}, false)
  await clock.advance(1_000)
  expect(redraws).toBe(0) // no subagents yet
  await $.agent.spawn({ ...SPAWN, prompt: 'p', description: 'scan repo', subagentType: 'Explore' })
  await clock.advance(1_000)
  expect(redraws).toBeGreaterThan(0)
  await $.command.run(RUN) // hidden
  const before = redraws
  await clock.advance(1_000)
  expect(redraws).toBe(before)
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
  const ui = await $.ui.mount({ plugin: 'swimtrace', surface: 'terminal', ...BAND })
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

const DIR = '/h/.claude/swimtrace/sessions'
const sessionFile = (id: string, project: string, agents: unknown[] = []) => JSON.stringify({
  v: 1, simulated: false, session: { id, project, startedAt: 1_000 }, writtenAt: 9_000, agents, tasks: [], workflows: {},
  folded: { completed: 0, failed: 0, interrupted: 0, killed: 0, unknown: 0 },
})
const fileEntry = (name: string, mtimeMs: number) => ({ name, kind: 'file' as const, size: 1, mtimeMs, isLink: false })

test('an unreadable other-session file draws this session with a note, keeps the buttons, and showing again resets the pick', async ($, on) => {
  await boot($, on, 'terminal', () => {
    on('fs.list', () => ({ value: [fileEntry('bad.json', 8_000)] }))
  }, { [`${DIR}/bad.json`]: sessionFile('bad-sess', '/w/bad', [null]) })
  const ui = await $.ui.mount({ plugin: 'swimtrace', surface: 'terminal', ...BAND })
  await ui.press({ key: 'session' })
  expect(await ui.find({ type: 'Text', text: /swimtrace: other session unreadable \(bad\.json\)/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /SWIMTRACE/ })) !== undefined).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^\[● scan repo/ })).toBeDefined() // this session's flow
  expect(await ui.find({ type: 'Button', key: 'session' })).toBeDefined()
  await ui.press({ key: 'next' }) // handlers survive the bad file too
  await $.command.run(RUN) // hide
  await $.command.run(RUN) // show again: back at this session
  await ui.redraw(BAND.props)
  expect(await ui.find({ type: 'Text', text: /unreadable/ })).toBeUndefined()
  await ui.press({ key: 'session' }) // still pressable: picks the bad file again
  expect(await ui.find({ type: 'Text', text: /unreadable/ })).toBeDefined()
  await ui.press({ key: 'session' }) // and back to this session
  expect(await ui.find({ type: 'Text', text: /unreadable/ })).toBeUndefined()
  await ui.press({ key: 'session' })
  await ui.redraw({ ...BAND.props, bodyColumns: 20 })
  expect((await ui.find({ type: 'Text', text: /^swimtrace: other/ }))?.text).toBe('swimtrace: other ses') // clipped to the body
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a 40-column band wraps its buttons and every one still works on ${surface}`, async ($, on) => {
    await boot($, on, surface, () => {
      on('fs.list', () => ({ value: [fileEntry('other.json', 8_000)] }))
    }, { [`${DIR}/other.json`]: sessionFile('other-sess', '/w/other') })
    const ui = await $.ui.mount({ plugin: 'swimtrace', surface, ...BAND, props: { ...BAND.props, bodyColumns: 40 } })
    // The kit lays nothing out (it never paints), so the wrap is asserted on the tree the surface gets.
    expect(JSON.stringify(await ui.drawn())).toContain('"flexWrap":"wrap"')
    await ui.press({ key: 'next' })
    await ui.press({ key: 'details' })
    expect(await ui.find({ type: 'Text', text: /^id main / })).toBeDefined()
    await ui.press({ key: 'session' })
    expect(await ui.find({ type: 'Text', text: /session other-se/ })).toBeDefined()
    await ui.unmount()
  })
}

test('final fix 2: the band never draws its own live session as stale, however long it runs', async ($, on) => {
  const { clock } = await boot($, on, 'terminal')
  await clock.advance(20_000) // past the 15 s staleness window
  const ui = await $.ui.mount({ plugin: 'swimtrace', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /STALE/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^\[● scan repo 20s\]$/ })).toBeDefined()
  await ui.press({ key: 'running' })
  await ui.press({ key: 'details' })
  await ui.press({ key: 'next' })
  expect((await ui.find({ type: 'Text', text: /^id \S+ / }))?.text.split(' ')[1]).toBe('a1') // running-only list still has it
  await ui.unmount()
})

test('a short, narrow band draws its buttons first, inside the rows it may take', async ($, on) => {
  await boot($, on, 'terminal')
  const ui = await $.ui.mount({ plugin: 'swimtrace', surface: 'terminal', ...BAND, props: { ...BAND.props, maxRows: 6, bodyColumns: 40 } })
  await ui.press({ key: 'view' }) // the pools view: two lanes, more rows than the band may take (the flow is main and one agent)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn.indexOf('"hotkey":"g"')).toBeGreaterThan(-1)
  expect(drawn.indexOf('"hotkey":"g"')).toBeLessThan(drawn.indexOf('SWIMTRACE'))
  expect(await ui.find({ type: 'Text', text: /more rows/ })).toBeDefined() // the rows were cut to fit, not the buttons
  await ui.unmount()
})
