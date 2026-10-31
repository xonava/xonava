import pg from "pg"
import { bootstrapPostgresFixture } from "../../fixtures/postgres/bootstrap.js"
import { resetPostgresFixture } from "../../fixtures/postgres/reset.js"

export function pgCertificationUrl(): string {
  const value = process.env.FRAMEWORK_TEST_PG_URL ?? process.env.DATABASE_URL
  if (!value) throw new Error("PostgreSQL integration tests require FRAMEWORK_TEST_PG_URL (or DATABASE_URL); the suite fails closed")
  return value
}

export async function openPgFixture(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: pgCertificationUrl() })
  await client.connect()
  await bootstrapPostgresFixture(client)
  await resetPostgresFixture(client)
  return client
}

export async function connectPg(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: pgCertificationUrl() })
  await client.connect()
  return client
}
