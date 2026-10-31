/* eslint-disable @typescript-eslint/require-await */
import type { ScopedFrameworkValidatedContext } from "./createFrameworkWriteHandler"
import { createListHandler } from "./crudHandlers/list"
import { createDetailHandler } from "./crudHandlers/detail"
import { createCreateHandler } from "./crudHandlers/create"
import { createUpdateHandler } from "./crudHandlers/update"
import { createDeleteHandler } from "./crudHandlers/delete"
import { buildScopeCacheTags, createShared } from "./crudHandlers/shared"
import { defaultIdParams, type CrudOptions, type CrudRoutesConfig, type CrudShared, type SelectableRow } from "./crudHandlers/types"
import type { RequestContext } from "@xonava/core/domain"
import type { RuntimeCapabilities } from "@xonava/core/bootstrap"
import type { SortSpec } from "@xonava/core/query"
import { frameworkJson } from "./handleFrameworkCoreError"

export type { CrudOptions }

export function createCrudHandlersInternal<TRow extends SelectableRow, TCreateBody = TRow, TUpdateBody = Partial<TRow>, TListRow extends SelectableRow = TRow, TDetailRow extends SelectableRow = TRow>(options: CrudOptions<TRow, TCreateBody, TUpdateBody, TListRow, TDetailRow>) {
  const capabilityMode = options.policy.skipCapabilityCheck === true ? { enabled: false, key: undefined } : options.policy.customCapabilityKey ? { enabled: true, key: options.policy.customCapabilityKey } : { enabled: false, key: undefined }
  const routes: CrudRoutesConfig = { list: options.routes?.list !== false, detail: options.routes?.detail !== false, create: options.routes?.create !== false, update: options.routes?.update !== false, delete: options.routes?.delete !== false }
  const writeRuntimeCapabilities: RuntimeCapabilities = options.runtimeCapabilities
  const invalidateTags = options.cache.enabled !== true ? undefined : async (_validated: ScopedFrameworkValidatedContext, context: RequestContext) => buildScopeCacheTags(options.cache.tag, context)
  const scope = { ...options.scope, idempotency: options.scope.idempotency ?? { required: true } }
  const base = { options: { ...options, scope }, entity: options.entity, deps: options.adapterDeps, idParamsSchema: options.validation?.idParams ?? defaultIdParams, capabilityMode, writeCapabilityConfig: capabilityMode.enabled ? { customCapabilityKey: capabilityMode.key } : { skipCapabilityCheck: true }, routes, writeRuntimeCapabilities, ...(invalidateTags ? { invalidateTags } : {}), resolveDefaultSort: (): SortSpec[] | undefined => options.listDefaults?.sortColumn ? [{ field: options.listDefaults.sortColumn, direction: options.listDefaults.sortDesc ? "desc" : "asc" }] : undefined }
  const shared = { ...base, ...createShared(options, routes, capabilityMode) } as CrudShared<TRow, TCreateBody, TUpdateBody, TListRow, TDetailRow>
  const list = createListHandler(shared); const detail = createDetailHandler(shared); // Write handlers are built only for enabled routes, so a disabled route needs no binding.
  const create = routes.create ? createCreateHandler(shared) : undefined; const update = routes.update ? createUpdateHandler(shared) : undefined; const deleteHandler = routes.delete ? createDeleteHandler(shared) : undefined
  return { list, detail, create: async (request: Request) => create ? create(request) : methodNotAllowed(), update: async (request: Request, context?: { params?: Promise<unknown> }) => update ? update(request, context) : methodNotAllowed(), delete: async (request: Request, context?: { params?: Promise<unknown> }) => deleteHandler ? deleteHandler(request, context) : methodNotAllowed() }
}

function methodNotAllowed(): Response { return frameworkJson({ error: "Method Not Allowed" }, { status: 405 }) }
