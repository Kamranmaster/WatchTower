import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Overridable so the end-to-end tests can run their own API + web app next to `npm run dev`.
const API = process.env.MONITORLY_API_URL ?? 'http://localhost:4000';
const PORT = Number(process.env.WEB_PORT ?? 5173);

// Same-origin in the browser → no CORS issues, and cookies just work.
const proxy = {
  '/api': API,
  '/health': API,
  '/socket.io': { target: API, ws: true },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: PORT, strictPort: true, proxy },
  preview: { port: PORT, strictPort: true, proxy },
  build: {
    rollupOptions: {
      output: {
        // Libraries change less often than the app: separate files stay cached across deploys.
        manualChunks: {
          react: ['react', 'react-dom', 'react-dom/client', 'react-router'],
          data: ['@tanstack/react-query', 'socket.io-client'],
          zod: ['zod'],
        },
      },
    },
  },
});
