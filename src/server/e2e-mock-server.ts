/**
 * E2E Mock Server
 * 替代真实豆包语音 API，提供可预测的服务端行为用于 E2E 测试。
 *
 * 启动: npx tsx src/server/e2e-mock-server.ts
 * - Fastify 服务器: 端口 9527
 * - Mock 豆包 WebSocket: 端口 9530
 */

// 设置环境变量（必须在 import 之前）
process.env.DOUBAO_ACCESS_TOKEN = 'mock-token'
process.env.DOUBAO_APP_KEY = 'mock-key'
process.env.DOUBAO_APP_ID = 'mock-id'
process.env.DOUBAO_WS_URL = 'ws://localhost:9530'

import { WebSocketServer, WebSocket } from 'ws'
import { randomUUID } from 'crypto'
import { createApp } from './app'
import { decodeFrame, encodeFrame, encodeJsonFrame } from './voiceSession'

// ---------- 协议常量（与 voiceSession.ts 对齐） ----------
const MSG_TYPE_FULL_SERVER       = 0x9
const MSG_TYPE_AUDIO_ONLY_SERVER = 0xB
const SERIAL_JSON = 0x1
const SERIAL_RAW  = 0x0

// ---------- 正弦波 PCM 生成 ----------
function generateSinePCM(durationMs: number, freq: number = 440): Buffer {
  const sampleRate = 24000
  const numSamples = Math.floor(sampleRate * durationMs / 1000)
  const buf = Buffer.alloc(numSamples * 2)
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.floor(3000 * Math.sin(2 * Math.PI * freq * i / sampleRate))
    buf.writeInt16LE(sample, i * 2)
  }
  return buf
}

// 预生成 TTS PCM 帧（1440 字节 = ~30ms @ 24kHz 16bit mono）
const TTS_FRAME_BYTES = 1440
const TTS_FRAME = generateSinePCM(30, 440).subarray(0, TTS_FRAME_BYTES)

// ---------- Mock 豆包 WebSocket 服务器 ----------
function createMockDoubaoServer(port: number): WebSocketServer {
  const wss = new WebSocketServer({ port })

  wss.on('connection', (ws) => {
    console.log('[MockDoubao] Client connected')
    let sessionId: string | null = null

    ws.on('message', (data: Buffer) => {
      const frame = decodeFrame(Buffer.from(data))
      if (!frame) {
        console.warn('[MockDoubao] Failed to decode frame')
        return
      }

      const { eventNum, sessionId: frameSid, payload, serialization } = frame

      // 解析 JSON payload
      let json: Record<string, unknown> = {}
      if (serialization === SERIAL_JSON && payload.length > 0) {
        try {
          json = JSON.parse(payload.toString('utf-8'))
        } catch (_) {}
      }

      console.log('[MockDoubao] Received event:', eventNum, frameSid ? `sid:${frameSid.slice(0, 8)}...` : '')

      switch (eventNum) {
        case 1: // StartConnection
          handleStartConnection(ws)
          break
        case 100: // StartSession
          sessionId = handleStartSession(ws, json)
          break
        case 200: // UserQuery (audio frame)
          if (sessionId) handleAudioFrame(ws, sessionId)
          break
        case 300: // SayHello
          if (sessionId) handleSayHello(ws, sessionId)
          break
        case 102: // FinishSession
          handleFinishSession(ws, frameSid || sessionId)
          sessionId = null
          break
        case 2: // FinishConnection
          console.log('[MockDoubao] FinishConnection received')
          break
        default:
          console.log('[MockDoubao] Unhandled event:', eventNum)
      }
    })

    ws.on('close', () => {
      console.log('[MockDoubao] Client disconnected')
    })
  })

  return wss
}

// ---------- 事件处理 ----------

/** event 1 → reply event 50 (ConnectionStarted)，无 sessionId */
function handleStartConnection(ws: WebSocket): void {
  console.log('[MockDoubao] → ConnectionStarted (50)')
  const resp = encodeJsonFrame(
    MSG_TYPE_FULL_SERVER,
    50,
    {},
  )
  ws.send(resp)
}

/** event 100 → reply event 150 (SessionStarted)，含 sessionId + dialog_id */
function handleStartSession(ws: WebSocket, json: Record<string, unknown>): string {
  const sid = `mock-session-${randomUUID().slice(0, 8)}`
  const dialogId = (json['dialog'] as Record<string, unknown>)?.['dialog_id'] as string || `mock-dialog-${randomUUID().slice(0, 8)}`

  console.log('[MockDoubao] → SessionStarted (150), sid:', sid)
  const resp = encodeJsonFrame(
    MSG_TYPE_FULL_SERVER,
    150,
    { session_id: sid, dialog_id: dialogId },
    sid,
    true,  // includeSessionId
  )
  ws.send(resp)
  return sid
}

