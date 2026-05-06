import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePreferences } from './usePreferences'

/** 声音提醒配置 */
const soundEnabled = ref(true)
const soundVolume = ref(0.8)
/** 触发声音的事件类型（空数组=所有事件都触发） */
const soundEvents = ref<string[]>([])

/** 所有可配置的声音事件类型 */
const SOUND_EVENT_OPTIONS = [
  { key: 'camera:offline', labelKey: 'settings.soundEventCameraOffline' },
  { key: 'camera:lowfps', labelKey: 'settings.soundEventCameraLowfps' },
  { key: 'alert', labelKey: 'settings.soundEventAlert' },
  { key: 'observation', labelKey: 'settings.soundEventDetectRule' },
  { key: 'detect', labelKey: 'settings.soundEventDetect' },
  { key: 'track:appeared', labelKey: 'settings.soundEventTrackAppeared' },
  { key: 'track:speed', labelKey: 'settings.soundEventTrackSpeed' },
  { key: 'motion', labelKey: 'settings.soundEventMotion' },
] as const

/** Web Audio 上下文（延迟创建） */
let audioCtx: AudioContext | null = null

/** 播放提示音 */
function playAlertSound() {
  if (!soundEnabled.value) return
  if (!audioCtx) audioCtx = new AudioContext()
  const ctx = audioCtx
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.type = 'sine'
  osc.frequency.setValueAtTime(880, ctx.currentTime)
  osc.frequency.setValueAtTime(660, ctx.currentTime + 0.1)
  gain.gain.setValueAtTime(soundVolume.value * 0.3, ctx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
  osc.start(ctx.currentTime)
  osc.stop(ctx.currentTime + 0.3)
}

export function useNotification() {
  useI18n()
  const { getPref, setPref } = usePreferences()

  /** 从后端恢复声音配置 */
  getPref<boolean>('nvr-sound-alert', true).then(v => { soundEnabled.value = v })
  getPref<number>('nvr-sound-volume', 80).then(v => { soundVolume.value = v / 100 })
  getPref<string[]>('nvr-sound-events', []).then(v => {
    /** 迁移旧事件名 */
    soundEvents.value = v.map(e => e === 'detect:rule' ? 'observation' : e)
  })

  /** 切换声音开关 */
  function toggleSound(on: boolean) {
    soundEnabled.value = on
    setPref('nvr-sound-alert', on)
  }

  /** 设置声音音量 (0-100) */
  function setSoundVolume(vol: number) {
    soundVolume.value = vol / 100
    setPref('nvr-sound-volume', vol)
  }

  /** 设置声音触发事件类型 */
  function setSoundEvents(events: string[]) {
    soundEvents.value = events
    setPref('nvr-sound-events', events)
  }

  return {
    soundEnabled,
    soundVolume,
    soundEvents,
    SOUND_EVENT_OPTIONS,
    playAlertSound,
    toggleSound,
    setSoundVolume,
    setSoundEvents,
  }
}
