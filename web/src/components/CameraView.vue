<script setup lang="ts">
import { ref, computed, onUnmounted, watch } from 'vue'
import type { Detection } from '../services/events'

const props = defineProps<{
  cameraId: string
  name: string
  online: boolean
  detections: Detection[]
  detectVersion: number
  /** WebSocket 推送的实时帧 data URL */
  frameImage: string
}>()

const emit = defineEmits<{
  fullscreen: [cameraId: string]
}>()

/** 标注图片 URL */
const annotatedUrl = ref<string>('')

/** 检测框列表（按置信度排序） */
const sortedDetections = computed(() =>
  [...props.detections].sort((a, b) => b.score - a.score)
)

/** 收到检测事件时拉取标注图片 */
watch(() => props.detectVersion, async (v: number) => {
  if (v === 0) return
  try {
    const res = await fetch(`/api/detection/annotated/${props.cameraId}`)
    if (res.ok) {
      const blob = await res.blob()
      if (annotatedUrl.value) URL.revokeObjectURL(annotatedUrl.value)
      annotatedUrl.value = URL.createObjectURL(blob)
    }
  } catch {
    // ignore
  }
})

/** 优先显示标注图片，没有则显示实时帧 */
const displayUrl = computed(() => annotatedUrl.value || props.frameImage)

/** 检测框叠加在画面上的样式 */
const detectionBoxes = computed(() => {
  if (!sortedDetections.value.length) return []
  return sortedDetections.value.map(d => ({
    label: d.label,
    score: d.score,
    style: {
      left: `${d.box.xmin * 100}%`,
      top: `${d.box.ymin * 100}%`,
      width: `${(d.box.xmax - d.box.xmin) * 100}%`,
      height: `${(d.box.ymax - d.box.ymin) * 100}%`,
    },
  }))
})

/** 3秒后清除标注图片，恢复实时帧 */
let annotatedTimer: ReturnType<typeof setTimeout> | null = null
watch(annotatedUrl, (url) => {
  if (annotatedTimer) clearTimeout(annotatedTimer)
  if (url) {
    annotatedTimer = setTimeout(() => {
      if (annotatedUrl.value) {
        URL.revokeObjectURL(annotatedUrl.value)
        annotatedUrl.value = ''
      }
      annotatedTimer = null
    }, 3000)
  }
})

onUnmounted(() => {
  if (annotatedUrl.value) URL.revokeObjectURL(annotatedUrl.value)
  if (annotatedTimer) clearTimeout(annotatedTimer)
})
</script>

<template>
  <div class="camera-view" :class="{ offline: !online }">
    <div class="camera-header">
      <span class="status-dot" :class="{ online, offline: !online }" />
      <span class="camera-name">{{ name }}</span>
      <span v-if="online && detections.length > 0" class="detection-count">
        {{ detections.length }}
      </span>
      <span v-if="!online" class="offline-badge">离线</span>
      <button class="fullscreen-btn" @click="emit('fullscreen', cameraId)" title="全屏">&#x26F6;</button>
    </div>

    <div class="camera-body">
      <img
        v-if="displayUrl"
        :src="displayUrl"
        class="camera-image"
        alt=""
      />
      <div v-else class="camera-placeholder">
        <div v-if="online" class="placeholder-icon">&#9679;</div>
        <div v-else class="placeholder-icon offline-icon">&#10005;</div>
        <span>{{ online ? '等待视频...' : '摄像头离线' }}</span>
      </div>

      <!-- 检测框叠加层 -->
      <div v-if="displayUrl && detectionBoxes.length > 0" class="detection-overlay">
        <div
          v-for="(box, i) in detectionBoxes"
          :key="i"
          class="detect-box"
          :style="box.style"
        >
          <span class="detect-label">{{ box.label }} {{ (box.score * 100).toFixed(0) }}%</span>
        </div>
      </div>
    </div>

    <div class="camera-footer" v-if="sortedDetections.length > 0">
      <div
        v-for="(det, i) in sortedDetections"
        :key="i"
        class="detection-tag"
      >
        {{ det.label }} {{ (det.score * 100).toFixed(0) }}%
      </div>
    </div>
  </div>
</template>

<style scoped>
.camera-view {
  background: #1a1a2e;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #2a2a4a;
  transition: border-color 0.3s;
}

.camera-view.offline {
  opacity: 0.7;
}

.camera-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #16213e;
  border-bottom: 1px solid #2a2a4a;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: #666;
}

.status-dot.online {
  background: #4CAF50;
}

.status-dot.offline {
  background: #F44336;
}

.camera-name {
  color: #e0e0e0;
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detection-count {
  background: #4ECDC4;
  color: #1a1a2e;
  border-radius: 10px;
  padding: 1px 7px;
  font-size: 11px;
  font-weight: 700;
}

.offline-badge {
  background: #F44336;
  color: #fff;
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 11px;
  font-weight: 600;
}

.fullscreen-btn {
  margin-left: auto;
  background: none;
  border: none;
  color: #888;
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.fullscreen-btn:hover {
  color: #e0e0e0;
}

.camera-body {
  position: relative;
  background: #0a0a1a;
  /** 16:9 宽高比 */
  aspect-ratio: 16 / 9;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.camera-image {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.camera-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: #444;
  font-size: 13px;
}

.placeholder-icon {
  font-size: 28px;
  color: #4CAF50;
  animation: pulse 2s infinite;
}

.placeholder-icon.offline-icon {
  color: #F44336;
  animation: none;
}

@keyframes pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

/* 检测框叠加层 */
.detection-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.detect-box {
  position: absolute;
  border: 2px solid #4ECDC4;
  border-radius: 3px;
}

.detect-label {
  position: absolute;
  top: -20px;
  left: -2px;
  background: #4ECDC4;
  color: #1a1a2e;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 2px;
  white-space: nowrap;
}

.camera-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 8px 12px;
  background: #16213e;
  border-top: 1px solid #2a2a4a;
}

.detection-tag {
  background: #2a2a4a;
  color: #4ECDC4;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
}

/* 移动端适配 */
@media (max-width: 768px) {
  .camera-header {
    padding: 6px 8px;
  }

  .camera-name {
    font-size: 13px;
  }

  .camera-footer {
    padding: 4px 8px;
  }
}
</style>
