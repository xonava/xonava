// @ts-nocheck
import { createServer, request as httpRequest, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import express from 'express'
import { createFastifyHandler, fastifyCrudPlugin } from '../../fastify'
import { createExpressHandler } from '../../express'
import type { HttpHandler } from '../frameworkAdapter'
import { nodeRequest } from '../nodeAdapter'

const origin = 'https://api.example.test'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

async function liveServer(kind: string, handler: HttpHandler, maxBodyBytes = 1024) {
  let server: Server
  if (kind === 'fastify') {
    const app = Fastify()
    app.removeAllContentTypeParsers()
    app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
    app.all('/', createFastifyHandler(handler, { origin, maxBodyBytes }))
    await app.listen({ host: '127.0.0.1', port: 0 })
    server = app.server
    cleanup.push(async () => { server.closeAllConnections(); await app.close() })
  } else {
    const app = express()
    app.all('/', createExpressHandler(handler, { origin, maxBodyBytes }))
    server = createServer(app)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }))
  }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test server address')
  return `http://127.0.0.1:${address.port}`
}

describe.each(['fastify', 'express'])('%s live Node transport', kind => {
  it('aborts the Fetch signal when the client disconnects during a handler', async () => {
    const entered = Promise.withResolvers<Request>()
    const aborted = Promise.withResolvers<void>()
    const url = await liveServer(kind, async req => {
      entered.resolve(req)
      await new Promise<void>(resolve => req.signal.addEventListener('abort', () => { aborted.resolve(); resolve() }, { once: true }))
      return new Response(null, { status: 499 })
    })
    const client = httpRequest(url)
    client.on('error', () => undefined)
    client.end()
    const fetchRequest = await entered.promise
    expect(fetchRequest.signal.aborted).toBe(false)
    client.destroy()
    await aborted.promise
    expect(fetchRequest.signal.aborted).toBe(true)
  })

  it('cancels the Fetch response stream after the client disconnects', async () => {
    const canceled = Promise.withResolvers<void>()
    const url = await liveServer(kind, () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('first chunk')) },
      cancel() { canceled.resolve() },
    })))
    const client = httpRequest(url)
    client.on('error', () => undefined)
    client.on('response', response => { response.once('data', () => client.destroy()); response.on('error', () => undefined) })
    client.end()
    await canceled.promise
  })

  it('enforces body limits for chunked requests without Content-Length', async () => {
    const handler = vi.fn(() => new Response('unexpected'))
    const url = await liveServer(kind, handler, 4)
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const client = httpRequest(url, { method: 'POST', headers: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' } }, response => { response.resume(); resolve(response.statusCode) })
      client.on('error', reject)
      client.write('123')
      client.end('45')
    })
    expect(status).toBe(413)
    expect(handler).not.toHaveBeenCalled()
  })

  it('preserves invalid UTF-8 bytes for strict framework validation', async () => {
    const url = await liveServer(kind, async req => Response.json([...new Uint8Array(await req.arrayBuffer())]))
    const res = await fetch(url, { method: 'POST', body: new Uint8Array([0xc3, 0x28]), headers: { 'content-type': 'application/json' } })
    expect(await res.json()).toEqual([0xc3, 0x28])
  })

  it('terminates failed response streams without substituting a second response', async () => {
    const url = await liveServer(kind, () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('partial')); setTimeout(() => controller.error(new Error('stream failure')), 20) },
    })))
    await expect(fetch(url).then(response => response.text())).rejects.toThrow()
  })
})

it('rejects parsed Fastify JSON rather than silently reserializing it', async () => {
  const app = Fastify()
  cleanup.push(() => app.close())
  const handler = vi.fn(() => new Response('unsafe'))
  app.post('/', createFastifyHandler(handler, { origin }))
  expect((await app.inject({ method: 'POST', url: '/', payload: { x: 1 } })).statusCode).toBe(500)
  expect(handler).not.toHaveBeenCalled()
})

it('limits raw Fastify plugin bodies before application execution', async () => {
  const app = Fastify()
  cleanup.push(() => app.close())
  const handler = vi.fn(() => new Response('unsafe'))
  await app.register(fastifyCrudPlugin, { origin, maxBodyBytes: 4, handlers: { list: handler, detail: handler, create: handler, update: handler, delete: handler } })
  expect((await app.inject({ method: 'POST', url: '/', payload: '12345', headers: { 'content-type': 'text/plain' } })).statusCode).toBe(413)
  expect(handler).not.toHaveBeenCalled()
})

it('does not resolve protocol-relative paths against an attacker origin', () => {
  const raw = { method: 'GET', rawHeaders: [], socket: {} } as unknown as import('node:http').IncomingMessage
  const request = nodeRequest(raw, '//evil.test/path', origin, undefined, new AbortController().signal)
  expect(new URL(request.url).origin).toBe(origin)
  expect(new URL(request.url).pathname).toBe('//evil.test/path')
})
