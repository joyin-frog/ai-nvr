<script setup lang="ts">
import { ref, computed, onUnmounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Detection } from '../services/events'
import { authFetch, authUrl } from '../services/auth'
import { useCanvasRenderer } from '../composables/useCanvasRenderer'
import { useFmp4Stream } from '../composables/useFmp4Stream'
import { useMjpegStream } from '../composables/useMjpegStream'
import { takeFrame } from '../services/ws-frame-cache'
import { takeDetections, getInferMs } from '../services/ws-detect-cache'
import PtzControl from './PtzControl.vue'
import { usePreferences } from '../composables/usePreferences'

const { t } = useI18n()
const { setPref, getPref } = usePreferences()
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
}>()

const emit = defineEmits<{
  fullscreen: [cameraId: string]
  jumpToRecording: [cameraId: string, timestamp: number]
  trackLabelUpdated: []
}>()

/** Canvas 渲染器（Canvas fallback 模式） */
const { canvasRef: _canvasRef, setCanvas, setOverlay, setFramePollFn, feedFrame, startLoop, stopLoop, captureJpeg, getFrameSize } = useCanvasRenderer()

/** fMP4/MSE 渲染器（高性能模式，GPU 硬件解码） */
const fmp4CameraId = computed(() => props.cameraId)
const fmp4 = useFmp4Stream(fmp4CameraId)

/**
 * 当前渲染模式：MSE 优先，Canvas fallback
 * 检测 MediaSource + H.264 codec 支持
 */
function canUseMse(): boolean {
  if (typeof MediaSource === 'undefined') return false
  /** 检测常见 H.264 codec 是否支持 */
  const codecs = ['avc1.640029', 'avc1.64001F', 'avc1.4D401F', 'avc1.42C01E']
  for (const codec of codecs) {
    if (MediaSource.isTypeSupported(`video/mp4; codecs="${codec}"`)) return true
  }
  return false
}
const useMse = ref(canUseMse())
const mjpegStream = useMjpegStream()

/** MSE 连续失败时自动回退到 Canvas 模式 */
watch(() => fmp4.failed.value, (failed) => {
  if (failed && useMse.value) {
    console.warn('[CameraView] MSE 连接失败，回退到 Canvas 模式')
    useMse.value = false
    stopOverlayLoop()
    fmp4.disconnect()
    /** 如果摄像头在线，启动 Canvas 渲染 */
    if (props.online) {
      startLoop()
      const url = authUrl(`/api/stream/${props.cameraId}`)
      mjpegStream.startFetch(url, onFrameDecoded)
    }
  }
})

/** MSE 模式的检测框 overlay canvas */
const overlayCanvas = ref<HTMLCanvasElement | null>(null)
let overlayRafId: number | null = null

/** MSE overlay 渲染循环 */
function startOverlayLoop() {
  if (overlayRafId) return
  const draw = () => {
    overlayRafId = requestAnimationFrame(draw)
    const canvas = overlayCanvas.value
    const video = fmp4.videoRef.value
    if (!canvas || !video) return

    const w = video.videoWidth
    const h = video.videoHeight
    if (w === 0 || h === 0) return

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)

    /** poll 检测结果 */
    const detectResult = takeDetections(props.cameraId, consumedDetectVersion)
    if (detectResult) {
      consumedDetectVersion = detectResult.version
      localDetections = detectResult.detections
      invalidateSortedDetections()
      updateDetectionSummary()
    }

    if (hasFrame.value && props.showBoxes) {
      drawDetectionOverlay(ctx, w, h)
    } else {
      drawOSD(ctx, w, h)
    }
  }
  draw()
}

function stopOverlayLoop() {
  if (overlayRafId) {
    cancelAnimationFrame(overlayRafId)
    overlayRafId = null
  }
}

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

/**
 * 追踪目标轨迹缓存
 * 记录每个 trackId 最近的中心点坐标（归一化），用于在 overlay 上绘制轨迹线
 * 最大保留 30 个点（约 60 秒的轨迹，AI interval = 2s）
 */
