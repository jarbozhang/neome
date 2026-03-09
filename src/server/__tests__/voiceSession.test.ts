import {
  encodeFrame,
  encodeJsonFrame,
  encodeAudioFrame,
  decodeFrame,
  generateVisemes,
  buildStartSessionPayload,
} from '../voiceSession'

// ---------- encodeFrame / decodeFrame 往返测试 ----------

describe('Binary Protocol: encodeFrame & decodeFrame', () => {
  test('roundtrip: JSON payload without sessionId (server event 51/52)', () => {
    // decodeFrame skips sessionId for events 51, 52 (SERVER_EVENTS_NO_SESSION_ID)
    // so roundtrip only works for these events when no sessionId is included
    const payload = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf-8')
    const frame = encodeFrame(0x9, 0x1, 51, payload)

    const decoded = decodeFrame(frame)
    expect(decoded).not.toBeNull()
    expect(decoded!.msgType).toBe(0x9)
    expect(decoded!.serialization).toBe(0x1)
    expect(decoded!.compression).toBe(0x0)
    expect(decoded!.eventNum).toBe(51)
    expect(decoded!.sessionId).toBeNull()
    expect(decoded!.payload.toString('utf-8')).toBe(JSON.stringify({ hello: 'world' }))
  })

  test('encode client frame without sessionId (event 1) produces correct header', () => {
    // Client-side frames with event 1 (StartConnection) don't include sessionId
    // decodeFrame expects sessionId for non-51/52 events, so this is NOT a roundtrip test
    const payload = Buffer.from('{}', 'utf-8')
    const frame = encodeFrame(0x1, 0x1, 1, payload)

    // Verify header structure manually
    expect(frame[0]).toBe(0x11) // version=1, headerSize=1
    expect((frame[1] >> 4) & 0xF).toBe(0x1) // msgType
    expect(frame[1] & 0xF).toBe(0b0100) // FLAG_WITH_EVENT
    expect((frame[2] >> 4) & 0xF).toBe(0x1) // JSON serialization

    // event number at offset 4
    expect(frame.readInt32BE(4)).toBe(1)

    // payload length at offset 8
    expect(frame.readUInt32BE(8)).toBe(2) // "{}"
  })

  test('roundtrip: JSON payload with sessionId', () => {
    const payload = Buffer.from('{}', 'utf-8')
    const sessionId = 'test-session-123'
    const frame = encodeFrame(0x1, 0x1, 100, payload, sessionId, true)

    const decoded = decodeFrame(frame)
    expect(decoded).not.toBeNull()
    expect(decoded!.eventNum).toBe(100)
    expect(decoded!.sessionId).toBe(sessionId)
    expect(decoded!.payload.toString('utf-8')).toBe('{}')
  })

  test('roundtrip: raw audio payload with sessionId', () => {
    const pcm = Buffer.alloc(1440) // 模拟一帧 PCM
    for (let i = 0; i < pcm.length; i += 2) {
      pcm.writeInt16LE(Math.floor(Math.random() * 65536 - 32768), i)
    }
    const sessionId = 'audio-session'
    const frame = encodeAudioFrame(pcm, sessionId)

    const decoded = decodeFrame(frame)
    expect(decoded).not.toBeNull()
    expect(decoded!.msgType).toBe(0x2) // MSG_TYPE_AUDIO_ONLY_CLIENT
    expect(decoded!.serialization).toBe(0x0) // SERIAL_RAW
    expect(decoded!.eventNum).toBe(200) // EVENT_USER_QUERY
    expect(decoded!.sessionId).toBe(sessionId)
    expect(decoded!.payload.length).toBe(1440)
    expect(decoded!.payload).toEqual(pcm)
  })

  test('header byte 0 is always 0x11', () => {
    const frame = encodeFrame(0x1, 0x1, 1, Buffer.from('{}'))
    expect(frame[0]).toBe(0x11)
  })

  test('byte 1 encodes msgType in high nibble and flags in low nibble', () => {
    const frame = encodeFrame(0x9, 0x1, 50, Buffer.from(''))
    const byte1 = frame[1]
    expect((byte1 >> 4) & 0xF).toBe(0x9)
    expect(byte1 & 0xF).toBe(0b0100) // FLAG_WITH_EVENT
  })

  test('byte 2 encodes serialization in high nibble', () => {
    const frameJson = encodeFrame(0x1, 0x1, 1, Buffer.from(''))
    expect((frameJson[2] >> 4) & 0xF).toBe(0x1)

    const frameRaw = encodeFrame(0x2, 0x0, 200, Buffer.from(''))
    expect((frameRaw[2] >> 4) & 0xF).toBe(0x0)
  })

  test('decodeFrame returns null for data shorter than 4 bytes', () => {
    expect(decodeFrame(Buffer.alloc(0))).toBeNull()
    expect(decodeFrame(Buffer.alloc(3))).toBeNull()
  })

  test('decodeFrame handles error frame (msgType=0xF)', () => {
    // Manually construct an error frame
    const header = Buffer.alloc(4)
    header[0] = 0x11
    header[1] = 0xF0 // msgType=0xF, flags=0
    header[2] = 0x10 // serialization=JSON
    header[3] = 0x00

    const errorCode = Buffer.alloc(4)
    errorCode.writeUInt32BE(1001, 0)

    const errMsg = Buffer.from('session timeout', 'utf-8')
    const payloadLen = Buffer.alloc(4)
    payloadLen.writeUInt32BE(errMsg.length, 0)

    const frame = Buffer.concat([header, errorCode, payloadLen, errMsg])
    const decoded = decodeFrame(frame)

    expect(decoded).not.toBeNull()
    expect(decoded!.msgType).toBe(0xF)
    expect(decoded!.payload.toString('utf-8')).toBe('session timeout')
  })

  test('decodeFrame skips sessionId for events 51 and 52', () => {
    // Construct a frame with event 51 (ConnectionFailed) - should NOT have sessionId
    const payload = Buffer.from('{"error":"failed"}', 'utf-8')
    const header = Buffer.alloc(4)
    header[0] = 0x11
    header[1] = ((0x9) << 4) | 0b0100 // FullServer + WITH_EVENT
    header[2] = (0x1 << 4) | 0x0       // JSON, no compression
    header[3] = 0x00

    const eventBuf = Buffer.alloc(4)
    eventBuf.writeInt32BE(51, 0)

    const payloadLen = Buffer.alloc(4)
    payloadLen.writeUInt32BE(payload.length, 0)

    const frame = Buffer.concat([header, eventBuf, payloadLen, payload])
    const decoded = decodeFrame(frame)

    expect(decoded).not.toBeNull()
    expect(decoded!.eventNum).toBe(51)
    expect(decoded!.sessionId).toBeNull()
    expect(JSON.parse(decoded!.payload.toString('utf-8'))).toEqual({ error: 'failed' })
  })
})

