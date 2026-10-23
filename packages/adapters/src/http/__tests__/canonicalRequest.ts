import type { CompiledRouteBinding } from "@xonava/core/bootstrap"
import { bindAbacSecurityDigest, type ExecutionScope, type Principal } from "@xonava/core/domain"
import type { CrudRouteBindings, FrameworkAuthorizationEntitlements } from "../../server"
import type {
  FrameworkRequestNormalization,
  ScopeAdmissionEvidence,
  TrustedFrameworkSession,
} from "../../server"

const authenticated = (id: string): Principal => Object.freeze({
  id,
  kind: "human",
  authentication: Object.freeze({
    kind: "authenticated",
    method: "test",
    authenticatedAt: "2026-09-10T00:00:00.000Z",
  }),
})

export function trustedSession(
  scope: ExecutionScope = { kind: "platform", platformKey: "test" },
  actorId = "actor-1",
  subjectId = actorId,
): TrustedFrameworkSession {
  const actor = authenticated(actorId)
  const subject = subjectId === actorId ? actor : authenticated(subjectId)
  return Object.freeze({ identity: Object.freeze({ actor, subject }), scope: Object.freeze({ ...scope }) })
}

function route(action: "list" | "detail" | "create" | "update" | "delete", scope: ExecutionScope, operationPrefix: string): CompiledRouteBinding {
  const mutation = action === "list" || action === "detail"
    ? { allowed: false as const }
    : { allowed: true as const, idempotencyRequirement: "optional" as const }
  return Object.freeze({
    routeKey: `test.${action}`,
    definitionVersion: 1,
    transport: "http",
    method: action === "create" ? "POST" : action === "update" ? "PATCH" : action === "delete" ? "DELETE" : "GET",
    pathTemplate: action === "list" || action === "create" ? "/items" : "/items/:id",
    exposure: "authenticated",
    operationKey: `${operationPrefix}.${action}`,
    scopeResolution: { kind: "fixed" as const, scope: Object.freeze({ ...scope }) },
    anonymousPrincipal: { allowed: false as const },
    inputPolicy: Object.freeze({}),
    outputPolicy: Object.freeze({}),
    mutation,
    authorizationPlanKey: "test",
  })
}

export function canonicalRequestNormalization(
  sessionOrResolver: TrustedFrameworkSession | (() => TrustedFrameworkSession) = trustedSession(),
  operationPrefix = "test",
): FrameworkRequestNormalization & { readonly routeBindings: Required<CrudRouteBindings> } {
  const initial = typeof sessionOrResolver === "function" ? sessionOrResolver() : sessionOrResolver
  const evidence: ScopeAdmissionEvidence = Object.freeze({
    grantId: "test-grant",
    purpose: "adapter-test",
    reason: "test fixture",
    issuedAt: "2026-09-10T00:00:00.000Z",
    policy: Object.freeze({
      policyKey: "test",
      policyVersion: 1,
      policyDigest: "test-digest",
      evaluatedAt: "2026-09-10T00:00:00.000Z",
      authorizationModel: "continuous",
    }),
  })
  return Object.freeze({
    routeBindings: Object.freeze({
      list: route("list", initial.scope, operationPrefix),
      detail: route("detail", initial.scope, operationPrefix),
      create: route("create", initial.scope, operationPrefix),
      update: route("update", initial.scope, operationPrefix),
      delete: route("delete", initial.scope, operationPrefix),
    }),
    resolverBindings: new Map(),
    resolveTrustedSession: async () => typeof sessionOrResolver === "function" ? sessionOrResolver() : sessionOrResolver,
    resolveAdmissionEvidence: async () => evidence,
  })
}

export function allowAllModuleFacts(args: { moduleKey: string }): FrameworkAuthorizationEntitlements {
  return Object.freeze({
    enabledModuleKeys: Object.freeze([args.moduleKey]),
    enabledModuleActions: Object.freeze({ [args.moduleKey]: Object.freeze(["manage"]) }),
    enabledModuleCapabilities: Object.freeze({ [args.moduleKey]: Object.freeze(["manage"]) }),
  })
}

export async function allowAllAbacBundle(moduleKey: string) {
  return bindAbacSecurityDigest({
    mode: "platform",
    moduleKey,
    policies: [{
      source: { policyId: "adapter-test-allow", scopeType: "platform_default" },
      moduleKey,
      effect: "allow",
      priority: 1,
      payload: {
        actions: ["read", "create", "update", "delete", "manage"],
        capabilities: ["manage"],
        conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } },
      },
      compiledConditions: { kind: "literal", value: true },
    }],
    context: {},
    defaultEffect: "deny",
    fieldCatalog: {},
  })
}
