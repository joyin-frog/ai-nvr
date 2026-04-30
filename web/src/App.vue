<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { EventClient, type Detection } from './services/events'
import CameraView from './components/CameraView.vue'
import EventPanel from './components/EventPanel.vue'
import RecordingsPanel from './components/RecordingsPanel.vue'

/** 摄像头状态 */
interface CameraStatus {
  id: string
  name: string
  online: boolean
  lastFrameAt: number
}

/** 侧边栏激活的标签 */
type SidebarTab = 'events' | 'recordings'
const activeTab = ref<SidebarTab>('events')

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
}

onMounted(() => {
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
})
</script>

<template>
  <div class="app">
    <header class="app-header">
      <h1>JK NVR</h1>
      <span class="status">{{ cameras.length }} 路摄像头</span>
    </header>
    <main class="app-body">
      <div class="camera-grid">
        <CameraView
          v-for="cam in cameras"
          :key="cam.id"
          :camera-id="cam.id"
          :name="cam.name"
          :online="cam.online"
          :detections="detectionsMap[cam.id] ?? []"
          :detect-version="detectVersions[cam.id] ?? 0"
          :frame-image="frameImages[cam.id] ?? ''"
        />
      </div>
      <div class="sidebar">
        <div class="sidebar-tabs">
          <button
            :class="['tab-btn', { active: activeTab === 'events' }]"
            @click="switchTab('events')"
          >事件日志</button>
          <button
            :class="['tab-btn', { active: activeTab === 'recordings' }]"
            @click="switchTab('recordings')"
          >录像回放</button>
        </div>
        <div class="sidebar-content">
          <EventPanel v-show="activeTab === 'events'" ref="eventPanel" />
          <RecordingsPanel
            v-show="activeTab === 'recordings'"
            ref="recordingsPanel"
            :cameras="cameras"
          />
        </div>
      </div>
    </main>
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
  grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
  gap: 12px;
  overflow-y: auto;
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
</style>
