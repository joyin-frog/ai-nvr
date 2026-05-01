<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
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
  /** 主色调名称 */
  dominantColor?: string
  /** 当前是否活跃（前端计算） */
  _active?: boolean
}

/** 主色调名称 → 显示颜色 */
const COLOR_MAP: Record<string, string> = {
  red: '#e74c3c', orange: '#e67e22', yellow: '#f1c40f', lime: '#2ecc71',
  green: '#27ae60', cyan: '#1abc9c', blue: '#3498db', purple: '#9b59b6',
  pink: '#e91e63', gray: '#95a5a6',
}

const tracks = ref<TrackInfo[]>([])
const loading = ref(false)
/** dHash 匹配建议：trackId → { name, distance } */
const suggestions = ref<Map<number, { name: string; distance: number }>>(new Map())
/** 强制视图更新的 tick（用于活跃状态刷新） */
const viewTick = ref(0)
/** 正在编辑名称的 trackId */
const editingId = ref<number | null>(null)
const editName = ref('')
/** 标签筛选 */
const filterLabel = ref('')
/** 摄像头筛选 */
const filterCamera = ref('')
/** 仅显示未命名 */
const filterUnnamed = ref(false)
/** 主色调筛选 */
const filterColor = ref('')
/** 名称/标签搜索 */
const searchText = ref('')
/** 展开事件历史的 trackId */
const expandedTrackId = ref<number | null>(null)
/** trackId → 事件历史列表 */
const trackEvents = ref<Record<number, Array<{ id: number; camera_id: string; timestamp: number; detail: string }>>>({})
/** 事件历史加载中 */
const loadingEvents = ref(false)
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
  /** 加载 dHash 匹配建议 */
  const sugRes = await authFetch('/api/tracks/suggestions')
  if (sugRes.ok) {
    const data = await sugRes.json() as Array<{ trackId: number; suggestedName: string; distance: number }>
    const map = new Map<number, { name: string; distance: number }>()
    for (const s of data) {
      map.set(s.trackId, { name: s.suggestedName, distance: s.distance })
    }
    suggestions.value = map
  }
  loading.value = false
}

/** 快照图片 URL */
function snapshotUrl(filename: string | undefined): string {
  if (!filename) return ''
  return authUrl(`/api/tracks/snapshot/${filename}`)
}

/** 所有已命名的目标名称（去重，用于快速关联下拉） */
const existingNames = computed(() => {
  const names = new Set<string>()
  for (const t of tracks.value) {
    if (t.customName) names.add(t.customName)
  }
  return [...names].sort()
})

/** 快速应用已有名称 */
function applyExistingName(name: string) {
  editName.value = name
}

/** 开始编辑名称 */
function startEdit(track: TrackInfo) {
  editingId.value = track.trackId
  editName.value = track.customName ?? ''
}

/** 合并确认状态 */
const mergeConfirm = ref<{ sourceId: number; targetId: number; name: string } | null>(null)

/** 查找使用指定名称的其他目标 */
function findTrackByName(name: string, excludeId: number): TrackInfo | undefined {
  return tracks.value.find(t => t.customName === name && t.trackId !== excludeId)
}

/** 一键应用 dHash 匹配建议 */
async function applySuggestion(trackId: number) {
  const sug = suggestions.value.get(trackId)
  if (!sug) return
  await doSaveName(trackId, sug.name)
}

/** 保存名称 */
async function saveName(trackId: number) {
  const name = editName.value.trim()
  /** 检查是否有同名目标 → 触发合并确认 */
  const existing = findTrackByName(name, trackId)
  if (existing) {
    mergeConfirm.value = { sourceId: trackId, targetId: existing.trackId, name }
    return
  }
  await doSaveName(trackId, name)
}

/** 仅命名（不合并） */
async function doSaveName(trackId: number, name: string) {
  await authFetch(`/api/tracks/${trackId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customName: name }),
  })
  editingId.value = null
  mergeConfirm.value = null
  await loadTracks()
}

/** 确认合并 */
async function confirmMerge() {
  if (!mergeConfirm.value) return
  const { sourceId, targetId, name } = mergeConfirm.value
  /** 先合并，再给目标设置名称 */
  await authFetch('/api/tracks/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId, targetId }),
  })
  /** 确保目标名称正确 */
  await authFetch(`/api/tracks/${targetId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customName: name }),
  })
  editingId.value = null
  mergeConfirm.value = null
  await loadTracks()
}

