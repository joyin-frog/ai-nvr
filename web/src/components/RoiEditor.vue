<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { authFetch } from '../services/auth'

const { t } = useI18n()

/** ROI 区域 */
interface RoiRegion {
  id: number
  cameraId: string
  name: string
  /** JSON 字符串 [{x, y}, ...] 归一化 0-1 */
  points: string
  enabled: boolean
}

/** 越线检测线段 */
interface CrossLine {
  id: number
  cameraId: string
  name: string
  start: { x: number; y: number }
  end: { x: number; y: number }
  enabled: boolean
}

const props = defineProps<{
  cameraId: string
  /** 当前摄像头帧图片 URL（用于绘制底图） */
  frameUrl: string
}>()

const regions = ref<RoiRegion[]>([])
const crossLines = ref<CrossLine[]>([])
const loading = ref(false)

/** 通知父组件刷新 ROI / 越线数据 */
const reloadRoi = inject<() => void>('reloadRoi')
const reloadCrossLines = inject<() => void>('reloadCrossLines')

/** 绘制模式：none / polygon / line */
type DrawMode = 'none' | 'polygon' | 'line'
const drawMode = ref<DrawMode>('none')
/** 当前正在绘制的顶点（归一化坐标） */
const currentPoints = ref<Array<{ x: number; y: number }>>([])
/** 新区域/线段名称 */
const newItemName = ref('')

/** 加载 ROI 列表和越线检测线段 */
async function loadRegions() {
  loading.value = true
  try {
    const [roiRes, lineRes] = await Promise.all([
      authFetch(`/api/roi/${props.cameraId}`),
      authFetch(`/api/cross-lines/${props.cameraId}`),
    ])
    if (roiRes.ok) regions.value = await roiRes.json()
    if (lineRes.ok) crossLines.value = await lineRes.json()
  } catch {
    // ignore
  } finally {
    loading.value = false
  }
}

/** 开始绘制多边形区域 */
function startPolygon() {
  drawMode.value = 'polygon'
  currentPoints.value = []
  newItemName.value = t('roi.regionDefault', { n: regions.value.length + 1 })
}

/** 开始绘制越线检测线段 */
function startLine() {
  drawMode.value = 'line'
  currentPoints.value = []
  newItemName.value = `Line ${crossLines.value.length + 1}`
}

/** 取消绘制 */
function cancelDrawing() {
  drawMode.value = 'none'
  currentPoints.value = []
}

/** 撤销最后一个顶点 */
function undoLastPoint() {
  if (drawMode.value !== 'none' && currentPoints.value.length > 0) {
    currentPoints.value.pop()
  }
}

/** 键盘快捷键处理 */
function onKeyDown(e: KeyboardEvent) {
  if (drawMode.value === 'none') return
  if (e.key === 'Enter') {
    e.preventDefault()
    finishDrawing()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancelDrawing()
  } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    undoLastPoint()
  }
}

/** 点击画面添加顶点 */
function onImageClick(e: MouseEvent) {
  if (drawMode.value === 'none') return
  const img = e.currentTarget as HTMLImageElement
  const rect = img.getBoundingClientRect()
  const x = (e.clientX - rect.left) / rect.width
  const y = (e.clientY - rect.top) / rect.height
  currentPoints.value.push({ x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) })
  /** 线段模式：2 个点自动完成 */
  if (drawMode.value === 'line' && currentPoints.value.length === 2) {
    finishDrawing()
  }
}

/** 完成绘制并保存 */
async function finishDrawing() {
  if (drawMode.value === 'polygon' && currentPoints.value.length < 3) return
  if (drawMode.value === 'line' && currentPoints.value.length < 2) return
  try {
    if (drawMode.value === 'polygon') {
      const res = await authFetch('/api/roi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cameraId: props.cameraId,
          name: newItemName.value,
          points: JSON.stringify(currentPoints.value),
        }),
      })
      if (res.ok) {
        drawMode.value = 'none'
        currentPoints.value = []
        loadRegions()
        reloadRoi?.()
      }
    } else if (drawMode.value === 'line') {
      const res = await authFetch('/api/cross-lines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cameraId: props.cameraId,
          name: newItemName.value,
          start: currentPoints.value[0],
          end: currentPoints.value[1],
        }),
      })
      if (res.ok) {
        drawMode.value = 'none'
        currentPoints.value = []
        loadRegions()
        reloadCrossLines?.()
      }
    }
  } catch {
    // ignore
  }
}

