import { EventEmitter } from 'events'
import WebSocket from 'ws'
import { VoiceSession, encodeJsonFrame, encodeFrame } from '../voiceSession'

// ---------- 协议常量（与源码保持一致） ----------
const MSG_TYPE_FULL_SERVER = 0x9
const MSG_TYPE_AUDIO_ONLY_SERVER = 0xB
const SERIAL_JSON = 0x1
const SERIAL_RAW = 0x0

// ---------- Mock doubao WebSocket ----------

/** 捕获最近创建的 mock doubao ws 实例 */
let lastMockDoubaoWs: EventEmitter & {
  readyState: number
  send: jest.Mock
  close: jest.Mock
  removeAllListeners: jest.Mock
} | null = null

jest.mock('ws', () => {
  const actualWs = jest.requireActual('ws')

  // 继承真实 WebSocket 的静态常量
  const MockWebSocket = function (this: any, _url: string, _opts?: any) {
    const emitter = new (require('events').EventEmitter)()
    emitter.readyState = actualWs.OPEN
    emitter.send = jest.fn()
    emitter.close = jest.fn()
    emitter.removeAllListeners = jest.fn(() => {
      emitter._events = {}
      return emitter
    })
    lastMockDoubaoWs = emitter
    return emitter
  } as any

  MockWebSocket.OPEN = actualWs.OPEN
  MockWebSocket.CLOSED = actualWs.CLOSED
  MockWebSocket.CONNECTING = actualWs.CONNECTING
  MockWebSocket.CLOSING = actualWs.CLOSING

  return {
    __esModule: true,
    default: MockWebSocket,
    WebSocket: MockWebSocket,
    OPEN: actualWs.OPEN,
    CLOSED: actualWs.CLOSED,
    CONNECTING: actualWs.CONNECTING,
    CLOSING: actualWs.CLOSING,
  }
})

// ---------- Mock 客户端 WebSocket ----------

function createMockClientWs(): WebSocket {
  const ws = {
    readyState: WebSocket.OPEN,
    send: jest.fn(),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
    close: jest.fn(),
  } as unknown as WebSocket
  return ws
}

// ---------- 帧构造辅助 ----------

function buildServerJsonFrame(
  eventNum: number,
  json: Record<string, unknown>,
  sessionId?: string,
): Buffer {
  const NO_SESSION_EVENTS = new Set([51, 52])
  const includeSessionId = !NO_SESSION_EVENTS.has(eventNum) && !!sessionId
  return encodeJsonFrame(MSG_TYPE_FULL_SERVER, eventNum, json, sessionId, includeSessionId)
}

function buildServerAudioFrame(pcmBuf: Buffer, sessionId: string): Buffer {
  return encodeFrame(MSG_TYPE_AUDIO_ONLY_SERVER, SERIAL_RAW, 200, pcmBuf, sessionId, true)
}

// ---------- 解析辅助 ----------

function getSentMessages(clientWs: WebSocket): Array<{ type: string; payload: unknown; timestamp: number }> {
  const sendMock = clientWs.send as jest.Mock
  return sendMock.mock.calls.map(([raw]: [string]) => JSON.parse(raw))
}

// ---------- 测试 ----------

