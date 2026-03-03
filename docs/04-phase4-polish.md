# Phase 4：体验完善（约 1.5 周）

> 目标：添加用户追踪（注视跟随）、表情丰富化、UI 组件、环境适配，打磨到可以在真实咖啡店中使用的程度。

> 前置依赖：Phase 3 全部完成（对话 + 点单已通）。

---

## Task 4.1：MediaPipe 用户追踪 + 数字人注视跟随

### 目标
使用前置摄像头 + MediaPipe Face Landmarker 检测用户脸部位置，让数字人始终看向用户方向。

### 具体步骤
1. 在 `src/app/hooks/useFaceTracker.ts` 中实现：
   - 请求前置摄像头权限
   - 使用 `expo-camera` 获取视频帧
   - 通过 MediaPipe Face Landmarker 检测人脸位置
   - 计算人脸中心相对于屏幕的归一化坐标 `(x, y)` 范围 [-1, 1]
   - 以 10-15 FPS 频率通过 postMessage 传给 WebView
2. 在 WebView `avatar.ts` 中实现注视跟随：
   - 接收 `face_position` 数据
   - 使用 VRM 的 `lookAt` 目标控制器
   - 平滑插值（lerp），避免头部突然跳动
   - 限制转头角度（左右最大 ±30°，上下最大 ±15°）
3. 实现人脸出现/消失检测：
   - 人脸出现 → 数字人转头看向用户 + 触发欢迎语
   - 人脸消失超过 10 秒 → 数字人回到正面 + session 重置

### 关键实现细节

**MediaPipe 在 RN 中的使用方案：**

因为 MediaPipe 的 Web 版本最成熟，推荐在另一个隐藏 WebView 中运行 MediaPipe，通过 postMessage 传回检测结果。

```typescript
// src/app/hooks/useFaceTracker.ts
import { useRef, useEffect, useState } from 'react'

interface FacePosition {
  x: number  // -1 (左) 到 1 (右)
  y: number  // -1 (下) 到 1 (上)
  detected: boolean
}

export function useFaceTracker() {
  const [facePosition, setFacePosition] = useState<FacePosition>({
    x: 0, y: 0, detected: false
  })
  const webViewRef = useRef(null)

  // MediaPipe WebView 的 HTML 内容
  const mediapipeHTML = `
    <script src="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.js"></script>
    <video id="video" autoplay playsinline style="display:none"></video>
    <script>
      async function init() {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm"
        );
        const faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: "face_landmarker.task" },
          runningMode: "VIDEO",
          numFaces: 1,
        });

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: 320, height: 240 }
        });
        const video = document.getElementById('video');
        video.srcObject = stream;
        await video.play();

        function detect() {
          const result = faceLandmarker.detectForVideo(video, performance.now());
          if (result.faceLandmarks.length > 0) {
            const nose = result.faceLandmarks[0][1]; // 鼻尖
            // 归一化到 [-1, 1]
            const x = (nose.x - 0.5) * 2;
            const y = -(nose.y - 0.5) * 2;
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'face_position', x, y, detected: true
            }));
          } else {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'face_position', x: 0, y: 0, detected: false
            }));
          }
          setTimeout(detect, 100); // ~10 FPS
        }
        detect();
      }
      init();
    </script>
  `

  return { facePosition, mediapipeHTML, webViewRef }
}
```

**WebView 中的注视跟随实现：**
```typescript
// avatar.ts 中添加
const lookAtTarget = new THREE.Vector3(0, 1.3, 2)  // 默认看正前方
const smoothFactor = 0.08  // 平滑系数，越小越丝滑

function updateLookAt(faceX: number, faceY: number) {
  if (!currentVRM) return

  // 将归一化坐标映射到 3D 空间中的目标点
  // 用户在左边 → 数字人看左边（因为面对面，方向相反）
  const targetX = -faceX * 0.5  // 限制幅度
  const targetY = 1.3 + faceY * 0.2

  // 平滑插值
  lookAtTarget.x += (targetX - lookAtTarget.x) * smoothFactor
  lookAtTarget.y += (targetY - lookAtTarget.y) * smoothFactor

  // 应用到 VRM lookAt
  currentVRM.lookAt.target = lookAtTarget
}

// 在 animate 循环中调用 updateLookAt
```