// ---------- encodeJsonFrame ----------

describe('encodeJsonFrame', () => {
  test('encodes JSON object correctly (with sessionId for roundtrip)', () => {
    const obj = { asr: { format: 'pcm' }, tts: { speaker: 'zh_female' } }
    const frame = encodeJsonFrame(0x1, 100, obj, 'sess-id', true)

    const decoded = decodeFrame(frame)
    expect(decoded).not.toBeNull()
    expect(decoded!.sessionId).toBe('sess-id')
    const parsed = JSON.parse(decoded!.payload.toString('utf-8'))
    expect(parsed).toEqual(obj)
  })

  test('encodes with sessionId when includeSessionId=true', () => {
    const frame = encodeJsonFrame(0x1, 100, {}, 'my-session', true)
    const decoded = decodeFrame(frame)
    expect(decoded).not.toBeNull()
    expect(decoded!.sessionId).toBe('my-session')
  })

  test('omits sessionId when includeSessionId=false', () => {
    // encodeJsonFrame is a client-side encoder; verify frame structure
    const frame = encodeJsonFrame(0x1, 1, { key: 'val' })
    // header(4) + event(4) + payloadLen(4) + payload
    const expectedPayload = Buffer.from(JSON.stringify({ key: 'val' }), 'utf-8')
    expect(frame.length).toBe(4 + 4 + 4 + expectedPayload.length)
    // No sessionId bytes between event and payload
    expect(frame.readUInt32BE(8)).toBe(expectedPayload.length)
  })
})

// ---------- generateVisemes ----------

