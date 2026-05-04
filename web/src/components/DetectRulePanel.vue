<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useCameraNameMap } from '../composables/useCameraNameMap'
import { authFetch, authUrl } from '../services/auth'
import { useToast } from '../composables/useToast'
import { confirmDialog } from '../composables/useConfirm'

let isNewTimer: ReturnType<typeof setTimeout> | null = null

/** ROI 区域 */
interface RoiItem {
  id: number
  cameraId: string
  name: string
  points: string
  enabled: boolean
}

/** 观测器摄像头源配置 */
interface ObserverCameraSource {
  cameraId: string
  roiId: number
  offsetSec: number
  videoClip?: {
    startOffsetSec: number
    endOffsetSec: number
    extraction: {
      mode: 'fps' | 'total'
      fps?: number
      totalFrames?: number
    }
  }
}

interface Observer {
  id: number
  name: string
  cameras: ObserverCameraSource[]
  prompt: string
  intervalMs: number
  cooldownMs: number
  enabled: boolean
  imageWidth: number
  /** 关联信号 ID（VLM 评估并更新这些信号的值） */
  signalIds: number[]
  schedule: string
  saveOriginal: boolean
  outputRegions: boolean
  refImages: string[]
  modelId: string
}

/** 快照信息（多摄像头） */
interface SnapshotEntry {
  cameraId: string
  url: string
  /** ROI 裁剪后的图片 URL */
  roiUrl?: string
}

/** 检测记录 */
interface ObserverRecord {
  id: number
  observerId: number
  observerName: string
  cameraId: string
  timestamp: number
  result: string
  matched: boolean
  detail: string
  snapshotUrl?: string | null
  /** 多摄像头快照列表 */
  snapshotUrls?: SnapshotEntry[]
  isNew?: boolean
}

const { t, locale } = useI18n()
const { error: toastError } = useToast()

const observers = ref<Observer[]>([])
const records = ref<ObserverRecord[]>([])
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
const { cameraNameMap } = useCameraNameMap(computed(() => props.cameras ?? []))

/** 可选的状态列表 */
interface StateItem { id: number; name: string; cameraId: string; valueType: string; currentValue: string }
const signalList = ref<StateItem[]>([])

/** 可用模型列表 */
interface ModelOption { id: string; name: string; model: string }
const availableModels = ref<ModelOption[]>([])

async function loadModels() {
  const res = await authFetch('/api/settings').catch(() => null)
  if (res?.ok) {
    const data = await res.json() as { ai?: { models?: ModelOption[] } }
    availableModels.value = data.ai?.models ?? []
  }
}

/** 表单状态 */
const showAddForm = ref(false)
const editingObserverId = ref<number | null>(null)
/** 高级设置折叠状态 */
const showAdvanced = ref(false)
const roiList = ref<RoiItem[]>([])

const form = ref({
  name: '',
  cameras: [{ cameraId: '', roiId: 0, offsetSec: 0 }] as ObserverCameraSource[],
  prompt: '',
  intervalMs: 5000,
  cooldownMs: 30000,
  imageWidth: 0,
  signalIds: [] as number[],
  scheduleEnabled: false,
  scheduleStart: '08:00',
  scheduleEnd: '18:00',
  scheduleDays: [1, 2, 3, 4, 5] as number[],
  saveOriginal: true,
  outputRegions: false,
  refImages: [] as string[],
  modelId: '',
})

function createEmptyForm() {
  return {
    name: '', cameras: [{ cameraId: '', roiId: 0, offsetSec: 0 }] as ObserverCameraSource[], prompt: '', intervalMs: 5000, cooldownMs: 30000,
    imageWidth: 0, signalIds: [] as number[], scheduleEnabled: false,
    scheduleStart: '08:00', scheduleEnd: '18:00', scheduleDays: [1, 2, 3, 4, 5] as number[],
    saveOriginal: true, outputRegions: false, refImages: [] as string[], modelId: '',
  }
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

/** 主摄像头 ID */
const primaryCamId = computed(() => form.value.cameras[0]?.cameraId ?? '')

/** 可选的状态列表（按主摄像头过滤） */
const availableSignals = computed(() => {
  const camId = primaryCamId.value
  return signalList.value.filter(s => !s.cameraId || s.cameraId === camId)
})

/** 状态 ID -> 名称映射（用于规则卡片显示） */
const signalNameMap = computed(() => {
  const map: Record<number, string> = {}
  for (const s of signalList.value) map[s.id] = s.name
  return map
})

/** 快速创建状态 */
const quickSignalName = ref('')

async function quickCreateSignal() {
  const name = quickSignalName.value.trim()
  if (!name) return
  try {
    const res = await authFetch('/api/signals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        cameraId: primaryCamId.value || '',
        valueType: 'boolean',
        initialValue: 'false',
        enabled: true,
      }),
    })
    if (res.ok) {
      const state = await res.json()
      form.value.signalIds.push(state.id)
      quickSignalName.value = ''
      await loadSignalList()
    }
  } catch { toastError(t('alert.saveFailed')) }
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

/** 切换信号选择 */
function toggleSignalId(id: number) {
  const idx = form.value.signalIds.indexOf(id)
  if (idx >= 0) form.value.signalIds.splice(idx, 1)
  else form.value.signalIds.push(id)
}

/** 获取指定摄像头对应的 ROI 列表 */
function getRoiOptionsForCamera(cameraId: string): RoiItem[] {
  if (!cameraId) return roiList.value
  return roiList.value.filter(r => r.cameraId === cameraId)
}

/** 加载 ROI 列表 */
async function loadRoiList() {
  try {
    const res = await authFetch('/api/roi')
    if (res.ok) roiList.value = await res.json()
  } catch {
    toastError(t('settings.loadFailed'))
  }
}

/** 加载状态列表 */
async function loadSignalList() {
  try {
    const res = await authFetch('/api/signals')
    if (res.ok) signalList.value = await res.json()
  } catch {
    toastError(t('settings.loadFailed'))
  }
}

/** 加载规则 */
async function loadObservers() {
  loading.value = true
  try {
    const res = await authFetch('/api/observers')
    if (res.ok) observers.value = await res.json()
  } catch {
    toastError(t('settings.loadFailed'))
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
    const res = await authFetch(`/api/observers/history?${params}`)
    if (res.ok) {
      const data = await res.json()
      records.value = append ? [...records.value, ...data.records] : data.records
      recordTotal.value = data.total ?? records.value.length
    }
  } catch {
    toastError(t('settings.loadFailed'))
  }
}

function loadMoreRecords() {
  recordOffset.value += PAGE_SIZE
  loadRecords(true)
}

const hasMore = computed(() => records.value.length < recordTotal.value)

/** 添加规则 */
async function addObserver() {
  if (!form.value.name || !form.value.cameras[0]?.cameraId || !form.value.prompt) return
  try {
    const body = { ...form.value, schedule: buildScheduleJson() }
    delete (body as Record<string, unknown>).scheduleEnabled
    delete (body as Record<string, unknown>).scheduleStart
    delete (body as Record<string, unknown>).scheduleEnd
    delete (body as Record<string, unknown>).scheduleDays
    const res = await authFetch('/api/observers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      showAddForm.value = false
      form.value = createEmptyForm()
      loadObservers()
    } else {
      toastError(t('alert.saveFailed'))
    }
  } catch {
    toastError(t('alert.saveFailed'))
  }
}

