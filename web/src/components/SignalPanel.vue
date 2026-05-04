<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { authFetch } from '../services/auth'
import { confirmDialog } from '../composables/useConfirm'
import { useToast } from '../composables/useToast'

const { t } = useI18n()
const { error: toastError } = useToast()

interface Signal {
  id: number
  name: string
  description: string
  cameraId: string
  valueType: 'boolean' | 'string' | 'number'
  initialValue: string
  currentValue: string
  notifyOnChange: boolean
  enabled: boolean
}

interface SignalChange {
  id: number
  signalId: number
  signalName: string
  cameraId: string
  oldValue: string
  newValue: string
  source: string
  sourceId: number
  timestamp: number
}

const props = defineProps<{
  cameras: Array<{ id: string; name: string }>
}>()

const signals = ref<Signal[]>([])
const records = ref<SignalChange[]>([])
const activeTab = ref<'rules' | 'history'>('rules')
const showAdd = ref(false)
const editingId = ref<number | null>(null)
const saving = ref(false)

/** 观测器 ID→名称 映射 */
const observerNames = ref<Record<number, string>>({})

const emit = defineEmits<{
  jumpToObserverHistory: [observerId: number]
}>()

/** 添加/编辑表单 */
const formName = ref('')
const formDescription = ref('')
const formCameraId = ref('')
const formValueType = ref<'boolean' | 'string' | 'number'>('boolean')
const formInitialValue = ref('')
const formNotify = ref(false)

/** 历史筛选 */
const filterCamera = ref('')
const filterDate = ref('')
const recordTotal = ref(0)
const PAGE_SIZE = 50

const signalCount = computed(() => signals.value.length)
const recordCount = computed(() => recordTotal.value)

function cameraName(id: string): string {
  if (!id) return t('alert.allCameras')
  return props.cameras.find(c => c.id === id)?.name ?? id
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

function displayValue(val: string, type: 'boolean' | 'string' | 'number' | 'auto'): string {
  const isBool = type === 'boolean' || (type === 'auto' && (val === 'true' || val === 'false'))
  if (isBool) return val === 'true' ? '✓' : '✗'
  return val
}

function sourceLabel(source: string, sourceId: number): string {
  if (source === 'manual') return t('signal.sourceManual')
  if (source.startsWith('observer:') || source.startsWith('rule:')) {
    if (sourceId > 0) {
      const name = observerNames.value[sourceId]
      return name ? `${t('signal.sourceObserver')}: ${name}` : `${t('signal.sourceObserver')} #${sourceId}`
    }
    return t('signal.sourceObserver')
  }
  return source
}

async function loadObserverNames() {
  try {
    const res = await authFetch('/api/observers')
    if (res.ok) {
      const observers = await res.json() as Array<{ id: number; name: string }>
      const map: Record<number, string> = {}
      for (const o of observers) map[o.id] = o.name
      observerNames.value = map
    }
  } catch { /* ignore */ }
}

async function loadSignals() {
  const res = await authFetch('/api/signals')
  if (res.ok) signals.value = await res.json()
}

async function loadRecords(append = false) {
  const params = new URLSearchParams()
  if (filterCamera.value) params.set('cameraId', filterCamera.value)
  if (filterDate.value) {
    const d = new Date(filterDate.value)
    params.set('since', String(d.getTime()))
    params.set('until', String(d.getTime() + 86400000))
  }
  if (!append) params.set('offset', '0')
  else params.set('offset', String(records.value.length))
  params.set('limit', String(PAGE_SIZE))
  const res = await authFetch(`/api/signals/history?${params}`)
  if (res.ok) {
    const data = await res.json()
    records.value = append ? [...records.value, ...data.records] : data.records
    recordTotal.value = data.total
  }
}

function resetForm() {
  formName.value = ''
  formDescription.value = ''
  formCameraId.value = ''
  formValueType.value = 'boolean'
  formInitialValue.value = ''
  formNotify.value = false
}

function startEdit(signal: Signal) {
  editingId.value = signal.id
  formName.value = signal.name
  formDescription.value = signal.description
  formCameraId.value = signal.cameraId
  formValueType.value = signal.valueType
  formInitialValue.value = signal.initialValue
  formNotify.value = signal.notifyOnChange
  showAdd.value = false
}

function startAdd() {
  showAdd.value = true
  editingId.value = null
  resetForm()
}

async function addSignal() {
  if (!formName.value.trim() || saving.value) return
  saving.value = true
  const res = await authFetch('/api/signals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: formName.value,
      description: formDescription.value,
      cameraId: formCameraId.value,
      valueType: formValueType.value,
      initialValue: formInitialValue.value || undefined,
      notifyOnChange: formNotify.value,
    }),
  })
  saving.value = false
  if (!res.ok) {
    toastError(t('alert.saveFailed'))
    return
  }
  showAdd.value = false
  resetForm()
  await loadSignals()
}

