import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // MapLibre is most of the bundle and changes far less often than the
        // app does. Splitting it keeps the return visit cheap, which matters
        // when someone opens this on a phone in a parking lot.
        manualChunks: { maplibre: ['maplibre-gl'], react: ['react', 'react-dom'] },
      },
    },
    chunkSizeWarningLimit: 900,
  },
  server: {
    // `npm run dev` in web/ talks to `wrangler dev` in worker/.
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
  },
});
