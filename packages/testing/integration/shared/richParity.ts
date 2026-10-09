import { Predicate, createAbacAuthorizer, markTrustedPredicate, evaluatePredicate, evaluatePredicateTruth, type NormalizedAbacPolicy, type PredicateNode, type PredicatePrimitive } from "core/domain"
import { validateQueryPlan, type ListResult, type QueryOptions, type SortSpec } from "core/query"
import { createRng, forAllAsync, hashSeed, scaledRuns, type Rng } from "../../../core/src/__tests__/differential/harness.js"
import { DIFFERENTIAL_FIELDS, generateCondition, generatePredicate, generateRecord, shrinkPredicate, type DifferentialField, type ValueDomains } from "../../../core/src/__tests__/differential/arbitraries.js"
import { ABAC_ACTIONS, bindPolicies, describePolicyCase, generatePolicies, shrinkPolicies } from "../../../core/src/__tests__/differential/abacArbitraries.js"
import { compileCursorPredicate } from "../../../adapters/src/drizzle-shared/cursorPagination.js"

/**
 * Real-database differential: every SQL dialect must select exactly the rows
 * the core evaluator selects (docs/spec/persistence/predicates.md), order rows
 * exactly as core comparison orders them, and page through them with keyset
 * cursors without gaps or duplicates (docs/spec/query.md). Core is the
 * reference; any disagreement is a bug in a compiler or in core.
 *
 * One dataset is inserted per table and thousands of generated predicates
 * (or sort specs, or ABAC bundles) run against it. Failures are shrunk and
 * replayable with DIFFERENTIAL_SEED / DIFFERENTIAL_RUN; DIFFERENTIAL_SCALE
 * scales every case count.
 */

/** Every catalog type, plus `price`: a number stored in a DECIMAL/NUMERIC column (drivers return strings). */
export const PARITY_FIELDS: readonly DifferentialField[] = Object.freeze([...DIFFERENTIAL_FIELDS, { key: "price", type: "number" }])
export const SCALAR_FIELDS: readonly DifferentialField[] = PARITY_FIELDS.filter((field) => field.type !== "string-array")

/**
 * Stored values. Strings are chosen where engines disagree with code-point
 * order: case, accents (composed and decomposed), German sharp s, dotted and
 * dotless i, emoji (non-BMP, so UTF-16 and code-point order differ against
 * U+E000), LIKE metacharacters including MySQL's `!` escape, quotes, and
 * leading/trailing whitespace (PAD SPACE collations ignore trailing spaces).
 */
export const RECORD_DOMAINS = {
  string: ["", "a", "A", "ab", "Ab", "aB", "b", "B", "é", "é", "e", "E", "z", "Z", "ß", "ss", "SS", "İ", "i", "ı", "😀", "😀a", "", "a%_\\", "%", "_", "\\", "a!", "!a", "a_b", "a'b", " a", "a ", "a\t", "draft", "Draft", "locked"],
  identifier: ["u1", "u2", "u10", "U1", "u1 ", "u_1", "u%"],
  number: [-1e15, -2, -0.5, 0, 0.1, 0.30000000000000004, 1, 2.5, 10, 1e6, 1e15, 9007199254740991],
  date: ["1999-12-31", "2024-02-29", "2025-12-31", "2026-01-01", "2026-02-28", "2026-03-01"],
  /** Same instants at different offsets and precisions; all valid RFC 3339. */
  datetime: [
    "2025-12-31T23:59:59Z",
    "2025-12-31T23:59:59.999Z",
    "2026-01-01T00:00:00Z",
    "2026-01-01T05:30:00+05:30",
    "2025-12-31T19:00:00-05:00",
    "2026-01-01T00:00:00.001Z",
    "2026-06-01T12:00:00-07:00",
    "1999-12-31T23:59:59.5+00:00",
  ],
  tag: ["x", "y", "z", "X"],
} as const satisfies ValueDomains

/**
 * Literal values: the stored values plus needles and strings core cannot
 * parse as instants (they must yield UNKNOWN, never an error or a match).
 */
