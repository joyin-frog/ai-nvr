<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { authFetch, authUrl } from '../services/auth'
import { useToast } from '../composables/useToast'
import { confirmDialog } from '../composables/useConfirm'

/** ROI 区域 */
interface RoiItem {
  id: number
  cameraId: string
  name: string
  points: string
  enabled: boolean
}

/** 检测规则 */
interface DetectRule {
  id: number
  name: string
  cameraId: string
  roiId: number
  prompt: string
  intervalMs: number
  cooldownMs: number
  enabled: boolean
  /** AI 推理分辨率（0=使用全局配置） */
  imageWidth: number
  /** 关联的状态 ID 列表 */
  stateIds: number[]
  /** 时段配置 JSON */
  schedule: string
  /** 匹配时是否保存原图 */
  saveOriginal: boolean
  /** 是否输出目标区域坐标 */
  outputRegions: boolean
}

/** 检测记录 */
interface DetectRuleRecord {
  id: number
  ruleId: number
  ruleName: string
  cameraId: string
  timestamp: number
  result: string
  matched: boolean
  detail: string
  snapshotUrl?: string | null
  isNew?: boolean
}

const { t, locale } = useI18n()
const { error: toastError } = useToast()

const rules = ref<DetectRule[]>([])
const records = ref<DetectRuleRecord[]>([])
const loading = ref(false)

/** 历史筛选 */
const filterCamera = ref('')
const filterDate = ref('')
const filterMatched = ref(false)
const recordOffset = ref(0)
const PAGE_SIZE = 50
const recordTotal = ref(0)

const props = defineProps<{
  cameras?: Array<{ id: string; name: string }>
}>()

const emit = defineEmits<{
  jumpToRecording: [cameraId: string, timestamp: number]
}>()

/** 摄像头 ID → 名称映射 */
const cameraNameMap = computed(() => {
  const map: Record<string, string> = {}
  for (const cam of (props.cameras ?? [])) {
    map[cam.id] = cam.name
  }
  return map
})

/** 可选的状态列表 */
interface StateItem { id: number; name: string; cameraId: string; valueType: string; currentValue: string }
const stateList = ref<StateItem[]>([])

/** 表单状态 */
const showAddForm = ref(false)
const editingRuleId = ref<number | null>(null)
/** 高级设置折叠状态 */
const showAdvanced = ref(false)
const roiList = ref<RoiItem[]>([])

const form = ref({
  name: '',
  cameraId: '',
  roiId: 0,
  prompt: '',
  intervalMs: 5000,
  cooldownMs: 30000,
  imageWidth: 0,
  stateIds: [] as number[],
  scheduleEnabled: false,
  scheduleStart: '08:00',
  scheduleEnd: '18:00',
  scheduleDays: [1, 2, 3, 4, 5] as number[],
  saveOriginal: true,
  outputRegions: false,
})

const emptyForm = {
  name: '', cameraId: '', roiId: 0, prompt: '', intervalMs: 5000, cooldownMs: 30000,
  imageWidth: 0, stateIds: [] as number[], scheduleEnabled: false,
  scheduleStart: '08:00', scheduleEnd: '18:00', scheduleDays: [1, 2, 3, 4, 5] as number[],
  saveOriginal: true, outputRegions: false,
}

/** 星期选项 */
const dayOptions = [
  { value: 1, label: () => t('detectRule.dayMon') },
  { value: 2, label: () => t('detectRule.dayTue') },
  { value: 3, label: () => t('detectRule.dayWed') },
  { value: 4, label: () => t('detectRule.dayThu') },
  { value: 5, label: () => t('detectRule.dayFri') },
  { value: 6, label: () => t('detectRule.daySat') },
  { value: 7, label: () => t('detectRule.daySun') },
]

/** 可选的状态列表（按摄像头过滤） */
const availableStates = computed(() => {
  const camId = form.value.cameraId
  return stateList.value.filter(s => !s.cameraId || s.cameraId === camId)
})

/** 状态 ID -> 名称映射（用于规则卡片显示） */
const stateNameMap = computed(() => {
  const map: Record<number, string> = {}
  for (const s of stateList.value) map[s.id] = s.name
  return map
})

/** 快速创建状态 */
const quickStateName = ref('')

async function quickCreateState() {
  const name = quickStateName.value.trim()
  if (!name) return
  try {
    const res = await authFetch('/api/states', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        cameraId: form.value.cameraId || '',
        valueType: 'boolean',
        initialValue: 'false',
        enabled: true,
      }),
    })
    if (res.ok) {
      const state = await res.json()
      form.value.stateIds.push(state.id)
      quickStateName.value = ''
      await loadStateList()
    }
  } catch { /* ignore */ }
}

/** 构建 schedule JSON */
function buildScheduleJson(): string {
  if (!form.value.scheduleEnabled) return ''
  return JSON.stringify({
    enabled: true,
    start: form.value.scheduleStart,
    end: form.value.scheduleEnd,
    days: form.value.scheduleDays,
  })
}