/** 编辑规则 */
function startEdit(rule: Observer) {
  editingObserverId.value = rule.id
  showAddForm.value = false
  form.value = {
    name: rule.name,
    cameras: rule.cameras.length > 0 ? rule.cameras.map(c => ({ ...c })) : [{ cameraId: '', roiId: 0, offsetSec: 0 }],
    prompt: rule.prompt,
    intervalMs: rule.intervalMs,
    cooldownMs: rule.cooldownMs,
    imageWidth: rule.imageWidth ?? 0,
    signalIds: rule.signalIds ?? [],
    scheduleEnabled: false,
    scheduleStart: '08:00',
    scheduleEnd: '18:00',
    scheduleDays: [1, 2, 3, 4, 5],
    saveOriginal: rule.saveOriginal ?? true,
    outputRegions: rule.outputRegions ?? false,
    refImages: rule.refImages ?? [],
    modelId: rule.modelId ?? '',
  }
  parseScheduleJson(rule.schedule ?? '')
  showAdvanced.value = (rule.imageWidth > 0) || (rule.signalIds?.length > 0) || !!rule.schedule || !rule.saveOriginal || rule.outputRegions || rule.cameras.length > 1 || (rule.refImages?.length ?? 0) > 0
}

async function saveEdit() {
  if (!editingObserverId.value || !form.value.name) return
  try {
    const body = { ...form.value, schedule: buildScheduleJson() }
    delete (body as Record<string, unknown>).scheduleEnabled
    delete (body as Record<string, unknown>).scheduleStart
    delete (body as Record<string, unknown>).scheduleEnd
    delete (body as Record<string, unknown>).scheduleDays
    const res = await authFetch(`/api/observers/${editingObserverId.value}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      editingObserverId.value = null
      form.value = createEmptyForm()
      loadObservers()
    } else {
      toastError(t('alert.saveFailed'))
    }
  } catch {
    toastError(t('alert.saveFailed'))
  }
}

function cancelEdit() {
  editingObserverId.value = null
  form.value = createEmptyForm()
}

/** 切换启用 */
async function toggleObserver(rule: Observer) {
  try {
    const res = await authFetch(`/api/observers/${rule.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !rule.enabled }),
    })
    if (res.ok) loadObservers()
    else toastError(t('alert.saveFailed'))
  } catch {
    toastError(t('alert.saveFailed'))
  }
}

/** 删除规则 */
async function deleteObserver(id: number) {
  if (!await confirmDialog(t('alert.confirmDelete'))) return
  try {
    const res = await authFetch(`/api/observers/${id}`, { method: 'DELETE' })
    if (res.ok) loadObservers()
    else toastError(t('alert.deleteFailed'))
  } catch {
    toastError(t('alert.deleteFailed'))
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(locale.value)
}

/** 提示词快速模板 */
const promptTemplates = computed(() => [
  { label: t('detectRule.tplSceneGuard'), prompt: t('detectRule.tplSceneGuardPrompt') },
  { label: t('detectRule.tplPersonSafety'), prompt: t('detectRule.tplPersonSafetyPrompt') },
  { label: t('detectRule.tplVehicle'), prompt: t('detectRule.tplVehiclePrompt') },
  { label: t('detectRule.tplFire'), prompt: t('detectRule.tplFirePrompt') },
  { label: t('detectRule.tplCrowd'), prompt: t('detectRule.tplCrowdPrompt') },
  { label: t('detectRule.tplAnimal'), prompt: t('detectRule.tplAnimalPrompt') },
])

function applyTemplate(prompt: string) {
  form.value.prompt = prompt
}

/** AI 规则建议 */
interface AiRuleSuggestion {
  name: string
  prompt: string
  interval: number
  reason: string
}
const aiSuggestions = ref<AiRuleSuggestion[]>([])
const aiSuggestLoading = ref(false)

async function fetchAiSuggestions() {
  if (!primaryCamId.value) return
  aiSuggestLoading.value = true
  aiSuggestions.value = []
  const res = await authFetch('/api/ai/suggest-rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cameraId: primaryCamId.value }),
  }).catch(() => null)
  if (res?.ok) {
    const data = await res.json() as { suggestions?: AiRuleSuggestion[] }
    aiSuggestions.value = data.suggestions ?? []
  }
  aiSuggestLoading.value = false
}

/** 一键应用 AI 建议到表单 */
function applySuggestion(s: AiRuleSuggestion) {
  form.value.name = s.name
  form.value.prompt = s.prompt
  form.value.intervalMs = s.interval
  aiSuggestions.value = []
}

/** textarea 自动增长高度 */
function autoGrowTextarea(e: Event) {
  const el = e.target as HTMLTextAreaElement
  el.style.height = 'auto'
  el.style.height = `${Math.max(80, el.scrollHeight)}px`
}

/** 切换摄像头源的视频片段模式 */
function toggleClipMode(src: ObserverCameraSource) {
  if (src.videoClip) {
    delete src.videoClip
  } else {
    src.videoClip = {
      startOffsetSec: 30,
      endOffsetSec: 5,
      extraction: { mode: 'total', totalFrames: 5 },
    }
  }
}

/** ROI 绘制状态 */
const roiDrawingIdx = ref(-1)
/** 正在编辑的 ROI ID（0=新建） */
const roiEditingId = ref(0)
/** 正在绘制的多边形顶点（归一化坐标） */
const roiDrawPoints = ref<Array<{ x: number; y: number }>>([])

function toggleRoiDraw(idx: number) {
  if (roiDrawingIdx.value === idx) {
    roiDrawingIdx.value = -1
    roiDrawPoints.value = []
    roiEditingId.value = 0
    return
  }
  roiDrawingIdx.value = idx
  roiDrawPoints.value = []
  /** 如果已选中 ROI，加载其顶点用于编辑 */
  const src = form.value.cameras[idx]
  if (src?.roiId && src.roiId > 0) {
    roiEditingId.value = src.roiId
    const roi = roiList.value.find(r => r.id === src.roiId)
    if (roi?.points) {
      try { roiDrawPoints.value = JSON.parse(roi.points) } catch { /* ignore */ }
    }
  } else {
    roiEditingId.value = 0
  }
}

function onRoiImageClick(e: MouseEvent) {
  const img = e.currentTarget as HTMLImageElement
  const rect = img.getBoundingClientRect()
  const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
  roiDrawPoints.value.push({ x, y })
}

function undoRoiPoint() {
  roiDrawPoints.value.pop()
}