export const LITERAL_DOMAINS: ValueDomains = {
  ...RECORD_DOMAINS,
  /**
   * Date fields get calendar-date literals only (valid, or strings that are not
   * RFC 3339 and so compare as text / are UNKNOWN). A date-time literal against
   * a date column is cast by the engine to a calendar date, while core compares
   * an instant or a string: not portable, so not generated (see
   * docs/spec/persistence/predicates.md, "Temporal columns").
   */
  date: [...RECORD_DOMAINS.date, "2026-02-30", "2026-1-1", "0000-01-01", "0999-12-31", "9999-12-31"],
  string: [...RECORD_DOMAINS.string, "a%", "%a", "ft", "😀", "aa", "éz"],
  datetime: [
    ...RECORD_DOMAINS.datetime,
    "2026-01-01",
    "2026-01-01T00:00:00.000001Z",
    "2026-01-01T00:00:00.999999999-00:00",
    "2026-01-01T00:00:00",
    "2026-02-30T00:00:00Z",
    "2026-01-01 00:00:00Z",
    "yesterday",
    // Outside engine input ranges: year 0 (1 BC), year 10000 after the offset, MySQL's 1000-9999.
    "0000-01-01T00:00:00Z",
    "9999-12-31T23:00:00-05:00",
    "0999-12-31T23:59:59Z",
    // Driver text forms with offsets PostgreSQL rejects (not RFC 3339: UNKNOWN for Date-hydrated rows).
    "2024-01-01 10:00:00+99",
    "2024-01-01 10:00:00+16:00",
  ],
}

export type ParityRecord = Record<string, unknown> & { id: number }

/**
 * Canonical entity values: date fields are `YYYY-MM-DD` strings, datetimes
 * are `Date`, tags are string arrays, and absent keys are NULL.
 */
/**
 * A dialect-specific string-hydrated column beyond {@link PARITY_FIELDS}
 * (PostgreSQL enum, inet, uuid, ...). It gets every string operator,
 * ordering included, and is ordered and paginated against core's code-point
 * order: whatever a column type's native comparison, SQL must agree with core.
 */
export interface ExtraField {
  readonly key: string
  /** Stored values (as rows hydrate them). */
  readonly values: readonly string[]
  /** Literal values for predicates (should include non-stored strings). */
  readonly literals: readonly string[]
}

export function generateDataset(seed = hashSeed("rich-parity-dataset"), randomRows = 200, extraFields: readonly ExtraField[] = []): ParityRecord[] {
  const records = generateBaseDataset(seed, randomRows)
  for (const field of extraFields) {
    const rng = createRng(hashSeed(`rich-parity-extra:${field.key}`))
    for (const record of records) record[field.key] = rng.bool(0.15) ? null : rng.pick(field.values)
  }
  return records
}

function generateBaseDataset(seed: number, randomRows: number): ParityRecord[] {
  const rng = createRng(seed)
  const records: Record<string, unknown>[] = []
  // Every string value is stored at least once in `name` so ordering covers the whole domain.
  for (const name of RECORD_DOMAINS.string) records.push({ ...generateRecord(rng, { fields: PARITY_FIELDS, domains: RECORD_DOMAINS }), name })
  for (let index = 0; index < randomRows; index++) records.push(generateRecord(rng, { fields: PARITY_FIELDS, domains: RECORD_DOMAINS, nullRate: 0.15, missingRate: 0.1 }))
  records.push({})
  return records.map((record, index) => {
    const out: ParityRecord = { id: index + 1 }
    for (const field of PARITY_FIELDS) {
      const value = Object.hasOwn(record, field.key) ? record[field.key] : null
      out[field.key] = field.type === "datetime" && typeof value === "string" ? new Date(value) : value
    }
    return out
  })
}

// ---------------------------------------------------------------------------
// Driver contract
// ---------------------------------------------------------------------------

