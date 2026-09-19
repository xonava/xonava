import { RuntimeCapabilityError } from "../domain/errors"
import type { ObjectStore } from "../object-store/objectStore"

export interface RuntimeCapabilities { deferredExecution: boolean; objectStore?: ObjectStore; cache: boolean }
export type RuntimeCapability = "deferredExecution" | "objectStore" | "cache"
const RUNTIME_CAPABILITY_NAMES: readonly RuntimeCapability[] = ["deferredExecution", "objectStore", "cache"]
export function isRuntimeCapability(value: string): value is RuntimeCapability { return (RUNTIME_CAPABILITY_NAMES as readonly string[]).includes(value) }
export function assertRuntimeCapability(value: string): asserts value is RuntimeCapability { if (!isRuntimeCapability(value)) throw new RuntimeCapabilityError(`Unknown runtime capability "${value}".`, { capability: value }) }
type BooleanKeys<T> = { [K in keyof T]: T[K] extends boolean ? K : never }[keyof T]
export function requireCapability<TCapabilities extends object, TCapability extends BooleanKeys<TCapabilities>>(capabilities: TCapabilities, capability: TCapability): void { if (capabilities[capability] === true) return; throw new RuntimeCapabilityError(`Runtime capability "${String(capability)}" is not available.`, { capability: String(capability) }) }
export function requireRuntimeCapability(capabilities: RuntimeCapabilities, capability: RuntimeCapability): void { assertRuntimeCapability(capability); const available = capability === "objectStore" ? hasObjectStoreCapability(capabilities) : capabilities[capability] === true; if (available) return; throw new RuntimeCapabilityError(`Runtime capability "${capability}" is not available.`, { capability }) }
export function hasObjectStoreCapability(capabilities: Pick<RuntimeCapabilities, "objectStore">): boolean { const store = capabilities.objectStore; return store !== null && typeof store === "object" && [store.put, store.get, store.head, store.delete].every(method => typeof method === "function") }
