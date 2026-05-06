<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { getBackendUrl, setBackendUrl } from '../services/backend'
import { useI18n } from 'vue-i18n'

const emit = defineEmits<{
  saved: []
}>()
import { authFetch } from '../services/auth'
import { usePreferences } from '../composables/usePreferences'
import { useToast } from '../composables/useToast'

const { t } = useI18n()
const { setPref, getPref } = usePreferences()
const toast = useToast()
let successTimer: ReturnType<typeof setTimeout> | null = null

/** 后端地址 */
const backendUrlInput = ref(getBackendUrl())
function saveBackendUrl() {
  setBackendUrl(backendUrlInput.value)
  location.reload()
}

/** 声音提醒设置 */
const soundEnabled = ref(true)
const soundVolume = ref(80)
/** 触发声音的事件类型（空数组=所有事件都触发） */
const soundEvents = ref<string[]>([])

/** 所有可配置的声音事件类型 */
const SOUND_EVENT_OPTIONS = [
  { key: 'camera:offline', labelKey: 'settings.soundEventCameraOffline' },
  { key: 'camera:lowfps', labelKey: 'settings.soundEventCameraLowfps' },
  { key: 'alert', labelKey: 'settings.soundEventAlert' },
  { key: 'observation', labelKey: 'settings.soundEventDetectRule' },
  { key: 'track:appeared', labelKey: 'settings.soundEventTrackAppeared' },
  { key: 'track:speed', labelKey: 'settings.soundEventTrackSpeed' },
  { key: 'motion', labelKey: 'settings.soundEventMotion' },
] as const

getPref<boolean>('nvr-sound-alert', true).then(v => { soundEnabled.value = v })
getPref<number>('nvr-sound-volume', 80).then(v => { soundVolume.value = v })
getPref<string[]>('nvr-sound-events', []).then(v => { soundEvents.value = v })

function onSoundToggle() {
  setPref('nvr-sound-alert', soundEnabled.value)
}
function onVolumeChange() {
  setPref('nvr-sound-volume', soundVolume.value)
}
function onSoundEventToggle() {
  setPref('nvr-sound-events', soundEvents.value)
}
function toggleSoundEvent(key: string) {
  const idx = soundEvents.value.indexOf(key)
  if (idx >= 0) {
    soundEvents.value.splice(idx, 1)
  } else {
    soundEvents.value.push(key)
  }
  onSoundEventToggle()
}

/** 运行时设置 */
interface RuntimeSettings {
  language: string
  motion: {
    threshold: number
    cooldown: number
    compareWidth: number
    compareHeight: number
  }
  ai: {
    llm: {
      enabled: boolean
      apiUrl: string
      model: string
      maxTokens: number
      interval: number
      imageWidth: number
      systemPrompt: string
    }
    models: Array<{
      id: string
      name: string
      apiUrl: string
      model: string
      maxTokens: number
    }>
    clip: {
      enabled: boolean
      model: string
      embeddingDim: number
    }
  }
  recording: {
    mode: string
    postMotionDuration: number
    retentionDays: number
    segmentDuration: number
    eventPreMs: number
    eventPostMs: number
    bufferDurationMs: number
    watermark: {
      enabled: boolean
      namePosition: string
      timePosition: string
      fontSize: number
    }
  }
  cameraOverrides: Record<string, {
    motionThreshold?: number
    motionCooldown?: number
    detectFps?: number
  }>
  webhook: {
    urls: string[]
  }
  notify: {
    dingtalk: {
      enabled: boolean
      webhookUrl: string
      secret: string
    }
    email: {
      enabled: boolean
      smtp: {
        host: string
        port: number
        secure: boolean
        user: string
        pass: string
      } | null
      from: string
      to: string
    }
  }
  cleanup: {
    eventsRetentionDays: number
    alertsRetentionDays: number
    snapshotsRetentionDays: number
    thumbnailsRetentionDays: number
  }
}

const settings = ref<RuntimeSettings | null>(null)
const saving = ref(false)
const success = ref(false)

/** 摄像头列表（用于 per-camera 配置） */
const cameraList = ref<Array<{ id: string; name: string }>>([])

/** 加载设置 */
async function loadSettings() {
  try {
    const res = await authFetch('/api/settings')
    if (res.ok) {
      const data = await res.json()
      /** 确保 smtp 非空，避免模板中 smtp! 崩溃 */
      if (!data.notify?.email?.smtp) {
        if (!data.notify) data.notify = {}
        if (!data.notify.email) data.notify.email = { enabled: false, smtp: null, from: '', to: '' }
        data.notify.email.smtp = { host: '', port: 465, secure: true, user: '', pass: '' }
      }
      /** 确保 models 数组和 llm 配置存在 */
      if (!data.ai?.models) {
        if (!data.ai) data.ai = {} as RuntimeSettings['ai']
        data.ai.models = []
      }
      if (!data.ai.llm) {
        data.ai.llm = { enabled: false, apiUrl: '', model: '', maxTokens: 150, interval: 5000, imageWidth: 640, systemPrompt: '' }
      }
      settings.value = data
    }
  } catch {
    toast.error(t('settings.loadFailed'))
  }
}

