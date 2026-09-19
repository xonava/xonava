export const D1_FIXTURE_MIGRATIONS = ["0001_framework.sql"] as const
export interface D1FixtureDatabase { exec(sql: string): Promise<unknown> }
