<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { authFetch } from '../services/auth'
import { useToast } from '../composables/useToast'
import { confirmDialog } from '../composables/useConfirm'
import { useCameraNameMap } from '../composables/useCameraNameMap'

let isNewTimer: ReturnType<typeof setTimeout> | null = null

interface AlertRule {
  id: number
  name: string
  eventType: string
  cameraId: string
  windowSeconds: number
  threshold: number
  cooldownSeconds: number
  enabled: boolean
  silentStart: string
  silentEnd: string
  /** 订阅配置，描述事件来源 */
  subscription: { eventType: string; sourceId?: number; cameraId?: string } | null
  /** 条件 JSON */
  condition: string
}

interface AlertRecord {
  id: number
  ruleId: number
  ruleName: string
  cameraId: string
  timestamp: number
  detail: string
  isNew?: boolean
}

interface ObserverItem { id: number; name: string; cameraId: string }
interface SignalItem { id: number; name: string; cameraId: string; valueType: string; currentValue: string }

const { t, locale } = useI18n()
const { error: toastError } = useToast()

const rules = ref<AlertRule[]>([])
const alerts = ref<AlertRecord[]>([])
const loading = ref(false)
const observerList = ref<ObserverItem[]>([])
const signalList = ref<SignalItem[]>([])

const filterCamera = ref('')
const filterDate = ref('')
const alertOffset = ref(0)
const PAGE_SIZE = 50
const alertTotal = ref(0)

const props = defineProps<{
  cameras?: Array<{ id: string; name: string }>
}>()

const emit = defineEmits<{
  jumpToRecording: [cameraId: string, timestamp: number]
}>()

const { cameraNameMap } = useCameraNameMap(computed(() => props.cameras ?? []))

const showAddForm = ref(false)
const editingRuleId = ref<number | null>(null)

/** 表单中的条件（从 condition JSON 解析） */
interface ConditionForm {
  resultContains: string
  valueEquals: string
  valueNotEquals: string
}

const form = ref({
  name: '',
  eventType: 'observation',
  cameraId: '',
  windowSeconds: 60,
  threshold: 1,
  cooldownSeconds: 300,
  silentStart: '',
  silentEnd: '',
  sourceId: 0,
  conditionForm: { resultContains: '', valueEquals: '', valueNotEquals: '' } as ConditionForm,
})

const emptyForm = {
  name: '', eventType: 'observation', cameraId: '',
  windowSeconds: 60, threshold: 1, cooldownSeconds: 300,
  silentStart: '', silentEnd: '', sourceId: 0,
  conditionForm: { resultContains: '', valueEquals: '', valueNotEquals: '' } as ConditionForm,
}

/** 构建 condition JSON */
function buildConditionJson(): string {
  const cf = form.value.conditionForm
  const obj: Record<string, string> = {}
  if (form.value.eventType === 'observation' && cf.resultContains) obj.resultContains = cf.resultContains
  if (form.value.eventType === 'signal:changed') {
    if (cf.valueEquals) obj.valueEquals = cf.valueEquals
    if (cf.valueNotEquals) obj.valueNotEquals = cf.valueNotEquals
  }
  return Object.keys(obj).length > 0 ? JSON.stringify(obj) : ''
}

/** 解析 condition JSON 到表单 */
function parseCondition(condition: string): ConditionForm {
  const cf: ConditionForm = { resultContains: '', valueEquals: '', valueNotEquals: '' }
  if (!condition) return cf
  try {
    const obj = JSON.parse(condition) as Record<string, string>
    if (obj.resultContains) cf.resultContains = obj.resultContains
    if (obj.valueEquals) cf.valueEquals = obj.valueEquals
    if (obj.valueNotEquals) cf.valueNotEquals = obj.valueNotEquals
  } catch { /* ignore */ }
  return cf
}

