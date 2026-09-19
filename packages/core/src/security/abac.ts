export interface AbacWriteEnforcer {
  enforce(action: string, record: Record<string, unknown>, changedFields?: string[]): void
}
