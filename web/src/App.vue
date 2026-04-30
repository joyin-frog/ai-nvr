<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { EventClient, type Detection, type ConnectionState } from './services/events'
import { isAuthEnabled, getToken, authFetch, authWsUrl } from './services/auth'
import { registerShortcut, useKeyboardShortcuts } from './composables/useKeyboard'
import { useRegisterSW } from 'virtual:pwa-register/vue'
import CameraView from './components/CameraView.vue'
import EventPanel from './components/EventPanel.vue'
import RecordingsPanel from './components/RecordingsPanel.vue'
import CameraStatusPanel from './components/CameraStatusPanel.vue'
import CameraManagePanel from './components/CameraManagePanel.vue'
import AlertPanel from './components/AlertPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import LoginView from './components/LoginView.vue'

const { t, locale } = useI18n()

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
}

/** 侧边栏激活的标签 */
type SidebarTab = 'events' | 'recordings' | 'status' | 'cameras' | 'alerts' | 'settings'
const activeTab = ref<SidebarTab>('events')

/** 全屏摄像头 ID（null 为网格模式） */
const fullscreenCamera = ref<string | null>(null)

/** PWA 更新提示 */
const { offlineReady, needRefresh, updateServiceWorker } = useRegisterSW({
  immediate: true,
  onRegisteredSW(_swUrl: string, registration: ServiceWorkerRegistration | undefined) {
    if (registration) {
      setInterval(() => { registration.update() }, 60 * 60 * 1000)
    }
  },
})
const showPwaPrompt = computed(() => offlineReady.value || needRefresh.value)
function closePwaPrompt() {
  offlineReady.value = false
  needRefresh.value = false
}

/** 网格列数配置 */
const gridCols = ref(0) // 0 = auto

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

/** 检测屏幕宽度 */
function checkMobile() {
  isMobile.value = window.innerWidth < 768
}

const cameras = ref<CameraStatus[]>([])
const detectionsMap = ref<Record<string, Detection[]>>({})
const detectVersions = ref<Record<string, number>>({})
/** 每个摄像头的最新帧 data URL */
const frameImages = ref<Record<string, string>>({})
/** 每个摄像头最近检测事件的帧快照 */
const detectSnapshots = ref<Record<string, string>>({})
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

