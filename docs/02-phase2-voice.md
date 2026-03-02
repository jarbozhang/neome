# Phase 2：语音链路（约 2 周）

> 目标：打通"用户说话 → ASR → LLM 回复 → TTS → 口型同步"完整语音链路，支持打断。Phase 2 完成后，数字人可以真正"听"和"说"。

> 前置依赖：Phase 1 全部完成。

---

## Task 2.1：豆包实时语音 API 对接

### 目标
后端建立与豆包实时语音大模型的 WebSocket 连接，能够发送音频流并接收 ASR 识别结果。

### 具体步骤
1. 阅读豆包实时语音 API 文档：https://www.volcengine.com/docs/6893/1527770
2. 在 `src/server/voiceSession.ts` 中实现：
   - 与豆包 API 建立 WebSocket 连接（鉴权 + 握手）
   - 接收客户端 PCM 音频流，转发到豆包
   - 接收豆包返回的事件（ASR 文本、TTS 音频、状态变更等）
   - 处理 session 生命周期（创建/销毁/超时）
3. 创建 `.env` 配置文件，存储豆包 API Key 等敏感配置
4. 在 server `index.ts` 中将 WebSocket `/ws` 路由与 VoiceSession 关联

### 关键实现细节

**豆包实时语音 API 协议要点：**
- 协议基于 WebSocket，事件驱动
- 客户端事件：`session.create`, `audio.append`, `audio.commit`, `response.cancel`
- 服务端事件：`session.created`, `transcript.delta`, `audio.delta`, `response.done`
- 音频格式：PCM 16kHz 16bit mono, base64 编码
- 支持 VAD（服务端检测语音端点）
- 支持打断：发送 `response.cancel` 即可中断当前回复

```typescript
// src/server/voiceSession.ts 核心结构
import WebSocket from 'ws'

export class VoiceSession {
  private doubaoWs: WebSocket | null = null
  private clientWs: WebSocket
  private sessionId: string | null = null

  constructor(clientWs: WebSocket) {
    this.clientWs = clientWs
  }

  async start(): Promise<void> {
    // 1. 连接豆包 API
    this.doubaoWs = new WebSocket('wss://ark.cn-beijing.volces.com/api/v3/realtime', {
      headers: {
        'Authorization': `Bearer ${process.env.DOUBAO_API_KEY}`,
      }
    })

    // 2. 创建 session
    this.doubaoWs.on('open', () => {
      this.doubaoWs.send(JSON.stringify({
        type: 'session.create',
        session: {
          model: 'doubao-1.5-realtime-voice-pro',
          modalities: ['text', 'audio'],
          voice: 'zh_female_shuangkuaisisi_moon_bigtts',  // 选择合适的声音
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          turn_detection: { type: 'server_vad' },
        }
      }))
    })

    // 3. 监听豆包返回事件
    this.doubaoWs.on('message', (data) => {
      const event = JSON.parse(data.toString())
      this.handleDoubaoEvent(event)
    })
  }

  // 接收客户端音频并转发
  appendAudio(pcmBase64: string): void {
    this.doubaoWs?.send(JSON.stringify({
      type: 'audio.append',
      audio: pcmBase64,
    }))
  }

  // 打断当前回复
  interrupt(): void {
    this.doubaoWs?.send(JSON.stringify({
      type: 'response.cancel',
    }))
  }

  // 处理豆包返回事件
  private handleDoubaoEvent(event: any): void {
    switch (event.type) {
      case 'transcript.delta':
        // ASR 识别文本，转发给客户端显示
        this.clientWs.send(JSON.stringify({
          type: 'transcript',
          payload: { text: event.delta, isFinal: false },
          timestamp: Date.now(),
        }))
        break

      case 'audio.delta':
        // TTS 音频流，转发给客户端播放
        this.clientWs.send(JSON.stringify({
          type: 'reply_audio',
          payload: {
            audio: event.delta,  // base64 PCM
            visemes: [],         // Task 2.3 中添加 viseme 数据
            isFinal: false,
          },
          timestamp: Date.now(),
        }))
        break

      case 'response.done':
        // 回复完成
        this.clientWs.send(JSON.stringify({
          type: 'reply_audio',
          payload: { audio: '', visemes: [], isFinal: true },
          timestamp: Date.now(),
        }))
        break
    }
  }

  destroy(): void {
    this.doubaoWs?.close()
    this.doubaoWs = null
  }
}
```