/** 取消合并，改为仅命名 */
function cancelMerge() {
  if (!mergeConfirm.value) return
  doSaveName(mergeConfirm.value.sourceId, mergeConfirm.value.name)
}

/** 取消编辑 */
function cancelEdit() {
  editingId.value = null
}

/** 删除追踪目标 */
const confirmDelete = ref<number | null>(null)
async function deleteTrack(trackId: number) {
  await authFetch(`/api/tracks/${trackId}`, { method: 'DELETE' })
  confirmDelete.value = null
  await loadTracks()
}

/** 加载追踪目标的检测事件历史 */
async function loadTrackEvents(trackId: number) {
  if (expandedTrackId.value === trackId) {
    expandedTrackId.value = null
    return
  }
  expandedTrackId.value = trackId
  if (trackEvents.value[trackId]) return
  loadingEvents.value = true
  const res = await authFetch(`/api/tracks/${trackId}/events?limit=20`)
  if (res.ok) {
    trackEvents.value = { ...trackEvents.value, [trackId]: await res.json() }
  }
  loadingEvents.value = false
}

/** 格式化时间 */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

/** 格式化相对时间 */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return t('tracks.secondsAgo', { n: Math.floor(diff / 1000) })
  if (diff < 3600000) return t('tracks.minutesAgo', { n: Math.floor(diff / 60000) })
  if (diff < 86400000) return t('tracks.hoursAgo', { n: Math.floor(diff / 3600000) })
  return t('tracks.daysAgo', { n: Math.floor(diff / 86400000) })
}

/** 判断目标是否活跃（最近 30 秒内被检测到） */
function isTrackActive(track: TrackInfo): boolean {
  void viewTick.value
  return Date.now() - track.lastSeen < 30000
}

/** 所有出现过的标签 */
const allLabels = computed(() => {
  const set = new Set<string>()
  for (const t of tracks.value) set.add(t.label)
  return [...set].sort()
})

/** 所有出现过的摄像头 */
const allCameras = computed(() => {
  const set = new Set<string>()
  for (const t of tracks.value) for (const c of t.cameraIds) set.add(c)
  return [...set].sort()
})

/** 所有出现过的主色调 */
const allColors = computed(() => {
  const set = new Set<string>()
  for (const t of tracks.value) if (t.dominantColor) set.add(t.dominantColor)
  return [...set].sort()
})

/** 按标签 + 摄像头 + 搜索 + 未命名筛选后的列表 */
const filteredTracks = computed(() => {
  let list = tracks.value
  if (filterLabel.value) list = list.filter(t => t.label === filterLabel.value)
  if (filterCamera.value) list = list.filter(t => t.cameraIds.includes(filterCamera.value))
  if (filterColor.value) list = list.filter(t => t.dominantColor === filterColor.value)
  if (filterUnnamed.value) list = list.filter(t => !t.customName)
  if (searchText.value) {
    const q = searchText.value.toLowerCase()
    list = list.filter(t =>
      (t.customName && t.customName.toLowerCase().includes(q))
      || t.label.toLowerCase().includes(q)
      || String(t.trackId).includes(q)
    )
  }
  return list
})

/** 未命名的目标数量 */
const unnamedCount = computed(() => tracks.value.filter(t => !t.customName).length)

/** 判断是否为新目标（最近 5 分钟内首次出现且未命名） */
function isNewTrack(track: TrackInfo): boolean {
  if (track.customName) return false
  return Date.now() - track.firstSeen < 300000
}

let activeTickTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  loadTracks()
  /** 每 30 秒刷新数据 */
  refreshTimer = setInterval(loadTracks, 30000)
  /** 每 10 秒更新活跃状态指示 */
  activeTickTimer = setInterval(() => { viewTick.value++ }, 10000)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
  if (activeTickTimer) clearInterval(activeTickTimer)
})
</script>

