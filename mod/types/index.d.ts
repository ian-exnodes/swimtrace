// The swimtrace $.state contract. A contract must be self-contained (no import), so these are copies of
// the core's Snapshot and ConfigJson; hooks/register.tsx asserts at the type level that they stay identical.

export type SwimtraceStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'killed' | 'unknown'
export type SwimtraceEndReason = 'answer' | 'aborted' | 'refusal' | 'error' | 'killed' | 'stale' | 'session-end'
export type SwimtraceTaskStatus = 'pending' | 'in_progress' | 'completed'

export interface SwimtraceAgent {
  id: string
  parentId?: string
  type: string
  description: string
  name?: string
  workflowRunId?: string
  status: SwimtraceStatus
  startedAt: number
  endedAt?: number
  endReason?: SwimtraceEndReason
  currentTool?: string
  lastSeenAt: number
}

export interface SwimtraceTask { id: string; subject: string; status: SwimtraceTaskStatus; blockedBy: string[] }

export interface SwimtraceSession { id: string; project: string; startedAt: number; endedAt?: number; endReason?: string }

export interface SwimtraceFolded { completed: number; failed: number; interrupted: number; killed: number; unknown: number }

export interface SwimtraceSnapshot {
  v: 1
  simulated: boolean
  session: SwimtraceSession
  writtenAt: number
  agents: SwimtraceAgent[]
  tasks: SwimtraceTask[]
  workflows: Record<string, string>
  folded: SwimtraceFolded
}

export type SwimtraceMatchKey = 'type' | 'name' | 'description' | 'project'
export interface SwimtraceRule { match: Partial<Record<SwimtraceMatchKey, string>>; pool: string }
export interface SwimtraceConfig { rules: SwimtraceRule[]; staleWorkflowAgentMinutes: number }

export type SwimtraceUi = { view: 'pool' | 'agent'; runningOnly: boolean; selectedId?: string; expanded: boolean; pick?: string }

declare module 'claude-code' {
  interface PluginState {
    swimtrace: { snap: SwimtraceSnapshot | undefined; config: SwimtraceConfig; ui: SwimtraceUi }
  }
}
