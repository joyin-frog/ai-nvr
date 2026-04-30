<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { authFetch } from '../services/auth'

const { t } = useI18n()

/** 摄像头性能指标 */
interface CameraMetric {
  cameraId: string
  online: boolean
  fps: number
  lastFrameAt: number
  motionCount: number
  detectCount: number
  avgMotionRatio: number
}

/** 系统指标 */
interface SystemMetrics {
  uptime: number
  memoryUsedMb: number
  memoryRssMb: number
  cameraCount: number
  onlineCameras: number
  cameras: CameraMetric[]
  startedAt: number
  storage?: {
    directories: Array<{ name: string; bytes: number; fileCount: number }>
    totalBytes: number
    diskFreeBytes: number
    diskTotalBytes: number
  }
}

const props = defineProps<{
  cameras: Array<{ id: string; name: string; online: boolean }>
}>()

const metrics = ref<SystemMetrics | null>(null)
/** 今日事件统计 */
const todayStats = ref<{
  motionCount: number
  detectCount: number
  offlineCount: number
  alertCount: number
  byCamera: Array<{ cameraId: string; count: number }>
  byHour: Array<{ hour: number; count: number; type: string }>
} | null>(null)

/** 7天趋势数据 */
const weekStats = ref<Array<{ date: string; motion: number; detect: number; alert: number }>>([])

/** 图表时间范围 */
type ChartRange = 'today' | 'week'
const chartRange = ref<ChartRange>('today')

/** 小时趋势图数据：24 个桶，每个桶包含 motion 和 detect 计数 */
const hourlyChart = computed(() => {
  const buckets = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    motion: 0,
    detect: 0,
  }))
  if (!todayStats.value?.byHour) return buckets
  for (const item of todayStats.value.byHour) {
    const h = new Date(item.hour).getHours()
    if (h >= 0 && h < 24) {
      const bucket = buckets[h]!
      if (item.type === 'motion') bucket.motion = item.count
      else if (item.type === 'detect') bucket.detect = item.count
    }
  }
  return buckets
})

/** 7天趋势图最大值 */
const weekChartMax = computed(() => {
  let max = 0
  for (const d of weekStats.value) {
    max = Math.max(max, d.motion + d.detect + d.alert)
  }
  return max || 1
})

/** 环形图分段（SVG stroke-dasharray） */
const donutSegments = computed(() => {
  const ts = todayStats.value
  if (!ts) return { motion: '0 100', detect: '0 100', alert: '0 100', detectOffset: 25, alertOffset: 25 }
  const total = ts.motionCount + ts.detectCount + ts.alertCount
  if (total === 0) return { motion: '0 100', detect: '0 100', alert: '0 100', detectOffset: 25, alertOffset: 25 }
  const mPct = (ts.motionCount / total) * 100
  const dPct = (ts.detectCount / total) * 100
  const aPct = (ts.alertCount / total) * 100
  return {
    motion: `${mPct} ${100 - mPct}`,
    detect: `${dPct} ${100 - dPct}`,
    alert: `${aPct} ${100 - aPct}`,
    detectOffset: 25 - mPct,
    alertOffset: 25 - mPct - dPct,
  }
})

/** 趋势图最大值 */
const chartMax = computed(() => {
  let max = 0
  for (const b of hourlyChart.value) {
    max = Math.max(max, b.motion + b.detect)
  }
  return max || 1
})
let timer: ReturnType<typeof setInterval> | null = null
/** 今日统计刷新定时器 */
let statsTimer: ReturnType<typeof setInterval> | null = null

/** 摄像头 ID → 名称 */
const nameMap = () => {
  const map: Record<string, string> = {}
  for (const cam of props.cameras) {
    map[cam.id] = cam.name
  }
  return map
}

/** 格式化运行时长 */
function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return t('status.day', { d, h, m })
  if (h > 0) return t('status.hour', { h, m })
  return t('status.minute', { m })
}

