<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import RecordingsTimeline from './RecordingsTimeline.vue'

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
const loading = ref(false)

/** 缩略图 URL 缓存（filename → URL） */
const thumbUrls = ref<Record<string, string>>({})

/** 当前播放的录像 URL */
const videoUrl = computed(() => {
  if (!selectedRecording.value) return ''
  return `/api/recordings/${selectedRecording.value.filename}`
})

/** 摄像头 ID → 名称映射 */
const cameraNameMap = computed(() => {
  const map: Record<string, string> = {}
  for (const cam of props.cameras) {
    map[cam.id] = cam.name
  }
  return map
})

/** 格式化文件大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 格式化时间 */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
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

/** 加载录像列表 */
async function loadRecordings() {
  loading.value = true
  try {
    const params = new URLSearchParams()
    if (filterCamera.value) params.set('cameraId', filterCamera.value)
    const res = await fetch(`/api/recordings?${params}`)
    if (res.ok) {
      recordings.value = await res.json()
    }
  } catch {
    // ignore
  } finally {
    loading.value = false
  }
}

/** 选择录像播放 */
function play(rec: Recording) {
  selectedRecording.value = rec
}

/** 悬停时懒加载缩略图 */
function onRecordingHover(rec: Recording) {
  if (thumbUrls.value[rec.filename]) return
  const dur = Math.max(0, (rec.endTime - rec.startTime) / 1000 / 2)
  thumbUrls.value = {
    ...thumbUrls.value,
    [rec.filename]: `/api/recordings/thumb?file=${encodeURIComponent(rec.filename)}&time=${dur.toFixed(1)}`,
  }
}

/** 关闭播放器 */
function closePlayer() {
  selectedRecording.value = null
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
    play(closest)
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
          <button class="close-btn" @click="closePlayer">&times;</button>
        </div>
        <video
          :src="videoUrl"
          controls
          autoplay
          class="player-video"
        />
      </div>
    </div>

    <div class="panel-header">
      <span>录像回放</span>
      <select v-model="filterCamera" @change="loadRecordings" class="filter-select">
        <option value="">全部摄像头</option>
        <option v-for="cam in cameras" :key="cam.id" :value="cam.id">{{ cam.name }}</option>
      </select>
      <button class="refresh-btn" @click="loadRecordings" :disabled="loading">刷新</button>
    </div>

    <!-- 时间轴 -->
    <RecordingsTimeline
      :recordings="recordings"
      :selected-camera="filterCamera"
      @play="play"
    />

    <div class="recordings-list">
      <div v-if="recordings.length === 0" class="empty">
        {{ loading ? '加载中...' : '暂无录像' }}
      </div>
      <div
        v-for="rec in recordings"
        :key="rec.filename"
        class="recording-item"
        @click="play(rec)"
        @mouseenter="onRecordingHover(rec)"
      >
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
        </div>
      </div>
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

.filter-select {
  margin-left: auto;
  background: #0a0a1a;
  color: #e0e0e0;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 12px;
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
  margin-left: auto;
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

.player-video {
  width: 100%;
  display: block;
  max-height: 75vh;
  background: #000;
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
