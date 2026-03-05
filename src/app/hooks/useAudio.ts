import { useEffect, useRef, useCallback, RefObject } from 'react'
import { Audio } from 'expo-av'
import { File, Paths } from 'expo-file-system/next'
import { sessionManager } from '../services/SessionManager'
import { ReplyAudioPayload } from '../../shared/types'
import type { AvatarWebViewRef } from '../components/AvatarWebView'
import { setDefaultToSpeaker } from '../../../modules/audio-route'

// 动态导入原生模块，Expo Go 中不可用时降级
let LiveAudioStream: any = null
try {
  LiveAudioStream = require('react-native-live-audio-stream').default
} catch (_) {
  console.warn('[useAudio] react-native-live-audio-stream not available (Expo Go?), audio capture disabled')
}

// ---------- 配置 ----------
const CAPTURE_SAMPLE_RATE = 16000
const CAPTURE_CHANNELS = 1
const CAPTURE_BITS = 16

const TTS_SAMPLE_RATE = 24000

// VAD: 16-bit PCM RMS 阈值（speaking 状态下检测用户说话打断）
// 阈值不能太低，否则扬声器播放的 TTS 音频泄漏到麦克风会误触发打断
const VAD_THRESHOLD = 2000

// 进入 speaking 状态后，延迟多久开启 VAD（ms）
// 等待音频播放稳定 + 回声消除生效
const VAD_GRACE_PERIOD_MS = 2000

// 收到多少个 TTS chunk 后开始播放（减小首帧延迟 vs 防止断续）
const PLAYBACK_START_CHUNKS = 3

// speaking 结束后回声冷却期（ms），防止扬声器回声被 ASR 识别成用户输入
const ECHO_COOLDOWN_MS = 1500

// ---------- 工具函数 ----------

/** 从 base64 编码的 16-bit PCM 计算 RMS（Root Mean Square） */
function calculateRMS(base64: string): number {
  const raw = atob(base64)
  const numSamples = raw.length / 2
  if (numSamples === 0) return 0
  let sumSq = 0
  for (let i = 0; i < raw.length; i += 2) {
    const lo = raw.charCodeAt(i)
    const hi = raw.charCodeAt(i + 1)
    let sample = lo | (hi << 8)
    if (sample >= 0x8000) sample -= 0x10000
    sumSq += sample * sample
  }
  return Math.sqrt(sumSq / numSamples)
}

/** 将多个 base64 PCM chunk 合并并添加 WAV 头，返回完整 WAV 的 Uint8Array */
function pcmChunksToWav(chunks: string[], sampleRate: number): Uint8Array {
  const allBytes: number[] = []
  for (const chunk of chunks) {
    const raw = atob(chunk)
    for (let i = 0; i < raw.length; i++) {
      allBytes.push(raw.charCodeAt(i))
    }
  }

  const dataLen = allBytes.length
  const wav = new Uint8Array(44 + dataLen)
  const view = new DataView(wav.buffer)

  // RIFF header
  wav[0] = 0x52; wav[1] = 0x49; wav[2] = 0x46; wav[3] = 0x46
  view.setUint32(4, 36 + dataLen, true)
  wav[8] = 0x57; wav[9] = 0x41; wav[10] = 0x56; wav[11] = 0x45

  // fmt chunk
  wav[12] = 0x66; wav[13] = 0x6D; wav[14] = 0x74; wav[15] = 0x20
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)     // PCM
  view.setUint16(22, 1, true)     // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)

  // data chunk
  wav[36] = 0x64; wav[37] = 0x61; wav[38] = 0x74; wav[39] = 0x61
  view.setUint32(40, dataLen, true)

  wav.set(allBytes, 44)
  return wav
}

/** Uint8Array → base64 */
function uint8ToBase64(arr: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i])
  }
  return btoa(binary)
}

// ---------- Hook ----------

