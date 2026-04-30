<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { authFetch } from '../services/auth'

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
    postMotionDuration: number
    retentionDays: number
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

/** 加载设置 */
async function loadSettings() {
  try {
    const res = await authFetch('/api/settings')
    if (res.ok) settings.value = await res.json()
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
      alert(`模型加载失败: ${result.error ?? '未知错误'}`)
    }
  } catch {
    alert('模型加载请求失败')
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

/** 手动触发清理 */
async function runCleanup() {
  try {
    const res = await authFetch('/api/cleanup/run', { method: 'POST' })
    if (res.ok) {
      const report = await res.json()
      const total = (report.events ?? 0) + (report.alerts ?? 0) + (report.snapshots ?? 0)
      alert(`清理完成: ${total} 条记录已删除`)
    }
  } catch {
    // ignore
  }
}

onMounted(() => {
  loadSettings()
  loadModelInfo()
})
</script>

<template>
  <div class="settings-panel">
    <div class="panel-header">
      <span>设置</span>
      <button class="save-btn" @click="saveSettings" :disabled="saving">
        {{ saving ? '保存中...' : success ? '已保存' : '保存' }}
      </button>
    </div>

    <div v-if="settings" class="settings-form">
      <!-- 变动检测 -->
      <section class="section">
        <h3>变动检测</h3>
        <label class="field">
          <span class="field-label">阈值 (0-1)</span>
          <input type="number" v-model.number="settings.motion.threshold" step="0.001" min="0.001" max="1" class="input" />
        </label>
        <label class="field">
          <span class="field-label">冷却间隔 (ms)</span>
          <input type="number" v-model.number="settings.motion.cooldown" step="100" min="0" class="input" />
        </label>
      </section>

      <!-- AI 检测 -->
      <section class="section">
        <h3>AI 目标检测</h3>
        <label class="field">
          <span class="field-label">启用</span>
          <input type="checkbox" v-model="settings.ai.enabled" class="checkbox" />
        </label>
        <div class="field field-col">
          <span class="field-label">检测模型</span>
          <div class="model-row">
            <input
              type="text"
              v-model="settings.ai.model"
              placeholder="Xenova/detr-resnet-50"
              class="input-model"
            />
            <button class="reload-btn" @click="reloadModel" :disabled="modelReloading">
              {{ modelReloading ? '加载中...' : '重载' }}
            </button>
          </div>
          <span v-if="modelInfo" class="model-status">
            {{ modelInfo.loading ? '加载中...' : modelInfo.initialized ? `当前: ${modelInfo.model}` : '未初始化' }}
          </span>
        </div>
        <label class="field">
          <span class="field-label">置信度阈值</span>
          <input type="number" v-model.number="settings.ai.threshold" step="0.05" min="0.1" max="1" class="input" />
        </label>
        <label class="field">
          <span class="field-label">最大检测数</span>
          <input type="number" v-model.number="settings.ai.maxDetections" step="1" min="1" max="100" class="input" />
        </label>
      </section>

      <!-- 录像 -->
      <section class="section">
        <h3>录像</h3>
        <label class="field">
          <span class="field-label">运动后延时 (ms)</span>
          <input type="number" v-model.number="settings.recording.postMotionDuration" step="1000" min="1000" class="input" />
        </label>
        <label class="field">
          <span class="field-label">保留天数</span>
          <input type="number" v-model.number="settings.recording.retentionDays" step="1" min="1" max="90" class="input" />
        </label>
      </section>

      <!-- Webhook 通知 -->
      <section class="section">
        <h3>Webhook 通知</h3>
        <div v-for="(_url, i) in settings.webhook.urls" :key="i" class="field">
          <input
            type="url"
            v-model="settings.webhook.urls[i]"
            placeholder="https://example.com/webhook"
            class="input-url"
          />
          <button class="remove-btn" @click="removeWebhook(i)">✕</button>
        </div>
        <button class="add-btn" @click="addWebhook">+ 添加 Webhook</button>
      </section>

      <!-- 钉钉机器人通知 -->
      <section class="section">
        <h3>钉钉机器人通知</h3>
        <label class="field">
          <span class="field-label">启用</span>
          <input type="checkbox" v-model="settings.notify.dingtalk.enabled" class="checkbox" />
        </label>
        <label class="field">
          <span class="field-label">Webhook URL</span>
          <input
            type="url"
            v-model="settings.notify.dingtalk.webhookUrl"
            placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
            class="input-url"
          />
        </label>
        <label class="field">
          <span class="field-label">加签密钥</span>
          <input
            type="text"
            v-model="settings.notify.dingtalk.secret"
            placeholder="SEC...（可选）"
            class="input-url"
          />
        </label>
      </section>

      <!-- 数据清理 -->
      <section class="section">
        <h3>数据清理</h3>
        <label class="field">
          <span class="field-label">事件保留天数</span>
          <input type="number" v-model.number="settings.cleanup.eventsRetentionDays" step="1" min="1" max="365" class="input" />
        </label>
        <label class="field">
          <span class="field-label">告警保留天数</span>
          <input type="number" v-model.number="settings.cleanup.alertsRetentionDays" step="1" min="1" max="365" class="input" />
        </label>
        <label class="field">
          <span class="field-label">快照保留天数</span>
          <input type="number" v-model.number="settings.cleanup.snapshotsRetentionDays" step="1" min="1" max="90" class="input" />
        </label>
        <label class="field">
          <span class="field-label">缩略图缓存天数</span>
          <input type="number" v-model.number="settings.cleanup.thumbnailsRetentionDays" step="1" min="1" max="30" class="input" />
        </label>
        <button class="add-btn" @click="runCleanup">立即清理</button>
      </section>
    </div>
    <div v-else class="empty">加载中...</div>
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
</style>