### 验收标准
- [ ] App 请求前置摄像头权限，用户授权后开始追踪
- [ ] 用户在屏幕前左右移动，数字人头部跟随转动
- [ ] 用户上下移动，数字人有微微抬头/低头的反应
- [ ] 转头动作平滑，没有突然跳动（插值生效）
- [ ] 转头角度合理，不会出现 180° 转头等异常
- [ ] 用户离开（无人脸）10 秒后，数字人回到正面待机
- [ ] 用户走近时触发欢迎语，session 开始
- [ ] 追踪不影响主渲染帧率（仍然 30+ FPS）

### 产出文件
```
src/app/hooks/useFaceTracker.ts
src/app/screens/MainScreen.tsx      # 更新：集成追踪 WebView
src/webview/avatar.ts               # 更新：添加 lookAt 控制
```

---

## Task 4.2：表情丰富化

### 目标
让数字人在对话中展现更丰富的面部表情和肢体微动，提升"像真人"的感觉。

### 具体步骤
1. 在 `avatar.ts` 中实现以下表情/动画系统：
   - **idle 微动作**：随机眨眼（2-5 秒间隔）、偶尔微微歪头、呼吸动画
   - **情绪表情**：开心（推荐成功时）、思考（用户犹豫时）、抱歉（缺货/没听清）
   - **说话时**：配合口型的微表情（眉毛微动、眼睛注视变化）
   - **听用户说话时**：点头、微微前倾、关注表情
2. 实现表情控制 API，后端可以通过 WebSocket 指定表情：
   - `{type: "set_expression", data: {name: "happy", intensity: 0.8, duration: 2000}}`
3. Agent 在特定场景触发表情：
   - 推荐成功 → happy
   - 用户犹豫 → curious
   - 缺货 → sorry
   - 支付完成 → excited

### 表情到 VRM blendshape 映射
```typescript
const EXPRESSIONS: Record<string, Record<string, number>> = {
  neutral: {},
  happy: {
    'happy': 0.7,        // VRM 预设表情
  },
  thinking: {
    'lookUp': 0.3,       // 微微抬眼
  },
  sorry: {
    'sad': 0.4,
  },
  curious: {
    'surprised': 0.3,
  },
  excited: {
    'happy': 1.0,
  },
}
```

### idle 微动作实现
```typescript
// 眨眼
function blinkLoop() {
  const interval = 2000 + Math.random() * 4000  // 2-6秒随机
  setTimeout(() => {
    // 快速眨眼动画：0ms→闭眼, 100ms→睁眼
    animateBlendshape('blink', 0, 1, 80)
      .then(() => animateBlendshape('blink', 1, 0, 80))
      .then(() => blinkLoop())
  }, interval)
}

// 呼吸
function breatheLoop(deltaTime: number) {
  const t = performance.now() / 1000
  const breathe = Math.sin(t * 0.8) * 0.002  // 极微小的上下运动
  if (currentVRM) {
    const chest = currentVRM.humanoid.getNormalizedBoneNode('chest')
    if (chest) chest.position.y += breathe
  }
}

// 偶尔歪头
function headTiltLoop() {
  const interval = 8000 + Math.random() * 12000  // 8-20秒随机
  setTimeout(() => {
    const tiltAngle = (Math.random() - 0.5) * 0.05  // 极微小的倾斜
    animateRotation('head', 'z', tiltAngle, 1000)
      .then(() => delay(2000))
      .then(() => animateRotation('head', 'z', 0, 1000))
      .then(() => headTiltLoop())
  }, interval)
}
```

### 验收标准
- [ ] 数字人在 idle 状态有自然的眨眼（2-6 秒随机间隔）
- [ ] 数字人有轻微的呼吸动画（胸部微动）
- [ ] 后端发送 `set_expression: happy` 后，数字人面露微笑
- [ ] 推荐成功时数字人自动微笑
- [ ] 没听清时数字人自动展现抱歉表情
- [ ] 表情之间过渡平滑，不会突然变脸
- [ ] 所有微动作不影响口型同步

### 产出文件
```
src/webview/avatar.ts               # 更新：表情系统 + 微动作
src/server/agent.ts                 # 更新：在特定场景发送表情指令
```

---

## Task 4.3：UI 组件（订单面板 + 菜单 + 支付）

### 目标
在数字人画面上叠加 UI 组件：当前订单面板、菜单浏览、支付二维码，辅助纯语音交互。

