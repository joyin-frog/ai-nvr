<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'

const { t, locale } = useI18n()

/** 录像片段 */
interface Recording {
  filename: string
  cameraId: string
  startTime: number
  endTime: number
  size: number
}

/** 摄像头信息 */
interface CameraInfo {
  id: string
  name: string
}

/** 时间轴上的事件标记 */
interface TimelineEvent {
  timestamp: number
  type: string
  label?: string
  cameraId?: string
}

/** 事件类型对应颜色 */
const EVENT_MARKER_COLORS: Record<string, string> = {
  detect: '#5bc0de',
  motion: '#f0ad4e',
  alert: '#d9534f',
  'camera:offline': '#d9534f',
  'llm:scene': '#7E57C2',
  'llm:summary': '#5C6BC0',
  'llm:patrol': '#26A69A',
}

const props = defineProps<{
  recordings: Recording[]
  cameras: CameraInfo[]
  /** 当前播放位置（绝对时间戳 ms，0 表示未播放） */
  playbackTime?: number
  /** 当前播放的摄像头 ID */
  playbackCameraId?: string
  /** 事件标记列表（按摄像头） */
  events?: TimelineEvent[]
}>()

const emit = defineEmits<{
  play: [recording: Recording, seekToSec?: number]
}>()

/** 视图模式 */
const viewMode = ref<'day' | 'hour'>('day')
const selectedDate = ref(new Date().toISOString().slice(0, 10))
const selectedHour = ref(new Date().getHours())

/** 当前时间 */
const now = ref(Date.now())
let refreshTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  refreshTimer = setInterval(() => { now.value = Date.now() }, 60_000)
})
onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})

/** 按摄像头分组的录像 */
const recordingsByCamera = computed(() => {
  const map = new Map<string, Recording[]>()
  for (const rec of props.recordings) {
    const list = map.get(rec.cameraId) ?? []
    list.push(rec)
    map.set(rec.cameraId, list)
  }
  return map
})

/** 显示的摄像头列表（只有有录像的） */
const cameraRows = computed(() => {
  return props.cameras.filter(c => recordingsByCamera.value.has(c.id))
})

/** 时间轴范围 */
const timeRange = computed(() => {
  if (viewMode.value === 'day') {
    const date = new Date(selectedDate.value + 'T00:00:00')
    const start = date.getTime()
    return { start, end: start + 86_400_000 }
  }
  const date = new Date(selectedDate.value + 'T00:00:00')
  const start = date.getTime() + selectedHour.value * 3_600_000
  return { start, end: start + 3_600_000 }
})

/** 刻度标签 */
const tickLabels = computed(() => {
  const { start, end } = timeRange.value
  const labels: Array<{ label: string; position: number }> = []
  const duration = end - start

  if (viewMode.value === 'day') {
    for (let h = 0; h <= 24; h += 3) {
      const t = start + h * 3_600_000
      if (t > end) break
      labels.push({ label: `${h}:00`, position: ((t - start) / duration) * 100 })
    }
  } else {
    for (let m = 0; m <= 60; m += 10) {
      const t = start + m * 60_000
      if (t > end) break
      labels.push({ label: `${m}m`, position: ((t - start) / duration) * 100 })
    }
  }
  return labels
})

/** 当前时间指示器位置 */
const nowPosition = computed(() => {
  const { start, end } = timeRange.value
  if (now.value < start || now.value > end) return -1
  return ((now.value - start) / (end - start)) * 100
})

/** 播放位置指示器 */
const playbackPosition = computed(() => {
  if (!props.playbackTime) return -1
  const { start, end } = timeRange.value
  if (props.playbackTime < start || props.playbackTime > end) return -1
  return ((props.playbackTime - start) / (end - start)) * 100
})

/** 按摄像头分组的事件标记 */
const eventMarkersByCamera = computed(() => {
  const evts = props.events
  if (!evts || evts.length === 0) return new Map<string, Array<{ position: number; color: string; count: number; labels: string; timestamp: number }>>()

  const { start, end } = timeRange.value
  const duration = end - start
  const minGap = duration * 0.005

  const byCam = new Map<string, TimelineEvent[]>()
  for (const evt of evts) {
    if (evt.timestamp < start || evt.timestamp > end) continue
    const camId = evt.cameraId ?? ''
    const list = byCam.get(camId) ?? []
    list.push(evt)
    byCam.set(camId, list)
  }

  const result = new Map<string, Array<{ position: number; color: string; count: number; labels: string; timestamp: number }>>()
  for (const [camId, camEvts] of byCam) {
    camEvts.sort((a, b) => a.timestamp - b.timestamp)
    const groups: Array<{ timestamp: number; types: Set<string>; labels: string[] }> = []
    for (const evt of camEvts) {
      const last = groups[groups.length - 1]
      if (last && evt.timestamp - last.timestamp < minGap) {
        last.types.add(evt.type)
        if (evt.label) last.labels.push(evt.label)
      } else {
        groups.push({ timestamp: evt.timestamp, types: new Set([evt.type]), labels: evt.label ? [evt.label] : [] })
      }
    }
    result.set(camId, groups.map(g => {
      let primaryType = 'motion'
      if (g.types.has('alert')) primaryType = 'alert'
      else if (g.types.has('detect')) primaryType = 'detect'
      return {
        position: ((g.timestamp - start) / duration) * 100,
        color: EVENT_MARKER_COLORS[primaryType] ?? '#888',
        count: g.labels.length || g.types.size,
        labels: [...new Set(g.labels)].slice(0, 3).join(', '),
        timestamp: g.timestamp,
      }
    }))
  }
  return result
})

