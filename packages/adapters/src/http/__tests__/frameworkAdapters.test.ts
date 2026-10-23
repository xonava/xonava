// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest"
import Fastify from "fastify"
import { Hono } from "hono"
import express from "express"
import supertest from "supertest"
import { z } from "zod"
import { ForbiddenError, ValidationError } from "@xonava/core/domain"
import { createFastifyHandler, fastifyCrudPlugin } from "../../fastify"
import { createHonoHandler, createHonoCrudApp } from "../../hono"
import { createExpressHandler, createExpressCrudRouter } from "../../express"
import { parseJsonBodySafely, parseUniqueQueryParameters } from "../requestBody"
import { resolveAdapterHttpMetadata, type HttpHandler, type HttpCrudHandlers } from "../frameworkAdapter"
import { httpCrudFixture } from "./httpCrudFixture"
import { createFrameworkWriteHandler } from "../createFrameworkWriteHandler"
import { allowAllAbacBundle, allowAllModuleFacts, canonicalRequestNormalization } from "./canonicalRequest"
import type { IdempotencyPort } from "@xonava/core/events"

const origin = 'https://api.example.test'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

interface Result { status: number; headers: Headers; bytes: Uint8Array; text: string }
type Send = (method: string, path: string, body?: string, headers?: Record<string, string>) => Promise<Result>

async function harness(kind: string, handler: HttpHandler, maxBodyBytes = 1024, crud?: HttpCrudHandlers): Promise<Send> {
  if (kind === 'fastify') {
    const app = Fastify()
    cleanup.push(() => app.close())
    if (crud) await app.register(fastifyCrudPlugin, { prefix: '/api/people', handlers: crud, origin, maxBodyBytes })
    else {
      app.removeAllContentTypeParsers()
      app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
      app.all('/api/people/:id', createFastifyHandler(handler, { origin, maxBodyBytes }))
    }
    await app.ready()
    return async (method, path, body, headers) => {
      const res = await app.inject({ method: method as 'GET', url: path, ...(body !== undefined ? { payload: body } : {}), ...(headers ? { headers } : {}) })
      const resultHeaders = new Headers()
      for (const [key, value] of Object.entries(res.headers)) {
        for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) resultHeaders.append(key, String(item))
      }
      return { status: res.statusCode, headers: resultHeaders, bytes: res.rawPayload, text: res.body }
    }
  }
  if (kind === 'hono') {
    const app = new Hono()
    if (crud) app.route('/api/people', createHonoCrudApp(crud))
    else app.all('/api/people/:id', createHonoHandler(handler, { resolveHttpMetadata: () => ({ peerAddress: '127.0.0.1' }) }))
    return async (method, path, body, headers) => {
      const res = await app.request(origin + path, { method, ...(body !== undefined ? { body } : {}), ...(headers ? { headers } : {}) })
      const bytes = new Uint8Array(await res.arrayBuffer())
      return { status: res.status, headers: res.headers, bytes, text: new TextDecoder().decode(bytes) }
    }
  }
  const app = express()
  if (crud) app.use('/api/people', createExpressCrudRouter(crud, { origin, maxBodyBytes }))
  else {
    const router = express.Router()
    router.all('/:id', createExpressHandler(handler, { origin, maxBodyBytes }))
    app.use('/api/people', router)
  }
  return async (method, path, body, headers) => {
    const client = supertest(app)
    const call = method === 'GET' ? client.get(path) : method === 'HEAD' ? client.head(path) : method === 'POST' ? client.post(path) : method === 'PATCH' ? client.patch(path) : method === 'DELETE' ? client.delete(path) : client.put(path)
    if (headers) call.set(headers)
    if (body !== undefined) call.send(body)
    const res = await call
    const resultHeaders = new Headers()
    for (const [key, value] of Object.entries(res.headers)) {
      for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) resultHeaders.append(key, String(item))
    }
    const bytes = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.text ?? '')
    return { status: res.status, headers: resultHeaders, bytes, text: new TextDecoder().decode(bytes) }
  }
}

