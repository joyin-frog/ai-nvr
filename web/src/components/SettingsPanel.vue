<script setup lang="ts">
import { ref, onMounted } from 'vue'

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
}

const settings = ref<RuntimeSettings | null>(null)
const saving = ref(false)
const success = ref(false)

/** 加载设置 */
async function loadSettings() {
  try {
    const res = await fetch('/api/settings')
    if (res.ok) settings.value = await res.json()
  } catch {
    // ignore
  }
}

/** 保存设置 */
async function saveSettings() {
  if (!settings.value) return
  saving.value = true
  success.value = false
  try {
    const res = await fetch('/api/settings', {
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

onMounted(() => {
  loadSettings()
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
</style>
