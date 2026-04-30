<script setup lang="ts">
import { ref, onMounted } from 'vue'

/** 告警规则 */
interface AlertRule {
  id: number
  name: string
  eventType: string
  cameraId: string
  labels: string
  windowSeconds: number
  threshold: number
  cooldownSeconds: number
  enabled: boolean
}

/** 告警记录 */
interface AlertRecord {
  id: number
  ruleId: number
  ruleName: string
  cameraId: string
  timestamp: number
  detail: string
}

const rules = ref<AlertRule[]>([])
const alerts = ref<AlertRecord[]>([])
const loading = ref(false)

/** 显示添加表单 */
const showAddForm = ref(false)
const form = ref({
  name: '',
  eventType: 'detect',
  cameraId: '',
  labels: '',
  windowSeconds: 60,
  threshold: 3,
  cooldownSeconds: 300,
})

/** 事件类型选项 */
const eventTypes = [
  { value: 'detect', label: 'AI 检测' },
  { value: 'motion', label: '变动检测' },
  { value: 'camera:offline', label: '摄像头离线' },
]

/** 加载规则列表 */
async function loadRules() {
  loading.value = true
  try {
    const res = await fetch('/api/alerts/rules')
    if (res.ok) rules.value = await res.json()
  } catch {
    // ignore
  } finally {
    loading.value = false
  }
}

/** 加载告警历史 */
async function loadAlerts() {
  try {
    const res = await fetch('/api/alerts/history?limit=50')
    if (res.ok) {
      const data = await res.json()
      alerts.value = data.alerts
    }
  } catch {
    // ignore
  }
}

/** 添加规则 */
async function addRule() {
  if (!form.value.name || !form.value.eventType) return
  try {
    const res = await fetch('/api/alerts/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form.value),
    })
    if (res.ok) {
      showAddForm.value = false
      form.value = { name: '', eventType: 'detect', cameraId: '', labels: '', windowSeconds: 60, threshold: 3, cooldownSeconds: 300 }
      loadRules()
    }
  } catch {
    // ignore
  }
}

