import { ConfigurationError } from "@xonava/core/domain"

/** Validates a PostgreSQL schema identifier before it is interpolated into SQL. */
export function pgSchemaName(schema: string): string {
  if (typeof schema !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) throw new ConfigurationError("Unsafe PostgreSQL schema name")
  return schema
}
