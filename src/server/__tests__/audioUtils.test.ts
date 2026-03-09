import { calculateRMS, pcmChunksToWav, uint8ToBase64 } from '../../shared/audioUtils'

// ---------- calculateRMS ----------

describe('calculateRMS', () => {
  test('returns 0 for empty input', () => {
    const empty = Buffer.from('', 'latin1').toString('base64')
    expect(calculateRMS(empty)).toBe(0)
  })

  test('returns 0 for all-zero samples', () => {
    const silent = Buffer.alloc(320, 0) // 160 samples of silence
    const b64 = silent.toString('base64')
    expect(calculateRMS(b64)).toBe(0)
  })

  test('returns correct RMS for known samples', () => {
    // Create 4 samples: [100, -100, 100, -100]
    const buf = Buffer.alloc(8)
    buf.writeInt16LE(100, 0)
    buf.writeInt16LE(-100, 2)
    buf.writeInt16LE(100, 4)
    buf.writeInt16LE(-100, 6)
    const b64 = buf.toString('base64')
    // RMS = sqrt((100^2 + 100^2 + 100^2 + 100^2) / 4) = sqrt(10000) = 100
    expect(calculateRMS(b64)).toBeCloseTo(100, 1)
  })

  test('returns correct RMS for uniform high amplitude', () => {
    const buf = Buffer.alloc(200) // 100 samples
    for (let i = 0; i < 100; i++) {
      buf.writeInt16LE(5000, i * 2)
    }
    const b64 = buf.toString('base64')
    expect(calculateRMS(b64)).toBeCloseTo(5000, 1)
  })

  test('handles negative samples correctly', () => {
    const buf = Buffer.alloc(4) // 2 samples
    buf.writeInt16LE(-32768, 0) // min 16-bit
    buf.writeInt16LE(-1, 2)
    const b64 = buf.toString('base64')
    const rms = calculateRMS(b64)
    // RMS = sqrt((32768^2 + 1^2) / 2) ≈ 23170
    expect(rms).toBeGreaterThan(23000)
    expect(rms).toBeLessThan(24000)
  })

  test('VAD threshold detection: silent audio is below threshold', () => {
    const VAD_THRESHOLD = 2000
    const buf = Buffer.alloc(640, 0) // 320 samples of silence
    const b64 = buf.toString('base64')
    expect(calculateRMS(b64)).toBeLessThan(VAD_THRESHOLD)
  })

  test('VAD threshold detection: loud audio is above threshold', () => {
    const VAD_THRESHOLD = 2000
    const buf = Buffer.alloc(640)
    for (let i = 0; i < 320; i++) {
      buf.writeInt16LE(5000, i * 2)
    }
    const b64 = buf.toString('base64')
    expect(calculateRMS(b64)).toBeGreaterThan(VAD_THRESHOLD)
  })
})

// ---------- pcmChunksToWav ----------

