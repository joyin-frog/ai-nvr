<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { EventClient, type ConnectionState } from './services/events'
import { isAuthEnabled, getToken, authFetch, authWsUrl, authUrl } from './services/auth'
import { putFrame } from './services/ws-frame-cache'
import { putDetections, pushZoneNotification, pushMatchSuggestion } from './services/ws-detect-cache'
import { registerShortcut, useKeyboardShortcuts } from './composables/useKeyboard'
import { useToast } from './composables/useToast'
import { usePreferences } from './composables/usePreferences'
import { useRegisterSW } from 'virtual:pwa-register/vue'
import CameraView from './components/CameraView.vue'
import EventPanel from './components/EventPanel.vue'
import RecordingsPanel from './components/RecordingsPanel.vue'
import CameraStatusPanel from './components/CameraStatusPanel.vue'
import CameraManagePanel from './components/CameraManagePanel.vue'
import AlertPanel from './components/AlertPanel.vue'
import TrackGallery from './components/TrackGallery.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import LoginView from './components/LoginView.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'

const { t, locale } = useI18n()
const { toasts: toastToasts, dismiss: toastDismiss, error: toastError, warning: toastWarning } = useToast()
const { getPref } = usePreferences()

/** 切换语言 */
function toggleLocale() {
  const next = locale.value === 'zh-CN' ? 'en' : 'zh-CN'
  locale.value = next
  localStorage.setItem('nvr-locale', next)
}

/** 摄像头状态 */
interface CameraStatus {
  id: string
  name: string
  online: boolean
  lastFrameAt: number
  group: string
  ptz: boolean
  width: number
  height: number
  /** 是否正在录像 */
  recording: boolean
  /** 录像开始时间戳 */
  recordingStart: number
  /** 是否双流模式（HD显示+SD检测） */
  dualStream: boolean
  /** 显示流帧率 */
  displayFps: number
  /** 检测流帧率 */
  detectFps: number
}

/** 侧边栏激活的标签 */
type SidebarTab = 'events' | 'recordings' | 'status' | 'cameras' | 'alerts' | 'tracks' | 'settings'
const savedTab = localStorage.getItem('nvr-active-tab') as SidebarTab | null
const activeTab = ref<SidebarTab>(savedTab ?? 'events')

/** 摄像头 FPS 映射（从 health API 更新） */
const cameraFpsMap = ref<Record<string, number>>({})
/** 摄像头帧大小映射（KB，从 health API 更新） */
const cameraFrameSizeMap = ref<Record<string, number>>({})

/** 摄像头 ID → 索引映射（避免每帧 Array.find 的 O(n) 查找） */
const cameraIndexMap = computed(() => {
  const map = new Map<string, number>()
  for (let i = 0; i < cameras.value.length; i++) {
    map.set(cameras.value[i]!.id, i)
  }
  return map
})

/** 快速查找摄像头（O(1) Map 查找替代 Array.find） */
function getCamera(id: string): CameraStatus | undefined {
  const idx = cameraIndexMap.value.get(id)
  return idx !== undefined ? cameras.value[idx] : undefined
}

/** 全屏摄像头 ID（null 为网格模式） */
const fullscreenCamera = ref<string | null>(null)

/** PWA 更新提示 */
const { offlineReady, needRefresh, updateServiceWorker } = useRegisterSW({
  immediate: true,
  onRegisteredSW(_swUrl: string, registration: ServiceWorkerRegistration | undefined) {
    if (registration) {
      pwaUpdateTimer = setInterval(() => { registration.update() }, 60 * 60 * 1000)
    }
  },
})
const showPwaPrompt = computed(() => offlineReady.value || needRefresh.value)
function closePwaPrompt() {
  offlineReady.value = false
  needRefresh.value = false
}

/** 网格列数配置 */
const gridCols = ref(Number(localStorage.getItem('nvr-grid-cols')) || 0) // 0 = auto

/** 循环切换网格列数：auto → 1 → 2 → 3 → 4 → auto */
function cycleGridCols() {
  const cycle = [0, 1, 2, 3, 4]
  const idx = cycle.indexOf(gridCols.value)
  gridCols.value = cycle[(idx + 1) % cycle.length]!
  localStorage.setItem('nvr-grid-cols', String(gridCols.value))
}

/** 分组筛选（空字符串表示全部） */
const filterGroup = ref('')

/** 所有分组列表 */
const groups = computed(() => {
  const set = new Set<string>()
  for (const cam of cameras.value) {
    if (cam.group) set.add(cam.group)
  }
  return [...set].sort()
})

/** 是否为移动端布局 */
const isMobile = ref(false)
/** 移动端底部面板是否展开 */
const mobilePanelOpen = ref(false)
/** 移动端面板高度（px，默认 50vh） */
const mobilePanelHeight = ref(Number(localStorage.getItem('nvr-mobile-panel-height')) || Math.round(window.innerHeight * 0.5))

/** 移动端面板拖拽调整高度 */
function onMobileDragStart(e: TouchEvent) {
  const startY = e.touches[0]!.clientY
  const startHeight = mobilePanelHeight.value
  function onMove(ev: TouchEvent) {
    const delta = startY - ev.touches[0]!.clientY
    const maxH = Math.round(window.innerHeight * 0.85)
    const minH = 120
    mobilePanelHeight.value = Math.max(minH, Math.min(maxH, startHeight + delta))
  }
  function onEnd() {
    localStorage.setItem('nvr-mobile-panel-height', String(mobilePanelHeight.value))
    document.removeEventListener('touchmove', onMove)
    document.removeEventListener('touchend', onEnd)
  }
  document.addEventListener('touchmove', onMove, { passive: true })
  document.addEventListener('touchend', onEnd)
}

