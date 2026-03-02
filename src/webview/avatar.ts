/**
 * avatar.ts — 3D 渲染、口型驱动、表情控制
 *
 * 此文件作为 TypeScript 源码参考存在。
 * 由于 WebView 无法直接加载 TS，实际运行逻辑内联在 AvatarWebView.tsx 的 getWebViewHTML() 中。
 * 后续构建流程集成后，此文件会被编译后注入 index.html。
 *
 * 注意：three 和 @pixiv/three-vrm 通过 CDN 在 WebView 中加载，
 * 本文件仅供源码参考，未加入 Expo 编译流程。
 */
// @ts-nocheck — three 和 @pixiv/three-vrm 类型依赖尚未安装，此文件仅供源码参考

declare const THREE: any
declare const GLTFLoader: any
declare const VRMLoaderPlugin: any
type VRM = any

// MODEL_URL 由宿主注入（在 AvatarWebView.tsx 的模板字符串中）
declare const MODEL_URL: string

let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let renderer: THREE.WebGLRenderer
let currentVRM: VRM | null = null
let vrmScene: THREE.Group | null = null
const clock = new THREE.Clock()

// 状态机
let currentState: string = 'idle'
let breathingEnabled: boolean = true
let blinkTimer: ReturnType<typeof setTimeout> | null = null
let placeholderBody: THREE.Mesh | null = null
let placeholderHead: THREE.Mesh | null = null

interface RNMessage {
  type: string
  data?: unknown
}

function init(): void {
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0xf0f0f0)

  camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 20)
  camera.position.set(0, 1.3, 1.5)
  camera.lookAt(0, 1.2, 0)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  document.body.appendChild(renderer.domElement)

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
  scene.add(ambientLight)
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8)
  dirLight.position.set(1, 2, 1)
  scene.add(dirLight)

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  })

  // 监听来自 RN 的消息（iOS）
  window.addEventListener('message', (event: MessageEvent) => {
    try {
      const msg: RNMessage =
        typeof event.data === 'string' ? JSON.parse(event.data) : event.data
      handleMessage(msg)
    } catch (e) {
      console.error('Failed to parse message:', e)
    }
  })
  // 监听来自 RN 的消息（Android）
  document.addEventListener('message', (event: Event) => {
    try {
      const msgEvent = event as MessageEvent
      const msg: RNMessage =
        typeof msgEvent.data === 'string' ? JSON.parse(msgEvent.data) : msgEvent.data
      handleMessage(msg)
    } catch (e) {
      console.error('Failed to parse message:', e)
    }
  })

  loadVRM()
  animate()
}

function handleMessage(msg: RNMessage): void {
  console.log('WebView received:', msg.type, msg)
  switch (msg.type) {
    case 'set_state':
      setState(msg.data as string)
      break
    case 'set_visemes':
      // Phase 2 实现
      break
    case 'set_expression':
      // Phase 2 实现
      break
  }
}

function setState(state: string): void {
  if (currentState === state) return
  currentState = state
  console.log('Avatar state:', state)

  stopBlinking()

  switch (state) {
    case 'idle':
      breathingEnabled = true
      startBlinking()
      resetExpression()
      break
    case 'listening':
      breathingEnabled = true
      startBlinking()
      setListeningExpression()
      break
    case 'thinking':
      breathingEnabled = true
      setThinkingExpression()
      break
    case 'speaking':
      breathingEnabled = true
      startBlinking()
      resetExpression()
      // 口型驱动在 Phase 2 实现
      break
  }
}

async function loadVRM(): Promise<void> {
  const loader = new GLTFLoader()
  loader.register((parser: any) => new VRMLoaderPlugin(parser))

  try {
    sendToRN({ type: 'loading', data: { status: 'loading' } })
    const gltf = await loader.loadAsync(MODEL_URL)
    currentVRM = gltf.userData.vrm
    vrmScene = gltf.scene

    // VRM 模型默认朝 +Z，旋转 180° 面向相机
    vrmScene!.rotation.y = Math.PI
    scene.add(vrmScene!)

    // 移除占位体（如果有的话）
    removePlaceholder()

    sendToRN({ type: 'ready', data: { vrm: true } })
    startBlinking()
  } catch (err) {
    const error = err as Error
    console.error('Failed to load VRM:', error)
    // 加载失败，使用占位体
    createPlaceholderAvatar()
    sendToRN({ type: 'ready', data: { placeholder: true, error: error.message } })
  }
}

