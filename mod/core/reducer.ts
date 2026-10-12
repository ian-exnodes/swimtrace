import type { Agent, ListStatus, Snapshot, Status, TaskStatus } from './model.ts'
import { MAX_FINISHED, isLive } from './model.ts'

export type Event =
  | { kind: 'spawn'; at: number; id: string; type: string; description: string; parentId?: string; name?: string; workflowRunId?: string }
  | { kind: 'toolCall'; at: number; agentId: string; tool: string }
  | { kind: 'runEnd'; at: number; agentId: string; reason: 'answer' | 'aborted' | 'refusal' | 'error' }
  | { kind: 'mainTurn'; at: number; phase: 'start' | 'end' }
  | { kind: 'listStatus'; at: number; agentId: string; status: ListStatus; type: string; description: string; parentId?: string; name?: string }
  | { kind: 'taskCreate'; id: string; subject: string }
  | { kind: 'taskUpdate'; id: string; subject?: string; status?: TaskStatus | 'deleted'; addBlockedBy?: string[] }
  | { kind: 'workflowName'; runId: string; name: string }
  | { kind: 'sessionEnd'; at: number; reason: string }
  | { kind: 'tick'; at: number; staleWorkflowMs: number }

const REQUIRED: Record<Event['kind'], Record<string, 'string' | 'number'>> = {
  spawn: { at: 'number', id: 'string', type: 'string', description: 'string' },
  toolCall: { at: 'number', agentId: 'string', tool: 'string' },
  runEnd: { at: 'number', agentId: 'string', reason: 'string' },
  mainTurn: { at: 'number', phase: 'string' },
  listStatus: { at: 'number', agentId: 'string', status: 'string', type: 'string', description: 'string' },
  taskCreate: { id: 'string', subject: 'string' },
  taskUpdate: { id: 'string' },
  workflowName: { runId: 'string', name: 'string' },
  sessionEnd: { at: 'number', reason: 'string' },
  tick: { at: 'number', staleWorkflowMs: 'number' },
}

// Allowed values for enum-like fields, checked after the type check. Optional fields may be absent.
const ENUMS: Partial<Record<Event['kind'], Record<string, readonly string[]>>> = {
  runEnd: { reason: ['answer', 'aborted', 'refusal', 'error'] },
  mainTurn: { phase: ['start', 'end'] },
  listStatus: { status: ['pending', 'running', 'waiting', 'idle', 'completed', 'failed', 'killed'] },
  taskUpdate: { status: ['pending', 'in_progress', 'completed', 'deleted'] },
}

export function isEvent(x: unknown): x is Event {
  if (typeof x !== 'object' || x === null) return false
  const ev = x as Record<string, unknown>
  if (typeof ev.kind !== 'string' || !Object.hasOwn(REQUIRED, ev.kind)) return false
  const kind = ev.kind as Event['kind']
  const typesOk = Object.entries(REQUIRED[kind]).every(([k, t]) => typeof ev[k] === t && (t !== 'number' || Number.isFinite(ev[k])))
  if (!typesOk) return false
  const enums = ENUMS[kind]
  if (enums !== undefined && !Object.entries(enums).every(([k, allowed]) => ev[k] === undefined || allowed.includes(ev[k] as string))) return false
  if (kind === 'taskUpdate' && ev.addBlockedBy !== undefined) {
    if (!Array.isArray(ev.addBlockedBy) || !ev.addBlockedBy.every(x => typeof x === 'string')) return false
  }
  return true
}

const END_STATUS: Record<'answer' | 'aborted' | 'refusal' | 'error', Status> = {
  answer: 'completed', aborted: 'interrupted', refusal: 'failed', error: 'failed',
}

// A workflow agent the tick marked unknown for silence alone: its own toolCall or runEnd still lands.
// Unknown for any other reason (the session ended) is final.
const staleUnknown = (a: Agent): boolean => a.status === 'unknown' && a.endReason === 'stale'

// Returns `s` itself when `fn` changed nothing: the collector relies on that to skip idle writes.
function mapAgent(s: Snapshot, id: string, fn: (a: Agent) => Agent): Snapshot {
  let changed = false
  const agents = s.agents.map(a => {
    if (a.id !== id) return a
    const n = fn(a)
    if (n !== a) changed = true
    return n
  })
  return changed ? { ...s, agents } : s
}

