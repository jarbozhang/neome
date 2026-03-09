import { SessionManager } from '../../app/services/SessionManager'

// Mock WebSocket
class MockWebSocket {
  static OPEN = 1
  static CLOSED = 3
  readyState = MockWebSocket.OPEN
  sentMessages: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: ((error: unknown) => void) | null = null

  send(data: string) {
    this.sentMessages.push(data)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }

  // 模拟收到服务端消息
  simulateMessage(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}

// 替换全局 WebSocket
;(global as any).WebSocket = MockWebSocket

describe('SessionManager', () => {
  let sm: SessionManager

  beforeEach(() => {
    jest.useFakeTimers()
    sm = new SessionManager()
  })

  afterEach(() => {
    sm.disconnect()
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
  })

  // ---------- 初始状态 ----------

  describe('initial state', () => {
    test('starts in idle state', () => {
      expect(sm.getState()).toBe('idle')
    })

    test('starts not connected', () => {
      expect(sm.isConnected()).toBe(false)
    })
  })

  // ---------- 状态转换 ----------

  describe('state transitions', () => {
    test('idle → listening is valid', () => {
      expect(sm.transition('listening')).toBe(true)
      expect(sm.getState()).toBe('listening')
    })

    test('listening → thinking is valid', () => {
      sm.transition('listening')
      expect(sm.transition('thinking')).toBe(true)
      expect(sm.getState()).toBe('thinking')
    })

    test('listening → speaking is valid', () => {
      sm.transition('listening')
      expect(sm.transition('speaking')).toBe(true)
      expect(sm.getState()).toBe('speaking')
    })

    test('thinking → speaking is valid', () => {
      sm.transition('listening')
      sm.transition('thinking')
      expect(sm.transition('speaking')).toBe(true)
      expect(sm.getState()).toBe('speaking')
    })

    test('speaking → listening is valid', () => {
      sm.transition('listening')
      sm.transition('speaking')
      expect(sm.transition('listening')).toBe(true)
      expect(sm.getState()).toBe('listening')
    })

    test('speaking → idle is valid', () => {
      sm.transition('listening')
      sm.transition('speaking')
      expect(sm.transition('idle')).toBe(true)
      expect(sm.getState()).toBe('idle')
    })

    test('idle → speaking is INVALID', () => {
      expect(sm.transition('speaking')).toBe(false)
      expect(sm.getState()).toBe('idle')
    })

    test('idle → thinking is INVALID', () => {
      expect(sm.transition('thinking')).toBe(false)
      expect(sm.getState()).toBe('idle')
    })

    test('speaking → thinking is INVALID', () => {
      sm.transition('listening')
      sm.transition('speaking')
      expect(sm.transition('thinking')).toBe(false)
      expect(sm.getState()).toBe('speaking')
    })

    test('thinking → idle is valid (e.g. error/reset)', () => {
      sm.transition('listening')
      sm.transition('thinking')
      expect(sm.transition('idle')).toBe(true)
      expect(sm.getState()).toBe('idle')
    })

    test('listening → idle is valid (e.g. disconnect)', () => {
      sm.transition('listening')
      expect(sm.transition('idle')).toBe(true)
      expect(sm.getState()).toBe('idle')
    })
  })

  // ---------- onStateChange 回调 ----------

  describe('onStateChange callback', () => {
    test('fires on valid transition', () => {
      const states: string[] = []
      sm.onStateChange = (s) => states.push(s)

      sm.transition('listening')
      sm.transition('thinking')
      expect(states).toEqual(['listening', 'thinking'])
    })

    test('does not fire on invalid transition', () => {
      const states: string[] = []
      sm.onStateChange = (s) => states.push(s)

      sm.transition('speaking') // invalid from idle
      expect(states).toEqual([])
    })
  })

  // ---------- 消息监听/分发 ----------

  describe('message dispatch', () => {
    test('on() registers handler and dispatch invokes it', () => {
      const messages: any[] = []
      sm.on('transcript', (msg) => messages.push(msg))

      // 手动模拟 dispatch（通过 connect + 模拟 WebSocket 消息）
      // 由于 dispatch 是 private，通过 WebSocket connect 模拟
      sm.connect('ws://localhost:9527/ws')

      // 获取内部创建的 MockWebSocket
      const ws = (sm as any).ws as MockWebSocket
      ws.onopen?.()

      ws.simulateMessage({
        type: 'transcript',
        payload: { text: 'hello', isFinal: true },
        timestamp: 123,
      })

      expect(messages.length).toBe(1)
      expect(messages[0].payload.text).toBe('hello')
    })

    test('unsubscribe function removes handler', () => {
      const messages: any[] = []
      const unsub = sm.on('transcript', (msg) => messages.push(msg))

      sm.connect('ws://localhost:9527/ws')
      const ws = (sm as any).ws as MockWebSocket
      ws.onopen?.()

      ws.simulateMessage({
        type: 'transcript',
        payload: { text: '1' },
        timestamp: 1,
      })

      unsub()

      ws.simulateMessage({
        type: 'transcript',
        payload: { text: '2' },
        timestamp: 2,
      })

      expect(messages.length).toBe(1)
    })

    test('multiple handlers for same type all fire', () => {
      const a: any[] = []
      const b: any[] = []
      sm.on('reply_audio', (msg) => a.push(msg))
      sm.on('reply_audio', (msg) => b.push(msg))

      sm.connect('ws://localhost:9527/ws')
      const ws = (sm as any).ws as MockWebSocket
      ws.onopen?.()

      ws.simulateMessage({
        type: 'reply_audio',
        payload: { audio: 'data' },
        timestamp: 1,
      })

      expect(a.length).toBe(1)
      expect(b.length).toBe(1)
    })
  })

  // ---------- dispatch: server state_change ----------

  describe('server-driven state changes', () => {
    test('valid server state_change updates state', () => {
      sm.connect('ws://localhost:9527/ws')
      const ws = (sm as any).ws as MockWebSocket
      ws.onopen?.()

      ws.simulateMessage({
        type: 'state_change',
        payload: { state: 'listening' },
        timestamp: 1,
      })

      expect(sm.getState()).toBe('listening')
    })

    test('invalid server state_change is ignored', () => {
      sm.connect('ws://localhost:9527/ws')
      const ws = (sm as any).ws as MockWebSocket
      ws.onopen?.()

      ws.simulateMessage({
        type: 'state_change',
        payload: { state: 'speaking' }, // idle → speaking is invalid
        timestamp: 1,
      })

      expect(sm.getState()).toBe('idle')
    })

    test('duplicate state_change is ignored (no callback)', () => {
      const states: string[] = []
      sm.onStateChange = (s) => states.push(s)

      sm.connect('ws://localhost:9527/ws')
      const ws = (sm as any).ws as MockWebSocket
      ws.onopen?.()

      ws.simulateMessage({
        type: 'state_change',
        payload: { state: 'listening' },
        timestamp: 1,
      })
      ws.simulateMessage({
        type: 'state_change',
        payload: { state: 'listening' },
        timestamp: 2,
      })

      expect(states).toEqual(['listening']) // only once
    })
  })

  // ---------- forceIdle ----------

  describe('forceIdle', () => {
    test('resets state to idle regardless of current state', () => {
      sm.transition('listening')
      sm.transition('speaking')
      sm.forceIdle()
      expect(sm.getState()).toBe('idle')
    })

    test('fires onStateChange', () => {
      const states: string[] = []
      sm.transition('listening')
      sm.onStateChange = (s) => states.push(s)
      sm.forceIdle()
      expect(states).toContain('idle')
    })
  })

  // ---------- send ----------

  describe('send', () => {
    test('sends JSON when connected', () => {
      sm.connect('ws://localhost:9527/ws')
      const ws = (sm as any).ws as MockWebSocket
      ws.onopen?.()

      sm.send({
        type: 'audio_chunk',
        payload: { audio: 'base64data' },
        timestamp: Date.now(),
      })

      expect(ws.sentMessages.length).toBe(1)
      const parsed = JSON.parse(ws.sentMessages[0])
      expect(parsed.type).toBe('audio_chunk')
    })

    test('does not throw when not connected', () => {
      expect(() => {
        sm.send({
          type: 'interrupt',
          payload: {},
          timestamp: Date.now(),
        })
      }).not.toThrow()
    })
  })

  // ---------- disconnect ----------

  describe('disconnect', () => {
    test('closes WebSocket and clears state', () => {
      sm.connect('ws://localhost:9527/ws')
      const ws = (sm as any).ws as MockWebSocket
      ws.onopen?.()

      sm.disconnect()
      expect((sm as any).ws).toBeNull()
      expect(sm.isConnected()).toBe(false)
    })
  })
})