/** 切换启用 */
async function toggleRule(rule: AlertRule) {
  try {
    await fetch(`/api/alerts/rules/${rule.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !rule.enabled }),
    })
    loadRules()
  } catch {
    // ignore
  }
}

/** 删除规则 */
async function deleteRule(id: number) {
  try {
    await fetch(`/api/alerts/rules/${id}`, { method: 'DELETE' })
    loadRules()
  } catch {
    // ignore
  }
}

/** 格式化时间 */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN')
}

/** 事件类型中文 */
function eventTypeLabel(type: string): string {
  return eventTypes.find(e => e.value === type)?.label ?? type
}

/** Tab 切换 */
const activeView = ref<'rules' | 'history'>('rules')

onMounted(() => {
  loadRules()
  loadAlerts()
})

defineExpose({ loadAlerts })
</script>

<template>
  <div class="alert-panel">
    <div class="panel-header">
      <span>告警规则</span>
      <button class="refresh-btn" @click="loadRules(); loadAlerts()" :disabled="loading">刷新</button>
      <button class="add-btn" @click="showAddForm = !showAddForm">{{ showAddForm ? '取消' : '+ 规则' }}</button>
    </div>

    <!-- 添加表单 -->
    <div v-if="showAddForm" class="add-form">
      <div class="form-field">
        <label>名称</label>
        <input v-model="form.name" placeholder="如：频繁人员检测" class="input" />
      </div>
      <div class="form-field">
        <label>事件类型</label>
        <select v-model="form.eventType" class="input">
          <option v-for="t in eventTypes" :key="t.value" :value="t.value">{{ t.label }}</option>
        </select>
      </div>
      <div class="form-field">
        <label>摄像头</label>
        <input v-model="form.cameraId" placeholder="留空表示所有" class="input" />
      </div>
      <div class="form-field" v-if="form.eventType === 'detect'">
        <label>标签过滤</label>
        <input v-model="form.labels" placeholder="person, car（逗号分隔）" class="input" />
      </div>
      <div class="form-row">
        <div class="form-field half">
          <label>时间窗口(秒)</label>
          <input v-model.number="form.windowSeconds" type="number" class="input" />
        </div>
        <div class="form-field half">
          <label>触发次数</label>
          <input v-model.number="form.threshold" type="number" class="input" />
        </div>
      </div>
      <div class="form-field">
        <label>冷却时间(秒)</label>
        <input v-model.number="form.cooldownSeconds" type="number" class="input" />
      </div>
      <button class="submit-btn" @click="addRule">确认添加</button>
    </div>

    <!-- 视图切换 -->
    <div class="view-tabs">
      <button :class="['view-btn', { active: activeView === 'rules' }]" @click="activeView = 'rules'">规则 ({{ rules.length }})</button>
      <button :class="['view-btn', { active: activeView === 'history' }]" @click="activeView = 'history'; loadAlerts()">历史 ({{ alerts.length }})</button>
    </div>

    <!-- 规则列表 -->
    <div v-if="activeView === 'rules'" class="rule-list">
      <div v-if="rules.length === 0" class="empty">{{ loading ? '加载中...' : '暂无规则' }}</div>
      <div v-for="rule in rules" :key="rule.id" class="rule-item">
        <div class="rule-header">
          <button class="toggle-btn" @click="toggleRule(rule)">
            {{ rule.enabled ? '●' : '○' }}
          </button>
          <span class="rule-name" :class="{ disabled: !rule.enabled }">{{ rule.name }}</span>
          <button class="delete-btn" @click="deleteRule(rule.id)">删除</button>
        </div>
        <div class="rule-meta">
          <span class="meta-tag">{{ eventTypeLabel(rule.eventType) }}</span>
          <span v-if="rule.cameraId" class="meta-tag cam">{{ rule.cameraId }}</span>
          <span v-if="rule.labels" class="meta-tag label">{{ rule.labels }}</span>
          <span class="meta-info">{{ rule.threshold }}次 / {{ rule.windowSeconds }}秒 · 冷却{{ rule.cooldownSeconds }}秒</span>
        </div>
      </div>
    </div>

    <!-- 告警历史 -->
    <div v-if="activeView === 'history'" class="alert-list">
      <div v-if="alerts.length === 0" class="empty">暂无告警记录</div>
      <div v-for="alert in alerts" :key="alert.id" class="alert-item">
        <div class="alert-time">{{ formatTime(alert.timestamp) }}</div>
        <div class="alert-body">
          <span class="alert-rule">{{ alert.ruleName }}</span>
          <span class="alert-cam">{{ alert.cameraId }}</span>
        </div>
        <div v-if="alert.detail" class="alert-detail">{{ alert.detail }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.alert-panel {
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
  gap: 8px;
}

.refresh-btn {
  margin-left: auto;
  background: #2a2a4a;
  color: #e0e0e0;
  border: none;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}

.refresh-btn:hover { background: #3a3a5a; }
.refresh-btn:disabled { opacity: 0.5; }

.add-btn {
  background: #4ECDC4;
  color: #1a1a2e;
  border: none;
  border-radius: 4px;
  padding: 2px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.add-btn:hover { background: #3ad4c8; }

.view-tabs {
  display: flex;
  border-bottom: 1px solid #2a2a4a;
}

.view-btn {
  flex: 1;
  padding: 6px;
  background: transparent;
  border: none;
  color: #888;
  font-size: 12px;
  cursor: pointer;
}

.view-btn:hover { color: #bbb; }

.view-btn.active {
  color: #FFD93D;
  border-bottom: 2px solid #FFD93D;
}

/* 添加表单 */
.add-form {
  padding: 10px 12px;
  border-bottom: 1px solid #2a2a4a;
  background: #16213e;
}

.form-field {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.form-field label {
  font-size: 12px;
  color: #888;
  min-width: 80px;
  flex-shrink: 0;
}

.form-row {
  display: flex;
  gap: 8px;
}

.form-field.half {
  flex: 1;
}

.input {
  flex: 1;
  background: #0a0a1a;
  color: #e0e0e0;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
}

.input:focus { outline: none; border-color: #4ECDC4; }
.input::placeholder { color: #444; }

select.input {
  appearance: none;
  cursor: pointer;
}

.submit-btn {
  width: 100%;
  background: #FFD93D;
  color: #1a1a2e;
  border: none;
  border-radius: 4px;
  padding: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  margin-top: 4px;
}

.submit-btn:hover { background: #ffe066; }

/* 规则列表 */
.rule-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.empty {
  color: #555;
  text-align: center;
  padding: 20px;
  font-size: 13px;
}

.rule-item {
  padding: 8px;
  border-radius: 4px;
  border: 1px solid transparent;
}

.rule-item:hover { background: #2a2a4a; }

.rule-header {
  display: flex;
  align-items: center;
  gap: 6px;
}

.toggle-btn {
  background: none;
  border: none;
  font-size: 12px;
  cursor: pointer;
  padding: 0;
  color: #4ECDC4;
}

.rule-name {
  font-size: 13px;
  color: #e0e0e0;
  font-weight: 500;
  flex: 1;
}

.rule-name.disabled { color: #666; }

.delete-btn {
  background: none;
  border: none;
  color: #e74c3c;
  font-size: 11px;
  cursor: pointer;
}

.delete-btn:hover { color: #ff6b6b; }

.rule-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
  margin-left: 18px;
}

.meta-tag {
  font-size: 10px;
  background: #2a2a4a;
  color: #aaa;
  padding: 1px 6px;
  border-radius: 3px;
}

.meta-tag.cam { color: #4ECDC4; }
.meta-tag.label { color: #FFD93D; }

.meta-info {
  font-size: 11px;
  color: #555;
  margin-left: auto;
}

/* 告警历史 */
.alert-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.alert-item {
  padding: 6px 8px;
  border-radius: 4px;
  border-left: 3px solid #FFD93D;
  margin-bottom: 4px;
  background: #16213e;
}

.alert-time {
  font-size: 11px;
  color: #666;
}

.alert-body {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}

.alert-rule {
  font-size: 12px;
  color: #FFD93D;
  font-weight: 500;
}

.alert-cam {
  font-size: 11px;
  color: #888;
}

.alert-detail {
  font-size: 11px;
  color: #666;
  margin-top: 2px;
  word-break: break-all;
}
</style>