export interface ParityDriver {
  readonly label: string
  /** Rows exactly as the repository returns them, hydrated into the entity's value kinds. */
  findMany(options: QueryOptions): Promise<ListResult<ParityRecord>>
  /**
   * Ids selected by `WHERE <compiled filter>` using the adapter's predicate
   * compiler (the one its repository uses). Predicates and ABAC scopes go
   * through this path because the repository's query budget (depth 5,
   * 50 nodes) rejects many of them before any SQL runs.
   */
  selectIds(filter: PredicateNode): Promise<number[]>
  /** Whether the repository supports `SortSpec.nulls` (MySQL rejects it). */
  readonly explicitNulls: boolean
  /** Cursor page size for the pagination walks (default 7); slow drivers use larger pages. */
  readonly pageSize?: number
  /** Dialect-specific columns stored in the table and covered by every property. */
  readonly extraFields?: readonly ExtraField[]
}

export const PAGE_ALL = 10_000

async function selectAll(driver: ParityDriver, filter?: PredicateNode, sort?: readonly SortSpec[]): Promise<ParityRecord[]> {
  return (await driver.findMany({ ...(filter ? { filter } : {}), ...(sort ? { sort } : {}), pagination: { kind: "offset", page: 1, pageSize: PAGE_ALL } })).rows
}

function describeValue(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (item instanceof Date ? `Date(${item.toISOString()})` : item))
}

function sameValue(type: DifferentialField["type"], expected: unknown, actual: unknown): boolean {
  if (expected === null || expected === undefined) return actual === null || actual === undefined
  if (actual === null || actual === undefined) return false
  switch (type) {
    case "datetime": return actual instanceof Date && (expected as Date).getTime() === actual.getTime()
    case "date": return (actual instanceof Date ? actual.toISOString().slice(0, 10) : actual) === expected && (!(actual instanceof Date) || actual.getTime() % 86_400_000 === 0)
    case "string-array": return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected)
    case "number": return typeof actual === "number" && (actual === expected)
    default: return actual === expected
  }
}

