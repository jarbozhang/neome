import WebSocket from 'ws'
import { randomUUID } from 'crypto'
import { gunzipSync } from 'zlib'
import { WSMessage, SessionState } from '../shared/types'

// ---------- 协议常量 ----------
// Header byte 0: version=1 (高4位), headerSize=1 表示 4 bytes (低4位)
const HEADER_BYTE0 = 0x11

// Message type (byte 1 高4位)
const MSG_TYPE_FULL_CLIENT        = 0x1  // JSON payload，客户端发
const MSG_TYPE_AUDIO_ONLY_CLIENT  = 0x2  // 原始 PCM，客户端发
const MSG_TYPE_FULL_SERVER        = 0x9  // JSON payload，服务端发
const MSG_TYPE_AUDIO_ONLY_SERVER  = 0xB  // 原始 PCM，服务端发
// const MSG_TYPE_ERROR           = 0xF

// Flags (byte 1 低4位)
const FLAG_NO_SEQ      = 0b0000
const FLAG_WITH_EVENT  = 0b0100  // payload 头部含 event number

// Serialization (byte 2 高4位)
const SERIAL_RAW  = 0x0
const SERIAL_JSON = 0x1

// Compression (byte 2 低4位)
const COMPRESS_NONE = 0x0
const COMPRESS_GZIP = 0x1

// 事件编号：Client → Server
const EVENT_START_CONNECTION  = 1
const EVENT_FINISH_CONNECTION = 2
const EVENT_START_SESSION     = 100
const EVENT_FINISH_SESSION    = 102
const EVENT_USER_QUERY        = 200   // 音频帧使用此事件

// 事件编号：Server → Client（不需要 SessionID/ConnectID 前缀的特殊事件）
// 注意：event 50 (ConnectionStarted) 实际包含 connectId 字段，所以不在此集合中
const SERVER_EVENTS_NO_SESSION_ID = new Set([51, 52])

// 豆包语音对话 API URL
const DOUBAO_DIALOGUE_URL = 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue'

// Pre-ready 音频缓冲上限
const AUDIO_BUFFER_MAX = 100

// ---------- VoiceSession 内部状态机 ----------
type VoiceSessionState = 'init' | 'connecting' | 'ready' | 'closing' | 'closed'

// ---------- 二进制协议编码 ----------

/**
 * 编码一个发给豆包的 WebSocket 二进制帧
 * @param msgType   消息类型（MSG_TYPE_*）
 * @param serialization  序列化方式（SERIAL_RAW / SERIAL_JSON）
 * @param eventNum  事件编号
 * @param sessionId 会话 ID 字符串（可选，某些事件不需要）
 * @param payloadBuf 实际 payload
 * @param includeSessionId 是否在 payload 前写入 sessionId 长度 + 内容
 */
function encodeFrame(
  msgType: number,
  serialization: number,
  eventNum: number,
  payloadBuf: Buffer,
  sessionId?: string,
  includeSessionId = false,
): Buffer {
  // byte 1: msgType (高4) | FLAG_WITH_EVENT (低4)
  const byte1 = ((msgType & 0xF) << 4) | FLAG_WITH_EVENT
  // byte 2: serialization (高4) | compression=0 (低4)
  const byte2 = ((serialization & 0xF) << 4) | COMPRESS_NONE

  const header = Buffer.alloc(4)
  header[0] = HEADER_BYTE0
  header[1] = byte1
  header[2] = byte2
  header[3] = 0x00

  // event number: int32 big-endian (4 bytes)
  const eventBuf = Buffer.alloc(4)
  eventBuf.writeInt32BE(eventNum, 0)

  const parts: Buffer[] = [header, eventBuf]

  // sessionId: uint32 length + string bytes（不适用于 event 1,2,50,51,52）
  if (includeSessionId && sessionId) {
    const sidBuf = Buffer.from(sessionId, 'utf-8')
    const sidLen = Buffer.alloc(4)
    sidLen.writeUInt32BE(sidBuf.length, 0)
    parts.push(sidLen, sidBuf)
  }

  // payload length + payload
  const payloadLen = Buffer.alloc(4)
  payloadLen.writeUInt32BE(payloadBuf.length, 0)
  parts.push(payloadLen, payloadBuf)

  return Buffer.concat(parts)
}

