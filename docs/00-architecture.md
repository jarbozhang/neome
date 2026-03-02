# NeoMe 架构总览

## 项目简介

NeoMe 是一个咖啡店数字人点单助手。部署在移动设备（平板/手机）上，通过 3D 半写实虚拟人与顾客进行语音交互，完成点单、推荐、支付等流程。

## 技术决策（已确认）

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 数字人风格 | 半写实卡通（皮克斯风） | 亲和力强，适合大众咖啡店 |
| App 平台 | React Native (Expo) | 跨平台 iOS/Android |
| 3D 渲染 | RN WebView 内嵌 Three.js + @pixiv/three-vrm | 生态成熟，TalkingHead 可复用 |
| 模型格式 | VRM 1.0 (含 ARKit 52 blendshapes) | 口型/表情驱动标准 |
| 语音 API | 豆包实时语音大模型 (已有 Key) | Speech2Speech, ~700ms 延迟 |
| LLM | 豆包大模型 | 意图识别 + 对话管理 |
| 后端 | Node.js + Fastify | 轻量高性能 |
| 数据库 | SQLite | 简单够用 |

## 架构图

```
┌─────────── React Native App ──────────────────────┐
│                                                    │
│  ┌─ Native Layer ─────────────────────────────┐   │
│  │  Camera (前置摄像头 → MediaPipe)            │   │
│  │  Audio (麦克风采集 / 扬声器播放)             │   │
│  └────────────────────┬───────────────────────┘   │
│                       │ postMessage / Bridge       │
│  ┌─ WebView ─────────────────────────────────┐    │
│  │  Three.js + @pixiv/three-vrm              │    │
│  │  → VRM 模型加载 + 场景渲染                  │    │
│  │  → viseme blendshape 口型驱动              │    │
│  │  → 表情动画 + idle 微动作                   │    │
│  │  → 头部朝向跟随（接收追踪坐标）              │    │
│  └───────────────────────────────────────────┘    │
│                                                    │
│  ┌─ RN JS Layer ─────────────────────────────┐    │
│  │  FaceTracker: MediaPipe → 用户位置          │    │
│  │  AudioManager: 采集 PCM / 播放 / VAD        │    │
│  │  SessionManager: WebSocket + 状态机         │    │
│  │  UI: 订单面板 / 菜单 / 支付二维码            │    │
│  └────────────────────┬───────────────────────┘   │
│                       │ WebSocket                  │
└───────────────────────┼────────────────────────────┘
                        │
┌──────────── 后端 Node.js (Fastify) ────────────────┐
│                                                     │
│  VoiceSession                                       │
│  → WebSocket Proxy ↔ 豆包实时语音 API               │
│  → 音频流转发 + 打断信号处理                         │
│                                                     │
│  TTSService                                         │
│  → HeadTTS (Kokoro) 备选 TTS                        │
│  → 生成 viseme 时间戳                                │
│                                                     │
│  Agent                                              │
│  → 豆包大模型 LLM                                    │
│  → 系统 prompt (咖啡店角色 + 菜单)                    │
│  → MCP Tool 调度                                     │
│                                                     │
│  MCP Tools                                          │
│  → query_menu / recommend_drink                     │
│  → create_order / modify_order / confirm_order      │
│  → check_order_status / check_inventory             │
│                                                     │
│  Database (SQLite)                                   │
│  → menus / orders / inventory                       │
└─────────────────────────────────────────────────────┘
```

## 数据流

### 完整对话流程
```
用户说话
  → RN AudioManager 采集 PCM (16kHz 16bit mono)
  → WebSocket 发送到后端
  → 后端 VoiceSession 转发到豆包实时语音 API
  → 豆包 ASR 流式返回文本
  → Agent 接收文本 → 意图识别 → 调用 MCP Tools
  → Agent 生成回复文本（流式）
  → TTSService 将文本转语音 + 生成 viseme 时间戳
  → WebSocket 推送 {audio_chunk, visemes[]} 到前端
  → RN AudioManager 播放音频
  → WebView postMessage 接收 visemes → 驱动 VRM blendshapes
  → 数字人嘴巴动 + 说话
```

### 打断流程
```
用户在数字人说话时开口
  → VAD 检测到用户语音
  → 立即: 停止音频播放 + 清空缓冲 + 口型归零
  → WebSocket 发送 {type: "interrupt"} 到后端
  → 后端: 通知豆包中断 + 清空 TTS 队列
  → 切换到 listening 状态
  → 开始新一轮 ASR
```

