<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { authFetch, authUrl } from '../services/auth'
import RecordingsTimeline from './RecordingsTimeline.vue'
import MultiTimeline from './MultiTimeline.vue'

const { t, locale } = useI18n()

/** 录像信息 */
interface Recording {
  filename: string
  cameraId: string
  startTime: number
  endTime: number
  size: number
}

const props = defineProps<{
  cameras: Array<{ id: string; name: string }>
}>()

const recordings = ref<Recording[]>([])
const selectedRecording = ref<Recording | null>(null)
const filterCamera = ref('')
/** 日期筛选（YYYY-MM-DD） */
const filterDate = ref('')
const loading = ref(false)

/** 多选模式 */
const multiSelectMode = ref(false)
const selectedFiles = ref<Set<string>>(new Set())
const merging = ref(false)
const mergeFilename = ref('')

/** 缩略图 URL 缓存（filename → URL） */
const thumbUrls = ref<Record<string, string>>({})

/** 导出状态 */
const showExport = ref(false)
const exportStartSec = ref(0)
const exportEndSec = ref(0)
const exporting = ref(false)
/** 导出结果下载文件名 */
const exportFilename = ref('')

/** 当前播放速度 */
const playbackSpeed = ref(1)

/** video 元素引用 */
const playerRef = ref<HTMLVideoElement | null>(null)

/** 播放后需要跳转到的时间点（秒偏移，-1 表示不跳转） */
const seekOffset = ref(-1)

/** 自动连续播放开关 */
const autoPlayNext = ref(true)

/** 倍速变更时同步到 video 元素 */
function changeSpeed(speed: number) {
  playbackSpeed.value = speed
  if (playerRef.value) playerRef.value.playbackRate = speed
}

/** video 元素 ratechange 事件（用户通过浏览器原生控件改倍速时同步下拉框） */
function onRateChange() {
  if (playerRef.value) playbackSpeed.value = playerRef.value.playbackRate
}

/** video 元素 loadedmetadata 事件：恢复倍速 + 执行 seek 跳转 */
function onLoadedMetadata() {
  if (!playerRef.value) return
  playerRef.value.playbackRate = playbackSpeed.value
  if (seekOffset.value >= 0) {
    playerRef.value.currentTime = seekOffset.value
    seekOffset.value = -1
  }
}

/** 视频播放结束，自动播放同摄像头的下一段录像 */
function onVideoEnded() {
  if (!autoPlayNext.value || !selectedRecording.value) return
  /** 按时间升序排列，找到当前录像的下一段 */
  const sameCam = filteredRecordings.value
    .filter(r => r.cameraId === selectedRecording.value!.cameraId)
    .sort((a, b) => a.startTime - b.startTime)
  const idx = sameCam.findIndex(r => r.filename === selectedRecording.value!.filename)
  if (idx >= 0 && idx < sameCam.length - 1) {
    play(sameCam[idx + 1]!)
  }
}

/** 当前播放的录像 URL */
const videoUrl = computed(() => {
  if (!selectedRecording.value) return ''
  return authUrl(`/api/recordings/${selectedRecording.value.filename}`)
})

/** 当前录像总时长（秒） */
const totalDurationSec = computed(() => {
  if (!selectedRecording.value) return 0
  return Math.max(0, Math.round((selectedRecording.value.endTime - selectedRecording.value.startTime) / 1000))
})

/** 当前播放位置对应的绝对时间戳 */
const currentAbsTime = ref(0)
/** 是否正在播放 */
const isPlaying = ref(false)
function onTimeUpdate() {
  if (!playerRef.value || !selectedRecording.value) return
  currentAbsTime.value = selectedRecording.value.startTime + playerRef.value.currentTime * 1000
}

/** 播放进度百分比 */
const playProgress = computed(() => {
  if (!playerRef.value || !playerRef.value.duration || !isFinite(playerRef.value.duration)) return 0
  return (playerRef.value.currentTime / playerRef.value.duration) * 100
})

