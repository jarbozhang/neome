import Fastify, { FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import WebSocket from 'ws'
import { WSMessage } from '../../shared/types'
import { VoiceSession } from '../voiceSession'

// ---------- 辅助函数 ----------

/** 短暂等待 */
const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * 创建 WebSocket 客户端，连接时自动缓存所有收到的消息。
 * 返回 ws 实例和辅助方法。
 */
function createTrackedClient(url: string): {
  ws: WebSocket
  waitForOpen: (timeout?: number) => Promise<void>
  waitForClose: (timeout?: number) => Promise<void>
  waitForMessage: (type: string, timeout?: number) => Promise<WSMessage>
  allMessages: WSMessage[]
} {
  const ws = new WebSocket(url)
  const allMessages: WSMessage[] = []
  const pendingResolvers: Array<{ type: string; resolve: (msg: WSMessage) => void; timer: ReturnType<typeof setTimeout> }> = []

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString()) as WSMessage
      allMessages.push(msg)
      // 检查是否有 pending 的 waitForMessage
      for (let i = pendingResolvers.length - 1; i >= 0; i--) {
        if (pendingResolvers[i].type === msg.type) {
          const { resolve, timer } = pendingResolvers[i]
          clearTimeout(timer)
          pendingResolvers.splice(i, 1)
          resolve(msg)
        }
      }
    } catch (_) {
      // 非 JSON，忽略
    }
  })

  return {
    ws,
    allMessages,

    waitForOpen(timeout = 3000) {
      return new Promise((resolve, reject) => {
        if (ws.readyState === WebSocket.OPEN) return resolve()
        const timer = setTimeout(() => reject(new Error('Timeout waiting for WS open')), timeout)
        ws.once('open', () => { clearTimeout(timer); resolve() })
        ws.once('error', (err) => { clearTimeout(timer); reject(err) })
      })
    },

    waitForClose(timeout = 3000) {
      return new Promise((resolve, reject) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve()
        const timer = setTimeout(() => reject(new Error('Timeout waiting for WS close')), timeout)
        ws.once('close', () => { clearTimeout(timer); resolve() })
      })
    },

    waitForMessage(type: string, timeout = 3000) {
      // 先检查已缓存的消息
      const existing = allMessages.find(m => m.type === type)
      if (existing) return Promise.resolve(existing)

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = pendingResolvers.findIndex(r => r.timer === timer)
          if (idx >= 0) pendingResolvers.splice(idx, 1)
          reject(new Error(`Timeout waiting for ${type}`))
        }, timeout)
        pendingResolvers.push({ type, resolve, timer })
      })
    },
  }
}

// ---------- 测试服务器搭建 ----------

let createdSessions: VoiceSession[] = []

async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(websocket)

  app.get('/ws', { websocket: true }, (socket) => {
    const voiceSession = new VoiceSession(socket)
    createdSessions.push(voiceSession)

    voiceSession.start().catch(() => {})

    socket.on('message', (raw) => {
      try {
        const msg: WSMessage = JSON.parse(raw.toString())
        switch (msg.type) {
          case 'audio_chunk': {
            const payload = msg.payload as { audio: string }
            voiceSession.appendAudio(payload.audio)
            break
          }
          case 'interrupt': {
            voiceSession.interrupt()
            break
          }
          case 'session_reset': {
            voiceSession.resetSession()
            break
          }
          case 'state_change': {
            // logged only
            break
          }
          default:
            break
        }
      } catch (_) {
        // 非 JSON 或解析失败，不崩溃
      }
    })

    socket.on('close', () => {
      voiceSession.destroy()
    })

    socket.on('error', () => {
      voiceSession.destroy()
    })
  })

  return app
}

// ---------- 测试 ----------

