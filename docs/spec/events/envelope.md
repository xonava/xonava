# Events

An event envelope contains a format/version, stable event identifier, event type/version, occurrence time, canonical execution scope and scope identity, producer identity, authority provenance, payload and optional correlation/causation identifiers.

Readers validate the complete envelope and versioned payload codec before dispatch. Producers are immutable facts. Event handlers receive only the authority explicitly reconstructed and attenuated for that consumer.
