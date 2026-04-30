<script setup lang="ts">
import { ref, onMounted } from 'vue'

/** 事件记录 */
interface EventRecord {
  id: number
  type: string
  camera_id: string
  timestamp: number
  detail: string | null
}

interface EventItem {
  id: number
  time: string
  /** 原始时间戳 */
  timestamp: number
  type: string
  cameraId: string
  detail: string
}

const events = ref<EventItem[]>([])
const MAX_LIVE_EVENTS = 50
const loading = ref(false)
const filterType = ref('')

const props = defineProps<{
  /** 每个摄像头的最新检测帧快照 */
  snapshots?: Record<string, string>
}>()

const emit = defineEmits<{
  (e: 'play-recording', cameraId: string, timestamp: number): void
}>()

/** 事件类型标签样式 */
const typeConfig: Record<string, { label: string; bg: string; color: string }> = {
  motion: { label: '变动', bg: '#FFEAA7', color: '#333' },
  detect: { label: '检测', bg: '#4ECDC4', color: '#333' },
  'camera:online': { label: '上线', bg: '#4CAF50', color: '#fff' },
  'camera:offline': { label: '离线', bg: '#F44336', color: '#fff' },
}

/** 添加实时事件 */
function addEvent(type: string, cameraId: string, detail: string) {
  const now = Date.now()
  const time = new Date(now).toLocaleTimeString('zh-CN')
  events.value.unshift({ id: now, time, timestamp: now, type, cameraId, detail })
  if (events.value.length > MAX_LIVE_EVENTS) {
    events.value = events.value.slice(0, MAX_LIVE_EVENTS)
  }
}

/** 格式化时间戳 */
function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN')
}

/** 解析 detail JSON */
function parseDetail(type: string, detail: string | null): string {
  if (!detail) return ''
  try {
    const obj = JSON.parse(detail)
    if (type === 'motion' && obj.ratio) return `变动 ${(obj.ratio * 100).toFixed(1)}%`
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
    const params = new URLSearchParams({ limit: '100' })
    if (filterType.value) params.set('type', filterType.value)
    const res = await fetch(`/api/events/history?${params}`)
    if (res.ok) {
      const data = await res.json()
      const historyEvents: EventItem[] = (data.events as EventRecord[]).map((e) => ({
        id: e.id,
        time: formatTimestamp(e.timestamp),
        timestamp: e.timestamp,
        type: e.type,
        cameraId: e.camera_id,
        detail: parseDetail(e.type, e.detail),
      }))
      events.value = historyEvents
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

defineExpose({ addEvent, loadHistory })
</script>

<template>
  <div class="event-panel">
    <div class="panel-header">
      <span>事件日志</span>
      <select v-model="filterType" @change="loadHistory" class="filter-select">
        <option value="">全部类型</option>
        <option value="motion">变动</option>
        <option value="detect">检测</option>
        <option value="camera:online">上线</option>
        <option value="camera:offline">离线</option>
      </select>
      <button class="refresh-btn" @click="loadHistory" :disabled="loading">
        刷新
      </button>
    </div>
    <div class="event-list">
      <div v-if="events.length === 0" class="empty">
        {{ loading ? '加载中...' : '暂无事件' }}
      </div>
      <div
        v-for="e in events"
        :key="e.id"
        class="event-item"
        :class="[e.type, { clickable: e.type === 'motion' || e.type === 'detect' }]"
        @click="emit('play-recording', e.cameraId, e.timestamp)"
      >
        <span class="event-time">{{ e.time }}</span>
        <span
          v-if="typeConfig[e.type]"
          class="event-type"
          :style="{ background: typeConfig[e.type].bg, color: typeConfig[e.type].color }"
        >{{ typeConfig[e.type].label }}</span>
        <span class="event-cam">{{ e.cameraId }}</span>
        <img
          v-if="e.type === 'detect' && snapshots?.[e.cameraId]"
          :src="snapshots[e.cameraId]"
          class="event-thumb"
          alt=""
        />
        <span class="event-detail">{{ e.detail }}</span>
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
}

.event-item:hover {
  background: #2a2a4a;
}

.event-item.clickable {
  cursor: pointer;
}

.event-item.clickable:hover {
  background: #2a3a4a;
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
}

.event-thumb {
  width: 32px;
  height: 24px;
  object-fit: cover;
  border-radius: 2px;
  flex-shrink: 0;
  border: 1px solid #2a2a4a;
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
}
</style>
