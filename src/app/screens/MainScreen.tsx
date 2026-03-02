import React, { useCallback, useRef, useEffect } from 'react'
import { StyleSheet, View, Text, TouchableOpacity } from 'react-native'
import AvatarWebView, { AvatarWebViewRef } from '../components/AvatarWebView'
import { useSession } from '../hooks/useSession'
import { SessionState } from '../../shared/types'

// 开发时使用本机 IP，后续可配置
const SERVER_URL = 'ws://localhost:3000/ws'

export default function MainScreen() {
  const { connected, state, transition } = useSession(SERVER_URL)
  const avatarRef = useRef<AvatarWebViewRef>(null)

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
      <AvatarWebView ref={avatarRef} onReady={handleReady} onError={handleError} />
      {/* Debug 信息 */}
      <View style={styles.debugBar}>
        <Text style={styles.debugText}>
          WS: {connected ? '🟢' : '🔴'} | {state}
        </Text>
      </View>
      {/* Debug 状态切换按钮 */}
      <View style={styles.stateButtons}>
        {(['idle', 'listening', 'thinking', 'speaking'] as SessionState[]).map((s) => (
          <TouchableOpacity
            key={s}
            style={[styles.stateButton, state === s && styles.stateButtonActive]}
            onPress={() => handleStateChange(s)}
          >
            <Text style={[styles.stateButtonText, state === s && styles.stateButtonTextActive]}>
              {s}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
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
})
