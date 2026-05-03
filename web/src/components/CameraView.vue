<script setup lang="ts">
import { ref, computed, onUnmounted, onMounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Detection } from '../services/events'
import { authFetch } from '../services/auth'
import { useFmp4Stream } from '../composables/useFmp4Stream'
import { takeDetections, getInferMs, takeZoneNotifications, takeMatchSuggestions, getMatchSuggestionForTrack, takeLlmDescription, getTrackFirstSeen, takeRuleRegions, takePatrolStatus, type ZoneNotification } from '../services/ws-detect-cache'
import PtzControl from './PtzControl.vue'
import { usePreferences } from '../composables/usePreferences'
import { registerShortcut } from '../composables/useKeyboard'
import { LABEL_COLORS } from '../services/constants'

const { t } = useI18n()
const { setPref, getPref } = usePreferences()

/** 主色调 → 颜色映射（常量，避免每帧每检测目标重建） */
const DOMINANT_COLOR_MAP: Record<string, string> = {
  red: '#e74c3c', orange: '#e67e22', yellow: '#f1c40f', lime: '#2ecc71',
  green: '#27ae60', cyan: '#1abc9c', blue: '#3498db', purple: '#9b59b6',
  pink: '#e91e63', gray: '#95a5a6',
}
/** 缓存 prefers-reduced-motion（避免每帧 matchMedia 调用） */
const PREFERS_REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const DPR = window.devicePixelRatio || 1
const props = defineProps<{
  cameraId: string
  name: string
  online: boolean
  /** 最后收到帧的时间戳（ms） */
  lastFrameAt: number
  /** 是否支持 PTZ 云台控制 */
  ptz?: boolean
  /** 视频宽度（用于计算画面比例） */
  videoWidth?: number
  /** 视频高度（用于计算画面比例） */
  videoHeight?: number
  /** 实时帧率（从 health API 获取） */
  fps?: number
  /** 帧延迟（ms） */
  latency?: number
  /** 是否正在录像 */
  recording?: boolean
  /** 录像开始时间戳 */
  recordingStart?: number
  /** 是否显示检测框叠加层 */
  showBoxes?: boolean
  /** 追踪标签映射：trackId -> 自定义名称 */
  trackLabels?: Record<number, string>
  /** 是否双流模式 */
  dualStream?: boolean
  /** 检测流帧率 */
  detectFps?: number
  /** ROI 区域列表（归一化坐标多边形） */
  roiRegions?: Array<{ id: number; name: string; points: Array<{ x: number; y: number }> }>
  /** 越线检测线段列表（归一化坐标） */
  crossLines?: Array<{ id: number; name: string; start: { x: number; y: number }; end: { x: number; y: number } }>
  /** 当前是否全屏显示（用于注册缩放快捷键） */
  isFullscreen?: boolean
}>()

const emit = defineEmits<{
  fullscreen: [cameraId: string]
  jumpToRecording: [cameraId: string, timestamp: number]
  jumpToTrack: [trackId: number]
  trackLabelUpdated: []
}>()

/** fMP4/MSE 渲染器（高性能模式，GPU 硬件解码） */
const fmp4CameraId = computed(() => props.cameraId)
const fmp4 = useFmp4Stream(fmp4CameraId)

/** 根元素引用（用于 IntersectionObserver） */
const rootEl = ref<HTMLElement | null>(null)

/** 共享 IntersectionObserver（所有 CameraView 实例共用一个，避免 N 路摄像头创建 N 个 Observer） */
let sharedViewportObserver: IntersectionObserver | null = null
let sharedViewportRefCount = 0
const viewportCallbacks = new Map<Element, (visible: boolean) => void>()

function getSharedViewportObserver(): IntersectionObserver {
  if (!sharedViewportObserver) {
    sharedViewportObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const cb = viewportCallbacks.get(entry.target)
          if (cb) cb(entry.isIntersecting)
        }
      },
      { rootMargin: '100px' },
    )
  }
  return sharedViewportObserver
}

/** 视口可见性管理：不可见时暂停 fMP4 流 + 停止 overlay 绘制节省 CPU */
let isInViewport = true
onMounted(() => {
  const observer = getSharedViewportObserver()
  sharedViewportRefCount++
  const el = rootEl.value
  if (el) {
    viewportCallbacks.set(el, (visible) => {
      isInViewport = visible
      fmp4.setVisible(visible)
      if (visible && props.online) {
        startOverlayLoop()
      } else {
        stopOverlayLoop()
      }
    })
    observer.observe(el)
  }
})

watch(rootEl, (el, oldEl) => {
  const observer = sharedViewportObserver
  if (oldEl && observer) {
    observer.unobserve(oldEl)
    viewportCallbacks.delete(oldEl)
  }
  if (el && observer) {
    viewportCallbacks.set(el, (visible) => {
      isInViewport = visible
      fmp4.setVisible(visible)
      if (visible && props.online) {
        startOverlayLoop()
      } else {
        stopOverlayLoop()
      }
    })
    observer.observe(el)
  }
})

/** MSE 模式的检测框 overlay canvas */
const overlayCanvas = ref<HTMLCanvasElement | null>(null)
/** 缓存的动态层 canvas 2d context（避免每帧 getContext 调用） */
let overlayCtx: CanvasRenderingContext2D | null = null
/** 静态叠加层 canvas（OSD + ROI + 越线 + 热力图 + 区域计数，只在数据变化时重绘） */
const staticCanvasRef = ref<HTMLCanvasElement | null>(null)
/** 缓存的静态层 canvas 2d context */
let staticCtx: CanvasRenderingContext2D | null = null
/** 缓存的 canvas CSS 尺寸（由 ResizeObserver 更新，避免每帧 getBoundingClientRect） */
let cachedCssW = 0
let cachedCssH = 0
let canvasResizeObserver: ResizeObserver | null = null
let overlayVfcId: number | null = null

/** 监听 canvas 元素挂载，设置 ResizeObserver 缓存尺寸 */
watch(overlayCanvas, (canvas) => {
  canvasResizeObserver?.disconnect()
  overlayCtx = null /** canvas 元素变化时重置 context 缓存 */
  if (canvas) {
    cachedCssW = Math.round(canvas.getBoundingClientRect().width)
    cachedCssH = Math.round(canvas.getBoundingClientRect().height)
    canvasResizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) {
        const size = entry.borderBoxSize?.[0] ?? entry.contentRect
        cachedCssW = Math.round(size.inlineSize)
        cachedCssH = Math.round(size.blockSize)
      }
    })
    canvasResizeObserver.observe(canvas)
  }
}, { immediate: true })
/** rAF fallback（浏览器不支持 requestVideoFrameCallback 时使用） */
let overlayRafId: number | null = null
/** 静态层是否需要重绘 */
let staticLayerDirty = true
/** 静态层上次绘制的 canvas 尺寸 */
let staticLayerLastW = 0
let staticLayerLastH = 0
/** 静态层缓存 key（ROI/越线/热力图数据变化时改变） */
let staticLayerLastKey = ''

/** MSE overlay 渲染：优先使用 requestVideoFrameCallback 与视频帧同步 */
function startOverlayLoop() {
  stopOverlayLoop()
  const video = fmp4.videoRef.value
  if (!video) return

  /** 浏览器支持 requestVideoFrameCallback：overlay 与视频帧完美同步 */
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    const onVideoFrame = () => {
      overlayVfcId = video.requestVideoFrameCallback(onVideoFrame)
      drawOverlayOnce()
    }
    overlayVfcId = video.requestVideoFrameCallback(onVideoFrame)
  } else {
    /** 降级：rAF 循环，~60fps */
    let lastDraw = 0
    const INTERVAL = 16
    const draw = () => {
      overlayRafId = requestAnimationFrame(draw)
      const now = performance.now()
      if (now - lastDraw < INTERVAL) return
      lastDraw = now
      drawOverlayOnce()
    }
    draw()
  }
}

/** 静态层的缓存 key（computed 自动缓存，只在依赖变化时重算） */
const staticLayerKey = computed(() => {
  const roiKey = (props.roiRegions ?? []).map(r => `${r.id}:${r.name}`).join(';')
  const lineKey = (props.crossLines ?? []).map(l => `${l.id}:${l.name}`).join(';')
  const hmKey = `${showHeatmap.value}:${heatmapGrid.value.length}:${heatmapMaxCount.value}`
  return `${roiKey}|${lineKey}|${hmKey}`
})

/** 绘制静态层（OSD + ROI + 越线 + 热力图 + 区域计数） */
function drawStaticLayer(cssW: number, cssH: number) {
  const sCanvas = staticCanvasRef.value
  if (!sCanvas) return
  const key = staticLayerKey.value
  /** 尺寸未变且 key 未变 → 跳过重绘 */
  if (!staticLayerDirty && cssW === staticLayerLastW && cssH === staticLayerLastH && key === staticLayerLastKey) return
  staticLayerLastW = cssW
  staticLayerLastH = cssH
  staticLayerLastKey = key
  staticLayerDirty = false

  const dpr = DPR
  const canvasW = Math.round(cssW * dpr)
  const canvasH = Math.round(cssH * dpr)
  if (sCanvas.width !== canvasW || sCanvas.height !== canvasH) {
    sCanvas.width = canvasW
    sCanvas.height = canvasH
  }
  if (!staticCtx) staticCtx = sCanvas.getContext('2d')
  const ctx = staticCtx
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)

  /** 静态 OSD（摄像头名称） */
  drawStaticOSD(ctx, cssW, cssH)

  /** 静态元素（ROI + 越线，使用离屏缓存） */
  const staticCache = drawStaticCache(cssW, cssH)
  ctx.drawImage(staticCache, 0, 0)

  /** 热力图叠加层 */
  if (showHeatmap.value && heatmapGrid.value.length > 0 && heatmapMaxCount.value > 0) {
    const hmCache = drawHeatmapCache(cssW, cssH)
    if (hmCache) ctx.drawImage(hmCache, 0, 0)
  }

  /** ROI 区域内目标计数徽章 */
  if (props.roiRegions && props.roiRegions.length > 0) {
    const sorted = localDetections.length > 0 ? getSortedDetections() : []
    if (sorted.length > 0) {
      ctx.font = 'bold 11px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (const roi of props.roiRegions) {
        if (roi.points.length < 3) continue
        let count = 0
        for (const d of sorted) {
          const cx = (d.box.xmin + d.box.xmax) / 2
          const cy = (d.box.ymin + d.box.ymax) / 2
          if (pointInPoly(cx, cy, roi.points)) count++
        }
        if (count === 0) continue
        const rcx = roi.points.reduce((s, p) => s + p.x, 0) / roi.points.length * cssW
        const rcy = roi.points.reduce((s, p) => s + p.y, 0) / roi.points.length * cssH
        const badgeX = rcx + (roi.name ? ctx.measureText(roi.name).width / 2 + 14 : 0)
        const badgeY = rcy
        ctx.fillStyle = 'rgba(233, 30, 99, 0.9)'
        ctx.beginPath()
        ctx.arc(badgeX, badgeY, 9, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#fff'
        ctx.fillText(String(count), badgeX, badgeY + 1)
      }
      ctx.textAlign = 'start'
      ctx.textBaseline = 'bottom'
    }
  }
}

/** 执行一次 overlay 绘制 */
function drawOverlayOnce() {
  if (document.hidden) return
  const canvas = overlayCanvas.value
  const video = fmp4.videoRef.value
  if (!canvas || !video) return

  /** 使用缓存的 CSS 像素尺寸（由 ResizeObserver 维护，避免每帧强制布局重排） */
  const dpr = DPR
  const cssW = cachedCssW
  const cssH = cachedCssH
  if (cssW === 0 || cssH === 0) return

  const canvasW = Math.round(cssW * dpr)
  const canvasH = Math.round(cssH * dpr)
  if (canvas.width !== canvasW || canvas.height !== canvasH) {
    canvas.width = canvasW
    canvas.height = canvasH
    staticLayerDirty = true
  }

  /** poll 检测结果 */
  const detectResult = takeDetections(props.cameraId, consumedDetectVersion)
  if (detectResult) {
    /** 仅在有 ROI 区域时才需要更新静态层（区域计数徽标依赖检测结果） */
    if (props.roiRegions && props.roiRegions.length > 0) staticLayerDirty = true
    consumedDetectVersion = detectResult.version
    localDetections = detectResult.detections
    updateSmoothedBoxes(localDetections)
    invalidateSortedDetections()
    updateDetectionSummary()
  }

  /** 绘制静态层（OSD + ROI + 越线 + 热力图 + 区域计数） */
  drawStaticLayer(cssW, cssH)

  /** 绘制动态层（时钟 + FPS/延迟/AI指标 + 检测框 + 轨迹 + 通知） */
  if (!overlayCtx) overlayCtx = canvas.getContext('2d')
  const ctx = overlayCtx
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)

  /** 动态 OSD（时钟 + FPS/延迟/AI指标 + 检测摘要，始终显示） */
  drawDynamicOSD(ctx, cssW, cssH)

  if (hasFrame.value && props.showBoxes) {
    drawDynamicOverlay(ctx, cssW, cssH)
  }

  /** LLM 场景描述（AI 分析覆盖层） */
  const llmDesc = takeLlmDescription(props.cameraId)
  if (llmDesc) {
    drawLlmDescription(ctx, cssW, cssH, llmDesc)
  }

  /** AI 巡逻异常状态指示器 */
  const patrol = takePatrolStatus(props.cameraId)
  if (patrol && patrol.status !== 'normal') {
    const color = patrol.status === 'alert' ? 'rgba(231, 76, 60, 0.85)' : 'rgba(243, 156, 18, 0.85)'
    const icon = patrol.status === 'alert' ? '⚠' : '⚡'
    const text = patrol.anomalyDetail || patrol.analysis
    ctx.save()
    ctx.font = 'bold 13px system-ui, sans-serif'
    const maxW = cssW - 16
    const truncated = text.length > 60 ? text.slice(0, 57) + '...' : text
    const tw = ctx.measureText(`${icon} ${truncated}`).width + 16
    const bh = 28
    const bx = 8
    const by = cssH - bh - 8
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.roundRect(bx, by, Math.min(tw, maxW), bh, 4)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.fillText(`${icon} ${truncated}`, bx + 8, by + 18)
    ctx.restore()
  }

  /** AI 巡逻计数标签（右上角，显示人数/车辆数） */
  if (patrol?.count) {
    const parts: string[] = []
    if (patrol.count.person) parts.push(`${patrol.count.person}人`)
    if (patrol.count.vehicle) parts.push(`${patrol.count.vehicle}车`)
    if (parts.length > 0) {
      ctx.save()
      ctx.font = 'bold 12px system-ui, sans-serif'
      const label = parts.join(' ')
      const lw = ctx.measureText(label).width + 12
      const lh = 22
      const lx = cssW - lw - 8
      const ly = 36
      ctx.fillStyle = patrol.status === 'normal' ? 'rgba(78, 205, 196, 0.8)' : 'rgba(231, 76, 60, 0.85)'
      ctx.beginPath()
      ctx.roundRect(lx, ly, lw, lh, 4)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.fillText(label, lx + 6, ly + 15)
      ctx.restore()
    }
  }
}