/** 侧边栏宽度（可拖拽调整） */
const sidebarWidth = ref(Number(localStorage.getItem('nvr-sidebar-width')) || 340)
/** 拖拽调整侧边栏宽度 */
let resizing = false
function onResizeStart(e: MouseEvent) {
  e.preventDefault()
  resizing = true
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  const startX = e.clientX
  const startWidth = sidebarWidth.value
  function onMove(ev: MouseEvent) {
    if (!resizing) return
    const delta = ev.clientX - startX
    sidebarWidth.value = Math.max(260, Math.min(600, startWidth + delta))
  }
  function onUp() {
    resizing = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    localStorage.setItem('nvr-sidebar-width', String(sidebarWidth.value))
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

/** 检测屏幕宽度 */
function checkMobile() {
  isMobile.value = window.innerWidth < 768
}

const cameras = ref<CameraStatus[]>([])
/** 摄像头排序（ID 数组，持久化到 localStorage） */
const cameraOrder = ref<string[]>(JSON.parse(localStorage.getItem('nvr-camera-order') ?? '[]'))
/** 是否显示检测框（从 settings API 获取） */
const showBoxes = ref(true)
/** 每个摄像头的追踪标签映射：cameraId -> { trackId: name } */
const trackLabelsMap = ref<Record<string, Record<number, string>>>({})
/** 每个摄像头的帧延迟（ms），基于 serverTimestamp - 接收时间差 */
const frameLatency = ref<Record<string, number>>({})
/** ROI 区域数据（按摄像头分组） */
const roiDataMap = ref<Record<string, Array<{ id: number; name: string; points: string }>>>({})
/** 摄像头 ID → 解析后的 ROI 列表（归一化坐标） */
const parsedRoiMap = computed(() => {
  const result: Record<string, Array<{ id: number; name: string; points: Array<{ x: number; y: number }> }>> = {}
  for (const [camId, regions] of Object.entries(roiDataMap.value)) {
    result[camId] = regions.map(r => ({
      id: r.id,
      name: r.name,
      points: JSON.parse(r.points) as Array<{ x: number; y: number }>,
    }))
  }
  return result
})
const eventPanel = ref<InstanceType<typeof EventPanel> | null>(null)
const recordingsPanel = ref<InstanceType<typeof RecordingsPanel> | null>(null)
const cameraManagePanel = ref<InstanceType<typeof CameraManagePanel> | null>(null)
const alertPanel = ref<InstanceType<typeof AlertPanel> | null>(null)
const showShortcuts = ref(false)

/** 认证状态 */
const authRequired = ref(false)
const authenticated = ref(false)

/** WebSocket 连接状态 */
const wsState = ref<ConnectionState>('disconnected')
/** 是否为首次连接（区分首次连接和重连） */
let firstConnection = true

/** 磁盘空间预警 */
const diskWarn = ref<{ percent: number; free: string } | null>(null)
let diskCheckTimer: ReturnType<typeof setInterval> | null = null
/** PWA 更新检查定时器 */
let pwaUpdateTimer: ReturnType<typeof setInterval> | null = null

async function checkDiskSpace() {
  try {
    const res = await authFetch('/api/health')
    if (!res.ok) return
    const data = await res.json()
    /** 更新摄像头 FPS */
    if (data.cameras && Array.isArray(data.cameras)) {
      const fpsMap: Record<string, number> = {}
      for (const cam of data.cameras as Array<{ cameraId: string; fps: number }>) {
        fpsMap[cam.cameraId] = cam.fps
      }
      cameraFpsMap.value = fpsMap
      /** 更新摄像头帧大小 */
      const sizeMap: Record<string, number> = {}
      for (const cam of data.cameras as Array<{ cameraId: string; avgFrameSizeKb: number }>) {
        sizeMap[cam.cameraId] = cam.avgFrameSizeKb
      }
      cameraFrameSizeMap.value = sizeMap
    }
    const storage = data.storage as { diskTotalBytes: number; diskFreeBytes: number } | undefined
    if (!storage || storage.diskTotalBytes === 0) return
    const used = storage.diskTotalBytes - storage.diskFreeBytes
    const percent = Math.round((used / storage.diskTotalBytes) * 100)
    if (percent >= 80) {
      const free = storage.diskFreeBytes
      const freeStr = free < 1024 * 1024 * 1024
        ? `${(free / (1024 * 1024)).toFixed(0)} MB`
        : `${(free / (1024 * 1024 * 1024)).toFixed(1)} GB`
      diskWarn.value = { percent, free: freeStr }
    } else {
      diskWarn.value = null
    }
  } catch {
    // ignore
  }
}

/** 创建带认证的 WebSocket 客户端 */
const client = new EventClient(authWsUrl('/api/events'))

/** 动态标题：闪烁后自动恢复 */
let titleTimer: ReturnType<typeof setTimeout> | null = null
function flashTitle(message: string, duration = 5000) {
  document.title = `⚠ ${message}`
  if (titleTimer) clearTimeout(titleTimer)
  titleTimer = setTimeout(() => {
    const online = onlineCameras.value.length
    document.title = `JK NVR - ${t('notify.titleOnline', { total: cameras.value.length, online })}`
    titleTimer = null
  }, duration)
}

/** 更新常态标题 */
function updateTitle() {
  if (titleTimer) return
  const online = onlineCameras.value.length
  document.title = `JK NVR - ${t('notify.titleOnline', { total: cameras.value.length, online })}`
}

/** 拖拽排序 */
const dragCameraId = ref<string | null>(null)

function onDragStart(cameraId: string) {
  dragCameraId.value = cameraId
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
}

function onDrop(targetId: string) {
  if (!dragCameraId.value || dragCameraId.value === targetId) return
  const ids = sortedCameras.value.map(c => c.id)
  const fromIdx = ids.indexOf(dragCameraId.value)
  const toIdx = ids.indexOf(targetId)
  if (fromIdx < 0 || toIdx < 0) return
  ids.splice(fromIdx, 1)
  ids.splice(toIdx, 0, dragCameraId.value)
  cameraOrder.value = ids
  localStorage.setItem('nvr-camera-order', JSON.stringify(ids))
  dragCameraId.value = null
}

/** 加载摄像头列表 */
async function loadCameras() {
  try {
    const res = await authFetch('/api/cameras')
    if (res.status === 401) return
    const data = await res.json()
    cameras.value = data.map((c: CameraStatus) => ({
      id: c.id,
      name: c.name,
      online: c.online,
      lastFrameAt: c.lastFrameAt,
      group: c.group ?? '',
      ptz: c.ptz ?? false,
      width: c.width ?? 0,
      height: c.height ?? 0,
      recording: c.recording ?? false,
      recordingStart: c.recordingStart ?? 0,
      dualStream: c.dualStream ?? false,
      displayFps: c.displayFps ?? 0,
      detectFps: c.detectFps ?? 0,
    }))
    updateTitle()
    loadRoiData()
    /** 订阅当前摄像头的帧推送，减少无关帧带宽 */
    client.subscribe(cameras.value.map(c => c.id))
  } catch {
    toastError(t('app.loadFailed'))
  }
}

/** 加载 ROI 区域数据 */
async function loadRoiData() {
  try {
    const res = await authFetch('/api/roi')
    if (!res.ok) return
    const allRois = await res.json() as Array<{ id: number; cameraId: string; name: string; points: string }>
    const grouped: Record<string, Array<{ id: number; name: string; points: string }>> = {}
    for (const r of allRois) {
      if (!grouped[r.cameraId]) grouped[r.cameraId] = []
      grouped[r.cameraId]!.push({ id: r.id, name: r.name, points: r.points })
    }
    roiDataMap.value = grouped
  } catch {
    toastWarning('ROI ' + t('app.loadFailed'))
  }
}

/** 事件点击跳转录像 */
async function onPlayRecording(cameraId: string, timestamp: number) {
  activeTab.value = 'recordings'
  /** 等 DOM 更新后调用 playAtTime */
  await new Promise(r => setTimeout(r, 50))
  await recordingsPanel.value?.playAtTime(cameraId, timestamp)
}

/** 切换到录像标签时刷新列表 */
function switchTab(tab: SidebarTab) {
  activeTab.value = tab
  localStorage.setItem('nvr-active-tab', tab)
  if (tab === 'recordings') {
    recordingsPanel.value?.loadRecordings()
  }
  if (tab === 'events') {
    eventPanel.value?.loadHistory()
  }
  if (tab === 'cameras') {
    cameraManagePanel.value?.loadCameras()
  }
}

/** 进入全屏单路 */
function enterFullscreen(cameraId: string) {
  fullscreenCamera.value = cameraId
  /** 同时请求浏览器全屏 */
  document.documentElement.requestFullscreen?.().catch(() => { /* ignore */ })
}

/** 退出全屏回到网格 */
function exitFullscreen() {
  fullscreenCamera.value = null
  stopPatrol()
  if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => { /* ignore */ })
  }
}

