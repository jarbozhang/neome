import { requireNativeModule } from 'expo-modules-core'

const AudioRoute = requireNativeModule('AudioRoute')

export function setDefaultToSpeaker(): void {
  AudioRoute.setDefaultToSpeaker()
}
