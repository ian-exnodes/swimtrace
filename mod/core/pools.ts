import type { Agent, PoolSource } from './model.ts'
import { DEFAULT_STALE_WORKFLOW_MS } from './model.ts'

export type MatchKey = 'type' | 'name' | 'description' | 'project'
const KEYS: readonly MatchKey[] = ['type', 'name', 'description', 'project']

export interface RuleJson { match: Partial<Record<MatchKey, string>>; pool: string }
export interface ConfigJson { rules: RuleJson[]; staleWorkflowAgentMinutes: number }
export interface CompiledRule { match: Partial<Record<MatchKey, RegExp>>; pool: string }
export interface Pool { name: string; source: PoolSource }

export const DEFAULT_CONFIG: ConfigJson = { rules: [], staleWorkflowAgentMinutes: DEFAULT_STALE_WORKFLOW_MS / 60_000 }

export function parseConfig(text: string | undefined): { config: ConfigJson; warnings: string[] } {
  if (text === undefined) return { config: DEFAULT_CONFIG, warnings: [] }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { config: DEFAULT_CONFIG, warnings: ['config.json is not valid JSON; using defaults'] } }
  const warnings: string[] = []
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const rules: RuleJson[] = []
  for (const [i, r] of (Array.isArray(obj.rules) ? obj.rules : []).entries()) {
    const rule = r as Record<string, unknown> | null
    const match = rule?.match as Record<string, unknown> | undefined
    const keys = match && typeof match === 'object' ? KEYS.filter(k => typeof match[k] === 'string') : []
    if (typeof rule?.pool !== 'string' || keys.length === 0) { warnings.push(`rule ${i}: needs a string "pool" and at least one string match key`); continue }
    rules.push({ match: Object.fromEntries(keys.map(k => [k, match![k]])) as RuleJson['match'], pool: rule.pool })
  }
  const m = obj.staleWorkflowAgentMinutes
  const minutes = typeof m === 'number' && m > 0 ? m : DEFAULT_CONFIG.staleWorkflowAgentMinutes
  if (m !== undefined && minutes !== m) warnings.push('staleWorkflowAgentMinutes must be a positive number; using default')
  return { config: { rules, staleWorkflowAgentMinutes: minutes }, warnings }
}

export function compileRules(rules: readonly RuleJson[]): { rules: CompiledRule[]; warnings: string[] } {
  const out: CompiledRule[] = []
  const warnings: string[] = []
  for (const [i, r] of rules.entries()) {
    try {
      const match: CompiledRule['match'] = {}
      for (const k of KEYS) if (r.match[k] !== undefined) match[k] = new RegExp(r.match[k]!)
      out.push({ match, pool: r.pool })
    } catch (err) {
      warnings.push(`rule ${i}: invalid regex (${(err as Error).message}); skipped`)
    }
  }
  return { rules: out, warnings }
}

const EXPLICIT = /^\[pool:([^\]]+)\]/

export function resolvePool(a: Agent, project: string, workflows: Record<string, string>, rules: readonly CompiledRule[]): Pool {
  if (a.id === 'main') return { name: 'MAIN', source: 'main' }
  const fields: Record<MatchKey, string> = { type: a.type, name: a.name ?? '', description: a.description, project }
  for (const r of rules) {
    let groups: RegExpExecArray | null = null
    let ok = true
    for (const k of KEYS) {
      const re = r.match[k]
      if (re === undefined) continue
      const m = re.exec(fields[k])
      if (m === null) { ok = false; break }
      if (groups === null && m.length > 1) groups = m // captures come from the first key, in KEYS order, that has groups
    }
    if (ok) return { name: r.pool.replace(/\$(\d)/g, (_, d: string) => groups?.[Number(d)] ?? ''), source: 'config' }
  }
  const tag = EXPLICIT.exec(a.description)
  if (tag) return { name: tag[1]!.trim(), source: 'explicit' }
  if (a.workflowRunId !== undefined) return { name: workflows[a.workflowRunId] ?? a.workflowRunId, source: 'workflow' }
  return { name: a.type, source: 'type' }
}
