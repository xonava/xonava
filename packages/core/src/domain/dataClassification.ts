export type DataClassification = "public" | "internal" | "confidential" | "restricted"
export type DataHandlingPurpose = "audit" | "telemetry" | "search" | "export" | "data-protection"
export type FieldDataClassifications<TRow = Record<string, unknown>> = Readonly<Partial<Record<keyof TRow & string, DataClassification>>>

const PURPOSE_MAXIMUM: Record<DataHandlingPurpose, DataClassification> = { audit: "confidential", telemetry: "internal", search: "confidential", export: "restricted", "data-protection": "restricted" }
const RANK: Record<DataClassification, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 }

export function fieldsAllowedForPurpose<TRow>(classifications: FieldDataClassifications<TRow>, purpose: DataHandlingPurpose): readonly string[] {
  const maximum = RANK[PURPOSE_MAXIMUM[purpose]]
  return Object.freeze(Object.entries(classifications).filter(([, classification]) => RANK[classification as DataClassification] <= maximum).map(([field]) => field))
}