/** 轮巡模式 */
const patrolActive = ref(false)
/** 轮巡间隔（秒） */
const patrolInterval = ref(5)
/** 轮巡定时器 */
let patrolTimer: ReturnType<typeof setInterval> | null = null
/** 当前轮巡索引 */
let patrolIndex = 0

/** 获取在线摄像头列表 */
const onlineCameras = computed(() => cameras.value.filter(c => c.online))

/** 开始轮巡 */
function startPatrol() {
  if (onlineCameras.value.length === 0) return
  patrolActive.value = true
  patrolIndex = 0
  fullscreenCamera.value = onlineCameras.value[0]!.id
  patrolTimer = setInterval(() => {
    const cams = onlineCameras.value
    if (cams.length === 0) { stopPatrol(); return }
    patrolIndex = (patrolIndex + 1) % cams.length
    fullscreenCamera.value = cams[patrolIndex]!.id
  }, patrolInterval.value * 1000)
}

/** 停止轮巡 */
function stopPatrol() {
  patrolActive.value = false
  if (patrolTimer) {
    clearInterval(patrolTimer)
    patrolTimer = null
  }
}

/** 切换轮巡 */
function togglePatrol() {
  if (patrolActive.value) {
    stopPatrol()
  } else {
    startPatrol()
  }
}

/** 网格列数样式 */
const gridStyle = computed(() => {
  if (fullscreenCamera.value) return {}
  if (isMobile.value) return { 'grid-template-columns': '1fr' }
  const n = gridCols.value
  if (n > 0) return { 'grid-template-columns': `repeat(${n}, 1fr)` }
  return { 'grid-template-columns': 'repeat(auto-fit, minmax(400px, 1fr))' }
})

/** 按 cameraOrder 排序的摄像头列表 */
const sortedCameras = computed(() => {
  if (cameraOrder.value.length === 0) return cameras.value
  const orderMap = new Map(cameraOrder.value.map((id, i) => [id, i]))
  return [...cameras.value].sort((a, b) => {
    const oa = orderMap.get(a.id) ?? Infinity
    const ob = orderMap.get(b.id) ?? Infinity
    return oa - ob
  })
})

/** 显示的摄像头列表 */
const visibleCameras = computed(() => {
  const list = fullscreenCamera.value
    ? sortedCameras.value.filter(c => c.id === fullscreenCamera.value)
    : filterGroup.value
      ? sortedCameras.value.filter(c => c.group === filterGroup.value)
      : sortedCameras.value
  return list
})

/** 按分组聚集摄像头（用于分组视图） */
const groupedCameras = computed(() => {
  if (fullscreenCamera.value || filterGroup.value) {
    return [{ group: '', cameras: visibleCameras.value }]
  }
  const map = new Map<string, CameraStatus[]>()
  for (const cam of visibleCameras.value) {
    const g = cam.group || ''
    const list = map.get(g) ?? []
    list.push(cam)
    map.set(g, list)
  }
  /** 确保有分组的在前，无分组的在后 */
  const result: Array<{ group: string; cameras: CameraStatus[] }> = []
  for (const [group, cams] of map) {
    if (group) result.push({ group, cameras: cams })
  }
  const ungrouped = map.get('')
  if (ungrouped) result.push({ group: '', cameras: ungrouped })
  return result
})

/** 折叠的分组（用 Record 确保响应式） */
const collapsedGroups = ref<Record<string, boolean>>({})

/** 登录成功回调 */
function onLoginSuccess() {
  authenticated.value = true
  startApp()
}

/** 从 settings API 加载 showBoxes 配置 */
async function loadShowBoxes() {
  const res = await authFetch('/api/settings')
  if (res.ok) {
    const s = await res.json()
    if (typeof s.ai?.showBoxes === 'boolean') showBoxes.value = s.ai.showBoxes
  }
}

/** 加载所有摄像头的追踪标签（批量请求替代 N+1 串行） */
async function loadTrackLabels() {
  const map: Record<string, Record<number, string>> = {}
  /** 批量加载所有 TrackLabel 标签（单次请求） */
  try {
    const res = await authFetch('/api/track-labels')
    if (res.ok) {
      const labels = await res.json() as Array<{ cameraId: string; trackId: number; name: string }>
      for (const l of labels) {
        if (!l.name) continue
        if (!map[l.cameraId]) map[l.cameraId] = {}
        map[l.cameraId][l.trackId] = l.name
      }
    }
  } catch { /* non-critical */ }
  /** TrackStorage 自动快照目标的 customName */
  try {
    const res = await authFetch('/api/tracks')
    if (res.ok) {
      const tracks = await res.json() as Array<{ trackId: number; customName?: string; cameraIds: string[] }>
      for (const track of tracks) {
        if (!track.customName) continue
        for (const camId of track.cameraIds) {
          if (!map[camId]) map[camId] = {}
          if (!map[camId][track.trackId]) {
            map[camId][track.trackId] = track.customName
          }
        }
      }
    }
  } catch { /* non-critical */ }
  trackLabelsMap.value = map
}

/** 启动应用主逻辑 */
function startApp() {
  loadCameras().then(() => loadTrackLabels())
  loadShowBoxes()
  setupEventListeners()
  client.connect()
  client.onStateChange((state) => {
    wsState.value = state
    if (state === 'connected') {
      if (firstConnection) {
        firstConnection = false
      } else {
        loadCameras().then(() => loadTrackLabels())
        loadRoiData()
        loadShowBoxes()
        eventPanel.value?.loadHistory()
        recordingsPanel.value?.loadRecordings()
      }
    }
  })
  checkDiskSpace()
  diskCheckTimer = setInterval(checkDiskSpace, 300000)
}

