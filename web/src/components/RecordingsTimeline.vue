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

const props = defineProps<{
  /** 录像列表 */
  recordings: Recording[]
  /** 当前选中的摄像头（空=全部） */
  selectedCamera: string
  /** 当前播放位置（绝对时间戳 ms，0 表示未播放） */
  playbackTime?: number
}>()

const emit = defineEmits<{
  /** 点击录像片段，可选跳转偏移（秒） */
  play: [recording: Recording, seekToSec?: number]
}>()

/** 时间轴容器引用 */
const timelineEl = ref<HTMLDivElement | null>(null)

/** tooltip 状态 */
const tooltip = ref<{ x: number; y: number; url: string; time: string } | null>(null)

/** 视图模式：小时/全天 */
const viewMode = ref<'hour' | 'day'>('hour')

/** 当前选中日期（YYYY-MM-DD） */
const selectedDate = ref(new Date().toISOString().slice(0, 10))

/** 当前选中小时（0-23，hour 模式下使用） */
const selectedHour = ref(new Date().getHours())

/** 时间轴刷新定时器 */
let refreshTimer: ReturnType<typeof setInterval> | null = null

/** 当前时间指示器（每分钟更新） */
const now = ref(Date.now())

onMounted(() => {
  refreshTimer = setInterval(() => { now.value = Date.now() }, 60_000)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})

/** 可用日期列表（从录像中提取） */
const availableDates = computed(() => {
  const dates = new Set<string>()
  for (const rec of props.recordings) {
    dates.add(new Date(rec.startTime).toISOString().slice(0, 10))
  }
  /** 确保今天在列表中 */
  dates.add(new Date().toISOString().slice(0, 10))
  return [...dates].sort().reverse()
})

/** 筛选后的录像片段 */
const filteredRecordings = computed(() => {
  let recs = props.recordings

  /** 按摄像头筛选 */
  if (props.selectedCamera) {
    recs = recs.filter(r => r.cameraId === props.selectedCamera)
  }

  /** 按日期筛选 */
  recs = recs.filter(r => {
    const date = new Date(r.startTime).toISOString().slice(0, 10)
    return date === selectedDate.value
  })

  /** 按小时筛选（hour 模式） */
  if (viewMode.value === 'hour') {
    recs = recs.filter(r => {
      const hour = new Date(r.startTime).getHours()
      return hour === selectedHour.value
    })
  }

  return recs
})

/** 时间轴范围 */
const timeRange = computed(() => {
  if (viewMode.value === 'day') {
    const date = new Date(selectedDate.value + 'T00:00:00')
    const start = date.getTime()
    return { start, end: start + 86_400_000 }
  }
  /** hour 模式：1小时 */
  const date = new Date(selectedDate.value + 'T00:00:00')
  const start = date.getTime() + selectedHour.value * 3_600_000
  return { start, end: start + 3_600_000 }
})

/** 时间轴刻度标签 */
const tickLabels = computed(() => {
  const { start, end } = timeRange.value
  const labels: Array<{ label: string; position: number }> = []
  const duration = end - start

  if (viewMode.value === 'day') {
    /** 全天模式：每3小时一个刻度 */
    for (let h = 0; h <= 24; h += 3) {
      const t = start + h * 3_600_000
      if (t > end) break
      labels.push({ label: `${h}:00`, position: ((t - start) / duration) * 100 })
    }
  } else {
    /** 小时模式：每10分钟一个刻度 */
    for (let m = 0; m <= 60; m += 10) {
      const t = start + m * 60_000
      if (t > end) break
      labels.push({ label: `${m}m`, position: ((t - start) / duration) * 100 })
    }
  }
  return labels
})

/** 录像片段在时间轴上的位置 */
const segments = computed(() => {
  const { start, end } = timeRange.value
  const duration = end - start

  return filteredRecordings.value.map(rec => {
    const segStart = Math.max(0, (rec.startTime - start) / duration) * 100
    const segEnd = Math.min(1, (rec.endTime - start) / duration) * 100
    return {
      recording: rec,
      left: `${segStart}%`,
      width: `${Math.max(0.5, segEnd - segStart)}%`,
    }
  })
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

/** 切换到上/下一个时间段 */
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
      prevPeriod()
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
      nextPeriod()
    }
  }
}

