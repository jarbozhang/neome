import React, { useRef, useCallback, forwardRef, useImperativeHandle } from 'react'
import { StyleSheet } from 'react-native'
import { WebView, WebViewMessageEvent } from 'react-native-webview'

// WebView 加载的完整 HTML 内容（内联，避免 WebView 本地文件访问限制）
// modelUrl 通过模板字符串注入 JS 中的 MODEL_URL 常量
function getWebViewHTML(modelUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <style>
    * { margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; overflow: hidden; }
    canvas { display: block; }
  </style>
</head>
<body>
  <script type="importmap">
  {
    "imports": {
      "three": "https://esm.sh/three@0.162.0",
      "three/examples/jsm/loaders/GLTFLoader": "https://esm.sh/three@0.162.0/examples/jsm/loaders/GLTFLoader.js?external=three",
      "@pixiv/three-vrm": "https://esm.sh/@pixiv/three-vrm@3.3.5?external=three"
    }
  }
  <\/script>
  <script type="module">
    import * as THREE from 'three'
    import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
    import { VRMLoaderPlugin } from '@pixiv/three-vrm'

    const MODEL_URL = '${modelUrl}'

    let scene, camera, renderer, currentVRM = null
    let vrmScene = null
    const clock = new THREE.Clock()

    // 状态机
    let currentState = 'idle'
    let breathingEnabled = true
    let blinkTimer = null
    let placeholderBody = null
    let placeholderHead = null

    function init() {
      scene = new THREE.Scene()
      scene.background = new THREE.Color(0xf0f0f0)

      camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 20)
      camera.position.set(0, 1.3, 1.5)
      camera.lookAt(0, 1.2, 0)

      renderer = new THREE.WebGLRenderer({ antialias: true, premultipliedAlpha: false })
      renderer.setSize(window.innerWidth, window.innerHeight)
      renderer.setPixelRatio(window.devicePixelRatio)
      renderer.outputColorSpace = THREE.SRGBColorSpace
      document.body.appendChild(renderer.domElement)

      const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
      scene.add(ambientLight)
      const dirLight = new THREE.DirectionalLight(0xffffff, 0.8)
      dirLight.position.set(1, 2, 1)
      scene.add(dirLight)

      window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight
        camera.updateProjectionMatrix()
        renderer.setSize(window.innerWidth, window.innerHeight)
      })

      // 监听来自 RN 的消息（iOS）
      window.addEventListener('message', (event) => {
        try {
          const msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
          handleMessage(msg)
        } catch (e) {
          console.error('Failed to parse message:', e)
        }
      })
      // 监听来自 RN 的消息（Android）
      document.addEventListener('message', (event) => {
        try {
          const msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
          handleMessage(msg)
        } catch (e) {
          console.error('Failed to parse message:', e)
        }
      })

      loadVRM()
      animate()
    }

    function handleMessage(msg) {
      console.log('WebView received:', msg.type, msg)
      switch (msg.type) {
        case 'set_state':
          setState(msg.data)
          break
        case 'set_visemes':
          // Phase 2 实现
          break
        case 'set_expression':
          // Phase 2 实现
          break
      }
    }

    function setState(state) {
      if (currentState === state) return
      currentState = state
      console.log('Avatar state:', state)

      stopBlinking()

      switch (state) {
        case 'idle':
          breathingEnabled = true
          startBlinking()
          resetExpression()
          break
        case 'listening':
          breathingEnabled = true
          startBlinking()
          setListeningExpression()
          break
        case 'thinking':
          breathingEnabled = true
          setThinkingExpression()
          break
        case 'speaking':
          breathingEnabled = true
          startBlinking()
          resetExpression()
          // 口型驱动在 Phase 2 实现
          break
      }
    }

    async function loadVRM() {
      const loader = new GLTFLoader()
      loader.register((parser) => new VRMLoaderPlugin(parser))

      try {
        sendToRN({ type: 'loading', data: { status: 'loading' } })

        const gltf = await loader.loadAsync(MODEL_URL)
        currentVRM = gltf.userData.vrm
        vrmScene = gltf.scene

        // VRM 标准：模型面向 +Z，相机在 +Z，旋转 180° 面向相机
        vrmScene.rotation.y = Math.PI
        scene.add(vrmScene)

        sendToRN({ type: 'loading', data: { status: 'vrm_loaded' } })

        // 强制更新世界矩阵
        vrmScene.updateMatrixWorld(true)

        // 半身特写相机
        camera.position.set(0, 1.35, 1.5)
        camera.lookAt(0, 1.25, 0)
        camera.fov = 25
        camera.near = 0.01
        camera.far = 100
        camera.updateProjectionMatrix()

        // MToon → MeshStandardMaterial (处理单材质和多材质数组)
        // TODO Phase 4: 眼睛半透明叠层被 iOS WebGL premultiply 压暗，需自定义 shader 或服务端特殊处理
        function replaceMat(oldMat) {
          let color = new THREE.Color(0xffffff)
          if (oldMat.color) color.copy(oldMat.color)
          else if (oldMat.uniforms?.litFactor?.value) color.copy(oldMat.uniforms.litFactor.value)
          let tex = oldMat.map || null
          if (!tex && oldMat.uniforms) {
            for (const key of ['map', 'mainTex', '_MainTex', 'diffuse']) {
              if (oldMat.uniforms[key]?.value?.isTexture) { tex = oldMat.uniforms[key].value; break }
            }
          }
          const mat = new THREE.MeshStandardMaterial({
            color,
            side: THREE.DoubleSide,
            transparent: false,
            opacity: 1.0,
            roughness: 0.6,
            metalness: 0.0,
          })
          if (tex) {
            tex.premultiplyAlpha = false
            tex.colorSpace = THREE.SRGBColorSpace
            tex.needsUpdate = true
            mat.map = tex
          }
          return mat
        }
        vrmScene.traverse((child) => {
          if (child.isMesh && child.material) {
            child.frustumCulled = false
            child.visible = true
            const mats = Array.isArray(child.material) ? child.material : [child.material]
            child.material = mats.length === 1 ? replaceMat(mats[0]) : mats.map(m => replaceMat(m))
          }
        })

        // 移除占位体（如果有的话）
        removePlaceholder()

        sendToRN({ type: 'ready', data: { vrm: true, childCount: vrmScene.children.length } })
        startBlinking()
      } catch (err) {
        console.error('Failed to load VRM:', err)
        // 加载失败，使用占位体
        createPlaceholderAvatar()
        sendToRN({ type: 'ready', data: { placeholder: true, error: String(err) } })
      }
    }

    function removePlaceholder() {
      if (placeholderBody) {
        scene.remove(placeholderBody)
        placeholderBody.geometry.dispose()
        placeholderBody.material.dispose()
        placeholderBody = null
      }
      if (placeholderHead) {
        scene.remove(placeholderHead)
        placeholderHead.geometry.dispose()
        placeholderHead.material.dispose()
        placeholderHead = null
      }
    }

    function createPlaceholderAvatar() {
      const bodyGeometry = new THREE.CapsuleGeometry(0.15, 0.5, 4, 16)
      const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x6699cc })
      const body = new THREE.Mesh(bodyGeometry, bodyMaterial)
      body.position.set(0, 1.0, 0)
      scene.add(body)
      placeholderBody = body

      const headGeometry = new THREE.SphereGeometry(0.12, 16, 16)
      const headMaterial = new THREE.MeshStandardMaterial({ color: 0xffcc99 })
      const head = new THREE.Mesh(headGeometry, headMaterial)
      head.position.set(0, 1.5, 0)
      scene.add(head)
      placeholderHead = head

      startBlinking()
    }

    function sendToRN(msg) {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify(msg))
      }
    }

    // 转发 console.log 到 RN
    const _origLog = console.log
    console.log = function(...args) {
      _origLog.apply(console, args)
      sendToRN({ type: 'console', data: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') })
    }

    function animate() {
      requestAnimationFrame(animate)
      const delta = clock.getDelta()
      const elapsed = clock.getElapsedTime()

      if (currentVRM) {
        currentVRM.update(delta)

        // VRM 呼吸动画：微调 spine bone
        if (breathingEnabled) {
          const spine = currentVRM.humanoid.getNormalizedBoneNode('spine')
          if (spine) {
            spine.rotation.x = Math.sin(elapsed * 1.8) * 0.01
          }
        }
      }

      // 占位体呼吸（fallback）
      if (breathingEnabled && placeholderBody && placeholderHead && !currentVRM) {
        const breathOffset = Math.sin(elapsed * 1.8) * 0.002
        placeholderBody.position.y = 1.0 + breathOffset
        placeholderHead.position.y = 1.5 + breathOffset
      }

      renderer.render(scene, camera)
    }

    // 眨眼
    function startBlinking() {
      stopBlinking()
      scheduleBlink()
    }

    function stopBlinking() {
      if (blinkTimer) {
        clearTimeout(blinkTimer)
        blinkTimer = null
      }
    }

    function scheduleBlink() {
      const interval = 2000 + Math.random() * 4000
      blinkTimer = setTimeout(() => {
        doBlink()
        scheduleBlink()
      }, interval)
    }

    function doBlink() {
      if (!currentVRM) {
        // fallback 到占位体眨眼
        if (placeholderHead) {
          placeholderHead.scale.y = 0.7
          setTimeout(() => { if (placeholderHead) placeholderHead.scale.y = 1 }, 150)
        }
        return
      }
      // VRM blink expression
      currentVRM.expressionManager.setValue('blink', 1.0)
      setTimeout(() => {
        if (currentVRM) currentVRM.expressionManager.setValue('blink', 0.0)
      }, 150)
    }

    // 表情控制
    function resetExpression() {
      if (currentVRM) {
        currentVRM.expressionManager.setValue('happy', 0)
        currentVRM.expressionManager.setValue('angry', 0)
        currentVRM.expressionManager.setValue('sad', 0)
        currentVRM.expressionManager.setValue('surprised', 0)
        // 重置头部旋转
        const head = currentVRM.humanoid.getNormalizedBoneNode('head')
        if (head) { head.rotation.z = 0; head.rotation.x = 0 }
      }
      // 占位体 fallback
      if (placeholderHead) placeholderHead.material.color.setHex(0xffcc99)
      if (placeholderBody) placeholderBody.rotation.z = 0
    }

    function setListeningExpression() {
      if (currentVRM) {
        // 微微惊讶 = 关注
        currentVRM.expressionManager.setValue('surprised', 0.2)
      }
      if (placeholderHead) placeholderHead.material.color.setHex(0xffd9a8)
    }

    function setThinkingExpression() {
      if (currentVRM) {
        // 微微歪头
        const head = currentVRM.humanoid.getNormalizedBoneNode('head')
        if (head) { head.rotation.z = 0.08 }
      }
      if (placeholderHead) placeholderHead.material.color.setHex(0xeeccaa)
      if (placeholderBody) placeholderBody.rotation.z = 0.05
    }

    init()
  <\/script>
</body>
</html>`
}

export interface AvatarWebViewRef {
  sendMessage: (msg: { type: string; data?: unknown }) => void
}

interface AvatarWebViewProps {
  modelUrl: string
  serverBaseUrl: string
  onReady?: () => void
  onError?: (error: string) => void
}

const AvatarWebView = forwardRef<AvatarWebViewRef, AvatarWebViewProps>(
  function AvatarWebView({ modelUrl, serverBaseUrl, onReady, onError }, ref) {
    const webViewRef = useRef<WebView>(null)

    const sendMessage = useCallback((msg: { type: string; data?: unknown }) => {
      webViewRef.current?.postMessage(JSON.stringify(msg))
    }, [])

    useImperativeHandle(ref, () => ({ sendMessage }), [sendMessage])

    const handleMessage = useCallback((event: WebViewMessageEvent) => {
      try {
        const msg = JSON.parse(event.nativeEvent.data)
        console.log('[AvatarWebView] Received:', msg.type)
        if (msg.type === 'console') {
          console.log('[WebView]', msg.data)
        } else if (msg.type === 'meshDebug') {
          const items = msg.data || []
          console.log('[MeshDebug] Total meshes:', items.length)
          items.forEach((info: string) => console.log('[MeshDebug]', info))
        } else if (msg.type === 'ready') {
          console.log('[AvatarWebView] Ready data:', JSON.stringify(msg.data))
          onReady?.()
        } else if (msg.type === 'loading') {
          console.log('[AvatarWebView] Loading:', JSON.stringify(msg.data))
        } else if (msg.type === 'error') {
          console.error('[AvatarWebView] Error:', msg.data?.message)
          onError?.(msg.data?.message)
        }
      } catch (e) {
        console.error('[AvatarWebView] Parse error:', e)
      }
    }, [onReady, onError])

    return (
      <WebView
        ref={webViewRef}
        source={{ html: getWebViewHTML(modelUrl), baseUrl: serverBaseUrl }}
        style={styles.webview}
        onMessage={handleMessage}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        allowFileAccess={true}
        originWhitelist={['*']}
        mixedContentMode="compatibility"
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
      />
    )
  }
)

export default AvatarWebView

const styles = StyleSheet.create({
  webview: {
    flex: 1,
    backgroundColor: 'transparent',
  },
})