/** 事件类型选项 */
const eventTypes = computed(() => [
  { value: 'observation', label: t('alert.eventTypeObservation') },
  { value: 'signal:changed', label: t('alert.eventTypeSignalChanged') },
  { value: 'track:appeared', label: t('alert.eventTypeTrackAppeared') },
  { value: 'track:disappeared', label: t('alert.eventTypeTrackDisappeared') },
  { value: 'track:enter-zone', label: t('alert.eventTypeTrackEnterZone') },
  { value: 'track:leave-zone', label: t('alert.eventTypeTrackLeaveZone') },
  { value: 'track:loiter', label: t('alert.eventTypeTrackLoiter') },
  { value: 'track:line-cross', label: t('alert.eventTypeTrackLineCross') },
  { value: 'track:approach', label: t('alert.eventTypeTrackApproach') },
  { value: 'track:crowd', label: t('alert.eventTypeTrackCrowd') },
  { value: 'track:speed', label: t('alert.eventTypeTrackSpeed') },
  { value: 'motion', label: t('alert.eventTypeMotion') },
  { value: 'camera:online', label: t('alert.eventTypeCameraOnline') },
  { value: 'camera:offline', label: t('alert.eventTypeCameraOffline') },
])

/** 当前摄像头过滤后的观测器 */
const cameraObservers = computed(() => {
  const camId = form.value.cameraId
  if (!camId) return observerList.value
  return observerList.value.filter(r => !r.cameraId || r.cameraId === camId)
})

/** 当前摄像头过滤后的信号 */
const cameraSignals = computed(() => {
  const camId = form.value.cameraId
  if (!camId) return signalList.value
  return signalList.value.filter(s => !s.cameraId || s.cameraId === camId)
})

/** 加载观测器和信号列表（供事件源选择） */
async function loadSourceOptions() {
  try {
    const [observersRes, signalsRes] = await Promise.all([
      authFetch('/api/observers'),
      authFetch('/api/signals'),
    ])
    if (observersRes.ok) observerList.value = await observersRes.json()
    if (signalsRes.ok) signalList.value = await signalsRes.json()
  } catch { /* ignore */ }
}

async function loadRules() {
  loading.value = true
  try {
    const res = await authFetch('/api/alerts/rules')
    if (res.ok) rules.value = await res.json()
  } catch { /* ignore */ }
  finally { loading.value = false }
}

async function loadAlerts(append = false) {
  try {
    const params = new URLSearchParams()
    params.set('limit', String(PAGE_SIZE))
    if (!append) alertOffset.value = 0
    params.set('offset', String(alertOffset.value))
    if (filterCamera.value) params.set('cameraId', filterCamera.value)
    if (filterDate.value) {
      const since = new Date(`${filterDate.value}T00:00:00`).getTime()
      params.set('since', String(since))
      params.set('until', String(since + 86_400_000))
    }
    const res = await authFetch(`/api/alerts/history?${params}`)
    if (res.ok) {
      const data = await res.json()
      alerts.value = append ? [...alerts.value, ...data.records] : data.records
      alertTotal.value = data.total ?? alerts.value.length
    }
  } catch { /* ignore */ }
}

function loadMoreAlerts() {
  alertOffset.value += PAGE_SIZE
  loadAlerts(true)
}

const hasMore = computed(() => alerts.value.length < alertTotal.value)

/** 构建提交 body（去掉 conditionForm 和 sourceId，加上 condition 和 subscription） */
function buildBody(): Record<string, unknown> {
  const { conditionForm, sourceId, ...rest } = form.value
  const subscription = {
    eventType: form.value.eventType,
    sourceId: form.value.sourceId || undefined,
    cameraId: form.value.cameraId || undefined,
  }
  return { ...rest, condition: buildConditionJson(), subscription }
}

