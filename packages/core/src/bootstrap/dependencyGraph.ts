import { ConfigurationError } from "../domain/errors.js"
import type { FrameworkDefinition } from "./definition.js"

export function definitionId(definition: Pick<FrameworkDefinition, "kind" | "key">): string {
  return `${definition.kind}:${definition.key}`
}

export function resolveDependencyOrder(definitions: readonly FrameworkDefinition[]): readonly string[] {
  const byId = new Map(definitions.map((definition) => [definitionId(definition), definition]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const path: string[] = []
  const pathEdgeAllowsCycle: boolean[] = []
  const order: string[] = []
  const visit = (id: string, incomingAllowsCycle = false): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      const start = path.indexOf(id)
      if (incomingAllowsCycle && pathEdgeAllowsCycle.slice(start + 1).every(Boolean)) return
      throw new ConfigurationError(`unsupported definition dependency cycle at ${id}`)
    }
    const definition = byId.get(id)
    if (!definition) throw new ConfigurationError(`missing definition reference ${id}`)
    visiting.add(id)
    path.push(id)
    pathEdgeAllowsCycle.push(incomingAllowsCycle)
    for (const reference of definition.references ?? []) {
      const targetId = `${reference.kind}:${reference.key}`
      const target = byId.get(targetId)
      if (!target) throw new ConfigurationError(`missing definition reference ${targetId} from ${id}`)
      if (reference.minimumVersion !== undefined && target.definitionVersion < reference.minimumVersion) {
        throw new ConfigurationError(`definition ${targetId} version ${target.definitionVersion} is below required ${reference.minimumVersion}`)
      }
      visit(targetId, reference.allowCycle === true)
    }
    visiting.delete(id)
    path.pop()
    pathEdgeAllowsCycle.pop()
    visited.add(id)
    order.push(id)
  }
  for (const id of byId.keys()) visit(id)
  return Object.freeze(order)
}
