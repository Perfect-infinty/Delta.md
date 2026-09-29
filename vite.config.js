import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Delta uses relative asset paths so the built index.html
// can be loaded directly from disk by Electron (file://).
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
