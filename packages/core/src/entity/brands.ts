export const ENTITY_DEFINITION_BRAND: unique symbol = Symbol("core.entityDefinition")

const definitions = new WeakSet<object>()
export function registerEntityDefinition(value: object): void { definitions.add(value) }
export function isEntityDefinition(value: unknown): value is object { return typeof value === "object" && value !== null && definitions.has(value) }