/** 保存设置 */
async function saveSettings() {
  if (!settings.value) return
  saving.value = true
  success.value = false
  try {
    const res = await authFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings.value),
    })
    if (res.ok) {
      settings.value = await res.json()
      success.value = true
      emit('saved')
      if (successTimer) clearTimeout(successTimer)
      successTimer = setTimeout(() => { success.value = false }, 2000)
    }
  } catch {
    toast.error(t('settings.saveFailed'))
  } finally {
    saving.value = false
  }
}

/** 添加 Webhook URL */
function addWebhook() {
  if (!settings.value) return
  settings.value.webhook.urls.push('')
}

/** 移除 Webhook URL */
function removeWebhook(index: number) {
  if (!settings.value) return
  settings.value.webhook.urls.splice(index, 1)
}

/** 多模型管理 */
function addModel() {
  if (!settings.value) return
  if (!settings.value.ai.models) settings.value.ai.models = []
  const idx = settings.value.ai.models.length
  settings.value.ai.models.push({
    id: `model_${idx}`,
    name: '',
    apiUrl: '',
    model: '',
    maxTokens: 150,
  })
}

function removeModel(index: number) {
  if (!settings.value) return
  settings.value.ai.models.splice(index, 1)
}

/** CLIP 候选标签管理 */
const clipCandidates = ref<Record<string, string[]>>({})
const clipCandidatesLoaded = ref(false)
const clipCandidatesSaving = ref(false)
/** 新标签输入状态 */
const newCandidateLabel = ref('')
const newCandidateText = ref('')

async function loadClipCandidates() {
  try {
    const res = await authFetch('/api/clip-candidates')
    if (res.ok) {
      clipCandidates.value = await res.json()
      clipCandidatesLoaded.value = true
    }
  } catch {
    toast.error(t('settings.loadFailed'))
  }
}

async function saveClipCandidates() {
  clipCandidatesSaving.value = true
  try {
    await authFetch('/api/clip-candidates', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clipCandidates.value),
    })
    toast.success(t('settings.clipCandidatesSaved', '候选标签已保存'))
  } catch {
    toast.error(t('settings.clipCandidatesSaveFailed', '保存失败'))
  } finally {
    clipCandidatesSaving.value = false
  }
}

/** 添加新的候选类别 */
function addCandidateCategory() {
  const label = newCandidateLabel.value.trim()
  if (!label || clipCandidates.value[label]) return
  clipCandidates.value[label] = ['a ' + label]
  newCandidateLabel.value = ''
}

/** 删除候选类别 */
function removeCandidateCategory(label: string) {
  delete clipCandidates.value[label]
  /** 触发响应式更新 */
  clipCandidates.value = { ...clipCandidates.value }
}

/** 在某类别中添加候选标签 */
function addCandidateText(label: string) {
  const text = newCandidateText.value.trim()
  if (!text) return
  const list = clipCandidates.value[label]
  if (!list) return
  list.push(text)
  newCandidateText.value = ''
}

/** 在某类别中删除候选标签 */
function removeCandidateText(label: string, index: number) {
  const list = clipCandidates.value[label]
  if (!list) return
  list.splice(index, 1)
  if (list.length === 0) {
    removeCandidateCategory(label)
  }
}

/** 加载摄像头列表（用于 per-camera 灵敏度配置） */
const clipCandidateActions = { saveClipCandidates, addCandidateCategory, addCandidateText, removeCandidateText }
void clipCandidateActions

async function loadCameras() {
  try {
    const res = await authFetch('/api/cameras')
    if (res.ok) {
      const data = await res.json()
      cameraList.value = data.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name }))
    }
  } catch {
    toast.error(t('settings.loadFailed'))
  }
}

/** 设置摄像头级别覆盖参数 */
function setCameraOverride(cameraId: string, field: 'motionThreshold' | 'motionCooldown' | 'detectFps', rawValue: string) {
  if (!settings.value) return
  if (!settings.value.cameraOverrides[cameraId]) {
    settings.value.cameraOverrides[cameraId] = {}
  }
  const override = settings.value.cameraOverrides[cameraId]!
  if (rawValue === '') {
    delete override[field]
    /** 如果 override 对象为空，删除整个条目 */
    if (Object.keys(override).length === 0) {
      delete settings.value.cameraOverrides[cameraId]
    }
  } else {
    const num = Number(rawValue)
    if (!isNaN(num)) override[field] = num
  }
}

/** 手动触发清理 */
async function runCleanup() {
  try {
    const res = await authFetch('/api/cleanup/run', { method: 'POST' })
    if (res.ok) {
      const report = await res.json()
      const total = (report.events ?? 0) + (report.alerts ?? 0) + (report.snapshots ?? 0)
      toast.success(t('settings.cleanupDone', { count: total }))
    }
    loadCleanupStats()
  } catch {
    toast.error(t('settings.saveFailed'))
  }
}

