import { snapshotData } from "../kernel/snapshotData"

/** Defensive data snapshot used at the pure rule boundary. */
export function snapshotRuleData<T>(value: T, label: string): T {
  return snapshotData(value, { label })
}
