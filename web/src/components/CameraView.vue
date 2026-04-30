<script setup lang="ts">
import { ref, computed, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Detection } from '../services/events'
import { authFetch } from '../services/auth'
import PtzControl from './PtzControl.vue'

const { t } = useI18n()
const props = defineProps<{
  cameraId: string
  name: string
  online: boolean
  /** 最后收到帧的时间戳（ms） */
  lastFrameAt: number
  detections: Detection[]
  detectVersion: number
  /** WebSocket 推送的实时帧 data URL */
  frameImage: string
  /** 是否支持 PTZ 云台控制 */
  ptz?: boolean
  /** 视频宽度（用于计算画面比例） */
  videoWidth?: number
  /** 视频高度（用于计算画面比例） */
  videoHeight?: number
  /** 实时帧率（从 health API 获取） */
  fps?: number
}>()

const emit = defineEmits<{
  fullscreen: [cameraId: string]
}>()

/** 实时时钟 */
const clockText = ref('')
let clockTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
  const now = new Date()
  const y = now.getFullYear()
  const mo = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const h = String(now.getHours()).padStart(2, '0')
  const mi = String(now.getMinutes()).padStart(2, '0')
  const s = String(now.getSeconds()).padStart(2, '0')
  clockText.value = `${y}-${mo}-${d} ${h}:${mi}:${s}`
}, 1000)
/** 立即初始化 */
{
  const now = new Date()
  const y = now.getFullYear()
  const mo = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const h = String(now.getHours()).padStart(2, '0')
  const mi = String(now.getMinutes()).padStart(2, '0')
  const s = String(now.getSeconds()).padStart(2, '0')
  clockText.value = `${y}-${mo}-${d} ${h}:${mi}:${s}`
}

/** 标注图片 URL（仅用于截图下载） */
const annotatedUrl = ref<string>('')

/** 检测框列表（按置信度排序） */
const sortedDetections = computed(() =>
  [...props.detections].sort((a, b) => b.score - a.score)
)

/** 收到检测事件时拉取标注图片（仅截图用） */
watch(() => props.detectVersion, async (v: number) => {
  if (v === 0) return
  try {
    const res = await authFetch(`/api/detection/annotated/${props.cameraId}`)
    if (res.ok) {
      const blob = await res.blob()
      if (annotatedUrl.value) URL.revokeObjectURL(annotatedUrl.value)
      annotatedUrl.value = URL.createObjectURL(blob)
    }
  } catch {
    // ignore
  }
})

/** 始终显示实时帧，检测框通过叠加层渲染 */
const displayUrl = computed(() => props.frameImage)

/** 画面比例：根据视频分辨率计算，默认 16:9 */
const cameraBodyStyle = computed(() => {
  if (props.videoWidth && props.videoHeight && props.videoWidth > 0 && props.videoHeight > 0) {
    return { 'aspect-ratio': `${props.videoWidth} / ${props.videoHeight}` }
  }
  return { 'aspect-ratio': '16 / 9' }
})

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

/** 离线时显示"最后在线 x 分钟前" */
const lastSeenText = computed(() => {
  if (props.online || !props.lastFrameAt) return ''
  const diffSec = Math.floor((Date.now() - props.lastFrameAt) / 1000)
  if (diffSec < 60) return t('camera.lastSeenJustNow')
  if (diffSec < 3600) return t('camera.lastSeenMinutes', { count: Math.floor(diffSec / 60) })
  if (diffSec < 86400) return t('camera.lastSeenHours', { count: Math.floor(diffSec / 3600) })
  return t('camera.lastSeenDays', { count: Math.floor(diffSec / 86400) })
})

/** FPS 质量等级 */
const fpsQuality = computed(() => {
  const fps = props.fps ?? 0
  if (fps >= 10) return 'good'
  if (fps >= 5) return 'fair'
  return 'poor'
})

/** 截图下载当前画面（优先标注图） */
function takeScreenshot() {
  const src = annotatedUrl.value || displayUrl.value
  if (!src) return
  const link = document.createElement('a')
  const now = new Date()
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
  link.download = `${props.name}_${ts}.jpg`
  link.href = src
  link.click()
}

/** 画面调节面板 */
const showAdjust = ref(false)
const brightness = ref(100)
const contrast = ref(100)
const saturation = ref(100)