function encodeJsonFrame(
  msgType: number,
  eventNum: number,
  obj: Record<string, unknown>,
  sessionId?: string,
  includeSessionId = false,
): Buffer {
  const payloadBuf = Buffer.from(JSON.stringify(obj), 'utf-8')
  return encodeFrame(msgType, SERIAL_JSON, eventNum, payloadBuf, sessionId, includeSessionId)
}

function encodeAudioFrame(pcmBuf: Buffer, sessionId: string): Buffer {
  // AudioOnlyClient, Raw serialization, event=200, 包含 sessionId
  return encodeFrame(
    MSG_TYPE_AUDIO_ONLY_CLIENT,
    SERIAL_RAW,
    EVENT_USER_QUERY,
    pcmBuf,
    sessionId,
    true,
  )
}

// ---------- 二进制协议解码 ----------

interface DecodedFrame {
  msgType: number
  flags: number
  serialization: number
  compression: number
  eventNum: number | null
  sessionId: string | null
  payload: Buffer
}

function decodeFrame(data: Buffer): DecodedFrame | null {
  if (data.length < 4) return null

  const byte1 = data[1]
  const byte2 = data[2]

  const msgType      = (byte1 >> 4) & 0xF
  const flags        = byte1 & 0xF
  const serialization = (byte2 >> 4) & 0xF
  const compression   = byte2 & 0xF

  // Error 帧 (msgType=0xF): header(4) + errorCode(4) + payloadLen(4) + payload
  if (msgType === 0xF) {
    let offset = 4
    // 跳过 4 字节 error code
    if (data.length < offset + 4) return null
    offset += 4
    // payload length + payload
    if (data.length < offset + 4) return null
    const payloadLen = data.readUInt32BE(offset)
    offset += 4
    const payload = data.subarray(offset, offset + payloadLen)
    return { msgType, flags, serialization, compression, eventNum: null, sessionId: null, payload }
  }

  const hasEvent = (flags & FLAG_WITH_EVENT) !== 0

  let offset = 4  // 跳过 header

  let eventNum: number | null = null
  if (hasEvent) {
    if (data.length < offset + 4) return null
    eventNum = data.readInt32BE(offset)
    offset += 4
  }

  let sessionId: string | null = null
  // 服务端发来的 FullServer/AudioOnlyServer，除特殊事件外都含 sessionId/connectId
  if (hasEvent && eventNum !== null && !SERVER_EVENTS_NO_SESSION_ID.has(eventNum)) {
    if (data.length < offset + 4) return null
    const sidLen = data.readUInt32BE(offset)
    offset += 4
    if (data.length < offset + sidLen) return null
    sessionId = data.subarray(offset, offset + sidLen).toString('utf-8')
    offset += sidLen
  }

  // payload length + payload
  if (data.length < offset + 4) return null
  const payloadLen = data.readUInt32BE(offset)
  offset += 4
  if (data.length < offset + payloadLen) return null
  const payload = data.subarray(offset, offset + payloadLen)

  return { msgType, flags, serialization, compression, eventNum, sessionId, payload }
}

// ---------- StartSession payload ----------
function buildStartSessionPayload(): Record<string, unknown> {
  return {
    asr: {
      extra: {
        end_smooth_window_ms: 1500,
        enable_custom_vad: false,
        enable_asr_twopass: false,
      },
    },
    tts: {
      speaker: 'zh_female_vv_jupiter_bigtts',
      audio_config: {
        channel: 1,
        format: 'pcm',
        sample_rate: 24000,
      },
    },
    dialog: {
      bot_name: '小美',
      system_role: '你是一个咖啡店的点单助手，友好、简洁地与顾客交流。',
      speaking_style: '语气友好、专业',
      extra: {
        input_mod: 'audio',
        model: '1.2.1.0',
        recv_timeout: 10,
      },
    },
  }
}

// ---------- VoiceSession ----------

export class VoiceSession {
  private doubaoWs: WebSocket | null = null
  private clientWs: WebSocket
  private sessionId: string | null = null          // 豆包返回的 SessionID
  private connectId: string                         // 本次连接 UUID
  private internalState: VoiceSessionState = 'init'
  private generation: number = 0
  private audioBuffer: Buffer[] = []               // pre-ready PCM 缓冲
  private closed: boolean = false
  private isSpeaking: boolean = false

  constructor(clientWs: WebSocket) {
    this.clientWs = clientWs
    this.connectId = randomUUID()
  }

