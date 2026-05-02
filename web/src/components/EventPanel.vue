<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import EventTimeline from './EventTimeline.vue'
import { authFetch, authUrl } from '../services/auth'
import { usePreferences } from '../composables/usePreferences'

/** 检测结果 */
interface Detection {
  label: string
  score: number
  box: { xmin: number; ymin: number; xmax: number; ymax: number }
  trackId?: number
  /** 用户自定义名称（如 "张三"） */
  trackName?: string
  /** CLIP 语义标签（如 "a person wearing dark clothes"） */
  semanticLabel?: string
}

const { t, locale } = useI18n()

const { setPref, getPref } = usePreferences()

/** 从后端偏好缓存恢复筛选条件 */
getPref<string>('nvr-event-filter-type', '').then(v => { filterType.value = v })
getPref<string>('nvr-event-filter-camera', '').then(v => { filterCamera.value = v })

/** 事件记录 */
interface EventRecord {
  id: number
  type: string
  camera_id: string
  timestamp: number
  detail: string | null
  starred: number
}

interface EventItem {
  id: number
  time: string
  /** 原始时间戳 */
  timestamp: number
  type: string
  cameraId: string
  detail: string
  /** 服务端摘要（如 "person ×2, car ×1"） */
  summary: string | null
  /** 原始 JSON detail（展开详情时按需加载） */
  rawDetail: string | null
  /** 是否已收藏 */
  starred: boolean
  /** 是否为实时新增事件（用于入场动画） */
  isNew?: boolean
  /** 关联的快照 URL（原始图） */
  snapshotUrl?: string | null
  /** 快照的检测结果（用于叠加标注框） */
  snapshotDetections?: Detection[] | null
}

const events = ref<EventItem[]>([])
const PAGE_SIZE = 50
/** DOM 渲染上限：超过此数量时只渲染最新的事件，防止 DOM 膨胀 */
const MAX_RENDER_EVENTS = 200
const loading = ref(false)
const hasMore = ref(false)
const filterType = ref('')
/** 摄像头筛选 */
const filterCamera = ref('')
/** 日期筛选（YYYY-MM-DD） */
const filterDate = ref('')
/** 搜索关键词 */
const filterSearch = ref('')
/** 搜索防抖定时器 */
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null

/** 搜索输入防抖（300ms） */
function onSearchInput() {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
  searchDebounceTimer = setTimeout(loadHistory, 300)
}
/** 快速时间范围（空=全部, '1h'=最近1小时, '24h'=最近24小时） */
const filterRange = ref('')
/** 当前展开的事件 ID */
const expandedId = ref<number | null>(null)
/** 当前筛选条件下的事件总数 */
const totalCount = ref(0)
/** 排序方向（默认最新在前） */
const sortDesc = ref(true)
/** 仅看收藏 */
const filterStarred = ref(false)
/** 是否显示检测框标注 */
const showDetectionBoxes = ref(true)

/** 筛选条件变更：持久化 + 重新加载 */
function onFilterChange(field: 'type' | 'camera') {
  if (field === 'type') setPref('nvr-event-filter-type', filterType.value)
  if (field === 'camera') setPref('nvr-event-filter-camera', filterCamera.value)
  loadHistory()
}

/** 当前子视图：'events' 事件列表 | 'gallery' 快照画廊 */
const subView = ref<'events' | 'gallery'>('events')

/** 快照数据 */
interface SnapshotInfo {
  filename: string
  cameraId: string
  timestamp: number
  size: number
  detectionLabels?: string
}
const snapshotList = ref<SnapshotInfo[]>([])
const snapshotLoading = ref(false)
/** 快照筛选摄像头 */
const snapFilterCamera = ref('')
/** 快照筛选标签 */
const snapFilterLabel = ref('')
/** 选中放大查看的快照 URL */
const previewUrl = ref('')

/**
 * trackId → 快照缩略图 URL 缓存
 * 从事件 detail 中提取 trackId，按需从后端加载快照
 */
const trackSnapshotMap = new Map<number, string>()
const trackSnapshotLoading = new Set<number>()

/** 按 trackId 加载快照缩略图 URL */
async function loadTrackSnapshotUrl(trackId: number) {
  if (trackSnapshotMap.has(trackId) || trackSnapshotLoading.has(trackId)) return
  trackSnapshotLoading.add(trackId)
  const url = `/api/tracks/${trackId}/snapshot`
  const res = await fetch(url).catch(() => null)
  if (res?.ok) {
    trackSnapshotMap.set(trackId, url)
  } else {
    trackSnapshotMap.set(trackId, '')
  }
  trackSnapshotLoading.delete(trackId)
}

/** 从事件 detail 中提取 trackId */
function extractTrackId(type: string, rawDetail: string | null): number | null {
  if (!rawDetail || !type.startsWith('track:')) return null
  try {
    const d = JSON.parse(rawDetail)
    return d.trackId ?? null
  } catch { return null }
}

/** 获取 track 事件的快照 URL（按需加载） */
function getTrackSnapshotUrl(type: string, rawDetail: string | null): string | null {
  const trackId = extractTrackId(type, rawDetail)
  if (trackId == null) return null
  const cached = trackSnapshotMap.get(trackId)
  if (cached === '') return null
  if (cached) return cached
  /** 触发异步加载 */
  loadTrackSnapshotUrl(trackId)
  return null
}

/** 加载快照列表 */
async function loadSnapshots() {
  snapshotLoading.value = true
  try {
    const params = new URLSearchParams({ limit: '200' })
    if (snapFilterCamera.value) params.set('cameraId', snapFilterCamera.value)
    const res = await authFetch(`/api/snapshots?${params}`)
    if (res.ok) {
      snapshotList.value = await res.json()
    }
  } catch {
    // ignore
  } finally {
    snapshotLoading.value = false
  }
}

/** 快照缩略图 URL */
function snapThumbUrl(snap: SnapshotInfo): string {
  return authUrl(`/api/snapshots/${snap.cameraId}/${snap.filename}`)
}