### 验收标准
- [ ] 后端启动时能读取 `.env` 中的 `DOUBAO_API_KEY`
- [ ] 客户端 WebSocket 连接后，后端自动创建豆包语音 session
- [ ] 向后端发送模拟音频数据（可用预录制的 PCM 文件），豆包返回 ASR 文本
- [ ] ASR 文本通过 WebSocket 转发到客户端
- [ ] 豆包的 TTS 音频通过 WebSocket 转发到客户端
- [ ] 发送 `interrupt` 消息后，豆包停止当前回复
- [ ] 客户端断连后，豆包 session 自动清理

### 产出文件
```
src/server/voiceSession.ts
src/server/index.ts                # 更新：集成 VoiceSession
.env.example                       # 环境变量示例（不含真实 key）
```

---

## Task 2.2：RN 音频采集 + VAD 打断

### 目标
在 React Native 端实现麦克风音频采集（PCM 格式），通过 WebSocket 流式发送到后端；实现 VAD 检测，支持打断正在说话的数字人。

### 具体步骤
1. 研究 React Native 音频采集方案，选择合适的库：
   - 方案 A：`expo-av` 录音（简单但延迟较高）
   - 方案 B：`react-native-audio-api`（低延迟，接近 Web Audio API）
   - 方案 C：`react-native-live-audio-stream`（原始 PCM 流）
   - **推荐方案 C**，它能直接输出 PCM 流，最适合实时语音场景
2. 在 `src/app/hooks/useAudio.ts` 中实现：
   - 麦克风权限请求
   - PCM 音频流采集（16kHz, 16bit, mono）
   - 音频数据 base64 编码后通过 SessionManager 发送
   - 音频播放（接收服务端 TTS 音频并播放）
3. 实现 VAD（Voice Activity Detection）打断逻辑：
   - 当状态为 `speaking` 时，持续监听麦克风
   - 检测到用户语音活动 → 触发打断
   - VAD 可以简单用音量阈值实现（Phase 4 再优化为 Silero VAD）

### 关键实现细节

```typescript
// src/app/hooks/useAudio.ts
import LiveAudioStream from 'react-native-live-audio-stream'
import { SessionManager } from '../services/SessionManager'

export function useAudio(sessionManager: SessionManager) {
  const startRecording = () => {
    LiveAudioStream.init({
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      audioSource: 6, // VOICE_RECOGNITION (Android 优化)
    })

    LiveAudioStream.start()

    LiveAudioStream.on('data', (base64: string) => {
      // 发送音频到后端
      sessionManager.send({
        type: 'audio_chunk',
        payload: { audio: base64 },
        timestamp: Date.now(),
      })

      // VAD 打断检测（简单版：音量阈值）
      if (sessionManager.getState() === 'speaking') {
        const volume = calculateRMS(base64)
        if (volume > VAD_THRESHOLD) {
          sessionManager.send({
            type: 'interrupt',
            payload: {},
            timestamp: Date.now(),
          })
        }
      }
    })
  }

  const playAudio = (pcmBase64: string) => {
    // 将 base64 PCM 解码后通过 expo-av 或原生模块播放
    // 需要处理连续 chunk 的队列和拼接
  }

  const stopPlayback = () => {
    // 立即停止播放 + 清空队列（打断时调用）
  }

  return { startRecording, playAudio, stopPlayback }
}
```

