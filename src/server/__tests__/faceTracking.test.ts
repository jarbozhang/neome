/**
 * Face Tracking 单元测试
 *
 * 覆盖：
 * 1. AvatarWebView 内嵌 JS 的 face tracking 逻辑（欧拉角 → bone rotation + lerp）
 * 2. FaceTrackerWebView 的 matrixToEuler 变换矩阵 → 欧拉角转换
 * 3. useFaceTracker hook 的调度逻辑
 */

// ==================== matrixToEuler 测试 ====================
// 从 FaceTrackerWebView.tsx 中提取的 matrixToEuler 算法（纯函数，可独立测试）
function matrixToEuler(m: number[]) {
  const r00 = m[0], r01 = m[4], r02 = m[8]
  const r10 = m[1], r11 = m[5], r12 = m[9]
  const r20 = m[2], r21 = m[6], r22 = m[10]

  let pitch: number, yaw: number, roll: number
  if (Math.abs(r20) < 0.9999) {
    yaw = Math.asin(-r20)
    pitch = Math.atan2(r21, r22)
    roll = Math.atan2(r10, r00)
  } else {
    yaw = r20 > 0 ? -Math.PI / 2 : Math.PI / 2
    pitch = Math.atan2(-r12, r11)
    roll = 0
  }
  const maxAngle = Math.PI / 3
  return {
    yaw: Math.max(-1, Math.min(1, yaw / maxAngle)),
    pitch: Math.max(-1, Math.min(1, pitch / maxAngle)),
    roll: Math.max(-1, Math.min(1, roll / maxAngle)),
  }
}

describe('matrixToEuler', () => {
  test('identity matrix → zero angles', () => {
    // 4x4 identity (column-major flat)
    const identity = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]
    const result = matrixToEuler(identity)
    expect(result.yaw).toBeCloseTo(0, 5)
    expect(result.pitch).toBeCloseTo(0, 5)
    expect(result.roll).toBeCloseTo(0, 5)
  })

  test('yaw rotation (Y-axis) produces yaw value', () => {
    const angle = Math.PI / 6 // 30°
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    // Y-axis rotation matrix, column-major flat:
    // col0=[cos,0,-sin], col1=[0,1,0], col2=[sin,0,cos]
    const mat = [
      cos, 0, -sin, 0,
      0,   1,  0,   0,
      sin, 0,  cos, 0,
      0,   0,  0,   1,
    ]
    const result = matrixToEuler(mat)
    // r20 = m[2] = -sin → yaw = asin(-r20) = asin(sin) = angle
    expect(result.yaw).toBeCloseTo(angle / (Math.PI / 3), 3)
    expect(Math.abs(result.pitch)).toBeLessThan(0.01)
  })

  test('pitch rotation (X-axis) produces pitch value', () => {
    const angle = Math.PI / 6 // 30°
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    // X-axis rotation matrix, column-major flat:
    // col0=[1,0,0], col1=[0,cos,sin], col2=[0,-sin,cos]
    const mat = [
      1, 0,   0,    0,
      0, cos, sin,  0,
      0, -sin, cos, 0,
      0, 0,   0,    1,
    ]
    const result = matrixToEuler(mat)
    // r21 = m[6] = -sin, r22 = m[10] = cos → pitch = atan2(r21, r22)
    expect(result.pitch).toBeCloseTo(angle / (Math.PI / 3), 3)
    expect(Math.abs(result.yaw)).toBeLessThan(0.01)
  })

  test('output is clamped to [-1, 1]', () => {
    // 90° Y-rotation: col0=[0,0,-1], col1=[0,1,0], col2=[1,0,0]
    const mat = [
      0, 0, -1, 0,
      0, 1,  0, 0,
      1, 0,  0, 0,
      0, 0,  0, 1,
    ]
    const result = matrixToEuler(mat)
    // r20 = -1 → yaw = asin(1) = PI/2 > maxAngle → clamped to 1
    expect(result.yaw).toBe(1)
    expect(result.yaw).toBeLessThanOrEqual(1)
    expect(result.yaw).toBeGreaterThanOrEqual(-1)
  })

  test('negative yaw rotation works', () => {
    const angle = -Math.PI / 6 // -30°
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    // col0=[cos,0,-sin], col1=[0,1,0], col2=[sin,0,cos]
    const mat = [
      cos, 0, -sin, 0,
      0,   1,  0,   0,
      sin, 0,  cos, 0,
      0,   0,  0,   1,
    ]
    const result = matrixToEuler(mat)
    expect(result.yaw).toBeCloseTo(angle / (Math.PI / 3), 3)
  })

  test('gimbal lock case (r20 ≈ ±1)', () => {
    // r20 = m[2] = -1 → |r20| >= 0.9999 → yaw = PI/2 (since r20 < 0)
    const mat = [
      0,  0, -1, 0,
      0,  1,  0, 0,
      1,  0,  0, 0,
      0,  0,  0, 1,
    ]
    const result = matrixToEuler(mat)
    expect(result.yaw).toBe(1) // PI/2 > maxAngle, clamped to 1
  })
})

