import React, { forwardRef, useImperativeHandle, useRef, useCallback } from 'react'
import { StyleSheet } from 'react-native'
import { WebView, WebViewMessageEvent } from 'react-native-webview'

export interface FaceData {
  yaw: number    // -1 ~ 1, 左负右正
  pitch: number  // -1 ~ 1, 下负上正
  roll: number   // -1 ~ 1
  lost: boolean
}

export interface FaceTrackerWebViewRef {
  detectFace: (base64Image: string) => void
}

interface FaceTrackerWebViewProps {
  onFaceDetected: (data: FaceData) => void
}

const FACE_TRACKER_HTML = `<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body>
<script type="module">
  import { FaceLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/+esm';

  let faceLandmarker = null;
  let ready = false;

  async function init() {
    try {
      const filesetResolver = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
      );
      faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'IMAGE',
        numFaces: 1,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: true,
      });
      ready = true;
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
    } catch (err) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', data: String(err) }));
    }
  }

  // 从 transformation matrix 提取欧拉角
  function matrixToEuler(m) {
    // m is 4x4 column-major flat array (16 elements)
    // rotation part: m[0..2] = col0, m[4..6] = col1, m[8..10] = col2
    const r00 = m[0], r01 = m[4], r02 = m[8];
    const r10 = m[1], r11 = m[5], r12 = m[9];
    const r20 = m[2], r21 = m[6], r22 = m[10];

    let pitch, yaw, roll;
    if (Math.abs(r20) < 0.9999) {
      yaw = Math.asin(-r20);
      pitch = Math.atan2(r21, r22);
      roll = Math.atan2(r10, r00);
    } else {
      yaw = r20 > 0 ? -Math.PI / 2 : Math.PI / 2;
      pitch = Math.atan2(-r12, r11);
      roll = 0;
    }
    // 归一化到 -1~1 (假设最大偏转 ~60度 = PI/3)
    const maxAngle = Math.PI / 3;
    return {
      yaw: Math.max(-1, Math.min(1, yaw / maxAngle)),
      pitch: Math.max(-1, Math.min(1, pitch / maxAngle)),
      roll: Math.max(-1, Math.min(1, roll / maxAngle)),
    };
  }

  window.detectFace = function(base64) {
    if (!ready || !faceLandmarker) return;
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      // 前置摄像头图片是镜像的，翻转回来
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0);

      try {
        const result = faceLandmarker.detect(canvas);
        if (result.facialTransformationMatrixes && result.facialTransformationMatrixes.length > 0) {
          const matrix = result.facialTransformationMatrixes[0].data;
          const euler = matrixToEuler(matrix);
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'face',
            data: { ...euler, lost: false }
          }));
        } else {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'face',
            data: { yaw: 0, pitch: 0, roll: 0, lost: true }
          }));
        }
      } catch (e) {
        // 检测失败不发消息，静默跳过
      }
    };
    img.src = 'data:image/jpeg;base64,' + base64;
  };

  init();
<\/script>
</body>
</html>`

const FaceTrackerWebView = forwardRef<FaceTrackerWebViewRef, FaceTrackerWebViewProps>(
  function FaceTrackerWebView({ onFaceDetected }, ref) {
    const webViewRef = useRef<WebView>(null)

    const detectFace = useCallback((base64Image: string) => {
      // 注入 JS 调用 detectFace 函数，传递 base64 数据
      // 为避免字符串过大导致 injectJavaScript 问题，分块或直接传
      webViewRef.current?.injectJavaScript(`window.detectFace("${base64Image}"); true;`)
    }, [])

    useImperativeHandle(ref, () => ({ detectFace }), [detectFace])

    const handleMessage = useCallback((event: WebViewMessageEvent) => {
      try {
        const msg = JSON.parse(event.nativeEvent.data)
        if (msg.type === 'face') {
          onFaceDetected(msg.data)
        } else if (msg.type === 'ready') {
          console.log('[FaceTracker] MediaPipe ready')
        } else if (msg.type === 'error') {
          console.error('[FaceTracker] Error:', msg.data)
        }
      } catch (e) {
        // ignore parse errors
      }
    }, [onFaceDetected])

    return (
      <WebView
        ref={webViewRef}
        source={{ html: FACE_TRACKER_HTML }}
        style={styles.hidden}
        onMessage={handleMessage}
        javaScriptEnabled={true}
        originWhitelist={['*']}
        // 不需要用户交互
        scrollEnabled={false}
        bounces={false}
      />
    )
  }
)

export default FaceTrackerWebView

const styles = StyleSheet.create({
  hidden: {
    width: 0,
    height: 0,
    opacity: 0,
    position: 'absolute',
  },
})