/** 解析 schedule JSON 到表单 */
function parseScheduleJson(json: string) {
  if (!json) { form.value.scheduleEnabled = false; return }
  const s = JSON.parse(json)
  form.value.scheduleEnabled = !!s.enabled
  form.value.scheduleStart = s.start ?? '08:00'
  form.value.scheduleEnd = s.end ?? '18:00'
  form.value.scheduleDays = s.days ?? [1, 2, 3, 4, 5]
}

/** 切换星期选择 */
function toggleDay(day: number) {
  const idx = form.value.scheduleDays.indexOf(day)
  if (idx >= 0) form.value.scheduleDays.splice(idx, 1)
  else form.value.scheduleDays.push(day)
  form.value.scheduleDays.sort()
}

/** 切换状态选择 */
function toggleStateId(id: number) {
  const idx = form.value.stateIds.indexOf(id)
  if (idx >= 0) form.value.stateIds.splice(idx, 1)
  else form.value.stateIds.push(id)
}

/** 当前选中摄像头对应的 ROI */
const cameraRoiOptions = computed(() => {
  if (!form.value.cameraId) return roiList.value
  return roiList.value.filter(r => r.cameraId === form.value.cameraId)
})

/** 加载 ROI 列表 */
async function loadRoiList() {
  try {
    const res = await authFetch('/api/roi')
    if (res.ok) roiList.value = await res.json()
  } catch {
    // ignore
  }
}

/** 加载状态列表 */
async function loadStateList() {
  try {
    const res = await authFetch('/api/states')
    if (res.ok) stateList.value = await res.json()
  } catch {
    // ignore
  }
}

/** 加载规则 */
async function loadRules() {
  loading.value = true
  try {
    const res = await authFetch('/api/detect-rules')
    if (res.ok) rules.value = await res.json()
  } catch {
    // ignore
  } finally {
    loading.value = false
  }
}

/** 加载检测记录 */
async function loadRecords(append = false) {
  try {
    const params = new URLSearchParams()
    params.set('limit', String(PAGE_SIZE))
    if (!append) recordOffset.value = 0
    params.set('offset', String(recordOffset.value))
    if (filterCamera.value) params.set('cameraId', filterCamera.value)
    if (filterMatched.value) params.set('matched', '1')
    if (filterDate.value) {
      const since = new Date(`${filterDate.value}T00:00:00`).getTime()
      const until = since + 86_400_000
      params.set('since', String(since))
      params.set('until', String(until))
    }
    const res = await authFetch(`/api/detect-rules/history?${params}`)
    if (res.ok) {
      const data = await res.json()
      records.value = append ? [...records.value, ...data.records] : data.records
      recordTotal.value = data.total ?? records.value.length
    }
  } catch {
    // ignore
  }
}

function loadMoreRecords() {
  recordOffset.value += PAGE_SIZE
  loadRecords(true)
}

const hasMore = computed(() => records.value.length < recordTotal.value)

/** 添加规则 */
async function addRule() {
  if (!form.value.name || !form.value.cameraId || !form.value.prompt) return
  try {
    const body = { ...form.value, schedule: buildScheduleJson() }
    delete (body as Record<string, unknown>).scheduleEnabled
    delete (body as Record<string, unknown>).scheduleStart
    delete (body as Record<string, unknown>).scheduleEnd
    delete (body as Record<string, unknown>).scheduleDays
    const res = await authFetch('/api/detect-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      showAddForm.value = false
      form.value = { ...emptyForm }
      loadRules()
    } else {
      toastError(t('alert.saveFailed'))
    }
  } catch {
    toastError(t('alert.saveFailed'))
  }
}

/** 编辑规则 */
function startEdit(rule: DetectRule) {
  editingRuleId.value = rule.id
  showAddForm.value = false
  form.value = {
    name: rule.name,
    cameraId: rule.cameraId,
    roiId: rule.roiId,
    prompt: rule.prompt,
    intervalMs: rule.intervalMs,
    cooldownMs: rule.cooldownMs,
    imageWidth: rule.imageWidth ?? 0,
    stateIds: rule.stateIds ?? [],
    scheduleEnabled: false,
    scheduleStart: '08:00',
    scheduleEnd: '18:00',
    scheduleDays: [1, 2, 3, 4, 5],
    saveOriginal: rule.saveOriginal ?? true,
    outputRegions: rule.outputRegions ?? false,
  }
  parseScheduleJson(rule.schedule ?? '')
  /** 有高级配置时自动展开 */
  showAdvanced.value = (rule.imageWidth > 0) || (rule.stateIds?.length > 0) || !!rule.schedule || !rule.saveOriginal || rule.outputRegions
}

async function saveEdit() {
  if (!editingRuleId.value || !form.value.name) return
  try {
    const body = { ...form.value, schedule: buildScheduleJson() }
    delete (body as Record<string, unknown>).scheduleEnabled
    delete (body as Record<string, unknown>).scheduleStart
    delete (body as Record<string, unknown>).scheduleEnd
    delete (body as Record<string, unknown>).scheduleDays
    const res = await authFetch(`/api/detect-rules/${editingRuleId.value}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      editingRuleId.value = null
      form.value = { ...emptyForm }
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
  form.value = { ...emptyForm }
}

/** 切换启用 */
async function toggleRule(rule: DetectRule) {
  try {
    await authFetch(`/api/detect-rules/${rule.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !rule.enabled }),
    })
    loadRules()
  } catch {
    toastError(t('alert.saveFailed'))
  }
}