/** 进度条拖拽 seek */
const progressEl = ref<HTMLDivElement | null>(null)
function onProgressClick(e: MouseEvent) {
  if (!playerRef.value || !progressEl.value) return
  const rect = progressEl.value.getBoundingClientRect()
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  playerRef.value.currentTime = pct * playerRef.value.duration
}

/** 拖拽进度条 */
let progressDragging = false
function onProgressDragStart(e: MouseEvent) {
  progressDragging = true
  onProgressClick(e)
  function onMove(ev: MouseEvent) {
    if (!progressDragging || !playerRef.value || !progressEl.value) return
    const rect = progressEl.value.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
    playerRef.value.currentTime = pct * playerRef.value.duration
  }
  function onUp() {
    progressDragging = false
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

/** video play/pause 事件同步 isPlaying */
function onPlay() { isPlaying.value = true }
function onPause() { isPlaying.value = false }

/** 格式化绝对时间为 HH:MM:SS */
function formatAbsTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

/** 导出时长文本 */
const exportDurationText = computed(() => {
  const sec = exportEndSec.value - exportStartSec.value
  if (sec <= 0) return '0s'
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m${sec % 60}s`
})

/** 摄像头 ID → 名称映射 */
const cameraNameMap = computed(() => {
  const map: Record<string, string> = {}
  for (const cam of props.cameras) {
    map[cam.id] = cam.name
  }
  return map
})

/** 按日期过滤后的录像列表 */
const filteredRecordings = computed(() => {
  if (!filterDate.value) return recordings.value
  const since = new Date(`${filterDate.value}T00:00:00`).getTime()
  const until = since + 86_400_000
  return recordings.value.filter(r => r.startTime < until && r.endTime > since)
})

/** 筛选后录像总大小 */
const totalSize = computed(() => {
  return filteredRecordings.value.reduce((sum, r) => sum + r.size, 0)
})

/** 格式化文件大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 格式化时间 */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(locale.value, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** 计算录像时长 */
function duration(start: number, end: number): string {
  const sec = Math.round((end - start) / 1000)
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m${sec % 60}s`
}

/** 格式化秒数为 mm:ss 或 hh:mm:ss */
function formatSec(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 加载录像列表 */
async function loadRecordings() {
  loading.value = true
  try {
    const params = new URLSearchParams()
    if (filterCamera.value) params.set('cameraId', filterCamera.value)
    if (filterDate.value) {
      const since = new Date(`${filterDate.value}T00:00:00`).getTime()
      const until = since + 86_400_000
      params.set('since', String(since))
      params.set('until', String(until))
    }
    const res = await authFetch(`/api/recordings?${params}`)
    if (res.ok) {
      recordings.value = await res.json()
      thumbUrls.value = {}
    }
  } catch {
    // ignore
  } finally {
    loading.value = false
  }
}

/** 选择录像播放 */
function play(rec: Recording, seekToSec: number = -1) {
  selectedRecording.value = rec
  seekOffset.value = seekToSec
  showExport.value = false
  exportFilename.value = ''
  exportStartSec.value = 0
  exportEndSec.value = totalDurationSec.value || 0
}

/** 悬停时懒加载缩略图 */
function onRecordingHover(rec: Recording) {
  if (thumbUrls.value[rec.filename]) return
  const dur = Math.max(0, (rec.endTime - rec.startTime) / 1000 / 2)
  thumbUrls.value = {
    ...thumbUrls.value,
    [rec.filename]: authUrl(`/api/recordings/thumb?file=${encodeURIComponent(rec.filename)}&time=${dur.toFixed(1)}`),
  }
}

/** 关闭播放器 */
function closePlayer() {
  selectedRecording.value = null
  showExport.value = false
  exportFilename.value = ''
  gifFilename.value = ''
}

/** 删除录像 */
async function deleteRecording(rec: Recording) {
  if (!confirm(t('recording.confirmDelete'))) return
  try {
    const res = await authFetch(`/api/recordings/${rec.filename}`, { method: 'DELETE' })
    if (res.ok) {
      if (selectedRecording.value?.filename === rec.filename) closePlayer()
      recordings.value = recordings.value.filter(r => r.filename !== rec.filename)
    }
  } catch {
    // ignore
  }
}

/** 批量删除选中的录像 */
async function batchDelete() {
  if (selectedFiles.value.size === 0) return
  if (!confirm(t('recording.confirmBatchDelete', { count: selectedFiles.value.size }))) return
  const toDelete = new Set(selectedFiles.value)
  for (const filename of toDelete) {
    try {
      await authFetch(`/api/recordings/${filename}`, { method: 'DELETE' })
    } catch {
      // ignore individual failures
    }
  }
  if (selectedRecording.value && toDelete.has(selectedRecording.value.filename)) closePlayer()
  recordings.value = recordings.value.filter(r => !toDelete.has(r.filename))
  selectedFiles.value = new Set()
}

/** 打开导出面板 */
function openExport() {
  if (!selectedRecording.value) return
  exportStartSec.value = 0
  exportEndSec.value = totalDurationSec.value
  showExport.value = true
  exportFilename.value = ''
  gifFilename.value = ''
}

/** 执行导出 */
async function doExport() {
  if (!selectedRecording.value) return
  exporting.value = true
  exportFilename.value = ''
  try {
    const res = await authFetch('/api/recordings/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: selectedRecording.value.filename,
        cameraId: selectedRecording.value.cameraId,
        startSec: exportStartSec.value,
        endSec: exportEndSec.value,
      }),
    })
    if (res.ok) {
      const data = await res.json()
      exportFilename.value = data.filename
    }
  } catch {
    // ignore
  } finally {
    exporting.value = false
  }
}

/** GIF 导出状态 */
const gifExporting = ref(false)
const gifFilename = ref('')

/** 导出 GIF 动图 */
async function doGifExport() {
  if (!selectedRecording.value) return
  gifExporting.value = true
  gifFilename.value = ''
  try {
    const res = await authFetch('/api/recordings/gif', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: selectedRecording.value.filename,
        cameraId: selectedRecording.value.cameraId,
        startSec: exportStartSec.value,
        endSec: exportEndSec.value,
      }),
    })
    if (res.ok) {
      const data = await res.json()
      gifFilename.value = data.filename
    }
  } catch {
    // ignore
  } finally {
    gifExporting.value = false
  }
}

