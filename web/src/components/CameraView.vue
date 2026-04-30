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

/** 标注图片 URL */
const annotatedUrl = ref<string>('')

/** 检测框列表（按置信度排序） */
const sortedDetections = computed(() =>
  [...props.detections].sort((a, b) => b.score - a.score)
)

/** 状态指示灯颜色 */
const statusColor = computed(() => props.online ? '#4CAF50' : '#F44336')

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

onUnmounted(() => {
  if (annotatedUrl.value) URL.revokeObjectURL(annotatedUrl.value)
})
</script>

<template>
  <div class="camera-view">
    <div class="camera-header">
      <span class="status-dot" :style="{ backgroundColor: statusColor }" />
      <span class="camera-name">{{ name }}</span>
      <span class="detection-count" v-if="detections.length > 0">
        {{ detections.length }} 个目标
      </span>
    </div>

    <div class="camera-body">
      <img
        v-if="displayUrl"
        :src="displayUrl"
        class="camera-image"
        alt="视频流"
      />
      <div v-else class="camera-placeholder">
        <span>等待视频...</span>
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
}

.camera-name {
  color: #e0e0e0;
  font-weight: 600;
  font-size: 14px;
}

.detection-count {
  margin-left: auto;
  color: #4ECDC4;
  font-size: 12px;
}

.camera-body {
  position: relative;
  background: #0a0a1a;
  min-height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.camera-image {
  width: 100%;
  height: auto;
  display: block;
}

.camera-placeholder {
  color: #555;
  font-size: 14px;
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
</style>
