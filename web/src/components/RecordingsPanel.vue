<script setup lang="ts">
import { ref, onUnmounted, computed, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { authFetch, authUrl } from '../services/auth'
import { takeFrame } from '../services/ws-frame-cache'
import RecordingsTimeline from './RecordingsTimeline.vue'
import MultiTimeline from './MultiTimeline.vue'
import { confirmDialog } from '../composables/useConfirm'
import { usePreferences } from '../composables/usePreferences'

const { t, locale } = useI18n()

const { cache, setPref, getPref } = usePreferences()

/** 从后端偏好缓存恢复初始值 */
getPref<string>('nvr-rec-filter-camera', '').then(v => { filterCamera.value = v })
getPref<string[]>('nvr-starred-recordings', []).then(v => { starredFiles.value = new Set(v) })
getPref<string>('nvr-timeline-mode', 'auto').then(v => { timelineMode.value = v as 'auto' | 'multi' | 'single' })
getPref<number>('nvr-playback-speed', 1).then(v => { playbackSpeed.value = v })
getPref<boolean>('nvr-auto-play-next', true).then(v => { autoPlayNext.value = v })
getPref<number>('nvr-volume', 1).then(v => { volume.value = Math.round(v * 100) })
getPref<string>('nvr-rec-sort', 'newest').then(v => { sortMode.value = v as SortMode })

/** 检测目标标签 → 颜色 */
import { eventMarkerColor } from '../services/constants'

/** 录像信息 */
interface Recording {
  filename: string
  cameraId: string
  startTime: number
  endTime: number
  size: number
  /** 标签搜索时返回的匹配事件数 */
  matchCount?: number
  /** 搜索匹配的事件时间戳数组 */
  matchTimestamps?: number[]
}

const props = defineProps<{
  cameras: Array<{ id: string; name: string }>
  /** 追踪标签映射：cameraId -> trackId -> 自定义名称 */
  trackLabels?: Record<string, Record<number, string>>
  /** 是否为当前激活的标签页 */
  active?: boolean
}>()

const recordings = ref<Recording[]>([])
const selectedRecording = ref<Recording | null>(null)
const filterCamera = ref('')
/** 日期筛选（YYYY-MM-DD） */
const filterDate = ref('')
/** 仅显示有检测/变动事件的录像 */
const filterEventsOnly = ref(false)
const loading = ref(false)
/** AI 目标搜索关键词 */
const searchLabel = ref('')
const isSearching = ref(false)

/** 录像列表定时刷新定时器 */
let refreshTimer: ReturnType<typeof setInterval> | null = null

/** 多选模式 */
const multiSelectMode = ref(false)
const selectedFiles = ref<Set<string>>(new Set())
const merging = ref(false)
const mergeFilename = ref('')
/** ZIP 打包状态 */
const zipping = ref(false)
const zipFilename = ref('')

/** 收藏录像集合 */
const starredFiles = ref<Set<string>>(new Set())
/** 时间轴视图模式：auto 自动 / multi 多路 / single 单路 */
const timelineMode = ref<'auto' | 'multi' | 'single'>('auto')

/** 实际使用的时间轴视图 */
const effectiveTimeline = computed(() => {
  if (timelineMode.value === 'multi') return 'multi'
  if (timelineMode.value === 'single') return 'single'
  return filterCamera.value ? 'single' : 'multi'
})

function setTimelineMode(mode: 'auto' | 'multi' | 'single') {
  timelineMode.value = mode
  setPref('nvr-timeline-mode', mode)
}

/** 仅看收藏 */
const filterStarred = ref(false)
function toggleRecStar(filename: string) {
  const s = new Set(starredFiles.value)
  if (s.has(filename)) s.delete(filename)
  else s.add(filename)
  starredFiles.value = s
  setPref('nvr-starred-recordings', [...s])
}

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
function toggleAutoPlay() {
  autoPlayNext.value = !autoPlayNext.value
  setPref('nvr-auto-play-next', autoPlayNext.value)
}

/** 倍速变更时同步到 video 元素 */
function changeSpeed(speed: number) {
  playbackSpeed.value = speed
  setPref('nvr-playback-speed', speed)
  if (playerRef.value) playerRef.value.playbackRate = speed
}

/** 智能倍速开关 */
const smartSpeed = ref(false)
/** 智能倍速：根据事件密度自动调整播放速度 */
function updateSmartSpeed() {
  if (!smartSpeed.value || !playerRef.value || !selectedRecording.value || playbackEvents.value.length === 0) return
  const t = currentAbsTime.value
  /** 查找距离当前时间最近的事件（前后 5 秒窗口） */
  const windowMs = 5000
  let nearestDist = Infinity
  for (const e of playbackEvents.value) {
    const dist = Math.abs(e.timestamp - t)
    if (dist < nearestDist) nearestDist = dist
  }
  /** 根据距离最近事件的远近来决定倍速 */
  let targetSpeed: number
  if (nearestDist < 1000) {
    targetSpeed = 1
  } else if (nearestDist < 3000) {
    targetSpeed = 1.5
  } else if (nearestDist < windowMs) {
    targetSpeed = 2
  } else {
    targetSpeed = 4
  }
  /** 平滑过渡（不直接跳变，而是渐进） */
  const current = playerRef.value.playbackRate
  const diff = targetSpeed - current
  if (Math.abs(diff) > 0.2) {
    const newSpeed = Math.round((current + diff * 0.3) * 10) / 10
    playerRef.value.playbackRate = Math.max(0.5, Math.min(8, newSpeed))
    playbackSpeed.value = playerRef.value.playbackRate
  }
}

/** video 元素 ratechange 事件（用户通过浏览器原生控件改倍速时同步下拉框） */
function onRateChange() {
  if (playerRef.value) playbackSpeed.value = playerRef.value.playbackRate
}

/** video 元素 loadedmetadata 事件：恢复倍速 + 执行 seek 跳转 */
function onLoadedMetadata() {
  if (!playerRef.value) return
  playerRef.value.playbackRate = playbackSpeed.value
  initVolume()
  if (seekOffset.value >= 0) {
    playerRef.value.currentTime = seekOffset.value
    seekOffset.value = -1
  }
}

/** 视频播放结束，自动播放同摄像头的下一段录像 */
function onVideoEnded() {
  if (!autoPlayNext.value || !selectedRecording.value) return
  playNextRecording()
}

/** 获取当前摄像头按时间排列的录像列表 */
function sameCameraRecordings() {
  return filteredRecordings.value
    .filter(r => r.cameraId === selectedRecording.value!.cameraId)
    .sort((a, b) => a.startTime - b.startTime)
}

/** 播放下一个录像 */
function playNextRecording() {
  if (!selectedRecording.value) return
  const list = sameCameraRecordings()
  const idx = list.findIndex(r => r.filename === selectedRecording.value!.filename)
  if (idx >= 0 && idx < list.length - 1) {
    play(list[idx + 1]!)
  }
}

/** 播放上一个录像 */
function playPrevRecording() {
  if (!selectedRecording.value) return
  const list = sameCameraRecordings()
  const idx = list.findIndex(r => r.filename === selectedRecording.value!.filename)
  if (idx > 0) {
    play(list[idx - 1]!)
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
/** A-B 循环播放 */
const loopStart = ref(-1)
const loopEnd = ref(-1)

function onTimeUpdate() {
  if (!playerRef.value || !selectedRecording.value) return
  currentAbsTime.value = selectedRecording.value.startTime + playerRef.value.currentTime * 1000
  /** A-B 循环：到达 B 点时跳回 A 点 */
  if (loopStart.value >= 0 && loopEnd.value > loopStart.value) {
    if (playerRef.value.currentTime >= loopEnd.value) {
      playerRef.value.currentTime = loopStart.value
    }
  }
  /** 更新回放检测框 */
  updatePlaybackDetections()
  /** 智能倍速 */
  updateSmartSpeed()
}

/** 回放检测框叠加 */
interface PlaybackDetection {
  label: string
  score: number
  box: { xmin: number; ymin: number; xmax: number; ymax: number }
  trackId?: number
  trackName?: string
  /** CLIP 语义标签 */
  semanticLabel?: string
}
/** 当前录像的检测事件列表（预加载） */
const playbackEvents = ref<Array<{ timestamp: number; detections: PlaybackDetection[] }>>([])
/** 当前显示的检测框 */
const playbackDetections = ref<PlaybackDetection[]>([])
/** 是否显示回放检测框 */
const showPlaybackBoxes = ref(true)
/** 显示播放器事件列表 */
const showPlaybackEventList = ref(false)
/** 是否显示回放轨迹 */
const showPlaybackTrail = ref(true)
/** 回放轨迹线（每个 trackId 的历史中心点路径） */
const playbackTrails = ref<Array<{ trackId: number; label: string; points: Array<{ x: number; y: number }> }>>([])
/** 回放行为事件列表 */
const playbackBehaviorEvents = ref<Array<{ timestamp: number; type: string; summary: string }>>([])
/** 轨迹线颜色池 */
const TRAIL_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#F4A460', '#87CEEB', '#98D8C8', '#F7DC6F']

/** 播放录像时加载检测事件和行为事件 */
async function loadPlaybackDetections(rec: Recording) {
  playbackEvents.value = []
  playbackDetections.value = []
  playbackBehaviorEvents.value = []
  const detectParams = new URLSearchParams({
    type: 'detect',
    cameraId: rec.cameraId,
    since: String(rec.startTime),
    until: String(rec.endTime),
    limit: '2000',
  })
  const behaviorParams = new URLSearchParams({
    typeLike: 'track:%',
    cameraId: rec.cameraId,
    since: String(rec.startTime),
    until: String(rec.endTime),
    limit: '500',
  })
  try {
    const [detectRes, behaviorRes] = await Promise.all([
      authFetch(`/api/events/history?${detectParams}`),
      authFetch(`/api/events/history?${behaviorParams}`),
    ])
    if (detectRes.ok) {
      const data = await detectRes.json()
      playbackEvents.value = (data.events as Array<{ timestamp: number; detail: string | null }>)
        .filter(e => e.detail)
        .map(e => {
          const detail = JSON.parse(e.detail!) as { detections?: PlaybackDetection[] }
          return { timestamp: e.timestamp, detections: detail.detections ?? [] }
        })
    }
    if (behaviorRes.ok) {
      const data = await behaviorRes.json()
      playbackBehaviorEvents.value = (data.events as Array<{ timestamp: number; type: string; detail: string | null }>)
        .filter(e => e.detail)
        .map(e => {
          const d = JSON.parse(e.detail!) as { trackName?: string; label?: string; semanticLabel?: string; zoneName?: string; lineName?: string; dwellMs?: number }
          const parts: string[] = []
          if (d.trackName) parts.push(d.trackName)
          else if (d.semanticLabel) parts.push(d.semanticLabel)
          else if (d.label) parts.push(d.label)
          if (d.zoneName) parts.push(d.zoneName)
          if (d.lineName) parts.push(d.lineName)
          if (d.dwellMs && d.dwellMs > 0) parts.push(`${(d.dwellMs / 1000).toFixed(0)}s`)
          return { timestamp: e.timestamp, type: e.type, summary: parts.join(' → ') }
        })
    }
  } catch {
    // ignore
  }
}

/** 行为事件类型样式 */
const BEHAVIOR_EVENT_STYLE: Record<string, { label: string; bg: string }> = {
  'track:enter-zone': { label: '进入', bg: '#26A69A' },
  'track:leave-zone': { label: '离开', bg: '#7E57C2' },
  'track:dwell': { label: '停留', bg: '#FF7043' },
  'track:speed': { label: '高速', bg: '#E91E63' },
  'track:line-cross': { label: '越线', bg: '#FF6F00' },
  'track:loiter': { label: '徘徊', bg: '#795548' },
  'track:appeared': { label: '出现', bg: '#66BB6A' },
  'track:disappeared': { label: '消失', bg: '#EF5350' },
}

/** 根据 currentAbsTime 更新当前检测框和轨迹 */
function updatePlaybackDetections() {
  if (!showPlaybackBoxes.value || playbackEvents.value.length === 0) {
    playbackDetections.value = []
    playbackTrails.value = []
    return
  }
  const t = currentAbsTime.value
  /** 二分查找：找到 timestamp <= t 的最后一个事件 */
  let lo = 0, hi = playbackEvents.value.length - 1, best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (playbackEvents.value[mid]!.timestamp <= t) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  /** 动态超时窗口：取前一个事件的间隔 × 1.5，最小 3 秒，最大 10 秒 */
  const eventTs = playbackEvents.value[best]!.timestamp
  const prevIdx = best > 0 ? best - 1 : undefined
  const gap = prevIdx !== undefined ? eventTs - playbackEvents.value[prevIdx]!.timestamp : 3000
  const threshold = Math.max(3000, Math.min(10_000, gap * 1.5))
  if (best >= 0 && t - eventTs < threshold) {
    playbackDetections.value = playbackEvents.value[best]!.detections
  } else {
    playbackDetections.value = []
  }

  /** 计算轨迹：从当前帧往前回溯，收集每个 trackId 的历史中心点 */
  if (!showPlaybackTrail.value || best < 0) {
    playbackTrails.value = []
    return
  }
  /** 收集当前帧中活跃的 trackId */
  const activeTracks = new Map<number, string>()
  for (const d of playbackDetections.value) {
    if (d.trackId != null) activeTracks.set(d.trackId, d.semanticLabel || d.label)
  }
  if (activeTracks.size === 0) {
    playbackTrails.value = []
    return
  }
  /** 回溯最近 5 秒的事件，构建轨迹 */
  const trailWindow = 5000
  const trailStart = t - trailWindow
  const trailMap = new Map<number, Array<{ x: number; y: number }>>()
  for (let i = 0; i <= best; i++) {
    const evt = playbackEvents.value[i]!
    if (evt.timestamp < trailStart) continue
    for (const d of evt.detections) {
      if (d.trackId == null || !activeTracks.has(d.trackId)) continue
      const cx = (d.box.xmin + d.box.xmax) / 2
      const cy = (d.box.ymin + d.box.ymax) / 2
      let trail = trailMap.get(d.trackId)
      if (!trail) {
        trail = []
        trailMap.set(d.trackId, trail)
      }
      trail.push({ x: cx, y: cy })
    }
  }
  /** 转换为 playbackTrails 数组 */
  const trails: Array<{ trackId: number; label: string; points: Array<{ x: number; y: number }> }> = []
  for (const [trackId, points] of trailMap) {
    if (points.length >= 2) {
      trails.push({ trackId, label: activeTracks.get(trackId) ?? '', points })
    }
  }
  playbackTrails.value = trails
}

/** 获取回放检测框标签（含自定义名称，优先 semanticLabel） */
function getPlaybackDetectLabel(cameraId: string, d: PlaybackDetection): string {
  const camLabels = props.trackLabels?.[cameraId]
  const customName = d.trackName || (d.trackId && camLabels?.[d.trackId])
  if (customName) return `${customName} ${(d.score * 100).toFixed(0)}%`
  const displayLabel = d.semanticLabel || d.label
  const parts: string[] = []
  if (d.trackId) parts.push(`#${d.trackId}`)
  parts.push(displayLabel)
  parts.push(`${(d.score * 100).toFixed(0)}%`)
  return parts.join(' ')
}

/** 设置循环起点/终点 */
function setLoopPoint(which: 'a' | 'b') {
  if (!playerRef.value) return
  const t = playerRef.value.currentTime
  if (which === 'a') {
    loopStart.value = t
    if (loopEnd.value >= 0 && loopEnd.value <= t) loopEnd.value = -1
  } else {
    if (t > (loopStart.value >= 0 ? loopStart.value : 0)) {
      loopEnd.value = t
    }
  }
}

function clearLoop() {
  loopStart.value = -1
  loopEnd.value = -1
}

/** 播放进度百分比 */
const playProgress = computed(() => {
  if (!playerRef.value || !playerRef.value.duration || !isFinite(playerRef.value.duration)) return 0
  return (playerRef.value.currentTime / playerRef.value.duration) * 100
})

/** 进度条上的检测事件标记位置 */
const progressEventMarkers = computed(() => {
  if (!selectedRecording.value || playbackEvents.value.length === 0) return []
  const rec = selectedRecording.value
  const duration = rec.endTime - rec.startTime
  if (duration <= 0) return []
  return playbackEvents.value.map((e, i) => ({
    key: i,
    position: ((e.timestamp - rec.startTime) / duration) * 100,
    count: e.detections.length,
    labels: [...new Set(e.detections.map(d => d.label))],
  })).filter(m => m.position >= 0 && m.position <= 100)
})

/** 当前播放位置对应的事件索引（用于事件列表高亮） */
const activePlaybackEventIdx = computed(() => {
  if (!selectedRecording.value || playbackEvents.value.length === 0) return -1
  const absTime = currentAbsTime.value
  if (!absTime) return -1
  let best = -1
  for (let i = 0; i < playbackEvents.value.length; i++) {
    if (playbackEvents.value[i]!.timestamp <= absTime) best = i
  }
  return best
})

/** 跳转到指定检测事件时间点 */
function seekToPlaybackEvent(timestamp: number) {
  if (!playerRef.value || !selectedRecording.value) return
  const offsetSec = (timestamp - selectedRecording.value.startTime) / 1000
  playerRef.value.currentTime = Math.max(0, offsetSec)
}

/** 跳转到下一个/上一个检测事件 */
function seekNextEvent(direction: 1 | -1) {
  if (!playerRef.value || !selectedRecording.value || playbackEvents.value.length === 0) return
  const absTime = currentAbsTime.value
  const events = direction > 0 ? playbackEvents.value : [...playbackEvents.value].reverse()
  for (const e of events) {
    const ts = e.timestamp
    if (direction > 0 && ts > absTime + 500) {
      seekToPlaybackEvent(ts)
      return
    }
    if (direction < 0 && ts < absTime - 500) {
      seekToPlaybackEvent(ts)
      return
    }
  }
}
const progressEl = ref<HTMLDivElement | null>(null)
function onProgressClick(e: MouseEvent) {
  if (!playerRef.value || !progressEl.value) return
  const rect = progressEl.value.getBoundingClientRect()
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  playerRef.value.currentTime = pct * playerRef.value.duration
}

/** 点击检测事件标记跳转到对应位置 */
function seekToMarker(positionPct: number) {
  if (!playerRef.value) return
  const pct = Math.max(0, Math.min(1, positionPct / 100))
  playerRef.value.currentTime = pct * playerRef.value.duration
}

/** 进度条悬停提示 */
const hoverPct = ref(-1)
const hoverClientX = ref(0)
/** 悬停缩略图 URL */
const hoverThumbUrl = ref('')
let hoverThumbDebounce: ReturnType<typeof setTimeout> | null = null
function onProgressHover(e: MouseEvent) {
  if (!progressEl.value) return
  const rect = progressEl.value.getBoundingClientRect()
  hoverPct.value = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  hoverClientX.value = e.clientX
  /** 延迟加载悬停缩略图（200ms 防抖） */
  if (hoverThumbDebounce) clearTimeout(hoverThumbDebounce)
  hoverThumbDebounce = setTimeout(() => {
    if (!selectedRecording.value || hoverPct.value < 0) return
    const durationMs = selectedRecording.value.endTime - selectedRecording.value.startTime
    const timeSec = Math.max(0, hoverPct.value * durationMs / 1000)
    hoverThumbUrl.value = authUrl(`/api/recordings/thumb?file=${encodeURIComponent(selectedRecording.value.filename)}&time=${timeSec.toFixed(1)}`)
  }, 200)
}
function onProgressLeave() {
  hoverPct.value = -1
  hoverThumbUrl.value = ''
  if (hoverThumbDebounce) { clearTimeout(hoverThumbDebounce); hoverThumbDebounce = null }
}
/** 悬停位置的绝对时间 */
const hoverAbsTime = computed(() => {
  if (!selectedRecording.value || hoverPct.value < 0) return 0
  const durationMs = selectedRecording.value.endTime - selectedRecording.value.startTime
  return selectedRecording.value.startTime + hoverPct.value * durationMs
})

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

/** 音量控制 */
const volume = ref(100)
const isMuted = ref(false)
watch(volume, (v) => {
  if (playerRef.value) {
    playerRef.value.volume = v / 100
    setPref('nvr-volume', v / 100)
  }
})
function toggleMute() {
  if (!playerRef.value) return
  isMuted.value = !isMuted.value
  playerRef.value.muted = isMuted.value
}
/** 初始化音量 */
function initVolume() {
  if (!playerRef.value) return
  const v = Number(cache.value['nvr-volume'] ?? 1)
  playerRef.value.volume = v
  volume.value = Math.round(v * 100)
}

/** 播放器全屏切换 */
const playerModalEl = ref<HTMLDivElement | null>(null)
function togglePlayerFullscreen() {
  if (!playerModalEl.value) return
  if (document.fullscreenElement) {
    document.exitFullscreen()
  } else {
    playerModalEl.value.requestFullscreen()
  }
}

/** 截取当前视频帧并下载（叠加检测框） */
function takePlayerScreenshot() {
  if (!playerRef.value || !selectedRecording.value) return
  const video = playerRef.value
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth || 1920
  canvas.height = video.videoHeight || 1080
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  /** 叠加检测框 */
  if (showPlaybackBoxes.value && playbackDetections.value.length > 0) {
    const w = canvas.width
    const h = canvas.height
    ctx.font = 'bold 14px monospace'
    ctx.textBaseline = 'bottom'
    for (const d of playbackDetections.value) {
      const x = d.box.xmin * w
      const y = d.box.ymin * h
      const bw = (d.box.xmax - d.box.xmin) * w
      const bh = (d.box.ymax - d.box.ymin) * h
      ctx.strokeStyle = '#5bc0de'
      ctx.lineWidth = 2
      ctx.strokeRect(x, y, bw, bh)
      const label = getPlaybackDetectLabel(selectedRecording.value.cameraId, d)
      const metrics = ctx.measureText(label)
      ctx.fillStyle = 'rgba(91, 192, 222, 0.8)'
      ctx.fillRect(x, y - 20, metrics.width + 8, 20)
      ctx.fillStyle = '#fff'
      ctx.fillText(label, x + 4, y - 4)
    }
  }
  const link = document.createElement('a')
  const now = new Date()
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
  link.download = `${selectedRecording.value.cameraId}_${ts}.jpg`
  link.href = canvas.toDataURL('image/jpeg', 0.95)
  link.click()
}

/** 下载当前播放录像的原始 MP4 文件 */
function downloadRecording(rec?: Recording) {
  const target = rec ?? selectedRecording.value
  if (!target) return
  const link = document.createElement('a')
  link.href = authUrl(`/api/recordings/${target.filename}`)
  link.download = target.filename.split('/').pop() ?? 'recording.mp4'
  link.click()
}

/** 播放器键盘快捷键 */
function onPlayerKeydown(e: KeyboardEvent) {
  if (!selectedRecording.value || !playerRef.value) return
  const video = playerRef.value
  switch (e.key) {
    case ' ':
      e.preventDefault()
      isPlaying.value ? video.pause() : video.play()
      break
    case 'ArrowLeft':
      e.preventDefault()
      video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? 30 : 5))
      break
    case 'ArrowRight':
      e.preventDefault()
      video.currentTime = Math.min(video.duration, video.currentTime + (e.shiftKey ? 30 : 5))
      break
    case 'ArrowUp':
      e.preventDefault()
      volume.value = Math.min(100, volume.value + 5)
      break
    case 'ArrowDown':
      e.preventDefault()
      volume.value = Math.max(0, volume.value - 5)
      break
    case 'm':
    case 'M':
      toggleMute()
      break
    case 'f':
    case 'F':
      togglePlayerFullscreen()
      break
    case ',':
      e.preventDefault()
      stepFrame(-1)
      break
    case '.':
      e.preventDefault()
      stepFrame(1)
      break
    case '[':
      e.preventDefault()
      setLoopPoint('a')
      break
    case ']':
      e.preventDefault()
      setLoopPoint('b')
      break
    case '\\':
      e.preventDefault()
      clearLoop()
      break
    case '+':
    case '=':
      e.preventDefault()
      changeSpeed(Math.min(8, [0.5, 1, 1.5, 2, 4, 8].find(s => s > playbackSpeed.value) ?? 8))
      break
    case '-':
    case '_':
      e.preventDefault()
      changeSpeed(Math.max(0.5, [0.5, 1, 1.5, 2, 4, 8].reverse().find(s => s < playbackSpeed.value) ?? 0.5))
      break
    case 'p':
    case 'P':
      e.preventDefault()
      togglePip()
      break
    case 'n':
    case 'N':
      e.preventDefault()
      seekNextEvent(1)
      break
    case 'b':
    case 'B':
      e.preventDefault()
      seekNextEvent(-1)
      break
    case 'PageDown':
      e.preventDefault()
      playNextRecording()
      break
    case 'PageUp':
      e.preventDefault()
      playPrevRecording()
      break
  }
}

/** 逐帧步进（±1/30秒） */
function stepFrame(direction: number) {
  if (!playerRef.value) return
  playerRef.value.pause()
  const step = direction > 0 ? 1 / 30 : -1 / 30
  playerRef.value.currentTime = Math.max(0, Math.min(playerRef.value.duration, playerRef.value.currentTime + step))
}

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

/** 排序模式 */
type SortMode = 'newest' | 'oldest' | 'largest'
const sortMode = ref<SortMode>('newest')

function setSortMode(mode: SortMode) {
  sortMode.value = mode
  setPref('nvr-rec-sort', mode)
}

/** 按日期和收藏过滤后的录像列表 */
/** 搜索结果（有值时替代 filteredRecordings） */
const searchResults = ref<Array<Recording & { matchCount?: number; matches?: Array<{ trackId: number; label: string; customName?: string; semanticLabel?: string; similarity: number }> }> | null>(null)
/** 语义搜索模式（使用 CLIP embedding 匹配） */
const semanticSearchMode = ref(false)

/** 执行目标搜索（精确标签或语义搜索） */
async function searchByLabel() {
  const label = searchLabel.value.trim()
  if (!label) {
    searchResults.value = null
    return
  }
  isSearching.value = true
  const params = new URLSearchParams(semanticSearchMode.value ? { q: label } : { label })
  if (filterCamera.value) params.set('cameraId', filterCamera.value)
  if (filterDate.value) {
    const since = new Date(`${filterDate.value}T00:00:00`).getTime()
    params.set('since', String(since))
    params.set('until', String(since + 86_400_000))
  }
  const endpoint = semanticSearchMode.value ? '/api/recordings/semantic-search' : '/api/recordings/search'
  const res = await authFetch(`${endpoint}?${params}`)
  if (res.ok) {
    const data = await res.json()
    /** 语义搜索返回 { results: [...] }，精确搜索直接返回数组 */
    searchResults.value = semanticSearchMode.value ? data.results : data
  }
  isSearching.value = false
}

/** 清除搜索 */
function clearSearch() {
  searchLabel.value = ''
  searchResults.value = null
}

/** 有事件的录像文件名集合（独立于 filteredRecordings，避免循环依赖） */
const recordingsWithEvents = computed(() => {
  if (timelineEvents.value.length === 0) return new Set<string>()
  const set = new Set<string>()
  for (const rec of recordings.value) {
    for (const evt of timelineEvents.value) {
      if (evt.timestamp >= rec.startTime && evt.timestamp <= rec.endTime && (!evt.cameraId || evt.cameraId === rec.cameraId)) {
        set.add(rec.filename)
        break
      }
    }
  }
  return set
})

const filteredRecordings = computed(() => {
  /** 搜索模式下直接返回搜索结果 */
  if (searchResults.value) return searchResults.value
  let list = recordings.value
  if (filterStarred.value) {
    list = list.filter(r => starredFiles.value.has(r.filename))
  }
  if (filterDate.value) {
    const since = new Date(`${filterDate.value}T00:00:00`).getTime()
    const until = since + 86_400_000
    list = list.filter(r => r.startTime < until && r.endTime > since)
  }
  if (filterEventsOnly.value && recordingsWithEvents.value.size > 0) {
    list = list.filter(r => recordingsWithEvents.value.has(r.filename))
  }
  const sorted = [...list]
  if (sortMode.value === 'newest') sorted.sort((a, b) => b.startTime - a.startTime)
  else if (sortMode.value === 'oldest') sorted.sort((a, b) => a.startTime - b.startTime)
  else if (sortMode.value === 'largest') sorted.sort((a, b) => b.size - a.size)
  return sorted
})

/** 每个录像的检测事件统计（数量 + 标签类型） */
interface RecEventStats {
  /** 检测事件数量 */
  count: number
  /** 检测到的目标标签（去重，最多显示 3 个） */
  labels: string[]
}
const recordingEventStats = computed(() => {
  if (timelineEvents.value.length === 0) return new Map<string, RecEventStats>()
  const stats = new Map<string, RecEventStats>()
  for (const rec of filteredRecordings.value) {
    let count = 0
    const labelSet = new Set<string>()
    for (const evt of timelineEvents.value) {
      if (evt.timestamp >= rec.startTime && evt.timestamp <= rec.endTime && (!evt.cameraId || evt.cameraId === rec.cameraId)) {
        count++
        if (evt.label) {
          for (const l of evt.label.split(', ')) labelSet.add(l)
        }
      }
    }
    if (count > 0) stats.set(rec.filename, { count, labels: [...labelSet].slice(0, 3) })
  }
  return stats
})

/** 筛选后录像总大小 */
const totalSize = computed(() => {
  return filteredRecordings.value.reduce((sum, r) => sum + r.size, 0)
})

/** 筛选后录像总时长（秒） */
const totalRecDurationSec = computed(() => {
  return filteredRecordings.value.reduce((sum, r) => sum + Math.max(0, (r.endTime - r.startTime) / 1000), 0)
})

/** 格式化时长 */
function formatDuration(totalSec: number): string {
  if (totalSec < 60) return `${Math.round(totalSec)}s`
  if (totalSec < 3600) return `${Math.floor(totalSec / 60)}m${Math.round(totalSec % 60)}s`
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  return `${h}h${m}m`
}

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

/** 摄像头筛选变更 */
function onCameraFilterChange() {
  setPref('nvr-rec-filter-camera', filterCamera.value)
  loadRecordings()
}

/** 录像列表键盘导航 */
const focusedIndex = ref(-1)
const recListEl = ref<HTMLDivElement | null>(null)

/** 虚拟滚动：固定 item 高度 */
const ITEM_HEIGHT = 52
const BUFFER_ITEMS = 5
const virtualStart = ref(0)
const virtualEnd = ref(50)

/** 虚拟滚动可见 items */
const visibleRecordings = computed(() => {
  return filteredRecordings.value.slice(virtualStart.value, virtualEnd.value)
})

/** 虚拟滚动总高度 + padding */
const virtualPaddingTop = computed(() => virtualStart.value * ITEM_HEIGHT)
const virtualPaddingBottom = computed(() => {
  const total = filteredRecordings.value.length
  return Math.max(0, (total - virtualEnd.value) * ITEM_HEIGHT)
})

/** 滚动事件：计算可见范围 */
function onRecListScroll() {
  const el = recListEl.value
  if (!el) return
  const scrollTop = el.scrollTop
  const viewHeight = el.clientHeight
  const start = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER_ITEMS)
  const end = Math.min(filteredRecordings.value.length, Math.ceil((scrollTop + viewHeight) / ITEM_HEIGHT) + BUFFER_ITEMS)
  virtualStart.value = start
  virtualEnd.value = end
}