function stopOverlayLoop() {
  if (overlayVfcId != null) {
    const video = fmp4.videoRef.value
    video?.cancelVideoFrameCallback?.(overlayVfcId)
    overlayVfcId = null
  }
  if (overlayRafId) {
    cancelAnimationFrame(overlayRafId)
    overlayRafId = null
  }
}

/**
 * 追踪目标轨迹缓存
 * 记录每个 trackId 最近的中心点坐标（归一化），用于在 overlay 上绘制轨迹线
 * 最大保留 30 个点（约 60 秒的轨迹，AI interval = 2s）
 */
const MAX_TRAIL_POINTS = 30
const TRAIL_FADE_MS = 3000
const trackTrails = new Map<number, Array<{ x: number; y: number }>>()
/** 消失目标的最后更新时间，用于渐隐 */
const trailFadeStart = new Map<number, number>()

/** 热力图状态 */
const showHeatmap = ref(false)
/** 音频是否静音（默认静音，用户可点击切换） */
const isMuted = ref(true)
/** AI 按需分析中 */
const aiAnalyzing = ref(false)
/** 热力图网格数据 */
const heatmapGrid = ref<number[][]>([])
const heatmapMaxCount = ref(0)
/** 预计算的热力图 hash（避免绘制时遍历所有格子） */
let heatmapDataHash = ''
let heatmapTimer: ReturnType<typeof setInterval> | null = null

/** 加载热力图数据 */
async function loadHeatmap() {
  if (!showHeatmap.value || !props.online) return
  try {
    const res = await authFetch(`/api/tracks/heatmap/${props.cameraId}?cols=40&rows=30`)
    if (!res.ok) return
    const data = await res.json() as { grid: number[][]; maxCount: number; totalPoints: number }
    heatmapGrid.value = data.grid
    heatmapMaxCount.value = data.maxCount
    /** 预计算 hash，避免 drawHeatmapCache 每次遍历所有格子 */
    let nonZeroCount = 0
    let nonZeroSum = 0
    for (const row of data.grid) {
      for (const v of row) {
        if (v > 0) { nonZeroCount++; nonZeroSum += v }
      }
    }
    heatmapDataHash = `${data.maxCount}:${nonZeroCount}:${nonZeroSum}`
    staticLayerDirty = true
  } catch { /* 静默降级 */ }
}

/** 切换热力图显示 */
watch(showHeatmap, (v) => {
  staticLayerDirty = true
  if (v) {
    loadHeatmap()
    heatmapTimer = setInterval(loadHeatmap, 5000)
  } else {
    if (heatmapTimer) { clearInterval(heatmapTimer); heatmapTimer = null }
    heatmapGrid.value = []
    heatmapMaxCount.value = 0
  }
})

/** 记录当前帧中所有检测目标的中心点到轨迹缓存 */
function recordTrails() {
  for (const d of localDetections) {
    if (d.trackId == null) continue
    /** 跳过全图框（CLIP 模式无空间定位） */
    if (d.box.xmax - d.box.xmin > 0.95 && d.box.ymax - d.box.ymin > 0.95) continue
    const cx = (d.box.xmin + d.box.xmax) / 2
    const cy = (d.box.ymin + d.box.ymax) / 2
    let trail = trackTrails.get(d.trackId)
    if (!trail) {
      trail = []
      trackTrails.set(d.trackId, trail)
    }
    trail.push({ x: cx, y: cy })
    if (trail.length > MAX_TRAIL_POINTS) trail.shift()
  }
}

/**
 * 从后端加载历史轨迹，合并到内存中的 trackTrails
 * 摄像头上线时调用一次，获取最近 2 分钟的历史轨迹点
 */
async function loadHistoryTrails() {
  try {
    const res = await authFetch(`/api/tracks/trajectory-camera/${props.cameraId}`)
    if (!res.ok) return
    const data = await res.json() as Array<{ trackId: number; points: Array<{ ts: number; x: number; y: number }> }>
    for (const { trackId, points } of data) {
      if (points.length < 2) continue
      /** 只保留坐标，与实时轨迹格式一致 */
      const coords = points.map(p => ({ x: p.x, y: p.y }))
      /** 与现有轨迹合并（避免重复） */
      const existing = trackTrails.get(trackId)
      if (existing) {
        /** 历史轨迹放前面，实时轨迹放后面 */
        trackTrails.set(trackId, [...coords, ...existing])
      } else {
        trackTrails.set(trackId, coords)
      }
      /** 限制总点数 */
      const trail = trackTrails.get(trackId)!
      if (trail.length > MAX_TRAIL_POINTS * 3) {
        trail.splice(0, trail.length - MAX_TRAIL_POINTS * 3)
      }
    }
  } catch { /* 静默降级 */ }
}

/** 清理不再活跃的轨迹（消失后保留 3 秒渐隐） */
function cleanupTrails() {
  const now = Date.now()
  /** 从当前检测构建活跃 trackId Set，O(1) 查找代替 O(n) some */
  const activeIds = new Set<number>()
  for (const d of localDetections) {
    if (d.trackId != null) activeIds.add(d.trackId)
  }
  for (const id of trackTrails.keys()) {
    if (!activeIds.has(id)) {
      if (!trailFadeStart.has(id)) trailFadeStart.set(id, now)
      if (now - trailFadeStart.get(id)! > TRAIL_FADE_MS) {
        trackTrails.delete(id)
        trailFadeStart.delete(id)
      }
    } else {
      trailFadeStart.delete(id)
    }
  }
}

/** 缓存的排序后检测结果（避免每次绘制重复排序） */
let sortedDetectionsCache: Detection[] = []
let sortedDetectionsDirty = true

/** 消失目标的淡出状态（trackId → 最后位置 + 消失时间） */
const fadeOutBoxes = new Map<number, { box: { xmin: number; ymin: number; xmax: number; ymax: number }; color: string; startTime: number }>()
/** 淡出持续时间 ms */
const FADE_OUT_DURATION = 500

/**
 * 目标快照缩略图缓存
 * 悬停时按需从后端加载 trackId 对应的裁剪快照
 * 最多缓存 50 张（LRU 淘汰），避免内存泄漏
 */
const MAX_SNAPSHOT_CACHE = 50
const trackSnapshotCache = new Map<number, HTMLImageElement | null>()
/** 正在加载中的 trackId 集合（防止重复请求） */
const snapshotLoading = new Set<number>()

/** 按需加载 trackId 的快照缩略图 */
function loadTrackSnapshot(trackId: number) {
  if (trackSnapshotCache.has(trackId) || snapshotLoading.has(trackId)) return
  snapshotLoading.add(trackId)
  const img = new Image()
  img.onload = () => {
    trackSnapshotCache.set(trackId, img)
    snapshotLoading.delete(trackId)
    /** LRU 淘汰 */
    if (trackSnapshotCache.size > MAX_SNAPSHOT_CACHE) {
      const firstKey = trackSnapshotCache.keys().next().value
      if (firstKey != null) trackSnapshotCache.delete(firstKey)
    }
  }
  img.onerror = () => {
    trackSnapshotCache.set(trackId, null)
    snapshotLoading.delete(trackId)
  }
  img.src = `/api/tracks/${trackId}/snapshot`
}

/**
 * 检测框 EMA 平滑 + 速度插值
 * 维护每个 trackId 的当前显示位置，新检测到达时按 EMA 系数平滑过渡
 * 在两次推理之间根据速度向量预测位置，使检测框以视频帧率平滑移动
 */
const SMOOTH_ALPHA = 0.35
const smoothedBoxes = new Map<number, { xmin: number; ymin: number; xmax: number; ymax: number }>()
/** 每个 trackId 的速度向量（归一化坐标/帧） */
const trackVelocities = new Map<number, { dx: number; dy: number }>()
/** 上次推理时间（用于插值时间差计算） */
let lastInferTime = 0
/** 上次推理的平均间隔（用于插值外推） */
let inferInterval = 100

/** 更新平滑框：新检测到达时调用 */
function updateSmoothedBoxes(detections: Detection[]) {
  const now = performance.now()
  /** 更新推理间隔估计 */
  if (lastInferTime > 0) {
    const delta = now - lastInferTime
    if (delta > 10 && delta < 5000) {
      inferInterval = inferInterval * 0.8 + delta * 0.2
    }
  }
  lastInferTime = now

  const activeIds = new Set<number>()
  for (const d of detections) {
    if (d.trackId == null) continue
    activeIds.add(d.trackId)
    /** 目标重新出现，清除淡出状态 */
    fadeOutBoxes.delete(d.trackId)
    /** 记录速度向量 */
    if (d.velocity) {
      trackVelocities.set(d.trackId, d.velocity)
    } else {
      trackVelocities.delete(d.trackId)
    }
    const prev = smoothedBoxes.get(d.trackId)
    if (prev) {
      prev.xmin = prev.xmin + SMOOTH_ALPHA * (d.box.xmin - prev.xmin)
      prev.ymin = prev.ymin + SMOOTH_ALPHA * (d.box.ymin - prev.ymin)
      prev.xmax = prev.xmax + SMOOTH_ALPHA * (d.box.xmax - prev.xmax)
      prev.ymax = prev.ymax + SMOOTH_ALPHA * (d.box.ymax - prev.ymax)
    } else {
      smoothedBoxes.set(d.trackId, { ...d.box })
    }
  }
  /** 已消失的目标移入淡出队列 */
  const fadeNow = Date.now()
  for (const id of smoothedBoxes.keys()) {
    if (!activeIds.has(id)) {
      const box = smoothedBoxes.get(id)!
      const color = getColor('', id)
      fadeOutBoxes.set(id, { box, color: color.stroke, startTime: fadeNow })
      smoothedBoxes.delete(id)
      trackVelocities.delete(id)
    }
  }
  /** 清理过期的淡出目标 */
  for (const [id, state] of fadeOutBoxes) {
    if (fadeNow - state.startTime > FADE_OUT_DURATION) fadeOutBoxes.delete(id)
  }
}

/** 帧级平滑框缓存（每帧开始时 clear，同一帧内同一检测只计算一次） */
let smoothBoxFrameCache = new Map<number, { xmin: number; ymin: number; xmax: number; ymax: number }>()
/** 预计算的速度插值偏移量（每帧一次） */
let velocityShifts = { computed: false, shifts: new Map<number, { sx: number; sy: number }>() }

/** 清空帧级平滑框缓存（每帧绘制开始时调用） */
function resetSmoothBoxCache() {
  smoothBoxFrameCache.clear()
  velocityShifts.computed = false
}

/** 计算所有 track 的速度偏移（每帧只执行一次） */
function ensureVelocityShifts() {
  if (velocityShifts.computed) return
  velocityShifts.computed = true
  velocityShifts.shifts.clear()
  if (lastInferTime === 0) return
  const ratio = Math.min((performance.now() - lastInferTime) / inferInterval, 1)
  for (const [trackId, vel] of trackVelocities) {
    velocityShifts.shifts.set(trackId, { sx: vel.dx * ratio, sy: vel.dy * ratio })
  }
}