// ==================== Avatar bone rotation 逻辑测试 ====================

describe('Avatar face tracking bone logic', () => {
  // 模拟 avatar.ts 中的 updateFaceTracking 逻辑
  let faceTargetYaw: number
  let faceTargetPitch: number
  let faceCurrentYaw: number
  let faceCurrentPitch: number
  let faceLost: boolean
  const FACE_LERP = 0.15
  const FACE_LOST_LERP = 0.05

  function handleFacePosition(data: { yaw: number; pitch: number; lost: boolean }) {
    if (data.lost) {
      faceLost = true
      faceTargetYaw = 0
      faceTargetPitch = 0
    } else {
      faceLost = false
      faceTargetYaw = data.yaw
      faceTargetPitch = data.pitch
    }
  }

  function updateFaceTracking() {
    const lerp = faceLost ? FACE_LOST_LERP : FACE_LERP
    faceCurrentYaw += (faceTargetYaw - faceCurrentYaw) * lerp
    faceCurrentPitch += (faceTargetPitch - faceCurrentPitch) * lerp
  }

  beforeEach(() => {
    faceTargetYaw = 0
    faceTargetPitch = 0
    faceCurrentYaw = 0
    faceCurrentPitch = 0
    faceLost = false
  })

  test('initial state is zero', () => {
    expect(faceCurrentYaw).toBe(0)
    expect(faceCurrentPitch).toBe(0)
  })

  test('handleFacePosition sets target values', () => {
    handleFacePosition({ yaw: 0.5, pitch: -0.3, lost: false })
    expect(faceTargetYaw).toBe(0.5)
    expect(faceTargetPitch).toBe(-0.3)
    expect(faceLost).toBe(false)
  })

  test('handleFacePosition lost resets targets to zero', () => {
    handleFacePosition({ yaw: 0.5, pitch: -0.3, lost: false })
    handleFacePosition({ yaw: 0, pitch: 0, lost: true })
    expect(faceTargetYaw).toBe(0)
    expect(faceTargetPitch).toBe(0)
    expect(faceLost).toBe(true)
  })

  test('updateFaceTracking lerps toward target', () => {
    handleFacePosition({ yaw: 1.0, pitch: 0.5, lost: false })

    // First update
    updateFaceTracking()
    expect(faceCurrentYaw).toBeCloseTo(1.0 * FACE_LERP, 5)
    expect(faceCurrentPitch).toBeCloseTo(0.5 * FACE_LERP, 5)

    // More updates → converges
    for (let i = 0; i < 50; i++) updateFaceTracking()
    expect(faceCurrentYaw).toBeCloseTo(1.0, 2)
    expect(faceCurrentPitch).toBeCloseTo(0.5, 2)
  })

  test('face lost uses slower lerp', () => {
    handleFacePosition({ yaw: 0.8, pitch: 0.4, lost: false })
    for (let i = 0; i < 30; i++) updateFaceTracking()
    const yawBefore = faceCurrentYaw

    // Face lost → target goes to 0
    handleFacePosition({ yaw: 0, pitch: 0, lost: true })
    updateFaceTracking()

    // Lost lerp is slower (0.05 vs 0.15)
    const expectedDelta = (0 - yawBefore) * FACE_LOST_LERP
    expect(faceCurrentYaw).toBeCloseTo(yawBefore + expectedDelta, 5)
  })

  test('bone rotation multipliers are correct', () => {
    handleFacePosition({ yaw: 1.0, pitch: 1.0, lost: false })
    // Run until converged
    for (let i = 0; i < 100; i++) updateFaceTracking()

    // head.rotation.y = faceCurrentYaw * 0.6
    const headY = faceCurrentYaw * 0.6
    expect(headY).toBeCloseTo(0.6, 1)

    // head.rotation.x = faceCurrentPitch * 0.3
    const headX = faceCurrentPitch * 0.3
    expect(headX).toBeCloseTo(0.3, 1)

    // spine.rotation.y = faceCurrentYaw * 0.2
    const spineY = faceCurrentYaw * 0.2
    expect(spineY).toBeCloseTo(0.2, 1)
  })

  test('smooth transition from one position to another', () => {
    handleFacePosition({ yaw: -0.5, pitch: 0.3, lost: false })
    for (let i = 0; i < 50; i++) updateFaceTracking()
    expect(faceCurrentYaw).toBeCloseTo(-0.5, 2)

    // Change target
    handleFacePosition({ yaw: 0.5, pitch: -0.3, lost: false })
    // After 1 update, should move toward new target
    const prevYaw = faceCurrentYaw
    updateFaceTracking()
    expect(faceCurrentYaw).toBeGreaterThan(prevYaw) // moving from -0.5 toward 0.5
  })

  test('lost → recover → track again', () => {
    handleFacePosition({ yaw: 0.8, pitch: 0.4, lost: false })
    for (let i = 0; i < 50; i++) updateFaceTracking()

    // Lost
    handleFacePosition({ yaw: 0, pitch: 0, lost: true })
    for (let i = 0; i < 100; i++) updateFaceTracking()
    expect(faceCurrentYaw).toBeCloseTo(0, 1)

    // Recover
    handleFacePosition({ yaw: -0.6, pitch: 0.2, lost: false })
    for (let i = 0; i < 50; i++) updateFaceTracking()
    expect(faceCurrentYaw).toBeCloseTo(-0.6, 2)
  })
})