/** 按摄像头 ID 索引的快照缩略图 URL */
const snapshotMapByCamera = computed(() => {
  const map = new Map<string, string>()
  for (const snap of snapshotList.value) {
    if (!map.has(snap.cameraId)) {
      map.set(snap.cameraId, snapThumbUrl(snap))
    }
  }
  return map
})

/** 快照中所有出现过的检测标签 */
const allSnapshotLabels = computed(() => {
  const set = new Set<string>()
  for (const snap of snapshotList.value) {
    if (snap.detectionLabels) {
      for (const label of snap.detectionLabels.split(', ')) {
        if (label) set.add(label)
      }
    }
  }
  return [...set].sort()
})

/** 按标签筛选后的快照列表 */
const filteredSnapshots = computed(() => {
  if (!snapFilterLabel.value) return snapshotList.value
  return snapshotList.value.filter(s =>
    s.detectionLabels?.includes(snapFilterLabel.value),
  )
})

/** 打开快照大图预览 */
function openSnapPreview(snap: SnapshotInfo) {
  previewUrl.value = snapThumbUrl(snap)
}

/** 切换到快照画廊视图 */
function switchToGallery() {
  subView.value = 'gallery'
  previewUrl.value = ''
  loadSnapshots()
}

/** 排序后的事件列表（限制 DOM 渲染上限） */
const sortedEvents = computed(() => {
  const list = sortDesc.value ? events.value : [...events.value].reverse()
  if (list.length <= MAX_RENDER_EVENTS) return list
  return list.slice(0, MAX_RENDER_EVENTS)
})

const props = defineProps<{
  /** 摄像头列表（用于筛选） */
  cameras?: Array<{ id: string; name: string }>
  /** 追踪标签映射：cameraId -> trackId -> 自定义名称 */
  trackLabels?: Record<string, Record<number, string>>
}>()

const emit = defineEmits<{
  (e: 'play-recording', cameraId: string, timestamp: number): void
  (e: 'jump-to-track', trackId: number): void
}>()

/** 摄像头 ID → 名称映射（O(1) 查找，替代模板中 find） */
const cameraNameMap = computed(() => {
  const map = new Map<string, string>()
  for (const c of props.cameras ?? []) map.set(c.id, c.name)
  return map
})

/** 获取摄像头友好名称 */
function cameraName(id: string): string {
  return cameraNameMap.value.get(id) ?? id
}

/** 事件类型标签样式 */
const typeConfig: Record<string, { labelKey: string; bg: string; color: string }> = {
  motion: { labelKey: 'event.motion', bg: '#FFEAA7', color: '#333' },
  detect: { labelKey: 'event.detect', bg: '#4ECDC4', color: '#333' },
  'camera:online': { labelKey: 'event.online', bg: '#4CAF50', color: '#fff' },
  'camera:offline': { labelKey: 'event.offline', bg: '#F44336', color: '#fff' },
  'camera:lowfps': { labelKey: 'event.lowfps', bg: '#FF9800', color: '#fff' },
  alert: { labelKey: 'event.alert', bg: '#FFD93D', color: '#333' },
  'track:appeared': { labelKey: 'event.trackAppeared', bg: '#81C784', color: '#fff' },
  'track:disappeared': { labelKey: 'event.trackDisappeared', bg: '#E57373', color: '#fff' },
  'track:enter-zone': { labelKey: 'event.trackEnterZone', bg: '#26A69A', color: '#fff' },
  'track:leave-zone': { labelKey: 'event.trackLeaveZone', bg: '#7E57C2', color: '#fff' },
  'track:dwell': { labelKey: 'event.trackDwell', bg: '#FF7043', color: '#fff' },
  'track:speed': { labelKey: 'event.trackSpeed', bg: '#E91E63', color: '#fff' },
  'track:line-cross': { labelKey: 'event.trackLineCross', bg: '#FF6F00', color: '#fff' },
  'track:loiter': { labelKey: 'event.trackLoiter', bg: '#795548', color: '#fff' },
  'track:match-suggest': { labelKey: 'event.trackMatchSuggest', bg: '#9C27B0', color: '#fff' },
  'llm:scene': { labelKey: 'event.llmScene', bg: '#7C4DFF', color: '#fff' },
  'detect:rule': { labelKey: 'event.detectRule', bg: '#FF6B6B', color: '#fff' },
  'state:changed': { labelKey: 'event.stateChanged', bg: '#FF9800', color: '#fff' },
}

/** 从 detail 文本中提取变动比例（如 "变动 15.3%" → 15.3） */
function motionRatio(detail: string): number {
  const match = detail.match(/([\d.]+)%/)
  return match ? parseFloat(match[1]!) : 0
}

/** 变动比例 → 颜色（绿→黄→红） */
function motionBarColor(ratio: number): string {
  if (ratio < 5) return '#4CAF50'
  if (ratio < 15) return '#FFC107'
  return '#F44336'
}

/** 添加实时事件（受筛选条件过滤） */
function addEvent(type: string, cameraId: string, detail: string) {
  if (filterType.value && filterType.value !== type) return
  if (filterCamera.value && filterCamera.value !== cameraId) return
  const now = Date.now()

  /** motion 事件去重：同一摄像头 5 秒内只更新不新增 */
  if (type === 'motion') {
    const recent = events.value[0]
    if (recent && recent.type === 'motion' && recent.cameraId === cameraId && (now - recent.timestamp) < 5000) {
      recent.detail = detail
      recent.summary = detail
      recent.rawDetail = detail
      recent.time = new Date(now).toLocaleTimeString(locale.value)
      return
    }
  }

  /** detect 事件去重：同一摄像头 3 秒内只更新不新增 */
  if (type === 'detect') {
    const recent = events.value[0]
    if (recent && recent.type === 'detect' && recent.cameraId === cameraId && (now - recent.timestamp) < 3000) {
      recent.detail = detail
      recent.summary = detail
      recent.rawDetail = detail
      recent.time = new Date(now).toLocaleTimeString(locale.value)
      return
    }
  }

  const time = new Date(now).toLocaleTimeString(locale.value)
  events.value.unshift({ id: now, time, timestamp: now, type, cameraId, detail, summary: detail, rawDetail: detail, starred: false, isNew: true })
  /** 1 秒后移除动画标记 */
  const eventId = now
  setTimeout(() => {
    const ev = events.value.find(e => e.id === eventId)
    if (ev) ev.isNew = false
  }, 1000)
  if (events.value.length > PAGE_SIZE) {
    events.value = events.value.slice(0, PAGE_SIZE)
  }
}

