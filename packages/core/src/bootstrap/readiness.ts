import { ConfigurationError } from "../domain/errors.js"
import type { CompiledFrameworkPlan } from "./compiledPlan.js"

export function assertFrameworkReady(plan: CompiledFrameworkPlan, satisfied: ReadonlySet<string>): void {
  const missing = plan.readiness.requirements.filter((requirement) => !satisfied.has(requirement.key))
  if (missing.length) throw new ConfigurationError(`framework readiness requirements missing: ${missing.map((item) => item.key).join(", ")}`)
}

export function requiredReadinessKeys(plan: CompiledFrameworkPlan): ReadonlySet<string> {
  return new Set(plan.readiness.requirements.map(requirement => requirement.key))
}
