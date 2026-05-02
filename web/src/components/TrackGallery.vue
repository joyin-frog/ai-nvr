<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { authFetch, authUrl } from '../services/auth'

const { t } = useI18n()

const props = defineProps<{
  cameras?: Array<{ id: string; online?: boolean }>
}>()

/** 追踪目标信息 */
interface TrackInfo {
  trackId: number
  label: string
  customName?: string
  firstSeen: number
  lastSeen: number
  hitCount: number
  cameraIds: string[]
  snapshotFile?: string
  /** 主色调名称 */
  dominantColor?: string
  /** CLIP 零样本分类语义标签 */
  semanticLabel?: string
  /** 行为事件数量 */
  eventCount?: number
  /** 当前是否活跃（前端计算） */
  _active?: boolean
  /** 语义搜索匹配分数（0-1） */
  searchScore?: number
}

/** 主色调名称 → 显示颜色 */
const COLOR_MAP: Record<string, string> = {
  red: '#e74c3c', orange: '#e67e22', yellow: '#f1c40f', lime: '#2ecc71',
  green: '#27ae60', cyan: '#1abc9c', blue: '#3498db', purple: '#9b59b6',
  pink: '#e91e63', gray: '#95a5a6',
}

const tracks = ref<TrackInfo[]>([])
const loading = ref(false)
/** 快照放大预览 URL */
const previewUrl = ref('')
/** dHash 匹配建议：trackId → { name, distance } */
const suggestions = ref<Map<number, { name: string; distance: number }>>(new Map())
/** 强制视图更新的 tick（用于活跃状态刷新） */
const viewTick = ref(0)
/** 正在编辑名称的 trackId */
const editingId = ref<number | null>(null)
const editName = ref('')
/** 标签筛选 */
const filterLabel = ref('')
/** 摄像头筛选 */
const filterCamera = ref('')
/** 仅显示未命名 */
const filterUnnamed = ref(false)
/** 仅显示活跃目标 */
const filterActive = ref(false)
/** 主色调筛选 */
const filterColor = ref('')
/** 名称/标签搜索 */
const searchText = ref('')
/** 语义搜索结果（CLIP text→image 匹配） */
const semanticResults = ref<TrackInfo[]>([])
/** 语义搜索加载中 */
const semanticSearching = ref(false)
/** 语义搜索防抖定时器 */
let semanticDebounce: ReturnType<typeof setTimeout> | null = null
/** 展开事件历史的 trackId */
const expandedTrackId = ref<number | null>(null)
/** trackId → 事件历史列表 */
const trackEvents = ref<Record<number, Array<{ id: number; type: string; camera_id: string; timestamp: number; detail: string | null }>>>({})
/** 事件历史加载中 */
const loadingEvents = ref(false)
/** trackId → 轨迹点（归一化坐标） */
const trackTrajectories = ref<Record<number, Array<{ x: number; y: number }>>>({})
/** trackId → 活跃时段分布（24 小时） */
const trackActivity = ref<Record<number, Array<{ hour: number; count: number }>>>({})
/** trackId → 区域停留统计 */
const trackZoneStats = ref<Record<number, Array<{ zoneName: string; totalDwellMs: number; visits: number }>>>({})

/** 事件类型标签样式 */
const EVENT_TYPE_STYLE: Record<string, { label: string; bg: string; color: string }> = {
  'track:appeared': { label: '出现', bg: '#81C784', color: '#fff' },
  'track:disappeared': { label: '消失', bg: '#E57373', color: '#fff' },
  'track:enter-zone': { label: '进入', bg: '#26A69A', color: '#fff' },
  'track:leave-zone': { label: '离开', bg: '#AB47BC', color: '#fff' },
  'track:dwell': { label: '停留', bg: '#FF9800', color: '#fff' },
  'track:speed': { label: '速度', bg: '#42A5F5', color: '#fff' },
  'track:line-cross': { label: '越线', bg: '#FF6F00', color: '#fff' },
  'track:loiter': { label: '徘徊', bg: '#795548', color: '#fff' },
  'track:match-suggest': { label: '匹配', bg: '#CE93D8', color: '#fff' },
  'detect': { label: '检测', bg: '#4ECDC4', color: '#fff' },
  'motion': { label: '变动', bg: '#FFC107', color: '#333' },
}
let refreshTimer: ReturnType<typeof setInterval> | null = null

const emit = defineEmits<{
  jumpToRecording: [cameraId: string, timestamp: number]
  viewLive: [cameraId: string]
}>()

/** 加载追踪目标列表 */
async function loadTracks() {
  loading.value = true
  const res = await authFetch('/api/tracks')
  if (res.ok) {
    tracks.value = await res.json()
  }
  /** 加载 dHash 匹配建议 */
  const sugRes = await authFetch('/api/tracks/suggestions')
  if (sugRes.ok) {
    const data = await sugRes.json() as Array<{ trackId: number; suggestedName: string; distance: number }>
    const map = new Map<number, { name: string; distance: number }>()
    for (const s of data) {
      map.set(s.trackId, { name: s.suggestedName, distance: s.distance })
    }
    suggestions.value = map
  }
  loading.value = false
}