/** 获取插值后的检测框（EMA 平滑 + 速度预测），带帧级缓存 */
function getSmoothedBox(d: Detection): { xmin: number; ymin: number; xmax: number; ymax: number } {
  if (d.trackId == null) return d.box
  const cached = smoothBoxFrameCache.get(d.trackId)
  if (cached) return cached
  const smoothed = smoothedBoxes.get(d.trackId)
  if (!smoothed) return d.box

  ensureVelocityShifts()
  const shift = velocityShifts.shifts.get(d.trackId)
  const result = shift
    ? { xmin: smoothed.xmin + shift.sx, ymin: smoothed.ymin + shift.sy, xmax: smoothed.xmax + shift.sx, ymax: smoothed.ymax + shift.sy }
    : smoothed

  smoothBoxFrameCache.set(d.trackId, result)
  return result
}

/** 标记检测结果已更新，需要重新排序 */
function invalidateSortedDetections() {
  sortedDetectionsDirty = true
}

/** 获取排序后的检测列表（带缓存） */
function getSortedDetections(): Detection[] {
  if (sortedDetectionsDirty) {
    sortedDetectionsCache = [...localDetections].sort((a, b) => b.score - a.score)
    sortedDetectionsDirty = false
  }
  return sortedDetectionsCache
}

/** 检测计数（响应式，用于模板徽标和 footer） */
const detectCount = ref(0)
/** 检测计数归零防抖定时器（避免 badge 逐帧闪烁） */
let detectCountZeroTimer: ReturnType<typeof setTimeout> | null = null
const detectionSummary = ref('')

/** 更新检测摘要（在 poll 回调中调用） */
function updateDetectionSummary() {
  const newCount = localDetections.length
  if (newCount > 0) {
    if (detectCountZeroTimer) { clearTimeout(detectCountZeroTimer); detectCountZeroTimer = null }
    detectCount.value = newCount
  } else if (detectCount.value > 0 && !detectCountZeroTimer) {
    /** 归零延迟 2 秒，避免逐帧闪烁 */
    detectCountZeroTimer = setTimeout(() => { detectCountZeroTimer = null; detectCount.value = 0 }, 2000)
  }
  const counts = new Map<string, { count: number; customNames: string[] }>()
  for (const det of localDetections) {
    const entry = counts.get(det.label) ?? { count: 0, customNames: [] }
    entry.count++
    const camLabels = props.trackLabels
    const customName = det.trackId && camLabels?.[det.trackId]
    if (customName && !entry.customNames.includes(customName)) {
      entry.customNames.push(customName)
    }
    counts.set(det.label, entry)
  }
  const parts: string[] = []
  for (const [label, { count, customNames }] of counts) {
    if (customNames.length > 0) {
      parts.push(`${customNames.join(', ')}${count > customNames.length ? ` +${count - customNames.length}` : ''}`)
    } else {
      parts.push(count > 1 ? `${label} ×${count}` : label)
    }
  }
  detectionSummary.value = parts.join(' · ')
  /** 同步更新 AI 推理耗时（响应式，用于模板徽标） */
  localInferMs.value = getInferMs(props.cameraId)
}

/** AI 推理耗时（响应式，用于模板） */
const localInferMs = ref(0)

/** 是否有帧数据 */
const hasFrame = computed(() => props.online)

/** 帧冻结检测：在线但超过 10 秒无新帧 */
const frozen = ref(false)
let frozenTimer: ReturnType<typeof setInterval> | null = null

/** 画中画模式 */
const isPip = ref(false)
async function togglePip() {
  const video = fmp4.videoRef.value
  if (!video) return
  if (document.pictureInPictureElement) {
    await document.exitPictureInPicture()
    return
  }
  try {
    await video.requestPictureInPicture()
    isPip.value = true
    video.addEventListener('leavepictureinpicture', () => { isPip.value = false }, { once: true })
  } catch { /* 浏览器不支持或被阻止 */ }
}
/** fMP4 流首次变为非播放状态的时间 */
let fmp4StallStart = 0

function checkFrozen() {
  if (!props.online) { frozen.value = false; fmp4StallStart = 0; return }
  /** JPEG 帧超时检测 */
  const jpegFrozen = props.lastFrameAt > 0 && (Date.now() - props.lastFrameAt) > 10000
  /** fMP4 流检测：连接但未播放超过 15 秒才判定冻结 */
  const fmp4Connected = fmp4.connected.value
  const fmp4Playing = fmp4.playing.value
  let fmp4Frozen = false
  if (fmp4Connected && !fmp4Playing && fmp4.videoRef.value && fmp4.videoRef.value.readyState >= 2) {
    if (!fmp4StallStart) fmp4StallStart = Date.now()
    fmp4Frozen = (Date.now() - fmp4StallStart) > 15000
  } else {
    fmp4StallStart = 0
  }
  frozen.value = jpegFrozen || fmp4Frozen
}
watch(() => props.online, (on) => {
  if (on) {
    /** 加载历史轨迹（后台静默） */
    loadHistoryTrails()
    /** 热力图上线恢复 */
    if (showHeatmap.value) loadHeatmap()
    /** MSE 模式：仅在未连接时连接（避免 brief offline 时全管道重建） */
    if (!fmp4.connected.value) {
      fmp4.connect()
    }
    nextTick(() => startOverlayLoop())
    if (!frozenTimer) { frozenTimer = setInterval(checkFrozen, 3000); checkFrozen() }
  }
  else {
    /** 离线时不拆除 MSE 管道，让 WS 自行处理断连重连 */
    /** 仅在组件卸载时才真正 disconnect（由 onUnmounted 负责） */
    stopOverlayLoop()
    frozen.value = false
    fmp4StallStart = 0
    if (frozenTimer) { clearInterval(frozenTimer); frozenTimer = null }
  }
}, { immediate: true })

/** 本地检测结果缓存（从 ws-detect-cache poll） */
let localDetections: Detection[] = []
let consumedDetectVersion = 0
watch(() => props.lastFrameAt, () => { if (frozen.value) frozen.value = false })
/** fMP4 恢复播放时清除 frozen 状态 */
watch(() => fmp4.playing.value, (playing) => { if (playing && frozen.value) frozen.value = false })

/** 画面比例：优先用 MSE video 尺寸，回退到 props */
const cameraBodyStyle = computed(() => {
  const fw = fmp4.videoWidth.value || props.videoWidth || 0
  const fh = fmp4.videoHeight.value || props.videoHeight || 0
  if (fw > 0 && fh > 0) {
    return { 'aspect-ratio': `${fw} / ${fh}` }
  }
  return { 'aspect-ratio': '16 / 9' }
})

/**
 * 基于 trackId 生成稳定唯一颜色
 * 使用黄金角（~137.5°）分布色相，确保相邻 ID 差异最大化
 * 无 trackId 时按 label 类别 fallback 到固定色
 */

/** 字符串 hash（用于已命名目标的稳定着色） */
function nameHash(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

/** 解析 HSL/Hex/RGB 颜色字符串为 {r, g, b} */
function parseCssColor(color: string): { r: number; g: number; b: number } {
  /** 尝试 HSL 格式 */
  const hslMatch = color.match(/hsl[a]?\(\s*(\d+)\s*,\s*(\d+)%?\s*,\s*(\d+)%?/)
  if (hslMatch) {
    const [, h, s, l] = hslMatch
    return hslToRgb(Number(h), Number(s), Number(l))
  }
  /** 尝试 Hex 格式 */
  const hexMatch = color.match(/^#([0-9a-f]{6})$/i)
  if (hexMatch) {
    const hex = hexMatch[1]!
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) }
  }
  return { r: 128, g: 128, b: 128 }
}

/** HSL → RGB 转换 */
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  s /= 100
  l /= 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) }
}

/** parseCssColor 缓存（颜色字符串通常只有几种，避免每帧 regex） */
const _parsedColorCache = new Map<string, { r: number; g: number; b: number }>()
function cachedParseCssColor(color: string): { r: number; g: number; b: number } {
  const cached = _parsedColorCache.get(color)
  if (cached) return cached
  const parsed = parseCssColor(color)
  _parsedColorCache.set(color, parsed)
  return parsed
}

/** 在两个 CSS 颜色之间线性插值，t=0 返回 a，t=1 返回 b（带颜色解析缓存） */
function lerpColor(a: string, b: string, t: number): string {
  const ca = cachedParseCssColor(a)
  const cb = cachedParseCssColor(b)
  const r = Math.round(ca.r + (cb.r - ca.r) * t)
  const g = Math.round(ca.g + (cb.g - ca.g) * t)
  const bl = Math.round(ca.b + (cb.b - ca.b) * t)
  return `rgb(${r},${g},${bl})`
}

/** 颜色缓存（避免每帧对相同 trackId/name 重复生成 HSL 字符串） */
const MAX_COLOR_CACHE = 200
const colorCache = new Map<string, { stroke: string; fill: string }>()

/** 根据 trackId + label + customName 获取颜色（同名目标同色，带缓存） */
function getColor(label: string, trackId?: number, customName?: string): { stroke: string; fill: string } {
  const key = customName ? `n:${customName}` : trackId != null ? `t:${trackId}` : `l:${label}`
  const cached = colorCache.get(key)
  if (cached) return cached
  let result: { stroke: string; fill: string }
  if (customName) {
    const hue = nameHash(customName) % 360
    result = { stroke: `hsl(${hue}, 75%, 60%)`, fill: `hsla(${hue}, 75%, 60%, 0.12)` }
  } else if (trackId != null) {
    const hue = (trackId * 137.508) % 360
    result = { stroke: `hsl(${hue}, 75%, 60%)`, fill: `hsla(${hue}, 75%, 60%, 0.12)` }
  } else {
    const hex = LABEL_COLORS[label] ?? '#4ECDC4'
    result = { stroke: hex, fill: hex + '1F' }
  }
  if (colorCache.size >= MAX_COLOR_CACHE) {
    /** 删除最早插入的条目（Map 保持插入顺序） */
    const firstKey = colorCache.keys().next().value
    if (firstKey !== undefined) colorCache.delete(firstKey)
  }
  colorCache.set(key, result)
  return result
}

/** Canvas overlay 绘制 OSD（摄像头名称 + 时钟 + FPS/延迟/AI指标） */
/** LLM 描述换行缓存（避免每帧字符级 measureText） */
let llmWrapCacheKey = ''
let llmWrapCacheWidth = 0
let llmWrapCacheLines: string[] = []

/** 绘制 LLM 场景描述（左下角半透明条） */
function drawLlmDescription(ctx: CanvasRenderingContext2D, width: number, height: number, desc: string) {
  ctx.save()
  const fontSize = 12
  ctx.font = `${fontSize}px sans-serif`
  ctx.textBaseline = 'bottom'

  /** 自动换行（缓存结果，文本和宽度不变时跳过重算） */
  const maxLineWidth = width - 16
  if (desc !== llmWrapCacheKey || maxLineWidth !== llmWrapCacheWidth) {
    llmWrapCacheKey = desc
    llmWrapCacheWidth = maxLineWidth
    const lines: string[] = []
    let currentLine = ''
    for (const ch of desc) {
      const testLine = currentLine + ch
      if (ctx.measureText(testLine).width > maxLineWidth) {
        if (currentLine) lines.push(currentLine)
        currentLine = ch
      } else {
        currentLine = testLine
      }
    }
    if (currentLine) lines.push(currentLine)
    llmWrapCacheLines = lines.slice(0, 3)
  }
  const displayLines = llmWrapCacheLines

  const lineHeight = fontSize + 4
  const pad = 6
  const boxH = displayLines.length * lineHeight + pad * 2
  const boxY = height - 26 - boxH - 4

  ctx.fillStyle = 'rgba(156, 39, 176, 0.7)'
  ctx.fillRect(4, boxY, width - 8, boxH)

  ctx.fillStyle = '#fff'
  for (let i = 0; i < displayLines.length; i++) {
    ctx.fillText(displayLines[i]!, 4 + pad, boxY + pad + (i + 1) * lineHeight - 4)
  }
  ctx.restore()
}

/** 绘制静态 OSD（摄像头名称，几乎不变） */
function drawStaticOSD(ctx: CanvasRenderingContext2D, width: number, _height: number) {
  ctx.save()
  if (props.name) {
    ctx.font = 'bold 13px monospace'
    ctx.textBaseline = 'top'
    const nm = ctx.measureText(props.name)
    const pad = 4
    ctx.fillStyle = 'rgba(0,0,0,0.5)'
    ctx.fillRect(4, 4, nm.width + pad * 2, 18)
    ctx.fillStyle = '#fff'
    ctx.fillText(props.name, 4 + pad, 6)
  }
  ctx.restore()
}

