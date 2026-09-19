import type { AbacPolicy, AbacContext } from "../domain/abacTypes"

export interface ResolveAbacPoliciesInput {
  mode: "tenant" | "platform"
  moduleKey: string
  context: AbacContext
  at?: Date
}

export interface AbacPolicyProvider {
  resolve(input: ResolveAbacPoliciesInput): Promise<AbacPolicy[]>
}
