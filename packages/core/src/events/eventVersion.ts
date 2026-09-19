import { ConfigurationError } from "../domain"

export interface EventUpcaster { readonly from: number; readonly to: number; readonly upcast: (payload: unknown) => unknown }

export function upcastEventPayload(payload: unknown, from: number, to: number, upcasters: readonly EventUpcaster[]): unknown {
  let value = payload
  let version = from
  while (version < to) {
    const step = upcasters.find(candidate => candidate.from === version && candidate.to === version + 1)
    if (!step) throw new ConfigurationError(`Missing event upcaster ${version}->${version + 1}`)
    value = step.upcast(value)
    version += 1
  }
  if (version !== to) throw new ConfigurationError(`Cannot downcast event payload ${from}->${to}`)
  return value
}

