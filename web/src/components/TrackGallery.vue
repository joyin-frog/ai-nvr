<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { authFetch, authUrl } from '../services/auth'

const { t } = useI18n()

/** 追踪目标信息 */
interface TrackInfo {
  trackId: number
  label: string
  customName?: string
  firstSeen: number
  lastSeen: number
  hitCount: number
  cameraIds: string[]
  snapshotFile?: string
}

const tracks = ref<TrackInfo[]>([])
const loading = ref(false)
/** 正在编辑名称的 trackId */
const editingId = ref<number | null>(null)
const editName = ref('')
let refreshTimer: ReturnType<typeof setInterval> | null = null

const emit = defineEmits<{
  jumpToRecording: [cameraId: string, timestamp: number]
}>()

/** 加载追踪目标列表 */
async function loadTracks() {
  loading.value = true
  const res = await authFetch('/api/tracks')
  if (res.ok) {
    tracks.value = await res.json()
  }
  loading.value = false
}

/** 快照图片 URL */
function snapshotUrl(filename: string | undefined): string {
  if (!filename) return ''
  return authUrl(`/api/tracks/snapshot/${filename}`)
}

/** 开始编辑名称 */
function startEdit(track: TrackInfo) {
  editingId.value = track.trackId
  editName.value = track.customName ?? ''
}

/** 保存名称 */
async function saveName(trackId: number) {
  const name = editName.value.trim()
  await authFetch(`/api/tracks/${trackId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customName: name }),
  })
  editingId.value = null
  await loadTracks()
}

/** 取消编辑 */
function cancelEdit() {
  editingId.value = null
}

/** 格式化时间 */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

/** 格式化相对时间 */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return `${Math.floor(diff / 1000)}秒前`
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
  return `${Math.floor(diff / 86400000)}天前`
}

onMounted(() => {
  loadTracks()
  /** 每 30 秒刷新 */
  refreshTimer = setInterval(loadTracks, 30000)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>

<template>
  <div class="track-gallery">
    <div class="gallery-header">
      <h3>{{ t('tracks.title', '追踪目标') }}</h3>
      <button class="refresh-btn" @click="loadTracks" :disabled="loading">
        {{ loading ? '...' : '↻' }}
      </button>
    </div>

    <div v-if="tracks.length === 0" class="empty">
      {{ t('tracks.empty', '暂无追踪目标') }}
    </div>

    <div v-else class="track-grid">
      <div v-for="track in tracks" :key="track.trackId" class="track-card">
        <!-- 快照 -->
        <div class="track-snapshot">
          <img
            v-if="track.snapshotFile"
            :src="snapshotUrl(track.snapshotFile)"
            :alt="`Track #${track.trackId}`"
          />
          <div v-else class="no-snapshot">
            <span>{{ track.label.charAt(0).toUpperCase() }}</span>
          </div>
        </div>

        <!-- 信息 -->
        <div class="track-info">
          <div class="track-name-row">
            <template v-if="editingId === track.trackId">
              <input
                v-model="editName"
                class="name-input"
                :placeholder="track.label"
                @keydown.enter="saveName(track.trackId)"
                @keydown.escape="cancelEdit"
                autofocus
              />
              <button class="save-btn" @click="saveName(track.trackId)">✓</button>
              <button class="cancel-btn" @click="cancelEdit">✗</button>
            </template>
            <template v-else>
              <span class="track-label" @dblclick="startEdit(track)">
                {{ track.customName || track.label }}
              </span>
              <span v-if="track.customName" class="track-original-label">{{ track.label }}</span>
            </template>
          </div>
          <div class="track-meta">
            <span class="track-id">#{{ track.trackId }}</span>
            <span class="track-count">{{ track.hitCount }}次</span>
            <span class="track-time" :title="formatTime(track.lastSeen)">{{ relativeTime(track.lastSeen) }}</span>
          </div>
          <div class="track-cameras">
            {{ track.cameraIds.join(', ') }}
          </div>
          <button class="play-btn" @click="emit('jumpToRecording', track.cameraIds[0], track.lastSeen)">
            ▶ {{ t('tracks.playRecording', '查看录像') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.track-gallery {
  padding: 12px;
}

.gallery-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.gallery-header h3 {
  color: #e0e0e0;
  font-size: 14px;
  margin: 0;
}

.refresh-btn {
  background: #2a2a4a;
  color: #e0e0e0;
  border: none;
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 12px;
}

.refresh-btn:hover { background: #3a3a5a; }
.refresh-btn:disabled { opacity: 0.5; }

.empty {
  color: #555;
  text-align: center;
  padding: 24px;
  font-size: 13px;
}

.track-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
}

.track-card {
  background: #1a1a3a;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid #2a2a4a;
  transition: border-color 0.2s;
}

.track-card:hover {
  border-color: #4ECDC4;
}

.track-snapshot {
  width: 100%;
  height: 120px;
  overflow: hidden;
  background: #0a0a1a;
}

.track-snapshot img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.no-snapshot {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #4ECDC4;
  font-size: 32px;
  font-weight: bold;
}

.track-info {
  padding: 8px;
}

.track-name-row {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
}

.track-label {
  color: #e0e0e0;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.track-label:hover {
  color: #4ECDC4;
}

.track-original-label {
  color: #666;
  font-size: 10px;
}

.name-input {
  background: #0a0a1a;
  border: 1px solid #4ECDC4;
  color: #e0e0e0;
  border-radius: 3px;
  padding: 1px 4px;
  font-size: 11px;
  width: 80px;
  outline: none;
}

.save-btn, .cancel-btn {
  background: none;
  border: none;
  color: #4ECDC4;
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
}

.cancel-btn { color: #e74c3c; }

.track-meta {
  display: flex;
  gap: 6px;
  font-size: 10px;
  color: #888;
}

.track-id { color: #4ECDC4; }
.track-count { color: #aaa; }
.track-time { color: #666; }

.track-cameras {
  font-size: 10px;
  color: #555;
  margin-top: 2px;
}

.play-btn {
  display: block;
  width: 100%;
  margin-top: 6px;
  background: #2a2a4a;
  color: #4ECDC4;
  border: 1px solid #4ECDC4;
  border-radius: 3px;
  padding: 3px 0;
  font-size: 11px;
  cursor: pointer;
  text-align: center;
}

.play-btn:hover {
  background: #4ECDC420;
}
</style>