/** 格式化字节数 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** 磁盘用量百分比 */
function diskUsagePercent(): number {
  if (!metrics.value?.storage) return 0
  const { diskTotalBytes, diskFreeBytes } = metrics.value.storage
  if (diskTotalBytes === 0) return 0
  return Math.round(((diskTotalBytes - diskFreeBytes) / diskTotalBytes) * 100)
}

/** 目录名称到 i18n key 的映射 */
const dirNameKeys: Record<string, string> = {
  recordings: 'status.dirRecordings',
  'detection-snapshots': 'status.dirDetectionSnapshots',
  snapshots: 'status.dirSnapshots',
  nvr: 'status.dirNvr',
  roi: 'status.dirRoi',
  alerts: 'status.dirAlerts',
  thumbnails: 'status.dirThumbnails',
}

/** 加载指标 */
async function loadMetrics() {
  try {
    const res = await authFetch('/api/health')
    if (res.ok) {
      metrics.value = await res.json()
    }
  } catch {
    // ignore
  }
}

/** 加载今日事件统计 */
async function loadTodayStats() {
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const since = startOfDay.getTime()
  try {
    const res = await authFetch(`/api/events/stats?since=${since}`)
    if (!res.ok) return
    const data = await res.json()
    const byType = data.byType as Record<string, number>
    todayStats.value = {
      motionCount: byType.motion ?? 0,
      detectCount: byType.detect ?? 0,
      offlineCount: (byType['camera:offline'] ?? 0) as number,
      alertCount: byType.alert ?? 0,
      byCamera: (data.byCamera as Array<{ camera_id: string; count: number }>).map(c => ({
        cameraId: c.camera_id,
        count: c.count,
      })),
      byHour: data.byHour as Array<{ hour: number; count: number; type: string }>,
    }
  } catch {
    // ignore
  }
}

/** 加载 7 天趋势数据 */
async function loadWeekStats() {
  const result: Array<{ date: string; motion: number; detect: number; alert: number }> = []
  const now = new Date()
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    d.setHours(0, 0, 0, 0)
    const since = d.getTime()
    const until = since + 86400000
    const dateStr = `${d.getMonth() + 1}/${d.getDate()}`
    try {
      const res = await authFetch(`/api/events/stats?since=${since}&until=${until}`)
      if (!res.ok) { result.push({ date: dateStr, motion: 0, detect: 0, alert: 0 }); continue }
      const data = await res.json()
      const byType = data.byType as Record<string, number>
      result.push({
        date: dateStr,
        motion: byType.motion ?? 0,
        detect: byType.detect ?? 0,
        alert: byType.alert ?? 0,
      })
    } catch {
      result.push({ date: dateStr, motion: 0, detect: 0, alert: 0 })
    }
  }
  weekStats.value = result
}