/** 筛选日期范围内的录像 */
function filterByRange(recs: Recording[]) {
  const { start, end } = timeRange.value
  return recs.filter(r => {
    const date = new Date(r.startTime).toISOString().slice(0, 10)
    if (date !== selectedDate.value) return false
    if (viewMode.value === 'hour') {
      const hour = new Date(r.startTime).getHours()
      if (hour !== selectedHour.value) return false
    }
    return r.startTime < end && r.endTime > start
  })
}

/** 计算片段位置 */
function segmentStyle(rec: Recording) {
  const { start, end } = timeRange.value
  const duration = end - start
  const segStart = Math.max(0, (rec.startTime - start) / duration) * 100
  const segEnd = Math.min(1, (rec.endTime - start) / duration) * 100
  return {
    left: `${segStart}%`,
    width: `${Math.max(0.5, segEnd - segStart)}%`,
  }
}

/** 日期标签 */
const dateLabel = computed(() => {
  if (viewMode.value === 'day') {
    return new Date(selectedDate.value + 'T00:00:00').toLocaleDateString(locale.value, { month: 'long', day: 'numeric' })
  }
  return `${selectedHour.value}:00 - ${selectedHour.value}:59`
})

/** 可用日期列表 */
const availableDates = computed(() => {
  const dates = new Set<string>()
  for (const rec of props.recordings) {
    dates.add(new Date(rec.startTime).toISOString().slice(0, 10))
  }
  dates.add(new Date().toISOString().slice(0, 10))
  return [...dates].sort().reverse()
})

/** 总片段数 */
const totalSegments = computed(() => {
  let count = 0
  for (const recs of recordingsByCamera.value.values()) {
    count += filterByRange(recs).length
  }
  return count
})

function prevPeriod() {
  if (viewMode.value === 'day') {
    const d = new Date(selectedDate.value + 'T00:00:00')
    d.setDate(d.getDate() - 1)
    selectedDate.value = d.toISOString().slice(0, 10)
  } else {
    if (selectedHour.value > 0) {
      selectedHour.value--
    } else {
      selectedHour.value = 23
      const d = new Date(selectedDate.value + 'T00:00:00')
      d.setDate(d.getDate() - 1)
      selectedDate.value = d.toISOString().slice(0, 10)
    }
  }
}

function nextPeriod() {
  if (viewMode.value === 'day') {
    const d = new Date(selectedDate.value + 'T00:00:00')
    d.setDate(d.getDate() + 1)
    selectedDate.value = d.toISOString().slice(0, 10)
  } else {
    if (selectedHour.value < 23) {
      selectedHour.value++
    } else {
      selectedHour.value = 0
      const d = new Date(selectedDate.value + 'T00:00:00')
      d.setDate(d.getDate() + 1)
      selectedDate.value = d.toISOString().slice(0, 10)
    }
  }
}

function goToday() {
  selectedDate.value = new Date().toISOString().slice(0, 10)
  selectedHour.value = new Date().getHours()
}

/** 点击片段：计算点击位置对应的播放偏移 */
function onSegClick(e: MouseEvent, rec: Recording) {
  const target = e.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  const offsetSec = Math.max(0, (pct * (rec.endTime - rec.startTime)) / 1000)
  emit('play', rec, offsetSec)
}

/** 点击事件标记：跳转到对应时间的录像 */
function onEventMarkerClick(cameraId: string, timestamp: number) {
  const camRecs = filterByRange(recordingsByCamera.value.get(cameraId) ?? [])
  const match = camRecs.find(r => r.startTime <= timestamp && r.endTime >= timestamp)
  if (match) {
    const offsetSec = Math.max(0, (timestamp - match.startTime) / 1000)
    emit('play', match, offsetSec)
  }
}