const MAX_TRAIL_POINTS = 30
const trackTrails = new Map<number, Array<{ x: number; y: number }>>()

/** 记录当前帧中所有检测目标的中心点到轨迹缓存 */
function recordTrails() {
  for (const d of localDetections) {
    if (d.trackId == null) continue
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

/** 清理不再活跃的轨迹（超过 MAX_TRAIL_POINTS 帧未更新的） */
function cleanupTrails() {
  const activeIds = new Set(localDetections.filter(d => d.trackId != null).map(d => d.trackId!))
  for (const id of trackTrails.keys()) {
    if (!activeIds.has(id)) trackTrails.delete(id)
  }
}

/** 缓存的排序后检测结果（避免每次绘制重复排序） */
let sortedDetectionsCache: Detection[] = []
let sortedDetectionsDirty = true

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
const detectionSummary = ref('')

/** 更新检测摘要（在 poll 回调中调用） */
function updateDetectionSummary() {
  detectCount.value = localDetections.length
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
function checkFrozen() {
  if (!props.online) { frozen.value = false; return }
  frozen.value = props.lastFrameAt > 0 && (Date.now() - props.lastFrameAt) > 10000
}
/** WS 帧消费：上次已消费的版本号 */
let consumedWsVersion = 0

/** 喂入帧数据并更新帧尺寸 */
function onFrameDecoded(jpeg: ArrayBuffer) {
  feedFrame(jpeg)
  const size = getFrameSize()
  if (size.width > 0 && size.height > 0) {
    frameSize.value = size
  }
}

watch(() => props.online, (on) => {
  if (on) {
    if (useMse.value) {
      /** MSE 模式：直接连接 fMP4 流 */
      fmp4.connect()
      nextTick(() => startOverlayLoop())
    } else {
      /** Canvas 模式：启动渲染循环 + MJPEG fallback */
      startLoop()
      authFetch(`/api/snapshot/${props.cameraId}`)
        .then(res => res.ok ? res.arrayBuffer() : null)
        .then(buf => {
          if (buf && buf.byteLength > 100) onFrameDecoded(buf)
        })
        .catch(() => { /* 快照获取失败不影响实时流 */ })
      const url = authUrl(`/api/stream/${props.cameraId}`)
      mjpegStream.startFetch(url, onFrameDecoded)
    }
    frozenTimer = setInterval(checkFrozen, 3000); checkFrozen()
  }
  else {
    fmp4.disconnect()
    stopOverlayLoop()
    mjpegStream.stopFetch()
    stopLoop()
    frozen.value = false
    if (frozenTimer) { clearInterval(frozenTimer); frozenTimer = null }
  }
}, { immediate: true })

/** WS 帧消费：通过 rAF poll 替代 Vue watcher，减少响应式开销 */
let mjpegSuppressed = false
let mjpegRestoreTimer: ReturnType<typeof setTimeout> | null = null

/** 本地检测结果缓存（从 ws-detect-cache poll） */
let localDetections: Detection[] = []
let consumedDetectVersion = 0

setFramePollFn(() => {
  if (!props.online) return

  /** poll 检测结果 */
  const detectResult = takeDetections(props.cameraId, consumedDetectVersion)
  if (detectResult) {
    consumedDetectVersion = detectResult.version
    localDetections = detectResult.detections
    invalidateSortedDetections()
    updateDetectionSummary()
  }

  const result = takeFrame(props.cameraId, consumedWsVersion)
  if (result) {
    consumedWsVersion = result.version
    onFrameDecoded(result.jpeg)
    /** 收到 WS 帧时暂停 MJPEG fetch（节省带宽） */
    if (!mjpegSuppressed) {
      mjpegStream.stopFetch()
      mjpegSuppressed = true
    }
    /** 重置恢复定时器：3 秒无 WS 帧则恢复 MJPEG */
    if (mjpegRestoreTimer) clearTimeout(mjpegRestoreTimer)
    mjpegRestoreTimer = setTimeout(() => {
      if (mjpegSuppressed && props.online) {
        const url = authUrl(`/api/stream/${props.cameraId}`)
        mjpegStream.startFetch(url, onFrameDecoded)
        mjpegSuppressed = false
      }
    }, 3000)
  }
})
watch(() => props.lastFrameAt, () => { if (frozen.value) frozen.value = false })

/** 画面比例：优先用帧实际尺寸/MSE video 尺寸，回退到 props */
const frameSize = ref({ width: 0, height: 0 })
const cameraBodyStyle = computed(() => {
  const mseW = fmp4.videoWidth.value
  const mseH = fmp4.videoHeight.value
  const fw = mseW || frameSize.value.width || props.videoWidth || 0
  const fh = mseH || frameSize.value.height || props.videoHeight || 0
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
const LABEL_COLORS: Record<string, string> = {
  person: '#FF6B6B',
  car: '#4ECDC4',
  truck: '#45B7D1',
  bus: '#96CEB4',
  motorcycle: '#FFEAA7',
  bicycle: '#DDA0DD',
  dog: '#F4A460',
  cat: '#FFB6C1',
}

/** 根据 trackId + label 获取颜色（trackId 优先保证唯一性） */
function getColor(label: string, trackId?: number): { stroke: string; fill: string } {
  if (trackId != null) {
    /** 黄金角分布：每个 trackId 色相间隔 ~137.5°，饱和度 75%，亮度 60% */
    const hue = (trackId * 137.508) % 360
    return { stroke: `hsl(${hue}, 75%, 60%)`, fill: `hsla(${hue}, 75%, 60%, 0.12)` }
  }
  const hex = LABEL_COLORS[label] ?? '#4ECDC4'
  return { stroke: hex, fill: hex + '1F' }
}

/** Canvas overlay 绘制 OSD（摄像头名称 + 时钟 + FPS/延迟/AI指标） */
function drawOSD(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.save()

  /** 左上角：摄像头名称 */
  if (props.name) {
    ctx.font = 'bold 13px monospace'
    ctx.textBaseline = 'top'
    const nameText = props.name
    const nm = ctx.measureText(nameText)
    const pad = 4
    ctx.fillStyle = 'rgba(0,0,0,0.5)'
    ctx.fillRect(4, 4, nm.width + pad * 2, 18)
    ctx.fillStyle = '#fff'
    ctx.fillText(nameText, 4 + pad, 6)
  }

  /** 左下角：时钟 */
  if (clockText.value) {
    ctx.font = 'bold 12px monospace'
    ctx.textBaseline = 'bottom'
    const tm = ctx.measureText(clockText.value)
    const pad = 4
    const y = height - 4
    ctx.fillStyle = 'rgba(0,0,0,0.5)'
    ctx.fillRect(4, y - 18, tm.width + pad * 2, 18)
    ctx.fillStyle = '#fff'
    ctx.fillText(clockText.value, 4 + pad, y - 4)
  }

  /** 右下角：渲染FPS + 源FPS + 延迟 + AI耗时 + 分辨率 指标栏 */
  const stats: Array<{ text: string; color: string }> = []
  /** MSE 模式使用 fMP4 segment FPS，Canvas 模式使用渲染帧率 */
  const renderFps = useMse.value ? fmp4.fps.value : getRenderFps()
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
  /** MSE 模式用 fmp4 分辨率，Canvas 模式用帧尺寸 */
  const w = useMse.value ? (fmp4.videoWidth.value || 0) : frameSize.value.width
  const h = useMse.value ? (fmp4.videoHeight.value || 0) : frameSize.value.height
  if (w > 0 && h > 0) {
    stats.push({ text: `${w}x${h}`, color: '#888' })
  }

  if (stats.length > 0) {
    ctx.font = '10px monospace'
    ctx.textBaseline = 'bottom'
    const pad = 4
    let totalWidth = 0
    for (const s of stats) {
      totalWidth += ctx.measureText(s.text).width + pad * 2 + 4
    }
    totalWidth -= 4
    const boxX = width - totalWidth - 4
    const boxY = height - 4

    let x = boxX
    for (const s of stats) {
      const tw = ctx.measureText(s.text).width + pad * 2
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.fillRect(x, boxY - 16, tw, 16)
      ctx.fillStyle = s.color
      ctx.fillText(s.text, x + pad, boxY - 3)
      x += tw + 4
    }
  }

  ctx.restore()
}

/** Canvas overlay 绘制检测框 + OSD */
function drawDetectionOverlay(ctx: CanvasRenderingContext2D, width: number, height: number) {
  if (!hasFrame.value) {
    trackTrails.clear()
    return
  }

  /** 绘制 OSD（摄像头名称 + 时钟，始终显示） */
  drawOSD(ctx, width, height)

  if (!props.showBoxes) {
    trackTrails.clear()
    return
  }

  /** 记录轨迹 + 清理失效轨迹 */
  recordTrails()
  cleanupTrails()

  const sorted = getSortedDetections()
  if (sorted.length === 0) return

  ctx.save()
  ctx.font = 'bold 12px monospace'
  ctx.textBaseline = 'bottom'

  for (const d of sorted) {
    const { stroke, fill } = getColor(d.label, d.trackId)
    const x = d.box.xmin * width
    const y = d.box.ymin * height
    const w = (d.box.xmax - d.box.xmin) * width
    const h = (d.box.ymax - d.box.ymin) * height

    /** 绘制圆角矩形框 + 半透明填充 */
    const r = Math.min(4, w / 4, h / 4)
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + w - r, y)
    ctx.arcTo(x + w, y, x + w, y + r, r)
    ctx.lineTo(x + w, y + h - r)
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
    ctx.lineTo(x + r, y + h)
    ctx.arcTo(x, y + h, x, y + h - r, r)
    ctx.lineTo(x, y + r)
    ctx.arcTo(x, y, x + r, y, r)
    ctx.closePath()

    ctx.fillStyle = fill
    ctx.fill()
    ctx.strokeStyle = stroke
    ctx.lineWidth = 2
    ctx.stroke()

    /** 绘制标签背景和文字 */
    const tid = d.trackId
    const customName = tid ? props.trackLabels?.[tid] : undefined
    const parts: string[] = []
    if (customName) parts.push(customName)
    if (tid) parts.push(`#${tid}`)
    parts.push(d.label)
    parts.push(`${(d.score * 100).toFixed(0)}%`)
    const text = parts.join(' ')

    const textMetrics = ctx.measureText(text)
    const labelH = 18
    const labelY = y > labelH + 2 ? y - 2 : y + h + labelH + 2
    const labelW = textMetrics.width + 10

    /** 标签背景：圆角 + 不透明填充 */
    ctx.beginPath()
    ctx.moveTo(x + 2, labelY - labelH)
    ctx.lineTo(x + labelW - 2, labelY - labelH)
    ctx.arcTo(x + labelW, labelY - labelH, x + labelW, labelY - labelH + 2, 2)
    ctx.lineTo(x + labelW, labelY - 2)
    ctx.arcTo(x + labelW, labelY, x + labelW - 2, labelY, 2)
    ctx.lineTo(x + 2, labelY)
    ctx.arcTo(x, labelY, x, labelY - 2, 2)
    ctx.lineTo(x, labelY - labelH + 2)
    ctx.arcTo(x, labelY - labelH, x + 2, labelY - labelH, 2)
    ctx.closePath()
    ctx.fillStyle = stroke
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.fillText(text, x + 5, labelY - 4)
  }

  /** 绘制追踪轨迹线（贝塞尔平滑曲线） */
  if (trackTrails.size > 0) {
    ctx.lineWidth = 1.5
    ctx.setLineDash([])
    for (const [trackId, points] of trackTrails) {
      if (points.length < 2) continue
      const color = getColor('', trackId)
      ctx.strokeStyle = color.stroke
      ctx.globalAlpha = 0.5
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
    }
  }

  /** 绘制 ROI 区域 */
  if (props.roiRegions && props.roiRegions.length > 0) {
    ctx.lineWidth = 1.5
    ctx.setLineDash([6, 4])
    for (const roi of props.roiRegions) {
      if (roi.points.length < 3) continue
      ctx.strokeStyle = 'rgba(156, 39, 176, 0.7)'
      ctx.fillStyle = 'rgba(156, 39, 176, 0.08)'
      ctx.beginPath()
      ctx.moveTo(roi.points[0]!.x * width, roi.points[0]!.y * height)
      for (let i = 1; i < roi.points.length; i++) {
        ctx.lineTo(roi.points[i]!.x * width, roi.points[i]!.y * height)
      }
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      /** ROI 名称 */
      if (roi.name) {
        const cx = roi.points.reduce((s, p) => s + p.x, 0) / roi.points.length * width
        const cy = roi.points.reduce((s, p) => s + p.y, 0) / roi.points.length * height
        ctx.setLineDash([])
        ctx.font = 'bold 10px sans-serif'
        ctx.fillStyle = 'rgba(156, 39, 176, 0.9)'
        ctx.textAlign = 'center'
        ctx.fillText(roi.name, cx, cy)
        ctx.textAlign = 'start'
        ctx.setLineDash([6, 4])
      }
    }
    ctx.setLineDash([])
  }

  ctx.restore()
}

/** 注册 Canvas overlay */
setOverlay(drawDetectionOverlay)
const namingBox = ref<{ trackId: number; label: string; x: number; y: number } | null>(null)
const namingName = ref('')
const namingInput = ref<HTMLInputElement | null>(null)

const namingPopupStyle = computed(() => {
  if (!namingBox.value) return {}
  return {
    left: `${Math.min(namingBox.value.x, 80)}%`,
    top: `${Math.min(namingBox.value.y, 80)}%`,
  }
})

/** Canvas contextmenu 事件：根据点击位置匹配最近的检测框 */
function onCanvasContext(e: MouseEvent) {
  const sorted = getSortedDetections()
  if (sorted.length === 0) return
  const canvas = e.currentTarget as HTMLElement
  const rect = canvas.getBoundingClientRect()
  const nx = (e.clientX - rect.left) / rect.width
  const ny = (e.clientY - rect.top) / rect.height

  /** 找到包含点击位置且面积最小的检测框（最精确匹配） */
  let best: { trackId?: number; label: string; box: Detection['box'] } | null = null
  let bestArea = Infinity
  for (const d of sorted) {
    if (nx >= d.box.xmin && nx <= d.box.xmax && ny >= d.box.ymin && ny <= d.box.ymax) {
      const area = (d.box.xmax - d.box.xmin) * (d.box.ymax - d.box.ymin)
      if (area < bestArea) {
        best = d
        bestArea = area
      }
    }
  }
  if (!best || !best.trackId) return
  const x = nx * 100
  const y = ny * 100
  const existing = props.trackLabels?.[best.trackId] ?? ''
  namingBox.value = { trackId: best.trackId, label: best.label, x, y }
  namingName.value = existing
  nextTick(() => namingInput.value?.focus())
}

async function saveNaming() {
  if (!namingBox.value || !namingName.value.trim()) { cancelNaming(); return }
  const { trackId, label } = namingBox.value
  await authFetch('/api/track-labels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cameraId: props.cameraId, trackId, label, name: namingName.value.trim() }),
  })
  emit('trackLabelUpdated')
  cancelNaming()
}

function cancelNaming() {
  namingBox.value = null
  namingName.value = ''
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

/** 截图下载当前画面（直接从 Canvas 导出，包含检测框+轨迹+ROI+OSD） */
async function takeScreenshot() {
  const now = new Date()
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
  const link = document.createElement('a')
  link.download = `${props.name}_${ts}.jpg`

  if (useMse.value && fmp4.videoRef.value) {
    /** MSE 模式：从 video + overlay canvas 合成截图 */
    const video = fmp4.videoRef.value
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth || 1920
    canvas.height = video.videoHeight || 1080
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(video, 0, 0)
    /** 叠加 overlay */
    if (overlayCanvas.value) {
      ctx.drawImage(overlayCanvas.value, 0, 0)
    }
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92))
    if (blob) {
      const url = URL.createObjectURL(blob)
      link.href = url
      link.click()
      URL.revokeObjectURL(url)
    }
  } else {
    /** Canvas fallback 模式 */
    const blob = await captureJpeg()
    if (blob) {
      const url = URL.createObjectURL(blob)
      link.href = url
      link.click()
      URL.revokeObjectURL(url)
    }
  }
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
  fmp4.disconnect()
  stopOverlayLoop()
  mjpegStream.stopFetch()
  stopLoop()
  if (mjpegRestoreTimer) clearTimeout(mjpegRestoreTimer)
  if (clockTimer) clearInterval(clockTimer)
  if (recDurationTimer) clearInterval(recDurationTimer)
})
</script>

<template>
  <div class="camera-view" :class="{ offline: !online }">
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
      <span v-if="frozen" class="frozen-badge">{{ t('camera.frozen') }}</span>
      <button class="fullscreen-btn" @click="emit('fullscreen', cameraId)" :title="t('camera.fullscreen')">&#x26F6;</button>
      <button v-if="online" class="screenshot-btn" @click="takeScreenshot" :title="t('camera.screenshot')">&#x1F4F7;</button>
      <button v-if="online" class="recording-btn" @click="emit('jumpToRecording', cameraId, Date.now())" :title="t('camera.jumpToRecording')">&#x25B6;</button>
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
      <div class="camera-content" :style="{ transform: zoomTransform }">
        <!-- MSE 模式：video 硬件解码 -->
        <template v-if="useMse && online">
          <div class="mse-wrapper">
            <video
              :ref="(el: any) => fmp4.setVideo(el as HTMLVideoElement | null)"
              class="camera-video"
              :style="{ filter: imageFilter }"
              autoplay muted playsinline
              @contextmenu.prevent="onCanvasContext"
            />
            <canvas
              ref="overlayCanvas"
              class="camera-overlay"
              @contextmenu.prevent="onCanvasContext"
            />
          </div>
        </template>
        <!-- Canvas fallback 模式 -->
        <canvas
          v-else-if="online"
          :ref="(el: any) => setCanvas(el as HTMLCanvasElement | null)"
          class="camera-image"
          :style="{ filter: imageFilter }"
          @contextmenu.prevent="onCanvasContext"
        />
        <div v-else class="camera-placeholder">
          <div v-if="online" class="placeholder-icon">&#9679;</div>
          <div v-else class="placeholder-icon offline-icon">&#10005;</div>
          <span>{{ online ? t('camera.waiting') : t('camera.cameraOffline') }}</span>
          <span v-if="!online && lastSeenText" class="last-seen">{{ lastSeenText }}</span>
        </div>

        <!-- 检测框由 Canvas overlay 绘制（不再使用 HTML TransitionGroup） -->

        <!-- 右键命名弹出框 -->
        <div v-if="namingBox" class="naming-popup" :style="namingPopupStyle">
          <div class="naming-title">{{ namingBox.label }} #{{ namingBox.trackId }}</div>
          <input
            ref="namingInput"
            v-model="namingName"
            class="naming-input"
            :placeholder="t('roi.name')"
            @keydown.enter="saveNaming"
            @keydown.escape="cancelNaming"
          />
          <div class="naming-actions">
            <button class="naming-save" @click="saveNaming">{{ t('manage.save') }}</button>
            <button class="naming-cancel" @click="cancelNaming">{{ t('manage.cancel') }}</button>
          </div>
        </div>
      </div>

      <!-- 双流模式标记 -->
      <div v-if="online && hasFrame && dualStream" class="dual-stream-badge" :title="`HD显示 + SD检测(${(detectFps ?? 0).toFixed(0)}fps)`">
        HD+SD
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
}

.camera-video {
  max-width: 100%;
  max-height: 100%;
  display: block;
}

.camera-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
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
.dual-stream-badge {
  position: absolute;
  bottom: 6px;
  right: 90px;
  background: rgba(78, 205, 196, 0.75);
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 9px;
  font-weight: 700;
  font-family: 'Courier New', Courier, monospace;
  color: #fff;
  pointer-events: none;
}

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
