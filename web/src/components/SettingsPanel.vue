<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { authFetch } from '../services/auth'

const { t } = useI18n()

/** 运行时设置 */
interface RuntimeSettings {
  motion: {
    threshold: number
    cooldown: number
    compareWidth: number
    compareHeight: number
  }
  ai: {
    enabled: boolean
    model: string
    threshold: number
    maxDetections: number
  }
  recording: {
    mode: string
    postMotionDuration: number
    retentionDays: number
    segmentDuration: number
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
const modelReloading = ref(false)
const modelInfo = ref<{ model: string; loading: boolean; initialized: boolean } | null>(null)

/** 摄像头列表（用于 per-camera 配置） */
const cameraList = ref<Array<{ id: string; name: string }>>([])

/** 加载设置 */
async function loadSettings() {
  try {
    const res = await authFetch('/api/settings')
    if (res.ok) {
      settings.value = await res.json()
      /** 确保 email.smtp 有默认值，避免模板中 null 引用 */
      if (settings.value && !settings.value.notify.email.smtp) {
        settings.value.notify.email.smtp = { host: '', port: 465, secure: true, user: '', pass: '' }
      }
      /** 确保 watermark 有默认值（向后兼容旧版后端） */
      if (settings.value && !settings.value.recording.watermark) {
        settings.value.recording.watermark = { enabled: true, namePosition: 'top-left', timePosition: 'bottom-left', fontSize: 24 }
      }
    }
  } catch {
    // ignore
  }
}

/** 加载模型信息 */
async function loadModelInfo() {
  try {
    const res = await authFetch('/api/ai/model')
    if (res.ok) modelInfo.value = await res.json()
  } catch {
    // ignore
  }
}

/** 重新加载 AI 模型 */
async function reloadModel() {
  if (!settings.value) return
  modelReloading.value = true
  try {
    const res = await authFetch('/api/ai/reload-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: settings.value.ai.model }),
    })
    const result = await res.json()
    if (result.ok) {
      modelInfo.value = { model: result.model, loading: false, initialized: true }
      success.value = true
      setTimeout(() => { success.value = false }, 2000)
    } else {
      alert(t('settings.modelLoadFailed', { error: result.error ?? 'Unknown' }))
    }
  } catch {
    alert(t('settings.modelLoadError'))
  } finally {
    modelReloading.value = false
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
      setTimeout(() => { success.value = false }, 2000)
    }
  } catch {
    // ignore
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

/** 加载摄像头列表（用于 per-camera 灵敏度配置） */
async function loadCameras() {
  try {
    const res = await authFetch('/api/cameras')
    if (res.ok) {
      const data = await res.json()
      cameraList.value = data.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name }))
    }
  } catch {
    // ignore
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
      alert(t('settings.cleanupDone', { count: total }))
    }
  } catch {
    // ignore
  }
}

onMounted(() => {
  loadSettings()
  loadModelInfo()
  loadCameras()
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

      <!-- AI 检测 -->
      <section class="section">
        <h3>{{ t('settings.ai') }}</h3>
        <label class="field">
          <span class="field-label">{{ t('settings.aiEnabled') }}</span>
          <input type="checkbox" v-model="settings.ai.enabled" class="checkbox" />
        </label>
        <div class="field field-col">
          <span class="field-label">{{ t('settings.aiModel') }}</span>
          <div class="model-row">
            <input
              type="text"
              v-model="settings.ai.model"
              placeholder="Xenova/detr-resnet-50"
              class="input-model"
            />
            <button class="reload-btn" @click="reloadModel" :disabled="modelReloading">
              {{ modelReloading ? t('settings.aiModelLoading') : t('settings.aiModelReload') }}
            </button>
          </div>
          <span v-if="modelInfo" class="model-status">
            {{ modelInfo.loading ? t('settings.aiModelLoading') : modelInfo.initialized ? t('settings.aiModelCurrent', { model: modelInfo.model }) : t('settings.aiModelNotInit') }}
          </span>
        </div>
        <label class="field">
          <span class="field-label">{{ t('settings.aiThreshold') }}</span>
          <input type="number" v-model.number="settings.ai.threshold" step="0.05" min="0.1" max="1" class="input" />
        </label>
        <label class="field">
          <span class="field-label">{{ t('settings.aiMaxDetections') }}</span>
          <input type="number" v-model.number="settings.ai.maxDetections" step="1" min="1" max="100" class="input" />
        </label>
      </section>

      <!-- 录像 -->
      <section class="section">
        <h3>{{ t('settings.recording') }}</h3>
        <label class="field">
          <span class="field-label">{{ t('settings.recordingMode') }}</span>
          <select v-model="settings.recording.mode" class="input">
            <option value="motion">{{ t('settings.recordingMotion') }}</option>
            <option value="continuous">{{ t('settings.recordingContinuous') }}</option>
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

.empty {
  color: #555;
  text-align: center;
  padding: 20px;
  font-size: 13px;
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
</style>
