import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API = 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // Same-origin in the browser → no CORS issues in dev, and cookies just work.
    proxy: {
      '/api': API,
      '/health': API,
      '/socket.io': { target: API, ws: true },
    },
  },
});
