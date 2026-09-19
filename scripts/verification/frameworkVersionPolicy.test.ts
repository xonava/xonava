import { describe, expect, it } from "vitest"
import {
  FRAMEWORK_VERSION_POLICY,
  isForbiddenCompatibilityExport,
  isFrameworkTwoVersion,
} from "./frameworkVersionPolicy"

describe("F0 repository version policy", () => {
  it.each([
    "2.0.0-alpha.1",
    "2.0.0-beta.12",
    "2.0.0-rc.1",
    "2.0.0",
  ])("accepts the declared 2.0 version %s", (version) => {
    expect(isFrameworkTwoVersion(version)).toBe(true)
  })

  it.each([
    "1.0.0",
    "1.0-J",
    "2.0.0-alpha.0",
    "2.0.0-dev.1",
    "2.1.0",
    "3.0.0",
  ])("rejects a version outside the declared line: %s", (version) => {
    expect(isFrameworkTwoVersion(version)).toBe(false)
  })

  it.each(["./legacy", "./compat/auth", "./v1j", "./1.0-j/security"])(
    "rejects compatibility export %s",
    (exportName) => expect(isForbiddenCompatibilityExport(exportName)).toBe(true),
  )

  it("keeps application versions outside certification", () => {
    expect(FRAMEWORK_VERSION_POLICY.applicationVersionsAffectCertification).toBe(false)
    expect(FRAMEWORK_VERSION_POLICY.publicApiSource).toBe("package.json#exports")
    expect(FRAMEWORK_VERSION_POLICY.maintenanceProfile).not.toBe(
      FRAMEWORK_VERSION_POLICY.releaseProfile,
    )
  })
})
