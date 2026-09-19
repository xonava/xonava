import { ConfigurationError } from "../domain/errors.js"
import type { CompiledFrameworkPlan } from "./compiledPlan.js"
import type { FrameworkDefinitionRegistry } from "./definitionRegistry.js"
import { assertFrameworkReady } from "./readiness.js"

export class FrameworkRuntimeRegistry {
  #ready = false
  readonly #ports = new Map<string, unknown>()
  constructor(readonly plan: CompiledFrameworkPlan, readonly definitions: FrameworkDefinitionRegistry) {}
  bind(key: string, value: unknown): this {
    if (this.#ready) throw new ConfigurationError("runtime is READY; bindings are sealed")
    if (typeof key !== "string" || !key.trim()) throw new ConfigurationError("runtime binding key must be non-empty")
    if (value === undefined || value === null) throw new ConfigurationError(`runtime binding ${key} must provide a value`)
    if (this.#ports.has(key)) throw new ConfigurationError(`duplicate runtime binding ${key}`)
    this.#ports.set(key, value); return this
  }
  ready(satisfiedReadiness: ReadonlySet<string> = new Set()): void {
    for (const requirement of this.plan.runtimeBindings.requiredPorts) {
      if (!requirement.optional && !this.#ports.has(requirement.key)) throw new ConfigurationError(`missing runtime binding ${requirement.key}`)
    }
    assertFrameworkReady(this.plan, satisfiedReadiness)
    this.definitions.transition("SEALED", "READY"); this.#ready = true
  }
  get<T>(key: string): T {
    if (!this.#ready) throw new ConfigurationError("runtime is not READY")
    if (!this.#ports.has(key)) throw new ConfigurationError(`unknown runtime binding ${key}`)
    return this.#ports.get(key) as T
  }
}