onMounted(() => {
  loadMetrics()
  loadTodayStats()
  loadWeekStats()
  timer = setInterval(loadMetrics, 5000)
  statsTimer = setInterval(loadTodayStats, 30000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
  if (statsTimer) clearInterval(statsTimer)
})
</script>

<template>
  <div class="status-panel">
    <div class="panel-header">{{ t('status.title') }}</div>

    <!-- 系统概览 -->
    <div v-if="metrics" class="system-overview">
      <div class="stat-row">
        <span class="stat-label">{{ t('status.uptime') }}</span>
        <span class="stat-value">{{ formatUptime(metrics.uptime) }}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">{{ t('status.memoryUsage') }}</span>
        <span class="stat-value">{{ metrics.memoryUsedMb }} MB</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">{{ t('status.cameras') }}</span>
        <span class="stat-value">
          <span class="online-count">{{ metrics.onlineCameras }}</span>
          <span class="dim"> / {{ metrics.cameraCount }}</span>
        </span>
      </div>
    </div>

    <!-- 今日统计 -->
    <div v-if="todayStats" class="today-stats">
      <div class="stats-title">{{ t('status.todayStats') }}</div>
      <div class="stats-grid">
        <div class="stat-card">
          <span class="stat-num motion">{{ todayStats.motionCount }}</span>
          <span class="stat-desc">{{ t('status.todayMotion') }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-num detect">{{ todayStats.detectCount }}</span>
          <span class="stat-desc">{{ t('status.todayDetect') }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-num alert">{{ todayStats.alertCount }}</span>
          <span class="stat-desc">{{ t('status.todayAlerts') }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-num offline">{{ todayStats.offlineCount }}</span>
          <span class="stat-desc">{{ t('status.todayOffline') }}</span>
        </div>
      </div>
      <!-- 事件类型分布环形图 -->
      <div v-if="todayStats.motionCount + todayStats.detectCount + todayStats.alertCount > 0" class="donut-section">
        <div class="donut-chart">
          <svg viewBox="0 0 36 36">
            <circle class="donut-ring" cx="18" cy="18" r="15.9" />
            <circle class="donut-segment motion-seg" cx="18" cy="18" r="15.9"
              :stroke-dasharray="donutSegments.motion" stroke-dashoffset="25" />
            <circle class="donut-segment detect-seg" cx="18" cy="18" r="15.9"
              :stroke-dasharray="donutSegments.detect" :stroke-dashoffset="donutSegments.detectOffset" />
            <circle class="donut-segment alert-seg" cx="18" cy="18" r="15.9"
              :stroke-dasharray="donutSegments.alert" :stroke-dashoffset="donutSegments.alertOffset" />
          </svg>
          <div class="donut-center">
            <span class="donut-total">{{ todayStats.motionCount + todayStats.detectCount + todayStats.alertCount }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 事件趋势图 -->
    <div class="chart-section">
      <div class="chart-header">
        <span class="stats-title" style="margin-bottom:0">{{ t('status.eventTrend') }}</span>
        <div class="range-tabs">
          <button :class="['range-btn', { active: chartRange === 'today' }]" @click="chartRange = 'today'">{{ t('status.today') }}</button>
          <button :class="['range-btn', { active: chartRange === 'week' }]" @click="chartRange = 'week'">7{{ t('status.days') }}</button>
        </div>
      </div>

      <!-- 今日 24h 趋势 -->
      <template v-if="chartRange === 'today' && todayStats">
        <div class="hourly-chart">
          <div v-for="b in hourlyChart" :key="b.hour" class="chart-bar-wrap" :title="`${b.hour}:00 — motion: ${b.motion} detect: ${b.detect}`">
            <div class="chart-bar">
              <div
                v-if="b.detect > 0"
                class="bar-segment detect"
                :style="{ height: (b.detect / chartMax * 100) + '%' }"
              />
              <div
                v-if="b.motion > 0"
                class="bar-segment motion"
                :style="{ height: (b.motion / chartMax * 100) + '%' }"
              />
            </div>
            <span class="bar-label">{{ b.hour }}</span>
          </div>
        </div>
        <div class="chart-legend">
          <span class="legend-item"><span class="legend-dot motion" />{{ t('event.motion') }}</span>
          <span class="legend-item"><span class="legend-dot detect" />{{ t('event.detect') }}</span>
        </div>
      </template>

      <!-- 7天趋势 -->
      <template v-if="chartRange === 'week'">
        <div class="hourly-chart">
          <div v-for="d in weekStats" :key="d.date" class="chart-bar-wrap" :title="`${d.date} — motion: ${d.motion} detect: ${d.detect} alert: ${d.alert}`">
            <div class="chart-bar">
              <div v-if="d.alert > 0" class="bar-segment alert" :style="{ height: (d.alert / weekChartMax * 100) + '%' }" />
              <div v-if="d.detect > 0" class="bar-segment detect" :style="{ height: (d.detect / weekChartMax * 100) + '%' }" />
              <div v-if="d.motion > 0" class="bar-segment motion" :style="{ height: (d.motion / weekChartMax * 100) + '%' }" />
            </div>
            <span class="bar-label">{{ d.date }}</span>
          </div>
        </div>
        <div class="chart-legend">
          <span class="legend-item"><span class="legend-dot motion" />{{ t('event.motion') }}</span>
          <span class="legend-item"><span class="legend-dot detect" />{{ t('event.detect') }}</span>
          <span class="legend-item"><span class="legend-dot alert-dot" />{{ t('event.alert') }}</span>
        </div>
      </template>
    </div>

    <!-- 存储用量 -->
    <div v-if="metrics?.storage" class="storage-section">
      <div class="stats-title">{{ t('status.storageUsage') }}</div>
      <!-- 磁盘总览 -->
      <div v-if="metrics.storage.diskTotalBytes > 0" class="disk-bar-wrap">
        <div class="disk-bar">
          <div
            class="disk-used"
            :style="{ width: diskUsagePercent() + '%' }"
            :class="{ warn: diskUsagePercent() > 80, critical: diskUsagePercent() > 95 }"
          />
        </div>
        <div class="disk-info">
          <span>{{ t('status.used') }} {{ diskUsagePercent() }}%</span>
          <span class="dim">{{ t('status.remaining') }} {{ formatBytes(metrics.storage.diskFreeBytes) }}</span>
        </div>
      </div>
      <!-- 各目录用量 -->
      <div class="dir-list">
        <div v-for="dir in metrics.storage.directories" :key="dir.name" class="dir-row">
          <span class="dir-name">{{ dirNameKeys[dir.name] ? t(dirNameKeys[dir.name]) : dir.name }}</span>
          <span class="dir-size">{{ formatBytes(dir.bytes) }}</span>
          <span class="dir-files">{{ dir.fileCount }} {{ t('status.files') }}</span>
        </div>
      </div>
    </div>

    <!-- 摄像头列表 -->
    <div class="camera-list">
      <div v-if="metrics" class="cameras">
        <div
          v-for="cam in metrics.cameras"
          :key="cam.cameraId"
          class="camera-card"
          :class="{ offline: !cam.online }"
        >
          <div class="cam-header">
            <span class="cam-dot" :class="{ online: cam.online }" />
            <span class="cam-name">{{ nameMap()[cam.cameraId] ?? cam.cameraId }}</span>
            <span class="cam-status">{{ cam.online ? t('status.online') : t('status.offline') }}</span>
          </div>
          <div class="cam-metrics">
            <div class="metric">
              <span class="metric-val">{{ cam.fps }}</span>
              <span class="metric-unit">fps</span>
            </div>
            <div class="metric">
              <span class="metric-val">{{ cam.motionCount }}</span>
              <span class="metric-unit">{{ t('status.todayMotion') }}</span>
            </div>
            <div class="metric">
              <span class="metric-val">{{ cam.detectCount }}</span>
              <span class="metric-unit">{{ t('status.todayDetect') }}</span>
            </div>
            <div v-if="todayStats" class="metric">
              <span class="metric-val">{{ todayStats.byCamera.find(c => c.cameraId === cam.cameraId)?.count ?? 0 }}</span>
              <span class="metric-unit">{{ t('status.todayEvents') }}</span>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="empty">{{ t('app.loading') }}</div>
    </div>
  </div>
</template>

<style scoped>
.status-panel {
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
}

.system-overview {
  padding: 10px 12px;
  border-bottom: 1px solid #2a2a4a;
}

.stat-row {
  display: flex;
  justify-content: space-between;
  padding: 3px 0;
  font-size: 13px;
}

.stat-label {
  color: #888;
}

.stat-value {
  color: #e0e0e0;
  font-weight: 500;
}

.online-count {
  color: #4CAF50;
  font-weight: 600;
}

.dim {
  color: #666;
}

.camera-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.cameras {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.camera-card {
  background: #16213e;
  border-radius: 6px;
  padding: 10px;
  border: 1px solid #2a2a4a;
}

.camera-card.offline {
  opacity: 0.5;
}

.cam-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.cam-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #F44336;
}

.cam-dot.online {
  background: #4CAF50;
}

.cam-name {
  font-size: 13px;
  font-weight: 600;
  color: #e0e0e0;
}

.cam-status {
  margin-left: auto;
  font-size: 11px;
  color: #888;
}

.cam-metrics {
  display: flex;
  gap: 12px;
}

.metric {
  display: flex;
  align-items: baseline;
  gap: 2px;
}

.metric-val {
  font-size: 14px;
  font-weight: 600;
  color: #4ECDC4;
}

.metric-unit {
  font-size: 11px;
  color: #888;
}

.empty {
  color: #555;
  text-align: center;
  padding: 20px;
  font-size: 13px;
}

/* 今日统计 */
.today-stats {
  padding: 8px 12px;
  border-bottom: 1px solid #2a2a4a;
}

.stats-title {
  font-size: 11px;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

/* 环形图 */
.donut-section {
  display: flex;
  justify-content: center;
  margin-top: 8px;
}

.donut-chart {
  position: relative;
  width: 80px;
  height: 80px;
}

.donut-chart svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}

.donut-ring {
  fill: none;
  stroke: #2a2a4a;
  stroke-width: 3;
}

.donut-segment {
  fill: none;
  stroke-width: 3;
  stroke-linecap: round;
}

.motion-seg { stroke: #FFEAA7; }
.detect-seg { stroke: #4ECDC4; }
.alert-seg { stroke: #F44336; }

.donut-center {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.donut-total {
  font-size: 16px;
  font-weight: 700;
  color: #e0e0e0;
}

/* 趋势范围切换 */
.chart-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.range-tabs {
  display: flex;
  gap: 2px;
  background: #0a0a1a;
  border-radius: 4px;
  padding: 1px;
}

.range-btn {
  background: transparent;
  border: none;
  color: #888;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 3px;
  cursor: pointer;
}

.range-btn.active {
  background: #2a2a4a;
  color: #4ECDC4;
  font-weight: 600;
}

.stat-card {
  background: #16213e;
  border-radius: 4px;
  padding: 6px 8px;
  text-align: center;
}

.stat-num {
  display: block;
  font-size: 18px;
  font-weight: 700;
}

.stat-num.motion {
  color: #FFEAA7;
}

.stat-num.detect {
  color: #4ECDC4;
}

.stat-num.alert {
  color: #F44336;
}

.stat-num.offline {
  color: #9B59B6;
}

.stat-desc {
  font-size: 11px;
  color: #666;
}

/* 存储用量 */
.storage-section {
  padding: 8px 12px;
  border-bottom: 1px solid #2a2a4a;
}

.disk-bar-wrap {
  margin-bottom: 8px;
}

.disk-bar {
  height: 6px;
  background: #0a0a1a;
  border-radius: 3px;
  overflow: hidden;
}

.disk-used {
  height: 100%;
  background: #4ECDC4;
  border-radius: 3px;
  transition: width 0.3s;
}

.disk-used.warn { background: #FFEAA7; }
.disk-used.critical { background: #e74c3c; }

.disk-info {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: #aaa;
  margin-top: 3px;
}

.dir-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dir-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 2px 0;
}

.dir-name {
  color: #ccc;
  flex: 1;
}

.dir-size {
  color: #4ECDC4;
  font-weight: 500;
}

.dir-files {
  color: #555;
  font-size: 11px;
}

/* 事件趋势图 */
.chart-section {
  padding: 8px 12px;
  border-bottom: 1px solid #2a2a4a;
}

.hourly-chart {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 80px;
  padding: 4px 0;
}

.chart-bar-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
  min-width: 0;
}

.chart-bar {
  flex: 1;
  width: 100%;
  display: flex;
  flex-direction: column-reverse;
  gap: 1px;
}

.bar-segment {
  width: 100%;
  border-radius: 1px;
  min-height: 1px;
  transition: height 0.3s;
}

.bar-segment.motion { background: #FFEAA7; }
.bar-segment.detect { background: #4ECDC4; }
.bar-segment.alert { background: #F44336; }

.bar-label {
  font-size: 8px;
  color: #555;
  line-height: 1;
  margin-top: 2px;
  flex-shrink: 0;
}

.chart-legend {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-top: 4px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: #888;
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.legend-dot.motion { background: #FFEAA7; }
.legend-dot.detect { background: #4ECDC4; }
.legend-dot.alert-dot { background: #F44336; }
</style>
