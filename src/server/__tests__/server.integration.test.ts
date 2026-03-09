import { FastifyInstance } from 'fastify'
import { createApp } from '../app'

let app: FastifyInstance

beforeAll(async () => {
  app = await createApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

// ---------- GET /health ----------

describe('GET /health', () => {
  test('should return 200 with status ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})

// ---------- GET /vrm/:filename ----------

describe('GET /vrm/:filename', () => {
  test('existing VRM file should return 200 with correct Content-Type', async () => {
    const res = await app.inject({ method: 'GET', url: '/vrm/default.vrm' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('model/gltf-binary')
    expect(res.rawPayload.length).toBeGreaterThan(0)
  })

  test('non-existent file should return 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/vrm/nonexistent.vrm' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'VRM not found' })
  })

  test('raw=true should return original binary', async () => {
    const res = await app.inject({ method: 'GET', url: '/vrm/default.vrm?raw=true' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('model/gltf-binary')
    // glTF magic bytes: 0x46546C67 ("glTF")
    expect(res.rawPayload.readUInt32LE(0)).toBe(0x46546C67)
  })

  test('raw=true with non-existent file should return 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/vrm/missing.vrm?raw=true' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'VRM not found' })
  })

  test('second request should return cached data (same response)', async () => {
    // First request populates cache
    const res1 = await app.inject({ method: 'GET', url: '/vrm/default.vrm' })
    expect(res1.statusCode).toBe(200)

    // Second request should hit cache
    const res2 = await app.inject({ method: 'GET', url: '/vrm/default.vrm' })
    expect(res2.statusCode).toBe(200)
    expect(res2.headers['content-type']).toBe('model/gltf-binary')
    // Cached response should be identical
    expect(Buffer.compare(res1.rawPayload, res2.rawPayload)).toBe(0)
  })
})

// ---------- CORS ----------

describe('CORS', () => {
  test('should return Access-Control-Allow-Origin header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:3000' },
    })
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000')
  })

  test('OPTIONS preflight should return correct CORS headers', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'GET',
      },
    })
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000')
  })
})