/** 快照图片 URL */
function snapshotUrl(filename: string | undefined): string {
  if (!filename) return ''
  return authUrl(`/api/tracks/snapshot/${filename}`)
}

/** 所有已命名的目标名称（去重，用于快速关联下拉） */
const existingNames = computed(() => {
  const names = new Set<string>()
  for (const t of tracks.value) {
    if (t.customName) names.add(t.customName)
  }
  return [...names].sort()
})

/** 快速应用已有名称 */
function applyExistingName(name: string) {
  editName.value = name
}

/** 开始编辑名称 */
function startEdit(track: TrackInfo) {
  editingId.value = track.trackId
  editName.value = track.customName ?? ''
}

/** 合并确认状态 */
const mergeConfirm = ref<{ sourceId: number; targetId: number; name: string } | null>(null)

/** 查找使用指定名称的其他目标 */
function findTrackByName(name: string, excludeId: number): TrackInfo | undefined {
  return tracks.value.find(t => t.customName === name && t.trackId !== excludeId)
}

/** 一键应用 dHash 匹配建议 */
async function applySuggestion(trackId: number) {
  const sug = suggestions.value.get(trackId)
  if (!sug) return
  await doSaveName(trackId, sug.name)
}

/** 保存名称 */
async function saveName(trackId: number) {
  const name = editName.value.trim()
  /** 检查是否有同名目标 → 触发合并确认 */
  const existing = findTrackByName(name, trackId)
  if (existing) {
    mergeConfirm.value = { sourceId: trackId, targetId: existing.trackId, name }
    return
  }
  await doSaveName(trackId, name)
}

/** 仅命名（不合并） */
async function doSaveName(trackId: number, name: string) {
  await authFetch(`/api/tracks/${trackId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customName: name }),
  })
  editingId.value = null
  mergeConfirm.value = null
  await loadTracks()
}

/** 确认合并 */
async function confirmMerge() {
  if (!mergeConfirm.value) return
  const { sourceId, targetId, name } = mergeConfirm.value
  /** 先合并，再给目标设置名称 */
  await authFetch('/api/tracks/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId, targetId }),
  })
  /** 确保目标名称正确 */
  await authFetch(`/api/tracks/${targetId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customName: name }),
  })
  editingId.value = null
  mergeConfirm.value = null
  await loadTracks()
}

/** 取消合并，改为仅命名 */
function cancelMerge() {
  if (!mergeConfirm.value) return
  doSaveName(mergeConfirm.value.sourceId, mergeConfirm.value.name)
}

/** 取消编辑 */
function cancelEdit() {
  editingId.value = null
}

/** 删除追踪目标 */
const confirmDelete = ref<number | null>(null)
async function deleteTrack(trackId: number) {
  await authFetch(`/api/tracks/${trackId}`, { method: 'DELETE' })
  confirmDelete.value = null
  await loadTracks()
}

/** 加载追踪目标的检测事件历史 */
async function loadTrackEvents(trackId: number) {
  if (expandedTrackId.value === trackId) {
    expandedTrackId.value = null
    return
  }
  expandedTrackId.value = trackId
  /** 并行加载事件历史和轨迹数据 */
  const promises: Promise<void>[] = []
  if (!trackEvents.value[trackId]) {
    loadingEvents.value = true
    promises.push(
      authFetch(`/api/tracks/${trackId}/events?limit=20`)
        .then(res => res.ok ? res.json() : [])
        .then(data => { trackEvents.value = { ...trackEvents.value, [trackId]: data } })
        .finally(() => { loadingEvents.value = false })
    )
  }
  if (!trackTrajectories.value[trackId]) {
    promises.push(
      authFetch(`/api/tracks/trajectory/${trackId}`)
        .then(res => res.ok ? res.json() : { points: [] })
        .then((data: { points: Array<{ x: number; y: number }> }) => {
          trackTrajectories.value = { ...trackTrajectories.value, [trackId]: data.points }
        })
        .catch(() => {})
    )
  }
  if (!trackActivity.value[trackId]) {
    promises.push(
      authFetch(`/api/tracks/activity/${trackId}`)
        .then(res => res.ok ? res.json() : { hours: [] })
        .then((data: { hours: Array<{ hour: number; count: number }> }) => {
          trackActivity.value = { ...trackActivity.value, [trackId]: data.hours }
        })
        .catch(() => {})
    )
  }
  if (!trackZoneStats.value[trackId]) {
    promises.push(
      authFetch(`/api/tracks/zone-stats/${trackId}`)
        .then(res => res.ok ? res.json() : [])
        .then((data: Array<{ zoneName: string; totalDwellMs: number; visits: number }>) => {
          if (data.length > 0) trackZoneStats.value = { ...trackZoneStats.value, [trackId]: data }
        })
        .catch(() => {})
    )
  }
  await Promise.all(promises)
}

/** 格式化时间 */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

/** 格式化相对时间 */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return t('tracks.secondsAgo', { n: Math.floor(diff / 1000) })
  if (diff < 3600000) return t('tracks.minutesAgo', { n: Math.floor(diff / 60000) })
  if (diff < 86400000) return t('tracks.hoursAgo', { n: Math.floor(diff / 3600000) })
  return t('tracks.daysAgo', { n: Math.floor(diff / 86400000) })
}