/** 绘制动态 OSD（FPS/延迟/AI指标 + 检测摘要，频繁变化） */
function drawDynamicOSD(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.save()

  /** 右下角：渲染FPS + 源FPS + 延迟 + AI耗时 + 分辨率 指标栏 */
  const stats: Array<{ text: string; color: string }> = []
  /** fMP4 segment FPS */
  const renderFps = fmp4.fps.value
  const srcFps = props.fps ?? 0
  if (renderFps > 0 || srcFps > 0) {
    /** 显示渲染帧率（实际到达屏幕的帧率），如果和源帧率不同则同时显示 */
    const displayFps = renderFps > 0 ? renderFps : srcFps
    const fpsColor = displayFps >= 15 ? '#4CAF50' : displayFps >= 10 ? '#FFC107' : '#F44336'
    const label = srcFps > 0 && renderFps > 0 && Math.abs(renderFps - srcFps) > 2
      ? `${renderFps.toFixed(0)}/${srcFps.toFixed(0)}fps`
      : `${displayFps.toFixed(0)}fps`
    stats.push({ text: label, color: fpsColor })
  }
  const latency = props.latency ?? 0
  if (latency > 0) {
    const latColor = latency <= 200 ? '#4CAF50' : latency <= 500 ? '#FFC107' : '#F44336'
    const latText = latency < 1000 ? `${latency.toFixed(0)}ms` : `${(latency / 1000).toFixed(1)}s`
    stats.push({ text: latText, color: latColor })
  }
  if (localInferMs.value > 0) {
    stats.push({ text: `AI ${localInferMs.value.toFixed(0)}ms`, color: '#9C27B0' })
  }
  /** fMP4 视频分辨率 */
  const w = fmp4.videoWidth.value || 0
  const h = fmp4.videoHeight.value || 0
  if (w > 0 && h > 0) {
    stats.push({ text: `${w}x${h}`, color: '#888' })
  }

  if (stats.length > 0) {
    ctx.font = '10px monospace'
    ctx.textBaseline = 'bottom'
    const pad = 4
    /** 一次 measureText 缓存宽度，避免二次重复测量 */
    const statWidths = stats.map(s => ctx.measureText(s.text).width + pad * 2)
    let totalWidth = statWidths.reduce((sum, w) => sum + w + 4, 0) - 4
    const boxX = width - totalWidth - 4
    const boxY = height - 4

    let x = boxX
    for (let i = 0; i < stats.length; i++) {
      const tw = statWidths[i]!
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.fillRect(x, boxY - 16, tw, 16)
      ctx.fillStyle = stats[i]!.color
      ctx.fillText(stats[i]!.text, x + pad, boxY - 3)
      x += tw + 4
    }
  }

  /** 右上角：检测目标摘要（如 "张三 · 李四 +1 · car"） */
  const summary = detectionSummary.value
  if (summary && props.showBoxes !== false) {
    ctx.font = 'bold 11px monospace'
    ctx.textBaseline = 'top'
    const pad = 5
    const sm = ctx.measureText(summary)
    const smW = sm.width + pad * 2
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(width - smW - 4, 4, smW, 18)
    ctx.fillStyle = '#4ECDC4'
    ctx.fillText(summary, width - smW - 4 + pad, 8)
  }

  ctx.restore()
}

/** 静态元素（ROI + 越线）离屏缓存 */
let staticCacheCanvas: OffscreenCanvas | null = null
let staticCacheW = 0
let staticCacheH = 0
let staticCacheKey = ''

/** 热力图缓存（OffscreenCanvas，只在数据变化时重绘） */
let heatmapCacheCanvas: OffscreenCanvas | null = null
let heatmapCacheW = 0
let heatmapCacheH = 0
let heatmapCacheKey = ''

/** 计算静态元素的缓存 key（props 变化时 key 改变触发重绘） */
function computeStaticCacheKey(): string {
  const roiKey = (props.roiRegions ?? []).map(r => `${r.id}:${r.name}:${r.points.map(p => `${p.x},${p.y}`).join('|')}`).join(';')
  const lineKey = (props.crossLines ?? []).map(l => `${l.id}:${l.name}:${l.start.x},${l.start.y}-${l.end.x},${l.end.y}`).join(';')
  return `${roiKey}|${lineKey}`
}

/** 绘制静态元素到离屏 Canvas */
function drawStaticCache(width: number, height: number): OffscreenCanvas {
  const key = computeStaticCacheKey()
  if (staticCacheCanvas && staticCacheW === width && staticCacheH === height && staticCacheKey === key) {
    return staticCacheCanvas
  }
  const oc = new OffscreenCanvas(width, height)
  const sctx = oc.getContext('2d')!
  /** 绘制 ROI 区域 */
  if (props.roiRegions && props.roiRegions.length > 0) {
    sctx.lineWidth = 1.5
    sctx.setLineDash([6, 4])
    for (const roi of props.roiRegions) {
      if (roi.points.length < 3) continue
      sctx.strokeStyle = 'rgba(156, 39, 176, 0.7)'
      sctx.fillStyle = 'rgba(156, 39, 176, 0.08)'
      sctx.beginPath()
      sctx.moveTo(roi.points[0]!.x * width, roi.points[0]!.y * height)
      for (let i = 1; i < roi.points.length; i++) {
        sctx.lineTo(roi.points[i]!.x * width, roi.points[i]!.y * height)
      }
      sctx.closePath()
      sctx.fill()
      sctx.stroke()
      if (roi.name) {
        const cx = roi.points.reduce((s, p) => s + p.x, 0) / roi.points.length * width
        const cy = roi.points.reduce((s, p) => s + p.y, 0) / roi.points.length * height
        sctx.setLineDash([])
        sctx.font = 'bold 10px sans-serif'
        sctx.fillStyle = 'rgba(156, 39, 176, 0.9)'
        sctx.textAlign = 'center'
        sctx.fillText(roi.name, cx, cy)
        sctx.textAlign = 'start'
        sctx.setLineDash([6, 4])
      }
    }
    sctx.setLineDash([])
  }
  /** 绘制越线检测线段 */
  if (props.crossLines && props.crossLines.length > 0) {
    sctx.lineWidth = 2
    sctx.setLineDash([4, 3])
    for (const line of props.crossLines) {
      const sx = line.start.x * width
      const sy = line.start.y * height
      const ex = line.end.x * width
      const ey = line.end.y * height
      sctx.strokeStyle = 'rgba(255, 111, 0, 0.7)'
      sctx.beginPath()
      sctx.moveTo(sx, sy)
      sctx.lineTo(ex, ey)
      sctx.stroke()
      sctx.fillStyle = 'rgba(255, 111, 0, 0.9)'
      sctx.beginPath()
      sctx.arc(sx, sy, 3, 0, Math.PI * 2)
      sctx.fill()
      sctx.beginPath()
      sctx.arc(ex, ey, 3, 0, Math.PI * 2)
      sctx.fill()
      const dx = ex - sx
      const dy = ey - sy
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len > 0) {
        const mx = (sx + ex) / 2
        const my = (sy + ey) / 2
        const nx = dx / len
        const ny = dy / len
        const arrowSize = 6
        const tx = mx + nx * arrowSize
        const ty = my + ny * arrowSize
        const lx = mx - nx * arrowSize * 0.5 - ny * arrowSize * 0.4
        const ly = my - ny * arrowSize * 0.5 + nx * arrowSize * 0.4
        const rx = mx - nx * arrowSize * 0.5 + ny * arrowSize * 0.4
        const ry = my - ny * arrowSize * 0.5 - nx * arrowSize * 0.4
        sctx.setLineDash([])
        sctx.fillStyle = 'rgba(255, 111, 0, 0.9)'
        sctx.beginPath()
        sctx.moveTo(lx, ly)
        sctx.lineTo(tx, ty)
        sctx.lineTo(rx, ry)
        sctx.closePath()
        sctx.fill()
        sctx.setLineDash([4, 3])
      }
      if (line.name) {
        sctx.setLineDash([])
        sctx.font = 'bold 9px sans-serif'
        sctx.fillStyle = 'rgba(255, 111, 0, 0.9)'
        sctx.textAlign = 'center'
        const labelY = Math.min(sy, ey) - 6
        const labelX = (sx + ex) / 2
        sctx.fillText(line.name, labelX, labelY)
        sctx.textAlign = 'start'
        sctx.setLineDash([4, 3])
      }
    }
    sctx.setLineDash([])
  }
  staticCacheCanvas = oc
  staticCacheW = width
  staticCacheH = height
  staticCacheKey = key
  return oc
}

/** 绘制热力图到缓存（只在数据变化时重绘） */
function drawHeatmapCache(width: number, height: number): OffscreenCanvas | null {
  const grid = heatmapGrid.value
  const maxCount = heatmapMaxCount.value
  if (!grid.length || !maxCount) return null

  const gridRows = grid.length
  const gridCols = grid[0]?.length ?? 0
  if (!gridRows || !gridCols) return null

  /** 使用预计算的 hash 作为缓存 key（避免绘制时遍历所有格子） */
  const key = `${width}:${height}:${heatmapDataHash}`
  if (heatmapCacheCanvas && heatmapCacheW === width && heatmapCacheH === height && heatmapCacheKey === key) {
    return heatmapCacheCanvas
  }

  const oc = new OffscreenCanvas(width, height)
  const ctx = oc.getContext('2d')
  if (!ctx) return null

  const cellW = width / gridCols
  const cellH = height / gridRows
  ctx.globalAlpha = 0.35
  for (let row = 0; row < gridRows; row++) {
    for (let col = 0; col < gridCols; col++) {
      const count = grid[row]?.[col] ?? 0
      if (count === 0) continue
      const intensity = count / maxCount
      let r: number, g: number, b: number
      if (intensity < 0.33) {
        const t = intensity / 0.33
        r = 0; g = Math.round(t * 255); b = Math.round((1 - t) * 255)
      } else if (intensity < 0.66) {
        const t = (intensity - 0.33) / 0.33
        r = Math.round(t * 255); g = 255; b = 0
      } else {
        const t = (intensity - 0.66) / 0.34
        r = 255; g = Math.round((1 - t) * 255); b = 0
      }
      const cx = (col + 0.5) * cellW
      const cy = (row + 0.5) * cellH
      const radius = Math.max(cellW, cellH) * (0.6 + intensity * 0.8)
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
      gradient.addColorStop(0, `rgba(${r},${g},${b},0.8)`)
      gradient.addColorStop(1, `rgba(${r},${g},${b},0)`)
      ctx.fillStyle = gradient
      ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2)
    }
  }

  heatmapCacheCanvas = oc
  heatmapCacheW = width
  heatmapCacheH = height
  heatmapCacheKey = key
  return oc
}

