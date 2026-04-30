<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import EventTimeline from './EventTimeline.vue'
import { authFetch, authUrl } from '../services/auth'

const { t, locale } = useI18n()

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
  /** 原始 JSON detail（用于展开详情解析） */
  rawDetail: string | null
  /** 是否已收藏 */
  starred: boolean
  /** 是否为实时新增事件（用于入场动画） */
  isNew?: boolean
}

const events = ref<EventItem[]>([])
const PAGE_SIZE = 50
const loading = ref(false)
const hasMore = ref(false)
const filterType = ref('')
/** 摄像头筛选 */
const filterCamera = ref('')
/** 日期筛选（YYYY-MM-DD） */
const filterDate = ref('')
/** 搜索关键词 */
const filterSearch = ref('')
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

/** 当前子视图：'events' 事件列表 | 'gallery' 快照画廊 */
const subView = ref<'events' | 'gallery'>('events')

/** 快照数据 */
interface SnapshotInfo {
  filename: string
  cameraId: string
  timestamp: number
  size: number
}
const snapshotList = ref<SnapshotInfo[]>([])
const snapshotLoading = ref(false)
/** 快照筛选摄像头 */
const snapFilterCamera = ref('')
/** 选中放大查看的快照 URL */
const previewUrl = ref('')

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

/** 下载快照图片 */
function downloadSnapshot(snap: SnapshotInfo) {
  const link = document.createElement('a')
  link.href = snapThumbUrl(snap)
  link.download = snap.filename
  link.click()
}

/** 排序后的事件列表 */
const sortedEvents = computed(() => {
  if (sortDesc.value) return events.value
  return [...events.value].reverse()
})

const props = defineProps<{
  /** 每个摄像头的最新检测帧快照 */
  snapshots?: Record<string, string>
  /** 摄像头列表（用于筛选） */
  cameras?: Array<{ id: string; name: string }>
}>()

const emit = defineEmits<{
  (e: 'play-recording', cameraId: string, timestamp: number): void
}>()

/** 事件类型标签样式 */
const typeConfig: Record<string, { labelKey: string; bg: string; color: string }> = {
  motion: { labelKey: 'event.motion', bg: '#FFEAA7', color: '#333' },
  detect: { labelKey: 'event.detect', bg: '#4ECDC4', color: '#333' },
  'camera:online': { labelKey: 'event.online', bg: '#4CAF50', color: '#fff' },
  'camera:offline': { labelKey: 'event.offline', bg: '#F44336', color: '#fff' },
  alert: { labelKey: 'event.alert', bg: '#FFD93D', color: '#333' },
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
      recent.rawDetail = detail
      recent.time = new Date(now).toLocaleTimeString(locale.value)
      return
    }
  }

  const time = new Date(now).toLocaleTimeString(locale.value)
  events.value.unshift({ id: now, time, timestamp: now, type, cameraId, detail, rawDetail: detail, starred: false, isNew: true })
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

/** 格式化时间戳 */
function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString(locale.value)
}