/** 列表数据变化时重置虚拟滚动 */
watch(() => filteredRecordings.value.length, () => {
  virtualStart.value = 0
  virtualEnd.value = Math.min(50, filteredRecordings.value.length)
  nextTick(() => onRecListScroll())
})

function onRecListKeydown(e: KeyboardEvent) {
  if (filteredRecordings.value.length === 0) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    focusedIndex.value = Math.min(focusedIndex.value + 1, filteredRecordings.value.length - 1)
    scrollToFocused()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    focusedIndex.value = Math.max(focusedIndex.value - 1, 0)
    scrollToFocused()
  } else if (e.key === 'Enter' && focusedIndex.value >= 0) {
    e.preventDefault()
    const rec = filteredRecordings.value[focusedIndex.value]
    if (rec) {
      if (multiSelectMode.value) toggleFileSelect(rec.filename)
      else play(rec)
    }
  } else if (e.key === ' ' && focusedIndex.value >= 0 && multiSelectMode.value) {
    e.preventDefault()
    const rec = filteredRecordings.value[focusedIndex.value]
    if (rec) toggleFileSelect(rec.filename)
  }
}

function scrollToFocused() {
  /** 确保 focused item 在虚拟范围内 */
  const idx = focusedIndex.value
  if (idx < virtualStart.value || idx >= virtualEnd.value) {
    const el = recListEl.value
    if (el) el.scrollTop = Math.max(0, (idx - BUFFER_ITEMS) * ITEM_HEIGHT)
  }
  nextTick(() => {
    const el = recListEl.value
    el?.querySelector(`.recording-item.focused`)?.scrollIntoView({ block: 'nearest' })
  })
}