/** 清理统计（含磁盘压力） */
const cleanupStats = ref<{ diskPressure: string; diskUsedPercent: number } | null>(null)

async function loadCleanupStats() {
  try {
    const res = await authFetch('/api/cleanup/stats')
    if (res.ok) cleanupStats.value = await res.json()
  } catch {
    toast.error(t('settings.loadFailed'))
  }
}

/** 一键清除数据 */
const purgeOpts = reactive({
  events: false,
  alerts: false,
  snapshots: false,
  alertSnapshots: false,
  tracks: false,
  trajectories: false,
  thumbnails: false,
  exports: false,
  recordings: false,
})
const purgeBusy = ref(false)
const purgeResult = ref('')
const hasPurgeSelection = computed(() => Object.values(purgeOpts).some(v => v))

async function purgeData() {
  if (!hasPurgeSelection.value) return
  const labels = Object.entries(purgeOpts).filter(([, v]) => v).map(([k]) => {
    const map: Record<string, string> = {
      events: t('settings.purgeEvents'), alerts: t('settings.purgeAlerts'),
      snapshots: t('settings.purgeDetectSnapshots'), alertSnapshots: t('settings.purgeAlertSnapshots'),
      tracks: t('settings.purgeTracks'), trajectories: t('settings.purgeTrajectories'),
      thumbnails: t('settings.purgeThumbnails'), exports: t('settings.purgeExports'),
      recordings: t('settings.purgeRecordings'),
    }
    return map[k]
  })
  if (!confirm(t('settings.purgeConfirm', { items: labels.join('、') }))) return

  purgeBusy.value = true
  purgeResult.value = ''
  try {
    const res = await authFetch('/api/data/purge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(purgeOpts),
    })
    if (res.ok) {
      const data = await res.json() as { results: Record<string, string> }
      purgeResult.value = Object.values(data.results).join('；')
      for (const k of Object.keys(purgeOpts) as Array<keyof typeof purgeOpts>) { purgeOpts[k] = false }
      loadCleanupStats()
    }
  } catch {
    purgeResult.value = t('settings.purgeFailed')
  } finally {
    purgeBusy.value = false
  }
}

onMounted(() => {
  loadSettings()
  loadCameras()
  loadCleanupStats()
  loadClipCandidates()
})

onUnmounted(() => {
  if (successTimer) clearTimeout(successTimer)
})
</script>