/** 点击时间轴空白区域：定位到对应时间 */
function onTimelineClick(e: MouseEvent) {
  if (!timelineEl.value) return
  const rect = timelineEl.value.getBoundingClientRect()
  const pct = (e.clientX - rect.left) / rect.width
  const { start, end } = timeRange.value
  const clickTime = start + pct * (end - start)

  /** 找到最近的录像片段 */
  let closest: Recording | null = null
  let closestDist = Infinity
  for (const rec of filteredRecordings.value) {
    const mid = (rec.startTime + rec.endTime) / 2
    const dist = Math.abs(mid - clickTime)
    if (dist < closestDist) {
      closestDist = dist
      closest = rec
    }
  }
  if (closest) {
    const offsetSec = Math.max(0, (clickTime - closest.startTime) / 1000)
    emit('play', closest, offsetSec)
  }
}

/** 点击录像片段：计算点击位置对应的播放偏移 */
function onSegmentClick(e: MouseEvent, rec: Recording) {
  const target = e.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  const offsetSec = Math.max(0, (pct * (rec.endTime - rec.startTime)) / 1000)
  emit('play', rec, offsetSec)
}

/** 片段悬停：显示缩略图 tooltip */
function onSegmentEnter(e: MouseEvent, rec: Recording) {
  const dur = Math.max(0, (rec.endTime - rec.startTime) / 1000 / 2)
  tooltip.value = {
    x: e.clientX,
    y: e.clientY,
    url: `/api/recordings/thumb?file=${encodeURIComponent(rec.filename)}&time=${dur.toFixed(1)}`,
    time: new Date(rec.startTime).toLocaleTimeString(locale.value),
  }
}

function onSegmentMove(e: MouseEvent) {
  if (!tooltip.value) return
  tooltip.value = { ...tooltip.value, x: e.clientX, y: e.clientY }
}

function onSegmentLeave() {
  tooltip.value = null
}

/** 格式化日期标签 */
const dateLabel = computed(() => {
  if (viewMode.value === 'day') {
    return new Date(selectedDate.value + 'T00:00:00').toLocaleDateString(locale.value, { month: 'long', day: 'numeric' })
  }
  return `${selectedHour.value}:00 - ${selectedHour.value}:59`
})

/** 跳转到今天 */
function goToday() {
  selectedDate.value = new Date().toISOString().slice(0, 10)
  selectedHour.value = new Date().getHours()
}
</script>

<template>
  <div class="timeline-container">
    <!-- 控制栏 -->
    <div class="timeline-controls">
      <button class="nav-btn" @click="prevPeriod">&#9664;</button>
      <span class="date-label">{{ dateLabel }}</span>
      <button class="nav-btn" @click="nextPeriod">&#9654;</button>
      <button class="mode-btn" @click="viewMode = viewMode === 'day' ? 'hour' : 'day'">
        {{ viewMode === 'day' ? '24h' : '1h' }}
      </button>
      <button class="today-btn" @click="goToday">{{ t('timeline.now') }}</button>
      <span class="count-badge">{{ filteredRecordings.length }} {{ t('timeline.segments') }}</span>
    </div>

    <!-- 时间轴 -->
    <div class="timeline-bar" ref="timelineEl" @click="onTimelineClick">
      <!-- 刻度标签 -->
      <div class="ticks">
        <div v-for="tick in tickLabels" :key="tick.label" class="tick" :style="{ left: tick.position + '%' }">
          <span class="tick-label">{{ tick.label }}</span>
          <div class="tick-line"></div>
        </div>
      </div>

      <!-- 录像片段 -->
      <div class="segments">
        <div
          v-for="(seg, i) in segments"
          :key="i"
          class="segment"
          :style="{ left: seg.left, width: seg.width }"
          @click.stop="onSegmentClick($event, seg.recording)"
          @mouseenter="onSegmentEnter($event, seg.recording)"
          @mousemove="onSegmentMove"
          @mouseleave="onSegmentLeave"
        />
      </div>

      <!-- 当前时间指示器 -->
      <div v-if="nowPosition >= 0" class="now-indicator" :style="{ left: nowPosition + '%' }">
        <div class="now-dot"></div>
        <div class="now-line"></div>
      </div>

      <!-- 播放位置指示器 -->
      <div v-if="playbackPosition >= 0" class="playback-indicator" :style="{ left: playbackPosition + '%' }">
        <div class="playback-dot"></div>
        <div class="playback-line"></div>
      </div>
    </div>

    <!-- 日期快速选择 -->
    <div v-if="availableDates.length > 1" class="date-tabs">
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
  <!-- 缩略图 tooltip -->
  <Teleport to="body">
    <div v-if="tooltip" class="thumb-tooltip" :style="{ left: tooltip.x + 'px', top: (tooltip.y - 120) + 'px' }">
      <img :src="tooltip.url" alt="" class="tooltip-img" />
      <span class="tooltip-time">{{ tooltip.time }}</span>
    </div>
  </Teleport>
