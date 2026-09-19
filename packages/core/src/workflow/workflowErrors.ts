import { FrameworkCoreError } from "../domain/errors"

export class WorkflowDefinitionError extends FrameworkCoreError {
  constructor(message: string, details?: unknown) { super(message, "CONFIGURATION_ERROR", details) }
}
export class WorkflowStateError extends FrameworkCoreError {
  constructor(message: string, details?: unknown) { super(message, "CONFLICT", details) }
}
export class WorkflowLeaseLostError extends FrameworkCoreError {
  constructor(message = "Workflow lease was lost", details?: unknown) { super(message, "STALE_CLAIM", details) }
}
export class WorkflowVersionError extends FrameworkCoreError {
  constructor(message: string, details?: unknown) { super(message, "VALIDATION_ERROR", details) }
}
