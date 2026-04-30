<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { EventClient, type Detection } from './services/events'
import CameraView from './components/CameraView.vue'
import EventPanel from './components/EventPanel.vue'
import RecordingsPanel from './components/RecordingsPanel.vue'
import CameraStatusPanel from './components/CameraStatusPanel.vue'

/** 摄像头状态 */
interface CameraStatus {
  id: string
  name: string
  online: boolean
  lastFrameAt: number
}

/** 侧边栏激活的标签 */
type SidebarTab = 'events' | 'recordings' | 'status'
const activeTab = ref<SidebarTab>('events')

/** 全屏摄像头 ID（null 为网格模式） */
const fullscreenCamera = ref<string | null>(null)

/** 网格列数配置 */
const gridCols = ref(0) // 0 = auto

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
const eventPanel = ref<InstanceType<typeof EventPanel> | null>(null)
const recordingsPanel = ref<InstanceType<typeof RecordingsPanel> | null>(null)

const client = new EventClient()

/** 加载摄像头列表 */
async function loadCameras() {
  try {
    const res = await fetch('/api/cameras')
    const data = await res.json()
    cameras.value = data.map((c: CameraStatus) => ({
      id: c.id,
      name: c.name,
      online: c.online,
      lastFrameAt: c.lastFrameAt,
    }))
  } catch {
    // retry later
  }
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
}

/** 进入全屏单路 */
function enterFullscreen(cameraId: string) {
  fullscreenCamera.value = cameraId
}

/** 退出全屏回到网格 */
function exitFullscreen() {
  fullscreenCamera.value = null
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
  return cameras.value
})

onMounted(() => {
  checkMobile()
  window.addEventListener('resize', checkMobile)
  loadCameras()

  /** 监听变动事件 */
  client.on('motion', (payload) => {
    eventPanel.value?.addEvent('motion', payload.cameraId, `变动 ${(payload.ratio * 100).toFixed(1)}%`)
  })

  /** 监听帧事件：实时推送帧图片 */
  client.on('frame', (payload) => {
    frameImages.value[payload.cameraId] = payload.image
    frameImages.value = { ...frameImages.value }
  })

  /** 监听检测事件 */
  client.on('detect', (payload) => {
    detectionsMap.value[payload.cameraId] = payload.detections
    detectionsMap.value = { ...detectionsMap.value }
    detectVersions.value[payload.cameraId] = (detectVersions.value[payload.cameraId] ?? 0) + 1
    detectVersions.value = { ...detectVersions.value }
    const labels = payload.detections.map((d) => d.label).join(', ')
    eventPanel.value?.addEvent('detect', payload.cameraId, labels)
  })

  /** 监听摄像头上线 */
  client.on('camera:online', (payload) => {
    const cam = cameras.value.find(c => c.id === payload.cameraId)
    if (cam) cam.online = true
    eventPanel.value?.addEvent('camera:online', payload.cameraId, '上线')
  })

  /** 监听摄像头离线 */
  client.on('camera:offline', (payload) => {
    const cam = cameras.value.find(c => c.id === payload.cameraId)
    if (cam) cam.online = false
    eventPanel.value?.addEvent('camera:offline', payload.cameraId, '离线')
  })

  client.connect()
})

onUnmounted(() => {
  client.disconnect()
  window.removeEventListener('resize', checkMobile)
})
</script>

<template>
  <div class="app" :class="{ mobile: isMobile }">
    <header class="app-header">
      <h1>JK NVR</h1>
      <span class="status">{{ cameras.length }} 路摄像头</span>
      <div class="header-actions">
        <button
          v-if="fullscreenCamera"
          class="header-btn"
          @click="exitFullscreen"
        >返回网格</button>
        <button
          v-if="isMobile"
          class="header-btn"
          @click="mobilePanelOpen = !mobilePanelOpen"
        >{{ mobilePanelOpen ? '关闭' : '面板' }}</button>
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
          >事件</button>
          <button
            :class="['tab-btn', { active: activeTab === 'recordings' }]"
            @click="switchTab('recordings')"
          >录像</button>
          <button
            :class="['tab-btn', { active: activeTab === 'status' }]"
            @click="switchTab('status')"
          >状态</button>
        </div>
        <div class="sidebar-content">
          <EventPanel v-show="activeTab === 'events'" ref="eventPanel" />
          <RecordingsPanel
            v-show="activeTab === 'recordings'"
            ref="recordingsPanel"
            :cameras="cameras"
          />
          <CameraStatusPanel
            v-if="activeTab === 'status'"
            :cameras="cameras"
          />
        </div>
      </div>
    </main>
    <!-- 移动端底部面板 -->
    <div v-if="isMobile" class="mobile-panel" :class="{ open: mobilePanelOpen }">
      <div class="mobile-tabs">
        <button
          :class="['tab-btn', { active: activeTab === 'events' }]"
          @click="switchTab('events')"
        >事件</button>
        <button
          :class="['tab-btn', { active: activeTab === 'recordings' }]"
          @click="switchTab('recordings')"
        >录像</button>
        <button
          :class="['tab-btn', { active: activeTab === 'status' }]"
          @click="switchTab('status')"
        >状态</button>
      </div>
      <div class="mobile-content">
        <EventPanel v-show="activeTab === 'events'" ref="eventPanel" />
        <RecordingsPanel
          v-show="activeTab === 'recordings'"
          ref="recordingsPanel"
          :cameras="cameras"
        />
        <CameraStatusPanel
          v-if="activeTab === 'status'"
          :cameras="cameras"
        />
      </div>
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
  font-size: 13px;
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
</style>