### 具体步骤
1. 实现 `OrderPanel.tsx`：
   - 半透明浮层，固定在屏幕右侧或底部
   - 显示当前订单项列表（名称、规格、价格）
   - 实时更新（WebSocket 推送订单变更）
   - 显示总价
2. 实现 `MenuOverlay.tsx`：
   - 可收起的菜单列表（用户点击或语音说"看看菜单"时展开）
   - 按分类展示饮品
   - 显示价格和可用状态
3. 实现 `PaymentQR.tsx`：
   - 确认订单后弹出
   - 显示支付二维码（模拟）
   - 显示总价和倒计时
   - 支付成功后自动消失

### UI 布局
```
┌──────────────────────────────────────┐
│                                      │
│           数字人（WebView）            │
│                                      │
│                          ┌────────┐  │
│                          │ 订单   │  │
│                          │ 面板   │  │
│                          │        │  │
│                          └────────┘  │
│                                      │
│  ┌─────────────────────────────────┐ │
│  │ 状态指示：🎤 正在听...           │ │
│  └─────────────────────────────────┘ │
└──────────────────────────────────────┘
```

### 关键实现
```typescript
// src/app/components/OrderPanel.tsx
interface OrderPanelProps {
  items: OrderItem[]
  totalPrice: number
  status: 'draft' | 'confirmed' | 'paid'
}

export function OrderPanel({ items, totalPrice, status }: OrderPanelProps) {
  if (items.length === 0) return null

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>当前订单</Text>
      {items.map((item, i) => (
        <View key={i} style={styles.item}>
          <Text>{item.name} ({sizeLabel(item.size)})</Text>
          <Text>¥{item.unit_price}</Text>
        </View>
      ))}
      <View style={styles.divider} />
      <View style={styles.total}>
        <Text style={styles.totalLabel}>合计</Text>
        <Text style={styles.totalPrice}>¥{totalPrice}</Text>
      </View>
    </View>
  )
}
```

```typescript
// src/app/components/PaymentQR.tsx
interface PaymentQRProps {
  qrData: string
  totalPrice: number
  onClose: () => void
}

export function PaymentQR({ qrData, totalPrice, onClose }: PaymentQRProps) {
  return (
    <Modal transparent animationType="fade">
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.price}>¥{totalPrice}</Text>
          <QRCode value={qrData} size={200} />
          <Text style={styles.hint}>请使用微信或支付宝扫码支付</Text>
        </View>
      </View>
    </Modal>
  )
}
```

### 验收标准
- [ ] 点单过程中，屏幕右侧显示当前订单面板
- [ ] 每添加一个饮品，面板实时更新（名称、规格、价格）
- [ ] 总价实时计算并显示
- [ ] 确认订单后弹出支付二维码
- [ ] 二维码模态窗不遮挡数字人主体
- [ ] 屏幕底部有状态指示（正在听... / 思考中... / 说话中...）
- [ ] UI 组件不影响数字人渲染性能

### 产出文件
```
src/app/components/OrderPanel.tsx
src/app/components/MenuOverlay.tsx
src/app/components/PaymentQR.tsx
src/app/components/StatusBar.tsx    # 状态指示条
src/app/screens/MainScreen.tsx      # 更新：集成所有 UI 组件
```

---

## Task 4.4：环境适配 + 测试

### 目标
针对咖啡店真实场景做适配和测试：嘈杂环境、多种设备、网络波动。

### 具体步骤
1. **嘈杂环境优化**：
   - 音频采集配置 `echoCancellation: true`, `noiseSuppression: true`, `autoGainControl: true`
   - 调整 VAD 阈值，避免环境噪音误触打断
   - ASR 连续失败 3 次时，数字人提示"这里有点吵，能靠近一点说吗？"
2. **多设备适配**：
   - 测试 iPad (主要目标设备)、iPhone、Android 平板
   - 适配不同屏幕尺寸的 UI 布局
   - 检查 WebView WebGL 性能（低端设备降级：减少光照、降低分辨率）
3. **网络波动处理**：
   - WebSocket 断线自动重连（指数退避）
   - 断线期间数字人显示"网络连接中..."
   - 豆包 API 超时处理（5 秒无响应显示提示）
4. **性能优化**：
   - WebView 渲染帧率监控
   - 音频播放延迟监控
   - 内存泄漏检查（长时间运行）

