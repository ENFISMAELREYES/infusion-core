import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'

// Un solo valor de versión para todo el build (antes se calculaba Date.now()
// por separado en `define` y en `closeBundle`, en momentos distintos del
// build, así que casi nunca coincidían y el aviso de actualización salía
// siempre, incluso justo después de cargar la versión más reciente).
const BUILD_VERSION = Date.now().toString();

export default defineConfig({
  plugins: [
    react(),
    {
      // Escribe dist/version.json con el MISMO identificador embebido en el
      // bundle, para que la app pueda detectar cuando hay una versión más
      // reciente desplegada mientras alguien la tiene abierta.
      name: 'write-version-file',
      closeBundle() {
        fs.writeFileSync('dist/version.json', JSON.stringify({ version: BUILD_VERSION }));
      },
    },
  ],
  define: {
    __APP_VERSION__: JSON.stringify(BUILD_VERSION),
  },
})