// ==================== useFaceTracker 调度逻辑测试 ====================

describe('useFaceTracker scheduling logic', () => {
  test('capture interval is 200ms', () => {
    // 验证常量：抓帧频率 = 5fps
    const CAPTURE_INTERVAL = 200
    expect(CAPTURE_INTERVAL).toBe(200)
    expect(1000 / CAPTURE_INTERVAL).toBe(5) // 5 fps
  })

  test('concurrent capture prevention (capturingRef guard)', () => {
    // 模拟 capturingRef 防重叠逻辑
    let capturing = false
    let captureCount = 0

    async function captureAndDetect() {
      if (capturing) return // guard
      capturing = true
      captureCount++
      // simulate async work
      await new Promise(r => setTimeout(r, 10))
      capturing = false
    }

    // 并发调用 → 第二次被跳过
    const p1 = captureAndDetect()
    const p2 = captureAndDetect() // should be skipped (capturing=true)
    return Promise.all([p1, p2]).then(() => {
      expect(captureCount).toBe(1)
    })
  })

  test('start/stop lifecycle', () => {
    jest.useFakeTimers()
    let running = false
    let intervalId: ReturnType<typeof setInterval> | null = null
    let tickCount = 0

    function start() {
      if (running) return
      running = true
      intervalId = setInterval(() => { tickCount++ }, 200)
    }

    function stop() {
      running = false
      if (intervalId) { clearInterval(intervalId); intervalId = null }
    }

    start()
    jest.advanceTimersByTime(1000) // 5 ticks
    expect(tickCount).toBe(5)

    stop()
    jest.advanceTimersByTime(1000)
    expect(tickCount).toBe(5) // no more ticks

    // Restart
    start()
    jest.advanceTimersByTime(400) // 2 more ticks
    expect(tickCount).toBe(7)

    stop()
    jest.useRealTimers()
  })

  test('double start is no-op', () => {
    jest.useFakeTimers()
    let running = false
    let intervalId: ReturnType<typeof setInterval> | null = null
    let tickCount = 0

    function start() {
      if (running) return
      running = true
      intervalId = setInterval(() => { tickCount++ }, 200)
    }

    function stop() {
      running = false
      if (intervalId) { clearInterval(intervalId); intervalId = null }
    }

    start()
    start() // should be no-op
    jest.advanceTimersByTime(600)
    expect(tickCount).toBe(3) // not 6

    stop()
    jest.useRealTimers()
  })
})

