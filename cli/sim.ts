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
const task = (id: string, subject: string): Event => ({ kind: 'taskCreate', id, subject })
const moved = (id: string, status: 'in_progress' | 'completed'): Event => ({ kind: 'taskUpdate', id, status })

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

// The orchestration stages: a turn plans for ~1.5 s, dispatches two Explore agents (the first tagged [class:complex]) and a
// workflow run (review:perf fails, verify:bugs follows review:bugs), moves five tasks along; then a short second turn.
const WF = { workflowRunId: 'wf_orch' }
const orchestrated: Step[] = [
  { after: 0, ev: turn('start') },
  { after: 300, ev: tool('main', 'TaskCreate') },
  { after: 100, ev: task('1', 'List source files') }, { after: 50, ev: task('2', 'Count test files') },
  { after: 50, ev: task('3', 'Review for bugs') }, { after: 50, ev: task('4', 'Review for performance') },
  { after: 50, ev: task('5', 'Verify the findings') },
  { after: 900, ev: tool('main', 'Agent') },
  { after: 0, ev: sp('t1', 'Explore', '[T1] Explore — list files in src [class:complex]', { model: 'claude-haiku-4-5' }) },
  { after: 200, ev: sp('t2', 'Explore', '[T2] Explore — count test files', { model: 'claude-haiku-4-5' }) },
  { after: 100, ev: moved('1', 'in_progress') }, { after: 0, ev: moved('2', 'in_progress') },
  { after: 400, ev: tool('t1', 'Glob') }, { after: 300, ev: tool('t2', 'Grep') },
  { after: 500, ev: tool('main', 'Workflow') },
  { after: 100, ev: { kind: 'workflowName', runId: 'wf_orch', name: 'review-changes' } },
  { after: 200, ev: sp('r1', 'general-purpose', 'review:bugs', { ...WF, model: 'claude-sonnet-4-5' }) },
  { after: 100, ev: sp('r2', 'general-purpose', 'review:perf', { ...WF, model: 'claude-sonnet-4-5' }) },
  { after: 0, ev: moved('3', 'in_progress') }, { after: 0, ev: moved('4', 'in_progress') },
  { after: 600, ev: tool('t1', 'Read') }, { after: 300, ev: tool('r1', 'Read') }, { after: 300, ev: tool('r2', 'Grep') },
  { after: 1500, ev: end('t2', 'answer') }, { after: 0, ev: moved('2', 'completed') },
  { after: 1000, ev: end('t1', 'answer') }, { after: 0, ev: moved('1', 'completed') },
  { after: 1200, ev: tool('r1', 'Grep') },
  { after: 1300, ev: end('r2', 'error') }, // the perf review fails; its task stays in progress
  { after: 1200, ev: end('r1', 'answer') }, { after: 0, ev: moved('3', 'completed') },
  { after: 300, ev: sp('v1', 'general-purpose', 'verify:bugs', { ...WF, model: 'claude-haiku-4-5' }) }, { after: 0, ev: moved('5', 'in_progress') },
  { after: 500, ev: tool('v1', 'Grep') }, { after: 1200, ev: tool('v1', 'Bash') },
  { after: 1200, ev: end('v1', 'answer') }, { after: 0, ev: moved('5', 'completed') },
  { after: 400, ev: turn('end') },
  { after: 1200, ev: turn('start') },
  { after: 1000, ev: tool('main', 'Agent') },
  { after: 0, ev: sp('t3', 'Explore', '[T6] Explore — summarize the review', { model: 'claude-haiku-4-5' }) },
  { after: 500, ev: tool('t3', 'Read') },
  { after: 1500, ev: end('t3', 'answer') },
  { after: 300, ev: turn('end') },
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
    { after: 200, ev: sp('w1', 'reviewer', 'review:correctness', { workflowRunId: 'wf_sim', model: 'claude-sonnet-4-5' }) },
    { after: 100, ev: sp('w2', 'reviewer', 'review:security', { workflowRunId: 'wf_sim', model: 'claude-sonnet-4-5' }) },
    { after: 2500, ev: end('w1', 'answer') },
    { after: 200, ev: sp('w3', 'general-purpose', 'verify:correctness', { workflowRunId: 'wf_sim', model: 'claude-haiku-4-5' }) },
    { after: 1500, ev: end('w2', 'answer') },
    { after: 200, ev: sp('w4', 'general-purpose', 'verify:security', { workflowRunId: 'wf_sim', model: 'claude-haiku-4-5' }) },
    { after: 2000, ev: end('w3', 'answer') },
  ] }] },
  'multi-session': { sessions: [
    { id: 'sim-multi-a', project: '/sim/project-alpha', steps: fanout },
    { id: 'sim-multi-b', project: '/sim/project-delta', steps: [
      { after: 0, ev: turn('start') }, { after: 700, ev: sp('p', 'Plan', 'plan refactor') }, { after: 4000, ev: end('p', 'answer') }, { after: 200, ev: turn('end') },
    ] },
  ] },
  orchestrated: { sessions: [{ id: 'sim-orchestrated', project: '/sim/project-zeta', steps: orchestrated }] },
  crash: { stopWritingAfterMs: 3000, sessions: [{ id: 'sim-crash', project: '/sim/project-epsilon', steps: [
    { after: 0, ev: turn('start') }, { after: 500, ev: sp('c1', 'Explore', 'scan before crash') }, { after: 500, ev: tool('c1', 'Grep') },
  ] }] },
}

const resolve = (ev: Step['ev'], now: number): Event => (typeof ev === 'function' ? ev(now) : ev)

/** Each session's snapshot after its steps, or (`untilMs`) as it stands that far in. */
export function playInstant(name: string, start: number, untilMs = Infinity): Snapshot[] {
  const sc = SCENARIOS[name]
  if (!sc) throw new Error(`unknown scenario ${name}`)
  return sc.sessions.map(({ id, project, steps }) => {
    let now = start
    let s = emptySnapshot({ id, project, startedAt: start }, true)
    for (const st of steps) {
      if (now + st.after - start > untilMs) break
      now += st.after
      s = reduce(s, resolve(st.ev, now))
    }
    return { ...s, writtenAt: untilMs === Infinity ? now : start + untilMs }
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
