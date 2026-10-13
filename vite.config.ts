import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const config = defineConfig({
  resolve: { tsconfigPaths: true, dedupe: ['react', 'react-dom'] },
  // Prebundle the complete UI layer together to avoid a second React instance during lazy-page HMR.
  optimizeDeps: { include: ['@base-ui/react/button', '@base-ui/react/checkbox', '@base-ui/react/dialog', '@base-ui/react/input', '@base-ui/react/select', '@base-ui/react/tabs', '@base-ui/react/toggle', '@base-ui/react/toggle-group', 'motion/react', 'embla-carousel-react'] },
  // SSR logs must stay on the server: forwarding them in both directions can loop.
  server: { forwardConsole: false },
  plugins: [devtools({ consolePiping: { enabled: false } }), tailwindcss(), tanstackStart(), viteReact()],
})

export default config