/** CSS filter 字符串 */
const imageFilter = computed(() => {
  const parts: string[] = []
  if (!props.online) {
    parts.push('grayscale(100%)', 'opacity(0.6)')
  }
  if (brightness.value !== 100) parts.push(`brightness(${brightness.value}%)`)
  if (contrast.value !== 100) parts.push(`contrast(${contrast.value}%)`)
  if (saturation.value !== 100) parts.push(`saturate(${saturation.value}%)`)
  return parts.length > 0 ? parts.join(' ') : 'none'
})

/** 重置画面调节 */
function resetAdjust() {
  brightness.value = 100
  contrast.value = 100
  saturation.value = 100
}

/** 画面缩放（滚轮缩放，可拖拽平移） */
const zoomLevel = ref(1)
const panX = ref(0)
const panY = ref(0)

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const delta = e.deltaY > 0 ? -0.15 : 0.15
  zoomLevel.value = Math.max(1, Math.min(5, zoomLevel.value + delta))
  if (zoomLevel.value === 1) {
    panX.value = 0
    panY.value = 0
  }
}

/** 拖拽平移 */
let dragging = false
let dragStartX = 0
let dragStartY = 0
let dragStartPanX = 0
let dragStartPanY = 0

function onPanStart(e: MouseEvent) {
  if (zoomLevel.value <= 1) return
  dragging = true
  dragStartX = e.clientX
  dragStartY = e.clientY
  dragStartPanX = panX.value
  dragStartPanY = panY.value
}

function onPanMove(e: MouseEvent) {
  if (!dragging) return
  panX.value = dragStartPanX + (e.clientX - dragStartX)
  panY.value = dragStartPanY + (e.clientY - dragStartY)
}

function onPanEnd() {
  dragging = false
}

/** 缩放 transform 样式 */
const zoomTransform = computed(() => {
  if (zoomLevel.value <= 1) return 'none'
  return `translate(${panX.value}px, ${panY.value}px) scale(${zoomLevel.value})`
})

/** 重置缩放 */
function resetZoom() {
  zoomLevel.value = 1
  panX.value = 0
  panY.value = 0
}

