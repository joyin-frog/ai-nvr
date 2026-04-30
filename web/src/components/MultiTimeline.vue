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

const props = defineProps<{
  recordings: Recording[]
  cameras: CameraInfo[]
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
    <div class="mtl-tracks">
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
            :title="new Date(rec.startTime).toLocaleTimeString(locale)"
            @click="onSegClick($event, rec)"
          />
          <!-- 当前时间指示器 -->
          <div v-if="nowPosition >= 0" class="mtl-now" :style="{ left: nowPosition + '%' }" />
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

.mtl-now {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: #e74c3c;
  z-index: 2;
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
</style>