/** 下载导出文件 */
function downloadExport() {
  if (!exportFilename.value) return
  const link = document.createElement('a')
  link.href = authUrl(`/api/recordings/export/${exportFilename.value}`)
  link.download = exportFilename.value
  link.click()
}

/** 下载 GIF 导出文件 */
function downloadGif() {
  if (!gifFilename.value) return
  const link = document.createElement('a')
  link.href = authUrl(`/api/recordings/export/${gifFilename.value}`)
  link.download = gifFilename.value
  link.click()
}

/** 切换多选模式 */
function toggleMultiSelect() {
  multiSelectMode.value = !multiSelectMode.value
  selectedFiles.value = new Set()
  mergeFilename.value = ''
}

/** 切换选中文件 */
function toggleFileSelect(filename: string) {
  const s = new Set(selectedFiles.value)
  if (s.has(filename)) s.delete(filename)
  else s.add(filename)
  selectedFiles.value = s
  mergeFilename.value = ''
}

/** 选中的文件按时间排序 */
const sortedSelectedFiles = computed(() => {
  return recordings.value
    .filter(r => selectedFiles.value.has(r.filename))
    .sort((a, b) => a.startTime - b.startTime)
})

/** 合并导出选中录像 */
async function doMergeExport() {
  if (sortedSelectedFiles.value.length < 1) return
  merging.value = true
  mergeFilename.value = ''
  const cameraId = sortedSelectedFiles.value[0]!.cameraId
  try {
    const res = await authFetch('/api/recordings/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: sortedSelectedFiles.value.map(r => r.filename),
        cameraId,
      }),
    })
    if (res.ok) {
      const data = await res.json()
      mergeFilename.value = data.filename
    }
  } catch {
    // ignore
  } finally {
    merging.value = false
  }
}