</template>

<style scoped>
.timeline-container {
  padding: 8px 12px;
  border-bottom: 1px solid #2a2a4a;
  background: #16213e;
}

.timeline-controls {
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
  line-height: 1;
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

.count-badge {
  font-size: 11px;
  color: #888;
}

/* 时间轴条 */
.timeline-bar {
  position: relative;
  height: 28px;
  background: #0a0a1a;
  border-radius: 4px;
  overflow: hidden;
  cursor: pointer;
}

.ticks {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.tick {
  position: absolute;
  top: 0;
  height: 100%;
}

.tick-label {
  position: absolute;
  top: 1px;
  font-size: 9px;
  color: #555;
  transform: translateX(-50%);
  white-space: nowrap;
}

.tick-line {
  position: absolute;
  top: 12px;
  bottom: 0;
  left: 50%;
  width: 1px;
  background: #222;
}

.segments {
  position: absolute;
  top: 14px;
  bottom: 2px;
  left: 0;
  right: 0;
}

.segment {
  position: absolute;
  top: 0;
  height: 100%;
  min-width: 2px;
  background: #4ECDC4;
  border-radius: 2px;
  opacity: 0.8;
  cursor: pointer;
  transition: opacity 0.15s;
}

.segment:hover {
  opacity: 1;
  background: #5EEEE6;
}

/* 当前时间指示器 */
.now-indicator {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 2;
  pointer-events: none;
}

.now-dot {
  width: 6px;
  height: 6px;
  background: #e74c3c;
  border-radius: 50%;
  position: absolute;
  top: 8px;
  left: -3px;
}

.now-line {
  position: absolute;
  top: 14px;
  bottom: 0;
  left: 0;
  width: 1px;
  background: #e74c3c;
}

/* 播放位置指示器 */
.playback-indicator {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 3;
  pointer-events: none;
}

.playback-dot {
  width: 8px;
  height: 8px;
  background: #FFD93D;
  border-radius: 50%;
  position: absolute;
  top: 7px;
  left: -4px;
}

.playback-line {
  position: absolute;
  top: 14px;
  bottom: 0;
  left: 0;
  width: 2px;
  background: #FFD93D;
}

/* 日期快速选择 */
.date-tabs {
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
.thumb-tooltip {
  position: fixed;
  z-index: 2000;
  pointer-events: none;
  background: #1a1a2e;
  border: 1px solid #2a2a4a;
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
  transform: translateX(-50%);
}

.tooltip-img {
  width: 192px;
  height: 108px;
  object-fit: cover;
  display: block;
  background: #0a0a1a;
}

.tooltip-time {
  display: block;
  text-align: center;
  font-size: 10px;
  color: #aaa;
  padding: 2px 0 3px;
  background: #16213e;
}
</style>
