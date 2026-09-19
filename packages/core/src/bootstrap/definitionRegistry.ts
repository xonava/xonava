import { ConfigurationError } from "../domain/errors.js"
import { DEFINITION_KINDS, type FrameworkDefinition } from "./definition.js"
import { definitionId } from "./dependencyGraph.js"
import { cloneAndFreezeDefinition } from "../kernel/definitionIntegrity.js"

export type RegistryState = "OPEN" | "NORMALIZING" | "RESOLVING" | "COMPILING" | "SEALED" | "READY"

export class FrameworkDefinitionRegistry {
  #state: RegistryState = "OPEN"
  readonly #definitions = new Map<string, FrameworkDefinition>()
  get state(): RegistryState { return this.#state }
  register<T extends FrameworkDefinition>(definition: T): T {
    if (this.#state !== "OPEN") throw new ConfigurationError(`registry is ${this.#state}; registration is closed`)
    if (!DEFINITION_KINDS.includes(definition.kind) || !definition.key.trim() || definition.key !== definition.key.trim() || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(definition.key) || !Number.isSafeInteger(definition.definitionVersion) || definition.definitionVersion < 1) {
      throw new ConfigurationError("definition key and positive integer definitionVersion are required")
    }
    const id = definitionId(definition)
    if (this.#definitions.has(id)) throw new ConfigurationError(`duplicate definition ${id}`)
    this.#definitions.set(id, cloneAndFreezeDefinition(definition, true))
    return definition
  }
  transition(expected: RegistryState, next: RegistryState): void {
    if (this.#state !== expected) throw new ConfigurationError(`registry transition expected ${expected}, found ${this.#state}`)
    const legal: Readonly<Record<RegistryState, RegistryState | null>> = { OPEN: "NORMALIZING", NORMALIZING: "RESOLVING", RESOLVING: "COMPILING", COMPILING: "SEALED", SEALED: "READY", READY: null }
    if (legal[expected] !== next) throw new ConfigurationError(`illegal registry transition ${expected} -> ${next}`)
    this.#state = next
  }
  snapshot(): readonly FrameworkDefinition[] {
    return Object.freeze([...this.#definitions.values()])
  }
}
