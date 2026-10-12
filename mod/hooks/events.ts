import type { Event } from '../core/reducer.ts'
import type { ListStatus } from '../core/model.ts'

// Pure mapping from engine event shapes to core events. Privacy: only tool NAMES, a task's subject and a
// workflow's name leave this file; never a prompt, a tool's input or output, or an answer.

type SpawnIn = {
  description: string; prompt: string; subagentType: string; parentAgentId?: string; name?: string
  workflow?: { runId: string; agentIndex: number }
}
// An unlabelled workflow agent() is spawned with its prompt (or a prefix of it) as the description. The prompt is
// read here only to recognise that; it is never stored.
const derivedFromPrompt = (description: string, prompt: string): boolean => {
  const d = description.trim(), p = prompt.trim()
  if (d === '') return false
  if (d === p.split('\n', 1)[0]!.trim()) return true
  const stem = d.replace(/(…|\.\.\.)$/, '').trimEnd()
  return stem !== '' && p.startsWith(stem)
}
export const spawnEvent = (e: SpawnIn, agentId: string, at: number): Event => ({
  kind: 'spawn', at, id: agentId, type: e.subagentType,
  description: derivedFromPrompt(e.description, e.prompt) ? (e.workflow ? `agent ${e.workflow.agentIndex}` : e.subagentType) : e.description,
  parentId: e.parentAgentId, name: e.name, workflowRunId: e.workflow?.runId || undefined,
})

type ToolIn = { tool: string; agentId?: string } & Record<string, unknown>
type ToolOut = { deny?: string; result?: unknown; isError?: boolean }
// Raised as the tool starts, so the agent's current tool is the one in progress.
export const toolCallEvent = (e: ToolIn, at: number): Event => ({ kind: 'toolCall', at, agentId: e.agentId ?? 'main', tool: e.tool })

// Raised once the tool settled: what its result adds (tasks, a workflow's name). Nothing for a refused or failed call.
export function toolResultEvents(e: ToolIn, ran: ToolOut): Event[] {
  const out: Event[] = []
  if (ran.deny !== undefined || ran.isError === true) return out
  const r = ran.result as Record<string, any> | undefined
  if (e.tool === 'TaskCreate' && typeof r?.task?.id === 'string') {
    out.push({ kind: 'taskCreate', id: r.task.id, subject: typeof e.subject === 'string' ? e.subject : String(r.task.subject) })
  }
  if (e.tool === 'TaskUpdate' && typeof e.taskId === 'string') {
    out.push({
      kind: 'taskUpdate', id: e.taskId, subject: typeof e.subject === 'string' ? e.subject : undefined,
      status: typeof e.status === 'string' ? (e.status as never) : undefined,
      addBlockedBy: Array.isArray(e.addBlockedBy) ? e.addBlockedBy.filter((x): x is string => typeof x === 'string') : undefined,
    })
  }
  if (e.tool === 'Workflow' && typeof r?.runId === 'string' && typeof r?.workflowName === 'string') {
    out.push({ kind: 'workflowName', runId: r.runId, name: r.workflowName })
  }
  return out
}

type TurnIn = { agentId?: string; reason: 'answer' | 'aborted' | 'refusal' | 'error' }
export const turnEndEvent = (e: TurnIn, at: number): Event =>
  e.agentId === undefined ? { kind: 'mainTurn', at, phase: 'end' } : { kind: 'runEnd', at, agentId: e.agentId, reason: e.reason }

type Info = { id: string; type: string; description: string; status: ListStatus; parentId?: string; name?: string }
export const listEvents = (list: readonly Info[], at: number): Event[] =>
  list.map(a => ({ kind: 'listStatus', at, agentId: a.id, status: a.status, type: a.type, description: a.description, parentId: a.parentId, name: a.name }))
