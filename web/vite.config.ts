import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { pilot } from 'vite-plugin-pilot'
import VueDevTools from 'vite-plugin-vue-devtools'

export default defineConfig({
  define: {
    'import.meta.env.VITE_BACKEND_URL': JSON.stringify('http://localhost:3100'),
  },
  plugins: [
    vue(),
    VueDevTools(),
    pilot({ locale: 'zh' }),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons.svg'],
      manifest: {
        name: 'JK NVR',
        short_name: 'JK NVR',
        description: '轻量级网络视频录像机',
        theme_color: '#16213e',
        background_color: '#0a0a1a',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        /** 不缓存 API 请求，只缓存静态资源 */
        navigateFallback: 'index.html',
        runtimeCaching: [],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  server: {
    port: 3200,
  },
})
