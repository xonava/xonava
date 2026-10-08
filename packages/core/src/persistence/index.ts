export * from "./datasource.js"
export * from "./persistenceRouter.js"
export * from "./provider"
export * from "./scoped"
export * from "./bulk"
export * from "./streaming"
// Registration stays module-private: exporting it would let any caller brand a raw provider as tenant-scoped.
export { TENANT_SCOPED_PROVIDER_BRAND, isCoreTenantScopedProvider } from "./tenantScopeBrand"
export * from "./capabilities"
