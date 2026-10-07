import { coercePolicyValue, coercePolicyValueList } from "./coercePolicyValue"
import type { AbacModuleCatalog } from "./abacCatalog"

export type AbacPolicyEffect = "allow" | "deny"

export type PolicyGroupLogic = "AND" | "OR"

export type PolicyOperator =
  | "equals"
  | "notEquals"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "isEmpty"
  | "isNotEmpty"
  | "greaterThan"
  | "lessThan"
  | "greaterOrEqual"
  | "lessOrEqual"
  | "isTrue"
  | "isFalse"
  | "isNull"
  | "isNotNull"
  | "includesAny"
  | "includesAll"
  | "before"
  | "after"
  | "between"
  | "in"

export interface PolicyFilterClause {
  field: string
  operator?: PolicyOperator
  value?: unknown
  values?: unknown[]
  userAttr?: string
}

export interface PolicyConditionGroup {
  logic: PolicyGroupLogic
  conditions: Array<PolicyFilterClause | PolicyConditionGroup>
}

export interface PolicyConditions {
  version: 2
  systemScope: PolicyConditionGroup
  userFilters: PolicyConditionGroup
}

export type FieldPolicyReadMode = "allow" | "omit" | "mask"

export interface PolicyFieldQueryAccess {
  filter?: string[]
  search?: string[]
  sort?: string[]
}

export interface PolicyFieldAccess {
  read?: Record<string, FieldPolicyReadMode>
  write?: string[]
  query?: PolicyFieldQueryAccess
}

export interface ParsedPolicyPayload {
  actions: string[]
  capabilities: string[]
  conditions: PolicyConditions
  fieldAccess?: PolicyFieldAccess
}

export interface PolicyParseIssue {
  path: string
  message: string
  value?: unknown
}

const MAX_POLICY_INPUT_BYTES = 1024 * 1024
const MAX_POLICY_INPUT_DEPTH = 20
const MAX_POLICY_INPUT_NODES = 5_000
const MAX_POLICY_ARRAY_ITEMS = 500

/** Copy direct decoded input into inert JSON-shaped data before authorization parsing. */
function clonePolicyInput(value: unknown, depth = 0, ancestors = new WeakSet<object>(), budget = { nodes: 0, bytes: 0 }): unknown | undefined {
  if (depth > MAX_POLICY_INPUT_DEPTH || ++budget.nodes > MAX_POLICY_INPUT_NODES) return undefined
  if (typeof value === "string") {
    if (value.length > MAX_POLICY_INPUT_BYTES) return undefined
    budget.bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength
  } else budget.bytes += value === undefined ? 0 : typeof value === "object" && value !== null ? 2 : JSON.stringify(value)?.length ?? 0
  if (budget.bytes > MAX_POLICY_INPUT_BYTES) return undefined
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  if (typeof value !== "object" || ancestors.has(value)) return undefined
  try {
    ancestors.add(value)
    if (Array.isArray(value)) {
      if (value.length > MAX_POLICY_ARRAY_ITEMS) return undefined
      budget.bytes += Math.max(0, value.length - 1)
      if (budget.bytes > MAX_POLICY_INPUT_BYTES) return undefined
      const descriptors = Object.getOwnPropertyDescriptors(value)
      const copied: unknown[] = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)]
        if (!descriptor || !("value" in descriptor)) return undefined
        const child = clonePolicyInput(descriptor.value, depth + 1, ancestors, budget)
        if (child === undefined && descriptor.value !== undefined) return undefined
        copied.push(child)
      }
      return copied
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    if (Object.getOwnPropertySymbols(value).length > 0) return undefined
    const copied: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(value)) {
      if (key.length > MAX_POLICY_INPUT_BYTES) return undefined
      budget.bytes += new TextEncoder().encode(JSON.stringify(key)).byteLength + 2
      if (budget.bytes > MAX_POLICY_INPUT_BYTES || budget.nodes >= MAX_POLICY_INPUT_NODES) return undefined
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor) return undefined
      if (!descriptor.enumerable) continue
      if (!("value" in descriptor)) return undefined
      const child = clonePolicyInput(descriptor.value, depth + 1, ancestors, budget)
      if (child === undefined && descriptor.value !== undefined) return undefined
      copied[key] = child
    }
    return copied
  } catch {
    return undefined
  } finally {
    ancestors.delete(value)
  }
}

