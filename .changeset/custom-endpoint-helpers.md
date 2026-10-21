---
"@xonava/adapters": minor
---

Add `resolveEndpointRequestContext` and `admitModuleAction` to `@xonava/adapters/http` so hand-written endpoints build the trusted request context and run module admission exactly as CRUD handlers do. The five CRUD keys in `FrameworkRequestNormalization.routeBindings` are now optional; a CRUD handler whose enabled route has no binding fails at construction with a `ConfigurationError` naming the key.