export function useAudio(avatarRef?: RefObject<AvatarWebViewRef | null>) {
  const isCapturing = useRef(false)
  const playbackQueue = useRef<string[]>([])
  const isPlaying = useRef(false)
  const currentSound = useRef<Audio.Sound | null>(null)
  const generation = useRef(0)
  const fileCounter = useRef(0)
  const interruptSent = useRef(false)  // 防止 speaking 期间重复发送 interrupt
  const speakingStartTime = useRef(0)  // 进入 speaking 状态的时间戳
  const wasSpeaking = useRef(false)    // 追踪上一次是否处于 speaking
  const speakingEndTime = useRef(0)    // 离开 speaking 状态的时间戳（回声冷却用）
  const expectedServerGen = useRef<number | null>(null)  // 服务端 generation 校验

  // 设置音频模式
  useEffect(() => {
    Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
    })

    // 监听服务端 reply_audio 消息
    const unsubAudio = sessionManager.on('reply_audio', (msg) => {
      const payload = msg.payload as ReplyAudioPayload
      // 服务端 generation 校验：首包记录，后续不匹配则丢弃
      if (payload.generation !== undefined) {
        if (expectedServerGen.current === null) {
          expectedServerGen.current = payload.generation
        } else if (payload.generation !== expectedServerGen.current) {
          return  // 旧 generation 的音频，丢弃
        }
      }
      if (payload.audio) {
        enqueueChunk(payload.audio)
      }
      // 转发 viseme 数据到 WebView
      if (payload.visemes && payload.visemes.length > 0 && avatarRef?.current) {
        avatarRef.current.sendMessage({
          type: 'set_visemes',
          data: { visemes: payload.visemes },
        })
      }
    })

    return () => {
      unsubAudio()
      stopCapture()
      clearPlayback()
    }
  }, [])

  // ---------- 音频采集 ----------

  const startCapture = useCallback(async () => {
    if (isCapturing.current) return

    if (!LiveAudioStream) {
      console.warn('[useAudio] Native audio capture not available, skipping')
      return
    }

    const { status } = await Audio.requestPermissionsAsync()
    if (status !== 'granted') {
      console.warn('[useAudio] Microphone permission denied')
      return
    }

    LiveAudioStream.init({
      sampleRate: CAPTURE_SAMPLE_RATE,
      channels: CAPTURE_CHANNELS,
      bitsPerSample: CAPTURE_BITS,
      audioSource: 6,       // VOICE_RECOGNITION
      wavFile: 'capture.wav', // 必填但不使用（我们只用流式回调）
    })

    LiveAudioStream.on('data', (base64: string) => {
      const currentState = sessionManager.getState()

      if (currentState === 'speaking') {
        // 记录进入 speaking 的时间
        if (!wasSpeaking.current) {
          wasSpeaking.current = true
          speakingStartTime.current = Date.now()
        }

        // speaking 状态下：不发送 audio 到服务端（服务端在生成 TTS，不需要 ASR）
        // 仅做本地 VAD 打断检测
        if (!interruptSent.current) {
          // 保护期内不检测 VAD，避免扬声器回声误触发
          const elapsed = Date.now() - speakingStartTime.current
          if (elapsed > VAD_GRACE_PERIOD_MS) {
            const rms = calculateRMS(base64)
            if (rms > VAD_THRESHOLD) {
              interruptSent.current = true
              console.log('[useAudio] VAD interrupt, RMS:', Math.round(rms))
              // 立即清空播放队列，不等服务端状态变更
              clearPlayback()
              sessionManager.send({
                type: 'interrupt',
                payload: {},
                timestamp: Date.now(),
              })
            }
          }
        }
      } else {
        // 非 speaking 状态
        if (wasSpeaking.current) {
          wasSpeaking.current = false
          interruptSent.current = false
        }

        // TTS 还在播放时，不发送音频（防止回声被 ASR 识别）
        if (isPlaying.current) {
          speakingEndTime.current = Date.now()  // 持续刷新，冷却期从播放真正结束后开始
          return
        }

        // 播放结束后的回声冷却期
        if (speakingEndTime.current > 0) {
          const cooldown = Date.now() - speakingEndTime.current
          if (cooldown < ECHO_COOLDOWN_MS) {
            return  // 跳过这个 chunk
          }
        }

        // 正常发送音频到后端
        sessionManager.send({
          type: 'audio_chunk',
          payload: { audio: base64 },
          timestamp: Date.now(),
        })
      }
    })

    LiveAudioStream.start()
    isCapturing.current = true
    console.log('[useAudio] Capture started')

    // LiveAudioStream 启动后会覆盖 AVAudioSession，默认走听筒。
    // 调用原生模块强制切换到扬声器输出。
    try {
      setDefaultToSpeaker()
      console.log('[useAudio] Audio routed to speaker')
    } catch (e) {
      console.warn('[useAudio] Failed to set speaker output:', e)
    }
  }, [])

  const stopCapture = useCallback(() => {
    if (!isCapturing.current) return
    LiveAudioStream.stop()
    isCapturing.current = false
    console.log('[useAudio] Capture stopped')
  }, [])

  // ---------- TTS 音频播放 ----------

  const enqueueChunk = (base64: string) => {
    playbackQueue.current.push(base64)

    if (!isPlaying.current && playbackQueue.current.length >= PLAYBACK_START_CHUNKS) {
      playNextBatch()
    }
  }

  const playNextBatch = async () => {
    if (playbackQueue.current.length === 0) {
      isPlaying.current = false
      return
    }

    isPlaying.current = true
    const currentGen = generation.current

    const chunks = playbackQueue.current.splice(0)
    const wavData = pcmChunksToWav(chunks, TTS_SAMPLE_RATE)
    const wavBase64 = uint8ToBase64(wavData)

    const fileName = `tts_${++fileCounter.current}.wav`
    const file = new File(Paths.cache, fileName)

    try {
      file.write(wavBase64, { encoding: 'base64' })

      // 打断检查
      if (currentGen !== generation.current) {
        try { file.delete() } catch (_) {}
        isPlaying.current = false
        return
      }

      // 播放前重新 assert 扬声器路由（expo-av 可能覆盖 AVAudioSession）
      try { setDefaultToSpeaker() } catch (_) {}

      const { sound } = await Audio.Sound.createAsync({ uri: file.uri })
      currentSound.current = sound

      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          sound.unloadAsync()
          try { file.delete() } catch (_) {}
          currentSound.current = null
          playNextBatch()
        }
      })

      await sound.playAsync()
    } catch (err) {
      console.error('[useAudio] Playback error:', err)
      try { file.delete() } catch (_) {}
      isPlaying.current = false
      if (playbackQueue.current.length > 0) {
        playNextBatch()
      }
    }
  }

  /** 清空播放队列并停止当前播放（打断/重置时调用） */
  const clearPlayback = useCallback(async () => {
    generation.current++
    expectedServerGen.current = null  // 重置服务端 generation 校验
    playbackQueue.current = []
    isPlaying.current = false

    if (currentSound.current) {
      try {
        await currentSound.current.stopAsync()
        await currentSound.current.unloadAsync()
      } catch (_) {}
      currentSound.current = null
    }
  }, [])

  return { startCapture, stopCapture, clearPlayback }
}