/** 判断目标是否活跃（最近 30 秒内被检测到） */
function isTrackActive(track: TrackInfo): boolean {
  void viewTick.value
  return Date.now() - track.lastSeen < 30000
}

/** 生成轨迹 SVG polyline 的 points 属性 */
function trailSvgPoints(trackId: number): string {
  const pts = trackTrajectories.value[trackId]
  if (!pts || pts.length < 2) return ''
  const svgW = 200
  const svgH = 100
  return pts.map(p => `${(p.x * svgW).toFixed(1)},${(p.y * svgH).toFixed(1)}`).join(' ')
}

/** 活跃时段条形图高度（百分比） */
function activityHeight(trackId: number, count: number): number {
  const hours = trackActivity.value[trackId]
  if (!hours) return 0
  const max = Math.max(1, ...hours.map(h => h.count))
  return (count / max) * 100
}

/** 格式化毫秒时长为可读文本 */
function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`
  if (ms < 3600000) return `${Math.round(ms / 60000)}min`
  const h = Math.floor(ms / 3600000)
  const m = Math.round((ms % 3600000) / 60000)
  return m > 0 ? `${h}h${m}m` : `${h}h`
}

/** 区域停留条形图宽度（百分比） */
function zoneBarWidth(trackId: number, dwellMs: number): number {
  const stats = trackZoneStats.value[trackId]
  if (!stats || stats.length === 0) return 0
  const max = Math.max(1, ...stats.map(s => s.totalDwellMs))
  return (dwellMs / max) * 100
}

/** 所有出现过的标签 */
const allLabels = computed(() => {
  const set = new Set<string>()
  for (const t of tracks.value) set.add(t.label)
  return [...set].sort()
})

/** 所有出现过的摄像头 */
const allCameras = computed(() => {
  const set = new Set<string>()
  for (const t of tracks.value) for (const c of t.cameraIds) set.add(c)
  return [...set].sort()
})

/** 所有出现过的主色调 */
const allColors = computed(() => {
  const set = new Set<string>()
  for (const t of tracks.value) if (t.dominantColor) set.add(t.dominantColor)
  return [...set].sort()
})

/** 按标签 + 摄像头 + 搜索 + 未命名筛选后的列表 */
const filteredTracks = computed(() => {
  let list = tracks.value
  if (filterLabel.value) list = list.filter(t => t.label === filterLabel.value)
  if (filterCamera.value) list = list.filter(t => t.cameraIds.includes(filterCamera.value))
  if (filterColor.value) list = list.filter(t => t.dominantColor === filterColor.value)
  if (filterUnnamed.value) list = list.filter(t => !t.customName)
  if (filterActive.value) list = list.filter(t => isTrackActive(t))
  if (searchText.value) {
    const q = searchText.value.toLowerCase()
    const localMatches = list.filter(t =>
      (t.customName && t.customName.toLowerCase().includes(q))
      || t.label.toLowerCase().includes(q)
      || (t.semanticLabel && t.semanticLabel.toLowerCase().includes(q))
      || String(t.trackId).includes(q)
    )
    /** 本地匹配有结果就用本地结果；否则展示语义搜索结果 */
    if (localMatches.length > 0) return localMatches
    if (semanticResults.value.length > 0) {
      /** 用语义搜索结果覆盖，但仍应用筛选条件 */
      return semanticResults.value
    }
    return []
  }
  return list
})

/** 触发语义搜索（防抖 500ms） */
function triggerSemanticSearch(query: string) {
  if (semanticDebounce) clearTimeout(semanticDebounce)
  if (!query || query.length < 2) {
    semanticResults.value = []
    semanticSearching.value = false
    return
  }
  semanticDebounce = setTimeout(async () => {
    semanticSearching.value = true
    const url = authUrl(`/api/tracks/semantic-search?q=${encodeURIComponent(query)}`)
    const res = await authFetch(url)
    if (res.ok) {
      semanticResults.value = await res.json()
    }
    semanticSearching.value = false
  }, 500)
}

/** 未命名的目标数量 */
const unnamedCount = computed(() => tracks.value.filter(t => !t.customName).length)

/** 活跃目标数量 */
const activeCount = computed(() => {
  void viewTick.value
  return tracks.value.filter(t => Date.now() - t.lastSeen < 30000).length
})

/** 有匹配建议的未命名目标数量 */
const suggestableCount = computed(() => tracks.value.filter(t => !t.customName && suggestions.value.has(t.trackId)).length)

/** 批量应用所有匹配建议 */
async function applyAllSuggestions() {
  const promises: Promise<void>[] = []
  for (const t of tracks.value) {
    if (t.customName) continue
    const sug = suggestions.value.get(t.trackId)
    if (!sug) continue
    promises.push(doSaveName(t.trackId, sug.name))
  }
  await Promise.all(promises)
  await loadTracks()
}

/** 批量删除确认状态 */
const batchDeleteConfirm = ref(false)

/** 批量删除所有未命名目标 */
async function deleteUnnamed() {
  const promises: Promise<void>[] = []
  for (const t of tracks.value) {
    if (t.customName) continue
    promises.push(authFetch(`/api/tracks/${t.trackId}`, { method: 'DELETE' }).then(() => {}))
  }
  await Promise.all(promises)
  batchDeleteConfirm.value = false
  await loadTracks()
}

/** 判断是否为新目标（最近 5 分钟内首次出现且未命名） */
function isNewTrack(track: TrackInfo): boolean {
  if (track.customName) return false
  return Date.now() - track.firstSeen < 300000
}

let activeTickTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  loadTracks()
  /** 每 30 秒刷新数据 */
  refreshTimer = setInterval(loadTracks, 30000)
  /** 每 10 秒更新活跃状态指示 */
  activeTickTimer = setInterval(() => { viewTick.value++ }, 10000)
})

/** 搜索文本变化时触发语义搜索 */
watch(searchText, (q) => {
  triggerSemanticSearch(q)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
  if (activeTickTimer) clearInterval(activeTickTimer)
  if (semanticDebounce) clearTimeout(semanticDebounce)
})

/** 选中并滚动到指定追踪目标 */
function selectTrack(trackId: number) {
  expandedTrackId.value = trackId
  loadTrackEvents(trackId)
  /** 延迟滚动，等 DOM 更新 */
  setTimeout(() => {
    const el = document.querySelector(`[data-track-id="${trackId}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, 100)
}