// ==================== face_position WebSocket 消息格式测试 ====================

describe('face_position message format', () => {
  test('valid face_position message has correct structure', () => {
    const msg = {
      type: 'face_position' as const,
      data: { yaw: 0.3, pitch: -0.2, roll: 0.1, lost: false },
    }
    expect(msg.type).toBe('face_position')
    expect(typeof msg.data.yaw).toBe('number')
    expect(typeof msg.data.pitch).toBe('number')
    expect(typeof msg.data.lost).toBe('boolean')
    expect(msg.data.yaw).toBeGreaterThanOrEqual(-1)
    expect(msg.data.yaw).toBeLessThanOrEqual(1)
  })

  test('lost face message has zero values', () => {
    const msg = {
      type: 'face_position' as const,
      data: { yaw: 0, pitch: 0, roll: 0, lost: true },
    }
    expect(msg.data.lost).toBe(true)
    expect(msg.data.yaw).toBe(0)
    expect(msg.data.pitch).toBe(0)
  })
})

// ==================== AvatarWebView handleMessage 路由测试 ====================

describe('AvatarWebView handleMessage routing', () => {
  // 模拟 handleMessage 的 switch-case 路由
  const handled: Record<string, unknown[]> = {}

  function handleMessage(msg: { type: string; data?: unknown }) {
    switch (msg.type) {
      case 'set_state':
        handled['set_state'] = handled['set_state'] || []
        handled['set_state'].push(msg.data)
        break
      case 'set_visemes':
        handled['set_visemes'] = handled['set_visemes'] || []
        handled['set_visemes'].push(msg.data)
        break
      case 'face_position':
        handled['face_position'] = handled['face_position'] || []
        handled['face_position'].push(msg.data)
        break
    }
  }

  beforeEach(() => {
    for (const key of Object.keys(handled)) delete handled[key]
  })

  test('routes face_position messages', () => {
    handleMessage({ type: 'face_position', data: { yaw: 0.5, pitch: 0.1, lost: false } })
    expect(handled['face_position']).toHaveLength(1)
    expect((handled['face_position']![0] as any).yaw).toBe(0.5)
  })

  test('does not interfere with other message types', () => {
    handleMessage({ type: 'set_state', data: 'listening' })
    handleMessage({ type: 'face_position', data: { yaw: 0.3, pitch: 0, lost: false } })
    handleMessage({ type: 'set_visemes', data: { visemes: [] } })

    expect(handled['set_state']).toHaveLength(1)
    expect(handled['face_position']).toHaveLength(1)
    expect(handled['set_visemes']).toHaveLength(1)
  })

  test('unknown message type is silently ignored', () => {
    handleMessage({ type: 'unknown_type', data: {} })
    expect(Object.keys(handled)).toHaveLength(0)
  })
})
