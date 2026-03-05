# 音频采集方案 — 解决 Expo Go 不支持原生模块问题

## Context
当前 `src/app/hooks/useAudio.ts` 使用 `react-native-live-audio-stream` 做实时 PCM 采集（16kHz/16bit/mono），但该库是原生模块，Expo Go 中不可用。需要切换到 Dev Build 模式。

**核心事实：** 任何实时 PCM 流式采集方案都需要原生桥接，Expo Go 无法绕过这个限制。官方 `expo-audio` 模块的录音 API 只支持文件录制，不支持流式回调。

---

## 方案对比

| 方案 | 代码改动 | 是否需要 Dev Build | 实时流式 | 社区活跃度 |
|---|---|---|---|---|
| A. expo-dev-client + 保留现有库 | 无代码改动 | 是 | 是 | react-native-live-audio-stream 维护较少 |
| B. expo-dev-client + expo-audio-stream | 中等改动 | 是 | 是 | mykin-ai, 54 stars |
| C. expo-dev-client + @siteed/expo-audio-studio | 中等改动 | 是 | 是 | 277 stars, 较活跃 |
| D. expo-av 文件录制轮询 | 大改动 | 否(Expo Go可用) | 否(高延迟) | 官方 |

---

## 推荐：方案 A — 设置 Dev Build，保留现有代码

**理由：**
- 代码改动为零，只需配置构建环境
- `react-native-live-audio-stream` 已经验证可用（代码已写好）
- Dev Build 是 Expo 项目使用原生模块的标准做法
- 未来其他原生模块（如 Silero VAD、高级音频处理）也需要 Dev Build

### 实施步骤

#### 1. 安装 expo-dev-client
```bash
npx expo install expo-dev-client
```

#### 2. 配置 EAS Build（如需云构建）
```bash
npm install -g eas-cli
eas login
eas build:configure
```

#### 3. 本地 Dev Build（推荐，无需 EAS 云服务）
```bash
# iOS
npx expo run:ios

# Android
npx expo run:android
```
这会在本地生成包含所有原生模块的自定义开发客户端。

#### 4. 后续开发流程变更
- 不再用 `npx expo start` 配 Expo Go
- 改用 `npx expo start --dev-client` 启动开发服务器
- 用自定义 Dev Client app 扫码连接（体验与 Expo Go 相同）

### 修改文件
- `package.json` — 新增 `expo-dev-client` 依赖
- `dev.sh` — 启动命令加 `--dev-client` flag
- `src/app/hooks/useAudio.ts` — **无需改动**，可选移除降级 try/catch

---

## 备选：如果不想设置 Dev Build

方案 D（expo-av 文件轮询）可作为**临时开发调试用**：
- 每 500ms 录制一小段到文件 → 读取 → base64 → 发送
- 延迟高（~500ms+），不适合生产
- 仅建议在无法构建原生包时临时使用

---

## 验证方式
1. `npx expo run:ios` 成功构建并安装到模拟器/真机
2. App 启动后 console 不再出现 `react-native-live-audio-stream not available` 警告
3. 对着手机说话，服务端日志显示收到 `audio_chunk` 消息
4. 完整语音链路可用（说话 → ASR → TTS 回复 → 播放）

---

## 参考资料
- [Expo Dev Build 文档](https://docs.expo.dev/develop/development-builds/introduction/)
- [expo-audio 官方文档](https://docs.expo.dev/versions/latest/sdk/audio/) — 不支持流式录音
- [expo-audio-stream (mykin-ai)](https://github.com/mykin-ai/expo-audio-stream) — 备选方案 B
- [@siteed/expo-audio-studio](https://github.com/deeeed/expo-audio-stream) — 备选方案 C
- [Expo 实时音频处理博客](https://expo.dev/blog/real-time-audio-processing-with-expo-and-native-code)