async function saveEdit() {
  if (!editingId.value) return
  const res = await authFetch(`/api/signals/${editingId.value}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: formName.value,
      description: formDescription.value,
      cameraId: formCameraId.value,
      valueType: formValueType.value,
      initialValue: formInitialValue.value,
      notifyOnChange: formNotify.value,
    }),
  })
  if (!res.ok) {
    toastError(t('alert.saveFailed'))
    return
  }
  editingId.value = null
  resetForm()
  await loadSignals()
}

async function toggleSignal(signal: Signal) {
  const res = await authFetch(`/api/signals/${signal.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: !signal.enabled }),
  })
  if (!res.ok) {
    toastError(t('alert.saveFailed'))
    return
  }
  await loadSignals()
}

async function toggleBoolValue(signal: Signal) {
  const newVal = signal.currentValue === 'true' ? 'false' : 'true'
  const res = await authFetch(`/api/signals/${signal.id}/value`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: newVal }),
  })
  if (!res.ok) {
    toastError(t('alert.saveFailed'))
    return
  }
  await loadSignals()
}

async function deleteSignal(id: number) {
  if (!await confirmDialog(t('alert.confirmDelete'))) return
  const res = await authFetch(`/api/signals/${id}`, { method: 'DELETE' })
  if (!res.ok) {
    toastError(t('alert.deleteFailed'))
    return
  }
  await loadSignals()
}

function cancelEdit() {
  editingId.value = null
  showAdd.value = false
  resetForm()
}

onMounted(() => {
  loadSignals()
  loadRecords()
  loadObserverNames()
})

defineExpose({ loadSignals, loadRecords })
</script>

