import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  // No client environment variables are needed. Do not expose server configuration.
  envDir: false,
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3001' },
    fs: { strict: true, allow: ['src/web'], deny: ['**/.env*', '**/work/**', '**/.git/**'] }
  }
});