describe('pcmChunksToWav', () => {
  test('produces valid WAV header for empty input', () => {
    const wav = pcmChunksToWav([], 24000, 1.0)
    expect(wav.length).toBe(44) // header only

    // RIFF
    expect(String.fromCharCode(wav[0], wav[1], wav[2], wav[3])).toBe('RIFF')
    // WAVE
    expect(String.fromCharCode(wav[8], wav[9], wav[10], wav[11])).toBe('WAVE')
    // fmt
    expect(String.fromCharCode(wav[12], wav[13], wav[14], wav[15])).toBe('fmt ')
    // data
    expect(String.fromCharCode(wav[36], wav[37], wav[38], wav[39])).toBe('data')
  })

  test('WAV header has correct sample rate', () => {
    const wav = pcmChunksToWav([], 24000, 1.0)
    const view = new DataView(wav.buffer)
    expect(view.getUint32(24, true)).toBe(24000) // sample rate
    expect(view.getUint32(28, true)).toBe(48000) // byte rate = 24000 * 2
  })

  test('WAV header has correct format fields', () => {
    const wav = pcmChunksToWav([], 16000, 1.0)
    const view = new DataView(wav.buffer)
    expect(view.getUint16(20, true)).toBe(1)  // PCM format
    expect(view.getUint16(22, true)).toBe(1)  // mono
    expect(view.getUint16(34, true)).toBe(16) // 16-bit
  })

  test('data length matches chunk content', () => {
    // Create one chunk with 4 samples (8 bytes)
    const buf = Buffer.alloc(8)
    for (let i = 0; i < 4; i++) buf.writeInt16LE(100, i * 2)
    const b64 = buf.toString('base64')

    const wav = pcmChunksToWav([b64], 24000, 1.0)
    expect(wav.length).toBe(44 + 8)

    const view = new DataView(wav.buffer)
    expect(view.getUint32(40, true)).toBe(8) // data chunk size
    expect(view.getUint32(4, true)).toBe(36 + 8) // RIFF size
  })

  test('applies gain correctly', () => {
    const buf = Buffer.alloc(2)
    buf.writeInt16LE(1000, 0)
    const b64 = buf.toString('base64')

    const wav = pcmChunksToWav([b64], 24000, 2.0) // gain = 2.0
    const view = new DataView(wav.buffer)
    const sample = view.getInt16(44, true)
    expect(sample).toBe(2000) // 1000 * 2.0
  })

  test('clamps samples to 16-bit range', () => {
    const buf = Buffer.alloc(2)
    buf.writeInt16LE(20000, 0)
    const b64 = buf.toString('base64')

    const wav = pcmChunksToWav([b64], 24000, 10.0) // 20000 * 10 = 200000 > 32767
    const view = new DataView(wav.buffer)
    const sample = view.getInt16(44, true)
    expect(sample).toBe(32767) // clamped to max
  })

  test('clamps negative samples to -32768', () => {
    const buf = Buffer.alloc(2)
    buf.writeInt16LE(-20000, 0)
    const b64 = buf.toString('base64')

    const wav = pcmChunksToWav([b64], 24000, 10.0) // -20000 * 10 = -200000 < -32768
    const view = new DataView(wav.buffer)
    const sample = view.getInt16(44, true)
    expect(sample).toBe(-32768) // clamped to min
  })

  test('concatenates multiple chunks', () => {
    const buf1 = Buffer.alloc(4)
    buf1.writeInt16LE(100, 0)
    buf1.writeInt16LE(200, 2)

    const buf2 = Buffer.alloc(4)
    buf2.writeInt16LE(300, 0)
    buf2.writeInt16LE(400, 2)

    const wav = pcmChunksToWav(
      [buf1.toString('base64'), buf2.toString('base64')],
      24000,
      1.0,
    )
    expect(wav.length).toBe(44 + 8) // 4 samples * 2 bytes
    const view = new DataView(wav.buffer)
    expect(view.getInt16(44, true)).toBe(100)
    expect(view.getInt16(46, true)).toBe(200)
    expect(view.getInt16(48, true)).toBe(300)
    expect(view.getInt16(50, true)).toBe(400)
  })
})

// ---------- uint8ToBase64 ----------

describe('uint8ToBase64', () => {
  test('encodes empty array', () => {
    expect(uint8ToBase64(new Uint8Array(0))).toBe('')
  })

  test('roundtrip: encode then decode', () => {
    const original = new Uint8Array([72, 101, 108, 108, 111]) // "Hello"
    const b64 = uint8ToBase64(original)
    const decoded = Buffer.from(b64, 'base64')
    expect(Array.from(decoded)).toEqual(Array.from(original))
  })

  test('handles binary data with high bytes', () => {
    const data = new Uint8Array([0, 128, 255, 1, 254])
    const b64 = uint8ToBase64(data)
    const decoded = Buffer.from(b64, 'base64')
    expect(Array.from(decoded)).toEqual(Array.from(data))
  })
})
