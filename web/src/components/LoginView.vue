<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { login } from '../services/auth'

const { t } = useI18n()
const token = ref('')
const error = ref(false)
const loading = ref(false)

const emit = defineEmits<{
  (e: 'success'): void
}>()

async function submit() {
  if (!token.value.trim()) return
  loading.value = true
  error.value = false
  const ok = await login(token.value.trim())
  if (ok) {
    emit('success')
  } else {
    error.value = true
  }
  loading.value = false
}
</script>

<template>
  <div class="login-overlay">
    <div class="login-card">
      <h1 class="login-title">JK NVR</h1>
      <p class="login-subtitle">{{ t('login.tokenPlaceholder') }}</p>
      <form @submit.prevent="submit" class="login-form">
        <input
          v-model="token"
          type="password"
          :placeholder="t('login.token')"
          class="login-input"
          autofocus
        />
        <button type="submit" class="login-btn" :disabled="loading || !token.trim()">
          {{ loading ? '...' : t('login.submit') }}
        </button>
      </form>
      <p v-if="error" class="login-error">{{ t('login.invalid') }}</p>
    </div>
  </div>
</template>

<style scoped>
.login-overlay {
  position: fixed;
  inset: 0;
  background: #0a0a1a;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.login-card {
  background: #1a1a2e;
  border: 1px solid #2a2a4a;
  border-radius: 12px;
  padding: 40px 32px;
  width: 320px;
  text-align: center;
}

.login-title {
  font-size: 24px;
  font-weight: 700;
  color: #4ECDC4;
  margin: 0 0 8px;
}

.login-subtitle {
  font-size: 13px;
  color: #888;
  margin: 0 0 24px;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.login-input {
  width: 100%;
  padding: 10px 14px;
  background: #0a0a1a;
  border: 1px solid #2a2a4a;
  border-radius: 6px;
  color: #e0e0e0;
  font-size: 14px;
  box-sizing: border-box;
}

.login-input:focus {
  outline: none;
  border-color: #4ECDC4;
}

.login-input::placeholder {
  color: #444;
}

.login-btn {
  width: 100%;
  padding: 10px;
  background: #4ECDC4;
  color: #1a1a2e;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.login-btn:hover {
  opacity: 0.85;
}

.login-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.login-error {
  color: #e74c3c;
  font-size: 12px;
  margin-top: 12px;
}
</style>
