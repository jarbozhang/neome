# Phase 1：核心骨架（约 2 周）

> 目标：搭建 RN App + WebView Three.js 渲染 + 后端 WebSocket 通信，跑通一个"数字人站在屏幕上，前后端能通信"的最小闭环。

---

## Task 1.1：项目初始化

### 目标
创建 Expo (React Native) 项目，配置 monorepo 结构（App + Server），安装基础依赖。

### 具体步骤
1. 使用 `npx create-expo-app@latest NeoMe --template blank-typescript` 初始化
2. 在项目根目录下创建 `src/server/` 目录和独立的 `package.json`
3. 安装 App 侧依赖：
   - `react-native-webview`
   - `expo-camera`（后续 MediaPipe 用）
   - `expo-av`（音频采集/播放备选）
4. 安装 Server 侧依赖：
   - `fastify`
   - `ws`
   - `better-sqlite3`
   - `typescript` + `tsx`（开发运行）
5. 配置 `tsconfig.json`，确保 `src/shared/` 类型可以被 App 和 Server 共享
6. 创建 `src/shared/types.ts`，定义基础消息类型

### 验收标准
- [x] `npx expo start` 能启动 App，真机/模拟器可见默认页面
- [x] `npx tsx src/server/index.ts` 能启动 Fastify 服务，访问 `http://localhost:9527/health` 返回 `{status: "ok"}`
- [x] `src/shared/types.ts` 存在且同时被 App 和 Server 的 tsconfig 引用
- [x] 项目结构与 `docs/00-architecture.md` 中描述一致

### 产出文件
```
NeoMe/
├── package.json
├── app.json
├── tsconfig.json
├── src/
│   ├── app/
│   │   └── App.tsx
│   ├── server/
│   │   ├── package.json
│   │   └── index.ts          # Fastify health check 端点
│   └── shared/
│       └── types.ts           # WebSocketMessage 类型定义
```

### types.ts 初始定义
```typescript
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
}
```

---

## Task 1.2：WebView + Three.js + VRM 基础渲染

### 目标
在 RN App 中嵌入 WebView，加载 Three.js 场景，成功加载并显示一个 VRM 模型（静止站立）。

### 具体步骤
1. 创建 `src/webview/index.html`，引入 Three.js 和 @pixiv/three-vrm（通过 CDN 或内联打包）
2. 在 `src/webview/avatar.ts` 中实现：
   - 创建 Three.js 场景 (Scene + Camera + Renderer + Lights)
   - 使用 GLTFLoader + VRMLoaderPlugin 加载 VRM 模型文件
   - 设置合适的相机角度（半身特写，从腰部到头顶）
   - 添加基础光照（环境光 + 方向光）
   - 启动 requestAnimationFrame 渲染循环
3. 创建 `src/app/components/AvatarWebView.tsx`：
   - 使用 `react-native-webview` 加载 `index.html`
   - 设置 WebView 全屏，背景透明（如果可能）
   - 实现 `postMessage` / `onMessage` 双向通信接口
4. 在 `src/app/screens/MainScreen.tsx` 中放置 AvatarWebView 组件
5. 准备一个测试用 VRM 模型文件（从 VRoid Hub 下载免费示例模型），放入 `assets/models/`

### 关键实现细节

**WebView 内 Three.js 初始化（avatar.ts 核心逻辑）：**
```typescript
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
import { VRMLoaderPlugin, VRM } from '@pixiv/three-vrm'

let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let renderer: THREE.WebGLRenderer
let currentVRM: VRM | null = null

function init() {
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0xf0f0f0) // 浅灰背景

  camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 20)
  camera.position.set(0, 1.3, 1.5) // 半身特写视角
  camera.lookAt(0, 1.2, 0)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setPixelRatio(window.devicePixelRatio)
  document.body.appendChild(renderer.domElement)

  // 光照
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
  scene.add(ambientLight)
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8)
  dirLight.position.set(1, 2, 1)
  scene.add(dirLight)

  loadVRM('./models/default.vrm')
  animate()
}

async function loadVRM(url: string) {
  const loader = new GLTFLoader()
  loader.register((parser) => new VRMLoaderPlugin(parser))
  const gltf = await loader.loadAsync(url)
  currentVRM = gltf.userData.vrm as VRM
  scene.add(gltf.scene)
  // VRM 模型默认朝 +Z 方向，需要旋转 180 度面向相机
  gltf.scene.rotation.y = Math.PI
}

function animate() {
  requestAnimationFrame(animate)
  if (currentVRM) {
    currentVRM.update(clock.getDelta())
  }
  renderer.render(scene, camera)
}
```