/** 删除规则 */
async function deleteRule(id: number) {
  if (!await confirmDialog(t('alert.confirmDelete'))) return
  try {
    await authFetch(`/api/detect-rules/${id}`, { method: 'DELETE' })
    loadRules()
  } catch {
    toastError(t('alert.deleteFailed'))
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(locale.value)
}

/** 提示词快速模板 */
const promptTemplates = computed(() => [
  { label: t('detectRule.tplSceneGuard', '场景守护'), prompt: t('detectRule.tplSceneGuardPrompt', 'Is there any abnormal activity, intruder, or unauthorized person/vehicle in the scene?') },
  { label: t('detectRule.tplPersonSafety', '人员安全'), prompt: t('detectRule.tplPersonSafetyPrompt', 'Is any person in danger, fallen, showing distress, or in a restricted/dangerous area?') },
  { label: t('detectRule.tplVehicle', '车辆异常'), prompt: t('detectRule.tplVehiclePrompt', 'Are there any vehicles parked illegally, staying too long, or in no-parking zones?') },
  { label: t('detectRule.tplFire', '消防安全'), prompt: t('detectRule.tplFirePrompt', 'Is there any sign of fire, smoke, or dangerous situation visible in the scene?') },
  { label: t('detectRule.tplCrowd', '人群聚集'), prompt: t('detectRule.tplCrowdPrompt', 'Is there an unusual crowd gathering or abnormal grouping of people?') },
  { label: t('detectRule.tplAnimal', '动物检测'), prompt: t('detectRule.tplAnimalPrompt', 'Are there any animals (dogs, cats, birds, etc.) visible in the scene?') },
])

function applyTemplate(prompt: string) {
  form.value.prompt = prompt
}

/** textarea 自动增长高度 */
function autoGrowTextarea(e: Event) {
  const el = e.target as HTMLTextAreaElement
  el.style.height = 'auto'
  el.style.height = `${Math.max(80, el.scrollHeight)}px`
}

/** 展开的记录 ID */
const expandedRecordId = ref<number | null>(null)

function toggleExpand(record: DetectRuleRecord) {
  expandedRecordId.value = expandedRecordId.value === record.id ? null : record.id
}

/** 解析 detail JSON */
function parseDetail(detail: string): { confidence?: number; prompt?: string; rawResponse?: string; regions?: Array<{ label: string; box: { xmin: number; ymin: number; xmax: number; ymax: number } }> } {
  if (!detail) return {}
  try { return JSON.parse(detail) } catch { return {} }
}

/** 快照图片加载后叠加 regions 检测框 */
function onSnapshotLoad(e: Event, record: DetectRuleRecord) {
  const img = e.target as HTMLImageElement
  const regions = parseDetail(record.detail).regions
  if (!regions?.length) return

  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.drawImage(img, 0, 0)
  for (const r of regions) {
    const { xmin, ymin, xmax, ymax } = r.box
    const x = xmin * canvas.width
    const y = ymin * canvas.height
    const w = (xmax - xmin) * canvas.width
    const h = (ymax - ymin) * canvas.height

    ctx.strokeStyle = '#FF6B6B'
    ctx.lineWidth = 2
    ctx.setLineDash([6, 3])
    ctx.strokeRect(x, y, w, h)
    ctx.setLineDash([])

    if (r.label) {
      ctx.font = 'bold 12px sans-serif'
      const tw = ctx.measureText(r.label).width + 8
      ctx.fillStyle = 'rgba(255, 107, 107, 0.85)'
      ctx.fillRect(x, y - 16, tw, 16)
      ctx.fillStyle = '#fff'
      ctx.textBaseline = 'middle'
      ctx.fillText(r.label, x + 4, y - 8)
    }
  }
  img.src = canvas.toDataURL('image/jpeg', 0.9)
}

/** 实时追加记录 */
function addRecord(payload: { ruleId: number; ruleName: string; cameraId: string; timestamp: number; result: string; confidence: number }) {
  if (filterCamera.value && filterCamera.value !== payload.cameraId) return
  if (filterMatched.value) return
  const record: DetectRuleRecord = {
    id: -(Date.now()),
    ruleId: payload.ruleId,
    ruleName: payload.ruleName,
    cameraId: payload.cameraId,
    timestamp: payload.timestamp,
    result: payload.result,
    matched: true,
    detail: '',
    isNew: true,
  }
  records.value.unshift(record)
  recordTotal.value++
  const recordId = record.id
  setTimeout(() => {
    const r = records.value.find(a => a.id === recordId)
    if (r) r.isNew = false
  }, 1000)
}

/** Tab 切换 */
const activeView = ref<'rules' | 'history'>('rules')

/** 导出 CSV */
async function exportCsv() {
  const params = new URLSearchParams({ limit: '10000', offset: '0' })
  if (filterCamera.value) params.set('cameraId', filterCamera.value)
  if (filterMatched.value) params.set('matched', '1')
  if (filterDate.value) {
    const since = new Date(`${filterDate.value}T00:00:00`).getTime()
    params.set('since', String(since))
    params.set('until', String(since + 86_400_000))
  }
  const res = await authFetch(`/api/detect-rules/history?${params}`)
  if (!res.ok) return
  const { records: rows } = await res.json() as { records: DetectRuleRecord[] }
  const header = 'ID,Rule,Camera,Time,Matched,Result'
  const csvRows = rows.map(r =>
    `${r.id},"${r.ruleName}","${cameraNameMap.value[r.cameraId] ?? r.cameraId}","${new Date(r.timestamp).toLocaleString(locale.value)}",${r.matched ? 'Yes' : 'No'},"${(r.result ?? '').replace(/"/g, '""')}"`
  )
  const csv = [header, ...csvRows].join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const link = document.createElement('a')
  const dateStr = filterDate.value || new Date().toISOString().slice(0, 10)
  link.href = URL.createObjectURL(blob)
  link.download = `detect_rules_${dateStr}.csv`
  link.click()
  URL.revokeObjectURL(link.href)
}

onMounted(() => {
  loadRules()
  loadRecords()
  loadRoiList()
  loadStateList()
})

defineExpose({ loadRecords, addRecord, switchToHistory })

function switchToHistory() {
  activeView.value = 'history'
  loadRecords()
}
</script>

<template>
  <div class="detect-rule-panel">
    <div class="panel-header">
      <span>{{ t('detectRule.title') }}</span>
      <button class="refresh-btn" @click="loadRules(); loadRecords()" :disabled="loading">{{ t('alert.refresh') }}</button>
      <button class="add-btn" @click="showAddForm = !showAddForm">{{ showAddForm ? t('alert.cancel') : t('alert.addRuleShort') }}</button>
    </div>

    <!-- 添加表单 -->
    <div v-if="showAddForm" class="add-form">
      <div class="form-field">
        <label>{{ t('detectRule.name') }}</label>
        <input v-model="form.name" :placeholder="t('detectRule.namePlaceholder')" class="input" />
      </div>
      <div class="form-field">
        <label>{{ t('detectRule.camera') }}</label>
        <select v-model="form.cameraId" class="input">
          <option value="" disabled>{{ t('detectRule.cameraPlaceholder') }}</option>
          <option v-for="cam in (cameras ?? [])" :key="cam.id" :value="cam.id">{{ cam.name }}</option>
        </select>
      </div>
      <div class="form-field" v-if="cameraRoiOptions.length > 0">
        <label>ROI</label>
        <select v-model.number="form.roiId" class="input">
          <option :value="0">{{ t('detectRule.allRegions') }}</option>
          <option v-for="roi in cameraRoiOptions" :key="roi.id" :value="roi.id">{{ roi.name || `ROI #${roi.id}` }}</option>
        </select>
      </div>
      <div class="form-field">
        <label>{{ t('detectRule.prompt') }}</label>
        <textarea v-model="form.prompt" :placeholder="t('detectRule.promptPlaceholder')" class="input textarea auto-grow" rows="3" @input="autoGrowTextarea"></textarea>
      </div>
      <div class="prompt-templates">
        <div class="template-chips">
          <button v-for="tpl in promptTemplates" :key="tpl.label" :class="['tpl-chip', { active: form.prompt === tpl.prompt }]" @click="applyTemplate(tpl.prompt)">{{ tpl.label }}</button>
        </div>
      </div>
      <div class="form-row">
        <div class="form-field half">
          <label>{{ t('detectRule.interval') }}</label>
          <input v-model.number="form.intervalMs" type="number" step="1000" min="1000" class="input" />
        </div>
        <div class="form-field half">
          <label>{{ t('detectRule.cooldown') }}</label>
          <input v-model.number="form.cooldownMs" type="number" step="1000" min="1000" class="input" />
        </div>
      </div>
      <!-- 关联状态 -->
      <div class="form-field">
        <label>{{ t('detectRule.linkedStates') }}</label>
        <div v-if="availableStates.length > 0" class="chip-group">
          <button
            v-for="st in availableStates" :key="st.id"
            :class="['state-chip', { selected: form.stateIds.includes(st.id) }]"
            @click="toggleStateId(st.id)"
          >{{ st.name }}</button>
        </div>
        <div v-else class="chip-group">
          <span class="hint-inline">{{ t('detectRule.noStatesYet') }}</span>
        </div>
        <div class="quick-state-row">
          <input v-model="quickStateName" class="input quick-state-input" :placeholder="t('detectRule.quickStatePlaceholder')" @keyup.enter="quickCreateState" />
          <button class="quick-state-btn" @click="quickCreateState" :disabled="!quickStateName.trim()">{{ t('detectRule.quickCreate') }}</button>
        </div>
        <span class="hint">{{ t('detectRule.linkedStatesHint') }}</span>
      </div>
      <!-- 高级设置 -->
      <button class="advanced-toggle" @click="showAdvanced = !showAdvanced">
        {{ showAdvanced ? '▾' : '▸' }} {{ t('settings.title') }}
      </button>
      <div v-if="showAdvanced" class="advanced-section">
        <div class="form-row">
          <div class="form-field half">
            <label>{{ t('settings.aiInputWidth') }}</label>
            <input v-model.number="form.imageWidth" type="number" min="0" step="64" class="input" :placeholder="'0 = auto'" />
          </div>
          <div class="form-field half">
            <label class="checkbox-label">
              <input type="checkbox" v-model="form.saveOriginal" />
              {{ t('state.saveOriginal') }}
            </label>
          </div>
        </div>
        <div class="form-row">
          <div class="form-field half">
            <label class="checkbox-label">
              <input type="checkbox" v-model="form.outputRegions" />
              {{ t('detectRule.outputRegions') }}
            </label>
          </div>
        </div>
        <!-- 启用时段 -->
        <div class="schedule-section">
          <label class="checkbox-label">
            <input type="checkbox" v-model="form.scheduleEnabled" />
            {{ t('detectRule.schedule') }}
          </label>
          <template v-if="form.scheduleEnabled">
            <div class="schedule-times">
              <input type="time" v-model="form.scheduleStart" class="input time-input" />
              <span class="time-sep">~</span>
              <input type="time" v-model="form.scheduleEnd" class="input time-input" />
            </div>
            <div class="day-chips">
              <button v-for="d in dayOptions" :key="d.value"
                :class="['day-chip', { selected: form.scheduleDays.includes(d.value) }]"
                @click="toggleDay(d.value)"
              >{{ d.label() }}</button>
            </div>
          </template>
        </div>
      </div>
      <button class="submit-btn" @click="addRule">{{ t('alert.confirmAdd') }}</button>
    </div>

    <!-- 视图切换 -->
    <div class="view-tabs">
      <button :class="['view-btn', { active: activeView === 'rules' }]" @click="activeView = 'rules'">{{ t('detectRule.rulesTab') }} ({{ rules.length }})</button>
      <button :class="['view-btn', { active: activeView === 'history' }]" @click="activeView = 'history'; loadRecords()">{{ t('detectRule.historyTab') }} ({{ records.length }})</button>
    </div>

    <!-- 规则列表 -->
    <div v-if="activeView === 'rules'" class="rule-list">
      <div v-if="rules.length === 0" class="empty">{{ loading ? t('alert.loading') : t('detectRule.noRules') }}</div>
      <div v-for="rule in rules" :key="rule.id" class="rule-item">
        <!-- 编辑模式 -->
        <template v-if="editingRuleId === rule.id">
          <div class="edit-form">
            <div class="form-field">
              <label>{{ t('detectRule.name') }}</label>
              <input v-model="form.name" class="input" />
            </div>
            <div class="form-field">
              <label>{{ t('detectRule.camera') }}</label>
              <select v-model="form.cameraId" class="input">
                <option v-for="cam in (cameras ?? [])" :key="cam.id" :value="cam.id">{{ cam.name }}</option>
              </select>
            </div>
            <div class="form-field" v-if="cameraRoiOptions.length > 0">
              <label>ROI</label>
              <select v-model.number="form.roiId" class="input">
                <option :value="0">{{ t('detectRule.allRegions') }}</option>
                <option v-for="roi in cameraRoiOptions" :key="roi.id" :value="roi.id">{{ roi.name || `ROI #${roi.id}` }}</option>
              </select>
            </div>
            <div class="form-field">
              <label>{{ t('detectRule.prompt') }}</label>
              <textarea v-model="form.prompt" class="input textarea auto-grow" rows="3" @input="autoGrowTextarea"></textarea>
            </div>
            <div class="prompt-templates">
              <div class="template-chips">
                <button v-for="tpl in promptTemplates" :key="tpl.label" :class="['tpl-chip', { active: form.prompt === tpl.prompt }]" @click="applyTemplate(tpl.prompt)">{{ tpl.label }}</button>
              </div>
            </div>
            <div class="form-row">
              <div class="form-field half">
                <label>{{ t('detectRule.interval') }}</label>
                <input v-model.number="form.intervalMs" type="number" class="input" />
              </div>
              <div class="form-field half">
                <label>{{ t('detectRule.cooldown') }}</label>
                <input v-model.number="form.cooldownMs" type="number" class="input" />
              </div>
            </div>
            <!-- 关联状态（编辑） -->
            <div class="form-field">
              <label>{{ t('detectRule.linkedStates') }}</label>
              <div v-if="availableStates.length > 0" class="chip-group">
                <button
                  v-for="st in availableStates" :key="st.id"
                  :class="['state-chip', { selected: form.stateIds.includes(st.id) }]"
                  @click="toggleStateId(st.id)"
                >{{ st.name }}</button>
              </div>
              <div v-else class="chip-group">
                <span class="hint-inline">{{ t('detectRule.noStatesYet') }}</span>
              </div>
              <div class="quick-state-row">
                <input v-model="quickStateName" class="input quick-state-input" :placeholder="t('detectRule.quickStatePlaceholder')" @keyup.enter="quickCreateState" />
                <button class="quick-state-btn" @click="quickCreateState" :disabled="!quickStateName.trim()">{{ t('detectRule.quickCreate') }}</button>
              </div>
              <span class="hint">{{ t('detectRule.linkedStatesHint') }}</span>
            </div>
            <!-- 高级设置（编辑） -->
            <button class="advanced-toggle" @click="showAdvanced = !showAdvanced">
              {{ showAdvanced ? '▾' : '▸' }} {{ t('settings.title') }}
            </button>
            <div v-if="showAdvanced" class="advanced-section">
              <div class="form-row">
                <div class="form-field half">
                  <label>{{ t('settings.aiInputWidth') }}</label>
                  <input v-model.number="form.imageWidth" type="number" min="0" step="64" class="input" :placeholder="'0 = auto'" />
                </div>
                <div class="form-field half">
                  <label class="checkbox-label">
                    <input type="checkbox" v-model="form.saveOriginal" />
                    {{ t('state.saveOriginal') }}
                  </label>
                </div>
              </div>
              <div class="form-row">
                <div class="form-field half">
                  <label class="checkbox-label">
                    <input type="checkbox" v-model="form.outputRegions" />
                    {{ t('detectRule.outputRegions') }}
                  </label>
                </div>
              </div>
              <div class="schedule-section">
                <label class="checkbox-label">
                  <input type="checkbox" v-model="form.scheduleEnabled" />
                  {{ t('detectRule.schedule') }}
                </label>
                <template v-if="form.scheduleEnabled">
                  <div class="schedule-times">
                    <input type="time" v-model="form.scheduleStart" class="input time-input" />
                    <span class="time-sep">~</span>
                    <input type="time" v-model="form.scheduleEnd" class="input time-input" />
                  </div>
                  <div class="day-chips">
                    <button v-for="d in dayOptions" :key="d.value"
                      :class="['day-chip', { selected: form.scheduleDays.includes(d.value) }]"
                      @click="toggleDay(d.value)"
                    >{{ d.label() }}</button>
                  </div>
                </template>
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
            <span class="meta-tag cam">{{ cameraNameMap[rule.cameraId] ?? rule.cameraId }}</span>
            <span v-if="rule.roiId > 0" class="meta-tag roi">ROI #{{ rule.roiId }}</span>
            <span class="meta-info">{{ rule.intervalMs / 1000 }}{{ t('detectRule.secondsUnit') }} · {{ t('detectRule.cooldownLabel') }}{{ rule.cooldownMs / 1000 }}{{ t('detectRule.secondsUnit') }}</span>
            <template v-if="rule.stateIds?.length > 0">
              <span v-for="sid in rule.stateIds" :key="sid" class="meta-tag state">{{ stateNameMap[sid] ?? `#${sid}` }}</span>
            </template>
            <span class="meta-prompt">{{ rule.prompt.slice(0, 60) }}{{ rule.prompt.length > 60 ? '...' : '' }}</span>
          </div>
        </template>
      </div>
    </div>

    <!-- 历史记录 -->
    <div v-if="activeView === 'history'" class="history-filters">
      <select v-model="filterCamera" @change="loadRecords()" class="filter-select" :title="t('alert.filterCamera')">
        <option value="">{{ t('alert.allCameras') }}</option>
        <option v-for="cam in (cameras ?? [])" :key="cam.id" :value="cam.id">{{ cam.name }}</option>
      </select>
      <input type="date" v-model="filterDate" @change="loadRecords()" class="filter-date" :title="t('alert.filterDate')" />
      <button :class="['filter-match-btn', { active: filterMatched }]" @click="filterMatched = !filterMatched; loadRecords()">{{ t('detectRule.matchedOnly') }}</button>
      <span v-if="recordTotal > 0" class="record-total">{{ t('alert.totalCount', { count: recordTotal }) }}</span>
      <button class="csv-btn" @click="exportCsv" :title="t('alert.exportCsv')">CSV</button>
    </div>
    <div v-if="activeView === 'history'" class="record-list">
      <div v-if="records.length === 0" class="empty">{{ t('detectRule.noRecords') }}</div>
      <div v-for="record in records" :key="record.id" :class="['record-item', { 'new-record': record.isNew, expanded: expandedRecordId === record.id }]">
        <div class="record-summary" @click="toggleExpand(record)">
          <div class="record-info">
            <div class="record-time">{{ formatTime(record.timestamp) }}</div>
            <div class="record-body">
              <span class="record-rule">{{ record.ruleName }}</span>
              <span class="record-cam">{{ cameraNameMap[record.cameraId] ?? record.cameraId }}</span>
              <span v-if="record.matched" class="record-matched">{{ t('detectRule.matched') }}</span>
              <span v-else class="record-unmatched">{{ t('detectRule.unmatched') }}</span>
            </div>
            <div v-if="record.result" class="record-result-preview">{{ record.result.slice(0, 80) }}{{ record.result.length > 80 ? '...' : '' }}</div>
          </div>
          <span class="expand-arrow">{{ expandedRecordId === record.id ? '▾' : '▸' }}</span>
        </div>
        <div v-if="expandedRecordId === record.id" class="record-detail">
          <div class="detail-section">
            <div class="detail-label">AI Response</div>
            <div class="detail-text">{{ record.result || '(empty)' }}</div>
          </div>
          <template v-if="parseDetail(record.detail).confidence !== undefined || parseDetail(record.detail).prompt || parseDetail(record.detail).rawResponse">
            <div class="detail-row">
              <span v-if="parseDetail(record.detail).confidence !== undefined" class="detail-tag confidence">
                Confidence: {{ (parseDetail(record.detail).confidence! * 100).toFixed(1) }}%
              </span>
            </div>
            <div v-if="parseDetail(record.detail).rawResponse" class="detail-section">
              <div class="detail-label">Raw Response</div>
              <pre class="detail-code">{{ parseDetail(record.detail).rawResponse }}</pre>
            </div>
            <div v-if="parseDetail(record.detail).prompt" class="detail-section">
              <div class="detail-label">Prompt</div>
              <div class="detail-text detail-prompt">{{ parseDetail(record.detail).prompt }}</div>
            </div>
          </template>
          <div v-if="record.snapshotUrl" class="detail-snapshot">
            <img :src="authUrl(record.snapshotUrl)" class="snapshot-img" loading="lazy" @load="onSnapshotLoad($event, record)" />
          </div>
          <div class="detail-actions">
            <button class="action-btn recording-btn" @click="emit('jumpToRecording', record.cameraId, record.timestamp)">{{ t('detectRule.viewRecording') }}</button>
          </div>
        </div>
      </div>
      <button v-if="hasMore" class="load-more-btn" @click="loadMoreRecords">{{ t('alert.loadMore') }}</button>
    </div>
  </div>
</template>

<style scoped>
.detect-rule-panel {
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
  color: #4ECDC4;
  border-bottom: 2px solid #4ECDC4;
}

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

.textarea {
  resize: vertical;
  min-height: 40px;
  font-family: inherit;
}

.submit-btn {
  width: 100%;
  background: #4ECDC4;
  color: #1a1a2e;
  border: none;
  border-radius: 4px;
  padding: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  margin-top: 4px;
}

.submit-btn:hover { background: #3ad4c8; }

.rule-list, .record-list {
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

.edit-btn {
  background: none;
  border: none;
  color: #888;
  font-size: 11px;
  cursor: pointer;
}

.edit-btn:hover { color: #4ECDC4; }

.edit-form {
  padding: 8px;
  background: #0a0a1a;
  border-radius: 4px;
}

.edit-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}

.save-btn {
  flex: 1;
  background: #4ECDC4;
  color: #1a1a2e;
  border: none;
  border-radius: 4px;
  padding: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.save-btn:hover { background: #3ad4c8; }

.cancel-btn {
  background: #2a2a4a;
  color: #888;
  border: none;
  border-radius: 4px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
}

.cancel-btn:hover { color: #e0e0e0; }

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
.meta-tag.roi { color: #9C27B0; }

.meta-info {
  font-size: 11px;
  color: #555;
}

.meta-prompt {
  font-size: 11px;
  color: #888;
  font-style: italic;
  margin-left: auto;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 历史记录 */
.history-filters {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid #2a2a4a;
  background: #16213e;
}

.filter-select, .filter-date {
  background: #0a0a1a;
  color: #e0e0e0;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 12px;
}

.filter-date::-webkit-calendar-picker-indicator { filter: invert(0.7); }

.filter-match-btn {
  background: #2a2a4a;
  color: #888;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
}

.filter-match-btn:hover { border-color: #4ECDC4; color: #4ECDC4; }
.filter-match-btn.active { background: #4ECDC4; color: #1a1a2e; border-color: #4ECDC4; }

.record-total {
  margin-left: auto;
  font-size: 11px;
  color: #666;
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

.load-more-btn {
  display: block;
  width: 100%;
  background: #2a2a4a;
  color: #e0e0e0;
  border: none;
  border-radius: 4px;
  padding: 6px;
  font-size: 12px;
  cursor: pointer;
  margin-top: 4px;
}

.load-more-btn:hover { background: #3a3a5a; }

.record-item {
  border-radius: 4px;
  border-left: 3px solid #4ECDC4;
  margin-bottom: 4px;
  background: #16213e;
  transition: background 0.15s;
}

.record-item.expanded {
  border-left-color: #3ad4c8;
}

.record-summary {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  padding: 6px 8px;
  cursor: pointer;
}

.record-summary:hover { background: #1a2a4a; }

.record-item.new-record {
  animation: record-flash 1s ease-out;
}

@keyframes record-flash {
  0% { background: rgba(78, 205, 196, 0.25); }
  100% { background: #16213e; }
}

.expand-arrow {
  color: #555;
  font-size: 11px;
  padding-top: 2px;
  flex-shrink: 0;
}

.record-item.expanded .expand-arrow {
  color: #4ECDC4;
}

.record-info {
  flex: 1;
  min-width: 0;
}

.record-time {
  font-size: 11px;
  color: #666;
}

.record-body {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}

.record-rule {
  font-size: 12px;
  color: #4ECDC4;
  font-weight: 500;
}

.record-cam {
  font-size: 11px;
  color: #888;
}

.record-matched {
  font-size: 10px;
  color: #4ade80;
  background: rgba(74, 222, 128, 0.1);
  padding: 0 4px;
  border-radius: 2px;
}

.record-unmatched {
  font-size: 10px;
  color: #666;
}

.record-result-preview {
  font-size: 11px;
  color: #666;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/** 展开的详细内容 */
.record-detail {
  padding: 0 12px 10px;
  border-top: 1px solid #2a2a4a;
}

.detail-section {
  margin-top: 8px;
}

.detail-label {
  font-size: 10px;
  color: #555;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 2px;
}

.detail-text {
  font-size: 12px;
  color: #ccc;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 4px;
  padding: 6px 8px;
}

.detail-prompt {
  color: #888;
  font-style: italic;
}

.detail-code {
  font-size: 11px;
  color: #aaa;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 4px;
  padding: 6px 8px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Menlo', 'Consolas', monospace;
  line-height: 1.4;
  max-height: 200px;
  overflow-y: auto;
}

.detail-row {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.detail-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
}

.detail-tag.confidence {
  background: rgba(78, 205, 196, 0.15);
  color: #4ECDC4;
}

.detail-snapshot {
  margin-top: 8px;
}

.snapshot-img {
  max-width: 100%;
  border-radius: 4px;
  border: 1px solid #2a2a4a;
}

.detail-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.action-btn {
  padding: 4px 12px;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  border: none;
  transition: background 0.15s;
}

.recording-btn {
  background: #2a2a4a;
  color: #4ECDC4;
}

.recording-btn:hover {
  background: #3a3a5a;
}

/** 提示词快速模板 */
.prompt-templates {
  margin-bottom: 6px;
}

.template-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.tpl-chip {
  padding: 3px 8px;
  border: 1px solid #3a3a5a;
  border-radius: 12px;
  background: transparent;
  color: #888;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}

.tpl-chip:hover {
  border-color: #4ECDC4;
  color: #4ECDC4;
}

.tpl-chip.active {
  border-color: #4ECDC4;
  background: rgba(78, 205, 196, 0.15);
  color: #4ECDC4;
}

/** 高级设置折叠 */
.advanced-toggle {
  background: none;
  border: none;
  color: #666;
  font-size: 11px;
  cursor: pointer;
  padding: 4px 0;
  margin-bottom: 4px;
  transition: color 0.15s;
}

.advanced-toggle:hover { color: #aaa; }

.advanced-section {
  padding: 6px 8px;
  margin-bottom: 6px;
  background: rgba(10, 10, 26, 0.5);
  border-radius: 4px;
  border: 1px solid #222;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 12px;
  color: #aaa;
}
.checkbox-label input[type="checkbox"] {
  width: 14px;
  height: 14px;
  accent-color: #4ECDC4;
}

/** 关联状态芯片 */
.chip-group {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  flex: 1;
}

.state-chip {
  padding: 2px 8px;
  border: 1px solid #3a3a5a;
  border-radius: 10px;
  background: transparent;
  color: #888;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}

.state-chip.selected {
  border-color: #4ECDC4;
  background: rgba(78, 205, 196, 0.15);
  color: #4ECDC4;
}

.state-chip:hover {
  border-color: #4ECDC4;
}

.hint-inline {
  font-size: 11px;
  color: #666;
  font-style: italic;
}

.quick-state-row {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}
.quick-state-input {
  flex: 1;
  min-width: 0;
  height: 26px;
  font-size: 11px;
}
.quick-state-btn {
  padding: 2px 10px;
  border: 1px solid #3a3a5a;
  border-radius: 4px;
  background: transparent;
  color: #4ECDC4;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.quick-state-btn:disabled {
  color: #555;
  cursor: not-allowed;
}
.quick-state-btn:hover:not(:disabled) {
  border-color: #4ECDC4;
  background: rgba(78, 205, 196, 0.1);
}

.meta-tag.state {
  border-color: #9C27B0;
  color: #CE93D8;
}

.hint {
  display: block;
  font-size: 10px;
  color: #555;
  margin-top: 2px;
}

/** 启用时段 */
.schedule-section {
  margin-bottom: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.schedule-times {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: 20px;
}

.time-input {
  width: 90px;
}

.time-sep {
  color: #555;
  font-size: 12px;
}

.time-input::-webkit-calendar-picker-indicator {
  filter: invert(0.7);
}

.day-chips {
  display: flex;
  gap: 3px;
  margin-left: 20px;
}

.day-chip {
  padding: 2px 6px;
  border: 1px solid #3a3a5a;
  border-radius: 8px;
  background: transparent;
  color: #666;
  font-size: 10px;
  cursor: pointer;
  transition: all 0.15s;
}

.day-chip.selected {
  border-color: #4ECDC4;
  background: rgba(78, 205, 196, 0.15);
  color: #4ECDC4;
}

.day-chip:hover {
  border-color: #4ECDC4;
}
</style>