async function addRule() {
  if (!form.value.name || !form.value.eventType) return
  try {
    const res = await authFetch('/api/alerts/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody()),
    })
    if (res.ok) {
      showAddForm.value = false
      form.value = { ...emptyForm, conditionForm: { ...emptyForm.conditionForm } }
      loadRules()
    } else {
      toastError(t('alert.saveFailed'))
    }
  } catch {
    toastError(t('alert.saveFailed'))
  }
}

function startEdit(rule: AlertRule) {
  editingRuleId.value = rule.id
  showAddForm.value = false
  const sourceId = rule.subscription?.sourceId ?? 0
  form.value = {
    name: rule.name,
    eventType: rule.subscription?.eventType ?? rule.eventType,
    cameraId: rule.cameraId,
    windowSeconds: rule.windowSeconds,
    threshold: rule.threshold,
    cooldownSeconds: rule.cooldownSeconds,
    silentStart: rule.silentStart ?? '',
    silentEnd: rule.silentEnd ?? '',
    sourceId,
    conditionForm: parseCondition(rule.condition ?? ''),
  }
}

async function saveEdit() {
  if (!editingRuleId.value || !form.value.name) return
  try {
    const res = await authFetch(`/api/alerts/rules/${editingRuleId.value}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody()),
    })
    if (res.ok) {
      editingRuleId.value = null
      form.value = { ...emptyForm, conditionForm: { ...emptyForm.conditionForm } }
      loadRules()
    } else {
      toastError(t('alert.saveFailed'))
    }
  } catch {
    toastError(t('alert.saveFailed'))
  }
}

function cancelEdit() {
  editingRuleId.value = null
  form.value = { ...emptyForm, conditionForm: { ...emptyForm.conditionForm } }
}

async function toggleRule(rule: AlertRule) {
  try {
    const res = await authFetch(`/api/alerts/rules/${rule.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !rule.enabled }),
    })
    if (res.ok) loadRules()
    else toastError(t('alert.saveFailed'))
  } catch {
    toastError(t('alert.saveFailed'))
  }
}

