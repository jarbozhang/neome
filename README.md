# NeoMe - 数字人点单助手

咖啡店 3D 数字人点单助手。顾客通过语音与半写实虚拟人交互，完成点单、推荐、支付等流程。

## 技术栈

| 层 | 选型 |
|---|---|
| App | React Native (Expo SDK 54) + TypeScript |
| 3D 渲染 | WebView 内嵌 Three.js + @pixiv/three-vrm |
| Face Tracking | expo-camera + MediaPipe FaceLandmarker |
| 后端 | Node.js + Fastify + TypeScript |
| 数据库 | SQLite (better-sqlite3) |
| 语音 | 豆包实时语音大模型 (WebSocket) |
| LLM | 豆包大模型 + MCP 工具协议 |
| 实时通信 | WebSocket (ws) |

## 项目结构

```
src/
├── app/                    # React Native 客户端
│   ├── components/         # AvatarWebView, FaceTrackerWebView
│   ├── hooks/              # useSession, useAudio, useFaceTracker
│   ├── screens/            # MainScreen
│   └── services/           # SessionManager (状态机 + WebSocket)
├── server/                 # Node.js 后端
│   ├── index.ts            # Fastify 入口
│   ├── voiceSession.ts     # 豆包语音 WebSocket 代理
│   ├── agent.ts            # LLM Agent + 意图识别
│   ├── db/                 # SQLite 数据库
│   └── __tests__/          # Jest 测试
├── shared/                 # 前后端共享类型
│   └── types.ts            # WSMessage, SessionState 等
└── webview/                # WebView 资源
assets/
└── models/default.vrm      # VRM 模型 (CC0)
docs/                       # 架构和分阶段实现文档
```

## 快速开始

### 环境要求

- Node.js >= 18
- Expo CLI
- iOS 开发：Xcode + CocoaPods
- 豆包 API 密钥

### 配置

复制 `.env.example` 为 `.env`，填入必要配置：

```bash
cp .env.example .env
```

```env
DOUBAO_APP_ID=your_app_id
DOUBAO_ACCESS_TOKEN=your_access_token
DOUBAO_APP_KEY=your_app_key
EXPO_PUBLIC_SERVER_HOST=192.168.x.x   # 你的 LAN IP
EXPO_PUBLIC_SERVER_PORT=9527
```

### 一键启动

```bash
./dev.sh
```

自动启动后端 (port 9527) + Expo 开发服务器 (port 9528)，并自动检测 LAN IP。

### 手动启动

```bash
# 后端
cd src/server && npx tsx index.ts

# Expo
npx expo start --port 9528 --dev-client
```

### 构建原生客户端

```bash
npx expo prebuild
npx expo run:ios
```

## 数据流

```
用户说话 → 麦克风 PCM (16kHz) → WebSocket → 后端 → 豆包 ASR
                                                      ↓
用户听到 ← 扬声器播放 WAV ← WebSocket ← 后端 ← 豆包 TTS (24kHz)
                                                      ↑
                                               LLM 生成回复
                                               MCP 工具执行
```

## 主要功能

- **语音对话**：实时语音识别 + TTS，支持打断
- **3D 虚拟人**：VRM 模型渲染，口型驱动 (viseme)，表情动画，idle 微动作
- **Face Tracking**：前置摄像头追踪用户面部，数字人头部跟随
- **状态机**：idle → listening → thinking → speaking 四态循环
- **VAD 打断**：speaking 状态下检测用户说话，自动打断 TTS

## 测试

```bash
# 单元测试
npm test

# E2E 测试 (Maestro)
./e2e/run-e2e.sh
```

## License

Private
