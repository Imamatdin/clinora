import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  // No client environment variables are needed. Do not expose server configuration.
  envDir: false,
  build: {
    outDir: '../../dist/web', emptyOutDir: true,
    // Task 026: fonts are never inlined as data: URIs (the CSP allows same-origin fonts only) and keep their
    // package file names, so public/sw.js can precache them by a fixed list. Other assets stay content-hashed.
    assetsInlineLimit: (file: string) => (/\.woff2$/.test(file) ? false : undefined),
    rollupOptions: { output: { assetFileNames: info => (/\.woff2$/.test(info.names?.[0] ?? '') ? 'assets/[name][extname]' : 'assets/[name]-[hash][extname]') } }
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3001' },
    fs: { strict: true, allow: ['src/web', 'node_modules/@fontsource/onest/files'], deny: ['**/.env*', '**/work/**', '**/.git/**'] }
  }
});
