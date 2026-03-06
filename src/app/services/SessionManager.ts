import { WSMessage, WSMessageType, SessionState } from '../../shared/types'

type MessageHandler = (msg: WSMessage) => void

// 合法状态转换表
const VALID_TRANSITIONS: Record<SessionState, SessionState[]> = {
  idle: ['listening'],
  listening: ['thinking', 'speaking', 'idle'],
  thinking: ['speaking', 'listening', 'idle'],
  speaking: ['listening', 'idle'],
}

export class SessionManager {
  private ws: WebSocket | null = null
  private state: SessionState = 'idle'
  private listeners: Map<WSMessageType, MessageHandler[]> = new Map()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private url: string = ''
  private isConnecting: boolean = false

  // 连接状态回调
  onConnectionChange?: (connected: boolean) => void
  onStateChange?: (state: SessionState) => void

  connect(url: string): void {
    this.url = url
    this.doConnect()
  }

  private doConnect(): void {
    if (this.isConnecting || (this.ws?.readyState === WebSocket.OPEN)) return
    this.isConnecting = true

    try {
      this.ws = new WebSocket(this.url)

      this.ws.onopen = () => {
        this.isConnecting = false
        console.log('[SessionManager] Connected')
        this.onConnectionChange?.(true)
        this.clearReconnectTimer()
      }

      this.ws.onmessage = (event) => {
        try {
          const msg: WSMessage = JSON.parse(event.data as string)
          this.dispatch(msg)
        } catch (e) {
          console.error('[SessionManager] Parse error:', e)
        }
      }

      this.ws.onclose = () => {
        this.isConnecting = false
        console.log('[SessionManager] Disconnected')
        this.onConnectionChange?.(false)
        this.scheduleReconnect()
      }

      this.ws.onerror = (error) => {
        this.isConnecting = false
        console.error('[SessionManager] Error:', error)
      }
    } catch (e) {
      this.isConnecting = false
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer()
    this.reconnectTimer = setTimeout(() => {
      console.log('[SessionManager] Reconnecting...')
      this.doConnect()
    }, 3000)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  send(msg: WSMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    } else {
      console.warn('[SessionManager] Cannot send, not connected')
    }
  }

  on(type: WSMessageType, handler: MessageHandler): () => void {
    const handlers = this.listeners.get(type) || []
    handlers.push(handler)
    this.listeners.set(type, handlers)
    // 返回取消注册函数
    return () => {
      const list = this.listeners.get(type)
      if (list) {
        const idx = list.indexOf(handler)
        if (idx >= 0) list.splice(idx, 1)
      }
    }
  }

  private dispatch(msg: WSMessage): void {
    // 内部处理 state_change（服务端下发）
    if (msg.type === 'state_change' && msg.payload && typeof msg.payload === 'object' && 'state' in msg.payload) {
      const newState = (msg.payload as { state: SessionState }).state
      if (this.state !== newState) {
        const allowed = VALID_TRANSITIONS[this.state]
        if (allowed.includes(newState)) {
          this.state = newState
          this.onStateChange?.(newState)
        } else {
          console.warn(`[SessionManager] Server requested invalid transition: ${this.state} → ${newState}, ignored`)
        }
      }
    }

    const handlers = this.listeners.get(msg.type)
    if (handlers) {
      handlers.forEach(h => h(msg))
    }
  }

  transition(newState: SessionState): boolean {
    const allowed = VALID_TRANSITIONS[this.state]
    if (!allowed.includes(newState)) {
      console.warn(`[SessionManager] Invalid transition: ${this.state} → ${newState}`)
      return false
    }
    this.state = newState
    this.onStateChange?.(newState)
    this.send({
      type: 'state_change',
      payload: { state: newState },
      timestamp: Date.now(),
    })
    return true
  }

  resetSession(): void {
    console.log('[SessionManager] Reset session (new customer)')
    this.send({
      type: 'session_reset',
      payload: {},
      timestamp: Date.now(),
    })
  }

  forceIdle(): void {
    this.state = 'idle'
    this.onStateChange?.('idle')
    this.send({
      type: 'state_change',
      payload: { state: 'idle' },
      timestamp: Date.now(),
    })
  }

  getState(): SessionState {
    return this.state
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  disconnect(): void {
    this.clearReconnectTimer()
    this.isConnecting = false
    this.ws?.close()
    this.ws = null
  }
}

// 单例
export const sessionManager = new SessionManager()