/** 从检测结果生成摘要文本 */
function summarizeDetections(detections: Detection[]): string {
  const labelCounts = new Map<string, number>()
  for (const d of detections) {
    const name = d.trackName ?? d.semanticLabel ?? d.label
    labelCounts.set(name, (labelCounts.get(name) ?? 0) + 1)
  }
  return [...labelCounts.entries()].map(([l, c]) => c > 1 ? `${l} ×${c}` : l).join(', ')
}

/** 添加带快照的检测事件 */
function addDetectEvent(type: string, cameraId: string, detail: string, snapshotUrl: string, detections: Detection[]) {
  if (filterType.value && filterType.value !== type) return
  if (filterCamera.value && filterCamera.value !== cameraId) return
  const now = Date.now()
  const summary = summarizeDetections(detections)

  /** detect 事件去重：同一摄像头 3 秒内只更新不新增 */
  const recent = events.value[0]
  if (recent && recent.type === 'detect' && recent.cameraId === cameraId && (now - recent.timestamp) < 3000) {
    recent.detail = summary
    recent.summary = summary
    recent.rawDetail = detail
    recent.time = new Date(now).toLocaleTimeString(locale.value)
    recent.snapshotUrl = snapshotUrl
    recent.snapshotDetections = detections
    return
  }

  const time = new Date(now).toLocaleTimeString(locale.value)
  events.value.unshift({
    id: now, time, timestamp: now, type, cameraId, detail: summary, summary, rawDetail: detail,
    starred: false, isNew: true, snapshotUrl, snapshotDetections: detections,
  })
  const eventId = now
  setTimeout(() => {
    const ev = events.value.find(e => e.id === eventId)
    if (ev) ev.isNew = false
  }, 1000)
  if (events.value.length > PAGE_SIZE) {
    events.value = events.value.slice(0, PAGE_SIZE)
  }
}

/** 格式化时间戳 */
function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString(locale.value)
}

/** 加载历史事件 */
async function loadHistory() {
  loading.value = true
  try {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
    if (filterType.value) params.set('type', filterType.value)
    if (filterCamera.value) params.set('cameraId', filterCamera.value)
    if (filterSearch.value) params.set('search', filterSearch.value)
    if (filterStarred.value) params.set('starred', 'true')
    if (filterRange.value) {
      const now = Date.now()
      const since = filterRange.value === '1h' ? now - 3600000 : now - 86400000
      params.set('since', String(since))
    } else if (filterDate.value) {
      const since = new Date(`${filterDate.value}T00:00:00`).getTime()
      const until = since + 86_400_000
      params.set('since', String(since))
      params.set('until', String(until))
    }
    const res = await authFetch(`/api/events/history?${params}`)
    if (res.ok) {
      const data = await res.json()
      const historyEvents: EventItem[] = (data.events as Array<Record<string, unknown>>).map((e) => ({
        id: e.id as number,
        time: formatTimestamp(e.timestamp as number),
        timestamp: e.timestamp as number,
        type: e.type as string,
        cameraId: e.camera_id as string,
        detail: (e.summary as string) || '',
        summary: (e.summary as string) || null,
        rawDetail: null,
        starred: e.starred === 1,
        snapshotUrl: (e.snapshotUrl as string) || null,
        snapshotDetections: (e.detections as Detection[]) || null,
      }))
      events.value = historyEvents
      totalCount.value = (data.total as number) ?? 0
      hasMore.value = historyEvents.length >= PAGE_SIZE
    }
  } catch {
    // ignore
  } finally {
    loading.value = false
  }
}

/** 加载更多（追加） */
async function loadMore() {
  if (loading.value || !hasMore.value) return
  loading.value = true
  try {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(events.value.length) })
    if (filterType.value) params.set('type', filterType.value)
    if (filterCamera.value) params.set('cameraId', filterCamera.value)
    if (filterSearch.value) params.set('search', filterSearch.value)
    if (filterRange.value) {
      const now = Date.now()
      const since = filterRange.value === '1h' ? now - 3600000 : now - 86400000
      params.set('since', String(since))
    } else if (filterDate.value) {
      const since = new Date(`${filterDate.value}T00:00:00`).getTime()
      const until = since + 86_400_000
      params.set('since', String(since))
      params.set('until', String(until))
    }
    const res = await authFetch(`/api/events/history?${params}`)
    if (res.ok) {
      const data = await res.json()
      const moreEvents: EventItem[] = (data.events as Array<Record<string, unknown>>).map((e) => ({
        id: e.id as number,
        time: formatTimestamp(e.timestamp as number),
        timestamp: e.timestamp as number,
        type: e.type as string,
        cameraId: e.camera_id as string,
        detail: (e.summary as string) || '',
        summary: (e.summary as string) || null,
        rawDetail: null,
        starred: e.starred === 1,
        snapshotUrl: (e.snapshotUrl as string) || null,
        snapshotDetections: (e.detections as Detection[]) || null,
      }))
      events.value.push(...moreEvents)
      hasMore.value = moreEvents.length >= PAGE_SIZE
    }
  } catch {
    // ignore
  } finally {
    loading.value = false
  }
}

/** 加载更多哨兵 ref */
const loadMoreSentinel = ref<HTMLElement | null>(null)

/** IntersectionObserver 自动加载更多 */
let loadMoreObserver: IntersectionObserver | null = null

