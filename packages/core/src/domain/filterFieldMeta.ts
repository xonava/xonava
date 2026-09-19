export type FilterFieldType = "string" | "number" | "boolean" | "date"

export interface FilterFieldMeta {
  columnName?: string
  kind?: FilterFieldType
}
