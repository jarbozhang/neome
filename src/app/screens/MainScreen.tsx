import React, { useCallback, useRef, useEffect, useState } from 'react'
import { StyleSheet, View, Text, TouchableOpacity } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import AvatarWebView, { AvatarWebViewRef } from '../components/AvatarWebView'
import FaceTrackerWebView, { FaceTrackerWebViewRef } from '../components/FaceTrackerWebView'
import { useSession } from '../hooks/useSession'
import { useAudio } from '../hooks/useAudio'
import { useFaceTracker } from '../hooks/useFaceTracker'
import { SessionState } from '../../shared/types'

// 从 .env 读取，改 IP 只需改 .env 文件
const SERVER_HOST = process.env.EXPO_PUBLIC_SERVER_HOST || '192.168.100.241'
const SERVER_PORT = Number(process.env.EXPO_PUBLIC_SERVER_PORT) || 9527
const SERVER_BASE = `http://${SERVER_HOST}:${SERVER_PORT}`
const SERVER_URL = `ws://${SERVER_HOST}:${SERVER_PORT}/ws`
const MODEL_URL = `${SERVER_BASE}/vrm/default.vrm?raw=true`

export default function MainScreen() {
  const { connected, state, transition, resetSession } = useSession(SERVER_URL)
  const avatarRef = useRef<AvatarWebViewRef>(null)
  const cameraRef = useRef<CameraView>(null)
  const faceTrackerRef = useRef<FaceTrackerWebViewRef>(null)
  const { startCapture, stopCapture, clearPlayback } = useAudio(avatarRef)
  const [cameraPermission, requestCameraPermission] = useCameraPermissions()
  const [avatarReady, setAvatarReady] = useState(false)
  const { start: startFaceTracker, stop: stopFaceTracker, onFaceDetected } = useFaceTracker(cameraRef, faceTrackerRef, avatarRef)

  // 请求相机权限并启动 face tracking
  useEffect(() => {
    if (!cameraPermission?.granted) {
      requestCameraPermission()
    }
  }, [cameraPermission, requestCameraPermission])

  // 连接成功后自动开始音频采集
  useEffect(() => {
    if (connected) {
      startCapture()
    } else {
      stopCapture()
    }
  }, [connected, startCapture, stopCapture])

  // avatar 就绪 + 已连接后启动 face tracking
  useEffect(() => {
    if (connected && avatarReady) {
      startFaceTracker()
    } else {
      stopFaceTracker()
    }
  }, [connected, avatarReady, startFaceTracker, stopFaceTracker])

  // 状态变更时通知 WebView
  useEffect(() => {
    avatarRef.current?.sendMessage({ type: 'set_state', data: state })
  }, [state])

  const handleReady = useCallback(() => {
    console.log('[MainScreen] Avatar WebView ready')
    setAvatarReady(true)
    // WebView 就绪后同步当前状态
    avatarRef.current?.sendMessage({ type: 'set_state', data: state })
  }, [state])

  const handleError = useCallback((error: string) => {
    console.error('[MainScreen] Avatar error:', error)
  }, [])

  const handleStateChange = useCallback((newState: SessionState) => {
    transition(newState)
  }, [transition])

  return (
    <View style={styles.container} testID="main-screen">
      <AvatarWebView ref={avatarRef} modelUrl={MODEL_URL} serverBaseUrl={SERVER_BASE} onReady={handleReady} onError={handleError} />
      {avatarReady && cameraPermission?.granted && (
        <CameraView
          ref={cameraRef}
          style={__DEV__ ? styles.cameraPreview : styles.hiddenCamera}
          facing="front"
          animateShutter={false}
          mute={true}
        />
      )}
      {avatarReady && <FaceTrackerWebView ref={faceTrackerRef} onFaceDetected={onFaceDetected} />}
      {/* 新顾客按钮 */}
      <TouchableOpacity testID="reset-button" style={styles.resetButton} onPress={() => { clearPlayback(); resetSession() }}>
        <Text style={styles.resetButtonText}>新顾客</Text>
      </TouchableOpacity>
      {__DEV__ && (
        <View style={styles.debugLabel}>
          <Text testID="status-label" style={styles.debugLabelText}>state:{state}</Text>
          <Text testID="connection-label" style={styles.debugLabelText}>connected:{String(connected)}</Text>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f0f0f0',
  },
  hiddenCamera: {
    width: 1,
    height: 1,
    position: 'absolute',
    opacity: 0,
  },
  cameraPreview: {
    position: 'absolute',
    bottom: 16,
    left: 16,
    width: 120,
    height: 160,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  debugBar: {
    position: 'absolute',
    bottom: 130,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(0,0,0,0.7)',
    padding: 8,
    borderRadius: 8,
  },
  debugText: {
    color: '#fff',
    fontSize: 14,
  },
  debugLabel: {
    position: 'absolute',
    top: 60,
    left: 16,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  debugLabelText: {
    color: '#fff',
    fontSize: 10,
    fontFamily: 'monospace',
  },
  stateButtons: {
    position: 'absolute',
    bottom: 40,
    left: 16,
    right: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  stateButton: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
  },
  stateButtonActive: {
    backgroundColor: '#4A90D9',
  },
  stateButtonText: {
    color: '#aaa',
    fontSize: 12,
    fontWeight: '600',
  },
  stateButtonTextActive: {
    color: '#fff',
  },
  resetButton: {
    position: 'absolute',
    top: 60,
    right: 16,
    backgroundColor: '#E74C3C',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
  },
  resetButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
})
