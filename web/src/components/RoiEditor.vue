<script setup lang="ts">
import { ref, onMounted } from 'vue'

/** ROI 区域 */
interface RoiRegion {
  id: number
  cameraId: string
  name: string
  /** JSON 字符串 [{x, y}, ...] 归一化 0-1 */
  points: string
  enabled: boolean
}

const props = defineProps<{
  cameraId: string
  /** 当前摄像头帧图片 URL（用于绘制底图） */
  frameUrl: string
}>()

const regions = ref<RoiRegion[]>([])
const loading = ref(false)

/** 绘制模式 */
const drawing = ref(false)
/** 当前正在绘制的顶点（归一化坐标） */
const currentPoints = ref<Array<{ x: number; y: number }>>([])
/** 新区域名称 */
const newRegionName = ref('')

/** 加载 ROI 列表 */
async function loadRegions() {
  loading.value = true
  try {
    const res = await fetch(`/api/roi/${props.cameraId}`)
    if (res.ok) regions.value = await res.json()
  } catch {
    // ignore
  } finally {
    loading.value = false
  }
}

/** 开始绘制新区域 */
function startDrawing() {
  drawing.value = true
  currentPoints.value = []
  newRegionName.value = `区域 ${regions.value.length + 1}`
}

/** 取消绘制 */
function cancelDrawing() {
  drawing.value = false
  currentPoints.value = []
}

/** 点击画面添加顶点 */
function onImageClick(e: MouseEvent) {
  if (!drawing.value) return
  const img = e.currentTarget as HTMLImageElement
  const rect = img.getBoundingClientRect()
  const x = (e.clientX - rect.left) / rect.width
  const y = (e.clientY - rect.top) / rect.height
  currentPoints.value.push({ x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) })
}

/** 完成绘制并保存 */
async function finishDrawing() {
  if (currentPoints.value.length < 3) return
  try {
    const res = await fetch('/api/roi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cameraId: props.cameraId,
        name: newRegionName.value,
        points: JSON.stringify(currentPoints.value),
      }),
    })
    if (res.ok) {
      drawing.value = false
      currentPoints.value = []
      loadRegions()
    }
  } catch {
    // ignore
  }
}

/** 切换启用/禁用 */
async function toggleRegion(region: RoiRegion) {
  try {
    await fetch(`/api/roi/item/${region.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !region.enabled }),
    })
    loadRegions()
  } catch {
    // ignore
  }
}

/** 删除区域 */
async function deleteRegion(id: number) {
  try {
    await fetch(`/api/roi/item/${id}`, { method: 'DELETE' })
    loadRegions()
  } catch {
    // ignore
  }
}

/** 解析 points JSON */
function parsePoints(pointsStr: string): Array<{ x: number; y: number }> {
  try {
    return JSON.parse(pointsStr)
  } catch {
    return []
  }
}

onMounted(() => {
  loadRegions()
})
</script>

<template>
  <div class="roi-editor">
    <!-- 绘制区域 -->
    <div class="draw-area">
      <div class="draw-header">
        <span class="draw-title">检测区域</span>
        <button v-if="!drawing" class="draw-btn" @click="startDrawing">+ 绘制区域</button>
        <template v-else>
          <span class="draw-hint">{{ currentPoints.length }} 个顶点（至少3个）</span>
          <button class="save-btn" :disabled="currentPoints.length < 3" @click="finishDrawing">完成</button>
          <button class="cancel-btn" @click="cancelDrawing">取消</button>
        </template>
      </div>

      <!-- 画面 + 多边形叠加 -->
      <div class="image-container" v-if="drawing || regions.length > 0">
        <img
          v-if="frameUrl"
          :src="frameUrl"
          class="roi-image"
          @click="onImageClick"
          :class="{ clickable: drawing }"
          alt=""
        />
        <div v-else class="no-frame">无画面</div>

        <!-- SVG 叠加层 -->
        <svg class="roi-overlay" viewBox="0 0 1 1" preserveAspectRatio="none">
          <!-- 已保存的区域 -->
          <template v-for="region in regions" :key="region.id">
            <polygon
              v-if="parsePoints(region.points).length >= 3"
              :points="parsePoints(region.points).map(p => `${p.x},${p.y}`).join(' ')"
              :class="['roi-polygon', { disabled: !region.enabled }]"
            />
          </template>
          <!-- 当前绘制中的区域 -->
          <polygon
            v-if="currentPoints.length >= 3"
            :points="currentPoints.map(p => `${p.x},${p.y}`).join(' ')"
            class="roi-polygon drawing"
          />
          <template v-for="(p, i) in currentPoints" :key="i">
            <circle :cx="p.x" :cy="p.y" r="0.015" class="roi-vertex" />
          </template>
        </svg>
      </div>
    </div>

    <!-- 区域列表 -->
    <div v-if="regions.length > 0" class="region-list">
      <div v-for="region in regions" :key="region.id" class="region-item">
        <button class="toggle-btn" @click="toggleRegion(region)">
          {{ region.enabled ? '●' : '○' }}
        </button>
        <span class="region-name">{{ region.name }}</span>
        <span class="region-vertices">{{ parsePoints(region.points).length }} 顶点</span>
        <button class="delete-btn" @click="deleteRegion(region.id)">删除</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.roi-editor {
  padding: 8px;
}

.draw-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.draw-title {
  font-size: 13px;
  font-weight: 600;
  color: #e0e0e0;
}

.draw-btn {
  margin-left: auto;
  background: #4ECDC4;
  color: #1a1a2e;
  border: none;
  border-radius: 4px;
  padding: 2px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.draw-hint {
  margin-left: auto;
  font-size: 12px;
  color: #888;
}

.save-btn {
  background: #4ECDC4;
  color: #1a1a2e;
  border: none;
  border-radius: 3px;
  padding: 2px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.save-btn:disabled { opacity: 0.4; }

.cancel-btn {
  background: none;
  border: 1px solid #555;
  color: #888;
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}

.image-container {
  position: relative;
  background: #0a0a1a;
  border-radius: 4px;
  overflow: hidden;
  aspect-ratio: 16 / 9;
}

.roi-image {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.roi-image.clickable {
  cursor: crosshair;
}

.no-frame {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #444;
  font-size: 13px;
}

.roi-overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.roi-polygon {
  fill: rgba(78, 205, 196, 0.2);
  stroke: #4ECDC4;
  stroke-width: 0.005;
}

.roi-polygon.disabled {
  fill: rgba(136, 136, 136, 0.1);
  stroke: #555;
}

.roi-polygon.drawing {
  fill: rgba(78, 205, 196, 0.3);
  stroke: #4ECDC4;
  stroke-width: 0.006;
  stroke-dasharray: 0.02;
}

.roi-vertex {
  fill: #4ECDC4;
  stroke: #1a1a2e;
  stroke-width: 0.003;
}

.region-list {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.region-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 3px;
  font-size: 12px;
}

.region-item:hover {
  background: #2a2a4a;
}

.toggle-btn {
  background: none;
  border: none;
  font-size: 12px;
  cursor: pointer;
  padding: 0;
  color: #4ECDC4;
}

.region-name {
  color: #e0e0e0;
  font-weight: 500;
}

.region-vertices {
  color: #555;
  font-size: 11px;
}

.delete-btn {
  margin-left: auto;
  background: none;
  border: none;
  color: #e74c3c;
  font-size: 11px;
  cursor: pointer;
}

.delete-btn:hover { color: #ff6b6b; }
</style>