/** The stored dataset must read back as the same values, or no comparison below is meaningful. */
export async function roundTripMismatches(driver: ParityDriver, dataset: readonly ParityRecord[]): Promise<string[]> {
  const rows = await selectAll(driver)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const out: string[] = []
  if (rows.length !== dataset.length) out.push(`row count ${rows.length} !== ${dataset.length}`)
  for (const record of dataset) {
    const row = byId.get(record.id)
    if (!row) { out.push(`row ${record.id} missing`); continue }
    for (const field of [...PARITY_FIELDS, ...(driver.extraFields ?? []).map((extra) => ({ key: extra.key, type: "string" as const }))]) {
      if (!sameValue(field.type, record[field.key], row[field.key])) out.push(`row ${record.id}.${field.key}: stored ${describeValue(record[field.key])}, read ${describeValue(row[field.key])}`)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Property 1: predicate parity
// ---------------------------------------------------------------------------

export interface PredicateParityStats { cases: number; nonTrivial: number; empty: number; all: number }

function idDiff(rows: readonly ParityRecord[], expected: readonly number[], actual: readonly number[], explain: (row: ParityRecord) => string): string {
  const want = new Set(expected)
  const got = new Set(actual)
  const onlyCore = expected.filter((id) => !got.has(id))
  const onlySql = actual.filter((id) => !want.has(id))
  const sample = [...onlyCore.slice(0, 3), ...onlySql.slice(0, 3)].map((id) => rows.find((row) => row.id === id)!).map(explain)
  return `core-only ids ${JSON.stringify(onlyCore)}; sql-only ids ${JSON.stringify(onlySql)}\n${sample.join("\n")}`
}

/**
 * Generated portable predicates (depth up to 6, literals, empty groups,
 * null literals, invalid instants) against the stored dataset: the
 * repository's ids must equal the ids the core evaluator accepts.
 */
export async function checkPredicateParity(driver: ParityDriver, rows: readonly ParityRecord[], runs = 1500): Promise<PredicateParityStats> {
  const stats: PredicateParityStats = { cases: 0, nonTrivial: 0, empty: 0, all: 0 }
  const sortedIds = (list: readonly ParityRecord[]) => list.map((row) => row.id).sort((a, b) => a - b)
  const extras = driver.extraFields ?? []
  await forAllAsync(`real-database predicate parity (${driver.label})`, (rng) => {
    const base = generatePredicate(rng, { portable: true, emptyTests: true, fields: PARITY_FIELDS, domains: LITERAL_DOMAINS, maxDepth: 6, literalRate: 0.08 })
    if (extras.length === 0 || !rng.bool(0.4)) return base
    const condition = extraCondition(rng, rng.pick(extras))
    return rng.pick([Predicate.and(base, condition), Predicate.or(base, condition), condition, Predicate.not(condition)])
  }, async (predicate) => {
    const expected = sortedIds(rows.filter((row) => evaluatePredicate(row, predicate)))
    const actual = [...await driver.selectIds(predicate)].sort((a, b) => a - b)
    stats.cases++
    if (expected.length === 0) stats.empty++
    else if (expected.length === rows.length) stats.all++
    else stats.nonTrivial++
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error(idDiff(rows, expected, actual, (row) => `  row ${describeValue(row)} core=${String(evaluatePredicateTruth(row, predicate))}`))
    }
  }, { runs, shrink: shrinkPredicate, describe: describeValue })
  return stats
}

/** Any string condition on an extra field, ordering comparisons included. */
function extraCondition(rng: Rng, field: ExtraField): PredicateNode {
  return generateCondition(rng, { portable: true, emptyTests: true, fields: [{ key: field.key, type: "string" }], domains: { string: field.literals } })
}

// ---------------------------------------------------------------------------
// Property 2: ordering and keyset pagination parity
// ---------------------------------------------------------------------------

/** Core comparison of two non-null values: -1/0/1 via the evaluator itself, or null when incomparable. */
function coreCompare(left: unknown, right: unknown): number | null {
  const record = { v: left as PredicatePrimitive }
  const value = right as PredicatePrimitive
  if (evaluatePredicate(record, Predicate.lt("v", value))) return -1
  if (evaluatePredicate(record, Predicate.eq("v", value))) return 0
  if (evaluatePredicate(record, Predicate.gt("v", value))) return 1
  return null
}

/** The documented core order: core comparison per key, explicit NULL placement, unique `id` tie-breaker. */
export function coreOrder(rows: readonly ParityRecord[], sort: readonly SortSpec[]): ParityRecord[] {
  const compare = (a: ParityRecord, b: ParityRecord): number => {
    for (const spec of sort) {
      const left = a[spec.field] ?? null
      const right = b[spec.field] ?? null
      if (left === null && right === null) continue
      if (left === null || right === null) {
        if (!spec.nulls) throw new Error(`core order for NULL ${spec.field} needs explicit null placement`)
        const nullFirst = spec.nulls === "first"
        return (left === null) === nullFirst ? -1 : 1
      }
      const compared = coreCompare(left, right)
      if (compared === null) throw new Error(`incomparable ${spec.field} values ${describeValue(left)} / ${describeValue(right)}`)
      if (compared !== 0) return spec.direction === "asc" ? compared : -compared
    }
    return 0
  }
  return [...rows].sort(compare)
}

function cursorValue(value: unknown): string | number | boolean | null {
  if (value === undefined || value === null) return null
  if (value instanceof Date) return value.toISOString()
  return value as string | number | boolean
}

export interface OrderingCase {
  field: string
  direction: "asc" | "desc"
  nulls?: "first" | "last"
}

export function orderingCases(driver: ParityDriver): OrderingCase[] {
  const out: OrderingCase[] = []
  const fields = [...SCALAR_FIELDS.map((field) => field.key), ...(driver.extraFields ?? []).map((field) => field.key)]
  for (const field of fields) {
    for (const direction of ["asc", "desc"] as const) {
      const base = { field, direction }
      if (driver.explicitNulls) for (const nulls of ["first", "last"] as const) out.push({ ...base, nulls })
      else out.push(base)
    }
  }
  return out
}

export type OrderingAspect = "order" | "keyset" | "forward" | "backward"

export interface OrderingReport {
  readonly spec: OrderingCase
  readonly label: string
  /** Failure description per aspect; absent aspects passed. */
  readonly failures: Partial<Record<OrderingAspect, string>>
}

/**
 * For one sort field: (order) the repository's full ORDER BY equals the core
 * order; (keyset) every keyset boundary, evaluated by core, splits the core
 * order exactly at the boundary row; (forward/backward) walking cursor pages
 * through the real repository reproduces the core order with no gaps or
 * duplicates. Without explicit NULL placement (MySQL) only non-NULL rows are
 * ordered, since the spec promises no default NULL position.
 */
export async function orderingReport(driver: ParityDriver, rows: readonly ParityRecord[], spec: OrderingCase, pageSize = 7): Promise<OrderingReport> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError("pageSize must be a positive integer")
  const sort: SortSpec[] = [
    { field: spec.field, direction: spec.direction, ...(spec.nulls ? { nulls: spec.nulls } : {}) },
    { field: "id", direction: spec.direction },
  ]
  const label = `${spec.field} ${spec.direction}${spec.nulls ? ` nulls ${spec.nulls}` : ""}`
  const failures: Partial<Record<OrderingAspect, string>> = {}
  const filter = spec.nulls ? undefined : Predicate.isNotNull(spec.field)
  const scoped = filter ? rows.filter((row) => evaluatePredicate(row, filter)) : [...rows]
  // The order of a cursor page (one page holding every row): offset pages only promise a deterministic order.
  const sqlOrder = async () => (await driver.findMany({ ...(filter ? { filter } : {}), sort, pagination: { kind: "cursor", direction: "after", limit: PAGE_ALL } })).rows.map((row) => row.id)
  const expected = coreOrder(scoped, sort).map((row) => row.id)
  const show = (id: number | undefined) => (id === undefined ? "<end>" : `${id}:${describeValue(rows.find((row) => row.id === id)?.[spec.field] ?? null)}`)
  const firstDifference = (actual: readonly number[]): string | undefined => {
    const index = expected.findIndex((id, position) => actual[position] !== id)
    if (index === -1 && expected.length === actual.length) return undefined
    const at = index === -1 ? Math.min(expected.length, actual.length) : index
    return `position ${at}: core ${show(expected[at])}, sql ${show(actual[at])} (previous ${show(expected[at - 1])})`
  }
  const attempt = async (aspect: OrderingAspect, check: () => Promise<string | undefined>): Promise<void> => {
    try {
      const failure = await check()
      if (failure) failures[aspect] = failure
    } catch (error) {
      failures[aspect] = `threw ${error instanceof Error ? error.message : String(error)}`
    }
  }

  await attempt("order", async () => firstDifference(await sqlOrder()))

  // Keyset boundaries evaluated by core must split the core order exactly.
  await attempt("keyset", async () => {
    const byId = new Map(rows.map((row) => [row.id, row]))
    for (let index = 0; index < expected.length; index++) {
      const boundary = byId.get(expected[index]!)!
      const after = compileCursorPredicate(sort, { direction: "after", values: sort.map((item) => cursorValue(boundary[item.field])) })
      for (let other = 0; other < expected.length; other++) {
        const isAfter = evaluatePredicate(byId.get(expected[other]!)!, after)
        if (isAfter !== other > index) return `keyset predicate after ${show(expected[index])} ${isAfter ? "admits" : "rejects"} ${show(expected[other])} at position ${other}`
      }
    }
    return undefined
  })

  const walk = async (direction: "after" | "before"): Promise<number[]> => {
    const seen: number[] = []
    let values: (string | number | boolean | null)[] | undefined
    for (let page = 0; page <= expected.length + 1; page++) {
      const result = await driver.findMany({ ...(filter ? { filter } : {}), sort, pagination: { kind: "cursor", direction, limit: pageSize, ...(values ? { values } : {}) } })
      const ids = result.rows.map((row) => row.id)
      if (direction === "after") seen.push(...ids)
      else seen.unshift(...ids)
      const more = result.pageInfo?.kind === "cursor" && (direction === "after" ? result.pageInfo.hasNextPage : result.pageInfo.hasPreviousPage)
      if (!more || result.rows.length === 0) return seen
      const edge = direction === "after" ? result.rows[result.rows.length - 1]! : result.rows[0]!
      values = sort.map((item) => cursorValue(edge[item.field]))
    }
    throw new Error("cursor walk did not terminate")
  }
  await attempt("forward", async () => firstDifference(await walk("after")))
  await attempt("backward", async () => firstDifference(await walk("before")))
  return { spec, label, failures }
}

export async function orderingReports(driver: ParityDriver, rows: readonly ParityRecord[]): Promise<OrderingReport[]> {
  const out: OrderingReport[] = []
  for (const spec of orderingCases(driver)) out.push(await orderingReport(driver, rows, spec, driver.pageSize))
  return out
}

/**
 * Splits failures into unexpected ones and known defects that no longer
 * reproduce (so a fix forces the marker to be removed). Every aspect not
 * marked as a known defect is asserted in full.
 */
export function orderingVerdict(reports: readonly OrderingReport[], knownDefect: (spec: OrderingCase, aspect: OrderingAspect) => boolean): { unexpected: string[]; fixed: string[]; known: string[] } {
  const unexpected: string[] = []
  const fixed: string[] = []
  const known: string[] = []
  for (const report of reports) {
    for (const aspect of ["order", "keyset", "forward", "backward"] as const) {
      const failure = report.failures[aspect]
      const isKnown = knownDefect(report.spec, aspect)
      if (failure && !isKnown) unexpected.push(`${report.label} [${aspect}]: ${failure}`)
      else if (failure) known.push(`${report.label} [${aspect}]: ${failure}`)
      else if (isKnown) fixed.push(`${report.label} [${aspect}] passes: remove it from the known defects`)
    }
  }
  return { unexpected, fixed, known }
}

// ---------------------------------------------------------------------------
// Property 3: ABAC scope end-to-end
// ---------------------------------------------------------------------------

export interface AbacCase {
  policies: NormalizedAbacPolicy[]
  action: string
  /** A caller filter within the default query budget, applied alongside the scope; absent for none. */
  callerFilter?: PredicateNode
}

export interface AbacParityStats {
  cases: number; nonTrivial: number; empty: number; all: number
  /** Cases that reached the repository `findMany` path (the collection is not refused). */
  repository: number
  /** ...of which with a caller filter alongside the scope. */
  withCallerFilter: number
  /** ...of which the same filter, untrusted (a structural clone), would exceed the caller budget. */
  overCallerBudget: number
}

function withinCallerBudget(filter: PredicateNode): boolean {
  try {
    validateQueryPlan({ filter })
    return true
  } catch {
    return false
  }
}

/**
 * Random verified bundles from abacArbitraries (literals exactly as
 * `normalizeAbacPolicy` stores them). Three paths must agree with the core
 * record decision (`canRecordAction`):
 * - the adapter's compiled SQL for the raw `buildActionScope(action).filter`;
 * - the adapter's compiled SQL for the simplified, trusted
 *   `authorizeCollection(action).scope`;
 * - the real repository `findMany` with the filter the authorized repository
 *   builds, `and(structural scope, collection scope, caller filter)`, so the
 *   query budget validation of a caller filter alongside trusted scopes is on
 *   the path too. Expected ids there are allowed rows the caller filter accepts.
 */
export async function checkAbacScopeParity(driver: ParityDriver, rows: readonly ParityRecord[], runs = 300): Promise<AbacParityStats> {
  const stats: AbacParityStats = { cases: 0, nonTrivial: 0, empty: 0, all: 0, repository: 0, withCallerFilter: 0, overCallerBudget: 0 }
  // Framework-built row scope, as authorizedRepository adds one (always true here).
  const structural = markTrustedPredicate(Predicate.isNotNull("id"))
  await forAllAsync<AbacCase>(`real-database ABAC scope parity (${driver.label})`, (rng) => {
    const policies = generatePolicies(rng, { min: 1, max: 5, unconditionalRate: 0.25, fieldAccessRate: 0 })
    const action = rng.pick(ABAC_ACTIONS)
    const filter = rng.bool(0.6) ? generatePredicate(rng, { portable: true, fields: PARITY_FIELDS, maxDepth: 2, literalRate: 0.05 }) : undefined
    return { policies, action, ...(filter && withinCallerBudget(filter) ? { callerFilter: filter } : {}) }
  }, async (value) => {
    const authorizer = createAbacAuthorizer(await bindPolicies(value.policies))
    const allowed = rows.filter((row) => authorizer.canRecordAction(value.action, row))
    const expected = allowed.map((row) => row.id).sort((a, b) => a - b)
    stats.cases++
    if (expected.length === 0) stats.empty++
    else if (expected.length === rows.length) stats.all++
    else stats.nonTrivial++
    const check = (source: string, scope: PredicateNode, want: readonly number[], got: readonly number[]): void => {
      const actual = [...got].sort((a, b) => a - b)
      if (JSON.stringify(want) !== JSON.stringify(actual)) {
        throw new Error(`${source} scope ${describeValue(scope)}\n${idDiff(rows, want, actual, (row) => `  row ${describeValue(row)} allowed=${String(authorizer.canRecordAction(value.action, row))} scope=${String(evaluatePredicateTruth(row, scope))}`)}`)
      }
    }
    const raw = authorizer.buildActionScope(value.action).filter
    check("compiled buildActionScope", raw, expected, await driver.selectIds(raw))
    const collection = authorizer.authorizeCollection(value.action)
    if (!collection.allowed) {
      // The authorized repository refuses the read outright.
      if (expected.length > 0) throw new Error(`authorizeCollection denies ${value.action} (${collection.reasonCode}) but core allows rows ${JSON.stringify(expected)}`)
      return
    }
    check("compiled authorizeCollection", collection.scope, expected, await driver.selectIds(collection.scope))
    const filters = [structural, collection.scope, ...(value.callerFilter ? [value.callerFilter] : [])]
    const callerFilter = value.callerFilter
    const want = callerFilter ? allowed.filter((row) => evaluatePredicate(row, callerFilter)).map((row) => row.id).sort((a, b) => a - b) : expected
    const combined = Predicate.and(...filters)
    stats.repository++
    if (callerFilter) stats.withCallerFilter++
    // A clone loses the trusted brand: shows how often the exemption is what admits the read.
    if (!withinCallerBudget(structuredClone(combined))) stats.overCallerBudget++
    const result = await driver.findMany({ filter: combined, pagination: { kind: "offset", page: 1, pageSize: PAGE_ALL } })
    check(`repository findMany (caller filter ${describeValue(callerFilter ?? null)}) with`, collection.scope, want, result.rows.map((row) => row.id))
  }, {
    runs,
    shrink: function* (value) {
      if (value.callerFilter) {
        const { callerFilter, ...rest } = value
        yield rest
        for (const smaller of shrinkPredicate(callerFilter)) yield { ...value, callerFilter: smaller }
      }
      for (const policies of shrinkPolicies(value.policies)) yield { ...value, policies }
    },
    describe: describePolicyCase,
    maxShrinkSteps: 300,
  })
  return stats
}

/** Base case counts at DIFFERENTIAL_SCALE=1 (each property also scales them). */
export const PREDICATE_RUNS = 3000
export const ABAC_RUNS = 600

export function summary(label: string, stats: { cases: number; nonTrivial: number; empty: number; all: number } & Partial<AbacParityStats>): string {
  const repository = stats.repository === undefined ? "" : `; repository findMany ${stats.repository} (${stats.withCallerFilter} with caller filter, ${stats.overCallerBudget} over the caller budget without the trusted brand)`
  return `${label}: ${stats.cases} cases (${stats.nonTrivial} non-trivial, ${stats.empty} empty, ${stats.all} all rows)${repository}; scale ${scaledRuns(1)}`
}