/** Canvas overlay 绘制检测框 + OSD */
function drawDynamicOverlay(ctx: CanvasRenderingContext2D, width: number, height: number) {
  if (!hasFrame.value) {
    trackTrails.clear()
    return
  }

  if (!props.showBoxes) {
    trackTrails.clear()
    return
  }

  /** 清空帧级平滑框缓存 */
  resetSmoothBoxCache()

  /** 记录轨迹 + 清理失效轨迹 */
  recordTrails()
  cleanupTrails()

  /** 帧级统一时间戳（避免多次 Date.now 系统调用） */
  const now = Date.now()
  const nowPerf = performance.now()

  const sorted = getSortedDetections()

  /** 绘制区域事件浮动通知（即使没有检测框也要显示） */
  const notifications = takeZoneNotifications(props.cameraId)
  if (notifications.length > 0) {
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let i = 0; i < notifications.length; i++) {
      const n = notifications[i]!
      const age = now - n.timestamp
      const alpha = Math.max(0, 1 - age / 3000)
      if (alpha <= 0) continue
      const nx = width / 2
      const ny = height * 0.25 + i * 24
      const arrow = n.type === 'enter' ? '→' : n.type === 'leave' ? '←' : n.type === 'line-cross' ? '⚡' : n.type === 'loiter' ? '↻' : n.type === 'approach' ? '⊕' : '⏳'
      const directionText = n.direction ? ` ${n.direction}` : ''
      const dwellText = n.dwellMs ? ` ${(n.dwellMs / 1000).toFixed(0)}s` : ''
      const text = n.type === 'approach' ? `${arrow} ${n.name} → ${n.zoneName}` : `${arrow} ${n.name} ${n.zoneName}${directionText}${dwellText}`
      ctx.font = 'bold 12px sans-serif'
      const tm = ctx.measureText(text)
      const pad = 6
      ctx.globalAlpha = alpha * 0.85
      ctx.fillStyle = n.type === 'enter' ? 'rgba(0, 150, 136, 0.9)' : n.type === 'leave' ? 'rgba(156, 39, 176, 0.9)' : n.type === 'line-cross' ? 'rgba(255, 111, 0, 0.9)' : n.type === 'loiter' ? 'rgba(121, 85, 72, 0.9)' : n.type === 'approach' ? 'rgba(233, 30, 99, 0.9)' : 'rgba(255, 152, 0, 0.9)'
      ctx.beginPath()
      ctx.roundRect(nx - tm.width / 2 - pad, ny - 10, tm.width + pad * 2, 20, 4)
      ctx.fill()
      ctx.globalAlpha = alpha
      ctx.fillStyle = '#fff'
      ctx.fillText(text, nx, ny)
      ctx.globalAlpha = 1
    }
    ctx.textAlign = 'start'
    ctx.textBaseline = 'bottom'
  }

  /** 绘制消失目标的淡出框（即使无活跃目标也需要绘制） */
  if (fadeOutBoxes.size > 0) {
    for (const [id, state] of fadeOutBoxes) {
      const elapsed = now - state.startTime
      const alpha = Math.max(0, 1 - elapsed / FADE_OUT_DURATION)
      if (alpha <= 0) continue
      const { box, color } = state
      const x = box.xmin * width
      const y = box.ymin * height
      const w = (box.xmax - box.xmin) * width
      const h = (box.ymax - box.ymin) * height
      ctx.globalAlpha = alpha * 0.6
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      const r = Math.min(4, w / 4, h / 4)
      ctx.roundRect(x, y, w, h, r)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    ctx.setLineDash([])
  }

  if (sorted.length === 0) return

  /** 动画脉冲因子（用于未命名目标边框闪烁），减少动画模式下不闪烁 */
  const reduceMotion = PREFERS_REDUCED_MOTION
  const pulse = reduceMotion ? 0.8 : 0.5 + 0.5 * Math.sin(nowPerf / 500)

  ctx.save()
  const FONT_LABEL = 'bold 12px monospace'
  const FONT_SMALL = '11px sans-serif'
  ctx.font = FONT_LABEL
  ctx.textBaseline = 'bottom'

  /** 获取外观匹配建议 */
  const suggestions = takeMatchSuggestions(props.cameraId)
  const suggestMap = new Map<number, string>()
  for (const s of suggestions) {
    if (s.matches.length > 0) {
      const best = s.matches[0]!
      const pct = ((1 - best.distance) * 100).toFixed(0)
      suggestMap.set(s.trackId, `${best.customName} ${pct}%`)
    }
  }

  for (const d of sorted) {
    /** CLIP 全图分类：box 覆盖 ≥95% 画面时不画框（仅右上角标签栏显示） */
    const boxW = d.box.xmax - d.box.xmin
    const boxH = d.box.ymax - d.box.ymin
    if (boxW > 0.95 && boxH > 0.95) continue

    const tid = d.trackId
    const customName = tid ? props.trackLabels?.[tid] : undefined
    const isNamed = !!customName
    const { stroke, fill } = getColor(d.label, d.trackId, customName)

    /** 停留时间警告渐变：30s 后颜色从原始向橙色过渡，120s 后向红色过渡 */
    let dwellSec = 0
    let dwellColorShift = 0
    if (tid) {
      const firstSeen = getTrackFirstSeen(tid)
      if (firstSeen) {
        dwellSec = (now - firstSeen) / 1000
        if (dwellSec > 30) {
          dwellColorShift = dwellSec > 120 ? 1 : (dwellSec - 30) / 90
        }
      }
    }

    /** 根据停留时间混合边框颜色：正常 → 橙色(#e67e22) → 红色(#e74c3c) */
    let effectiveStroke = stroke
    let effectiveFill = fill
    let effectiveLineWidth = isHovered ? 3.5 : isNamed ? 2.5 : 1.5
    if (dwellColorShift > 0) {
      const warnColor = dwellColorShift >= 1 ? '#e74c3c' : '#e67e22'
      const warnFill = dwellColorShift >= 1 ? 'rgba(231,76,60,0.12)' : 'rgba(230,126,34,0.12)'
      effectiveStroke = lerpColor(stroke, warnColor, Math.min(dwellColorShift, 1))
      effectiveFill = warnFill
      effectiveLineWidth = Math.max(effectiveLineWidth, 2 + dwellColorShift)
      /** 长时间停留时脉冲透明度更明显 */
      if (dwellColorShift >= 1) {
        ctx.globalAlpha = 0.7 + 0.3 * pulse
      }
    }

    const box = getSmoothedBox(d)
    const x = box.xmin * width
    const y = box.ymin * height
    const w = (box.xmax - box.xmin) * width
    const h = (box.ymax - box.ymin) * height

    /** 已命名目标：粗边框 + 实线；未命名目标：细边框 + 虚线 + 脉冲透明度 */
    const isHovered = tid != null && hoveredTrackId.value === tid
    ctx.setLineDash(isNamed ? [] : [8, 4])
    ctx.lineWidth = effectiveLineWidth
    if (dwellColorShift === 0) {
      ctx.globalAlpha = isNamed || isHovered ? 1 : (0.5 + 0.5 * pulse)
    }

    /** 绘制圆角矩形框 + 半透明填充 */
    const r = Math.min(4, w / 4, h / 4)
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, r)

    ctx.fillStyle = effectiveFill
    ctx.fill()
    ctx.strokeStyle = effectiveStroke
    ctx.stroke()

    ctx.setLineDash([])
    ctx.globalAlpha = 1

    /** 绘制标签背景和文字 */
    /** 有自定义名称时简化显示（名称 + 置信度），无名称时显示完整信息 + 右键提示 */
    /** semanticLabel（CLIP 分类）优先于原始 label，去掉 "a " 前缀使标签更紧凑 */
    const rawSemantic = d.semanticLabel || d.label
    const displayLabel = rawSemantic.startsWith('a ') ? rawSemantic.slice(2) : rawSemantic
    /** 停留时间后缀（超过 5 秒才显示，复用上方已计算的 dwellSec） */
    let dwellSuffix = ''
    if (tid && dwellSec >= 5) {
      dwellSuffix = dwellSec < 60 ? ` ${Math.round(dwellSec)}s` : ` ${Math.floor(dwellSec / 60)}m${Math.round(dwellSec % 60)}s`
    }
    /** 姿态标签（紧凑显示在标签末尾） */
    const poseTag = d.pose ? ` ${d.pose}` : ''
    const text = customName
      ? `${customName}${poseTag} ${(d.score * 100).toFixed(0)}%${dwellSuffix}`
      : `${tid ? `#${tid} ` : ''}${displayLabel}${poseTag} ${(d.score * 100).toFixed(0)}%${dwellSuffix}`

    const textMetrics = ctx.measureText(text)
    const labelH = 18
    const labelY = y > labelH + 2 ? y - 2 : y + h + labelH + 2
    const labelW = textMetrics.width + 10

    /** 标签背景：圆角 + 不透明填充 */
    ctx.beginPath()
    ctx.roundRect(x, labelY - labelH, labelW, labelH, 2)
    ctx.fillStyle = effectiveStroke
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.fillText(text, x + 5, labelY - 4)

    /** 绘制主色调圆点 */
    if (d.dominantColor) {
      const dotColor = DOMINANT_COLOR_MAP[d.dominantColor]
      if (dotColor) {
        const dotR = 4
        const dotX = x + labelW + dotR + 2
        const dotY = labelY - labelH / 2
        ctx.beginPath()
        ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2)
        ctx.fillStyle = dotColor
        ctx.fill()
        ctx.strokeStyle = 'rgba(255,255,255,0.6)'
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }

    /** 绘制匹配建议提示（未命名目标有匹配时） */
    if (tid && !isNamed) {
      const suggest = suggestMap.get(tid)
      if (suggest) {
        const sugY = y > labelH * 2 + 4 ? labelY - labelH - 2 : y + h + 2
        ctx.font = FONT_SMALL
        const sugTm = ctx.measureText(`≈ ${suggest}`)
        const sugW = sugTm.width + 8
        ctx.fillStyle = 'rgba(233, 30, 99, 0.85)'
        ctx.beginPath()
        ctx.roundRect(x, sugY - 16, sugW, 16, 3)
        ctx.fill()
        ctx.fillStyle = '#fff'
        ctx.fillText(`≈ ${suggest}`, x + 4, sugY - 3)
        ctx.font = FONT_LABEL
      }
    }

    /** 悬停详情 tooltip */
    if (isHovered && tid != null) {
      ctx.font = FONT_SMALL
      const lines: string[] = []
      lines.push(`${d.label} #${tid}`)
      if (d.semanticLabel) lines.push(`语义: ${d.semanticLabel}`)
      if (customName) lines.push(`名称: ${customName}`)
      lines.push(`置信度: ${(d.score * 100).toFixed(0)}%`)
      if (d.dominantColor) lines.push(`\0color:${d.dominantColor}`)
      if (d.pose) lines.push(`姿态: ${d.pose}`)
      if (d.velocity) {
        const speed = Math.sqrt(d.velocity.dx * d.velocity.dx + d.velocity.dy * d.velocity.dy)
        if (speed > 0.001) lines.push(`速度: ${(speed * 1000).toFixed(1)}/ks`)
      }
      /** 停留时间 */
      if (tid) {
        const firstSeen = getTrackFirstSeen(tid)
        if (firstSeen) {
          const dwellSec = (now - firstSeen) / 1000
          if (dwellSec >= 3) {
            lines.push(`停留: ${dwellSec < 60 ? Math.round(dwellSec) + 's' : `${Math.floor(dwellSec / 60)}m${Math.round(dwellSec % 60)}s`}`)
          }
        }
      }
      /** 未命名目标显示匹配建议 + 命名提示 */
      if (!isNamed && tid) {
        const suggest = suggestMap.get(tid)
        if (suggest) lines.push(`≈ ${suggest}`)
        lines.push(t('camera.doubleClickToName', '双击命名'))
      }
      const tipX = x + w + 4
      const tipY = y
      const tipPad = 6
      const lineH = 15
      let maxLineW = 0
      for (const line of lines) {
        /** 颜色行：圆点 14px + 颜色名文字宽度 */
        const lw = line.startsWith('\0color:')
          ? 14 + ctx.measureText(line.slice(7)).width
          : ctx.measureText(line).width
        if (lw > maxLineW) maxLineW = lw
      }
      /** 缩略图尺寸 */
      const thumbSize = 48
      const thumbGap = 6
      const snapshotImg = tid != null ? (trackSnapshotCache.get(tid) ?? undefined) : undefined
      const hasSnapshot = snapshotImg != null && snapshotImg.width > 0
      const textW = maxLineW + tipPad * 2
      const thumbTotal = hasSnapshot ? thumbSize + thumbGap : 0
      const tipW = textW + thumbTotal
      const tipH = Math.max(lines.length * lineH + tipPad * 2, hasSnapshot ? thumbSize + tipPad * 2 : 0)
      /** 如果超出右边界，放到左侧 */
      const finalX = tipX + tipW > width ? x - tipW - 4 : tipX
      const finalY = Math.min(tipY, height - tipH - 4)

      ctx.fillStyle = 'rgba(0, 0, 0, 0.85)'
      ctx.beginPath()
      ctx.roundRect(finalX, finalY, tipW, tipH, 4)
      ctx.fill()
      /** 左边框高亮色 */
      ctx.fillStyle = stroke
      ctx.fillRect(finalX, finalY + 4, 2, tipH - 8)

      ctx.fillStyle = '#fff'
      ctx.textBaseline = 'top'
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li]!
        /** 特殊行：主色调圆点 */
        if (line.startsWith('\0color:')) {
          const colorName = line.slice(7)
          const dotColor = DOMINANT_COLOR_MAP[colorName] ?? '#666'
          const dotY = finalY + tipPad + li * lineH + 7
          ctx.beginPath()
          ctx.arc(finalX + tipPad + 5, dotY, 5, 0, Math.PI * 2)
          ctx.fillStyle = dotColor
          ctx.fill()
          ctx.strokeStyle = 'rgba(255,255,255,0.6)'
          ctx.lineWidth = 1
          ctx.stroke()
          ctx.fillStyle = '#fff'
          ctx.fillText(colorName, finalX + tipPad + 14, finalY + tipPad + li * lineH)
        } else {
          ctx.fillText(line, finalX + tipPad, finalY + tipPad + li * lineH)
        }
      }
      ctx.textBaseline = 'bottom'
      ctx.font = FONT_LABEL
      /** 绘制缩略图（右侧垂直居中） */
      if (hasSnapshot && snapshotImg) {
        const thumbX = finalX + textW + thumbGap / 2
        const thumbY = finalY + (tipH - thumbSize) / 2
        ctx.save()
        ctx.beginPath()
        ctx.roundRect(thumbX, thumbY, thumbSize, thumbSize, 3)
        ctx.clip()
        /** 居中裁切填满 */
        const imgW = snapshotImg.naturalWidth || snapshotImg.width
        const imgH = snapshotImg.naturalHeight || snapshotImg.height
        const scale = Math.max(thumbSize / imgW, thumbSize / imgH)
        const drawW = imgW * scale
        const drawH = imgH * scale
        ctx.drawImage(snapshotImg, thumbX + (thumbSize - drawW) / 2, thumbY + (thumbSize - drawH) / 2, drawW, drawH)
        ctx.restore()
        /** 缩略图边框 */
        ctx.strokeStyle = 'rgba(255,255,255,0.3)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.roundRect(thumbX, thumbY, thumbSize, thumbSize, 3)
        ctx.stroke()
      }
    }
    if (d.velocity && (Math.abs(d.velocity.dx) > 0.005 || Math.abs(d.velocity.dy) > 0.005)) {
      const cx = x + w / 2
      const cy = y + h / 2
      /** 放大速度向量用于可视化 */
      const scale = Math.min(w, h) * 2
      const vLen = Math.sqrt(d.velocity.dx * d.velocity.dx + d.velocity.dy * d.velocity.dy)
      const arrowLen = Math.min(vLen * scale, Math.min(w, h) * 0.8)
      if (arrowLen > 5) {
        const nx = d.velocity.dx / vLen
        const ny = d.velocity.dy / vLen
        const ex = cx + nx * arrowLen
        const ey = cy + ny * arrowLen
        ctx.beginPath()
        ctx.moveTo(cx, cy)
        ctx.lineTo(ex, ey)
        ctx.strokeStyle = stroke
        ctx.lineWidth = 2
        ctx.setLineDash([])
        ctx.stroke()
        /** 箭头头部 */
        const headLen = Math.min(8, arrowLen * 0.3)
        const angle = Math.atan2(ny, nx)
        ctx.beginPath()
        ctx.moveTo(ex, ey)
        ctx.lineTo(ex - headLen * Math.cos(angle - 0.5), ey - headLen * Math.sin(angle - 0.5))
        ctx.moveTo(ex, ey)
        ctx.lineTo(ex - headLen * Math.cos(angle + 0.5), ey - headLen * Math.sin(angle + 0.5))
        ctx.stroke()
      }
    }
  }

  /** 绘制追踪轨迹线（贝塞尔平滑曲线 + 渐隐） */
  if (trackTrails.size > 0) {
    ctx.lineWidth = 1.5
    ctx.setLineDash([])
    for (const [trackId, points] of trackTrails) {
      if (points.length < 2) continue
      const trailName = props.trackLabels?.[trackId]
      const color = getColor('', trackId, trailName)
      ctx.strokeStyle = color.stroke
      /** 消失目标的轨迹渐隐 */
      const fadeStart = trailFadeStart.get(trackId)
      if (fadeStart) {
        const fadeAlpha = Math.max(0, 1 - (now - fadeStart) / TRAIL_FADE_MS)
        ctx.globalAlpha = fadeAlpha * 0.5
      } else {
        ctx.globalAlpha = 0.5
      }
      ctx.beginPath()
      const p0 = points[0]!
      ctx.moveTo(p0.x * width, p0.y * height)
      /** 使用二次贝塞尔曲线平滑连接 */
      if (points.length === 2) {
        ctx.lineTo(points[1]!.x * width, points[1]!.y * height)
      } else {
        for (let i = 1; i < points.length - 1; i++) {
          const curr = points[i]!
          const next = points[i + 1]!
          const cpx = curr.x * width
          const cpy = curr.y * height
          const endx = ((curr.x + next.x) / 2) * width
          const endy = ((curr.y + next.y) / 2) * height
          ctx.quadraticCurveTo(cpx, cpy, endx, endy)
        }
        /** 最后一个点 */
        const last = points[points.length - 1]!
        ctx.lineTo(last.x * width, last.y * height)
      }
      ctx.stroke()
      ctx.globalAlpha = 1

      /** 在轨迹末尾绘制速度方向箭头 */
      const velocity = trackVelocities.get(trackId)
      if (velocity && points.length >= 1) {
        const last = points[points.length - 1]!
        const speed = Math.sqrt(velocity.dx * velocity.dx + velocity.dy * velocity.dy)
        if (speed > 0.005) {
          /** 箭头长度与速度成正比，限制最大长度 */
          const arrowLen = Math.min(speed * 800, 40)
          const nx = velocity.dx / speed
          const ny = velocity.dy / speed
          const ex = last.x * width + nx * arrowLen
          const ey = last.y * height + ny * arrowLen
          const sx = last.x * width
          const sy = last.y * height
          /** 箭头线 */
          const fadeAlpha2 = fadeStart ? Math.max(0, 1 - (now - fadeStart) / TRAIL_FADE_MS) : 1
          ctx.globalAlpha = fadeAlpha2 * 0.7
          ctx.strokeStyle = color.stroke
          ctx.lineWidth = 2
          ctx.setLineDash([])
          ctx.beginPath()
          ctx.moveTo(sx, sy)
          ctx.lineTo(ex, ey)
          ctx.stroke()
          /** 箭头头部 */
          const headLen = 6
          const angle = Math.atan2(ey - sy, ex - sx)
          ctx.beginPath()
          ctx.moveTo(ex, ey)
          ctx.lineTo(ex - headLen * Math.cos(angle - 0.5), ey - headLen * Math.sin(angle - 0.5))
          ctx.moveTo(ex, ey)
          ctx.lineTo(ex - headLen * Math.cos(angle + 0.5), ey - headLen * Math.sin(angle + 0.5))
          ctx.stroke()
          ctx.globalAlpha = 1
        }
      }
    }
  }

  /** 绘制 VLM 检测规则区域（虚线框 + 规则名称标签） */
  const ruleRegions = takeRuleRegions(props.cameraId)
  if (ruleRegions.length > 0) {
    ctx.setLineDash([8, 4])
    ctx.lineWidth = 2
    for (const region of ruleRegions) {
      const { xmin, ymin, xmax, ymax } = region.box
      const rx = xmin * width
      const ry = ymin * height
      const rw = (xmax - xmin) * width
      const rh = (ymax - ymin) * height

      /** 虚线矩形 */
      ctx.strokeStyle = '#FF6B6B'
      ctx.strokeRect(rx, ry, rw, rh)

      /** 半透明填充 */
      ctx.fillStyle = 'rgba(255, 107, 107, 0.08)'
      ctx.fillRect(rx, ry, rw, rh)

      /** 标签背景 + 文字 */
      const label = region.label ? `${region.ruleName}: ${region.label}` : region.ruleName
      ctx.font = 'bold 11px sans-serif'
      const textW = ctx.measureText(label).width + 8
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(255, 107, 107, 0.85)'
      ctx.fillRect(rx, ry - 16, textW, 16)
      ctx.fillStyle = '#fff'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, rx + 4, ry - 8)
      ctx.setLineDash([8, 4])
    }
    ctx.setLineDash([])
  }

  ctx.restore()
}

