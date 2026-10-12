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

export function isEvent(x: unknown): x is Event {
  if (typeof x !== 'object' || x === null) return false
  const ev = x as Record<string, unknown>
  const need = REQUIRED[ev.kind as Event['kind']]
  if (need === undefined) return false
  return Object.entries(need).every(([k, t]) => typeof ev[k] === t && (t !== 'number' || Number.isFinite(ev[k])))
}

const END_STATUS: Record<'answer' | 'aborted' | 'refusal' | 'error', Status> = {
  answer: 'completed', aborted: 'interrupted', refusal: 'failed', error: 'failed',
}

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
      return mapAgent(s, ev.agentId, a => ({ ...a, currentTool: ev.tool, lastSeenAt: ev.at }))
    case 'runEnd': {
      const status = END_STATUS[ev.reason]
      if (status === undefined || !known(ev.agentId) || ev.agentId === 'main') return s
      return mapAgent(s, ev.agentId, a => (isLive(a.status)
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

export function reduce(s: Snapshot, ev: unknown): Snapshot {
  if (!isEvent(ev)) return s
  return apply(s, ev)
}

export function reduceAll(s: Snapshot, evs: readonly unknown[]): Snapshot {
  return evs.reduce<Snapshot>(reduce, s)
}
