import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'

export default defineConfig({
  plugins: [
    react(),
    {
      // Escribe dist/version.json con un identificador nuevo en cada build,
      // para que la app pueda detectar cuando hay una versión más reciente
      // desplegada mientras alguien la tiene abierta.
      name: 'write-version-file',
      closeBundle() {
        fs.writeFileSync('dist/version.json', JSON.stringify({ version: Date.now() }));
      },
    },
  ],
  define: {
    __APP_VERSION__: JSON.stringify(Date.now()),
  },
})