/** 点是否在多边形内（射线法） */
function pointInPoly(x: number, y: number, poly: Array<{ x: number; y: number }>): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]!.x, yi = poly[i]!.y
    const xj = poly[j]!.x, yj = poly[j]!.y
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

const namingBox = ref<{ trackId: number; label: string; x: number; y: number } | null>(null)
const namingName = ref('')
const namingInput = ref<HTMLInputElement | null>(null)
/** 命名操作错误提示 */
const namingError = ref('')

/** 当前命名目标的 dHash 匹配建议 */
const namingSuggestion = computed(() => {
  if (!namingBox.value) return null
  return getMatchSuggestionForTrack(props.cameraId, namingBox.value.trackId)
})

/** 当前命名目标的 CLIP 语义标签（作为快速命名建议） */
const namingSemanticLabel = computed(() => {
  if (!namingBox.value) return null
  const dets = takeDetections(props.cameraId)
  if (!dets) return null
  const det = dets.find(d => d.trackId === namingBox.value!.trackId)
  if (!det?.semanticLabel) return null
  /** 去掉 "a " 前缀，首字母大写 */
  const raw = det.semanticLabel.startsWith('a ') ? det.semanticLabel.slice(2) : det.semanticLabel
  return raw.charAt(0).toUpperCase() + raw.slice(1)
})

const namingPopupStyle = computed(() => {
  if (!namingBox.value) return {}
  return {
    left: `${Math.min(namingBox.value.x, 80)}%`,
    top: `${Math.min(namingBox.value.y, 80)}%`,
  }
})

/** 当前摄像头已命名的目标名称列表（去重） */
const existingTrackNames = computed(() => {
  if (!props.trackLabels) return []
  const names = new Set<string>()
  for (const name of Object.values(props.trackLabels)) {
    if (name) names.add(name)
  }
  return [...names].sort()
})

/** Canvas contextmenu 事件：根据点击位置匹配最近的检测框 */
function onCanvasContext(e: MouseEvent) {
  const result = findDetectionAt(e.clientX, e.clientY, e.currentTarget as HTMLElement)
  if (!result) return
  const { trackId, label, nx, ny } = result
  const existing = props.trackLabels?.[trackId] ?? ''
  namingBox.value = { trackId, label, x: nx * 100, y: ny * 100 }
  namingName.value = existing
  nextTick(() => namingInput.value?.focus())
}

/** Canvas dblclick 事件：双击检测框直接命名 */
function onOverlayDblClick(e: MouseEvent) {
  const result = findDetectionAt(e.clientX, e.clientY, e.currentTarget as HTMLElement)
  if (result) {
    e.stopPropagation()
    const existing = props.trackLabels?.[result.trackId] ?? ''
    namingBox.value = { trackId: result.trackId, label: result.label, x: result.nx * 100, y: result.ny * 100 }
    namingName.value = existing
    nextTick(() => namingInput.value?.focus())
  }
}

/** camera-body 双击 → 全屏（如果不在 canvas overlay 上） */
function onBodyDblClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.tagName === 'CANVAS' || target.tagName === 'VIDEO') return
  emit('fullscreen', cameraId)
}

/** 查找点击位置对应的检测框 */
function findDetectionAt(clientX: number, clientY: number, element: HTMLElement): { trackId: number; label: string; nx: number; ny: number } | null {
  const sorted = getSortedDetections()
  if (sorted.length === 0) return null
  const rect = element.getBoundingClientRect()
  const nx = (clientX - rect.left) / rect.width
  const ny = (clientY - rect.top) / rect.height

  let best: { trackId?: number; label: string; box: Detection['box'] } | null = null
  let bestArea = Infinity
  for (const d of sorted) {
    const box = getSmoothedBox(d)
    if (nx >= box.xmin && nx <= box.xmax && ny >= box.ymin && ny <= box.ymax) {
      const area = (box.xmax - box.xmin) * (box.ymax - box.ymin)
      if (area < bestArea) {
        best = d
        bestArea = area
      }
    }
  }
  if (!best || !best.trackId) return null
  return { trackId: best.trackId, label: best.label, nx, ny }
}

/** 触屏长按命名支持（移动端） */
let longPressTimer: ReturnType<typeof setTimeout> | null = null
let longPressTarget: { trackId: number; label: string; x: number; y: number } | null = null

function onTouchStartNaming(e: TouchEvent) {
  if (e.touches.length !== 1) return
  const touch = e.touches[0]!
  const sorted = getSortedDetections()
  if (sorted.length === 0) return
  const canvas = e.currentTarget as HTMLElement
  const rect = canvas.getBoundingClientRect()
  const nx = (touch.clientX - rect.left) / rect.width
  const ny = (touch.clientY - rect.top) / rect.height

  let best: { trackId?: number; label: string; box: Detection['box'] } | null = null
  let bestArea = Infinity
  for (const d of sorted) {
    const box = getSmoothedBox(d)
    if (nx >= box.xmin && nx <= box.xmax && ny >= box.ymin && ny <= box.ymax) {
      const area = (box.xmax - box.xmin) * (box.ymax - box.ymin)
      if (area < bestArea) { best = d; bestArea = area }
    }
  }
  if (!best || !best.trackId) { longPressTarget = null; return }
  longPressTarget = { trackId: best.trackId, label: best.label, x: nx * 100, y: ny * 100 }
  longPressTimer = setTimeout(() => {
    if (!longPressTarget) return
    const existing = props.trackLabels?.[longPressTarget.trackId] ?? ''
    namingBox.value = longPressTarget
    namingName.value = existing
    nextTick(() => namingInput.value?.focus())
    longPressTarget = null
  }, 600)
}

function handleTouchMoveNaming() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; longPressTarget = null }
}

function handleTouchEndNaming() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; longPressTarget = null }
}

async function saveNaming() {
  if (!namingBox.value) { cancelNaming(); return }
  const name = namingName.value.trim()
  if (!name) { cancelNaming(); return }
  const { trackId, label } = namingBox.value
  const res = await authFetch('/api/track-labels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cameraId: props.cameraId, trackId, label, name }),
  })
  if (!res.ok) {
    namingError.value = t('camera.saveFailed')
    return
  }
  emit('trackLabelUpdated')
  cancelNaming()
}

/** 清除已命名目标的名称 */
async function clearNaming() {
  if (!namingBox.value) return
  const { trackId } = namingBox.value
  const res = await authFetch(`/api/track-labels/${props.cameraId}/${trackId}`, { method: 'DELETE' })
  if (!res.ok) {
    namingError.value = t('camera.saveFailed')
    return
  }
  emit('trackLabelUpdated')
  cancelNaming()
}

function cancelNaming() {
  namingBox.value = null
  namingName.value = ''
  namingError.value = ''
}

/** 从命名弹窗跳转到录像 */
function jumpToRecordingFromNaming() {
  emit('jumpToRecording', props.cameraId, Date.now())
  cancelNaming()
}

/** 跳转到追踪目标图库 */
function jumpToTrackFromNaming() {
  if (namingBox.value) {
    emit('jumpToTrack', namingBox.value.trackId)
  }
  cancelNaming()
}

/** 离线时显示"最后在线 x 分钟前" */
const lastSeenText = computed(() => {
  if (props.online || !props.lastFrameAt) return ''
  const diffSec = Math.floor((Date.now() - props.lastFrameAt) / 1000)
  if (diffSec < 60) return t('camera.lastSeenJustNow')
  if (diffSec < 3600) return t('camera.lastSeenMinutes', { count: Math.floor(diffSec / 60) })
  if (diffSec < 86400) return t('camera.lastSeenHours', { count: Math.floor(diffSec / 3600) })
  return t('camera.lastSeenDays', { count: Math.floor(diffSec / 86400) })
})

/** 录像已录时长（每秒更新） */
const recordingDuration = ref('')
function updateRecDuration() {
  if (!props.recording || !props.recordingStart) { recordingDuration.value = ''; return }
  const sec = Math.floor((Date.now() - props.recordingStart) / 1000)
  if (sec < 60) { recordingDuration.value = `${sec}s`; return }
  const m = Math.floor(sec / 60)
  const s = sec % 60
  recordingDuration.value = `${m}:${String(s).padStart(2, '0')}`
}

let recDurationTimer: ReturnType<typeof setInterval> | null = null
watch(() => props.recording, (on) => {
  if (recDurationTimer) { clearInterval(recDurationTimer); recDurationTimer = null }
  if (on) { updateRecDuration(); recDurationTimer = setInterval(updateRecDuration, 1000) }
  else { recordingDuration.value = '' }
}, { immediate: true })