/** 浏览器通知（点击后聚焦窗口并跳转到对应摄像头） */
/** 声音提醒配置 */
const soundEnabled = ref(true)
const soundVolume = ref(0.8)

/** 从后端恢复声音配置 */
getPref<boolean>('nvr-sound-alert', true).then(v => { soundEnabled.value = v })
getPref<number>('nvr-sound-volume', 80).then(v => { soundVolume.value = v / 100 })

/** Web Audio API 播放提示音 */
let audioCtx: AudioContext | null = null
function playAlertSound() {
  if (!soundEnabled.value) return
  if (!audioCtx) audioCtx = new AudioContext()
  const ctx = audioCtx
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.type = 'sine'
  osc.frequency.setValueAtTime(880, ctx.currentTime)
  osc.frequency.setValueAtTime(660, ctx.currentTime + 0.1)
  gain.gain.setValueAtTime(soundVolume.value * 0.3, ctx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
  osc.start(ctx.currentTime)
  osc.stop(ctx.currentTime + 0.3)
}

function notify(title: string, body: string, cameraId?: string) {
  playAlertSound()
  if ('Notification' in window && Notification.permission === 'granted') {
    const icon = cameraId ? authUrl(`/api/detection/annotated/${cameraId}`) : undefined
    const n = new Notification(title, { body, icon })
    n.onclick = () => {
      window.focus()
      if (cameraId) enterFullscreen(cameraId)
      n.close()
    }
  }
}


/** 注册事件监听器 */
function setupEventListeners() {
  /** 首次用户交互时请求通知权限（需要用户手势） */
  if ('Notification' in window && Notification.permission === 'default') {
    const handler = () => {
      Notification.requestPermission()
      document.removeEventListener('click', handler)
    }
    document.addEventListener('click', handler)
  }

  client.on('motion', (payload) => {
    eventPanel.value?.addEvent('motion', payload.cameraId, `${t('event.motion')} ${(payload.ratio * 100).toFixed(1)}%`)
  })

  client.on('frame', (payload) => {
    /** 更新摄像头最后帧时间（防止"画面冻结"误判） */
    const cam = getCamera(payload.cameraId)
    if (cam) cam.lastFrameAt = payload.timestamp ?? Date.now()
    /** 计算帧延迟（ms）：当前时间 - 服务端帧时间戳 */
    if (payload.timestamp) {
      const latency = Math.max(0, Date.now() - payload.timestamp)
      /** 只在延迟变化超过 50ms 时触发响应式更新，减少 GC 压力 */
      if (Math.abs((frameLatency.value[payload.cameraId] ?? 0) - latency) > 50) {
        frameLatency.value = { ...frameLatency.value, [payload.cameraId]: latency }
      } else {
        frameLatency.value[payload.cameraId] = latency
      }
    }
    /** 缓存 WS 帧数据供 CameraView rAF poll 消费（跳过 Vue 响应式） */
    if (payload.jpegData) {
      putFrame(payload.cameraId, payload.jpegData)
    }
  })

  client.on('detect', (payload) => {
    /** 存入非响应式缓存，CameraView 通过 rAF poll 消费 */
    putDetections(payload.cameraId, payload.detections, payload.inferMs)
    /** 0 目标或重复检测时只更新 UI 状态，不记录事件/通知 */
    if (payload.detections.length === 0 || payload.changed === false) return

    const labels = payload.detections.map((d) => d.label).join(', ')
    const detail = labels
    /** 关联标注快照 URL（后端 annotator 缓存了最新标注图） */
    const snapshotUrl = authUrl(`/api/detection/annotated/${payload.cameraId}`)
    eventPanel.value?.addDetectEvent('detect', payload.cameraId, detail, snapshotUrl, payload.detections)
  })

  client.on('camera:online', (payload) => {
    const cam = getCamera(payload.cameraId)
    if (cam) cam.online = true
    eventPanel.value?.addEvent('camera:online', payload.cameraId, t('event.online'))
    updateTitle()
  })

  client.on('camera:offline', (payload) => {
    const cam = getCamera(payload.cameraId)
    if (cam) cam.online = false
    eventPanel.value?.addEvent('camera:offline', payload.cameraId, t('event.offline'))
    notify(t('notify.cameraOffline', { name: cam?.name ?? payload.cameraId }), t('notify.cameraOfflineBody'), payload.cameraId)
    flashTitle(t('notify.cameraOffline', { name: cam?.name ?? payload.cameraId }), 10000)
  })

  client.on('camera:lowfps', (payload) => {
    const cam = getCamera(payload.cameraId)
    eventPanel.value?.addEvent('camera:lowfps', payload.cameraId, `FPS: ${payload.fps.toFixed(1)}`)
    notify(t('notify.cameraLowFps', { name: cam?.name ?? payload.cameraId }), `FPS: ${payload.fps.toFixed(1)}`, payload.cameraId)
  })

  client.on('alert', (payload) => {
    eventPanel.value?.addEvent('alert', payload.cameraId, `${t('notify.alertPrefix')}: ${payload.ruleName}`)
    alertPanel.value?.addAlert(payload)
    notify(t('notify.alert', { ruleName: payload.ruleName }), payload.cameraId, payload.cameraId)
    flashTitle(`${t('notify.alertPrefix')}: ${payload.ruleName} - ${payload.cameraId}`, 10000)
  })

  client.on('track:appeared', (payload) => {
    const customName = payload.trackName || trackLabelsMap.value[payload.cameraId]?.[payload.trackId]
    const displayName = customName ? `${customName} (${payload.label})` : `${payload.label} #${payload.trackId}`
    eventPanel.value?.addEvent('track:appeared', payload.cameraId, `${displayName} ${t('event.trackAppeared', '出现')}`)
    /** 已命名目标出现时发送浏览器通知 */
    if (customName) {
      const cam = cameras.value.find(c => c.id === payload.cameraId)
      notify(displayName, `${t('event.trackAppeared', '出现')} · ${cam?.name ?? payload.cameraId}`, payload.cameraId)
    }
  })

  client.on('track:disappeared', (payload) => {
    const customName = payload.trackName || trackLabelsMap.value[payload.cameraId]?.[payload.trackId]
    const displayName = customName ? `${customName} (${payload.label})` : `${payload.label} #${payload.trackId}`
    eventPanel.value?.addEvent('track:disappeared', payload.cameraId, `${displayName} ${t('event.trackDisappeared', '消失')}`)
  })

  client.on('track:enter-zone', (payload) => {
    const customName = payload.trackName || trackLabelsMap.value[payload.cameraId]?.[payload.trackId]
    const displayName = customName ? `${customName} (${payload.label})` : `${payload.label} #${payload.trackId}`
    eventPanel.value?.addEvent('track:enter-zone', payload.cameraId, `${displayName} → ${payload.zoneName}`)
    pushZoneNotification(payload.cameraId, { type: 'enter', name: customName || payload.label, zoneName: payload.zoneName, timestamp: payload.timestamp })
  })

  client.on('track:leave-zone', (payload) => {
    const customName = payload.trackName || trackLabelsMap.value[payload.cameraId]?.[payload.trackId]
    const displayName = customName ? `${customName} (${payload.label})` : `${payload.label} #${payload.trackId}`
    const dwellSec = (payload.dwellMs / 1000).toFixed(0)
    eventPanel.value?.addEvent('track:leave-zone', payload.cameraId, `${displayName} ← ${payload.zoneName} (${dwellSec}s)`)
    pushZoneNotification(payload.cameraId, { type: 'leave', name: customName || payload.label, zoneName: payload.zoneName, timestamp: payload.timestamp, dwellMs: payload.dwellMs })
  })

  client.on('track:dwell', (payload) => {
    const customName = payload.trackName || trackLabelsMap.value[payload.cameraId]?.[payload.trackId]
    const displayName = customName ? `${customName} (${payload.label})` : `${payload.label} #${payload.trackId}`
    const dwellSec = (payload.dwellMs / 1000).toFixed(0)
    eventPanel.value?.addEvent('track:dwell', payload.cameraId, `${displayName} 在 ${payload.zoneName} 停留 ${dwellSec}s`)
    pushZoneNotification(payload.cameraId, { type: 'dwell', name: customName || payload.label, zoneName: payload.zoneName, timestamp: payload.timestamp, dwellMs: payload.dwellMs })
  })

  client.on('track:speed', (payload) => {
    const customName = payload.trackName || trackLabelsMap.value[payload.cameraId]?.[payload.trackId]
    const displayName = customName ? `${customName} (${payload.label})` : `${payload.label} #${payload.trackId}`
    eventPanel.value?.addEvent('track:speed', payload.cameraId, `${displayName} 高速移动 (${payload.speed.toFixed(3)}/帧)`)
  })

  client.on('track:match-suggest', (payload) => {
    const best = payload.matches[0]
    if (!best) return
    const dist = ((64 - best.distance) / 64 * 100).toFixed(0)
    eventPanel.value?.addEvent('track:match-suggest', payload.cameraId, `${payload.label} #${payload.trackId} 可能是 "${best.customName}" (${dist}% 相似)`)
    pushMatchSuggestion(payload.cameraId, { trackId: payload.trackId, label: payload.label, matches: payload.matches, timestamp: payload.timestamp })
  })

  /** 其他客户端更新了追踪标签 → 实时同步 */
  client.on('track:label-updated', (payload) => {
    const map = { ...trackLabelsMap.value }
    const camMap = { ...(map[payload.cameraId] ?? {}) }
    camMap[payload.trackId] = payload.name
    map[payload.cameraId] = camMap
    trackLabelsMap.value = map
  })

}

onMounted(async () => {
  checkMobile()
  window.addEventListener('resize', checkMobile)

  /** 浏览器全屏退出时同步退出单路模式 */
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && fullscreenCamera.value) {
      fullscreenCamera.value = null
    }
  })

  /** 检查是否需要认证 */
  const enabled = await isAuthEnabled()
  if (enabled) {
    authRequired.value = true
    /** 已有 token 则尝试直接启动 */
    const token = getToken()
    if (token) {
      const res = await authFetch('/api/cameras')
      if (res.ok) {
        authenticated.value = true
        startApp()
      }
      /** 401 则清除 token，显示登录页 */
    }
    if (!authenticated.value) return
  } else {
    startApp()
  }

  /** 键盘快捷键 */
  useKeyboardShortcuts()

  /** 下载 Blob 文件 */
  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  }

  /** ISO 时间戳（用于文件名） */
  function ts() {
    return new Date().toISOString().replace(/[:.]/g, '-')
  }

  registerShortcut({ key: '1', description: t('shortcuts.switchTab'), handler: () => switchTab('events') })
  registerShortcut({ key: '2', description: t('shortcuts.switchTab'), handler: () => switchTab('recordings') })
  registerShortcut({ key: '3', description: t('shortcuts.switchTab'), handler: () => switchTab('status') })
  registerShortcut({ key: '4', description: t('shortcuts.switchTab'), handler: () => switchTab('cameras') })
  registerShortcut({ key: '5', description: t('shortcuts.switchTab'), handler: () => switchTab('alerts') })
  registerShortcut({ key: '6', description: t('shortcuts.switchTab'), handler: () => switchTab('tracks') })
  registerShortcut({ key: '7', description: t('shortcuts.switchTab'), handler: () => switchTab('settings') })
  registerShortcut({ key: 'f', description: t('shortcuts.fullscreen'), handler: () => {
    if (fullscreenCamera.value) exitFullscreen()
    else if (cameras.value.length > 0) enterFullscreen(cameras.value[0]!.id)
  }})
  registerShortcut({ key: 'Escape', description: t('shortcuts.exit'), handler: () => {
    if (fullscreenCamera.value) exitFullscreen()
  }})
  registerShortcut({ key: '?', description: t('shortcuts.help'), handler: () => { showShortcuts.value = !showShortcuts.value }})
  registerShortcut({ key: 'p', description: t('shortcuts.patrol'), handler: () => { togglePatrol() }})
  registerShortcut({ key: 's', description: t('shortcuts.screenshot'), handler: async () => {
    /** 全屏模式：截当前摄像头；网格模式：Shift+S 截所有，否则截第一个 */
    if (fullscreenCamera.value) {
      const res = await authFetch(`/api/snapshot/${fullscreenCamera.value}?quality=hd`)
      if (res.ok) downloadBlob(await res.blob(), `screenshot_${fullscreenCamera.value}_${ts()}.jpg`)
    } else if (visibleCameras.value.length === 1) {
      const cam = visibleCameras.value[0]!
      const res = await authFetch(`/api/snapshot/${cam.id}?quality=hd`)
      if (res.ok) downloadBlob(await res.blob(), `screenshot_${cam.id}_${ts()}.jpg`)
    } else {
      /** 多路模式：并行截取所有在线摄像头 */
      const onlineIds = visibleCameras.value.filter(c => c.online).map(c => c.id)
      const blobs = await Promise.all(onlineIds.map(async id => {
        const res = await authFetch(`/api/snapshot/${id}?quality=hd`)
        return res.ok ? { id, blob: await res.blob() } : null
      }))
      for (const item of blobs) {
        if (item) downloadBlob(item.blob, `screenshot_${item.id}_${ts()}.jpg`)
      }
    }
  }})
})