**RN ↔ WebView 通信协议：**
```typescript
// RN → WebView（通过 webViewRef.postMessage）
interface RNToWebViewMessage {
  type: 'set_visemes' | 'set_face_position' | 'set_expression' | 'reset'
  data: unknown
}

// WebView → RN（通过 window.ReactNativeWebView.postMessage）
interface WebViewToRNMessage {
  type: 'ready' | 'error'
  data: unknown
}
```

### 验收标准
- [x] App 启动后，屏幕上显示一个 3D VRM 模型（静止站立状态）
- [x] 模型面朝镜头（面向用户），半身特写构图
- [x] WebView 发送 `{type: "ready"}` 消息，RN 层收到并打印日志
- [x] RN 层可以通过 postMessage 发送消息，WebView 收到并打印日志
- [x] 在 iOS 真机上正常渲染

> **实现备注（2026-03-03）：**
> - MToon 着色器在 iOS WebView 不可用，所有材质替换为 `MeshStandardMaterial`
> - VRM mesh 存在多材质数组（Body/Hair），需 `Array.isArray(child.material)` 分支处理
> - esm.sh importmap 必须加 `?external=three` 防止 three.js 重复实例
> - 服务端 `/vrm/:filename` 端点对嵌入 PNG 做 un-premultiply + alpha=255 处理
> - 面部/眼睛贴图仍受 iOS WebGL GPU 层 premultiply 影响（Phase 4 优化项）
> - LAN IP 通过 `.env` 的 `EXPO_PUBLIC_SERVER_HOST` 配置，无需改代码

### 产出文件
```
src/app/components/AvatarWebView.tsx
src/app/screens/MainScreen.tsx
src/webview/index.html
src/webview/avatar.ts
assets/models/default.vrm          # 测试用 VRM 模型
```

---

## Task 1.3：WebSocket 前后端通信框架

### 目标
建立 RN App 与 Fastify 后端之间的 WebSocket 双向通信，能够互相发送/接收 JSON 消息。

### 具体步骤
1. 在 `src/server/index.ts` 中集成 `@fastify/websocket` 插件
2. 创建 WebSocket 路由 `/ws`，处理连接/断连/消息
3. 在 `src/app/services/SessionManager.ts` 中实现：
   - WebSocket 连接管理（连接/重连/心跳）
   - 消息发送和接收（基于 `src/shared/types.ts` 中的类型）
   - 连接状态管理
4. 创建 `src/app/hooks/useSession.ts` React Hook，封装 SessionManager

### 关键实现细节

**服务端 WebSocket（server/index.ts）：**
```typescript
import Fastify from 'fastify'
import websocket from '@fastify/websocket'

const app = Fastify({ logger: true })
await app.register(websocket)

app.get('/ws', { websocket: true }, (socket, req) => {
  console.log('Client connected')

  socket.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    console.log('Received:', msg.type)
    // 根据 msg.type 分发处理
  })

  socket.on('close', () => {
    console.log('Client disconnected')
  })
})
```

**客户端 SessionManager：**
```typescript
// src/app/services/SessionManager.ts
import { WSMessage, SessionState } from '../../shared/types'

export class SessionManager {
  private ws: WebSocket | null = null
  private state: SessionState = 'idle'
  private listeners: Map<string, Function[]> = new Map()

  connect(url: string): void { /* WebSocket 连接 + 自动重连 */ }
  send(msg: WSMessage): void { /* 发送消息 */ }
  on(type: string, handler: Function): void { /* 注册消息处理器 */ }
  getState(): SessionState { return this.state }
  disconnect(): void { /* 断开连接 */ }
}
```

