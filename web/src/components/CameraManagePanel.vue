<script setup lang="ts">
import { ref, onMounted } from 'vue'
import RoiEditor from './RoiEditor.vue'

/** 摄像头信息 */
interface CameraInfo {
  id: string
  name: string
  online: boolean
  lastFrameAt: number
}

const cameras = ref<CameraInfo[]>([])
const loading = ref(false)

/** 添加摄像头表单 */
const showAddForm = ref(false)
const addForm = ref({ id: '', friendlyName: '', hdUrl: '', sdUrl: '', detectFps: 5 })
const adding = ref(false)

/** 编辑摄像头 */
const editingId = ref<string | null>(null)
const editForm = ref({ friendlyName: '', hdUrl: '', sdUrl: '' })
const saving = ref(false)

/** ROI 编辑中的摄像头 ID */
const roiCameraId = ref<string | null>(null)

/** 加载摄像头列表 */
async function loadCameras() {
  loading.value = true
  try {
    const res = await fetch('/api/cameras')
    if (res.ok) {
      cameras.value = await res.json()
    }
  } catch {
    // ignore
  } finally {
    loading.value = false
  }
}

/** 添加摄像头 */
async function addCamera() {
  if (!addForm.value.id || !addForm.value.friendlyName || !addForm.value.hdUrl || !addForm.value.sdUrl) return
  adding.value = true
  try {
    const res = await fetch('/api/cameras', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(addForm.value),
    })
    if (res.ok) {
      showAddForm.value = false
      addForm.value = { id: '', friendlyName: '', hdUrl: '', sdUrl: '', detectFps: 5 }
      loadCameras()
    }
  } catch {
    // ignore
  } finally {
    adding.value = false
  }
}

/** 开始编辑 */
function startEdit(cam: CameraInfo) {
  editingId.value = cam.id
  editForm.value = { friendlyName: cam.name, hdUrl: '', sdUrl: '' }
}

/** 取消编辑 */
function cancelEdit() {
  editingId.value = null
}

