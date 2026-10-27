import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  base: '/',
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5176,
    proxy: {
      '/api': { target: 'http://localhost:8003', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](recharts|d3-|victory-vendor|lodash|react-smooth|recharts-scale)/.test(id)) return 'charts'
          if (/[\\/]node_modules[\\/]@radix-ui[\\/]/.test(id)) return 'radix'
          return 'vendor'
        },
      },
    },
  },
})
