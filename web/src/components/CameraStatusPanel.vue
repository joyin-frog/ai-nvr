<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

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
const todayStats = ref<{ motionCount: number; detectCount: number; onlineCount: number; offlineCount: number; topLabels: string[] } | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

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
  if (d > 0) return `${d}天${h}时${m}分`
  if (h > 0) return `${h}时${m}分`
  return `${m}分`
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

/** 目录友好名称映射 */
const dirNames: Record<string, string> = {
  recordings: '录像',
  'detection-snapshots': '检测快照',
  snapshots: '帧快照',
  nvr: '事件数据库',
  roi: 'ROI 数据库',
  alerts: '告警数据库',
  thumbnails: '缩略图缓存',
}

/** 加载指标 */
async function loadMetrics() {
  try {
    const res = await fetch('/api/health')
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
    const [motionRes, detectRes] = await Promise.all([
      fetch(`/api/events/history?type=motion&since=${since}&limit=1`),
      fetch(`/api/events/history?type=detect&since=${since}&limit=1`),
    ])
    const motionData = motionRes.ok ? await motionRes.json() : { total: 0 }
    const detectData = detectRes.ok ? await detectRes.json() : { total: 0 }
    todayStats.value = {
      motionCount: motionData.total ?? 0,
      detectCount: detectData.total ?? 0,
      onlineCount: 0,
      offlineCount: 0,
      topLabels: [],
    }
  } catch {
    // ignore
  }
}

onMounted(() => {
  loadMetrics()
  loadTodayStats()
  timer = setInterval(loadMetrics, 5000)
  /** 每30秒刷新今日统计 */
  setInterval(loadTodayStats, 30000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="status-panel">
    <div class="panel-header">系统状态</div>

    <!-- 系统概览 -->
    <div v-if="metrics" class="system-overview">
      <div class="stat-row">
        <span class="stat-label">运行时长</span>
        <span class="stat-value">{{ formatUptime(metrics.uptime) }}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">内存使用</span>
        <span class="stat-value">{{ metrics.memoryUsedMb }} MB</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">摄像头</span>
        <span class="stat-value">
          <span class="online-count">{{ metrics.onlineCameras }}</span>
          <span class="dim"> / {{ metrics.cameraCount }}</span>
        </span>
      </div>
    </div>

    <!-- 今日统计 -->
    <div v-if="todayStats" class="today-stats">
      <div class="stats-title">今日统计</div>
      <div class="stats-grid">
        <div class="stat-card">
          <span class="stat-num motion">{{ todayStats.motionCount }}</span>
          <span class="stat-desc">变动</span>
        </div>
        <div class="stat-card">
          <span class="stat-num detect">{{ todayStats.detectCount }}</span>
          <span class="stat-desc">检测</span>
        </div>
      </div>
    </div>

    <!-- 存储用量 -->
    <div v-if="metrics?.storage" class="storage-section">
      <div class="stats-title">存储用量</div>
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
          <span>已用 {{ diskUsagePercent() }}%</span>
          <span class="dim">剩余 {{ formatBytes(metrics.storage.diskFreeBytes) }}</span>
        </div>
      </div>
      <!-- 各目录用量 -->
      <div class="dir-list">
        <div v-for="dir in metrics.storage.directories" :key="dir.name" class="dir-row">
          <span class="dir-name">{{ dirNames[dir.name] ?? dir.name }}</span>
          <span class="dir-size">{{ formatBytes(dir.bytes) }}</span>
          <span class="dir-files">{{ dir.fileCount }} 文件</span>
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
            <span class="cam-status">{{ cam.online ? '在线' : '离线' }}</span>
          </div>
          <div class="cam-metrics">
            <div class="metric">
              <span class="metric-val">{{ cam.fps }}</span>
              <span class="metric-unit">fps</span>
            </div>
            <div class="metric">
              <span class="metric-val">{{ cam.motionCount }}</span>
              <span class="metric-unit">变动</span>
            </div>
            <div class="metric">
              <span class="metric-val">{{ cam.detectCount }}</span>
              <span class="metric-unit">检测</span>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="empty">加载中...</div>
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
</style>
