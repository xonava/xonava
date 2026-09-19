# Modularity and tree shaking

Core uses native ESM, capability subpath exports, `sideEffects: false`, zero runtime dependencies, and no required import-time registry. Applications may consume cache, rate limiting, telemetry, object storage, persistence, query, or full orchestration independently.

Tree shaking means an application bundle can omit unreachable capability code. It does not mean npm installs dependencies separately per subpath. Adapter packaging/distribution is separate.

The architecture gate bundles nine isolated consumption fixtures and rejects cross-capability leakage, runtime cycles, and obsolete owners.