<template>
  <div class="signal-panel">
    <div class="panel-header">
      <h3>{{ t('signal.title') }}</h3>
      <button class="btn-icon" @click="loadSignals(); loadRecords()" :title="t('alert.refresh')">&#x21BB;</button>
      <button class="btn-add" @click="startAdd">{{ t('alert.addRuleShort') }}</button>
    </div>

    <!-- 添加表单 -->
    <div v-if="showAdd" class="form-card">
      <div class="form-row">
        <label>{{ t('signal.name') }}</label>
        <input v-model="formName" :placeholder="t('signal.namePlaceholder')" />
      </div>
      <div class="form-row">
        <label>{{ t('signal.description') }}</label>
        <input v-model="formDescription" :placeholder="t('signal.descriptionPlaceholder')" />
      </div>
      <div class="form-row">
        <label>{{ t('detectRule.camera') }}</label>
        <select v-model="formCameraId">
          <option value="">{{ t('alert.allCameras') }}</option>
          <option v-for="cam in cameras" :key="cam.id" :value="cam.id">{{ cam.name || cam.id }}</option>
        </select>
      </div>
      <div class="form-row">
        <label>{{ t('signal.valueType') }}</label>
        <select v-model="formValueType">
          <option value="boolean">Boolean</option>
          <option value="string">String</option>
          <option value="number">Number</option>
        </select>
      </div>
      <div class="form-row" v-if="formValueType !== 'boolean'">
        <label>{{ t('signal.initialValue') }}</label>
        <input v-model="formInitialValue" />
      </div>
      <div class="form-row">
        <label class="checkbox-label">
          <input type="checkbox" v-model="formNotify" />
          {{ t('signal.notifyOnChange') }}
        </label>
      </div>
      <div class="form-actions">
        <button class="btn-primary" :disabled="saving" @click="addSignal">{{ saving ? t('settings.aiModelLoading') : t('alert.confirmAdd') }}</button>
        <button class="btn-secondary" @click="cancelEdit">{{ t('manage.cancel') }}</button>
      </div>
    </div>

    <!-- Tab 切换 -->
    <div class="tab-bar">
      <button :class="['tab-btn', { active: activeTab === 'rules' }]" @click="activeTab = 'rules'">
        {{ t('detectRule.rulesTab') }} ({{ signalCount }})
      </button>
      <button :class="['tab-btn', { active: activeTab === 'history' }]" @click="activeTab = 'history'; loadRecords()">
        {{ t('detectRule.historyTab') }} ({{ recordCount }})
      </button>
    </div>

    <!-- 信号列表 -->
    <div v-if="activeTab === 'rules'" class="rules-list">
      <div v-if="signals.length === 0" class="empty">{{ t('signal.noSignals') }}</div>
      <div v-for="signal in signals" :key="signal.id" class="rule-card">
        <template v-if="editingId !== signal.id">
          <div class="rule-header">
            <label class="toggle-wrap">
              <input type="checkbox" :checked="signal.enabled" @change="toggleSignal(signal)" />
              <span class="toggle-slider"></span>
            </label>
            <span class="rule-name">{{ signal.name }}</span>
            <span v-if="signal.cameraId" class="camera-tag">{{ cameraName(signal.cameraId) }}</span>
          </div>
          <div class="rule-body">
            <span class="value-type-badge">{{ signal.valueType }}</span>
            <span class="current-value">
              <template v-if="signal.valueType === 'boolean'">
                <button
                  :class="['bool-btn', signal.currentValue === 'true' ? 'on' : 'off']"
                  @click="toggleBoolValue(signal)"
                >{{ signal.currentValue === 'true' ? '✓ ON' : '✗ OFF' }}</button>
              </template>
              <template v-else>{{ signal.currentValue || '—' }}</template>
            </span>
            <span v-if="signal.notifyOnChange" class="notify-badge" :title="t('signal.notifyOnChange')">&#x1F514;</span>
          </div>
          <div class="rule-actions">
            <button class="btn-sm" @click="startEdit(signal)">{{ t('alert.edit') }}</button>
            <button class="btn-sm btn-danger" @click="deleteSignal(signal.id)">{{ t('alert.delete') }}</button>
          </div>
        </template>
        <!-- 编辑模式 -->
        <template v-else>
          <div class="form-row">
            <label>{{ t('signal.name') }}</label>
            <input v-model="formName" />
          </div>
          <div class="form-row">
            <label>{{ t('detectRule.camera') }}</label>
            <select v-model="formCameraId">
              <option value="">{{ t('alert.allCameras') }}</option>
              <option v-for="cam in cameras" :key="cam.id" :value="cam.id">{{ cam.name || cam.id }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>{{ t('signal.valueType') }}</label>
            <select v-model="formValueType">
              <option value="boolean">Boolean</option>
              <option value="string">String</option>
              <option value="number">Number</option>
            </select>
          </div>
          <div class="form-row">
            <label class="checkbox-label">
              <input type="checkbox" v-model="formNotify" />
              {{ t('signal.notifyOnChange') }}
            </label>
          </div>
          <div class="form-actions">
            <button class="btn-primary" @click="saveEdit">{{ t('manage.save') }}</button>
            <button class="btn-secondary" @click="cancelEdit">{{ t('manage.cancel') }}</button>
          </div>
        </template>
      </div>
    </div>

    <!-- 历史记录 -->
    <div v-if="activeTab === 'history'" class="history-section">
      <div class="history-filters">
        <select v-model="filterCamera" @change="loadRecords()">
          <option value="">{{ t('alert.allCameras') }}</option>
          <option v-for="cam in cameras" :key="cam.id" :value="cam.id">{{ cam.name || cam.id }}</option>
        </select>
        <input type="date" v-model="filterDate" @change="loadRecords()" />
        <span class="total-count">{{ t('alert.totalCount', { count: recordTotal }) }}</span>
      </div>
      <div v-if="records.length === 0" class="empty">{{ t('signal.noHistory') }}</div>
      <div v-for="rec in records" :key="rec.id" class="history-card">
        <div class="history-time">{{ formatTime(rec.timestamp) }}</div>
        <div class="history-body">
          <span class="history-name">{{ rec.signalName }}</span>
          <span class="history-change">
            <span class="old-val">{{ displayValue(rec.oldValue, 'auto') }}</span>
            <span class="arrow">→</span>
            <span class="new-val">{{ displayValue(rec.newValue, 'auto') }}</span>
          </span>
          <span class="history-source">{{ sourceLabel(rec.source, rec.sourceId) }}</span>
          <button v-if="rec.sourceId > 0" class="btn-sm link-btn" @click="emit('jumpToObserverHistory', rec.sourceId)">{{ t('signal.viewObserver') }}</button>
          <span v-if="rec.cameraId" class="camera-tag">{{ cameraName(rec.cameraId) }}</span>
        </div>
      </div>
      <button v-if="records.length < recordTotal" class="btn-load-more" @click="loadRecords(true)">
        {{ t('alert.loadMore') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.signal-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  color: #e0e0e0;
  font-size: 13px;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.panel-header h3 {
  margin: 0;
  font-size: 15px;
  flex: 1;
}

.btn-icon {
  background: none;
  border: 1px solid #444;
  color: #aaa;
  border-radius: 4px;
  cursor: pointer;
  padding: 4px 8px;
  font-size: 16px;
}
.btn-icon:hover { color: #fff; border-color: #666; }

.btn-add {
  background: #4ECDC4;
  color: #1a1a2e;
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.btn-add:hover { background: #3dbdb5; }

.form-card {
  background: #16213e;
  border: 1px solid #2a2a4a;
  border-radius: 6px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.form-row label {
  min-width: 80px;
  color: #aaa;
  font-size: 12px;
}
.form-row input, .form-row select, .form-row textarea {
  flex: 1;
  background: #0a0a1a;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 6px 8px;
  color: #e0e0e0;
  font-size: 13px;
}
.form-row input:focus, .form-row select:focus {
  border-color: #4ECDC4;
  outline: none;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.form-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.btn-primary {
  background: #4ECDC4;
  color: #1a1a2e;
  border: none;
  border-radius: 4px;
  padding: 6px 16px;
  font-weight: 600;
  cursor: pointer;
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-secondary {
  background: #333;
  color: #ccc;
  border: none;
  border-radius: 4px;
  padding: 6px 16px;
  cursor: pointer;
}

.tab-bar {
  display: flex;
  gap: 0;
  border-bottom: 1px solid #2a2a4a;
}

.tab-btn {
  flex: 1;
  background: none;
  border: none;
  color: #888;
  padding: 8px;
  cursor: pointer;
  font-size: 12px;
  border-bottom: 2px solid transparent;
}
.tab-btn.active {
  color: #4ECDC4;
  border-bottom-color: #4ECDC4;
}

.rules-list, .history-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.empty {
  color: #555;
  text-align: center;
  padding: 24px;
}

.rule-card {
  background: #16213e;
  border: 1px solid #2a2a4a;
  border-left: 3px solid #4ECDC4;
  border-radius: 4px;
  padding: 8px 12px;
}

.rule-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rule-name { font-weight: 600; }
.camera-tag {
  background: #2a2a4a;
  color: #aaa;
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 11px;
}

.rule-body {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.value-type-badge {
  background: #333;
  color: #aaa;
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 10px;
  text-transform: uppercase;
}

.current-value {
  font-size: 13px;
}

.bool-btn {
  border: none;
  border-radius: 3px;
  padding: 2px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.bool-btn.on { background: #4CAF50; color: #fff; }
.bool-btn.off { background: #555; color: #ccc; }

.notify-badge { font-size: 14px; }

.rule-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.btn-sm {
  background: #333;
  color: #ccc;
  border: none;
  border-radius: 3px;
  padding: 3px 10px;
  font-size: 11px;
  cursor: pointer;
}
.btn-sm:hover { background: #444; }
.btn-sm.btn-danger { color: #F44336; }
.btn-sm.btn-danger:hover { background: #F44336; color: #fff; }

.toggle-wrap {
  position: relative;
  width: 32px;
  height: 18px;
  flex-shrink: 0;
}
.toggle-wrap input {
  opacity: 0;
  width: 0;
  height: 0;
}
.toggle-slider {
  position: absolute;
  inset: 0;
  background: #444;
  border-radius: 9px;
  cursor: pointer;
  transition: background 0.2s;
}
.toggle-slider::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  background: #ccc;
  border-radius: 50%;
  transition: transform 0.2s;
}
.toggle-wrap input:checked + .toggle-slider {
  background: #4ECDC4;
}
.toggle-wrap input:checked + .toggle-slider::after {
  transform: translateX(14px);
}

.history-filters {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.history-filters select, .history-filters input {
  background: #0a0a1a;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 4px 8px;
  color: #e0e0e0;
  font-size: 12px;
}
.total-count {
  color: #666;
  font-size: 11px;
}

.history-card {
  background: #16213e;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 6px 10px;
}
.history-time {
  font-size: 11px;
  color: #666;
}
.history-body {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}
.history-name { font-weight: 600; }
.history-change {
  display: flex;
  align-items: center;
  gap: 4px;
}
.old-val { color: #F44336; }
.new-val { color: #4CAF50; }
.arrow { color: #666; }
.history-source {
  background: #333;
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 10px;
  color: #aaa;
}

.link-btn {
  color: #4ECDC4 !important;
  font-size: 10px;
  padding: 1px 6px;
}
.link-btn:hover { background: #2a2a4a !important; }

.btn-load-more {
  background: none;
  border: 1px solid #2a2a4a;
  color: #888;
  border-radius: 4px;
  padding: 8px;
  cursor: pointer;
  text-align: center;
}
.btn-load-more:hover { color: #4ECDC4; border-color: #4ECDC4; }
</style>
