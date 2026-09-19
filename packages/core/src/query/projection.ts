import { ValidationError } from "../domain/errors.js"
export interface ProjectionSpec { readonly fields: readonly string[] }
export function resolveProjection(requested: ProjectionSpec | undefined, routeFields: readonly string[], queryableFields: readonly string[], readableFields: readonly string[]): ProjectionSpec {
  const allowed = new Set(routeFields.filter(field => queryableFields.includes(field) && readableFields.includes(field)))
  const fields = requested?.fields ?? [...allowed]
  if (new Set(fields).size !== fields.length || fields.some(field => !allowed.has(field))) throw new ValidationError("projection contains a forbidden, hidden, duplicate, or non-queryable field")
  return Object.freeze({ fields: Object.freeze([...fields]) })
}