describe.each(['fastify', 'hono', 'express'])('%s HTTP adapter', kind => {
  it('replays an actual idempotent framework write without executing it', async () => {
    const execute = vi.fn()
    const acquire = vi.fn(async () => ({ outcome: 'replay' as const, result: { version: 'v1', body: '{"id":"existing"}', status: 201, headers: [['content-type', 'application/json']] } }))
    const handler = createFrameworkWriteHandler({
      adapterDeps: {
        assertValidCsrf: () => undefined,
        resolveModuleAuthorizationFacts: allowAllModuleFacts,
        resolveAbacBundle: async ({ moduleKey }) => allowAllAbacBundle(moduleKey),
        createIdempotencyPort: <T>() => ({ acquire, renew: vi.fn(), complete: vi.fn(), markCommittedInTransaction: vi.fn() }) as unknown as IdempotencyPort<T>,
      },
      requestNormalization: canonicalRequestNormalization(undefined, 'http.replay'),
      moduleKey: 'http.replay', action: 'create', skipCapabilityCheck: true,
      scope: { scope: 'platform', idempotency: { required: true } },
      createPersistence: vi.fn(),
      definition: { key: 'http.replay.create', kind: 'mutation', atomicity: { kind: 'standard', mode: 'required' }, authorization: { authorize: async () => ({ allowed: true }) }, execute },
      resolveInput: async () => ({}),
      resolveResourceIdentity: () => ({ entity: 'http.replay', id: 'existing' }),
      recoverCommittedResponse: async () => ({ id: 'existing' }),
      validation: { body: z.object({ name: z.string() }) },
    })
    const send = await harness(kind, handler)
    const res = await send('POST', '/api/people/1', '{"name":"Ada"}', { 'content-type': 'application/json', 'idempotency-key': 'key-1' })
    expect(res.status, res.text).toBe(201)
    expect(JSON.parse(res.text)).toEqual({ id: 'existing' })
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ key: 'key-1' }))
    expect(execute).not.toHaveBeenCalled()
    expect(res.headers.get('x-request-id')).toBeTruthy()
  })

  it('executes compiled CRUD create/list/detail/update/delete with tenant scope and OCC', async () => {
    const { handlers, rows } = httpCrudFixture()
    rows.set('other-tenant', { id: 'other-tenant', tenantId: 'tenant-2', name: 'private', version: 1 })
    const send = await harness(kind, handlers.list, 1024, handlers)
    const created = await send('POST', '/api/people', '{"name":"Ada"}', { 'content-type': 'application/json', 'x-correlation-id': 'crud-test' })
    expect(created.status, created.text).toBe(201)
    expect(created.headers.get('x-request-id')).toBeTruthy()
    expect(created.headers.get('x-correlation-id')).toBe('crud-test')
    const row = JSON.parse(created.text) as { id: string; name: string; version: number }
    expect(row).toMatchObject({ name: 'Ada', version: 1 })
    expect(rows.get(row.id)?.tenantId).toBe('tenant-1')
    const list = await send('GET', '/api/people')
    expect(list.status, list.text).toBe(200)
    expect(list.text).toContain('Ada')
    expect(list.text).not.toContain('private')
    expect((await send('GET', '/api/people/other-tenant')).status).toBe(404)
    expect((await send('GET', '/api/people/' + row.id)).status).toBe(200)
    const updated = await send('PATCH', '/api/people/' + row.id, '{"name":"Grace"}', { 'content-type': 'application/json', 'if-match': '1' })
    expect(updated.status, updated.text).toBe(200)
    expect(JSON.parse(updated.text)).toMatchObject({ name: 'Grace', version: 2 })
    expect((await send('PATCH', '/api/people/' + row.id, '{"name":"stale"}', { 'content-type': 'application/json', 'if-match': '1' })).status).toBe(409)
    const deleted = await send('DELETE', '/api/people/' + row.id, undefined, { 'if-match': '2' })
    expect(deleted.status, deleted.text).toBe(200)
    expect((await send('GET', '/api/people/' + row.id)).status).toBe(404)
    expect(rows.has('other-tenant')).toBe(true)
  })

  // The Fetch Request API rejects a body on GET, so the Hono harness cannot send one; Fastify and Express can.
  it.skipIf(kind === 'hono')('answers list and detail GET requests normally when a body is sent, because they never read one', async () => {
    const { handlers, rows } = httpCrudFixture()
    rows.set('person-1', { id: 'person-1', tenantId: 'tenant-1', name: 'Ada', version: 1 })
    const send = await harness(kind, handlers.list, 1024, handlers)
    const list = await send('GET', '/api/people', '{"name":"ignored"}', { 'content-type': 'application/json' })
    expect(list.status, list.text).toBe(200)
    expect(list.text).toContain('Ada')
    const detail = await send('GET', '/api/people/person-1', '{"name":"ignored"}', { 'content-type': 'application/json' })
    expect(detail.status, detail.text).toBe(200)
    expect(JSON.parse(detail.text)).toMatchObject({ id: 'person-1', name: 'Ada' })
    expect(rows.get('person-1')?.name).toBe('Ada')
  })

  // The Node transports buffer and size-check every method's body before routing, so an oversize GET body is refused.
  it.skipIf(kind === 'hono')('refuses an oversize GET body at the Node transport with 413 before the handler runs', async () => {
    const { handlers, repository } = httpCrudFixture()
    const send = await harness(kind, handlers.list, 1024, handlers)
    const res = await send('GET', '/api/people', 'x'.repeat(2048), { 'content-type': 'application/json' })
    expect(res.status, res.text).toBe(413)
    expect(JSON.parse(res.text)).toEqual({ error: "Request body is too large", code: "REQUEST_BODY_TOO_LARGE" })
    expect(repository.findMany).not.toHaveBeenCalled()
  })

  it('preserves actual CRUD authorization denials and disabled-route responses', async () => {
    for (const disabled of [false, true]) {
      const { handlers, repository } = httpCrudFixture({ deny: true, disabled })
      const send = await harness(kind, handlers.list, 1024, handlers)
      for (const [method, path] of [['GET', '/api/people'], ['GET', '/api/people/1'], ['POST', '/api/people'], ['PATCH', '/api/people/1'], ['DELETE', '/api/people/1']]) {
        const res = await send(method!, path!, method === 'POST' || method === 'PATCH' ? '{"name":"Ada"}' : undefined, { 'content-type': 'application/json' })
        expect(res.status, res.text).toBe(disabled ? 405 : 403)
      }
      expect(repository.insert).not.toHaveBeenCalled()
      expect(repository.findMany).not.toHaveBeenCalled()
    }
  })

  it('preserves method, full mounted path, query encoding, headers, and decoded params', async () => {
    const send = await harness(kind, async (req, context) => Response.json({ method: req.method, url: req.url, authorization: req.headers.get('authorization'), params: await context?.params }))
    const res = await send('PATCH', '/api/people/a%20b?q=a%2Bb&q=second', '{}', { 'content-type': 'application/json', authorization: 'Bearer test' })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.text)).toEqual({ method: 'PATCH', url: origin + '/api/people/a%20b?q=a%2Bb&q=second', authorization: 'Bearer test', params: { id: 'a b' } })
  })

  it('preserves raw UTF-8 body bytes and cloning', async () => {
    const body = '{ "name": "é😀", "n": 1.00 }'
    const send = await harness(kind, async req => Response.json({ text: await req.clone().text(), bytes: [...new Uint8Array(await req.arrayBuffer())] }))
    const res = await send('POST', '/api/people/1', body, { 'content-type': 'application/json' })
    expect(JSON.parse(res.text)).toEqual({ text: body, bytes: [...new TextEncoder().encode(body)] })
  })

  it.each([
    ['{"name":"Ada"}', 'application/json', 200],
    ['{"name":"Ada"}', 'application/vnd.example+json', 200],
    ['{broken', 'application/json', 400],
    ['{}', 'application/json', 400],
    ['{"name":"Ada"}', 'text/plain', 415],
    ['{"name":"Ada"}', 'application/json;charset=latin1', 415],
  ])('retains framework body validation for %s / %s', async (body, contentType, status) => {
    const send = await harness(kind, async req => Response.json(await parseJsonBodySafely(req, z.object({ name: z.string() }))))
    expect((await send('POST', '/api/people/1', body, { 'content-type': contentType })).status).toBe(status)
  })

  it('enforces the shared JSON body limit', async () => {
    const send = await harness(kind, async req => Response.json(await parseJsonBodySafely(req, z.object({ name: z.string() }), 12)))
    const res = await send('POST', '/api/people/1', '{"name":"a long value"}', { 'content-type': 'application/json' })
    expect(res.status).toBe(413)
    expect(JSON.parse(res.text).code).toBe('REQUEST_BODY_TOO_LARGE')
  })

  it('leaves duplicate query rejection to the shared parser', async () => {
    const send = await harness(kind, req => Response.json(parseUniqueQueryParameters(req)))
    expect((await send('GET', '/api/people/1?limit=1&limit=2')).status).toBe(400)
  })

  it('maps domain failures and redacts unexpected error details', async () => {
    for (const [error, status] of [[new ValidationError('bad input'), 400], [new ForbiddenError('denied'), 403], [new Error('database password secret'), 500]] as const) {
      const send = await harness(kind, () => { throw error })
      const res = await send('GET', '/api/people/1')
      expect(res.status).toBe(status)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.text).not.toContain('database password secret')
    }
  })

  it('preserves response status, metadata, retry and separate cookies', async () => {
    const send = await harness(kind, () => {
      const headers = new Headers({ 'retry-after': '3', 'x-request-id': 'request-123', 'x-correlation-id': 'correlation-123', 'cache-control': 'no-store' })
      headers.append('set-cookie', 'session=a; Path=/; HttpOnly; Expires=Wed, 21 Oct 2030 07:28:00 GMT')
      headers.append('set-cookie', 'csrf=b; Path=/; Secure')
      return Response.json({ code: 'RATE_LIMIT_EXCEEDED' }, { status: 429, headers })
    })
    const res = await send('GET', '/api/people/1')
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('3')
    expect(res.headers.get('x-request-id')).toBe('request-123')
    expect(res.headers.get('x-correlation-id')).toBe('correlation-123')
    expect(res.headers.getSetCookie()).toHaveLength(2)
    expect(res.headers.getSetCookie()[0]).toContain('Expires=Wed,')
  })

  it('transfers a binary stream without JSON serialization', async () => {
    const send = await harness(kind, () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0, 1, 128, 255])); controller.close() } }), { headers: { 'content-type': 'application/octet-stream' } }))
    expect([...(await send('GET', '/api/people/1')).bytes]).toEqual([0, 1, 128, 255])
  })

  it.each([204, 304])('preserves a bodyless %i response', async status => {
    const send = await harness(kind, () => new Response(null, { status, headers: { etag: '"v1"' } }))
    const res = await send('GET', '/api/people/1')
    expect(res.status).toBe(status)
    expect(res.text).toBe('')
    expect(res.headers.get('etag')).toBe('"v1"')
  })

  it('suppresses HEAD response bodies', async () => {
    const send = await harness(kind, () => new Response('invisible', { headers: { 'x-test': 'head' } }))
    const res = await send('HEAD', '/api/people/1')
    expect(res.text).toBe('')
    expect(res.headers.get('x-test')).toBe('head')
  })

  it('exposes transport metadata without trusting forwarded headers', async () => {
    const send = await harness(kind, req => Response.json(resolveAdapterHttpMetadata(req)))
    const res = await send('GET', '/api/people/1', undefined, { 'x-forwarded-for': 'attacker', 'x-real-ip': 'attacker' })
    expect(JSON.parse(res.text).peerAddress).toBeTruthy()
    expect(JSON.parse(res.text).peerAddress).not.toBe('attacker')
    expect(JSON.parse(res.text).trustedProxy).toBeUndefined()
  })

  it('mounts all five CRUD handlers with their correct parameter conventions', async () => {
    const handlers: HttpCrudHandlers = {
      list: () => Response.json({ op: 'list' }),
      detail: (_req, params) => Response.json({ op: 'detail', params }),
      create: () => Response.json({ op: 'create' }, { status: 201 }),
      update: async (_req, context) => Response.json({ op: 'update', params: await context?.params }),
      delete: async (_req, context) => Response.json({ op: 'delete', params: await context?.params }),
    }
    const send = await harness(kind, handlers.list, 1024, handlers)
    for (const [method, path, op, status] of [
      ['GET', '/api/people', 'list', 200], ['POST', '/api/people', 'create', 201],
      ['GET', '/api/people/a%20b', 'detail', 200], ['PATCH', '/api/people/a%20b', 'update', 200], ['DELETE', '/api/people/a%20b', 'delete', 200],
    ] as const) {
      const res = await send(method, path)
      expect(res.status).toBe(status)
      expect(JSON.parse(res.text)).toEqual({ op, ...(['detail', 'update', 'delete'].includes(op) ? { params: { id: 'a b' } } : {}) })
    }
    expect((await send('PUT', '/api/people/1')).status).toBe(404)
  })
})

