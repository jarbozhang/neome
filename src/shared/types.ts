// src/shared/types.ts

// WebSocket 消息类型
export type WSMessageType =
  | 'audio_chunk'      // 客户端→服务端：音频数据
  | 'transcript'       // 服务端→客户端：ASR 识别文本
  | 'reply_text'       // 服务端→客户端：LLM 回复文本
  | 'reply_audio'      // 服务端→客户端：TTS 音频 + viseme
  | 'interrupt'        // 客户端→服务端：打断信号
  | 'state_change'     // 双向：状态机变更
  | 'face_position'    // 客户端→服务端→WebView：用户脸部位置
  | 'welcome'          // 服务端→客户端：欢迎语触发
  | 'session_reset'    // 客户端→服务端：新顾客重置会话
  | 'make_coffee'      // 服务端→客户端：出杯指令

export interface WSMessage {
  type: WSMessageType
  payload: unknown
  timestamp: number
}

// 对话状态机
export type SessionState = 'idle' | 'listening' | 'thinking' | 'speaking'

// viseme 数据
export interface VisemeEvent {
  viseme: string    // ARKit viseme 名称，如 'viseme_aa', 'viseme_O'
  time: number      // 相对于音频起始的时间偏移 (ms)
  weight: number    // 权重 0-1
}

// TTS 音频 + viseme 包
export interface ReplyAudioPayload {
  audio: string          // base64 编码的 PCM/opus chunk
  visemes: VisemeEvent[]
  isFinal: boolean       // 是否最后一个 chunk
  generation?: number    // 打断代数，用于丢弃过期数据
}
