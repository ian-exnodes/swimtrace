export type Status = 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'killed' | 'unknown'
export type EndReason = 'answer' | 'aborted' | 'refusal' | 'error' | 'killed' | 'stale' | 'session-end'
export type PoolSource = 'config' | 'explicit' | 'workflow' | 'type' | 'main'
export type ListStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'
export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export interface Agent {
  id: string // 'main' for the main loop
  parentId?: string
  type: string
  description: string // the Agent call's short label; never the prompt
  name?: string
  workflowRunId?: string
  status: Status
  startedAt: number
  endedAt?: number
  endReason?: EndReason
  currentTool?: string // tool NAME only
  lastSeenAt: number
  model?: string // from the spawn result
  tools?: string[] // distinct tool NAMES in first-use order, at most MAX_TOOLS
}

export interface Task { id: string; subject: string; status: TaskStatus; blockedBy: string[] }

export interface Session { id: string; project: string; startedAt: number; endedAt?: number; endReason?: string }

// A main turn: timestamps only, never the prompt.
export interface Turn { startedAt: number; endedAt?: number }

export interface Folded { completed: number; failed: number; interrupted: number; killed: number; unknown: number }

/** This release, as in package.json and mod/.claude-plugin/plugin.json (a test keeps the three equal). */
export const VERSION = '0.1.4'

export interface Snapshot {
  v: 1
  by?: string // VERSION of the plugin that wrote the file; older files have none
  simulated: boolean
  session: Session
  writtenAt: number
  agents: Agent[]
  tasks: Task[]
  workflows: Record<string, string> // runId → workflow meta.name
  folded: Folded
  turns: Turn[] // main's turns, oldest first, at most MAX_TURNS; files written before turns existed have none
}

export const MAX_FINISHED = 200
export const MAX_TOOLS = 20
export const MAX_TURNS = 20
export const STALE_SESSION_MS = 15_000
export const DEFAULT_STALE_WORKFLOW_MS = 600_000

export const isLive = (s: Status): boolean => s === 'running' || s === 'waiting'

export function emptySnapshot(session: Session, simulated = false): Snapshot {
  const main: Agent = {
    id: 'main', type: 'main', description: 'main', status: 'waiting',
    startedAt: session.startedAt, lastSeenAt: session.startedAt,
  }
  return {
    v: 1, simulated, session, writtenAt: session.startedAt, agents: [main], tasks: [], workflows: {},
    folded: { completed: 0, failed: 0, interrupted: 0, killed: 0, unknown: 0 }, turns: [],
  }
}