**音频播放队列设计：**
```typescript
// 因为 TTS 音频是分 chunk 流式到达的，需要队列管理
class AudioQueue {
  private chunks: string[] = []
  private isPlaying = false

  enqueue(pcmBase64: string): void {
    this.chunks.push(pcmBase64)
    if (!this.isPlaying) this.playNext()
  }

  private async playNext(): Promise<void> {
    if (this.chunks.length === 0) {
      this.isPlaying = false
      return
    }
    this.isPlaying = true
    const chunk = this.chunks.shift()!
    await playPCM(chunk)  // 实际播放
    this.playNext()
  }

  clear(): void {
    this.chunks = []
    this.isPlaying = false
    // 停止当前正在播放的音频
  }
}
```

### 验收标准
- [ ] App 请求麦克风权限，用户授权后开始录音
- [ ] 对着手机说话，服务端日志显示收到 `audio_chunk` 消息
- [ ] 服务端返回的 TTS 音频能在 App 中播放出声
- [ ] 数字人说话时（speaking 状态），用户大声说话触发打断
- [ ] 打断后立即停止音频播放，切换到 listening 状态
- [ ] 音频播放是流式的（不需要等全部 TTS 完成才开始播放）

### 产出文件
```
src/app/hooks/useAudio.ts
src/app/screens/MainScreen.tsx     # 更新：集成音频
```

---

## Task 2.3：TTS + Viseme 口型驱动

### 目标
将 TTS 音频与 viseme（口型标记）关联，让数字人在说话时嘴巴动作与语音同步。

### 具体步骤
1. 研究 viseme 生成方案（二选一）：
   - **方案 A（推荐）**：利用豆包 TTS 输出的音频，在后端用轻量级音素分析生成 viseme 时间戳
   - **方案 B**：集成 HeadTTS (Kokoro)，它原生输出 viseme 时间戳
2. 在 `src/server/ttsService.ts` 中实现 viseme 生成：
   - 接收 TTS 音频流
   - 分析音频/文本生成 viseme 时间戳序列
   - 将 `{audio, visemes}` 打包发送到客户端
3. 在 WebView `avatar.ts` 中实现 viseme 驱动：
   - 接收 viseme 事件序列
   - 按时间戳驱动 VRM 模型的 blendshape morph targets
   - 实现平滑过渡（viseme 之间的插值）

### Viseme 映射表
```typescript
// ARKit viseme 到 VRM blendshape 的映射
const VISEME_MAP: Record<string, string> = {
  'viseme_sil': 'Neutral',      // 静默/闭嘴
  'viseme_aa':  'aa',            // "啊"
  'viseme_E':   'ee',            // "诶"
  'viseme_I':   'ih',            // "衣"
  'viseme_O':   'oh',            // "哦"
  'viseme_U':   'ou',            // "乌"
  // 更多映射根据 VRM 模型实际 blendshape 调整
}
```

### WebView viseme 驱动实现
```typescript
// avatar.ts 中添加
interface VisemeTimeline {
  visemes: VisemeEvent[]
  startTime: number
}

let currentTimeline: VisemeTimeline | null = null

// 接收 RN 传入的 viseme 数据
window.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.type === 'set_visemes') {
    currentTimeline = {
      visemes: msg.data.visemes,
      startTime: performance.now(),
    }
  }
  if (msg.type === 'reset') {
    resetVisemes()
  }
})

// 在渲染循环中更新 viseme
function updateVisemes(deltaTime: number) {
  if (!currentTimeline || !currentVRM) return

  const elapsed = performance.now() - currentTimeline.startTime
  const { visemes } = currentTimeline

  // 找到当前应该应用的 viseme
  let currentViseme = 'viseme_sil'
  let currentWeight = 0
  for (let i = visemes.length - 1; i >= 0; i--) {
    if (elapsed >= visemes[i].time) {
      currentViseme = visemes[i].viseme
      currentWeight = visemes[i].weight
      break
    }
  }

  // 应用到 VRM blendshape（带平滑插值）
  const blendshapeName = VISEME_MAP[currentViseme] || 'Neutral'
  const expression = currentVRM.expressionManager
  if (expression) {
    // 重置所有 viseme blendshape
    Object.values(VISEME_MAP).forEach(name => {
      const current = expression.getValue(name) || 0
      // 平滑衰减
      expression.setValue(name, current * 0.7)
    })
    // 设置当前 viseme
    expression.setValue(blendshapeName, currentWeight)
  }
}
```

