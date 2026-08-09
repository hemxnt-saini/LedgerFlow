import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    outDir: 'dist',
    // Source maps ship: this is a demo people are meant to read, and a stack
    // trace pointing at minified output helps nobody.
    sourcemap: true,
  },
});
