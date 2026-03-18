# 全屏 Avatar + UI Overlay 实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 VRM Avatar WebView 占满整个屏幕，UI 元素（标题、状态、按钮、字幕）浮动覆盖在 Avatar 之上，可点击。

**Architecture:** 将 AvatarWebView 改为 `position: absolute` 铺满全屏，其余 UI 使用 `pointerEvents="box-none"` 叠加在上层，确保触摸事件穿透到 WebView 或被 UI 按钮捕获。

**Tech Stack:** React Native StyleSheet, pointerEvents

---

### Task 1: AvatarWebView 全屏铺底

**Files:**
- Modify: `src/app/screens/MainScreen.tsx:100-233` (styles + JSX)

- [ ] **Step 1: 修改 MainScreen JSX 结构**

将 `avatarContainer` 改为绝对定位全屏容器，作为最底层。移除假渐变背景 (`gradientTop`, `gradientBottom`)，因为 Avatar 本身就是背景。将其余 UI 放入一个 `pointerEvents="box-none"` 的绝对定位覆盖层中。

```tsx
return (
  <View style={styles.container} testID="main-screen">
    {/* Avatar 全屏底层 */}
    <View style={styles.avatarFullscreen}>
      <AvatarWebView ref={avatarRef} modelUrl={MODEL_URL} serverBaseUrl={SERVER_BASE} onReady={handleReady} onError={handleError} />
    </View>

    {/* UI 覆盖层 — box-none 让触摸穿透到 Avatar */}
    <View style={styles.overlay} pointerEvents="box-none">
      {/* 顶部栏 */}
      <View style={styles.topBar}>
        <View style={styles.topBarSide} />
        <Text style={styles.characterName}>小Neo</Text>
        <View style={styles.topBarSide}>
          {!connected && (
            <View style={styles.connectionBadge}>
              <Text style={styles.connectionText}>连接中...</Text>
            </View>
          )}
        </View>
      </View>

      {/* 中间弹性空间 — 触摸穿透 */}
      <View style={styles.spacer} pointerEvents="none" />

      {/* 底部 UI 区域 */}
      <View style={styles.bottomUI} pointerEvents="box-none">
        {/* 对话区域 */}
        {isSubtitleOn && (
          <ConversationArea userText={userTranscript} aiText={aiReply} />
        )}

        {/* 状态指示器 */}
        <StatusIndicator state={state} />

        {/* DEV: 手势测试按钮 */}
        {__DEV__ && (
          <View style={styles.debugPanel}>
            <View style={styles.debugLabels}>
              <Text testID="connection-label" style={styles.debugText}>connected:{String(connected)}</Text>
              <Text testID="status-label" style={styles.debugText}>state:{state}</Text>
            </View>
            <View style={styles.gestureRow}>
              {(['nod', 'shake', 'happy'] as const).map((g) => (
                <TouchableOpacity
                  key={g}
                  testID={`gesture-${g}`}
                  style={styles.gestureBtn}
                  onPress={() => avatarRef.current?.sendMessage({ type: 'play_gesture', data: g })}
                >
                  <Text style={styles.gestureBtnText}>{g}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* 底部工具栏 */}
        <BottomToolbar
          onMicPress={handleMicToggle}
          onResetPress={handleReset}
          onSubtitleToggle={handleSubtitleToggle}
          onEndPress={handleEnd}
          isMicActive={isMicActive}
          isSubtitleOn={isSubtitleOn}
        />
      </View>
    </View>

    {/* 隐藏的 Camera 和 FaceTracker */}
    {avatarReady && cameraPermission?.granted && (
      <CameraView
        ref={cameraRef}
        style={styles.hiddenCamera}
        facing="front"
        animateShutter={false}
        mute={true}
      />
    )}
    {avatarReady && <FaceTrackerWebView ref={faceTrackerRef} onFaceDetected={onFaceDetected} />}
  </View>
)
```

- [ ] **Step 2: 更新 styles**

删除 `gradientTop`, `gradientBottom`, `avatarContainer`。新增 `avatarFullscreen`, `overlay`, `spacer`, `bottomUI`：

```ts
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ede7f6',
  },
  avatarFullscreen: {
    ...StyleSheet.absoluteFillObject,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: STATUS_BAR_HEIGHT + 8,
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  topBarSide: {
    width: 80,
    alignItems: 'flex-end',
  },
  characterName: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1a1a2e',
  },
  connectionBadge: {
    backgroundColor: 'rgba(0,0,0,0.06)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  connectionText: {
    fontSize: 12,
    color: '#999',
  },
  spacer: {
    flex: 1,
  },
  bottomUI: {
    // 不需要额外样式，由子组件决定大小
  },
  hiddenCamera: {
    width: 1,
    height: 1,
    position: 'absolute',
    opacity: 0,
  },
  debugPanel: {
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  debugLabels: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
    marginBottom: 4,
  },
  debugText: {
    fontSize: 10,
    color: '#999',
    fontFamily: 'monospace',
  },
  gestureRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  gestureBtn: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    backgroundColor: 'rgba(0,0,0,0.06)',
    borderRadius: 12,
  },
  gestureBtnText: {
    fontSize: 11,
    color: '#666',
  },
})
```

- [ ] **Step 3: 验证模拟器截图**

重启 app，截图确认：
1. Avatar 铺满全屏
2. 顶部标题可见
3. 底部按钮可见且可点击
4. 中间区域触摸可穿透到 WebView

### Task 2: 调整 WebView 内相机参数适配全屏

**Files:**
- Modify: `src/app/components/AvatarWebView.tsx:213-215,401-406`

- [ ] **Step 1: 调整相机参数**

全屏后 WebView 纵横比变大（更窄更长），模型需要适配。将 FOV 从 25 调整到 20，相机 Z 距离增大到 1.0，让模型在全屏中居中偏上。初始 init 和 VRM 加载后两处都需改：

```js
camera = new THREE.PerspectiveCamera(20, window.innerWidth / window.innerHeight, 0.1, 20)
camera.position.set(0, 1.32, 1.0)
camera.lookAt(0, 1.29, 0)
```

- [ ] **Step 2: 重启验证**

截图确认模型在全屏中的比例和位置合适。

- [ ] **Step 3: Commit**

```bash
git add src/app/screens/MainScreen.tsx src/app/components/AvatarWebView.tsx
git commit -m "feat: fullscreen avatar with UI overlay"
```
