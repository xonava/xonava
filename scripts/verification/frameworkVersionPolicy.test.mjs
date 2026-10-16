import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  FRAMEWORK_VERSION_POLICY,
  isForbiddenCompatibilityExport,
  isFrameworkVersion,
  lockstepViolations,
} from "./frameworkVersionPolicy.mjs"

describe("framework version policy", () => {
  for (const version of ["0.1.0", "0.12.3", "1.0.0-alpha.1", "1.0.0-beta.12", "1.0.0-rc.1", "1.0.0", "2.10.0"]) {
    it(`accepts ${version}`, () => assert.equal(isFrameworkVersion(version), true))
  }

  for (const version of ["1.0", "01.0.0", "1.0.0-rc.0", "1.0.0-dev.1", "1.0.0-rc", "1.0.0+build.1", "v1.0.0", 1]) {
    it(`rejects ${String(version)}`, () => assert.equal(isFrameworkVersion(version), false))
  }

  for (const exportName of ["./legacy", "./compat/auth", "./v1j", "./1.0-j/security"]) {
    it(`rejects compatibility export ${exportName}`, () => assert.equal(isForbiddenCompatibilityExport(exportName), true))
  }

  it("keeps application versions outside certification", () => {
    assert.equal(FRAMEWORK_VERSION_POLICY.applicationVersionsAffectCertification, false)
    assert.equal(FRAMEWORK_VERSION_POLICY.versioning, "lockstep-semver")
  })

  const core = { name: "@xonava/core", version: "0.1.0", dependencies: {} }
  const adapters = { name: "@xonava/adapters", version: "0.1.0", dependencies: { "@xonava/core": "0.1.0", zod: "^4.0.0" } }
  const testing = {
    name: "@xonava/testing",
    version: "0.1.0",
    dependencies: { "@xonava/core": "0.1.0" },
    devDependencies: { "@xonava/adapters": "0.1.0" },
  }

  it("accepts packages in lockstep with exact internal pins", () => {
    assert.deepEqual(lockstepViolations([core, adapters, testing]), [])
  })

  it("rejects a package at a different version", () => {
    assert.equal(lockstepViolations([core, { ...adapters, version: "0.1.1" }, testing]).length, 1)
  })

  it("rejects a range on an internal dependency", () => {
    const loose = { ...adapters, dependencies: { "@xonava/core": "^0.1.0" } }
    assert.match(lockstepViolations([core, loose, testing]).join("\n"), /pins @xonava\/core@\^0\.1\.0/)
  })

  it("rejects a stale internal development dependency", () => {
    const stale = { ...testing, devDependencies: { "@xonava/adapters": "0.0.9" } }
    assert.equal(lockstepViolations([core, adapters, stale]).length, 1)
  })

  it("rejects an invalid shared version", () => {
    const bad = (manifest) => ({ ...manifest, version: "0.1" })
    assert.match(lockstepViolations([bad(core)]).join("\n"), /not a permitted version/)
  })
})