onMounted(() => {
  loadHistory()
  loadMoreObserver = new IntersectionObserver((entries) => {
    if (entries[0]?.isIntersecting && hasMore.value && !loading.value) {
      loadMore()
    }
  }, { rootMargin: '200px' })
})

onUnmounted(() => {
  loadMoreObserver?.disconnect()
  loadMoreObserver = null
})

/** 哨兵元素挂载时开始观察 */
watch(loadMoreSentinel, (el) => {
  if (el && loadMoreObserver) {
    loadMoreObserver.observe(el)
  }
})

/** 切换事件展开 */
function toggleExpand(id: number) {
  expandedId.value = expandedId.value === id ? null : id
}

/** 获取检测框标签文本（含自定义名称） */
function getDetectionLabel(cameraId: string, d: Detection): string {
  const camLabels = props.trackLabels?.[cameraId]
  const customName = d.trackId && camLabels?.[d.trackId]
  const parts: string[] = []
  if (customName) parts.push(customName)
  if (d.trackId) parts.push(`#${d.trackId}`)
  parts.push(d.label)
  parts.push(`${(d.score * 100).toFixed(0)}%`)
  return parts.join(' ')
}

/** 解析 rawDetail 为结构化信息 */
function parseExpandedDetail(e: EventItem): Array<{ label: string; value: string; trackId?: number }> {
  if (!e.rawDetail) return []
  const items: Array<{ label: string; value: string; trackId?: number }> = []
  try {
    const obj = JSON.parse(e.rawDetail)
    if (e.type === 'motion' && obj.ratio !== undefined) {
      items.push({ label: t('event.ratio'), value: `${(obj.ratio * 100).toFixed(1)}%` })
    }
    if (e.type === 'detect' && Array.isArray(obj.detections)) {
      const camLabels = props.trackLabels?.[e.cameraId]
      for (const d of obj.detections as Array<{ label: string; score: number; trackId?: number }>) {
        const customName = d.trackId && camLabels?.[d.trackId]
        const name = customName ? `${customName} (#${d.trackId})` : d.trackId ? `#${d.trackId}` : ''
        items.push({ label: d.label, value: `${name}${name ? ' ' : ''}${(d.score * 100).toFixed(0)}%`, trackId: d.trackId })
      }
    }
    if (e.type === 'alert') {
      if (obj.ruleName) items.push({ label: t('event.rule'), value: obj.ruleName })
      if (obj.detail) items.push({ label: t('event.detail'), value: obj.detail })
    }
    /** 行为事件详情 */
    if (e.type === 'track:enter-zone' || e.type === 'track:leave-zone' || e.type === 'track:dwell') {
      if (obj.trackName) items.push({ label: t('event.name', '名称'), value: String(obj.trackName), trackId: obj.trackId })
      else if (obj.semanticLabel) items.push({ label: t('event.name', '名称'), value: String(obj.semanticLabel), trackId: obj.trackId })
      if (obj.label) items.push({ label: t('event.targets'), value: String(obj.label) })
      if (obj.zoneName) items.push({ label: t('event.zone', '区域'), value: String(obj.zoneName) })
      if (obj.dwellMs !== undefined) items.push({ label: t('event.dwellTime', '停留时长'), value: `${(obj.dwellMs / 1000).toFixed(1)}s` })
    }
    if (e.type === 'track:line-cross') {
      if (obj.trackName) items.push({ label: t('event.name', '名称'), value: String(obj.trackName), trackId: obj.trackId })
      else if (obj.semanticLabel) items.push({ label: t('event.name', '名称'), value: String(obj.semanticLabel), trackId: obj.trackId })
      if (obj.label) items.push({ label: t('event.targets'), value: String(obj.label) })
      if (obj.lineName) items.push({ label: t('event.zone', '区域'), value: String(obj.lineName) })
      if (obj.direction) items.push({ label: t('event.direction', '方向'), value: String(obj.direction) })
    }
    if (e.type === 'track:speed') {
      if (obj.trackName) items.push({ label: t('event.name', '名称'), value: String(obj.trackName), trackId: obj.trackId })
      else if (obj.semanticLabel) items.push({ label: t('event.name', '名称'), value: String(obj.semanticLabel), trackId: obj.trackId })
      if (obj.label) items.push({ label: t('event.targets'), value: String(obj.label) })
      if (obj.speed !== undefined) items.push({ label: t('event.speed', '速度'), value: String(obj.speed) })
    }
    /** AI 场景描述事件 */
    if (e.type === 'llm:scene') {
      if (obj.description) items.push({ label: t('event.description', '描述'), value: String(obj.description) })
      if (obj.trigger) items.push({ label: t('event.trigger', '触发'), value: String(obj.trigger) })
      if (obj.inferMs !== undefined) items.push({ label: t('event.inferTime', '推理耗时'), value: `${Math.round(obj.inferMs)}ms` })
    }
    /** 用户检测规则事件 */
    if (e.type === 'detect:rule') {
      if (obj.ruleName) items.push({ label: t('event.rule', '规则'), value: String(obj.ruleName) })
      if (obj.prompt) items.push({ label: t('event.prompt', '提示词'), value: String(obj.prompt) })
      if (obj.result) items.push({ label: t('event.result', '结果'), value: String(obj.result) })
      if (obj.confidence !== undefined) items.push({ label: t('event.confidence', '置信度'), value: `${(obj.confidence * 100).toFixed(0)}%` })
    }
    /** 状态变更事件 */
    if (e.type === 'state:changed') {
      if (obj.stateName) items.push({ label: t('event.name'), value: String(obj.stateName) })
      if (obj.oldValue !== undefined) items.push({ label: '→', value: `${obj.oldValue} → ${obj.newValue}` })
      if (obj.source) items.push({ label: t('event.detail'), value: obj.source.startsWith('rule:') ? t('state.sourceRule') : t('state.sourceManual') })
    }
  } catch {
    if (e.rawDetail) items.push({ label: t('event.detail'), value: e.rawDetail })
  }
  return items
}