defineExpose({ loadTracks, selectTrack })
</script>

<template>
  <div class="track-gallery">
    <div class="gallery-header">
      <h3>{{ t('tracks.title') }} <span class="track-total">{{ filteredTracks.length }}</span></h3>
      <input
        v-model="searchText"
        class="search-input"
        :placeholder="t('tracks.search', '搜索名称/标签...')"
      />
      <span v-if="semanticSearching" class="semantic-hint" title="CLIP 语义搜索中...">...</span>
      <select v-if="allLabels.length > 1" v-model="filterLabel" class="label-filter">
        <option value="">{{ t('tracks.all') }}</option>
        <option v-for="label in allLabels" :key="label" :value="label">{{ label }}</option>
      </select>
      <select v-if="allCameras.length > 1" v-model="filterCamera" class="label-filter">
        <option value="">{{ t('tracks.all') }}</option>
        <option v-for="cam in allCameras" :key="cam" :value="cam">{{ cam }}</option>
      </select>
      <div v-if="allColors.length > 1" class="color-filter-group">
        <button
          v-for="color in allColors" :key="color"
          class="color-filter-dot"
          :class="{ active: filterColor === color }"
          :style="{ background: COLOR_MAP[color] ?? '#666' }"
          :title="color"
          @click="filterColor = filterColor === color ? '' : color"
        ></button>
      </div>
      <button
        v-if="activeCount > 0"
        class="active-filter-btn"
        :class="{ active: filterActive }"
        @click="filterActive = !filterActive"
        :title="t('tracks.filterActive', '仅显示活跃目标')"
      >
        ● {{ activeCount }} {{ t('tracks.active', '活跃') }}
      </button>
      <button
        v-if="unnamedCount > 0"
        class="unnamed-filter-btn"
        :class="{ active: filterUnnamed }"
        @click="filterUnnamed = !filterUnnamed"
        :title="t('tracks.filterUnnamed', '仅显示未命名')"
      >
        {{ unnamedCount }} {{ t('tracks.unnamed', '未命名') }}
      </button>
      <button
        v-if="suggestableCount > 0"
        class="suggest-all-btn"
        @click="applyAllSuggestions"
        :title="t('tracks.applyAllSuggestions', '一键应用所有匹配建议')"
      >
        ≈ {{ suggestableCount }}
      </button>
      <template v-if="unnamedCount > 0">
        <button
          v-if="!batchDeleteConfirm"
          class="batch-delete-btn"
          @click="batchDeleteConfirm = true"
          :title="t('tracks.deleteUnnamed', '删除所有未命名目标')"
        >
          ✕ {{ unnamedCount }}
        </button>
        <template v-else>
          <button class="delete-confirm-btn" @click="deleteUnnamed">{{ t('manage.confirm') }}</button>
          <button class="delete-cancel-btn" @click="batchDeleteConfirm = false">{{ t('manage.cancel') }}</button>
        </template>
      </template>
      <button class="refresh-btn" @click="loadTracks" :disabled="loading">
        {{ loading ? '...' : '↻' }}
      </button>
    </div>

    <div v-if="tracks.length === 0" class="empty">
      {{ t('tracks.empty') }}
    </div>

    <div v-else class="track-grid">
      <div v-for="track in filteredTracks" :key="track.trackId" class="track-card" :class="{ 'new-track': isNewTrack(track), 'highlighted': expandedTrackId === track.trackId }"
            :data-track-id="track.trackId"
            @dblclick="props.cameras?.find(c => c.id === track.cameraIds[0])?.online && emit('viewLive', track.cameraIds[0])">
        <!-- 快照 -->
        <div class="track-snapshot" @click="track.snapshotFile && (previewUrl = snapshotUrl(track.snapshotFile))">
          <img
            v-if="track.snapshotFile"
            :src="snapshotUrl(track.snapshotFile)"
            :alt="`Track #${track.trackId}`"
            class="snapshot-img"
          />
          <div v-else class="no-snapshot">
            <span>{{ track.label.charAt(0).toUpperCase() }}</span>
          </div>
        </div>

        <!-- 信息 -->
        <div class="track-info">
          <div class="track-name-row">
            <template v-if="editingId === track.trackId">
              <div class="name-edit-group">
                <input
                  v-model="editName"
                  class="name-input"
                  :placeholder="track.label"
                  @keydown.enter="saveName(track.trackId)"
                  @keydown.escape="cancelEdit"
                  autofocus
                />
                <button class="save-btn" @click="saveName(track.trackId)">✓</button>
                <button class="cancel-btn" @click="cancelEdit">✗</button>
                <!-- 快速关联已有名称下拉 -->
                <select
                  v-if="existingNames.length > 0"
                  class="name-preset"
                  @change="applyExistingName(($event.target as HTMLSelectElement).value)"
                  :title="t('tracks.quickName', '快速关联')"
                >
                  <option value="">{{ t('tracks.quickName', '关联...') }}</option>
                  <option v-for="name in existingNames" :key="name" :value="name">{{ name }}</option>
                </select>
              </div>
            </template>
            <template v-else>
              <span class="track-label" @dblclick="startEdit(track)">
                {{ track.customName || track.label }}
              </span>
              <span v-if="track.customName" class="track-original-label">{{ track.label }}</span>
              <span v-if="track.semanticLabel" class="track-semantic-label">{{ track.semanticLabel }}</span>
              <span v-if="track.searchScore" class="track-search-score">{{ (track.searchScore * 100).toFixed(0) }}%</span>
              <!-- dHash 匹配建议：一键应用 -->
              <button
                v-if="!track.customName && suggestions.get(track.trackId)"
                class="suggest-btn"
                @click.stop="applySuggestion(track.trackId)"
                :title="t('tracks.applySuggestion', '点击应用建议名称')"
              >
                ≈ {{ suggestions.get(track.trackId)!.name }} ({{ ((1 - suggestions.get(track.trackId)!.distance) * 100).toFixed(0) }}%)
              </button>
            </template>
          </div>
          <div class="track-meta">
            <span class="track-id">#{{ track.trackId }}</span>
            <span
              v-if="track.dominantColor && COLOR_MAP[track.dominantColor]"
              class="color-dot"
              :style="{ background: COLOR_MAP[track.dominantColor] }"
              :title="track.dominantColor"
            ></span>
            <span v-if="isTrackActive(track)" class="track-active" :title="t('tracks.active', '活跃中')">●</span>
            <span class="track-count">{{ track.hitCount }}次</span>
            <span v-if="track.eventCount" class="track-event-count" :title="t('tracks.eventCount', '行为事件')">{{ track.eventCount }}evt</span>
            <span class="track-time" :title="formatTime(track.lastSeen)">{{ relativeTime(track.lastSeen) }}</span>
          </div>
          <div class="track-cameras">
            <span
              v-for="(camId, idx) in track.cameraIds" :key="camId"
              class="cam-tag clickable"
              :class="{ 'cam-online': props.cameras?.find(c => c.id === camId)?.online, active: filterCamera === camId }"
              @click="filterCamera = filterCamera === camId ? '' : camId"
            >{{ camId }}{{ idx < track.cameraIds.length - 1 ? ',' : '' }}</span>
          </div>
          <div class="action-btns">
            <button class="play-btn" @click="emit('jumpToRecording', track.cameraIds[0], track.lastSeen)">
              ▶ {{ t('tracks.playRecording') }}
            </button>
            <button
              v-if="props.cameras?.find(c => c.id === track.cameraIds[0])?.online"
              class="live-btn"
              @click="emit('viewLive', track.cameraIds[0])"
            >
              ◎ {{ t('tracks.viewLive', '实时') }}
            </button>
          </div>
          <div class="action-row">
            <button class="history-btn" @click="loadTrackEvents(track.trackId)">
              {{ expandedTrackId === track.trackId ? '▲' : '▼' }} {{ t('tracks.history') }}
            </button>
            <button v-if="confirmDelete !== track.trackId" class="delete-btn" @click="confirmDelete = track.trackId" :title="t('tracks.delete')">✕</button>
            <template v-else>
              <button class="delete-confirm-btn" @click="deleteTrack(track.trackId)">{{ t('manage.confirm', '确认') }}</button>
              <button class="delete-cancel-btn" @click="confirmDelete = null">{{ t('manage.cancel', '取消') }}</button>
            </template>
          </div>
          <!-- 迷你轨迹图 -->
          <div v-if="expandedTrackId === track.trackId && trailSvgPoints(track.trackId)" class="trail-mini">
            <svg viewBox="0 0 200 100" class="trail-svg">
              <rect width="200" height="100" fill="#0a0a1a" rx="3" />
              <polyline :points="trailSvgPoints(track.trackId)" fill="none" :stroke="COLOR_MAP[track.dominantColor ?? ''] ?? '#4ECDC4'" stroke-width="1.5" stroke-linejoin="round" />
              <circle v-if="trackTrajectories[track.trackId]?.length" :cx="(trackTrajectories[track.trackId].at(-1)!.x * 200).toFixed(1)" :cy="(trackTrajectories[track.trackId].at(-1)!.y * 100).toFixed(1)" r="3" fill="#fff" />
            </svg>
          </div>
          <!-- 活跃时段分布（24小时条形图） -->
          <div v-if="expandedTrackId === track.trackId && trackActivity[track.trackId]" class="activity-section">
            <div class="activity-chart">
              <div v-for="h in trackActivity[track.trackId]" :key="h.hour" class="activity-bar-wrap" :title="`${h.hour}:00 — ${h.count} 次`">
                <div class="activity-bar">
                  <div class="activity-fill" :style="{ height: activityHeight(track.trackId, h.count) + '%' }" />
                </div>
                <span v-if="h.hour % 4 === 0" class="activity-label">{{ h.hour }}</span>
              </div>
            </div>
          </div>
          <!-- 区域停留统计 -->
          <div v-if="expandedTrackId === track.trackId && trackZoneStats[track.trackId]?.length" class="zone-stats">
            <div v-for="zs in trackZoneStats[track.trackId]" :key="zs.zoneName" class="zone-stat-row">
              <span class="zone-stat-name">{{ zs.zoneName }}</span>
              <span class="zone-stat-detail">{{ formatDuration(zs.totalDwellMs) }} / {{ zs.visits }}次</span>
              <div class="zone-stat-bar">
                <div class="zone-stat-fill" :style="{ width: zoneBarWidth(track.trackId, zs.totalDwellMs) + '%' }" />
              </div>
            </div>
          </div>
          <!-- 事件历史列表 -->
          <div v-if="expandedTrackId === track.trackId && trackEvents[track.trackId]" class="event-list">
            <div v-if="trackEvents[track.trackId].length === 0" class="event-empty">
              {{ t('tracks.noEvents') }}
            </div>
            <div v-for="ev in trackEvents[track.trackId]" :key="ev.id" class="event-item"
              @click="emit('jumpToRecording', ev.camera_id, ev.timestamp)">
              <span v-if="EVENT_TYPE_STYLE[ev.type]" class="event-type-tag" :style="{ background: EVENT_TYPE_STYLE[ev.type].bg, color: EVENT_TYPE_STYLE[ev.type].color }">{{ EVENT_TYPE_STYLE[ev.type].label }}</span>
              <span class="event-time">{{ new Date(ev.timestamp).toLocaleString() }}</span>
              <span class="event-cam">{{ ev.camera_id }}</span>
              <button class="event-play" @click.stop="emit('jumpToRecording', ev.camera_id, ev.timestamp)">▶</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 合并确认对话框 -->
    <div v-if="mergeConfirm" class="merge-overlay" @click.self="mergeConfirm = null">
      <div class="merge-dialog">
        <p class="merge-text">{{ t('tracks.mergeConfirm', { name: mergeConfirm.name }) }}</p>
        <p class="merge-hint">{{ t('tracks.mergeHint', '合并将把两个目标的记录整合到一起') }}</p>
        <div class="merge-actions">
          <button class="merge-yes-btn" @click="confirmMerge">{{ t('tracks.mergeAction', '合并') }}</button>
          <button class="merge-no-btn" @click="cancelMerge">{{ t('tracks.justName', '仅命名') }}</button>
          <button class="merge-cancel-btn" @click="mergeConfirm = null; editingId = null">{{ t('manage.cancel', '取消') }}</button>
        </div>
      </div>
    </div>

    <!-- 快照放大预览 -->
    <div v-if="previewUrl" class="preview-overlay" @click="previewUrl = ''">
      <img :src="previewUrl" class="preview-img" @click.stop />
    </div>
  </div>
