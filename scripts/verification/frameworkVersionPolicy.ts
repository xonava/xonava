export const FRAMEWORK_PACKAGE_DIRECTORIES = [
  "packages/core",
  "packages/adapters",
  "packages/testing",
] as const

export const FRAMEWORK_TWO_VERSION_PATTERN =
  /^2\.0\.0(?:-(?:alpha|beta|rc)\.[1-9][0-9]*)?$/

export const FORBIDDEN_COMPATIBILITY_EXPORT_PATTERN =
  /(?:^|[\/_\-.])(?:legacy|compat(?:ibility)?|v?1j|1\.0-j)(?:$|[\/_\-.])/i

export const VERSION_POLICY_SCHEMA = "framework.version-policy"
export const VERSION_POLICY_SCHEMA_VERSION = 1
export const RELEASE_EVIDENCE_SCHEMA = "framework.release-evidence"
export const RELEASE_EVIDENCE_SCHEMA_VERSION = 1

export interface FrameworkVersionPolicy {
  readonly schema: typeof VERSION_POLICY_SCHEMA
  readonly schemaVersion: typeof VERSION_POLICY_SCHEMA_VERSION
  readonly line: "2.0"
  readonly permittedVersions: readonly string[]
  readonly applicationVersionsAffectCertification: false
  readonly compatibilityAliasesPermitted: false
  readonly publicApiSource: "package.json#exports"
  readonly releaseProfile: string
}

export const FRAMEWORK_VERSION_POLICY: FrameworkVersionPolicy = Object.freeze({
  schema: VERSION_POLICY_SCHEMA,
  schemaVersion: VERSION_POLICY_SCHEMA_VERSION,
  line: "2.0",
  permittedVersions: Object.freeze([
    "2.0.0-alpha.N",
    "2.0.0-beta.N",
    "2.0.0-rc.N",
    "2.0.0",
  ]),
  applicationVersionsAffectCertification: false,
  compatibilityAliasesPermitted: false,
  publicApiSource: "package.json#exports",
  releaseProfile: "release/framework-2.0.json",
})

export function isFrameworkTwoVersion(version: unknown): version is string {
  return typeof version === "string" && FRAMEWORK_TWO_VERSION_PATTERN.test(version)
}

export function isForbiddenCompatibilityExport(exportName: string): boolean {
  return FORBIDDEN_COMPATIBILITY_EXPORT_PATTERN.test(exportName)
}