/** 截图下载当前画面（从 video + overlay canvas 合成，包含检测框+轨迹+ROI+OSD） */
/** 按需 AI 分析当前帧 */
async function analyzeFrame() {
  if (aiAnalyzing.value) return
  aiAnalyzing.value = true
  try {
    const resp = await authFetch('/api/ai/analyze-frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cameraId: props.cameraId }),
    })
    if (!resp.ok) {
      console.warn('[CameraView] AI 分析请求失败:', resp.status)
    }
    /** 结果通过 WebSocket llm:scene 事件异步推送到 overlay */
  } finally {
    setTimeout(() => { aiAnalyzing.value = false }, 2000)
  }
}

const showAiAsk = ref(false)
const aiQuestion = ref('')
const aiAsking = ref(false)
const aiAnswer = ref('')

/** AI 场景问答 */
async function askAi() {
  if (!aiQuestion.value.trim() || aiAsking.value) return
  aiAsking.value = true
  aiAnswer.value = ''
  try {
    const resp = await authFetch('/api/ai/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cameraId: props.cameraId, question: aiQuestion.value.trim() }),
    })
    if (resp.ok) {
      const data = await resp.json()
      aiAnswer.value = data.answer || 'No answer'
    }
  } catch {
    // ignore
  } finally {
    aiAsking.value = false
  }
}

