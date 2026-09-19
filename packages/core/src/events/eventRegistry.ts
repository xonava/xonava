import { ConfigurationError } from "../domain"
import type { EventDefinition } from "./eventDefinition"
import type { EventEnvelope } from "./eventEnvelope"
import { upcastEventPayload, type EventUpcaster } from "./eventVersion"

export class EventRegistry {
  private readonly definitions = new Map<string, EventDefinition>()
  private readonly upcasters = new Map<string, readonly EventUpcaster[]>()

  register(definition: EventDefinition, upcasters: readonly EventUpcaster[] = []): this {
    if (this.definitions.has(definition.type)) throw new ConfigurationError(`Duplicate event type ${definition.type}`)
    this.definitions.set(definition.type, definition)
    this.upcasters.set(definition.type, Object.freeze([...upcasters]))
    return this
  }

  validate(envelope: EventEnvelope): unknown {
    const definition = this.definitions.get(envelope.eventType)
    if (!definition) throw new ConfigurationError(`Unknown event type ${envelope.eventType}`)
    const version = definition.versions.find(candidate => candidate.version === envelope.payloadVersion)
    if (!version) throw new ConfigurationError(`Unsupported ${envelope.eventType} version ${envelope.payloadVersion}`)
    return version.validate(envelope.payload)
  }

  upcast(envelope: EventEnvelope, targetVersion: number): unknown {
    const definition = this.definitions.get(envelope.eventType)
    if (!definition) throw new ConfigurationError(`Unknown event type ${envelope.eventType}`)
    const target = definition.versions.find(candidate => candidate.version === targetVersion)
    if (!target) throw new ConfigurationError(`Unsupported ${envelope.eventType} target version ${targetVersion}`)
    return target.validate(upcastEventPayload(envelope.payload, envelope.payloadVersion, targetVersion, this.upcasters.get(envelope.eventType) ?? []))
  }
}

