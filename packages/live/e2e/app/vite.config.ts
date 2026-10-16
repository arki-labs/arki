import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// No Nitro: `vite build` emits `dist/server/server.js` (`export default { fetch }`) and
// `dist/client/`, which `serve.ts` serves. The e2e suite builds once and restarts only that server.
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  plugins: [tanstackStart({ router: { quoteStyle: 'single', semicolons: true } }), viteReact()],
});