### 验收标准
- [x] App 启动后自动连接 `ws://SERVER_IP:9527/ws`
- [x] 服务端日志显示 "Client connected"
- [x] App 发送消息 → 服务端收到并打印
- [x] 服务端发送消息 → App 收到并打印
- [ ] App 断网后重连，服务端日志显示新连接
- [x] `useSession` hook 在组件中可用，能获取连接状态

### 产出文件
```
src/server/index.ts                 # 更新：添加 WebSocket 路由
src/app/services/SessionManager.ts
src/app/hooks/useSession.ts
```

---

## Task 1.4：基础状态机

### 目标
实现对话状态机 (idle → listening → thinking → speaking → idle)，前后端同步状态，数字人根据状态播放对应动画。

### 具体步骤
1. 在 `SessionManager.ts` 中实现状态机逻辑：
   - 定义状态转换规则
   - 状态变更时通知后端和 WebView
2. 在 WebView `avatar.ts` 中为每个状态添加基础动画：
   - `idle`: 轻微呼吸动画（胸部上下、微微眨眼）
   - `listening`: 稍微前倾 + 关注表情
   - `thinking`: 微微歪头 + 思考表情
   - `speaking`: 口型驱动（Phase 2 实现，这里先用简单的嘴巴张合）
3. 在 MainScreen 添加一个 debug 按钮行，手动切换状态（开发调试用）

### 状态转换规则
```
idle → listening:       检测到用户（人脸出现）或用户点击
listening → thinking:   ASR 识别到完整语句（静音超时）
thinking → speaking:    LLM 开始生成回复
speaking → listening:   回复播放完毕
speaking → listening:   用户打断
任意状态 → idle:        用户离开（人脸消失超过 5 秒）
```

### WebView 动画实现要点
```typescript
// avatar.ts 中根据状态切换动画
function setState(state: SessionState) {
  switch (state) {
    case 'idle':
      startBreathingAnimation()  // 胸部 Y 轴微微上下 + 随机眨眼
      break
    case 'listening':
      setExpression('interested') // 微微睁大眼睛
      break
    case 'thinking':
      setExpression('thinking')   // 微微歪头
      break
    case 'speaking':
      // Phase 2 实现完整口型，这里先占位
      break
  }
}

// 呼吸动画示例
function startBreathingAnimation() {
  // 使用 sin 函数微调 VRM 的 chest bone Y 位置
  // 幅度极小（0.002），周期 3-4 秒
  // 配合随机间隔的眨眼（blink blendshape）
}
```

### 验收标准
- [x] 状态机有 4 个状态：idle / listening / thinking / speaking
- [x] 手动点击 debug 按钮可以切换状态
- [x] 状态切换时，WebView 中数字人有对应动画变化（idle 呼吸 + 眨眼、listening 微惊讶、thinking 歪头）
- [x] 状态变更时，RN 和 Server 双向同步（服务端日志显示状态变更）
- [x] 从 speaking 状态可以直接回到 listening（打断路径）

### 产出文件
```
src/app/services/SessionManager.ts  # 更新：添加状态机
src/webview/avatar.ts               # 更新：添加状态动画
src/app/screens/MainScreen.tsx      # 更新：添加 debug 按钮
```

---

## Phase 1 里程碑验收

完成以上 4 个 Task 后，应该达到：

1. ✅ Expo App 正常启动，真机可运行
2. ✅ 屏幕上有一个 3D VRM 半身数字人，有呼吸和眨眼动画
3. ✅ App 与后端通过 WebSocket 双向通信
4. ✅ 状态机可切换，数字人根据状态有不同表现
5. ✅ 后端 Fastify 正常运行，有 health check 和 WebSocket 端点

**此时还没有**：语音能力、LLM 对话、口型同步、用户追踪。这些在后续 Phase 实现。