### 验收标准
- [ ] 在播放背景音乐的环境中（模拟咖啡店），语音识别仍可用
- [ ] iPad 上 UI 布局合理，数字人占据主要画面
- [ ] iPhone 上 UI 自适应，不会溢出或遮挡
- [ ] 断开 WiFi 后重连，对话可以继续
- [ ] App 连续运行 30 分钟不崩溃、不卡顿
- [ ] WebView 渲染保持 30+ FPS

### 产出文件
```
src/app/hooks/useAudio.ts           # 更新：噪声抑制配置
src/app/services/SessionManager.ts  # 更新：重连 + 网络状态
src/app/screens/MainScreen.tsx      # 更新：自适应布局
```

---

## Phase 4 里程碑验收

完成以上 4 个 Task 后，应该达到：

1. ✅ 数字人看向用户方向，用户移动时自然跟随
2. ✅ 数字人有丰富的面部表情和微动作
3. ✅ 屏幕有辅助 UI（订单面板、菜单、支付）
4. ✅ 在模拟咖啡店嘈杂环境中可正常工作
5. ✅ 多设备适配完成

---

## 项目整体验收（End-to-End）

### 场景 1：完整点单流程
```
1. 用户走到平板前（数字人检测到人脸，转头看向用户）
2. 数字人：你好！欢迎来到咖啡店，想喝点什么？（微笑）
3. 用户：有什么推荐的吗
4. 数字人：推荐我们的招牌拿铁...（屏幕右侧无订单面板）
5. 用户：好的，来一杯中杯拿铁少糖
6. 数字人：好的！（订单面板出现：中杯拿铁少糖 ¥26）
7. 用户：再加一杯美式
8. 数字人：美式要什么杯型？（订单面板更新）
9. 用户：大杯
10. 数字人：好的，大杯美式。一共两杯52块，还要别的吗？
11. 用户：就这些
12. 数字人：请扫码支付~（支付二维码弹出）
13. （模拟支付成功）
14. 数字人：收到啦！大概3分钟出杯，请稍等~（开心表情）
15. 用户走开（10秒后 session 重置）
```

### 场景 2：打断测试
```
1. 数字人正在说一长段推荐话术
2. 用户突然说"不要了，直接来一杯美式"
3. 数字人立即停止说话 → 口型归零 → "好的，一杯美式！"
```

### 场景 3：注视跟随测试
```
1. 用户在屏幕左侧 → 数字人头转向左
2. 用户移到右侧 → 数字人头平滑转向右
3. 用户走开 → 数字人慢慢回到正面
```

### 场景 4：异常处理
```
1. 说含糊不清的话 → "抱歉没听清，能再说一次吗？"
2. 点一个不存在的饮品 → "抱歉，我们菜单上没有这个，要看看菜单吗？"
3. 点一个缺货的饮品 → "抱歉，XX 今天暂时缺货了，换一个试试？"
4. 网络断开 → "网络连接中，请稍等..."
```

---

## 已知技术问题（Phase 1 遗留，Phase 4 解决）

### VRM 贴图在 iOS WebView 中的渲染问题

**现象：** 面部和眼睛贴图颜色偏暗/发黑，眼睛半透明叠层（虹膜、瞳孔、高光）几乎不可见。

**根因：** iOS WebView 的 WebGL 实现在 GPU 层面强制对纹理做 premultiplied alpha 处理。即使：
- 服务端已将 PNG 嵌入的 alpha 通道修复为 255（含 un-premultiply RGB）
- Three.js 侧设置了 `texture.premultiplyAlpha = false`
iOS WebGL 仍在 `texImage2D` 时对 RGB 做 premultiply，导致半透明区域颜色被压暗。

**当前 workaround：**
- MToon → MeshStandardMaterial 替换，保留贴图（`tex.premultiplyAlpha = false`）
- Body/Hair 渲染正常，Face 偏暗但可接受
- 眼睛黑色（半透明叠层严重受影响）

**待探索方案：**
1. 自定义 WebGL shader，在 fragment shader 中手动反 premultiply
2. 服务端针对眼部贴图特殊处理（将半透明合并为不透明）
3. 使用 `<canvas>` 在客户端重新处理纹理后再上传 WebGL
4. 探索 `UNPACK_PREMULTIPLY_ALPHA_WEBGL` 在 iOS WebView 中的行为