/** 下载合并导出文件 */
function downloadMerge() {
  if (!mergeFilename.value) return
  const link = document.createElement('a')
  link.href = authUrl(`/api/recordings/export/${mergeFilename.value}`)
  link.download = mergeFilename.value
  link.click()
}

/** 根据摄像头和时间戳查找并播放对应录像 */
async function playAtTime(cameraId: string, timestamp: number): Promise<boolean> {
  /** 加载该摄像头的录像列表 */
  filterCamera.value = cameraId
  await loadRecordings()

  /** 找到时间范围包含该时间戳的录像 */
  const match = recordings.value.find(
    r => r.cameraId === cameraId && r.startTime <= timestamp && r.endTime >= timestamp
  )
  /** 如果没有精确匹配，找最接近的（时间戳在录像开始前后60秒内） */
  const closest = match ?? recordings.value
    .filter(r => r.cameraId === cameraId)
    .sort((a, b) => Math.abs(a.startTime - timestamp) - Math.abs(b.startTime - timestamp))[0]

  if (closest) {
    const offsetSec = Math.max(0, (timestamp - closest.startTime) / 1000)
    play(closest, offsetSec)
    return true
  }
  return false
}

onMounted(() => {
  loadRecordings()
})

defineExpose({ loadRecordings, playAtTime })
</script>

