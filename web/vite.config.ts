import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base` is overridden for GitHub Pages via `VITE_BASE=/hass-ember-mug-component/`.
// When the local server hosts the bundle it is served from the root, so '/' is correct.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
});