// 防抖：同一 session 内只响应一次 audio frame
const audioResponseLocks = new Set<string>()

/** event 200 → 模拟 ASR + LLM + TTS 流程（延迟 2 秒） */
function handleAudioFrame(ws: WebSocket, sessionId: string): void {
  // 防抖：忽略连续音频帧，每个 session 只模拟一次回复
  if (audioResponseLocks.has(sessionId)) return
  audioResponseLocks.add(sessionId)

  setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) return

    // ASR 文本 (event 451)
    console.log('[MockDoubao] → ASR text (451)')
    ws.send(encodeJsonFrame(
      MSG_TYPE_FULL_SERVER,
      451,
      { results: [{ text: '来一杯美式', is_interim: false }] },
      sessionId,
      true,
    ))

    // LLM 文本 (event 550)
    console.log('[MockDoubao] → LLM text (550)')
    ws.send(encodeJsonFrame(
      MSG_TYPE_FULL_SERVER,
      550,
      { content: '好的，一杯美式咖啡！马上为您制作～[MAKE:美式]' },
      sessionId,
      true,
    ))

    // TTS 音频帧 x3 (AudioOnlyServer, msgType=0xB)
    for (let i = 0; i < 3; i++) {
      console.log(`[MockDoubao] → TTS audio frame ${i + 1}/3`)
      const audioFrame = encodeFrame(
        MSG_TYPE_AUDIO_ONLY_SERVER,
        SERIAL_RAW,
        200,  // event number for audio（服务端音频帧也带 event）
        TTS_FRAME,
        sessionId,
        true,
      )
      ws.send(audioFrame)
    }

    // TTS 结束 (event 359)
    console.log('[MockDoubao] → TTS end (359)')
    ws.send(encodeJsonFrame(
      MSG_TYPE_FULL_SERVER,
      359,
      {},
      sessionId,
      true,
    ))

    // LLM 结束 (event 559)
    console.log('[MockDoubao] → LLM end (559)')
    ws.send(encodeJsonFrame(
      MSG_TYPE_FULL_SERVER,
      559,
      {},
      sessionId,
      true,
    ))

    audioResponseLocks.delete(sessionId)
  }, 2000)
}

/** event 300 → 模拟欢迎语 TTS */
function handleSayHello(ws: WebSocket, sessionId: string): void {
  console.log('[MockDoubao] SayHello received, sending welcome TTS')

  // LLM 文本 (event 550)
  ws.send(encodeJsonFrame(
    MSG_TYPE_FULL_SERVER,
    550,
    { content: '你好！欢迎光临，有什么可以帮你的吗？' },
    sessionId,
    true,
  ))

  // TTS 音频帧 x50 (~1.5s，让 Maestro 有时间捕捉 speaking 状态)
  for (let i = 0; i < 50; i++) {
    if (i < 3) console.log(`[MockDoubao] → Welcome TTS frame ${i + 1}/50`)
    const audioFrame = encodeFrame(
      MSG_TYPE_AUDIO_ONLY_SERVER,
      SERIAL_RAW,
      200,
      TTS_FRAME,
      sessionId,
      true,
    )
    ws.send(audioFrame)
  }

  // TTS 结束 (event 359)
  ws.send(encodeJsonFrame(
    MSG_TYPE_FULL_SERVER,
    359,
    {},
    sessionId,
    true,
  ))

  // LLM 结束 (event 559)
  ws.send(encodeJsonFrame(
    MSG_TYPE_FULL_SERVER,
    559,
    {},
    sessionId,
    true,
  ))
}

/** event 102 → reply event 152 (SessionFinished) */
function handleFinishSession(ws: WebSocket, sessionId: string | null): void {
  console.log('[MockDoubao] → SessionFinished (152)')
  ws.send(encodeJsonFrame(
    MSG_TYPE_FULL_SERVER,
    152,
    {},
    sessionId || 'unknown',
    true,
  ))
}

// ---------- 启动 ----------
async function main() {
  // 1. 启动 mock 豆包 WebSocket 服务器
  const mockPort = 9530
  const mockWss = createMockDoubaoServer(mockPort)
  console.log(`[E2E] Mock Doubao WebSocket server started on port ${mockPort}`)

  // 2. 启动 Fastify 应用服务器
  const app = await createApp()
  const serverPort = 9527
  await app.listen({ host: '0.0.0.0', port: serverPort })
  console.log(`[E2E] Mock server ready on port ${serverPort}, mock Doubao on port ${mockPort}`)

  // 优雅关闭
  const shutdown = async () => {
    console.log('[E2E] Shutting down...')
    mockWss.close()
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('[E2E] Failed to start:', err)
  process.exit(1)
})
