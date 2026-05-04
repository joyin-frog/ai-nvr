<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { authFetch } from '../services/auth'
import { useToast } from '../composables/useToast'

const { t } = useI18n()
const { error: toastError } = useToast()

/** 摄像头 ID */
const props = defineProps<{
  cameraId: string
}>()

/** 面板是否展开 */
const expanded = ref(false)
/** 预置位列表 */
const presets = ref<Array<{ token: string; name: string }>>([])

/** 发送 PTZ 命令 */
async function ptzCommand(action: string, body?: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await authFetch(`/api/ptz/${encodeURIComponent(props.cameraId)}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    return res.ok
  } catch {
    toastError(t('settings.saveFailed'))
    return false
  }
}

/** 开始连续移动（按住）— 允许方向切换，最新命令覆盖旧命令 */
function onStartMove(x: number, y: number, zoom = 0) {
  ptzCommand('move', { velocity: { x, y, zoom }, timeout: 5000 })
}

/** 停止移动（松开） */
function onStopMove() {
  ptzCommand('stop')
}

/** 缩放开始 */
function onStartZoom(zoom: number) {
  ptzCommand('move', { velocity: { x: 0, y: 0, zoom }, timeout: 5000 })
}

/** 加载预置位列表 */
async function loadPresets() {
  try {
    const res = await authFetch(`/api/ptz/${encodeURIComponent(props.cameraId)}/presets`)
    if (!res.ok) return
    const data = await res.json()
    presets.value = data.presets ?? []
  } catch { toastError(t('settings.loadFailed')) }
}

/** 跳转预置位 */
function gotoPreset(token: string) {
  ptzCommand('goto-preset', { presetToken: token })
}

/** 回到初始位置 */
function goHome() {
  ptzCommand('home')
}

/** 展开面板时加载预置位 */
function togglePanel() {
  expanded.value = !expanded.value
  if (expanded.value) {
    loadPresets()
  }
}
</script>

<template>
  <div class="ptz-control">
    <button class="ptz-toggle" @click="togglePanel" :title="t('ptz.control')">
      &#x1F3AF;
    </button>
    <div v-if="expanded" class="ptz-panel" @click.stop>
      <!-- 方向键 -->
      <div class="ptz-dpad">
        <button class="dpad-btn up" @pointerdown="onStartMove(0, 0.5)" @pointerup="onStopMove" @pointerleave="onStopMove">&#9650;</button>
        <button class="dpad-btn left" @pointerdown="onStartMove(-0.5, 0)" @pointerup="onStopMove" @pointerleave="onStopMove">&#9664;</button>
        <button class="dpad-btn center" @click="goHome" :title="t('ptz.home')">&#8226;</button>
        <button class="dpad-btn right" @pointerdown="onStartMove(0.5, 0)" @pointerup="onStopMove" @pointerleave="onStopMove">&#9654;</button>
        <button class="dpad-btn down" @pointerdown="onStartMove(0, -0.5)" @pointerup="onStopMove" @pointerleave="onStopMove">&#9660;</button>
      </div>
      <!-- 缩放 -->
      <div class="ptz-zoom">
        <button class="zoom-btn" @pointerdown="onStartZoom(0.3)" @pointerup="onStopMove" @pointerleave="onStopMove">+</button>
        <span class="zoom-label">{{ t('ptz.zoom') }}</span>
        <button class="zoom-btn" @pointerdown="onStartZoom(-0.3)" @pointerup="onStopMove" @pointerleave="onStopMove">&minus;</button>
      </div>
      <!-- 预置位 -->
      <div v-if="presets.length > 0" class="ptz-presets">
        <div class="presets-label">{{ t('ptz.presets') }}</div>
        <div class="presets-list">
          <button v-for="p in presets" :key="p.token" class="preset-btn" @click="gotoPreset(p.token)">
            {{ p.name }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ptz-control {
  position: relative;
}

.ptz-toggle {
  background: rgba(0, 0, 0, 0.5);
  border: none;
  color: #e0e0e0;
  font-size: 14px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  line-height: 1;
}

.ptz-toggle:hover {
  background: rgba(0, 0, 0, 0.7);
}

.ptz-panel {
  position: absolute;
  right: 0;
  top: 28px;
  background: rgba(15, 15, 30, 0.95);
  border: 1px solid #2a2a4a;
  border-radius: 8px;
  padding: 12px;
  z-index: 20;
  min-width: 160px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
}

.ptz-dpad {
  display: grid;
  grid-template-columns: 36px 36px 36px;
  grid-template-rows: 36px 36px 36px;
  gap: 4px;
  justify-content: center;
  margin-bottom: 10px;
}

.dpad-btn {
  background: #2a2a4a;
  border: 1px solid #3a3a5a;
  color: #e0e0e0;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
}

.dpad-btn:hover {
  background: #3a3a5a;
}

.dpad-btn:active {
  background: #4ECDC4;
  color: #1a1a2e;
}

.dpad-btn.up { grid-column: 2; grid-row: 1; }
.dpad-btn.left { grid-column: 1; grid-row: 2; }
.dpad-btn.center { grid-column: 2; grid-row: 2; background: #1a2a3a; }
.dpad-btn.right { grid-column: 3; grid-row: 2; }
.dpad-btn.down { grid-column: 2; grid-row: 3; }

.ptz-zoom {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-bottom: 10px;
}

.zoom-btn {
  background: #2a2a4a;
  border: 1px solid #3a3a5a;
  color: #e0e0e0;
  border-radius: 4px;
  font-size: 16px;
  font-weight: 700;
  width: 32px;
  height: 28px;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
}

.zoom-btn:hover { background: #3a3a5a; }
.zoom-btn:active { background: #4ECDC4; color: #1a1a2e; }

.zoom-label {
  font-size: 11px;
  color: #888;
}

.ptz-presets {
  border-top: 1px solid #2a2a4a;
  padding-top: 8px;
}

.presets-label {
  font-size: 11px;
  color: #888;
  margin-bottom: 6px;
}

.presets-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.preset-btn {
  background: #2a2a4a;
  border: 1px solid #3a3a5a;
  color: #4ECDC4;
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 11px;
  cursor: pointer;
}

.preset-btn:hover { background: #3a3a5a; }
.preset-btn:active { background: #4ECDC4; color: #1a1a2e; }
</style>