describe.each(['fastify', 'express'])('%s Node transport boundaries', kind => {
  it('enforces byte limits before invoking the handler', async () => {
    const handler = vi.fn(() => new Response('must not run'))
    const send = await harness(kind, handler, 4)
    expect((await send('POST', '/api/people/1', '😀a', { 'content-type': 'text/plain' })).status).toBe(413)
    expect(handler).not.toHaveBeenCalled()
  })

  it('accepts bodies exactly at the byte limit', async () => {
    const send = await harness(kind, req => req.text().then(text => new Response(text)), 4)
    expect((await send('POST', '/api/people/1', '😀', { 'content-type': 'text/plain' })).text).toBe('😀')
  })

  it('uses the configured origin despite hostile host and proxy headers', async () => {
    const send = await harness(kind, req => new Response(req.url))
    const res = await send('GET', '/api/people/1', undefined, { host: 'evil.test', 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'http' })
    expect(res.text).toBe(origin + '/api/people/1')
  })

  it('strips hop-by-hop response headers and connection-nominated fields', async () => {
    const send = await harness(kind, () => new Response('ok', { headers: { connection: 'x-private', 'x-private': 'secret', 'keep-alive': 'timeout=1234' } }))
    const res = await send('GET', '/api/people/1')
    expect(res.headers.get('x-private')).toBeNull()
    expect(res.headers.get('keep-alive')).not.toBe('timeout=1234')
  })
})

