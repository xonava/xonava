export const FRAMEWORK_PACKAGE_DIRECTORIES = [
  "packages/core",
  "packages/adapters",
  "packages/testing",
]

export const FRAMEWORK_PACKAGE_SCOPE = "@xonava/"

// Semantic Versioning core version with an optional alpha, beta or rc prerelease number.
export const FRAMEWORK_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:alpha|beta|rc)\.[1-9][0-9]*)?$/

export const FORBIDDEN_COMPATIBILITY_EXPORT_PATTERN =
  /(?:^|[\/_\-.])(?:legacy|compat(?:ibility)?|v?1j|1\.0-j)(?:$|[\/_\-.])/i

export const VERSION_POLICY_SCHEMA = "framework.version-policy"
export const VERSION_POLICY_SCHEMA_VERSION = 2

export const FRAMEWORK_VERSION_POLICY = Object.freeze({
  schema: VERSION_POLICY_SCHEMA,
  schemaVersion: VERSION_POLICY_SCHEMA_VERSION,
  versioning: "lockstep-semver",
  permittedVersions: "MAJOR.MINOR.PATCH, optionally followed by -alpha.N, -beta.N or -rc.N",
  applicationVersionsAffectCertification: false,
  compatibilityAliasesPermitted: false,
  publicApiSource: "package.json#exports",
})

const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]

/** @param {unknown} version @returns {version is string} */
export function isFrameworkVersion(version) {
  return typeof version === "string" && FRAMEWORK_VERSION_PATTERN.test(version)
}

/** @param {string} exportName */
export function isForbiddenCompatibilityExport(exportName) {
  return FORBIDDEN_COMPATIBILITY_EXPORT_PATTERN.test(exportName)
}

/**
 * Returns every lockstep violation: the framework packages must share one valid version, and every
 * dependency on a framework package must pin that exact version.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} packages
 * @returns {string[]}
 */
export function lockstepViolations(packages) {
  /** @type {string[]} */
  const violations = []
  const version = packages[0]?.version
  if (packages.length === 0) return ["no framework packages were supplied"]
  if (!isFrameworkVersion(version)) {
    violations.push(`${String(packages[0]?.name)} version ${String(version)} is not a permitted version`)
  }
  for (const manifest of packages) {
    if (manifest.version !== version) {
      violations.push(`${String(manifest.name)} version ${String(manifest.version)} differs from ${String(version)}`)
    }
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = manifest[field]
      if (!dependencies || typeof dependencies !== "object") continue
      for (const [name, range] of Object.entries(dependencies)) {
        if (name.startsWith(FRAMEWORK_PACKAGE_SCOPE) && range !== version) {
          violations.push(`${String(manifest.name)} ${field} pins ${name}@${String(range)}, expected ${String(version)}`)
        }
      }
    }
  }
  return violations
}