/** 保存编辑 */
async function saveEdit() {
  if (!editingId.value) return
  saving.value = true
  try {
    const res = await fetch(`/api/cameras/${editingId.value}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editForm.value),
    })
    if (res.ok) {
      editingId.value = null
      loadCameras()
    }
  } catch {
    // ignore
  } finally {
    saving.value = false
  }
}

/** 删除摄像头 */
async function deleteCamera(id: string) {
  if (!confirm(`确定删除摄像头 "${id}"？`)) return
  try {
    const res = await fetch(`/api/cameras/${id}`, { method: 'DELETE' })
    if (res.ok) loadCameras()
  } catch {
    // ignore
  }
}

/** 在线状态标签 */
function statusText(cam: CameraInfo): string {
  if (!cam.online) return '离线'
  const ago = Math.round((Date.now() - cam.lastFrameAt) / 1000)
  if (ago > 10) return `${ago}s 前`
  return '在线'
}

onMounted(() => {
  loadCameras()
})

defineExpose({ loadCameras })
</script>

<template>
  <div class="camera-manage-panel">
    <div class="panel-header">
      <span>摄像头管理</span>
      <button class="refresh-btn" @click="loadCameras" :disabled="loading">刷新</button>
      <button class="add-btn" @click="showAddForm = !showAddForm">{{ showAddForm ? '取消' : '+ 添加' }}</button>
    </div>

    <!-- 添加表单 -->
    <div v-if="showAddForm" class="add-form">
      <div class="form-field">
        <label>ID</label>
        <input v-model="addForm.id" placeholder="ipc_new" class="input" />
      </div>
      <div class="form-field">
        <label>名称</label>
        <input v-model="addForm.friendlyName" placeholder="新摄像头" class="input" />
      </div>
      <div class="form-field">
        <label>主码流 RTSP</label>
        <input v-model="addForm.hdUrl" placeholder="rtsp://..." class="input" />
      </div>
      <div class="form-field">
        <label>子码流 RTSP</label>
        <input v-model="addForm.sdUrl" placeholder="rtsp://..." class="input" />
      </div>
      <button class="submit-btn" @click="addCamera" :disabled="adding">
        {{ adding ? '添加中...' : '确认添加' }}
      </button>
    </div>

    <!-- 摄像头列表 -->
    <div class="camera-list">
      <div v-if="cameras.length === 0" class="empty">
        {{ loading ? '加载中...' : '暂无摄像头' }}
      </div>
      <div v-for="cam in cameras" :key="cam.id" class="camera-item">
        <template v-if="editingId === cam.id">
          <div class="edit-form">
            <div class="form-field">
              <label>名称</label>
              <input v-model="editForm.friendlyName" class="input" />
            </div>
            <div class="form-field">
              <label>主码流 RTSP</label>
              <input v-model="editForm.hdUrl" placeholder="留空不修改" class="input" />
            </div>
            <div class="form-field">
              <label>子码流 RTSP</label>
              <input v-model="editForm.sdUrl" placeholder="留空不修改" class="input" />
            </div>
            <div class="edit-actions">
              <button class="save-btn" @click="saveEdit" :disabled="saving">
                {{ saving ? '保存中...' : '保存' }}
              </button>
              <button class="cancel-btn" @click="cancelEdit">取消</button>
            </div>
          </div>
        </template>
        <template v-else>
          <div class="camera-info">
            <span class="cam-status" :class="{ online: cam.online }">●</span>
            <div class="cam-detail">
              <span class="cam-name">{{ cam.name }}</span>
              <span class="cam-id">{{ cam.id }}</span>
            </div>
            <span class="cam-status-text" :class="{ offline: !cam.online }">{{ statusText(cam) }}</span>
          </div>
          <div class="camera-actions">
            <button class="action-btn roi" :class="{ active: roiCameraId === cam.id }" @click="roiCameraId = roiCameraId === cam.id ? null : cam.id">区域</button>
            <button class="action-btn edit" @click="startEdit(cam)">编辑</button>
            <button class="action-btn delete" @click="deleteCamera(cam.id)">删除</button>
          </div>
          <!-- ROI 编辑器 -->
          <div v-if="roiCameraId === cam.id" class="roi-section">
            <RoiEditor :camera-id="cam.id" :frame-url="`/api/snapshot/${cam.id}`" />
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.camera-manage-panel {
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
  background: #1a1a2e;
  border-bottom: 1px solid #2a2a4a;
  color: #e0e0e0;
  font-weight: 600;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.refresh-btn {
  margin-left: auto;
  background: #2a2a4a;
  color: #e0e0e0;
  border: none;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}

.refresh-btn:hover { background: #3a3a5a; }
.refresh-btn:disabled { opacity: 0.5; }

.add-btn {
  background: #4ECDC4;
  color: #1a1a2e;
  border: none;
  border-radius: 4px;
  padding: 2px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.add-btn:hover { background: #3ad4c8; }

.camera-list {
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

.camera-item {
  padding: 8px;
  border-radius: 4px;
  border: 1px solid transparent;
}

.camera-item:hover {
  background: #2a2a4a;
}

.camera-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cam-status {
  color: #e74c3c;
  font-size: 10px;
}

.cam-status.online {
  color: #4CAF50;
}

.cam-detail {
  flex: 1;
  min-width: 0;
}

.cam-name {
  display: block;
  font-size: 13px;
  color: #e0e0e0;
  font-weight: 500;
}

.cam-id {
  display: block;
  font-size: 11px;
  color: #666;
}

.cam-status-text {
  font-size: 11px;
  color: #4CAF50;
  flex-shrink: 0;
}

.cam-status-text.offline {
  color: #e74c3c;
}

.camera-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  justify-content: flex-end;
}

.action-btn {
  background: none;
  border: 1px solid #2a2a4a;
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
}

.action-btn.edit {
  color: #4ECDC4;
  border-color: #4ECDC4;
}

.action-btn.edit:hover { background: #4ECDC420; }

.action-btn.delete {
  color: #e74c3c;
  border-color: #e74c3c;
}

.action-btn.delete:hover { background: #e74c3c20; }

.action-btn.roi {
  color: #FFD93D;
  border-color: #FFD93D;
}

.action-btn.roi:hover { background: #FFD93D20; }

.action-btn.roi.active {
  background: #FFD93D30;
}

/* 添加表单 */
.add-form {
  padding: 10px 12px;
  border-bottom: 1px solid #2a2a4a;
  background: #16213e;
}

.form-field {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.form-field label {
  font-size: 12px;
  color: #888;
  min-width: 70px;
  flex-shrink: 0;
}

.input {
  flex: 1;
  background: #0a0a1a;
  color: #e0e0e0;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
}

.input:focus {
  outline: none;
  border-color: #4ECDC4;
}

.input::placeholder {
  color: #444;
}

.submit-btn {
  width: 100%;
  background: #4ECDC4;
  color: #1a1a2e;
  border: none;
  border-radius: 4px;
  padding: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  margin-top: 4px;
}

.submit-btn:hover { background: #3ad4c8; }
.submit-btn:disabled { opacity: 0.5; }

/* 编辑表单 */
.edit-form {
  padding: 4px 0;
}

.edit-actions {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}

.save-btn {
  flex: 1;
  background: #4ECDC4;
  color: #1a1a2e;
  border: none;
  border-radius: 3px;
  padding: 4px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.save-btn:hover { background: #3ad4c8; }
.save-btn:disabled { opacity: 0.5; }

.cancel-btn {
  background: none;
  border: 1px solid #2a2a4a;
  color: #888;
  border-radius: 3px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}

.cancel-btn:hover { color: #e0e0e0; }

/* ROI 编辑区 */
.roi-section {
  margin-top: 6px;
  border-top: 1px solid #2a2a4a;
  background: #16213e;
  border-radius: 4px;
}

/* 移动端适配 */
@media (max-width: 768px) {
  .camera-manage-panel {
    border-radius: 0;
    border: none;
  }
}
</style>