<template>
  <div class="settings-panel">
    <div class="panel-header">
      <span>{{ t('settings.title') }}</span>
      <button class="save-btn" @click="saveSettings" :disabled="saving">
        {{ saving ? t('settings.saving') : success ? t('settings.saved') : t('settings.save') }}
      </button>
    </div>

    <div v-if="settings" class="settings-form">
      <!-- 连接 -->
      <section class="section">
        <h3>{{ t('settings.connection') }}</h3>
        <label class="field">
          <span class="field-label">{{ t('settings.backendUrl') }}</span>
          <div class="model-row">
            <input type="url" v-model="backendUrlInput" placeholder="http://localhost:3100" class="input-model" />
            <button class="reload-btn" @click="saveBackendUrl">{{ t('settings.save') }}</button>
          </div>
        </label>
        <label class="field">
          <span class="field-label">{{ t('settings.language') }}</span>
          <select v-model="settings.language" class="input">
            <option value="zh-CN">{{ t('settings.langZh') }}</option>
            <option value="en">English</option>
          </select>
        </label>
      </section>

      <!-- 变动检测 -->
      <section class="section">
        <h3>{{ t('settings.motion') }}</h3>
        <label class="field">
          <span class="field-label">{{ t('settings.motionThreshold') }}</span>
          <input type="number" v-model.number="settings.motion.threshold" step="0.001" min="0.001" max="1" class="input" />
        </label>
        <label class="field">
          <span class="field-label">{{ t('settings.motionCooldown') }}</span>
          <input type="number" v-model.number="settings.motion.cooldown" step="100" min="0" class="input" />
        </label>
      </section>

      <!-- 摄像头灵敏度覆盖 -->
      <section v-if="cameraList.length > 0" class="section">
        <h3>{{ t('settings.cameraSensitivity') }}</h3>
        <div v-for="cam in cameraList" :key="cam.id" class="camera-override">
          <div class="cam-override-header">
            <span class="cam-override-name">{{ cam.name }}</span>
            <button v-if="settings.cameraOverrides[cam.id]" class="reset-cam-btn" @click="delete settings.cameraOverrides[cam.id]">{{ t('settings.cameraReset') }}</button>
          </div>
          <div class="cam-override-fields">
            <label class="field compact">
              <span class="field-label small">{{ t('settings.motionThreshold') }}</span>
              <input type="number" :value="settings.cameraOverrides[cam.id]?.motionThreshold ?? ''" @input="setCameraOverride(cam.id, 'motionThreshold', ($event.target as HTMLInputElement).value)" step="0.001" min="0.001" max="1" class="input small" :placeholder="String(settings.motion.threshold)" />
            </label>
            <label class="field compact">
              <span class="field-label small">{{ t('settings.motionCooldown') }}</span>
              <input type="number" :value="settings.cameraOverrides[cam.id]?.motionCooldown ?? ''" @input="setCameraOverride(cam.id, 'motionCooldown', ($event.target as HTMLInputElement).value)" step="100" min="0" class="input small" :placeholder="String(settings.motion.cooldown)" />
            </label>
            <label class="field compact">
              <span class="field-label small">{{ t('settings.detectFps') }}</span>
              <input type="number" :value="settings.cameraOverrides[cam.id]?.detectFps ?? ''" @input="setCameraOverride(cam.id, 'detectFps', ($event.target as HTMLInputElement).value)" step="1" min="1" max="30" class="input small" />
            </label>
          </div>
        </div>
      </section>

      <!-- AI 视觉分析 -->
      <section class="section">
        <h3>{{ t('settings.ai', 'AI 视觉分析') }}</h3>
        <p class="section-desc">{{ t('settings.vlmDesc') }}</p>

        <!-- 多模型管理 -->
        <div class="models-section">
          <div class="models-header">
            <span class="field-label">{{ t('settings.modelList') }}</span>
            <button class="add-btn compact" @click="addModel">{{ t('settings.addModel') }}</button>
          </div>
          <p class="field-hint">{{ t('settings.modelListHint') }}</p>
          <div v-if="settings.ai.models && settings.ai.models.length > 0" class="model-list">
            <div v-for="(m, i) in settings.ai.models" :key="m.id" class="model-card">
              <div class="model-card-header">
                <span class="model-card-index">#{{ i + 1 }}</span>
                <span v-if="i === 0" class="model-default-badge">{{ t('settings.defaultModel') }}</span>
                <button class="remove-btn" @click="removeModel(i)">✕</button>
              </div>
              <div class="model-card-fields">
                <label class="field compact">
                  <span class="field-label small">ID</span>
                  <input type="text" v-model="m.id" class="input" placeholder="model_0" />
                </label>
                <label class="field compact">
                  <span class="field-label small">{{ t('settings.modelName') }}</span>
                  <input type="text" v-model="m.name" class="input" placeholder="Qwen 3.5" />
                </label>
                <label class="field compact">
                  <span class="field-label small">{{ t('settings.modelApiUrl') }}</span>
                  <input type="url" v-model="m.apiUrl" class="input model-input-wide" placeholder="http://localhost:1234/v1/chat/completions" />
                </label>
                <label class="field compact">
                  <span class="field-label small">{{ t('settings.modelModel') }}</span>
                  <input type="text" v-model="m.model" class="input" placeholder="qwen3.5-0.8b" />
                </label>
                <label class="field compact">
                  <span class="field-label small">Max Tokens</span>
                  <input type="number" v-model.number="m.maxTokens" step="10" min="30" max="4096" class="input" />
                </label>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- 录像 -->
      <section class="section">
        <h3>{{ t('settings.recording') }}</h3>
        <label class="field">
          <span class="field-label">{{ t('settings.recordingMode') }}</span>
          <select v-model="settings.recording.mode" class="input">
            <option value="motion">{{ t('settings.recordingMotion') }}</option>
            <option value="continuous">{{ t('settings.recordingContinuous') }}</option>
            <option value="event">{{ t('settings.recordingEvent', '事件驱动') }}</option>
          </select>
        </label>
        <label v-if="settings.recording.mode === 'motion'" class="field">
          <span class="field-label">{{ t('settings.postMotionDuration') }}</span>
          <input type="number" v-model.number="settings.recording.postMotionDuration" step="1000" min="1000" class="input" />
        </label>
        <label v-if="settings.recording.mode === 'continuous'" class="field">
          <span class="field-label">{{ t('settings.segmentDuration') }}</span>
          <input type="number" v-model.number="settings.recording.segmentDuration" step="60" min="60" max="3600" class="input" />
        </label>
        <template v-if="settings.recording.mode === 'event'">
          <p class="section-desc">{{ t('settings.eventModeDesc', 'AI 检测到有效事件时自动保存前后视频，无事件时数据仅在内存中暂存。') }}</p>
          <label class="field">
            <span class="field-label">{{ t('settings.eventPreMs', '事件前保留') }}</span>
            <input type="number" v-model.number="settings.recording.eventPreMs" step="1000" min="1000" max="120000" class="input" />
            <span class="field-hint">{{ t('settings.eventPreMsHint', '毫秒，建议 10000-30000') }}</span>
          </label>
          <label class="field">
            <span class="field-label">{{ t('settings.eventPostMs', '事件后保留') }}</span>
            <input type="number" v-model.number="settings.recording.eventPostMs" step="1000" min="1000" max="120000" class="input" />
            <span class="field-hint">{{ t('settings.eventPostMsHint', '毫秒，建议 15000-60000') }}</span>
          </label>
          <label class="field">
            <span class="field-label">{{ t('settings.bufferDurationMs', '内存缓冲时长') }}</span>
            <input type="number" v-model.number="settings.recording.bufferDurationMs" step="1000" min="5000" max="120000" class="input" />
            <span class="field-hint">{{ t('settings.bufferDurationMsHint', '毫秒，建议 ≥ eventPreMs') }}</span>
          </label>
        </template>
        <label class="field">
          <span class="field-label">{{ t('settings.retentionDays') }}</span>
          <input type="number" v-model.number="settings.recording.retentionDays" step="1" min="1" max="90" class="input" />
        </label>
        <div class="field watermark-toggle">
          <span class="field-label">{{ t('settings.watermarkEnabled') }}</span>
          <input type="checkbox" v-model="settings.recording.watermark.enabled" />
        </div>
        <template v-if="settings.recording.watermark.enabled">
          <label class="field">
            <span class="field-label">{{ t('settings.watermarkNamePos') }}</span>
            <select v-model="settings.recording.watermark.namePosition" class="input">
              <option value="top-left">↖ {{ t('settings.posTopLeft') }}</option>
              <option value="top-right">↗ {{ t('settings.posTopRight') }}</option>
              <option value="bottom-left">↙ {{ t('settings.posBottomLeft') }}</option>
              <option value="bottom-right">↘ {{ t('settings.posBottomRight') }}</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">{{ t('settings.watermarkTimePos') }}</span>
            <select v-model="settings.recording.watermark.timePosition" class="input">
              <option value="top-left">↖ {{ t('settings.posTopLeft') }}</option>
              <option value="top-right">↗ {{ t('settings.posTopRight') }}</option>
              <option value="bottom-left">↙ {{ t('settings.posBottomLeft') }}</option>
              <option value="bottom-right">↘ {{ t('settings.posBottomRight') }}</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">{{ t('settings.watermarkFontSize') }}</span>
            <input type="number" v-model.number="settings.recording.watermark.fontSize" step="2" min="12" max="48" class="input" />
          </label>
        </template>
      </section>

      <!-- Webhook 通知 -->
      <section class="section">
        <h3>{{ t('settings.webhook') }}</h3>
        <div v-for="(_url, i) in settings.webhook.urls" :key="i" class="field">
          <input
            type="url"
            v-model="settings.webhook.urls[i]"
            placeholder="https://example.com/webhook"
            class="input-url"
          />
          <button class="remove-btn" @click="removeWebhook(i)">✕</button>
        </div>
        <button class="add-btn" @click="addWebhook">{{ t('settings.addWebhook') }}</button>
      </section>

      <!-- 钉钉机器人通知 -->
      <section class="section">
        <h3>{{ t('settings.dingtalk') }}</h3>
        <label class="field">
          <span class="field-label">{{ t('settings.aiEnabled') }}</span>
          <input type="checkbox" v-model="settings.notify.dingtalk.enabled" class="checkbox" />
        </label>
        <label class="field">
          <span class="field-label">{{ t('settings.dingtalkWebhook') }}</span>
          <input
            type="url"
            v-model="settings.notify.dingtalk.webhookUrl"
            placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
            class="input-url"
          />
        </label>
        <label class="field">
          <span class="field-label">{{ t('settings.dingtalkSecret') }}</span>
          <input
            type="text"
            v-model="settings.notify.dingtalk.secret"
            :placeholder="t('settings.dingtalkSecretPlaceholder')"
            class="input-url"
          />
        </label>
      </section>

      <!-- 邮件告警通知 -->
      <section class="section">
        <h3>{{ t('settings.email') }}</h3>
        <label class="field">
          <span class="field-label">{{ t('settings.aiEnabled') }}</span>
          <input type="checkbox" v-model="settings.notify.email.enabled" class="checkbox" />
        </label>
        <div class="field field-col">
          <span class="field-label">{{ t('settings.emailSmtpHost') }}</span>
          <div class="smtp-row">
            <input
              type="text"
              v-model="settings.notify.email.smtp!.host"
              placeholder="smtp.example.com"
              class="input-smtp-host"
            />
            <input
              type="number"
              v-model.number="settings.notify.email.smtp!.port"
              placeholder="465"
              class="input-smtp-port"
            />
            <label class="secure-label">
              <input type="checkbox" v-model="settings.notify.email.smtp!.secure" class="checkbox" />
              <span>{{ t('settings.emailSmtpSsl') }}</span>
            </label>
          </div>
        </div>
        <label class="field">
          <span class="field-label">{{ t('settings.emailUser') }}</span>
          <input
            type="text"
            v-model="settings.notify.email.smtp!.user"
            placeholder="user@example.com"
            class="input-url"
          />
        </label>
        <label class="field">
          <span class="field-label">{{ t('settings.emailPass') }}</span>
          <input
            type="password"
            v-model="settings.notify.email.smtp!.pass"
            :placeholder="t('settings.emailPass')"
            class="input-url"
          />
        </label>
        <label class="field">
          <span class="field-label">{{ t('settings.emailFrom') }}</span>
          <input
            type="text"
            v-model="settings.notify.email.from"
            :placeholder="t('settings.emailFromPlaceholder')"
            class="input-url"
          />
        </label>
        <label class="field">
          <span class="field-label">{{ t('settings.emailTo') }}</span>
          <input
            type="text"
            v-model="settings.notify.email.to"
            :placeholder="t('settings.emailToPlaceholder')"
            class="input-url"
          />
        </label>
      </section>

      <!-- 数据清理 -->
      <section class="section">
        <h3>{{ t('settings.cleanup') }}</h3>
        <div v-if="cleanupStats" class="disk-pressure" :class="cleanupStats.diskPressure">
          <span class="pressure-dot"></span>
          <span>{{ t('settings.diskUsage', '磁盘使用') }}: {{ cleanupStats.diskUsedPercent }}%</span>
          <span v-if="cleanupStats.diskPressure !== 'normal'" class="pressure-hint">
            {{ t('settings.diskPressureHint', '自动缩短保留天数') }}
          </span>
        </div>
        <label class="field">
          <span class="field-label">{{ t('settings.eventsRetention') }}</span>
          <input type="number" v-model.number="settings.cleanup.eventsRetentionDays" step="1" min="1" max="365" class="input" />
        </label>
        <label class="field">
          <span class="field-label">{{ t('settings.alertsRetention') }}</span>
          <input type="number" v-model.number="settings.cleanup.alertsRetentionDays" step="1" min="1" max="365" class="input" />
        </label>
        <label class="field">
          <span class="field-label">{{ t('settings.snapshotsRetention') }}</span>
          <input type="number" v-model.number="settings.cleanup.snapshotsRetentionDays" step="1" min="1" max="90" class="input" />
        </label>
        <label class="field">
          <span class="field-label">{{ t('settings.thumbnailsRetention') }}</span>
          <input type="number" v-model.number="settings.cleanup.thumbnailsRetentionDays" step="1" min="1" max="30" class="input" />
        </label>
        <button class="add-btn" @click="runCleanup">{{ t('settings.runCleanup') }}</button>

        <!-- 一键清除数据 -->
        <div class="purge-section">
          <h4>{{ t('settings.purgeTitle', '一键清除数据') }}</h4>
          <p class="section-desc danger">{{ t('settings.purgeWarning', '以下操作不可恢复，请谨慎使用！') }}</p>
          <div class="purge-options">
            <label class="purge-check"><input type="checkbox" v-model="purgeOpts.events" /> {{ t('settings.purgeEvents') }}</label>
            <label class="purge-check"><input type="checkbox" v-model="purgeOpts.alerts" /> {{ t('settings.purgeAlerts') }}</label>
            <label class="purge-check"><input type="checkbox" v-model="purgeOpts.snapshots" /> {{ t('settings.purgeDetectSnapshots') }}</label>
            <label class="purge-check"><input type="checkbox" v-model="purgeOpts.alertSnapshots" /> {{ t('settings.purgeAlertSnapshots') }}</label>
            <label class="purge-check"><input type="checkbox" v-model="purgeOpts.tracks" /> {{ t('settings.purgeTracks') }}</label>
            <label class="purge-check"><input type="checkbox" v-model="purgeOpts.trajectories" /> {{ t('settings.purgeTrajectories') }}</label>
            <label class="purge-check"><input type="checkbox" v-model="purgeOpts.thumbnails" /> {{ t('settings.purgeThumbnails') }}</label>
            <label class="purge-check"><input type="checkbox" v-model="purgeOpts.exports" /> {{ t('settings.purgeExports') }}</label>
            <label class="purge-check danger"><input type="checkbox" v-model="purgeOpts.recordings" /> {{ t('settings.purgeRecordings') }}</label>
          </div>
          <button class="purge-btn" @click="purgeData" :disabled="purgeBusy || !hasPurgeSelection">
            {{ purgeBusy ? t('settings.purgeBusy') : t('settings.purgeSelected') }}
          </button>
          <span v-if="purgeResult" class="purge-result">{{ purgeResult }}</span>
        </div>
      </section>

      <!-- 声音提醒 -->
      <section class="section">
        <h3>{{ t('settings.soundAlert') }}</h3>
        <label class="field">
          <span class="field-label">{{ t('settings.soundEnabled') }}</span>
          <input type="checkbox" v-model="soundEnabled" class="checkbox" @change="onSoundToggle" />
        </label>
        <label v-if="soundEnabled" class="field">
          <span class="field-label">{{ t('settings.soundVolume') }}</span>
          <div class="volume-row">
            <input type="range" v-model.number="soundVolume" min="0" max="100" step="5" class="volume-slider" @input="onVolumeChange" />
            <span class="volume-val">{{ soundVolume }}%</span>
          </div>
        </label>
        <div v-if="soundEnabled" class="field field-col sound-events">
          <span class="field-label">{{ t('settings.soundTriggerEvents', '触发事件') }}</span>
          <span class="field-hint">{{ t('settings.soundTriggerHint', '不选则所有事件都触发声音') }}</span>
          <div class="sound-event-chips">
            <button
              v-for="opt in SOUND_EVENT_OPTIONS"
              :key="opt.key"
              :class="['event-chip', { active: soundEvents.includes(opt.key) }]"
              @click="toggleSoundEvent(opt.key)"
            >{{ t(opt.labelKey) }}</button>
          </div>
        </div>
      </section>
    </div>
    <div v-else class="empty">{{ t('settings.loading') }}</div>
  </div>
