/// <reference types="vite/client" />

declare module 'virtual:pwa-register/vue' {
  import type { Ref } from 'vue'

  interface RegisterSWOptions {
    immediate?: boolean
    onRegisteredSW?: (swUrl: string, registration: ServiceWorkerRegistration | undefined) => void
    onRegisterError?: (error: Error) => void
  }

  export function useRegisterSW(options?: RegisterSWOptions): {
    offlineReady: Ref<boolean>
    needRefresh: Ref<boolean>
    updateServiceWorker: (reloadPage?: boolean) => Promise<void>
  }
}
