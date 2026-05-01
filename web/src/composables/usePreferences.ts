import { ref } from 'vue'
import { authFetch } from '../services/auth'

/** 模块级单例状态 */
const cache = ref<Record<string, unknown>>({})
/** 响应式初始化标志（组件可 watch） */
const initializedRef = ref(false)
let initialized = false
let loading: Promise<void> | null = null

/** 脏键队列 */
const dirtyQueue = new Map<string, unknown>()
/** 防抖写入定时器 */
let flushTimer: ReturnType<typeof setTimeout> | null = null
const FLUSH_DELAY = 500

/** 从后端加载全部偏好 */
async function ensureLoaded(): Promise<void> {
  if (initialized) return
  if (!loading) {
    loading = authFetch('/api/preferences')
      .then(res => res.json())
      .then((data: Record<string, unknown>) => {
        cache.value = data
        initialized = true
        initializedRef.value = true
      })
      .catch(() => {
        /** 网络失败静默降级为内存级存储 */
        initialized = true
        initializedRef.value = true
      })
  }
  await loading
}

/** 防抖批量写入后端 */
function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    if (dirtyQueue.size === 0) return
    const entries = Object.fromEntries(dirtyQueue)
    dirtyQueue.clear()
    authFetch('/api/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entries),
    }).catch(() => {
      /** 写入失败静默忽略，缓存已乐观更新 */
    })
  }, FLUSH_DELAY)
}

/** 获取偏好值 */
export async function getPref<T = unknown>(key: string, defaultValue?: T): Promise<T> {
  await ensureLoaded()
  if (key in cache.value) return cache.value[key] as T
  return defaultValue as T
}

/** 设置偏好值（乐观更新 + 防抖写入） */
export async function setPref(key: string, value: unknown): Promise<void> {
  await ensureLoaded()
  cache.value = { ...cache.value, [key]: value }
  dirtyQueue.set(key, value)
  scheduleFlush()
}

/** 批量设置偏好 */
export async function setMany(entries: Record<string, unknown>): Promise<void> {
  await ensureLoaded()
  cache.value = { ...cache.value, ...entries }
  for (const [k, v] of Object.entries(entries)) {
    dirtyQueue.set(k, v)
  }
  scheduleFlush()
}

/** 返回响应式偏好绑定（可配合 v-model） */
export function bindPref<T = unknown>(key: string, defaultValue: T) {
  return {
    get: async (): Promise<T> => getPref(key, defaultValue),
    set: (value: T): void => { setPref(key, value) },
  }
}

/** 直接访问响应式缓存（用于 computed/watch 等同步场景） */
export function usePreferences() {
  /** 触发加载 */
  ensureLoaded()

  return {
    /** 响应式缓存（首次加载前为空对象） */
    cache,
    /** 是否已初始化（响应式） */
    initialized: initializedRef,
    /** 获取偏好值 */
    getPref,
    /** 设置偏好值 */
    setPref,
    /** 批量设置 */
    setMany,
    /** 绑定偏好 */
    bindPref,
  }
}
