import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { pilot } from 'vite-plugin-pilot'

export default defineConfig({
  plugins: [vue(), pilot({ locale: 'zh' })],
  server: {
    port: 3200,
    proxy: {
      '/api': {
        target: 'http://localhost:3100',
        ws: true,
      },
    },
  },
})