function removePlaceholder(): void {
  if (placeholderBody) {
    scene.remove(placeholderBody)
    placeholderBody.geometry.dispose()
    placeholderBody.material.dispose()
    placeholderBody = null
  }
  if (placeholderHead) {
    scene.remove(placeholderHead)
    placeholderHead.geometry.dispose()
    placeholderHead.material.dispose()
    placeholderHead = null
  }
}

function createPlaceholderAvatar(): void {
  const bodyGeometry = new THREE.CapsuleGeometry(0.15, 0.5, 4, 16)
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x6699cc })
  const body = new THREE.Mesh(bodyGeometry, bodyMaterial)
  body.position.set(0, 1.0, 0)
  scene.add(body)
  placeholderBody = body

  const headGeometry = new THREE.SphereGeometry(0.12, 16, 16)
  const headMaterial = new THREE.MeshStandardMaterial({ color: 0xffcc99 })
  const head = new THREE.Mesh(headGeometry, headMaterial)
  head.position.set(0, 1.5, 0)
  scene.add(head)
  placeholderHead = head

  startBlinking()
}

function sendToRN(msg: RNMessage): void {
  const rnWebView = (window as unknown as { ReactNativeWebView?: { postMessage: (s: string) => void } }).ReactNativeWebView
  if (rnWebView) {
    rnWebView.postMessage(JSON.stringify(msg))
  }
}

function animate(): void {
  requestAnimationFrame(animate)
  const delta = clock.getDelta()
  const elapsed = clock.getElapsedTime()

  if (currentVRM) {
    currentVRM.update(delta)

    // VRM 呼吸动画：微调 spine bone
    if (breathingEnabled) {
      const spine = currentVRM.humanoid.getNormalizedBoneNode('spine')
      if (spine) {
        spine.rotation.x = Math.sin(elapsed * 1.8) * 0.01
      }
    }
  }

  // 占位体呼吸（fallback）
  if (breathingEnabled && placeholderBody && placeholderHead && !currentVRM) {
    const breathOffset = Math.sin(elapsed * 1.8) * 0.002
    placeholderBody.position.y = 1.0 + breathOffset
    placeholderHead.position.y = 1.5 + breathOffset
  }

  renderer.render(scene, camera)
}

// 眨眼
function startBlinking(): void {
  stopBlinking()
  scheduleBlink()
}

function stopBlinking(): void {
  if (blinkTimer) {
    clearTimeout(blinkTimer)
    blinkTimer = null
  }
}

function scheduleBlink(): void {
  const interval = 2000 + Math.random() * 4000
  blinkTimer = setTimeout(() => {
    doBlink()
    scheduleBlink()
  }, interval)
}

function doBlink(): void {
  if (!currentVRM) {
    // fallback 到占位体眨眼
    if (placeholderHead) {
      placeholderHead.scale.y = 0.7
      setTimeout(() => { if (placeholderHead) placeholderHead.scale.y = 1 }, 150)
    }
    return
  }
  // VRM blink expression
  currentVRM.expressionManager.setValue('blink', 1.0)
  setTimeout(() => {
    if (currentVRM) currentVRM.expressionManager.setValue('blink', 0.0)
  }, 150)
}

// 表情控制
function resetExpression(): void {
  if (currentVRM) {
    currentVRM.expressionManager.setValue('happy', 0)
    currentVRM.expressionManager.setValue('angry', 0)
    currentVRM.expressionManager.setValue('sad', 0)
    currentVRM.expressionManager.setValue('surprised', 0)
    // 重置头部旋转
    const head = currentVRM.humanoid.getNormalizedBoneNode('head')
    if (head) { head.rotation.z = 0; head.rotation.x = 0 }
  }
  // 占位体 fallback
  if (placeholderHead) placeholderHead.material.color.setHex(0xffcc99)
  if (placeholderBody) placeholderBody.rotation.z = 0
}

function setListeningExpression(): void {
  if (currentVRM) {
    // 微微惊讶 = 关注
    currentVRM.expressionManager.setValue('surprised', 0.2)
  }
  if (placeholderHead) placeholderHead.material.color.setHex(0xffd9a8)
}

function setThinkingExpression(): void {
  if (currentVRM) {
    // 微微歪头
    const head = currentVRM.humanoid.getNormalizedBoneNode('head')
    if (head) { head.rotation.z = 0.08 }
  }
  if (placeholderHead) placeholderHead.material.color.setHex(0xeeccaa)
  if (placeholderBody) placeholderBody.rotation.z = 0.05
}

init()