</template>

<style scoped>
.track-gallery {
  padding: 12px;
}

.gallery-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.gallery-header h3 {
  color: #e0e0e0;
  font-size: 14px;
  margin: 0;
  flex-shrink: 0;
}

.track-total {
  color: #4ECDC4;
  font-size: 12px;
}

.search-input {
  background: #2a2a4a;
  color: #e0e0e0;
  border: 1px solid #2a2a4a;
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 11px;
  outline: none;
  flex: 1;
  min-width: 80px;
}

.search-input:focus { border-color: #4ECDC4; }
.search-input::placeholder { color: #555; }

.semantic-hint {
  color: #9b59b6;
  font-size: 12px;
  animation: pulse 1s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.label-filter {
  background: #2a2a4a;
  color: #e0e0e0;
  border: 1px solid #2a2a4a;
  border-radius: 3px;
  padding: 1px 4px;
  font-size: 11px;
  outline: none;
  flex-shrink: 0;
}

.label-filter:focus { border-color: #4ECDC4; }

.refresh-btn {
  background: #2a2a4a;
  color: #e0e0e0;
  border: none;
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 12px;
}

.refresh-btn:hover { background: #3a3a5a; }
.refresh-btn:disabled { opacity: 0.5; }

.unnamed-filter-btn {
  background: #2a2a4a;
  color: #FFC107;
  border: 1px solid #FFC10740;
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 11px;
  flex-shrink: 0;
}

.unnamed-filter-btn.active {
  background: #FFC10720;
  border-color: #FFC107;
}

.unnamed-filter-btn:hover { background: #FFC10720; }

.active-filter-btn {
  background: #2a2a4a;
  color: #4CAF50;
  border: 1px solid #4CAF5040;
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 11px;
  flex-shrink: 0;
}

.active-filter-btn.active {
  background: #4CAF5020;
  border-color: #4CAF50;
}

.active-filter-btn:hover { background: #4CAF5020; }

.suggest-all-btn {
  background: rgba(156, 39, 176, 0.2);
  color: #CE93D8;
  border: 1px solid rgba(156, 39, 176, 0.4);
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 11px;
  flex-shrink: 0;
}
.suggest-all-btn:hover {
  background: rgba(156, 39, 176, 0.35);
}

.batch-delete-btn {
  background: none;
  color: #666;
  border: 1px solid #e74c3c40;
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 11px;
  flex-shrink: 0;
}
.batch-delete-btn:hover {
  color: #e74c3c;
  border-color: #e74c3c;
  background: #e74c3c15;
}

.new-track {
  border-color: #FFC10760;
  animation: new-track-glow 2s ease-out;
}

@keyframes new-track-glow {
  0% { box-shadow: 0 0 12px #FFC10740; }
  100% { box-shadow: none; }
}

.empty {
  color: #555;
  text-align: center;
  padding: 24px;
  font-size: 13px;
}

.track-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
}

.track-card {
  background: #1a1a3a;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid #2a2a4a;
  transition: border-color 0.2s;
}

.track-card:hover {
  border-color: #4ECDC4;
}

.track-card.highlighted {
  border-color: #9b59b6;
  box-shadow: 0 0 12px rgba(155, 89, 182, 0.5);
}

.track-snapshot {
  width: 100%;
  height: 120px;
  overflow: hidden;
  background: #0a0a1a;
}

.track-snapshot img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.no-snapshot {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #4ECDC4;
  font-size: 32px;
  font-weight: bold;
}

.track-info {
  padding: 8px;
}

.track-name-row {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
}

.track-label {
  color: #e0e0e0;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.track-label:hover {
  color: #4ECDC4;
}

.track-original-label {
  color: #666;
  font-size: 10px;
}

.track-semantic-label {
  color: #9c27b0;
  font-size: 10px;
  font-style: italic;
  margin-left: 4px;
}

.track-search-score {
  color: #4ECDC4;
  font-size: 10px;
  font-weight: 600;
  margin-left: 4px;
}

.suggest-btn {
  display: inline-block;
  background: rgba(156, 39, 176, 0.2);
  border: 1px solid rgba(156, 39, 176, 0.4);
  border-radius: 3px;
  color: #CE93D8;
  font-size: 10px;
  padding: 1px 5px;
  cursor: pointer;
  margin-left: 4px;
  white-space: nowrap;
}
.suggest-btn:hover {
  background: rgba(156, 39, 176, 0.35);
}

.name-input {
  background: #0a0a1a;
  border: 1px solid #4ECDC4;
  color: #e0e0e0;
  border-radius: 3px;
  padding: 1px 4px;
  font-size: 11px;
  width: 80px;
  outline: none;
}

.name-edit-group {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
}

.name-preset {
  background: #1a1a2e;
  border: 1px solid #444;
  color: #aaa;
  border-radius: 3px;
  padding: 1px 2px;
  font-size: 10px;
  cursor: pointer;
  outline: none;
  max-width: 90px;
}

.name-preset:hover {
  border-color: #4ECDC4;
  color: #4ECDC4;
}

.save-btn, .cancel-btn {
  background: none;
  border: none;
  color: #4ECDC4;
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
}

.cancel-btn { color: #e74c3c; }

.track-meta {
  display: flex;
  gap: 6px;
  font-size: 10px;
  color: #888;
}

.track-id { color: #4ECDC4; }

.color-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  vertical-align: middle;
}

.color-filter-group {
  display: flex;
  gap: 3px;
  align-items: center;
  flex-shrink: 0;
}

.color-filter-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  transition: border-color 0.15s, transform 0.15s;
  padding: 0;
}

.color-filter-dot:hover {
  transform: scale(1.2);
}

.color-filter-dot.active {
  border-color: #fff;
  transform: scale(1.2);
}
.track-count { color: #aaa; }
.track-event-count { color: #FF9800; font-size: 9px; }
.track-time { color: #666; }
.track-active {
  color: #4CAF50;
  animation: active-pulse 1.5s infinite;
}
@keyframes active-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.track-cameras {
  font-size: 10px;
  color: #555;
  margin-top: 2px;
  display: flex;
  gap: 2px;
  flex-wrap: wrap;
}

.cam-tag {
  color: #555;
  cursor: default;
}

.cam-tag.clickable {
  cursor: pointer;
  transition: color 0.2s;
}

.cam-tag.clickable:hover {
  color: #aaa;
}

.cam-tag.active {
  color: #4ECDC4;
  font-weight: 600;
}

.cam-tag.cam-online {
  color: #4CAF50;
}

.action-btns {
  display: flex;
  gap: 4px;
  margin-top: 6px;
}

.play-btn {
  flex: 1;
  background: #2a2a4a;
  color: #4ECDC4;
  border: 1px solid #4ECDC4;
  border-radius: 3px;
  padding: 3px 0;
  font-size: 11px;
  cursor: pointer;
  text-align: center;
}

.play-btn:hover {
  background: #4ECDC420;
}

.live-btn {
  flex: 0;
  background: #2a2a4a;
  color: #4CAF50;
  border: 1px solid #4CAF5060;
  border-radius: 3px;
  padding: 3px 8px;
  font-size: 11px;
  cursor: pointer;
  text-align: center;
}
.live-btn:hover {
  background: #4CAF5020;
  border-color: #4CAF50;
}

.history-btn {
  display: block;
  width: 100%;
  margin-top: 4px;
  background: transparent;
  color: #888;
  border: none;
  border-radius: 3px;
  padding: 2px 0;
  font-size: 10px;
  cursor: pointer;
  text-align: center;
}

.history-btn:hover { color: #4ECDC4; }

.action-row {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}

.action-row .history-btn {
  flex: 1;
  display: block;
  width: auto;
  margin-top: 0;
  background: transparent;
  color: #888;
  border: none;
  border-radius: 3px;
  padding: 2px 0;
  font-size: 10px;
  cursor: pointer;
  text-align: center;
}

.delete-btn {
  background: none;
  border: none;
  color: #666;
  cursor: pointer;
  font-size: 10px;
  padding: 2px 4px;
  border-radius: 3px;
}

.delete-btn:hover { color: #e74c3c; }

.delete-confirm-btn {
  background: #e74c3c;
  color: #fff;
  border: none;
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 10px;
  cursor: pointer;
}

.delete-cancel-btn {
  background: none;
  border: 1px solid #555;
  color: #888;
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 10px;
  cursor: pointer;
}

/* 迷你轨迹图 */
.trail-mini {
  margin-top: 6px;
}

.trail-svg {
  width: 100%;
  height: 80px;
  display: block;
  border-radius: 4px;
}

/* 活跃时段分布图 */
.activity-section {
  margin-top: 6px;
}

.activity-chart {
  display: flex;
  align-items: flex-end;
  gap: 1px;
  height: 40px;
  padding: 2px 0;
}

.activity-bar-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
}

.activity-bar {
  flex: 1;
  width: 100%;
  display: flex;
  flex-direction: column-reverse;
}

.activity-fill {
  width: 100%;
  background: #4ECDC4;
  border-radius: 1px;
  min-height: 1px;
  transition: height 0.3s;
}

.activity-label {
  font-size: 7px;
  color: #555;
  line-height: 1;
  margin-top: 2px;
}

.zone-stats {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.zone-stat-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}

.zone-stat-name {
  color: #26A69A;
  min-width: 40px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.zone-stat-detail {
  color: #888;
  white-space: nowrap;
  font-size: 10px;
}

.zone-stat-bar {
  flex: 1;
  height: 4px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 2px;
  overflow: hidden;
}

.zone-stat-fill {
  height: 100%;
  background: linear-gradient(90deg, #26A69A, #FF9800);
  border-radius: 2px;
  transition: width 0.3s;
}

.event-list {
  margin-top: 6px;
  border-top: 1px solid #2a2a4a;
  padding-top: 4px;
  max-height: 150px;
  overflow-y: auto;
}

.event-empty {
  color: #555;
  font-size: 11px;
  text-align: center;
  padding: 6px;
}

.event-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px;
  font-size: 10px;
  cursor: pointer;
  border-radius: 3px;
}

.event-type-tag {
  display: inline-block;
  padding: 1px 4px;
  border-radius: 2px;
  font-size: 9px;
  font-weight: 600;
  flex-shrink: 0;
}

.event-item:hover {
  background: #2a2a4a;
}

.event-time {
  color: #aaa;
  flex: 1;
}

.event-cam {
  color: #4ECDC4;
}

.event-play {
  background: none;
  border: none;
  color: #666;
  font-size: 10px;
  cursor: pointer;
  padding: 0 2px;
}

.event-play:hover { color: #4ECDC4; }

.merge-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.merge-dialog {
  background: #1a1a3a;
  border: 1px solid #4ECDC4;
  border-radius: 8px;
  padding: 20px;
  max-width: 340px;
  width: 90%;
}

.merge-text {
  color: #e0e0e0;
  font-size: 13px;
  margin: 0 0 8px;
}

.merge-hint {
  color: #888;
  font-size: 11px;
  margin: 0 0 16px;
}

.merge-actions {
  display: flex;
  gap: 8px;
}

.merge-yes-btn {
  background: #4ECDC4;
  color: #000;
  border: none;
  border-radius: 4px;
  padding: 6px 16px;
  font-size: 12px;
  cursor: pointer;
  font-weight: 600;
}

.merge-no-btn {
  background: #2a2a4a;
  color: #4ECDC4;
  border: 1px solid #4ECDC4;
  border-radius: 4px;
  padding: 6px 16px;
  font-size: 12px;
  cursor: pointer;
}

.merge-cancel-btn {
  background: none;
  color: #888;
  border: 1px solid #555;
  border-radius: 4px;
  padding: 6px 16px;
  font-size: 12px;
  cursor: pointer;
  margin-left: auto;
}

.snapshot-img {
  cursor: pointer;
  transition: transform 0.15s;
}

.snapshot-img:hover {
  transform: scale(1.05);
}

.preview-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  cursor: pointer;
}

.preview-img {
  max-width: 90vw;
  max-height: 85vh;
  border-radius: 8px;
  box-shadow: 0 0 40px rgba(0, 0, 0, 0.6);
}
</style>