/** 导出当前筛选的事件为 CSV（后端直接生成） */
function exportCsv() {
  const params = new URLSearchParams()
  if (filterType.value) params.set('type', filterType.value)
  if (filterCamera.value) params.set('cameraId', filterCamera.value)
  if (filterSearch.value) params.set('search', filterSearch.value)
  if (filterStarred.value) params.set('starred', 'true')
  if (filterRange.value) {
    const now = Date.now()
    const since = filterRange.value === '1h' ? now - 3600000 : now - 86400000
    params.set('since', String(since))
  } else if (filterDate.value) {
    const since = new Date(`${filterDate.value}T00:00:00`).getTime()
    const until = since + 86_400_000
    params.set('since', String(since))
    params.set('until', String(until))
  }
  const qs = params.toString()
  const link = document.createElement('a')
  link.href = authUrl(`/api/events/export${qs ? '?' + qs : ''}`)
  const dateStr = filterDate.value || new Date().toISOString().slice(0, 10)
  link.download = `events_${dateStr}.csv`
  link.click()
}

/** 切换快速时间范围 */
function setRange(range: string) {
  filterRange.value = filterRange.value === range ? '' : range
  filterDate.value = ''
  loadHistory()
}

/** 切换事件收藏状态 */
async function toggleStar(id: number) {
  try {
    const res = await authFetch(`/api/events/${id}/star`, { method: 'POST' })
    if (res.ok) {
      const data = await res.json()
      const item = events.value.find(e => e.id === id)
      if (item) item.starred = data.starred
    }
  } catch {
    // ignore
  }
}

defineExpose({ addEvent, addDetectEvent, loadHistory })
</script>

