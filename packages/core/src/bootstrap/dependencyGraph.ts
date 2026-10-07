import { ConfigurationError } from "../domain/errors.js"
import type { FrameworkDefinition } from "./definition.js"

export function definitionId(definition: Pick<FrameworkDefinition, "kind" | "key">): string {
  return `${definition.kind}:${definition.key}`
}

/**
 * Topological order of definitions (dependencies first). Iterative, so a long
 * reference chain cannot exhaust the call stack. A cycle is accepted only when
 * every edge on it is marked `allowCycle`.
 */
export function resolveDependencyOrder(definitions: readonly FrameworkDefinition[]): readonly string[] {
  const byId = new Map(definitions.map((definition) => [definitionId(definition), definition]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const order: string[] = []
  type Frame = { readonly id: string; readonly incomingAllowsCycle: boolean; readonly references: NonNullable<FrameworkDefinition["references"]>; next: number }
  const stack: Frame[] = []
  const enter = (id: string, incomingAllowsCycle: boolean): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      const start = stack.findIndex((frame) => frame.id === id)
      if (incomingAllowsCycle && stack.slice(start + 1).every((frame) => frame.incomingAllowsCycle)) return
      throw new ConfigurationError(`unsupported definition dependency cycle at ${id}`)
    }
    const definition = byId.get(id)
    if (!definition) throw new ConfigurationError(`missing definition reference ${id}`)
    visiting.add(id)
    stack.push({ id, incomingAllowsCycle, references: definition.references ?? [], next: 0 })
  }
  for (const rootId of byId.keys()) {
    enter(rootId, false)
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      if (frame.next < frame.references.length) {
        const reference = frame.references[frame.next++]!
        const targetId = `${reference.kind}:${reference.key}`
        const target = byId.get(targetId)
        if (!target) throw new ConfigurationError(`missing definition reference ${targetId} from ${frame.id}`)
        if (reference.minimumVersion !== undefined && target.definitionVersion < reference.minimumVersion) {
          throw new ConfigurationError(`definition ${targetId} version ${target.definitionVersion} is below required ${reference.minimumVersion}`)
        }
        enter(targetId, reference.allowCycle === true)
        continue
      }
      stack.pop()
      visiting.delete(frame.id)
      visited.add(frame.id)
      order.push(frame.id)
    }
  }
  return Object.freeze(order)
}
