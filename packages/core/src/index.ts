// Root-level API is intentionally small. Capability families live behind the
// named package subpaths recorded in approvedFrameworkExports.json.
export { defineEntity, compileEntity, isCompiledEntityDefinition } from "./entity/index"
export type {
  BrandedEntityDefinition,
  CompiledEntityDefinition,
  EntityDefinition,
  EntityDefinitionInput,
} from "./entity/index"
export {
  createOperation,
  runOperation,
  runOperationDetailed,
  OperationCommittedEffectError,
} from "./operation/index"
export type {
  OperationDefinition,
  OperationOutcome,
  OperationRunner,
} from "./operation/index"