/** 缩略图 tooltip 状态 */
const thumbTooltip = ref<{
  x: number
  y: number
  url: string
  time: string
} | null>(null)

/** 片段悬停：显示缩略图 */
function onSegEnter(e: MouseEvent, rec: Recording) {
  const dur = Math.max(0, (rec.endTime - rec.startTime) / 1000 / 2)
  thumbTooltip.value = {
    x: e.clientX,
    y: e.clientY,
    url: `/api/recordings/thumb?file=${encodeURIComponent(rec.filename)}&time=${dur.toFixed(1)}`,
    time: new Date(rec.startTime).toLocaleTimeString(locale.value),
  }
}

function onSegMove(e: MouseEvent) {
  if (!thumbTooltip.value) return
  thumbTooltip.value = { ...thumbTooltip.value, x: e.clientX, y: e.clientY }
}

function onSegLeave() {
  thumbTooltip.value = null
}

/** 鼠标滚轮缩放时间范围 */
function onTracksWheel(e: WheelEvent) {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()

  /** 获取 tracks 容器的边界，计算鼠标在时间轴上的位置百分比 */
  const target = e.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))

  if (e.deltaY < 0) {
    /** 放大：day → hour（根据鼠标位置定位到对应小时） */
    if (viewMode.value === 'day') {
      const { start, end } = timeRange.value
      const mouseTime = start + pct * (end - start)
      const hour = new Date(mouseTime).getHours()
      selectedHour.value = hour
      viewMode.value = 'hour'
    }
  } else {
    /** 缩小：hour → day */
    if (viewMode.value === 'hour') {
      viewMode.value = 'day'
    }
  }
}
</script>

<template>
  <div class="multi-timeline">
    <!-- 控制栏 -->
    <div class="mtl-controls">
      <button class="nav-btn" @click="prevPeriod">&#9664;</button>
      <span class="date-label">{{ dateLabel }}</span>
      <button class="nav-btn" @click="nextPeriod">&#9654;</button>
      <button class="mode-btn" @click="viewMode = viewMode === 'day' ? 'hour' : 'day'">
        {{ viewMode === 'day' ? '24h' : '1h' }}
      </button>
      <button class="today-btn" @click="goToday">{{ t('timeline.now') }}</button>
      <span class="count-badge">{{ totalSegments }} {{ t('timeline.segments') }} · {{ cameraRows.length }} {{ t('timeline.tracks') }}</span>
    </div>

    <!-- 时间刻度 -->
    <div class="mtl-ticks">
      <div class="mtl-label-col"></div>
      <div class="mtl-ticks-bar">
        <div v-for="tick in tickLabels" :key="tick.label" class="tick" :style="{ left: tick.position + '%' }">
          <span class="tick-label">{{ tick.label }}</span>
        </div>
      </div>
    </div>

    <!-- 多轨道区域 -->
    <div class="mtl-tracks" @wheel="onTracksWheel">
      <div v-for="cam in cameraRows" :key="cam.id" class="mtl-row">
        <div class="mtl-label-col">
          <span class="cam-name">{{ cam.name }}</span>
        </div>
        <div class="mtl-track">
          <div
            v-for="rec in filterByRange(recordingsByCamera.get(cam.id) ?? [])"
            :key="rec.filename"
            class="mtl-segment"
            :style="segmentStyle(rec)"
            @click="onSegClick($event, rec)"
            @mouseenter="onSegEnter($event, rec)"
            @mousemove="onSegMove"
            @mouseleave="onSegLeave"
          />
          <!-- 事件标记 -->
          <template v-for="(m, mi) in eventMarkersByCamera.get(cam.id) ?? []" :key="'e'+mi">
            <div class="mtl-event-marker" :style="{ left: m.position + '%' }" :title="m.labels || t('event.event')" @click.stop="onEventMarkerClick(cam.id, m.timestamp)">
              <div class="mtl-event-dot" :style="{ background: m.color }"></div>
            </div>
          </template>
          <!-- 当前时间指示器 -->
          <div v-if="nowPosition >= 0" class="mtl-now" :style="{ left: nowPosition + '%' }" />
          <!-- 播放位置指示器（仅当前播放的摄像头轨道） -->
          <div v-if="playbackPosition >= 0 && cam.id === playbackCameraId" class="mtl-playback" :style="{ left: playbackPosition + '%' }" />
        </div>
      </div>
      <div v-if="cameraRows.length === 0" class="mtl-empty">
        {{ t('timeline.noRecordingsInRange') }}
      </div>
    </div>

    <!-- 日期快速选择 -->
    <div v-if="availableDates.length > 1" class="mtl-dates">
      <button
        v-for="date in availableDates.slice(0, 7)"
        :key="date"
        :class="['date-tab', { active: date === selectedDate }]"
        @click="selectedDate = date"
      >
        {{ new Date(date + 'T00:00:00').toLocaleDateString(locale, { day: 'numeric', weekday: 'short' }) }}
      </button>
    </div>

    <!-- 缩略图 tooltip -->
    <div v-if="thumbTooltip" class="mtl-thumb-tooltip" :style="{ left: thumbTooltip.x + 'px', top: (thumbTooltip.y - 120) + 'px' }">
      <img :src="thumbTooltip.url" alt="" class="mtl-thumb-img" />
      <span class="mtl-thumb-time">{{ thumbTooltip.time }}</span>
    </div>
  </div>