describe('configuration and middleware integration', () => {
  it.each(['file:///tmp', 'https://user:password@example.test', 'https://example.test/path', 'https://example.test/?q=1'])('rejects unsafe origin %s', origin => {
    expect(() => createFastifyHandler(() => new Response(), { origin })).toThrow()
    expect(() => createExpressHandler(() => new Response(), { origin })).toThrow()
  })

  it.each([-1, 1.5, NaN, Infinity])('rejects invalid maxBodyBytes %s', maxBodyBytes => {
    expect(() => createFastifyHandler(() => new Response(), { origin, maxBodyBytes })).toThrow()
    expect(() => createExpressHandler(() => new Response(), { origin, maxBodyBytes })).toThrow()
  })

  it('fails closed if Express JSON middleware already parsed the request', async () => {
    const app = express()
    const handler = vi.fn(() => new Response('unsafe'))
    const reportError = vi.fn()
    app.use(express.json())
    app.post('/', createExpressHandler(handler, { origin, reportError }))
    const res = await supertest(app).post('/').send({ value: 1 })
    expect(res.status).toBe(500)
    expect(handler).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledOnce()
  })

  it('accepts Express raw middleware', async () => {
    const app = express()
    app.use(express.raw({ type: '*/*', inflate: false }))
    app.post('/', createExpressHandler(async req => new Response(await req.text()), { origin }))
    const res = await supertest(app).post('/').set('content-type', 'application/json').send('{ "value": 1 }')
    expect(res.text).toBe('{ "value": 1 }')
  })

  it('keeps Fastify raw parsing encapsulated', async () => {
    const app = Fastify()
    cleanup.push(() => app.close())
    const echo = async (req: Request) => new Response(await req.text())
    await app.register(fastifyCrudPlugin, { origin, prefix: '/people', handlers: { list: echo, detail: echo, create: echo, update: echo, delete: echo } })
    app.post('/native', req => ({ parsed: typeof req.body }))
    expect((await app.inject({ method: 'POST', url: '/native', payload: { a: 1 } })).json()).toEqual({ parsed: 'object' })
    expect((await app.inject({ method: 'POST', url: '/people/', payload: '{ broken', headers: { 'content-type': 'application/json' } })).body).toBe('{ broken')
  })

  it('reports async failures and preserves Hono middleware response headers', async () => {
    const app = new Hono()
    const reportError = vi.fn()
    app.use('*', async (c, next) => { await next(); c.header('x-middleware', 'present') })
    app.get('/', createHonoHandler(async () => { throw new Error('secret') }, { reportError }))
    const response = await app.request('/')
    expect(response.status).toBe(500)
    expect(response.headers.get('x-middleware')).toBe('present')
    expect(reportError).toHaveBeenCalledOnce()
  })
})
