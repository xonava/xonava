import { fieldsAllowedForPurpose, type DataClassification } from "../domain/dataClassification"

/** Effective per-field classification: descriptor classifications overridden by the entity map. */
export function entityFieldClassifications(
  fields: unknown,
  dataClassification: Readonly<Record<string, unknown>> | undefined,
): Record<string, DataClassification> {
  const declared = fields && typeof fields === "object"
    ? Object.entries(fields as Record<string, { classification?: DataClassification } | undefined>)
        .flatMap(([field, descriptor]) => descriptor?.classification ? [[field, descriptor.classification] as const] : [])
    : []
  return { ...Object.fromEntries(declared), ...(dataClassification ?? {}) } as Record<string, DataClassification>
}

/**
 * Filter/sort are as revealing as search (oracle by predicate or ordering), so
 * every caller-influenced query surface uses the search classification ceiling.
 */
export function queryableFieldFilter(classifications: Readonly<Record<string, DataClassification>>): (field: string) => boolean {
  const searchAllowed = fieldsAllowedForPurpose(classifications, "search")
  return (field: string) => !Object.hasOwn(classifications, field) || searchAllowed.includes(field)
}
