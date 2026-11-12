// Local entry point. The logic and its production/staging guard live in src/server/demo-seed.ts
// so the same code runs compiled inside the container (staging only).
await import('../src/server/demo-seed.ts');
