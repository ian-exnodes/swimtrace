import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { emptySnapshot, type Snapshot } from '../mod/core/model.ts'
import { reduce, type Event } from '../mod/core/reducer.ts'

export type Step = { after: number; ev: Event | ((now: number) => Event) }
type Scenario = { sessions: { id: string; project: string; steps: Step[] }[]; stopWritingAfterMs?: number }

const sp = (id: string, type: string, description: string, extra: Partial<Extract<Event, { kind: 'spawn' }>> = {}) =>
  (now: number): Event => ({ kind: 'spawn', at: now, id, type, description, ...extra })
const end = (agentId: string, reason: 'answer' | 'error' | 'aborted' | 'refusal') =>
  (now: number): Event => ({ kind: 'runEnd', at: now, agentId, reason })
const tool = (agentId: string, t: string) => (now: number): Event => ({ kind: 'toolCall', at: now, agentId, tool: t })
const turn = (phase: 'start' | 'end') => (now: number): Event => ({ kind: 'mainTurn', at: now, phase })

const fanout: Step[] = [
  { after: 0, ev: turn('start') },
  { after: 500, ev: sp('e1', 'Explore', 'map auth module') },
  { after: 100, ev: sp('e2', 'Explore', 'map billing module') },
  { after: 100, ev: sp('e3', 'Explore', 'map api routes') },
  { after: 1500, ev: tool('e1', 'Grep') }, { after: 300, ev: tool('e2', 'Read') }, { after: 300, ev: tool('e3', 'Glob') },
  { after: 3000, ev: end('e2', 'answer') }, { after: 1500, ev: end('e1', 'answer') }, { after: 1000, ev: end('e3', 'answer') },
  { after: 800, ev: sp('rv', 'reviewer', '[pool:Review] review findings') },
  { after: 500, ev: tool('rv', 'Read') },
]

export const SCENARIOS: Record<string, Scenario> = {
  fanout: { sessions: [{ id: 'sim-fanout', project: '/sim/project-alpha', steps: fanout }] },
  failure: { sessions: [{ id: 'sim-failure', project: '/sim/project-beta', steps: [
    { after: 0, ev: turn('start') },
    { after: 300, ev: sp('ok', 'implementer', 'add endpoint') },
    { after: 100, ev: sp('bad', 'implementer', 'migrate db') },
    { after: 100, ev: sp('stop', 'Explore', 'long scan') },
    { after: 100, ev: sp('kill', 'Explore', 'stuck scan') },
    { after: 2000, ev: end('bad', 'error') },
    { after: 1000, ev: end('stop', 'aborted') },
    { after: 1000, ev: (now: number): Event => ({ kind: 'listStatus', at: now, agentId: 'kill', status: 'killed', type: 'Explore', description: 'stuck scan' }) },
    { after: 1000, ev: end('ok', 'answer') },
  ] }] },
  workflow: { sessions: [{ id: 'sim-workflow', project: '/sim/project-gamma', steps: [
    { after: 0, ev: turn('start') },
    { after: 200, ev: { kind: 'workflowName', runId: 'wf_sim', name: 'review-changes' } },
    { after: 200, ev: sp('w1', 'reviewer', 'review:correctness', { workflowRunId: 'wf_sim' }) },
    { after: 100, ev: sp('w2', 'reviewer', 'review:security', { workflowRunId: 'wf_sim' }) },
    { after: 2500, ev: end('w1', 'answer') },
    { after: 200, ev: sp('w3', 'general-purpose', 'verify:correctness', { workflowRunId: 'wf_sim' }) },
    { after: 1500, ev: end('w2', 'answer') },
    { after: 200, ev: sp('w4', 'general-purpose', 'verify:security', { workflowRunId: 'wf_sim' }) },
    { after: 2000, ev: end('w3', 'answer') },
  ] }] },
  'multi-session': { sessions: [
    { id: 'sim-multi-a', project: '/sim/project-alpha', steps: fanout },
    { id: 'sim-multi-b', project: '/sim/project-delta', steps: [
      { after: 0, ev: turn('start') }, { after: 700, ev: sp('p', 'Plan', 'plan refactor') }, { after: 4000, ev: end('p', 'answer') }, { after: 200, ev: turn('end') },
    ] },
  ] },
  crash: { stopWritingAfterMs: 3000, sessions: [{ id: 'sim-crash', project: '/sim/project-epsilon', steps: [
    { after: 0, ev: turn('start') }, { after: 500, ev: sp('c1', 'Explore', 'scan before crash') }, { after: 500, ev: tool('c1', 'Grep') },
  ] }] },
}

const resolve = (ev: Step['ev'], now: number): Event => (typeof ev === 'function' ? ev(now) : ev)

export function playInstant(name: string, start: number): Snapshot[] {
  const sc = SCENARIOS[name]
  if (!sc) throw new Error(`unknown scenario ${name}`)
  return sc.sessions.map(({ id, project, steps }) => {
    let now = start
    let s = emptySnapshot({ id, project, startedAt: start }, true)
    for (const st of steps) { now += st.after; s = reduce(s, resolve(st.ev, now)) }
    return { ...s, writtenAt: now }
  })
}

export async function runSim(name: string, dir: string, speed: number, view: (dir: string) => Promise<number>): Promise<number> {
  const sc = SCENARIOS[name]
  if (!sc) { console.error(`unknown scenario "${name}"; choose: ${Object.keys(SCENARIOS).join(', ')}`); return 1 }
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const t0 = Date.now()
  const timers: NodeJS.Timeout[] = []
  for (const { id, project, steps } of sc.sessions) {
    let s = emptySnapshot({ id, project, startedAt: t0 }, true)
    const path = join(dir, `${id}.json`)
    const write = () => {
      if (sc.stopWritingAfterMs !== undefined && Date.now() - t0 > sc.stopWritingAfterMs / speed) return // simulated crash: heartbeat stops
      writeFileSync(path, JSON.stringify({ ...s, writtenAt: Date.now() }))
    }
    let at = 0
    for (const st of steps) {
      at += st.after / speed
      timers.push(setTimeout(() => { s = reduce(s, resolve(st.ev, Date.now())); write() }, at))
    }
    timers.push(setInterval(write, 1000))
    write()
  }
  try { return await view(dir) } finally { timers.forEach(clearTimeout) }
}
