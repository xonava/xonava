export type BuiltInScalarKind = "string" | "boolean" | "integer" | "decimal" | "date" | "datetime" | "uuid" | "enum" | "json"

export type ScalarDescriptor =
  | { readonly type: "string"; readonly format?: "text" | "email" | "phone" | "identifier" }
  | { readonly type: "boolean" }
  | { readonly type: "integer"; readonly minimum?: number; readonly maximum?: number }
  | { readonly type: "decimal"; readonly precision: number; readonly scale: number }
  | { readonly type: "date" | "datetime" }
  | { readonly type: "uuid" }
  | { readonly type: "enum"; readonly values: readonly string[] }
  | { readonly type: "json" }
  | { readonly type: "custom"; readonly durableCodec: string }