onUnmounted(() => {
  if (annotatedUrl.value) URL.revokeObjectURL(annotatedUrl.value)
  if (clockTimer) clearInterval(clockTimer)
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
      <span v-if="zoomLevel > 1" class="zoom-badge" @click="resetZoom" :title="t('camera.resetZoom')">{{ zoomLevel.toFixed(1) }}x</span>
      <span v-if="!online" class="offline-badge">{{ t('camera.offline') }}</span>
      <button class="fullscreen-btn" @click="emit('fullscreen', cameraId)" :title="t('camera.fullscreen')">&#x26F6;</button>
      <button v-if="online" class="screenshot-btn" @click="takeScreenshot" :title="t('camera.screenshot')">&#x1F4F7;</button>
      <PtzControl v-if="ptz && online" :camera-id="cameraId" />
      <button v-if="online" :class="['adjust-btn', { active: showAdjust }]" @click="showAdjust = !showAdjust" :title="t('camera.adjust')">&#x2606;</button>
    </div>

    <div
      class="camera-body"
      :style="cameraBodyStyle"
      @dblclick="emit('fullscreen', cameraId)"
      @wheel="onWheel"
      @mousedown="onPanStart"
      @mousemove="onPanMove"
      @mouseup="onPanEnd"
      @mouseleave="onPanEnd"
    >
      <img
        v-if="displayUrl"
        :src="displayUrl"
        class="camera-image"
        :style="{ filter: imageFilter, transform: zoomTransform }"
        alt=""
      />
      <div v-else class="camera-placeholder">
        <div v-if="online" class="placeholder-icon">&#9679;</div>
        <div v-else class="placeholder-icon offline-icon">&#10005;</div>
        <span>{{ online ? t('camera.waiting') : t('camera.cameraOffline') }}</span>
        <span v-if="!online && lastSeenText" class="last-seen">{{ lastSeenText }}</span>
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

      <!-- 摄像头名称叠加 -->
      <div v-if="displayUrl" class="name-overlay">
        <span class="name-text">{{ name }}</span>
      </div>

      <!-- 数字时钟叠加 -->
      <div v-if="online && displayUrl" class="clock-overlay">
        <span class="clock-text">{{ clockText }}</span>
      </div>

      <!-- FPS 质量指示 -->
      <div v-if="online && displayUrl && (fps ?? 0) > 0" :class="['fps-badge', fpsQuality]">
        {{ (fps ?? 0).toFixed(0) }} fps
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

    <!-- 画面调节面板 -->
    <div v-if="showAdjust" class="adjust-panel">
      <label class="adjust-row">
        <span class="adjust-label">{{ t('camera.brightness') }}</span>
        <input type="range" v-model.number="brightness" min="50" max="200" step="5" class="adjust-slider" />
        <span class="adjust-val">{{ brightness }}%</span>
      </label>
      <label class="adjust-row">
        <span class="adjust-label">{{ t('camera.contrast') }}</span>
        <input type="range" v-model.number="contrast" min="50" max="200" step="5" class="adjust-slider" />
        <span class="adjust-val">{{ contrast }}%</span>
      </label>
      <label class="adjust-row">
        <span class="adjust-label">{{ t('camera.saturation') }}</span>
        <input type="range" v-model.number="saturation" min="0" max="200" step="5" class="adjust-slider" />
        <span class="adjust-val">{{ saturation }}%</span>
      </label>
      <button class="adjust-reset" @click="resetAdjust">{{ t('camera.resetAdjust') }}</button>
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

.screenshot-btn {
  background: none;
  border: none;
  color: #888;
  font-size: 14px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.screenshot-btn:hover {
  color: #4ECDC4;
}

.camera-body {
  position: relative;
  background: #0a0a1a;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: pointer;
}

.camera-image {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  transform-origin: center center;
  transition: transform 0.15s ease-out;
}

.zoom-badge {
  background: #4ECDC4;
  color: #1a1a2e;
  border-radius: 10px;
  padding: 1px 7px;
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
}

.camera-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: #444;
  font-size: 13px;
}

.last-seen {
  font-size: 11px;
  color: #666;
  margin-top: -4px;
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

/* FPS 质量徽标 */
.fps-badge {
  position: absolute;
  bottom: 6px;
  right: 6px;
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 10px;
  font-weight: 700;
  font-family: 'Courier New', Courier, monospace;
  pointer-events: none;
  color: #fff;
}

.fps-badge.good {
  background: rgba(76, 175, 80, 0.75);
}

.fps-badge.fair {
  background: rgba(255, 193, 7, 0.8);
  color: #1a1a2e;
}

.fps-badge.poor {
  background: rgba(244, 67, 54, 0.8);
}

/* 数字时钟叠加 */
.name-overlay {
  position: absolute;
  top: 6px;
  left: 6px;
  background: rgba(0, 0, 0, 0.55);
  border-radius: 3px;
  padding: 2px 8px;
  pointer-events: none;
}

.name-text {
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.5);
}

.clock-overlay {
  position: absolute;
  bottom: 6px;
  left: 6px;
  background: rgba(0, 0, 0, 0.55);
  border-radius: 3px;
  padding: 2px 8px;
  pointer-events: none;
}

.clock-text {
  color: #fff;
  font-family: 'Courier New', Courier, monospace;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
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

.adjust-btn {
  background: none;
  border: none;
  color: #888;
  font-size: 14px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.adjust-btn:hover,
.adjust-btn.active {
  color: #4ECDC4;
}

.adjust-panel {
  padding: 6px 12px;
  background: #16213e;
  border-top: 1px solid #2a2a4a;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: center;
}

.adjust-row {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #aaa;
  cursor: pointer;
}

.adjust-label {
  min-width: 36px;
}

.adjust-slider {
  width: 60px;
  height: 3px;
  appearance: none;
  background: #2a2a4a;
  border-radius: 2px;
  outline: none;
}

.adjust-slider::-webkit-slider-thumb {
  appearance: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #4ECDC4;
  cursor: pointer;
}

.adjust-val {
  min-width: 30px;
  text-align: right;
  font-size: 10px;
  color: #888;
}

.adjust-reset {
  background: none;
  border: 1px solid #555;
  color: #888;
  border-radius: 3px;
  padding: 1px 8px;
  font-size: 10px;
  cursor: pointer;
}

.adjust-reset:hover {
  border-color: #4ECDC4;
  color: #4ECDC4;
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