/** 解析 detail JSON */
function parseDetail(type: string, detail: string | null): string {
  if (!detail) return ''
  try {
    const obj = JSON.parse(detail)
    if (type === 'motion' && obj.ratio) return t('event.motionRatio', { ratio: (obj.ratio * 100).toFixed(1) })
    if (type === 'detect' && obj.detections) {
      return obj.detections.map((d: { label: string; score: number }) => d.label).join(', ')
    }
    return detail
  } catch {
    return detail
  }
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
      const historyEvents: EventItem[] = (data.events as EventRecord[]).map((e) => ({
        id: e.id,
        time: formatTimestamp(e.timestamp),
        timestamp: e.timestamp,
        type: e.type,
        cameraId: e.camera_id,
        detail: parseDetail(e.type, e.detail),
        rawDetail: e.detail,
        starred: e.starred === 1,
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
      const moreEvents: EventItem[] = (data.events as EventRecord[]).map((e) => ({
        id: e.id,
        time: formatTimestamp(e.timestamp),
        timestamp: e.timestamp,
        type: e.type,
        cameraId: e.camera_id,
        detail: parseDetail(e.type, e.detail),
        rawDetail: e.detail,
        starred: e.starred === 1,
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

onMounted(() => {
  loadHistory()
})

/** 切换事件展开 */
function toggleExpand(id: number) {
  expandedId.value = expandedId.value === id ? null : id
}

/** 解析 rawDetail 为结构化信息 */
function parseExpandedDetail(e: EventItem): Array<{ label: string; value: string }> {
  if (!e.rawDetail) return []
  const items: Array<{ label: string; value: string }> = []
  try {
    const obj = JSON.parse(e.rawDetail)
    if (e.type === 'motion' && obj.ratio !== undefined) {
      items.push({ label: t('event.ratio'), value: `${(obj.ratio * 100).toFixed(1)}%` })
    }
    if (e.type === 'detect' && Array.isArray(obj.detections)) {
      for (const d of obj.detections as Array<{ label: string; score: number }>) {
        items.push({ label: d.label, value: `${(d.score * 100).toFixed(0)}%` })
      }
    }
    if (e.type === 'alert') {
      if (obj.ruleName) items.push({ label: t('event.rule'), value: obj.ruleName })
      if (obj.detail) items.push({ label: t('event.detail'), value: obj.detail })
    }
  } catch {
    if (e.rawDetail) items.push({ label: t('event.detail'), value: e.rawDetail })
  }
  return items
}

/** 导出当前筛选的事件为 CSV */
async function exportCsv() {
  loading.value = true
  try {
    const params = new URLSearchParams({ limit: '10000' })
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
    if (!res.ok) return
    const data = await res.json()
    const rows = (data.events as EventRecord[]).map((e) => {
      const time = new Date(e.timestamp).toISOString()
      const detail = (e.detail ?? '').replace(/"/g, '""')
      return `${e.id},"${time}","${e.type}","${e.camera_id}","${detail}"`
    })
    const header = 'id,time,type,camera_id,detail'
    const csv = [header, ...rows].join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    const dateStr = filterDate.value || new Date().toISOString().slice(0, 10)
    link.download = `events_${dateStr}.csv`
    link.click()
    URL.revokeObjectURL(url)
  } catch {
    // ignore
  } finally {
    loading.value = false
  }
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

defineExpose({ addEvent, loadHistory })
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
        @change="loadHistory"
        class="filter-search"
        :placeholder="t('event.searchPlaceholder')"
        :title="t('event.search')"
      />
      <select v-model="filterCamera" @change="loadHistory" class="filter-select">
        <option value="">{{ t('event.allCameras') }}</option>
        <option v-for="cam in cameras" :key="cam.id" :value="cam.id">{{ cam.name }}</option>
      </select>
      <select v-model="filterType" @change="loadHistory" class="filter-select">
        <option value="">{{ t('event.allTypesLabel') }}</option>
        <option value="motion">{{ t('event.motion') }}</option>
        <option value="detect">{{ t('event.detect') }}</option>
        <option value="camera:online">{{ t('event.online') }}</option>
        <option value="camera:offline">{{ t('event.offline') }}</option>
      </select>
      <button class="refresh-btn" @click="loadHistory" :disabled="loading">
        {{ t('event.refresh') }}
      </button>
      <button class="export-btn" @click="exportCsv" :disabled="loading" :title="t('event.exportCsv')">
        CSV
      </button>
      <button :class="['sort-btn', { desc: sortDesc }]" @click="sortDesc = !sortDesc" :title="sortDesc ? t('event.sortOldest') : t('event.sortNewest')">
        {{ sortDesc ? '↓' : '↑' }}
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
          <span class="event-cam">{{ cameras?.find(c => c.id === e.cameraId)?.name ?? e.cameraId }}</span>
          <img
            v-if="e.type === 'detect' && snapshots?.[e.cameraId]"
            :src="snapshots[e.cameraId]"
            class="event-thumb"
            alt=""
          />
          <span class="event-detail">{{ e.detail }}</span>
          <span class="expand-icon">{{ expandedId === e.id ? '▾' : '▸' }}</span>
          <button :class="['star-btn', { starred: e.starred }]" @click.stop="toggleStar(e.id)" :title="t('event.toggleStar')">
            {{ e.starred ? '★' : '☆' }}
          </button>
        </div>
        <!-- 展开详情 -->
        <div v-if="expandedId === e.id" class="event-expand">
          <img
            v-if="e.type === 'detect' && snapshots?.[e.cameraId]"
            :src="snapshots[e.cameraId]"
            class="expand-snapshot"
            alt=""
          />
          <div v-for="(item, i) in parseExpandedDetail(e)" :key="i" class="detail-row">
            <span class="detail-label">{{ item.label }}</span>
            <span class="detail-value">{{ item.value }}</span>
          </div>
          <div class="expand-actions">
            <button
              v-if="e.type === 'motion' || e.type === 'detect'"
              class="play-btn"
              @click.stop="emit('play-recording', e.cameraId, e.timestamp)"
            >{{ t('event.viewRecording') }}</button>
          </div>
        </div>
      </div>
      <div v-if="hasMore" class="load-more">
        <button class="load-more-btn" @click="loadMore" :disabled="loading">
          {{ loading ? t('app.loading') : t('event.loadMore') }}
        </button>
      </div>
    </div>

    <!-- 快照画廊视图 -->
    <div v-if="subView === 'gallery'" class="gallery-container">
      <div v-if="snapshotList.length === 0" class="empty">
        {{ snapshotLoading ? t('app.loading') : t('event.noSnapshots') }}
      </div>
      <div class="gallery-grid">
        <div
          v-for="snap in snapshotList"
          :key="snap.filename"
          class="gallery-item"
          @click="openSnapPreview(snap)"
        >
          <img :src="snapThumbUrl(snap)" class="gallery-thumb" alt="" loading="lazy" />
          <div class="gallery-meta">
            <span class="gallery-cam">{{ cameras?.find(c => c.id === snap.cameraId)?.name ?? snap.cameraId }}</span>
            <span class="gallery-time">{{ new Date(snap.timestamp).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 快照大图预览浮层 -->
    <div v-if="previewUrl" class="preview-overlay" @click.self="previewUrl = ''">
      <div class="preview-modal">
        <button class="preview-close" @click="previewUrl = ''">&times;</button>
        <img :src="previewUrl" class="preview-img" alt="" />
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

.event-detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
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

.expand-snapshot {
  max-width: 320px;
  border-radius: 4px;
  margin-bottom: 6px;
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
