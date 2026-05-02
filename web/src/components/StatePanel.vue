<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { authFetch } from '../services/auth'
import { confirmDialog } from '../composables/useConfirm'

const { t } = useI18n()

interface StateDef {
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

interface StateChange {
  id: number
  stateId: number
  stateName: string
  cameraId: string
  oldValue: string
  newValue: string
  source: string
  sourceRuleId: number
  timestamp: number
}

const props = defineProps<{
  cameras: Array<{ id: string; name: string }>
}>()

const states = ref<StateDef[]>([])
const records = ref<StateChange[]>([])
const activeTab = ref<'rules' | 'history'>('rules')
const showAdd = ref(false)
const editingId = ref<number | null>(null)

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

const stateCount = computed(() => states.value.length)
const recordCount = computed(() => recordTotal.value)

function cameraName(id: string): string {
  if (!id) return t('alert.allCameras')
  return props.cameras.find(c => c.id === id)?.name ?? id
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

function displayValue(val: string, type: string): string {
  if (type === 'boolean') return val === 'true' ? '✓' : '✗'
  return val
}

function sourceLabel(source: string): string {
  if (source === 'manual') return t('state.sourceManual')
  if (source.startsWith('rule:')) return t('state.sourceRule')
  return source
}

async function loadStates() {
  const res = await authFetch('/api/states')
  if (res.ok) states.value = await res.json()
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
  const res = await authFetch(`/api/states/history?${params}`)
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

function startEdit(state: StateDef) {
  editingId.value = state.id
  formName.value = state.name
  formDescription.value = state.description
  formCameraId.value = state.cameraId
  formValueType.value = state.valueType
  formInitialValue.value = state.initialValue
  formNotify.value = state.notifyOnChange
  showAdd.value = false
}

function startAdd() {
  showAdd.value = true
  editingId.value = null
  resetForm()
}

async function addState() {
  if (!formName.value.trim()) return
  await authFetch('/api/states', {
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
  showAdd.value = false
  resetForm()
  await loadStates()
}

async function saveEdit() {
  if (!editingId.value) return
  await authFetch(`/api/states/${editingId.value}`, {
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
  editingId.value = null
  resetForm()
  await loadStates()
}

async function toggleState(state: StateDef) {
  await authFetch(`/api/states/${state.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: !state.enabled }),
  })
  await loadStates()
}

async function toggleBoolValue(state: StateDef) {
  const newVal = state.currentValue === 'true' ? 'false' : 'true'
  await authFetch(`/api/states/${state.id}/value`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: newVal }),
  })
  await loadStates()
}

async function deleteState(id: number) {
  if (!await confirmDialog(t('alert.confirmDelete'))) return
  await authFetch(`/api/states/${id}`, { method: 'DELETE' })
  await loadStates()
}

function cancelEdit() {
  editingId.value = null
  showAdd.value = false
  resetForm()
}

onMounted(() => {
  loadStates()
  loadRecords()
})

defineExpose({ loadStates, loadRecords })
</script>

<template>
  <div class="state-panel">
    <div class="panel-header">
      <h3>{{ t('state.title') }}</h3>
      <button class="btn-icon" @click="loadStates(); loadRecords()" :title="t('alert.refresh')">&#x21BB;</button>
      <button class="btn-add" @click="startAdd">{{ t('alert.addRuleShort') }}</button>
    </div>

    <!-- 添加表单 -->
    <div v-if="showAdd" class="form-card">
      <div class="form-row">
        <label>{{ t('state.name') }}</label>
        <input v-model="formName" :placeholder="t('state.namePlaceholder')" />
      </div>
      <div class="form-row">
        <label>{{ t('state.description') }}</label>
        <input v-model="formDescription" :placeholder="t('state.descriptionPlaceholder')" />
      </div>
      <div class="form-row">
        <label>{{ t('detectRule.camera') }}</label>
        <select v-model="formCameraId">
          <option value="">{{ t('alert.allCameras') }}</option>
          <option v-for="cam in cameras" :key="cam.id" :value="cam.id">{{ cam.name || cam.id }}</option>
        </select>
      </div>
      <div class="form-row">
        <label>{{ t('state.valueType') }}</label>
        <select v-model="formValueType">
          <option value="boolean">Boolean</option>
          <option value="string">String</option>
          <option value="number">Number</option>
        </select>
      </div>
      <div class="form-row" v-if="formValueType !== 'boolean'">
        <label>{{ t('state.initialValue') }}</label>
        <input v-model="formInitialValue" />
      </div>
      <div class="form-row">
        <label class="checkbox-label">
          <input type="checkbox" v-model="formNotify" />
          {{ t('state.notifyOnChange') }}
        </label>
      </div>
      <div class="form-actions">
        <button class="btn-primary" @click="addState">{{ t('alert.confirmAdd') }}</button>
        <button class="btn-secondary" @click="cancelEdit">{{ t('manage.cancel') }}</button>
      </div>
    </div>

    <!-- Tab 切换 -->
    <div class="tab-bar">
      <button :class="['tab-btn', { active: activeTab === 'rules' }]" @click="activeTab = 'rules'">
        {{ t('detectRule.rulesTab') }} ({{ stateCount }})
      </button>
      <button :class="['tab-btn', { active: activeTab === 'history' }]" @click="activeTab = 'history'; loadRecords()">
        {{ t('detectRule.historyTab') }} ({{ recordCount }})
      </button>
    </div>

    <!-- 规则列表 -->
    <div v-if="activeTab === 'rules'" class="rules-list">
      <div v-if="states.length === 0" class="empty">{{ t('state.noStates') }}</div>
      <div v-for="state in states" :key="state.id" class="rule-card">
        <template v-if="editingId !== state.id">
          <div class="rule-header">
            <label class="toggle-wrap">
              <input type="checkbox" :checked="state.enabled" @change="toggleState(state)" />
              <span class="toggle-slider"></span>
            </label>
            <span class="rule-name">{{ state.name }}</span>
            <span v-if="state.cameraId" class="camera-tag">{{ cameraName(state.cameraId) }}</span>
          </div>
          <div class="rule-body">
            <span class="value-type-badge">{{ state.valueType }}</span>
            <span class="current-value">
              <template v-if="state.valueType === 'boolean'">
                <button
                  :class="['bool-btn', state.currentValue === 'true' ? 'on' : 'off']"
                  @click="toggleBoolValue(state)"
                >{{ state.currentValue === 'true' ? '✓ ON' : '✗ OFF' }}</button>
              </template>
              <template v-else>{{ state.currentValue || '—' }}</template>
            </span>
            <span v-if="state.notifyOnChange" class="notify-badge" :title="t('state.notifyOnChange')">&#x1F514;</span>
          </div>
          <div class="rule-actions">
            <button class="btn-sm" @click="startEdit(state)">{{ t('alert.edit') }}</button>
            <button class="btn-sm btn-danger" @click="deleteState(state.id)">{{ t('alert.delete') }}</button>
          </div>
        </template>
        <!-- 编辑模式 -->
        <template v-else>
          <div class="form-row">
            <label>{{ t('state.name') }}</label>
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
            <label>{{ t('state.valueType') }}</label>
            <select v-model="formValueType">
              <option value="boolean">Boolean</option>
              <option value="string">String</option>
              <option value="number">Number</option>
            </select>
          </div>
          <div class="form-row">
            <label class="checkbox-label">
              <input type="checkbox" v-model="formNotify" />
              {{ t('state.notifyOnChange') }}
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
      <div v-if="records.length === 0" class="empty">{{ t('state.noHistory') }}</div>
      <div v-for="rec in records" :key="rec.id" class="history-card">
        <div class="history-time">{{ formatTime(rec.timestamp) }}</div>
        <div class="history-body">
          <span class="history-name">{{ rec.stateName }}</span>
          <span class="history-change">
            <span class="old-val">{{ displayValue(rec.oldValue, 'auto') }}</span>
            <span class="arrow">→</span>
            <span class="new-val">{{ displayValue(rec.newValue, 'auto') }}</span>
          </span>
          <span class="history-source">{{ sourceLabel(rec.source) }}</span>
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
.state-panel {
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
