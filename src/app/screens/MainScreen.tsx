import React, { useCallback, useRef, useEffect, useState } from 'react'
import { StyleSheet, View, Text, TouchableOpacity } from 'react-native'
import Constants from 'expo-constants'
import { CameraView, useCameraPermissions } from 'expo-camera'
import AvatarWebView, { AvatarWebViewRef } from '../components/AvatarWebView'
import FaceTrackerWebView, { FaceTrackerWebViewRef } from '../components/FaceTrackerWebView'
import ConversationArea from '../components/ConversationArea'
import StatusIndicator from '../components/StatusIndicator'
import BottomToolbar from '../components/BottomToolbar'
import { useSession } from '../hooks/useSession'
import { useAudio } from '../hooks/useAudio'
import { useFaceTracker } from '../hooks/useFaceTracker'

const SERVER_HOST = process.env.EXPO_PUBLIC_SERVER_HOST || '192.168.100.241'
const SERVER_PORT = Number(process.env.EXPO_PUBLIC_SERVER_PORT) || 9527
const SERVER_BASE = `http://${SERVER_HOST}:${SERVER_PORT}`
const SERVER_URL = `ws://${SERVER_HOST}:${SERVER_PORT}/ws`
const MODEL_URL = `${SERVER_BASE}/vrm/default.vrm?raw=true`

const STATUS_BAR_HEIGHT = Constants.statusBarHeight || 44

export default function MainScreen() {
  const { connected, state, userTranscript, aiReply, resetSession } = useSession(SERVER_URL)
  const avatarRef = useRef<AvatarWebViewRef>(null)
  const cameraRef = useRef<CameraView>(null)
  const faceTrackerRef = useRef<FaceTrackerWebViewRef>(null)
  const { startCapture, stopCapture, clearPlayback } = useAudio(avatarRef)
  const [cameraPermission, requestCameraPermission] = useCameraPermissions()
  const [avatarReady, setAvatarReady] = useState(false)
  const [isMicActive, setIsMicActive] = useState(true)
  const [isSubtitleOn, setIsSubtitleOn] = useState(true)
  const { start: startFaceTracker, stop: stopFaceTracker, onFaceDetected } = useFaceTracker(cameraRef, faceTrackerRef, avatarRef)

  useEffect(() => {
    if (!cameraPermission?.granted) {
      requestCameraPermission()
    }
  }, [cameraPermission, requestCameraPermission])

  useEffect(() => {
    if (connected) {
      startCapture()
    } else {
      stopCapture()
    }
  }, [connected, startCapture, stopCapture])

  useEffect(() => {
    if (connected && avatarReady) {
      startFaceTracker()
    } else {
      stopFaceTracker()
    }
  }, [connected, avatarReady, startFaceTracker, stopFaceTracker])

  useEffect(() => {
    avatarRef.current?.sendMessage({ type: 'set_state', data: state })
  }, [state])

  const handleReady = useCallback(() => {
    console.log('[MainScreen] Avatar WebView ready')
    setAvatarReady(true)
    avatarRef.current?.sendMessage({ type: 'set_state', data: state })
    // 首次加载完成，微笑欢迎
    setTimeout(() => {
      console.log('[MainScreen] Sending greet command')
      avatarRef.current?.sendMessage({ type: 'greet' })
    }, 1500)
  }, [state])

  const handleError = useCallback((error: string) => {
    console.error('[MainScreen] Avatar error:', error)
  }, [])

  const handleReset = useCallback(() => {
    clearPlayback()
    resetSession()
    // 触发微笑欢迎
    avatarRef.current?.sendMessage({ type: 'greet' })
  }, [clearPlayback, resetSession])

  const handleMicToggle = useCallback(() => {
    if (isMicActive) {
      stopCapture()
    } else {
      startCapture()
    }
    setIsMicActive(!isMicActive)
  }, [isMicActive, startCapture, stopCapture])

  const handleSubtitleToggle = useCallback(() => {
    setIsSubtitleOn(prev => !prev)
  }, [])

  const handleEnd = useCallback(() => {
    clearPlayback()
    resetSession()
  }, [clearPlayback, resetSession])

  return (
    <View style={styles.container} testID="main-screen">
      {/* Avatar 全屏底层 — 不接收触摸 */}
      <View style={styles.avatarFullscreen} pointerEvents="none">
        <AvatarWebView ref={avatarRef} modelUrl={MODEL_URL} serverBaseUrl={SERVER_BASE} onReady={handleReady} onError={handleError} />
      </View>

      {/* 顶部栏 — 绝对定位，始终在顶部 */}
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

      {/* 底部 UI 区域 — 绝对定位，始终在底部 */}
      <View style={styles.bottomUI}>
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
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ede7f6',
  },
  avatarFullscreen: {
    ...StyleSheet.absoluteFillObject,
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
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
  bottomUI: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
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
