import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';

/** A hash of every file that decides what the simulation does, so two builds that would disagree never share a room. */
function buildFingerprint(): string {
  const hash = createHash('sha256');
  const walk = (dir: string, files = /\.(ts|json)$/) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p, files);
      else if (files.test(p)) hash.update(p.replace(/\\/g, '/')).update(readFileSync(p, 'utf8').replace(/\r\n/g, '\n'));
    }
  };
  for (const dir of ['src/engine', 'src/game', 'src/net']) walk(dir);
  return hash.digest('hex').slice(0, 12);
}

export default defineConfig({
  // Relative asset paths let the same build run from any folder, including a repository subfolder on a static host.
  base: './',
  define: {
    __BUILD__: JSON.stringify(buildFingerprint()),
    __RELAY_URL__: JSON.stringify(process.env.RELAY_URL || ''),
  },
  server: {
    port: Number(process.env.PORT) || 5173,
    watch: { ignored: ['**/out/**', '**/Notes/**', '**/work/**', '**/sb3/**', '**/public/assets/**', '**/server/**'] },
    // The room server runs beside the page while developing (npm run worker:dev).
    proxy: {
      '/api': { target: process.env.WORKER_URL ?? 'http://127.0.0.1:8788', changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 12000,
  },
});