async function saveRoiDraw() {
  if (roiDrawPoints.value.length < 3 || roiDrawingIdx.value < 0) return
  const src = form.value.cameras[roiDrawingIdx.value]
  if (!src?.cameraId) return
  try {
    if (roiEditingId.value > 0) {
      /** 编辑已有 ROI */
      const res = await authFetch(`/api/roi/item/${roiEditingId.value}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: JSON.stringify(roiDrawPoints.value) }),
      })
      if (res.ok) {
        roiDrawPoints.value = []
        roiDrawingIdx.value = -1
        roiEditingId.value = 0
        await loadRoiList()
      }
    } else {
      /** 新建 ROI */
      const res = await authFetch('/api/roi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cameraId: src.cameraId,
          name: `ROI ${roiList.value.filter(r => r.cameraId === src.cameraId).length + 1}`,
          points: JSON.stringify(roiDrawPoints.value),
        }),
      })
      if (res.ok) {
        const roi = await res.json() as { id: number }
        src.roiId = roi.id
        roiDrawPoints.value = []
        roiDrawingIdx.value = -1
        roiEditingId.value = 0
        await loadRoiList()
      }
    }
  } catch { toastError(t('settings.saveFailed')) }
}

function cancelRoiDraw() {
  roiDrawPoints.value = []
  roiDrawingIdx.value = -1
  roiEditingId.value = 0
}

/** 上传参考图片 */
const refImageUploading = ref(false)
async function uploadRefImage(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  refImageUploading.value = true
  const formData = new FormData()
  formData.append('image', file)
  const res = await authFetch('/api/observers/ref-images', {
    method: 'POST',
    body: formData,
  }).catch(() => null)
  if (res?.ok) {
    const data = await res.json() as { filename: string }
    form.value.refImages.push(data.filename)
  }
  refImageUploading.value = false
  input.value = ''
}

/** 删除参考图片 */
async function removeRefImage(idx: number) {
  const filename = form.value.refImages[idx]
  if (!filename) return
  form.value.refImages.splice(idx, 1)
  await authFetch(`/api/observers/ref-images/${filename}`, { method: 'DELETE' }).catch(() => {})
}

/** 展开的记录 ID */
const expandedRecordId = ref<number | null>(null)

/** 当前展开记录的解析后详情（缓存，避免模板中重复 JSON.parse） */
const expandedDetail = computed(() => {
  if (!expandedRecordId.value) return {} as ParsedDetail
  const rec = records.value.find((r: ObserverRecord) => r.id === expandedRecordId.value)
  return rec ? parseDetail(rec.detail) : {} as ParsedDetail
})

/** 展开的详情子区域（raw response、prompt 等） */
const expandedDetailSections = ref(new Set<string>())

function toggleDetailSection(key: string) {
  if (expandedDetailSections.value.has(key)) expandedDetailSections.value.delete(key)
  else expandedDetailSections.value.add(key)
}

function toggleExpand(record: ObserverRecord) {
  expandedRecordId.value = expandedRecordId.value === record.id ? null : record.id
  expandedDetailSections.value.clear()
}

/** 解析 detail JSON */
interface ParsedDetail {
  confidence?: number
  prompt?: string
  rawResponse?: string
  regions?: Array<{ label: string; box: { xmin: number; ymin: number; xmax: number; ymax: number } }>
  signalIds?: number[]
  signalUpdates?: Array<{ id: number; value: string }>
  cameras?: Array<{ cameraId: string; roiId: number; roiPoints?: Array<{ x: number; y: number }> }>
}
function parseDetail(detail: string): ParsedDetail {
  if (!detail) return {}
  try { return JSON.parse(detail) } catch { return {} }
}

/** 快照图片加载后叠加 ROI 区域和 regions 检测框 */
function onSnapshotLoad(e: Event, record: ObserverRecord) {
  const img = e.target as HTMLImageElement
  const detail = parseDetail(record.detail)
  const regions = detail.regions
  /** 找到当前摄像头对应的 ROI 坐标 */
  const snapContainer = img.closest('.snapshot-item')
  const camLabel = snapContainer?.querySelector('.snapshot-cam-label')?.textContent
  const camId = record.snapshotUrls?.find(s => (cameraNameMap.value.get(s.cameraId) ?? s.cameraId) === camLabel)?.cameraId ?? record.cameraId
  const cameraDef = detail.cameras?.find(c => c.cameraId === camId)
  const roiPoints = cameraDef?.roiPoints

  if (!regions?.length && !roiPoints?.length) return

  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.drawImage(img, 0, 0)
  const cw = canvas.width
  const ch = canvas.height

  /** 绘制 ROI 多边形区域 */
  if (roiPoints && roiPoints.length >= 3) {
    ctx.beginPath()
    ctx.moveTo(roiPoints[0]!.x * cw, roiPoints[0]!.y * ch)
    for (let i = 1; i < roiPoints.length; i++) {
      ctx.lineTo(roiPoints[i]!.x * cw, roiPoints[i]!.y * ch)
    }
    ctx.closePath()
    ctx.strokeStyle = '#FFD93D'
    ctx.lineWidth = 2
    ctx.setLineDash([8, 4])
    ctx.stroke()
    ctx.setLineDash([])

    /** ROI 标签 */
    ctx.font = 'bold 11px sans-serif'
    ctx.fillStyle = 'rgba(255, 217, 61, 0.9)'
    const labelY = Math.min(...roiPoints.map(p => p.y)) * ch - 4
    ctx.textBaseline = 'bottom'
    ctx.fillText('ROI', roiPoints[0]!.x * cw + 2, labelY > 12 ? labelY : 12)
  }

  /** 绘制检测 regions 框 */
  if (regions) {
    for (const r of regions) {
      const { xmin, ymin, xmax, ymax } = r.box
      const x = xmin * cw
      const y = ymin * ch
      const w = (xmax - xmin) * cw
      const h = (ymax - ymin) * ch

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
  }

  img.src = canvas.toDataURL('image/jpeg', 0.9)
  /** 释放 Canvas GPU 资源 */
  canvas.width = 0
  canvas.height = 0
}

/** 实时追加记录 */
function addRecord(payload: { observerId: number; observerName: string; cameraId: string; timestamp: number; result: string; confidence: number; detail?: string; snapshotUrl?: string | null }) {
  if (filterCamera.value && filterCamera.value !== payload.cameraId) return
  if (filterMatched.value) return
  const record: ObserverRecord = {
    id: -(Date.now()),
    observerId: payload.observerId,
    observerName: payload.observerName,
    cameraId: payload.cameraId,
    timestamp: payload.timestamp,
    result: payload.result,
    matched: true,
    detail: payload.detail ?? '',
    snapshotUrl: payload.snapshotUrl ?? undefined,
    isNew: true,
  }
  records.value.unshift(record)
  recordTotal.value++
  const recordId = record.id
  if (isNewTimer) clearTimeout(isNewTimer)
  isNewTimer = setTimeout(() => {
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
  const res = await authFetch(`/api/observers/history?${params}`)
  if (!res.ok) return
  const { records: rows } = await res.json() as { records: ObserverRecord[] }
  const header = 'ID,Observer,Camera,Time,Matched,Result'
  const csvRows = rows.map(r =>
    `${r.id},"${r.observerName}","${cameraNameMap.value.get(r.cameraId) ?? r.cameraId}","${new Date(r.timestamp).toLocaleString(locale.value)}",${r.matched ? 'Yes' : 'No'},"${(r.result ?? '').replace(/"/g, '""')}"`
  )
  const csv = [header, ...csvRows].join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const link = document.createElement('a')
  const dateStr = filterDate.value || new Date().toISOString().slice(0, 10)
  link.href = URL.createObjectURL(blob)
  link.download = `observer_history_${dateStr}.csv`
  link.click()
  URL.revokeObjectURL(link.href)
}

