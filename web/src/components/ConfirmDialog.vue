<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { confirmState, resolveConfirm } from '../composables/useConfirm'

const { t } = useI18n()

function onEsc(e: KeyboardEvent) {
  if (e.key === 'Escape' && confirmState.value) resolveConfirm(false)
}

onMounted(() => window.addEventListener('keydown', onEsc))
onUnmounted(() => window.removeEventListener('keydown', onEsc))
</script>

<template>
  <Teleport to="body">
    <div v-if="confirmState" class="confirm-overlay" @click.self="resolveConfirm(false)">
      <div class="confirm-modal">
        <p class="confirm-message">{{ confirmState.message }}</p>
        <div class="confirm-actions">
          <button class="confirm-btn cancel" @click="resolveConfirm(false)">{{ t('settings.cancel') }}</button>
          <button class="confirm-btn ok" @click="resolveConfirm(true)">{{ t('recording.delete') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.confirm-modal {
  background: #1a1a2e;
  border: 1px solid #2a2a4a;
  border-radius: 8px;
  padding: 20px 24px;
  min-width: 300px;
  max-width: 420px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.confirm-message {
  color: #e0e0e0;
  font-size: 14px;
  margin: 0 0 16px;
  line-height: 1.5;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.confirm-btn {
  padding: 6px 16px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: none;
}

.confirm-btn.cancel {
  background: #2a2a4a;
  color: #ccc;
}

.confirm-btn.cancel:hover {
  background: #3a3a5a;
}

.confirm-btn.ok {
  background: #e74c3c;
  color: #fff;
}

.confirm-btn.ok:hover {
  background: #c0392b;
}
</style>