describe('VoiceSession Integration Tests', () => {
  const originalEnv = process.env

  beforeEach(() => {
    lastMockDoubaoWs = null
    process.env = {
      ...originalEnv,
      DOUBAO_ACCESS_TOKEN: 'test-token',
      DOUBAO_APP_KEY: 'test-app-key',
      DOUBAO_APP_ID: 'test-app-id',
    }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  /** 推进 VoiceSession 到 ready 状态 */
  async function advanceToReady(
    vs: VoiceSession,
    sid = 'test-session-id',
  ): Promise<void> {
    await vs.start()
    const dws = lastMockDoubaoWs!

    // 触发 open → VoiceSession 发送 StartConnection
    dws.emit('open')

    // 服务端 → ConnectionStarted (event 50)
    dws.emit('message', buildServerJsonFrame(50, {}, 'connect-id'))

    // 服务端 → SessionStarted (event 150)
    dws.emit('message', buildServerJsonFrame(150, { session_id: sid, dialog_id: 'dialog-001' }, sid))
  }

  // ============================================================
  // 1. 生命周期
  // ============================================================
  describe('Lifecycle', () => {
    test('start() should send idle state_change when env vars are missing', async () => {
      delete process.env.DOUBAO_ACCESS_TOKEN
      delete process.env.DOUBAO_APP_KEY
      delete process.env.DOUBAO_APP_ID

      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      await session.start()

      const msgs = getSentMessages(clientWs)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].type).toBe('state_change')
      expect(msgs[0].payload).toEqual({ state: 'idle' })
    })

    test('start() should send idle state_change when only some env vars are missing', async () => {
      delete process.env.DOUBAO_APP_ID

      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      await session.start()

      const msgs = getSentMessages(clientWs)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].type).toBe('state_change')
      expect(msgs[0].payload).toEqual({ state: 'idle' })
    })

    test('start() should be ignored when not in init state', async () => {
      delete process.env.DOUBAO_ACCESS_TOKEN

      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      await session.start() // → closed
      ;(clientWs.send as jest.Mock).mockClear()

      await session.start() // should be ignored
      expect((clientWs.send as jest.Mock).mock.calls).toHaveLength(0)
    })

    test('destroy() should clean up resources', () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)

      session.appendAudio(Buffer.alloc(100).toString('base64'))
      session.appendAudio(Buffer.alloc(100).toString('base64'))
      session.destroy()

      ;(clientWs.send as jest.Mock).mockClear()
      session.appendAudio(Buffer.alloc(100).toString('base64'))
      expect((clientWs.send as jest.Mock).mock.calls).toHaveLength(0)
    })

    test('destroy() called twice should be safe', () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      expect(() => {
        session.destroy()
        session.destroy()
      }).not.toThrow()
    })

    test('destroy() should not throw even with no doubaoWs', () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      expect(() => session.destroy()).not.toThrow()
    })

    test('destroy() should close doubaoWs when in OPEN state', async () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      await advanceToReady(session)

      const dws = lastMockDoubaoWs!
      session.destroy()

      expect(dws.removeAllListeners).toHaveBeenCalled()
      expect(dws.close).toHaveBeenCalled()
    })
  })

  // ============================================================
  // 2. 音频缓冲
  // ============================================================
  describe('Audio Buffering', () => {
    test('appendAudio() should buffer when not ready (up to 100)', () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)

      for (let i = 0; i < 100; i++) {
        session.appendAudio(Buffer.alloc(10).toString('base64'))
      }
      expect((clientWs.send as jest.Mock).mock.calls).toHaveLength(0)
    })

    test('appendAudio() should discard beyond buffer limit of 100', () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)

      for (let i = 0; i < 100; i++) {
        session.appendAudio(Buffer.alloc(10).toString('base64'))
      }
      // 第 101 个应被丢弃，不抛异常
      session.appendAudio(Buffer.alloc(10).toString('base64'))
      expect((clientWs.send as jest.Mock).mock.calls).toHaveLength(0)
    })

    test('appendAudio() should be ignored in closed state', () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      session.destroy()
      session.appendAudio(Buffer.alloc(10).toString('base64'))
      expect((clientWs.send as jest.Mock).mock.calls).toHaveLength(0)
    })
  })

  // ============================================================
  // 3. 打断逻辑
  // ============================================================
  describe('Interrupt', () => {
    test('interrupt() should increment generation', () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      expect(session.getGeneration()).toBe(0)
      session.interrupt()
      expect(session.getGeneration()).toBe(1)
      session.interrupt()
      expect(session.getGeneration()).toBe(2)
    })

    test('interrupt() should reset isSpeaking and currentResponseBuffer (observable via behavior)', () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      session.interrupt()
      session.interrupt()
      expect(session.getGeneration()).toBe(2)
    })

    test('interrupt() in non-ready state should only increment generation (no WebSocket send)', () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      session.interrupt()
      expect(session.getGeneration()).toBe(1)
      expect((clientWs.send as jest.Mock).mock.calls).toHaveLength(0)
    })

    test('interrupt() in closed state should be ignored', () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      session.destroy()
      const genBefore = session.getGeneration()
      session.interrupt()
      expect(session.getGeneration()).toBe(genBefore)
    })

    test('interrupt() in ready state should send FinishSession and re-start session', async () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      await advanceToReady(session)

      const dws = lastMockDoubaoWs!
      dws.send.mockClear()

      session.interrupt()

      // 应调用 doubaoWs.send 两次: FinishSession + StartSession
      expect(dws.send).toHaveBeenCalledTimes(2)
      expect(session.getGeneration()).toBe(1)

      session.destroy()
    })
  })

  // ============================================================
  // 4. 会话重置
  // ============================================================
  describe('Session Reset', () => {
    test('resetSession() should increment generation', () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      expect(session.getGeneration()).toBe(0)
      session.resetSession()
      expect(session.getGeneration()).toBe(1)
    })

    test('resetSession() in init state should set pendingReset (no crash)', () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      expect(() => session.resetSession()).not.toThrow()
      expect(session.getGeneration()).toBe(1)
    })

    test('resetSession() in closed state should be ignored', () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      session.destroy()
      const genBefore = session.getGeneration()
      session.resetSession()
      expect(session.getGeneration()).toBe(genBefore)
    })

    test('resetSession() multiple times should be safe', () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      expect(() => {
        session.resetSession()
        session.resetSession()
        session.resetSession()
      }).not.toThrow()
      expect(session.getGeneration()).toBe(3)
    })

    test('resetSession() in connecting state should set pendingReset', async () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      await session.start()

      // 此时 internalState = connecting
      session.resetSession()
      expect(session.getGeneration()).toBe(1)

      // pendingReset 会在 SessionStarted 后执行
      const dws = lastMockDoubaoWs!
      dws.emit('open')
      dws.emit('message', buildServerJsonFrame(50, {}, 'connect-id'))

      // SessionStarted → 检测到 pendingReset → 自动执行 resetSession
      dws.emit('message', buildServerJsonFrame(150, { session_id: 'sid-1', dialog_id: 'd-1' }, 'sid-1'))

      // pendingReset 触发了额外的 resetSession → generation 再次递增
      expect(session.getGeneration()).toBe(2)

      session.destroy()
    })
  })

  // ============================================================
  // 5. 服务端音频处理
  // ============================================================
  describe('Server Audio Processing', () => {
    test('receiving TTS audio should send speaking state_change + reply_audio', async () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      await advanceToReady(session)
      ;(clientWs.send as jest.Mock).mockClear()

      // 构造有声音的 PCM 数据
      const pcm = Buffer.alloc(1440)
      for (let i = 0; i < 720; i++) pcm.writeInt16LE(5000, i * 2)
      const audioFrame = buildServerAudioFrame(pcm, 'test-session-id')

      lastMockDoubaoWs!.emit('message', audioFrame)

      const msgs = getSentMessages(clientWs)
      const stateChanges = msgs.filter(m => m.type === 'state_change')
      const replyAudios = msgs.filter(m => m.type === 'reply_audio')

      expect(stateChanges.length).toBeGreaterThanOrEqual(1)
      expect(stateChanges[0].payload).toEqual({ state: 'speaking' })

      expect(replyAudios).toHaveLength(1)
      expect((replyAudios[0].payload as any).isFinal).toBe(false)
      expect((replyAudios[0].payload as any).audio).toBeDefined()
      expect((replyAudios[0].payload as any).visemes).toBeDefined()

      session.destroy()
    })

    test('receiving multiple audio frames should keep isSpeaking = true (only one speaking state_change)', async () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      await advanceToReady(session)
      ;(clientWs.send as jest.Mock).mockClear()

      const pcm = Buffer.alloc(1440)
      for (let i = 0; i < 720; i++) pcm.writeInt16LE(3000, i * 2)

      for (let i = 0; i < 3; i++) {
        lastMockDoubaoWs!.emit('message', buildServerAudioFrame(pcm, 'test-session-id'))
      }

      const msgs = getSentMessages(clientWs)
      const speakingChanges = msgs.filter(
        m => m.type === 'state_change' && (m.payload as any).state === 'speaking',
      )
      const replyAudios = msgs.filter(m => m.type === 'reply_audio')

      expect(speakingChanges).toHaveLength(1)
      expect(replyAudios).toHaveLength(3)

      session.destroy()
    })

    test('reply_audio payload should contain generation matching session generation', async () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      await advanceToReady(session)
      ;(clientWs.send as jest.Mock).mockClear()

      const pcm = Buffer.alloc(1440)
      for (let i = 0; i < 720; i++) pcm.writeInt16LE(5000, i * 2)
      lastMockDoubaoWs!.emit('message', buildServerAudioFrame(pcm, 'test-session-id'))

      const msgs = getSentMessages(clientWs)
      const replyAudio = msgs.find(m => m.type === 'reply_audio')
      expect((replyAudio!.payload as any).generation).toBe(session.getGeneration())

      session.destroy()
    })
  })

  // ============================================================
  // 6. 意图检测
  // ============================================================
  describe('Intent Detection', () => {
    test('LLM reply containing [MAKE:美式] should trigger onMakeCoffee and make_coffee message', async () => {
      const makeCoffeeCallback = jest.fn()
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs, makeCoffeeCallback)
      await advanceToReady(session)
      ;(clientWs.send as jest.Mock).mockClear()

      const dws = lastMockDoubaoWs!
      dws.emit('message', buildServerJsonFrame(550, { content: '好的，一杯美式咖啡！马上为您制作～[MAKE:美式]' }, 'test-session-id'))
      dws.emit('message', buildServerJsonFrame(559, {}, 'test-session-id'))

      expect(makeCoffeeCallback).toHaveBeenCalledWith('美式')

      const msgs = getSentMessages(clientWs)
      const coffeeMsg = msgs.find(m => m.type === 'make_coffee')
      expect(coffeeMsg).toBeDefined()
      expect((coffeeMsg!.payload as any).recipe).toBe('美式')

      session.destroy()
    })

    test('interrupted reply should NOT trigger intent detection (generation mismatch)', async () => {
      const makeCoffeeCallback = jest.fn()
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs, makeCoffeeCallback)
      await advanceToReady(session)
      ;(clientWs.send as jest.Mock).mockClear()

      const dws = lastMockDoubaoWs!
      // LLM 开始回复
      dws.emit('message', buildServerJsonFrame(550, { content: '好的，一杯美式[MAKE:美式]' }, 'test-session-id'))

      // 打断 → generation 递增 + currentResponseBuffer 清空
      session.interrupt()

      // 旧回复的 559 到达
      dws.emit('message', buildServerJsonFrame(559, {}, 'test-session-id'))

      expect(makeCoffeeCallback).not.toHaveBeenCalled()

      const msgs = getSentMessages(clientWs)
      const coffeeMsg = msgs.find(m => m.type === 'make_coffee')
      expect(coffeeMsg).toBeUndefined()

      session.destroy()
    })

    test('LLM reply split across multiple event 550 frames should accumulate correctly', async () => {
      const makeCoffeeCallback = jest.fn()
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs, makeCoffeeCallback)
      await advanceToReady(session)
      ;(clientWs.send as jest.Mock).mockClear()

      const dws = lastMockDoubaoWs!
      dws.emit('message', buildServerJsonFrame(550, { content: '好的，一杯美式咖啡！' }, 'test-session-id'))
      dws.emit('message', buildServerJsonFrame(550, { content: '马上为您制作～' }, 'test-session-id'))
      dws.emit('message', buildServerJsonFrame(550, { content: '[MAKE:美式]' }, 'test-session-id'))
      dws.emit('message', buildServerJsonFrame(559, {}, 'test-session-id'))

      expect(makeCoffeeCallback).toHaveBeenCalledWith('美式')

      session.destroy()
    })

    test('LLM reply without MAKE tag should NOT trigger onMakeCoffee', async () => {
      const makeCoffeeCallback = jest.fn()
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs, makeCoffeeCallback)
      await advanceToReady(session)
      ;(clientWs.send as jest.Mock).mockClear()

      const dws = lastMockDoubaoWs!
      dws.emit('message', buildServerJsonFrame(550, { content: '我们有美式、拿铁、摩卡，您想喝哪个？' }, 'test-session-id'))
      dws.emit('message', buildServerJsonFrame(559, {}, 'test-session-id'))

      expect(makeCoffeeCallback).not.toHaveBeenCalled()

      const msgs = getSentMessages(clientWs)
      const coffeeMsg = msgs.find(m => m.type === 'make_coffee')
      expect(coffeeMsg).toBeUndefined()

      session.destroy()
    })

    test('event 559 should send final transcript with isFinal=true', async () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      await advanceToReady(session)
      ;(clientWs.send as jest.Mock).mockClear()

      const dws = lastMockDoubaoWs!
      dws.emit('message', buildServerJsonFrame(550, { content: '你好' }, 'test-session-id'))
      dws.emit('message', buildServerJsonFrame(559, {}, 'test-session-id'))

      const msgs = getSentMessages(clientWs)
      const transcripts = msgs.filter(m => m.type === 'transcript')
      const finalTranscript = transcripts.find(t => (t.payload as any).isFinal === true)
      expect(finalTranscript).toBeDefined()

      session.destroy()
    })
  })

  // ============================================================
  // 综合场景
  // ============================================================
  describe('Combined Scenarios', () => {
    test('destroy() after start() with missing env should be safe', async () => {
      delete process.env.DOUBAO_ACCESS_TOKEN
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      await session.start()
      expect(() => session.destroy()).not.toThrow()
    })

    test('appendAudio + interrupt + appendAudio sequence should not throw', () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      session.appendAudio(Buffer.alloc(10).toString('base64'))
      session.interrupt()
      session.appendAudio(Buffer.alloc(10).toString('base64'))
      session.interrupt()
      expect(session.getGeneration()).toBe(2)
    })

    test('resetSession + destroy sequence should not throw', () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      session.resetSession()
      expect(() => session.destroy()).not.toThrow()
    })

    test('getGeneration() returns 0 initially', () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      expect(session.getGeneration()).toBe(0)
    })

    test('clientWs not OPEN should not crash safeSendToClient', async () => {
      delete process.env.DOUBAO_ACCESS_TOKEN
      const clientWs = createMockClientWs()
      Object.defineProperty(clientWs, 'readyState', { value: WebSocket.CLOSED })

      const session = new VoiceSession(clientWs)
      await session.start()
      expect((clientWs.send as jest.Mock).mock.calls).toHaveLength(0)
    })

    test('TTS end event (359) should send reply_audio isFinal + listening state', async () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      await advanceToReady(session)

      const dws = lastMockDoubaoWs!
      // 先发一帧音频让 isSpeaking = true
      const pcm = Buffer.alloc(1440)
      for (let i = 0; i < 720; i++) pcm.writeInt16LE(5000, i * 2)
      dws.emit('message', buildServerAudioFrame(pcm, 'test-session-id'))
      ;(clientWs.send as jest.Mock).mockClear()

      // TTS 结束事件
      dws.emit('message', buildServerJsonFrame(359, {}, 'test-session-id'))

      const msgs = getSentMessages(clientWs)
      const finalAudio = msgs.find(m => m.type === 'reply_audio' && (m.payload as any).isFinal === true)
      expect(finalAudio).toBeDefined()

      const listeningState = msgs.find(
        m => m.type === 'state_change' && (m.payload as any).state === 'listening',
      )
      expect(listeningState).toBeDefined()

      session.destroy()
    })

    test('ASR final text (event 451) should trigger thinking state', async () => {
      const clientWs = createMockClientWs()
      const session = new VoiceSession(clientWs)
      await advanceToReady(session)
      ;(clientWs.send as jest.Mock).mockClear()

      const dws = lastMockDoubaoWs!
      dws.emit('message', buildServerJsonFrame(451, {
        results: [{ text: '来一杯美式', is_interim: false }],
      }, 'test-session-id'))

      const msgs = getSentMessages(clientWs)
      const thinkingState = msgs.find(
        m => m.type === 'state_change' && (m.payload as any).state === 'thinking',
      )
      expect(thinkingState).toBeDefined()

      const transcript = msgs.find(m => m.type === 'transcript')
      expect(transcript).toBeDefined()
      expect((transcript!.payload as any).text).toBe('来一杯美式')
      expect((transcript!.payload as any).isFinal).toBe(true)

      session.destroy()
    })
  })
})
