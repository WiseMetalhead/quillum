import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import Icons from 'unplugin-icons/vite'

// https://vite.dev/config/
export default defineConfig({
  worker: {
    format: 'es',
  },
  server: {
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:8002',
        ws: true,
      },
      '/collaboration/ws': {
        target: 'ws://127.0.0.1:8003',
        ws: true,
      },
    },
  },
  preview: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
      },
      '/ws': {
        target: 'ws://127.0.0.1:8002',
        ws: true,
      },
      '/collaboration/ws': {
        target: 'ws://127.0.0.1:8003',
        ws: true,
      },
    },
  },
  plugins: [
    react(),
    Icons({
      compiler: 'jsx',
      jsx: 'react',
    }),
  ],
})