### 注视跟随流程
```
前置摄像头持续运行
  → MediaPipe Face Landmarker 检测人脸 468 关键点
  → 计算人脸中心坐标 (x, y) 相对屏幕位置
  → postMessage 到 WebView
  → Three.js 中 VRM 模型 lookAt 目标更新
  → 数字人平滑转头看向用户
```

## 项目结构

```
NeoMe/
├── docs/                           # 项目文档
│   ├── 00-architecture.md          # 本文件
│   ├── 01-phase1-skeleton.md       # Phase 1 详细任务
│   ├── 02-phase2-voice.md          # Phase 2 详细任务
│   ├── 03-phase3-agent.md          # Phase 3 详细任务
│   └── 04-phase4-polish.md         # Phase 4 详细任务
│
├── package.json
├── app.json                        # Expo 配置
├── tsconfig.json
│
├── src/
│   ├── app/                        # React Native 主应用
│   │   ├── App.tsx                 # 入口
│   │   ├── screens/
│   │   │   └── MainScreen.tsx      # 主屏幕
│   │   ├── components/
│   │   │   ├── AvatarWebView.tsx   # WebView 容器
│   │   │   ├── OrderPanel.tsx      # 订单面板
│   │   │   ├── MenuOverlay.tsx     # 菜单浮层
│   │   │   └── PaymentQR.tsx       # 支付二维码
│   │   ├── hooks/
│   │   │   ├── useAudio.ts         # 音频采集/播放
│   │   │   ├── useFaceTracker.ts   # MediaPipe 追踪
│   │   │   └── useSession.ts       # WebSocket 会话
│   │   └── services/
│   │       └── SessionManager.ts   # 状态机 + WebSocket
│   │
│   ├── webview/                    # WebView 内 Three.js
│   │   ├── index.html              # WebView 入口
│   │   ├── avatar.ts               # VRM 加载+渲染+口型
│   │   └── lib/                    # Three.js 打包
│   │
│   ├── server/                     # 后端
│   │   ├── index.ts                # Fastify 入口
│   │   ├── voiceSession.ts         # 豆包语音管理
│   │   ├── ttsService.ts           # TTS + viseme
│   │   ├── agent.ts                # LLM Agent
│   │   ├── tools/                  # MCP 工具
│   │   │   ├── index.ts            # 工具注册
│   │   │   ├── menu.ts             # 菜单查询
│   │   │   ├── order.ts            # 订单管理
│   │   │   └── payment.ts          # 支付
│   │   └── db/
│   │       ├── schema.sql          # 建表语句
│   │       └── index.ts            # 数据库操作
│   │
│   └── shared/                     # 前后端共享
│       └── types.ts                # 类型定义
│
├── assets/
│   ├── models/                     # VRM 模型文件
│   └── animations/                 # 动画资源
│
└── server/                         # 后端独立运行入口
    └── package.json
```

## 关键外部依赖

| 包名 | 用途 | 文档 |
|------|------|------|
| expo | RN 框架 | https://docs.expo.dev |
| react-native-webview | WebView 容器 | https://github.com/nickasd/react-native-webview |
| three | 3D 渲染引擎 | https://threejs.org |
| @pixiv/three-vrm | VRM 模型支持 | https://github.com/pixiv/three-vrm |
| @mediapipe/tasks-vision | 人脸追踪 | https://developers.google.com/mediapipe |
| @ricky0123/vad-web | 语音活动检测 | https://github.com/ricky0123/vad |
| fastify | 后端框架 | https://fastify.dev |
| ws | WebSocket | https://github.com/websockets/ws |
| better-sqlite3 | SQLite | https://github.com/WiseLibs/better-sqlite3 |
| @modelcontextprotocol/sdk | MCP 工具 | https://github.com/modelcontextprotocol/typescript-sdk |

## 关键参考项目

| 项目 | 用途 | 地址 |
|------|------|------|
| TalkingHead | Three.js VRM 口型驱动参考 | https://github.com/met4citizen/TalkingHead |
| HeadTTS | Kokoro TTS + viseme 生成 | https://github.com/met4citizen/HeadTTS |
| DH_live | 超轻量数字人参考 | https://github.com/kleinlee/DH_live |
| NVIDIA Audio2Face-3D | 音频→面部动画参考 | https://github.com/NVIDIA/Audio2Face-3D |