async function deleteRule(id: number) {
  if (!await confirmDialog(t('alert.confirmDelete'))) return
  try {
    const res = await authFetch(`/api/alerts/rules/${id}`, { method: 'DELETE' })
    if (res.ok) loadRules()
    else toastError(t('alert.deleteFailed'))
  } catch {
    toastError(t('alert.deleteFailed'))
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(locale.value)
}

function eventTypeLabel(type: string): string {
  return eventTypes.value.find(e => e.value === type)?.label ?? type
}

/** 获取规则显示用的源名称 */
function sourceLabel(rule: AlertRule): string {
  const sub = rule.subscription
  if (!sub) return ''
  if (sub.eventType === 'observation') {
    if (sub.sourceId && sub.sourceId > 0) {
      const r = observerList.value.find(d => d.id === sub.sourceId)
      return r?.name ?? `#${sub.sourceId}`
    }
    return t('alert.anyObserver')
  }
  if (sub.eventType === 'signal:changed') {
    if (sub.sourceId && sub.sourceId > 0) {
      const s = signalList.value.find(st => st.id === sub.sourceId)
      return s?.name ?? `#${sub.sourceId}`
    }
    return t('alert.anySignal')
  }
  return ''
}

function formatDetail(detail: string): string {
  let obj: Record<string, unknown>
  try { obj = JSON.parse(detail) } catch { return detail }
  const parts: string[] = []
  if (typeof obj.sourceObserverName === 'string') parts.push(obj.sourceObserverName)
  if (typeof obj.sourceSignalName === 'string') parts.push(`${obj.sourceSignalName}: ${obj.oldValue ?? ""} → ${obj.newValue ?? ""}`)
  if (typeof obj.result === 'string') parts.push(obj.result)
  return parts.length > 0 ? parts.join(' · ') : detail
}

function addAlert(payload: { ruleId: number; ruleName: string; cameraId: string; timestamp: number; detail: string }) {
  if (filterCamera.value && filterCamera.value !== payload.cameraId) return
  if (filterDate.value) {
    const since = new Date(`${filterDate.value}T00:00:00`).getTime()
    if (payload.timestamp < since || payload.timestamp > since + 86_400_000) return
  }
  const record: AlertRecord = {
    id: -(Date.now()),
    ruleId: payload.ruleId, ruleName: payload.ruleName,
    cameraId: payload.cameraId, timestamp: payload.timestamp,
    detail: payload.detail, isNew: true,
  }
  alerts.value.unshift(record)
  alertTotal.value++
  const recordId = record.id
  if (isNewTimer) clearTimeout(isNewTimer)
  isNewTimer = setTimeout(() => {
    const r = alerts.value.find(a => a.id === recordId)
    if (r) r.isNew = false
  }, 1000)
}

const activeView = ref<'rules' | 'history'>('rules')

async function exportCsv() {
  try {
    const params = new URLSearchParams({ limit: '10000', offset: '0' })
    if (filterCamera.value) params.set('cameraId', filterCamera.value)
    if (filterDate.value) {
      const since = new Date(`${filterDate.value}T00:00:00`).getTime()
      params.set('since', String(since))
      params.set('until', String(since + 86_400_000))
    }
    const res = await authFetch(`/api/alerts/history?${params}`)
    if (!res.ok) return
    const { records } = await res.json() as { records: AlertRecord[] }
    const header = 'ID,Rule Name,Camera,Time,Detail'
    const csvRows = records.map(a =>
      `${a.id},"${a.ruleName}","${cameraNameMap.value.get(a.cameraId) ?? a.cameraId}","${new Date(a.timestamp).toLocaleString(locale.value)}","${(a.detail ?? '').replace(/"/g, '""')}"`
    )
    const csv = [header, ...csvRows].join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const link = document.createElement('a')
    const dateStr = filterDate.value || new Date().toISOString().slice(0, 10)
    link.href = URL.createObjectURL(blob)
    link.download = `alerts_${dateStr}.csv`
    link.click()
    URL.revokeObjectURL(link.href)
  } catch { /* ignore */ }
}

/** 根据事件类型重置条件表单 */
function resetConditionForm() {
  form.value.conditionForm = { resultContains: '', valueEquals: '', valueNotEquals: '' }
  form.value.sourceId = 0
}

onMounted(() => {
  loadRules()
  loadAlerts()
  loadSourceOptions()
})

onUnmounted(() => {
  if (isNewTimer) clearTimeout(isNewTimer)
})

defineExpose({ loadAlerts, addAlert })
</script>

<template>
  <div class="alert-panel">
    <div class="panel-header">
      <span>{{ t('alert.rules') }}</span>
      <button class="refresh-btn" @click="loadRules(); loadAlerts()" :disabled="loading">{{ t('alert.refresh') }}</button>
      <button class="add-btn" @click="showAddForm = !showAddForm">{{ showAddForm ? t('alert.cancel') : t('alert.addRuleShort') }}</button>
    </div>

    <!-- 添加表单 -->
    <div v-if="showAddForm" class="add-form">
      <div class="form-field">
        <label>{{ t('alert.nameLabel') }}</label>
        <input v-model="form.name" :placeholder="t('alert.namePlaceholder')" class="input" />
      </div>
      <div class="form-field">
        <label>{{ t('alert.eventType') }}</label>
        <select v-model="form.eventType" class="input" @change="resetConditionForm">
          <option v-for="et in eventTypes" :key="et.value" :value="et.value">{{ et.label }}</option>
        </select>
      </div>
      <div class="form-field">
        <label>{{ t('alert.cameraFilter') }}</label>
        <select v-model="form.cameraId" class="input">
          <option value="">{{ t('alert.cameraPlaceholder') }}</option>
          <option v-for="cam in cameras" :key="cam.id" :value="cam.id">{{ cam.name || cam.id }}</option>
        </select>
      </div>
      <!-- observation 事件源配置 -->
      <template v-if="form.eventType === 'observation'">
        <div class="form-field">
          <label>{{ t('alert.sourceObserver') }}</label>
          <select v-model.number="form.sourceId" class="input">
            <option :value="0">{{ t('alert.anyObserver') }}</option>
            <option v-for="r in cameraObservers" :key="r.id" :value="r.id">{{ r.name }}</option>
          </select>
        </div>
        <div class="form-field">
          <label>{{ t('alert.resultContains') }}</label>
          <input v-model="form.conditionForm.resultContains" class="input" :placeholder="t('alert.resultContains')" />
        </div>
      </template>
      <!-- signal:changed 事件源配置 -->
      <template v-if="form.eventType === 'signal:changed'">
        <div class="form-field">
          <label>{{ t('alert.sourceSignal') }}</label>
          <select v-model.number="form.sourceId" class="input">
            <option :value="0">{{ t('alert.anySignal') }}</option>
            <option v-for="s in cameraSignals" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </div>
        <div class="form-row">
          <div class="form-field half">
            <label>{{ t('alert.valueEquals') }}</label>
            <input v-model="form.conditionForm.valueEquals" class="input" />
          </div>
          <div class="form-field half">
            <label>{{ t('alert.valueNotEquals') }}</label>
            <input v-model="form.conditionForm.valueNotEquals" class="input" />
          </div>
        </div>
      </template>
      <div class="form-row">
        <div class="form-field half">
          <label>{{ t('alert.windowSeconds') }}</label>
          <input v-model.number="form.windowSeconds" type="number" class="input" />
        </div>
        <div class="form-field half">
          <label>{{ t('alert.triggerCount') }}</label>
          <input v-model.number="form.threshold" type="number" class="input" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-field half">
          <label>{{ t('alert.cooldown') }}</label>
          <input v-model.number="form.cooldownSeconds" type="number" class="input" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-field half">
          <label>{{ t('alert.silentStartLabel') }}</label>
          <input v-model="form.silentStart" type="time" class="input" />
        </div>
        <div class="form-field half">
          <label>{{ t('alert.silentEndLabel') }}</label>
          <input v-model="form.silentEnd" type="time" class="input" />
        </div>
      </div>
      <button class="submit-btn" @click="addRule">{{ t('alert.confirmAdd') }}</button>
    </div>

    <!-- 视图切换 -->
    <div class="view-tabs">
      <button :class="['view-btn', { active: activeView === 'rules' }]" @click="activeView = 'rules'">{{ t('alert.rulesTab') }} ({{ rules.length }})</button>
      <button :class="['view-btn', { active: activeView === 'history' }]" @click="activeView = 'history'; loadAlerts()">{{ t('alert.historyTab') }} ({{ alertTotal }})</button>
    </div>

    <!-- 规则列表 -->
    <div v-if="activeView === 'rules'" class="rule-list">
      <div v-if="rules.length === 0" class="empty">{{ loading ? t('alert.loading') : t('alert.noRules') }}</div>
      <div v-for="rule in rules" :key="rule.id" class="rule-item">
        <!-- 编辑模式 -->
        <template v-if="editingRuleId === rule.id">
          <div class="edit-form">
            <div class="form-field">
              <label>{{ t('alert.nameLabel') }}</label>
              <input v-model="form.name" class="input" />
            </div>
            <div class="form-field">
              <label>{{ t('alert.eventType') }}</label>
              <select v-model="form.eventType" class="input" @change="resetConditionForm">
                <option v-for="et in eventTypes" :key="et.value" :value="et.value">{{ et.label }}</option>
              </select>
            </div>
            <div class="form-field">
              <label>{{ t('alert.cameraFilter') }}</label>
              <select v-model="form.cameraId" class="input">
                <option value="">{{ t('alert.allCameras') }}</option>
                <option v-for="cam in cameras" :key="cam.id" :value="cam.id">{{ cam.name || cam.id }}</option>
              </select>
            </div>
            <!-- observation 事件源配置 -->
            <template v-if="form.eventType === 'observation'">
              <div class="form-field">
                <label>{{ t('alert.sourceObserver') }}</label>
                <select v-model.number="form.sourceId" class="input">
                  <option :value="0">{{ t('alert.anyObserver') }}</option>
                  <option v-for="r in cameraObservers" :key="r.id" :value="r.id">{{ r.name }}</option>
                </select>
              </div>
              <div class="form-field">
                <label>{{ t('alert.resultContains') }}</label>
                <input v-model="form.conditionForm.resultContains" class="input" />
              </div>
            </template>
            <!-- signal:changed 事件源配置 -->
            <template v-if="form.eventType === 'signal:changed'">
              <div class="form-field">
                <label>{{ t('alert.sourceSignal') }}</label>
                <select v-model.number="form.sourceId" class="input">
                  <option :value="0">{{ t('alert.anySignal') }}</option>
                  <option v-for="s in cameraSignals" :key="s.id" :value="s.id">{{ s.name }}</option>
                </select>
              </div>
              <div class="form-row">
                <div class="form-field half">
                  <label>{{ t('alert.valueEquals') }}</label>
                  <input v-model="form.conditionForm.valueEquals" class="input" />
                </div>
                <div class="form-field half">
                  <label>{{ t('alert.valueNotEquals') }}</label>
                  <input v-model="form.conditionForm.valueNotEquals" class="input" />
                </div>
              </div>
            </template>
            <div class="form-row">
              <div class="form-field half">
                <label>{{ t('alert.windowSeconds') }}</label>
                <input v-model.number="form.windowSeconds" type="number" class="input" />
              </div>
              <div class="form-field half">
                <label>{{ t('alert.triggerCount') }}</label>
                <input v-model.number="form.threshold" type="number" class="input" />
              </div>
            </div>
            <div class="form-row">
              <div class="form-field half">
                <label>{{ t('alert.cooldown') }}</label>
                <input v-model.number="form.cooldownSeconds" type="number" class="input" />
              </div>
            </div>
            <div class="form-row">
              <div class="form-field half">
                <label>{{ t('alert.silentStartLabel') }}</label>
                <input v-model="form.silentStart" type="time" class="input" />
              </div>
              <div class="form-field half">
                <label>{{ t('alert.silentEndLabel') }}</label>
                <input v-model="form.silentEnd" type="time" class="input" />
              </div>
            </div>
            <div class="edit-actions">
              <button class="save-btn" @click="saveEdit">{{ t('alert.save') }}</button>
              <button class="cancel-btn" @click="cancelEdit">{{ t('alert.cancel') }}</button>
            </div>
          </div>
        </template>
        <!-- 显示模式 -->
        <template v-else>
          <div class="rule-header">
            <button class="toggle-btn" @click="toggleRule(rule)">
              {{ rule.enabled ? '●' : '○' }}
            </button>
            <span class="rule-name" :class="{ disabled: !rule.enabled }">{{ rule.name }}</span>
            <button class="edit-btn" @click="startEdit(rule)">{{ t('alert.edit') }}</button>
            <button class="delete-btn" @click="deleteRule(rule.id)">{{ t('alert.delete') }}</button>
          </div>
          <div class="rule-meta">
            <span class="meta-tag">{{ eventTypeLabel(rule.eventType) }}</span>
            <span class="meta-tag source">{{ sourceLabel(rule) }}</span>
            <span v-if="rule.cameraId" class="meta-tag cam">{{ cameraNameMap.get(rule.cameraId) ?? rule.cameraId }}</span>
            <span v-if="rule.condition" class="meta-tag cond">{{ rule.condition }}</span>
            <span class="meta-info">{{ rule.threshold }}{{ t('alert.timesUnit') }} / {{ rule.windowSeconds }}{{ t('alert.secondsUnit') }} · {{ t('alert.cooldownLabel') }}{{ rule.cooldownSeconds }}{{ t('alert.secondsUnit') }}</span>
            <span v-if="rule.silentStart && rule.silentEnd" class="meta-tag silent">{{ t('alert.silentLabel') }} {{ rule.silentStart }}-{{ rule.silentEnd }}</span>
          </div>
        </template>
      </div>
    </div>

    <!-- 告警历史 -->
    <div v-if="activeView === 'history'" class="history-filters">
      <select v-model="filterCamera" @change="loadAlerts()" class="filter-select" :title="t('alert.filterCamera')">
        <option value="">{{ t('alert.allCameras') }}</option>
        <option v-for="cam in (cameras ?? [])" :key="cam.id" :value="cam.id">{{ cam.name }}</option>
      </select>
      <input type="date" v-model="filterDate" @change="loadAlerts()" class="filter-date" :title="t('alert.filterDate')" />
      <span v-if="alertTotal > 0" class="alert-total">{{ t('alert.totalCount', { count: alertTotal }) }}</span>
      <button class="csv-btn" @click="exportCsv" :title="t('alert.exportCsv')">CSV</button>
    </div>
    <div v-if="activeView === 'history'" class="alert-list">
      <div v-if="alerts.length === 0" class="empty">{{ t('alert.noAlertRecords') }}</div>
      <div v-for="alert in alerts" :key="alert.id" :class="['alert-item', { 'new-alert': alert.isNew }]" @click="emit('jumpToRecording', alert.cameraId, alert.timestamp)">
        <div class="alert-info">
          <div class="alert-time">{{ formatTime(alert.timestamp) }}</div>
          <div class="alert-body">
            <span class="alert-rule">{{ alert.ruleName }}</span>
            <span class="alert-cam">{{ cameraNameMap.get(alert.cameraId) ?? alert.cameraId }}</span>
          </div>
          <div v-if="alert.detail" class="alert-detail">{{ formatDetail(alert.detail) }}</div>
        </div>
      </div>
      <button v-if="hasMore" class="load-more-btn" @click="loadMoreAlerts">{{ t('alert.loadMore') }}</button>
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

.rule-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.rule-item {
  padding: 8px;
  border-radius: 4px;
  border: 1px solid transparent;
}

.rule-item:hover { background: #2a2a4a; }

.toggle-btn {
  background: none;
  border: none;
  font-size: 12px;
  cursor: pointer;
  padding: 0;
  color: #4ECDC4;
}

.edit-btn {
  background: none;
  border: none;
  color: #888;
  font-size: 11px;
  cursor: pointer;
}

.edit-btn:hover { color: #4ECDC4; }

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
.meta-tag.source { color: #9C27B0; }
.meta-tag.cond { color: #FF9800; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-tag.silent { color: #e74c3c; }

.meta-info {
  font-size: 11px;
  color: #555;
}

.filter-date::-webkit-calendar-picker-indicator {
  filter: invert(0.7);
}

.alert-total {
  margin-left: auto;
  font-size: 11px;
  color: #666;
}

.alert-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.csv-btn {
  background: #2a2a4a;
  color: #e0e0e0;
  border: none;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}

.csv-btn:hover { background: #3a3a5a; }

.alert-item {
  display: flex;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  border-left: 3px solid #FFD93D;
  margin-bottom: 4px;
  background: #16213e;
  cursor: pointer;
  transition: background 0.15s;
}

.alert-item:hover { background: #1a2a4a; }

.alert-item.new-alert { animation: alert-flash 1s ease-out; }

@keyframes alert-flash {
  0% { background: rgba(255, 217, 61, 0.25); }
  100% { background: #16213e; }
}

.alert-info {
  flex: 1;
  min-width: 0;
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
