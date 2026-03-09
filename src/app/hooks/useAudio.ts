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

// TTS 播放增益（1.0 = 原始音量）
const TTS_GAIN = 10.0

const TTS_SAMPLE_RATE = 24000

// VAD: 16-bit PCM RMS 阈值（speaking 状态下检测用户说话打断）
// 阈值不能太低，否则扬声器播放的 TTS 音频泄漏到麦克风会误触发打断
const VAD_THRESHOLD = 2000

// 进入 speaking 状态后，延迟多久开启 VAD（ms）
// 等待音频播放稳定 + 回声消除生效
const VAD_GRACE_PERIOD_MS = 2000

// 收到多少个 TTS chunk 后开始播放（减小首帧延迟 vs 防止断续）
const PLAYBACK_START_CHUNKS = 6

// speaking 结束后回声冷却期（ms），防止扬声器回声被 ASR 识别成用户输入
const ECHO_COOLDOWN_MS = 300

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
    for (let i = 0; i < raw.length; i += 2) {
      const lo = raw.charCodeAt(i)
      const hi = i + 1 < raw.length ? raw.charCodeAt(i + 1) : 0
      let sample = lo | (hi << 8)
      if (sample >= 0x8000) sample -= 0x10000
      // 应用增益并 clamp 到 16-bit 范围
      sample = Math.max(-32768, Math.min(32767, Math.round(sample * TTS_GAIN)))
      const us = sample < 0 ? sample + 0x10000 : sample
      allBytes.push(us & 0xFF, (us >> 8) & 0xFF)
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
  const fileSlot = useRef(0)  // 0 or 1, rotating between tts_0.wav and tts_1.wav
  const interruptSent = useRef(false)  // 防止 speaking 期间重复发送 interrupt
  const speakingStartTime = useRef(0)  // 进入 speaking 状态的时间戳
  const wasSpeaking = useRef(false)    // 追踪上一次是否处于 speaking
  const speakingEndTime = useRef(0)    // 离开 speaking 状态的时间戳（回声冷却用）
  const expectedServerGen = useRef<number | null>(null)  // 服务端 generation 校验
  const pendingSound = useRef<Audio.Sound | null>(null)  // 双缓冲：预加载的下一批 Sound
  const pendingFile = useRef<File | null>(null)           // 双缓冲：预加载的文件引用
  const preparingNext = useRef(false)                     // 是否正在预加载
  const prebufferTimer = useRef<ReturnType<typeof setTimeout> | null>(null)  // 预缓冲延迟计时器
  const firstChunkTime = useRef(0)                        // 首个 chunk 到达时间（超时用）
  const accumulateTimer = useRef<ReturnType<typeof setTimeout> | null>(null) // 等 isFinal 超时计时器
  const visemeBuffer = useRef<any[]>([])  // 缓冲所有 viseme 帧，等播放时重放
  const visemePlaybackTimer = useRef<ReturnType<typeof setInterval> | null>(null)

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
          console.log('[useAudio] New stream, serverGen:', payload.generation, 'isFinal:', !!payload.isFinal, 'hasAudio:', !!payload.audio)
          expectedServerGen.current = payload.generation
        } else if (payload.generation !== expectedServerGen.current) {
          console.log('[useAudio] DROPPED chunk, expected:', expectedServerGen.current, 'got:', payload.generation)
          return  // 旧 generation 的音频，丢弃
        }
      }
      if (payload.audio) {
        enqueueChunk(payload.audio, !!payload.isFinal)
      } else if (payload.isFinal) {
        // 无音频的 isFinal 信号：立即触发预缓冲合并剩余 chunks
        flushAllChunks()
      }
      // 缓冲 viseme 数据，等实际播放时再按序发给 WebView
      if (payload.visemes && payload.visemes.length > 0) {
        for (const v of payload.visemes) {
          visemeBuffer.current.push(v)
        }
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

  const enqueueChunk = (base64: string, isFinal: boolean = false) => {
    playbackQueue.current.push(base64)

    // 记录首个 chunk 到达时间
    if (firstChunkTime.current === 0) {
      firstChunkTime.current = Date.now()
    }

    if (isFinal) {
      // TTS 结束：立即播放/预缓冲全部
      flushAllChunks()
    } else if (!isPlaying.current) {
      // 未开始播放：等 isFinal，但设超时防止长回复延迟过大
      if (!accumulateTimer.current) {
        accumulateTimer.current = setTimeout(() => {
          accumulateTimer.current = null
          if (!isPlaying.current && playbackQueue.current.length > 0) {
            console.log('[useAudio] Accumulate timeout, starting playback, queue:', playbackQueue.current.length)
            playNextBatch()
          }
        }, 2000)
      }
    } else if (isPlaying.current && !pendingSound.current && !preparingNext.current) {
      // 已在播放：延迟预缓冲
      if (!prebufferTimer.current) {
        prebufferTimer.current = setTimeout(() => {
          prebufferTimer.current = null
          if (playbackQueue.current.length > 0 && !pendingSound.current && !preparingNext.current) {
            console.log('[useAudio] Deferred prebuffer, queue:', playbackQueue.current.length)
            prepareNextBatch()
          }
        }, 300)
      }
    }
  }

  /** 收到 isFinal 或超时：将全部 chunks 合并为一批播放 */
  const flushAllChunks = () => {
    // 清理计时器
    if (accumulateTimer.current) {
      clearTimeout(accumulateTimer.current)
      accumulateTimer.current = null
    }
    if (prebufferTimer.current) {
      clearTimeout(prebufferTimer.current)
      prebufferTimer.current = null
    }

    if (!isPlaying.current && playbackQueue.current.length > 0) {
      console.log('[useAudio] isFinal: playing ALL chunks in one batch, queue:', playbackQueue.current.length)
      playNextBatch()
    } else if (isPlaying.current && playbackQueue.current.length > 0 && !pendingSound.current && !preparingNext.current) {
      console.log('[useAudio] isFinal: prebuffer remaining, queue:', playbackQueue.current.length)
      prepareNextBatch()
    }
  }

  /** 延迟触发预缓冲，让 chunks 积累 300ms 再构建，减少批次切换次数 */
  const schedulePrebuffer = () => {
    if (prebufferTimer.current || pendingSound.current || preparingNext.current) return
    prebufferTimer.current = setTimeout(() => {
      prebufferTimer.current = null
      if (playbackQueue.current.length > 0 && !pendingSound.current && !preparingNext.current) {
        console.log('[useAudio] Deferred prebuffer, queue:', playbackQueue.current.length)
        prepareNextBatch()
      }
    }, 300)
  }

  /** 音频开始播放时，按 30ms 间隔重放缓冲的 viseme 帧 */
  const startVisemePlayback = () => {
    stopVisemePlayback()
    const allVisemes = visemeBuffer.current.splice(0)
    if (allVisemes.length === 0 || !avatarRef?.current) return

    // 告诉 WebView 进入 speaking 状态（覆盖服务端时序）
    avatarRef.current.sendMessage({ type: 'set_state', data: 'speaking' })

    let index = 0
    // 每 30ms 发一帧 viseme（与服务端生成帧率一致）
    visemePlaybackTimer.current = setInterval(() => {
      if (index >= allVisemes.length || !avatarRef?.current) {
        if (visemePlaybackTimer.current) {
          clearInterval(visemePlaybackTimer.current)
          visemePlaybackTimer.current = null
        }
        return
      }
      avatarRef.current.sendMessage({
        type: 'set_visemes',
        data: { visemes: [allVisemes[index]] },
      })
      index++
    }, 30)
  }

  /** 停止 viseme 重放 */
  const stopVisemePlayback = () => {
    if (visemePlaybackTimer.current) {
      clearInterval(visemePlaybackTimer.current)
      visemePlaybackTimer.current = null
    }
  }

  /** 预加载下一批音频（双缓冲：在当前批次播放时提前创建 Sound） */
  const prepareNextBatch = async () => {
    if (preparingNext.current || pendingSound.current) return
    if (playbackQueue.current.length === 0) return

    preparingNext.current = true
    const currentGen = generation.current

    const chunks = playbackQueue.current.splice(0)
    const wavData = pcmChunksToWav(chunks, TTS_SAMPLE_RATE)
    const wavBase64 = uint8ToBase64(wavData)

    const fileName = `tts_${fileSlot.current ^= 1}.wav`
    const file = new File(Paths.cache, fileName)

    try {
      file.write(wavBase64, { encoding: 'base64' })

      if (currentGen !== generation.current) {
        try { file.delete() } catch (_) {}
        preparingNext.current = false
        return
      }

      const { sound } = await Audio.Sound.createAsync({ uri: file.uri })

      if (currentGen !== generation.current) {
        sound.unloadAsync()
        try { file.delete() } catch (_) {}
        preparingNext.current = false
        return
      }

      pendingSound.current = sound
      pendingFile.current = file
    } catch (err) {
      console.error('[useAudio] Prepare next batch error:', err)
      try { file.delete() } catch (_) {}
    }

    preparingNext.current = false
  }

  const playNextBatch = async () => {
    const t0 = Date.now()

    // 双缓冲：优先使用预加载的 Sound（零间隙切换）
    if (pendingSound.current) {
      isPlaying.current = true
      const currentGen = generation.current
      const sound = pendingSound.current
      const file = pendingFile.current
      pendingSound.current = null
      pendingFile.current = null

      if (currentGen !== generation.current) {
        sound.unloadAsync()
        try { file?.delete() } catch (_) {}
        isPlaying.current = false
        return
      }

      currentSound.current = sound

      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          console.log('[useAudio] Batch finished (buffered), pending:', !!pendingSound.current, 'queue:', playbackQueue.current.length)
          sound.unloadAsync()
          try { file?.delete() } catch (_) {}
          currentSound.current = null
          playNextBatch()
        }
      })

      await sound.playAsync()
      startVisemePlayback()
      console.log('[useAudio] Batch started (buffered), switchTime:', Date.now() - t0, 'ms')
      // 延迟预加载下一批，让 chunks 积累更多
      schedulePrebuffer()
      return
    }

    // 无预加载可用：回退到原始逻辑
    if (playbackQueue.current.length === 0) {
      console.log('[useAudio] No more chunks, playback ended')
      isPlaying.current = false
      firstChunkTime.current = 0
      expectedServerGen.current = null
      stopVisemePlayback()
      avatarRef?.current?.sendMessage({ type: 'set_state', data: 'listening' })
      return
    }

    isPlaying.current = true
    const currentGen = generation.current

    try {
    const chunks = playbackQueue.current.splice(0)
    const wavData = pcmChunksToWav(chunks, TTS_SAMPLE_RATE)
    const wavBase64 = uint8ToBase64(wavData)

    const fileName = `tts_${fileSlot.current ^= 1}.wav`
    const file = new File(Paths.cache, fileName)

      file.write(wavBase64, { encoding: 'base64' })

      if (currentGen !== generation.current) {
        try { file.delete() } catch (_) {}
        isPlaying.current = false
        return
      }

      const { sound } = await Audio.Sound.createAsync({ uri: file.uri })
      currentSound.current = sound

      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          console.log('[useAudio] Batch finished (unbuffered), pending:', !!pendingSound.current, 'queue:', playbackQueue.current.length)
          sound.unloadAsync()
          try { file.delete() } catch (_) {}
          currentSound.current = null
          playNextBatch()
        }
      })

      await sound.playAsync()
      startVisemePlayback()
      console.log('[useAudio] Batch started (unbuffered), loadTime:', Date.now() - t0, 'ms')
      // 延迟预加载下一批，让 chunks 积累更多
      schedulePrebuffer()
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
    preparingNext.current = false
    firstChunkTime.current = 0
    if (prebufferTimer.current) {
      clearTimeout(prebufferTimer.current)
      prebufferTimer.current = null
    }
    if (accumulateTimer.current) {
      clearTimeout(accumulateTimer.current)
      accumulateTimer.current = null
    }

    // 清理 viseme 播放
    stopVisemePlayback()
    visemeBuffer.current = []

    // 清理预加载的 Sound
    if (pendingSound.current) {
      try { await pendingSound.current.unloadAsync() } catch (_) {}
      pendingSound.current = null
    }
    if (pendingFile.current) {
      try { pendingFile.current.delete() } catch (_) {}
      pendingFile.current = null
    }

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