<template>
  <div class="track-gallery">
    <div class="gallery-header">
      <h3>{{ t('tracks.title') }} <span class="track-total">{{ filteredTracks.length }}</span></h3>
      <input
        v-model="searchText"
        class="search-input"
        :placeholder="t('tracks.search', '搜索名称/标签...')"
      />
      <select v-if="allLabels.length > 1" v-model="filterLabel" class="label-filter">
        <option value="">{{ t('tracks.all') }}</option>
        <option v-for="label in allLabels" :key="label" :value="label">{{ label }}</option>
      </select>
      <select v-if="allCameras.length > 1" v-model="filterCamera" class="label-filter">
        <option value="">{{ t('tracks.all') }}</option>
        <option v-for="cam in allCameras" :key="cam" :value="cam">{{ cam }}</option>
      </select>
      <div v-if="allColors.length > 1" class="color-filter-group">
        <button
          v-for="color in allColors" :key="color"
          class="color-filter-dot"
          :class="{ active: filterColor === color }"
          :style="{ background: COLOR_MAP[color] ?? '#666' }"
          :title="color"
          @click="filterColor = filterColor === color ? '' : color"
        ></button>
      </div>
      <button
        v-if="unnamedCount > 0"
        class="unnamed-filter-btn"
        :class="{ active: filterUnnamed }"
        @click="filterUnnamed = !filterUnnamed"
        :title="t('tracks.filterUnnamed', '仅显示未命名')"
      >
        {{ unnamedCount }} {{ t('tracks.unnamed', '未命名') }}
      </button>
      <button class="refresh-btn" @click="loadTracks" :disabled="loading">
        {{ loading ? '...' : '↻' }}
      </button>
    </div>

    <div v-if="tracks.length === 0" class="empty">
      {{ t('tracks.empty') }}
    </div>

    <div v-else class="track-grid">
      <div v-for="track in filteredTracks" :key="track.trackId" class="track-card" :class="{ 'new-track': isNewTrack(track) }">
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
              <div class="name-edit-group">
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
                <!-- 快速关联已有名称下拉 -->
                <select
                  v-if="existingNames.length > 0"
                  class="name-preset"
                  @change="applyExistingName(($event.target as HTMLSelectElement).value)"
                  :title="t('tracks.quickName', '快速关联')"
                >
                  <option value="">{{ t('tracks.quickName', '关联...') }}</option>
                  <option v-for="name in existingNames" :key="name" :value="name">{{ name }}</option>
                </select>
              </div>
            </template>
            <template v-else>
              <span class="track-label" @dblclick="startEdit(track)">
                {{ track.customName || track.label }}
              </span>
              <span v-if="track.customName" class="track-original-label">{{ track.label }}</span>
              <!-- dHash 匹配建议：一键应用 -->
              <button
                v-if="!track.customName && suggestions.get(track.trackId)"
                class="suggest-btn"
                @click.stop="applySuggestion(track.trackId)"
                :title="t('tracks.applySuggestion', '点击应用建议名称')"
              >
                ≈ {{ suggestions.get(track.trackId)!.name }} ({{ ((64 - suggestions.get(track.trackId)!.distance) / 64 * 100).toFixed(0) }}%)
              </button>
            </template>
          </div>
          <div class="track-meta">
            <span class="track-id">#{{ track.trackId }}</span>
            <span
              v-if="track.dominantColor && COLOR_MAP[track.dominantColor]"
              class="color-dot"
              :style="{ background: COLOR_MAP[track.dominantColor] }"
              :title="track.dominantColor"
            ></span>
            <span v-if="isTrackActive(track)" class="track-active" :title="t('tracks.active', '活跃中')">●</span>
            <span class="track-count">{{ track.hitCount }}次</span>
            <span class="track-time" :title="formatTime(track.lastSeen)">{{ relativeTime(track.lastSeen) }}</span>
          </div>
          <div class="track-cameras">
            {{ track.cameraIds.join(', ') }}
          </div>
          <button class="play-btn" @click="emit('jumpToRecording', track.cameraIds[0], track.lastSeen)">
            ▶ {{ t('tracks.playRecording') }}
          </button>
          <div class="action-row">
            <button class="history-btn" @click="loadTrackEvents(track.trackId)">
              {{ expandedTrackId === track.trackId ? '▲' : '▼' }} {{ t('tracks.history') }}
            </button>
            <button v-if="confirmDelete !== track.trackId" class="delete-btn" @click="confirmDelete = track.trackId" :title="t('tracks.delete')">✕</button>
            <template v-else>
              <button class="delete-confirm-btn" @click="deleteTrack(track.trackId)">{{ t('manage.confirm', '确认') }}</button>
              <button class="delete-cancel-btn" @click="confirmDelete = null">{{ t('manage.cancel', '取消') }}</button>
            </template>
          </div>
          <!-- 事件历史列表 -->
          <div v-if="expandedTrackId === track.trackId && trackEvents[track.trackId]" class="event-list">
            <div v-if="trackEvents[track.trackId].length === 0" class="event-empty">
              {{ t('tracks.noEvents') }}
            </div>
            <div v-for="ev in trackEvents[track.trackId]" :key="ev.id" class="event-item"
              @click="emit('jumpToRecording', ev.camera_id, ev.timestamp)">
              <span class="event-time">{{ new Date(ev.timestamp).toLocaleString() }}</span>
              <span class="event-cam">{{ ev.camera_id }}</span>
              <button class="event-play" @click.stop="emit('jumpToRecording', ev.camera_id, ev.timestamp)">▶</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 合并确认对话框 -->
    <div v-if="mergeConfirm" class="merge-overlay" @click.self="mergeConfirm = null">
      <div class="merge-dialog">
        <p class="merge-text">{{ t('tracks.mergeConfirm', `名称「${mergeConfirm.name}」已被其他目标使用`) }}</p>
        <p class="merge-hint">{{ t('tracks.mergeHint', '合并将把两个目标的记录整合到一起') }}</p>
        <div class="merge-actions">
          <button class="merge-yes-btn" @click="confirmMerge">{{ t('tracks.mergeAction', '合并') }}</button>
          <button class="merge-no-btn" @click="cancelMerge">{{ t('tracks.justName', '仅命名') }}</button>
          <button class="merge-cancel-btn" @click="mergeConfirm = null; editingId = null">{{ t('manage.cancel', '取消') }}</button>
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
  gap: 8px;
  margin-bottom: 12px;
}