async function takeScreenshot() {
  const now = new Date()
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`

  let blob: Blob | null = null

  if (fmp4.videoRef.value) {
    const video = fmp4.videoRef.value
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth || 1920
    canvas.height = video.videoHeight || 1080
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(video, 0, 0)
    /** 合成静态层和动态层两个 canvas */
    if (staticCanvasRef.value) {
      ctx.drawImage(staticCanvasRef.value, 0, 0, canvas.width, canvas.height)
    }
    if (overlayCanvas.value) {
      ctx.drawImage(overlayCanvas.value, 0, 0, canvas.width, canvas.height)
    }
    blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  }

  if (!blob) return

  /** 复制到剪贴板（PNG 格式，保留透明通道支持） */
  if (navigator.clipboard && window.ClipboardItem) {
    const pngBlob = blob.type === 'image/png' ? blob : await new Promise<Blob | null>(resolve => {
      const img = new Image()
      img.onload = () => {
        const c = document.createElement('canvas')
        c.width = img.width
        c.height = img.height
        c.getContext('2d')!.drawImage(img, 0, 0)
        c.toBlob(resolve, 'image/png')
      }
      img.src = URL.createObjectURL(blob!)
    })
    if (pngBlob) {
      navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]).catch(() => { /* 剪贴板权限被拒绝 */ })
    }
  }

  /** 同时下载为 JPG */
  const link = document.createElement('a')
  link.download = `${props.name}_${ts}.jpg`
  link.href = URL.createObjectURL(blob)
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 10000)
}

/** 画面调节面板 */
const showAdjust = ref(false)

/** 画面调节参数（按摄像头 ID 持久化到后端） */
const ADJUST_KEY = `nvr-adjust-${props.cameraId}`
function loadAdjust(): { brightness: number; contrast: number; saturation: number } {
  return { brightness: 100, contrast: 100, saturation: 100 }
}

function saveAdjust() {
  setPref(ADJUST_KEY, {
    brightness: brightness.value,
    contrast: contrast.value,
    saturation: saturation.value,
  })
}

const initAdjust = loadAdjust()
const brightness = ref(initAdjust.brightness)
const contrast = ref(initAdjust.contrast)
const saturation = ref(initAdjust.saturation)

/** 从后端恢复画面调节参数 */
getPref<{ brightness: number; contrast: number; saturation: number }>(ADJUST_KEY).then(v => {
  if (v) {
    brightness.value = v.brightness
    contrast.value = v.contrast
    saturation.value = v.saturation
  }
})

/** 画面参数变化时自动保存 */
watch([brightness, contrast, saturation], saveAdjust)

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
  /** watch 会自动触发 saveAdjust */
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
/** 拖拽状态 ref（用于模板 class 绑定，控制 transition） */
const isDragging = ref(false)
let dragStartX = 0
let dragStartY = 0
let dragStartPanX = 0
let dragStartPanY = 0

function onPanStart(e: MouseEvent) {
  if (zoomLevel.value <= 1) return
  dragging = true
  isDragging.value = true
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
  isDragging.value = false
}

/** 触摸手势：双指缩放 + 单指平移 */
let touchStartDist = 0
let touchStartZoom = 1
let touchPanning = false
let touchStartPanX = 0
let touchStartPanY = 0
let touchStartClientX = 0
let touchStartClientY = 0

function handleTouchZoom(e: TouchEvent) {
  if (e.touches.length === 2) {
    /** 双指缩放开始 */
    e.preventDefault()
    const dx = e.touches[1]!.clientX - e.touches[0]!.clientX
    const dy = e.touches[1]!.clientY - e.touches[0]!.clientY
    touchStartDist = Math.sqrt(dx * dx + dy * dy)
    touchStartZoom = zoomLevel.value
  } else if (e.touches.length === 1 && zoomLevel.value > 1) {
    /** 单指平移开始（仅缩放时） */
    touchPanning = true
    touchStartClientX = e.touches[0]!.clientX
    touchStartClientY = e.touches[0]!.clientY
    touchStartPanX = panX.value
    touchStartPanY = panY.value
  }
}

/** 统一触摸开始：同时处理缩放/平移和长按命名 */
function onTouchStart(e: TouchEvent) {
  handleTouchZoom(e)
  onTouchStartNaming(e)
}

function handleTouchZoomMove(e: TouchEvent) {
  if (e.touches.length === 2) {
    /** 双指缩放 */
    e.preventDefault()
    const dx = e.touches[1]!.clientX - e.touches[0]!.clientX
    const dy = e.touches[1]!.clientY - e.touches[0]!.clientY
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (touchStartDist === 0) return
    const scale = dist / touchStartDist
    zoomLevel.value = Math.max(1, Math.min(5, touchStartZoom * scale))
    if (zoomLevel.value <= 1) {
      panX.value = 0
      panY.value = 0
    }
  } else if (e.touches.length === 1 && touchPanning) {
    /** 单指平移 */
    e.preventDefault()
    panX.value = touchStartPanX + (e.touches[0]!.clientX - touchStartClientX)
    panY.value = touchStartPanY + (e.touches[0]!.clientY - touchStartClientY)
  }
}

/** 统一触摸移动：同时处理缩放/平移和命名取消 */
function onTouchMove(e: TouchEvent) {
  handleTouchZoomMove(e)
  handleTouchMoveNaming()
}

/** 统一触摸结束 */
function onTouchEnd() {
  touchPanning = false
  touchStartDist = 0
  handleTouchEndNaming()
}

/** 鼠标悬停检测框追踪 */
const hoveredTrackId = ref<number | null>(null)
let mouseNormX = -1
let mouseNormY = -1

function onOverlayMouseMove(e: MouseEvent) {
  const canvas = e.currentTarget as HTMLElement
  const rect = canvas.getBoundingClientRect()
  mouseNormX = (e.clientX - rect.left) / rect.width
  mouseNormY = (e.clientY - rect.top) / rect.height

  /** 检测鼠标是否在某个检测框内（含 10px 扩展命中区域，方便小目标悬停） */
  const padNorm = 10 / rect.width
  const sorted = getSortedDetections()
  let found: number | null = null
  let bestArea = Infinity
  for (const d of sorted) {
    if (d.trackId == null) continue
    const box = getSmoothedBox(d)
    if (mouseNormX >= box.xmin - padNorm && mouseNormX <= box.xmax + padNorm && mouseNormY >= box.ymin - padNorm && mouseNormY <= box.ymax + padNorm) {
      const area = (box.xmax - box.xmin) * (box.ymax - box.ymin)
      if (area < bestArea) {
        found = d.trackId
        bestArea = area
      }
    }
  }
  hoveredTrackId.value = found
  /** 悬停时按需加载目标快照缩略图 */
  if (found != null) loadTrackSnapshot(found)
}

function onOverlayMouseLeave() {
  mouseNormX = -1
  mouseNormY = -1
  hoveredTrackId.value = null
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

/** 全屏模式下注册缩放快捷键 */
let unregZoomIn: (() => void) | null = null
let unregZoomOut: (() => void) | null = null
let unregZoomReset: (() => void) | null = null

watch(() => props.isFullscreen, (fs) => {
  unregZoomIn?.()
  unregZoomOut?.()
  unregZoomReset?.()
  unregZoomIn = unregZoomOut = unregZoomReset = null
  if (fs) {
    unregZoomIn = registerShortcut({ key: '+', description: t('camera.zoomIn', '放大'), handler: () => { zoomLevel.value = Math.min(5, zoomLevel.value + 0.5) } })
    /** = 键也用于放大（和 + 同键位） */
    const unregEq = registerShortcut({ key: '=', description: t('camera.zoomIn', '放大'), handler: () => { zoomLevel.value = Math.min(5, zoomLevel.value + 0.5) } })
    unregZoomOut = registerShortcut({ key: '-', description: t('camera.zoomOut', '缩小'), handler: () => { zoomLevel.value = Math.max(1, zoomLevel.value - 0.5); if (zoomLevel.value <= 1) resetZoom() } })
    unregZoomReset = registerShortcut({ key: '0', description: t('camera.resetZoom', '重置缩放'), handler: resetZoom })
    /** 把 = 的清理函数也绑定到 unregZoomIn 上 */
    const origUnreg = unregZoomIn
    unregZoomIn = () => { origUnreg?.(); unregEq?.() }
  }
}, { immediate: true })

onUnmounted(() => {
  /** 从共享 IntersectionObserver 注销 */
  const el = rootEl.value
  if (el && sharedViewportObserver) {
    sharedViewportObserver.unobserve(el)
    viewportCallbacks.delete(el)
  }
  sharedViewportRefCount--
  if (sharedViewportRefCount <= 0 && sharedViewportObserver) {
    sharedViewportObserver.disconnect()
    sharedViewportObserver = null
    viewportCallbacks.clear()
    sharedViewportRefCount = 0
  }
  if (canvasResizeObserver) {
    canvasResizeObserver.disconnect()
    canvasResizeObserver = null
  }
  fmp4.disconnect()
  stopOverlayLoop()
  if (detectCountZeroTimer) clearTimeout(detectCountZeroTimer)
  if (longPressTimer) clearTimeout(longPressTimer)
  if (frozenTimer) clearInterval(frozenTimer)
  if (recDurationTimer) clearInterval(recDurationTimer)
  if (heatmapTimer) clearInterval(heatmapTimer)
  trackTrails.clear()
  smoothedBoxes.clear()
  trackVelocities.clear()
  trackSnapshotCache.clear()
  fadeOutBoxes.clear()
  snapshotLoading.clear()
})
</script>

<template>
  <div ref="rootEl" class="camera-view" :class="{ offline: !online }">
    <div class="camera-header">
      <span class="status-dot" :class="{ online, offline: !online }" />
      <span class="camera-name">{{ name }}</span>
      <span v-if="recording" class="rec-indicator" :title="`REC ${recordingDuration}`">
        <span class="rec-dot" />{{ recordingDuration }}
      </span>
      <span v-if="showBoxes && online && detectCount > 0" class="detection-count">
        {{ detectCount }}
      </span>
      <span v-if="zoomLevel > 1" class="zoom-badge" @click="resetZoom" :title="t('camera.resetZoom')">{{ zoomLevel.toFixed(1) }}x</span>
      <span v-if="!online" class="offline-badge">{{ t('camera.offline') }}</span>
      <span v-else-if="fmp4.connected.value && !fmp4.playing.value && hasFrame" class="reconnect-badge">{{ t('camera.buffering', '缓冲中...') }}</span>
      <span v-else-if="frozen" class="frozen-badge">{{ t('camera.frozen') }}</span>
      <button class="fullscreen-btn" @click="emit('fullscreen', cameraId)" :title="t('camera.fullscreen')">&#x26F6;</button>
      <button v-if="online" class="screenshot-btn" @click="takeScreenshot" :title="t('camera.screenshot')">&#x1F4F7;</button>
      <button v-if="online" :class="['ai-btn', { loading: aiAnalyzing }]" @click="analyzeFrame" :title="t('camera.aiAnalyze', 'AI 分析')" :disabled="aiAnalyzing">{{ aiAnalyzing ? '&#x23F3;' : '&#x1F916;' }}</button>
      <div v-if="online" class="ai-ask-wrapper">
        <button class="ai-ask-btn" @click="showAiAsk = !showAiAsk" :title="t('camera.aiAsk', 'AI 问答')">&#x2753;</button>
        <div v-if="showAiAsk" class="ai-ask-panel">
          <input v-model="aiQuestion" class="ai-ask-input" :placeholder="t('camera.aiAskPlaceholder', '输入关于画面的问题...')" @keydown.enter="askAi" />
          <button class="ai-ask-submit" @click="askAi" :disabled="aiAsking">{{ aiAsking ? '...' : '&#x27A4;' }}</button>
          <div v-if="aiAnswer" class="ai-ask-answer">{{ aiAnswer }}</div>
        </div>
      </div>
      <button v-if="online" :class="['mute-btn', { active: !isMuted }]" @click="isMuted = !isMuted" :title="isMuted ? t('camera.unmute', '取消静音') : t('camera.mute', '静音')">{{ isMuted ? '&#x1F507;' : '&#x1F50A;' }}</button>
      <button v-if="online" :class="['heatmap-btn', { active: showHeatmap }]" @click="showHeatmap = !showHeatmap" :title="t('camera.heatmap')">&#x1F321;</button>
      <button v-if="online" :class="['pip-btn', { active: isPip }]" @click="togglePip" :title="t('camera.pip')">&#x1F4BB;</button>
      <button v-if="online" class="recording-btn" @click="emit('jumpToRecording', cameraId, Date.now())" :title="t('camera.jumpToRecording')">&#x25B6;</button>
      <PtzControl v-if="ptz && online" :camera-id="cameraId" />
      <button v-if="online" :class="['adjust-btn', { active: showAdjust }]" @click="showAdjust = !showAdjust" :title="t('camera.adjust')">&#x2606;</button>
    </div>

    <div
      class="camera-body"
      :style="cameraBodyStyle"
      @dblclick="onBodyDblClick($event)"
      @wheel="onWheel"
      @mousedown="onPanStart"
      @mousemove="onPanMove"
      @mouseup="onPanEnd"
      @touchstart="onTouchStart"
      @touchmove="onTouchMove"
      @touchend="onTouchEnd"
      @mouseleave="onPanEnd"
    >
      <div class="camera-content" :class="{ 'dragging-zoom': isDragging }" :style="{ transform: zoomTransform }">
        <!-- fMP4/MSE 模式：video 硬件解码 — 始终渲染，避免 online 抖动导致销毁重建黑闪 -->
        <div class="mse-wrapper">
          <video
            :ref="(el: any) => fmp4.setVideo(el as HTMLVideoElement | null)"
            class="camera-video"
            :style="{ filter: imageFilter }"
            autoplay playsinline
            :muted="isMuted"
            disablePictureInPicture
            disableremoteplayback
            @contextmenu.prevent="onCanvasContext"
          />
          <canvas
            ref="staticCanvasRef"
            class="camera-overlay static-overlay"
            style="pointer-events: none;"
          />
          <canvas
            ref="overlayCanvas"
            class="camera-overlay dynamic-overlay"
            @contextmenu.prevent="onCanvasContext"
            @dblclick="onOverlayDblClick"
            @mousemove="onOverlayMouseMove"
            @mouseleave="onOverlayMouseLeave"
            @touchstart="onTouchStart"
            @touchmove="onTouchMove"
            @touchend="onTouchEnd"
          />
        </div>
        <!-- placeholder 叠加层：离线时覆盖在视频上方，不销毁视频元素 -->
        <div v-if="!online" class="camera-placeholder">
          <div class="placeholder-icon offline-icon">&#10005;</div>
          <span>{{ t('camera.cameraOffline') }}</span>
          <span v-if="lastSeenText" class="last-seen">{{ lastSeenText }}</span>
        </div>

        <!-- 检测框由 Canvas overlay 绘制（不再使用 HTML TransitionGroup） -->

        <!-- 右键命名弹出框 -->
        <div v-if="namingBox" class="naming-popup" :style="namingPopupStyle">
          <div class="naming-title">{{ namingBox.label }} #{{ namingBox.trackId }}</div>
          <!-- dHash 匹配建议：一键应用 -->
          <button v-if="namingSuggestion && namingName !== namingSuggestion" class="naming-suggest-btn" @click="namingName = namingSuggestion!">
            ≈ {{ namingSuggestion }}
          </button>
          <!-- CLIP 语义标签建议：一键使用 AI 描述作为名称 -->
          <button v-if="namingSemanticLabel && namingName !== namingSemanticLabel" class="naming-suggest-btn semantic" @click="namingName = namingSemanticLabel!">
            AI: {{ namingSemanticLabel }}
          </button>
          <input
            ref="namingInput"
            v-model="namingName"
            class="naming-input"
            :placeholder="t('roi.name')"
            @keydown.enter="saveNaming"
            @keydown.escape="cancelNaming"
          />
          <!-- 快速关联已有名称 -->
          <select
            v-if="existingTrackNames.length > 0"
            class="naming-preset"
            @change="namingName = ($event.target as HTMLSelectElement).value"
          >
            <option value="">关联...</option>
            <option v-for="name in existingTrackNames" :key="name" :value="name">{{ name }}</option>
          </select>
          <div class="naming-actions">
            <button class="naming-save" @click="saveNaming">{{ t('manage.save') }}</button>
            <button
              v-if="props.trackLabels?.[namingBox.trackId]"
              class="naming-clear"
              @click="clearNaming"
            >{{ t('camera.clearName', '清除') }}</button>
            <button class="naming-cancel" @click="cancelNaming">{{ t('manage.cancel') }}</button>
            <button class="naming-recording" @click="jumpToRecordingFromNaming" :title="t('camera.jumpToRecording')">&#x25B6;</button>
            <button class="naming-track" @click="jumpToTrackFromNaming" title="查看追踪目标">&#x1F3AF;</button>
          </div>
          <div v-if="namingError" class="naming-error">{{ namingError }}</div>
        </div>
      </div>

      <!-- 实时目标计数 -->
      <div v-if="online && hasFrame && showBoxes && detectCount > 0" class="detect-count-badge">
        {{ detectionSummary }}
      </div>
    </div>

    <div class="camera-footer" v-if="showBoxes && detectCount > 0">
      <span class="detection-summary">{{ detectionSummary }}</span>
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
  /* 不再降低整体 opacity，避免在线恢复时视频区域闪烁变暗 */
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

/* 录像指示器 */
.rec-indicator {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #e74c3c;
  font-size: 11px;
  font-weight: 700;
  font-family: 'Courier New', Courier, monospace;
}

.rec-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #e74c3c;
  animation: rec-blink 1s infinite;
}

@keyframes rec-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
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

.frozen-badge {
  background: #FF9800;
  color: #fff;
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 11px;
  font-weight: 600;
  animation: frozen-blink 1.5s ease-in-out infinite;
}

.reconnect-badge {
  background: #2196F3;
  color: #fff;
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 11px;
  font-weight: 600;
  animation: pulse-badge 1.5s ease-in-out infinite;
}

@keyframes pulse-badge {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

@keyframes frozen-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
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

.mute-btn {
  background: none;
  border: none;
  color: #888;
  font-size: 14px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.mute-btn:hover {
  color: #e0e0e0;
}

.mute-btn.active {
  color: #4ECDC4;
}

.ai-btn {
  background: none;
  border: none;
  color: #888;
  font-size: 14px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  transition: color 0.2s;
}

.ai-btn:hover {
  color: #e0e0e0;
}

.ai-btn.loading {
  color: #f1c40f;
  cursor: wait;
}

.ai-btn:disabled {
  cursor: wait;
}

.ai-ask-wrapper {
  position: relative;
}

.ai-ask-btn {
  background: none;
  border: none;
  color: #888;
  font-size: 14px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  transition: color 0.2s;
}

.ai-ask-btn:hover {
  color: #b388ff;
}

.ai-ask-panel {
  position: absolute;
  top: 100%;
  right: 0;
  background: rgba(26, 26, 46, 0.95);
  border: 1px solid rgba(124, 77, 255, 0.4);
  border-radius: 8px;
  padding: 8px;
  width: 280px;
  z-index: 20;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ai-ask-input {
  flex: 1;
  min-width: 0;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  padding: 5px 8px;
  color: #eee;
  font-size: 12px;
  outline: none;
}

.ai-ask-input:focus {
  border-color: #7c4dff;
}

.ai-ask-submit {
  background: #7c4dff;
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 5px 10px;
  font-size: 13px;
  cursor: pointer;
}

.ai-ask-submit:disabled {
  opacity: 0.5;
  cursor: wait;
}

.ai-ask-answer {
  width: 100%;
  font-size: 12px;
  line-height: 1.5;
  color: #ddd;
  background: rgba(124, 77, 255, 0.1);
  border-radius: 4px;
  padding: 6px 8px;
  white-space: pre-wrap;
}
  background: none;
  border: none;
  color: #888;
  font-size: 14px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  transition: color 0.2s;
}

.heatmap-btn:hover,
.heatmap-btn.active {
  color: #ff6b6b;
}

.pip-btn {
  background: none;
  border: none;
  color: #888;
  font-size: 14px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  transition: color 0.2s;
}

.pip-btn:hover,
.pip-btn.active {
  color: #74b9ff;
}

.recording-btn {
  background: none;
  border: none;
  color: #888;
  font-size: 12px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.recording-btn:hover {
  color: #FFD93D;
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

.camera-content {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  transform-origin: center center;
}

/** 仅在非拖拽状态下启用 transition（避免高频输入时连续取消/重启动画） */
.camera-content:not(.dragging-zoom) {
  transition: transform 0.15s ease-out;
}

.camera-image {
  max-width: 100%;
  max-height: 100%;
  display: block;
  margin: auto;
  image-rendering: auto;
}

.mse-wrapper {
  position: relative;
  display: inline-flex;
  max-width: 100%;
  max-height: 100%;
  line-height: 0;
  contain: layout style;
}

.camera-video {
  max-width: 100%;
  max-height: 100%;
  display: block;
  will-change: transform;
}

.camera-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  contain: strict;
  will-change: transform;
}

.static-overlay {
  z-index: 1;
}

.dynamic-overlay {
  z-index: 2;
  pointer-events: auto;
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
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: #1a1a2e;
  color: #444;
  font-size: 13px;
  z-index: 5;
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
.detect-count-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  pointer-events: none;
  color: #fff;
  background: rgba(78, 205, 196, 0.8);
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 右键命名弹窗 */
.naming-popup {
  position: absolute;
  z-index: 100;
  background: #1a1a2e;
  border: 1px solid #4ECDC4;
  border-radius: 6px;
  padding: 8px;
  min-width: 160px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.5);
  pointer-events: auto;
}

.naming-title {
  color: #4ECDC4;
  font-size: 11px;
  font-weight: 700;
  margin-bottom: 6px;
}

.naming-suggest-btn {
  display: block;
  width: 100%;
  background: rgba(156, 39, 176, 0.25);
  border: 1px solid rgba(156, 39, 176, 0.5);
  border-radius: 3px;
  color: #CE93D8;
  font-size: 11px;
  padding: 4px 6px;
  margin-bottom: 6px;
  cursor: pointer;
  text-align: left;
}
.naming-suggest-btn:hover {
  background: rgba(156, 39, 176, 0.4);
}
.naming-suggest-btn.semantic {
  background: rgba(33, 150, 243, 0.2);
  border-color: rgba(33, 150, 243, 0.5);
  color: #90CAF9;
}
.naming-suggest-btn.semantic:hover {
  background: rgba(33, 150, 243, 0.35);
}

.naming-input {
  width: 100%;
  background: #2a2a4a;
  border: 1px solid #555;
  border-radius: 3px;
  color: #e0e0e0;
  font-size: 12px;
  padding: 4px 6px;
  outline: none;
}

.naming-input:focus {
  border-color: #4ECDC4;
}

.naming-preset {
  width: 100%;
  background: #2a2a4a;
  border: 1px solid #444;
  border-radius: 3px;
  color: #aaa;
  font-size: 11px;
  padding: 2px 4px;
  outline: none;
  margin-top: 4px;
  cursor: pointer;
}

.naming-preset:hover {
  border-color: #4ECDC4;
  color: #4ECDC4;
}

.naming-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.naming-save, .naming-cancel {
  flex: 1;
  background: none;
  border: 1px solid #555;
  color: #aaa;
  border-radius: 3px;
  padding: 3px 0;
  font-size: 11px;
  cursor: pointer;
}

.naming-clear {
  flex: 0;
  background: none;
  border: 1px solid #e74c3c40;
  color: #e74c3c;
  border-radius: 3px;
  padding: 3px 6px;
  font-size: 11px;
  cursor: pointer;
}
.naming-clear:hover {
  background: #e74c3c20;
  border-color: #e74c3c;
}

.naming-error {
  color: #e74c3c;
  font-size: 10px;
  margin-top: 2px;
}

.naming-recording {
  flex: 0;
  background: none;
  border: 1px solid #555;
  color: #aaa;
  border-radius: 3px;
  padding: 3px 8px;
  font-size: 11px;
  cursor: pointer;
}

.naming-recording:hover {
  border-color: #4ECDC4;
  color: #4ECDC4;
}

.naming-track {
  flex: 0;
  background: none;
  border: 1px solid #555;
  color: #aaa;
  border-radius: 3px;
  padding: 3px 6px;
  font-size: 11px;
  cursor: pointer;
}
.naming-track:hover {
  border-color: #9b59b6;
  color: #9b59b6;
}

.naming-save:hover {
  border-color: #4ECDC4;
  color: #4ECDC4;
}

.naming-cancel:hover {
  border-color: #888;
  color: #ddd;
}

.camera-footer {
  padding: 6px 12px;
  background: #16213e;
  border-top: 1px solid #2a2a4a;
}

.detection-summary {
  color: #4ECDC4;
  font-size: 12px;
  font-weight: 500;
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