  async start(): Promise<void> {
    if (this.internalState !== 'init') {
      console.warn('[VoiceSession] start() called in invalid state:', this.internalState)
      return
    }
    this.internalState = 'connecting'

    const accessToken = process.env.DOUBAO_ACCESS_TOKEN
    const appKey      = process.env.DOUBAO_APP_KEY
    const appId       = process.env.DOUBAO_APP_ID

    if (!accessToken || !appKey || !appId) {
      console.error('[VoiceSession] Missing DOUBAO_ACCESS_TOKEN / DOUBAO_APP_KEY / DOUBAO_APP_ID')
      this.safeSendToClient({
        type: 'state_change',
        payload: { state: 'idle' as SessionState },
        timestamp: Date.now(),
      })
      this.internalState = 'closed'
      return
    }

    try {
      console.log('[VoiceSession] Connecting to Doubao Dialogue API, connectId:', this.connectId)
      this.doubaoWs = new WebSocket(DOUBAO_DIALOGUE_URL, {
        headers: {
          'X-Api-Resource-Id': 'volc.speech.dialog',
          'X-Api-Access-Key':  accessToken,
          'X-Api-App-Key':     appKey,
          'X-Api-App-ID':      appId,
          'X-Api-Connect-Id':  this.connectId,
        },
      })

      this.doubaoWs.on('open', () => {
        console.log('[VoiceSession] WebSocket open, sending StartConnection')
        // Step 1: StartConnection
        const frame = encodeJsonFrame(
          MSG_TYPE_FULL_CLIENT,
          EVENT_START_CONNECTION,
          {},
        )
        this.doubaoWs?.send(frame)
      })

      this.doubaoWs.on('message', (data: WebSocket.Data) => {
        const buf = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer)
        this.handleDoubaoFrame(buf)
      })

      this.doubaoWs.on('close', (code, reason) => {
        console.log('[VoiceSession] Doubao connection closed:', code, reason.toString())
        if (!this.closed) {
          this.safeSendToClient({
            type: 'state_change',
            payload: { state: 'idle' as SessionState },
            timestamp: Date.now(),
          })
          this.internalState = 'closed'
        }
      })

      this.doubaoWs.on('error', (err) => {
        console.error('[VoiceSession] Doubao WebSocket error:', err)
        if (!this.closed) {
          this.safeSendToClient({
            type: 'state_change',
            payload: { state: 'idle' as SessionState },
            timestamp: Date.now(),
          })
        }
      })
    } catch (err) {
      console.error('[VoiceSession] Failed to connect to Doubao:', err)
      this.internalState = 'closed'
    }
  }

  appendAudio(pcmBase64: string): void {
    if (this.closed) return

    // base64 PCM → Buffer
    const pcmBuf = Buffer.from(pcmBase64, 'base64')

    if (this.internalState !== 'ready') {
      // 尚未握手完成，缓冲起来
      if (this.audioBuffer.length < AUDIO_BUFFER_MAX) {
        this.audioBuffer.push(pcmBuf)
      }
      return
    }

    this.sendAudioFrame(pcmBuf)
  }

  interrupt(): void {
    if (this.closed) return

    this.generation++
    this.isSpeaking = false
    console.log('[VoiceSession] Interrupt, generation:', this.generation)

    if (this.internalState !== 'ready' || !this.sessionId) return

    // FinishSession → StartSession（重置当前对话轮次）
    const finishFrame = encodeJsonFrame(
      MSG_TYPE_FULL_CLIENT,
      EVENT_FINISH_SESSION,
      {},
      this.sessionId,
      true,
    )
    this.doubaoWs?.send(finishFrame)

    // 重新建立 Session，复用同一 WebSocket 连接
    this.internalState = 'connecting'
    this.sessionId = null
    this.sendStartSession()
  }

  getGeneration(): number {
    return this.generation
  }

  destroy(): void {
    if (this.closed) return
    this.closed = true
    this.internalState = 'closing'
    console.log('[VoiceSession] Destroying session')

    this.audioBuffer = []

    if (this.doubaoWs) {
      const ws = this.doubaoWs
      this.doubaoWs = null

      ws.removeAllListeners()

      if (ws.readyState === WebSocket.OPEN) {
        try {
          // 如果有 session，先发 FinishSession
          if (this.sessionId) {
            ws.send(encodeJsonFrame(
              MSG_TYPE_FULL_CLIENT,
              EVENT_FINISH_SESSION,
              {},
              this.sessionId,
              true,
            ))
          }
          // 再发 FinishConnection
          ws.send(encodeJsonFrame(
            MSG_TYPE_FULL_CLIENT,
            EVENT_FINISH_CONNECTION,
            {},
          ))
        } catch (_) {
          // ignore
        }
        ws.close()
      } else if (ws.readyState === WebSocket.CONNECTING) {
        // CONNECTING 状态下 close() 会抛错，监听 open 后再关闭
        ws.on('open', () => { try { ws.close() } catch (_) {} })
        ws.on('error', () => {})  // 防止未处理错误
      }
    }

    this.internalState = 'closed'
    this.sessionId = null
  }

  // ---------- 私有方法 ----------

  /** 发送 StartSession 消息（连接建立后 + 打断后调用） */
  private sendStartSession(): void {
    const frame = encodeJsonFrame(
      MSG_TYPE_FULL_CLIENT,
      EVENT_START_SESSION,
      buildStartSessionPayload(),
      this.connectId,
      true,  // includeSessionId: StartSession 需要包含 connectId
    )
    this.doubaoWs?.send(frame)
    console.log('[VoiceSession] StartSession sent with connectId:', this.connectId)
  }

  /** 发送音频帧给豆包（event=200） */
  private sendAudioFrame(pcmBuf: Buffer): void {
    if (!this.sessionId || this.doubaoWs?.readyState !== WebSocket.OPEN) return
    const frame = encodeAudioFrame(pcmBuf, this.sessionId)
    this.doubaoWs.send(frame)
  }

  /** ready 后把缓冲音频全部发出 */
  private flushAudioBuffer(): void {
    for (const pcmBuf of this.audioBuffer) {
      this.sendAudioFrame(pcmBuf)
    }
    if (this.audioBuffer.length > 0) {
      console.log(`[VoiceSession] Flushed ${this.audioBuffer.length} buffered audio chunks`)
    }
    this.audioBuffer = []
  }

  /** 解析并处理豆包发来的二进制帧 */
  private handleDoubaoFrame(data: Buffer): void {
    const frame = decodeFrame(data)
    if (!frame) {
      console.warn('[VoiceSession] Failed to decode frame, length:', data.length)
      return
    }

    const { msgType, eventNum, sessionId: frameSid, payload, serialization, compression } = frame

    // ConnectionStarted (50) 的 sid 字段是 connectId，不是 sessionId
    // SessionStarted (150) 及之后事件的 sid 才是真正的 sessionId
    if (frameSid && eventNum !== 50 && !this.sessionId) {
      this.sessionId = frameSid
      console.log('[VoiceSession] sessionId set:', this.sessionId)
    }

    // 解压 payload（如果使用了 gzip）
    let realPayload = payload
    if (compression === COMPRESS_GZIP && payload.length > 0) {
      try {
        realPayload = gunzipSync(payload)
      } catch (err) {
        console.error('[VoiceSession] gzip decompress failed:', err)
        return
      }
    }

    if (msgType === MSG_TYPE_FULL_SERVER) {
      // JSON 消息
      let json: Record<string, unknown> = {}
      if (serialization === SERIAL_JSON && realPayload.length > 0) {
        try {
          json = JSON.parse(realPayload.toString('utf-8'))
        } catch (err) {
          console.error('[VoiceSession] Failed to parse JSON payload:', err)
          console.error('[VoiceSession] Raw payload hex:', realPayload.subarray(0, 32).toString('hex'))
          return
        }
      }
      this.handleServerJsonEvent(eventNum, json)
    } else if (msgType === MSG_TYPE_AUDIO_ONLY_SERVER) {
      // TTS 音频 PCM（也可能被 gzip 压缩）
      this.handleServerAudio(realPayload)
    } else if (msgType === 0xF) {
      // Error 帧
      const errMsg = realPayload.toString('utf-8')
      console.error('[VoiceSession] Server error frame:', errMsg)
      // AudioIdleTimeout → 不自动重试，等待客户端重新连接
    } else {
      console.log('[VoiceSession] Unhandled msgType:', msgType.toString(16), 'event:', eventNum)
    }
  }

  /** 处理豆包 JSON 事件 */
  private handleServerJsonEvent(eventNum: number | null, json: Record<string, unknown>): void {
    console.log('[VoiceSession] Server event:', eventNum, JSON.stringify(json).slice(0, 200))

    switch (eventNum) {
      case 50: {
        // ConnectionStarted → 发送 StartSession
        console.log('[VoiceSession] ConnectionStarted, sending StartSession')
        this.sendStartSession()
        break
      }
      case 51: {
        // ConnectionFailed
        console.error('[VoiceSession] ConnectionFailed:', json)
        this.safeSendToClient({
          type: 'state_change',
          payload: { state: 'idle' as SessionState },
          timestamp: Date.now(),
        })
        this.internalState = 'closed'
        break
      }
      case 52: {
        // ConnectionFinished
        console.log('[VoiceSession] ConnectionFinished')
        break
      }
      case 150: {
        // SessionStarted → ready，可以开始接收音频
        console.log('[VoiceSession] SessionStarted, session ready')
        this.internalState = 'ready'
        // sessionId 可能在这条消息里
        if (!this.sessionId) {
          const sid = json['session_id'] as string | undefined
          if (sid) {
            this.sessionId = sid
            console.log('[VoiceSession] sessionId from SessionStarted:', this.sessionId)
          }
        }
        this.flushAudioBuffer()
        // 通知客户端进入 listening 状态
        this.safeSendToClient({
          type: 'state_change',
          payload: { state: 'listening' as SessionState },
          timestamp: Date.now(),
        })
        break
      }
      default: {
        // 处理各种业务事件
        this.handleBusinessEvent(eventNum, json)
        break
      }
    }
  }

  /** 处理业务层事件（ASR/TTS/Dialog 状态变更等） */
  private handleBusinessEvent(eventNum: number | null, json: Record<string, unknown>): void {
    const extra = json['extra'] as Record<string, unknown> | undefined

    // Event 451: ASR 识别文本（豆包对话 API 格式：extra.origin_text + extra.endpoint）
    if (eventNum === 451 && extra) {
      const text = extra['origin_text'] as string | undefined
      const isEndpoint = extra['endpoint'] as boolean | undefined

      if (text) {
        if (isEndpoint) {
          // 用户说话结束 → thinking 状态
          this.safeSendToClient({
            type: 'state_change',
            payload: { state: 'thinking' as SessionState },
            timestamp: Date.now(),
          })
        }
        this.safeSendToClient({
          type: 'transcript',
          payload: {
            text,
            isFinal: !!isEndpoint,
            generation: this.generation,
          },
          timestamp: Date.now(),
        })
      }
    }

    // Event 550: LLM 文本回复
    if (eventNum === 550) {
      const content = json['content'] as string | undefined
      if (content) {
        this.safeSendToClient({
          type: 'transcript',
          payload: {
            text: content,
            isFinal: false,
            generation: this.generation,
          },
          timestamp: Date.now(),
        })
      }
    }

    // Event 559: LLM 文本回复结束
    if (eventNum === 559) {
      this.safeSendToClient({
        type: 'transcript',
        payload: {
          text: '',
          isFinal: true,
          generation: this.generation,
        },
        timestamp: Date.now(),
      })
    }

    // Event 359: TTS 音频结束 → 回到 listening
    if (eventNum === 359) {
      this.isSpeaking = false
      this.safeSendToClient({
        type: 'state_change',
        payload: { state: 'listening' as SessionState },
        timestamp: Date.now(),
      })
    }
  }

  /** 处理豆包发来的 TTS 音频帧（float32 PCM → int16 PCM） */
  private handleServerAudio(pcmBuf: Buffer): void {
    if (!this.isSpeaking) {
      this.isSpeaking = true
      this.safeSendToClient({
        type: 'state_change',
        payload: { state: 'speaking' as SessionState },
        timestamp: Date.now(),
      })
    }

    // 豆包对话 API 返回 float32 PCM，转换为 int16 PCM
    const floatCount = pcmBuf.length / 4
    const int16Buf = Buffer.alloc(floatCount * 2)
    for (let i = 0; i < floatCount; i++) {
      let sample = pcmBuf.readFloatLE(i * 4)
      sample = Math.max(-1.0, Math.min(1.0, sample))
      int16Buf.writeInt16LE(Math.round(sample * 32767), i * 2)
    }

    const audioBase64 = int16Buf.toString('base64')
    this.safeSendToClient({
      type: 'reply_audio',
      payload: {
        audio: audioBase64,
        visemes: [],        // Task 2.3 中填充 viseme 数据
        isFinal: false,
        generation: this.generation,
      },
      timestamp: Date.now(),
    })
  }

  private safeSendToClient(msg: WSMessage): void {
    if (this.clientWs.readyState === WebSocket.OPEN) {
      try {
        this.clientWs.send(JSON.stringify(msg))
      } catch (err) {
        console.error('[VoiceSession] Failed to send to client:', err)
      }
    }
  }
}