describe('generateVisemes', () => {
  test('returns empty array for empty buffer', () => {
    const result = generateVisemes(Buffer.alloc(0))
    expect(result).toEqual([])
  })

  test('returns silence viseme for zero-amplitude audio', () => {
    // 720 samples * 2 bytes = 1440 bytes = one frame
    const silent = Buffer.alloc(1440, 0)
    const result = generateVisemes(silent)
    expect(result.length).toBe(1)
    expect(result[0].viseme).toBe('sil')
    expect(result[0].weight).toBe(0)
    expect(result[0].time).toBe(0)
  })

  test('returns non-silent viseme for loud audio', () => {
    // Fill with high-amplitude samples
    const loud = Buffer.alloc(1440)
    for (let i = 0; i < 720; i++) {
      loud.writeInt16LE(10000, i * 2) // RMS will be 10000, well above threshold
    }
    const result = generateVisemes(loud)
    expect(result.length).toBe(1)
    expect(result[0].viseme).not.toBe('sil')
    expect(result[0].weight).toBeGreaterThan(0.3)
    expect(result[0].weight).toBeLessThanOrEqual(1.0)
  })

  test('generates multiple frames for multi-frame buffer', () => {
    // 3 frames = 3 * 1440 = 4320 bytes
    const buf = Buffer.alloc(4320, 0)
    const result = generateVisemes(buf)
    expect(result.length).toBe(3)
    expect(result[0].time).toBe(0)
    expect(result[1].time).toBe(30)
    expect(result[2].time).toBe(60)
  })

  test('weight is clamped between 0.3 and 1.0 for non-silent frames', () => {
    // Medium amplitude
    const buf = Buffer.alloc(1440)
    for (let i = 0; i < 720; i++) {
      buf.writeInt16LE(1000, i * 2)
    }
    const result = generateVisemes(buf)
    if (result.length > 0 && result[0].viseme !== 'sil') {
      expect(result[0].weight).toBeGreaterThanOrEqual(0.3)
      expect(result[0].weight).toBeLessThanOrEqual(1.0)
    }
  })

  test('handles partial last frame', () => {
    // 1440 + 500 bytes = 1 full frame + partial frame
    const buf = Buffer.alloc(1940, 0)
    for (let i = 0; i < buf.length - 1; i += 2) {
      buf.writeInt16LE(5000, i)
    }
    const result = generateVisemes(buf)
    expect(result.length).toBe(2) // 1 full frame + 1 partial frame
  })

  test('viseme names come from vowel set', () => {
    const vowels = ['aa', 'ih', 'ou', 'ee', 'oh']
    const buf = Buffer.alloc(1440)
    for (let i = 0; i < 720; i++) {
      buf.writeInt16LE(8000, i * 2)
    }
    const result = generateVisemes(buf)
    for (const v of result) {
      if (v.viseme !== 'sil') {
        expect(vowels).toContain(v.viseme)
      }
    }
  })
})

// ---------- buildStartSessionPayload ----------

describe('buildStartSessionPayload', () => {
  test('returns correct structure without dialogId', () => {
    const payload = buildStartSessionPayload()
    expect(payload).toHaveProperty('asr')
    expect(payload).toHaveProperty('tts')
    expect(payload).toHaveProperty('dialog')

    const tts = payload.tts as Record<string, unknown>
    expect(tts.speaker).toBe('zh_female_vv_jupiter_bigtts')

    const audioConfig = tts.audio_config as Record<string, unknown>
    expect(audioConfig.format).toBe('pcm_s16le')
    expect(audioConfig.sample_rate).toBe(24000)
    expect(audioConfig.channel).toBe(1)

    const dialog = payload.dialog as Record<string, unknown>
    expect(dialog.bot_name).toBe('小Neo')
    expect(dialog).not.toHaveProperty('dialog_id')
  })

  test('includes dialog_id when provided', () => {
    const payload = buildStartSessionPayload('dialog-abc-123')
    const dialog = payload.dialog as Record<string, unknown>
    expect(dialog.dialog_id).toBe('dialog-abc-123')
  })

  test('omits dialog_id when null', () => {
    const payload = buildStartSessionPayload(null)
    const dialog = payload.dialog as Record<string, unknown>
    expect(dialog).not.toHaveProperty('dialog_id')
  })

  test('ASR config has expected fields', () => {
    const payload = buildStartSessionPayload()
    const asr = payload.asr as Record<string, unknown>
    const extra = asr.extra as Record<string, unknown>
    expect(extra.end_smooth_window_ms).toBe(1500)
    expect(extra.enable_custom_vad).toBe(false)
  })
})
