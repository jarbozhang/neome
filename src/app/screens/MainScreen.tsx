import React, { useCallback, useRef, useEffect } from 'react'
import { StyleSheet, View, Text, TouchableOpacity } from 'react-native'
import AvatarWebView, { AvatarWebViewRef } from '../components/AvatarWebView'
import { useSession } from '../hooks/useSession'
import { useAudio } from '../hooks/useAudio'
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
  const { startCapture, stopCapture, clearPlayback } = useAudio(avatarRef)

  // 连接成功后自动开始音频采集
  useEffect(() => {
    if (connected) {
      startCapture()
    } else {
      stopCapture()
    }
  }, [connected, startCapture, stopCapture])

  // 状态变更时通知 WebView
  useEffect(() => {
    avatarRef.current?.sendMessage({ type: 'set_state', data: state })
  }, [state])

  const handleReady = useCallback(() => {
    console.log('[MainScreen] Avatar WebView ready')
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
    <View style={styles.container}>
      <AvatarWebView ref={avatarRef} modelUrl={MODEL_URL} serverBaseUrl={SERVER_BASE} onReady={handleReady} onError={handleError} />
      {/* 新顾客按钮 */}
      <TouchableOpacity style={styles.resetButton} onPress={() => { clearPlayback(); resetSession() }}>
        <Text style={styles.resetButtonText}>新顾客</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f0f0f0',
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
