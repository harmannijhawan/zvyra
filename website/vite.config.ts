import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022', assetsInlineLimit: 4096 },
  server: { port: 5180 },
  preview: { port: 4180 }
})
