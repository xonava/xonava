import { describe } from "vitest"
import { evaluatePredicate } from "../../domain/evaluatePredicate"
import { Predicate, type PredicateNode } from "../../domain/predicate"
import { bench, BENCH_OPTIONS } from "./benchOptions"

const record: Record<string, unknown> = {
  id: "ord_000123",
  status: "open",
  amount: 1250.5,
  quantity: 7,
  region: "emea",
  ownerId: "user-42",
  archived: false,
  deletedAt: null,
  name: "Quarterly maintenance contract renewal",
  tags: ["priority", "renewal", "contract"],
  dueAt: "2026-03-15T12:00:00Z",
}

const simple = Predicate.eq("status", "open")
const conjunction = Predicate.and(
  Predicate.eq("status", "open"),
  Predicate.gte("amount", 1000),
  Predicate.lt("quantity", 10),
  Predicate.isFalse("archived"),
  Predicate.isNull("deletedAt"),
)
const nested = Predicate.and(
  Predicate.or(Predicate.eq("region", "emea"), Predicate.eq("region", "apac"), Predicate.eq("ownerId", "user-42")),
  Predicate.not(Predicate.and(Predicate.eq("status", "closed"), Predicate.eq("archived", true))),
  Predicate.between("amount", [100, 5000]),
  Predicate.or(Predicate.contains("name", "maintenance"), Predicate.startsWith("name", "Annual")),
)
const largeIn = Predicate.in("ownerId", Array.from({ length: 100 }, (_, index) => `user-${index}`))
const arrayOps = Predicate.and(Predicate.includesAny("tags", ["renewal", "other"]), Predicate.includesAll("tags", ["priority", "contract"]))
const temporal = Predicate.and(Predicate.gte("dueAt", "2026-01-01T00:00:00Z"), Predicate.lt("dueAt", "2026-12-31T23:59:59Z"))
const wide = Predicate.or(...Array.from({ length: 20 }, (_, index) => Predicate.and(Predicate.eq("ownerId", `user-${index}`), Predicate.eq("status", "open"))))

function run(predicate: PredicateNode): () => void {
  return () => { evaluatePredicate(record, predicate) }
}

describe("evaluatePredicate", () => {
  bench("single equality", run(simple), BENCH_OPTIONS)
  bench("five-way conjunction", run(conjunction), BENCH_OPTIONS)
  bench("nested or/not/between/contains", run(nested), BENCH_OPTIONS)
  bench("in with 100 values", run(largeIn), BENCH_OPTIONS)
  bench("array includesAny/includesAll", run(arrayOps), BENCH_OPTIONS)
  bench("RFC 3339 range", run(temporal), BENCH_OPTIONS)
  bench("or of 20 conjunctions", run(wide), BENCH_OPTIONS)
})
