import WebSocket from 'ws'
import { randomUUID } from 'crypto'
import { gunzipSync } from 'zlib'
import { WSMessage, SessionState, VisemeEvent } from '../shared/types'

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
const EVENT_SAY_HELLO         = 300   // 主动触发欢迎语

// 事件编号：Server → Client（不需要 SessionID/ConnectID 前缀的特殊事件）
// 注意：event 50 (ConnectionStarted) 实际包含 connectId 字段，所以不在此集合中
// 不含 sessionId 的事件（客户端 + 服务端）
const EVENTS_NO_SESSION_ID = new Set([1, 2, 50, 51, 52, 100])

// 豆包语音对话 API URL（运行时读取，支持 E2E mock 覆盖）
const getDoubaoUrl = () => process.env.DOUBAO_WS_URL || 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue'

// Pre-ready 音频缓冲上限
const AUDIO_BUFFER_MAX = 100

// ---------- Viseme 生成 ----------
// 每帧 ~30ms (24kHz 16-bit mono → 720 samples = 1440 bytes)
const VISEME_FRAME_BYTES = 1440
// RMS 阈值：低于此值视为静默
const VISEME_SILENCE_THRESHOLD = 400
// 元音切换最小间隔 (ms)
const VISEME_VOWEL_INTERVAL_MS = 180
// 可用元音 viseme
const VOWEL_VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh']

let lastVowelTime = 0
let lastVowelIndex = 0

/**
 * 从 int16 PCM buffer 生成 viseme 事件序列
 * 每 ~30ms 一帧，计算 RMS → 映射 mouth weight
 * 超阈值时随机切换元音，静默帧发 sil
 */
export function generateVisemes(int16Buf: Buffer): VisemeEvent[] {
  const visemes: VisemeEvent[] = []
  const totalBytes = int16Buf.length
  let offset = 0
  let frameTime = 0
  const now = Date.now()
  while (offset + 1 < totalBytes) {
    const end = Math.min(offset + VISEME_FRAME_BYTES, totalBytes)
    const sampleCount = Math.floor((end - offset) / 2)
    if (sampleCount === 0) break

    // 计算 RMS
    let sumSq = 0
    for (let i = 0; i < sampleCount; i++) {
      const sample = int16Buf.readInt16LE(offset + i * 2)
      sumSq += sample * sample
    }
    const rms = Math.sqrt(sumSq / sampleCount)

    if (rms < VISEME_SILENCE_THRESHOLD) {
      visemes.push({ viseme: 'sil', time: frameTime, weight: 0 })
    } else {
      // 归一化 weight: RMS 800~4000 → 0.3~1.0（TTS 音频 RMS 通常 1000~5000）
      const weight = Math.min(1.0, Math.max(0.3, 0.3 + 0.7 * (rms - VISEME_SILENCE_THRESHOLD) / 3200))

      // 切换元音
      if (now - lastVowelTime >= VISEME_VOWEL_INTERVAL_MS) {
        let idx = Math.floor(Math.random() * VOWEL_VISEMES.length)
        if (idx === lastVowelIndex) idx = (idx + 1) % VOWEL_VISEMES.length
        lastVowelIndex = idx
        lastVowelTime = now
      }

      visemes.push({
        viseme: VOWEL_VISEMES[lastVowelIndex],
        time: frameTime,
        weight,
      })
    }

    offset = end
    frameTime += 30
  }

  return visemes
}