onUnmounted(() => {
  client.disconnect()
  window.removeEventListener('resize', checkMobile)
  stopPatrol()
  if (diskCheckTimer) clearInterval(diskCheckTimer)
  if (pwaUpdateTimer) clearInterval(pwaUpdateTimer)
})
</script>

<template>
  <!-- 登录页 -->
  <LoginView v-if="authRequired && !authenticated" @success="onLoginSuccess" />
  <!-- 主界面 -->
  <div v-else class="app" :class="{ mobile: isMobile }">
    <!-- 磁盘空间预警横幅 -->
    <div v-if="diskWarn" :class="['disk-warn-bar', { critical: diskWarn.percent >= 95 }]">
      <span>&#9888; {{ t('status.diskUsage') }} {{ diskWarn.percent }}% — {{ t('status.remaining') }} {{ diskWarn.free }}</span>
    </div>
    <header class="app-header">
      <h1>JK NVR</h1>
      <span class="status">{{ t('header.cameraCount', { count: cameras.length }) }}</span>
      <span :class="['ws-indicator', wsState]" :title="wsState === 'connected' ? t('header.wsConnected') : wsState === 'connecting' ? t('header.wsConnecting') : t('header.wsDisconnected')">
        {{ wsState === 'connected' ? '●' : wsState === 'connecting' ? '◐' : '○' }}
      </span>
      <select v-if="groups.length > 0" v-model="filterGroup" class="group-select">
        <option value="">{{ t('header.groupAll') }}</option>
        <option v-for="g in groups" :key="g" :value="g">{{ g }}</option>
      </select>
      <div class="header-actions">
        <button
          v-if="cameras.length > 1 && !fullscreenCamera && !isMobile"
          class="header-btn"
          @click="cycleGridCols"
          :title="t('header.gridCols', { n: gridCols || 'auto' })"
        >{{ gridCols || 'auto' }}</button>
        <button
          v-if="cameras.length > 1"
          :class="['header-btn', { active: patrolActive }]"
          @click="togglePatrol"
          :title="patrolActive ? t('header.patrolOff') : t('header.patrol')"
        >{{ t('header.patrol') }}</button>
        <input
          v-if="patrolActive"
          type="number"
          v-model.number="patrolInterval"
          min="2"
          max="60"
          class="patrol-input"
          :title="t('header.patrolInterval')"
        />
        <button
          v-if="fullscreenCamera && !patrolActive"
          class="header-btn"
          @click="exitFullscreen"
        >{{ t('header.backToGrid') }}</button>
        <button
          v-if="isMobile"
          class="header-btn"
          @click="mobilePanelOpen = !mobilePanelOpen"
        >{{ mobilePanelOpen ? t('header.close') : t('header.panel') }}</button>
        <button class="header-btn lang-btn" @click="toggleLocale" :title="locale === 'zh-CN' ? 'English' : '中文'">
          {{ locale === 'zh-CN' ? 'EN' : '中' }}
        </button>
      </div>
    </header>
    <main class="app-body">
      <div class="camera-grid" :style="gridStyle" :class="{ fullscreen: !!fullscreenCamera }">
        <div v-if="cameras.length === 0" class="empty-state">
          <div class="empty-icon">&#x1F4F7;</div>
          <p>{{ t('manage.noCameras') }}</p>
          <button class="header-btn" @click="switchTab('cameras')">{{ t('manage.addCamera') }}</button>
        </div>
        <template v-for="group in groupedCameras" :key="group.group">
          <div v-if="group.group && groupedCameras.length > 1" class="group-header" @click="collapsedGroups[group.group] = !collapsedGroups[group.group]">
            <span class="group-toggle">{{ collapsedGroups[group.group] ? '▸' : '▾' }}</span>
            <span class="group-name">{{ group.group }}</span>
            <span class="group-count">{{ group.cameras.filter(c => c.online).length }}/{{ group.cameras.length }}</span>
          </div>
          <template v-if="!collapsedGroups[group.group]">
            <div
              v-for="cam in group.cameras"
              :key="cam.id"
              class="camera-cell"
              :class="{ dragging: dragCameraId === cam.id }"
              draggable="true"
              @dragstart="onDragStart(cam.id)"
              @dragover="onDragOver"
              @drop="onDrop(cam.id)"
            >
              <CameraView
                :camera-id="cam.id"
                :name="cam.name"
                :online="cam.online"
                :last-frame-at="cam.lastFrameAt"
                :ptz="cam.ptz"
                :video-width="cam.width"
                :video-height="cam.height"
                :fps="cameraFpsMap[cam.id] ?? 0"
                :latency="frameLatency[cam.id] ?? 0"
                :recording="cam.recording"
                :recording-start="cam.recordingStart"
                :show-boxes="showBoxes"
                :track-labels="trackLabelsMap[cam.id]"
                :dual-stream="cam.dualStream"
                :detect-fps="cam.detectFps"
                :roi-regions="parsedRoiMap[cam.id]"
                @fullscreen="enterFullscreen"
                @jump-to-recording="onPlayRecording"
                @track-label-updated="loadTrackLabels"
              />
            </div>
          </template>
        </template>
        <!-- WS 断开覆盖 -->
        <div v-if="wsState === 'disconnected' && cameras.length > 0" class="ws-disconnected-overlay">
          <span>{{ t('header.wsDisconnected') }}</span>
        </div>
      </div>
      <div v-if="!isMobile" class="sidebar" :style="{ width: sidebarWidth + 'px' }">
        <div class="sidebar-resize-handle" @mousedown="onResizeStart" />
        <div class="sidebar-tabs">
          <button
            :class="['tab-btn', { active: activeTab === 'events' }]"
            @click="switchTab('events')"
          >☰ {{ t('tab.events') }}</button>
          <button
            :class="['tab-btn', { active: activeTab === 'recordings' }]"
            @click="switchTab('recordings')"
          >▶ {{ t('tab.recordings') }}</button>
          <button
            :class="['tab-btn', { active: activeTab === 'status' }]"
            @click="switchTab('status')"
          >◉ {{ t('tab.status') }}</button>
          <button
            :class="['tab-btn', { active: activeTab === 'cameras' }]"
            @click="switchTab('cameras')"
          >◎ {{ t('tab.cameras') }}</button>
          <button
            :class="['tab-btn', { active: activeTab === 'alerts' }]"
            @click="switchTab('alerts')"
          >⚠ {{ t('tab.alerts') }}</button>
          <button
            :class="['tab-btn', { active: activeTab === 'tracks' }]"
            @click="switchTab('tracks')"
          >❖ {{ t('tab.tracks', '目标') }}</button>
          <button
            :class="['tab-btn', { active: activeTab === 'settings' }]"
            @click="switchTab('settings')"
          >⚙ {{ t('tab.settings') }}</button>
        </div>
        <div class="sidebar-content">
          <EventPanel v-show="activeTab === 'events'" ref="eventPanel" :cameras="cameras" :track-labels="trackLabelsMap" @play-recording="onPlayRecording" />
          <RecordingsPanel
            v-show="activeTab === 'recordings'"
            ref="recordingsPanel"
            :cameras="cameras"
            :track-labels="trackLabelsMap"
          />
          <CameraStatusPanel
            v-if="activeTab === 'status'"
            :cameras="cameras"
          />
          <CameraManagePanel v-if="activeTab === 'cameras'" ref="cameraManagePanel" />
          <AlertPanel v-if="activeTab === 'alerts'" ref="alertPanel" :cameras="cameras" @jump-to-recording="onPlayRecording" />
          <TrackGallery v-if="activeTab === 'tracks'" @jump-to-recording="onPlayRecording" />
          <SettingsPanel v-if="activeTab === 'settings'" @saved="loadShowBoxes" />
        </div>
      </div>
    </main>
    <!-- 移动端底部面板 -->
    <div v-if="isMobile" class="mobile-panel" :class="{ open: mobilePanelOpen }" :style="mobilePanelOpen ? { height: mobilePanelHeight + 'px' } : {}">
      <div class="mobile-drag-handle" @touchstart="onMobileDragStart">
        <span class="drag-indicator"></span>
      </div>
      <div class="mobile-tabs">
        <button
          :class="['tab-btn', { active: activeTab === 'events' }]"
          @click="switchTab('events')"
        >☰ {{ t('tab.events') }}</button>
        <button
          :class="['tab-btn', { active: activeTab === 'recordings' }]"
          @click="switchTab('recordings')"
        >▶ {{ t('tab.recordings') }}</button>
        <button
          :class="['tab-btn', { active: activeTab === 'status' }]"
          @click="switchTab('status')"
        >◉ {{ t('tab.status') }}</button>
        <button
          :class="['tab-btn', { active: activeTab === 'cameras' }]"
          @click="switchTab('cameras')"
        >◎ {{ t('tab.cameras') }}</button>
        <button
          :class="['tab-btn', { active: activeTab === 'alerts' }]"
          @click="switchTab('alerts')"
        >⚠ {{ t('tab.alerts') }}</button>
        <button
          :class="['tab-btn', { active: activeTab === 'tracks' }]"
          @click="switchTab('tracks')"
        >◉ {{ t('tab.tracks', '目标') }}</button>
        <button
          :class="['tab-btn', { active: activeTab === 'settings' }]"
          @click="switchTab('settings')"
        >⚙ {{ t('tab.settings') }}</button>
      </div>
      <div class="mobile-content">
        <EventPanel v-show="activeTab === 'events'" ref="eventPanel" :cameras="cameras" :track-labels="trackLabelsMap" @play-recording="onPlayRecording" />
        <RecordingsPanel
          v-show="activeTab === 'recordings'"
          ref="recordingsPanel"
          :cameras="cameras"
          :track-labels="trackLabelsMap"
        />
        <CameraStatusPanel
          v-if="activeTab === 'status'"
          :cameras="cameras"
        />
        <CameraManagePanel v-if="activeTab === 'cameras'" ref="cameraManagePanel" />
        <AlertPanel v-if="activeTab === 'alerts'" ref="alertPanel" :cameras="cameras" @jump-to-recording="onPlayRecording" />
        <TrackGallery v-if="activeTab === 'tracks'" @jump-to-recording="onPlayRecording" />
        <SettingsPanel v-if="activeTab === 'settings'" />
      </div>
    </div>

    <!-- 快捷键帮助 -->
    <div v-if="showShortcuts" class="shortcuts-overlay" @click="showShortcuts = false">
      <div class="shortcuts-modal" @click.stop>
        <div class="shortcuts-header">
          <span>{{ t('shortcuts.title') }}</span>
          <button class="close-btn" @click="showShortcuts = false">&times;</button>
        </div>
        <div class="shortcuts-list">
          <div class="shortcut-row"><kbd>1</kbd> - <kbd>6</kbd><span>{{ t('shortcuts.switchTab') }}</span></div>
          <div class="shortcut-row"><kbd>F</kbd><span>{{ t('shortcuts.fullscreen') }}</span></div>
          <div class="shortcut-row"><kbd>Esc</kbd><span>{{ t('shortcuts.exit') }}</span></div>
          <div class="shortcut-row"><kbd>?</kbd><span>{{ t('shortcuts.help') }}</span></div>
          <div class="shortcut-row"><kbd>P</kbd><span>{{ t('shortcuts.patrol') }}</span></div>
          <div class="shortcut-row"><kbd>S</kbd><span>{{ t('shortcuts.screenshot') }}</span></div>
        </div>
      </div>
    </div>

    <!-- PWA 更新提示 -->
    <div v-if="showPwaPrompt" class="pwa-toast">
      <span v-if="offlineReady">{{ t('pwa.offlineReady') }}</span>
      <span v-else>{{ t('pwa.needRefresh') }}</span>
      <button v-if="needRefresh" class="pwa-btn" @click="updateServiceWorker(true)">{{ t('pwa.refresh') }}</button>
      <button class="pwa-btn pwa-btn-close" @click="closePwaPrompt">{{ t('pwa.close') }}</button>
    </div>
  </div>
  <ConfirmDialog />
  <!-- Toast 通知容器 -->
  <div class="toast-container">
    <TransitionGroup name="toast">
      <div v-for="t in toastToasts" :key="t.id" :class="['toast-item', `toast-${t.type}`]" @click="toastDismiss(t.id)">
        <span class="toast-icon">{{ t.type === 'error' ? '✕' : t.type === 'warning' ? '⚠' : t.type === 'success' ? '✓' : 'ℹ' }}</span>
        <span class="toast-msg">{{ t.message }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.app {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.disk-warn-bar {
  background: #FFEAA7;
  color: #1a1a2e;
  text-align: center;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 600;
}

.disk-warn-bar.critical {
  background: #e74c3c;
  color: #fff;
  animation: blink-warn 1s infinite;
}

@keyframes blink-warn {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

.app-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 20px;
  background: #16213e;
  border-bottom: 1px solid #2a2a4a;
}

.app-header h1 {
  font-size: 18px;
  font-weight: 700;
  color: #e0e0e0;
}

.status {
  font-size: 13px;
  color: #888;
}

.ws-indicator {
  font-size: 10px;
  line-height: 1;
}

.ws-indicator.connected {
  color: #4CAF50;
}

.ws-indicator.connecting {
  color: #FFD93D;
  animation: pulse-ws 1s infinite;
}

.ws-indicator.disconnected {
  color: #F44336;
}

@keyframes pulse-ws {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

.group-select {
  background: #0a0a1a;
  color: #e0e0e0;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 12px;
}

.app-body {
  flex: 1;
  display: flex;
  gap: 12px;
  padding: 12px;
  overflow: hidden;
}

.camera-grid {
  flex: 1;
  display: grid;
  gap: 12px;
  overflow-y: auto;
  position: relative;
}

.camera-grid.fullscreen {
  grid-template-columns: 1fr;
}

.camera-cell {
  border-radius: 8px;
  transition: opacity 0.2s;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 60px 20px;
  color: #666;
  grid-column: 1 / -1;
}

.empty-icon {
  font-size: 48px;
  opacity: 0.5;
}

.empty-state p {
  font-size: 16px;
  margin: 0;
}

.empty-state .header-btn {
  background: #4ECDC4;
  color: #1a1a2e;
  border: none;
  border-radius: 6px;
  padding: 8px 20px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.empty-state .header-btn:hover {
  opacity: 0.9;
}

.group-header {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: #16213e;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
  margin-top: 4px;
}

.group-header:hover {
  background: #1e2d4a;
}

.group-toggle {
  font-size: 10px;
  color: #4ECDC4;
  width: 12px;
}

.group-name {
  font-size: 13px;
  font-weight: 600;
  color: #e0e0e0;
}

.group-count {
  font-size: 11px;
  color: #888;
  margin-left: auto;
}

.ws-disconnected-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  padding: 8px;
  background: rgba(244, 67, 54, 0.15);
  border-bottom: 1px solid rgba(244, 67, 54, 0.3);
  text-align: center;
  color: #F44336;
  font-size: 12px;
  font-weight: 600;
  pointer-events: none;
  z-index: 10;
}

.camera-cell.dragging {
  opacity: 0.4;
}

.header-actions {
  margin-left: auto;
}

.header-btn {
  background: #2a2a4a;
  color: #e0e0e0;
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
}

.header-btn:hover {
  background: #3a3a5a;
}

.header-btn.active {
  background: #4ECDC4;
  color: #1a1a2e;
  font-weight: 600;
}

.lang-btn {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
  min-width: 32px;
}

.patrol-input {
  width: 48px;
  background: #0a0a1a;
  color: #4ECDC4;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 3px 6px;
  font-size: 12px;
  text-align: center;
}

.patrol-input:focus {
  outline: none;
  border-color: #4ECDC4;
}

.sidebar {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.sidebar-resize-handle {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 4px;
  cursor: col-resize;
  z-index: 1;
}

.sidebar-resize-handle:hover,
.sidebar-resize-handle:active {
  background: rgba(78, 205, 196, 0.3);
}

.sidebar-tabs {
  display: flex;
  background: #16213e;
  border-radius: 8px 8px 0 0;
  border: 1px solid #2a2a4a;
  border-bottom: none;
  overflow: hidden;
}

.tab-btn {
  flex: 1;
  padding: 8px 0;
  background: transparent;
  border: none;
  color: #888;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.tab-btn:hover {
  color: #bbb;
  background: #1a1a2e;
}

.tab-btn.active {
  color: #4ECDC4;
  background: #1a1a2e;
}

.sidebar-content {
  flex: 1;
  overflow: hidden;
}

/* 移动端布局 */
.app.mobile .app-body {
  flex-direction: column;
  padding: 8px;
}

.app.mobile .app-header {
  padding: 8px 12px;
}

.app.mobile .app-header h1 {
  font-size: 16px;
}

.mobile-panel {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #1a1a2e;
  border-top: 1px solid #2a2a4a;
  transform: translateY(100%);
  transition: transform 0.3s ease;
  z-index: 100;
  display: flex;
  flex-direction: column;
}

.mobile-panel.open {
  transform: translateY(0);
}

.mobile-drag-handle {
  display: flex;
  justify-content: center;
  padding: 6px 0 4px;
  cursor: grab;
  touch-action: none;
}

.drag-indicator {
  width: 36px;
  height: 4px;
  background: #3a3a5a;
  border-radius: 2px;
}

.mobile-tabs {
  display: flex;
  background: #16213e;
  border-bottom: 1px solid #2a2a4a;
}

.mobile-content {
  flex: 1;
  overflow-y: auto;
}

.shortcuts-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.shortcuts-modal {
  background: #1a1a2e;
  border: 1px solid #2a2a4a;
  border-radius: 8px;
  min-width: 320px;
  max-width: 420px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.shortcuts-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #2a2a4a;
  color: #e0e0e0;
  font-weight: 600;
  font-size: 14px;
}

.close-btn {
  background: none;
  border: none;
  color: #888;
  font-size: 18px;
  cursor: pointer;
  padding: 0 4px;
}

.close-btn:hover {
  color: #e0e0e0;
}

.shortcuts-list {
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.shortcut-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #ccc;
}

.shortcut-row span {
  margin-left: auto;
  color: #888;
  font-size: 12px;
}

kbd {
  display: inline-block;
  background: #16213e;
  border: 1px solid #3a3a5a;
  border-radius: 4px;
  padding: 2px 8px;
  font-family: inherit;
  font-size: 12px;
  color: #4ECDC4;
  min-width: 24px;
  text-align: center;
}

.pwa-toast {
  position: fixed;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  background: #1a1a2e;
  border: 1px solid #4ECDC4;
  border-radius: 8px;
  padding: 10px 16px;
  display: flex;
  align-items: center;
  gap: 10px;
  color: #e0e0e0;
  font-size: 13px;
  z-index: 10000;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.pwa-btn {
  background: #4ECDC4;
  color: #0a0a1a;
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  font-weight: 600;
}

.pwa-btn-close {
  background: transparent;
  color: #888;
  border: 1px solid #2a2a4a;
}

/* Toast 通知 */
.toast-container {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: none;
  max-width: 360px;
}

.toast-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 6px;
  font-size: 13px;
  color: #e0e0e0;
  cursor: pointer;
  pointer-events: auto;
  backdrop-filter: blur(8px);
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
}

.toast-icon { font-size: 14px; flex-shrink: 0; }
.toast-msg { flex: 1; line-height: 1.4; }

.toast-error { background: rgba(231, 76, 60, 0.9); }
.toast-warning { background: rgba(243, 156, 18, 0.9); color: #1a1a2e; }
.toast-success { background: rgba(46, 204, 113, 0.9); color: #1a1a2e; }
.toast-info { background: rgba(78, 205, 196, 0.9); color: #1a1a2e; }

.toast-enter-active { transition: all 0.25s ease-out; }
.toast-leave-active { transition: all 0.2s ease-in; }
.toast-enter-from { opacity: 0; transform: translateX(40px); }
.toast-leave-to { opacity: 0; transform: translateX(40px); }
.toast-move { transition: transform 0.25s ease; }

@media (max-width: 768px) {
  .toast-container {
    left: 12px;
    right: 12px;
    max-width: none;
  }
}
</style>
