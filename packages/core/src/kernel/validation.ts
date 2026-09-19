export interface ValidationSchema<T = unknown> {
  parse(input: unknown): T
  parseAsync(input: unknown): Promise<T>
}