function apply(s: Snapshot, ev: Event): Snapshot {
  const known = (id: string) => s.agents.some(a => a.id === id)
  switch (ev.kind) {
    case 'spawn': {
      if (known(ev.id)) return s // dedupe
      const a: Agent = {
        id: ev.id, parentId: ev.parentId, type: ev.type, description: ev.description, name: ev.name,
        workflowRunId: ev.workflowRunId, status: 'running', startedAt: ev.at, lastSeenAt: ev.at,
      }
      return { ...s, agents: [...s.agents, a] }
    }
    case 'toolCall':
      if (!known(ev.agentId)) return s
      return mapAgent(s, ev.agentId, a => {
        if (isLive(a.status)) return { ...a, currentTool: ev.tool, lastSeenAt: ev.at }
        if (!staleUnknown(a)) return a
        const { endedAt: _e, endReason: _r, ...rest } = a // it was only silent: back to running
        return { ...rest, status: 'running', currentTool: ev.tool, lastSeenAt: ev.at }
      })
    case 'runEnd': {
      const status = END_STATUS[ev.reason]
      if (status === undefined || !known(ev.agentId) || ev.agentId === 'main') return s
      return mapAgent(s, ev.agentId, a => (isLive(a.status) || staleUnknown(a)
        ? { ...a, status, endedAt: ev.at, endReason: ev.reason, currentTool: undefined, lastSeenAt: ev.at }
        : a))
    }
    case 'mainTurn':
      return mapAgent(s, 'main', a => {
        const status: Status = ev.phase === 'start' ? 'running' : 'waiting'
        if (a.status === status && (ev.phase === 'start' || a.currentTool === undefined)) return a
        return { ...a, status, lastSeenAt: ev.at, currentTool: ev.phase === 'end' ? undefined : a.currentTool }
      })
    case 'listStatus': {
      if (!known(ev.agentId)) {
        const live = ev.status === 'running' || ev.status === 'pending' || ev.status === 'waiting' || ev.status === 'idle'
        const a: Agent = {
          id: ev.agentId, parentId: ev.parentId, type: ev.type, description: ev.description, name: ev.name,
          status: live ? (ev.status === 'waiting' || ev.status === 'idle' ? 'waiting' : 'running') : listEnd(ev.status),
          startedAt: ev.at, lastSeenAt: ev.at, endedAt: live ? undefined : ev.at,
          endReason: ev.status === 'killed' ? 'killed' : undefined,
        }
        return { ...s, agents: [...s.agents, a] }
      }
      return mapAgent(s, ev.agentId, a => {
        if (!isLive(a.status)) return a // finished is final
        switch (ev.status) {
          case 'killed': return { ...a, status: 'killed', endedAt: ev.at, endReason: 'killed', currentTool: undefined }
          case 'completed': case 'failed': return { ...a, status: ev.status, endedAt: ev.at, currentTool: undefined }
          case 'waiting': case 'idle': return a.status === 'waiting' ? a : { ...a, status: 'waiting' }
          default: return a.status === 'running' ? a : { ...a, status: 'running' }
        }
      })
    }
    case 'taskCreate':
      if (s.tasks.some(t => t.id === ev.id)) return s
      return { ...s, tasks: [...s.tasks, { id: ev.id, subject: ev.subject, status: 'pending', blockedBy: [] }] }
    case 'taskUpdate': {
      if (ev.status === 'deleted') return { ...s, tasks: s.tasks.filter(t => t.id !== ev.id) }
      const base = s.tasks.find(t => t.id === ev.id) ?? { id: ev.id, subject: ev.id, status: 'pending' as TaskStatus, blockedBy: [] }
      const next = {
        ...base,
        subject: ev.subject ?? base.subject,
        status: ev.status ?? base.status,
        blockedBy: [...new Set([...base.blockedBy, ...(ev.addBlockedBy ?? [])])],
      }
      return { ...s, tasks: s.tasks.some(t => t.id === ev.id) ? s.tasks.map(t => (t.id === ev.id ? next : t)) : [...s.tasks, next] }
    }
    case 'workflowName':
      return { ...s, workflows: { ...s.workflows, [ev.runId]: ev.name } }
    case 'sessionEnd':
      return {
        ...s,
        session: { ...s.session, endedAt: ev.at, endReason: ev.reason },
        agents: s.agents.map(a => {
          if (!isLive(a.status)) return a
          if (a.id === 'main') return { ...a, status: 'completed', endedAt: ev.at, endReason: 'session-end', currentTool: undefined }
          return { ...a, status: 'unknown', endedAt: ev.at, endReason: 'session-end', currentTool: undefined }
        }),
      }
    case 'tick': {
      const isStale = (a: Agent) => a.workflowRunId !== undefined && isLive(a.status) && ev.at - a.lastSeenAt > ev.staleWorkflowMs
      if (!s.agents.some(isStale)) return s
      return {
        ...s,
        agents: s.agents.map(a => (isStale(a) ? { ...a, status: 'unknown', endedAt: a.lastSeenAt, endReason: 'stale', currentTool: undefined } : a)),
      }
    }
    default:
      return s
  }
}

const listEnd = (st: ListStatus): Status => (st === 'killed' ? 'killed' : st === 'failed' ? 'failed' : 'completed')

function fold(s: Snapshot): Snapshot {
  const finished = s.agents.filter(a => !isLive(a.status))
  const extra = finished.length - MAX_FINISHED
  if (extra <= 0) return s
  const drop = new Set(finished.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0)).slice(0, extra).map(a => a.id))
  const folded = { ...s.folded }
  for (const a of s.agents) if (drop.has(a.id)) folded[a.status as keyof typeof folded] += 1
  return { ...s, agents: s.agents.filter(a => !drop.has(a.id)), folded }
}

export function reduce(s: Snapshot, ev: unknown): Snapshot {
  if (!isEvent(ev)) return s
  const next = apply(s, ev)
  return next === s ? s : fold(next)
}

export function reduceAll(s: Snapshot, evs: readonly unknown[]): Snapshot {
  return evs.reduce<Snapshot>(reduce, s)
}