describe('E2E WebSocket message flow', () => {
  let app: FastifyInstance
  let wsUrl: string
  const allClients: WebSocket[] = []

  /** 创建客户端，自动等待连接打开 */
  async function makeClient() {
    const client = createTrackedClient(wsUrl)
    allClients.push(client.ws)
    await client.waitForOpen()
    return client
  }

  beforeAll(async () => {
    delete process.env.DOUBAO_ACCESS_TOKEN
    delete process.env.DOUBAO_APP_KEY
    delete process.env.DOUBAO_APP_ID

    app = await buildServer()
    const address = await app.listen({ port: 0 })
    wsUrl = address.replace('http', 'ws') + '/ws'
  })

  afterEach(() => {
    createdSessions = []
  })

  afterAll(async () => {
    for (const ws of allClients) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    }
    await delay(200)
    await app.close()
  })

  // ---- 1. 连接建立 ----
  describe('连接建立', () => {
    test('客户端连接 /ws 应成功', async () => {
      const { ws } = await makeClient()
      expect(ws.readyState).toBe(WebSocket.OPEN)
    })

    test('连接后服务端应创建 VoiceSession', async () => {
      const prevCount = createdSessions.length
      await makeClient()
      await delay(100)
      expect(createdSessions.length).toBe(prevCount + 1)
    })

    test('缺少豆包环境变量时应发送 idle 状态', async () => {
      const client = await makeClient()
      const msg = await client.waitForMessage('state_change', 2000)
      expect(msg.type).toBe('state_change')
      expect((msg.payload as any).state).toBe('idle')
    })
  })

  // ---- 2. 状态变更消息 ----
  describe('状态变更消息', () => {
    test('客户端发送 state_change 不应崩溃或断开', async () => {
      const client = await makeClient()
      await client.waitForMessage('state_change', 2000)

      client.ws.send(JSON.stringify({
        type: 'state_change',
        payload: { state: 'listening' },
        timestamp: Date.now(),
      } as WSMessage))

      await delay(300)
      expect(client.ws.readyState).toBe(WebSocket.OPEN)
    })
  })

  // ---- 3. 音频发送 ----
  describe('音频发送', () => {
    test('客户端发送 audio_chunk 应被接受而不崩溃', async () => {
      const client = await makeClient()
      await client.waitForMessage('state_change', 2000)

      const fakePcm = Buffer.alloc(960).toString('base64')
      client.ws.send(JSON.stringify({
        type: 'audio_chunk',
        payload: { audio: fakePcm },
        timestamp: Date.now(),
      } as WSMessage))

      await delay(300)
      expect(client.ws.readyState).toBe(WebSocket.OPEN)
    })

    test('VoiceSession closed 状态下音频应被丢弃（不崩溃）', async () => {
      const client = await makeClient()
      await client.waitForMessage('state_change', 2000)
      await delay(100)

      for (let i = 0; i < 5; i++) {
        client.ws.send(JSON.stringify({
          type: 'audio_chunk',
          payload: { audio: Buffer.alloc(960).toString('base64') },
          timestamp: Date.now(),
        } as WSMessage))
      }

      await delay(300)
      expect(client.ws.readyState).toBe(WebSocket.OPEN)
    })
  })

  // ---- 4. 打断信号 ----
  describe('打断信号', () => {
    test('客户端发送 interrupt 不应崩溃', async () => {
      const client = await makeClient()
      await client.waitForMessage('state_change', 2000)

      client.ws.send(JSON.stringify({
        type: 'interrupt',
        payload: null,
        timestamp: Date.now(),
      } as WSMessage))

      await delay(300)
      expect(client.ws.readyState).toBe(WebSocket.OPEN)
    })

    test('interrupt 应递增 VoiceSession generation', async () => {
      const client = await makeClient()
      await client.waitForMessage('state_change', 2000)
      await delay(100)

      const session = createdSessions[createdSessions.length - 1]
      const genBefore = session.getGeneration()

      client.ws.send(JSON.stringify({
        type: 'interrupt',
        payload: null,
        timestamp: Date.now(),
      } as WSMessage))

      await delay(100)
      expect(session.getGeneration()).toBe(genBefore + 1)
    })
  })

  // ---- 5. 会话重置 ----
  describe('会话重置', () => {
    test('客户端发送 session_reset 不应崩溃', async () => {
      const client = await makeClient()
      await client.waitForMessage('state_change', 2000)

      client.ws.send(JSON.stringify({
        type: 'session_reset',
        payload: null,
        timestamp: Date.now(),
      } as WSMessage))

      await delay(300)
      expect(client.ws.readyState).toBe(WebSocket.OPEN)
    })

    test('session_reset 应递增 generation', async () => {
      const client = await makeClient()
      await client.waitForMessage('state_change', 2000)
      await delay(100)

      const session = createdSessions[createdSessions.length - 1]
      const genBefore = session.getGeneration()

      client.ws.send(JSON.stringify({
        type: 'session_reset',
        payload: null,
        timestamp: Date.now(),
      } as WSMessage))

      await delay(100)
      expect(session.getGeneration()).toBe(genBefore + 1)
    })
  })

  // ---- 6. 连接断开 ----
  describe('连接断开', () => {
    test('客户端断开后服务端不应崩溃', async () => {
      const client = await makeClient()
      await client.waitForMessage('state_change', 2000)

      client.ws.close()
      await client.waitForClose()

      // 服务端仍能接受新连接
      const client2 = await makeClient()
      expect(client2.ws.readyState).toBe(WebSocket.OPEN)
    })

    test('客户端断开应触发 VoiceSession destroy', async () => {
      const client = await makeClient()
      await client.waitForMessage('state_change', 2000)
      await delay(100)

      const session = createdSessions[createdSessions.length - 1]

      client.ws.close()
      await client.waitForClose()
      await delay(200)

      // destroy 后再调用方法应安全
      expect(() => session.appendAudio(Buffer.alloc(100).toString('base64'))).not.toThrow()
      expect(() => session.interrupt()).not.toThrow()
      expect(() => session.destroy()).not.toThrow()
    })
  })

  // ---- 7. 无效消息 ----
  describe('无效消息', () => {
    test('发送非 JSON 文本不应崩溃', async () => {
      const client = await makeClient()
      await client.waitForMessage('state_change', 2000)

      client.ws.send('this is not json {{{')
      client.ws.send('')
      client.ws.send('12345')

      await delay(300)
      expect(client.ws.readyState).toBe(WebSocket.OPEN)
    })

    test('发送未知 type 消息不应崩溃', async () => {
      const client = await makeClient()
      await client.waitForMessage('state_change', 2000)

      client.ws.send(JSON.stringify({
        type: 'unknown_type_xyz',
        payload: { foo: 'bar' },
        timestamp: Date.now(),
      }))

      await delay(300)
      expect(client.ws.readyState).toBe(WebSocket.OPEN)
    })

    test('发送缺少 type 字段的 JSON 不应崩溃', async () => {
      const client = await makeClient()
      await client.waitForMessage('state_change', 2000)

      client.ws.send(JSON.stringify({ payload: 'no type' }))

      await delay(300)
      expect(client.ws.readyState).toBe(WebSocket.OPEN)
    })

    test('发送二进制数据不应崩溃', async () => {
      const client = await makeClient()
      await client.waitForMessage('state_change', 2000)

      client.ws.send(Buffer.from([0x00, 0xFF, 0x01, 0x02]))

      await delay(300)
      expect(client.ws.readyState).toBe(WebSocket.OPEN)
    })
  })

  // ---- 8. 多客户端并发 ----
  describe('多客户端并发', () => {
    test('多个客户端同时连接应各自独立', async () => {
      const client1 = await makeClient()
      const client2 = await makeClient()

      const msg1 = await client1.waitForMessage('state_change', 2000)
      const msg2 = await client2.waitForMessage('state_change', 2000)

      expect(msg1.type).toBe('state_change')
      expect(msg2.type).toBe('state_change')

      // 关闭一个不影响另一个
      client1.ws.close()
      await client1.waitForClose()
      await delay(200)

      expect(client2.ws.readyState).toBe(WebSocket.OPEN)
    })
  })

  // ---- 9. 消息序列测试 ----
  describe('消息序列', () => {
    test('快速连续发送多种消息不应崩溃', async () => {
      const client = await makeClient()
      await client.waitForMessage('state_change', 2000)

      const messages: WSMessage[] = [
        { type: 'state_change', payload: { state: 'listening' }, timestamp: Date.now() },
        { type: 'audio_chunk', payload: { audio: Buffer.alloc(480).toString('base64') }, timestamp: Date.now() },
        { type: 'interrupt', payload: null, timestamp: Date.now() },
        { type: 'audio_chunk', payload: { audio: Buffer.alloc(480).toString('base64') }, timestamp: Date.now() },
        { type: 'session_reset', payload: null, timestamp: Date.now() },
        { type: 'state_change', payload: { state: 'idle' }, timestamp: Date.now() },
      ]

      for (const msg of messages) {
        client.ws.send(JSON.stringify(msg))
      }

      await delay(500)
      expect(client.ws.readyState).toBe(WebSocket.OPEN)
    })
  })
})
