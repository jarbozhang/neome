import { useState, useEffect, useCallback } from 'react'
import { sessionManager } from '../services/SessionManager'
import { WSMessage, SessionState } from '../../shared/types'

interface UseSessionReturn {
  connected: boolean
  state: SessionState
  send: (msg: WSMessage) => void
  transition: (newState: SessionState) => boolean
}

export function useSession(serverUrl: string): UseSessionReturn {
  const [connected, setConnected] = useState(false)
  const [state, setState] = useState<SessionState>('idle')

  useEffect(() => {
    sessionManager.onConnectionChange = setConnected
    sessionManager.onStateChange = setState
    sessionManager.connect(serverUrl)

    return () => {
      sessionManager.disconnect()
    }
  }, [serverUrl])

  const send = useCallback((msg: WSMessage) => {
    sessionManager.send(msg)
  }, [])

  const transition = useCallback((newState: SessionState) => {
    return sessionManager.transition(newState)
  }, [])

  return { connected, state, send, transition }
}