### 验收标准
- [ ] 数字人说话时嘴巴有开合动作
- [ ] 口型变化与语音内容基本同步（延迟 < 200ms 可接受）
- [ ] 不同元音（啊、哦、衣）对应不同的嘴型
- [ ] 说话结束后嘴巴回到闭合状态
- [ ] viseme 之间过渡平滑，不出现突然跳变
- [ ] 打断时嘴巴立即归零

### 产出文件
```
src/server/ttsService.ts
src/webview/avatar.ts              # 更新：添加 viseme 驱动
src/shared/types.ts                # 更新：如需补充 viseme 类型
```

---

## Task 2.4：完整打断逻辑

### 目标
实现端到端的打断流程：用户在数字人说话时开口 → 数字人立即停止 → 开始听用户说话。确保打断体验流畅、无残留音频。

### 具体步骤
1. 完善前端打断链路：
   - VAD 检测到语音 → 停止音频播放 → 清空音频队列 → 发送 reset 到 WebView（口型归零）→ 发送 interrupt 到后端
2. 完善后端打断链路：
   - 收到 interrupt → 向豆包发送 `response.cancel` → 清空 TTS 缓冲 → 切换状态
3. 处理边界情况：
   - 打断时正在播放的音频 chunk 立即停止（不等播完）
   - 打断后仍在路上的音频 chunk 到达时丢弃（用 sequence number 标记）
   - 连续快速打断不会导致状态错乱

### 关键实现：序列号机制
```typescript
// 用 generation 计数器避免旧数据污染
// SessionManager.ts
private generation = 0

interrupt(): void {
  this.generation++  // 递增 generation
  this.send({ type: 'interrupt', payload: { generation: this.generation }, timestamp: Date.now() })
  this.audioQueue.clear()
  this.webview.postMessage({ type: 'reset' })
  this.setState('listening')
}

handleReplyAudio(msg: WSMessage): void {
  const payload = msg.payload as ReplyAudioPayload & { generation: number }
  // 只处理当前 generation 的数据
  if (payload.generation !== this.generation) return
  this.audioQueue.enqueue(payload.audio)
  this.webview.postMessage({ type: 'set_visemes', data: { visemes: payload.visemes } })
}
```

### 验收标准
- [ ] 数字人说话时，用户说话能在 500ms 内打断
- [ ] 打断后没有残留音频播放出来
- [ ] 打断后数字人嘴巴立即闭合
- [ ] 打断后 immediately 开始新一轮 ASR 监听
- [ ] 快速连续打断（用户说一个字就停，再说一个字又停）不会崩溃
- [ ] 打断后的新对话正常工作，不受旧数据影响

### 产出文件
```
src/app/services/SessionManager.ts  # 更新：完善打断逻辑
src/app/hooks/useAudio.ts           # 更新：打断时清空队列
src/server/voiceSession.ts          # 更新：处理 interrupt
```

---

## Phase 2 里程碑验收

完成以上 4 个 Task 后，应该达到：

1. ✅ 对着手机说话，数字人能"听懂"并语音回复
2. ✅ 数字人说话时嘴巴与语音同步
3. ✅ 可以在数字人说话时打断，数字人立即停止并开始听
4. ✅ 对话是流式的（不需要等全部生成完才开始说）
5. ✅ 豆包实时语音 API 完整对接

**此时还没有**：LLM 意图识别（豆包 API 自带基础对话能力，但没有咖啡店专业知识）、MCP 工具、用户追踪、UI 组件。

**端到端测试场景：**
1. 启动 App + Server
2. 对着手机说"你好"
3. 数字人回复"你好"（豆包默认对话），嘴巴随语音张合
4. 在数字人说话时再次说话，数字人立即停止并听你说
5. 说"今天天气怎么样"，数字人给出回答