.gallery-header h3 {
  color: #e0e0e0;
  font-size: 14px;
  margin: 0;
  flex-shrink: 0;
}

.track-total {
  color: #4ECDC4;
  font-size: 12px;
}

.search-input {
  background: #2a2a4a;
  color: #e0e0e0;
  border: 1px solid #2a2a4a;
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 11px;
  outline: none;
  flex: 1;
  min-width: 80px;
}

.search-input:focus { border-color: #4ECDC4; }
.search-input::placeholder { color: #555; }

.label-filter {
  background: #2a2a4a;
  color: #e0e0e0;
  border: 1px solid #2a2a4a;
  border-radius: 3px;
  padding: 1px 4px;
  font-size: 11px;
  outline: none;
  flex-shrink: 0;
}

.label-filter:focus { border-color: #4ECDC4; }

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

.unnamed-filter-btn {
  background: #2a2a4a;
  color: #FFC107;
  border: 1px solid #FFC10740;
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 11px;
  flex-shrink: 0;
}

.unnamed-filter-btn.active {
  background: #FFC10720;
  border-color: #FFC107;
}

.unnamed-filter-btn:hover { background: #FFC10720; }

.new-track {
  border-color: #FFC10760;
  animation: new-track-glow 2s ease-out;
}

@keyframes new-track-glow {
  0% { box-shadow: 0 0 12px #FFC10740; }
  100% { box-shadow: none; }
}

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

.suggest-btn {
  display: inline-block;
  background: rgba(156, 39, 176, 0.2);
  border: 1px solid rgba(156, 39, 176, 0.4);
  border-radius: 3px;
  color: #CE93D8;
  font-size: 10px;
  padding: 1px 5px;
  cursor: pointer;
  margin-left: 4px;
  white-space: nowrap;
}
.suggest-btn:hover {
  background: rgba(156, 39, 176, 0.35);
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

.name-edit-group {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
}

.name-preset {
  background: #1a1a2e;
  border: 1px solid #444;
  color: #aaa;
  border-radius: 3px;
  padding: 1px 2px;
  font-size: 10px;
  cursor: pointer;
  outline: none;
  max-width: 90px;
}

.name-preset:hover {
  border-color: #4ECDC4;
  color: #4ECDC4;
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

.color-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  vertical-align: middle;
}

.color-filter-group {
  display: flex;
  gap: 3px;
  align-items: center;
  flex-shrink: 0;
}

.color-filter-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  transition: border-color 0.15s, transform 0.15s;
  padding: 0;
}

.color-filter-dot:hover {
  transform: scale(1.2);
}

.color-filter-dot.active {
  border-color: #fff;
  transform: scale(1.2);
}
.track-count { color: #aaa; }
.track-time { color: #666; }
.track-active {
  color: #4CAF50;
  animation: active-pulse 1.5s infinite;
}
@keyframes active-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

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

.history-btn {
  display: block;
  width: 100%;
  margin-top: 4px;
  background: transparent;
  color: #888;
  border: none;
  border-radius: 3px;
  padding: 2px 0;
  font-size: 10px;
  cursor: pointer;
  text-align: center;
}

.history-btn:hover { color: #4ECDC4; }

.action-row {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}

.action-row .history-btn {
  flex: 1;
  display: block;
  width: auto;
  margin-top: 0;
  background: transparent;
  color: #888;
  border: none;
  border-radius: 3px;
  padding: 2px 0;
  font-size: 10px;
  cursor: pointer;
  text-align: center;
}

.delete-btn {
  background: none;
  border: none;
  color: #666;
  cursor: pointer;
  font-size: 10px;
  padding: 2px 4px;
  border-radius: 3px;
}

.delete-btn:hover { color: #e74c3c; }

.delete-confirm-btn {
  background: #e74c3c;
  color: #fff;
  border: none;
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 10px;
  cursor: pointer;
}

.delete-cancel-btn {
  background: none;
  border: 1px solid #555;
  color: #888;
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 10px;
  cursor: pointer;
}

.event-list {
  margin-top: 6px;
  border-top: 1px solid #2a2a4a;
  padding-top: 4px;
  max-height: 150px;
  overflow-y: auto;
}

.event-empty {
  color: #555;
  font-size: 11px;
  text-align: center;
  padding: 6px;
}

.event-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  font-size: 10px;
  cursor: pointer;
  border-radius: 3px;
}

.event-item:hover {
  background: #2a2a4a;
}

.event-time {
  color: #aaa;
  flex: 1;
}

.event-cam {
  color: #4ECDC4;
}

.event-play {
  background: none;
  border: none;
  color: #666;
  font-size: 10px;
  cursor: pointer;
  padding: 0 2px;
}

.event-play:hover { color: #4ECDC4; }

.merge-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.merge-dialog {
  background: #1a1a3a;
  border: 1px solid #4ECDC4;
  border-radius: 8px;
  padding: 20px;
  max-width: 340px;
  width: 90%;
}

.merge-text {
  color: #e0e0e0;
  font-size: 13px;
  margin: 0 0 8px;
}

.merge-hint {
  color: #888;
  font-size: 11px;
  margin: 0 0 16px;
}

.merge-actions {
  display: flex;
  gap: 8px;
}

.merge-yes-btn {
  background: #4ECDC4;
  color: #000;
  border: none;
  border-radius: 4px;
  padding: 6px 16px;
  font-size: 12px;
  cursor: pointer;
  font-weight: 600;
}

.merge-no-btn {
  background: #2a2a4a;
  color: #4ECDC4;
  border: 1px solid #4ECDC4;
  border-radius: 4px;
  padding: 6px 16px;
  font-size: 12px;
  cursor: pointer;
}

.merge-cancel-btn {
  background: none;
  color: #888;
  border: 1px solid #555;
  border-radius: 4px;
  padding: 6px 16px;
  font-size: 12px;
  cursor: pointer;
  margin-left: auto;
}
</style>