onMounted(() => {
  loadObservers()
  loadRecords()
  loadRoiList()
  loadSignalList()
  loadModels()
})

onUnmounted(() => {
  if (isNewTimer) clearTimeout(isNewTimer)
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
      <button class="refresh-btn" @click="loadObservers(); loadRecords()" :disabled="loading">{{ t('alert.refresh') }}</button>
      <button class="add-btn" @click="showAddForm = !showAddForm">{{ showAddForm ? t('alert.cancel') : t('alert.addObserverShort') }}</button>
    </div>

    <!-- 添加表单 -->
    <div v-if="showAddForm" class="add-form">
      <div class="form-field">
        <label>{{ t('detectRule.name') }}</label>
        <input v-model="form.name" :placeholder="t('detectRule.namePlaceholder')" class="input" />
      </div>
      <!-- 摄像头源列表 -->
      <div class="cameras-section">
        <label>{{ t('detectRule.camera') }}</label>
        <div v-for="(src, idx) in form.cameras" :key="idx" class="cam-source-item">
          <div class="cam-row">
            <select v-model="src.cameraId" class="input cam-select">
              <option value="" disabled>{{ t('detectRule.cameraPlaceholder') }}</option>
              <option v-for="cam in (cameras ?? [])" :key="cam.id" :value="cam.id">{{ cam.name }}</option>
            </select>
            <select v-if="!src.videoClip" v-model.number="src.roiId" class="input cam-roi-select" :disabled="getRoiOptionsForCamera(src.cameraId).length === 0">
              <option :value="0">{{ getRoiOptionsForCamera(src.cameraId).length > 0 ? t('detectRule.allRegions') : t('detectRule.noRoiHint') }}</option>
              <option v-for="roi in getRoiOptionsForCamera(src.cameraId)" :key="roi.id" :value="roi.id">{{ roi.name || `ROI #${roi.id}` }}</option>
            </select>
            <button v-if="!src.videoClip && src.cameraId" class="roi-draw-btn" :class="{ active: roiDrawingIdx === idx }" @click="toggleRoiDraw(idx)" :title="src.roiId > 0 ? t('detectRule.editRoi') : t('detectRule.drawRoi')">{{ src.roiId > 0 ? '✎' : '◇' }}</button>
            <input v-if="!src.videoClip" v-model.number="src.offsetSec" type="number" min="0" step="1" class="input cam-offset" :placeholder="t('detectRule.offsetPlaceholder')" :title="t('detectRule.offsetTitle')" />
            <button class="clip-toggle-btn" :class="{ active: !!src.videoClip }" @click="toggleClipMode(src)" :title="t('detectRule.toggleClipMode')">▶</button>
            <button v-if="form.cameras.length > 1" class="remove-btn" @click="form.cameras.splice(idx, 1)" :title="t('detectRule.remove')">&#x2715;</button>
          </div>
          <!-- 视频片段配置 -->
          <div v-if="src.videoClip" class="clip-config">
            <div class="clip-time-row">
              <span class="clip-label">{{ t('detectRule.clipRewind') }}</span>
              <input v-model.number="src.videoClip.startOffsetSec" type="number" min="1" max="300" step="1" class="input clip-num" />
              <span class="clip-sep">~</span>
              <input v-model.number="src.videoClip.endOffsetSec" type="number" min="0" max="300" step="1" class="input clip-num" />
              <span class="clip-label">{{ t('detectRule.clipSecondsAgo') }}</span>
            </div>
            <div class="clip-extract-row">
              <select v-model="src.videoClip.extraction.mode" class="input clip-mode-select">
                <option value="total">{{ t('detectRule.clipEvenlySample') }}</option>
                <option value="fps">{{ t('detectRule.clipByFps') }}</option>
              </select>
              <input v-if="src.videoClip.extraction.mode === 'total'" v-model.number="src.videoClip.extraction.totalFrames" type="number" min="1" max="20" step="1" class="input clip-num" :placeholder="t('detectRule.clipFrameCount')" />
              <input v-else v-model.number="src.videoClip.extraction.fps" type="number" min="1" max="5" step="1" class="input clip-num" :placeholder="t('detectRule.clipFps')" />
              <span class="clip-hint">{{ t('detectRule.clipHint') }}</span>
            </div>
          </div>
          <!-- ROI 绘制面板 -->
          <div v-if="roiDrawingIdx === idx && src.cameraId" class="roi-draw-panel">
            <div class="roi-draw-toolbar">
              <span class="roi-draw-hint">{{ roiEditingId > 0 ? t('detectRule.editRoiPrefix', { id: roiEditingId }) : '' }}{{ roiDrawPoints.length < 3 ? t('detectRule.roiAddVertex', { n: roiDrawPoints.length }) : t('detectRule.roiVertexCount', { n: roiDrawPoints.length }) }}</span>
              <button class="roi-draw-undo" :disabled="roiDrawPoints.length === 0" @click="undoRoiPoint">↩</button>
              <button class="roi-draw-save" :disabled="roiDrawPoints.length < 3" @click="saveRoiDraw">{{ t('roi.save') }}</button>
              <button class="roi-draw-cancel" @click="cancelRoiDraw">{{ t('settings.cancel') }}</button>
            </div>
            <div class="roi-draw-image-container">
              <img :src="authUrl(`/api/snapshot/${src.cameraId}`)" class="roi-draw-img" @click="onRoiImageClick" />
              <svg class="roi-draw-overlay" viewBox="0 0 1 1" preserveAspectRatio="none">
                <polygon v-if="roiDrawPoints.length >= 3" :points="roiDrawPoints.map(p => `${p.x},${p.y}`).join(' ')" class="roi-draw-polygon" />
                <template v-for="(p, i) in roiDrawPoints" :key="i">
                  <circle :cx="p.x" :cy="p.y" r="0.015" class="roi-draw-vertex" />
                </template>
              </svg>
            </div>
          </div>
        </div>
        <button class="add-extra-cam-btn" @click="form.cameras.push({ cameraId: '', roiId: 0, offsetSec: 0 })">{{ t('detectRule.addExtraCamera') }}</button>
      </div>
      <div class="form-field">
        <label>{{ t('detectRule.prompt') }}</label>
        <textarea v-model="form.prompt" :placeholder="t('detectRule.promptPlaceholder')" class="input textarea auto-grow" rows="3" @input="autoGrowTextarea"></textarea>
      </div>
      <div class="prompt-templates">
        <div class="template-chips">
          <button v-for="tpl in promptTemplates" :key="tpl.label" :class="['tpl-chip', { active: form.prompt === tpl.prompt }]" @click="applyTemplate(tpl.prompt)">{{ tpl.label }}</button>
          <button class="tpl-chip ai-suggest-btn" @click="fetchAiSuggestions" :disabled="aiSuggestLoading || !primaryCamId" :title="!primaryCamId ? t('detectRule.selectCameraFirst') : t('detectRule.aiSuggestTitle')">{{ t('detectRule.aiSuggest') }}</button>
        </div>
        <div v-if="aiSuggestLoading" class="ai-suggest-loading">{{ t('detectRule.aiAnalyzing') }}</div>
        <div v-if="aiSuggestions.length > 0" class="ai-suggestions">
          <div v-for="(s, i) in aiSuggestions" :key="i" class="ai-suggest-item" @click="applySuggestion(s)">
            <div class="ai-suggest-name">{{ s.name }}</div>
            <div class="ai-suggest-prompt">{{ s.prompt }}</div>
            <div class="ai-suggest-reason">{{ s.reason }}</div>
          </div>
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
        <label>{{ t('detectRule.linkedSignals') }}</label>
        <div v-if="availableSignals.length > 0" class="chip-group">
          <button
            v-for="st in availableSignals" :key="st.id"
            :class="['signal-chip', { selected: form.signalIds.includes(st.id) }]"
            @click="toggleSignalId(st.id)"
          >{{ st.name }}</button>
        </div>
        <div v-else class="chip-group">
          <span class="hint-inline">{{ t('detectRule.noSignalsYet') }}</span>
        </div>
        <div class="quick-state-row">
          <input v-model="quickSignalName" class="input quick-state-input" :placeholder="t('detectRule.quickSignalPlaceholder')" @keyup.enter="quickCreateSignal" />
          <button class="quick-state-btn" @click="quickCreateSignal" :disabled="!quickSignalName.trim()">{{ t('detectRule.quickCreate') }}</button>
        </div>
        <span class="hint">{{ t('detectRule.linkedSignalsHint') }}</span>
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
        <div v-if="availableModels.length > 0" class="form-field">
          <label>{{ t('detectRule.aiModel') }}</label>
          <select v-model="form.modelId" class="input">
            <option value="">{{ t('detectRule.defaultModel') }}</option>
            <option v-for="m in availableModels" :key="m.id" :value="m.id">{{ m.name }} ({{ m.model }})</option>
          </select>
        </div>
        <!-- 参考图片 -->
        <div class="ref-images-section">
          <label>{{ t('detectRule.refImages') }}</label>
          <span class="hint-inline">{{ t('detectRule.refImagesHint') }}</span>
          <div class="ref-images-grid">
            <div v-for="(img, idx) in form.refImages" :key="img" class="ref-image-item">
              <img :src="authUrl(`/api/observers/ref-images/${img}`)" class="ref-thumb" />
              <button class="ref-remove-btn" @click="removeRefImage(idx)" :title="t('detectRule.deleteTitle')">&#x2715;</button>
            </div>
            <label class="ref-upload-btn" :class="{ disabled: refImageUploading }">
              <input type="file" accept="image/*" @change="uploadRefImage" :disabled="refImageUploading" hidden />
              {{ refImageUploading ? t('detectRule.uploading') : t('detectRule.upload') }}
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
      <button class="submit-btn" @click="addObserver">{{ t('alert.confirmAdd') }}</button>
    </div>

    <!-- 视图切换 -->
    <div class="view-tabs">
      <button :class="['view-btn', { active: activeView === 'rules' }]" @click="activeView = 'rules'">{{ t('detectRule.rulesTab') }} ({{ observers.length }})</button>
      <button :class="['view-btn', { active: activeView === 'history' }]" @click="activeView = 'history'; loadRecords()">{{ t('detectRule.historyTab') }} ({{ records.length }})</button>
    </div>

    <!-- 规则列表 -->
    <div v-if="activeView === 'rules'" class="rule-list">
      <div v-if="observers.length === 0" class="empty">{{ loading ? t('alert.loading') : t('detectRule.noRules') }}</div>
      <div v-for="rule in observers" :key="rule.id" class="rule-item">
        <!-- 编辑模式 -->
        <template v-if="editingObserverId === rule.id">
          <div class="edit-form">
            <div class="form-field">
              <label>{{ t('detectRule.name') }}</label>
              <input v-model="form.name" class="input" />
            </div>
            <!-- 摄像头源列表（编辑） -->
            <div class="cameras-section">
              <label>{{ t('detectRule.camera') }}</label>
              <div v-for="(src, idx) in form.cameras" :key="idx" class="cam-source-item">
                <div class="cam-row">
                  <select v-model="src.cameraId" class="input cam-select">
                    <option value="" disabled>{{ t('detectRule.cameraPlaceholder') }}</option>
                    <option v-for="cam in (cameras ?? [])" :key="cam.id" :value="cam.id">{{ cam.name }}</option>
                  </select>
                  <select v-if="!src.videoClip" v-model.number="src.roiId" class="input cam-roi-select" :disabled="getRoiOptionsForCamera(src.cameraId).length === 0">
                    <option :value="0">{{ getRoiOptionsForCamera(src.cameraId).length > 0 ? t('detectRule.allRegions') : t('detectRule.noRoiHint') }}</option>
                    <option v-for="roi in getRoiOptionsForCamera(src.cameraId)" :key="roi.id" :value="roi.id">{{ roi.name || `ROI #${roi.id}` }}</option>
                  </select>
                  <button v-if="!src.videoClip && src.cameraId" class="roi-draw-btn" :class="{ active: roiDrawingIdx === idx }" @click="toggleRoiDraw(idx)" :title="src.roiId > 0 ? t('detectRule.editRoi') : t('detectRule.drawRoi')">{{ src.roiId > 0 ? '✎' : '◇' }}</button>
                  <input v-if="!src.videoClip" v-model.number="src.offsetSec" type="number" min="0" step="1" class="input cam-offset" :placeholder="t('detectRule.offsetPlaceholder')" :title="t('detectRule.offsetTitle')" />
                  <button class="clip-toggle-btn" :class="{ active: !!src.videoClip }" @click="toggleClipMode(src)" :title="t('detectRule.toggleClipMode')">▶</button>
                  <button v-if="form.cameras.length > 1" class="remove-btn" @click="form.cameras.splice(idx, 1)" :title="t('detectRule.remove')">&#x2715;</button>
                </div>
                <div v-if="src.videoClip" class="clip-config">
                  <div class="clip-time-row">
                    <span class="clip-label">{{ t('detectRule.clipRewind') }}</span>
                    <input v-model.number="src.videoClip.startOffsetSec" type="number" min="1" max="300" step="1" class="input clip-num" />
                    <span class="clip-sep">~</span>
                    <input v-model.number="src.videoClip.endOffsetSec" type="number" min="0" max="300" step="1" class="input clip-num" />
                    <span class="clip-label">{{ t('detectRule.clipSecondsAgo') }}</span>
                  </div>
                  <div class="clip-extract-row">
                    <select v-model="src.videoClip.extraction.mode" class="input clip-mode-select">
                      <option value="total">{{ t('detectRule.clipEvenlySample') }}</option>
                      <option value="fps">{{ t('detectRule.clipByFps') }}</option>
                    </select>
                    <input v-if="src.videoClip.extraction.mode === 'total'" v-model.number="src.videoClip.extraction.totalFrames" type="number" min="1" max="20" step="1" class="input clip-num" :placeholder="t('detectRule.clipFrameCount')" />
                    <input v-else v-model.number="src.videoClip.extraction.fps" type="number" min="1" max="5" step="1" class="input clip-num" :placeholder="t('detectRule.clipFps')" />
                    <span class="clip-hint">{{ t('detectRule.clipHint') }}</span>
                  </div>
                </div>
                <!-- ROI 绘制面板（编辑） -->
                <div v-if="roiDrawingIdx === idx && src.cameraId" class="roi-draw-panel">
                  <div class="roi-draw-toolbar">
                    <span class="roi-draw-hint">{{ roiDrawPoints.length < 3 ? t('detectRule.roiAddVertex', { n: roiDrawPoints.length }) : t('detectRule.roiVertexCount', { n: roiDrawPoints.length }) }}</span>
                    <button class="roi-draw-undo" :disabled="roiDrawPoints.length === 0" @click="undoRoiPoint">↩</button>
                    <button class="roi-draw-save" :disabled="roiDrawPoints.length < 3" @click="saveRoiDraw">{{ t('roi.save') }}</button>
                    <button class="roi-draw-cancel" @click="cancelRoiDraw">{{ t('settings.cancel') }}</button>
                  </div>
                  <div class="roi-draw-image-container">
                    <img :src="authUrl(`/api/snapshot/${src.cameraId}`)" class="roi-draw-img" @click="onRoiImageClick" />
                    <svg class="roi-draw-overlay" viewBox="0 0 1 1" preserveAspectRatio="none">
                      <polygon v-if="roiDrawPoints.length >= 3" :points="roiDrawPoints.map(p => `${p.x},${p.y}`).join(' ')" class="roi-draw-polygon" />
                      <template v-for="(p, i) in roiDrawPoints" :key="i">
                        <circle :cx="p.x" :cy="p.y" r="0.015" class="roi-draw-vertex" />
                      </template>
                    </svg>
                  </div>
                </div>
              </div>
              <button class="add-extra-cam-btn" @click="form.cameras.push({ cameraId: '', roiId: 0, offsetSec: 0 })">{{ t('detectRule.addExtraCamera') }}</button>
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
              <label>{{ t('detectRule.linkedSignals') }}</label>
              <div v-if="availableSignals.length > 0" class="chip-group">
                <button
                  v-for="st in availableSignals" :key="st.id"
                  :class="['signal-chip', { selected: form.signalIds.includes(st.id) }]"
                  @click="toggleSignalId(st.id)"
                >{{ st.name }}</button>
              </div>
              <div v-else class="chip-group">
                <span class="hint-inline">{{ t('detectRule.noSignalsYet') }}</span>
              </div>
              <div class="quick-state-row">
                <input v-model="quickSignalName" class="input quick-state-input" :placeholder="t('detectRule.quickSignalPlaceholder')" @keyup.enter="quickCreateSignal" />
                <button class="quick-state-btn" @click="quickCreateSignal" :disabled="!quickSignalName.trim()">{{ t('detectRule.quickCreate') }}</button>
              </div>
              <span class="hint">{{ t('detectRule.linkedSignalsHint') }}</span>
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
              <div v-if="availableModels.length > 0" class="form-field">
                <label>{{ t('detectRule.aiModel') }}</label>
                <select v-model="form.modelId" class="input">
                  <option value="">{{ t('detectRule.defaultModel') }}</option>
                  <option v-for="m in availableModels" :key="m.id" :value="m.id">{{ m.name }} ({{ m.model }})</option>
                </select>
              </div>
              <!-- 参考图片（编辑） -->
              <div class="ref-images-section">
                <label>{{ t('detectRule.refImages') }}</label>
                <span class="hint-inline">{{ t('detectRule.refImagesHintShort') }}</span>
                <div class="ref-images-grid">
                  <div v-for="(img, idx) in form.refImages" :key="img" class="ref-image-item">
                    <img :src="authUrl(`/api/observers/ref-images/${img}`)" class="ref-thumb" />
                    <button class="ref-remove-btn" @click="removeRefImage(idx)" :title="t('detectRule.deleteTitle')">&#x2715;</button>
                  </div>
                  <label class="ref-upload-btn" :class="{ disabled: refImageUploading }">
                    <input type="file" accept="image/*" @change="uploadRefImage" :disabled="refImageUploading" hidden />
                    {{ refImageUploading ? t('detectRule.uploading') : t('detectRule.upload') }}
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
            <label class="toggle-switch" @click.prevent="toggleObserver(rule)">
              <input type="checkbox" :checked="rule.enabled" />
              <span class="toggle-slider"></span>
            </label>
            <span class="rule-name" :class="{ disabled: !rule.enabled }">{{ rule.name }}</span>
            <button class="edit-btn" @click="startEdit(rule)">{{ t('alert.edit') }}</button>
            <button class="delete-btn" @click="deleteObserver(rule.id)">{{ t('alert.delete') }}</button>
          </div>
          <div class="rule-meta">
            <template v-for="(cam, idx) in rule.cameras" :key="idx">
              <span class="meta-tag cam">{{ cameraNameMap.get(cam.cameraId) ?? cam.cameraId }}<template v-if="cam.videoClip"> ({{ t('detectRule.clipTag') }} {{ cam.videoClip.startOffsetSec }}s~{{ cam.videoClip.endOffsetSec }}s)</template><template v-else-if="cam.offsetSec > 0"> (-{{ cam.offsetSec }}s)</template></span>
              <span v-if="!cam.videoClip && cam.roiId > 0" class="meta-tag roi">ROI #{{ cam.roiId }}</span>
            </template>
            <span v-if="rule.refImages?.length > 0" class="meta-tag ref">📷 x{{ rule.refImages.length }}</span>
            <span v-if="rule.modelId" class="meta-tag model">{{ availableModels.find(m => m.id === rule.modelId)?.name ?? rule.modelId }}</span>
            <span class="meta-info">{{ rule.intervalMs / 1000 }}{{ t('detectRule.secondsUnit') }} · {{ t('detectRule.cooldownLabel') }}{{ rule.cooldownMs / 1000 }}{{ t('detectRule.secondsUnit') }}</span>
            <template v-if="rule.signalIds?.length > 0">
              <span v-for="sid in rule.signalIds" :key="sid" class="meta-tag signal">{{ signalNameMap[sid] ?? `#${sid}` }}</span>
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
              <span class="record-rule">{{ record.observerName }}</span>
              <span class="record-cam">{{ cameraNameMap.get(record.cameraId) ?? record.cameraId }}</span>
              <span v-if="record.matched" class="record-matched">{{ t('detectRule.matched') }}</span>
              <span v-else class="record-unmatched">{{ t('detectRule.unmatched') }}</span>
            </div>
            <div v-if="record.result" class="record-result-preview">{{ record.result.slice(0, 80) }}{{ record.result.length > 80 ? '...' : '' }}</div>
          </div>
          <span class="expand-arrow">{{ expandedRecordId === record.id ? '▾' : '▸' }}</span>
        </div>
        <div v-if="expandedRecordId === record.id" class="record-detail">
          <div class="detail-section">
            <div class="detail-row">
              <div class="detail-label" style="margin:0">AI Response</div>
              <span v-if="expandedDetail.confidence !== undefined" class="detail-tag confidence">
                Confidence: {{ (expandedDetail.confidence! * 100).toFixed(1) }}%
              </span>
              <span v-if="record.matched" class="detail-tag matched-tag">{{ t('detectRule.matched') }}</span>
              <span v-else class="detail-tag unmatched-tag">{{ t('detectRule.unmatched') }}</span>
            </div>
            <div class="detail-text">{{ record.result || '(empty)' }}</div>
          </div>
          <!-- 完整响应：默认收起，可展开 -->
          <template v-if="expandedDetail.rawResponse">
            <button class="detail-collapse-toggle" @click="toggleDetailSection(`raw-${record.id}`)">
              {{ expandedDetailSections.has(`raw-${record.id}`) ? '▾' : '▸' }} Raw Response
            </button>
            <div v-if="expandedDetailSections.has(`raw-${record.id}`)" class="detail-section">
              <pre class="detail-code">{{ expandedDetail.rawResponse }}</pre>
            </div>
          </template>
          <!-- Prompt：默认收起 -->
          <template v-if="expandedDetail.prompt">
            <button class="detail-collapse-toggle" @click="toggleDetailSection(`prompt-${record.id}`)">
              {{ expandedDetailSections.has(`prompt-${record.id}`) ? '▾' : '▸' }} Prompt
            </button>
            <div v-if="expandedDetailSections.has(`prompt-${record.id}`)" class="detail-section">
              <div class="detail-text detail-prompt">{{ expandedDetail.prompt }}</div>
            </div>
          </template>
          <!-- 信号关联信息 -->
          <template v-if="(expandedDetail.signalIds?.length ?? 0) > 0 || (expandedDetail.signalUpdates?.length ?? 0) > 0">
            <div class="detail-section">
              <div class="detail-label">{{ t('detectRule.linkedSignals') }}</div>
              <div class="detail-signal-info">
                <template v-if="(expandedDetail.signalIds?.length ?? 0) > 0">
                  <div class="signal-info-row">
                    <span class="signal-info-label">📖 {{ t('detectRule.linkedSignals') }}</span>
                    <span v-for="sid in expandedDetail.signalIds!" :key="sid" class="signal-info-chip context">{{ signalNameMap[sid] ?? `#${sid}` }}</span>
                  </div>
                </template>
                <template v-if="(expandedDetail.signalUpdates?.length ?? 0) > 0">
                  <div class="signal-info-row">
                    <span class="signal-info-label">🔄 {{ t('detectRule.signalUpdates') }}</span>
                    <span v-for="su in expandedDetail.signalUpdates!" :key="su.id" class="signal-info-chip updated">
                      {{ signalNameMap[su.id] ?? `#${su.id}` }} → {{ su.value }}
                    </span>
                  </div>
                </template>
              </div>
            </div>
          </template>
          <!-- 输入图片 -->
          <div v-if="record.snapshotUrls?.length || record.snapshotUrl" class="detail-section">
            <!-- 原图（叠加 ROI 虚线框） -->
            <div class="detail-label">{{ t('detectRule.originalImage') }}</div>
            <div class="detail-snapshot">
              <template v-if="record.snapshotUrls?.length">
                <div v-for="snap in record.snapshotUrls" :key="'orig-' + snap.cameraId" class="snapshot-item">
                  <img :src="authUrl(snap.url)" class="snapshot-img" crossorigin="anonymous" loading="lazy" @load="onSnapshotLoad($event, record)" />
                  <span v-if="record.snapshotUrls.length > 1" class="snapshot-cam-label">{{ cameraNameMap.get(snap.cameraId) ?? snap.cameraId }}</span>
                </div>
              </template>
              <template v-else-if="record.snapshotUrl">
                <img :src="authUrl(record.snapshotUrl)" class="snapshot-img" crossorigin="anonymous" loading="lazy" @load="onSnapshotLoad($event, record)" />
              </template>
            </div>
            <!-- ROI 裁剪后的图片（发给 AI 的实际输入） -->
            <template v-if="record.snapshotUrls?.some(s => s.roiUrl)">
              <div class="detail-label" style="margin-top: 10px">{{ t('detectRule.roiCropLabel') }}</div>
              <div class="detail-snapshot">
                <div v-for="snap in record.snapshotUrls.filter(s => s.roiUrl)" :key="'roi-' + snap.cameraId" class="snapshot-item">
                  <img :src="authUrl(snap.roiUrl!)" class="snapshot-img" crossorigin="anonymous" loading="lazy" />
                  <span v-if="record.snapshotUrls.length > 1" class="snapshot-cam-label">{{ cameraNameMap.get(snap.cameraId) ?? snap.cameraId }}</span>
                </div>
              </div>
            </template>
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
  padding: 12px;
  border-bottom: 1px solid #2a2a4a;
  background: #16213e;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}

.form-field label {
  font-size: 12px;
  color: #888;
  flex-shrink: 0;
}

.form-row {
  display: flex;
  gap: 12px;
}

.form-field.half {
  flex: 1;
  min-width: 0;
}

select.input {
  appearance: none;
  cursor: pointer;
}

.textarea {
  resize: vertical;
  min-height: 40px;
  font-family: inherit;
}

.rule-list, .record-list {
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

.toggle-switch {
  position: relative;
  display: inline-block;
  width: 32px;
  height: 18px;
  cursor: pointer;
  flex-shrink: 0;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  inset: 0;
  background: #333;
  border-radius: 9px;
  transition: background 0.2s;
}

.toggle-slider::before {
  content: '';
  position: absolute;
  width: 14px;
  height: 14px;
  left: 2px;
  top: 2px;
  background: #888;
  border-radius: 50%;
  transition: transform 0.2s, background 0.2s;
}

.toggle-switch input:checked + .toggle-slider {
  background: rgba(78, 205, 196, 0.3);
}

.toggle-switch input:checked + .toggle-slider::before {
  transform: translateX(14px);
  background: #4ECDC4;
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

.detail-collapse-toggle {
  background: none;
  border: none;
  color: #666;
  font-size: 11px;
  cursor: pointer;
  padding: 4px 0;
  margin-top: 6px;
  display: block;
  transition: color 0.15s;
}
.detail-collapse-toggle:hover { color: #aaa; }

.detail-tag.matched-tag {
  background: rgba(74, 222, 128, 0.15);
  color: #4ade80;
}
.detail-tag.unmatched-tag {
  background: rgba(102, 102, 102, 0.15);
  color: #666;
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
  margin-top: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.detail-signal-info {
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.signal-info-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.signal-info-label {
  font-size: 10px;
  color: #888;
  min-width: 70px;
}

.signal-info-chip {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid transparent;
}

.signal-info-chip.context {
  border-color: #3498db;
  color: #5dade2;
  background: rgba(52, 152, 219, 0.1);
}

.signal-info-chip.eval {
  border-color: #f39c12;
  color: #f5b041;
  background: rgba(243, 156, 18, 0.1);
}

.signal-info-chip.updated {
  border-color: #4ECDC4;
  color: #4ECDC4;
  background: rgba(78, 205, 196, 0.15);
}

.snapshot-item {
  position: relative;
  flex: 1 1 200px;
  max-width: calc(50% - 4px);
}

.snapshot-cam-label {
  position: absolute;
  bottom: 4px;
  left: 4px;
  background: rgba(0, 0, 0, 0.7);
  color: #e0e0e0;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
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

.ai-suggest-btn {
  border-color: #9b59b6;
  color: #9b59b6;
}

.ai-suggest-btn:hover:not(:disabled) {
  border-color: #8e44ad;
  color: #8e44ad;
  background: rgba(155, 89, 182, 0.1);
}

.ai-suggest-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.ai-suggest-loading {
  font-size: 11px;
  color: #9b59b6;
  padding: 4px 0;
}

.ai-suggestions {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ai-suggest-item {
  padding: 6px 8px;
  border: 1px solid #333;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s;
}

.ai-suggest-item:hover {
  border-color: #9b59b6;
  background: rgba(155, 89, 182, 0.08);
}

.ai-suggest-name {
  font-size: 12px;
  font-weight: 600;
  color: #9b59b6;
}

.ai-suggest-prompt {
  font-size: 11px;
  color: #aaa;
  margin-top: 2px;
}

.ai-suggest-reason {
  font-size: 10px;
  color: #666;
  margin-top: 2px;
  font-style: italic;
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
}

.signal-chip {
  padding: 2px 8px;
  border: 1px solid #3a3a5a;
  border-radius: 10px;
  background: transparent;
  color: #888;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}

.signal-chip.selected {
  border-color: #4ECDC4;
  background: rgba(78, 205, 196, 0.15);
  color: #4ECDC4;
}

.signal-chip:hover {
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

.meta-tag.signal {
  border-color: #9C27B0;
  color: #CE93D8;
}

.hint {
  display: block;
  font-size: 10px;
  color: #555;
  margin-top: 2px;
}

/** 摄像头源列表 */
.cameras-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}
.cameras-section > label {
  font-size: 12px;
  color: #888;
  flex-shrink: 0;
}
.cam-row {
  display: flex;
  gap: 4px;
  align-items: center;
}
.cam-select {
  flex: 1;
  min-width: 0;
}
.cam-roi-select {
  width: 100px;
}
.cam-offset {
  width: 60px;
}
.cam-source-item {
  margin-bottom: 4px;
}
.clip-toggle-btn {
  background: none;
  border: 1px solid #3a3a5a;
  border-radius: 3px;
  color: #666;
  cursor: pointer;
  font-size: 11px;
  padding: 2px 6px;
  line-height: 1;
  transition: all 0.15s;
}
.clip-toggle-btn:hover { border-color: #3498db; color: #3498db; }
.clip-toggle-btn.active { border-color: #3498db; background: rgba(52, 152, 219, 0.15); color: #3498db; }
.clip-config {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 4px;
  padding: 4px 8px;
  background: rgba(52, 152, 219, 0.06);
  border: 1px solid rgba(52, 152, 219, 0.2);
  border-radius: 4px;
}
.clip-time-row, .clip-extract-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.clip-label { font-size: 11px; color: #888; }
.clip-sep { font-size: 11px; color: #555; }
.clip-hint { font-size: 10px; color: #555; font-style: italic; }
.clip-num { width: 50px; }
.clip-mode-select { width: 90px; }
.meta-tag.ref { color: #f0ad4e; border-color: #f0ad4e; }
.meta-tag.model { color: #5bc0de; border-color: #5bc0de; }
/** 参考图片 */
.ref-images-section {
  margin-bottom: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ref-images-section > label {
  font-size: 11px;
  color: #aaa;
  font-weight: 600;
}
.ref-images-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ref-image-item {
  position: relative;
  width: 60px;
  height: 60px;
}
.ref-thumb {
  width: 60px;
  height: 60px;
  object-fit: cover;
  border-radius: 4px;
  border: 1px solid #2a2a4a;
}
.ref-remove-btn {
  position: absolute;
  top: -4px;
  right: -4px;
  background: #e74c3c;
  border: none;
  border-radius: 50%;
  color: #fff;
  cursor: pointer;
  font-size: 10px;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.ref-upload-btn {
  width: 60px;
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed #3a3a5a;
  border-radius: 4px;
  color: #888;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}
.ref-upload-btn:hover { border-color: #4ECDC4; color: #4ECDC4; }
.ref-upload-btn.disabled { opacity: 0.5; cursor: not-allowed; }
.remove-btn {
  background: none;
  border: none;
  color: #e74c3c;
  cursor: pointer;
  font-size: 14px;
  padding: 2px 4px;
  line-height: 1;
}
.remove-btn:hover {
  color: #ff6b6b;
}
.add-extra-cam-btn {
  background: rgba(52, 152, 219, 0.15);
  border: 1px dashed rgba(52, 152, 219, 0.4);
  border-radius: 4px;
  color: #3498db;
  font-size: 12px;
  padding: 4px 8px;
  cursor: pointer;
  align-self: flex-start;
}
.add-extra-cam-btn:hover {
  background: rgba(52, 152, 219, 0.25);
}
.add-extra-cam-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
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

/** ROI 绘制按钮 */
.roi-draw-btn {
  background: none;
  border: 1px solid #3a3a5a;
  border-radius: 3px;
  color: #666;
  cursor: pointer;
  font-size: 13px;
  padding: 2px 6px;
  line-height: 1;
  transition: all 0.15s;
}
.roi-draw-btn:hover { border-color: #FFD93D; color: #FFD93D; }
.roi-draw-btn.active { border-color: #FFD93D; background: rgba(255, 217, 61, 0.15); color: #FFD93D; }

/** ROI 绘制面板 */
.roi-draw-panel {
  margin-top: 4px;
  padding: 6px 8px;
  background: rgba(255, 217, 61, 0.05);
  border: 1px solid rgba(255, 217, 61, 0.2);
  border-radius: 4px;
}

.roi-draw-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.roi-draw-hint {
  font-size: 11px;
  color: #888;
  flex: 1;
}

.roi-draw-undo {
  background: none;
  border: 1px solid #555;
  color: #aaa;
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 13px;
  cursor: pointer;
}
.roi-draw-undo:disabled { opacity: 0.3; }
.roi-draw-undo:hover:not(:disabled) { color: #e0e0e0; border-color: #888; }

.roi-draw-save {
  background: #4ECDC4;
  color: #1a1a2e;
  border: none;
  border-radius: 3px;
  padding: 2px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.roi-draw-save:disabled { opacity: 0.4; }

.roi-draw-cancel {
  background: none;
  border: 1px solid #555;
  color: #888;
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}

.roi-draw-image-container {
  position: relative;
  background: #0a0a1a;
  border-radius: 4px;
  overflow: hidden;
  aspect-ratio: 16 / 9;
}

.roi-draw-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  cursor: crosshair;
}

.roi-draw-overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.roi-draw-polygon {
  fill: rgba(255, 217, 61, 0.2);
  stroke: #FFD93D;
  stroke-width: 0.005;
}

.roi-draw-vertex {
  fill: #FFD93D;
  stroke: #1a1a2e;
  stroke-width: 0.003;
}
</style>
