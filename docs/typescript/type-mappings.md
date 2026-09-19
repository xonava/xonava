# Type mappings

| Specification concept | TypeScript representation |
|---|---|
| asynchronous operation | `Promise<T>` |
| explicit absence | `undefined` or a documented nullable result |
| binary payload | `Uint8Array` or provider-compatible stream chunk |
| structured error | `FrameworkCoreError` hierarchy/metadata |
| cancellation signal | `AbortSignal` where supported |
| stream | `AsyncIterable<T>` / Web stream at declared adapter boundaries |
| timestamp | numeric epoch or canonical string as the contract declares |
| contract | interface/type |
| key/value collection | `Map` or record according to the API |
| immutable result | `Readonly` shapes and frozen compiled definitions |

Representation choices never permit implementations to weaken the corresponding specification requirement.