</template>

<style scoped>
.settings-panel {
  background: #1a1a2e;
  border-radius: 0 0 8px 8px;
  border: 1px solid #2a2a4a;
  border-top: none;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.panel-header {
  padding: 10px 12px;
  background: #1a1a2e;
  border-bottom: 1px solid #2a2a4a;
  color: #e0e0e0;
  font-weight: 600;
  font-size: 14px;
  display: flex;
  align-items: center;
}

.save-btn {
  margin-left: auto;
  background: #2a2a4a;
  color: #4ECDC4;
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  font-weight: 600;
}

.save-btn:hover {
  background: #3a3a5a;
}

.save-btn:disabled {
  opacity: 0.5;
}

.settings-form {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.section {
  margin-bottom: 16px;
}

.section h3 {
  font-size: 13px;
  font-weight: 600;
  color: #888;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.disk-pressure {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  margin-bottom: 8px;
  border-radius: 4px;
  font-size: 12px;
  background: #1a2a1a;
  color: #4CAF50;
}

.disk-pressure.warning {
  background: #2a2a1a;
  color: #FFC107;
}

.disk-pressure.critical {
  background: #2a1a1a;
  color: #e74c3c;
  animation: pressure-blink 1s infinite;
}

.pressure-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

.pressure-hint {
  margin-left: auto;
  font-size: 10px;
  opacity: 0.7;
}

@keyframes pressure-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

.field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
}

.field-label {
  font-size: 13px;
  color: #ccc;
}

.input {
  width: 80px;
  background: #0a0a1a;
  color: #e0e0e0;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 13px;
  text-align: right;
}

.input:focus {
  outline: none;
  border-color: #4ECDC4;
}

.checkbox {
  width: 16px;
  height: 16px;
  accent-color: #4ECDC4;
}

.input-url {
  flex: 1;
  background: #0a0a1a;
  color: #e0e0e0;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
}

.input-url:focus {
  outline: none;
  border-color: #4ECDC4;
}

.remove-btn {
  background: transparent;
  color: #e74c3c;
  border: none;
  font-size: 14px;
  cursor: pointer;
  padding: 2px 6px;
}

.remove-btn:hover {
  color: #ff6b6b;
}

.add-btn {
  background: transparent;
  color: #4ECDC4;
  border: 1px dashed #4ECDC4;
  border-radius: 4px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  width: 100%;
  margin-top: 4px;
}

.add-btn:hover {
  background: #1a2a2e;
}

.field-col {
  flex-direction: column;
  align-items: flex-start;
}

.model-row {
  display: flex;
  gap: 6px;
  width: 100%;
  margin-top: 4px;
}

.input-model {
  flex: 1;
  background: #0a0a1a;
  color: #e0e0e0;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  font-family: monospace;
}

.input-model:focus {
  outline: none;
  border-color: #4ECDC4;
}

.reload-btn {
  background: #2a2a4a;
  color: #4ECDC4;
  border: none;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.reload-btn:hover {
  background: #3a3a5a;
}

.reload-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.model-status {
  font-size: 11px;
  color: #666;
  margin-top: 2px;
}

.model-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
  margin-bottom: 4px;
}

.preset-btn {
  background: #16213e;
  color: #aaa;
  border: 1px solid #2a2a4a;
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}

.preset-btn:hover {
  border-color: #4ECDC4;
  color: #4ECDC4;
}

.preset-btn.active {
  background: #4ECDC4;
  color: #1a1a2e;
  border-color: #4ECDC4;
  font-weight: 600;
}

.smtp-row {
  display: flex;
  gap: 6px;
  width: 100%;
  margin-top: 4px;
  align-items: center;
}

.input-smtp-host {
  flex: 1;
  background: #0a0a1a;
  color: #e0e0e0;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
}

.input-smtp-host:focus {
  outline: none;
  border-color: #4ECDC4;
}

.input-smtp-port {
  width: 60px;
  background: #0a0a1a;
  color: #e0e0e0;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  text-align: right;
}

.input-smtp-port:focus {
  outline: none;
  border-color: #4ECDC4;
}

.secure-label {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #ccc;
  font-size: 12px;
  white-space: nowrap;
}

.watermark-toggle input[type="checkbox"] {
  accent-color: #4ECDC4;
  width: 16px;
  height: 16px;
  cursor: pointer;
}

/* 摄像头灵敏度覆盖 */
.camera-override {
  background: #16213e;
  border-radius: 4px;
  padding: 8px;
  margin-bottom: 6px;
  border: 1px solid #2a2a4a;
}

.cam-override-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.cam-override-name {
  font-size: 12px;
  color: #e0e0e0;
  font-weight: 500;
}

.reset-cam-btn {
  margin-left: auto;
  background: none;
  border: 1px solid #555;
  color: #888;
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 10px;
  cursor: pointer;
}

.reset-cam-btn:hover {
  border-color: #e74c3c;
  color: #e74c3c;
}

.cam-override-fields {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.field.compact {
  padding: 2px 0;
  gap: 4px;
}

.field-label.small {
  font-size: 11px;
  min-width: 40px;
}

.input.small {
  width: 60px;
  font-size: 11px;
  padding: 2px 6px;
}

.volume-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.volume-slider {
  width: 100px;
  accent-color: #4ECDC4;
  cursor: pointer;
}

.volume-val {
  font-size: 12px;
  color: #aaa;
  min-width: 36px;
  text-align: right;
}

.sound-events {
  gap: 6px;
}

.field-hint {
  font-size: 11px;
  color: #666;
}

.section-desc {
  font-size: 12px;
  color: #888;
  margin: 0 0 8px 0;
}

.textarea {
  resize: vertical;
  min-height: 60px;
  font-family: inherit;
}

.sound-event-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}

.event-chip {
  background: #16213e;
  color: #888;
  border: 1px solid #2a2a4a;
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}

.event-chip:hover {
  border-color: #4ECDC4;
  color: #4ECDC4;
}

.event-chip.active {
  background: #4ECDC4;
  color: #1a1a2e;
  border-color: #4ECDC4;
  font-weight: 600;
}

.models-section {
  margin-top: 12px;
}

.models-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.add-btn.compact {
  width: auto;
  margin-top: 0;
  padding: 3px 10px;
  font-size: 11px;
}

.model-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.model-card {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid #2a2a4a;
  border-radius: 6px;
  padding: 8px 10px;
}

.model-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.model-card-index {
  font-size: 12px;
  font-weight: 600;
  color: #888;
}

.model-default-badge {
  font-size: 10px;
  background: rgba(78, 205, 196, 0.15);
  color: #4ECDC4;
  border: 1px solid rgba(78, 205, 196, 0.3);
  border-radius: 3px;
  padding: 1px 6px;
}

.model-card-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}