/** 创建带认证的 WebSocket 客户端 */
const client = new EventClient(authWsUrl(
  import.meta.env.DEV
    ? 'ws://localhost:3100/api/events'
    : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/events`
))

/** 动态标题：闪烁后自动恢复 */
let titleTimer: ReturnType<typeof setTimeout> | null = null
function flashTitle(message: string, duration = 5000) {
  document.title = `⚠ ${message}`
  if (titleTimer) clearTimeout(titleTimer)
  titleTimer = setTimeout(() => {
    const online = cameras.value.filter(c => c.online).length
    document.title = `JK NVR - ${cameras.value.length} 路 (${online} 在线)`
    titleTimer = null
  }, duration)
}

/** 更新常态标题 */
function updateTitle() {
  if (titleTimer) return
  const online = cameras.value.filter(c => c.online).length
  document.title = `JK NVR - ${cameras.value.length} 路 (${online} 在线)`
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
    }))
    updateTitle()
  } catch {
    // retry later
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
}

/** 退出全屏回到网格 */
function exitFullscreen() {
  fullscreenCamera.value = null
  stopPatrol()
}

/** 轮巡模式 */
const patrolActive = ref(false)
/** 轮巡间隔（秒） */
const patrolInterval = ref(5)
/** 轮巡定时器 */
let patrolTimer: ReturnType<typeof setInterval> | null = null
/** 当前轮巡索引 */
let patrolIndex = 0

/** 开始轮巡 */
function startPatrol() {
  if (cameras.value.length === 0) return
  patrolActive.value = true
  patrolIndex = 0
  /** 立即显示第一路 */
  fullscreenCamera.value = cameras.value[0]!.id
  patrolTimer = setInterval(() => {
    patrolIndex = (patrolIndex + 1) % cameras.value.length
    fullscreenCamera.value = cameras.value[patrolIndex]!.id
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

/** 显示的摄像头列表 */
const visibleCameras = computed(() => {
  if (fullscreenCamera.value) {
    return cameras.value.filter(c => c.id === fullscreenCamera.value)
  }
  if (filterGroup.value) {
    return cameras.value.filter(c => c.group === filterGroup.value)
  }
  return cameras.value
})

/** 登录成功回调 */
function onLoginSuccess() {
  authenticated.value = true
  startApp()
}

/** 启动应用主逻辑 */
function startApp() {
  loadCameras()
  setupEventListeners()
  client.connect()
  client.onStateChange((state) => {
    wsState.value = state
  })
}

/** 浏览器通知 */
function notify(title: string, body: string) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body })
  }
}

/** 重要检测目标 */
const IMPORTANT_LABELS = new Set(['person', 'car', 'truck', 'bus', 'motorcycle', 'bicycle'])

/** 注册事件监听器 */
function setupEventListeners() {
  /** 请求通知权限 */
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission()
  }

  client.on('motion', (payload) => {
    eventPanel.value?.addEvent('motion', payload.cameraId, `变动 ${(payload.ratio * 100).toFixed(1)}%`)
  })

  client.on('frame', (payload) => {
    const old = frameImages.value[payload.cameraId]
    if (old) URL.revokeObjectURL(old)
    frameImages.value[payload.cameraId] = payload.image
    frameImages.value = { ...frameImages.value }
  })

  client.on('detect', (payload) => {
    detectionsMap.value[payload.cameraId] = payload.detections
    detectionsMap.value = { ...detectionsMap.value }
    detectVersions.value[payload.cameraId] = (detectVersions.value[payload.cameraId] ?? 0) + 1
    detectVersions.value = { ...detectVersions.value }
    const frame = frameImages.value[payload.cameraId]
    if (frame) {
      const oldSnap = detectSnapshots.value[payload.cameraId]
      if (oldSnap) URL.revokeObjectURL(oldSnap)
      fetch(frame)
        .then(r => r.blob())
        .then(blob => {
          detectSnapshots.value[payload.cameraId] = URL.createObjectURL(blob)
          detectSnapshots.value = { ...detectSnapshots.value }
        })
        .catch(() => { /* ignore */ })
    }
    const labels = payload.detections.map((d) => d.label).join(', ')
    eventPanel.value?.addEvent('detect', payload.cameraId, labels)

    const important = payload.detections.filter(d => IMPORTANT_LABELS.has(d.label))
    if (important.length > 0) {
      const cam = cameras.value.find(c => c.id === payload.cameraId)
      const name = cam?.name ?? payload.cameraId
      notify(`${name} - 检测到目标`, important.map(d => `${d.label} (${(d.score * 100).toFixed(0)}%)`).join(', '))
      const detLabels = important.map(d => d.label).join(', ')
      flashTitle(`检测: ${detLabels} - ${name}`)
    }
  })

  client.on('camera:online', (payload) => {
    const cam = cameras.value.find(c => c.id === payload.cameraId)
    if (cam) cam.online = true
    eventPanel.value?.addEvent('camera:online', payload.cameraId, '上线')
    updateTitle()
  })

  client.on('camera:offline', (payload) => {
    const cam = cameras.value.find(c => c.id === payload.cameraId)
    if (cam) cam.online = false
    eventPanel.value?.addEvent('camera:offline', payload.cameraId, '离线')
    notify(`${cam?.name ?? payload.cameraId} 离线`, '摄像头连接已断开')
    flashTitle(`${cam?.name ?? payload.cameraId} 离线`, 10000)
  })

  client.on('alert', (payload) => {
    eventPanel.value?.addEvent('alert', payload.cameraId, `告警: ${payload.ruleName}`)
    alertPanel.value?.loadAlerts()
    notify(`告警: ${payload.ruleName}`, payload.cameraId)
    flashTitle(`告警: ${payload.ruleName} - ${payload.cameraId}`, 10000)
  })
}

onMounted(async () => {
  checkMobile()
  window.addEventListener('resize', checkMobile)

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
  registerShortcut({ key: '1', description: '事件面板', handler: () => switchTab('events') })
  registerShortcut({ key: '2', description: '录像面板', handler: () => switchTab('recordings') })
  registerShortcut({ key: '3', description: '状态面板', handler: () => switchTab('status') })
  registerShortcut({ key: '4', description: '管理面板', handler: () => switchTab('cameras') })
  registerShortcut({ key: '5', description: '告警面板', handler: () => switchTab('alerts') })
  registerShortcut({ key: '6', description: '设置面板', handler: () => switchTab('settings') })
  registerShortcut({ key: 'f', description: '全屏切换', handler: () => {
    if (fullscreenCamera.value) exitFullscreen()
    else if (cameras.value.length > 0) enterFullscreen(cameras.value[0]!.id)
  }})
  registerShortcut({ key: 'Escape', description: '退出全屏', handler: () => {
    if (fullscreenCamera.value) exitFullscreen()
  }})
  registerShortcut({ key: '?', description: '快捷键帮助', handler: () => { showShortcuts.value = !showShortcuts.value }})
  registerShortcut({ key: 'p', description: '轮巡切换', handler: () => { togglePatrol() }})
})

onUnmounted(() => {
  client.disconnect()
  window.removeEventListener('resize', checkMobile)
  stopPatrol()
  /** 释放所有检测快照 blob URL */
  for (const url of Object.values(detectSnapshots.value)) {
    URL.revokeObjectURL(url)
  }
})
</script>

<template>
  <!-- 登录页 -->
  <LoginView v-if="authRequired && !authenticated" @success="onLoginSuccess" />
  <!-- 主界面 -->
  <div v-else class="app" :class="{ mobile: isMobile }">
    <header class="app-header">
      <h1>JK NVR</h1>
      <span class="status">{{ cameras.length }} 路摄像头</span>
      <span :class="['ws-indicator', wsState]" :title="wsState === 'connected' ? '已连接' : wsState === 'connecting' ? '连接中...' : '已断开'">
        {{ wsState === 'connected' ? '●' : wsState === 'connecting' ? '◐' : '○' }}
      </span>
      <select v-if="groups.length > 0" v-model="filterGroup" class="group-select">
        <option value="">{{ t('header.groupAll') }}</option>
        <option v-for="g in groups" :key="g" :value="g">{{ g }}</option>
      </select>
      <div class="header-actions">
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
        >返回网格</button>
        <button
          v-if="isMobile"
          class="header-btn"
          @click="mobilePanelOpen = !mobilePanelOpen"
        >{{ mobilePanelOpen ? '关闭' : '面板' }}</button>
        <button class="header-btn lang-btn" @click="toggleLocale" :title="locale === 'zh-CN' ? 'English' : '中文'">
          {{ locale === 'zh-CN' ? 'EN' : '中' }}
        </button>
      </div>
    </header>
    <main class="app-body">
      <div class="camera-grid" :style="gridStyle" :class="{ fullscreen: !!fullscreenCamera }">
        <CameraView
          v-for="cam in visibleCameras"
          :key="cam.id"
          :camera-id="cam.id"
          :name="cam.name"
          :online="cam.online"
          :detections="detectionsMap[cam.id] ?? []"
          :detect-version="detectVersions[cam.id] ?? 0"
          :frame-image="frameImages[cam.id] ?? ''"
          @fullscreen="enterFullscreen"
        />
      </div>
      <!-- 桌面端侧边栏 -->
      <div v-if="!isMobile" class="sidebar">
        <div class="sidebar-tabs">
          <button
            :class="['tab-btn', { active: activeTab === 'events' }]"
            @click="switchTab('events')"
          >{{ t('tab.events') }}</button>
          <button
            :class="['tab-btn', { active: activeTab === 'recordings' }]"
            @click="switchTab('recordings')"
          >{{ t('tab.recordings') }}</button>
          <button
            :class="['tab-btn', { active: activeTab === 'status' }]"
            @click="switchTab('status')"
          >{{ t('tab.status') }}</button>
          <button
            :class="['tab-btn', { active: activeTab === 'cameras' }]"
            @click="switchTab('cameras')"
          >{{ t('tab.cameras') }}</button>
          <button
            :class="['tab-btn', { active: activeTab === 'alerts' }]"
            @click="switchTab('alerts')"
          >{{ t('tab.alerts') }}</button>
          <button
            :class="['tab-btn', { active: activeTab === 'settings' }]"
            @click="switchTab('settings')"
          >{{ t('tab.settings') }}</button>
        </div>
        <div class="sidebar-content">
          <EventPanel v-show="activeTab === 'events'" ref="eventPanel" :snapshots="detectSnapshots" @play-recording="onPlayRecording" />
          <RecordingsPanel
            v-show="activeTab === 'recordings'"
            ref="recordingsPanel"
            :cameras="cameras"
          />
          <CameraStatusPanel
            v-if="activeTab === 'status'"
            :cameras="cameras"
          />
          <CameraManagePanel v-if="activeTab === 'cameras'" ref="cameraManagePanel" />
          <AlertPanel v-if="activeTab === 'alerts'" ref="alertPanel" />
          <SettingsPanel v-if="activeTab === 'settings'" />
        </div>
      </div>
    </main>
    <!-- 移动端底部面板 -->
    <div v-if="isMobile" class="mobile-panel" :class="{ open: mobilePanelOpen }">
      <div class="mobile-tabs">
        <button
          :class="['tab-btn', { active: activeTab === 'events' }]"
          @click="switchTab('events')"
        >{{ t('tab.events') }}</button>
        <button
          :class="['tab-btn', { active: activeTab === 'recordings' }]"
          @click="switchTab('recordings')"
        >{{ t('tab.recordings') }}</button>
        <button
          :class="['tab-btn', { active: activeTab === 'status' }]"
          @click="switchTab('status')"
        >{{ t('tab.status') }}</button>
        <button
          :class="['tab-btn', { active: activeTab === 'cameras' }]"
          @click="switchTab('cameras')"
        >{{ t('tab.cameras') }}</button>
        <button
          :class="['tab-btn', { active: activeTab === 'settings' }]"
          @click="switchTab('settings')"
        >{{ t('tab.settings') }}</button>
      </div>
      <div class="mobile-content">
        <EventPanel v-show="activeTab === 'events'" ref="eventPanel" @play-recording="onPlayRecording" />
        <RecordingsPanel
          v-show="activeTab === 'recordings'"
          ref="recordingsPanel"
          :cameras="cameras"
        />
        <CameraStatusPanel
          v-if="activeTab === 'status'"
          :cameras="cameras"
        />
        <CameraManagePanel v-if="activeTab === 'cameras'" ref="cameraManagePanel" />
        <AlertPanel v-if="activeTab === 'alerts'" ref="alertPanel" />
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
</template>

<style scoped>
.app {
  height: 100vh;
  display: flex;
  flex-direction: column;
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
}

.camera-grid.fullscreen {
  grid-template-columns: 1fr;
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
  width: 340px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
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
  max-height: 60vh;
  display: flex;
  flex-direction: column;
}

.mobile-panel.open {
  transform: translateY(0);
}

.mobile-tabs {
  display: flex;
  background: #16213e;
  border-bottom: 1px solid #2a2a4a;
}

.mobile-content {
  flex: 1;
  overflow-y: auto;
  max-height: 55vh;
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
</style>
