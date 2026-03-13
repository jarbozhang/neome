import { useRef, useCallback, useEffect } from 'react'
import { CameraView } from 'expo-camera'
import type { FaceTrackerWebViewRef, FaceData } from '../components/FaceTrackerWebView'
import type { AvatarWebViewRef } from '../components/AvatarWebView'

const CAPTURE_INTERVAL = 200 // ms

export function useFaceTracker(
  cameraRef: React.RefObject<CameraView | null>,
  faceTrackerRef: React.RefObject<FaceTrackerWebViewRef | null>,
  avatarRef: React.RefObject<AvatarWebViewRef | null>,
) {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const runningRef = useRef(false)
  const capturingRef = useRef(false) // 防止重叠拍照

  const onFaceDetected = useCallback((data: FaceData) => {
    // 直接注入 avatar WebView，不经服务端
    avatarRef.current?.sendMessage({ type: 'face_position', data })
  }, [avatarRef])

  const captureAndDetect = useCallback(async () => {
    if (!runningRef.current || capturingRef.current) return
    if (!cameraRef.current || !faceTrackerRef.current) return

    capturingRef.current = true
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.2,
        base64: true,
        skipProcessing: true,
        shutterSound: false,
      })
      if (photo?.base64 && runningRef.current) {
        faceTrackerRef.current?.detectFace(photo.base64)
      }
    } catch {
      // 拍照失败（相机未就绪等），静默跳过
    } finally {
      capturingRef.current = false
    }
  }, [cameraRef, faceTrackerRef])

  const start = useCallback(() => {
    if (runningRef.current) return
    runningRef.current = true
    intervalRef.current = setInterval(captureAndDetect, CAPTURE_INTERVAL)
  }, [captureAndDetect])

  const stop = useCallback(() => {
    runningRef.current = false
    capturingRef.current = false
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  // cleanup on unmount
  useEffect(() => {
    return () => {
      stop()
    }
  }, [stop])

  return { start, stop, onFaceDetected }
}