// ---------- VoiceSession 内部状态机 ----------
type VoiceSessionState = 'init' | 'connecting' | 'ready' | 'finishing' | 'closing' | 'closed'

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
export function encodeFrame(
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

export function encodeJsonFrame(
  msgType: number,
  eventNum: number,
  obj: Record<string, unknown>,
  sessionId?: string,
  includeSessionId = false,
): Buffer {
  const payloadBuf = Buffer.from(JSON.stringify(obj), 'utf-8')
  return encodeFrame(msgType, SERIAL_JSON, eventNum, payloadBuf, sessionId, includeSessionId)
}

export function encodeAudioFrame(pcmBuf: Buffer, sessionId: string): Buffer {
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

export interface DecodedFrame {
  msgType: number
  flags: number
  serialization: number
  compression: number
  eventNum: number | null
  sessionId: string | null
  payload: Buffer
}

export function decodeFrame(data: Buffer): DecodedFrame | null {
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
  if (hasEvent && eventNum !== null && !EVENTS_NO_SESSION_ID.has(eventNum)) {
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

// ---------- system_role ----------
const SYSTEM_ROLE = `你是"小Neo"，一家咖啡店的点单助手。友好、简洁地与顾客交流。

## 重要规则
- 每次回复不超过 2-3 句话（语音交互，太长用户听着累）
- 主动引导点单流程

## 出杯触发
当顾客明确确认要一杯美式咖啡时（例如"好的就要美式"、"确认下单"、"就这个"），
你的回复末尾必须包含标记 [MAKE:美式]。
仅在顾客确认下单时才包含此标记，询问、推荐阶段不要包含。
示例：
- 顾客说"来一杯美式" → "好的，一杯美式咖啡！马上为您制作～[MAKE:美式]"
- 顾客说"有什么好喝的" → 正常推荐，不含标记`

// ---------- StartSession payload ----------
export function buildStartSessionPayload(dialogId?: string | null): Record<string, unknown> {
  const payload: Record<string, unknown> = {
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
        format: 'pcm_s16le',
        sample_rate: 24000,
      },
    },
    dialog: {
      bot_name: '小Neo',
      system_role: SYSTEM_ROLE,
      speaking_style: '语气友好、专业',
      extra: {
        input_mod: 'audio',
        model: '1.2.1.0',
        recv_timeout: 10,
      },
      ...(dialogId ? { dialog_id: dialogId } : {}),
    },
  }
  return payload
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
  private dialogId: string | null = null           // 跨 Session 对话上下文 ID
  private isFirstSession: boolean = true           // 控制欢迎语只在首次/重置后触发
  private currentResponseBuffer: string = ''       // 累积 LLM 回复文本（用于意图检测）
  private responseBufferGeneration: number = 0     // buffer 对应的 generation
  private pendingReset: boolean = false             // connecting 期间收到 reset 请求
  private onMakeCoffee?: (recipe: string) => void

  constructor(clientWs: WebSocket, onMakeCoffee?: (recipe: string) => void) {
    this.clientWs = clientWs
    this.connectId = randomUUID()
    this.onMakeCoffee = onMakeCoffee
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
      this.doubaoWs = new WebSocket(getDoubaoUrl(), {
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
    this.currentResponseBuffer = ''
    console.log('[VoiceSession] Interrupt, generation:', this.generation)

    if (this.internalState !== 'ready' || !this.sessionId) return

    // FinishSession → StartSession（重置当前对话轮次，保留 dialogId 上下文）
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

  /** 重置会话（新顾客）：清除 dialogId，重新触发欢迎语 */
  resetSession(): void {
    if (this.closed) return

    console.log('[VoiceSession] Reset session (new customer)')
    this.dialogId = null
    this.isFirstSession = true
    this.currentResponseBuffer = ''
    this.generation++
    this.isSpeaking = false

    if (this.internalState !== 'ready' || !this.sessionId) {
      // 正在 connecting 或无 sessionId → 标记待处理，在 SessionStarted 后执行
      this.pendingReset = true
      return
    }

    const finishFrame = encodeJsonFrame(
      MSG_TYPE_FULL_CLIENT,
      EVENT_FINISH_SESSION,
      {},
      this.sessionId,
      true,
    )
    this.doubaoWs?.send(finishFrame)

    this.internalState = 'finishing'  // 等待 SessionFinished (250) 事件
    this.sessionId = null
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
      buildStartSessionPayload(this.dialogId),
      this.connectId,
      true,  // includeSessionId: StartSession 需要包含 connectId
    )
    this.doubaoWs?.send(frame)
    console.log('[VoiceSession] StartSession sent, connectId:', this.connectId, 'dialogId:', this.dialogId)
  }

  /** 发送 SayHello 主动触发欢迎语，返回是否发送成功 */
  private sendSayHello(): boolean {
    if (!this.sessionId || this.doubaoWs?.readyState !== WebSocket.OPEN) return false
    const frame = encodeJsonFrame(
      MSG_TYPE_FULL_CLIENT,
      EVENT_SAY_HELLO,
      { content: '你好！欢迎光临，我是小Neo，有什么可以帮你的吗？' },
      this.sessionId,
      true,
    )
    this.doubaoWs.send(frame)
    console.log('[VoiceSession] SayHello sent')
    return true
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

    // sessionId 仅在 event 150 (SessionStarted) 中设置，
    // 避免 interrupt/reset 后旧帧的 sid 覆盖已清空的 sessionId

    // 丢弃旧 session 的帧：
    // 排除连接级事件 (50/51/52) 和新 session 建立 (150)
    const isConnectionEvent = eventNum !== null && eventNum <= 52
    if (frameSid && eventNum !== 150 && !isConnectionEvent) {
      if (this.sessionId && frameSid !== this.sessionId) return
      if (!this.sessionId && this.internalState === 'connecting') return
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
      this.handleServerJsonEvent(eventNum, json, frameSid)
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
  private handleServerJsonEvent(eventNum: number | null, json: Record<string, unknown>, frameSid?: string | null): void {
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
      case 152: {
        // SessionFinished → 旧 session 已关闭，可以开新 session
        console.log('[VoiceSession] SessionFinished')
        if (this.internalState === 'finishing') {
          this.internalState = 'connecting'
          this.sendStartSession()
        }
        break
      }
      case 150: {
        // SessionStarted → ready，可以开始接收音频
        console.log('[VoiceSession] SessionStarted, session ready')
        this.internalState = 'ready'
        // sessionId: 优先帧头 sid，降级 json payload
        const sid = frameSid || (json['session_id'] as string | undefined)
        if (sid) {
          this.sessionId = sid
          console.log('[VoiceSession] sessionId from SessionStarted:', this.sessionId)
        }
        // 捕获 dialog_id（跨 Session 上下文）
        const dialogId = json['dialog_id'] as string | undefined
        if (dialogId) {
          this.dialogId = dialogId
          console.log('[VoiceSession] dialogId captured:', this.dialogId)
        }
        // 如果有挂起的 reset 请求（在 connecting 期间收到），立即执行
        if (this.pendingReset) {
          this.pendingReset = false
          console.log('[VoiceSession] Executing pending reset')
          this.resetSession()
          break
        }
        this.flushAudioBuffer()
        // 首次 Session 或重置后 → 触发欢迎语
        if (this.isFirstSession) {
          const sent = this.sendSayHello()
          if (sent) this.isFirstSession = false
        }
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

    // Event 450: ASRInfo — 日志记录 question_id
    if (eventNum === 450) {
      const questionId = json['question_id'] ?? extra?.['question_id']
      console.log('[VoiceSession] ASRInfo (450), question_id:', questionId)
    }

    // Event 451: ASR 识别文本（兼容官方格式 + 现有格式）
    if (eventNum === 451) {
      let text: string | undefined
      let isFinal = false

      // 优先官方格式: results[0].text + is_interim
      const results = json['results'] as Array<{ text: string; is_interim: boolean }> | undefined
      if (results?.length) {
        text = results[0].text
        isFinal = !results[0].is_interim
      } else if (extra) {
        // 降级现有格式: extra.origin_text + extra.endpoint
        text = extra['origin_text'] as string | undefined
        isFinal = !!(extra['endpoint'] as boolean | undefined)
      }

      if (text) {
        if (isFinal) {
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
            isFinal,
            generation: this.generation,
          },
          timestamp: Date.now(),
        })
      }
    }

    // Event 459: ASREnded — 兜底日志
    if (eventNum === 459) {
      console.log('[VoiceSession] ASREnded (459)')
    }

    // Event 350: TTSSentenceStart — 日志记录回复文本（备用通道）
    if (eventNum === 350) {
      const text = json['text'] as string | undefined
      if (text) {
        console.log('[VoiceSession] TTSSentenceStart (350):', text.slice(0, 100))
      }
    }

    // Event 550: LLM 文本回复
    if (eventNum === 550) {
      const content = json['content'] as string | undefined
      if (content) {
        // 绑定 generation：新回复开始时记录 generation
        if (this.currentResponseBuffer === '') {
          this.responseBufferGeneration = this.generation
        }
        this.currentResponseBuffer += content
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

    // Event 559: LLM 文本回复结束 — 意图检测
    if (eventNum === 559) {
      // 仅当 buffer 属于当前 generation 时才触发意图检测
      if (this.responseBufferGeneration === this.generation) {
        const makeMatch = this.currentResponseBuffer.match(/\[MAKE:([^\]]+)\]/)
        if (makeMatch) {
          const recipe = makeMatch[1]
          console.log('[VoiceSession] Coffee order detected:', recipe)
          this.onMakeCoffee?.(recipe)
          this.safeSendToClient({
            type: 'make_coffee',
            payload: { recipe },
            timestamp: Date.now(),
          })
        }
      }
      this.currentResponseBuffer = ''

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
      // 先发 isFinal 标记，让客户端合并剩余 chunks
      this.safeSendToClient({
        type: 'reply_audio',
        payload: {
          isFinal: true,
          generation: this.generation,
        },
        timestamp: Date.now(),
      })
      this.safeSendToClient({
        type: 'state_change',
        payload: { state: 'listening' as SessionState },
        timestamp: Date.now(),
      })
    }
  }

  private ttsChunkIndex = 0
  private ttsFirstChunkTime = 0

  /** 处理豆包发来的 TTS 音频帧（pcm_s16le 直出，无需转换） */
  private handleServerAudio(pcmBuf: Buffer): void {
    if (!this.isSpeaking) {
      this.isSpeaking = true
      this.ttsChunkIndex = 0
      this.ttsFirstChunkTime = Date.now()
      this.safeSendToClient({
        type: 'state_change',
        payload: { state: 'speaking' as SessionState },
        timestamp: Date.now(),
      })
    }

    this.ttsChunkIndex++
    const elapsed = Date.now() - this.ttsFirstChunkTime
    const durationMs = (pcmBuf.length / 2 / 24000) * 1000  // PCM 16-bit mono 24kHz
    console.log(`[TTS] chunk #${this.ttsChunkIndex} | +${elapsed}ms | ${pcmBuf.length}B | ~${durationMs.toFixed(0)}ms audio`)

    const audioBase64 = pcmBuf.toString('base64')
    const visemes = generateVisemes(pcmBuf)
    this.safeSendToClient({
      type: 'reply_audio',
      payload: {
        audio: audioBase64,
        visemes,
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