</template>

<style scoped>
.multi-timeline {
  background: #16213e;
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 8px;
}

.mtl-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.nav-btn {
  background: #2a2a4a;
  color: #e0e0e0;
  border: none;
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 10px;
  cursor: pointer;
}

.nav-btn:hover { background: #3a3a5a; }

.date-label {
  font-size: 12px;
  color: #e0e0e0;
  font-weight: 500;
  min-width: 100px;
  text-align: center;
}

.mode-btn {
  margin-left: auto;
  background: #2a2a4a;
  color: #4ECDC4;
  border: 1px solid #4ECDC4;
  border-radius: 3px;
  padding: 1px 8px;
  font-size: 11px;
  cursor: pointer;
}

.mode-btn:hover { background: #4ECDC420; }

.today-btn {
  background: #4ECDC4;
  color: #1a1a2e;
  border: none;
  border-radius: 3px;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.today-btn:hover { background: #3ad4c8; }

.count-badge { font-size: 11px; color: #888; }

/* 时间刻度 */
.mtl-ticks {
  display: flex;
  margin-bottom: 4px;
}

.mtl-label-col {
  width: 72px;
  flex-shrink: 0;
}

.mtl-ticks-bar {
  flex: 1;
  position: relative;
  height: 14px;
}

.tick {
  position: absolute;
  top: 0;
}

.tick-label {
  font-size: 9px;
  color: #555;
  transform: translateX(-50%);
  white-space: nowrap;
}

/* 多轨道 */
.mtl-tracks {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mtl-row {
  display: flex;
  align-items: center;
}

.mtl-label-col {
  width: 72px;
  flex-shrink: 0;
  padding-right: 6px;
  overflow: hidden;
}

.cam-name {
  font-size: 11px;
  color: #aaa;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mtl-track {
  flex: 1;
  height: 18px;
  background: #0a0a1a;
  border-radius: 3px;
  position: relative;
  overflow: hidden;
}

.mtl-segment {
  position: absolute;
  top: 2px;
  bottom: 2px;
  min-width: 2px;
  background: #4ECDC4;
  border-radius: 2px;
  opacity: 0.8;
  cursor: pointer;
  transition: opacity 0.15s;
}

.mtl-segment:hover {
  opacity: 1;
  background: #5EEEE6;
}

/* 事件标记 */
.mtl-event-marker {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  transform: translateX(-50%);
  pointer-events: auto;
  cursor: pointer;
}

.mtl-event-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  opacity: 0.9;
}

.mtl-event-marker:hover .mtl-event-dot {
  opacity: 1;
  transform: scale(1.5);
}

.mtl-now {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: #e74c3c;
  z-index: 2;
}

.mtl-playback {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 2px;
  background: #FFD93D;
  z-index: 3;
  border-radius: 1px;
}

.mtl-empty {
  color: #555;
  text-align: center;
  padding: 12px;
  font-size: 12px;
}

/* 日期选择 */
.mtl-dates {
  display: flex;
  gap: 4px;
  margin-top: 6px;
  overflow-x: auto;
}

.date-tab {
  background: #2a2a4a;
  color: #888;
  border: none;
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 10px;
  cursor: pointer;
  white-space: nowrap;
}

.date-tab:hover { color: #e0e0e0; }

.date-tab.active {
  background: #4ECDC4;
  color: #1a1a2e;
  font-weight: 600;
}

/* 缩略图 tooltip */
.mtl-thumb-tooltip {
  position: fixed;
  z-index: 100;
  background: #1a1a2e;
  border: 1px solid #333;
  border-radius: 4px;
  padding: 4px;
  pointer-events: none;
  box-shadow: 0 4px 12px rgba(0,0,0,0.5);
}

.mtl-thumb-img {
  display: block;
  width: 192px;
  height: 108px;
  object-fit: cover;
  border-radius: 2px;
  background: #0a0a1a;
}

.mtl-thumb-time {
  display: block;
  text-align: center;
  font-size: 10px;
  color: #aaa;
  margin-top: 2px;
}
</style>