/** 切换 ROI 启用/禁用 */
async function toggleRegion(region: RoiRegion) {
  try {
    await authFetch(`/api/roi/item/${region.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !region.enabled }),
    })
    loadRegions()
    reloadRoi?.()
  } catch {
    // ignore
  }
}

/** 删除 ROI */
async function deleteRegion(id: number) {
  try {
    await authFetch(`/api/roi/item/${id}`, { method: 'DELETE' })
    loadRegions()
    reloadRoi?.()
  } catch {
    // ignore
  }
}

/** 切换越线检测线段启用/禁用 */
async function toggleLine(line: CrossLine) {
  try {
    await authFetch(`/api/cross-lines/${line.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !line.enabled }),
    })
    loadRegions()
    reloadCrossLines?.()
  } catch {
    // ignore
  }
}

/** 删除越线检测线段 */
async function deleteLine(id: number) {
  try {
    await authFetch(`/api/cross-lines/${id}`, { method: 'DELETE' })
    loadRegions()
    reloadCrossLines?.()
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

/** 区域 ID → 解析后的顶点（避免模板中重复 parsePoints） */
const regionPointsMap = computed(() => {
  const map = new Map<number, Array<{ x: number; y: number }>>()
  for (const r of regions.value) map.set(r.id, parsePoints(r.points))
  return map
})

/** 线段方向箭头标记 SVG 路径 */
function lineArrowPath(line: CrossLine): string {
  const dx = line.end.x - line.start.x
  const dy = line.end.y - line.start.y
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len < 0.01) return ''
  /** 中点 */
  const mx = (line.start.x + line.end.x) / 2
  const my = (line.start.y + line.end.y) / 2
  /** 单位方向向量 */
  const nx = dx / len
  const ny = dy / len
  /** 箭头大小 */
  const s = 0.02
  /** 箭头三个点：尖端和两翼 */
  const tx = mx + nx * s
  const ty = my + ny * s
  const lx = mx - nx * s * 0.5 - ny * s * 0.5
  const ly = my - ny * s * 0.5 + nx * s * 0.5
  const rx = mx - nx * s * 0.5 + ny * s * 0.5
  const ry = my - ny * s * 0.5 - nx * s * 0.5
  return `M${lx},${ly} L${tx},${ty} L${rx},${ry} Z`
}

onMounted(() => {
  loadRegions()
  window.addEventListener('keydown', onKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
})
</script>

<template>
  <div class="roi-editor">
    <!-- 绘制区域 -->
    <div class="draw-area">
      <div class="draw-header">
        <span class="draw-title">{{ t('roi.title') }}</span>
        <template v-if="drawMode === 'none'">
          <button class="draw-btn" @click="startPolygon">{{ t('roi.addPoint') }}</button>
          <button class="draw-btn line-draw-btn" @click="startLine">+ Line</button>
        </template>
        <template v-else-if="drawMode === 'polygon'">
          <span class="draw-hint">{{ t('roi.drawHint', { count: currentPoints.length }) }}</span>
          <button class="undo-btn" :disabled="currentPoints.length === 0" @click="undoLastPoint">↩</button>
          <button class="save-btn" :disabled="currentPoints.length < 3" @click="finishDrawing">{{ t('roi.save') }}</button>
          <button class="cancel-btn" @click="cancelDrawing">{{ t('settings.cancel') }}</button>
        </template>
        <template v-else-if="drawMode === 'line'">
          <span class="draw-hint">{{ currentPoints.length === 0 ? 'Click start point' : 'Click end point' }}</span>
          <button class="undo-btn" :disabled="currentPoints.length === 0" @click="undoLastPoint">↩</button>
          <button class="save-btn" :disabled="currentPoints.length < 2" @click="finishDrawing">{{ t('roi.save') }}</button>
          <button class="cancel-btn" @click="cancelDrawing">{{ t('settings.cancel') }}</button>
        </template>
      </div>

      <!-- 画面 + 叠加层 -->
      <div class="image-container" v-if="drawMode !== 'none' || regions.length > 0 || crossLines.length > 0">
        <img
          v-if="frameUrl"
          :src="frameUrl"
          class="roi-image"
          @click="onImageClick"
          :class="{ clickable: drawMode !== 'none' }"
          alt=""
        />
        <div v-else class="no-frame">{{ t('camera.noFrame') }}</div>

        <!-- SVG 叠加层 -->
        <svg class="roi-overlay" viewBox="0 0 1 1" preserveAspectRatio="none">
          <!-- 已保存的多边形区域 -->
          <template v-for="region in regions" :key="'r' + region.id">
            <polygon
              v-if="(regionPointsMap.get(region.id)?.length ?? 0) >= 3"
              :points="regionPointsMap.get(region.id)!.map(p => `${p.x},${p.y}`).join(' ')"
              :class="['roi-polygon', { disabled: !region.enabled }]"
            />
          </template>
          <!-- 已保存的越线检测线段 -->
          <template v-for="line in crossLines" :key="'l' + line.id">
            <line
              :x1="line.start.x" :y1="line.start.y"
              :x2="line.end.x" :y2="line.end.y"
              :class="['cross-line', { disabled: !line.enabled }]"
            />
            <path :d="lineArrowPath(line)" :class="['cross-line-arrow', { disabled: !line.enabled }]" />
            <circle :cx="line.start.x" :cy="line.start.y" r="0.01" :class="['cross-line-dot', { disabled: !line.enabled }]" />
            <circle :cx="line.end.x" :cy="line.end.y" r="0.01" :class="['cross-line-dot', { disabled: !line.enabled }]" />
          </template>
          <!-- 当前绘制中的多边形 -->
          <polygon
            v-if="drawMode === 'polygon' && currentPoints.length >= 3"
            :points="currentPoints.map(p => `${p.x},${p.y}`).join(' ')"
            class="roi-polygon drawing"
          />
          <!-- 当前绘制中的线段 -->
          <line
            v-if="drawMode === 'line' && currentPoints.length >= 1"
            :x1="currentPoints[0]!.x" :y1="currentPoints[0]!.y"
            :x2="currentPoints.length >= 2 ? currentPoints[1]!.x : currentPoints[0]!.x"
            :y2="currentPoints.length >= 2 ? currentPoints[1]!.y : currentPoints[0]!.y"
            class="cross-line drawing"
          />
          <template v-for="(p, i) in currentPoints" :key="i">
            <circle :cx="p.x" :cy="p.y" r="0.015" class="roi-vertex" />
          </template>
        </svg>
      </div>
    </div>

    <!-- 区域列表 -->
    <div v-if="regions.length > 0 || crossLines.length > 0" class="region-list">
      <div v-for="region in regions" :key="'r' + region.id" class="region-item">
        <button class="toggle-btn" @click="toggleRegion(region)">
          {{ region.enabled ? '●' : '○' }}
        </button>
        <span class="region-icon region">◇</span>
        <span class="region-name">{{ region.name }}</span>
        <span class="region-vertices">{{ (regionPointsMap.get(region.id)?.length ?? 0) }} {{ t('roi.vertices') }}</span>
        <button class="delete-btn" @click="deleteRegion(region.id)">{{ t('roi.delete') }}</button>
      </div>
      <div v-for="line in crossLines" :key="'l' + line.id" class="region-item">
        <button class="toggle-btn line-toggle" @click="toggleLine(line)">
          {{ line.enabled ? '●' : '○' }}
        </button>
        <span class="region-icon line">╱</span>
        <span class="region-name">{{ line.name }}</span>
        <span class="region-vertices line-label">A→B</span>
        <button class="delete-btn" @click="deleteLine(line.id)">{{ t('roi.delete') }}</button>
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
  flex-wrap: wrap;
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

.line-draw-btn {
  background: #FF6F00;
  margin-left: 4px;
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

.undo-btn {
  background: none;
  border: 1px solid #555;
  color: #aaa;
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 13px;
  cursor: pointer;
}

.undo-btn:disabled { opacity: 0.3; }
.undo-btn:hover:not(:disabled) { color: #e0e0e0; border-color: #888; }

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

/* 越线检测线段样式 */
.cross-line {
  stroke: #FF6F00;
  stroke-width: 0.006;
  stroke-linecap: round;
}

.cross-line.disabled {
  stroke: #555;
}

.cross-line.drawing {
  stroke: #FF6F00;
  stroke-dasharray: 0.02;
}

.cross-line-arrow {
  fill: #FF6F00;
  opacity: 0.9;
}

.cross-line-arrow.disabled {
  fill: #555;
}

.cross-line-dot {
  fill: #FF6F00;
  stroke: #1a1a2e;
  stroke-width: 0.003;
}

.cross-line-dot.disabled {
  fill: #555;
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

.line-toggle {
  color: #FF6F00;
}

.region-icon {
  font-size: 11px;
  width: 14px;
  text-align: center;
}

.region-icon.region {
  color: #4ECDC4;
}

.region-icon.line {
  color: #FF6F00;
}

.region-name {
  color: #e0e0e0;
  font-weight: 500;
}

.region-vertices {
  color: #555;
  font-size: 11px;
}

.region-vertices.line-label {
  color: #FF6F00;
  font-size: 10px;
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
