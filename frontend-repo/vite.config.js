import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

// Build version auto-generado en cada build: YYYY-MM-DD-HHmm-<sha>.
// Inyectado como __APP_BUILD_VERSION__ via `define` y leído desde App.jsx.
function getBuildVersion() {
  const now = new Date()
  const date = now.toISOString().slice(0, 10)
  const hhmm = now.toTimeString().slice(0, 5).replace(':', '')
  try {
    const sha = execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString().trim()
    return `${date}-${hhmm}-${sha}`
  } catch {
    return `${date}-${hhmm}`
  }
}

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: true // Permitimos todos los hosts en desarrollo para evitar bloqueos del túnel
  },
  define: {
    __APP_BUILD_VERSION__: JSON.stringify(getBuildVersion()),
  },
})