.model-card-fields .field {
  flex: 1 1 calc(50% - 6px);
  min-width: 140px;
}

.model-input-wide {
  width: 100% !important;
  text-align: left;
}

.clip-candidates {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.candidate-categories {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 400px;
  overflow-y: auto;
}

.candidate-category {
  background: rgba(255,255,255,0.03);
  border: 1px solid #2a2a4a;
  border-radius: 6px;
  padding: 8px 10px;
}

.category-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.category-label {
  font-weight: 600;
  color: #4ECDC4;
  font-size: 13px;
}

.candidate-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}

.candidate-tag {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  background: rgba(78, 205, 196, 0.1);
  border: 1px solid rgba(78, 205, 196, 0.3);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  color: #e0e0e0;
}

.tag-remove {
  background: none;
  border: none;
  color: #ff6b6b;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
}

.tag-remove:hover {
  color: #ff4444;
}

.add-candidate-row,
.add-category-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.add-candidate-row .input,
.add-category-row .input {
  flex: 1;
}

.btn-sm {
  background: #2a2a4a;
  color: #e0e0e0;
  border: 1px solid #3a3a5a;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.btn-sm:hover {
  background: #3a3a5a;
}

.btn-icon.btn-danger {
  background: none;
  border: none;
  color: #ff6b6b;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 0 4px;
}

.btn-icon.btn-danger:hover {
  color: #ff4444;
}

.btn-save-candidates {
  background: #4ECDC4;
  color: #1a1a2e;
  border: none;
  border-radius: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  align-self: flex-start;
  margin-top: 4px;
}

.btn-save-candidates:hover {
  background: #3dbdb5;
}

.btn-save-candidates:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.purge-section {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid #2a2a4a;
}

.purge-section h4 {
  color: #ff6b6b;
  font-size: 13px;
  margin: 0 0 6px;
}

.purge-section .section-desc.danger {
  color: #ff9999;
  font-size: 11px;
  margin: 0 0 8px;
}

.purge-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 12px;
  margin-bottom: 8px;
}

.purge-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #bbb;
  cursor: pointer;
}

.purge-check.danger {
  color: #ff6b6b;
  font-weight: 600;
}

.purge-btn {
  width: 100%;
  padding: 6px;
  background: #cc3333;
  color: #fff;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.purge-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.purge-btn:hover:not(:disabled) {
  background: #dd4444;
}

.purge-result {
  display: block;
  margin-top: 6px;
  font-size: 11px;
  color: #4ade80;
}
</style>