<template>
  <div class="recordings-panel">
    <!-- 播放器弹窗 -->
    <div v-if="selectedRecording" class="player-overlay" @click.self="closePlayer">
      <div class="player-modal">
        <div class="player-header">
          <span>{{ cameraNameMap[selectedRecording.cameraId] ?? selectedRecording.cameraId }}</span>
          <span class="player-time">{{ formatTime(selectedRecording.startTime) }}</span>
          <button class="export-toggle-btn" @click="openExport" :title="t('recording.export')">{{ t('recording.export') }}</button>
          <select :value="playbackSpeed" @change="changeSpeed(Number(($event.target as HTMLSelectElement).value))" class="speed-select" :title="t('recording.speed')">
            <option :value="0.5">0.5x</option>
            <option :value="1">1x</option>
            <option :value="1.5">1.5x</option>
            <option :value="2">2x</option>
            <option :value="4">4x</option>
            <option :value="8">8x</option>
          </select>
          <button
            :class="['autoplay-btn', { active: autoPlayNext }]"
            @click="autoPlayNext = !autoPlayNext"
            :title="t('recording.autoPlayNext')"
          >&#9654;&#9654;</button>
          <button class="close-btn" @click="closePlayer">&times;</button>
        </div>
        <video
          ref="playerRef"
          :src="videoUrl"
          autoplay
          class="player-video"
          @ratechange="onRateChange"
          @loadedmetadata="onLoadedMetadata"
          @ended="onVideoEnded"
          @timeupdate="onTimeUpdate"
          @play="onPlay"
          @pause="onPause"
        />
        <!-- 自定义进度条（绝对时间） -->
        <div v-if="selectedRecording" class="custom-controls">
          <button class="ctrl-btn play-pause" @click="isPlaying ? playerRef?.pause() : playerRef?.play()">
            {{ isPlaying ? '&#10074;&#10074;' : '&#9654;' }}
          </button>
          <div ref="progressEl" class="progress-bar" @mousedown="onProgressDragStart">
            <div class="progress-fill" :style="{ width: playProgress + '%' }" />
            <div class="progress-thumb" :style="{ left: playProgress + '%' }" />
          </div>
          <div class="time-display">
            <span class="time-current">{{ formatAbsTime(currentAbsTime) }}</span>
            <span class="time-sep">/</span>
            <span class="time-end">{{ formatAbsTime(selectedRecording.endTime) }}</span>
          </div>
        </div>
        <!-- 导出面板 -->
        <div v-if="showExport" class="export-panel">
          <div class="export-row">
            <label>{{ t('recording.startTime') }}</label>
            <input type="range" v-model.number="exportStartSec" :min="0" :max="totalDurationSec" step="1" class="export-slider" />
            <span class="export-time">{{ formatSec(exportStartSec) }}</span>
          </div>
          <div class="export-row">
            <label>{{ t('recording.endTime') }}</label>
            <input type="range" v-model.number="exportEndSec" :min="0" :max="totalDurationSec" step="1" class="export-slider" />
            <span class="export-time">{{ formatSec(exportEndSec) }}</span>
          </div>
          <div class="export-actions">
            <span class="export-duration">{{ exportDurationText }}</span>
            <button v-if="!exportFilename && !gifFilename" class="export-btn" @click="doExport" :disabled="exporting || exportEndSec <= exportStartSec">
              {{ exporting ? t('recording.exporting') : t('recording.exportMp4') }}
            </button>
            <button v-if="!exportFilename && !gifFilename" class="gif-btn" @click="doGifExport" :disabled="gifExporting || exportEndSec <= exportStartSec">
              {{ gifExporting ? t('recording.exporting') : t('recording.exportGif') }}
            </button>
            <button v-if="exportFilename" class="download-btn" @click="downloadExport">{{ t('recording.download') }} MP4 ({{ exportDurationText }})</button>
            <button v-if="gifFilename" class="download-btn" @click="downloadGif">{{ t('recording.download') }} GIF ({{ exportDurationText }})</button>
          </div>
        </div>
      </div>
    </div>

    <div class="panel-header">
      <span>{{ t('recording.title') }} <span v-if="filteredRecordings.length > 0" class="rec-summary">{{ filteredRecordings.length }} / {{ formatSize(totalSize) }}</span></span>
      <input type="date" v-model="filterDate" class="filter-date" :title="t('recording.filterDate')" />
      <select v-model="filterCamera" @change="loadRecordings" class="filter-select">
        <option value="">{{ t("recording.allCameras") }}</option>
        <option v-for="cam in cameras" :key="cam.id" :value="cam.id">{{ cam.name }}</option>
      </select>
      <button class="refresh-btn" @click="loadRecordings" :disabled="loading">{{ t('event.refresh') }}</button>
      <button :class="['select-btn', { active: multiSelectMode }]" @click="toggleMultiSelect">{{ multiSelectMode ? t('recording.cancelSelect') : t('recording.selectMultiple') }}</button>
    </div>

    <!-- 多路同步时间轴（全部摄像头时显示） -->
    <MultiTimeline
      v-if="!filterCamera"
      :recordings="filteredRecordings"
      :cameras="cameras"
      @play="play"
    />

    <!-- 单路时间轴 -->
    <RecordingsTimeline
      v-if="filterCamera"
      :recordings="filteredRecordings"
      :selected-camera="filterCamera"
      @play="play"
    />

    <div class="recordings-list">
      <div v-if="filteredRecordings.length === 0" class="empty">
        {{ loading ? t('app.loading') : t('recording.noRecordings') }}
      </div>
      <div
        v-for="rec in filteredRecordings"
        :key="rec.filename"
        :class="['recording-item', { selected: selectedFiles.has(rec.filename) }]"
        @click="multiSelectMode ? toggleFileSelect(rec.filename) : play(rec)"
        @mouseenter="onRecordingHover(rec)"
      >
        <input
          v-if="multiSelectMode"
          type="checkbox"
          :checked="selectedFiles.has(rec.filename)"
          class="rec-checkbox"
          @click.stop="toggleFileSelect(rec.filename)"
        />
        <div class="rec-thumb">
          <img v-if="thumbUrls[rec.filename]" :src="thumbUrls[rec.filename]" alt="" class="thumb-img" />
          <span v-else class="thumb-icon">&#9654;</span>
        </div>
        <div class="rec-info">
          <div class="rec-cam">{{ cameraNameMap[rec.cameraId] ?? rec.cameraId }}</div>
          <div class="rec-time">{{ formatTime(rec.startTime) }}</div>
        </div>
        <div class="rec-meta">
          <span v-if="rec.endTime > rec.startTime" class="rec-duration">
            {{ duration(rec.startTime, rec.endTime) }}
          </span>
          <span class="rec-size">{{ formatSize(rec.size) }}</span>
          <button class="rec-delete" @click.stop="deleteRecording(rec)" :title="t('recording.delete')">&#10005;</button>
        </div>
      </div>
    </div>

    <!-- 多选合并操作栏 -->
    <div v-if="multiSelectMode" class="merge-bar">
      <span class="merge-info">{{ t('recording.selectedCount', { count: selectedFiles.size }) }}</span>
      <span v-if="sortedSelectedFiles.length > 1" class="merge-duration">
        {{ duration(sortedSelectedFiles[0].startTime, sortedSelectedFiles[sortedSelectedFiles.length - 1].endTime) }}
      </span>
      <button v-if="!mergeFilename" class="merge-btn" @click="doMergeExport" :disabled="merging || selectedFiles.size < 1">
        {{ merging ? t('recording.merging') : t('recording.merge') }}
      </button>
      <button v-else class="download-btn" @click="downloadMerge">{{ t('recording.download') }}</button>
      <button class="batch-delete-btn" @click="batchDelete" :disabled="selectedFiles.size === 0">
        {{ t('recording.deleteSelected') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.recordings-panel {
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
  background: #16213e;
  border-bottom: 1px solid #2a2a4a;
  color: #e0e0e0;
  font-weight: 600;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.rec-summary {
  background: #2a2a4a;
  color: #888;
  border-radius: 8px;
  padding: 1px 6px;
  font-size: 11px;
  font-weight: 400;
  margin-left: 4px;
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
  cursor: not-allowed;
}

.select-btn {
  background: #2a2a4a;
  color: #e0e0e0;
  border: none;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}

.select-btn:hover {
  background: #3a3a5a;
}

.select-btn.active {
  background: #4ECDC4;
  color: #1a1a2e;
}

.recordings-list {
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

.recording-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s;
}

.recording-item:hover {
  background: #2a2a4a;
}

.recording-item.selected {
  background: #1a3a3a;
  border-left: 3px solid #4ECDC4;
}

.rec-checkbox {
  accent-color: #4ECDC4;
  flex-shrink: 0;
  cursor: pointer;
}

.rec-thumb {
  width: 64px;
  height: 36px;
  background: #0a0a1a;
  border-radius: 3px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumb-icon {
  color: #4ECDC4;
  font-size: 12px;
}

.rec-info {
  flex: 1;
  min-width: 0;
}

.rec-cam {
  font-size: 13px;
  color: #e0e0e0;
  font-weight: 500;
}

.rec-time {
  font-size: 11px;
  color: #888;
  margin-top: 2px;
}

.rec-meta {
  text-align: right;
  flex-shrink: 0;
}

.rec-duration {
  display: block;
  font-size: 11px;
  color: #4ECDC4;
}

.rec-size {
  display: block;
  font-size: 11px;
  color: #888;
  margin-top: 2px;
}

.rec-delete {
  background: none;
  border: none;
  color: #555;
  font-size: 12px;
  cursor: pointer;
  padding: 2px;
  margin-left: 4px;
  opacity: 0;
  transition: opacity 0.2s, color 0.2s;
}

.recording-item:hover .rec-delete {
  opacity: 1;
}

.rec-delete:hover {
  color: #e74c3c;
}

/* 播放器弹窗 */
.player-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.player-modal {
  width: 90vw;
  max-width: 960px;
  background: #1a1a2e;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #2a2a4a;
  position: relative;
}

.player-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: #16213e;
  border-bottom: 1px solid #2a2a4a;
  font-size: 14px;
  color: #e0e0e0;
}

.player-time {
  color: #888;
  font-size: 12px;
}

.close-btn {
  background: none;
  border: none;
  color: #888;
  font-size: 20px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.close-btn:hover {
  color: #e0e0e0;
}

.speed-select {
  background: #0a0a1a;
  color: #4ECDC4;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 12px;
  cursor: pointer;
  margin-left: auto;
}

.speed-select:hover {
  border-color: #4ECDC4;
}

.autoplay-btn {
  background: none;
  border: 1px solid #555;
  color: #555;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 10px;
  cursor: pointer;
  line-height: 1;
}

.autoplay-btn.active {
  border-color: #4ECDC4;
  color: #4ECDC4;
}

.autoplay-btn:hover {
  border-color: #4ECDC4;
}

.player-video {
  width: 100%;
  display: block;
  max-height: 75vh;
  background: #000;
}

/* 自定义控制栏 */
.custom-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: #111;
  border-top: 1px solid #2a2a2a;
}

.ctrl-btn {
  background: none;
  border: none;
  color: #e0e0e0;
  font-size: 14px;
  cursor: pointer;
  padding: 2px 4px;
  line-height: 1;
  flex-shrink: 0;
}

.ctrl-btn:hover {
  color: #4ECDC4;
}

.progress-bar {
  flex: 1;
  height: 6px;
  background: #333;
  border-radius: 3px;
  cursor: pointer;
  position: relative;
}

.progress-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  background: #4ECDC4;
  border-radius: 3px;
  transition: width 0.1s linear;
}

.progress-thumb {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  background: #4ECDC4;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  opacity: 0;
  transition: opacity 0.15s;
  pointer-events: none;
}

.progress-bar:hover .progress-thumb {
  opacity: 1;
}

.time-display {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  color: #aaa;
  flex-shrink: 0;
  white-space: nowrap;
}

.time-current {
  color: #e0e0e0;
  min-width: 60px;
  text-align: right;
}

.time-sep {
  color: #555;
}

.time-end {
  min-width: 60px;
}

/* 导出面板 */
.export-toggle-btn {
  margin-left: auto;
  background: #2a4a2a;
  color: #4ECDC4;
  border: 1px solid #4ECDC4;
  border-radius: 4px;
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.export-toggle-btn:hover {
  background: #4ECDC4;
  color: #1a1a2e;
}

.export-panel {
  padding: 12px 16px;
  background: #0a0a1a;
  border-top: 1px solid #2a2a4a;
}

.export-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.export-row label {
  color: #888;
  font-size: 12px;
  width: 32px;
  flex-shrink: 0;
}

.export-slider {
  flex: 1;
  accent-color: #4ECDC4;
  height: 4px;
}

.export-time {
  color: #4ECDC4;
  font-size: 12px;
  font-family: monospace;
  width: 60px;
  text-align: right;
  flex-shrink: 0;
}

.export-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.export-duration {
  color: #888;
  font-size: 12px;
}

.export-btn {
  margin-left: auto;
  background: #4ECDC4;
  color: #1a1a2e;
  border: none;
  border-radius: 4px;
  padding: 6px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.export-btn:hover {
  opacity: 0.85;
}

.export-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.download-btn {
  margin-left: auto;
  background: #4CAF50;
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 6px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.download-btn:hover {
  opacity: 0.85;
}

.gif-btn {
  background: #FFD93D;
  color: #1a1a2e;
  border: none;
  border-radius: 4px;
  padding: 6px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.gif-btn:hover {
  opacity: 0.85;
}

.gif-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 合并操作栏 */
.merge-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: #16213e;
  border-top: 1px solid #2a2a4a;
}

.merge-info {
  color: #e0e0e0;
  font-size: 12px;
  font-weight: 500;
}

.merge-duration {
  color: #4ECDC4;
  font-size: 12px;
}

.merge-btn {
  margin-left: auto;
  background: #FFD93D;
  color: #1a1a2e;
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.merge-btn:hover {
  opacity: 0.85;
}

.merge-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.batch-delete-btn {
  background: none;
  border: 1px solid #e74c3c;
  color: #e74c3c;
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 11px;
  cursor: pointer;
}

.batch-delete-btn:hover:not(:disabled) {
  background: #e74c3c;
  color: #fff;
}

.batch-delete-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 移动端适配 */
@media (max-width: 768px) {
  .recordings-panel {
    border-radius: 0;
    border: none;
  }

  .player-modal {
    width: 100vw;
    max-width: 100vw;
    border-radius: 0;
    max-height: 100vh;
  }

  .player-video {
    max-height: 80vh;
  }
}
</style>
