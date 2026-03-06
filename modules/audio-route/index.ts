import { requireNativeModule } from 'expo-modules-core'

let AudioRoute: any = null
try {
  AudioRoute = requireNativeModule('AudioRoute')
} catch (_) {
  // Native module not available (e.g. simulator)
}

export function setDefaultToSpeaker(): void {
  AudioRoute?.setDefaultToSpeaker()
}