<template>
  <div class="event-panel">
    <div class="panel-header">
      <span>{{ t('event.title') }} <span v-if="totalCount > 0 && subView === 'events'" class="total-count">{{ totalCount }}</span></span>
      <button :class="['view-toggle', { active: subView === 'events' }]" @click="subView = 'events'" :title="t('event.viewEvents')">☰</button>
      <button :class="['view-toggle', { active: subView === 'gallery' }]" @click="switchToGallery" :title="t('event.viewGallery')">☷</button>
      <template v-if="subView === 'events'">
      <button :class="['range-btn', { active: filterRange === '1h' }]" @click="setRange('1h')">1h</button>
      <button :class="['range-btn', { active: filterRange === '24h' }]" @click="setRange('24h')">24h</button>
      <input
        type="date"
        v-model="filterDate"
        @change="filterRange = ''; loadHistory()"
        class="filter-date"
        :title="t('event.filterDate')"
      />
      <input
        type="text"
        v-model="filterSearch"
        @input="onSearchInput"
        class="filter-search"
        :placeholder="t('event.searchPlaceholder')"
        :title="t('event.search')"
      />
      <select v-model="filterCamera" @change="onFilterChange('camera')" class="filter-select">
        <option value="">{{ t('event.allCameras') }}</option>
        <option v-for="cam in cameras" :key="cam.id" :value="cam.id">{{ cam.name }}</option>
      </select>
      <div class="type-chips">
        <button :class="['type-chip', { active: !filterType }]" @click="filterType = ''; onFilterChange('type')">{{ t('event.allTypes') }}</button>
        <button :class="['type-chip', 'motion', { active: filterType === 'motion' }]" @click="filterType = 'motion'; onFilterChange('type')">{{ t('event.motion') }}</button>
        <button :class="['type-chip', 'detect', { active: filterType === 'detect' }]" @click="filterType = 'detect'; onFilterChange('type')">{{ t('event.detect') }}</button>
        <button :class="['type-chip', 'offline', { active: filterType === 'camera:offline' }]" @click="filterType = 'camera:offline'; onFilterChange('type')">{{ t('event.offline') }}</button>
        <button :class="['type-chip', 'lowfps', { active: filterType === 'camera:lowfps' }]" @click="filterType = 'camera:lowfps'; onFilterChange('type')">{{ t('event.lowfps') }}</button>
        <button :class="['type-chip', { active: filterType === 'track:enter-zone' }]" @click="filterType = 'track:enter-zone'; onFilterChange('type')">{{ t('event.trackEnterZone', '进入区域') }}</button>
        <button :class="['type-chip', { active: filterType === 'track:leave-zone' }]" @click="filterType = 'track:leave-zone'; onFilterChange('type')">{{ t('event.trackLeaveZone', '离开区域') }}</button>
        <button :class="['type-chip', { active: filterType === 'track:dwell' }]" @click="filterType = 'track:dwell'; onFilterChange('type')">{{ t('event.trackDwell', '停留') }}</button>
        <button :class="['type-chip', { active: filterType === 'track:speed' }]" @click="filterType = 'track:speed'; onFilterChange('type')">{{ t('event.trackSpeed', '高速') }}</button>
        <button :class="['type-chip', { active: filterType === 'track:line-cross' }]" @click="filterType = 'track:line-cross'; onFilterChange('type')">{{ t('event.trackLineCross', '越线') }}</button>
        <button :class="['type-chip', { active: filterType === 'track:loiter' }]" @click="filterType = 'track:loiter'; onFilterChange('type')">{{ t('event.trackLoiter', '徘徊') }}</button>
        <button :class="['type-chip', { active: filterType === 'track:appeared' }]" @click="filterType = 'track:appeared'; onFilterChange('type')">{{ t('event.trackAppeared', '出现') }}</button>
        <button :class="['type-chip', { active: filterType === 'track:disappeared' }]" @click="filterType = 'track:disappeared'; onFilterChange('type')">{{ t('event.trackDisappeared', '消失') }}</button>
        <button :class="['type-chip', { active: filterType === 'detect:rule' }]" @click="filterType = 'detect:rule'; onFilterChange('type')">{{ t('event.detectRule', '检测规则') }}</button>
        <button :class="['type-chip', { active: filterType === 'llm:scene' }]" @click="filterType = 'llm:scene'; onFilterChange('type')">{{ t('event.llmScene', 'AI场景') }}</button>
        <button :class="['type-chip', { active: filterType === 'state:changed' }]" @click="filterType = 'state:changed'; onFilterChange('type')">{{ t('event.stateChanged', '状态变更') }}</button>
      </div>
      <button class="refresh-btn" @click="loadHistory" :disabled="loading">
        {{ t('event.refresh') }}
      </button>
      <button class="export-btn" @click="exportCsv" :disabled="loading" :title="t('event.exportCsv')">
        CSV
      </button>
      <button :class="['sort-btn', { desc: sortDesc }]" @click="sortDesc = !sortDesc" :title="sortDesc ? t('event.sortOldest') : t('event.sortNewest')">
        {{ sortDesc ? '↓' : '↑' }}
      </button>
      <button :class="['detect-box-btn', { active: showDetectionBoxes }]" @click="showDetectionBoxes = !showDetectionBoxes" title="Toggle detection boxes">
        ⊡
      </button>
      <button :class="['star-filter-btn', { active: filterStarred }]" @click="filterStarred = !filterStarred; loadHistory()" :title="t('event.filterStarred')">
        {{ filterStarred ? '★' : '☆' }}
      </button>
      </template>
      <template v-if="subView === 'gallery'">
      <select v-model="snapFilterCamera" @change="loadSnapshots" class="filter-select">
        <option value="">{{ t('event.allCameras') }}</option>
        <option v-for="cam in cameras" :key="cam.id" :value="cam.id">{{ cam.name }}</option>
      </select>
      <select v-if="allSnapshotLabels.length > 1" v-model="snapFilterLabel" class="filter-select">
        <option value="">{{ t('event.allTypes') }}</option>
        <option v-for="label in allSnapshotLabels" :key="label" :value="label">{{ label }}</option>
      </select>
      <button class="refresh-btn" @click="loadSnapshots" :disabled="snapshotLoading">
        {{ t('event.refresh') }}
      </button>
      </template>
    </div>
    <EventTimeline v-if="subView === 'events'" :events="events" />
    <div v-if="subView === 'events'" class="event-list">
      <div v-if="events.length === 0" class="empty">
        {{ loading ? t('app.loading') : t('event.noEvents') }}
      </div>
      <div
        v-for="e in sortedEvents"
        :key="e.id"
        class="event-row"
        :class="{ expanded: expandedId === e.id, 'new-event': e.isNew }"
      >
        <div
          class="event-item"
          :class="e.type"
          @click="toggleExpand(e.id)"
        >
          <span class="event-time">{{ e.time }}</span>
          <span
            v-if="typeConfig[e.type]"
            class="event-type"
            :style="{ background: typeConfig[e.type].bg, color: typeConfig[e.type].color }"
          >{{ t(typeConfig[e.type].labelKey) }}</span>
          <span class="event-cam">{{ cameraName(e.cameraId) }}</span>
          <div v-if="getTrackSnapshotUrl(e.type, e.rawDetail)" class="thumb-wrap track-thumb">
            <img :src="getTrackSnapshotUrl(e.type, e.rawDetail)!" class="event-thumb" alt="" />
          </div>
          <div v-else-if="(e.type === 'detect' || e.type === 'alert' || e.type === 'detect:rule' || e.type === 'llm:scene') && e.snapshotUrl" class="thumb-wrap">
            <img
              :src="authUrl(e.snapshotUrl)"
              class="event-thumb"
              alt=""
            />
            <div v-if="(e.type === 'detect' || e.type === 'alert') && showDetectionBoxes && e.snapshotDetections?.length" class="thumb-boxes">
              <div
                v-for="(d, i) in e.snapshotDetections"
                :key="i"
                class="thumb-box"
                :style="{ left: d.box.xmin * 100 + '%', top: d.box.ymin * 100 + '%', width: (d.box.xmax - d.box.xmin) * 100 + '%', height: (d.box.ymax - d.box.ymin) * 100 + '%' }"
              />
            </div>
          </div>
          <span class="event-detail">{{ e.detail }}</span>
          <div v-if="e.type === 'motion' && motionRatio(e.detail) > 0" class="motion-bar-wrap">
            <div class="motion-bar" :style="{ width: Math.min(motionRatio(e.detail) * 10, 100) + '%', background: motionBarColor(motionRatio(e.detail)) }" />
          </div>
          <span class="expand-icon">{{ expandedId === e.id ? '▾' : '▸' }}</span>
          <button :class="['star-btn', { starred: e.starred }]" @click.stop="toggleStar(e.id)" :title="t('event.toggleStar')">
            {{ e.starred ? '★' : '☆' }}
          </button>
        </div>
        <!-- 展开详情 -->
        <div v-if="expandedId === e.id" class="event-expand">
          <div v-if="getTrackSnapshotUrl(e.type, e.rawDetail)" class="expand-snap-wrap">
            <img :src="getTrackSnapshotUrl(e.type, e.rawDetail)!" class="expand-snapshot" alt="" />
          </div>
          <div v-else-if="(e.type === 'detect' || e.type === 'alert' || e.type === 'detect:rule' || e.type === 'llm:scene') && (e.snapshotUrl || snapshotMapByCamera.get(e.cameraId))" class="expand-snap-wrap">
            <img
              :src="e.snapshotUrl ? authUrl(e.snapshotUrl) : snapshotMapByCamera.get(e.cameraId)"
              class="expand-snapshot"
              alt=""
            />
            <div v-if="(e.type === 'detect' || e.type === 'alert') && showDetectionBoxes && e.snapshotDetections?.length" class="expand-boxes">
              <div
                v-for="(d, i) in e.snapshotDetections"
                :key="i"
                class="expand-box-item"
                :style="{ left: d.box.xmin * 100 + '%', top: d.box.ymin * 100 + '%', width: (d.box.xmax - d.box.xmin) * 100 + '%', height: (d.box.ymax - d.box.ymin) * 100 + '%' }"
              >
                <span class="box-label">{{ getDetectionLabel(e.cameraId, d) }}</span>
              </div>
            </div>
          </div>
          <div v-for="(item, i) in parseExpandedDetail(e)" :key="i" class="detail-row" :class="{ clickable: !!item.trackId }" @click.stop="item.trackId && emit('jump-to-track', item.trackId)">
            <span class="detail-label">{{ item.label }}</span>
            <span class="detail-value">{{ item.value }}<span v-if="item.trackId" class="link-hint" /></span>
          </div>
          <div class="expand-actions">
            <button
              v-if="e.type === 'motion' || e.type === 'detect' || e.type.startsWith('track:')"
              class="play-btn"
              @click.stop="emit('play-recording', e.cameraId, e.timestamp)"
            >{{ t('event.viewRecording') }}</button>
          </div>
        </div>
      </div>
      <div v-if="events.length > MAX_RENDER_EVENTS" class="truncated-hint">
        {{ t('event.truncatedHint', { total: events.length, shown: MAX_RENDER_EVENTS }) }}
      </div>
      <div v-if="hasMore" ref="loadMoreSentinel" class="load-more">
        <button class="load-more-btn" @click="loadMore" :disabled="loading">
          {{ loading ? t('app.loading') : t('event.loadMore') }}
        </button>
      </div>
    </div>

    <!-- 快照画廊视图 -->
    <div v-if="subView === 'gallery'" class="gallery-container">
      <div v-if="filteredSnapshots.length === 0" class="empty">
        {{ snapshotLoading ? t('app.loading') : t('event.noSnapshots') }}
      </div>
      <div class="gallery-grid">
        <div
          v-for="snap in filteredSnapshots"
          :key="snap.filename"
          class="gallery-item"
          @click="openSnapPreview(snap)"
        >
          <img :src="snapThumbUrl(snap)" class="gallery-thumb" alt="" loading="lazy" />
          <div class="gallery-meta">
            <span class="gallery-cam">{{ cameraName(snap.cameraId) }}</span>
            <span class="gallery-time">{{ new Date(snap.timestamp).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }}</span>
            <span v-if="snap.detectionLabels" class="gallery-labels">{{ snap.detectionLabels }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 快照大图预览浮层 -->
    <div v-if="previewUrl" class="preview-overlay" @click.self="previewUrl = ''">
      <div class="preview-modal">
        <button class="preview-close" @click="previewUrl = ''">&times;</button>
        <img :src="previewUrl" class="preview-img" alt="" />
        <a :href="previewUrl" download class="preview-download" target="_blank">&#x2B07;</a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.event-panel {
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

.filter-select {
  background: #0a0a1a;
  color: #e0e0e0;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 12px;
}

.filter-date {
  background: #0a0a1a;
  color: #e0e0e0;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 12px;
}

.filter-date::-webkit-calendar-picker-indicator {
  filter: invert(0.7);
}

.filter-search {
  background: #0a0a1a;
  color: #e0e0e0;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 12px;
  width: 100px;
}

.type-chips {
  display: flex;
  gap: 3px;
  flex-wrap: wrap;
}

.type-chip {
  background: #2a2a4a;
  color: #888;
  border: none;
  border-radius: 10px;
  padding: 1px 8px;
  font-size: 10px;
  cursor: pointer;
  white-space: nowrap;
}

.type-chip:hover {
  color: #e0e0e0;
}

.type-chip.active {
  background: #4ECDC4;
  color: #1a1a2e;
  font-weight: 600;
}

.type-chip.motion.active {
  background: #FFD93D;
}

.type-chip.detect.active {
  background: #4ECDC4;
}

.type-chip.offline.active {
  background: #e74c3c;
  color: #fff;
}

.type-chip.lowfps.active {
  background: #FF9800;
  color: #fff;
}

.refresh-btn {
  background: #2a2a4a;
  color: #e0e0e0;
  border: none;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}

.refresh-btn:hover {
  background: #3a3a5a;
}

.refresh-btn:disabled {
  opacity: 0.5;
}

.export-btn {
  background: #4ECDC4;
  color: #1a1a2e;
  border: none;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.export-btn:disabled {
  opacity: 0.5;
}

.export-btn:hover:not(:disabled) {
  opacity: 0.85;
}

.sort-btn {
  background: #2a2a4a;
  color: #e0e0e0;
  border: none;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 12px;
  cursor: pointer;
}

.sort-btn:hover {
  background: #3a3a5a;
}

.range-btn {
  background: #2a2a4a;
  color: #888;
  border: none;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11px;
  cursor: pointer;
}

.range-btn:hover {
  background: #3a3a5a;
}

.range-btn.active {
  background: #4ECDC4;
  color: #1a1a2e;
}

.total-count {
  background: #2a2a4a;
  color: #888;
  border-radius: 8px;
  padding: 1px 6px;
  font-size: 11px;
  font-weight: 400;
  margin-left: 4px;
}

.event-list {
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

.event-item {
  display: flex;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  color: #aaa;
  align-items: center;
  cursor: pointer;
}

.event-item:hover {
  background: #2a2a4a;
}

.event-row {
  border-radius: 4px;
}

.event-row.new-event {
  animation: event-flash 1s ease-out;
}

@keyframes event-flash {
  0% { background: rgba(78, 205, 196, 0.25); }
  100% { background: transparent; }
}

.event-row.expanded {
  background: #16213e;
  border: 1px solid #2a2a4a;
}

.event-time {
  color: #666;
  flex-shrink: 0;
  min-width: 65px;
}

.event-type {
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
}

.event-cam {
  color: #888;
  flex-shrink: 0;
  min-width: 60px;
}

.event-thumb {
  width: 48px;
  height: 27px;
  object-fit: cover;
  border-radius: 3px;
  flex-shrink: 0;
}

.thumb-wrap {
  position: relative;
  width: 48px;
  height: 27px;
  flex-shrink: 0;
}

.thumb-wrap .event-thumb {
  display: block;
}

/** track 事件缩略图（正方形裁剪快照） */
.thumb-wrap.track-thumb {
  width: 27px;
  height: 27px;
  border-radius: 3px;
  overflow: hidden;
}
.thumb-wrap.track-thumb .event-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumb-boxes {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.thumb-box {
  position: absolute;
  border: 1px solid #FF6B6B;
  border-radius: 1px;
}

.detect-box-btn {
  background: #2a2a4a;
  color: #888;
  border: 1px solid #444;
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 12px;
  cursor: pointer;
}

.detect-box-btn:hover {
  border-color: #4ECDC4;
  color: #4ECDC4;
}

.detect-box-btn.active {
  background: #4ECDC4;
  border-color: #4ECDC4;
  color: #1a1a2e;
}

.event-detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.motion-bar-wrap {
  width: 40px;
  height: 4px;
  background: #2a2a4a;
  border-radius: 2px;
  flex-shrink: 0;
  align-self: center;
}

.motion-bar {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s;
}

.expand-icon {
  color: #555;
  font-size: 10px;
  flex-shrink: 0;
}

.event-expand {
  padding: 6px 12px 8px 80px;
  border-top: 1px solid #2a2a4a;
}

.expand-snap-wrap {
  position: relative;
  display: inline-block;
  margin-bottom: 6px;
}

.expand-snap-wrap .expand-snapshot {
  display: block;
}

.expand-boxes {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.expand-box-item {
  position: absolute;
  border: 2px solid #FF6B6B;
  border-radius: 2px;
}

.box-label {
  position: absolute;
  top: -18px;
  left: -1px;
  background: rgba(255, 107, 107, 0.85);
  color: #fff;
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 2px;
  white-space: nowrap;
  font-weight: 600;
}

.expand-snapshot {
  max-width: 320px;
  border-radius: 4px;
}

.detail-row {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  font-size: 12px;
}

.detail-label {
  color: #888;
  min-width: 60px;
}

.detail-value {
  color: #e0e0e0;
}

.detail-row.clickable {
  cursor: pointer;
  border-radius: 3px;
}
.detail-row.clickable:hover {
  background: rgba(78, 205, 196, 0.1);
}
.link-hint::after {
  content: ' →';
  color: #4ECDC4;
  font-size: 11px;
}

.expand-actions {
  margin-top: 6px;
}

.play-btn {
  background: #4ECDC4;
  color: #1a1a2e;
  border: none;
  border-radius: 4px;
  padding: 3px 12px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.play-btn:hover {
  opacity: 0.85;
}

.truncated-hint {
  padding: 8px;
  text-align: center;
  color: #888;
  font-size: 12px;
}

.load-more {
  padding: 8px;
  text-align: center;
}

.load-more-btn {
  background: #2a2a4a;
  color: #e0e0e0;
  border: none;
  border-radius: 4px;
  padding: 4px 16px;
  font-size: 12px;
  cursor: pointer;
}

.load-more-btn:hover {
  background: #3a3a5a;
}

.load-more-btn:disabled {
  opacity: 0.5;
}

/* 视图切换按钮 */
.view-toggle {
  background: none;
  border: 1px solid #444;
  color: #888;
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 12px;
  cursor: pointer;
}

.view-toggle:hover {
  border-color: #4ECDC4;
  color: #4ECDC4;
}

.view-toggle.active {
  background: #4ECDC4;
  border-color: #4ECDC4;
  color: #1a1a2e;
}

/* 收藏星标 */
.star-btn {
  background: none;
  border: none;
  color: #555;
  font-size: 14px;
  cursor: pointer;
  padding: 0 2px;
  line-height: 1;
  flex-shrink: 0;
  transition: color 0.15s;
}

.star-btn:hover {
  color: #FFD93D;
}

.star-btn.starred {
  color: #FFD93D;
}

.star-filter-btn {
  background: none;
  border: 1px solid #444;
  color: #888;
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 12px;
  cursor: pointer;
}

.star-filter-btn:hover {
  border-color: #FFD93D;
  color: #FFD93D;
}

.star-filter-btn.active {
  background: #FFD93D;
  border-color: #FFD93D;
  color: #1a1a2e;
}

/* 快照画廊 */
.gallery-container {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.gallery-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
}

.gallery-item {
  background: #0a0a1a;
  border-radius: 6px;
  overflow: hidden;
  cursor: pointer;
  border: 1px solid #2a2a4a;
  transition: border-color 0.15s, transform 0.15s;
}

.gallery-item:hover {
  border-color: #4ECDC4;
  transform: translateY(-2px);
}

.gallery-thumb {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  display: block;
}

.gallery-meta {
  padding: 4px 6px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.gallery-cam {
  font-size: 11px;
  color: #e0e0e0;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gallery-time {
  font-size: 10px;
  color: #888;
}

.gallery-labels {
  display: block;
  font-size: 10px;
  color: #4ECDC4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 快照大图预览 */
.preview-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.9);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.preview-modal {
  position: relative;
  max-width: 90vw;
  max-height: 90vh;
}

.preview-img {
  max-width: 100%;
  max-height: 85vh;
  border-radius: 6px;
}

.preview-close {
  position: absolute;
  top: -30px;
  right: 0;
  background: none;
  border: none;
  color: #e0e0e0;
  font-size: 24px;
  cursor: pointer;
}

.preview-close:hover {
  color: #4ECDC4;
}

.preview-download {
  position: absolute;
  top: -30px;
  right: 36px;
  background: none;
  border: none;
  color: #aaa;
  font-size: 20px;
  cursor: pointer;
  text-decoration: none;
}

.preview-download:hover {
  color: #4ECDC4;
}

/* 移动端适配 */
@media (max-width: 768px) {
  .event-panel {
    border-radius: 0;
    border: none;
  }

  .event-time {
    min-width: 55px;
  }

  .event-cam {
    min-width: 45px;
  }

  .gallery-grid {
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    gap: 6px;
  }
}
</style>
