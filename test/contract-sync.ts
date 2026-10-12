// Type-level check, run by `npm run typecheck`: the mod's $.state contract (mod/types/index.d.ts) cannot
// import the core, so it holds copies of Snapshot and ConfigJson. They must stay identical, optional fields included.
import type { Snapshot } from '../mod/core/model.ts'
import type { ConfigJson } from '../mod/core/pools.ts'
import type { SwimtraceConfig, SwimtraceSnapshot } from '../mod/types/index.d.ts'

// The identity check: true only when A and B are the same type, so a field optional on one side or
// present on one side only (at any depth) makes it false.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

export const snapshotInSync: Equal<Snapshot, SwimtraceSnapshot> = true
export const configInSync: Equal<ConfigJson, SwimtraceConfig> = true