function policyInputWithinBudget(value: unknown): boolean {
  let nodes = 0
  const ancestors = new WeakSet<object>()
  const visit = (entry: unknown, depth: number): boolean => {
    if (depth > MAX_POLICY_INPUT_DEPTH || ++nodes > MAX_POLICY_INPUT_NODES) return false
    if (entry === null || typeof entry !== "object") return true
    if (ancestors.has(entry)) return false
    ancestors.add(entry)
    const values = Array.isArray(entry)
      ? entry.length <= MAX_POLICY_ARRAY_ITEMS ? entry : null
      : Object.values(entry as Record<string, unknown>)
    if (values === null || !values.every((child) => visit(child, depth + 1))) return false
    ancestors.delete(entry)
    return true
  }
  return visit(value, 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function safeJsonParse(input: string): unknown {
  if (new TextEncoder().encode(input).byteLength > MAX_POLICY_INPUT_BYTES) return null
  try {
    const parsed = JSON.parse(input)
    return policyInputWithinBudget(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function parseStringArrayStrict(
  input: unknown,
  path: string,
): { success: true; value: string[] } | { success: false; errors: PolicyParseIssue[] } {
  const raw = clonePolicyInput(typeof input === "string" ? safeJsonParse(input) : input)
  if (!policyInputWithinBudget(raw)) {
    return { success: false, errors: [{ path, message: "Policy input exceeds structural limits" }] }
  }
  if (!Array.isArray(raw)) {
    return { success: false, errors: [{ path, message: "Expected a JSON array of strings", value: raw }] }
  }

  const errors: PolicyParseIssue[] = []
  const result: string[] = []
  for (let i = 0; i < raw.length; i++) {
    if (typeof raw[i] !== "string") {
      errors.push({ path: `${path}[${i}]`, message: "Expected a string", value: raw[i] })
    } else {
      result.push(raw[i] as string)
    }
  }

  if (errors.length > 0) return { success: false, errors }
  return { success: true, value: result }
}

function emptyGroup(): PolicyConditionGroup {
  return { logic: "AND", conditions: [] }
}

export function parseFieldAccessStrict(
  input: unknown,
  path: string,
): { success: true; fieldAccess: PolicyFieldAccess } | { success: false; errors: PolicyParseIssue[] } {
  const errors: PolicyParseIssue[] = []
  // This parser is exported independently of parsePolicyPayloadStrict. Make
  // its public boundary inert as well, so accessor-backed objects cannot run
  // code while field permissions are being parsed.
  const raw = clonePolicyInput(input)
  if (raw === undefined && input !== undefined) {
    return { success: false, errors: [{ path, message: "fieldAccess must contain plain data only" }] }
  }
  input = raw

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { success: false, errors: [{ path, message: "Expected an object for fieldAccess", value: input }] }
  }

  const record = input as Record<string, unknown>
  const read: Record<string, FieldPolicyReadMode> = {}
  const VALID_MODES = new Set<FieldPolicyReadMode>(["allow", "omit", "mask"])

  if (record.read !== undefined) {
    if (record.read === null || typeof record.read !== "object" || Array.isArray(record.read)) {
      errors.push({ path: `${path}.read`, message: "Expected an object with field-mode pairs", value: record.read })
    } else {
      for (const [field, mode] of Object.entries(record.read)) {
        if (field.length === 0) {
          errors.push({ path: `${path}.read`, message: "Field name must not be empty", value: field })
        } else if (field === "__proto__" || field === "constructor" || field === "prototype") {
          // A {} literal silently drops "__proto__"; reject reserved names outright.
          errors.push({ path: `${path}.read`, message: `Reserved field name: ${field}`, value: field })
        } else if (!VALID_MODES.has(mode as FieldPolicyReadMode)) {
          errors.push({ path: `${path}.read.${field}`, message: `Invalid read mode: ${mode}`, value: mode })
        } else {
          read[field] = mode as FieldPolicyReadMode
        }
      }
    }
  }

  const write: string[] = []
  if (record.write !== undefined) {
    if (!Array.isArray(record.write)) {
      errors.push({ path: `${path}.write`, message: "Expected an array of field names", value: record.write })
    } else {
      for (let i = 0; i < record.write.length; i++) {
        if (typeof record.write[i] !== "string") {
          errors.push({ path: `${path}.write[${i}]`, message: "Expected a string field name", value: record.write[i] })
        } else if (record.write[i] === "") {
          errors.push({ path: `${path}.write[${i}]`, message: "Field name must not be empty", value: record.write[i] })
        } else {
          write.push(record.write[i] as string)
        }
      }
    }
  }

  const query: PolicyFieldQueryAccess = {}
  if (record.query !== undefined) {
    if (record.query === null || typeof record.query !== "object" || Array.isArray(record.query)) {
      errors.push({ path: `${path}.query`, message: "Expected an object with filter/search/sort field lists", value: record.query })
    } else {
      const queryRecord = record.query as Record<string, unknown>
      for (const mode of ["filter", "search", "sort"] as const) {
        const listInput = queryRecord[mode]
        if (listInput === undefined) continue
        if (!Array.isArray(listInput)) {
          errors.push({ path: `${path}.query.${mode}`, message: "Expected an array of field names", value: listInput })
          continue
        }
        const list: string[] = []
        for (let i = 0; i < listInput.length; i++) {
          if (typeof listInput[i] !== "string") {
            errors.push({ path: `${path}.query.${mode}[${i}]`, message: "Expected a string field name", value: listInput[i] })
          } else if (listInput[i] === "") {
            errors.push({ path: `${path}.query.${mode}[${i}]`, message: "Field name must not be empty", value: listInput[i] })
          } else {
            list.push(listInput[i] as string)
          }
        }
        if (list.length > 0) query[mode] = list
      }
      for (const key of Object.keys(queryRecord)) {
        if (key !== "filter" && key !== "search" && key !== "sort") {
          errors.push({ path: `${path}.query.${key}`, message: `Unknown fieldAccess.query key: ${key}`, value: key })
        }
      }
    }
  }

  for (const key of Object.keys(record)) {
    if (key !== "read" && key !== "write" && key !== "query") {
      errors.push({ path: `${path}.${key}`, message: `Unknown fieldAccess key: ${key}`, value: key })
    }
  }

  if (errors.length > 0) return { success: false, errors }

  const fieldAccess: PolicyFieldAccess = {}
  if (Object.keys(read).length > 0) fieldAccess.read = read
  if (write.length > 0) fieldAccess.write = write
  if (Object.keys(query).length > 0) fieldAccess.query = query
  return { success: true, fieldAccess }
}

export function parsePolicyPayloadStrict(input: {
  actionsJson: unknown
  capabilitiesJson: unknown
  conditionsJson: unknown
}): { success: true; payload: ParsedPolicyPayload } | { success: false; errors: PolicyParseIssue[] } {
  const errors: PolicyParseIssue[] = []

  const actionsResult = parseStringArrayStrict(input.actionsJson, "actionsJson")
  if (!actionsResult.success) errors.push(...actionsResult.errors)

  const capabilitiesResult = parseStringArrayStrict(input.capabilitiesJson, "capabilitiesJson")
  if (!capabilitiesResult.success) errors.push(...capabilitiesResult.errors)

  const conditionsRaw = clonePolicyInput(
    typeof input.conditionsJson === "string" ? safeJsonParse(input.conditionsJson) : input.conditionsJson,
  )

  if (!policyInputWithinBudget(conditionsRaw)) {
    return { success: false, errors: [...errors, { path: "conditionsJson", message: "Policy input exceeds structural limits" }] }
  }

  if (!isRecord(conditionsRaw)) {
    errors.push({ path: "conditionsJson", message: "conditionsJson must be a JSON object" })
    return { success: false, errors }
  }

  const conditionsResult = parseConditionObjectStrict(conditionsRaw, "conditionsJson")
  if (!conditionsResult.success) errors.push(...conditionsResult.errors)

  let fieldAccess: PolicyFieldAccess | undefined

  const fieldAccessInput = conditionsRaw.fieldAccess

  if (fieldAccessInput !== undefined) {
    const result = parseFieldAccessStrict(fieldAccessInput, "conditionsJson.fieldAccess")
    if (!result.success) {
      errors.push(...result.errors)
    } else {
      fieldAccess = result.fieldAccess
      if (fieldAccess?.write) {
        fieldAccess = { ...fieldAccess, write: [...new Set(fieldAccess.write)] }
      }
      if (fieldAccess?.query) {
        const { filter, search, sort } = fieldAccess.query
        fieldAccess = {
          ...fieldAccess,
          query: {
            ...(filter ? { filter: [...new Set(filter)] } : {}),
            ...(search ? { search: [...new Set(search)] } : {}),
            ...(sort ? { sort: [...new Set(sort)] } : {}),
          },
        }
      }
    }
  }

  // Deduplicate actions and capabilities
  const actions = [...new Set(actionsResult.success ? actionsResult.value : [])]
  const capabilities = [...new Set(capabilitiesResult.success ? capabilitiesResult.value : [])]

  if (errors.length > 0) return { success: false, errors }

  const payload: ParsedPolicyPayload = {
    actions,
    capabilities,
    conditions: conditionsResult.success
      ? conditionsResult.conditions
      : { version: 2, systemScope: emptyGroup(), userFilters: emptyGroup() },
  }
  if (fieldAccess) payload.fieldAccess = fieldAccess
  return { success: true, payload }
}

function parseClauseStrict(
  input: unknown,
  path: string,
): { success: true; clause: PolicyFilterClause } | { success: false; errors: PolicyParseIssue[] } {
  const errors: PolicyParseIssue[] = []

  if (!isRecord(input)) {
    return { success: false, errors: [{ path, message: "Expected an object" }] }
  }

  if (typeof input.field !== "string" || input.field.length === 0) {
    errors.push({ path: `${path}.field`, message: "field must be a non-empty string", value: input.field })
  }

  const VALID_CLAUSE_KEYS = new Set(["field", "operator", "value", "values", "userAttr"])
  for (const key of Object.keys(input)) {
    if (!VALID_CLAUSE_KEYS.has(key)) {
      errors.push({ path: `${path}.${key}`, message: `Unknown clause property: ${key}`, value: key })
    }
  }

  const operator = typeof input.operator === "string" ? input.operator : "equals"
  const validOperators: PolicyOperator[] = [
    "equals", "notEquals", "contains", "startsWith", "endsWith",
    "isEmpty", "isNotEmpty", "greaterThan", "lessThan", "greaterOrEqual", "lessOrEqual",
    "isTrue", "isFalse", "isNull", "isNotNull",
    "includesAny", "includesAll",
    "before", "after", "between",
    "in",
  ]

  if (!validOperators.includes(operator as PolicyOperator)) {
    errors.push({ path: `${path}.operator`, message: `Unknown operator: ${operator}`, value: operator })
  }

  if (operator === "includesAll") {
    errors.push({
      path: `${path}.operator`,
      message: "includesAll is not supported by persistence adapters",
      value: operator,
    })
  }

  // Reject conflicting clause values
  const hasValue = input.value !== undefined
  const hasValues = Array.isArray(input.values) && input.values.length > 0
  const hasUserAttr = typeof input.userAttr === "string"
  const providedCount = [hasValue, hasValues, hasUserAttr].filter(Boolean).length

  if (providedCount > 1) {
    errors.push({ path, message: "Clause must not have more than one of value, values, or userAttr", value: input })
  }

  // Validate valueless operators
  if (["isTrue", "isFalse", "isNull", "isNotNull", "isEmpty", "isNotEmpty"].includes(operator)) {
    if (input.value !== undefined || input.values !== undefined || input.userAttr !== undefined) {
      errors.push({ path: `${path}.value`, message: `${operator} does not accept values`, value: input.value })
    }
  }

  // Validate between operator
  if (operator === "between") {
    if (Array.isArray(input.value)) {
      if (input.value.length !== 2 || input.value[0] === undefined || input.value[1] === undefined) {
        errors.push({ path: `${path}.value`, message: "between array requires exactly 2 non-undefined values", value: input.value })
      }
    } else if (typeof input.value === "object" && input.value !== null) {
      const valObj = input.value as Record<string, unknown>
      const extraKeys = Object.keys(valObj).filter((k) => k !== "from" && k !== "to")
      if (extraKeys.length > 0) {
        errors.push({ path: `${path}.value`, message: `between object must only have from/to keys`, value: input.value })
      }
      if (valObj.from === undefined && valObj.to === undefined) {
        errors.push({ path: `${path}.value`, message: "between object requires at least one of from or to", value: input.value })
      }
    } else {
      errors.push({ path: `${path}.value`, message: "between requires [from, to] array or {from, to} object", value: input.value })
    }
  }

  // Validate array operators
  if (["includesAny", "includesAll", "in"].includes(operator)) {
    if (input.value !== undefined) {
      errors.push({ path: `${path}.value`, message: `${operator} does not accept value; use values instead`, value: input.value })
    }
    if (!Array.isArray(input.values) || input.values.length === 0) {
      errors.push({ path: `${path}.values`, message: `${operator} requires a non-empty array`, value: input.values })
    }
  }

  let userAttr: string | undefined
  if (typeof input.userAttr === "string") {
    const normalized = normalizeUserAttribute(input.userAttr)
    if (!normalized) {
      errors.push({ path: `${path}.userAttr`, message: `Invalid user attribute: ${input.userAttr}`, value: input.userAttr })
    } else {
      userAttr = normalized
    }
  }

  if (errors.length > 0) {
    return { success: false, errors }
  }

  const clause: PolicyFilterClause = {
    field: input.field as string,
    operator: operator as PolicyOperator,
  }
  if (input.value !== undefined) clause.value = input.value
  if (Array.isArray(input.values)) clause.values = input.values
  if (userAttr !== undefined) clause.userAttr = userAttr

  return {
    success: true,
    clause,
  }
}

export const ALLOWED_USER_ATTRS = new Set([
  "user.id",
  "user.roleId",
  "user.branchId",
  "user.departmentId",
  "user.tenantId",
])

export function normalizeUserAttribute(input: string): string | undefined {
  return ALLOWED_USER_ATTRS.has(input) ? input : undefined
}

function parseConditionGroupStrict(
  input: unknown,
  path: string,
): { success: true; conditions: PolicyConditionGroup } | { success: false; errors: PolicyParseIssue[] } {
  const errors: PolicyParseIssue[] = []

  if (!isRecord(input) || !Array.isArray(input.conditions)) {
    return { success: false, errors: [{ path, message: "Expected an object with a conditions array" }] }
  }

  const logic = input.logic
  if (logic !== "AND" && logic !== "OR") {
    errors.push({ path: `${path}.logic`, message: "logic must be AND or OR", value: logic })
  }
  for (const key of Object.keys(input)) {
    if (key !== "logic" && key !== "conditions") {
      errors.push({ path: `${path}.${key}`, message: `Unknown condition group property: ${key}`, value: key })
    }
  }

  const parsedConditions: Array<PolicyFilterClause | PolicyConditionGroup> = []
  for (let i = 0; i < input.conditions.length; i++) {
    const item = (input.conditions as unknown[])[i]
    const itemPath = `${path}.conditions[${i}]`

    if (isRecord(item) && Array.isArray(item.conditions)) {
      const nested = parseConditionGroupStrict(item, itemPath)
      if (nested.success) {
        parsedConditions.push(nested.conditions)
      } else {
        errors.push(...nested.errors)
      }
    } else {
      const clause = parseClauseStrict(item, itemPath)
      if (clause.success) {
        parsedConditions.push(clause.clause)
      } else {
        errors.push(...clause.errors)
      }
    }
  }

  if (errors.length > 0) {
    return { success: false, errors }
  }

  return { success: true, conditions: { logic: logic as PolicyGroupLogic, conditions: parsedConditions } }
}

function parseConditionObjectStrict(
  input: Record<string, unknown>,
  path: string,
): { success: true; conditions: PolicyConditions } | { success: false; errors: PolicyParseIssue[] } {
  const errors: PolicyParseIssue[] = []

  for (const key of Object.keys(input)) {
    if (key !== "version" && key !== "systemScope" && key !== "userFilters" && key !== "fieldAccess") {
      errors.push({ path: `${path}.${key}`, message: `Unknown conditions property: ${key}`, value: key })
    }
  }
  if (input.version !== 2) {
    errors.push({ path: `${path}.version`, message: "version must be 2", value: input.version })
  }

  const systemResult = parseConditionGroupStrict(input.systemScope, `${path}.systemScope`)
  if (!systemResult.success) {
    errors.push(...systemResult.errors)
    return { success: false, errors }
  }

  const userResult = parseConditionGroupStrict(input.userFilters, `${path}.userFilters`)
  if (!userResult.success) {
    errors.push(...userResult.errors)
    return { success: false, errors }
  }

  if (errors.length > 0) return { success: false, errors }
  return { success: true, conditions: { version: 2, systemScope: systemResult.conditions, userFilters: userResult.conditions } }
}

export function validatePayloadAgainstCatalog(
  payload: ParsedPolicyPayload,
  catalog: AbacModuleCatalog,
): PolicyParseIssue[] {
  const errors: PolicyParseIssue[] = []

  for (const action of payload.actions) {
    if (!catalog.actions.includes(action)) {
      errors.push({ path: "actions", message: `Unknown action: ${action}`, value: action })
    }
  }

  for (const capability of payload.capabilities) {
    if (!catalog.capabilities.includes(capability)) {
      errors.push({ path: "capabilities", message: `Unknown capability: ${capability}`, value: capability })
    }
  }

  if (payload.fieldAccess?.read) {
    for (const field of Object.keys(payload.fieldAccess.read)) {
      if (!Object.hasOwn(catalog.fields, field)) {
        errors.push({ path: `fieldAccess.read.${field}`, message: `Unknown field for read access: ${field}`, value: field })
      }
    }
  }

  if (payload.fieldAccess?.write) {
    for (const field of payload.fieldAccess.write) {
      if (!Object.hasOwn(catalog.fields, field)) {
        errors.push({ path: `fieldAccess.write.${field}`, message: `Unknown field for write access: ${field}`, value: field })
      }
    }
  }

  if (payload.fieldAccess?.query) {
    const validateQueryList = (fields: string[] | undefined, path: string) => {
      for (const field of fields ?? []) {
        if (!Object.hasOwn(catalog.fields, field)) {
          errors.push({ path, message: `Unknown field for query access: ${field}`, value: field })
        }
      }
    }
    validateQueryList(payload.fieldAccess.query.filter, "fieldAccess.query.filter")
    validateQueryList(payload.fieldAccess.query.search, "fieldAccess.query.search")
    validateQueryList(payload.fieldAccess.query.sort, "fieldAccess.query.sort")
  }

  validateConditionFields(payload.conditions, catalog, errors)

  return errors
}

function validateConditionFields(
  conditions: PolicyConditions,
  catalog: AbacModuleCatalog,
  errors: PolicyParseIssue[],
): void {
  function validateClause(clause: PolicyFilterClause, path: string) {
    const fieldDef = Object.hasOwn(catalog.fields, clause.field) ? catalog.fields[clause.field] : undefined
    if (!fieldDef) {
      errors.push({ path: `${path}.field`, message: `Unknown field: ${clause.field}`, value: clause.field })
      return
    }

    if (clause.operator && !fieldDef.operators.includes(clause.operator)) {
      errors.push({
        path: `${path}.operator`,
        message: `Operator ${clause.operator} is not supported for field ${clause.field}`,
        value: clause.operator,
      })
    }

    if (clause.value !== undefined && !clause.userAttr) {
      try {
        coercePolicyValue({ type: fieldDef.type, value: clause.value })
      } catch {
        errors.push({
          path: `${path}.value`,
          message: `Invalid value for field ${clause.field}`,
          value: clause.value,
        })
      }
    }

    if (clause.values !== undefined && !clause.userAttr) {
      const operator = clause.operator ?? "equals"
      if ((operator === "in" || operator === "includesAny" || operator === "includesAll") && fieldDef.type === "string-array") {
        const result = coercePolicyValueList({ type: fieldDef.type, values: clause.values })
        if (!result.success) {
          for (const err of result.errors) {
            errors.push({ path: `${path}.values`, message: err.message, value: err.details })
          }
        }
      } else {
        for (let i = 0; i < clause.values.length; i++) {
          try {
            coercePolicyValue({ type: fieldDef.type, value: clause.values[i] })
          } catch {
            errors.push({
              path: `${path}.values[${i}]`,
              message: `Invalid value for field ${clause.field}`,
              value: clause.values[i],
            })
          }
        }
      }
    }
  }

  function validateGroup(group: PolicyConditionGroup, path: string) {
    for (let i = 0; i < group.conditions.length; i++) {
      const condition = group.conditions[i]
      if (!condition) continue
      const itemPath = `${path}.conditions[${i}]`
      if ("logic" in condition && Array.isArray(condition.conditions)) {
        validateGroup(condition, itemPath)
      } else {
        validateClause(condition as PolicyFilterClause, itemPath)
      }
    }
  }

  validateGroup(conditions.systemScope, "systemScope")
  validateGroup(conditions.userFilters, "userFilters")
}
