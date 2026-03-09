// src/shared/audioUtils.ts
// 纯函数工具，可在 Node.js 和 React Native 中共用

// TTS 播放增益（1.0 = 原始音量）
const TTS_GAIN = 10.0

/**
 * 从 base64 编码的 16-bit PCM 计算 RMS（Root Mean Square）
 * @param base64 base64 编码的 PCM 数据
 * @param decode base64 解码函数（浏览器用 atob，Node 用 Buffer）
 */
export function calculateRMS(base64: string, decode?: (s: string) => string): number {
  const raw = decode ? decode(base64) : Buffer.from(base64, 'base64').toString('latin1')
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

/**
 * 将多个 base64 PCM chunk 合并并添加 WAV 头，返回完整 WAV 的 Uint8Array
 * @param chunks base64 编码的 PCM chunk 数组
 * @param sampleRate 采样率
 * @param gain 音量增益（默认 TTS_GAIN）
 * @param decode base64 解码函数
 */
export function pcmChunksToWav(
  chunks: string[],
  sampleRate: number,
  gain: number = TTS_GAIN,
  decode?: (s: string) => string,
): Uint8Array {
  const allBytes: number[] = []
  for (const chunk of chunks) {
    const raw = decode ? decode(chunk) : Buffer.from(chunk, 'base64').toString('latin1')
    for (let i = 0; i < raw.length; i += 2) {
      const lo = raw.charCodeAt(i)
      const hi = i + 1 < raw.length ? raw.charCodeAt(i + 1) : 0
      let sample = lo | (hi << 8)
      if (sample >= 0x8000) sample -= 0x10000
      // 应用增益并 clamp 到 16-bit 范围
      sample = Math.max(-32768, Math.min(32767, Math.round(sample * gain)))
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
export function uint8ToBase64(arr: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i])
  }
  return typeof btoa !== 'undefined' ? btoa(binary) : Buffer.from(binary, 'latin1').toString('base64')
}
