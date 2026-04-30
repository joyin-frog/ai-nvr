<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { EventClient, type Detection } from './services/events'
import CameraView from './components/CameraView.vue'
import EventPanel from './components/EventPanel.vue'

/** 摄像头状态 */
interface CameraStatus {
  id: string
  name: string
  online: boolean
  lastFrameAt: number
}

const cameras = ref<CameraStatus[]>([])
const detectionsMap = ref<Record<string, Detection[]>>({})
const detectVersions = ref<Record<string, number>>({})
const eventPanel = ref<InstanceType<typeof EventPanel> | null>(null)

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

onMounted(() => {
  loadCameras()

  /** 监听变动事件 */
  client.on('motion', (payload) => {
    eventPanel.value?.addEvent('motion', payload.cameraId, `变动 ${(payload.ratio * 100).toFixed(1)}%`)
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
        />
      </div>
      <div class="event-sidebar">
        <EventPanel ref="eventPanel" />
      </div>
    </main>
  </div>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  background: #0a0a1a;
  color: #e0e0e0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
</style>

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

.event-sidebar {
  width: 320px;
  flex-shrink: 0;
}
</style>