/** 日期前后导航 */
function shiftDate(delta: number) {
  if (!filterDate.value) {
    filterDate.value = new Date().toISOString().slice(0, 10)
  }
  const d = new Date(`${filterDate.value}T00:00:00`)
  d.setDate(d.getDate() + delta)
  filterDate.value = d.toISOString().slice(0, 10)
  loadRecordings()
}

/** 跳转到今天 */
function goToday() {
  filterDate.value = new Date().toISOString().slice(0, 10)
  loadRecordings()
}

/** 时间搜索 */
const searchTimeInput = ref('')
/** 高亮的录像文件名 */
const highlightFilename = ref('')
let highlightTimer: ReturnType<typeof setTimeout> | null = null

/** 跳转到指定时间的录像 */
function jumpToTime() {
  if (!searchTimeInput.value.trim()) return
  /** 解析输入：支持 HH:MM、HH:MM:SS、YYYY-MM-DD HH:MM 等格式 */
  const input = searchTimeInput.value.trim()
  let targetTs: number
  /** 如果只输入了时间 (HH:MM 或 HH:MM:SS) */
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(input)) {
    const date = filterDate.value || new Date().toISOString().slice(0, 10)
    targetTs = new Date(`${date}T${input}`).getTime()
  } else {
    targetTs = new Date(input).getTime()
  }
  if (isNaN(targetTs)) return
  /** 在按当前排序排列的列表中找到最近的录像 */
  const sorted = [...filteredRecordings.value].sort((a, b) => {
    const distA = Math.abs(a.startTime - targetTs)
    const distB = Math.abs(b.startTime - targetTs)
    return distA - distB
  })
  const nearest = sorted[0]
  if (!nearest) return
  /** 高亮该录像 */
  highlightFilename.value = nearest.filename
  if (highlightTimer) clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => { highlightFilename.value = '' }, 3000)
  /** 滚动到该录像元素 */
  nextTick(() => {
    const el = document.querySelector(`[data-rec="${nearest.filename}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
}

/** 加载录像列表 */
async function loadRecordings() {
  loading.value = true
  preloadedSet = new Set<string>()
  try {
    const params = new URLSearchParams()
    if (filterCamera.value) params.set('cameraId', filterCamera.value)
    if (filterDate.value) {
      const since = new Date(`${filterDate.value}T00:00:00`).getTime()
      const until = since + 86_400_000
      params.set('since', String(since))
      params.set('until', String(until))
    }
    /** 无日期过滤时限制返回数量，避免大负载 */
    if (!filterDate.value) {
      params.set('limit', '100')
    }
    const res = await authFetch(`/api/recordings?${params}`)
    if (res.ok) {
      const newRecordings = await res.json()
      /** 保留仍存在的录像缩略图，只移除已消失的 */
      const newFilenames = new Set(newRecordings.map((r: any) => r.filename as string))
      for (const key of Object.keys(thumbUrls.value)) {
        if (!newFilenames.has(key)) delete thumbUrls.value[key]
      }
      recordings.value = newRecordings
      /** 静默预生成缩略图（后台批量请求，不阻塞 UI） */
      preloadThumbnails()
    }
  } catch {
    // ignore
  } finally {
    loading.value = false
  }
  /** 加载对应时间范围的事件标记 */
  loadTimelineEvents()
}

/** 时间轴事件标记数据 */
interface TimelineEvent {
  timestamp: number
  type: string
  label?: string
  cameraId?: string
}
const timelineEvents = ref<TimelineEvent[]>([])

/** 根据录像时间范围加载事件 */
async function loadTimelineEvents() {
  /** 从录像列表推算时间范围 */
  if (recordings.value.length === 0) {
    timelineEvents.value = []
    return
  }
  const allStart = recordings.value.reduce((min, r) => Math.min(min, r.startTime), Infinity)
  const allEnd = recordings.value.reduce((max, r) => Math.max(max, r.endTime), -Infinity)

  /** 并行加载 detect 事件和 track 行为事件 */
  const detectParams = new URLSearchParams({
    type: 'detect',
    since: String(allStart),
    until: String(allEnd),
    limit: '300',
  })
  const trackParams = new URLSearchParams({
    typeLike: 'track:%',
    since: String(allStart),
    until: String(allEnd),
    limit: '200',
  })
  if (filterCamera.value) {
    detectParams.set('cameraId', filterCamera.value)
    trackParams.set('cameraId', filterCamera.value)
  }

  try {
    const [detectRes, trackRes] = await Promise.all([
      authFetch(`/api/events/history?${detectParams}`),
      authFetch(`/api/events/history?${trackParams}`),
    ])

    const allEvents: TimelineEvent[] = []

    /** 解析 detect 事件 */
    if (detectRes.ok) {
      const data = await detectRes.json()
      for (const e of data.events as Array<{ timestamp: number; type: string; detail: string | null; camera_id: string }>) {
        let label: string | undefined
        if (e.detail) {
          const detail = JSON.parse(e.detail) as { detections?: Array<{ label: string; trackName?: string; semanticLabel?: string }> }
          if (detail.detections && detail.detections.length > 0) {
            label = detail.detections.map(d => d.trackName || d.semanticLabel || d.label).join(', ')
          }
        }
        allEvents.push({ timestamp: e.timestamp, type: e.type, label, cameraId: e.camera_id })
      }
    }

    /** 解析 track 行为事件（enter-zone/leave-zone/dwell/loiter/speed/line-cross） */
    if (trackRes.ok) {
      const data = await trackRes.json()
      for (const e of data.events as Array<{ timestamp: number; type: string; detail: string | null; camera_id: string }>) {
        let label: string | undefined
        if (e.detail) {
          const detail = JSON.parse(e.detail) as { trackName?: string; label?: string; zoneName?: string; lineName?: string }
          const parts: string[] = []
          if (detail.trackName) parts.push(detail.trackName)
          else if (detail.label) parts.push(detail.label)
          if (detail.zoneName) parts.push(detail.zoneName)
          if (detail.lineName) parts.push(detail.lineName)
          label = parts.join(' → ') || undefined
        }
        allEvents.push({ timestamp: e.timestamp, type: e.type, label, cameraId: e.camera_id })
      }
    }

    timelineEvents.value = allEvents
  } catch {
    timelineEvents.value = []
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
  /** 加载该录像时间段的检测事件（用于回放叠加） */
  loadPlaybackDetections(rec)
  /** 聚焦播放器 modal 以接收键盘事件 */
  nextTick(() => playerModalEl.value?.focus())
}

/** 批量预生成缩略图（后台静默请求，只发一次） */
let preloadedSet = new Set<string>()
function preloadThumbnails() {
  const files: Array<{ filename: string; durationSec: number }> = []
  for (const rec of recordings.value) {
    if (preloadedSet.has(rec.filename)) continue
    preloadedSet.add(rec.filename)
    files.push({ filename: rec.filename, durationSec: (rec.endTime - rec.startTime) / 1000 })
  }
  if (files.length === 0) return
  authFetch('/api/recordings/thumb-preload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  }).catch(() => { /* ignore */ })
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

/** 播放器快捷键帮助显示 */
const showPlayerHelp = ref(false)

/** 关闭播放器 */
function closePlayer() {
  selectedRecording.value = null
  showExport.value = false
  exportFilename.value = ''
  gifFilename.value = ''
}

/** 删除录像 */
async function deleteRecording(rec: Recording) {
  if (!await confirmDialog(t('recording.confirmDelete'))) return
  try {
    const res = await authFetch(`/api/recordings/${rec.filename}`, { method: 'DELETE' })
    if (res.ok) {
      if (selectedRecording.value?.filename === rec.filename) closePlayer()
      loadRecordings()
    }
  } catch {
    // ignore
  }
}

/** 批量删除选中的录像 */
async function batchDelete() {
  if (selectedFiles.value.size === 0) return
  if (!await confirmDialog(t('recording.confirmBatchDelete', { count: selectedFiles.value.size }))) return
  const toDelete = new Set(selectedFiles.value)
  try {
    await authFetch('/api/recordings/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [...toDelete] }),
    })
  } catch {
    // ignore
  }
  if (selectedRecording.value && toDelete.has(selectedRecording.value.filename)) closePlayer()
  selectedFiles.value = new Set()
  loadRecordings()
}

/** 删除某个录像之前的所有录像 */
async function deleteBefore(rec: Recording) {
  const dateStr = new Date(rec.startTime).toLocaleString()
  if (!await confirmDialog(t('recording.confirmDeleteBefore', { time: dateStr }))) return
  try {
    const body: Record<string, unknown> = { before: rec.startTime }
    if (filterCamera.value) body.cameraId = filterCamera.value
    const res = await authFetch('/api/recordings/purge-before', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      loadRecordings()
    }
  } catch {
    // ignore
  }
}

/** 批量收藏/取消收藏选中录像 */
function batchStar() {
  if (selectedFiles.value.size === 0) return
  const s = new Set(starredFiles.value)
  /** 如果全部已收藏则全部取消，否则全部收藏 */
  const allStarred = [...selectedFiles.value].every(f => s.has(f))
  for (const filename of selectedFiles.value) {
    if (allStarred) s.delete(filename)
    else s.add(filename)
  }
  starredFiles.value = s
  setPref('nvr-starred-recordings', [...s])
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

/** 应用导出时长预设（0 = 全部） */
function applyExportPreset(sec: number) {
  if (!playerRef.value) return
  const duration = totalDurationSec.value
  if (sec === 0) {
    exportStartSec.value = 0
    exportEndSec.value = duration
  } else {
    const cur = Math.round(playerRef.value.currentTime)
    exportStartSec.value = Math.max(0, cur - Math.floor(sec / 2))
    exportEndSec.value = Math.min(duration, exportStartSec.value + sec)
  }
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

/** 全选/取消全选 */
function toggleSelectAll() {
  if (selectedFiles.value.size === filteredRecordings.value.length) {
    selectedFiles.value = new Set()
  } else {
    selectedFiles.value = new Set(filteredRecordings.value.map(r => r.filename))
  }
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

/** ZIP 批量下载选中录像 */
async function doZipDownload() {
  if (sortedSelectedFiles.value.length < 1) return
  zipping.value = true
  zipFilename.value = ''
  const cameraId = sortedSelectedFiles.value[0]!.cameraId
  try {
    const res = await authFetch('/api/recordings/download-zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: sortedSelectedFiles.value.map(r => r.filename),
        cameraId,
      }),
    })
    if (res.ok) {
      const data = await res.json()
      const link = document.createElement('a')
      link.href = authUrl(`/api/recordings/export/${data.filename}`)
      link.download = data.filename
      link.click()
    }
  } catch {
    // ignore
  } finally {
    zipping.value = false
  }
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

/** ========== PiP 画中画实时预览 ========== */
/** PiP 显示开关 */
const showPip = ref(false)
/** PiP 显示的摄像头 ID（默认跟随当前播放录像的摄像头） */
const pipCameraId = ref('')
/** PiP canvas 引用 */
const pipCanvasRef = ref<HTMLCanvasElement | null>(null)
/** PiP 帧版本号（用于 poll） */
let pipVersion = 0
/** PiP rAF ID */
let pipRafId = 0
/** PiP 复用 ImageBitmap（避免每帧创建 Image + objectURL） */
let pipBitmap: ImageBitmap | null = null
/** PiP 窗口位置（viewport px） */
const pipX = ref(0)
const pipY = ref(0)
/** PiP 窗口大小（px 宽度，高度按 16:9） */
const pipSize = ref(240)
/** PiP 拖拽状态 */
let pipDragging = false

/** PiP 可选摄像头列表（在线的摄像头） */
const pipCameras = computed(() => {
  const currentCamId = selectedRecording.value?.cameraId
  return props.cameras.filter(c => c.id !== currentCamId)
})

/** 切换 PiP 显示 */
function togglePip() {
  showPip.value = !showPip.value
  if (showPip.value && selectedRecording.value) {
    /** 默认显示当前录像的摄像头 */
    pipCameraId.value = selectedRecording.value.cameraId
    pipVersion = 0
    /** 初始位置：右下角 */
    pipX.value = window.innerWidth - pipSize.value - 20
    pipY.value = window.innerHeight - Math.round(pipSize.value * 9 / 16) - 60
    startPipLoop()
  } else {
    stopPipLoop()
  }
}

/** PiP 帧渲染循环 */
function startPipLoop() {
  stopPipLoop()
  function loop() {
    const canvas = pipCanvasRef.value
    if (!canvas || !showPip.value) return
    const camId = pipCameraId.value
    if (camId) {
      const frame = takeFrame(camId, pipVersion)
      if (frame) {
        pipVersion = frame.version
        const ctx = canvas.getContext('2d')
        if (ctx) {
          const blob = new Blob([frame.jpeg], { type: 'image/jpeg' })
          createImageBitmap(blob).then(bitmap => {
            /** 释放上一帧 bitmap */
            if (pipBitmap) pipBitmap.close()
            pipBitmap = bitmap
            canvas.width = bitmap.width
            canvas.height = bitmap.height
            ctx.drawImage(bitmap, 0, 0)
          })
        }
      }
    }
    pipRafId = requestAnimationFrame(loop)
  }
  pipRafId = requestAnimationFrame(loop)
}

function stopPipLoop() {
  if (pipRafId) {
    cancelAnimationFrame(pipRafId)
    pipRafId = 0
  }
  if (pipBitmap) {
    pipBitmap.close()
    pipBitmap = null
  }
}

/** PiP 滚轮缩放 */
function onPipWheel(e: WheelEvent) {
  e.preventDefault()
  const delta = e.deltaY > 0 ? -20 : 20
  pipSize.value = Math.max(160, Math.min(480, pipSize.value + delta))
}

/** PiP 拖拽开始 */
function onPipDragStart(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  pipDragging = true
  const startX = e.clientX
  const startY = e.clientY
  const origX = pipX.value
  const origY = pipY.value
  function onMove(ev: MouseEvent) {
    if (!pipDragging) return
    const dx = ev.clientX - startX
    const dy = ev.clientY - startY
    pipX.value = Math.max(0, Math.min(window.innerWidth - pipSize.value, origX + dx))
    pipY.value = Math.max(0, Math.min(window.innerHeight - 100, origY + dy))
  }
  function onUp() {
    pipDragging = false
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

/** 关闭播放器时清理 PiP */
watch(selectedRecording, (rec) => {
  if (!rec) {
    showPip.value = false
    stopPipLoop()
  }
})

/** 监听 active 状态：激活时启动定时刷新，离开时停止（immediate 处理首次加载，无需 onMounted 重复调用） */
watch(() => props.active, (isActive) => {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
  if (isActive) {
    loadRecordings()
    refreshTimer = setInterval(loadRecordings, 30000)
  }
}, { immediate: true })

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
  stopPipLoop()
})

defineExpose({ loadRecordings, playAtTime })
</script>

<template>
  <div class="recordings-panel">
    <!-- 播放器弹窗 -->
    <div v-if="selectedRecording" class="player-overlay" @click.self="closePlayer">
      <div ref="playerModalEl" class="player-modal" tabindex="-1" @keydown="onPlayerKeydown">
        <div class="player-header">
          <span>{{ cameraNameMap[selectedRecording.cameraId] ?? selectedRecording.cameraId }}</span>
          <span class="player-time">{{ formatTime(selectedRecording.startTime) }}</span>
          <button class="export-toggle-btn" @click="openExport" :title="t('recording.export')">{{ t('recording.export') }}</button>
          <select :value="playbackSpeed" @change="changeSpeed(Number(($event.target as HTMLSelectElement).value)); smartSpeed = false" class="speed-select" :title="t('recording.speed')">
            <option :value="0.5">0.5x</option>
            <option :value="1">1x</option>
            <option :value="1.5">1.5x</option>
            <option :value="2">2x</option>
            <option :value="4">4x</option>
            <option :value="8">8x</option>
          </select>
          <button v-if="playbackEvents.length > 0" :class="['ctrl-btn', 'smart-speed-btn', { active: smartSpeed }]" @click="smartSpeed = !smartSpeed" :title="t('recording.smartSpeed', '智能倍速：事件密集降速，稀疏加速')">⚡</button>
          <button
            :class="['autoplay-btn', { active: autoPlayNext }]"
            @click="toggleAutoPlay"
            :title="t('recording.autoPlayNext')"
          >&#9654;&#9654;</button>
          <button class="fullscreen-btn" @click="togglePlayerFullscreen" :title="t('camera.fullscreen')">&#x26F6;</button>
          <button class="screenshot-btn" @click="takePlayerScreenshot" :title="t('camera.screenshot')">&#x1F4F7;</button>
          <button :class="['detect-toggle-btn', { active: showPlaybackBoxes }]" @click="showPlaybackBoxes = !showPlaybackBoxes" :title="t('recording.toggleDetect')">&#x1F50D;</button>
          <button v-if="showPlaybackBoxes && playbackEvents.length > 0" :class="['trail-toggle-btn', { active: showPlaybackTrail }]" @click="showPlaybackTrail = !showPlaybackTrail" title="Trail">&#x2728;</button>
          <button v-if="playbackEvents.length > 0" :class="['event-list-btn', { active: showPlaybackEventList }]" @click="showPlaybackEventList = !showPlaybackEventList" :title="t('recording.toggleDetect')">&#x2630; {{ playbackEvents.length }}</button>
          <button class="download-raw-btn" @click="downloadRecording()" :title="t('recording.download')">&#x2B07;</button>
          <button :class="['pip-toggle-btn', { active: showPip }]" @click="togglePip" :title="t('recording.pip', '画中画')">&#x1F4FA;</button>
          <button class="player-help-btn" @click="showPlayerHelp = !showPlayerHelp" :title="t('header.help')">?</button>
          <button class="close-btn" @click="closePlayer">&times;</button>
        </div>
        <!-- 快捷键帮助浮层 -->
        <div v-if="showPlayerHelp" class="player-help-overlay" @click="showPlayerHelp = false">
          <div class="player-help-content" @click.stop>
            <div class="help-row"><kbd>Space</kbd> {{ t('recording.helpPlayPause') }}</div>
            <div class="help-row"><kbd>←</kbd><kbd>→</kbd> {{ t('recording.helpSeek') }}</div>
            <div class="help-row"><kbd>Shift+←</kbd><kbd>Shift+→</kbd> ±30s</div>
            <div class="help-row"><kbd>,</kbd><kbd>.</kbd> {{ t('recording.helpFrame') }}</div>
            <div class="help-row"><kbd>[</kbd> A <kbd>]</kbd> B <kbd>\</kbd> {{ t('recording.helpLoop') }}</div>
            <div class="help-row"><kbd>M</kbd> {{ t('recording.helpMute') }}</div>
            <div class="help-row"><kbd>F</kbd> {{ t('recording.helpFullscreen') }}</div>
            <div class="help-row"><kbd>+</kbd><kbd>-</kbd> {{ t('recording.helpSpeed', '倍速') }}</div>
            <div class="help-row"><kbd>P</kbd> {{ t('recording.helpPip', '画中画') }}</div>
            <div class="help-row"><kbd>N</kbd> {{ t('recording.helpNextEvent', '下一个事件') }}</div>
            <div class="help-row"><kbd>B</kbd> {{ t('recording.helpPrevEvent', '上一个事件') }}</div>
          </div>
        </div>
        <div class="player-video-wrapper">
          <video
            ref="playerRef"
            :src="videoUrl"
            autoplay
            class="player-video"
            @dblclick="togglePlayerFullscreen"
            @ratechange="onRateChange"
            @loadedmetadata="onLoadedMetadata"
            @ended="onVideoEnded"
            @timeupdate="onTimeUpdate"
            @play="onPlay"
            @pause="onPause"
          />
          <!-- 回放检测框叠加 -->
          <div v-if="showPlaybackBoxes" class="playback-detection-overlay">
            <!-- 轨迹 SVG 层 -->
            <svg v-if="showPlaybackTrail && playbackTrails.length > 0" class="playback-trail-svg" viewBox="0 0 1 1" preserveAspectRatio="none">
              <polyline
                v-for="(trail, ti) in playbackTrails"
                :key="trail.trackId"
                :points="trail.points.map(p => `${p.x},${p.y}`).join(' ')"
                fill="none"
                :stroke="TRAIL_COLORS[ti % TRAIL_COLORS.length]"
                stroke-width="0.003"
                stroke-linecap="round"
                stroke-linejoin="round"
                opacity="0.7"
              />
            </svg>
            <div
              v-for="d in playbackDetections"
              :key="d.trackId ?? `${d.label}-${Math.round(d.box.xmin * 100)}`"
              class="playback-detect-box"
              :style="{
                left: (d.box.xmin * 100) + '%',
                top: (d.box.ymin * 100) + '%',
                width: ((d.box.xmax - d.box.xmin) * 100) + '%',
                height: ((d.box.ymax - d.box.ymin) * 100) + '%',
              }"
            >
              <span class="playback-detect-label">
                {{ getPlaybackDetectLabel(selectedRecording!.cameraId, d) }}
              </span>
            </div>
          </div>
        </div>
        <!-- PiP 画中画实时预览浮窗（Teleport 到 body，fixed 定位，全屏时也能显示） -->
        <Teleport to="body">
          <div v-if="showPip && pipCameraId" class="pip-window" :style="{ left: pipX + 'px', top: pipY + 'px', width: pipSize + 'px' }" @wheel="onPipWheel">
            <div class="pip-header" @mousedown="onPipDragStart">
              <span class="pip-label">LIVE</span>
              <select v-model="pipCameraId" class="pip-camera-select" @mousedown.stop>
                <option :value="selectedRecording!.cameraId">{{ cameraNameMap[selectedRecording!.cameraId] ?? selectedRecording!.cameraId }}</option>
                <option v-for="cam in pipCameras" :key="cam.id" :value="cam.id">{{ cam.name }}</option>
              </select>
              <button class="pip-close" @click="showPip = false; stopPipLoop()">&times;</button>
            </div>
            <canvas ref="pipCanvasRef" class="pip-canvas" />
          </div>
        </Teleport>
        <!-- 自定义进度条（绝对时间） -->
        <div v-if="selectedRecording" class="custom-controls">
          <button class="ctrl-btn play-pause" @click="isPlaying ? playerRef?.pause() : playerRef?.play()">
            {{ isPlaying ? '&#10074;&#10074;' : '&#9654;' }}
          </button>
          <button class="ctrl-btn frame-btn" @click="stepFrame(-1)" title="◀ 1帧 (,)">◂</button>
          <button class="ctrl-btn frame-btn" @click="stepFrame(1)" title="1帧 ▸ (.)">▸</button>
          <button v-if="playbackEvents.length > 0" class="ctrl-btn frame-btn" @click="seekNextEvent(-1)" title="上一个事件">⏮</button>
          <button v-if="playbackEvents.length > 0" class="ctrl-btn frame-btn" @click="seekNextEvent(1)" title="下一个事件">⏭</button>
          <button class="ctrl-btn frame-btn" @click="playPrevRecording" title="上一个录像">⏪</button>
          <button class="ctrl-btn frame-btn" @click="playNextRecording" title="下一个录像">⏩</button>
          <button :class="['ctrl-btn', 'loop-btn', { active: loopStart >= 0 }]" @click="loopStart >= 0 ? clearLoop() : setLoopPoint('a')" :title="loopStart >= 0 ? '清除循环 (\\)' : '设A点 ([)'">A</button>
          <button v-if="loopStart >= 0" :class="['ctrl-btn', 'loop-btn', { active: loopEnd > loopStart }]" @click="setLoopPoint('b')" title="设B点 (])">B</button>
          <div ref="progressEl" class="progress-bar" @mousedown="onProgressDragStart" @mousemove="onProgressHover" @mouseleave="onProgressLeave">
            <div v-if="loopStart >= 0 && loopEnd > loopStart && playerRef" class="loop-region" :style="{ left: (loopStart / playerRef.duration * 100) + '%', width: ((loopEnd - loopStart) / playerRef.duration * 100) + '%' }" />
            <!-- 检测事件标记（按目标类别着色） -->
            <template v-for="m in progressEventMarkers" :key="m.key">
              <div class="progress-event-marker" :style="{ left: m.position + '%', background: eventMarkerColor(m.labels) }" :title="m.labels.join(', ') + ' (' + m.count + ')'" @click.stop="seekToMarker(m.position)" />
            </template>
            <div class="progress-fill" :style="{ width: playProgress + '%' }" />
            <div class="progress-thumb" :style="{ left: playProgress + '%' }" />
            <div v-if="hoverPct >= 0 && selectedRecording" class="progress-tooltip" :style="{ left: (hoverPct * 100) + '%' }">
              <img v-if="hoverThumbUrl" :src="hoverThumbUrl" alt="" class="tooltip-thumb" />
              <span>{{ formatAbsTime(hoverAbsTime) }}</span>
            </div>
          </div>
          <div class="time-display">
            <span class="time-current">{{ formatAbsTime(currentAbsTime) }}</span>
            <span class="time-sep">/</span>
            <span class="time-end">{{ formatAbsTime(selectedRecording.endTime) }}</span>
          </div>
          <div class="volume-control">
            <button class="ctrl-btn volume-icon" @click="toggleMute">
              {{ isMuted || volume === 0 ? '&#128264;' : volume < 50 ? '&#128265;' : '&#128266;' }}
            </button>
            <input type="range" v-model.number="volume" min="0" max="100" class="volume-slider" />
          </div>
        </div>
        <!-- 检测事件列表 -->
        <div v-if="showPlaybackEventList && playbackEvents.length > 0 && selectedRecording" class="playback-event-list">
          <div class="playback-event-header">{{ playbackEvents.length }} {{ t('event.detect', '检测事件') }}</div>
          <div class="playback-event-items">
            <div
              v-for="(ev, idx) in playbackEvents"
              :key="idx"
              class="playback-event-item"
              :class="{ active: playbackEvents[activePlaybackEventIdx]?.timestamp === ev.timestamp }"
              @click="seekToPlaybackEvent(ev.timestamp)"
            >
              <span class="pev-time">{{ formatAbsTime(ev.timestamp) }}</span>
              <span class="pev-labels">{{ [...new Set(ev.detections.map(d => d.trackName || d.semanticLabel || d.label))].join(', ') }}</span>
              <span class="pev-count">{{ ev.detections.length }}</span>
            </div>
          </div>
          <!-- 行为事件列表 -->
          <div v-if="playbackBehaviorEvents.length > 0" class="playback-behavior-list">
            <div class="playback-event-header">{{ playbackBehaviorEvents.length }} 行为事件</div>
            <div class="playback-event-items">
              <div
                v-for="(ev, idx) in playbackBehaviorEvents"
                :key="'b'+idx"
                class="playback-event-item behavior-event"
                @click="seekToPlaybackEvent(ev.timestamp)"
              >
                <span v-if="BEHAVIOR_EVENT_STYLE[ev.type]" class="behavior-tag" :style="{ background: BEHAVIOR_EVENT_STYLE[ev.type].bg }">{{ BEHAVIOR_EVENT_STYLE[ev.type].label }}</span>
                <span class="pev-time">{{ formatAbsTime(ev.timestamp) }}</span>
                <span class="pev-labels">{{ ev.summary }}</span>
              </div>
            </div>
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
            <div class="export-presets">
              <button class="preset-btn" @click="applyExportPreset(30)">30s</button>
              <button class="preset-btn" @click="applyExportPreset(60)">1m</button>
              <button class="preset-btn" @click="applyExportPreset(300)">5m</button>
              <button class="preset-btn" @click="applyExportPreset(0)">{{ t('recording.exportAll') }}</button>
            </div>
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
      <span>{{ t('recording.title') }} <span v-if="filteredRecordings.length > 0" class="rec-summary">{{ filteredRecordings.length }} · {{ formatSize(totalSize) }} · {{ formatDuration(totalRecDurationSec) }}</span></span>
      <input type="date" v-model="filterDate" class="filter-date" :title="t('recording.filterDate')" />
      <button class="date-nav-btn" @click="shiftDate(-1)" :title="t('recording.prevDay')" :disabled="!filterDate">◀</button>
      <button class="date-nav-btn" @click="shiftDate(1)" :title="t('recording.nextDay')" :disabled="!filterDate">▶</button>
      <button class="today-btn" @click="goToday" :title="t('timeline.now')">{{ t('timeline.now') }}</button>
      <select v-model="filterCamera" @change="onCameraFilterChange" class="filter-select">
        <option value="">{{ t("recording.allCameras") }}</option>
        <option v-for="cam in cameras" :key="cam.id" :value="cam.id">{{ cam.name }}</option>
      </select>
      <div class="time-search">
        <input v-model="searchTimeInput" :placeholder="t('recording.searchTime')" class="time-search-input" @keydown.enter="jumpToTime" />
        <button class="time-search-btn" @click="jumpToTime" :title="t('recording.jumpToTime')">&#x2315;</button>
      </div>
      <div class="ai-search">
        <button :class="['semantic-toggle-btn', { active: semanticSearchMode }]" @click="semanticSearchMode = !semanticSearchMode" :title="semanticSearchMode ? '语义搜索（CLIP）' : '精确标签搜索'" :aria-label="semanticSearchMode ? '语义搜索' : '标签搜索'">{{ semanticSearchMode ? '🧠' : '🏷️' }}</button>
        <input v-model="searchLabel" :placeholder="semanticSearchMode ? '描述目标（如：穿红衣服的人）' : t('recording.searchLabel', '搜索目标...')" class="ai-search-input" @keydown.enter="searchByLabel" />
        <button v-if="searchLabel" class="ai-search-clear" @click="clearSearch" title="清除">✕</button>
        <button class="ai-search-btn" @click="searchByLabel" :disabled="isSearching || !searchLabel.trim()" :title="semanticSearchMode ? '语义搜索' : t('recording.searchLabel', '搜索目标')">&#x1F50D;</button>
      </div>
      <button class="refresh-btn" @click="loadRecordings" :disabled="loading">{{ t('event.refresh') }}</button>
      <button class="sort-btn" @click="setSortMode(sortMode === 'newest' ? 'oldest' : sortMode === 'oldest' ? 'largest' : 'newest')" :title="sortMode === 'newest' ? '↓ Newest' : sortMode === 'oldest' ? '↑ Oldest' : '◎ Size'">
        {{ sortMode === 'newest' ? '↓' : sortMode === 'oldest' ? '↑' : '◎' }}
      </button>
      <button :class="['select-btn', { active: multiSelectMode }]" @click="toggleMultiSelect">{{ multiSelectMode ? t('recording.cancelSelect') : t('recording.selectMultiple') }}</button>
      <button :class="['star-filter-btn', { active: filterStarred }]" @click="filterStarred = !filterStarred" :title="t('recording.filterStarred')">
        {{ filterStarred ? '★' : '☆' }}
      </button>
      <button :class="['events-filter-btn', { active: filterEventsOnly }]" @click="filterEventsOnly = !filterEventsOnly" :title="t('recording.filterEvents', '仅显示有事件')">
        {{ filterEventsOnly ? '◆' : '◇' }}
      </button>
    </div>

    <!-- 搜索结果指示 -->
    <div v-if="searchResults" class="search-indicator">
      {{ semanticSearchMode ? '🧠 语义搜索' : t('recording.searchResult', '搜索结果') }}: "{{ searchLabel }}" — {{ searchResults.length }} {{ t('recording.segments', '段') }}
      <template v-if="semanticSearchMode && searchResults.length > 0">
        <span class="semantic-matches">
          <template v-for="(m, idx) in [...new Map(searchResults.flatMap(r => r.matches ?? []).map(m => [m.trackId, m])).values()]" :key="m.trackId">
            <span v-if="idx < 5" class="semantic-match-chip" :title="`相似度 ${(m.similarity * 100).toFixed(0)}%`">{{ m.customName || m.semanticLabel || m.label }} {{ (m.similarity * 100).toFixed(0) }}%</span>
          </template>
        </span>
      </template>
      <button class="search-clear-btn" @click="clearSearch">{{ t('manage.cancel') }}</button>
    </div>

    <!-- 时间轴视图切换 -->
    <div class="timeline-switch">
      <button :class="['tl-mode-btn', { active: effectiveTimeline === 'multi' }]" @click="setTimelineMode(effectiveTimeline === 'multi' ? 'auto' : 'multi')" title="Multi-track">☰</button>
      <button :class="['tl-mode-btn', { active: effectiveTimeline === 'single' }]" @click="setTimelineMode(effectiveTimeline === 'single' ? 'auto' : 'single')" title="Single-track">═</button>
    </div>

    <!-- 多路同步时间轴 -->
    <MultiTimeline
      v-if="effectiveTimeline === 'multi'"
      :recordings="filteredRecordings"
      :cameras="cameras"
      :playback-time="selectedRecording && isPlaying ? currentAbsTime : 0"
      :playback-camera-id="selectedRecording?.cameraId ?? ''"
      :events="timelineEvents"
      @play="play"
    />

    <!-- 单路时间轴 -->
    <RecordingsTimeline
      v-if="effectiveTimeline === 'single'"
      :recordings="filteredRecordings"
      :selected-camera="filterCamera"
      :playback-time="selectedRecording && isPlaying ? currentAbsTime : 0"
      :events="timelineEvents"
      @play="play"
    />

    <div ref="recListEl" class="recordings-list" tabindex="0" @keydown="onRecListKeydown" @scroll="onRecListScroll">
      <div v-if="filteredRecordings.length === 0" class="empty">
        {{ loading ? t('app.loading') : t('recording.noRecordings') }}
      </div>
      <template v-else>
        <div :style="{ height: virtualPaddingTop + 'px' }" />
        <div
          v-for="(rec, vidx) in visibleRecordings"
          :key="rec.filename"
          :data-rec="rec.filename"
          :class="['recording-item', { selected: selectedFiles.has(rec.filename), highlighted: highlightFilename === rec.filename, focused: virtualStart + vidx === focusedIndex }]"
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
          <div class="rec-time">{{ formatAbsTime(rec.startTime) }} - {{ formatAbsTime(rec.endTime) }}</div>
        </div>
        <div class="rec-meta">
          <span v-if="rec.endTime > rec.startTime" class="rec-duration">
            {{ duration(rec.startTime, rec.endTime) }}
          </span>
          <span v-if="recordingEventStats.get(rec.filename)" class="rec-event-count" :title="recordingEventStats.get(rec.filename)!.labels.join(', ')">
            AI {{ recordingEventStats.get(rec.filename)!.count }}
            <span v-if="recordingEventStats.get(rec.filename)!.labels.length" class="rec-event-labels">{{ recordingEventStats.get(rec.filename)!.labels.join(' ') }}</span>
          </span>
          <span v-if="rec.matchCount" class="rec-match-count" :title="t('recording.matchCountTip', { count: rec.matchCount })">
            ⚡{{ rec.matchCount }}
          </span>
          <!-- 搜索匹配时间标记条 -->
          <div v-if="rec.matchTimestamps?.length && rec.endTime > rec.startTime" class="rec-match-bar" :title="t('recording.matchCountTip', { count: rec.matchCount })">
            <span
              v-for="(ts, mi) in rec.matchTimestamps"
              :key="mi"
              class="rec-match-dot"
              :style="{ left: ((ts - rec.startTime) / (rec.endTime - rec.startTime) * 100) + '%' }"
            />
          </div>
          <span class="rec-size">{{ formatSize(rec.size) }}</span>
          <button :class="['rec-star', { starred: starredFiles.has(rec.filename) }]" @click.stop="toggleRecStar(rec.filename)" :title="t('recording.toggleStar')">
            {{ starredFiles.has(rec.filename) ? '★' : '☆' }}
          </button>
          <button class="rec-download" @click.stop="downloadRecording(rec)" :title="t('recording.download')">&#x2B07;</button>
          <button class="rec-delete" @click.stop="deleteRecording(rec)" :title="t('recording.delete')">&#10005;</button>
          <button v-if="vidx > 0" class="rec-delete-before" @click.stop="deleteBefore(rec)" :title="t('recording.deleteBefore')">⏏</button>
        </div>
      </div>
      <div :style="{ height: virtualPaddingBottom + 'px' }" />
      </template>
    </div>

    <!-- 多选合并操作栏 -->
    <div v-if="multiSelectMode" class="merge-bar">
      <button class="select-all-btn" @click="toggleSelectAll">{{ selectedFiles.size === filteredRecordings.length ? t('recording.cancelSelect') : '☑' }}</button>
      <span class="merge-info">{{ t('recording.selectedCount', { count: selectedFiles.size }) }}</span>
      <span v-if="sortedSelectedFiles.length > 1" class="merge-duration">
        {{ duration(sortedSelectedFiles[0].startTime, sortedSelectedFiles[sortedSelectedFiles.length - 1].endTime) }}
      </span>
      <button v-if="!mergeFilename" class="merge-btn" @click="doMergeExport" :disabled="merging || selectedFiles.size < 1">
        {{ merging ? t('recording.merging') : t('recording.merge') }}
      </button>
      <button v-else class="download-btn" @click="downloadMerge">{{ t('recording.download') }}</button>
      <button class="zip-btn" @click="doZipDownload" :disabled="zipping || selectedFiles.size < 1">
        {{ zipping ? t('recording.zipping') : t('recording.downloadZip') }}
      </button>
      <button class="batch-star-btn" @click="batchStar" :disabled="selectedFiles.size === 0">
        {{ t('recording.starSelected') }}
      </button>
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
  gap: 6px;
  flex-wrap: wrap;
}

.timeline-switch {
  display: flex;
  gap: 2px;
}

.tl-mode-btn {
  background: #2a2a4a;
  color: #888;
  border: none;
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}

.tl-mode-btn:hover {
  color: #e0e0e0;
}

.tl-mode-btn.active {
  background: #4ECDC4;
  color: #1a1a2e;
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

.date-nav-btn {
  background: #2a2a4a;
  color: #888;
  border: none;
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 11px;
  cursor: pointer;
  line-height: 1;
}

.date-nav-btn:hover:not(:disabled) {
  color: #4ECDC4;
  background: #3a3a5a;
}

.today-btn {
  background: #4ECDC4;
  color: #1a1a2e;
  border: none;
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.today-btn:hover { background: #3ad4c8; }

.date-nav-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.time-search {
  display: flex;
  align-items: center;
  gap: 0;
}

.time-search-input {
  background: #0a0a1a;
  color: #e0e0e0;
  border: 1px solid #2a2a4a;
  border-radius: 4px 0 0 4px;
  padding: 2px 6px;
  font-size: 11px;
  width: 100px;
  outline: none;
}

.time-search-input:focus {
  border-color: #4ECDC4;
}

.time-search-input::placeholder {
  color: #444;
}

.time-search-btn {
  background: #2a2a4a;
  color: #888;
  border: 1px solid #2a2a4a;
  border-left: none;
  border-radius: 0 4px 4px 0;
  padding: 2px 6px;
  font-size: 13px;
  cursor: pointer;
  line-height: 1;
}

.time-search-btn:hover {
  color: #4ECDC4;
  background: #3a3a5a;
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

.sort-btn {
  background: #2a2a4a;
  color: #4ECDC4;
  border: none;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}

.sort-btn:hover {
  background: #3a3a5a;
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

.star-filter-btn {
  background: none;
  border: 1px solid #444;
  color: #888;
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 12px;
  cursor: pointer;
}

.star-filter-btn:hover {
  border-color: #FFD93D;
  color: #FFD93D;
}

.star-filter-btn.active {
  background: #FFD93D;
  border-color: #FFD93D;
  color: #1a1a2e;
}

.events-filter-btn {
  background: none;
  border: 1px solid #444;
  color: #888;
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 12px;
  cursor: pointer;
}

.events-filter-btn:hover {
  border-color: #4ECDC4;
  color: #4ECDC4;
}

.events-filter-btn.active {
  background: #4ECDC4;
  border-color: #4ECDC4;
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
  height: 52px;
  box-sizing: border-box;
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

.recording-item.highlighted {
  animation: rec-highlight 3s ease-out;
}

@keyframes rec-highlight {
  0% { background: #4ECDC440; }
  100% { background: transparent; }
}

.recording-item.focused {
  outline: 1px solid #4ECDC4;
  outline-offset: -1px;
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

.rec-event-count {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  color: #5bc0de;
  background: #5bc0de20;
  padding: 0 4px;
  border-radius: 3px;
  margin-top: 2px;
}
.rec-event-labels {
  color: #88ccdd;
  font-size: 9px;
}

.rec-match-count {
  display: inline-block;
  font-size: 10px;
  color: #FFD93D;
  background: #FFD93D20;
  padding: 0 4px;
  border-radius: 3px;
  margin-top: 2px;
}

.rec-match-bar {
  position: relative;
  width: 60px;
  height: 6px;
  background: #2a2a4a;
  border-radius: 3px;
  margin-top: 3px;
  flex-shrink: 0;
}

.rec-match-dot {
  position: absolute;
  width: 3px;
  height: 6px;
  background: #FFD93D;
  border-radius: 1px;
  transform: translateX(-50%);
}

.ai-search {
  display: flex;
  align-items: center;
  position: relative;
}

.ai-search-input {
  background: #0a0a1a;
  border: 1px solid #2a2a4a;
  color: #e0e0e0;
  border-radius: 3px 0 0 3px;
  padding: 2px 20px 2px 6px;
  font-size: 11px;
  width: 100px;
  outline: none;
}

.ai-search-input:focus { border-color: #FFD93D; }

.ai-search-clear {
  position: absolute;
  right: 28px;
  background: none;
  border: none;
  color: #666;
  cursor: pointer;
  font-size: 10px;
  padding: 0 2px;
}

.ai-search-btn {
  background: #2a2a4a;
  color: #FFD93D;
  border: 1px solid #2a2a4a;
  border-left: none;
  border-radius: 0 3px 3px 0;
  padding: 2px 6px;
  font-size: 11px;
  cursor: pointer;
}

.ai-search-btn:hover { background: #3a3a5a; }
.ai-search-btn:disabled { opacity: 0.5; }

.semantic-toggle-btn {
  background: #1a1a2e;
  color: #888;
  border: 1px solid #2a2a4a;
  border-right: none;
  border-radius: 3px 0 0 3px;
  padding: 2px 5px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s;
}
.semantic-toggle-btn.active { background: #2a1a3e; color: #c084fc; border-color: #7c3aed; }
.semantic-toggle-btn:hover { background: #2a2a4a; }

.ai-search-input.semantic-active { border-color: #7c3aed; }

.semantic-match-chip {
  display: inline-block;
  background: #2a1a3e;
  color: #c084fc;
  border-radius: 3px;
  padding: 1px 5px;
  font-size: 10px;
  margin-left: 4px;
}

.search-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  background: #FFD93D15;
  color: #FFD93D;
  font-size: 11px;
  border-bottom: 1px solid #2a2a4a;
}

.search-clear-btn {
  background: none;
  border: 1px solid #FFD93D;
  color: #FFD93D;
  border-radius: 3px;
  padding: 0 6px;
  font-size: 10px;
  cursor: pointer;
}

.search-clear-btn:hover { background: #FFD93D20; }

.rec-delete, .rec-delete-before {
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

.rec-star {
  background: none;
  border: none;
  color: #555;
  font-size: 13px;
  cursor: pointer;
  padding: 2px;
  opacity: 0;
  transition: opacity 0.2s, color 0.2s;
}

.rec-star.starred {
  color: #FFD93D;
  opacity: 1;
}

.recording-item:hover .rec-star,
.recording-item:hover .rec-delete,
.recording-item:hover .rec-delete-before,
.recording-item:hover .rec-download {
  opacity: 1;
}

.rec-star:hover {
  color: #FFD93D;
}

.rec-delete:hover, .rec-delete-before:hover {
  color: #e74c3c;
}

.rec-download {
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

.rec-download:hover {
  color: #4ECDC4;
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
  display: flex;
  flex-direction: column;
}

.player-modal:fullscreen {
  max-width: 100vw;
  width: 100vw;
  height: 100vh;
  border-radius: 0;
  border: none;
}

.player-modal:fullscreen .player-video {
  max-height: none;
  flex: 1;
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

.fullscreen-btn {
  background: none;
  border: none;
  color: #888;
  font-size: 16px;
  cursor: pointer;
  padding: 2px 4px;
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
  padding: 2px 4px;
  line-height: 1;
}

.screenshot-btn:hover {
  color: #4ECDC4;
}

.download-raw-btn {
  background: none;
  border: none;
  color: #888;
  font-size: 14px;
  cursor: pointer;
  padding: 2px 4px;
  line-height: 1;
}

.download-raw-btn:hover {
  color: #4ECDC4;
}

.player-help-btn {
  background: none;
  border: 1px solid #444;
  color: #888;
  border-radius: 50%;
  width: 20px;
  height: 20px;
  font-size: 12px;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}

.player-help-btn:hover {
  color: #4ECDC4;
  border-color: #4ECDC4;
}

.player-help-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}

.player-help-content {
  background: #1a1a2e;
  border: 1px solid #2a2a4a;
  border-radius: 8px;
  padding: 16px 24px;
  min-width: 260px;
}

.help-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
  color: #ccc;
}

.help-row kbd {
  background: #2a2a4a;
  border: 1px solid #3a3a5a;
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 11px;
  font-family: inherit;
  color: #4ECDC4;
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

/* 视频容器（用于检测框叠加定位） */
.player-video-wrapper {
  position: relative;
  line-height: 0;
}

.player-video {
  width: 100%;
  display: block;
  max-height: 75vh;
  background: #000;
  cursor: pointer;
}

/* 回放检测框叠加 */
.playback-detection-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.playback-detect-box {
  position: absolute;
  border: 2px solid #5bc0de;
  border-radius: 2px;
  opacity: 0.85;
  transition: left 0.15s ease, top 0.15s ease, width 0.15s ease, height 0.15s ease;
}

.playback-detect-label {
  position: absolute;
  top: -20px;
  left: -2px;
  font-size: 11px;
  color: #fff;
  background: rgba(91, 192, 222, 0.85);
  padding: 1px 6px;
  border-radius: 2px;
  white-space: nowrap;
}

/* 检测框切换按钮 */
.detect-toggle-btn {
  background: #2a2a4a;
  color: #888;
  border: none;
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 12px;
  cursor: pointer;
}

.detect-toggle-btn.active {
  color: #5bc0de;
  background: #5bc0de30;
}

/* 智能倍速按钮 */
.smart-speed-btn {
  background: #2a2a4a;
  color: #888;
  border: none;
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 12px;
  cursor: pointer;
}

.smart-speed-btn.active {
  color: #FFEAA7;
  background: #FFEAA730;
}

/* 轨迹切换按钮 */
.trail-toggle-btn {
  background: #2a2a4a;
  color: #888;
  border: none;
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 12px;
  cursor: pointer;
}

.trail-toggle-btn.active {
  color: #FFEAA7;
  background: #FFEAA720;
}

.trail-toggle-btn:hover {
  color: #FFEAA7;
}

/* 回放轨迹 SVG 层 */
.playback-trail-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 0;
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

.frame-btn {
  font-size: 12px;
  padding: 2px 6px;
}

.loop-btn {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 5px;
  color: #888;
}

.loop-btn.active {
  color: #FFD93D;
}

.progress-bar {
  flex: 1;
  height: 6px;
  background: #333;
  border-radius: 3px;
  cursor: pointer;
  position: relative;
}

.loop-region {
  position: absolute;
  top: 0;
  height: 100%;
  background: rgba(255, 217, 61, 0.2);
  border-left: 1px solid #FFD93D;
  border-right: 1px solid #FFD93D;
  pointer-events: none;
  z-index: 1;
}

/* 进度条检测事件标记 */
.progress-event-marker {
  position: absolute;
  top: -4px;
  width: 6px;
  height: 14px;
  border-radius: 1px;
  transform: translateX(-50%);
  cursor: pointer;
  z-index: 2;
  opacity: 0.8;
  transition: opacity 0.15s, transform 0.15s;
}

.progress-event-marker:hover {
  opacity: 1;
  transform: translateX(-50%) scaleY(1.3);
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

.progress-tooltip {
  position: absolute;
  bottom: 100%;
  transform: translateX(-50%);
  background: #1a1a2e;
  color: #e0e0e0;
  font-size: 11px;
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  padding: 3px 6px;
  border-radius: 4px;
  border: 1px solid #4ECDC4;
  white-space: nowrap;
  pointer-events: none;
  margin-bottom: 4px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  overflow: hidden;
}

.tooltip-thumb {
  width: 128px;
  height: 72px;
  object-fit: cover;
  display: block;
  border-radius: 2px;
  background: #0a0a1a;
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

/* 音量控制 */
.volume-control {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.volume-icon {
  font-size: 16px;
  padding: 0;
}

.volume-slider {
  width: 60px;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: #333;
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}

.volume-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #4ECDC4;
  cursor: pointer;
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

/* 播放器检测事件列表 */
.event-list-btn {
  background: transparent;
  border: 1px solid #3a3a5a;
  color: #aaa;
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}

.event-list-btn.active {
  border-color: #4ECDC4;
  color: #4ECDC4;
  background: #4ECDC415;
}

.event-list-btn:hover { color: #4ECDC4; }

.playback-event-list {
  max-height: 200px;
  border-top: 1px solid #2a2a4a;
  background: #0a0a1a;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.playback-event-header {
  padding: 4px 12px;
  font-size: 11px;
  color: #888;
  border-bottom: 1px solid #1a1a3a;
  flex-shrink: 0;
}

.playback-event-items {
  overflow-y: auto;
  flex: 1;
}

.playback-event-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 12px;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.1s;
}

.playback-event-item:hover { background: #1a1a3a; }
.playback-event-item.active { background: #4ECDC420; border-left: 2px solid #4ECDC4; }

.pev-time { color: #aaa; flex-shrink: 0; min-width: 70px; }
.pev-labels { color: #e0e0e0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pev-count { color: #4ECDC4; font-size: 10px; }

.playback-behavior-list {
  margin-top: 4px;
  border-top: 1px solid #2a2a4a;
  padding-top: 4px;
}

.behavior-event {
  gap: 6px;
}

.behavior-tag {
  color: #fff;
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  flex-shrink: 0;
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
  flex-wrap: wrap;
}

.export-presets {
  display: flex;
  gap: 4px;
}

.preset-btn {
  background: #2a2a4a;
  color: #aaa;
  border: 1px solid #3a3a5a;
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
}

.preset-btn:hover {
  background: #3a3a5a;
  color: #4ECDC4;
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

.select-all-btn {
  background: #2a2a4a;
  color: #4ECDC4;
  border: none;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}

.select-all-btn:hover {
  background: #3a3a5a;
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

.zip-btn {
  background: #3498db;
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.zip-btn:hover:not(:disabled) {
  opacity: 0.85;
}

.zip-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.batch-star-btn {
  background: none;
  border: 1px solid #FFD93D;
  color: #FFD93D;
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 11px;
  cursor: pointer;
}

.batch-star-btn:hover:not(:disabled) {
  background: #FFD93D;
  color: #1a1a2e;
}

.batch-star-btn:disabled {
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

  .rec-star,
  .rec-delete,
  .rec-delete-before,
  .rec-download {
    opacity: 0.6;
  }

  .pip-window {
    width: 160px !important;
  }
}

/* PiP 切换按钮（在 scoped 播放器 header 内） */
.pip-toggle-btn {
  background: transparent;
  border: 1px solid #444;
  color: #aaa;
  border-radius: 4px;
  padding: 2px 6px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s;
}
.pip-toggle-btn:hover {
  color: #fff;
  border-color: #5bc0de;
}
.pip-toggle-btn.active {
  color: #5bc0de;
  border-color: #5bc0de;
  background: rgba(91, 192, 222, 0.15);
}
</style>

<!-- PiP 使用 Teleport，样式需要非 scoped -->
<style>
.pip-window {
  position: fixed;
  z-index: 10000;
  background: #000;
  border: 2px solid #5bc0de;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6);
}
.pip-window:hover {
  box-shadow: 0 4px 24px rgba(91, 192, 222, 0.3);
}
.pip-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  background: #0d1b2a;
  cursor: move;
  user-select: none;
}
.pip-label {
  font-size: 10px;
  font-weight: 700;
  color: #ff4444;
  background: rgba(255, 68, 68, 0.15);
  padding: 1px 4px;
  border-radius: 2px;
  letter-spacing: 0.5px;
  animation: pip-pulse 2s ease-in-out infinite;
}
@keyframes pip-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
.pip-camera-select {
  flex: 1;
  background: #16213e;
  color: #ddd;
  border: 1px solid #2a2a4a;
  border-radius: 3px;
  font-size: 11px;
  padding: 1px 2px;
  cursor: pointer;
  min-width: 0;
}
.pip-close {
  background: transparent;
  border: none;
  color: #888;
  font-size: 16px;
  cursor: pointer;
  padding: 0 2px;
  line-height: 1;
}
.pip-close:hover {
  color: #ff6b6b;
}
.pip-window .pip-canvas {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #111;
}
</style>
